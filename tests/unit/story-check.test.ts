import { describe, it, expect, afterAll } from 'vitest';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { ROOT } from '../../src/lib/paths.js';
import { checkStoriesConfig, checkStoriesFeed, checkStorySources } from '../../src/story/check.js';
import { buildStoriesFeed, collectStorySources } from '../../src/export/stories.js';
import { forbiddenSecretSegments } from '../../src/lib/secrets.js';
import { writeJson } from '../../src/lib/storage.js';
import { FEED_SIZE_LIMITS, FeedStorySeriesSchema } from '../../src/schemas/feed.js';
import { StoryPlanSchema } from '../../src/schemas/story.js';

/**
 * validate が呼ぶ Story の検査。一時ディレクトリへフィクスチャ（tests/fixtures/stories/）を
 * 写して壊し、期待した違反が（相対パス付きで）返ることを見る。
 * 壊す前の写しは違反ゼロであること——ここが赤なら、検査かフィクスチャのどちらかが壊れている。
 */

const FIXTURE_ROOT = join(ROOT, 'tests', 'fixtures', 'stories');
const NOW = '2026-10-04T00:00:00.000Z';

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

/** フィクスチャの写し。書き換えてよい。 */
function copyRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'velum-story-check-'));
  tmpDirs.push(root);
  cpSync(FIXTURE_ROOT, root, { recursive: true });
  return root;
}

const seasonDir = (root: string, character: string) =>
  join(root, 'characters', character, 'stories', 's01');
const rikoFile = (root: string, name: string) => join(seasonDir(root, 'riko'), name);
const edit = (path: string, change: (text: string) => string) =>
  writeFileSync(path, change(readFileSync(path, 'utf8')));

const joined = (problems: string[]) => problems.join('\n');

/** 本物の秘密の断片（本文へ混ぜる用）。文面はテストに書き写さない。 */
const secret = forbiddenSecretSegments().find((s) => s.owner === 'riko')!;

