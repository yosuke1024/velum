import { describe, it, expect } from 'vitest';
import { unifiedDiff } from '../../src/story/authoring/diff.js';

const NO_NEWLINE = '\\ No newline at end of file';
const LABELS = { a: 'a-label', b: 'b-label' };

/** 1..n の行（末尾に改行）。`l1\nl2\n...` */
const numbered = (n: number, prefix = 'l'): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
const text = (lines: string[]): string => lines.map((l) => `${l}\n`).join('');

/** 出力の末尾の改行を1つだけ外して行に割る（末尾の改行の有無には依存しない） */
const outLines = (diff: string): string[] =>
  (diff.endsWith('\n') ? diff.slice(0, -1) : diff).split('\n');

type Hunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
};

/**
 * unified diff を読む（ファイル見出しの2行の後ろ）。
 * 件数の省略（`-5` = `-5,1`）は GNU/git の流儀で、契約の `-l,s` の形が基本だが、読む側は両方受ける。
 */
function parseHunks(diff: string): Hunk[] {
  const lines = outLines(diff).slice(2);
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  for (const line of lines) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/.exec(line);
    if (m) {
      cur = {
        oldStart: Number(m[1]),
        oldCount: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newCount: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      };
      hunks.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    } else {
      throw new Error(`見出しの後ろに hunk の前の行がある: ${JSON.stringify(line)}`);
    }
  }
  return hunks;
}

/**
 * hunk を a に当てて b を作る（改行で終わる本文どうしの往復の確認用）。
 * 見出しの件数・文脈の一致・範囲の順序をすべて検査する。
 */
function applyUnified(a: string, diff: string): string {
  const aLines = a === '' ? [] : outLines(a);
  const out: string[] = [];
  let pos = 0; // a の次に読む行（0 起点）
  for (const h of parseHunks(diff)) {
    // 件数 0 のときの開始行は「その直前の行」（GNU 流）
    const startIdx = h.oldCount === 0 ? h.oldStart : h.oldStart - 1;
    expect(startIdx).toBeGreaterThanOrEqual(pos);
    while (pos < startIdx) out.push(aLines[pos++] as string);
    let oldSeen = 0;
    let newSeen = 0;
    for (const line of h.lines) {
      const tag = line[0];
      const body = line.slice(1);
      if (tag === ' ') {
        expect(aLines[pos]).toBe(body);
        out.push(body);
        pos++;
        oldSeen++;
        newSeen++;
      } else if (tag === '-') {
        expect(aLines[pos]).toBe(body);
        pos++;
        oldSeen++;
      } else if (tag === '+') {
        out.push(body);
        newSeen++;
      } else {
        throw new Error(`hunk の中に知らない行: ${JSON.stringify(line)}`);
      }
    }
    expect(oldSeen).toBe(h.oldCount);
    expect(newSeen).toBe(h.newCount);
  }
  while (pos < aLines.length) out.push(aLines[pos++] as string);
  return out.map((l) => `${l}\n`).join('');
}

const count = (lines: string[], tag: '+' | '-'): number =>
  lines.filter((l) => l.startsWith(tag)).length;

describe('unifiedDiff: 同じ内容', () => {
  it('同じ内容なら空文字を返す', () => {
    const t = text(numbered(10));
    expect(unifiedDiff(t, t, LABELS)).toBe('');
  });

  it('どちらも空でも空文字', () => {
    expect(unifiedDiff('', '', LABELS)).toBe('');
  });

  it('末尾の改行がないどうしで同じなら空文字', () => {
    expect(unifiedDiff('x\ny', 'x\ny', LABELS)).toBe('');
  });
});

