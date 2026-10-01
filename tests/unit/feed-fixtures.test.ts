import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../../src/lib/paths.js';
import {
  FeedCharactersSchema,
  FeedLoreSchema,
  FeedDiarySchema,
  FeedEntryFileSchema,
  FEED_SIZE_LIMITS,
  PORTRAIT_SIZE,
} from '../../src/schemas/feed.js';
import { CHARACTER_IDS } from '../../src/schemas/world.js';
import {
  FeedStoriesIndexSchema,
  FeedStorySeriesSchema,
  STORY_FEED_SIZE_LIMITS,
} from '../../src/schemas/story.js';
import { pngDimensions } from '../../src/lib/png.js';
import { secretLeaksIn } from '../../src/lib/secrets.js';

/**
 * pixapps S5 が使う feed フィクスチャ（tests/fixtures/feed/）。
 *
 * 実 feed は `npm run validate` が守るが、フィクスチャは配布物ではないので
 * そちらを通らない。かわりにここで同じスキーマ・同じ上限・同じ除外規則を
 * 当てる——S5 がフィクスチャで作った UI が、本番 feed でそのまま動くように。
 */

const root = join(ROOT, 'tests', 'fixtures', 'feed', 'world', 'feed');
const json = (rel: string): unknown => JSON.parse(readFileSync(join(root, rel), 'utf8'));

const START_DATE = '2026-09-01';

describe('feed フィクスチャ', () => {
  it('characters.json が本番と同じスキーマ・上限に収まる', () => {
    const parsed = FeedCharactersSchema.parse(json('characters.json'));
    expect(parsed.characters).toHaveLength(5);
    expect(statSync(join(root, 'characters.json')).size).toBeLessThanOrEqual(
      FEED_SIZE_LIMITS.characters,
    );
  });

  it('lore.json が本番と同じスキーマ・上限に収まる', () => {
    FeedLoreSchema.parse(json('lore.json'));
    expect(statSync(join(root, 'lore.json')).size).toBeLessThanOrEqual(FEED_SIZE_LIMITS.lore);
  });

  it('diary.json はダミー日記と整合し、新しい順に並ぶ', () => {
    const diary = FeedDiarySchema.parse(json('diary.json'));
    expect(diary.entries.length).toBeGreaterThanOrEqual(5);

    const ids = diary.entries.map((e) => e.id);
    expect(ids).toEqual([...ids].sort().reverse());

    for (const listed of diary.entries) {
      const file = FeedEntryFileSchema.parse(json(listed.path.replace('world/feed/', '')));
      // 一覧と全文の同フィールドが食い違わない（契約 §1.2）。
      for (const [key, value] of Object.entries(listed)) {
        expect(JSON.stringify((file as Record<string, unknown>)[key])).toBe(JSON.stringify(value));
      }
    }
  });

  it('ダミー日記の日付はすべて稼働開始（2026-09-01）より前', () => {
    // 実データはこの日以降にしか存在しない。日付そのものがダミーの印になる。
    const diary = FeedDiarySchema.parse(json('diary.json'));
    for (const entry of diary.entries) {
      expect(entry.date < START_DATE).toBe(true);
    }
  });

  it('ダミー日記が個別スキーマ・サイズ上限に収まり、5人全員ぶんある', () => {
    const files = readdirSync(join(root, 'entries')).filter((f) => f.endsWith('.json'));
    const authors = new Set<string>();

    for (const file of files) {
      const entry = FeedEntryFileSchema.parse(json(`entries/${file}`));
      expect(`${entry.id}.json`).toBe(file);
      expect(statSync(join(root, 'entries', file)).size).toBeLessThanOrEqual(
        FEED_SIZE_LIMITS.entry,
      );
      authors.add(entry.character_id);
    }
    // 同行者選択 UI の確認には5人ぶんの日記が要る。
    expect([...authors].sort()).toEqual([...CHARACTER_IDS].sort());
  });

  it('肖像が5人ぶんあり、512×512・200KB 以下', () => {
    for (const id of CHARACTER_IDS) {
      const path = join(root, 'portraits', `${id}.png`);
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).size).toBeLessThanOrEqual(FEED_SIZE_LIMITS.portrait);
      expect(pngDimensions(readFileSync(path))).toEqual({
        width: PORTRAIT_SIZE,
        height: PORTRAIT_SIZE,
      });
    }
  });

  it('フィクスチャにも秘匿情報は混じらない', () => {
    // ダミーでも配る先は同じ画面である。除外規則はフィクスチャにも当てる。
    const targets = [
      'characters.json',
      'lore.json',
      'diary.json',
      ...readdirSync(join(root, 'entries'))
        .filter((f) => f.endsWith('.json'))
        .map((f) => `entries/${f}`),
    ];
    for (const rel of targets) {
      expect(secretLeaksIn(readFileSync(join(root, rel), 'utf8'))).toEqual([]);
    }
  });
});

/**
 * Story feed のフィクスチャ（tests/fixtures/stories/ から `npm run export:feed -- --fixtures`
 * が作る）。本番の characters/riko/stories/ が草稿のうちは world/feed/stories/ に
 * 季が出ないので、PixTale の Stories UI はこちらで全状態を作る。
 */
describe('Story feed フィクスチャ', () => {
  it('index.json が本番と同じスキーマ・上限に収まり、Riko の第1季を載せる', () => {
    const index = FeedStoriesIndexSchema.parse(json('stories/index.json'));
    expect(statSync(join(root, 'stories', 'index.json')).size).toBeLessThanOrEqual(STORY_FEED_SIZE_LIMITS.index);
    expect(Object.keys(index.characters)).toEqual(['riko']);
    expect(index.characters.riko!.series.map((s) => s.id)).toEqual(['riko-s01']);
  });

  it('index が指す季のファイルが存在し、話数と id が一致する', () => {
    const index = FeedStoriesIndexSchema.parse(json('stories/index.json'));
    for (const entry of Object.values(index.characters)) {
      for (const listed of entry.series) {
        const rel = listed.path.replace('world/feed/', '');
        expect(existsSync(join(root, rel))).toBe(true);
        const series = FeedStorySeriesSchema.parse(json(rel));
        expect(series.id).toBe(listed.id);
        expect(series.episodes).toHaveLength(listed.episode_count);
        expect(statSync(join(root, rel)).size).toBeLessThanOrEqual(STORY_FEED_SIZE_LIMITS.series);
      }
    }
  });

  it('published の3話だけが出て、第1話は Progress 0 で読める', () => {
    const series = FeedStorySeriesSchema.parse(json('stories/riko-s01.json'));
    expect(series.episodes.map((e) => e.order)).toEqual([1, 2, 3]);
    expect(series.episodes[0]!.required_progress).toBe(0);
  });

  it('index に無い季のファイルが残っていない', () => {
    const index = FeedStoriesIndexSchema.parse(json('stories/index.json'));
    const listed = new Set(
      Object.values(index.characters).flatMap((c) => c.series.map((s) => s.path.replace('world/feed/', ''))),
    );
    for (const file of readdirSync(join(root, 'stories')).filter((f) => f.endsWith('.json') && f !== 'index.json')) {
      expect(listed.has(`stories/${file}`)).toBe(true);
    }
  });

  it('フィクスチャにも秘匿情報は混じらない', () => {
    for (const file of readdirSync(join(root, 'stories')).filter((f) => f.endsWith('.json'))) {
      expect(secretLeaksIn(readFileSync(join(root, 'stories', file), 'utf8'))).toEqual([]);
    }
  });
});

