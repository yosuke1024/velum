import { z } from 'zod';
import { CharacterId, EraId, CHARACTER_IDS } from './world.js';
import { Bilingual } from './bilingual.js';

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
} as const;

/** diary.json に載せる件数。最新90件・新しい順（契約 §1.1）。 */
export const DIARY_FEED_WINDOW = 90;

/** 肖像は 512×512 固定（契約 §1.1）。sheet.png から派生する。 */
export const PORTRAIT_SIZE = 512;

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

export type FeedCharacters = z.infer<typeof FeedCharactersSchema>;
export type FeedLore = z.infer<typeof FeedLoreSchema>;
export type FeedDiary = z.infer<typeof FeedDiarySchema>;
export type FeedDiaryEntry = z.infer<typeof FeedDiaryEntrySchema>;
export type FeedEntryFile = z.infer<typeof FeedEntryFileSchema>;
