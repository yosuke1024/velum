import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));

export const worldPath = (...parts: string[]) => join(ROOT, 'world', ...parts);
export const charPath = (id: string, ...parts: string[]) =>
  join(ROOT, 'characters', id, ...parts);

/** 日付を <YYYY>/<MM>/<YYYY-MM-DD> の階層へ割る */
export function datedPath(base: string, date: string, suffix: string): string {
  const [year, month] = date.split('-');
  if (!year || !month) throw new Error(`日付の形式が不正です: ${date}`);
  return join(base, year, month, `${date}${suffix}`);
}

/** 季の計画。人間が読んで直すファイルなので YAML で置く。 */
export const seasonPath = (season: number, era: string) =>
  worldPath('seasons', String(season).padStart(3, '0'), `${era}.yaml`);

export const seasonDir = (season: number) =>
  worldPath('seasons', String(season).padStart(3, '0'));

export const diaryPath = (id: string, date: string, lang: 'ja' | 'en') =>
  datedPath(charPath(id, 'diaries'), date, `.${lang}.md`);

export const entryPath = (id: string, date: string) =>
  datedPath(charPath(id, 'entries'), date, '.json');

export const eventPath = (id: string, date: string) =>
  datedPath(charPath(id, 'events'), date, '.json');

export const failurePath = (date: string, stage: string) =>
  join(ROOT, 'world', 'failures', `${date}-${stage}.json`);
