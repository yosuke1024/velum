import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { ROOT } from '../../lib/paths.js';

/**
 * 執筆者（Astra）の呼び出し設定 — authoring/writer.yaml。
 *
 * 新しい制作経路（story:doctor / story:draft / story:revise）がモデル ID を知る場所はここ1か所で、
 * 実行のたびに CLI へ明示して渡す。旧経路の VELUM_MODEL / VELUM_STORY_MODEL /
 * generateJson() の既定値は読まない（落ちた先で別のモデルが黙って書くことを許さない）。
 *
 * スキーマは strict。`fallback` と `provider` はリテラルで、別の値を書けば読み込みで落ちる。
 */

export const WRITER_CONFIG_PATH = join(ROOT, 'authoring', 'writer.yaml');

const SEMVER = /^\d+\.\d+\.\d+$/;

export const WRITER_VERBOSITIES = ['low', 'medium', 'high'] as const;
export type WriterVerbosity = (typeof WRITER_VERBOSITIES)[number];

export const CREDENTIALS_STORES = ['keyring', 'file', 'auto'] as const;
export type CredentialsStore = (typeof CREDENTIALS_STORES)[number];

/** effort の値の形。対応の有無はモデルカタログ（preflight）が決める。 */
export const EFFORT_PATTERN = /^[a-z]+$/;

export const WriterConfigSchema = z
  .object({
    provider: z.literal('codex-cli'),
    model: z.string().min(1),
    reasoning_effort: z.string().regex(EFFORT_PATTERN),
    verbosity: z.enum(WRITER_VERBOSITIES).nullable(),
    fallback: z.literal('none'),
    authentication: z.literal('chatgpt'),
    credentials_store: z.enum(CREDENTIALS_STORES),
    /** リポジトリ root からの相対パス */
    instructions: z.string().min(1),
    timeout_minutes: z.number().int().min(1).max(240),
    cli: z
      .object({
        command: z.string().min(1),
        min_version: z.string().regex(SEMVER),
      })
      .strict(),
  })
  .strict();

export type WriterConfig = z.infer<typeof WriterConfigSchema>;

/**
 * zod の指摘を「どの欄がどう悪いか」の1行にする。
 * `unrecognized_keys` は path が「余計なキーを持つオブジェクト」を指し（トップレベルなら空）、
 * キー名は issue.keys に入る。そのまま path だけを使うと欄の名前が消えるので、キーごとに展開する。
 */
function describeIssue(issue: z.ZodIssue): string[] {
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((key) => {
      const field = [...issue.path, key].join('.');
      return `${field} — 知らないキーです（writer.yaml が受け付ける欄だけを書いてください）`;
    });
  }
  return [`${issue.path.join('.') || '(root)'} — ${issue.message}`];
}

/** writer.yaml を読んで検証する。合わなければ、どの欄が悪いかを添えて投げる。 */
export function loadWriterConfig(path: string = WRITER_CONFIG_PATH): WriterConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(
      `${path} を読めません: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    throw new Error(
      `${path} を YAML として読めません: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = WriterConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.flatMap(describeIssue).join('\n  ');
    throw new Error(`${path} が執筆設定のスキーマに合いません:\n  ${issues}`);
  }
  return result.data;
}
