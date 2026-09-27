import type { ZodTypeAny, z } from 'zod';

/**
 * プロバイダに依らない共通部分。
 *
 * 呼び出し側（日記・季の計画・Snapshot）が見るのは src/lib/llm.ts の generateJson だけで、
 * ここにはその引数・戻り値の形、エラー、再試行の規律を置く。
 */

export type LlmRequest = {
  system: string;
  user: string;
  /** 構造化出力のスキーマ。src/lib/llm.ts の jsonSchema で組み立てる（Gemini 方言、nullable 付き） */
  responseSchema: Record<string, unknown>;
  model?: string;
  temperature?: number;
};

export type LlmResult<T> = {
  data: T;
  model: string;
  raw: string;
};

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 再試行の規律。
 *
 * ここで直るのは「形」だけ。値の範囲は src/diary/gate.ts が見る。
 * 形が違えばリトライする価値があるが、範囲違反はその日の破棄であって
 * リトライで直る種類の問題ではない。JSON として読めない応答（SyntaxError）は形の違いとして扱う。
 */
export async function withRetries<T>(attempts: number, attempt: () => Promise<T>): Promise<T> {
  let lastError: Error | null = null;

  for (let n = 1; n <= attempts; n += 1) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error as Error;
      const retryable =
        error instanceof LlmError ? error.retryable : error instanceof SyntaxError;
      if (!retryable || n === attempts) break;
      await sleep(2 ** n * 1000);
    }
  }

  throw lastError ?? new LlmError('原因不明の失敗');
}

/** JSON 文字列を zod で検証する。形が違えば再試行できるエラーにする。 */
export function parseWithSchema<S extends ZodTypeAny>(text: string, schema: S): z.infer<S> {
  const parsed = schema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'} — ${i.message}`)
      .join('; ');
    throw new LlmError(`応答が期待した形になっていません: ${issues}`, undefined, true);
  }
  return parsed.data;
}
