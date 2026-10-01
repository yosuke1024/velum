import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, cpSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../../src/lib/paths.js';
import { readYaml } from '../../src/lib/storage.js';
import { StoryManifestSchema, StoryPlanSchema, StoriesConfigSchema } from '../../src/schemas/story.js';
import { planStory, syncManifest, type Generate } from '../../src/story/plan.js';
import { writeStoryEpisode } from '../../src/story/write.js';
import { storyPaths } from '../../src/story/paths.js';
import { collectStoryFeeds } from '../../src/export/stories.js';
import { STORY_TEXT_LIMITS } from '../../src/story/prompt.js';

/**
 * story:plan → story:write → status を進める → feed、の一連を、生成を差し替えて見る。
 * 生成は呼ばない（鍵が要るし、ここで見たいのはその前後の規律である）。
 */

let root: string;

function seedRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'velum-story-'));
  mkdirSync(join(dir, 'characters', 'riko'), { recursive: true });
  for (const file of ['profile.yaml', 'canon.yaml', 'relationships.yaml']) {
    cpSync(join(ROOT, 'characters', 'riko', file), join(dir, 'characters', 'riko', file));
  }
  mkdirSync(join(dir, 'world', 'canon'), { recursive: true });
  for (const file of ['eras.yaml', 'silent.yaml']) {
    cpSync(join(ROOT, 'world', 'canon', file), join(dir, 'world', 'canon', file));
  }
  cpSync(join(ROOT, 'world', 'stories.yaml'), join(dir, 'world', 'stories.yaml'));
  mkdirSync(join(dir, 'tests', 'fixtures', 'voice'), { recursive: true });
  cpSync(join(ROOT, 'tests', 'fixtures', 'voice', 'riko.md'), join(dir, 'tests', 'fixtures', 'voice', 'riko.md'));
  return dir;
}

const planResponse = {
  title_ja: '売れないもの',
  title_en: "Things I Can't Sell",
  summary_ja: '荷車ひとつの行商人の、売れない数日。',
  summary_en: 'A few unsellable days of a one-cart peddler.',
  character_arc: {
    start: '売ることだけを考えている',
    emotional_change: '売れない理由を自分の側に見つけはじめる',
    end: '売らない、と口に出さずに決める',
  },
  relationship_focus: ['mio', 'garon', 'somebody-unknown'],
  episodes: [
    { order: 2, purpose: '値切られて本気で腹を立てる', situation: '裏路地の荷車', format: 'scene', people: [], working_title: '金貨三枚' },
    { order: 1, purpose: 'ミオとの日常', situation: '市の隅', format: 'first_person', people: ['mio', 'nobody'], working_title: 'ミオは何も買わない' },
    { order: 3, purpose: 'ガロンを遠くに見て隠れる', situation: '倉庫街', format: 'haiku', people: ['garon'], working_title: '倉庫の影' },
  ],
};

const fakePlan: Generate = async (_request, schema) => ({
  data: schema.parse(planResponse),
  model: 'fake-model',
  raw: JSON.stringify(planResponse),
});

const writeResponse = (order: number) => ({
  title_ja: `第${order}話の題`,
  title_en: `Title of Episode ${order}`,
  body_ja: `${'市の隅で、あの子がまた来ていた。'.repeat(20)}\n\n銅貨三十が、四十になった。`,
  body_en: `${'She was there again, at the edge of the market. '.repeat(10)}\n\nThirty copper became forty.`,
  summary_ja: `第${order}話の一文。`,
  summary_en: `One line for episode ${order}.`,
});

const fakeWrite =
  (order: number, overrides: Record<string, unknown> = {}): Generate =>
  async (_request, schema) => {
    const data = { ...writeResponse(order), ...overrides };
    return { data: schema.parse(data), model: 'fake-model', raw: JSON.stringify(data) };
  };