describe('checkStorySources', () => {
  it('フィクスチャの写しは違反ゼロ', () => {
    expect(checkStorySources(copyRoot())).toEqual([]);
  });

  it('stories/ の無いルートは問題なし', () => {
    const root = mkdtempSync(join(tmpdir(), 'velum-story-check-'));
    tmpDirs.push(root);
    expect(checkStorySources(root)).toEqual([]);
  });

  it('e1.ja.md のような名前の typo を、パス付きで落とす', () => {
    const root = copyRoot();
    writeFileSync(rikoFile(root, 'e1.ja.md'), '朝の市で荷車を引いた。');
    const problems = checkStorySources(root);
    expect(joined(problems)).toContain('characters/riko/stories/s01/e1.ja.md');
    expect(joined(problems)).toContain('想定外のファイル');
  });

  it('OS のメタデータ（.DS_Store）は、季のディレクトリでも stories/ 直下でも無視する', () => {
    const root = copyRoot();
    writeFileSync(rikoFile(root, '.DS_Store'), 'x');
    writeFileSync(join(root, 'characters', 'riko', 'stories', '.DS_Store'), 'x');
    expect(checkStorySources(root)).toEqual([]);

    // 名前が完全に一致するものだけ。ほかの隠しファイルや、似た名前は、これまでどおり落とす
    writeFileSync(rikoFile(root, '.DS_Store.bak'), 'x');
    writeFileSync(rikoFile(root, '.gitkeep'), 'x');
    const problems = joined(checkStorySources(root));
    expect(problems).toContain('characters/riko/stories/s01/.DS_Store.bak');
    expect(problems).toContain('characters/riko/stories/s01/.gitkeep');
    expect(problems).not.toContain('s01/.DS_Store:');
  });

  it('季のディレクトリにサブディレクトリを置けない', () => {
    const root = copyRoot();
    mkdirSync(join(seasonDir(root, 'riko'), 'old'));
    expect(joined(checkStorySources(root))).toContain('ファイルだけを置けます');
  });

  it('stories/ 直下に s<NN> 以外を置けない（README.md は可）', () => {
    const root = copyRoot();
    const stories = join(root, 'characters', 'riko', 'stories');
    writeFileSync(join(stories, 'README.md'), '説明');
    expect(checkStorySources(root)).toEqual([]);

    mkdirSync(join(stories, 'drafts'));
    writeFileSync(join(stories, 'notes.txt'), 'x');
    const problems = joined(checkStorySources(root));
    expect(problems).toContain('characters/riko/stories/drafts');
    expect(problems).toContain('characters/riko/stories/notes.txt');
  });

  it('台帳が無い季を落とす', () => {
    const root = copyRoot();
    unlinkSync(rikoFile(root, 'manifest.yaml'));
    expect(joined(checkStorySources(root))).toContain('characters/riko/stories/s01/manifest.yaml: 台帳が存在しません');
  });

  it('台帳の打ち間違い（strict）を、パス付きで落とす', () => {
    const root = copyRoot();
    edit(rikoFile(root, 'manifest.yaml'), (t) => t.replace('required_progress: 2', 'required_progres: 2'));
    const problems = joined(checkStorySources(root));
    expect(problems).toContain('characters/riko/stories/s01/manifest.yaml');
    expect(problems).toContain('required_progres');
  });

  it('台帳の season がディレクトリ名と合わない', () => {
    const root = copyRoot();
    edit(rikoFile(root, 'manifest.yaml'), (t) =>
      t.replaceAll('riko-s01', 'riko-s02').replace('season: 1', 'season: 2'),
    );
    expect(joined(checkStorySources(root))).toContain('season が 2 になっています（ディレクトリは s01）');
  });

  it('reviewed の話の本文（en）が無ければ落とす', () => {
    const root = copyRoot();
    unlinkSync(rikoFile(root, 'e04.en.md'));
    const problems = joined(checkStorySources(root));
    expect(problems).toContain('characters/riko/stories/s01/e04.en.md');
    expect(problems).toContain('reviewed');
  });

  it('published の話の本文（ja）が無ければ落とす', () => {
    const root = copyRoot();
    unlinkSync(rikoFile(root, 'e01.ja.md'));
    expect(joined(checkStorySources(root))).toContain('e01.ja.md: riko-s01-e01 は published');
  });

  it('draft の話は本文が無くてよい（フィクスチャの e05）', () => {
    expect(joined(checkStorySources(copyRoot()))).not.toContain('e05');
  });

  it('台帳に無い話の本文を落とす', () => {
    const root = copyRoot();
    writeFileSync(rikoFile(root, 'e09.ja.md'), '誰も読まない話。');
    expect(joined(checkStorySources(root))).toContain('e09.ja.md: manifest に第9話がありません');
  });

  it('本文の書式違反を落とす（Markdown の見出し・日本語でない ja）', () => {
    const root = copyRoot();
    edit(rikoFile(root, 'e02.ja.md'), (t) => `# 金貨三枚\n\n${t}`);
    writeFileSync(rikoFile(root, 'e03.ja.md'), 'It was a quiet market morning and nothing happened at all.');
    const problems = joined(checkStorySources(root));
    expect(problems).toContain('e02.ja.md: Markdown の見出し');
    expect(problems).toContain('e03.ja.md: 日本語の本文に見えません');
  });

  it('draft の本文に秘密の一文が混じっていたら落とす（公開リポジトリである）', () => {
    const root = copyRoot();
    writeFileSync(
      rikoFile(root, 'e05.ja.md'),
      `あたしは荷車の前で、ひとりごとを言った。\n${secret.segment}\nそれだけの日だった。\n`,
    );
    const problems = joined(checkStorySources(root));
    expect(problems).toContain('characters/riko/stories/s01/e05.ja.md');
    expect(problems).toContain(`${secret.owner} の秘密が混入しています`);
  });

  it('秘密の一文が hard newline で折り返されていても落とす', () => {
    const root = copyRoot();
    const chars = [...secret.segment];
    const half = Math.floor(chars.length / 2);
    writeFileSync(
      rikoFile(root, 'e05.ja.md'),
      `あたしは荷車の前で言った。\n${chars.slice(0, half).join('')}\n${chars.slice(half).join('')}\nそれだけの日だった。\n`,
    );
    expect(joined(checkStorySources(root))).toContain('秘密が混入しています');
  });

  it('台帳の題・要約に秘密が混じっていたら落とす（draft の話の題でも）', () => {
    const root = copyRoot();
    edit(rikoFile(root, 'manifest.yaml'), (t) =>
      t.replace('  - id: riko-s01-e05\n    order: 5', `  - id: riko-s01-e05\n    order: 5\n    summary:\n      ja: ${secret.segment}\n      en: A fine day.`),
    );
    expect(joined(checkStorySources(root))).toContain('manifest.yaml');
    expect(joined(checkStorySources(root))).toContain('秘密が混入しています');
  });

  describe('plan.yaml', () => {
    const plan = (overrides: Record<string, unknown> = {}) => ({
      id: 'riko-s01',
      character_id: 'riko',
      season: 1,
      title: { ja: '売れないもの', en: "Things I Can't Sell" },
      logline: '荷車の行商人の、売れないものをめぐる季。',
      character_arc: { start: '強がる', emotional_change: 'ほどける', end: '値段をつけないものを持つ' },
      relationships: { focus: ['mio'] },
      episodes: [
        {
          order: 1,
          purpose: '隣にいてほしい人だと伝える',
          situation: '朝の市',
          format: 'first_person',
          people: ['mio'],
          working_title: { ja: '仮題', en: 'Working title' },
        },
      ],
      ...overrides,
    });
    const writePlan = (root: string, value: unknown) =>
      writeFileSync(rikoFile(root, 'plan.yaml'), stringify(value));

    it('正しい計画は通る（周りの人は relationships.yaml の people）', () => {
      expect(StoryPlanSchema.safeParse(plan()).success).toBe(true);
      const root = copyRoot();
      writePlan(root, plan({ relationships: { focus: ['mio', 'garon'] } }));
      expect(checkStorySources(root)).toEqual([]);
    });

    it('relationships.yaml に無い人物を、focus と話ごとの people の両方で落とす', () => {
      const root = copyRoot();
      const base = plan();
      writePlan(
        root,
        plan({
          relationships: { focus: ['mio', 'zorro'] },
          episodes: [{ ...base.episodes[0], people: ['mio', 'nobody'] }],
        }),
      );
      const problems = joined(checkStorySources(root));
      expect(problems).toContain('characters/riko/stories/s01/plan.yaml');
      expect(problems).toContain('zorro');
      expect(problems).toContain('nobody');
      expect(problems).not.toContain('の mio は');
    });

    it('他の人物の周りの人は使えない（riko の計画に teo の vallen）', () => {
      const root = copyRoot();
      writePlan(root, plan({ relationships: { focus: ['vallen'] } }));
      expect(joined(checkStorySources(root))).toContain('vallen');
    });

    it('id・character_id・season がディレクトリと合わない計画を落とす', () => {
      const root = copyRoot();
      writePlan(root, plan({ id: 'riko-s02', season: 2 }));
      const problems = joined(checkStorySources(root));
      expect(problems).toContain('id が riko-s02 になっています（riko-s01 のはず）');
      expect(problems).toContain('season が 2 になっています');
    });

    it('スキーマ違反の計画を落とす', () => {
      const root = copyRoot();
      writePlan(root, plan({ logline: '' }));
      expect(joined(checkStorySources(root))).toContain('plan.yaml: logline');
    });
  });
});

