import { describe, expect, it } from 'vitest';
import { applyPatches, trimWorkingSets } from '../../src/diary/apply.js';
import { rollBack, memoriesBefore, canonBefore, fileDate } from '../../src/diary/as-of.js';
import type { DiaryResponse } from '../../src/schemas/patch.js';
import type {
  Canon,
  CurrentState,
  Memories,
  Relationships,
} from '../../src/schemas/character.js';
import type { DiaryEvent } from '../../src/schemas/diary.js';

/**
 * 過去の日を補うときの「その日の朝の人物」（docs/diary.md §9）。
 *
 * 実データは日々動くので読まない。小さな人物をここで組み、applyPatches で
 * 実際に日を進めてから、rollBack で戻したものが進める前と一致するかを見る。
 */

const bilingual = (text: string) => ({ ja: text, en: text });

const baseState = (): CurrentState => ({
  id: 'sevran',
  updated_at: '2026-09-03',
  mood: '朝の気分',
  immediate_goal: '朝の目的',
  doubt: '朝の迷い',
  concerns: ['稼働前からの懸念'],
  unresolved_thoughts: ['稼働前からの考え'],
  traits: { diligence: 0.8, guilt: 0.6 },
  beliefs: { 記録は裏切らない: 0.7 },
  habits: ['頁の端を揃える'],
  counters: { pages: 10 },
});

const baseRelationships = (): Relationships => ({
  id: 'sevran',
  people: [
    {
      id: 'milte',
      name: bilingual('ミルテ'),
      relation: bilingual('同僚'),
      trust: 0.9,
      wariness: 0.0,
      summary: bilingual('消えた同僚'),
      intro: bilingual('消えた同僚'),
    },
    {
      id: 'hum',
      name: bilingual('フム'),
      relation: bilingual('同居人'),
      trust: 0.4,
      wariness: 0.5,
      summary: bilingual('影の同居人'),
      intro: bilingual('影の同居人'),
    },
  ],
});

const emptyMemories = (): Memories => ({ id: 'sevran', memories: [] });

const baseCanon = (): Canon => ({
  id: 'sevran',
  formative_events: [
    { id: 'a', fact: bilingual('土台1') },
    { id: 'b', fact: bilingual('土台2') },
    { id: 'c', fact: bilingual('土台3') },
  ],
  facts: [{ id: 'seed', fact: bilingual('日付のない事実') }],
});

/** その日の日記が返したことにする差分。 */
function response(tag: string, overrides: Partial<DiaryResponse> = {}): DiaryResponse {
  return {
    perception: `${tag}の認識`,
    title_ja: `${tag}の題`,
    title_en: `${tag} title`,
    body_ja: `${tag}の本文`,
    body_en: `${tag} body`,
    quote_ja: `${tag}の引用`,
    quote_en: `${tag} quote`,
    mood_ja: `${tag}の気分`,
    mood_en: `${tag} mood`,
    immediate_goal: `${tag}の目的`,
    doubt: `${tag}の迷い`,
    relationship_patches: [],
    trait_patches: [],
    belief_patches: [],
    new_concerns: [],
    new_unresolved_thoughts: [],
    counter_patches: [],
    memory_candidate: null,
    canon_candidate: null,
    rare_expression_used: false,
    ...overrides,
  };
}

/** 日記を1本書いたことにして、状態を進め、events/ に残る形を返す。 */
function advance(
  world: { state: CurrentState; relationships: Relationships; memories: Memories; canon: Canon },
  date: string,
  diary: DiaryResponse,
): DiaryEvent {
  const result = applyPatches(diary, world, date);
  world.state = trimWorkingSets(result.state);
  world.relationships = result.relationships;
  world.memories = result.memories;
  world.canon = result.canon;
  return {
    date,
    protagonist: 'sevran',
    applied: result.applied,
    truncated: [],
    generation: { model: 'test', prompt_version: 'test', generated_at: `${date}T00:00:00Z` },
  };
}

