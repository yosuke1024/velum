import type { ZodTypeAny, z } from 'zod';
import {
  LlmError,
  RETRYABLE_STATUS,
  withRetries,
  parseWithSchema,
  type LlmRequest,
  type LlmResult,
} from './llm-core.js';

/**
 * Cloudflare Workers AI（REST）への最小の通信層。
 *
 * 2026-09-27 に Gemini から移した。PixTale のプロキシが Workers AI 上の Gemma で
 * 動いているので、語り手を育てる側も同じ系統に揃える（pixapps
 * docs/current/pixtale_ai_provider_routing_spec.md §6 と同じ呼び方）。
 *
 * - 構造化出力は JSON mode（response_format: json_schema）。
 * - Gemma の思考モードは chat_template_kwargs.enable_thinking=false で止める。
 *   これが止める唯一の手段（PixWork §6 の実測）。
 * - それでも先頭に思考タグやコードフェンスが混ざることがあるので、JSON 本体だけを
 *   切り出してから厳格に JSON.parse する。JSON 文字列値の内部には触れない。
 *
 * 無料枠は 1 日 10,000 neurons。日記 1 本が 200 neurons 前後、季の計画 5 本でも
 * 1,500 に届かないので、季の境目に補完をまとめても枠内に収まる。
 */

export const WORKERS_AI_DEFAULT_MODEL = '@cf/google/gemma-4-26b-a4b-it';

const ENDPOINT = 'https://api.cloudflare.com/client/v4/accounts';
/** 日記は本文 2 言語と差分で 4〜5k トークンになる。既定の 256 では必ず尻切れになる。 */
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_TIMEOUT_MS = 180_000;
const TOP_P = 0.95;

/**
 * jsonSchema ヘルパは Gemini の方言（`nullable: true`）で組んである。
 * Workers AI には標準の JSON Schema を渡すので、nullable を anyOf [型, null] に書き換える。
 * 決定的で冪等（標準の形にかけても変わらない）。
 */
export function toStandardJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toStandardJsonSchema);
  if (!schema || typeof schema !== 'object') return schema;

  const { nullable, ...rest } = schema as Record<string, unknown>;
  const converted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    converted[key] =
      key === 'properties' && value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([name, prop]) => [
              name,
              toStandardJsonSchema(prop),
            ]),
          )
        : toStandardJsonSchema(value);
  }

  return nullable === true ? { anyOf: [converted, { type: 'null' }] } : converted;
}

/** Workers AI の代表的な応答の形から本文を取り出す（未加工）。 */
export function extractText(result: unknown): string | null {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return null;
  const obj = result as Record<string, unknown>;

  // OpenAI 形: choices[0].message.content（文字列か、text パートの配列）
  if (Array.isArray(obj.choices) && obj.choices.length > 0) {
    const first = obj.choices[0] as Record<string, unknown> | undefined;
    const message = first?.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const texts = content
        .filter(
          (part): part is { type: 'text'; text: string } =>
            !!part &&
            typeof part === 'object' &&
            (part as Record<string, unknown>).type === 'text' &&
            typeof (part as Record<string, unknown>).text === 'string',
        )
        .map((part) => part.text);
      if (texts.length) return texts.join('');
    }
  }

  // 旧来の形: { response }。JSON mode では文字列ではなく解析済みのオブジェクトで返ることがある。
  if (typeof obj.response === 'string') return obj.response;
  if (obj.response && typeof obj.response === 'object') return JSON.stringify(obj.response);

  return null;
}

