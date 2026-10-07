import { describe, it, expect, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../../src/lib/paths.js';
import {
  buildStoriesFeed,
  buildStoriesIndex,
  buildStorySeries,
  collectStorySources,
  isStorySeriesFileName,
  publishedEpisodeIdsOnDisk,
  storyRevision,
  withdrawnEpisodeIds,
  type StorySource,
} from '../../src/export/stories.js';
import {
  FEED_SIZE_LIMITS,
  FeedStoriesIndexSchema,
  FeedStorySeriesSchema,
} from '../../src/schemas/feed.js';
import { secretLeaksInJson } from '../../src/lib/secrets.js';
import { writeStable } from '../../src/lib/stable-json.js';
import { CHARACTER_IDS } from '../../src/schemas/world.js';

/**
 * Story feed の組み立て。ソースはフィクスチャ（tests/fixtures/stories/）——
 * リコ（published ×3 / reviewed ×1 / draft ×1）とテオ（published ×2）のダミーの季。
 * 実データ（characters/<id>/stories/）の中身には依存しない。
 */

const FIXTURE_ROOT = join(ROOT, 'tests', 'fixtures', 'stories');
const NOW = '2026-10-04T00:00:00.000Z';
const LATER = '2026-10-05T12:34:56.000Z';

const tmpDirs: string[] = [];
const makeTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'velum-story-export-'));
  tmpDirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

const sources = collectStorySources(FIXTURE_ROOT);
const source = (character: string): StorySource => {
  const found = sources.find((s) => s.manifest.character_id === character);
  if (!found) throw new Error(`フィクスチャに ${character} の季がありません`);
  return found;
};

describe('collectStorySources', () => {
  it('人物ごとの季を CHARACTER_IDS 順に読む', () => {
    const order = sources.map((s) => CHARACTER_IDS.indexOf(s.manifest.character_id));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(sources.map((s) => s.manifest.id)).toEqual(['teo-s01', 'riko-s01']);
  });

  it('本文を読むのは published の話だけ', () => {
    const riko = source('riko');
    expect(Object.keys(riko.bodies).map(Number)).toEqual([1, 2, 3]);
  });

  it('stories/ の無いルートは空', () => {
    expect(collectStorySources(makeTmp())).toEqual([]);
  });

  it('published の話の本文（en）が無ければ、そのファイル名を添えて止まる', () => {
    const root = makeTmp();
    cpSync(FIXTURE_ROOT, root, { recursive: true });
    unlinkSync(join(root, 'characters', 'riko', 'stories', 's01', 'e02.en.md'));
    expect(() => collectStorySources(root)).toThrow(/e02\.en\.md/);
  });

  it('published の話の本文（ja）が無ければ止まる（en で代用しない）', () => {
    const root = makeTmp();
    cpSync(FIXTURE_ROOT, root, { recursive: true });
    unlinkSync(join(root, 'characters', 'teo', 'stories', 's01', 'e01.ja.md'));
    expect(() => collectStorySources(root)).toThrow(/e01\.ja\.md/);
  });

  it('台帳が壊れていれば、パスを添えて止まる', () => {
    const root = makeTmp();
    cpSync(FIXTURE_ROOT, root, { recursive: true });
    const manifest = join(root, 'characters', 'teo', 'stories', 's01', 'manifest.yaml');
    writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('required_progress', 'required_progres'));
    expect(() => collectStorySources(root)).toThrow(/characters\/teo\/stories\/s01\/manifest\.yaml/);
  });

  it('台帳の character_id / season が置き場所と食い違えば止まる', () => {
    const root = makeTmp();
    cpSync(FIXTURE_ROOT, root, { recursive: true });
    const from = join(root, 'characters', 'teo', 'stories', 's01');
    const to = join(root, 'characters', 'teo', 'stories', 's02');
    cpSync(from, to, { recursive: true });
    expect(() => collectStorySources(root)).toThrow(/食い違っています/);
  });

  it('published でない季の本文は、無くても読み込みで止まらない', () => {
    const root = makeTmp();
    const dir = join(root, 'characters', 'riko', 'stories', 's01');
    mkdirSync(dir, { recursive: true });
    cpSync(join(FIXTURE_ROOT, 'characters', 'riko', 'stories', 's01', 'manifest.yaml'), join(dir, 'manifest.yaml'));
    const manifest = join(dir, 'manifest.yaml');
    // 季を draft に戻し、話も全て draft にする（本文ファイルは1つも置かない）。
    writeFileSync(
      manifest,
      readFileSync(manifest, 'utf8')
        .replace(/status: (published|reviewed)/g, 'status: draft'),
    );
    const [only] = collectStorySources(root);
    expect(only?.bodies).toEqual({});
  });
});

