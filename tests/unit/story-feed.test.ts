import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { ROOT, storiesConfigPath } from '../../src/lib/paths.js';
import { readYaml } from '../../src/lib/storage.js';
import {
  listStorySources,
  buildStorySeriesFeed,
  buildStoriesIndex,
  collectStoryFeeds,
  splitStoryFrontMatter,
  publishedEpisodesOf,
} from '../../src/export/stories.js';
import {
  FeedStorySeriesSchema,
  FeedStoriesIndexSchema,
  StoriesConfigSchema,
  STORY_FEED_SIZE_LIMITS,
} from '../../src/schemas/story.js';
import { secretLeaksIn } from '../../src/lib/secrets.js';

/**
 * Story feed は Riko のフィクスチャ（tests/fixtures/stories/）から組む。
 * 本番の characters/riko/stories/ は draft のうちは feed に出ないので、
 * 公開の形はフィクスチャで見る。
 */
const FIXTURE_ROOT = join(ROOT, 'tests', 'fixtures', 'stories');
const NOW = '2026-10-01T00:00:00.000Z';

describe('Story feed（フィクスチャ）', () => {
  const sources = listStorySources(FIXTURE_ROOT);
  const riko = sources.find((s) => s.manifest.id === 'riko-s01')!;
  const series = buildStorySeriesFeed(riko, NOW)!;

  it('フィクスチャに Riko の第1季がある', () => {
    expect(riko).toBeDefined();
    expect(riko.manifest.status).toBe('published');
    expect(riko.manifest.episodes).toHaveLength(5);
  });

  it('published の話だけが feed に出る（reviewed / draft は出ない）', () => {
    expect(publishedEpisodesOf(riko.manifest).map((e) => e.order)).toEqual([1, 2, 3]);
    expect(series.episodes.map((e) => e.id)).toEqual(['riko-s01-e01', 'riko-s01-e02', 'riko-s01-e03']);
    expect(JSON.stringify(series)).not.toContain('届かない手紙');
    expect(JSON.stringify(series)).not.toContain('riko-s01-e05');
  });

  it('スキーマに合い、path は world/feed/stories/<id>.json', () => {
    expect(() => FeedStorySeriesSchema.parse(series)).not.toThrow();
    expect(series.path).toBe('world/feed/stories/riko-s01.json');
    expect(series.status).toBe('published');
  });

  it('第1話は Progress 0 で読め、以後は単調非減少', () => {
    expect(series.episodes[0]!.required_progress).toBe(0);
    const ladder = series.episodes.map((e) => e.required_progress);
    expect(ladder).toEqual([...ladder].sort((a, b) => a - b));
  });

  it('本文は ja / en を両方運び、段落の空行区切りを保つ', () => {
    const first = series.episodes[0]!;
    expect(first.body.ja).toContain('銅貨十一枚');
    expect(first.body.en).toContain('Eleven copper');
    expect(first.body.ja).toContain('\n\n');
    expect(first.body.en).toContain('\n\n');
  });

  it('front matter は本文に含まれない', () => {
    expect(series.episodes[0]!.body.ja).not.toContain('---');
    expect(series.episodes[0]!.body.ja).not.toContain('フィクスチャ。front matter');
    expect(splitStoryFrontMatter('---\nnote: x\n---\n本文')).toBe('本文');
    expect(splitStoryFrontMatter('本文だけ')).toBe('本文だけ');
  });

  it('format / summary は任意で、あれば運ぶ', () => {
    expect(series.episodes[0]!.format).toBe('first_person');
    expect(series.episodes[0]!.summary?.en).toContain('shelf that never sells');
    expect(series.episodes[1]!.summary).toBeUndefined();
  });

  it('index は published の季だけを人物ごとに載せる', () => {
    const index = buildStoriesIndex([series], NOW);
    expect(() => FeedStoriesIndexSchema.parse(index)).not.toThrow();
    expect(Object.keys(index.characters)).toEqual(['riko']);
    expect(index.characters.riko!.series).toEqual([
      {
        id: 'riko-s01',
        season: 1,
        title: series.title,
        path: 'world/feed/stories/riko-s01.json',
        episode_count: 3,
      },
    ]);
  });

  it('published の季が無ければ index は空の characters', () => {
    const index = buildStoriesIndex([], NOW);
    expect(index.characters).toEqual({});
    expect(() => FeedStoriesIndexSchema.parse(index)).not.toThrow();
  });

  it('collectStoryFeeds は index と series をまとめて返す', () => {
    const { index, series: all } = collectStoryFeeds(NOW, FIXTURE_ROOT);
    expect(all.map((s) => s.id)).toEqual(['riko-s01']);
    expect(index.characters.riko!.series[0]!.episode_count).toBe(3);
  });

  it('サイズ上限に収まる', () => {
    expect(Buffer.byteLength(JSON.stringify(series, null, 2))).toBeLessThanOrEqual(STORY_FEED_SIZE_LIMITS.series);
    expect(Buffer.byteLength(JSON.stringify(buildStoriesIndex([series], NOW), null, 2))).toBeLessThanOrEqual(
      STORY_FEED_SIZE_LIMITS.index,
    );
  });

  it('秘匿情報は混じらない', () => {
    expect(secretLeaksIn(JSON.stringify(series))).toEqual([]);
  });

  it('同じ素材と時刻からは、バイト単位で同じ feed ができる', () => {
    const again = buildStorySeriesFeed(riko, NOW)!;
    expect(JSON.stringify(again)).toBe(JSON.stringify(series));
  });
});

describe('Story feed（草稿の季）', () => {
  it('season が draft なら、話が published でも出ない（スキーマが先に拒む）', () => {
    // manifest 側の不変条件。episode は季より先へ進めない。
    const sources = listStorySources(FIXTURE_ROOT);
    const riko = sources.find((s) => s.manifest.id === 'riko-s01')!;
    const draft = { ...riko, manifest: { ...riko.manifest, status: 'draft' as const } };
    expect(buildStorySeriesFeed(draft, NOW)).toBeNull();
  });

  it('published の話に本文が無ければ止まる（黙って1本消さない）', () => {
    const sources = listStorySources(FIXTURE_ROOT);
    const riko = sources.find((s) => s.manifest.id === 'riko-s01')!;
    const episodes = riko.manifest.episodes.map((e) =>
      e.order === 5 ? { ...e, status: 'published' as const, title: { ja: 'あ', en: 'A' } } : e.order === 4 ? { ...e, status: 'published' as const } : e,
    );
    const missing = { ...riko, manifest: { ...riko.manifest, episodes } };
    expect(() => buildStorySeriesFeed(missing, NOW)).toThrow(/第5話/);
  });
});

describe('world/stories.yaml', () => {
  it('既定の階段がスキーマに合い、第1話は 0', () => {
    const config = readYaml(storiesConfigPath(), StoriesConfigSchema);
    expect(config.default_required_progress[0]).toBe(0);
    expect(config.default_required_progress.length).toBeGreaterThanOrEqual(8);
  });
});

describe('本番の Story（characters/*/stories/）', () => {
  it('manifest がすべてスキーマに合い、ディレクトリと整合する', () => {
    // 草稿しか無い時点でも、manifest 自体は壊れていないことを見る。
    expect(() => listStorySources()).not.toThrow();
  });
});
