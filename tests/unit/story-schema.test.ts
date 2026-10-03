import { describe, it, expect } from 'vitest';
import {
  STORY_EPISODE_LIMITS,
  StoriesConfigSchema,
  StoryManifestSchema,
  StoryPlanSchema,
  storyEpisodeId,
  storyEpisodeStem,
  storyManifestProblems,
  storySeasonDirName,
  storySeriesId,
} from '../../src/schemas/story.js';
import { japaneseRatio, normalizeStoryBody, storyBodyProblems } from '../../src/story/body.js';

/**
 * Character Story の台帳（manifest.yaml）・計画（plan.yaml）・既定値（stories.yaml）の
 * スキーマと、本文の書式。ファイルをまたぐ整合は story-check.test.ts が見る。
 */

const LADDER = [0, 2, 5, 9, 14, 20, 27, 35, 44, 54, 65, 77];

const episode = (order: number, overrides: Record<string, unknown> = {}) => ({
  id: storyEpisodeId('riko-s01', order),
  order,
  required_progress: LADDER[order - 1],
  status: 'draft',
  ...overrides,
});

const titled = (order: number, status: string, overrides: Record<string, unknown> = {}) =>
  episode(order, { status, title: { ja: `題${order}`, en: `Title ${order}` }, ...overrides });

const manifest = (overrides: Record<string, unknown> = {}) => ({
  id: 'riko-s01',
  character_id: 'riko',
  season: 1,
  title: { ja: '売れないもの', en: "Things I Can't Sell" },
  status: 'draft',
  episodes: [episode(1), episode(2), episode(3)],
  ...overrides,
});

const problemsOf = (value: unknown): string[] => {
  const result = StoryManifestSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((i) => i.message);
};

describe('ID とファイル名の規約', () => {
  it('季・話の ID とディレクトリ名・本文の幹が決まった形で作られる', () => {
    expect(storySeriesId('riko', 1)).toBe('riko-s01');
    expect(storySeriesId('teo', 12)).toBe('teo-s12');
    expect(storyEpisodeId('riko-s01', 3)).toBe('riko-s01-e03');
    expect(storySeasonDirName(2)).toBe('s02');
    expect(storyEpisodeStem(10)).toBe('e10');
  });
});