describe('unifiedDiff: 1行だけ変わる', () => {
  const a = text(numbered(10).map((l) => (l === 'l5' ? 'old' : l)));
  const b = text(numbered(10).map((l) => (l === 'l5' ? 'new' : l)));

  it('見出し2行 + hunk 1つ。既定の文脈は3行', () => {
    const diff = unifiedDiff(a, b, LABELS);
    expect(diff.startsWith('--- a-label\n+++ b-label\n')).toBe(true);
    expect(outLines(diff)).toEqual([
      '--- a-label',
      '+++ b-label',
      '@@ -2,7 +2,7 @@',
      ' l2',
      ' l3',
      ' l4',
      '-old',
      '+new',
      ' l6',
      ' l7',
      ' l8',
    ]);
  });

  it('hunk の見出しは `@@ -l,s +l,s @@` の形で、件数が行と合う', () => {
    const diff = unifiedDiff(a, b, LABELS);
    const headers = outLines(diff).filter((l) => l.startsWith('@@'));
    expect(headers).toHaveLength(1);
    expect(headers[0]).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/);
    const [h] = parseHunks(diff);
    expect(h).toBeDefined();
    expect(h?.lines.filter((l) => l.startsWith(' ') || l.startsWith('-'))).toHaveLength(7);
    expect(h?.lines.filter((l) => l.startsWith(' ') || l.startsWith('+'))).toHaveLength(7);
  });

  it('文脈の行数は context 引数に従う（context=1）', () => {
    const diff = unifiedDiff(a, b, LABELS, 1);
    expect(outLines(diff)).toEqual([
      '--- a-label',
      '+++ b-label',
      '@@ -4,3 +4,3 @@',
      ' l4',
      '-old',
      '+new',
      ' l6',
    ]);
  });

  it('context を大きくすると前後の行を使い切って、ファイルの端で止まる（context=100）', () => {
    const diff = unifiedDiff(a, b, LABELS, 100);
    const [h] = parseHunks(diff);
    expect(parseHunks(diff)).toHaveLength(1);
    expect(h?.oldStart).toBe(1);
    expect(h?.oldCount).toBe(10);
    expect(h?.newStart).toBe(1);
    expect(h?.newCount).toBe(10);
    expect(applyUnified(a, diff)).toBe(b);
  });

  it('ラベルは見出しにそのまま入る', () => {
    const diff = unifiedDiff(a, b, { a: 'parent/manuscript.body.txt', b: 'child/manuscript.body.txt' });
    expect(outLines(diff).slice(0, 2)).toEqual([
      '--- parent/manuscript.body.txt',
      '+++ child/manuscript.body.txt',
    ]);
  });
});

describe('unifiedDiff: 先頭・末尾・全行', () => {
  it('先頭への挿入', () => {
    const a = text(numbered(5));
    const b = text(['NEW', ...numbered(5)]);
    const diff = unifiedDiff(a, b, LABELS);
    expect(outLines(diff)).toEqual([
      '--- a-label',
      '+++ b-label',
      '@@ -1,3 +1,4 @@',
      '+NEW',
      ' l1',
      ' l2',
      ' l3',
    ]);
    expect(applyUnified(a, diff)).toBe(b);
  });

  it('末尾への挿入', () => {
    const a = text(numbered(5));
    const b = text([...numbered(5), 'NEW']);
    const diff = unifiedDiff(a, b, LABELS);
    expect(outLines(diff)).toEqual([
      '--- a-label',
      '+++ b-label',
      '@@ -3,3 +3,4 @@',
      ' l3',
      ' l4',
      ' l5',
      '+NEW',
    ]);
    expect(applyUnified(a, diff)).toBe(b);
  });

  it('先頭の行の削除', () => {
    const a = text(numbered(5));
    const b = text(numbered(5).slice(1));
    const diff = unifiedDiff(a, b, LABELS);
    expect(outLines(diff)).toEqual([
      '--- a-label',
      '+++ b-label',
      '@@ -1,4 +1,3 @@',
      '-l1',
      ' l2',
      ' l3',
      ' l4',
    ]);
    expect(applyUnified(a, diff)).toBe(b);
  });

  it('全行の削除（b が空）', () => {
    const a = text(['x', 'y']);
    const diff = unifiedDiff(a, '', LABELS);
    expect(outLines(diff)).toEqual(['--- a-label', '+++ b-label', '@@ -1,2 +0,0 @@', '-x', '-y']);
    expect(applyUnified(a, diff)).toBe('');
  });

  it('全行の追加（a が空）', () => {
    const b = text(['x', 'y']);
    const diff = unifiedDiff('', b, LABELS);
    expect(outLines(diff)).toEqual(['--- a-label', '+++ b-label', '@@ -0,0 +1,2 @@', '+x', '+y']);
    expect(applyUnified('', diff)).toBe(b);
  });

  it('全行を別の内容に置き換える', () => {
    const a = text(['x', 'y']);
    const b = text(['p', 'q', 'r']);
    const diff = unifiedDiff(a, b, LABELS);
    const [h] = parseHunks(diff);
    expect(parseHunks(diff)).toHaveLength(1);
    expect(h?.lines.filter((l) => l.startsWith(' '))).toEqual([]);
    expect(count(h?.lines ?? [], '-')).toBe(2);
    expect(count(h?.lines ?? [], '+')).toBe(3);
    expect(applyUnified(a, diff)).toBe(b);
  });
});

