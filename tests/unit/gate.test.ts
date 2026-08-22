import { describe, it, expect } from 'vitest';
import { gate } from '../../src/diary/gate.js';
import { applyPatches } from '../../src/diary/apply.js';
import { loadCharacter } from '../../src/diary/context.js';
import { PATCH_LIMITS, TEXT_LIMITS } from '../../src/schemas/limits.js';
import type { DiaryResponse } from '../../src/schemas/patch.js';

const character = loadCharacter('teo');

function response(overrides: Partial<DiaryResponse> = {}): DiaryResponse {
  return {
    perception: '座金が逆だった。誰も触れなかった。',
    title: '座金は逆だ',
    body_ja: 'あ'.repeat(TEXT_LIMITS.diaryBodyMinJa + 10),
    body_en: 'x'.repeat(300),
    quote: '別に、悔しくはない。',
    mood: '苛立ち',
    immediate_goal: '月末の仮銘審査',
    doubt: '報告すべきか',
    relationship_patches: [],
    trait_patches: [],
    belief_patches: [],
    new_concerns: [],
    new_unresolved_thoughts: [],
    memory_candidate: null,
    canon_candidate: null,
    rare_expression_used: false,
    ...overrides,
  };
}

const run = (r: DiaryResponse) =>
  gate(r, character.state, character.relationships, 'teo');

describe('構造ゲート', () => {
  it('妥当な応答を通す', () => {
    const result = run(response());
    expect(result.ok).toBe(true);
  });

  it('関係の変化が上限を超えたら、その日を破棄する', () => {
    const result = run(
      response({
        relationship_patches: [
          {
            id: 'vallen',
            trust_delta: PATCH_LIMITS.relationshipDelta * 2,
            wariness_delta: 0,
            note: '推薦状の話をされなかった',
          },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations[0]).toContain('trust');
  });

  it('上限ちょうどは通す', () => {
    const result = run(
      response({
        relationship_patches: [
          {
            id: 'vallen',
            trust_delta: -PATCH_LIMITS.relationshipDelta,
            wariness_delta: PATCH_LIMITS.relationshipDelta,
            note: '境界値',
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('存在しない人物を関係先にできない', () => {
    const result = run(
      response({
        relationship_patches: [
          { id: 'garon', trust_delta: 0.01, wariness_delta: 0, note: '別の時代の人物' },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations[0]).toContain('garon');
  });

  it('自分自身を関係先にできない', () => {
    const result = run(
      response({
        relationship_patches: [
          { id: 'teo', trust_delta: 0.01, wariness_delta: 0, note: '自分' },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations[0]).toContain('自分自身');
  });

  it('同じ人物を1日に2回更新できない', () => {
    const result = run(
      response({
        relationship_patches: [
          { id: 'lowe', trust_delta: 0.05, wariness_delta: 0, note: '朝' },
          { id: 'lowe', trust_delta: 0.05, wariness_delta: 0, note: '夜' },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.some((v) => v.includes('2回'))).toBe(true);
  });

  it('記憶の importance が範囲外なら破棄する（5段階評価との取り違え）', () => {
    const result = run(
      response({
        memory_candidate: { summary: '師匠が推薦状の話をしなかった', importance: 2 },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations[0]).toContain('importance');
  });

  it('本文が短すぎたら破棄する', () => {
    const result = run(response({ body_ja: '短い。' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations[0]).toContain('本文');
  });

  it('存在しない特性は更新できない', () => {
    const result = run(
      response({ trait_patches: [{ key: 'nonexistent', delta: 0.01 }] }),
    );
    expect(result.ok).toBe(false);
  });

  it('懸念の超過は破棄ではなく切り詰め', () => {
    const result = run(
      response({
        new_concerns: ['A', 'B', 'C', 'D'],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.new_concerns).toHaveLength(PATCH_LIMITS.newConcerns);
    // 黙って捨てない
    expect(result.truncated).toHaveLength(1);
    expect(result.truncated[0]).toContain('切り詰め');
  });

  it('違反があった日は状態を一切変更しない', () => {
    const before = structuredClone(character.state);
    const result = run(
      response({
        relationship_patches: [
          { id: 'vallen', trust_delta: 0.9, wariness_delta: 0, note: '過大' },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    expect(character.state).toEqual(before);
  });
});

describe('差分の適用', () => {
  it('着地点を 0.0〜1.0 に収める', () => {
    const state = structuredClone(character.state);
    state.traits.pride = 0.02;

    const result = applyPatches(
      response({ trait_patches: [{ key: 'pride', delta: -0.05 }] }),
      {
        state,
        relationships: character.relationships,
        memories: character.memories,
        canon: character.canon,
      },
      '2026-09-01',
    );

    expect(result.state.traits.pride).toBe(0);
  });

  it('浮動小数の誤差を溜めない', () => {
    const state = structuredClone(character.state);
    state.traits.pride = 0.1;

    const result = applyPatches(
      response({ trait_patches: [{ key: 'pride', delta: 0.05 }] }),
      {
        state,
        relationships: character.relationships,
        memories: character.memories,
        canon: character.canon,
      },
      '2026-09-01',
    );

    expect(result.state.traits.pride).toBe(0.15);
  });

  it('canon は追記のみで、既存を書き換えない', () => {
    const before = character.canon.formative_events.length;
    const result = applyPatches(
      response({
        canon_candidate: { id: 'new-fact', fact: '工房通りに新しい店ができた' },
      }),
      {
        state: character.state,
        relationships: character.relationships,
        memories: character.memories,
        canon: character.canon,
      },
      '2026-09-01',
    );

    expect(result.canon.formative_events).toHaveLength(before);
    expect(result.canon.facts).toHaveLength(character.canon.facts.length + 1);
  });

  it('何が動いたかを記録に残す', () => {
    const result = applyPatches(
      response({
        relationship_patches: [
          { id: 'vallen', trust_delta: -0.05, wariness_delta: 0.05, note: '推薦状の話がなかった' },
        ],
      }),
      {
        state: character.state,
        relationships: character.relationships,
        memories: character.memories,
        canon: character.canon,
      },
      '2026-09-01',
    );

    expect(result.applied.relationships[0]).toMatchObject({
      id: 'vallen',
      trust: [0.7, 0.65],
      wariness: [0.2, 0.25],
    });
  });
});
