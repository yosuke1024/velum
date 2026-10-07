import { describe, it, expect } from 'vitest';
import { parseStoryArgs, storyUsage } from '../../src/story/args.js';
import { CHARACTER_IDS } from '../../src/schemas/world.js';
import { STORY_EPISODE_LIMITS } from '../../src/schemas/story.js';

describe('story:plan の引数', () => {
  it('人物と季を読む', () => {
    expect(parseStoryArgs(['--character', 'riko', '--season', '1'], 'plan')).toEqual({
      character: 'riko',
      season: 1,
      force: false,
      dryRun: false,
    });
  });

  it('--k=v の形も受ける', () => {
    const args = parseStoryArgs(
      ['--character=teo', '--season=2', '--episodes=10', '--force', '--dry-run'],
      'plan',
    );
    expect(args).toEqual({
      character: 'teo',
      season: 2,
      episodes: 10,
      force: true,
      dryRun: true,
    });
  });

  it('話数は stories の範囲の整数だけ', () => {
    const base = ['--character', 'riko', '--season', '1', '--episodes'];
    expect(parseStoryArgs([...base, String(STORY_EPISODE_LIMITS.min)], 'plan').episodes).toBe(1);
    expect(parseStoryArgs([...base, String(STORY_EPISODE_LIMITS.max)], 'plan').episodes).toBe(12);
    expect(() => parseStoryArgs([...base, '0'], 'plan')).toThrow(/範囲/);
    expect(() => parseStoryArgs([...base, '13'], 'plan')).toThrow(/範囲/);
    expect(() => parseStoryArgs([...base, '8.5'], 'plan')).toThrow(/整数/);
    expect(() => parseStoryArgs([...base, 'ten'], 'plan')).toThrow(/整数/);
  });

  it('write の --episode は plan では受けない', () => {
    expect(() =>
      parseStoryArgs(['--character', 'riko', '--season', '1', '--episode', '3'], 'plan'),
    ).toThrow(/story:write の引数/);
  });
});

describe('story:write の引数', () => {
  it('1話だけを指す', () => {
    const args = parseStoryArgs(['--character', 'riko', '--season', '1', '--episode', '3'], 'write');
    expect(args.episode).toBe(3);
    expect(args.episodes).toBeUndefined();
  });

  it('plan の --episodes は write では受けない', () => {
    expect(() =>
      parseStoryArgs(['--character', 'riko', '--season', '1', '--episodes', '8'], 'write'),
    ).toThrow(/story:plan の引数/);
  });

  it('話番号は 1 以上の整数', () => {
    const base = ['--character', 'riko', '--season', '1', '--episode'];
    expect(() => parseStoryArgs([...base, '0'], 'write')).toThrow(/範囲/);
    // 値が - で始まる `--episode -1` は node:util がオプションの欠落と読む。どちらでも黙って通らない。
    expect(() => parseStoryArgs([...base, '-1'], 'write')).toThrow(/引数を読めません/);
    expect(() =>
      parseStoryArgs(['--character', 'riko', '--season', '1', '--episode=-1'], 'write'),
    ).toThrow(/整数/);
    expect(() => parseStoryArgs([...base, '1e1'], 'write')).toThrow(/整数/);
  });
});

describe('共通の検証', () => {
  it('人物は CHARACTER_IDS のいずれか', () => {
    for (const id of CHARACTER_IDS) {
      expect(parseStoryArgs(['--character', id, '--season', '1'], 'plan').character).toBe(id);
    }
    expect(() => parseStoryArgs(['--character', 'nobody', '--season', '1'], 'plan')).toThrow(
      /--character には/,
    );
  });

  it('人物と季は必須', () => {
    expect(() => parseStoryArgs(['--season', '1'], 'plan')).toThrow(/--character が要ります/);
    expect(() => parseStoryArgs(['--character', 'riko'], 'write')).toThrow(/--season が要ります/);
  });

  it('季は 1〜99 の整数', () => {
    expect(() => parseStoryArgs(['--character', 'riko', '--season', '0'], 'plan')).toThrow(/範囲/);
    expect(() => parseStoryArgs(['--character', 'riko', '--season', '100'], 'plan')).toThrow(/範囲/);
    expect(() => parseStoryArgs(['--character', 'riko', '--season', 's01'], 'plan')).toThrow(/整数/);
  });

  it('空文字（Actions の未設定入力）は「無い」として扱う', () => {
    const plan = parseStoryArgs(
      ['--character', 'riko', '--season', '1', '--episodes', '', '--episode', ''],
      'plan',
    );
    expect(plan.episodes).toBeUndefined();
    expect(plan.episode).toBeUndefined();

    const write = parseStoryArgs(
      ['--character', 'riko', '--season', '1', '--episode='],
      'write',
    );
    expect(write.episode).toBeUndefined();

    // 必須の値が空なら、無いのと同じ
    expect(() => parseStoryArgs(['--character', '', '--season', '1'], 'plan')).toThrow(
      /--character が要ります/,
    );
    expect(() => parseStoryArgs(['--character', 'riko', '--season', ''], 'plan')).toThrow(
      /--season が要ります/,
    );
  });

  it('不明な引数・位置引数は黙って捨てずにエラー', () => {
    expect(() =>
      parseStoryArgs(['--character', 'riko', '--season', '1', '--forse'], 'plan'),
    ).toThrow(/引数を読めません/);
    expect(() => parseStoryArgs(['--character', 'riko', '--season', '1', 'extra'], 'plan')).toThrow(
      /引数を読めません/,
    );
  });

  it('エラーには使い方が付く', () => {
    expect(() => parseStoryArgs([], 'plan')).toThrow(/使い方: npm run story:plan/);
    expect(() => parseStoryArgs([], 'write')).toThrow(/使い方: npm run story:write/);
    expect(storyUsage('plan')).toContain('--episodes');
    expect(storyUsage('write')).toContain('--episode');
  });
});
