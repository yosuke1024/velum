import { describe, it, expect } from 'vitest';
import {
  StoryManifestSchema,
  StoryPlanSchema,
  StoriesConfigSchema,
  storyId,
  storyEpisodeId,
  STORY_STATUS_RANK,
} from '../../src/schemas/story.js';

function episode(order: number, overrides: Record<string, unknown> = {}) {
  return {
    id: storyEpisodeId('riko', 1, order),
    order,
    required_progress: [0, 2, 5, 9, 14][order - 1] ?? 20,
    status: 'draft',
    ...overrides,
  };
}

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'riko-s01',
    character_id: 'riko',
    season: 1,
    title: { ja: '売れないもの', en: "Things I Can't Sell" },
    status: 'draft',
    episodes: [episode(1), episode(2), episode(3)],
    ...overrides,
  };
}

describe('Story の ID', () => {
  it('<character>-s<NN> と <character>-s<NN>-e<NN> で組む', () => {
    expect(storyId('riko', 1)).toBe('riko-s01');
    expect(storyEpisodeId('riko', 1, 3)).toBe('riko-s01-e03');
    expect(storyEpisodeId('uta', 12, 10)).toBe('uta-s12-e10');
  });
});

describe('Story manifest', () => {
  it('妥当な草稿を受け入れる（草稿は無題でよい）', () => {
    expect(StoryManifestSchema.safeParse(manifest()).success).toBe(true);
  });

  it('id が character_id と season に合わなければ拒む', () => {
    expect(StoryManifestSchema.safeParse(manifest({ id: 'riko-s02' })).success).toBe(false);
    expect(StoryManifestSchema.safeParse(manifest({ id: 'teo-s01' })).success).toBe(false);
  });

  it('話の id が order に合わなければ拒む', () => {
    const broken = manifest({ episodes: [episode(1), episode(2, { id: 'riko-s01-e03' }), episode(3)] });
    expect(StoryManifestSchema.safeParse(broken).success).toBe(false);
  });

  it('order は 1..N の順', () => {
    expect(StoryManifestSchema.safeParse(manifest({ episodes: [episode(1), episode(3)] })).success).toBe(false);
    expect(StoryManifestSchema.safeParse(manifest({ episodes: [episode(2), episode(1)] })).success).toBe(false);
  });

  it('第1話の required_progress は 0', () => {
    // 同行者を選んだ時点で読める。まだ好きでもない人物のために Scan を要求しない。
    const gated = manifest({ episodes: [episode(1, { required_progress: 2 }), episode(2), episode(3)] });
    expect(StoryManifestSchema.safeParse(gated).success).toBe(false);
  });

  it('required_progress は単調非減少（同値は許す）', () => {
    const down = manifest({ episodes: [episode(1), episode(2, { required_progress: 5 }), episode(3, { required_progress: 2 })] });
    expect(StoryManifestSchema.safeParse(down).success).toBe(false);
    const flat = manifest({ episodes: [episode(1), episode(2, { required_progress: 2 }), episode(3, { required_progress: 2 })] });
    expect(StoryManifestSchema.safeParse(flat).success).toBe(true);
  });

  it('published の話には title が要る', () => {
    const untitled = manifest({
      status: 'published',
      episodes: [episode(1, { status: 'published' }), episode(2), episode(3)],
    });
    expect(StoryManifestSchema.safeParse(untitled).success).toBe(false);

    const titled = manifest({
      status: 'published',
      episodes: [
        episode(1, { status: 'published', title: { ja: 'ミオは何も買わない', en: 'Mio Never Buys Anything' } }),
        episode(2),
        episode(3),
      ],
    });
    expect(StoryManifestSchema.safeParse(titled).success).toBe(true);
  });

  it('episode の status は季の status より先へ進めない', () => {
    expect(STORY_STATUS_RANK.draft).toBeLessThan(STORY_STATUS_RANK.reviewed);
    expect(STORY_STATUS_RANK.reviewed).toBeLessThan(STORY_STATUS_RANK.published);

    const ahead = manifest({
      status: 'draft',
      episodes: [episode(1, { status: 'published', title: { ja: 'あ', en: 'A' } }), episode(2), episode(3)],
    });
    expect(StoryManifestSchema.safeParse(ahead).success).toBe(false);
  });

  it('published の話は第1話から連続している（穴を許さない）', () => {
    const title = { ja: 'あ', en: 'A' };
    const gap = manifest({
      status: 'published',
      episodes: [
        episode(1, { status: 'published', title }),
        episode(2, { status: 'reviewed', title }),
        episode(3, { status: 'published', title }),
      ],
    });
    expect(StoryManifestSchema.safeParse(gap).success).toBe(false);
  });

  it('季を published にするなら、published の話が1本は要る', () => {
    const empty = manifest({ status: 'published' });
    expect(StoryManifestSchema.safeParse(empty).success).toBe(false);
  });

  it('形式は閉じた語彙', () => {
    expect(StoryManifestSchema.safeParse(manifest({ episodes: [episode(1, { format: 'letter' }), episode(2), episode(3)] })).success).toBe(true);
    expect(StoryManifestSchema.safeParse(manifest({ episodes: [episode(1, { format: 'haiku' }), episode(2), episode(3)] })).success).toBe(false);
  });
});

describe('Story plan', () => {
  const plan = {
    id: 'riko-s01',
    character_id: 'riko',
    season: 1,
    character_arc: {
      start: '売れない品を抱えたまま、売ることだけを考えている',
      emotional_change: '売れないことの理由を、自分の側に見つけはじめる',
      end: '売らない、と初めて口に出さずに決める',
    },
    relationships: { focus: ['mio', 'garon'] },
    episodes: [
      { order: 1, purpose: 'リコとミオの日常を見せる', situation: '市の隅の荷車', format: 'first_person', people: ['mio'] },
      { order: 2, purpose: '値切られて本気で腹を立てる人であることを見せる', situation: '北の市の裏路地', format: 'scene', people: [] },
    ],
  };

  it('手で書いた計画（generation 無し）を受け入れる', () => {
    expect(StoryPlanSchema.safeParse(plan).success).toBe(true);
  });

  it('order は 1..N の順', () => {
    const broken = { ...plan, episodes: [plan.episodes[1], plan.episodes[0]] };
    expect(StoryPlanSchema.safeParse(broken).success).toBe(false);
  });
});

describe('world/stories.yaml（既定の階段）', () => {
  it('第1話は 0 で、単調非減少', () => {
    expect(StoriesConfigSchema.safeParse({ default_required_progress: [0, 2, 5, 9] }).success).toBe(true);
    expect(StoriesConfigSchema.safeParse({ default_required_progress: [1, 2, 5] }).success).toBe(false);
    expect(StoriesConfigSchema.safeParse({ default_required_progress: [0, 5, 2] }).success).toBe(false);
  });
});