describe('checkStoriesConfig', () => {
  const ladder = [0, 2, 5, 9, 14, 20, 27, 35, 44, 54, 65, 77];
  const writeConfig = (value: unknown): string => {
    const root = mkdtempSync(join(tmpdir(), 'velum-story-check-'));
    tmpDirs.push(root);
    mkdirSync(join(root, 'world'));
    writeFileSync(join(root, 'world', 'stories.yaml'), stringify(value));
    return root;
  };

  it('正しい既定値は通る', () => {
    expect(checkStoriesConfig(writeConfig({ default_episode_count: 8, default_required_progress: ladder }))).toEqual([]);
  });

  it('階段が崩れていれば、パス付きで落とす', () => {
    const broken = [...ladder];
    broken[4] = 1;
    const problems = checkStoriesConfig(writeConfig({ default_episode_count: 8, default_required_progress: broken }));
    expect(joined(problems)).toContain('world/stories.yaml');
    expect(joined(problems)).toContain('単調非減少');
  });

  it('ファイルが無ければ落とす', () => {
    const root = mkdtempSync(join(tmpdir(), 'velum-story-check-'));
    tmpDirs.push(root);
    expect(joined(checkStoriesConfig(root))).toContain('world/stories.yaml');
  });

  it('実リポジトリの既定値が検査を通る', () => {
    expect(checkStoriesConfig(ROOT)).toEqual([]);
  });
});

