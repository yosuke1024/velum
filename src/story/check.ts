import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import type { ZodTypeAny } from 'zod';
import { ROOT, charPath, storiesDir } from '../lib/paths.js';
import { secretLeaksIn, secretLeaksInJson } from '../lib/secrets.js';
import { sameIgnoringGeneratedAt } from '../lib/stable-json.js';
import { RelationshipsSchema } from '../schemas/character.js';
import {
  FEED_SIZE_LIMITS,
  FeedStoriesIndexSchema,
  FeedStorySeriesSchema,
  type FeedStoriesIndex,
  type FeedStorySeries,
} from '../schemas/feed.js';
import {
  STORY_SERIES_ID,
  StoriesConfigSchema,
  StoryManifestSchema,
  StoryPlanSchema,
  storyEpisodeId,
  storySeriesId,
  type StoryManifest,
} from '../schemas/story.js';
import { CHARACTER_IDS } from '../schemas/world.js';
import {
  buildStoriesFeed,
  collectStorySources,
  isStorySeriesFileName,
  storyFeedPath,
  storyRevision,
} from '../export/stories.js';
import { storyBodyProblems } from './body.js';

/**
 * Character Story の検査（`npm run validate` が呼ぶ）。
 *
 * ソース（characters/<id>/stories/）と配布面（world/feed/stories/）の両方を見る。
 * どの関数も違反の文を返すだけで、書き換えない——自動修復はしない（違反は捨てて
 * 見せる）。返す文は「相対パス: 内容」の形で、validate の問題一覧にそのまま並ぶ。
 *
 * root を引数に取るのは、一時ディレクトリで違反を作って単体テストするため。
 * 人物の関係（relationships.yaml）だけは常に実リポジトリから読む——フィクスチャも
 * 実在の人物を使うので、周りの人の id の正は1か所である。
 *
 * 秘密の照合（secrets.ts）は**全ての状態**のソースに当てる。draft の本文もこのリポジトリ
 * では公開されているので、feed に出ないからといって秘密を書いてよい理由にならない。
 */

// ── 共通 ───────────────────────────────────────────────────────

const SEASON_DIR = /^s(\d{2})$/;
const BODY_FILE = /^e(\d{2})\.(ja|en)\.md$/;
/** 季ディレクトリに置いてよい（本文以外の）ファイル。 */
const SEASON_FILES = new Set(['manifest.yaml', 'plan.yaml', 'brief.md']);
/**
 * 検査から外す、OS が勝手に作るメタデータ（macOS の Finder が置く。.gitignore 済み）。
 * 名前が完全に一致するものだけ。ほかの想定外のファイルは、これまでどおり落とす。
 */
const OS_METADATA = new Set(['.DS_Store']);

const issuePath = (path: ReadonlyArray<string | number>): string =>
  path.length ? path.join('.') : '(root)';

/** 読めて、スキーマに合う値だけを返す。違反は problems へ。 */
function loadYamlWith<S extends ZodTypeAny>(
  path: string,
  schema: S,
  where: string,
  problems: string[],
): ReturnType<S['parse']> | null {
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, 'utf8'));
  } catch (error) {
    problems.push(`${where}: YAML を解析できません — ${(error as Error).message}`);
    return null;
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    for (const issue of result.error.issues) {
      problems.push(`${where}: ${issuePath(issue.path)} — ${issue.message}`);
    }
    return null;
  }
  return result.data;
}

function leakProblems(where: string, text: string, json: boolean): string[] {
  const leaks = json ? secretLeaksInJson(text) : secretLeaksIn(text);
  return leaks.map(
    (leak) => `${where}: ${leak.owner} の秘密が混入しています（${leak.segment.slice(0, 16)}…）`,
  );
}

// ── world/stories.yaml ─────────────────────────────────────────

/** Journey Progress の既定の階段と既定の話数。 */
export function checkStoriesConfig(root: string = ROOT): string[] {
  const problems: string[] = [];
  const path = join(root, 'world', 'stories.yaml');
  if (!existsSync(path)) {
    return ['world/stories.yaml: Journey Progress の既定値が存在しません'];
  }
  loadYamlWith(path, StoriesConfigSchema, 'world/stories.yaml', problems);
  return problems;
}

// ── characters/<id>/stories/ ───────────────────────────────────

/**
 * 周りの人の id（characters/<id>/relationships.yaml の people）。
 * 読めなければ null（そちらの検査は validate の characters ブロックが落とす）。
 */
function relationshipIds(characterId: string): Set<string> | null {
  try {
    const raw = parse(readFileSync(charPath(characterId, 'relationships.yaml'), 'utf8'));
    const result = RelationshipsSchema.safeParse(raw);
    return result.success ? new Set(result.data.people.map((p) => p.id)) : null;
  } catch {
    return null;
  }
}

