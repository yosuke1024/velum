import { describe, it, expect } from 'vitest';
import {
  FeedCharactersSchema,
  FeedLoreSchema,
  FeedDiarySchema,
  FeedEntryFileSchema,
  FEED_SIZE_LIMITS,
  DIARY_FEED_WINDOW,
} from '../../src/schemas/feed.js';
import {
  buildCharactersFeed,
  buildLoreFeed,
  feedEntryFrom,
  diaryFeedFrom,
} from '../../src/export/feed.js';
import { forbiddenSecretSegments } from '../../src/lib/secrets.js';
import {
  CHARACTER_IDS,
  ERA_PROTAGONIST,
  DEFAULT_COMPANION,
  GlossaryFileSchema,
} from '../../src/schemas/world.js';
import { emptyManifest } from '../../src/compile/publish.js';
import { worldPath } from '../../src/lib/paths.js';
import { readYaml } from '../../src/lib/storage.js';
import type { PersonaManifest } from '../../src/schemas/manifest.js';
import type { DiaryEntry } from '../../src/schemas/diary.js';

const NOW = '2026-08-29T00:00:00.000Z';

const characters = buildCharactersFeed(NOW);
const lore = buildLoreFeed(NOW);

/** 契約 §1.2 の除外規則。feed のどこにも秘匿情報は現れない。 */
describe('秘匿情報を feed に含めない', () => {
  const serialized = JSON.stringify(characters) + JSON.stringify(lore);

  for (const { owner, segment } of forbiddenSecretSegments()) {
    it(`${owner} の秘密の断片が現れない（${segment.slice(0, 12)}…）`, () => {
      expect(serialized.replace(/\s+/g, '')).not.toContain(segment.replace(/\s+/g, ''));
    });
  }
});

describe('world/feed/characters.json', () => {
  it('スキーマに合う', () => {
    expect(() => FeedCharactersSchema.parse(characters)).not.toThrow();
  });

  it('5人ぶんあり、時代と主人公の対応が world と一致する', () => {
    expect(characters.characters.map((c) => c.id).sort()).toEqual([...CHARACTER_IDS].sort());
    for (const c of characters.characters) {
      expect(ERA_PROTAGONIST[c.era]).toBe(c.id);
    }
  });

  it('ピンが無いあいだのデフォルト同行者は teo', () => {
    // 真の値はピン（world/personas.json の default_companion）。
    // ピンがまだ無い初期状態では、契約 §3.2 の既定値 teo を転記する。
    expect(DEFAULT_COMPANION).toBe('teo');
    expect(characters.default_companion_id).toBe(DEFAULT_COMPANION);
  });

  it('肖像は world/feed/portraits/<id>.png を 512×512 で指す', () => {
    for (const c of characters.characters) {
      expect(c.portrait.path).toBe(`world/feed/portraits/${c.id}.png`);
      expect(c.portrait.width).toBe(512);
      expect(c.portrait.height).toBe(512);
    }
  });

  it('紹介文は二言語で、生の改行を残さない', () => {
    const japanese = /[ぁ-んァ-ヶ一-龠]/;
    for (const c of characters.characters) {
      expect(c.intro.ja).toMatch(japanese);
      expect(c.intro.en).toMatch(/[A-Za-z]/);
      expect(c.intro.ja).not.toContain('\n');
      expect(c.intro.en).not.toContain('\n');
    }
  });

  it('サイズ上限 64KB に収まる', () => {
    expect(Buffer.byteLength(JSON.stringify(characters, null, 2))).toBeLessThanOrEqual(
      FEED_SIZE_LIMITS.characters,
    );
  });
});

describe('world/feed/lore.json', () => {
  it('スキーマに合う', () => {
    expect(() => FeedLoreSchema.parse(lore)).not.toThrow();
  });

  it('5時代が order 1..5 で揃っている', () => {
    const orders = lore.eras.map((e) => e.order).sort((a, b) => a - b);
    expect(orders).toEqual([1, 2, 3, 4, 5]);
  });

  it('世界法則が二言語で入っている', () => {
    expect(lore.laws.length).toBeGreaterThanOrEqual(1);
    for (const law of lore.laws) {
      expect(law.text.ja).toMatch(/[ぁ-んァ-ヶ一-龠]/);
      expect(law.text.en).toMatch(/[A-Za-z]/);
    }
  });

  it('組織の名前・要約が二言語で入っている', () => {
    expect(lore.organizations.length).toBeGreaterThanOrEqual(1);
    for (const org of lore.organizations) {
      expect(org.name.ja).toMatch(/[ぁ-んァ-ヶ一-龠]/);
      expect(org.name.en).toMatch(/[A-Za-z]/);
      expect(org.summary.ja).toMatch(/[ぁ-んァ-ヶ一-龠]/);
      expect(org.summary.en).toMatch(/[A-Za-z]/);
    }
  });

  it('summary を持つ5件だけが揃い、summary の無い vesper-workshop は含まない', () => {
    // 現時点の canon で summary を持つのはこの5件（各時代1件ずつ）。
    // guilds.yaml の vesper-workshop は意図的に summary が無く、除外される。
    // 並びも固定する（ERA_IDS 順 → ファイル内の記載順）。sort して比べると
    // 収集順が変わる実装（readdirSync 依存など）に退行しても気づけない。
    const ids = lore.organizations.map((o) => o.id);
    expect(ids).toEqual([
      'sana',
      'grand-court',
      'record-house',
      'reclaimers-guild',
      'riko-trading',
    ]);
    expect(ids).not.toContain('vesper-workshop');
  });

  it('同じ now で2回組み立てるとバイト単位で一致する（組織・用語集の収集順を含む）', () => {
    const a = JSON.stringify(buildLoreFeed(NOW), null, 2);
    const b = JSON.stringify(buildLoreFeed(NOW), null, 2);
    expect(a).toBe(b);
  });

  it('用語集が glossary.yaml の記載と一致し、二言語で入っている', () => {
    const source = readYaml(worldPath('canon/glossary.yaml'), GlossaryFileSchema);
    expect(lore.glossary.map((g) => g.id)).toEqual(source.glossary.map((g) => g.id));
    for (const entry of lore.glossary) {
      expect(entry.term.ja).toMatch(/[ぁ-んァ-ヶ一-龠]/);
      expect(entry.term.en).toMatch(/[A-Za-z]/);
      expect(entry.text.ja).toMatch(/[ぁ-んァ-ヶ一-龠]/);
      expect(entry.text.en).toMatch(/[A-Za-z]/);
    }
  });

  it('サイズ上限 64KB に収まる', () => {
    expect(Buffer.byteLength(JSON.stringify(lore, null, 2))).toBeLessThanOrEqual(
      FEED_SIZE_LIMITS.lore,
    );
  });
});