describe('unifiedDiff: 変更の数え方と hunk の分け方', () => {
  it('既知の例で、`-` の行数は削除数、`+` の行数は追加数に等しい', () => {
    const a = text(numbered(10));
    // l3, l4 を消し、l7 の後ろに A1〜A3 を足す
    const b = text(['l1', 'l2', 'l5', 'l6', 'l7', 'A1', 'A2', 'A3', 'l8', 'l9', 'l10']);
    const diff = unifiedDiff(a, b, LABELS);
    const body = outLines(diff).slice(2).filter((l) => !l.startsWith('@@'));
    expect(count(body, '-')).toBe(2);
    expect(count(body, '+')).toBe(3);
    expect(body.filter((l) => l.startsWith('-')).sort()).toEqual(['-l3', '-l4']);
    expect(body.filter((l) => l.startsWith('+')).sort()).toEqual(['+A1', '+A2', '+A3']);
    expect(applyUnified(a, diff)).toBe(b);
  });

  it('近い2か所の変更は1つの hunk にまとまる', () => {
    const a = text(numbered(12));
    const b = text(numbered(12).map((l) => (l === 'l4' || l === 'l7' ? `${l}x` : l)));
    const diff = unifiedDiff(a, b, LABELS);
    expect(parseHunks(diff)).toHaveLength(1);
    expect(applyUnified(a, diff)).toBe(b);
  });

  it('遠い2か所の変更は別々の hunk になり、間の行は出さない', () => {
    const a = text(numbered(30));
    const b = text(numbered(30).map((l) => (l === 'l3' || l === 'l28' ? `${l}x` : l)));
    const diff = unifiedDiff(a, b, LABELS);
    const hunks = parseHunks(diff);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]?.oldStart).toBe(1);
    expect(hunks[1]?.oldStart).toBe(25);
    const lines = outLines(diff);
    expect(lines).not.toContain(' l15');
    expect(lines).toContain('-l3');
    expect(lines).toContain('+l3x');
    expect(lines).toContain('-l28');
    expect(lines).toContain('+l28x');
    expect(applyUnified(a, diff)).toBe(b);
  });

  it('行の並びが入れ替わっても、適用すると b になる', () => {
    const a = text(['a', 'b', 'c', 'd', 'e', 'f']);
    const b = text(['f', 'b', 'c', 'e', 'd', 'a']);
    const diff = unifiedDiff(a, b, LABELS);
    expect(diff).not.toBe('');
    expect(applyUnified(a, diff)).toBe(b);
  });

  it('同じ行が繰り返されていても、最小の編集になる（余計な -/+ を出さない）', () => {
    const a = text(['x', 'x', 'x', 'y']);
    const b = text(['x', 'x', 'x', 'x', 'y']);
    const diff = unifiedDiff(a, b, LABELS);
    const body = outLines(diff).slice(2).filter((l) => !l.startsWith('@@'));
    expect(count(body, '-')).toBe(0);
    expect(count(body, '+')).toBe(1);
    expect(applyUnified(a, diff)).toBe(b);
  });

  it('空行も1行として扱う', () => {
    const a = 'a\n\nb\n';
    const b = 'a\n\n\nb\n';
    const diff = unifiedDiff(a, b, LABELS);
    const body = outLines(diff).slice(2).filter((l) => !l.startsWith('@@'));
    expect(count(body, '-')).toBe(0);
    expect(count(body, '+')).toBe(1);
    expect(applyUnified(a, diff)).toBe(b);
  });
});