/** 台帳に載る、人が読む文（題と要約）。秘密の照合に使う。 */
function manifestTexts(manifest: StoryManifest): string[] {
  const texts = [manifest.title.ja, manifest.title.en];
  if (manifest.summary) texts.push(manifest.summary.ja, manifest.summary.en);
  for (const episode of manifest.episodes) {
    if (episode.title) texts.push(episode.title.ja, episode.title.en);
    if (episode.summary) texts.push(episode.summary.ja, episode.summary.en);
  }
  return texts;
}

function checkSeasonDir(
  characterId: string,
  dirName: string,
  seasonDir: string,
  root: string,
): string[] {
  const problems: string[] = [];
  const rel = (path: string) => relative(root, path);
  const season = Number(SEASON_DIR.exec(dirName)![1]);

  // 置いてよいファイルだけ。名前の typo（e1.ja.md など）は、読まれないまま
  // 黙って残るので、ここで落とす。
  const names = readdirSync(seasonDir, { withFileTypes: true }).filter(
    (entry) => !OS_METADATA.has(entry.name),
  );
  for (const entry of names) {
    const where = rel(join(seasonDir, entry.name));
    if (!entry.isFile()) {
      problems.push(`${where}: 季のディレクトリにはファイルだけを置けます`);
    } else if (!SEASON_FILES.has(entry.name) && !BODY_FILE.test(entry.name)) {
      problems.push(
        `${where}: 想定外のファイルです（manifest.yaml / plan.yaml / brief.md / e<NN>.ja.md / e<NN>.en.md だけ）`,
      );
    }
  }
  const files = new Set(names.filter((e) => e.isFile()).map((e) => e.name));

  // 台帳
  const manifestFile = join(seasonDir, 'manifest.yaml');
  const manifestWhere = rel(manifestFile);
  let manifest: StoryManifest | null = null;
  if (!files.has('manifest.yaml')) {
    problems.push(`${manifestWhere}: 台帳が存在しません`);
  } else {
    manifest = loadYamlWith(manifestFile, StoryManifestSchema, manifestWhere, problems) as StoryManifest | null;
  }
  if (manifest) {
    if (manifest.character_id !== characterId) {
      problems.push(`${manifestWhere}: character_id が ${manifest.character_id} になっています（ディレクトリは ${characterId}）`);
    }
    if (manifest.season !== season) {
      problems.push(`${manifestWhere}: season が ${manifest.season} になっています（ディレクトリは ${dirName}）`);
    }
    for (const text of manifestTexts(manifest)) {
      problems.push(...leakProblems(manifestWhere, text, false));
    }
  }

  // 計画
  if (files.has('plan.yaml')) {
    const planFile = join(seasonDir, 'plan.yaml');
    const planWhere = rel(planFile);
    const plan = loadYamlWith(planFile, StoryPlanSchema, planWhere, problems);
    if (plan) {
      const expectedId = storySeriesId(characterId, season);
      if (plan.id !== expectedId) {
        problems.push(`${planWhere}: id が ${plan.id} になっています（${expectedId} のはず）`);
      }
      if (plan.character_id !== characterId) {
        problems.push(`${planWhere}: character_id が ${plan.character_id} になっています（ディレクトリは ${characterId}）`);
      }
      if (plan.season !== season) {
        problems.push(`${planWhere}: season が ${plan.season} になっています（ディレクトリは ${dirName}）`);
      }

      // 周りの人は relationships.yaml の people だけ。存在しない人物を計画へ
      // 出すと、本文がその人物をでっち上げる。
      const known = relationshipIds(characterId);
      if (known) {
        const refs: Array<[string, string]> = [
          ...plan.relationships.focus.map((id, i): [string, string] => [`relationships.focus[${i}]`, id]),
          ...plan.episodes.flatMap((episode, i) =>
            episode.people.map((id, j): [string, string] => [`episodes[${i}].people[${j}]`, id]),
          ),
        ];
        for (const [at, id] of refs) {
          if (!known.has(id)) {
            problems.push(
              `${planWhere}: ${at} の ${id} は characters/${characterId}/relationships.yaml の people にいません（${[...known].join(' / ')}）`,
            );
          }
        }
      }
    }
  }

  // 台帳以外の人が書く文（企画メモ・計画）にも秘密の照合を当てる。公開リポジトリである。
  for (const name of ['plan.yaml', 'brief.md']) {
    if (!files.has(name)) continue;
    const file = join(seasonDir, name);
    problems.push(...leakProblems(rel(file), readFileSync(file, 'utf8'), false));
  }

  // 本文
  const bodies = new Map<string, string>();
  for (const name of [...files].sort()) {
    const match = BODY_FILE.exec(name);
    if (!match) continue;
    const order = Number(match[1]);
    const lang = match[2] as 'ja' | 'en';
    const file = join(seasonDir, name);
    const where = rel(file);
    const text = readFileSync(file, 'utf8');
    bodies.set(name, text);

    if (manifest && !manifest.episodes.some((e) => e.order === order)) {
      problems.push(`${where}: manifest に第${order}話がありません（対応する話の無い本文）`);
    }
    for (const problem of storyBodyProblems(text, lang)) problems.push(`${where}: ${problem}`);
    problems.push(...leakProblems(where, text, false));
  }

  // reviewed 以上は ja / en の両方が要る。人間が読んで進める段階で片方が無いのは手違い。
  if (manifest) {
    for (const episode of manifest.episodes) {
      if (episode.status === 'draft') continue;
      for (const lang of ['ja', 'en'] as const) {
        const name = `e${String(episode.order).padStart(2, '0')}.${lang}.md`;
        if (!bodies.has(name)) {
          problems.push(`${rel(join(seasonDir, name))}: ${episode.id} は ${episode.status} なので本文（${lang}）が要ります`);
        }
      }
    }
  }

  return problems;
}

