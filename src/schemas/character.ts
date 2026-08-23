import { z } from 'zod';
import { CharacterId, EraId } from './world.js';
import { MEMORY_IMPORTANCE, UNIT_RANGE } from './limits.js';

const Bilingual = z.object({
  ja: z.string().min(1),
  en: z.string().min(1),
});

/**
 * まだ訳されていないかもしれない一文。
 *
 * サイトは 1言語 = 1 URL で、`/velum/en/` は英語しか出さない場所である。訳の無い
 * フィールドはそこに日本語のまま出てしまうので、読み手に見える欠陥になる。
 *
 * 手で書く固定層（profile / relationships / canon.formative_events）は
 * `Bilingual` を必須にして、書いた時点で欠落が止まる形にしてある。ここが緩いのは
 * `canon.facts` だけで、あれは日記の生成が1日1件まで追記できる配列だから——
 * 生成が英語を出せるようになるまで、素の文字列も受ける。
 *
 * 素の文字列は「未訳」であって「英語がある」ではない。読む側は必ず ja へ落とす。
 */
const MaybeBilingual = z.union([Bilingual, z.string().min(1)]);

const unit = () => z.number().min(UNIT_RANGE.min).max(UNIT_RANGE.max);

/**
 * 固定層。生成は絶対にこのファイルを書き換えない。
 * 書き込み可能な表現をどこにも作らないことが、検証ルールより強い保証になる。
 */
export const ProfileSchema = z.object({
  id: CharacterId,
  era: EraId,
  name: Bilingual,
  age: z.number().int().min(16).max(29),
  gender: z.enum(['male', 'female']),
  role: Bilingual,
  affiliation: z.string().min(1),
  designation: z.string().optional(),

  appeal_axis: z.string().min(1),
  reader_distance: z.string().min(1),

  core: z.object({
    wish: z.string().min(1),
    fear: z.string().min(1),
    contradiction: z.string().min(1),
    secret_hidden: z.string().min(1),
    secret_unknown_to_self: z.string().min(1),
    note: z.string().optional(),
  }),

  // register は生成プロンプト専用で、サイトへは出ない。出るものだけ二言語。
  voice: z.object({
    first_person: Bilingual,
    register: z.string().min(1),
    tic: Bilingual,
    never_says: Bilingual,
    closing: Bilingual,
  }),

  appraisal: z.object({
    question: Bilingual,
    focus: z.string().min(1),
    bias: Bilingual,
    humor: Bilingual,
    note: z.string().optional(),
  }),

  rare_expression: z.string().min(1),

  visual: z
    .object({
      build: z.string().min(1),
      hair: z.string().min(1),
      key_prop: z.string().min(1),
      palette: z.record(z.union([z.string(), z.array(z.string())])),
      acceptance: z.string().min(1),
    })
    .passthrough(),
});

/** 追記のみ。1日に最大1件の新事実。既存の書き換え・削除は生成側から行えない。 */
export const CanonSchema = z.object({
  id: CharacterId,
  /** 手で書く土台。追記されないので二言語を必須にできる。 */
  formative_events: z
    .array(
      z.object({
        id: z.string().min(1),
        fact: Bilingual,
      }),
    )
    .min(3),
  /** 日記の生成が1日1件まで追記する。生成が英語を出すまで素の文字列も受ける。 */
  facts: z.array(
    z.object({
      id: z.string().min(1),
      fact: MaybeBilingual,
      added_on: z.string().optional(),
      note: z.string().optional(),
    }),
  ),
});

/** 日次で動く層。差分で更新される。 */
export const CurrentStateSchema = z
  .object({
    id: CharacterId,
    updated_at: z.string().nullable(),
    mood: z.string().min(1),
    immediate_goal: z.string().min(1),
    doubt: z.string().min(1),
    concerns: z.array(z.string().min(1)),
    unresolved_thoughts: z.array(z.string().min(1)),
    traits: z.record(unit()),
    beliefs: z.record(unit()),
    habits: z.array(z.string().min(1)),
    /**
     * 数えているもの。カヤの「届けた人数」など、本人が口に出す数字。
     * プロンプトへ渡さないと、日記のたびに数が変わってしまう。
     */
    counters: z.record(z.number().int().min(0)).optional(),
  })
  .passthrough();

/**
 * 関係。関係者は独立した日記を持たないので、ここが彼らの唯一の記述場所になる。
 * hidden_from_protagonist は主人公が知らない事実であり、プロンプトへ渡してはいけない。
 */
export const RelationshipsSchema = z.object({
  id: CharacterId,
  people: z
    .array(
      z.object({
        id: z.string().min(1),
        name: Bilingual,
        relation: Bilingual,
        trust: unit(),
        wariness: unit(),
        summary: Bilingual,
        hidden_from_protagonist: z.string().optional(),
        visual: z.string().optional(),
        note: z.string().optional(),
        thread: z.string().optional(),
      }),
    )
    .length(2), // 主人公1人につき関係者2人
});

export const MemoriesSchema = z.object({
  id: CharacterId,
  memories: z.array(
    z.object({
      id: z.string().min(1),
      summary: z.string().min(1),
      importance: z
        .number()
        .min(MEMORY_IMPORTANCE.min)
        .max(MEMORY_IMPORTANCE.max),
      formed_on: z.string(),
    }),
  ),
});

export type Profile = z.infer<typeof ProfileSchema>;
export type Canon = z.infer<typeof CanonSchema>;
export type CurrentState = z.infer<typeof CurrentStateSchema>;
export type Relationships = z.infer<typeof RelationshipsSchema>;
export type Memories = z.infer<typeof MemoriesSchema>;
