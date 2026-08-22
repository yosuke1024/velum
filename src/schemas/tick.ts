import { z } from 'zod';
import { CharacterId, EraId } from './world.js';

/**
 * World Tick — その日、その時代で何が起きたか。
 *
 * Tick は「起きた事実」であって、人物がどう受け取ったかではない。
 * 認識と解釈は Diary 側の仕事である。この分離により、日記が事実を上書きできなくなる。
 */
export const TickSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  era: EraId,
  protagonist: CharacterId,

  /** 引いたイベントカード。同じカードでも、その人の現在状態で別の日になる。 */
  card: z.object({
    id: z.string().min(1),
    prompt: z.string().min(1),
  }),

  /** 参照したアークと未解決スレッド */
  arc: z.object({
    id: z.string().min(1),
    thread: z.string().nullable(),
  }),

  /** その日に起きた出来事。主観を含めない。 */
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

  /** 世界の側の状態変化（人物の内面ではない） */
  world_change: z.string().nullable(),

  generation: z.object({
    model: z.string(),
    prompt_version: z.string(),
    seed: z.string(),
    generated_at: z.string(),
  }),
});

export type Tick = z.infer<typeof TickSchema>;

/** 生成に失敗した日、または上限違反で破棄した日の記録。欠けた日は隠さない。 */
export const FailureSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  era: EraId,
  protagonist: CharacterId,
  stage: z.enum(['tick', 'diary']),
  reason: z.string().min(1),
  violations: z.array(z.string()),
  recorded_at: z.string(),
});

export type Failure = z.infer<typeof FailureSchema>;
