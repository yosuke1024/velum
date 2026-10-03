import { z } from 'zod';
import { CharacterId } from './world.js';
import { Bilingual } from './bilingual.js';

/**
 * Character Story — 人物ごとに厳選して制作し、PixTale の Journey Progress で解放する物語。
 *
 * 単位は Character → Season → Episode。ソースは
 * `characters/<id>/stories/s<NN>/` に置く（docs/stories.md §3）:
 *
 *   plan.yaml      季の計画。story:plan が書き、人間が読んで直す
 *   manifest.yaml  公開の台帳。話ごとの状態と unlock 条件。本文から切り離す
 *   e<NN>.ja.md    本文（日本語）。プレーンテキスト、段落は空行区切り
 *   e<NN>.en.md    本文（英語）
 *
 * **生成 ≠ 公開。** 状態は draft → reviewed → published と進み、feed
 * （world/feed/stories/）へ出るのは季と話の両方が published のものだけ。
 * 人間が読まずに公開される経路は無い——story:write は published に触れない。
 *
 * 旧 Diary Engine の「季」（world/seasons/、5話×5人の25日）とは別物である。
 * こちらは人物ひとりの物語の束で、話数も日付も持たない。
 */

export const STORY_STATUSES = ['draft', 'reviewed', 'published'] as const;
export const StoryStatus = z.enum(STORY_STATUSES);
export type StoryStatus = z.infer<typeof StoryStatus>;

/** 状態の順序。話の状態は季の状態を越えられない。 */
export const STORY_STATUS_RANK: Record<StoryStatus, number> = {
  draft: 0,
  reviewed: 1,
  published: 2,
};

/**
 * 話ごとに選べる形式。日記形式は必須にしない——人物の声は保つが、
 * 「本人がその日の夜に日記を書く」という制約からは解放する。
 */
export const STORY_FORMATS = [
  'first_person',
  'third_person',
  'dialogue',
  'letter',
  'record',
  'recollection',
  'scene',
] as const;
export const StoryFormat = z.enum(STORY_FORMATS);
export type StoryFormat = z.infer<typeof StoryFormat>;

/** 1季の話数。目安は 8〜10 話で、計画の既定は stories.yaml の default_episode_count。 */
export const STORY_EPISODE_LIMITS = { min: 1, max: 12 } as const;

/** 季の ID は `<character>-s<NN>`、話の ID は `<character>-s<NN>-e<NN>`。 */
export const STORY_SERIES_ID = /^([a-z]+)-s(\d{2})$/;
export const STORY_EPISODE_ID = /^([a-z]+)-s(\d{2})-e(\d{2})$/;

const pad2 = (n: number) => String(n).padStart(2, '0');
export const storySeriesId = (characterId: string, season: number) =>
  `${characterId}-s${pad2(season)}`;
export const storyEpisodeId = (seriesId: string, order: number) => `${seriesId}-e${pad2(order)}`;
/** ソースのディレクトリ名（s01）と本文のファイル名の幹（e01）。 */
export const storySeasonDirName = (season: number) => `s${pad2(season)}`;
export const storyEpisodeStem = (order: number) => `e${pad2(order)}`;

// ── manifest.yaml ──────────────────────────────────────────────

/** 生成の記録。plan.yaml と manifest の各話が同じ形で持つ。 */
export const StoryGenerationSchema = z
  .object({
    model: z.string().min(1),
    prompt_version: z.string().min(1),
    generated_at: z.string().min(1),
  })
  .strict();
export type StoryGeneration = z.infer<typeof StoryGenerationSchema>;

export const StoryEpisodeManifestSchema = z
  .object({
    id: z.string().regex(STORY_EPISODE_ID),
    order: z.number().int().min(1),
    /**
     * この話が解放される Journey Progress。第1話は 0（同行者を選んだ時点で読める）。
     * 季の中で単調非減少。値は stories.yaml の既定から始め、話ごとに直してよい。
     */
    required_progress: z.number().int().min(0),
    status: StoryStatus,
    /** draft のあいだは無くてよい。reviewed 以上には必須。 */
    title: Bilingual.optional(),
    summary: Bilingual.optional(),
    format: StoryFormat.optional(),
    /**
     * 本文を最後に生成したときの記録（story:write が書く）。人間が書いた話には無い。
     * feed には出さない——どのモデルで下書きしたかは制作側の記録である。
     */
    generation: StoryGenerationSchema.optional(),
  })
  .strict();

/**
 * 人間が手で直す台帳なので strict にする。`required_progres` のような打ち間違いが
 * 黙って捨てられ、別の欄の既定値で動いてしまうのを防ぐ。
 */
export const StoryManifestSchema = z
  .object({
    id: z.string().regex(STORY_SERIES_ID),
    character_id: CharacterId,
    season: z.number().int().min(1).max(99),
    title: Bilingual,
    summary: Bilingual.optional(),
    status: StoryStatus,
    episodes: z
      .array(StoryEpisodeManifestSchema)
      .min(STORY_EPISODE_LIMITS.min)
      .max(STORY_EPISODE_LIMITS.max),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    for (const message of storyManifestProblems(manifest)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    }
  });

export type StoryEpisodeManifest = z.infer<typeof StoryEpisodeManifestSchema>;
export type StoryManifest = z.infer<typeof StoryManifestSchema>;

/**
 * 台帳の不変条件。スキーマ（superRefine）と validate の両方がこれを読む。
 * ファイルをまたぐ整合（本文の有無・ディレクトリ名・feed）は validate が見る。
 */
