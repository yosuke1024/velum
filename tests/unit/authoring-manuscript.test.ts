import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SHORT_BODY_CHARS,
  assertNoTextLost,
  normalizeNewlines,
  splitManuscript,
  type TitleRule,
} from '../../src/story/authoring/manuscript.js';

/**
 * 既定の秘密の照合（src/lib/secrets.ts の secretLeaksIn）は実データの人物 YAML を読む。
 * このテストは実データに依存しないので、モジュールごと差し替える。
 * 各テストは options.secretLeaks を明示して、既定の経路を通らないようにする
 * （既定が使われることの確認だけ、最後の describe で行う）。
 */
const { secretLeaksInMock } = vi.hoisted(() => ({
  secretLeaksInMock: vi.fn((_text: string): Array<{ owner: string; segment: string }> => []),
}));
vi.mock('../../src/lib/secrets.js', () => ({ secretLeaksIn: secretLeaksInMock }));

type Leak = { owner: string };
const NO_LEAKS = (): Leak[] => [];
const split = (raw: string) => splitManuscript(raw, { secretLeaks: NO_LEAKS });

/** 書式の問題が無く、指定の字数を超える日本語の本文（段落は空行区切り）。 */
function cleanBody(minChars: number): string {
  const paragraphs: string[] = [];
  const sentence = '港の朝市で、行商の女は荷を解いて布を広げた。風が強く、石で四隅を押さえなければならなかった。';
  while ([...paragraphs.join('\n\n')].length < minChars) {
    paragraphs.push(`${sentence}${paragraphs.length + 1}人目の客が足を止めて、値を尋ねた。`);
  }
  return paragraphs.join('\n\n');
}

const LONG_BODY = cleanBody(SHORT_BODY_CHARS + 200);

beforeEach(() => {
  secretLeaksInMock.mockReset();
  secretLeaksInMock.mockImplementation(() => []);
});

