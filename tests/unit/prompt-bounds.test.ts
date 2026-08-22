import { describe, it, expect } from 'vitest';
import { PATCH_LIMITS, MEMORY_IMPORTANCE, TEXT_LIMITS } from '../../src/schemas/limits.js';
import { boundsLines, otherFatalRules, buildDiarySystemPrompt } from '../../src/diary/prompt.js';
import { loadCharacter } from '../../src/diary/context.js';
import type { Tick } from '../../src/schemas/tick.js';

/**
 * ゲートが落とせる上限は、すべてプロンプトに書かれていなければならない。
 *
 * バリデータが守っていてプロンプトが伝えていない上限は、厳格なゲートではなく罠になる。
 * モデルは指示に従ったのに1日を失う。
 *
 * このテストは PATCH_LIMITS のキーを走査するので、上限を足してプロンプトへ
 * 書き忘れると落ちる。プロンプト側の文面も定数から組み立てられているため、
 * 値を変えれば文面も追随する。
 */
describe('プロンプトは、ゲートが落とせる上限をすべて述べる', () => {
  const covered = new Set(boundsLines().map((line) => line.limit));

  for (const key of Object.keys(PATCH_LIMITS)) {
    it(`${key} に対応する説明がある`, () => {
      expect(covered.has(key)).toBe(true);
    });
  }

  it('説明文に実際の数値が埋め込まれている', () => {
    const text = boundsLines()
      .map((line) => line.text)
      .join('\n');

    expect(text).toContain(String(PATCH_LIMITS.relationshipDelta));
    expect(text).toContain(String(PATCH_LIMITS.relationshipsPerDay));
    expect(text).toContain(String(PATCH_LIMITS.traitDelta));
    expect(text).toContain(String(PATCH_LIMITS.beliefDelta));
    expect(text).toContain(String(PATCH_LIMITS.newMemories));
    expect(text).toContain(String(PATCH_LIMITS.newCanonFacts));
  });

  it('記憶の importance が「評価ではなく重み」だと説明されている', () => {
    const text = otherFatalRules().join('\n');
    expect(text).toContain(String(MEMORY_IMPORTANCE.min));
    expect(text).toContain(String(MEMORY_IMPORTANCE.max));
    // 5段階評価だと誤解させないための一文。JuryDiary が初日に日記を1本失った原因。
    expect(text).toMatch(/評価ではない/);
  });

  it('本文の文字数の下限と上限が書かれている', () => {
    const text = otherFatalRules().join('\n');
    expect(text).toContain(String(TEXT_LIMITS.diaryBodyMinJa));
    expect(text).toContain(String(TEXT_LIMITS.diaryBodyMaxJa));
  });

  it('破棄される違反と、切り詰められる違反が区別されている', () => {
    const lines = boundsLines();
    const relationship = lines.find((l) => l.limit === 'relationshipDelta');
    const concerns = lines.find((l) => l.limit === 'newConcerns');

    // 到達先が状態ファイルなら破棄、翌日のプロンプトだけなら切り詰め。
    expect(relationship?.text).toContain('破棄');
    expect(concerns?.text).toContain('切り詰め');
  });
});

describe('人物ごとのプロンプト', () => {
  const tick = {
    date: '2026-09-01',
    era: 'primordial',
    protagonist: 'uta',
  } as unknown as Tick;

  it('ウタには「書かない語り手」であることを伝える', () => {
    const context = {
      ...loadCharacter('uta'),
      tick,
      recentSummaries: [],
    };
    const prompt = buildDiarySystemPrompt(context);

    expect(prompt).toContain('文字を持たない');
    expect(prompt).toMatch(/「書く」/);
  });

  it('他の人物にはその指示を入れない', () => {
    const context = {
      ...loadCharacter('teo'),
      tick: { ...tick, era: 'guilds', protagonist: 'teo' } as unknown as Tick,
      recentSummaries: [],
    };
    const prompt = buildDiarySystemPrompt(context);

    expect(prompt).not.toContain('文字を持たない');
  });

  it('本人が知らない秘密をプロンプトへ渡さない', () => {
    for (const id of ['teo', 'riko', 'sevran', 'kaya', 'uta']) {
      const character = loadCharacter(id);
      const prompt = buildDiarySystemPrompt({
        ...character,
        tick: { ...tick, protagonist: id } as unknown as Tick,
        recentSummaries: [],
      });

      // 隠していることは本人が知っているので渡す。
      expect(prompt).toContain(character.profile.core.secret_hidden.trim().slice(0, 12));

      // 本人も知らないことは渡さない。渡せば、知らないはずのことを語り始める。
      const unknown = character.profile.core.secret_unknown_to_self.trim().slice(0, 20);
      expect(prompt).not.toContain(unknown);
    }
  });
});
