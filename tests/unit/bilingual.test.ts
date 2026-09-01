import { describe, it, expect } from 'vitest';
import { SeasonPlanSchema, BEATS } from '../../src/schemas/season.js';
import { DiaryEntrySchema } from '../../src/schemas/diary.js';
import {
  both,
  bothForReaders,
  ja,
  oneLine,
  oneLineForReaders,
  pick,
} from '../../src/lib/bilingual.js';

/**
 * 1言語 = 1 URL。`/velum/en/` は英語しか出さない場所で、`/velum/` は日本語しか
 * 出さない場所である。**読み手へ渡る欄はすべて訳を必須にする**——ここでそれを
 * 固定する。
 *
 * かつては「あとから訳す層」があった。未訳は英語ページに日本語のまま出るが、
 * 無言で消すよりは見えているほうがよい、という判断である。掲載側に言語ガードが
 * 入ってからは成り立たない——未訳の欄は見えている欠陥ではなく、その日の公開が
 * 丸ごと止まる原因になる（2026-09-01 に実際そうなった）。
 */

function episode(number: number, beat: (typeof BEATS)[number], overrides = {}) {
  return {
    number,
    beat,
    world_date: { month: 7, day: 3 + number * 4 },
    events: [{ summary: `第${number}話の出来事`, where: '大鑑定院', who: [] }],
    world_change: null,
    leaves_open: {
      ja: `第${number}話が残したもの`,
      en: `What episode ${number} leaves open`,
    },
    ...overrides,
  };
}

const plan = (overrides: Record<string, unknown> = {}) => ({
  season: 1,
  era: 'guilds',
  protagonist: 'teo',
  arc: 'guilds-provisional-sigil',
  year_in_world: 375,
  title: { ja: '座金の向き', en: 'Which Way the Washer Faces' },
  shape: {
    ja: '誰も見なかった座金から始まり、推薦状へ届かないまま終わる5話。',
    en: 'Five episodes that open on a washer nobody looked at and end short of the letter.',
  },
  episodes: BEATS.map((beat, i) => episode(i + 1, beat)),
  generation: {
    model: 'gemini-3.5-flash',
    prompt_version: 'season-v2',
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
  world_date: { year: 375, month: 7, day: 4 },
  title: { ja: '座金は逆だ', en: 'The washer is the wrong way round' },
  quote: { ja: '別に、悔しくはない。', en: 'It is not that I mind.' },
  mood: { ja: '苛立ち', en: 'irritation' },
  rare_expression_used: false,
  ...overrides,
});

describe('季の計画 — 生成がその場で両方書く', () => {
  it('二言語で揃っていれば通る', () => {
    expect(SeasonPlanSchema.safeParse(plan()).success).toBe(true);
  });

  it('日本語だけの計画は受け付けない', () => {
    // 時代ページはこの3つを両方の言語で出す。未訳のまま1つ commit すれば、
    // その日の公開が掲載側の言語ガードで止まる。`npm run plan` が両方書く。
    expect(SeasonPlanSchema.safeParse(plan({ title: '座金の向き' })).success).toBe(false);
    expect(SeasonPlanSchema.safeParse(plan({ shape: '5話の形。' })).success).toBe(false);
    const halfDone = plan({
      episodes: BEATS.map((beat, i) => episode(i + 1, beat, { leaves_open: `第${i + 1}話` })),
    });
    expect(SeasonPlanSchema.safeParse(halfDone).success).toBe(false);
  });

  it('英語だけ空でも受け付けない', () => {
    expect(
      SeasonPlanSchema.safeParse(plan({ title: { ja: '座金の向き', en: '' } })).success,
    ).toBe(false);
  });

  it('読み出しは素の文字列も受ける（書く側の契約と、読む側の作法は別）', () => {
    // スキーマはもう素の文字列を通さない。いっぽう読み出しは通す——掲載側が
    // 古い形の束を描けるのはこの寛容さによる。
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

/**
 * YAML の折り返しは見た目の整形にすぎない。英語ではそこに空白が要るが、
 * 日本語で空白が残ると読み手に見える欠陥になる（World タブの実機確認で判明）。
 * 発行済みの appraisal snapshot を通る oneLine() は据え置き、読み手向けだけ直す。
 */
describe('読み手向けの1行化', () => {
  it('和文どうしの折り返しは空白を入れずに繋ぐ', () => {
    const wrapped = '季節ごとに\n野営地を移しながら暮らす。';
    expect(oneLineForReaders(wrapped)).toBe('季節ごとに野営地を移しながら暮らす。');
    // 従来の oneLine は空白を入れる。こちらは発行済み Snapshot が依存するので変えない。
    expect(oneLine(wrapped)).toBe('季節ごとに 野営地を移しながら暮らす。');
  });

  it('英語の折り返しは従来どおり空白で繋ぐ', () => {
    expect(oneLineForReaders('A tribe without\nwriting.')).toBe('A tribe without writing.');
  });

  it('素材が意図して入れた文中の空白は残す', () => {
    // 「大鑑定院 見習い鑑定士」のような区切りは折り返し由来ではない。
    expect(oneLineForReaders('大鑑定院 見習い鑑定士')).toBe('大鑑定院 見習い鑑定士');
  });

  it('和文と英字の境目は空白で繋ぐ', () => {
    expect(oneLineForReaders('いまは\nEcho と呼ぶ。')).toBe('いまは Echo と呼ぶ。');
  });

  it('ダッシュ・三点リーダの隣で折り返しても空白を残さない', () => {
    // この世界の文章はダッシュを和文の約物として使う。折り返しがその隣に
    // 落ちると「口にしない—— それが」のように空白が残る。
    expect(oneLineForReaders('決して口にしない——\nそれが二人の掟。')).toBe(
      '決して口にしない——それが二人の掟。',
    );
    expect(oneLineForReaders('頭の上がらない\n——そして、会いに行けない。')).toBe(
      '頭の上がらない——そして、会いに行けない。',
    );
    expect(oneLineForReaders('聴こえた気がした…\nでも、確かめようがない。')).toBe(
      '聴こえた気がした…でも、確かめようがない。',
    );
  });

  it('英文のダッシュの隣は従来どおり空白で繋ぐ', () => {
    expect(oneLineForReaders('An enemy —\nbut one who keeps the code.')).toBe(
      'An enemy — but one who keeps the code.',
    );
  });

  it('bothForReaders は訳が無ければ日本語へ落ちる（both と同じ規則）', () => {
    expect(bothForReaders('物に残る\n声')).toEqual({ ja: '物に残る声', en: '物に残る声' });
  });
});
