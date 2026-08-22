import { z } from 'zod';
import { generateJson } from '../lib/gemini.js';
import { tickPath } from '../lib/paths.js';
import { writeJson } from '../lib/storage.js';
import { TickSchema, type Tick } from '../schemas/tick.js';
import type { EraId, CharacterId } from '../schemas/world.js';
import { buildTickContext } from './context.js';
import {
  buildTickSystemPrompt,
  buildTickUserPrompt,
  TICK_RESPONSE_SCHEMA,
  TICK_PROMPT_VERSION,
} from './prompt.js';

const TickResponseSchema = z.object({
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
  world_change: z.string().nullable(),
});

export async function generateTick(
  date: string,
  era: EraId,
  protagonist: CharacterId,
): Promise<Tick> {
  const context = buildTickContext(date, era, protagonist);

  const { data, model } = await generateJson(
    {
      system: buildTickSystemPrompt(),
      user: buildTickUserPrompt(context),
      responseSchema: TICK_RESPONSE_SCHEMA,
    },
    TickResponseSchema,
  );

  const tick: Tick = TickSchema.parse({
    date,
    era,
    protagonist,
    card: context.card,
    arc: { id: context.arc.id, thread: context.thread?.id ?? null },
    events: data.events,
    world_change: data.world_change,
    generation: {
      model,
      prompt_version: TICK_PROMPT_VERSION,
      seed: context.seed,
      generated_at: new Date().toISOString(),
    },
  });

  writeJson(tickPath(date), tick);
  return tick;
}