/**
 * ソースの検査。人物ごとの stories/ を見て、季ごとに台帳・計画・本文を調べる。
 * stories/ が無い人物は問題にしない。
 */
export function checkStorySources(root: string = ROOT): string[] {
  const problems: string[] = [];

  for (const id of CHARACTER_IDS) {
    const base = storiesDir(id, root);
    if (!existsSync(base)) continue;

    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (OS_METADATA.has(entry.name)) continue;
      const where = relative(root, join(base, entry.name));
      if (entry.isDirectory() && SEASON_DIR.test(entry.name)) {
        problems.push(...checkSeasonDir(id, entry.name, join(base, entry.name), root));
      } else if (entry.isFile() && entry.name === 'README.md') {
        continue;
      } else {
        problems.push(`${where}: stories/ には s<NN>/ のディレクトリ（と README.md）だけを置けます`);
      }
    }
  }

  return problems;
}

// ── world/feed/stories/ ────────────────────────────────────────

const REBUILD_HINT = '素材と食い違っています。npm run export:feed で作り直してください';

/** 2つの値の JSON 表現が等しいか（キー順も含む。スキーマを通した値同士で使う）。 */
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * 配布面の検査。
 *
 *   feedDir      <base>/world/feed/stories/ の絶対パス（メッセージの相対パスは <base> から）
 *   sourcesRoot  ソース（characters/<id>/stories/）の根。素材との食い違いの照合に使う
 *
 * index・季ファイルのスキーマとサイズ、index と季ファイルの整合、revision の再計算、
 * index に載らない季ファイル、素材から作り直した内容との食い違い、秘密の混入を見る。
 */
