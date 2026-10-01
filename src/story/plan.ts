import { z } from 'zod';
import { generateJson } from '../lib/llm.js';
import { readYaml, writeYaml, exists } from '../lib/storage.js';
import { ROOT } from '../lib/paths.js';
import {
  StoryPlanSchema,
  StoryManifestSchema,
  StoriesConfigSchema,
  StoryFormat,
  storyId,
  storyEpisodeId,
  DEFAULT_EPISODES_PER_STORY,
  MAX_EPISODES_PER_STORY,
  type StoryPlan,
  type StoryManifest,
} from '../schemas/story.js';
import type { CharacterId } from '../schemas/world.js';
import { buildStoryContext } from './context.js';
import {
  buildStoryPlanSystemPrompt,
  buildStoryPlanUserPrompt,
  STORY_PLAN_RESPONSE_SCHEMA,
  STORY_PROMPT_VERSION,
} from './prompt.js';
import { storyPaths } from './paths.js';

const PlanResponseSchema = z.object({
  title_ja: z.string().min(1),
  title_en: z.string().min(1),
  summary_ja: z.string().min(1),
  summary_en: z.string().min(1),
  character_arc: z.object({
    start: z.string().min(1),
    emotional_change: z.string().min(1),
    end: z.string().min(1),
  }),
  relationship_focus: z.array(z.string()),
  episodes: z
    .array(
      z.object({
        order: z.number().int(),
        purpose: z.string().min(1),
        situation: z.string().min(1),
        format: z.string(),
        people: z.array(z.string()),
        working_title: z.string().min(1),
      }),
    )
    .min(1)
    .max(MAX_EPISODES_PER_STORY),
});

export type Generate = typeof generateJson;

export type PlanStoryOptions = {
  characterId: CharacterId;
  season: number;
  /** 話数。省略時は DEFAULT_EPISODES_PER_STORY。 */
  episodes?: number;
  root?: string;
  now?: () => string;
  /** テストで差し替える。既定は src/lib/llm.ts の generateJson。 */
  generate?: Generate;
};

/**
 * 計画から manifest を同期する。**人間が manifest に書いたものは消さない。**
 *
 * - manifest が無ければ draft で作る。required_progress は既定の階段から写す。
 * - あれば、季の title / summary / status と、既存の話の status / title / required_progress
 *   を保つ。計画に増えた話だけを draft で足し、計画から消えた話は残す（本文があるかも
 *   しれないので、消すのは人間の仕事）。
 */
export function syncManifest(
  plan: StoryPlan,
  titles: { title: { ja: string; en: string }; summary: { ja: string; en: string } },
  existing: StoryManifest | null,
  ladder: number[],
): StoryManifest {
  const requiredProgressFor = (order: number): number =>
    ladder[order - 1] ?? ladder[ladder.length - 1] ?? 0;

  const planned = plan.episodes.map((episode) => {
    const kept = existing?.episodes.find((e) => e.order === episode.order);
    return {
      id: storyEpisodeId(plan.character_id, plan.season, episode.order),
      order: episode.order,
      required_progress: kept?.required_progress ?? requiredProgressFor(episode.order),
      status: kept?.status ?? ('draft' as const),
      ...(kept?.title ? { title: kept.title } : {}),
      format: kept?.format ?? episode.format,
      ...(kept?.summary ? { summary: kept.summary } : {}),
    };
  });

  const leftovers = (existing?.episodes ?? [])
    .filter((e) => !planned.some((p) => p.order === e.order))
    .map((e) => ({ ...e }));

  const episodes = [...planned, ...leftovers].sort((a, b) => a.order - b.order);

  return StoryManifestSchema.parse({
    id: plan.id,
    character_id: plan.character_id,
    season: plan.season,
    title: existing?.title ?? titles.title,
    summary: existing?.summary ?? titles.summary,
    status: existing?.status ?? 'draft',
    episodes,
  });
}

/**
 * 季の計画を立てる。plan.yaml を書き、manifest.yaml を同期する。
 *
 * 生成物はそのまま公開されない。plan.yaml は人間が読んで直すファイルで、
 * manifest.yaml は draft のまま。本文は story:write が別に書く。
 */
export async function planStory(options: PlanStoryOptions): Promise<{ plan: StoryPlan; manifest: StoryManifest }> {
  const root = options.root ?? ROOT;
  const generate = options.generate ?? generateJson;
  const now = options.now ?? (() => new Date().toISOString());
  const episodes = options.episodes ?? DEFAULT_EPISODES_PER_STORY;
  if (!Number.isInteger(episodes) || episodes < 1 || episodes > MAX_EPISODES_PER_STORY) {
    throw new Error(`話数は 1〜${MAX_EPISODES_PER_STORY} の整数です（${episodes}）`);
  }

  const context = buildStoryContext(options.characterId, root);
  const paths = storyPaths(options.characterId, options.season, root);
  const ladder = readYaml(paths.config, StoriesConfigSchema).default_required_progress;

  const { data, model } = await generate(
    {
      system: buildStoryPlanSystemPrompt(),
      user: buildStoryPlanUserPrompt(context, { season: options.season, episodes }),
      responseSchema: STORY_PLAN_RESPONSE_SCHEMA,
    },
    PlanResponseSchema,
  );

  if (data.episodes.length !== episodes) {
    throw new Error(`${episodes}話を求めましたが ${data.episodes.length}話が返りました`);
  }

  const knownPeople = new Set(context.people.map((p) => p.id));

  const plan = StoryPlanSchema.parse({
    id: storyId(options.characterId, options.season),
    character_id: options.characterId,
    season: options.season,
    character_arc: data.character_arc,
    relationships: {
      // 周りの人の id だけ。モデルが名前で返しても、知らない id は落とす。
      focus: data.relationship_focus.filter((id) => knownPeople.has(id)).length
        ? data.relationship_focus.filter((id) => knownPeople.has(id))
        : context.people.map((p) => p.id),
    },
    episodes: data.episodes
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((episode, index) => ({
        order: index + 1,
        purpose: episode.purpose,
        situation: episode.situation,
        // 語彙の外の形式は scene に落とす。形式は人間が plan.yaml で直せる。
        format: StoryFormat.safeParse(episode.format).success ? (episode.format as StoryFormat) : 'scene',
        people: episode.people.filter((id) => knownPeople.has(id)),
        working_title: episode.working_title,
      })),
    generation: {
      model,
      prompt_version: STORY_PROMPT_VERSION,
      generated_at: now(),
    },
  });

  const existing = exists(paths.manifest) ? readYaml(paths.manifest, StoryManifestSchema) : null;
  const manifest = syncManifest(
    plan,
    {
      title: { ja: data.title_ja, en: data.title_en },
      summary: { ja: data.summary_ja, en: data.summary_en },
    },
    existing,
    ladder,
  );

  writeYaml(paths.plan, plan);
  writeYaml(paths.manifest, manifest);

  return { plan, manifest };
}
