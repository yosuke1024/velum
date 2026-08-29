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
