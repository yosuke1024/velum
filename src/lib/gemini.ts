import type { ZodTypeAny, z } from 'zod';

/**
 * Gemini への最小の通信層。
 *
 * 無料枠で回すことを前提にする。1日に Tick 1件と日記1件しか生成しないので、
 * 実験が金を燃やさない規模に収まる。
 */

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * 既定モデル。JuryDiary と揃えてある。
 * Gemini 2.5 系は 2026-10-16 に提供終了するため、後継から始める。
 */
export const DEFAULT_MODEL = 'gemini-3.5-flash';

export type GeminiRequest = {
  system: string;
  user: string;
  /** 構造化出力のスキーマ（JSON Schema 形式） */
  responseSchema: Record<string, unknown>;
  model?: string;
  temperature?: number;
};

export type GeminiResult<T> = {
  data: T;
  model: string;
  raw: string;
};

class GeminiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'GeminiError';
  }
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 構造化出力を要求して呼び出し、zod で検証して返す。
 *
 * ここで検証するのは「形」だけ。値の範囲は src/diary/gate.ts が見る。
 * 形が違えばリトライする価値があるが、範囲違反はその日の破棄であって
 * リトライで直る種類の問題ではない。
 */
export async function generateJson<S extends ZodTypeAny>(
  request: GeminiRequest,
  schema: S,
  options: { attempts?: number } = {},
): Promise<GeminiResult<z.infer<S>>> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new GeminiError('GEMINI_API_KEY が設定されていません。');
  }

  const model = request.model ?? process.env.VELUM_MODEL ?? DEFAULT_MODEL;
  const attempts = options.attempts ?? 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(
        `${ENDPOINT}/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: request.system }] },
            contents: [{ role: 'user', parts: [{ text: request.user }] }],
            generationConfig: {
              responseMimeType: 'application/json',
              responseSchema: request.responseSchema,
              temperature: request.temperature ?? 1.0,
            },
          }),
        },
      );

      if (!response.ok) {
        const body = await response.text();
        throw new GeminiError(
          `Gemini が ${response.status} を返しました: ${body.slice(0, 400)}`,
          response.status,
          RETRYABLE_STATUS.has(response.status),
        );
      }

      const payload = (await response.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        throw new GeminiError('応答が空でした。', undefined, true);
      }

      const parsed = schema.safeParse(JSON.parse(text));
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'} — ${i.message}`)
          .join('; ');
        throw new GeminiError(
          `応答が期待した形になっていません: ${issues}`,
          undefined,
          true,
        );
      }

      return { data: parsed.data, model, raw: text };
    } catch (error) {
      lastError = error as Error;
      const retryable =
        error instanceof GeminiError ? error.retryable : error instanceof SyntaxError;
      if (!retryable || attempt === attempts) break;
      await sleep(2 ** attempt * 1000);
    }
  }

  throw lastError ?? new GeminiError('原因不明の失敗');
}

/** zod スキーマを持たない呼び出し側のための、素の JSON Schema 断片 */
export const jsonSchema = {
  string: () => ({ type: 'string' }),
  number: () => ({ type: 'number' }),
  boolean: () => ({ type: 'boolean' }),
  array: (items: Record<string, unknown>) => ({ type: 'array', items }),
  object: (
    properties: Record<string, unknown>,
    required: string[],
  ): Record<string, unknown> => ({
    type: 'object',
    properties,
    required,
  }),
  nullable: (inner: Record<string, unknown>) => ({ ...inner, nullable: true }),
} as const;