describe('checkStoriesFeed', () => {
  /** ソースの写しと、そこから書き出した feed を持つルート。 */
  function exportedRoot(): { root: string; feedDir: string } {
    const root = copyRoot();
    const feedDir = join(root, 'world', 'feed', 'stories');
    const built = buildStoriesFeed(collectStorySources(root), NOW);
    writeJson(join(feedDir, 'index.json'), built.index);
    for (const series of built.series) writeJson(join(feedDir, `${series.id}.json`), series);
    return { root, feedDir };
  }
  const readSeries = (feedDir: string, id: string) =>
    JSON.parse(readFileSync(join(feedDir, `${id}.json`), 'utf8')) as Record<string, any>;

  it('書き出したばかりの feed は違反ゼロ', () => {
    const { root, feedDir } = exportedRoot();
    expect(checkStoriesFeed(feedDir, root)).toEqual([]);
  });

  it('公開が0本の feed（characters: {}）も違反ゼロ', () => {
    const root = mkdtempSync(join(tmpdir(), 'velum-story-check-'));
    tmpDirs.push(root);
    const feedDir = join(root, 'world', 'feed', 'stories');
    writeJson(join(feedDir, 'index.json'), buildStoriesFeed([], NOW).index);
    expect(checkStoriesFeed(feedDir, root)).toEqual([]);
  });

  it('index.json が無ければ落とす（空でも書く契約）', () => {
    const { root, feedDir } = exportedRoot();
    unlinkSync(join(feedDir, 'index.json'));
    expect(joined(checkStoriesFeed(feedDir, root))).toContain('world/feed/stories/index.json: index がありません');
  });

  it('index に載っていない季ファイル（orphan）を落とす', () => {
    const { root, feedDir } = exportedRoot();
    cpSync(join(feedDir, 'riko-s01.json'), join(feedDir, 'uta-s01.json'));
    const problems = joined(checkStoriesFeed(feedDir, root));
    expect(problems).toContain('world/feed/stories/uta-s01.json: index.json に載っていない季ファイルです');
  });

  it('index が指す季ファイルが無ければ落とす', () => {
    const { root, feedDir } = exportedRoot();
    unlinkSync(join(feedDir, 'teo-s01.json'));
    expect(joined(checkStoriesFeed(feedDir, root))).toContain('teo-s01 が指す world/feed/stories/teo-s01.json が存在しません');
  });

  it('ソースを直して書き出し忘れると、素材との食い違いとして落とす', () => {
    const { root, feedDir } = exportedRoot();
    edit(rikoFile(root, 'e01.ja.md'), (t) => `${t}\n\n追記した一段落。`);
    const problems = checkStoriesFeed(feedDir, root);
    expect(joined(problems)).toContain('world/feed/stories/riko-s01.json: 素材と食い違っています。npm run export:feed で作り直してください');
    // index の revision も変わるはずなので、index も食い違う。
    expect(joined(problems)).toContain('world/feed/stories/index.json: 素材と食い違っています');
    // 触っていないテオの季は食い違わない。
    expect(joined(problems)).not.toContain('teo-s01.json: 素材と食い違っています');
  });

  it('公開済みの話をソースで reviewed に戻して書き出さないと、食い違いとして落とす', () => {
    const { root, feedDir } = exportedRoot();
    edit(rikoFile(root, 'manifest.yaml'), (t) =>
      t.replace(/(id: riko-s01-e03[\s\S]*?status: )published/, '$1reviewed'),
    );
    expect(joined(checkStoriesFeed(feedDir, root))).toContain('素材と食い違っています');
  });

  it('generated_at だけが違う feed は食い違いと数えない', () => {
    const { root, feedDir } = exportedRoot();
    edit(join(feedDir, 'riko-s01.json'), (t) => t.replace(NOW, '2030-01-01T00:00:00.000Z'));
    edit(join(feedDir, 'index.json'), (t) => t.replace(NOW, '2030-01-01T00:00:00.000Z'));
    expect(checkStoriesFeed(feedDir, root)).toEqual([]);
  });

  it('revision が内容と合わなければ落とす', () => {
    const { root, feedDir } = exportedRoot();
    edit(join(feedDir, 'riko-s01.json'), (t) => t.replace(/"revision": "[0-9a-f]{12}"/, '"revision": "000000000000"'));
    const problems = joined(checkStoriesFeed(feedDir, root));
    expect(problems).toContain('riko-s01.json: revision が内容と合いません');
    // index の要約の revision とも食い違う。
    expect(problems).toContain('revision が index.json の要約と食い違っています');
  });

  it('index の要約が季ファイルと食い違えば落とす（題・話数・解放条件）', () => {
    const { root, feedDir } = exportedRoot();
    const indexFile = join(feedDir, 'index.json');
    const index = JSON.parse(readFileSync(indexFile, 'utf8'));
    index.characters.riko.series[0].title.ja = '別の題';
    index.characters.riko.series[0].episode_count = 4;
    index.characters.riko.series[0].episodes[1].required_progress = 3;
    writeJson(indexFile, index);
    const problems = joined(checkStoriesFeed(feedDir, root));
    expect(problems).toContain('title が index.json の要約と食い違っています');
    expect(problems).toContain('episode_count');
    expect(problems).toContain('riko-s01-e02 の required_progress が index.json の要約と食い違っています');
  });

  it('別の人物の下に載った季・path の食い違いを落とす', () => {
    const { root, feedDir } = exportedRoot();
    const indexFile = join(feedDir, 'index.json');
    const index = JSON.parse(readFileSync(indexFile, 'utf8'));
    index.characters.riko.series[0].path = 'world/feed/stories/other.json';
    index.characters.uta = index.characters.teo;
    delete index.characters.teo;
    writeJson(indexFile, index);
    const problems = joined(checkStoriesFeed(feedDir, root));
    expect(problems).toContain('riko-s01 の path が world/feed/stories/other.json');
    expect(problems).toContain('teo-s01 が uta の下に載っています');
  });

  it('スキーマ違反（status が published でない）を落とす', () => {
    const { root, feedDir } = exportedRoot();
    edit(join(feedDir, 'teo-s01.json'), (t) => t.replace('"status": "published"', '"status": "reviewed"'));
    expect(joined(checkStoriesFeed(feedDir, root))).toContain('teo-s01.json: status');
  });

  it('サイズ上限を超えた季ファイルを落とす', () => {
    const { root, feedDir } = exportedRoot();
    const series = readSeries(feedDir, 'riko-s01');
    series.padding = 'あ'.repeat(FEED_SIZE_LIMITS.story);
    writeJson(join(feedDir, 'riko-s01.json'), series);
    expect(joined(checkStoriesFeed(feedDir, root))).toMatch(/riko-s01\.json: \d+ bytes あります/);
  });

  it('壊れた JSON を落とす', () => {
    const { root, feedDir } = exportedRoot();
    writeFileSync(join(feedDir, 'riko-s01.json'), '{ broken');
    expect(joined(checkStoriesFeed(feedDir, root))).toContain('riko-s01.json: JSON を解析できません');
  });

  it('feed の本文に秘密の一文が（折り返されて）混じっていたら落とす', () => {
    const { root, feedDir } = exportedRoot();
    const chars = [...secret.segment];
    const half = Math.floor(chars.length / 2);
    const series = readSeries(feedDir, 'riko-s01');
    series.episodes[0].body.ja += `\n\n${chars.slice(0, half).join('')}\n${chars.slice(half).join('')}`;
    writeJson(join(feedDir, 'riko-s01.json'), series);

    // 生のテキストでは \n が2文字になっているので、デコードした値を見ないと素通りする。
    expect(readFileSync(join(feedDir, 'riko-s01.json'), 'utf8')).toContain('\\n');
    const problems = joined(checkStoriesFeed(feedDir, root));
    expect(problems).toContain('world/feed/stories/riko-s01.json');
    expect(problems).toContain(`${secret.owner} の秘密が混入しています`);
  });

  it('素材から作り直せない（published の本文が無い）ときは、照合の失敗として落とす', () => {
    const { root, feedDir } = exportedRoot();
    unlinkSync(rikoFile(root, 'e02.en.md'));
    expect(joined(checkStoriesFeed(feedDir, root))).toContain('作り直しの照合に失敗しました');
  });

  it('スキーマに合う季ファイルが書けている（テストの土台の確認）', () => {
    const { feedDir } = exportedRoot();
    expect(FeedStorySeriesSchema.safeParse(readSeries(feedDir, 'riko-s01')).success).toBe(true);
  });
});
