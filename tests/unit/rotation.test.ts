import { describe, it, expect } from 'vitest';
import { seededRandom, weightedPick } from '../../src/lib/random.js';
import { worldPath } from '../../src/lib/paths.js';
import { readYaml } from '../../src/lib/storage.js';
import { RotationFileSchema, CardDeckFileSchema, ERA_PROTAGONIST } from '../../src/schemas/world.js';

describe('ローテーション', () => {
  const rotation = readYaml(worldPath('canon/rotation.yaml'), RotationFileSchema);

  it('5時代を1回ずつ含む', () => {
    expect(new Set(rotation.order).size).toBe(5);
  });

  it('ギルドから始まる', () => {
    expect(rotation.order[0]).toBe('guilds');
  });

  it('各時代に主人公が対応している', () => {
    for (const era of rotation.order) {
      expect(ERA_PROTAGONIST[era]).toBeTruthy();
    }
  });

  it('30日運転すると各主人公が6本書く', () => {
    const counts = new Map<string, number>();
    for (let day = 0; day < 30; day += 1) {
      const era = rotation.order[day % rotation.order.length];
      if (!era) continue;
      const who = ERA_PROTAGONIST[era];
      counts.set(who, (counts.get(who) ?? 0) + 1);
    }
    expect([...counts.values()]).toEqual([6, 6, 6, 6, 6]);
  });
});

describe('カードの抽選', () => {
  it('同じ日は同じカードを引く', () => {
    // 失敗した日をやり直すとき、カードまで変わると
    // 「その日に何が起きるはずだったか」が失われる。
    const deck = readYaml(worldPath('cards/guilds.yaml'), CardDeckFileSchema);

    const first = weightedPick(deck.cards, seededRandom('2026-09-01:guilds'));
    const second = weightedPick(deck.cards, seededRandom('2026-09-01:guilds'));

    expect(first.id).toBe(second.id);
  });

  it('日が変われば引くカードも変わりうる', () => {
    const deck = readYaml(worldPath('cards/guilds.yaml'), CardDeckFileSchema);
    const drawn = new Set<string>();

    for (let day = 1; day <= 40; day += 1) {
      const date = `2026-09-${String(day).padStart(2, '0')}`;
      drawn.add(weightedPick(deck.cards, seededRandom(`${date}:guilds`)).id);
    }

    // 40日で少なくとも数種類は出る。1枚に固着していたら偏りの設計ミス。
    expect(drawn.size).toBeGreaterThan(3);
  });

  it('重みが抽選に反映される', () => {
    const items = [
      { id: 'rare', weight: 1 },
      { id: 'common', weight: 9 },
    ];
    let common = 0;

    for (let i = 0; i < 1000; i += 1) {
      if (weightedPick(items, seededRandom(`seed-${i}`)).id === 'common') common += 1;
    }

    expect(common).toBeGreaterThan(800);
    expect(common).toBeLessThan(980);
  });
});
