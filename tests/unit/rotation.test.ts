import { describe, it, expect } from 'vitest';
import { seededRandom, weightedPick } from '../../src/lib/random.js';
import { turnFor, seasonStartDate, today } from '../../src/lib/rotation.js';
import { worldPath } from '../../src/lib/paths.js';
import { readYaml } from '../../src/lib/storage.js';
import {
  RotationFileSchema,
  CardDeckFileSchema,
  ERA_PROTAGONIST,
} from '../../src/schemas/world.js';
import { DAYS_PER_SEASON, EPISODES_PER_SEASON } from '../../src/schemas/season.js';

const rotation = readYaml(worldPath('canon/rotation.yaml'), RotationFileSchema);

describe('ローテーション', () => {
  it('5時代を1回ずつ含む', () => {
    expect(new Set(rotation.order).size).toBe(5);
  });

  it('ギルドから始まる', () => {
    expect(rotation.order[0]).toBe('guilds');
  });

  it('1季は25日（5時代 × 5話）', () => {
    expect(DAYS_PER_SEASON).toBe(rotation.order.length * EPISODES_PER_SEASON);
  });
});

describe('季と話の割り当て', () => {
  const start = rotation.start_date as string;

  const dayAfter = (offset: number): string =>
    new Date(Date.parse(`${start}T00:00:00Z`) + offset * 86_400_000)
      .toISOString()
      .slice(0, 10);

  it('初日はギルド／テオの第1季 第1話', () => {
    expect(turnFor(start)).toMatchObject({
      era: 'guilds',
      protagonist: 'teo',
      season: 1,
      episode: 1,
    });
  });

  it('最初の5日で5時代が一巡し、どれも第1話', () => {
    for (let offset = 0; offset < 5; offset += 1) {
      const turn = turnFor(dayAfter(offset));
      expect(turn.era).toBe(rotation.order[offset]);
      expect(turn.episode).toBe(1);
      expect(turn.season).toBe(1);
    }
  });

  it('6日目はギルドに戻り、第2話へ進む', () => {
    expect(turnFor(dayAfter(5))).toMatchObject({
      era: 'guilds',
      season: 1,
      episode: 2,
    });
  });

  it('25日目は原初の第5話で、第1季が終わる', () => {
    expect(turnFor(dayAfter(DAYS_PER_SEASON - 1))).toMatchObject({
      era: 'primordial',
      season: 1,
      episode: EPISODES_PER_SEASON,
    });
  });

  it('26日目から第2季が始まる', () => {
    expect(turnFor(dayAfter(DAYS_PER_SEASON))).toMatchObject({
      era: 'guilds',
      season: 2,
      episode: 1,
    });
  });

  it('1季のあいだに各主人公が5話ずつ書く', () => {
    const counts = new Map<string, number>();
    for (let offset = 0; offset < DAYS_PER_SEASON; offset += 1) {
      const turn = turnFor(dayAfter(offset));
      counts.set(turn.protagonist, (counts.get(turn.protagonist) ?? 0) + 1);
    }
    expect([...counts.values()]).toEqual([5, 5, 5, 5, 5]);
  });

  it('1季のあいだ、各主人公の話番号が1〜5を1回ずつ通る', () => {
    for (const era of rotation.order) {
      const who = ERA_PROTAGONIST[era];
      const episodes: number[] = [];
      for (let offset = 0; offset < DAYS_PER_SEASON; offset += 1) {
        const turn = turnFor(dayAfter(offset));
        if (turn.protagonist === who) episodes.push(turn.episode);
      }
      expect(episodes).toEqual([1, 2, 3, 4, 5]);
    }
  });

  it('季の初日を逆算できる', () => {
    expect(seasonStartDate(1)).toBe(start);
    expect(seasonStartDate(2)).toBe(dayAfter(DAYS_PER_SEASON));
  });

  it('稼働開始日より前は拒む', () => {
    expect(() => turnFor(dayAfter(-1))).toThrow(/稼働開始日/);
  });
});

describe('今日（JST）', () => {
  const start = rotation.start_date as string;

  /** 稼働開始日の朝 06:00 JST に cron が鳴る瞬間 = その前日の 21:00 UTC。 */
  const firstCron = new Date(Date.parse(`${start}T00:00:00Z`) - 3 * 3_600_000);

  it('稼働開始日の朝に鳴った cron は、その日を刻む', () => {
    // UTC で日付を取ると前日になり、turnFor が稼働開始日より前だと拒む。
    // 日次ジョブが1度も成功しなかったのはこれ。
    expect(firstCron.toISOString().slice(0, 10)).not.toBe(start);
    expect(today(firstCron)).toBe(start);
  });

  it('稼働開始日の朝の実行が、初日として成立する', () => {
    expect(turnFor(today(firstCron))).toMatchObject({
      era: 'guilds',
      protagonist: 'teo',
      season: 1,
      episode: 1,
    });
  });

  it('日付が変わるのは JST の深夜（15:00 UTC）', () => {
    expect(today(new Date('2026-09-01T14:59:59Z'))).toBe('2026-09-01'); // 23:59:59 JST
    expect(today(new Date('2026-09-01T15:00:00Z'))).toBe('2026-09-02'); // 00:00:00 JST
  });
});

describe('カードの抽選', () => {
  it('同じ季は同じカードを引く', () => {
    // 計画を作り直すとき素材まで変わると、直した箇所以外も別物になる。
    const deck = readYaml(worldPath('cards/guilds.yaml'), CardDeckFileSchema);
    const first = weightedPick(deck.cards, seededRandom('season-1:guilds'));
    const second = weightedPick(deck.cards, seededRandom('season-1:guilds'));
    expect(first.id).toBe(second.id);
  });

  it('季が変われば引くカードも変わりうる', () => {
    const deck = readYaml(worldPath('cards/guilds.yaml'), CardDeckFileSchema);
    const drawn = new Set<string>();
    for (let season = 1; season <= 20; season += 1) {
      drawn.add(weightedPick(deck.cards, seededRandom(`season-${season}:guilds`)).id);
    }
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
