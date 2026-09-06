import { describe, it, expect } from 'vitest';
import {
  NARRATIVE_MOVES,
  MOVES_PER_SEASON,
  movesFromIds,
  selectNarrativeMoves,
  type NarrativeSituation,
} from '../../src/season/narrative-calibration.js';
import { buildSeasonContext } from '../../src/season/context.js';
import { seededRandom, weightedPick } from '../../src/lib/random.js';
import { readYaml } from '../../src/lib/storage.js';
import { worldPath } from '../../src/lib/paths.js';
import { CardDeckFileSchema } from '../../src/schemas/world.js';
import { EPISODES_PER_SEASON } from '../../src/schemas/season.js';

/** 5人とも周囲に2人いて、季のあいだに節目がいくつか来る、という普通の状況。 */
const situation: NarrativeSituation = { peopleCount: 2, observanceCount: 3 };

const ids = (moves: ReadonlyArray<{ id: string }>) => moves.map((m) => m.id);

describe('Narrative Calibration の選択', () => {
  it('同じ seed からは同じ許可が出る', () => {
    // イベントカードと同じ約束。やり直したときに「どういう季だったか」が変わっては困る。
    const first = selectNarrativeMoves('season-1:guilds', situation);
    const second = selectNarrativeMoves('season-1:guilds', situation);
    expect(ids(first)).toEqual(ids(second));
  });

  it('1季に配るのは2〜3個', () => {
    for (let season = 1; season <= 12; season += 1) {
      for (const era of ['guilds', 'silent', 'convergence', 'fracture', 'primordial']) {
        const moves = selectNarrativeMoves(`season-${season}:${era}`, situation);
        expect(moves.length).toBeGreaterThanOrEqual(MOVES_PER_SEASON.min);
        expect(moves.length).toBeLessThanOrEqual(MOVES_PER_SEASON.max);
      }
    }
  });

  it('カタログ全部は配らない（チェックリストにしない）', () => {
    expect(NARRATIVE_MOVES.length).toBeGreaterThan(MOVES_PER_SEASON.max);
    const moves = selectNarrativeMoves('season-1:guilds', situation);
    expect(moves.length).toBeLessThan(NARRATIVE_MOVES.length);
  });

  it('seed が違えば、いつも同じ集合にはならない', () => {
    // 全季が同じ許可で回るなら、それはカタログではなく1本の追加ルールである。
    const sets = new Set<string>();
    for (let season = 1; season <= 20; season += 1) {
      sets.add(ids(selectNarrativeMoves(`season-${season}:guilds`, situation)).sort().join(','));
    }
    expect(sets.size).toBeGreaterThan(1);
  });

  it('id はカタログにあるものだけを返す', () => {
    const known = new Set(NARRATIVE_MOVES.map((m) => m.id));
    for (const move of selectNarrativeMoves('season-3:silent', situation)) {
      expect(known.has(move.id)).toBe(true);
    }
  });

  it('直前の季と丸ごと同じ集合は避ける', () => {
    const seed = 'season-2:guilds';
    const chosen = selectNarrativeMoves(seed, situation);
    // 前の季が「今回選ばれるはずの集合」だったことにして、同じものが出ないか見る。
    const again = selectNarrativeMoves(seed, situation, ids(chosen));
    expect(ids(again).sort().join(',')).not.toBe(ids(chosen).sort().join(','));
    expect(again.length).toBe(chosen.length);
  });

  it('前の季と一部だけ重なるのは許す', () => {
    // 同じ許可が続くこと自体は構わない。避けるのは二季続けて丸ごと同じ場合だけ。
    const chosen = selectNarrativeMoves('season-2:silent', situation);
    const withOverlap = selectNarrativeMoves('season-2:silent', situation, [
      ids(chosen)[0] as string,
    ]);
    expect(ids(withOverlap)).toEqual(ids(chosen));
  });

  it('効かない許可は無理に発動させない', () => {
    // 相手のいない摩擦を許可しても、モデルは辻褄合わせに人物を発明するだけである。
    const alone: NarrativeSituation = { peopleCount: 0, observanceCount: 0 };
    const moves = selectNarrativeMoves('season-1:primordial', alone);
    expect(ids(moves)).not.toContain('relationship_friction');
    expect(ids(moves)).not.toContain('offstage_consequence');
    expect(ids(moves)).not.toContain('causal_sidewind');
    expect(moves.length).toBeGreaterThanOrEqual(MOVES_PER_SEASON.min);
  });

  it('記録された id から許可を引き直せる（知らない id は落とす）', () => {
    const moves = movesFromIds(['partial_resolution', 'いつか消えた許可']);
    expect(ids(moves)).toEqual(['partial_resolution']);
  });

  it('許可は「してよい」の形で書かれている（義務にしない）', () => {
    for (const move of NARRATIVE_MOVES) {
      expect(move.permission).toMatch(/よい|なくてよい/);
    }
  });
});

describe('季の材料への副作用', () => {
  const context = buildSeasonContext(1, 'guilds', 'teo');

  it('計画の材料に、この季の許可が入っている', () => {
    expect(context.narrativeMoves.length).toBeGreaterThanOrEqual(MOVES_PER_SEASON.min);
    expect(context.narrativeMoves.length).toBeLessThanOrEqual(MOVES_PER_SEASON.max);
  });

  it('イベントカードの抽選を動かさない', () => {
    // 許可はカードとは別の乱数の流れから引く。同じ流れを使うと、カタログを1個
    // 足しただけで過去の季の引き札が変わり、「その季に何が起きるはずだったか」が失われる。
    const deck = readYaml(worldPath('cards/guilds.yaml'), CardDeckFileSchema);
    const random = seededRandom('season-1:guilds');
    const expected: string[] = [];
    const drawn = new Set<string>();
    for (let attempt = 0; attempt < 40 && expected.length < EPISODES_PER_SEASON + 2; attempt += 1) {
      const card = weightedPick(deck.cards, random);
      if (drawn.has(card.id)) continue;
      drawn.add(card.id);
      expected.push(card.id);
    }

    expect(context.cards.map((c) => c.id)).toEqual(expected);
  });
});
