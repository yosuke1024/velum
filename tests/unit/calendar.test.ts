import { describe, it, expect } from 'vitest';
import {
  linearDay,
  daysUntil,
  monthName,
  seasonOf,
  formatWorldDate,
  nextDay,
  convergenceDayCount,
  upcomingObservances,
  calendarLineFor,
  clockFor,
  loadClocks,
} from '../../src/lib/calendar.js';

describe('暦の算術', () => {
  it('年内通日: 芽の月1日は1、五夜の5日目は365', () => {
    expect(linearDay({ month: 1, day: 1 })).toBe(1);
    expect(linearDay({ month: 7, day: 4 })).toBe(184);
    expect(linearDay({ month: 13, day: 5 })).toBe(365);
  });

  it('daysUntil は年をまたいで数えられる', () => {
    expect(daysUntil({ month: 7, day: 4 }, { month: 7, day: 15 })).toBe(11);
    expect(daysUntil({ month: 12, day: 30 }, { month: 1, day: 1 })).toBe(6); // 五夜5日を挟む
  });

  it('月の名前と季節', () => {
    expect(monthName(7)).toBe('星の月');
    expect(monthName(13)).toBe('五夜');
    expect(seasonOf(7)).toBe('秋');
    expect(seasonOf(13)).toBe('冬の外れ');
  });

  it('日付の整形', () => {
    expect(formatWorldDate(3745, { month: 7, day: 4 })).toBe('3,745年 星の月4日');
    expect(formatWorldDate(null, { month: 7, day: 4 })).toBe('星の月4日');
    expect(formatWorldDate(9745, { month: 13, day: 2 })).toBe('9,745年 五夜の2日目');
  });
});

describe('翌日と年の変わり目', () => {
  it('月の中では日が進む', () => {
    expect(nextDay('guilds', { era: 'guilds', year: 3745, month: 7, day: 4 })).toMatchObject({
      month: 7,
      day: 5,
    });
  });

  it('眠りの月の後に五夜が来る', () => {
    expect(nextDay('guilds', { era: 'guilds', year: 3745, month: 12, day: 30 })).toMatchObject({
      month: 13,
      day: 1,
    });
  });

  it('五夜が明けると年が変わる', () => {
    expect(nextDay('guilds', { era: 'guilds', year: 3745, month: 13, day: 5 })).toMatchObject({
      year: 3746,
      month: 1,
      day: 1,
    });
  });

  it('大収束の年は変わらない（終わらない年）', () => {
    expect(
      nextDay('convergence', { era: 'convergence', year: 4217, month: 13, day: 5 }),
    ).toMatchObject({ year: 4217, month: 1, day: 1 });
  });

  it('原初は年を数えないまま', () => {
    expect(
      nextDay('primordial', { era: 'primordial', year: null, month: 13, day: 5 }),
    ).toMatchObject({ year: null, month: 1, day: 1 });
  });
});

describe('稼働開始時の設計と、既存の記述の整合', () => {
  // 声のフィクスチャと初期状態は暦より先に書かれた。
  // 暦（節目の日付）はそれらが成立するように設計されている——ここが崩れたら暦の側の退行。
  //
  // world/clocks.yaml は季の計画のたびに進む可変状態なので、ここでは読まない。
  // 検証するのは「稼働開始日 = 星の月4日」という設計定数と、節目の配置の関係。

  const START = { month: 7, day: 4 } as const;

  it('ウタ:「星祭りまで、あと十一の夜」', () => {
    const festival = upcomingObservances('primordial', START).find(
      (o) => o.id === 'star-festival',
    );
    expect(festival?.inDays).toBe(11);
  });

  it('リコ:「北の市まであと六日」', () => {
    const market = upcomingObservances('silent', START).find(
      (o) => o.id === 'northern-market',
    );
    expect(market?.inDays).toBe(6);
  });

  it('テオ: 仮銘審査は月末（星の月30日）', () => {
    const review = upcomingObservances('guilds', START).find(
      (o) => o.id === 'provisional-sigil-review',
    );
    expect(review?.inDays).toBe(26);
  });

  it('時計は妥当な状態を保っている（可変ぶんは中身を固定しない）', () => {
    const clocks = loadClocks();
    expect(clocks).toHaveLength(5);
    expect(clockFor('convergence').year).toBe(4217); // 終わらない年
    expect(clockFor('primordial').year).toBeNull(); // 年を数えない
  });
});

describe('時代ごとの暦の声', () => {
  it('ウタ: 年も日付の数字も出さず、夜の数で数える', () => {
    const line = calendarLineFor('primordial', null, { month: 7, day: 4 });
    expect(line).toContain('秋');
    expect(line).toContain('星の月');
    expect(line).toContain('星祭りまであと11夜');
    expect(line).not.toMatch(/\d+日（/); // 「4日」のような日付表記がない
    expect(line).not.toContain('年');
  });

  it('セヴラン: 収束暦を併記し、年は4,217のまま', () => {
    const line = calendarLineFor('convergence', 4217, { month: 7, day: 4 });
    expect(line).toContain('4,217年');
    expect(line).toContain('収束暦184日');
  });

  it('テオ: 年月日と、近い節目', () => {
    const line = calendarLineFor('guilds', 3745, { month: 7, day: 4 });
    expect(line).toContain('3,745年 星の月4日');
    expect(line).toContain('仮銘審査まであと26日');
  });

  it('収束暦は芽の月一日からの通算日', () => {
    expect(convergenceDayCount({ month: 1, day: 1 })).toBe(1);
    expect(convergenceDayCount({ month: 7, day: 4 })).toBe(184);
  });
});
