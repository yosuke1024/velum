import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT, feedRelPath, feedStorySeriesName, storyEpisodeFileName } from '../lib/paths.js';
import { readYaml } from '../lib/storage.js';
import { bothForReaders, type Bilingual } from '../lib/bilingual.js';
import { CHARACTER_IDS } from '../schemas/world.js';
import {
  STORY_FEED_SCHEMA_VERSION,
  StoryManifestSchema,
  FeedStorySeriesSchema,
  FeedStoriesIndexSchema,
  type StoryManifest,
  type FeedStorySeries,
  type FeedStoriesIndex,
} from '../schemas/story.js';

/**
 * Story feed（world/feed/stories/）の束。
 *
 * 守るものは diary feed（src/export/feed.ts）と同じ——商用アプリの契約面であり、
 * フィールドの削除・改名はしない。違いはひとつ、**published しか出さない**こと。
 * 生成した草稿は manifest に draft として置かれ、人間が読んで status を進めるまで
 * ここを通らない（docs/stories.md §5）。
 *
 * **秘匿情報（core.secret_*・hidden_from_protagonist）はここにも入らない。**
 * 本文は人間がレビューしてから published にする前提だが、`npm run validate` が
 * 書き出したファイルを断片照合で検査する（src/lib/secrets.ts）。
 */

export type StorySource = {
  manifest: StoryManifest;
  /** manifest.yaml のあるディレクトリ（絶対パス）。本文はこの下にある。 */
  dir: string;
  /** root からの相対。エラーメッセージ用。 */
  rel: string;
};

const STORY_SEASON_DIR = /^s(\d{2})$/;

/**
 * characters/<id>/stories/sNN/manifest.yaml を全部読む。
 * root を差し替えられるのは、フィクスチャ（tests/fixtures/stories/）を同じ
 * ビルダーで束ねるためである。
 */
export function listStorySources(root: string = ROOT): StorySource[] {
  const sources: StorySource[] = [];

  for (const id of CHARACTER_IDS) {
    const storiesRoot = join(root, 'characters', id, 'stories');
    if (!existsSync(storiesRoot)) continue;

    for (const name of readdirSync(storiesRoot).sort()) {
      const match = STORY_SEASON_DIR.exec(name);
      if (!match) continue;
      const dir = join(storiesRoot, name);
      const manifestPath = join(dir, 'manifest.yaml');
      if (!existsSync(manifestPath)) continue;

      const manifest = readYaml(manifestPath, StoryManifestSchema);
      const rel = relative(root, dir);
      if (manifest.character_id !== id) {
        throw new Error(`${rel}/manifest.yaml: character_id が ${manifest.character_id} になっています（ディレクトリは ${id}）`);
      }
      if (manifest.season !== Number(match[1])) {
        throw new Error(`${rel}/manifest.yaml: season が ${manifest.season} になっています（ディレクトリは ${name}）`);
      }
      sources.push({ manifest, dir, rel });
    }
  }

  return sources;
}

/**
 * 本文ファイルの先頭に YAML 風の front matter（--- で囲んだ塊）があれば捨てる。
 * 本文はプレーンテキストが正で、front matter は人間がメモを残すための余白である。
 */
export function splitStoryFrontMatter(markdown: string): string {
  const match = /^---\n[\s\S]*?\n---\n([\s\S]*)$/.exec(markdown);
  return (match ? match[1] ?? '' : markdown).trim();
}

/** 本文の整形。段落の空行区切りは保ち、3行以上の空行だけ詰める（diary feed と同じ）。 */
const normalizeBody = (text: string): string => text.trim().replace(/\n{3,}/g, '\n\n');

export function readStoryBody(dir: string, order: number, lang: 'ja' | 'en'): string | null {
  const path = join(dir, storyEpisodeFileName(order, lang));
  if (!existsSync(path)) return null;
  const body = splitStoryFrontMatter(readFileSync(path, 'utf8'));
  return body.length ? body : null;
}

/** 公開してよい話だけ。manifest と episode の両方が published であること。 */
export function publishedEpisodesOf(manifest: StoryManifest): StoryManifest['episodes'] {
  if (manifest.status !== 'published') return [];
  return manifest.episodes.filter((episode) => episode.status === 'published');
}

/**
 * 1季ぶんの feed。公開する話が無ければ null（index にも載らない）。
 *
 * published の話に本文が無いのはデータ不整合なので、落とすのではなく止める。
 * 英語も必須——読み手は 1言語 = 1画面であり、英語の画面に日本語が出るのは
 * 見える欠陥である（src/schemas/bilingual.ts の規律）。
 */
export function buildStorySeriesFeed(source: StorySource, now: string): FeedStorySeries | null {
  const { manifest, dir, rel } = source;
  const published = publishedEpisodesOf(manifest);
  if (!published.length) return null;

  const episodes = published.map((episode) => {
    const ja = readStoryBody(dir, episode.order, 'ja');
    const en = readStoryBody(dir, episode.order, 'en');
    if (!ja) {
      throw new Error(`${rel}: 第${episode.order}話は published ですが本文（ja）がありません`);
    }
    if (!en) {
      throw new Error(`${rel}: 第${episode.order}話は published ですが本文（en）がありません`);
    }
    if (!episode.title) {
      throw new Error(`${rel}: 第${episode.order}話は published ですが title がありません`);
    }
    const body: Bilingual = { ja: normalizeBody(ja), en: normalizeBody(en) };
    return {
      id: episode.id,
      order: episode.order,
      required_progress: episode.required_progress,
      title: bothForReaders(episode.title),
      ...(episode.format ? { format: episode.format } : {}),
      ...(episode.summary ? { summary: bothForReaders(episode.summary) } : {}),
      body,
    };
  });

  return FeedStorySeriesSchema.parse({
    schema_version: STORY_FEED_SCHEMA_VERSION,
    generated_at: now,
    id: manifest.id,
    character_id: manifest.character_id,
    season: manifest.season,
    title: bothForReaders(manifest.title),
    ...(manifest.summary ? { summary: bothForReaders(manifest.summary) } : {}),
    status: 'published',
    path: feedRelPath('stories', feedStorySeriesName(manifest.id)),
    episodes,
  });
}

/** index.json。人物ごとに、公開済みの季を season 順で並べる。公開が無い人物は載らない。 */
export function buildStoriesIndex(series: FeedStorySeries[], now: string): FeedStoriesIndex {
  const characters: FeedStoriesIndex['characters'] = {};

  // 並びは CHARACTER_IDS 順 → season 順で決定的にする。
  for (const id of CHARACTER_IDS) {
    const own = series
      .filter((s) => s.character_id === id)
      .sort((a, b) => a.season - b.season)
      .map((s) => ({
        id: s.id,
        season: s.season,
        title: s.title,
        path: s.path,
        episode_count: s.episodes.length,
      }));
    if (own.length) characters[id] = { series: own };
  }

  return FeedStoriesIndexSchema.parse({
    schema_version: STORY_FEED_SCHEMA_VERSION,
    generated_at: now,
    characters,
  });
}

/** published の季をすべて feed の形へ。index と series をまとめて返す。 */
export function collectStoryFeeds(
  now: string,
  root: string = ROOT,
): { index: FeedStoriesIndex; series: FeedStorySeries[] } {
  const series: FeedStorySeries[] = [];
  for (const source of listStorySources(root)) {
    const built = buildStorySeriesFeed(source, now);
    if (built) series.push(built);
  }
  return { index: buildStoriesIndex(series, now), series };
}
