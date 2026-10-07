import { describe, it, expect } from 'vitest';
import {
  forbiddenSecretSegments,
  secretLeaksIn,
  secretLeaksInJson,
  secretSegments,
} from '../../src/lib/secrets.js';

/**
 * 秘匿情報の照合。断片は実データ（forbiddenSecretSegments）から取る——
 * 秘密の文面をテストへ書き写さない（書き写せば、そこが新しい漏れ先になる）。
 */

/** JSON で壊れる文字（" と \）を含まない、折り返しに使える断片。 */
const segment = forbiddenSecretSegments().find(
  (s) => !/["\\\s]/.test(s.segment) && [...s.segment].length >= 10,
);
if (!segment) throw new Error('テスト用の秘密の断片が見つかりません');

/** 断片を真ん中で割り、間に hard newline を入れたもの（本文の折り返しを模す）。 */
const wrapped = (() => {
  const chars = [...segment.segment];
  const half = Math.floor(chars.length / 2);
  return `${chars.slice(0, half).join('')}\n${chars.slice(half).join('')}`;
})();

const found = (leaks: Array<{ owner: string; segment: string }>) =>
  leaks.some((l) => l.owner === segment.owner && l.segment === segment.segment);

describe('forbiddenSecretSegments', () => {
  it('1プロセスで1度だけ組み、同じ一覧を返す', () => {
    expect(forbiddenSecretSegments()).toBe(forbiddenSecretSegments());
  });

  it('断片は照合に意味のある長さ（8字以上）で、所有者を持つ', () => {
    for (const s of forbiddenSecretSegments()) {
      expect([...s.segment].length).toBeGreaterThanOrEqual(8);
      expect(s.owner.length).toBeGreaterThan(0);
    }
  });

  it('secretSegments は文と改行で割り、短い断片を捨てる', () => {
    expect(secretSegments('これは十分に長い一文です。短い\nもうひとつ十分に長い断片です')).toEqual([
      'これは十分に長い一文です',
      'もうひとつ十分に長い断片です',
    ]);
  });
});

describe('secretLeaksIn', () => {
  it('断片をそのまま含むテキストを検出する', () => {
    expect(found(secretLeaksIn(`前置き。${segment.segment}。後書き。`))).toBe(true);
  });

  it('空白・改行の入り方が違っても同じ文は同じ文として検出する（生の改行）', () => {
    expect(found(secretLeaksIn(wrapped))).toBe(true);
  });

  it('秘密を含まないテキストは通す', () => {
    expect(secretLeaksIn('朝いちばんの市は、まだ霜の匂いがした。')).toEqual([]);
  });

  it('JSON に直列化された折り返し（バックスラッシュと n の2文字）は、これ単独では素通りする', () => {
    // ここが secretLeaksInJson の存在理由。生のテキストでは改行が \n という2文字になっている。
    const serialized = JSON.stringify({ body: { ja: wrapped } });
    expect(serialized).toContain('\\n');
    expect(found(secretLeaksIn(serialized))).toBe(false);
  });
});

describe('secretLeaksInJson', () => {
  it('JSON の中で折り返された秘密の一文を、デコードした値から検出する', () => {
    const serialized = JSON.stringify({ body: { ja: wrapped } });
    expect(found(secretLeaksInJson(serialized))).toBe(true);
  });

  it('整形された JSON（インデント付き）でも、入れ子・配列の中の文字列を検出する', () => {
    const serialized = JSON.stringify(
      { episodes: [{ id: 'x', body: { ja: `さきに\n${wrapped}\nあとに`, en: 'plain' } }] },
      null,
      2,
    );
    expect(found(secretLeaksInJson(serialized))).toBe(true);
  });

  it('生のテキストで見つかるものは、デコード後と二重に数えない', () => {
    const serialized = JSON.stringify({ body: segment.segment });
    const hits = secretLeaksInJson(serialized).filter(
      (l) => l.owner === segment.owner && l.segment === segment.segment,
    );
    expect(hits).toHaveLength(1);
  });

  it('秘密を含まない JSON は通す', () => {
    expect(secretLeaksInJson(JSON.stringify({ body: { ja: '朝の市。', en: 'Morning market.' } }))).toEqual([]);
  });

  it('JSON として読めないテキストは、生のテキストの照合だけを返す', () => {
    expect(found(secretLeaksInJson(`{ broken ${segment.segment}`))).toBe(true);
    expect(secretLeaksInJson('{ broken')).toEqual([]);
  });
});