describe('buildStorySeries', () => {
  const riko = buildStorySeries(source('riko'), NOW)!;

  it('スキーマに合い、feed に載る季は status: published', () => {
    expect(FeedStorySeriesSchema.safeParse(riko).success).toBe(true);
    expect(riko.status).toBe('published');
    expect(riko.schema_version).toBe(1);
    expect(riko.generated_at).toBe(NOW);
    expect(riko.path).toBe('world/feed/stories/riko-s01.json');
  });

  it('published の話だけが載る（reviewed・draft は本文も題も出ない）', () => {
    expect(riko.episodes.map((e) => e.id)).toEqual(['riko-s01-e01', 'riko-s01-e02', 'riko-s01-e03']);

    const serialized = JSON.stringify(riko);
    // e04（reviewed）の題と本文、e05（draft）の id は 1 字も出ない。
    expect(serialized).not.toContain('樽の陰');
    expect(serialized).not.toContain('Behind the Barrels');
    expect(serialized).not.toContain('riko-s01-e04');
    expect(serialized).not.toContain('riko-s01-e05');
    expect(serialized).not.toContain('干物屋');
  });

  it('published でない季は null', () => {
    const draft: StorySource = {
      manifest: {
        ...source('riko').manifest,
        status: 'draft',
        episodes: source('riko').manifest.episodes.map((e) => ({ ...e, status: 'draft' as const })),
      },
      bodies: source('riko').bodies,
    };
    expect(buildStorySeries(draft, NOW)).toBeNull();
  });

  it('話は題・解放条件・形式・本文を持ち、任意欄（summary）は台帳にあるときだけ出る', () => {
    const [e1, e2] = riko.episodes;
    expect(e1?.required_progress).toBe(0);
    expect(e1?.title).toEqual({ ja: 'ミオは何も買わない', en: 'Mio Never Buys Anything' });
    expect(e1?.format).toBe('first_person');
    expect(e1?.summary?.en).toContain('Riko');
    expect(e2?.summary).toBeUndefined();
    expect(Object.keys(e2 ?? {})).not.toContain('summary');
    expect(e1?.body.ja).toContain('ミオ');
    expect(e1?.body.en).toContain('Mio');
  });

  it('制作側の記録（generation）は feed に出ない', () => {
    const base = source('riko');
    const withGeneration: StorySource = {
      ...base,
      manifest: {
        ...base.manifest,
        episodes: base.manifest.episodes.map((e) => ({
          ...e,
          generation: { model: 'secret-model-name', prompt_version: 'p9', generated_at: '2026-09-20T00:00:00.000Z' },
        })),
      },
    };
    const built = buildStorySeries(withGeneration, NOW)!;
    expect(JSON.stringify(built)).not.toContain('secret-model-name');
    expect(JSON.stringify(built)).not.toContain('generation');
  });

  it('本文は正規化される（行末の空白・過剰な空行・前後の空白）', () => {
    const base = source('teo');
    const messy: StorySource = {
      ...base,
      bodies: {
        ...base.bodies,
        1: { ja: '\n\n一行目。  \n二行目。\n\n\n\n三行目。\n\n', en: '  First.   \n\n\n\nSecond.  \n' },
      },
    };
    const built = buildStorySeries(messy, NOW)!;
    expect(built.episodes[0]?.body.ja).toBe('一行目。\n二行目。\n\n三行目。');
    expect(built.episodes[0]?.body.en).toBe('First.\n\nSecond.');
  });

  it('英語の本文が空なら、日本語で代用せず止まる', () => {
    const base = source('teo');
    const broken: StorySource = {
      ...base,
      bodies: { ...base.bodies, 1: { ja: base.bodies[1]!.ja, en: '  \n' } },
    };
    expect(() => buildStorySeries(broken, NOW)).toThrow(/teo-s01-e01/);
  });

  it('本文そのものが無ければ止まる', () => {
    const base = source('teo');
    const { 2: _dropped, ...rest } = base.bodies;
    expect(() => buildStorySeries({ ...base, bodies: rest }, NOW)).toThrow(/teo-s01-e02/);
  });

  it('サイズが上限に収まる', () => {
    expect(Buffer.byteLength(JSON.stringify(riko, null, 2))).toBeLessThanOrEqual(FEED_SIZE_LIMITS.story);
  });
});

