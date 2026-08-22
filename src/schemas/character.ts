import { z } from 'zod';
import { CharacterId, EraId } from './world.js';
import { MEMORY_IMPORTANCE, UNIT_RANGE } from './limits.js';

const Bilingual = z.object({
  ja: z.string().min(1),
  en: z.string().min(1),
});

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

  voice: z.object({
    first_person: z.string().min(1),
    register: z.string().min(1),
    tic: z.string().min(1),
    never_says: z.string().min(1),
    closing: z.string().min(1),
  }),

  appraisal: z.object({
    question: z.string().min(1),
    focus: z.string().min(1),
    bias: z.string().min(1),
    humor: z.string().min(1),
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
  formative_events: z
    .array(
      z.object({
        id: z.string().min(1),
        fact: z.string().min(1),
      }),
    )
    .min(3),
  facts: z.array(
    z.object({
      id: z.string().min(1),
      fact: z.string().min(1),
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
        relation: z.string().min(1),
        trust: unit(),
        wariness: unit(),
        summary: z.string().min(1),
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
