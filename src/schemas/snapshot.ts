import { z } from 'zod';
import { CharacterId, EraId } from './world.js';
import { UNIT_RANGE, MEMORY_IMPORTANCE } from './limits.js';
import { Bilingual } from './bilingual.js';

/**
 * Persona Snapshot — PixTale が読む、圧縮済みの人物像。
 *
 * これは日記の要約ではない。**人生の結果として残った人物像**である。
 * 出来事は characters/<id>/diaries/ に残っていればよく、ここには
 * 「その人生を送った人物だから、その物をそのように見る」に必要なものだけが入る。
 *
 * このスキーマは PixTale Proxy との契約である。実行時の連携はファイル取得の一方向だけで、
 * 両リポジトリはデプロイも CI も独立している。したがってここを壊すと、
 * こちらの CI が緑のまま向こうが壊れる。フィールドの削除・改名は避けること。
 *
 * 仕様は docs/persona-snapshot.md。
 */

const unit = () => z.number().min(UNIT_RANGE.min).max(UNIT_RANGE.max);

export const SnapshotSchema = z.object({
  /** ファイル名の vNNNN と一致する。追記のみで、既存バージョンは上書きしない。 */
  version: z.number().int().min(1),
  character: CharacterId,
  era: EraId,
  compiled_at: z.string(),

  /**
   * 何から圧縮したか。
   * 人格が不自然に変わったときに、ピンをどこまで戻すかを判断する材料になる。
   */
  source: z.object({
    /** 圧縮の時点で書かれていた日記の本数 */
    diaries: z.number().int().min(0),
    /** 最新の日記の日付。1本もなければ null */
    through: z.string().nullable(),
    memories: z.number().int().min(0),
    model: z.string(),
    prompt_version: z.string(),
  }),

  identity: z.object({
    name: Bilingual,
    age: z.number().int(),
    role: Bilingual,
    affiliation: z.string().min(1),
    designation: Bilingual.optional(),
  }),

  /** 話し方。Tale コメントがその人物の声で読めるかは、ここで決まる。 */
  voice: z.object({
    first_person: z.string().min(1),
    register: z.string().min(1),
    tic: z.string().min(1),
    never_says: z.string().min(1),
    closing: z.string().min(1),
    /** 定型が崩れる瞬間。日記では成長の節目、Tale コメントではレア演出になる。 */
    rare_expression: z.string().min(1),
  }),

  /**
   * 物の見方。
   *
   * humor を落とさないこと。PixTale が止まったのは出力が十分に面白くなかったからであり、
   * 育った人格が真面目になりすぎて笑いを殺すのが、この企画の最悪の失敗モードである。
   */
  appraisal: z.object({
    question: z.string().min(1),
    focus: z.string().min(1),
    bias: z.string().min(1),
    humor: z.string().min(1),
  }),

  /** 信じていること。強い順。 */
  values: z.array(z.object({ belief: z.string().min(1), strength: unit() })),
  /** 性格。強い順。 */
  temperament: z.array(z.object({ trait: z.string().min(1), level: unit() })),

  /** 現在の人物状態の要約。日記の全文ではなく、いまどこに立っているか。 */
  standing: z.object({
    mood: z.string().min(1),
    pursuing: z.string().min(1),
    doubting: z.string().min(1),
    weighing: z.array(z.string().min(1)),
    unsettled: z.array(z.string().min(1)),
    habits: z.array(z.string().min(1)),
  }),

  /** 動かない人生の事実。canon 由来。 */
  life_facts: z.array(z.string().min(1)),

  /** 覚えていること。importance の高い順。 */
  remembered: z.array(
    z.object({
      summary: z.string().min(1),
      weight: z.number().min(MEMORY_IMPORTANCE.min).max(MEMORY_IMPORTANCE.max),
      formed_on: z.string(),
    }),
  ),

  /**
   * 人生が残した癖。**関係そのものではなく、関係が残したもの。**
   *
   * 「親友に約束を破られた」ではなく「口約束を信用しない」。前者は日記に残っていればよく、
   * Tale コメントに必要なのは後者だけである。ここだけが生成を経る。
   */
  dispositions: z.array(z.string().min(1)),

  /** 知識境界。自分の時代より後を知らない人物が、時代の外の物をどう読むか。 */
  knowledge_boundary: z.object({
    era: z.string().min(1),
    years: z.string().min(1),
    familiar: z.string().min(1),
    note: z.string().min(1),
  }),
});

export type Snapshot = z.infer<typeof SnapshotSchema>;

/** characters/<id>/snapshots/vNNNN.json のファイル名 */
export const SNAPSHOT_FILE = /^v(\d{4})\.json$/;

export const snapshotFileName = (version: number): string =>
  `v${String(version).padStart(4, '0')}.json`;
