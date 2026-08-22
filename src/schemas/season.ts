import { z } from 'zod';
import { CharacterId, EraId } from './world.js';

/**
 * 季（シーズン）— 1人につき5話、5人で25日分。
 *
 * 出来事はその日に即興で作らず、季の頭でまとめて計画する。
 * 毎日その場で作ると物語の形（発端→転機→決着）がどこにもなく、
 * 昨日の設定を今日が壊す。人物が反応するのは日ごとだが、
 * 世界が動く形はあらかじめ決まっている。
 *
 * 計画は人間が読んで直せる。それがこの構造の主目的である。
 */

export const BEATS = ['発端', '展開', '転機', '危機', '決着'] as const;
export const Beat = z.enum(BEATS);
export type Beat = z.infer<typeof Beat>;

export const EPISODES_PER_SEASON = 5;
/** 5人 × 5話。ローテーション1周が5日なので、1季は25日になる。 */
export const DAYS_PER_SEASON = EPISODES_PER_SEASON * 5;

export const EpisodeSchema = z.object({
  number: z.number().int().min(1).max(EPISODES_PER_SEASON),
  beat: Beat,

  /** その日に起きたこと。主観は含めない。 */
  events: z
    .array(
      z.object({
        summary: z.string().min(1),
        where: z.string().min(1),
        who: z.array(z.string()),
      }),
    )
    .min(1)
    .max(3),

  /** 世界の側の変化。人物の内面ではない。 */
  world_change: z.string().nullable(),

  /** この話が次へ残すもの。第5話では次の季へ残す残り火。 */
  leaves_open: z.string().min(1),
});

export type Episode = z.infer<typeof EpisodeSchema>;

export const SeasonPlanSchema = z.object({
  season: z.number().int().min(1),
  era: EraId,
  protagonist: CharacterId,
  arc: z.string().min(1),

  title: z.string().min(1),
  /** 5話でどういう形を描くか。人間が読んで直すための要約。 */
  shape: z.string().min(1),

  episodes: z.array(EpisodeSchema).length(EPISODES_PER_SEASON),

  generation: z.object({
    model: z.string(),
    prompt_version: z.string(),
    seed: z.string(),
    generated_at: z.string(),
  }),
});

export type SeasonPlan = z.infer<typeof SeasonPlanSchema>;

/** 生成に失敗した日、または上限違反で破棄した日の記録。欠けた日は隠さない。 */
export const FailureSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  era: EraId,
  protagonist: CharacterId,
  season: z.number().int().min(1),
  episode: z.number().int().min(1).max(EPISODES_PER_SEASON),
  stage: z.enum(['plan', 'diary']),
  reason: z.string().min(1),
  violations: z.array(z.string()),
  recorded_at: z.string(),
});

export type Failure = z.infer<typeof FailureSchema>;
