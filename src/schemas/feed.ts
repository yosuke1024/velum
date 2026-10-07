import { z } from 'zod';
import { CharacterId, EraId, CHARACTER_IDS } from './world.js';
import { Bilingual } from './bilingual.js';
import { STORY_EPISODE_ID, STORY_SERIES_ID, StoryFormat } from './story.js';

/**
 * Diary/World feed — PixTale アプリが raw GitHub で直接読む契約面。
 *
 * 契約は pixapps 側 `docs/current/pixtale_v2_contracts.md` §1。契約面は
 * `world/feed/` 配下だけで、velum の内部ファイルは非契約である。
 *
 * バージョニングは Persona Snapshot と同じ規約（フィールド追加のみ・削除/改名禁止）。
 * 読み手は未知フィールドを無視し、未知の schema_version はそのファイルを不採用にする。
 *
 * **秘匿情報（core.secret_*・relationships[].hidden_from_protagonist）は
 * この feed のどこにも現れない。** 混入は `npm run validate` が検査する。
 */

export const FEED_SCHEMA_VERSION = 1;

/** 配布ファイルのサイズ上限（契約 §1.1）。validate が enforce する。 */
export const FEED_SIZE_LIMITS = {
  characters: 64 * 1024,
  lore: 64 * 1024,
  diary: 200 * 1024,
  entry: 32 * 1024,
  portrait: 200 * 1024,
  /** world/feed/stories/index.json（本文なし） */
  storiesIndex: 64 * 1024,
  /** world/feed/stories/<series-id>.json（1季ぶんの本文込み。日本語は1字3バイト） */
  story: 256 * 1024,
} as const;

/** diary.json に載せる件数。最新90件・新しい順（契約 §1.1）。 */
export const DIARY_FEED_WINDOW = 90;

/** 肖像は 512×512 固定（契約 §1.1）。sheet.png から派生する。 */
export const PORTRAIT_SIZE = 512;

/**
 * 周りの人。ソースは characters/<id>/relationships.yaml の people。
 * summary（内部文）・trust/wariness・hidden_from_protagonist はここに出さない
 * （契約 §1.2）——公開用に書いた intro/relation（public_relation があれば
 * それ）だけを転記する。
 */
export const FeedPersonSchema = z.object({
  id: z.string().min(1),
  name: Bilingual,
  relation: Bilingual,
  intro: Bilingual,
});

export const FeedCharacterSchema = z.object({
  id: CharacterId,
  era: EraId,
  name: Bilingual,
  role: Bilingual,
  age: z.number().int(),
  affiliation: z.string().min(1),
  /** World 詳細用の紹介文。秘密（secret_*）はここに書かない。 */
  intro: Bilingual,
  portrait: z.object({
    path: z.string().min(1),
    width: z.literal(PORTRAIT_SIZE),
    height: z.literal(PORTRAIT_SIZE),
  }),
  /** 周りの人。主人公1人につき2人（契約 §1.2）。 */
  people: z.array(FeedPersonSchema).length(2),
});

/** world/feed/characters.json — World タブ・同行者選択。 */
export const FeedCharactersSchema = z.object({
  schema_version: z.literal(FEED_SCHEMA_VERSION),
  generated_at: z.string(),
  /** ピン（world/personas.json の default_companion）の値の転記。 */
  default_companion_id: CharacterId,
  characters: z.array(FeedCharacterSchema).length(CHARACTER_IDS.length),
});

/** world/feed/lore.json — World Lore 基本（時代・世界法則）。 */
export const FeedLoreSchema = z.object({
  schema_version: z.literal(FEED_SCHEMA_VERSION),
  generated_at: z.string(),
  eras: z
    .array(
      z.object({
        id: EraId,
        order: z.number().int().min(1).max(5),
        years: z.string().min(1),
        name: Bilingual,
        summary: Bilingual,
      }),
    )
    .length(5),
  /** 読者向けに選別した世界法則。ソースは world/canon/laws.yaml。 */
  laws: z.array(z.object({ id: z.string().min(1), text: Bilingual })).min(1),
  /**
   * 読者向けの組織要約。ソースは各時代 canon（world/canon/<era>.yaml）の
   * institutions のうち、summary を持つものだけ（契約 §1.2）。
   */
  organizations: z
    .array(
      z.object({
        id: z.string().min(1),
        era: EraId,
        name: Bilingual,
        summary: Bilingual,
      }),
    )
    .min(1),
  /** 読者向けの用語集。ソースは world/canon/glossary.yaml。 */
  glossary: z
    .array(z.object({ id: z.string().min(1), term: Bilingual, text: Bilingual }))
    .min(1),
});

/** 日記 ID は `<date>-<characterId>`。 */
export const FEED_ENTRY_ID = /^(\d{4}-\d{2}-\d{2})-([a-z]+)$/;

export const FeedDiaryEntrySchema = z.object({
  id: z.string().regex(FEED_ENTRY_ID),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  character_id: CharacterId,
  era: EraId,
  season: z.number().int().min(1),
  episode: z.number().int().min(1).max(5),
  world_date: z.object({
    year: z.number().int().nullable(),
    month: z.number().int().min(1).max(13),
    day: z.number().int().min(1).max(30),
  }),
  title: Bilingual,
  /** 一覧用抜粋。velum 内部の quote を転用する。 */
  excerpt: Bilingual,
  mood: Bilingual,
  path: z.string().min(1),
});