describe('rollBack — 後の日を戻して、その日の朝へ', () => {
  it('後の日に動いた気分・関係・特性・信念・数を、その日の朝の値へ戻す', () => {
    const world = {
      state: baseState(),
      relationships: baseRelationships(),
      memories: emptyMemories(),
      canon: baseCanon(),
    };

    const earlier = [
      advance(world, '2026-09-13', response('13日', {
        trait_patches: [{ key: 'guilt', delta: 0.01 }],
        relationship_patches: [{ id: 'milte', trust_delta: 0.03, wariness_delta: 0, note: 'x' }],
      })),
    ];
    // 補う日（18日）の朝の人物。ここへ戻れば正しい。
    const morning = structuredClone({ state: world.state, relationships: world.relationships });

    const later = [
      advance(world, '2026-09-23', response('23日', {
        trait_patches: [{ key: 'diligence', delta: 0.01 }, { key: 'guilt', delta: 0.02 }],
        belief_patches: [{ key: '記録は裏切らない', delta: -0.05 }],
        relationship_patches: [{ id: 'milte', trust_delta: -0.02, wariness_delta: 0.01, note: 'y' }],
        counter_patches: [{ key: 'pages', delta: 2 }],
      })),
      advance(world, '2026-09-28', response('28日', {
        relationship_patches: [{ id: 'hum', trust_delta: 0.05, wariness_delta: -0.05, note: 'z' }],
        trait_patches: [{ key: 'guilt', delta: 0.01 }],
      })),
    ];

    const back = rollBack({ state: world.state, relationships: world.relationships }, earlier, later);

    expect(back.state.mood).toBe(morning.state.mood);
    expect(back.state.immediate_goal).toBe(morning.state.immediate_goal);
    expect(back.state.doubt).toBe(morning.state.doubt);
    expect(back.state.traits).toEqual(morning.state.traits);
    expect(back.state.beliefs).toEqual(morning.state.beliefs);
    expect(back.state.counters).toEqual(morning.state.counters);
    expect(back.relationships).toEqual(morning.relationships);
    expect(back.state.updated_at).toBe('2026-09-13');
  });

  it('後の日に足された懸念と考えを除き、上限に押し出されていた前の日のぶんを拾い戻す', () => {
    const world = {
      state: baseState(),
      relationships: baseRelationships(),
      memories: emptyMemories(),
      canon: baseCanon(),
    };
    const concerns = (tag: string) => [`${tag}の懸念A`, `${tag}の懸念B`];

    const earlier = ['09-03', '09-08', '09-13'].map((d) =>
      advance(world, `2026-${d}`, response(d, { new_concerns: concerns(d) })),
    );
    const morning = structuredClone(world.state);

    // 後の日が懸念を積み、上限（8件）から前の日のぶんを押し出す。
    const later = ['09-23', '09-28'].map((d) =>
      advance(world, `2026-${d}`, response(d, { new_concerns: concerns(d) })),
    );
    expect(world.state.concerns).not.toContain('09-03の懸念A');

    const back = rollBack({ state: world.state, relationships: world.relationships }, earlier, later);

    // 日記が足したものは、押し出されていても拾い戻せる。
    expect(back.state.concerns).toEqual(
      morning.concerns.filter((c) => c !== '稼働前からの懸念'),
    );
    // 稼働前から持っていた項目は events/ に根拠が無いので、押し出されていれば戻らない
    // （as-of.ts に書いた既知の限界）。押し出されていなければ残る。
    expect(back.state.concerns).not.toContain('稼働前からの懸念');
    expect(back.state.unresolved_thoughts).toEqual(morning.unresolved_thoughts);
  });

  it('後の日が無ければ、いまの状態をそのまま返す', () => {
    const state = baseState();
    const relationships = baseRelationships();
    const back = rollBack({ state, relationships }, [], []);
    expect(back.state).toEqual(state);
    expect(back.relationships).toEqual(relationships);
  });

  it('いまの状態を書き換えない（純粋関数）', () => {
    const world = {
      state: baseState(),
      relationships: baseRelationships(),
      memories: emptyMemories(),
      canon: baseCanon(),
    };
    const later = [advance(world, '2026-09-23', response('23日'))];
    const snapshot = structuredClone(world.state);
    rollBack({ state: world.state, relationships: world.relationships }, [], later);
    expect(world.state).toEqual(snapshot);
  });
});

describe('その日より前に得たものだけを渡す', () => {
  it('記憶は formed_on がその日より前のものだけ', () => {
    const memories: Memories = {
      id: 'sevran',
      memories: [
        { id: '1', summary: '前', importance: 0.7, formed_on: '2026-09-13' },
        { id: '2', summary: '後', importance: 0.9, formed_on: '2026-09-23' },
      ],
    };
    expect(memoriesBefore(memories, '2026-09-18').memories.map((m) => m.summary)).toEqual(['前']);
  });

  it('人生の事実は、その日より前に加わったものと、日付のない土台', () => {
    const canon = baseCanon();
    canon.facts.push(
      { id: 'before', fact: bilingual('前'), added_on: '2026-09-13' },
      { id: 'after', fact: bilingual('後'), added_on: '2026-09-23' },
    );
    const kept = canonBefore(canon, '2026-09-18');
    expect(kept.facts.map((f) => f.id)).toEqual(['seed', 'before']);
    expect(kept.formative_events).toHaveLength(3);
  });

  it('ファイル名から日付を取る', () => {
    expect(fileDate('/x/characters/sevran/entries/2026/09/2026-09-23.json')).toBe('2026-09-23');
  });
});
