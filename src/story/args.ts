import { parseArgs } from 'node:util';
import { CHARACTER_IDS, type CharacterId } from '../schemas/world.js';
import { STORY_EPISODE_LIMITS } from '../schemas/story.js';

/**
 * story:plan / story:write の引数。
 *
 *   --character riko   人物（必須）
 *   --season 1         季（必須。1以上の整数。s01 なら 1）
 *   --episodes 8       plan のみ。話数（STORY_EPISODE_LIMITS の範囲）。省略すると stories.yaml の既定
 *   --episode 3        write のみ。この1話だけ書く。省略すると本文の無い話すべて
 *   --force            plan: 計画済みでも作り直す／write: 本文があっても書き直す
 *   --dry-run          プロンプトだけ出す。LLM を呼ばず、何も書かない
 *
 * `--k=v` でも `--k v` でも受ける。
 *
 * **空文字は「無い」として扱う。** GitHub Actions は未設定の入力を空文字で渡すので
 * （`--episode ''`）、空を値として読むと「第0話」のような無意味な指定になる。
 * 不明な引数・整数でない値・範囲外は、黙って直さずエラーにする（リポジトリの方針）。
 */

export type StoryArgs = {
  character: CharacterId;
  season: number;
  /** plan のみ */
  episodes?: number;
  /** write のみ */
  episode?: number;
  force: boolean;
  dryRun: boolean;
};

export type StoryArgsMode = 'plan' | 'write';

const MAX_SEASON = 99;

export function storyUsage(mode: StoryArgsMode): string {
  const only =
    mode === 'plan'
      ? '[--episodes <話数>]'
      : '[--episode <話番号>]';
  return [
    `使い方: npm run story:${mode} -- --character <${CHARACTER_IDS.join('|')}> --season <季> ${only} [--force] [--dry-run]`,
    mode === 'plan'
      ? `  --episodes  話数（${STORY_EPISODE_LIMITS.min}〜${STORY_EPISODE_LIMITS.max}）。省略すると world/stories.yaml の既定`
      : '  --episode   この1話だけ書く。省略すると本文の無い話すべて',
    mode === 'plan'
      ? '  --force     plan.yaml があっても作り直す'
      : '  --force     本文があっても書き直す（published の話は書き直さない）',
    '  --dry-run   プロンプトだけを出す（LLM を呼ばない・何も書かない）',
  ].join('\n');
}

function fail(mode: StoryArgsMode, message: string): never {
  throw new Error(`${message}\n${storyUsage(mode)}`);
}

/** 空文字（Actions の未設定入力）と未指定を、どちらも undefined にそろえる。 */
function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** 整数だけを受ける。`1.5` `1e1` `-1` ` 1x` は整数ではない。 */
function integerOption(
  mode: StoryArgsMode,
  name: string,
  value: string,
  min: number,
  max: number,
): number {
  if (!/^\d+$/.test(value)) {
    fail(mode, `--${name} には整数を指定してください: ${value}`);
  }
  const parsed = Number(value);
  if (parsed < min || parsed > max) {
    fail(mode, `--${name} は ${min}〜${max} の範囲で指定してください: ${value}`);
  }
  return parsed;
}

export function parseStoryArgs(argv: readonly string[], mode: StoryArgsMode): StoryArgs {
  let values: {
    character?: string;
    season?: string;
    episodes?: string;
    episode?: string;
    force?: boolean;
    'dry-run'?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        character: { type: 'string' },
        season: { type: 'string' },
        episodes: { type: 'string' },
        episode: { type: 'string' },
        force: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
      },
    }));
  } catch (error) {
    // node:util の英語のメッセージは、どの引数が悪いかを伝える材料としてそのまま添える。
    fail(mode, `引数を読めません: ${(error as Error).message}`);
  }

  const character = present(values.character);
  if (!character) fail(mode, '--character が要ります。');
  if (!(CHARACTER_IDS as readonly string[]).includes(character)) {
    fail(mode, `--character には ${CHARACTER_IDS.join(' / ')} のいずれかを指定してください: ${character}`);
  }

  const seasonText = present(values.season);
  if (!seasonText) fail(mode, '--season が要ります。');
  const season = integerOption(mode, 'season', seasonText, 1, MAX_SEASON);

  const episodesText = present(values.episodes);
  const episodeText = present(values.episode);
  if (mode === 'write' && episodesText !== undefined) {
    fail(mode, '--episodes は story:plan の引数です。story:write では --episode で1話を指定します。');
  }
  if (mode === 'plan' && episodeText !== undefined) {
    fail(mode, '--episode は story:write の引数です。story:plan では --episodes で話数を指定します。');
  }

  const args: StoryArgs = {
    character: character as CharacterId,
    season,
    force: values.force === true,
    dryRun: values['dry-run'] === true,
  };
  if (episodesText !== undefined) {
    args.episodes = integerOption(
      mode,
      'episodes',
      episodesText,
      STORY_EPISODE_LIMITS.min,
      STORY_EPISODE_LIMITS.max,
    );
  }
  if (episodeText !== undefined) {
    args.episode = integerOption(mode, 'episode', episodeText, 1, STORY_EPISODE_LIMITS.max);
  }
  return args;
}