export function storyManifestProblems(manifest: {
  id: string;
  character_id: string;
  season: number;
  status: StoryStatus;
  episodes: Array<{
    id: string;
    order: number;
    required_progress: number;
    status: StoryStatus;
    title?: unknown;
  }>;
}): string[] {
  const problems: string[] = [];
  const expectedId = storySeriesId(manifest.character_id, manifest.season);
  if (manifest.id !== expectedId) {
    problems.push(`id は ${expectedId} であること（character_id と season から決まる）: ${manifest.id}`);
  }

  manifest.episodes.forEach((episode, index) => {
    const order = index + 1;
    if (episode.order !== order) {
      problems.push(`episodes[${index}].order は ${order} であること（1 から欠番なく並べる）`);
    }
    const expectedEpisodeId = storyEpisodeId(manifest.id, episode.order);
    if (episode.id !== expectedEpisodeId) {
      problems.push(`episodes[${index}].id は ${expectedEpisodeId} であること: ${episode.id}`);
    }
    if (STORY_STATUS_RANK[episode.status] > STORY_STATUS_RANK[manifest.status]) {
      problems.push(
        `${episode.id} の status（${episode.status}）が季の status（${manifest.status}）を越えています`,
      );
    }
    if (episode.status !== 'draft' && episode.title === undefined) {
      problems.push(`${episode.id} は ${episode.status} なので title（ja / en）が要ります`);
    }
  });

  const first = manifest.episodes[0];
  if (first && first.required_progress !== 0) {
    problems.push(
      `第1話の required_progress は 0 であること（同行者を選んだ時点で読める）: ${first.required_progress}`,
    );
  }
  for (let i = 1; i < manifest.episodes.length; i++) {
    const previous = manifest.episodes[i - 1]!;
    const current = manifest.episodes[i]!;
    if (current.required_progress < previous.required_progress) {
      problems.push(
        `${current.id} の required_progress（${current.required_progress}）が前の話（${previous.required_progress}）より小さい`,
      );
    }
  }

  // 公開済みの話は第1話から連続していること。第3話だけ公開すると、解放の階段に穴が開く。
  let sawUnpublished = false;
  for (const episode of manifest.episodes) {
    if (episode.status !== 'published') {
      sawUnpublished = true;
    } else if (sawUnpublished) {
      problems.push(`${episode.id} は published だが、それより前に未公開の話がある（公開は第1話から連続で）`);
    }
  }

  if (manifest.status === 'published' && !manifest.episodes.some((e) => e.status === 'published')) {
    problems.push('published の季には published の話が1話以上要る');
  }

  return problems;
}

// ── plan.yaml ──────────────────────────────────────────────────

/**
 * 季の計画。旧 Season Plan の固定5構造（発端→展開→転機→危機→決着）は使わない。
 * 各話の目的は Plot Beat ではなく「この回で読者に人物の何を知ってほしいか」。
 * 人間が読んで直す前提の内部ファイルなので、文は日本語だけでよい（題だけ二言語）。
 */
export const StoryPlanEpisodeSchema = z
  .object({
    order: z.number().int().min(1),
    /** 読者にこの回で知ってほしいこと。事件ではなく人物の側から書く。 */
    purpose: z.string().min(1),
    /** 場面の種。結末は書かない。 */
    situation: z.string().min(1),
    format: StoryFormat,
    /** この回に出る周りの人の id（relationships.yaml の people）。端役は書かない。 */
    people: z.array(z.string().min(1)),
    working_title: Bilingual,
  })
  .strict();

export const StoryPlanSchema = z
  .object({
    id: z.string().regex(STORY_SERIES_ID),
    character_id: CharacterId,
    season: z.number().int().min(1).max(99),
    title: Bilingual,
    /** 季全体で読者に残したいもの。一文〜三文。 */
    logline: z.string().min(1),
    character_arc: z
      .object({
        start: z.string().min(1),
        emotional_change: z.string().min(1),
        /** 季のおわりの人物。成長や教訓に着地させる必要はない。 */
        end: z.string().min(1),
      })
      .strict(),
    relationships: z.object({ focus: z.array(z.string().min(1)) }).strict(),
    episodes: z
      .array(StoryPlanEpisodeSchema)
      .min(STORY_EPISODE_LIMITS.min)
      .max(STORY_EPISODE_LIMITS.max),
    generation: StoryGenerationSchema.optional(),
  })
  .strict();

export type StoryPlanEpisode = z.infer<typeof StoryPlanEpisodeSchema>;
export type StoryPlan = z.infer<typeof StoryPlanSchema>;

// ── world/stories.yaml ─────────────────────────────────────────

/**
 * Journey Progress の既定の階段と既定の話数。**アプリにハードコードしない**数字は
 * ここが正で、story:plan が manifest に転記し、feed が話ごとの値として運ぶ。
 */
export const StoriesConfigSchema = z
  .object({
    default_episode_count: z
      .number()
      .int()
      .min(STORY_EPISODE_LIMITS.min)
      .max(STORY_EPISODE_LIMITS.max),
    default_required_progress: z
      .array(z.number().int().min(0))
      .length(STORY_EPISODE_LIMITS.max)
      .refine((ladder) => ladder[0] === 0, { message: '第1段は 0 であること' })
      .refine((ladder) => ladder.every((v, i) => i === 0 || v >= ladder[i - 1]!), {
        message: '階段は単調非減少であること',
      }),
  })
  .strict();

export type StoriesConfig = z.infer<typeof StoriesConfigSchema>;
