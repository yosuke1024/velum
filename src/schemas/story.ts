import { z } from 'zod';
import { CharacterId } from './world.js';
import { Bilingual } from './bilingual.js';

/**
 * Character Story — PixTale の同行者を「知るための物語」。
 *
 * 2026-10-01 に Velum の中心を日次の日記生成から、**厳選して事前に制作し、
 * PixTale の Journey Progress で順次解放する Story** へ移した（docs/stories.md）。
 * 日記（docs/diary.md）は Legacy として残り、ここはそれと並列の、別の層である。
 *
 * 単位は Character → Season → Episode。
 *
 *   characters/<id>/stories/s01/
 *     plan.yaml       季の計画（人間が読んで直す）
 *     manifest.yaml   公開する単位の台帳。unlock 条件と状態はここに置き、本文から切り離す
 *     e01.ja.md       本文（日本語）
 *     e01.en.md       本文（英語）
 *
 * **生成 ≠ 公開。** 状態は draft → reviewed → published と進み、feed へ出るのは
 * manifest と episode の両方が published のものだけである。人間が読まずに
 * 自動で公開される経路は、どこにも作らない。
 */

export const STORY_STATUSES = ['draft', 'reviewed', 'published'] as const;
export const StoryStatus = z.enum(STORY_STATUSES);
export type StoryStatus = z.infer<typeof StoryStatus>;

/** 状態の順。episode は manifest より先へ進めない（草稿の季に公開済みの話は作れない）。 */
export const STORY_STATUS_RANK: Record<StoryStatus, number> = {
  draft: 0,
  reviewed: 1,
  published: 2,
};

/**
 * 形式。日記形式を必須にしない——話ごとに最も合う形を選ぶ（docs/stories.md §4）。
 * 閉じた語彙にしてあるのは、アプリ側が形式ごとに表示を変えられるようにするため。
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

export const STORY_ID = /^([a-z]+)-s(\d{2})$/;
export const STORY_EPISODE_ID = /^([a-z]+)-s(\d{2})-e(\d{2})$/;

const pad2 = (n: number) => String(n).padStart(2, '0');

export const storyId = (character: string, season: number): string =>
  `${character}-s${pad2(season)}`;

export const storyEpisodeId = (character: string, season: number, order: number): string =>
  `${storyId(character, season)}-e${pad2(order)}`;

/** 1季あたりの話数の目安（docs/stories.md §3）。計画の既定値であって、上限ではない。 */
export const DEFAULT_EPISODES_PER_STORY = 8;
export const MAX_EPISODES_PER_STORY = 12;

export const StoryEpisodeManifestSchema = z.object({
  id: z.string().regex(STORY_EPISODE_ID),
  order: z.number().int().min(1).max(MAX_EPISODES_PER_STORY),
  /**
   * この話を読むのに要る Journey Progress。アプリは Scan 回数ではなくこの値で解放する。
   * 値は world/stories.yaml の既定の階段から写し、人間が manifest で直してよい。
   */
  required_progress: z.number().int().min(0),
  status: StoryStatus,
  /** published の話では必須（superRefine で見る）。草稿は無題でよい。 */
  title: Bilingual.optional(),
  format: StoryFormat.optional(),
  /** 一覧用の一文。無ければアプリは出さない。 */
  summary: Bilingual.optional(),
});

export type StoryEpisodeManifest = z.infer<typeof StoryEpisodeManifestSchema>;

