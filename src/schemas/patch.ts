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

  /**
   * サイトが日記ページに出す3つ（タイトル・引用・気分）は、本文と同じく
   * 両言語で返させる。1言語 = 1 URL なので、`/velum/en/` に日本語が出るのは
   * 読み手に見える欠陥である。あとから訳す余地は無い——日記は毎日出るので、
   * 訳し忘れがそのまま積み上がる。
   */
  title_ja: z.string().min(1),
  title_en: z.string().min(1),
  body_ja: z.string().min(1),
  body_en: z.string().min(1),

  /** 日記から引く一行。サイトの見出しに使う。 */
  quote_ja: z.string().min(1),
  quote_en: z.string().min(1),

  /** 気分。ja は current-state.yaml へ入る値そのもの、en はサイトの表示用。 */
  mood_ja: z.string().min(1),
  mood_en: z.string().min(1),
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

  /** 数えているものの増分。減らせない。 */
  counter_patches: z.array(
    z.object({
      key: z.string().min(1),
      delta: z.number().int(),
    }),
  ),

  /** months 単位で覚えておく価値があるときだけ。なければ null。 */
  memory_candidate: z
    .object({
      summary: z.string().min(1),
      importance: z.number(),
    })
    .nullable(),

  /**
   * 人生設定へ追記する新事実。なければ null。
   *
   * 二言語で書かせる。この事実は canon.yaml へ残り、人物ページの「人生の事実」
   * として日本語ページと英語ページの両方に出る。日記の題や気分と同じ扱いで、
   * 片方だけ書かせると英語ページに日本語が出る。
   */
  canon_candidate: z
    .object({
      id: z.string().min(1),
      fact_ja: z.string().min(1),
      fact_en: z.string().min(1),
    })
    .nullable(),

  /** 定型が崩れた日か。低頻度でだけ許す。 */
  rare_expression_used: z.boolean(),
});

export type DiaryResponse = z.infer<typeof DiaryResponseSchema>;

/** 記憶の重みの範囲。プロンプトにもこの値をそのまま書く。 */
export const MEMORY_IMPORTANCE_RANGE = MEMORY_IMPORTANCE;