describe('StoryManifestSchema', () => {
  it('草稿の台帳（title なし・第1話は 0）が通る', () => {
    expect(StoryManifestSchema.safeParse(manifest()).success).toBe(true);
  });

  it('全状態が揃った台帳が通る（published / reviewed / draft）', () => {
    const value = manifest({
      status: 'published',
      episodes: [titled(1, 'published'), titled(2, 'published'), titled(3, 'reviewed'), episode(4)],
    });
    expect(StoryManifestSchema.safeParse(value).success).toBe(true);
  });

  it('オプション欄（summary / format / generation）を持てる', () => {
    const value = manifest({
      summary: { ja: '要約', en: 'Summary' },
      episodes: [
        titled(1, 'draft', {
          summary: { ja: '話の要約', en: 'Episode summary' },
          format: 'dialogue',
          generation: { model: 'm', prompt_version: 'v1', generated_at: '2026-09-20T00:00:00.000Z' },
        }),
      ],
    });
    expect(StoryManifestSchema.safeParse(value).success).toBe(true);
  });

  it('第1話の required_progress は 0 でなければならない', () => {
    const value = manifest({ episodes: [episode(1, { required_progress: 1 }), episode(2), episode(3)] });
    expect(StoryManifestSchema.safeParse(value).success).toBe(false);
    expect(problemsOf(value).join('\n')).toContain('第1話の required_progress は 0');
  });

  it('required_progress は単調非減少（同値は許し、減少は落とす）', () => {
    const equal = manifest({
      episodes: [episode(1), episode(2, { required_progress: 2 }), episode(3, { required_progress: 2 })],
    });
    expect(StoryManifestSchema.safeParse(equal).success).toBe(true);

    const decreasing = manifest({
      episodes: [episode(1), episode(2, { required_progress: 5 }), episode(3, { required_progress: 4 })],
    });
    expect(StoryManifestSchema.safeParse(decreasing).success).toBe(false);
    expect(problemsOf(decreasing).join('\n')).toContain('前の話');
  });

  it('話の order は 1 から欠番なく並ぶ', () => {
    const skipped = manifest({
      episodes: [episode(1), { ...episode(3), order: 3 }],
    });
    expect(StoryManifestSchema.safeParse(skipped).success).toBe(false);
    expect(problemsOf(skipped).join('\n')).toContain('order は 2 であること');
  });

  it('季の id は character_id と season から決まる', () => {
    const value = manifest({ id: 'riko-s02' });
    expect(StoryManifestSchema.safeParse(value).success).toBe(false);
    expect(problemsOf(value).join('\n')).toContain('id は riko-s01');
  });

  it('話の id は季の id と order から決まる', () => {
    const value = manifest({
      episodes: [episode(1), episode(2, { id: 'riko-s01-e07' }), episode(3)],
    });
    expect(StoryManifestSchema.safeParse(value).success).toBe(false);
    expect(problemsOf(value).join('\n')).toContain('riko-s01-e02 であること');
  });

  it('話の status は季の status を越えられない', () => {
    const value = manifest({ status: 'draft', episodes: [titled(1, 'reviewed'), episode(2)] });
    expect(StoryManifestSchema.safeParse(value).success).toBe(false);
    expect(problemsOf(value).join('\n')).toContain('季の status');
  });

  it('公開は第1話から連続でなければならない（飛ばして published にできない）', () => {
    const value = manifest({
      status: 'published',
      episodes: [titled(1, 'published'), titled(2, 'reviewed'), titled(3, 'published')],
    });
    expect(StoryManifestSchema.safeParse(value).success).toBe(false);
    expect(problemsOf(value).join('\n')).toContain('第1話から連続');
  });

  it('reviewed 以上の話には title が要る（draft には要らない）', () => {
    const reviewed = manifest({ status: 'reviewed', episodes: [episode(1, { status: 'reviewed' })] });
    expect(StoryManifestSchema.safeParse(reviewed).success).toBe(false);
    expect(problemsOf(reviewed).join('\n')).toContain('title');

    const published = manifest({ status: 'published', episodes: [episode(1, { status: 'published' })] });
    expect(StoryManifestSchema.safeParse(published).success).toBe(false);

    expect(StoryManifestSchema.safeParse(manifest()).success).toBe(true);
  });

  it('published の季には published の話が1話以上要る', () => {
    const value = manifest({ status: 'published', episodes: [titled(1, 'reviewed'), episode(2)] });
    expect(StoryManifestSchema.safeParse(value).success).toBe(false);
    expect(problemsOf(value).join('\n')).toContain('published の話が1話以上');
  });

  it('strict: required_progres のような打ち間違いを黙って捨てず落とす', () => {
    const typo = manifest({
      episodes: [
        episode(1),
        { id: 'riko-s01-e02', order: 2, required_progres: 2, status: 'draft' },
      ],
    });
    const result = StoryManifestSchema.safeParse(typo);
    expect(result.success).toBe(false);
    if (!result.success) {
      const text = JSON.stringify(result.error.issues);
      expect(text).toContain('required_progres');
    }
  });

  it('strict: 季の直下の未知キーも落とす', () => {
    expect(StoryManifestSchema.safeParse({ ...manifest(), statuss: 'draft' }).success).toBe(false);
  });

  it('話数は 1〜12', () => {
    expect(StoryManifestSchema.safeParse(manifest({ episodes: [] })).success).toBe(false);

    const thirteen = Array.from({ length: STORY_EPISODE_LIMITS.max + 1 }, (_, i) => episode(i + 1, { required_progress: i }));
    expect(StoryManifestSchema.safeParse(manifest({ episodes: thirteen })).success).toBe(false);

    const twelve = thirteen.slice(0, STORY_EPISODE_LIMITS.max);
    expect(StoryManifestSchema.safeParse(manifest({ episodes: twelve })).success).toBe(true);
  });

  it('未知の人物・状態・形式を受け付けない', () => {
    expect(StoryManifestSchema.safeParse(manifest({ character_id: 'nobody', id: 'nobody-s01' })).success).toBe(false);
    expect(StoryManifestSchema.safeParse(manifest({ status: 'archived' })).success).toBe(false);
    expect(
      StoryManifestSchema.safeParse(manifest({ episodes: [episode(1, { format: 'poem' })] })).success,
    ).toBe(false);
  });

  it('storyManifestProblems は検査済みの値にも使え、問題が無ければ空', () => {
    const parsed = StoryManifestSchema.parse(manifest());
    expect(storyManifestProblems(parsed)).toEqual([]);
  });
});

describe('StoryPlanSchema', () => {
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

  it('計画が通る', () => {
    expect(StoryPlanSchema.safeParse(plan()).success).toBe(true);
  });

  it('strict: 未知のキーを落とす', () => {
    expect(StoryPlanSchema.safeParse(plan({ extra: 1 })).success).toBe(false);
  });
});

