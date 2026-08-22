import {
  PATCH_LIMITS,
  MEMORY_IMPORTANCE,
  TEXT_LIMITS,
  UNIT_RANGE,
} from '../schemas/limits.js';
import type { DiaryResponse } from '../schemas/patch.js';
import type { CurrentState, Relationships } from '../schemas/character.js';

export type GateResult =
  | { ok: true; response: DiaryResponse; truncated: string[] }
  | { ok: false; violations: string[] };

const EPSILON = 1e-9;

function overBy(value: number, limit: number): boolean {
  return Math.abs(value) > limit + EPSILON;
}

/**
 * 構造ゲート。
 *
 * 上限を超えた値はクランプせず、その日を破棄する。
 *
 * クランプは壊れたプロンプトを「それらしく見える状態」の裏に隠す。欠けた1日は目に見える。
 * 破棄（fatal）と切り詰め（truncate）の線引きは重要度ではなく到達先で決まる——
 * 状態ファイルか描画に届くものは破棄、翌日のプロンプトに載るだけのものは切り詰め。
 */
export function gate(
  response: DiaryResponse,
  state: CurrentState,
  relationships: Relationships,
  selfId: string,
): GateResult {
  const violations: string[] = [];
  const truncated: string[] = [];

  // ── 関係 ────────────────────────────────────────────────
  const known = new Set(relationships.people.map((p) => p.id));
  const patched = new Set<string>();

  if (response.relationship_patches.length > PATCH_LIMITS.relationshipsPerDay) {
    violations.push(
      `関係の更新が ${response.relationship_patches.length} 件（上限 ${PATCH_LIMITS.relationshipsPerDay}）`,
    );
  }

  for (const patch of response.relationship_patches) {
    if (patch.id === selfId) {
      violations.push('自分自身を関係先にしている');
      continue;
    }
    if (!known.has(patch.id)) {
      violations.push(`関係先 ${patch.id} が relationships.yaml に存在しない`);
      continue;
    }
    if (patched.has(patch.id)) {
      violations.push(`${patch.id} を同じ日に2回更新している`);
      continue;
    }
    patched.add(patch.id);

    if (overBy(patch.trust_delta, PATCH_LIMITS.relationshipDelta)) {
      violations.push(
        `${patch.id} の trust 変化が ${patch.trust_delta}（上限 ±${PATCH_LIMITS.relationshipDelta}）`,
      );
    }
    if (overBy(patch.wariness_delta, PATCH_LIMITS.relationshipDelta)) {
      violations.push(
        `${patch.id} の wariness 変化が ${patch.wariness_delta}（上限 ±${PATCH_LIMITS.relationshipDelta}）`,
      );
    }
  }

  // ── 特性 ────────────────────────────────────────────────
  if (response.trait_patches.length > PATCH_LIMITS.traitsPerDay) {
    violations.push(
      `特性の更新が ${response.trait_patches.length} 件（上限 ${PATCH_LIMITS.traitsPerDay}）`,
    );
  }
  for (const patch of response.trait_patches) {
    if (!(patch.key in state.traits)) {
      violations.push(`特性 ${patch.key} が current-state.yaml に存在しない`);
      continue;
    }
    if (overBy(patch.delta, PATCH_LIMITS.traitDelta)) {
      violations.push(
        `特性 ${patch.key} の変化が ${patch.delta}（上限 ±${PATCH_LIMITS.traitDelta}）`,
      );
    }
  }

  // ── 信念 ────────────────────────────────────────────────
  if (response.belief_patches.length > PATCH_LIMITS.beliefsPerDay) {
    violations.push(
      `信念の更新が ${response.belief_patches.length} 件（上限 ${PATCH_LIMITS.beliefsPerDay}）`,
    );
  }
  for (const patch of response.belief_patches) {
    if (!(patch.key in state.beliefs)) {
      violations.push(`信念 ${patch.key} が current-state.yaml に存在しない`);
      continue;
    }
    if (overBy(patch.delta, PATCH_LIMITS.beliefDelta)) {
      violations.push(
        `信念 ${patch.key} の変化が ${patch.delta}（上限 ±${PATCH_LIMITS.beliefDelta}）`,
      );
    }
  }

  // ── 数えているもの ──────────────────────────────────────
  for (const patch of response.counter_patches) {
    if (!state.counters || !(patch.key in state.counters)) {
      violations.push(`数えているもの ${patch.key} が current-state.yaml に存在しない`);
      continue;
    }
    if (patch.delta < 0) {
      violations.push(`${patch.key} を ${patch.delta} 減らそうとしている（減らせない）`);
      continue;
    }
    if (patch.delta > PATCH_LIMITS.counterDelta) {
      violations.push(
        `${patch.key} の増分が ${patch.delta}（上限 +${PATCH_LIMITS.counterDelta}）`,
      );
    }
  }

  // ── 記憶 ────────────────────────────────────────────────
  if (response.memory_candidate) {
    const { importance } = response.memory_candidate;
    if (
      importance < MEMORY_IMPORTANCE.min - EPSILON ||
      importance > MEMORY_IMPORTANCE.max + EPSILON
    ) {
      violations.push(
        `記憶の importance が ${importance}（範囲 ${MEMORY_IMPORTANCE.min}〜${MEMORY_IMPORTANCE.max}）`,
      );
    }
  }

  // ── 本文 ────────────────────────────────────────────────
  const bodyLength = [...response.body_ja].length;
  if (bodyLength < TEXT_LIMITS.diaryBodyMinJa) {
    violations.push(
      `本文が ${bodyLength} 文字（下限 ${TEXT_LIMITS.diaryBodyMinJa}）`,
    );
  }
  if (bodyLength > TEXT_LIMITS.diaryBodyMaxJa) {
    violations.push(
      `本文が ${bodyLength} 文字（上限 ${TEXT_LIMITS.diaryBodyMaxJa}）`,
    );
  }
  const titleLength = [...response.title].length;
  if (titleLength < TEXT_LIMITS.titleMin || titleLength > TEXT_LIMITS.titleMax) {
    violations.push(
      `タイトルが ${titleLength} 文字（${TEXT_LIMITS.titleMin}〜${TEXT_LIMITS.titleMax}）`,
    );
  }

  if (violations.length) return { ok: false, violations };

  // ── 切り詰め（破棄しない） ──────────────────────────────
  const gated: DiaryResponse = { ...response };

  if (gated.new_concerns.length > PATCH_LIMITS.newConcerns) {
    truncated.push(
      `新しい懸念 ${gated.new_concerns.length} 件のうち ${gated.new_concerns.length - PATCH_LIMITS.newConcerns} 件を切り詰め`,
    );
    gated.new_concerns = gated.new_concerns.slice(0, PATCH_LIMITS.newConcerns);
  }
  if (gated.new_unresolved_thoughts.length > PATCH_LIMITS.newUnresolvedThoughts) {
    truncated.push(
      `新しい考え ${gated.new_unresolved_thoughts.length} 件のうち ${gated.new_unresolved_thoughts.length - PATCH_LIMITS.newUnresolvedThoughts} 件を切り詰め`,
    );
    gated.new_unresolved_thoughts = gated.new_unresolved_thoughts.slice(
      0,
      PATCH_LIMITS.newUnresolvedThoughts,
    );
  }

  return { ok: true, response: gated, truncated };
}

/** 0.0〜1.0 に収める。差分を適用したあとの着地点にだけ使う。 */
export function clampUnit(value: number): number {
  return Math.min(UNIT_RANGE.max, Math.max(UNIT_RANGE.min, value));
}

/** 浮動小数の誤差が状態ファイルに溜まらないよう、小数第3位で丸める。 */
export function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
