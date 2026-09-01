import { z } from 'zod';
import { generateJson } from '../lib/gemini.js';
import { seasonPath, worldPath } from '../lib/paths.js';
import { writeYaml, readYaml } from '../lib/storage.js';
import { linearDay, nextDay, type WorldClock } from '../lib/calendar.js';
import { ClocksFileSchema } from '../schemas/world.js';
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
  title_ja: z.string().min(1),
  title_en: z.string().min(1),
  shape_ja: z.string().min(1),
  shape_en: z.string().min(1),
  episodes: z
    .array(
      z.object({
        number: z.number().int(),
        beat: z.string(),
        world_date: z.object({
          month: z.number().int().min(1).max(13),
          day: z.number().int().min(1).max(30),
        }),
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
        leaves_open_ja: z.string().min(1),
        leaves_open_en: z.string().min(1),
      }),
    )
    .length(EPISODES_PER_SEASON),
});

/** 日付の並びを検証する。単調非減少・開始日以降・季全体で60日以内。 */
function assertDatesSane(
  episodes: Array<{ number: number; world_date: { month: number; day: number } }>,
  clock: { month: number; day: number },
): void {
  let previous = linearDay(clock);
  const start = previous;

  for (const episode of episodes) {
    const current = linearDay(episode.world_date);
    if (current < previous) {
      throw new Error(
        `第${episode.number}話の日付が前の話より過去です（年内通日 ${current} < ${previous}）。` +
          '季の計画は年をまたげません。',
      );
    }
    previous = current;
  }

  if (previous - start > 60) {
    throw new Error(
      `季全体で${previous - start}日進んでいます（上限60日）。目安は20〜40日です。`,
    );
  }
}

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
      world_date: episode.world_date,
      events: episode.events,
      world_change: episode.world_change,
      leaves_open: { ja: episode.leaves_open_ja, en: episode.leaves_open_en },
    }));

  assertDatesSane(episodes, context.clock);

  const plan = SeasonPlanSchema.parse({
    season,
    era,
    protagonist,
    arc: context.arc.id,
    year_in_world: context.clock.year,
    title: { ja: data.title_ja, en: data.title_en },
    shape: { ja: data.shape_ja, en: data.shape_en },
    episodes,
    generation: {
      model,
      prompt_version: SEASON_PROMPT_VERSION,
      seed: context.seed,
      generated_at: new Date().toISOString(),
    },
  });

  writeYaml(seasonPath(season, era), plan);

  // 時計を、最終話の翌日へ進める。次の季はここから始まる。
  const last = episodes[episodes.length - 1];
  if (last) {
    const clocks = readYaml(worldPath('clocks.yaml'), ClocksFileSchema);
    const updated = clocks.clocks.map((clock) =>
      clock.era === era
        ? nextDay(era, { ...clock, ...last.world_date } as WorldClock)
        : clock,
    );
    writeYaml(worldPath('clocks.yaml'), { clocks: updated });
  }

  return plan;
}