beforeEach(() => {
  root = seedRoot();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('story:plan', () => {
  it('plan.yaml と draft の manifest.yaml を書き、階段を写す', async () => {
    const { plan, manifest } = await planStory({
      characterId: 'riko',
      season: 1,
      episodes: 3,
      root,
      generate: fakePlan,
      now: () => '2026-10-01T00:00:00.000Z',
    });
    const paths = storyPaths('riko', 1, root);
    expect(existsSync(paths.plan)).toBe(true);
    expect(existsSync(paths.manifest)).toBe(true);

    // order はこちらで並べ直す。モデルの並びを通さない。
    expect(plan.episodes.map((e) => e.order)).toEqual([1, 2, 3]);
    expect(plan.episodes[0]!.purpose).toBe('ミオとの日常');
    // 知らない人物 id は落ちる。語彙の外の形式は scene に落ちる。
    expect(plan.episodes[0]!.people).toEqual(['mio']);
    expect(plan.episodes[2]!.format).toBe('scene');
    expect(plan.relationships.focus).toEqual(['mio', 'garon']);
    expect(plan.generation?.model).toBe('fake-model');

    const ladder = readYaml(paths.config, StoriesConfigSchema).default_required_progress;
    expect(manifest.status).toBe('draft');
    expect(manifest.episodes.map((e) => e.required_progress)).toEqual(ladder.slice(0, 3));
    expect(manifest.episodes.every((e) => e.status === 'draft')).toBe(true);
    expect(manifest.title).toEqual({ ja: '売れないもの', en: "Things I Can't Sell" });
    expect(manifest.episodes[0]!.id).toBe('riko-s01-e01');
    expect(manifest.episodes[0]!.title).toBeUndefined();

    // 書いたものはスキーマで読める。
    expect(() => readYaml(paths.plan, StoryPlanSchema)).not.toThrow();
    expect(() => readYaml(paths.manifest, StoryManifestSchema)).not.toThrow();
  });

  it('求めた話数と違えば止まる', async () => {
    await expect(
      planStory({ characterId: 'riko', season: 1, episodes: 8, root, generate: fakePlan }),
    ).rejects.toThrow(/8話を求めましたが 3話/);
  });

  it('syncManifest は人間が manifest に書いたものを消さない', async () => {
    const { plan } = await planStory({ characterId: 'riko', season: 1, episodes: 3, root, generate: fakePlan });
    const human = StoryManifestSchema.parse({
      id: 'riko-s01',
      character_id: 'riko',
      season: 1,
      title: { ja: '人間が決めた題', en: 'The Human Title' },
      status: 'reviewed',
      episodes: [
        { id: 'riko-s01-e01', order: 1, required_progress: 0, status: 'reviewed', title: { ja: '一', en: 'One' } },
        { id: 'riko-s01-e02', order: 2, required_progress: 3, status: 'draft' },
        { id: 'riko-s01-e03', order: 3, required_progress: 7, status: 'draft' },
        { id: 'riko-s01-e04', order: 4, required_progress: 12, status: 'draft' },
      ],
    });
    const synced = syncManifest(plan, { title: { ja: 'x', en: 'x' }, summary: { ja: 'y', en: 'y' } }, human, [0, 2, 5, 9]);
    expect(synced.title).toEqual(human.title);
    expect(synced.status).toBe('reviewed');
    expect(synced.episodes[0]!.status).toBe('reviewed');
    expect(synced.episodes[0]!.title).toEqual({ ja: '一', en: 'One' });
    expect(synced.episodes[1]!.required_progress).toBe(3);
    // 計画から消えた第4話は残る（本文があるかもしれない。消すのは人間）。
    expect(synced.episodes.map((e) => e.order)).toEqual([1, 2, 3, 4]);
  });
});

describe('story:write', () => {
  it('本文（ja / en）を書き、manifest の title / summary を埋め、status は draft のまま', async () => {
    await planStory({ characterId: 'riko', season: 1, episodes: 3, root, generate: fakePlan });
    const outcome = await writeStoryEpisode({ characterId: 'riko', season: 1, order: 1, root, generate: fakeWrite(1) });
    expect(outcome.ok).toBe(true);

    const paths = storyPaths('riko', 1, root);
    expect(readFileSync(paths.episode(1, 'ja'), 'utf8')).toContain('銅貨三十が、四十になった。');
    expect(readFileSync(paths.episode(1, 'en'), 'utf8')).toContain('Thirty copper became forty.');

    const manifest = readYaml(paths.manifest, StoryManifestSchema);
    const first = manifest.episodes[0]!;
    expect(first.title).toEqual({ ja: '第1話の題', en: 'Title of Episode 1' });
    expect(first.summary?.ja).toBe('第1話の一文。');
    expect(first.status).toBe('draft');
    expect(manifest.status).toBe('draft');
  });

  it('本文があれば飛ばし、--force で書き直す', async () => {
    await planStory({ characterId: 'riko', season: 1, episodes: 3, root, generate: fakePlan });
    await writeStoryEpisode({ characterId: 'riko', season: 1, order: 1, root, generate: fakeWrite(1) });
    const skipped = await writeStoryEpisode({ characterId: 'riko', season: 1, order: 1, root, generate: fakeWrite(1, { title_ja: '別の題' }) });
    expect(skipped.ok && skipped.skipped).toBe(true);

    const forced = await writeStoryEpisode({ characterId: 'riko', season: 1, order: 1, root, generate: fakeWrite(1, { title_ja: '別の題' }), force: true });
    expect(forced.ok && !forced.skipped && forced.title).toBe('別の題');
  });

  it('構造ゲートに落ちた話は書かれない', async () => {
    await planStory({ characterId: 'riko', season: 1, episodes: 3, root, generate: fakePlan });
    const outcome = await writeStoryEpisode({
      characterId: 'riko',
      season: 1,
      order: 1,
      root,
      generate: fakeWrite(1, { body_ja: 'あ'.repeat(STORY_TEXT_LIMITS.bodyMinJa - 1) }),
    });
    expect(outcome.ok).toBe(false);
    expect(existsSync(storyPaths('riko', 1, root).episode(1, 'ja'))).toBe(false);
  });

  it('published の話は force でも書き直さない', async () => {
    await planStory({ characterId: 'riko', season: 1, episodes: 3, root, generate: fakePlan });
    await writeStoryEpisode({ characterId: 'riko', season: 1, order: 1, root, generate: fakeWrite(1) });
    const paths = storyPaths('riko', 1, root);
    const manifest = readYaml(paths.manifest, StoryManifestSchema);
    writeFileSync(
      paths.manifest,
      readFileSync(paths.manifest, 'utf8').replace(/status: draft/, 'status: published').replace(/status: draft/, 'status: published'),
    );
    const published = readYaml(paths.manifest, StoryManifestSchema);
    expect(published.status).toBe('published');
    expect(published.episodes[0]!.status).toBe('published');
    expect(manifest.episodes[0]!.status).toBe('draft');

    await expect(
      writeStoryEpisode({ characterId: 'riko', season: 1, order: 1, root, generate: fakeWrite(1), force: true }),
    ).rejects.toThrow(/published/);
  });

  it('書き直した話は reviewed から draft へ戻る', async () => {
    await planStory({ characterId: 'riko', season: 1, episodes: 3, root, generate: fakePlan });
    await writeStoryEpisode({ characterId: 'riko', season: 1, order: 1, root, generate: fakeWrite(1) });
    const paths = storyPaths('riko', 1, root);
    writeFileSync(
      paths.manifest,
      readFileSync(paths.manifest, 'utf8').replace(/status: draft/, 'status: reviewed').replace(/status: draft/, 'status: reviewed'),
    );
    expect(readYaml(paths.manifest, StoryManifestSchema).episodes[0]!.status).toBe('reviewed');
    await writeStoryEpisode({ characterId: 'riko', season: 1, order: 1, root, generate: fakeWrite(1), force: true });
    expect(readYaml(paths.manifest, StoryManifestSchema).episodes[0]!.status).toBe('draft');
  });
});

describe('生成 ≠ 公開', () => {
  it('書いただけでは feed に出ない。manifest を published にして初めて出る', async () => {
    await planStory({ characterId: 'riko', season: 1, episodes: 3, root, generate: fakePlan });
    for (const order of [1, 2, 3]) {
      await writeStoryEpisode({ characterId: 'riko', season: 1, order, root, generate: fakeWrite(order) });
    }
    expect(collectStoryFeeds('', root).series).toEqual([]);
    expect(collectStoryFeeds('', root).index.characters).toEqual({});

    // 人間が読んで、季と第1話・第2話だけを published にする。
    const paths = storyPaths('riko', 1, root);
    const manifest = readYaml(paths.manifest, StoryManifestSchema);
    const text = readFileSync(paths.manifest, 'utf8')
      .replace('status: draft', 'status: published') // 季
      .replace('status: draft', 'status: published') // 第1話
      .replace('status: draft', 'status: published'); // 第2話
    writeFileSync(paths.manifest, text);
    expect(manifest.episodes).toHaveLength(3);

    const { index, series } = collectStoryFeeds('2026-10-01T00:00:00.000Z', root);
    expect(series).toHaveLength(1);
    expect(series[0]!.episodes.map((e) => e.order)).toEqual([1, 2]);
    expect(series[0]!.episodes[0]!.required_progress).toBe(0);
    expect(index.characters.riko!.series[0]!.episode_count).toBe(2);
  });
});
