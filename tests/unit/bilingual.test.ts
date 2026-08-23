import { describe, it, expect } from 'vitest';
import { SeasonPlanSchema, BEATS } from '../../src/schemas/season.js';
import { DiaryEntrySchema } from '../../src/schemas/diary.js';
import { both, ja, pick, isUntranslated } from '../../src/lib/bilingual.js';

/**
 * 1言語 = 1 URL。`/velum/en/` は英語しか出さない場所で、`/velum/` は日本語しか
 * 出さない場所である。どの層が訳を必須にし、どの層があとから訳すのかを、ここで
 * 固定する。緩い層と厳しい層を取り違えると、片方は書けなくなり、もう片方は
 * 訳し忘れが公開ページへ積み上がる。
 */

function episode(number: number, beat: (typeof BEATS)[number], overrides = {}) {
  return {
    number,
    beat,
    world_date: { month: 7, day: 3 + number * 4 },
    events: [{ summary: `第${number}話の出来事`, where: '大鑑定院', who: [] }],
    world_change: null,
    leaves_open: `第${number}話が残したもの`,
    ...overrides,
  };
}

const plan = (overrides: Record<string, unknown> = {}) => ({
  season: 1,
  era: 'guilds',
  protagonist: 'teo',
  arc: 'guilds-provisional-sigil',
  year_in_world: 3745,
  title: '座金の向き',
  shape: '誰も見なかった座金から始まり、推薦状へ届かないまま終わる5話。',
  episodes: BEATS.map((beat, i) => episode(i + 1, beat)),
  generation: {
    model: 'gemini-3.5-flash',
    prompt_version: 'season-v1',
    seed: 'season-1:guilds',
    generated_at: '2026-08-22T00:00:00.000Z',
  },
  ...overrides,
});

const entry = (overrides: Record<string, unknown> = {}) => ({
  date: '2026-09-01',
  era: 'guilds',
  protagonist: 'teo',
  season: 1,
  episode: 1,
  beat: '発端',
  world_date: { year: 3745, month: 7, day: 4 },
  title: { ja: '座金は逆だ', en: 'The washer is the wrong way round' },
  quote: { ja: '別に、悔しくはない。', en: 'It is not that I mind.' },
  mood: { ja: '苛立ち', en: 'irritation' },
  rare_expression_used: false,
  ...overrides,
});

describe('季の計画 — あとから訳す層', () => {
  it('生成した直後の日本語だけの計画を受ける', () => {
    // 立てた季がその場で訳されていないのは正常。ここで落とすと計画が書けない。
    expect(SeasonPlanSchema.safeParse(plan()).success).toBe(true);
  });

  it('訳の付いた計画も受ける', () => {
    const translated = plan({
      title: { ja: '座金の向き', en: 'Which Way the Washer Faces' },
      shape: { ja: '5話の形。', en: 'The shape of five episodes.' },
      episodes: BEATS.map((beat, i) =>
        episode(i + 1, beat, {
          leaves_open: { ja: `第${i + 1}話が残したもの`, en: `What episode ${i + 1} leaves open` },
        }),
      ),
    });
    expect(SeasonPlanSchema.safeParse(translated).success).toBe(true);
  });

  it('未訳かどうかを見分けられる（validate が数えるため）', () => {
    expect(isUntranslated('座金の向き')).toBe(true);
    expect(isUntranslated({ ja: '座金の向き', en: 'Which Way the Washer Faces' })).toBe(false);
  });

  it('未訳の欄は英語ページに日本語のまま出る（黙って消さない）', () => {
    expect(pick('座金の向き', 'en')).toBe('座金の向き');
    expect(both('座金の向き')).toEqual({ ja: '座金の向き', en: '座金の向き' });
  });
});

describe('日記のメタ — その場で両方書かせる層', () => {
  it('二言語で揃っていれば通る', () => {
    expect(DiaryEntrySchema.safeParse(entry()).success).toBe(true);
  });

  for (const field of ['title', 'quote', 'mood'] as const) {
    it(`${field} が素の文字列なら受け付けない`, () => {
      // 日記は毎日出る。素の文字列を受けると、訳し忘れが英語ページに積み上がる。
      expect(DiaryEntrySchema.safeParse(entry({ [field]: '日本語だけ' })).success).toBe(false);
    });

    it(`${field} の英語が欠けていたら受け付けない`, () => {
      expect(
        DiaryEntrySchema.safeParse(entry({ [field]: { ja: '日本語だけ', en: '' } })).success,
      ).toBe(false);
    });
  }
});

describe('生成が読む向きは、常に日本語', () => {
  it('プロンプトへ戻すときは ja へ落とす', () => {
    expect(ja({ ja: '座金の向き', en: 'Which Way the Washer Faces' })).toBe('座金の向き');
    expect(ja('座金の向き')).toBe('座金の向き');
  });
});