describe('unifiedDiff: 日本語', () => {
  it('日本語の行はそのまま出る（段落1行の変更）', () => {
    const a = '雨の音がする。\n窓の外は暗い。\n遠くで電車が鳴った。\n';
    const b = '雨の音がする。\n窓の外は少し明るい。\n遠くで電車が鳴った。\n';
    const diff = unifiedDiff(a, b, LABELS);
    expect(outLines(diff)).toEqual([
      '--- a-label',
      '+++ b-label',
      '@@ -1,3 +1,3 @@',
      ' 雨の音がする。',
      '-窓の外は暗い。',
      '+窓の外は少し明るい。',
      ' 遠くで電車が鳴った。',
    ]);
    expect(applyUnified(a, diff)).toBe(b);
  });

  it('長い1行の段落は、行ごと -/+ になる（行の内側を切らない）', () => {
    const before = '朝の光が机の端に落ちて、ノートの罫線をひとつずつ白くしていった。';
    const after = '朝の光が机の端に落ちて、ノートの罫線をひとつずつ青くしていった。';
    const diff = unifiedDiff(`${before}\n`, `${after}\n`, LABELS);
    expect(outLines(diff)).toContain(`-${before}`);
    expect(outLines(diff)).toContain(`+${after}`);
  });
});

describe('unifiedDiff: 末尾の改行', () => {
  it('a だけ末尾に改行がない: 欠けている側の行の直後に印が付く', () => {
    const diff = unifiedDiff('x\ny', 'x\ny\n', LABELS);
    const lines = outLines(diff);
    expect(diff).toContain(NO_NEWLINE);
    expect(lines.filter((l) => l === NO_NEWLINE)).toHaveLength(1);
    const i = lines.indexOf('-y');
    expect(i).toBeGreaterThan(-1);
    expect(lines[i + 1]).toBe(NO_NEWLINE);
    expect(lines[i + 2]).toBe('+y');
  });

  it('b だけ末尾に改行がない: 欠けている側の行の直後に印が付く', () => {
    const diff = unifiedDiff('x\ny\n', 'x\ny', LABELS);
    const lines = outLines(diff);
    expect(diff).toContain(NO_NEWLINE);
    expect(lines.filter((l) => l === NO_NEWLINE)).toHaveLength(1);
    const i = lines.indexOf('+y');
    expect(i).toBeGreaterThan(-1);
    expect(lines[i - 1]).toBe('-y');
    expect(lines[i + 1]).toBe(NO_NEWLINE);
  });

  it('改行の有無だけが違う内容は「同じ」ではない（空文字にしない）', () => {
    expect(unifiedDiff('x', 'x\n', LABELS)).not.toBe('');
    expect(unifiedDiff('x\n', 'x', LABELS)).not.toBe('');
  });

  it('末尾の行が変わり、b の末尾に改行がない', () => {
    const diff = unifiedDiff('a\nb\nc\n', 'a\nb\nC', LABELS);
    const lines = outLines(diff);
    expect(lines.filter((l) => l === NO_NEWLINE)).toHaveLength(1);
    expect(lines[lines.length - 1]).toBe(NO_NEWLINE);
    expect(lines[lines.length - 2]).toBe('+C');
  });

  it('どちらも末尾に改行がなく、末尾が文脈のとき、その文脈の行の直後に印が付く', () => {
    const diff = unifiedDiff('a\nb\nc', 'a\nB\nc', LABELS);
    const lines = outLines(diff);
    expect(lines.filter((l) => l === NO_NEWLINE)).toHaveLength(1);
    const i = lines.indexOf(' c');
    expect(i).toBeGreaterThan(-1);
    expect(lines[i + 1]).toBe(NO_NEWLINE);
  });

  it('どちらも末尾が改行なら、印は出ない', () => {
    const diff = unifiedDiff('x\ny\n', 'x\nz\n', LABELS);
    expect(diff).not.toContain(NO_NEWLINE);
  });
});
