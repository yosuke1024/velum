import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { ROOT, feedRelPath, storiesDir, storyBodyPath } from '../lib/paths.js';
import { CHARACTER_IDS, type CharacterId } from '../schemas/world.js';
import {
  STORIES_SCHEMA_VERSION,
  FeedStoriesIndexSchema,
  FeedStorySeriesSchema,
  type FeedStoriesIndex,
  type FeedStorySeries,
} from '../schemas/feed.js';
import {
  STORY_SERIES_ID,
  StoryManifestSchema,
  storySeasonDirName,
  type StoryManifest,
} from '../schemas/story.js';
import { normalizeStoryBody } from '../story/body.js';

/**
 * Character Story の feed（world/feed/stories/）の組み立て。
 *
 * ソースは characters/<id>/stories/s<NN>/（docs/stories.md §3）。feed へ出るのは
 * **季と話の両方が published のもの**だけで、reviewed / draft は 1 字も出ない。
 * 載った本文は raw GitHub から誰でも読める——人間が読んで published にした話だけが
 * 公開される、という約束はこの絞り込みに懸かっている。
 *
 * ビルダーは純粋で、変わる入力は `now` だけ。同じソースからは同じ内容が出る
 * （generated_at を除く）ので、書き出しは「内容が同じなら書かない」ができ、
 * validate は書き出し忘れ（素材との食い違い）を検出できる。
 *
 * 読み込み（collect*）はファイルを読むだけで、`root` を差し替えられる。
 * フィクスチャ（tests/fixtures/stories/）も、テストの一時ディレクトリも同じ形で読む。
 */

/** 1季ぶんのソース。本文は feed に載る話（published）の分だけ読む。 */
export interface StorySource {
  manifest: StoryManifest;
  /** order → 本文。published の季の published の話だけが入る。 */
  bodies: Record<number, { ja: string; en: string }>;
}

const SEASON_DIR = /^s(\d{2})$/;

function readManifest(path: string, root: string): StoryManifest {
  const where = relative(root, path);
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${where} を YAML として読めません — ${(error as Error).message}`);
  }
  const result = StoryManifestSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'} — ${issue.message}`)
      .join('\n  ');
    throw new Error(`${where} がスキーマに合いません:\n  ${issues}`);
  }
  return result.data;
}

/**
 * 全人物の全季の台帳を読み、published の季については published の話の本文も読む。
 * 並びは CHARACTER_IDS 順 → 季の番号順で決定的。stories/ が無い人物は飛ばす。
 *
 * 台帳が壊れていれば、黙って1季だけ消えるより止まるほうがよいので、ファイルの
 * パスを添えて投げる。本文（ja / en のどちらか）が無い published の話も同じ。
 * 英語を日本語で代用することはしない——読者が英語で開いて日本語が出るのは欠陥である。
 */
export function collectStorySources(root: string = ROOT): StorySource[] {
  const sources: StorySource[] = [];

  for (const id of CHARACTER_IDS) {
    const base = storiesDir(id, root);
    if (!existsSync(base)) continue;

    const seasons = readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SEASON_DIR.test(entry.name))
      .map((entry) => entry.name)
      .sort();

    for (const dirName of seasons) {
      const season = Number(SEASON_DIR.exec(dirName)![1]);
      const manifestFile = join(base, dirName, 'manifest.yaml');
      if (!existsSync(manifestFile)) {
        throw new Error(`${relative(root, manifestFile)} がありません`);
      }

      const manifest = readManifest(manifestFile, root);
      // パスは置き場所から導く。台帳の自己申告と置き場所が食い違うなら、
      // 別の人物・別の季の本文を読んでしまうので止める。
      if (manifest.character_id !== id || storySeasonDirName(manifest.season) !== dirName) {
        throw new Error(
          `${relative(root, manifestFile)} の character_id / season（${manifest.character_id} / ${manifest.season}）が置き場所（${id} / ${season}）と食い違っています`,
        );
      }

      const bodies: StorySource['bodies'] = {};
      if (manifest.status === 'published') {
        for (const episode of manifest.episodes) {
          if (episode.status !== 'published') continue;
          const read = (lang: 'ja' | 'en'): string => {
            const file = storyBodyPath(id, season, episode.order, lang, root);
            if (!existsSync(file)) {
              throw new Error(`${episode.id} は published ですが本文（${lang}）がありません: ${relative(root, file)}`);
            }
            return readFileSync(file, 'utf8');
          };
          bodies[episode.order] = { ja: read('ja'), en: read('en') };
        }
      }

      sources.push({ manifest, bodies });
    }
  }

  return sources;
}

/**
 * 季ファイルの版。generated_at と revision 自身を除いた内容の sha256 の先頭12桁。
 * キーの順序はスキーマの形（FeedStorySeriesSchema の shape 順）で決まる——
 * スキーマを通した値を渡すこと。アプリはキャッシュ済みの季ファイルとこれを比べ、
 * 違えば取り直す。
 */
export function storyRevision(series: FeedStorySeries): string {
  const { generated_at: _generatedAt, revision: _revision, ...content } = series;
  return createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 12);
}

/** 季ファイルの feed 上のパス（base URL からの相対）。index の path と一致する。 */
export const storyFeedPath = (seriesId: string): string => feedRelPath('stories', `${seriesId}.json`);

