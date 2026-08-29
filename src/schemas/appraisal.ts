import { z } from 'zod';
import { ERA_IDS } from './world.js';
import { Bilingual } from './bilingual.js';

/**
 * World Appraisal Snapshot — PixTale プロキシが読む、圧縮済みの世界文脈。
 *
 * Persona Snapshot が「人物の圧縮」なら、これは「世界の圧縮」である。
 * カード1枚の鑑定文に要るのは全文 Lore ではなく、各時代の輪郭——
 * 価値観・禁忌・使える固有名詞・存在しないもの——だけで足りる。
 *
 * 契約は pixapps 側 `docs/current/pixtale_v2_contracts.md` §2。
 * 配布は `world/appraisal/vNNNN.json`（追記のみ・上書き禁止）で、
 * ピンは `world/personas.json` の `world` フィールド（additive 追加）。
 *
 * 素材は world/canon/*.yaml からの射影で、生成は経ない。日本語単一
 * （プロンプト素材であり表示物ではない）。全文日記・全文 Lore は含めない。
 */

export const APPRAISAL_SCHEMA_VERSION = 1;

/** サイズ上限 12KB（契約 §2.2）。validate と compile の両方が enforce する。 */
export const APPRAISAL_SIZE_LIMIT = 12 * 1024;

export const AppraisalEraSchema = z.object({
  name: Bilingual,
  order: z.number().int().min(1).max(5),
  years: z.string().min(1),
  /** 時代・文明・技術・魔法水準の要約。 */
  profile: z.string().min(1),
  /** 価値観・恐れ。 */
  values: z.array(z.string().min(1)).min(1),
  /** 禁忌。 */
  taboos: z.array(z.string().min(1)).min(1),
  /** 使用可能な固有名詞（勢力・地名・行事）。canon の名前からの射影。 */
  terms: z.array(z.string().min(1)).min(1),
  /** 参照可能な正史上の出来事・進行中アークの要約。 */
  events: z.array(z.string().min(1)).min(1),
  /** この時代に存在しない技術・禁止設定。 */
  absent: z.array(z.string().min(1)).min(1),
});

export const WorldAppraisalSchema = z.object({
  schema_version: z.literal(APPRAISAL_SCHEMA_VERSION),
  /** ファイル名の vNNNN と一致する。追記のみで、既存バージョンは上書きしない。 */
  version: z.number().int().min(1),
  compiled_at: z.string(),
  season: z.number().int().min(1),
  /** 生成を使った場合のみ。射影だけなら現れない。 */
  source: z.object({ model: z.string(), prompt_version: z.string() }).optional(),
  /** 世界共通の基本法則。world/canon/laws.yaml の ja 射影。 */
  laws: z.array(z.string().min(1)).min(1),
  /** 見立て規則。Snapshot にない事物の扱い方。 */
  expression_rules: z.array(z.string().min(1)).min(1),
  /** 5時代すべてが必須。 */
  eras: z.object(
    Object.fromEntries(ERA_IDS.map((id) => [id, AppraisalEraSchema])) as Record<
      (typeof ERA_IDS)[number],
      typeof AppraisalEraSchema
    >,
  ),
});

export type WorldAppraisal = z.infer<typeof WorldAppraisalSchema>;
export type AppraisalEra = z.infer<typeof AppraisalEraSchema>;

/** world/appraisal/vNNNN.json のファイル名。Persona Snapshot と同じ形。 */
export const APPRAISAL_FILE = /^v(\d{4})\.json$/;

export const appraisalFileName = (version: number): string =>
  `v${String(version).padStart(4, '0')}.json`;