export function extractFinishReason(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const choices = (result as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const reason = (choices[0] as Record<string, unknown> | undefined)?.finish_reason;
  return typeof reason === 'string' ? reason : null;
}

const LEADING_DECORATION = /^\s*<(think|thought|reasoning)>[\s\S]*?<\/\1>\s*/i;
const FENCE_FIRST_LINE = /^```(json)?\s*$/i;

/**
 * 最初の `{` / `[` から、対応する閉じ括弧までを切り出す。文字列リテラル内の括弧は数えない。
 * 閉じずに終わった（尻切れ）ときは開き括弧から末尾までを返し、後続の JSON.parse を失敗させる。
 */
function extractBalancedJson(text: string): string {
  const trimmed = text.trim();
  const start = trimmed.search(/[{[]/);
  if (start === -1) return trimmed;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) return trimmed.slice(start, i + 1);
    }
  }
  return trimmed.slice(start);
}

/**
 * 先頭の思考タグブロック → 先頭/末尾のコードフェンス → 括弧対応で JSON 本体、の順に剥がす。
 * 決定的で冪等（きれいな JSON にかけても変わらない）。
 */
export function stripModelDecorations(text: string): string {
  let result = text.trim();
  let match: RegExpExecArray | null;
  while ((match = LEADING_DECORATION.exec(result))) {
    result = result.slice(match[0].length);
  }

  const lines = result.split('\n');
  if (lines.length > 0 && FENCE_FIRST_LINE.test(lines[0]!.trim())) {
    lines.shift();
    if (lines.length > 0 && lines[lines.length - 1]!.trim() === '```') lines.pop();
    result = lines.join('\n').trim();
  }

  return extractBalancedJson(result);
}

type Envelope = {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: unknown;
};

export async function generateJsonWorkersAi<S extends ZodTypeAny>(
  request: LlmRequest,
  schema: S,
  options: { attempts?: number } = {},
): Promise<LlmResult<z.infer<S>>> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!accountId || !token) {
    throw new LlmError('CLOUDFLARE_ACCOUNT_ID と CLOUDFLARE_API_TOKEN が設定されていません。');
  }

  // GitHub Actions は未設定の variable を空文字で渡す。空は「未設定」として既定へ落とす。
  const model = request.model ?? (process.env.VELUM_MODEL?.trim() || WORKERS_AI_DEFAULT_MODEL);
  const maxTokens = Number(process.env.VELUM_MAX_TOKENS ?? DEFAULT_MAX_TOKENS);
  const timeoutMs = Number(process.env.VELUM_LLM_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const attempts = options.attempts ?? 3;

  const body = JSON.stringify({
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: request.user },
    ],
    max_completion_tokens: maxTokens,
    temperature: request.temperature ?? 1.0,
    top_p: TOP_P,
    chat_template_kwargs: { enable_thinking: false },
    response_format: {
      type: 'json_schema',
      json_schema: toStandardJsonSchema(request.responseSchema),
    },
  });

  return withRetries(attempts, async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${ENDPOINT}/${accountId}/ai/run/${model}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      throw new LlmError(
        `Workers AI に接続できませんでした: ${(error as Error).message}`,
        undefined,
        true,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    if (!response.ok) {
      throw new LlmError(
        `Workers AI が ${response.status} を返しました: ${text.slice(0, 400)}`,
        response.status,
        RETRYABLE_STATUS.has(response.status),
      );
    }

    let envelope: Envelope;
    try {
      envelope = JSON.parse(text) as Envelope;
    } catch {
      throw new LlmError(`Workers AI の応答を読めません: ${text.slice(0, 400)}`, undefined, true);
    }
    if (envelope.success === false) {
      const detail = (envelope.errors ?? [])
        .map((e) => `${e.code ?? ''} ${e.message ?? ''}`.trim())
        .join('; ');
      // 200 で success: false は生成側の失敗（スキーマに沿えなかった等）。引き直す価値がある。
      throw new LlmError(`Workers AI がエラーを返しました: ${detail || text.slice(0, 400)}`, undefined, true);
    }

    if (extractFinishReason(envelope.result) === 'length') {
      throw new LlmError(
        `応答が max_completion_tokens（${maxTokens}）で切れました。VELUM_MAX_TOKENS を増やしてください。`,
        undefined,
        true,
      );
    }

    const rawText = extractText(envelope.result);
    if (!rawText) throw new LlmError('応答が空でした。', undefined, true);

    const cleaned = stripModelDecorations(rawText);
    const data = parseWithSchema(cleaned, schema);
    return { data, model, raw: cleaned };
  });
}