/** world/feed/diary.json — 一覧。最新90件・新しい順。 */
export const FeedDiarySchema = z.object({
  schema_version: z.literal(FEED_SCHEMA_VERSION),
  generated_at: z.string(),
  entries: z.array(FeedDiaryEntrySchema).max(DIARY_FEED_WINDOW),
});

/**
 * world/feed/entries/<date>-<id>.json — 日記全文。発行後は不変。
 * 一覧と同じフィールドに body を足したもの。body はプレーンテキストで、
 * 段落は空行区切り。Markdown 装飾なし。
 */
export const FeedEntryFileSchema = FeedDiaryEntrySchema.extend({
  schema_version: z.literal(FEED_SCHEMA_VERSION),
  body: Bilingual,
});

// ── world/feed/stories/ ───────────────────────────────────────
//
// Character Story の配布面（docs/stories.md §6）。既存の diary feed と並列に足した
// 新しいファイル群で、既存ファイルの形も schema_version も動かさない。
//
// 版は既存 feed と別の定数で持つ——将来 stories だけ版を上げても、日記・人物・
// 時代のファイルが旧アプリで一斉に不採用になることがないように。
//
// **公開済み（季と話の両方が published）だけが載る。** 載った話の本文は raw GitHub
// から誰でも読める。解放（required_progress）はアプリ側の UX であって秘匿ではない。

export const STORIES_SCHEMA_VERSION = 1;

/** 一覧に載せる話の軽い情報。ロックされた行の表示と解放判定は index だけで済む。 */
export const FeedStoryEpisodeSummarySchema = z.object({
  id: z.string().regex(STORY_EPISODE_ID),
  order: z.number().int().min(1),
  required_progress: z.number().int().min(0),
  title: Bilingual,
});

export const FeedStorySeriesSummarySchema = z.object({
  id: z.string().regex(STORY_SERIES_ID),
  character_id: CharacterId,
  season: z.number().int().min(1),
  title: Bilingual,
  summary: Bilingual.optional(),
  /** 本文込みのファイル（base URL からの相対）。 */
  path: z.string().min(1),
  /**
   * 季ファイルの内容の版（generated_at を除いた内容の sha256 先頭12桁）。
   * アプリはキャッシュ済みの季ファイルとこれを比べ、違えば取り直す。
   */
  revision: z.string().regex(/^[0-9a-f]{12}$/),
  /** 公開済みの話数（= episodes の長さ）。 */
  episode_count: z.number().int().min(1),
  episodes: z.array(FeedStoryEpisodeSummarySchema).min(1),
});

/**
 * world/feed/stories/index.json — 人物ごとの公開済みの季。
 * 公開が1本も無くても書く（`characters: {}`）。アプリが「取得失敗」と
 * 「まだ無い」を区別できるように。
 */
export const FeedStoriesIndexSchema = z.object({
  schema_version: z.literal(STORIES_SCHEMA_VERSION),
  generated_at: z.string(),
  characters: z.record(
    CharacterId,
    z.object({ series: z.array(FeedStorySeriesSummarySchema).min(1) }),
  ),
});

export const FeedStoryEpisodeSchema = FeedStoryEpisodeSummarySchema.extend({
  summary: Bilingual.optional(),
  format: StoryFormat.optional(),
  /** プレーンテキスト。段落は空行区切り。Markdown 装飾なし（diary の body と同じ規約）。 */
  body: Bilingual,
});

/** world/feed/stories/<series-id>.json — 1季ぶんの公開済みの全話（本文込み）。 */
export const FeedStorySeriesSchema = z.object({
  schema_version: z.literal(STORIES_SCHEMA_VERSION),
  generated_at: z.string(),
  id: z.string().regex(STORY_SERIES_ID),
  character_id: CharacterId,
  season: z.number().int().min(1),
  title: Bilingual,
  summary: Bilingual.optional(),
  /** feed に載る季は常に published。 */
  status: z.literal('published'),
  path: z.string().min(1),
  revision: z.string().regex(/^[0-9a-f]{12}$/),
  episodes: z.array(FeedStoryEpisodeSchema).min(1),
});

export type FeedStoryEpisodeSummary = z.infer<typeof FeedStoryEpisodeSummarySchema>;
export type FeedStorySeriesSummary = z.infer<typeof FeedStorySeriesSummarySchema>;
export type FeedStoriesIndex = z.infer<typeof FeedStoriesIndexSchema>;
export type FeedStoryEpisode = z.infer<typeof FeedStoryEpisodeSchema>;
export type FeedStorySeries = z.infer<typeof FeedStorySeriesSchema>;

export type FeedPerson = z.infer<typeof FeedPersonSchema>;
export type FeedCharacters = z.infer<typeof FeedCharactersSchema>;
export type FeedLore = z.infer<typeof FeedLoreSchema>;
export type FeedDiary = z.infer<typeof FeedDiarySchema>;
export type FeedDiaryEntry = z.infer<typeof FeedDiaryEntrySchema>;
export type FeedEntryFile = z.infer<typeof FeedEntryFileSchema>;
