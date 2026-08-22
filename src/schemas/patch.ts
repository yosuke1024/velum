import { z } from 'zod';
import { MEMORY_IMPORTANCE } from './limits.js';

/**
 * モデルが返す差分。
 *
 * 状態の全体ではなく差分を返させる。全体を返させると、モデルは毎回「今の自分」を
 * 書き直すことになり、少しずつ極端な方向へ寄っていく。差分なら動いた分だけが見える。
 *
 * ここでは範囲を検証しない。範囲の検証は src/diary/gate.ts が行い、
 * 違反は「クランプ」ではなく「その日の破棄」になる。
 * スキーマ側でクランプすると、壊れたプロンプトがそれらしく見える状態の裏に隠れる。
 */
export const DiaryResponseSchema = z.object({
  /** 人物が認識した事実。Tick の出来事を、その人の目でどう受け取ったか。 */
  perception: z.string().min(1),

  title: z.string().min(1),
  body_ja: z.string().min(1),
  body_en: z.string().min(1),

  /** 日記から引く一行。サイトの見出しに使う。 */
  quote: z.string().min(1),

  mood: z.string().min(1),
  immediate_goal: z.string().min(1),
  doubt: z.string().min(1),

  relationship_patches: z.array(
    z.object({
      id: z.string().min(1),
      trust_delta: z.number(),
      wariness_delta: z.number(),
      note: z.string().min(1),
    }),
  ),

  trait_patches: z.array(
    z.object({
      key: z.string().min(1),
      delta: z.number(),
    }),
  ),

  belief_patches: z.array(
    z.object({
      key: z.string().min(1),
      delta: z.number(),
    }),
  ),

  new_concerns: z.array(z.string().min(1)),
  new_unresolved_thoughts: z.array(z.string().min(1)),

  /** months 単位で覚えておく価値があるときだけ。なければ null。 */
  memory_candidate: z
    .object({
      summary: z.string().min(1),
      importance: z.number(),
    })
    .nullable(),

  /** 人生設定へ追記する新事実。なければ null。 */
  canon_candidate: z
    .object({
      id: z.string().min(1),
      fact: z.string().min(1),
    })
    .nullable(),

  /** 定型が崩れた日か。低頻度でだけ許す。 */
  rare_expression_used: z.boolean(),
});

export type DiaryResponse = z.infer<typeof DiaryResponseSchema>;

/** 記憶の重みの範囲。プロンプトにもこの値をそのまま書く。 */
export const MEMORY_IMPORTANCE_RANGE = MEMORY_IMPORTANCE;