describe('revision', () => {
  const series = buildStorySeries(source('riko'), NOW)!;

  it('12桁の16進で、generated_at と revision を除いた内容の sha256 先頭12桁', () => {
    expect(series.revision).toMatch(/^[0-9a-f]{12}$/);

    const { generated_at: _g, revision: _r, ...content } = series;
    const expected = createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 12);
    expect(series.revision).toBe(expected);
    expect(storyRevision(series)).toBe(expected);
  });

  it('now が違っても変わらない（決定的）', () => {
    const again = buildStorySeries(source('riko'), LATER)!;
    expect(again.generated_at).toBe(LATER);
    expect(again.revision).toBe(series.revision);
    expect(JSON.stringify({ ...again, generated_at: '' })).toBe(JSON.stringify({ ...series, generated_at: '' }));
  });

  it('本文が1字変わると変わる', () => {
    const base = source('riko');
    const edited: StorySource = {
      ...base,
      bodies: { ...base.bodies, 2: { ja: base.bodies[2]!.ja + 'あ', en: base.bodies[2]!.en } },
    };
    expect(buildStorySeries(edited, NOW)!.revision).not.toBe(series.revision);
  });

  it('解放条件が変わっても変わる（アプリが取り直すべき変更）', () => {
    const base = source('riko');
    const edited: StorySource = {
      ...base,
      manifest: {
        ...base.manifest,
        episodes: base.manifest.episodes.map((e) => (e.order === 3 ? { ...e, required_progress: 6 } : e)),
      },
    };
    expect(buildStorySeries(edited, NOW)!.revision).not.toBe(series.revision);
  });

  it('reviewed の話の本文が変わっても変わらない（feed に出ないものは版に入らない）', () => {
    const base = source('riko');
    const edited: StorySource = {
      ...base,
      bodies: { ...base.bodies, 4: { ja: 'まだ公開されない本文。', en: 'Not public yet.' } },
    };
    expect(buildStorySeries(edited, NOW)!.revision).toBe(series.revision);
  });
});

describe('buildStoriesIndex', () => {
  const { index, series } = buildStoriesFeed(sources, NOW);

  it('スキーマに合い、サイズが上限に収まる', () => {
    expect(FeedStoriesIndexSchema.safeParse(index).success).toBe(true);
    expect(index.schema_version).toBe(1);
    expect(Buffer.byteLength(JSON.stringify(index, null, 2))).toBeLessThanOrEqual(FEED_SIZE_LIMITS.storiesIndex);
  });

  it('人物は CHARACTER_IDS 順、公開のある人物だけ', () => {
    expect(Object.keys(index.characters)).toEqual(['teo', 'riko']);
  });

  it('季の要約は季ファイルと同じ id・題・path・revision を持つ', () => {
    for (const s of series) {
      const summary = index.characters[s.character_id]?.series.find((x) => x.id === s.id);
      expect(summary).toBeDefined();
      expect(summary?.revision).toBe(s.revision);
      expect(summary?.path).toBe(s.path);
      expect(summary?.title).toEqual(s.title);
      expect(summary?.season).toBe(s.season);
      expect(summary?.episode_count).toBe(s.episodes.length);
    }
  });

  it('話の要約は id・order・required_progress・title だけ（本文を含まない）', () => {
    const riko = index.characters.riko!.series[0]!;
    expect(riko.episodes).toHaveLength(3);
    for (const episode of riko.episodes) {
      expect(Object.keys(episode)).toEqual(['id', 'order', 'required_progress', 'title']);
    }
    expect(riko.episodes.map((e) => e.required_progress)).toEqual([0, 2, 5]);
  });

  it('公開が1本も無いときも書ける（characters: {}）', () => {
    const empty = buildStoriesIndex([], NOW);
    expect(empty.characters).toEqual({});
    expect(FeedStoriesIndexSchema.safeParse(empty).success).toBe(true);
  });

  it('同じ人物の季は season 順に並ぶ', () => {
    const base = buildStorySeries(source('teo'), NOW)!;
    const second = { ...base, id: 'teo-s02', season: 2, path: 'world/feed/stories/teo-s02.json' };
    const built = buildStoriesIndex([second, base], NOW);
    expect(built.characters.teo?.series.map((s) => s.season)).toEqual([1, 2]);
  });

  it('draft の季しか無ければ index は空', () => {
    const draft: StorySource = {
      manifest: {
        ...source('teo').manifest,
        status: 'draft',
        episodes: source('teo').manifest.episodes.map((e) => ({ ...e, status: 'draft' as const })),
      },
      bodies: {},
    };
    expect(buildStoriesFeed([draft], NOW).index.characters).toEqual({});
  });

  it('秘匿情報が混じらない（デコードした文字列値でも）', () => {
    expect(secretLeaksInJson(JSON.stringify(index))).toEqual([]);
    for (const s of series) expect(secretLeaksInJson(JSON.stringify(s, null, 2))).toEqual([]);
  });
});

