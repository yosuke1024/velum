import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../../src/lib/paths.js';
import {
  FeedCharactersSchema,
  FeedLoreSchema,
  FeedDiarySchema,
  FeedEntryFileSchema,
  FeedStoriesIndexSchema,
  FeedStorySeriesSchema,
  FEED_SIZE_LIMITS,
  PORTRAIT_SIZE,
} from '../../src/schemas/feed.js';
import { CHARACTER_IDS } from '../../src/schemas/world.js';
import { pngDimensions } from '../../src/lib/png.js';
import { secretLeaksInJson } from '../../src/lib/secrets.js';
import { storyRevision } from '../../src/export/stories.js';
import { checkStoriesFeed, checkStorySources } from '../../src/story/check.js';
import { storyBodyProblems } from '../../src/story/body.js';

/**
 * pixapps S5 が使う feed フィクスチャ（tests/fixtures/feed/）。
 *
 * 実 feed は `npm run validate` が守るが、フィクスチャは配布物ではないので
 * そちらを通らない。かわりにここで同じスキーマ・同じ上限・同じ除外規則を
 * 当てる——S5 がフィクスチャで作った UI が、本番 feed でそのまま動くように。
 */

const root = join(ROOT, 'tests', 'fixtures', 'feed', 'world', 'feed');
/** stories フィクスチャのソース（tests/fixtures/feed/world/feed/stories/ の素材）。 */
const storiesSourceRoot = join(ROOT, 'tests', 'fixtures', 'stories');
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
      expect(secretLeaksInJson(readFileSync(join(root, rel), 'utf8'))).toEqual([]);
    }
  });
});

/**
 * Story feed のフィクスチャ（world/feed/stories/）。PixTale の Stories UI を作る側が
 * 読む見本で、リコ（published ×3 と、出ない reviewed / draft）とテオ（published ×2）の
 * ダミーの季。本番の feed と同じスキーマ・上限・整合・除外規則を当てる。
 */
describe('stories フィクスチャ', () => {
  const storiesDir = join(root, 'stories');
  const index = FeedStoriesIndexSchema.parse(json('stories/index.json'));
  const listed = Object.values(index.characters).flatMap((entry) => entry?.series ?? []);
  const seriesFile = (id: string) => FeedStorySeriesSchema.parse(json(`stories/${id}.json`));

  it('index.json が本番と同じスキーマ・上限に収まる', () => {
    expect(statSync(join(storiesDir, 'index.json')).size).toBeLessThanOrEqual(
      FEED_SIZE_LIMITS.storiesIndex,
    );
  });

  it('2人ぶんの季があり、季ファイルの名前は <series-id>.json', () => {
    expect(Object.keys(index.characters).sort()).toEqual(['riko', 'teo']);
    const files = readdirSync(storiesDir).filter((f) => f.endsWith('.json')).sort();
    expect(files).toEqual(['index.json', ...listed.map((s) => `${s.id}.json`)].sort());
  });

  it('季ファイルがスキーマ・サイズ上限に収まり、index の要約と食い違わない', () => {
    for (const summary of listed) {
      const series = seriesFile(summary.id);
      expect(statSync(join(storiesDir, `${summary.id}.json`)).size).toBeLessThanOrEqual(
        FEED_SIZE_LIMITS.story,
      );
      expect(series.status).toBe('published');
      expect(series.path).toBe(summary.path);
      expect(summary.path).toBe(`world/feed/stories/${summary.id}.json`);
      expect(series.revision).toBe(summary.revision);
      expect(summary.episode_count).toBe(series.episodes.length);
      expect(summary.episodes.map((e) => [e.id, e.order, e.required_progress, e.title])).toEqual(
        series.episodes.map((e) => [e.id, e.order, e.required_progress, e.title]),
      );
      // 一覧と同じ内容の再計算で revision が合う。
      expect(storyRevision(series)).toBe(series.revision);
    }
  });

  it('公開済みの話だけが載り、解放条件は第1話が 0 で単調非減少', () => {
    const riko = seriesFile('riko-s01');
    // フィクスチャには reviewed（e04）と draft（e05）もあるが、feed には出ない。
    expect(riko.episodes.map((e) => e.order)).toEqual([1, 2, 3]);
    expect(JSON.stringify(riko)).not.toContain('riko-s01-e04');

    for (const summary of listed) {
      const progress = summary.episodes.map((e) => e.required_progress);
      expect(progress[0]).toBe(0);
      expect(progress).toEqual([...progress].sort((a, b) => a - b));
    }
  });

  it('UI の検証に要る形が揃っている（二言語の題・本文、任意欄の有り無し）', () => {
    const riko = seriesFile('riko-s01');
    for (const episode of riko.episodes) {
      expect(episode.title.ja).toMatch(/[ぁ-んァ-ヶ一-龠]/);
      expect(episode.title.en).toMatch(/[A-Za-z]/);
      expect(storyBodyProblems(episode.body.ja, 'ja')).toEqual([]);
      expect(storyBodyProblems(episode.body.en, 'en')).toEqual([]);
      // 本文は段落が空行で区切られている（UI が段落描画を確かめられる）。
      expect(episode.body.ja).toContain('\n\n');
    }
    // summary / format は任意欄: あるものと無いものの両方がある。
    expect(riko.episodes.some((e) => e.summary)).toBe(true);
    expect(riko.episodes.some((e) => !e.summary)).toBe(true);
    expect(new Set(riko.episodes.map((e) => e.format)).size).toBeGreaterThan(1);
  });

  it('素材（tests/fixtures/stories）から作り直した内容と一致し、ソースも規約に合う', () => {
    expect(checkStoriesFeed(storiesDir, storiesSourceRoot)).toEqual([]);
    expect(checkStorySources(storiesSourceRoot)).toEqual([]);
  });

  it('秘匿情報は混じらない（デコードした本文でも）', () => {
    for (const name of readdirSync(storiesDir).filter((f) => f.endsWith('.json'))) {
      expect(secretLeaksInJson(readFileSync(join(storiesDir, name), 'utf8'))).toEqual([]);
    }
  });
});
