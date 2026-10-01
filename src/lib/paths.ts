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

/**
 * Persona Snapshot。追記のみで、既存バージョンは上書きしない。
 * PixTale Proxy はバージョンを固定して読む（docs/persona-snapshot.md §4）。
 */
export const snapshotDir = (id: string) => charPath(id, 'snapshots');

export const snapshotPath = (id: string, version: number) =>
  join(snapshotDir(id), `v${String(version).padStart(4, '0')}.json`);

/** いま配っているペルソナ。PixTale が最初に取りに来る1枚。 */
export const manifestPath = () => worldPath('personas.json');

/**
 * Diary/World feed。PixTale アプリが raw で直接読む契約面（契約 §1.1）。
 * ここより下のパス構造は配布 URL そのものなので、動かさない。
 */
export const feedDir = () => worldPath('feed');
export const feedPath = (...parts: string[]) => worldPath('feed', ...parts);
export const feedEntriesDir = () => feedPath('entries');
export const feedEntryName = (date: string, id: string) => `${date}-${id}.json`;
export const feedPortraitPath = (id: string) => feedPath('portraits', `${id}.png`);

/** リポジトリ root からの相対（feed の JSON に書く形）。 */
export const feedRelPath = (...parts: string[]) => ['world', 'feed', ...parts].join('/');

/**
 * World Appraisal Snapshot。追記のみで、既存バージョンは上書きしない。
 * PixTale プロキシはピン（world/personas.json の world）経由で読む。
 */
export const appraisalDir = () => worldPath('appraisal');

export const appraisalPath = (version: number) =>
  join(appraisalDir(), `v${String(version).padStart(4, '0')}.json`);

/**
 * Character Story（docs/stories.md）。
 *
 *   characters/<id>/stories/s01/{plan.yaml, manifest.yaml, e01.ja.md, e01.en.md, ...}
 *
 * 日記（diaries/）とは別の層である。日記は日付で割るが、Story は季と話の番号で割る。
 */
export const storySeasonDirName = (season: number) => `s${String(season).padStart(2, '0')}`;
export const storiesDir = (id: string) => charPath(id, 'stories');
export const storyDir = (id: string, season: number) =>
  join(storiesDir(id), storySeasonDirName(season));
export const storyManifestPath = (id: string, season: number) =>
  join(storyDir(id, season), 'manifest.yaml');
export const storyPlanPath = (id: string, season: number) =>
  join(storyDir(id, season), 'plan.yaml');
export const storyEpisodeFileName = (order: number, lang: 'ja' | 'en') =>
  `e${String(order).padStart(2, '0')}.${lang}.md`;
export const storyEpisodePath = (id: string, season: number, order: number, lang: 'ja' | 'en') =>
  join(storyDir(id, season), storyEpisodeFileName(order, lang));

/** Journey Progress の既定の階段。story:plan が manifest へ写す。 */
export const storiesConfigPath = () => worldPath('stories.yaml');

/**
 * Story feed。既存の feed と同じ契約面（world/feed/）の下に並列で足す。
 * ここより下のパス構造も配布 URL そのものなので、動かさない。
 */
export const feedStoriesDir = () => feedPath('stories');
export const feedStoriesIndexPath = () => feedPath('stories', 'index.json');
export const feedStorySeriesName = (storyId: string) => `${storyId}.json`;
export const feedStorySeriesPath = (storyId: string) =>
  feedPath('stories', feedStorySeriesName(storyId));
