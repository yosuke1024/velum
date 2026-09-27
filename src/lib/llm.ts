import type { ZodTypeAny, z } from 'zod';
import { LlmError, type LlmRequest, type LlmResult } from './llm-core.js';
import { generateJsonWorkersAi, WORKERS_AI_DEFAULT_MODEL } from './workers-ai.js';
import { generateJsonGemini, GEMINI_DEFAULT_MODEL } from './gemini.js';

/**
 * 生成の入口。日記・季の計画・Snapshot はここだけを呼ぶ。
 *
 * 既定は Cloudflare Workers AI の Gemma（src/lib/workers-ai.ts）。VELUM_PROVIDER=gemini で
 * 以前の Gemini（src/lib/gemini.ts）に戻せる。どちらで書かれたかは各日の
 * generation.model に残るので、切り替えの前後は並べて読み比べられる。
 */

export type { LlmRequest, LlmResult } from './llm-core.js';
export { LlmError } from './llm-core.js';

export type Provider = 'workers-ai' | 'gemini';

export function provider(): Provider {
  const value = process.env.VELUM_PROVIDER?.trim();
  if (!value || value === 'workers-ai') return 'workers-ai';
  if (value === 'gemini') return 'gemini';
  throw new LlmError(`VELUM_PROVIDER が不明です: ${value}（workers-ai / gemini）`);
}

/** プロバイダの既定モデル。VELUM_MODEL / VELUM_DIARY_MODEL が無いときに使う。 */
export function defaultModel(): string {
  return provider() === 'gemini' ? GEMINI_DEFAULT_MODEL : WORKERS_AI_DEFAULT_MODEL;
}

export async function generateJson<S extends ZodTypeAny>(
  request: LlmRequest,
  schema: S,
  options: { attempts?: number } = {},
): Promise<LlmResult<z.infer<S>>> {
  return provider() === 'gemini'
    ? generateJsonGemini(request, schema, options)
    : generateJsonWorkersAi(request, schema, options);
}

/**
 * zod スキーマを持たない呼び出し側のための、素の JSON Schema 断片。
 *
 * nullable は Gemini の方言（OpenAPI 風）で持つ。Workers AI へ渡すときは
 * workers-ai.ts が標準の anyOf [型, null] に書き換える。
 */
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