describe('writeStable（書き出しの「変わっていない」判定）', () => {
  it('generated_at だけが違うなら unchanged、中身が違えば written', () => {
    const dir = makeTmp();
    const file = join(dir, 'riko-s01.json');
    const first = buildStorySeries(source('riko'), NOW)!;

    expect(writeStable(file, first)).toBe('written');
    expect(writeStable(file, buildStorySeries(source('riko'), LATER)!)).toBe('unchanged');
    // generated_at は古いまま（書き直していない）。
    expect(JSON.parse(readFileSync(file, 'utf8')).generated_at).toBe(NOW);

    const base = source('riko');
    const edited = buildStorySeries(
      { ...base, bodies: { ...base.bodies, 1: { ja: base.bodies[1]!.ja + 'あ', en: base.bodies[1]!.en } } },
      LATER,
    )!;
    expect(writeStable(file, edited)).toBe('written');
    expect(JSON.parse(readFileSync(file, 'utf8')).generated_at).toBe(LATER);
  });

  it('壊れたファイルは書き直す', () => {
    const dir = makeTmp();
    const file = join(dir, 'x.json');
    writeFileSync(file, '{ broken');
    expect(writeStable(file, { generated_at: NOW, a: 1 })).toBe('written');
    expect(existsSync(file)).toBe(true);
  });
});

describe('再ロック防止の素材', () => {
  it('季ファイルの名前だけを季ファイルと数える（index.json は数えない）', () => {
    expect(isStorySeriesFileName('riko-s01.json')).toBe(true);
    expect(isStorySeriesFileName('index.json')).toBe(false);
    expect(isStorySeriesFileName('riko-s1.json')).toBe(false);
    expect(isStorySeriesFileName('riko-s01.md')).toBe(false);
  });

  const writeFeed = (dir: string, built: ReturnType<typeof buildStoriesFeed>) => {
    writeStable(join(dir, 'index.json'), built.index);
    for (const s of built.series) writeStable(join(dir, `${s.id}.json`), s);
  };

  it('ディスクの公開済みの話を数え、書く内容から消える話を返す', () => {
    const dir = makeTmp();
    const built = buildStoriesFeed(sources, NOW);
    writeFeed(dir, built);

    expect(publishedEpisodeIdsOnDisk(dir).sort()).toEqual(
      [
        'riko-s01-e01',
        'riko-s01-e02',
        'riko-s01-e03',
        'teo-s01-e01',
        'teo-s01-e02',
      ].sort(),
    );
    // 同じ内容を書き直すなら消える話は無い。
    expect(withdrawnEpisodeIds(dir, built.series)).toEqual([]);
    // 書く内容からテオの季が無くなるなら、テオの話が消える話として挙がる。
    expect(withdrawnEpisodeIds(dir, built.series.filter((s) => s.character_id === 'riko'))).toEqual([
      'teo-s01-e01',
      'teo-s01-e02',
    ]);
  });

  it('話が1つ減っても（公開の取り下げ）検出する', () => {
    const dir = makeTmp();
    writeFeed(dir, buildStoriesFeed(sources, NOW));

    const base = source('riko');
    const shrunk: StorySource = {
      ...base,
      manifest: {
        ...base.manifest,
        episodes: base.manifest.episodes.map((e) => (e.order === 3 ? { ...e, status: 'reviewed' as const } : e)),
      },
    };
    const next = buildStoriesFeed([source('teo'), shrunk], NOW);
    expect(withdrawnEpisodeIds(dir, next.series)).toEqual(['riko-s01-e03']);
  });

  it('feed の無いディレクトリ・壊れたファイルは公開済みの証拠にならない', () => {
    expect(publishedEpisodeIdsOnDisk(join(makeTmp(), 'nothing'))).toEqual([]);

    const dir = makeTmp();
    writeFileSync(join(dir, 'riko-s01.json'), '{ broken');
    expect(publishedEpisodeIdsOnDisk(dir)).toEqual([]);
  });
});
