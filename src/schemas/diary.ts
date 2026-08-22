import { z } from 'zod';
import { CharacterId, EraId } from './world.js';

/** サイトが描画する日記のエントリ。 */
export const DiaryEntrySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  era: EraId,
  protagonist: CharacterId,
  title: z.string().min(1),
  quote: z.string().min(1),
  mood: z.string().min(1),
  rare_expression_used: z.boolean(),
  tick_card: z.string().min(1),
});

export type DiaryEntry = z.infer<typeof DiaryEntrySchema>;

/**
 * 適用された差分の記録。何がどう動いたかを、あとから追える形で残す。
 * git 履歴と合わせて、これが実験記録の本体になる。
 */
export const DiaryEventSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  protagonist: CharacterId,
  applied: z.object({
    mood: z.tuple([z.string(), z.string()]),
    immediate_goal: z.tuple([z.string(), z.string()]),
    doubt: z.tuple([z.string(), z.string()]),
    relationships: z.array(
      z.object({
        id: z.string(),
        trust: z.tuple([z.number(), z.number()]),
        wariness: z.tuple([z.number(), z.number()]),
        note: z.string(),
      }),
    ),
    traits: z.array(
      z.object({ key: z.string(), from: z.number(), to: z.number() }),
    ),
    beliefs: z.array(
      z.object({ key: z.string(), from: z.number(), to: z.number() }),
    ),
    concerns_added: z.array(z.string()),
    thoughts_added: z.array(z.string()),
    memory_promoted: z.string().nullable(),
    canon_added: z.string().nullable(),
  }),
  /** 切り詰めた項目。破棄ではないが、黙って捨てない。 */
  truncated: z.array(z.string()),
  generation: z.object({
    model: z.string(),
    prompt_version: z.string(),
    generated_at: z.string(),
  }),
});

export type DiaryEvent = z.infer<typeof DiaryEventSchema>;