export const StoryManifestSchema = z
  .object({
    id: z.string().regex(STORY_ID),
    character_id: CharacterId,
    season: z.number().int().min(1),
    title: Bilingual,
    summary: Bilingual.optional(),
    status: StoryStatus,
    episodes: z.array(StoryEpisodeManifestSchema).min(1).max(MAX_EPISODES_PER_STORY),
  })
  .superRefine((manifest, ctx) => {
    if (manifest.id !== storyId(manifest.character_id, manifest.season)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['id'],
        message: `id は ${storyId(manifest.character_id, manifest.season)} のはずです`,
      });
    }

    const orders = manifest.episodes.map((e) => e.order);
    const wanted = manifest.episodes.map((_, i) => i + 1);
    if (orders.join(',') !== wanted.join(',')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['episodes'],
        message: `order は 1..${manifest.episodes.length} の順に並べてください（${orders.join(',')}）`,
      });
    }

    let previous = -1;
    manifest.episodes.forEach((episode, index) => {
      const expectedId = storyEpisodeId(manifest.character_id, manifest.season, episode.order);
      if (episode.id !== expectedId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['episodes', index, 'id'],
          message: `id は ${expectedId} のはずです`,
        });
      }

      // 第1話は同行者を選んだ時点で読める。まだ好きでもない人物のために
      // 「まず Scan してください」と要求しても成立しない（docs/stories.md §5）。
      if (index === 0 && episode.required_progress !== 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['episodes', index, 'required_progress'],
          message: '第1話の required_progress は 0 です',
        });
      }
      if (episode.required_progress < previous) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['episodes', index, 'required_progress'],
          message: 'required_progress は前の話より小さくできません',
        });
      }
      previous = episode.required_progress;

      if (STORY_STATUS_RANK[episode.status] > STORY_STATUS_RANK[manifest.status]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['episodes', index, 'status'],
          message: `episode の status（${episode.status}）は季の status（${manifest.status}）より先へ進めません`,
        });
      }
      if (episode.status === 'published' && !episode.title) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['episodes', index, 'title'],
          message: 'published の話には title が要ります',
        });
      }
    });

    // 公開済みの話は先頭から連続していること。第3話が公開済みで第2話が草稿だと、
    // 解放の階段に穴が開く。
    const published = manifest.episodes.map((e) => e.status === 'published');
    const firstUnpublished = published.indexOf(false);
    if (firstUnpublished !== -1 && published.slice(firstUnpublished).some(Boolean)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['episodes'],
        message: 'published の話は第1話から連続している必要があります',
      });
    }
    if (manifest.status === 'published' && !published.some(Boolean)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: '季を published にするなら、published の話が1本は要ります',
      });
    }
  });

export type StoryManifest = z.infer<typeof StoryManifestSchema>;

/**
 * 季の計画（plan.yaml）。旧 Season Plan の固定5構造（発端→…→決着）は使わない。
 * 各話の purpose は Plot Beat ではなく「この回で読者に人物の何を知ってほしいか」である。
 */
export const StoryPlanEpisodeSchema = z.object({
  order: z.number().int().min(1).max(MAX_EPISODES_PER_STORY),
  /** この回で読者に知ってほしい、この人物のこと。 */
  purpose: z.string().min(1),
  /** 場面の種。出来事の列ではなく、どこで誰と何をしている回か。 */
  situation: z.string().min(1),
  format: StoryFormat,
  /** 登場する周りの人の id。周囲2人（relationships.yaml）か、名もない端役。 */
  people: z.array(z.string().min(1)),
  working_title: z.string().min(1).optional(),
});

export const StoryPlanSchema = z
  .object({
    id: z.string().regex(STORY_ID),
    character_id: CharacterId,
    season: z.number().int().min(1),
    character_arc: z.object({
      start: z.string().min(1),
      emotional_change: z.string().min(1),
      end: z.string().min(1),
    }),
    relationships: z.object({
      focus: z.array(z.string().min(1)).min(1),
    }),
    episodes: z.array(StoryPlanEpisodeSchema).min(1).max(MAX_EPISODES_PER_STORY),
    /** 手で書いた計画には無い。生成したものだけが持つ。 */
    generation: z
      .object({
        model: z.string(),
        prompt_version: z.string(),
        generated_at: z.string(),
      })
      .optional(),
  })
  .superRefine((plan, ctx) => {
    if (plan.id !== storyId(plan.character_id, plan.season)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['id'],
        message: `id は ${storyId(plan.character_id, plan.season)} のはずです`,
      });
    }
    const orders = plan.episodes.map((e) => e.order);
    const wanted = plan.episodes.map((_, i) => i + 1);
    if (orders.join(',') !== wanted.join(',')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['episodes'],
        message: `order は 1..${plan.episodes.length} の順に並べてください`,
      });
    }
  });