describe('StoriesConfigSchema', () => {
  const config = (overrides: Record<string, unknown> = {}) => ({
    default_episode_count: 8,
    default_required_progress: LADDER,
    ...overrides,
  });

  it('既定値が通る', () => {
    expect(StoriesConfigSchema.safeParse(config()).success).toBe(true);
  });

  it('階段は 12 段で、第1段は 0', () => {
    expect(StoriesConfigSchema.safeParse(config({ default_required_progress: LADDER.slice(0, 8) })).success).toBe(false);
    expect(
      StoriesConfigSchema.safeParse(config({ default_required_progress: [1, ...LADDER.slice(1)] })).success,
    ).toBe(false);
  });

  it('階段は単調非減少', () => {
    const broken = [...LADDER];
    broken[5] = 3;
    expect(StoriesConfigSchema.safeParse(config({ default_required_progress: broken })).success).toBe(false);
  });

  it('既定の話数は 1〜12', () => {
    expect(StoriesConfigSchema.safeParse(config({ default_episode_count: 0 })).success).toBe(false);
    expect(StoriesConfigSchema.safeParse(config({ default_episode_count: 13 })).success).toBe(false);
    expect(StoriesConfigSchema.safeParse(config({ default_episode_count: 12 })).success).toBe(true);
  });

  it('strict: 未知のキーを落とす', () => {
    expect(StoriesConfigSchema.safeParse(config({ default_episode_cout: 8 })).success).toBe(false);
  });
});

describe('storyBodyProblems（本文の書式）', () => {
  const ja = '朝いちばんの市は、まだ霜の匂いがした。\n\nあたしは荷車の幌を上げた。';
  const en = 'First market of the morning smelled like frost.\n\nI pulled back the canvas.';

  it('正常な本文は問題なし（段落内の改行も許す）', () => {
    expect(storyBodyProblems(ja, 'ja')).toEqual([]);
    expect(storyBodyProblems(en, 'en')).toEqual([]);
    expect(storyBodyProblems('一行目。\n二行目。', 'ja')).toEqual([]);
  });

  it('長さは見ない（短い本文も書式としては正しい）', () => {
    expect(storyBodyProblems('はい。', 'ja')).toEqual([]);
  });

  it('空の本文を落とす', () => {
    expect(storyBodyProblems('  \n\n', 'ja').join()).toContain('空');
  });

  it('CR の混入を落とす', () => {
    expect(storyBodyProblems('一行目。\r\n二行目。', 'ja').join()).toContain('CR');
  });

  it('先頭の --- を落とす（front matter と誤読される）', () => {
    expect(storyBodyProblems('---\n朝の市。', 'ja').join()).toContain('front matter');
  });

  it('Markdown の見出し・強調・バッククォート・リンクを落とす', () => {
    expect(storyBodyProblems('# 朝の市\n\n荷車を引いた。', 'ja').join()).toContain('見出し');
    expect(storyBodyProblems('**朝**の市で荷車を引いた。', 'ja').join()).toContain('強調');
    expect(storyBodyProblems('朝の市で`荷車`を引いた。', 'ja').join()).toContain('バッククォート');
    expect(storyBodyProblems('朝の[市](http://example.com)で荷車を引いた。', 'ja').join()).toContain('リンク');
  });

  it('HTML タグを落とす', () => {
    expect(storyBodyProblems('朝の市で<b>荷車</b>を引いた。', 'ja').join()).toContain('HTML');
  });

  it('日本語として読めない ja を落とす', () => {
    expect(storyBodyProblems(en, 'ja').join()).toContain('日本語の本文に見えません');
  });

  it('日本語の混ざった en を落とす', () => {
    expect(storyBodyProblems(ja, 'en').join()).toContain('日本語が混じっています');
  });

  it('日本語の割合は空白を除いて数える', () => {
    expect(japaneseRatio('')).toBe(0);
    expect(japaneseRatio('abc')).toBe(0);
    expect(japaneseRatio('あい ab')).toBeCloseTo(0.5, 5);
  });
});

describe('normalizeStoryBody', () => {
  it('行末の空白を落とし、3つ以上続く改行を空行1つに詰め、前後を整える', () => {
    expect(normalizeStoryBody('\n\n一行目。  \n二行目。\n\n\n\n三行目。\n\n')).toBe(
      '一行目。\n二行目。\n\n三行目。',
    );
  });

  it('段落の空行区切りは保つ', () => {
    expect(normalizeStoryBody('A\n\nB')).toBe('A\n\nB');
  });
});
