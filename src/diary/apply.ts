import { PATCH_LIMITS } from '../schemas/limits.js';
import type { DiaryResponse } from '../schemas/patch.js';
import type {
  Canon,
  CurrentState,
  Memories,
  Relationships,
} from '../schemas/character.js';
import type { DiaryEvent } from '../schemas/diary.js';
import { clampUnit, round } from './gate.js';

export type ApplyResult = {
  state: CurrentState;
  relationships: Relationships;
  memories: Memories;
  canon: Canon;
  applied: DiaryEvent['applied'];
};

/**
 * 差分を状態へ適用する。
 *
 * ゲートを通ったものだけがここへ来る。適用後の着地点だけ 0.0〜1.0 に収める
 * （0.02 の人物に −0.05 を当てたら 0 で止まる、というだけの話であり、
 * 上限違反を隠すクランプとは別物）。
 */
export function applyPatches(
  response: DiaryResponse,
  current: {
    state: CurrentState;
    relationships: Relationships;
    memories: Memories;
    canon: Canon;
  },
  date: string,
): ApplyResult {
  const state: CurrentState = structuredClone(current.state);
  const relationships: Relationships = structuredClone(current.relationships);
  const memories: Memories = structuredClone(current.memories);
  const canon: Canon = structuredClone(current.canon);

  const applied: DiaryEvent['applied'] = {
    mood: [state.mood, response.mood],
    immediate_goal: [state.immediate_goal, response.immediate_goal],
    doubt: [state.doubt, response.doubt],
    relationships: [],
    traits: [],
    beliefs: [],
    concerns_added: [],
    thoughts_added: [],
    memory_promoted: null,
    canon_added: null,
  };

  state.mood = response.mood;
  state.immediate_goal = response.immediate_goal;
  state.doubt = response.doubt;
  state.updated_at = date;

  for (const patch of response.relationship_patches) {
    const person = relationships.people.find((p) => p.id === patch.id);
    if (!person) continue;
    const from = { trust: person.trust, wariness: person.wariness };
    person.trust = round(clampUnit(person.trust + patch.trust_delta));
    person.wariness = round(clampUnit(person.wariness + patch.wariness_delta));
    applied.relationships.push({
      id: patch.id,
      trust: [from.trust, person.trust],
      wariness: [from.wariness, person.wariness],
      note: patch.note,
    });
  }

  for (const patch of response.trait_patches) {
    const from = state.traits[patch.key];
    if (from === undefined) continue;
    const to = round(clampUnit(from + patch.delta));
    state.traits[patch.key] = to;
    applied.traits.push({ key: patch.key, from, to });
  }

  for (const patch of response.belief_patches) {
    const from = state.beliefs[patch.key];
    if (from === undefined) continue;
    const to = round(clampUnit(from + patch.delta));
    state.beliefs[patch.key] = to;
    applied.beliefs.push({ key: patch.key, from, to });
  }

  for (const concern of response.new_concerns) {
    if (!state.concerns.includes(concern)) {
      state.concerns.push(concern);
      applied.concerns_added.push(concern);
    }
  }
  for (const thought of response.new_unresolved_thoughts) {
    if (!state.unresolved_thoughts.includes(thought)) {
      state.unresolved_thoughts.push(thought);
      applied.thoughts_added.push(thought);
    }
  }

  if (response.memory_candidate) {
    memories.memories.push({
      id: `${date}-${memories.memories.length + 1}`,
      summary: response.memory_candidate.summary,
      importance: response.memory_candidate.importance,
      formed_on: date,
    });
    applied.memory_promoted = response.memory_candidate.summary;
  }

  if (response.canon_candidate) {
    // canon は追記のみ。同じ id が既にあれば足さない。
    const exists = canon.facts.some(
      (f) => f.id === response.canon_candidate?.id,
    );
    if (!exists) {
      canon.facts.push({
        id: response.canon_candidate.id,
        fact: response.canon_candidate.fact,
        added_on: date,
      });
      applied.canon_added = response.canon_candidate.fact;
    }
  }

  return { state, relationships, memories, canon, applied };
}

/**
 * 懸念と抱えている考えが際限なく伸びないよう、古いものから落とす。
 * これは人格の制約ではなく、プロンプトの長さの制約である。
 */
export function trimWorkingSets(state: CurrentState): CurrentState {
  const cap = PATCH_LIMITS.newConcerns * 4;
  const trimmed = structuredClone(state);
  if (trimmed.concerns.length > cap) {
    trimmed.concerns = trimmed.concerns.slice(-cap);
  }
  if (trimmed.unresolved_thoughts.length > cap) {
    trimmed.unresolved_thoughts = trimmed.unresolved_thoughts.slice(-cap);
  }
  return trimmed;
}