export type StoryPlan = z.infer<typeof StoryPlanSchema>;

/**
 * Journey Progress の既定の階段（world/stories.yaml）。
 * アプリにハードコードしない——manifest が episode ごとの値を持ち、feed がそれを運ぶ。
 * ここは story:plan が新しい manifest を作るときに写す既定値である。
 */
export const StoriesConfigSchema = z.object({
  default_required_progress: z
    .array(z.number().int().min(0))
    .min(1)
    .refine((ladder) => ladder[0] === 0, { message: '第1話の既定値は 0 です' })
    .refine((ladder) => ladder.every((v, i) => i === 0 || v >= (ladder[i - 1] ?? 0)), {
      message: '階段は単調非減少です',
    }),
});

export type StoriesConfig = z.infer<typeof StoriesConfigSchema>;

// ── feed（world/feed/stories/）────────────────────────────────────
// PixTale アプリが raw で直接読む契約面。既存の diary feed とは別ファイルで
// 並列に追加し、既存 feed の schema_version は動かさない（docs/stories.md §6）。

export const STORY_FEED_SCHEMA_VERSION = 1;

export const STORY_FEED_SIZE_LIMITS = {
  index: 16 * 1024,
  series: 256 * 1024,
} as const;

export const FeedStoryEpisodeSchema = z.object({
  id: z.string().regex(STORY_EPISODE_ID),
  order: z.number().int().min(1),
  required_progress: z.number().int().min(0),
  title: Bilingual,
  format: StoryFormat.optional(),
  summary: Bilingual.optional(),
  /** プレーンテキスト。段落は空行区切り。Markdown 装飾なし（diary feed と同じ）。 */
  body: Bilingual,
});

export type FeedStoryEpisode = z.infer<typeof FeedStoryEpisodeSchema>;

/** world/feed/stories/<story-id>.json — 1季ぶんの全話。 */
export const FeedStorySeriesSchema = z.object({
  schema_version: z.literal(STORY_FEED_SCHEMA_VERSION),
  generated_at: z.string(),
  id: z.string().regex(STORY_ID),
  character_id: CharacterId,
  season: z.number().int().min(1),
  title: Bilingual,
  summary: Bilingual.optional(),
  /** feed に出るのは published だけ。読み手が草稿を見分ける必要はない。 */
  status: z.literal('published'),
  path: z.string().min(1),
  episodes: z.array(FeedStoryEpisodeSchema).min(1),
});

export type FeedStorySeries = z.infer<typeof FeedStorySeriesSchema>;

export const FeedStoriesIndexSeriesSchema = z.object({
  id: z.string().regex(STORY_ID),
  season: z.number().int().min(1),
  title: Bilingual,
  path: z.string().min(1),
  /** 公開済みの話数。アプリは一覧でこれを出し、本文は series を取ってから読む。 */
  episode_count: z.number().int().min(1),
});

/** world/feed/stories/index.json — 人物ごとの季の一覧。 */
export const FeedStoriesIndexSchema = z.object({
  schema_version: z.literal(STORY_FEED_SCHEMA_VERSION),
  generated_at: z.string(),
  characters: z.record(CharacterId, z.object({ series: z.array(FeedStoriesIndexSeriesSchema) })),
});

export type FeedStoriesIndex = z.infer<typeof FeedStoriesIndexSchema>;

/** ディレクトリ名 sNN。paths.ts の storySeasonDirName と同じ形で、検証側が照合に使う。 */
export const storySeasonDirNameOf = (season: number): string => `s${pad2(season)}`;
