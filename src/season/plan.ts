import { z } from 'zod';
import { generateJson } from '../lib/gemini.js';
import { seasonPath } from '../lib/paths.js';
import { writeYaml } from '../lib/storage.js';
import {
  SeasonPlanSchema,
  BEATS,
  EPISODES_PER_SEASON,
  type SeasonPlan,
} from '../schemas/season.js';
import type { EraId, CharacterId } from '../schemas/world.js';
import { buildSeasonContext } from './context.js';
import {
  buildSeasonSystemPrompt,
  buildSeasonUserPrompt,
  SEASON_RESPONSE_SCHEMA,
  SEASON_PROMPT_VERSION,
} from './prompt.js';

const SeasonResponseSchema = z.object({
  title: z.string().min(1),
  shape: z.string().min(1),
  episodes: z
    .array(
      z.object({
        number: z.number().int(),
        beat: z.string(),
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
        leaves_open: z.string().min(1),
      }),
    )
    .length(EPISODES_PER_SEASON),
});

/**
 * 季の計画を立てる。
 *
 * 生成物はそのまま走らせず、YAML として書き出して人間が読めるようにする。
 * 出来事を前もって決める狙いは、物語の形を作ることと、**Yoh が読んで直せること**の両方。
 */
export async function planSeason(
  season: number,
  era: EraId,
  protagonist: CharacterId,
): Promise<SeasonPlan> {
  const context = buildSeasonContext(season, era, protagonist);

  const { data, model } = await generateJson(
    {
      system: buildSeasonSystemPrompt(),
      user: buildSeasonUserPrompt(context),
      responseSchema: SEASON_RESPONSE_SCHEMA,
    },
    SeasonResponseSchema,
  );

  // beat の並びはこちらで決める。モデルの言い換えを通さない。
  const episodes = data.episodes
    .slice()
    .sort((a, b) => a.number - b.number)
    .map((episode, index) => ({
      number: index + 1,
      beat: BEATS[index] as (typeof BEATS)[number],
      events: episode.events,
      world_change: episode.world_change,
      leaves_open: episode.leaves_open,
    }));

  const plan = SeasonPlanSchema.parse({
    season,
    era,
    protagonist,
    arc: context.arc.id,
    title: data.title,
    shape: data.shape,
    episodes,
    generation: {
      model,
      prompt_version: SEASON_PROMPT_VERSION,
      seed: context.seed,
      generated_at: new Date().toISOString(),
    },
  });

  writeYaml(seasonPath(season, era), plan);
  return plan;
}
