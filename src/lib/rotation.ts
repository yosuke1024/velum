import { worldPath } from './paths.js';
import { readYaml } from './storage.js';
import {
  RotationFileSchema,
  ERA_PROTAGONIST,
  type EraId,
  type CharacterId,
} from '../schemas/world.js';

export type Turn = {
  era: EraId;
  protagonist: CharacterId;
  dayIndex: number;
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
 * その日は誰の番か。
 *
 * 進むのは1日ひとつの時代だけ。番でない時代の時間は止まっている。
 * 5人が並行して生きているのではなく、5つの時代が順番に1日ずつ進む。
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

  const offset = daysBetween(rotation.start_date, date);
  if (offset < 0) {
    throw new Error(`${date} は稼働開始日 ${rotation.start_date} より前です。`);
  }

  const index = offset % rotation.order.length;
  const era = rotation.order[index] as EraId;

  return { era, protagonist: ERA_PROTAGONIST[era], dayIndex: offset };
}