// ── diary.json と entries/ ─────────────────────────────────────
// 実データの日記はまだ0本（稼働開始は 2026-09-01）なので、形は合成データで見る。

function entryOn(date: string): DiaryEntry {
  return {
    date,
    era: 'guilds',
    protagonist: 'teo',
    season: 1,
    episode: 1,
    beat: '発端',
    world_date: { year: 412, month: 3, day: 14 },
    title: { ja: '審査室の窓', en: 'The Review Room Window' },
    quote: { ja: '別に悔しくはない。', en: 'Not that I mind.' },
    mood: { ja: '澄まし', en: 'composed' },
    rare_expression_used: false,
  };
}

const body = { ja: '一段落目。\n\n二段落目。', en: 'First paragraph.\n\nSecond paragraph.' };

describe('world/feed/entries/<date>-<id>.json', () => {
  const file = feedEntryFrom(entryOn('2026-09-01'), body);

  it('スキーマに合い、ID は <date>-<characterId>', () => {
    expect(() => FeedEntryFileSchema.parse(file)).not.toThrow();
    expect(file.id).toBe('2026-09-01-teo');
    expect(file.path).toBe('world/feed/entries/2026-09-01-teo.json');
  });

  it('一覧用抜粋は velum 内部の quote を転用する', () => {
    expect(file.excerpt).toEqual({ ja: '別に悔しくはない。', en: 'Not that I mind.' });
  });

  it('本文は段落の空行区切りを保つ（Markdown 装飾なし・二言語）', () => {
    expect(file.body.ja).toBe('一段落目。\n\n二段落目。');
    expect(file.body.en).toContain('\n\n');
  });
});

describe('world/feed/diary.json', () => {
  it('新しい順に並び、最新90件で打ち切る', () => {
    const start = new Date('2026-09-01T00:00:00Z').getTime();
    const files = Array.from({ length: DIARY_FEED_WINDOW + 5 }, (_, i) => {
      const date = new Date(start + i * 86400_000).toISOString().slice(0, 10);
      return feedEntryFrom(entryOn(date), body);
    });

    const diary = diaryFeedFrom(files, NOW);
    expect(() => FeedDiarySchema.parse(diary)).not.toThrow();
    expect(diary.entries).toHaveLength(DIARY_FEED_WINDOW);

    const dates = diary.entries.map((e) => e.date);
    expect(dates).toEqual([...dates].sort().reverse());
    // 打ち切られるのは古い側。最新日は必ず残る。
    expect(dates[0]).toBe(files[files.length - 1]!.date);
  });

  it('一覧には本文が入らない（全文は entries/ 側だけ）', () => {
    const diary = diaryFeedFrom([feedEntryFrom(entryOn('2026-09-01'), body)], NOW);
    expect(diary.entries[0]).not.toHaveProperty('body');
  });

  it('日記が0本なら entries は空配列（9/1 以前は空が正しい）', () => {
    const diary = diaryFeedFrom([], NOW);
    expect(() => FeedDiarySchema.parse(diary)).not.toThrow();
    expect(diary.entries).toEqual([]);
  });
});

describe('決定性', () => {
  it('同じ素材と時刻からは、バイト単位で同じ feed ができる', () => {
    // 日次 cron が毎日走っても、内容が変わらない日はファイルが動かないための前提。
    expect(JSON.stringify(buildCharactersFeed(NOW))).toBe(JSON.stringify(characters));
    expect(JSON.stringify(buildLoreFeed(NOW))).toBe(JSON.stringify(lore));
  });
});

describe('ピンの転記', () => {
  it('ピンに default_companion があれば、その値を転記する', () => {
    const manifest: PersonaManifest = { ...emptyManifest(), default_companion: 'riko' };
    const feed = buildCharactersFeed(NOW, manifest);
    expect(feed.default_companion_id).toBe('riko');
  });
});
