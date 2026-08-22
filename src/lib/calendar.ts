import { worldPath } from './paths.js';
import { readYaml } from './storage.js';
import {
  CalendarFileSchema,
  ClocksFileSchema,
  EraCanonFileSchema,
  type EraId,
} from '../schemas/world.js';
import { z } from 'zod';

/**
 * Velum の暦。1年 = 12の月 × 30日 + 五夜（month: 13, day: 1..5）= 365日。
 *
 * 月の名は全時代で共通（原初の星読み由来、canon 参照）。
 * 年の数え方だけが時代ごとに違う:
 *   primordial  年を数えない（null）
 *   convergence 4,217 のまま変わらない（終わらない年）
 *   その他      普通に進む
 */

export type WorldDate = { month: number; day: number };
export type WorldClock = { era: EraId; year: number | null; month: number; day: number };

type Calendar = z.infer<typeof CalendarFileSchema>;

let cached: Calendar | null = null;

export function loadCalendar(): Calendar {
  if (!cached) {
    cached = readYaml(worldPath('canon/calendar.yaml'), CalendarFileSchema);
  }
  return cached;
}

export function loadClocks(): WorldClock[] {
  return readYaml(worldPath('clocks.yaml'), ClocksFileSchema).clocks as WorldClock[];
}

export function clockFor(era: EraId): WorldClock {
  const clock = loadClocks().find((c) => c.era === era);
  if (!clock) throw new Error(`時代 ${era} の時計が world/clocks.yaml にありません`);
  return clock;
}

/** 年内の通し日（1..365）。五夜は 361..365。 */
export function linearDay(date: WorldDate): number {
  if (date.month === 13) {
    if (date.day > 5) throw new Error(`五夜は5日までです: day=${date.day}`);
    return 360 + date.day;
  }
  return (date.month - 1) * 30 + date.day;
}

/** from から to まで何日か（年をまたぐ場合は次の年の to まで）。同日は 0。 */
export function daysUntil(from: WorldDate, to: WorldDate): number {
  const calendar = loadCalendar();
  return (linearDay(to) - linearDay(from) + calendar.year_days) % calendar.year_days;
}

export function monthName(month: number): string {
  const calendar = loadCalendar();
  if (month === 13) return calendar.intercalary.name.ja;
  const found = calendar.months.find((m) => m.number === month);
  if (!found) throw new Error(`月 ${month} は存在しません`);
  return found.name.ja;
}

export function seasonOf(month: number): string {
  if (month === 13) return '冬の外れ';
  const calendar = loadCalendar();
  const found = calendar.months.find((m) => m.number === month);
  if (!found) throw new Error(`月 ${month} は存在しません`);
  return found.season;
}

/** 「3,745年 星の月4日」「星の月4日」「五夜の2日目」 */
export function formatWorldDate(year: number | null, date: WorldDate): string {
  const day =
    date.month === 13 ? `${monthName(13)}の${date.day}日目` : `${monthName(date.month)}${date.day}日`;
  return year === null ? day : `${year.toLocaleString('ja-JP')}年 ${day}`;
}

/** 翌日。年をまたぐとき、convergence は年が変わらず、primordial は null のまま。 */
export function nextDay(era: EraId, clock: WorldClock): WorldClock {
  let { year, month, day } = clock;
  if (month === 13) {
    if (day < 5) {
      day += 1;
    } else {
      // 五夜の終わり = 年の変わり目
      month = 1;
      day = 1;
      if (year !== null && era !== 'convergence') year += 1;
    }
  } else if (day < 30) {
    day += 1;
  } else if (month < 12) {
    month += 1;
    day = 1;
  } else {
    month = 13;
    day = 1;
  }
  return { era, year, month, day };
}

/** 収束暦: 大収束が始まった芽の月一日からの通算日（canon の the-unending-year）。 */
export function convergenceDayCount(date: WorldDate): number {
  return linearDay(date);
}

export type UpcomingObservance = {
  id: string;
  name: string;
  inDays: number | null; // null = 季節帯（峠の閉山期など）
  note: string | null;
};

/** 今後 horizon 日以内の節目。季節帯は現在または翌月が帯に入っていれば載せる。 */
export function upcomingObservances(
  era: EraId,
  from: WorldDate,
  horizon = 45,
): UpcomingObservance[] {
  const canon = readYaml(worldPath(`canon/${era}.yaml`), EraCanonFileSchema);
  const result: UpcomingObservance[] = [];

  for (const observance of canon.observances ?? []) {
    const { when } = observance;

    if (when.intercalary) {
      const inDays = daysUntil(from, { month: 13, day: 1 });
      if (inDays <= horizon) {
        result.push({ id: observance.id, name: observance.name, inDays, note: observance.note ?? null });
      }
      continue;
    }

    if (when.months) {
      const nextMonth = from.month === 13 ? 1 : Math.min(from.month + 1, 13);
      if (when.months.includes(from.month) || when.months.includes(nextMonth)) {
        result.push({ id: observance.id, name: observance.name, inDays: null, note: observance.note ?? null });
      }
      continue;
    }

    if (when.month !== undefined) {
      const inDays = daysUntil(from, { month: when.month, day: when.day ?? 1 });
      if (inDays <= horizon) {
        result.push({ id: observance.id, name: observance.name, inDays, note: observance.note ?? null });
      }
    }
  }

  return result.sort((a, b) => (a.inDays ?? -1) - (b.inDays ?? -1));
}

/**
 * 日記プロンプト用の「今日の暦」。時代ごとの声で書く。
 *
 * primordial  年も日付の数字も出さない。季節と月の呼び名、節目までの夜の数だけ。
 * convergence 月日と収束暦を併記。年は 4,217 のまま。
 * その他      年月日。
 */
export function calendarLineFor(
  era: EraId,
  year: number | null,
  date: WorldDate,
): string {
  const season = seasonOf(date.month);
  const upcoming = upcomingObservances(era, date, 30);

  if (era === 'primordial') {
    const parts = [`季節は${season}、${monthName(date.month)}の頃`];
    for (const observance of upcoming) {
      if (observance.inDays !== null && observance.inDays > 0) {
        parts.push(`${observance.name}まであと${observance.inDays}夜`);
      } else if (observance.inDays === 0) {
        parts.push(`今夜は${observance.name}`);
      }
    }
    return parts.join('。');
  }

  const base = `${formatWorldDate(year, date)}（${season}）`;

  if (era === 'convergence') {
    return `${base}。収束暦${convergenceDayCount(date)}日`;
  }

  const parts = [base];
  for (const observance of upcoming) {
    if (observance.inDays === 0) {
      parts.push(`今日は${observance.name}`);
    } else if (observance.inDays !== null) {
      parts.push(`${observance.name}まであと${observance.inDays}日`);
    } else {
      parts.push(`${observance.name}の時季`);
    }
  }
  return parts.join('。');
}