export function checkStoriesFeed(feedDir: string, sourcesRoot: string = ROOT): string[] {
  const problems: string[] = [];
  const base = resolve(feedDir, '..', '..', '..');
  const rel = (path: string) => relative(base, path);

  const indexFile = join(feedDir, 'index.json');
  const indexWhere = rel(indexFile);
  if (!existsSync(indexFile)) {
    return [`${indexWhere}: index がありません。npm run export:feed で作ってください`];
  }

  const readChecked = (
    file: string,
    where: string,
    limit: number,
  ): { text: string; raw: unknown } | null => {
    const size = statSync(file).size;
    if (size > limit) problems.push(`${where}: ${size} bytes あります（上限 ${limit}）`);
    const text = readFileSync(file, 'utf8');
    problems.push(...leakProblems(where, text, true));
    try {
      return { text, raw: JSON.parse(text) };
    } catch (error) {
      problems.push(`${where}: JSON を解析できません — ${(error as Error).message}`);
      return null;
    }
  };

  const schemaProblems = (where: string, schema: ZodTypeAny, raw: unknown) => {
    const result = schema.safeParse(raw);
    if (result.success) return result.data;
    for (const issue of result.error.issues) {
      problems.push(`${where}: ${issuePath(issue.path)} — ${issue.message}`);
    }
    return null;
  };

  const indexRead = readChecked(indexFile, indexWhere, FEED_SIZE_LIMITS.storiesIndex);
  const index = indexRead
    ? (schemaProblems(indexWhere, FeedStoriesIndexSchema, indexRead.raw) as FeedStoriesIndex | null)
    : null;

  // 季ファイル。index が読めなければ、どれが載るべきか分からないので突き合わせは飛ばす。
  const listedFiles = new Set<string>();
  const seriesOnDisk = new Map<string, unknown>();

  if (index) {
    for (const [characterId, entry] of Object.entries(index.characters)) {
      for (const summary of entry?.series ?? []) {
        const fileName = `${summary.id}.json`;
        const file = join(feedDir, fileName);
        const where = rel(file);

        if (listedFiles.has(fileName)) {
          problems.push(`${indexWhere}: ${summary.id} が重複しています`);
          continue;
        }
        listedFiles.add(fileName);

        const match = STORY_SERIES_ID.exec(summary.id);
        if (!match || match[1] !== summary.character_id || Number(match[2]) !== summary.season) {
          problems.push(`${indexWhere}: ${summary.id} が character_id / season（${summary.character_id} / ${summary.season}）と合いません`);
        }
        if (summary.character_id !== characterId) {
          problems.push(`${indexWhere}: ${summary.id} が ${characterId} の下に載っています（character_id は ${summary.character_id}）`);
        }
        if (summary.path !== storyFeedPath(summary.id)) {
          problems.push(`${indexWhere}: ${summary.id} の path が ${summary.path} になっています（${storyFeedPath(summary.id)} のはず）`);
        }

        if (!existsSync(file)) {
          problems.push(`${indexWhere}: ${summary.id} が指す ${where} が存在しません`);
          continue;
        }
        const read = readChecked(file, where, FEED_SIZE_LIMITS.story);
        if (!read) continue;
        seriesOnDisk.set(fileName, read.raw);
        const series = schemaProblems(where, FeedStorySeriesSchema, read.raw) as FeedStorySeries | null;
        if (!series) continue;

        // index の要約と季ファイルが食い違わない。アプリは index だけで
        // ロック行を描き、季ファイルで本文を読むので、ずれると表示と中身が割れる。
        for (const key of ['id', 'character_id', 'season', 'title', 'summary', 'path', 'revision'] as const) {
          if (!sameJson(summary[key], series[key])) {
            problems.push(`${where}: ${key} が index.json の要約と食い違っています`);
          }
        }
        if (summary.episode_count !== series.episodes.length) {
          problems.push(`${where}: 話数が index.json の episode_count（${summary.episode_count}）と食い違っています（${series.episodes.length} 話）`);
        }
        if (summary.episodes.length !== series.episodes.length) {
          problems.push(`${where}: index.json の話の一覧（${summary.episodes.length} 話）と話数が食い違っています`);
        }
        summary.episodes.forEach((listed, i) => {
          const full = series.episodes[i];
          if (!full) return;
          for (const key of ['id', 'order', 'required_progress', 'title'] as const) {
            if (!sameJson(listed[key], full[key])) {
              problems.push(`${where}: ${listed.id} の ${key} が index.json の要約と食い違っています`);
            }
          }
        });

        // 公開済みの話は第1話から連続している。
        series.episodes.forEach((episode, i) => {
          if (episode.order !== i + 1 || episode.id !== storyEpisodeId(series.id, i + 1)) {
            problems.push(`${where}: episodes[${i}] が第${i + 1}話（${storyEpisodeId(series.id, i + 1)}）ではありません（${episode.id}）`);
          }
        });

        const expected = storyRevision(series);
        if (series.revision !== expected) {
          problems.push(`${where}: revision が内容と合いません（${series.revision}、内容からは ${expected}）`);
        }
      }
    }
  }

  // index に載っていない季ファイル。残っていると、取り下げたはずの本文が raw から読めてしまう。
  // index が読めないときは、どれが載るべきか分からないので見ない。
  if (index) {
    for (const name of readdirSync(feedDir).filter((f) => f.endsWith('.json') && f !== 'index.json').sort()) {
      if (listedFiles.has(name)) continue;
      problems.push(
        `${rel(join(feedDir, name))}: ${
          isStorySeriesFileName(name) ? 'index.json に載っていない季ファイルです' : '想定外のファイルです'
        }（公開をやめた季なら削除する）`,
      );
    }
  }

  // 素材との食い違い。ソースを直して書き出し忘れると、アプリは古い内容を配り続ける。
  try {
    const rebuilt = buildStoriesFeed(collectStorySources(sourcesRoot), '');
    if (index && indexRead && !sameIgnoringGeneratedAt(indexRead.raw, rebuilt.index)) {
      problems.push(`${indexWhere}: ${REBUILD_HINT}`);
    }
    for (const series of rebuilt.series) {
      const fileName = `${series.id}.json`;
      const onDisk = seriesOnDisk.get(fileName);
      if (onDisk !== undefined && !sameIgnoringGeneratedAt(onDisk, series)) {
        problems.push(`${rel(join(feedDir, fileName))}: ${REBUILD_HINT}`);
      }
    }
  } catch (error) {
    problems.push(`${rel(feedDir)}: 作り直しの照合に失敗しました — ${(error as Error).message}`);
  }

  return problems;
}