describe('normalizeNewlines', () => {
  it('CRLF と CR を LF にする', () => {
    expect(normalizeNewlines('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('CR と CRLF が続いても、改行の数は変わらない', () => {
    expect(normalizeNewlines('a\r\r\nb')).toBe('a\n\nb');
    expect(normalizeNewlines('a\r\n\r\nb\r\n')).toBe('a\n\nb\n');
  });

  it('タブ・全角空白・行末の空白は変えない', () => {
    expect(normalizeNewlines('a \t　\r\nb  \r\n　c')).toBe('a \t　\nb  \n　c');
  });

  it('LF だけの文字列と、改行の無い文字列はそのまま', () => {
    expect(normalizeNewlines('a\nb\n\n\nc\n')).toBe('a\nb\n\n\nc\n');
    expect(normalizeNewlines('改行なし')).toBe('改行なし');
    expect(normalizeNewlines('')).toBe('');
  });

  it('LF 以外の行区切り文字（U+2028 など）には触れない', () => {
    expect(normalizeNewlines('a b\u0085c')).toBe('a b\u0085c');
  });

  it('何度かけても同じ', () => {
    const once = normalizeNewlines('a\r\nb\rc\r\r\nd');
    expect(normalizeNewlines(once)).toBe(once);
  });
});

describe('splitManuscript: 題の取り出し', () => {
  it('Markdown の見出しを題にする', () => {
    const m = split('# 正午の鏡\n\n本文');
    expect(m.title).toBe('正午の鏡');
    expect(m.titleRule).toBe('markdown_heading');
    expect(m.body).toBe('本文');
  });

  it.each(['#', '##', '###', '####', '#####', '######'])(
    '見出しの階層（%s）に関わらず題として取る',
    (marks) => {
      const m = split(`${marks} 正午の鏡\n\n本文`);
      expect(m.title).toBe('正午の鏡');
      expect(m.titleRule).toBe('markdown_heading');
      expect(m.body).toBe('本文');
    },
  );

  it('末尾の # と余分な空白は題に含めない', () => {
    const m = split('## 題 ##\n\n本文');
    expect(m.title).toBe('題');
    expect(m.titleRule).toBe('markdown_heading');
    expect(m.body).toBe('本文');
    expect(split('#   題   \n\n本文').title).toBe('題');
  });

  it('# が7つ以上は見出しではない（題は取らず、本文を削らない）', () => {
    const m = split('####### 題\n\n本文');
    expect(m.title).toBeNull();
    expect(m.titleRule).toBeNull();
    expect(m.body).toBe('####### 題\n\n本文');
  });

  it('行全体が ** で囲まれた題は bold', () => {
    const m = split('**正午の鏡**\n\n本文');
    expect(m.title).toBe('正午の鏡');
    expect(m.titleRule).toBe('bold');
    expect(m.body).toBe('本文');
  });

  it('** が行の一部だけなら題として取らない', () => {
    const m = split('**題**は言った。\n\n本文');
    expect(m.title).toBeNull();
    expect(m.titleRule).toBeNull();
    expect(m.body).toContain('**題**は言った。');
  });

  it.each([
    ['タイトル：正午の鏡', '正午の鏡'],
    ['タイトル: 正午の鏡', '正午の鏡'],
    ['題名：正午の鏡', '正午の鏡'],
    ['題名: 正午の鏡', '正午の鏡'],
    ['題：正午の鏡', '正午の鏡'],
    ['Title: Mirror', 'Mirror'],
    ['Title：Mirror', 'Mirror'],
  ])('ラベル付きの題 %s', (line, expected) => {
    const m = split(`${line}\n\n本文`);
    expect(m.title).toBe(expected);
    expect(m.titleRule).toBe('label');
    expect(m.body).toBe('本文');
  });

  it('行全体が 『題』 で、次が空行なら bracketed', () => {
    const m = split('『正午の鏡』\n\n本文');
    expect(m.title).toBe('正午の鏡');
    expect(m.titleRule).toBe('bracketed');
    expect(m.body).toBe('本文');
  });

  it('『題』 の次の行が空白だけの行でも、空行として扱う', () => {
    const m = split('『正午の鏡』\n  \n本文');
    expect(m.title).toBe('正午の鏡');
    expect(m.titleRule).toBe('bracketed');
    expect(m.body).toBe('本文');
  });

  it('『題』 だけの原稿（それが最後の行）も bracketed で、本文は空', () => {
    const m = split('『正午の鏡』');
    expect(m.title).toBe('正午の鏡');
    expect(m.titleRule).toBe('bracketed');
    expect(m.body).toBe('');
    expect(m.bodyChars).toBe(0);
  });

  it('『題』 の直後に本文が続くとき（空行なし）は題として取らない', () => {
    const m = split('『正午の鏡』\n本文');
    expect(m.title).toBeNull();
    expect(m.titleRule).toBeNull();
    expect(m.body).toBe('『正午の鏡』\n本文');
  });

  it('『題』は言った。 のように行の一部なら題として取らない', () => {
    const m = split('『正午の鏡』は言った。\n\n本文');
    expect(m.title).toBeNull();
    expect(m.titleRule).toBeNull();
    expect(m.body).toBe('『正午の鏡』は言った。\n\n本文');
  });

  it('書式の無い1行目は題と判定せず、本文を削らず、確認の warning を出す', () => {
    const m = split('正午の鏡\n\n本文');
    expect(m.title).toBeNull();
    expect(m.titleRule).toBeNull();
    expect(m.body).toContain('正午の鏡');
    expect(m.body).toBe('正午の鏡\n\n本文');
    expect(m.warnings.some((w) => w.includes('題'))).toBe(true);
  });

  it('題の行のすぐ次に本文が続いても（空行なし）、題の行だけを取り除く', () => {
    expect(split('# 題\n本文').body).toBe('本文');
    expect(split('タイトル：題\n本文').body).toBe('本文');
  });

  it('見るのは最初の空でない行だけ（途中の見出しは題にしない）', () => {
    const m = split('はじまりの一文。\n\n# あとの見出し\n\n本文');
    expect(m.title).toBeNull();
    expect(m.titleRule).toBeNull();
    expect(m.body).toBe('はじまりの一文。\n\n# あとの見出し\n\n本文');
  });

  it('題の前の空行（空白だけの行を含む）は読み飛ばす', () => {
    const m = split('\n\n  \n\t\n# 題\n\n本文');
    expect(m.title).toBe('題');
    expect(m.titleRule).toBe('markdown_heading');
    expect(m.body).toBe('本文');
  });

  it('CRLF の原稿でも題を取れ、normalized に CR は残らない', () => {
    const m = split('# 題\r\n\r\n本文\r\n');
    expect(m.title).toBe('題');
    expect(m.titleRule).toBe('markdown_heading');
    expect(m.body).toBe('本文');
    expect(m.normalized).toBe('# 題\n\n本文\n');
    expect(m.normalized).not.toContain('\r');
  });

  it('題の規則ごとに、題の行は本文に残らない（本文に書式の warning が出ない）', () => {
    const cases: Array<[string, TitleRule]> = [
      ['# 題', 'markdown_heading'],
      ['**題**', 'bold'],
      ['タイトル：題', 'label'],
      ['『題』', 'bracketed'],
    ];
    for (const [line, rule] of cases) {
      const m = split(`${line}\n\n${LONG_BODY}\n`);
      expect(m.titleRule).toBe(rule);
      expect(m.title).toBe('題');
      expect(m.body).toBe(LONG_BODY);
      expect(m.warnings).toEqual([]);
    }
  });
});

describe('splitManuscript: 本文と normalized', () => {
  it('結果の形（題・規則・本文・文字数・normalized）', () => {
    const m = split('# 正午の鏡\n\n本文');
    expect(m).toMatchObject({
      normalized: '# 正午の鏡\n\n本文',
      title: '正午の鏡',
      titleRule: 'markdown_heading',
      body: '本文',
      bodyChars: 2,
    });
    expect(Array.isArray(m.warnings)).toBe(true);
  });

  it('先頭と末尾の空行（空白だけの行を含む）を落とす', () => {
    expect(split('# 題\n \n\t\n　\n本文\n \n\n').body).toBe('本文');
  });

  it('題が無いときも、先頭と末尾の空行だけを落とす', () => {
    const m = split('\n\n  \n本文\n\n \n');
    expect(m.title).toBeNull();
    expect(m.body).toBe('本文');
  });

  it('途中の3つ以上続く空行は、一つも減らさず残す', () => {
    const middle = 'A\n\n\n\n\nB\n\n\nC';
    expect(split(`# 題\n\n${middle}\n`).body).toBe(middle);
  });

  it('途中の空白だけの行も、そのまま残す', () => {
    const middle = 'A\n  \n\t\n\nB';
    expect(split(`# 題\n\n${middle}\n`).body).toBe(middle);
  });

  it('行末の空白と、行頭の字下げ（全角空白・タブ）を変えない', () => {
    const body = '　「ああ」と言った。  \n\t二行目。  \n三行目。 　';
    expect(split(`# 題\n\n${body}\n`).body).toBe(body);
  });

  it('最後の行の行末の空白も残す（落とすのは空行だけ）', () => {
    expect(split('# 題\n\n一行目  \n二行目  \n').body).toBe('一行目  \n二行目  ');
  });

  it('normalized は normalizeNewlines(raw) と一致する', () => {
    const raws = [
      '# 題\r\n\r\n本文\r\n',
      'a\rb\r\nc\n',
      '\n\n本文  \r\n\r\n\r\n\r\n続き\r\n\r\n',
      'タイトル：題\r\r本文',
    ];
    for (const raw of raws) {
      const m = split(raw);
      expect(m.normalized).toBe(normalizeNewlines(raw));
      expect(m.normalized).not.toContain('\r');
    }
  });

  it('本文は、いつでも normalized の連続した部分文字列（語句を失わない）', () => {
    const raws = [
      '# 題\n\n本文',
      '## 題 ##\r\n\r\n　一行目  \r\n\r\n\r\n\r\n二行目\r\n',
      '**題**\n本文\n',
      'タイトル：題\n\n本文\n\n\n',
      '『題』\n\n本文\n',
      '『題』\n本文\n',
      '正午の鏡\n\n本文',
      '\n\n  \nただの本文  \n \n',
      '####### 題\n\n本文',
      `# 題\n\n${LONG_BODY}\n\n**強調**\n\n※注記\n`,
    ];
    for (const raw of raws) {
      const m = split(raw);
      expect(m.normalized.includes(m.body)).toBe(true);
      if (m.body !== '') {
        expect(m.body.startsWith('\n')).toBe(false);
        expect(m.body.endsWith('\n')).toBe(false);
      }
    }
  });

  it('bodyChars はコードポイント数（サロゲートペアを1字と数える）', () => {
    const body = '𠮷野家の𠮷';
    const m = split(`# 題\n\n${body}\n`);
    expect(m.body).toBe(body);
    expect(m.bodyChars).toBe([...body].length);
    expect(m.bodyChars).toBe(5);
    expect(m.bodyChars).not.toBe(body.length);
  });

  it('bodyChars は本文の空白と改行も数える', () => {
    expect(split('# 題\n\nA\n\nB').bodyChars).toBe(4);
    expect(split('# 題\n\n　あ  \n').bodyChars).toBe(4);
  });

  it('入力の文字列は変わらず、同じ入力には同じ結果を返す', () => {
    const raw = '# 題\r\n\r\n本文  \r\n';
    const copy = `${raw}`;
    const first = split(raw);
    const second = split(raw);
    expect(raw).toBe(copy);
    expect(first.normalized).toBe('# 題\n\n本文  \n');
    expect(second).toEqual(first);
  });
});

/** 空白（改行を含む）をすべて除く。assertNoTextLost の不変条件と同じ見方。 */
const stripWhitespace = (text: string): string => text.replace(/\s+/gu, '');

describe('assertNoTextLost: 題の行を除いて、空白でない字を1つも失っていないこと', () => {
  it('空白を除いた normalized が「題の行 + 本文」と一致すれば通る', () => {
    expect(() => assertNoTextLost('# 題\n\n本文の一行目\n\n二行目\n', '# 題', '本文の一行目\n\n二行目')).not.toThrow();
  });

  it('題の行が無ければ（空文字）、本文だけと一致すれば通る。落とした空行は空白なので問われない', () => {
    expect(() => assertNoTextLost('\n\n  \n本文  \n \n', '', '本文  ')).not.toThrow();
    expect(() => assertNoTextLost('本文', '', '本文')).not.toThrow();
  });

  it('空白の入り方が違うだけなら通る（空白・タブ・全角空白・改行はどれも空白）', () => {
    expect(() => assertNoTextLost('# 題\n\u3000あ\tい \nう\n', '# 題', 'あい う')).not.toThrow();
  });

  it('本文から、空白でない字が1つでも欠けていたら投げる', () => {
    expect(() => assertNoTextLost('# 題\n\n本文の一行目\n二行目\n', '# 題', '本文の一行目\n二行')).toThrow(/語句を失/);
  });

  it('本文に、normalized に無い字が混じっていても投げる', () => {
    expect(() => assertNoTextLost('# 題\n\n本文\n', '# 題', '本文。')).toThrow(/語句を失/);
  });

  it('題の行を本文から取り除いたのに、題の行を渡し忘れても（題の分が足りない）投げる', () => {
    // 部分文字列かどうかだけを見る旧い検査は、これを通してしまう（本文は normalized の部分文字列だから）
    expect(() => assertNoTextLost('# 題\n\n本文\n', '', '本文')).toThrow(/語句を失/);
  });

  it('題の行を本文にも残してしまった（二重に数えた）ときも投げる', () => {
    expect(() => assertNoTextLost('# 題\n\n本文\n', '# 題', '# 題\n\n本文')).toThrow(/語句を失/);
  });

  it('本文の語句の順序が入れ替わっていても投げる', () => {
    expect(() => assertNoTextLost('# 題\n\nあい\nうえ\n', '# 題', 'うえ\nあい')).toThrow(/語句を失/);
  });

  it('投げるときの文面は、失った語句や本文そのものを含まない', () => {
    let message = '';
    try {
      assertNoTextLost('# 題\n\nZXQV9921の札\n', '# 題', '札');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/語句を失/);
    expect(message).not.toContain('ZXQV9921');
  });
});

describe('splitManuscript: 保全の不変条件は、すべての題の規則で成り立つ', () => {
  /** 題の規則ごとの、題の行（原稿の最初の空でない行そのまま） */
  const TITLE_LINES: Array<[string, TitleRule]> = [
    ['# 題', 'markdown_heading'],
    ['###### 題', 'markdown_heading'],
    ['## 題 ##', 'markdown_heading'],
    ['**題**', 'bold'],
    ['タイトル：題', 'label'],
    ['Title: 題', 'label'],
    ['題名：題', 'label'],
    ['『題』', 'bracketed'],
  ];
  const BODIES = [
    LONG_BODY,
    '一行目  \n\n\n\n二行目\n\t三行目',
    '　字下げ　\n「会話」と言った。\n『括弧』の行\n',
    '本文',
  ];

  it.each(TITLE_LINES)('題の行 %s（%s）: 空白を除いた normalized = 題の行 + 本文', (titleLine, rule) => {
    for (const body of BODIES) {
      for (const eol of ['\n', '\r\n', '\r']) {
        for (const lead of ['', '\n', '  \n\t\n']) {
          const raw = `${lead}${titleLine}\n\n${body}\n\n`.replace(/\n/g, eol);
          const m = split(raw);
          expect(m.titleRule, `${JSON.stringify(titleLine)} ${JSON.stringify(eol)}`).toBe(rule);
          expect(stripWhitespace(m.normalized)).toBe(stripWhitespace(titleLine) + stripWhitespace(m.body));
          // 本文の側は、元の本文から空白でない字を1つも失っていない
          expect(stripWhitespace(m.body)).toBe(stripWhitespace(body));
        }
      }
    }
  });

  it('題が無い原稿は、空白を除いた normalized = 本文', () => {
    for (const raw of ['正午の鏡\n\n本文', '\n\n  \nただの本文  \n \n', '####### 題\n\n本文', '**題** と続く本文\n', '『題』は言った。\n本文\n']) {
      const m = split(raw);
      expect(m.titleRule, raw).toBeNull();
      expect(stripWhitespace(m.normalized)).toBe(stripWhitespace(m.body));
    }
  });

  it('題の行だけの原稿でも成り立つ（本文は空）', () => {
    for (const raw of ['# 題\n', '『題』', '**題**\n\n\n']) {
      const m = split(raw);
      expect(m.body).toBe('');
      expect(stripWhitespace(m.normalized)).toBe(stripWhitespace(raw));
    }
  });

  it('題の行に当たらない最初の行は、本文として丸ごと残る（1行目を落とさない）', () => {
    const m = split('はじまりの一行\n\n続き\n');
    expect(m.title).toBeNull();
    expect(stripWhitespace(m.body)).toBe(stripWhitespace('はじまりの一行続き'));
  });
});

describe('splitManuscript: 異常検知は warnings だけ', () => {
  it('十分な長さで書式の問題が無い本文には warning が出ない', () => {
    const m = split(`# 題\n\n${LONG_BODY}\n`);
    expect(m.bodyChars).toBeGreaterThanOrEqual(SHORT_BODY_CHARS);
    expect(m.warnings).toEqual([]);
  });

  it('SHORT_BODY_CHARS 字未満は warning（本文は変えず、失敗にもしない）', () => {
    const body = 'あ'.repeat(SHORT_BODY_CHARS - 1);
    const m = split(`# 題\n\n${body}\n`);
    expect(m.bodyChars).toBe(SHORT_BODY_CHARS - 1);
    expect(m.warnings).toHaveLength(1);
    expect(m.body).toBe(body);
  });

  it('ちょうど SHORT_BODY_CHARS 字なら短さの warning は出ない', () => {
    const body = 'あ'.repeat(SHORT_BODY_CHARS);
    const m = split(`# 題\n\n${body}\n`);
    expect(m.bodyChars).toBe(SHORT_BODY_CHARS);
    expect(m.warnings).toEqual([]);
  });

  it('短い本文でも投げず、全文を本文として返す', () => {
    const m = split('# 題\n\n短い。');
    expect(m.body).toBe('短い。');
    expect(m.warnings.length).toBeGreaterThanOrEqual(1);
  });

  it('Markdown の強調が本文に残っていれば「書式」の warning。本文は直さない', () => {
    const body = `${LONG_BODY}\n\n**強調**された語。`;
    const m = split(`# 題\n\n${body}\n`);
    expect(m.warnings.some((w) => w.includes('書式'))).toBe(true);
    expect(m.body).toBe(body);
    expect(m.body).toContain('**強調**');
  });

  it.each(['解説：', '解説', 'あとがき', '補足', '注：', '字数', '文字数', '※'])(
    '本文の外の注記らしい行（行頭が %s）は warning。本文は削らない',
    (marker) => {
      const body = `${LONG_BODY}\n\n${marker}この話について少し書きます。`;
      const m = split(`# 題\n\n${body}\n`);
      expect(m.warnings.length).toBeGreaterThanOrEqual(1);
      expect(m.body).toBe(body);
    },
  );

  it.each(['解説', 'あとがき', '補足', '字数', '※'])(
    '行の途中に %s が出ても注記とは見なさない',
    (marker) => {
      const m = split(`# 題\n\n${LONG_BODY}\n\n彼は札に${marker}と書いた。\n`);
      expect(m.warnings).toEqual([]);
    },
  );

  it('秘密の断片に当たると、所有者を示す warning を出す。断片や本文は書かない', () => {
    const body = `${LONG_BODY}\n\n灯りの下でZXQV9921の札を見た。`;
    const m = splitManuscript(`# 題\n\n${body}\n`, { secretLeaks: () => [{ owner: 'riko' }] });
    const warning = m.warnings.find((w) => w.includes('riko'));
    expect(warning).toBeDefined();
    expect(m.warnings.join('\n')).not.toContain('ZXQV9921');
    expect(m.warnings.join('\n')).not.toContain(LONG_BODY.slice(0, 20));
    expect(m.body).toBe(body);
  });

  it('所有者が複数なら、その全員が warning に現れる', () => {
    const m = splitManuscript(`# 題\n\n${LONG_BODY}\n`, {
      secretLeaks: () => [{ owner: 'riko' }, { owner: 'teo' }],
    });
    const text = m.warnings.join('\n');
    expect(text).toContain('riko');
    expect(text).toContain('teo');
  });

  it('秘密の照合は本文を渡して呼ぶ', () => {
    const spy = vi.fn((_text: string): Leak[] => []);
    const body = `${LONG_BODY}\n\n結びの一文。`;
    splitManuscript(`# 題\n\n${body}\n`, { secretLeaks: spy });
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls.some(([text]) => text.includes(body))).toBe(true);
  });

  it('秘密の断片が無ければ（空配列）所有者の warning は出ない', () => {
    const m = split(`# 題\n\n${LONG_BODY}\n`);
    expect(m.warnings).toEqual([]);
  });

  it('warning があっても本文・題・normalized は warning の有無で変わらない', () => {
    const raw = `# 題\n\n${LONG_BODY}\n`;
    const clean = split(raw);
    const flagged = splitManuscript(raw, { secretLeaks: () => [{ owner: 'riko' }] });
    expect(flagged.body).toBe(clean.body);
    expect(flagged.title).toBe(clean.title);
    expect(flagged.normalized).toBe(clean.normalized);
    expect(flagged.bodyChars).toBe(clean.bodyChars);
    expect(flagged.warnings.length).toBeGreaterThan(clean.warnings.length);
  });
});

describe('splitManuscript: 秘密の照合の既定', () => {
  it('options を省くと src/lib/secrets.ts の secretLeaksIn を使う', () => {
    secretLeaksInMock.mockReturnValue([{ owner: 'teo', segment: 'SEGSEG7788' }]);
    const m = splitManuscript(`# 題\n\n${LONG_BODY}\n`);
    expect(secretLeaksInMock).toHaveBeenCalled();
    const text = m.warnings.join('\n');
    expect(text).toContain('teo');
    expect(text).not.toContain('SEGSEG7788');
  });

  it('options を省いて断片が無ければ、secretLeaksIn の結果が空なので warning は出ない', () => {
    const m = splitManuscript(`# 題\n\n${LONG_BODY}\n`);
    expect(secretLeaksInMock).toHaveBeenCalled();
    expect(m.warnings).toEqual([]);
  });

  it('secretLeaks を渡したときは、既定の secretLeaksIn を呼ばない', () => {
    split(`# 題\n\n${LONG_BODY}\n`);
    expect(secretLeaksInMock).not.toHaveBeenCalled();
  });
});
