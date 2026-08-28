import { describe, it, expect } from 'vitest';
import {
  SeasonPlanSchema,
  EpisodeSchema,
  BEATS,
  EPISODES_PER_SEASON,
  DAYS_PER_SEASON,
} from '../../src/schemas/season.js';

function episode(number: number, beat: (typeof BEATS)[number]) {
  return {
    number,
    beat,
    world_date: { month: 7, day: 3 + number * 4 },
    events: [{ summary: `第${number}話の出来事`, where: '大鑑定院', who: [] }],
    world_change: null,
    leaves_open: `第${number}話が残したもの`,
  };
}

function plan(overrides: Record<string, unknown> = {}) {
  return {
    season: 1,
    era: 'guilds',
    protagonist: 'teo',
    arc: 'guilds-provisional-sigil',
    year_in_world: 375,
    title: '座金の向き',
    shape: '誰も見なかった座金から始まり、推薦状へ届かないまま終わる5話。',
    episodes: BEATS.map((beat, i) => episode(i + 1, beat)),
    generation: {
      model: 'gemini-3.5-flash',
      prompt_version: 'season-v1',
      seed: 'season-1:guilds',
      generated_at: '2026-08-22T00:00:00.000Z',
    },
    ...overrides,
  };
}

describe('季の計画', () => {
  it('1季は5話', () => {
    expect(EPISODES_PER_SEASON).toBe(5);
    expect(DAYS_PER_SEASON).toBe(25);
  });

  it('妥当な計画を受け入れる', () => {
    expect(SeasonPlanSchema.safeParse(plan()).success).toBe(true);
  });

  it('話数が5でなければ拒む', () => {
    const short = plan({ episodes: BEATS.slice(0, 4).map((b, i) => episode(i + 1, b)) });
    expect(SeasonPlanSchema.safeParse(short).success).toBe(false);
  });

  it('beat は決まった5つ以外を受け付けない', () => {
    const invalid = plan({
      episodes: [
        episode(1, '発端'),
        { ...episode(2, '展開'), beat: 'クライマックス' },
        episode(3, '転機'),
        episode(4, '危機'),
        episode(5, '決着'),
      ],
    });
    expect(SeasonPlanSchema.safeParse(invalid).success).toBe(false);
  });

  it('1話の出来事は3件まで', () => {
    // 多すぎると一日が事件で埋まり、日常が消える。
    const crowded = {
      ...episode(1, '発端'),
      events: Array.from({ length: 4 }, (_, i) => ({
        summary: `出来事${i}`,
        where: '大鑑定院',
        who: [],
      })),
    };
    expect(EpisodeSchema.safeParse(crowded).success).toBe(false);
  });

  it('出来事のない話は作れない', () => {
    const empty = { ...episode(1, '発端'), events: [] };
    expect(EpisodeSchema.safeParse(empty).success).toBe(false);
  });

  it('leaves_open は必須（次へ渡すものが要る）', () => {
    const dangling = { ...episode(1, '発端'), leaves_open: '' };
    expect(EpisodeSchema.safeParse(dangling).success).toBe(false);
  });

  it('世界の側の変化がない日は null にできる', () => {
    expect(EpisodeSchema.safeParse(episode(1, '発端')).success).toBe(true);
  });

  it('shape は必須（人間が読んで直すための要約）', () => {
    expect(SeasonPlanSchema.safeParse(plan({ shape: '' })).success).toBe(false);
  });
});
