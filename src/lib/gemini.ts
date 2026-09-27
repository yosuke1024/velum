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
 * Gemini への最小の通信層。
 *
 * 2026-09-27 に既定から外した（src/lib/llm.ts）。VELUM_PROVIDER=gemini と
 * GEMINI_API_KEY を渡せば選べる。読み比べのために残してある。
 */

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Gemini 2.5 系は 2026-10-16 に提供終了するため、後継を指す。 */
export const GEMINI_DEFAULT_MODEL = 'gemini-3.5-flash';

export async function generateJsonGemini<S extends ZodTypeAny>(
  request: LlmRequest,
  schema: S,
  options: { attempts?: number } = {},
): Promise<LlmResult<z.infer<S>>> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new LlmError('GEMINI_API_KEY が設定されていません。');
  }

  const model = request.model ?? (process.env.VELUM_MODEL?.trim() || GEMINI_DEFAULT_MODEL);
  const attempts = options.attempts ?? 3;

  return withRetries(attempts, async () => {
    const response = await fetch(`${ENDPOINT}/${model}:generateContent?key=${apiKey}`, {
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
    });

    if (!response.ok) {
      const body = await response.text();
      throw new LlmError(
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
      throw new LlmError('応答が空でした。', undefined, true);
    }

    const data = parseWithSchema(text, schema);
    return { data, model, raw: text };
  });
}
