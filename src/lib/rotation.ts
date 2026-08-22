import { worldPath } from './paths.js';
import { readYaml } from './storage.js';
import {
  RotationFileSchema,
  ERA_PROTAGONIST,
  type EraId,
  type CharacterId,
} from '../schemas/world.js';
import { EPISODES_PER_SEASON, DAYS_PER_SEASON } from '../schemas/season.js';

export type Turn = {
  era: EraId;
  protagonist: CharacterId;
  /** 稼働開始から何日目か（0 始まり） */
  dayIndex: number;
  /** 季の番号（1 始まり） */
  season: number;
  /** その季の何話目か（1〜5） */
  episode: number;
};

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) {
    throw new Error(`日付を解釈できません: ${from} / ${to}`);
  }
  return Math.floor((b - a) / 86_400_000);
}

/**
 * その日は誰の、季の何話目か。
 *
 * 5日で5時代を1周し、5周で1季（25日）が終わる。
 * したがって各主人公は、1季のあいだに5話ぶんの日記を書く。
 *
 *   1日目 ギルド 第1話    6日目 ギルド 第2話   ...  26日目 ギルド 第1話（次の季）
 *   2日目 静寂   第1話    7日目 静寂   第2話
 *   3日目 大収束 第1話    ...
 */
export function turnFor(date: string): Turn {
  const rotation = readYaml(
    worldPath('canon/rotation.yaml'),
    RotationFileSchema,
  );

  if (!rotation.start_date) {
    throw new Error(
      'world/canon/rotation.yaml の start_date が未設定です。稼働開始日を決めてください。',
    );
  }

  const dayIndex = daysBetween(rotation.start_date, date);
  if (dayIndex < 0) {
    throw new Error(`${date} は稼働開始日 ${rotation.start_date} より前です。`);
  }

  const era = rotation.order[dayIndex % rotation.order.length] as EraId;

  return {
    era,
    protagonist: ERA_PROTAGONIST[era],
    dayIndex,
    season: Math.floor(dayIndex / DAYS_PER_SEASON) + 1,
    episode: (Math.floor(dayIndex / rotation.order.length) % EPISODES_PER_SEASON) + 1,
  };
}

/** 季の初日の日付。計画を立てるときの基準になる。 */
export function seasonStartDate(season: number): string {
  const rotation = readYaml(
    worldPath('canon/rotation.yaml'),
    RotationFileSchema,
  );
  if (!rotation.start_date) {
    throw new Error('world/canon/rotation.yaml の start_date が未設定です。');
  }
  const start = Date.parse(`${rotation.start_date}T00:00:00Z`);
  const offset = (season - 1) * DAYS_PER_SEASON * 86_400_000;
  return new Date(start + offset).toISOString().slice(0, 10);
}