/**
 * 1季ぶんの feed ファイル。published でない季は null。
 * 載るのは published の話だけ（台帳の不変条件により、第1話から連続している）。
 * 本文は normalizeStoryBody を通す。generation（どのモデルで下書きしたか）は
 * 制作側の記録なので出さない。
 */
export function buildStorySeries(source: StorySource, now: string): FeedStorySeries | null {
  const { manifest } = source;
  if (manifest.status !== 'published') return null;

  const episodes = manifest.episodes
    .filter((episode) => episode.status === 'published')
    .map((episode) => {
      const body = source.bodies[episode.order];
      if (!body || !body.ja.trim() || !body.en.trim()) {
        throw new Error(`${episode.id} は published ですが本文（ja / en）が揃っていません`);
      }
      if (!episode.title) {
        throw new Error(`${episode.id} は published ですが title がありません`);
      }
      return {
        id: episode.id,
        order: episode.order,
        required_progress: episode.required_progress,
        title: episode.title,
        ...(episode.summary ? { summary: episode.summary } : {}),
        ...(episode.format ? { format: episode.format } : {}),
        body: { ja: normalizeStoryBody(body.ja), en: normalizeStoryBody(body.en) },
      };
    });

  // スキーマを通すと、キーの順序がスキーマの形に揃う。revision はその順序で数える。
  const draft = FeedStorySeriesSchema.parse({
    schema_version: STORIES_SCHEMA_VERSION,
    generated_at: now,
    id: manifest.id,
    character_id: manifest.character_id,
    season: manifest.season,
    title: manifest.title,
    ...(manifest.summary ? { summary: manifest.summary } : {}),
    status: 'published',
    path: storyFeedPath(manifest.id),
    revision: '000000000000',
    episodes,
  });
  return FeedStorySeriesSchema.parse({ ...draft, revision: storyRevision(draft) });
}

/**
 * index.json。人物ごとの公開済みの季。人物は CHARACTER_IDS 順、季は season 順。
 * 公開が1本も無くても書く（`characters: {}`）——アプリが「取得失敗」と
 * 「まだ無い」を区別できるように。話の要約は {id, order, required_progress, title}
 * だけで、本文は季ファイルにある。
 */
export function buildStoriesIndex(series: FeedStorySeries[], now: string): FeedStoriesIndex {
  const characters: Partial<Record<CharacterId, { series: unknown[] }>> = {};

  for (const id of CHARACTER_IDS) {
    const mine = series.filter((s) => s.character_id === id).sort((a, b) => a.season - b.season);
    if (mine.length === 0) continue;
    characters[id] = {
      series: mine.map((s) => ({
        id: s.id,
        character_id: s.character_id,
        season: s.season,
        title: s.title,
        ...(s.summary ? { summary: s.summary } : {}),
        path: s.path,
        revision: s.revision,
        episode_count: s.episodes.length,
        episodes: s.episodes.map((e) => ({
          id: e.id,
          order: e.order,
          required_progress: e.required_progress,
          title: e.title,
        })),
      })),
    };
  }

  return FeedStoriesIndexSchema.parse({
    schema_version: STORIES_SCHEMA_VERSION,
    generated_at: now,
    characters,
  });
}

/** ソース一式から、公開する季ファイル群と index を組む。 */
export function buildStoriesFeed(
  sources: StorySource[],
  now: string,
): { index: FeedStoriesIndex; series: FeedStorySeries[] } {
  const series = sources
    .map((source) => buildStorySeries(source, now))
    .filter((s): s is FeedStorySeries => s !== null);
  return { index: buildStoriesIndex(series, now), series };
}

/** 季ファイルの名前（`<series-id>.json`）か。index.json などは含まない。 */
export const isStorySeriesFileName = (name: string): boolean =>
  name.endsWith('.json') && STORY_SERIES_ID.test(name.slice(0, -'.json'.length));

/**
 * いまディスクにある季ファイルの、公開済みの話の ID。
 * 壊れて読めないファイルは数えない（書き直す対象であり、アプリも読めない）。
 */
export function publishedEpisodeIdsOnDisk(dir: string): string[] {
  if (!existsSync(dir)) return [];

  const ids: string[] = [];
  for (const name of readdirSync(dir).filter(isStorySeriesFileName).sort()) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')) as {
        episodes?: Array<{ id?: unknown }>;
      };
      for (const episode of parsed.episodes ?? []) {
        if (typeof episode.id === 'string') ids.push(episode.id);
      }
    } catch {
      // 読めないファイルは公開済みの証拠にならない。
    }
  }
  return ids;
}

/**
 * 再ロック防止。いまディスクで公開されている話のうち、これから書く series から
 * 消えてしまうものの ID。
 *
 * 一度公開した話は、アプリで読み終えた人がいる。published → reviewed への
 * 戻しや季ごとの取り下げを、ソースの手違いや rebase の巻き戻りで黙って通すと、
 * 読めていた話が翌日ロックに戻る。意図した取り下げだけを --allow-withdraw で通す。
 */
export function withdrawnEpisodeIds(dir: string, series: FeedStorySeries[]): string[] {
  const next = new Set(series.flatMap((s) => s.episodes.map((e) => e.id)));
  return publishedEpisodeIdsOnDisk(dir).filter((id) => !next.has(id));
}
