import { parseArgs, type ParseArgsConfig } from 'node:util';
import { CHARACTER_IDS, type CharacterId } from '../../schemas/world.js';
import { EFFORT_PATTERN, WRITER_VERBOSITIES, type WriterVerbosity } from './config.js';

/**
 * 新しい制作経路の引数（story:doctor / story:draft / story:revise）。旧 story:plan / story:write の
 * src/story/args.ts と同じ規律: `--k=v` も `--k v` も受ける、空文字は「無い」、不明な引数・不正な値は
 * 黙って直さずエラー（使い方を添える）。位置引数は受けない。
 *
 *   story:doctor  [--probe]
 *   story:draft   --character <id> --brief <path> --request <path>
 *                 [--instructions <path>] [--effort <level>] [--verbosity low|medium|high]
 *                 [--timeout-minutes <1..240>] [--dry-run] [--print-prompt]
 *   story:revise  --run <run-id> --feedback <path>
 *                 [--brief <path>] [--instructions <path>] [--effort <level>] [--verbosity low|medium|high]
 *                 [--timeout-minutes <1..240>] [--dry-run] [--print-prompt]
 *
 * plan / season / episode は受けない（初稿は一作品を書くだけで、話数や解放条件を要求しない）。
 * --print-prompt は --dry-run と一緒のときだけ。--effort は小文字の英字だけ（対応は preflight が見る）。
 * パスはここでは解決しない（呼び出し側が cwd から解決する）。
 */

export type DoctorArgs = { probe: boolean };

export type DraftArgs = {
  character: CharacterId;
  brief: string;
  request: string;
  instructions?: string;
  effort?: string;
  verbosity?: WriterVerbosity;
  timeoutMinutes?: number;
  dryRun: boolean;
  printPrompt: boolean;
};

export type ReviseArgs = {
  run: string;
  feedback: string;
  brief?: string;
  instructions?: string;
  effort?: string;
  verbosity?: WriterVerbosity;
  timeoutMinutes?: number;
  dryRun: boolean;
  printPrompt: boolean;
};

export type AuthoringCommand = 'doctor' | 'draft' | 'revise';

/** --timeout-minutes の範囲。writer.yaml の timeout_minutes（config.ts のスキーマ）と同じ。 */
const TIMEOUT_MINUTES = { min: 1, max: 240 } as const;

export function authoringUsage(command: AuthoringCommand): string {
  const character = CHARACTER_IDS.join('|');
  const verbosity = WRITER_VERBOSITIES.join('|');
  const common = (instructionsDefault: string) => [
    `  --instructions      執筆者への指示ファイル（省略すると${instructionsDefault}）`,
    '  --effort            推論の強さ（小文字の英字。省略すると writer.yaml の reasoning_effort。対応は story:doctor が見る）',
    `  --verbosity         ${verbosity} のいずれか（省略すると writer.yaml の verbosity）`,
    `  --timeout-minutes   1回の実行の上限（${TIMEOUT_MINUTES.min}〜${TIMEOUT_MINUTES.max} 分。省略すると writer.yaml の timeout_minutes）`,
    '  --dry-run           モデル・認証・入力・呼び出し回数を示して終わる（Codex を呼ばない・原稿を作らない）',
    '  --print-prompt      --dry-run と一緒のときだけ。stdin へ渡す全文を出す',
  ];
  switch (command) {
    case 'doctor':
      return [
        '使い方: npm run story:doctor -- [--probe]',
        '  --probe   最小の1回だけ実際に Codex を呼んで、モデル・認証・effort が通ることを確かめる（推論が1回起きる）',
        '  省略すると推論は起こさない（版・認証・モデルカタログ・設定の検査だけ）',
      ].join('\n');
    case 'draft':
      return [
        `使い方: npm run story:draft -- --character <${character}> --brief <path> --request <path> [--instructions <path>] [--effort <level>] [--verbosity <${verbosity}>] [--timeout-minutes <${TIMEOUT_MINUTES.min}..${TIMEOUT_MINUTES.max}>] [--dry-run [--print-prompt]]`,
        '  --character         書く人物',
        '  --brief             brief（資料）のファイル',
        '  --request           依頼文のファイル',
        ...common(' authoring/writer.yaml の instructions'),
      ].join('\n');
    case 'revise':
      return [
        `使い方: npm run story:revise -- --run <run-id> --feedback <path> [--brief <path>] [--instructions <path>] [--effort <level>] [--verbosity <${verbosity}>] [--timeout-minutes <${TIMEOUT_MINUTES.min}..${TIMEOUT_MINUTES.max}>] [--dry-run [--print-prompt]]`,
        '  --run               直す元の run（.story-runs/ の run-id）',
        '  --feedback          フィードバックのファイル',
        '  --brief             brief を差し替えるとき（省略すると元の run の brief の写しを使う）',
        ...common(' 元の run の指示の写しを使う'),
      ].join('\n');
  }
}

function fail(command: AuthoringCommand, message: string): never {
  throw new Error(`${message}\n${authoringUsage(command)}`);
}

/**
 * 空文字（Actions の未設定入力）と未指定を、どちらも undefined にそろえる。
 * 空白だけの値も「無い」。それ以外は**そのまま**返す——パスや値の前後の空白を黙って削らない
 * （削って通れば、指定と違うものを使うことになる。合わなければ下の検証が落とす）。
 */
function present(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined;
}

/** 整数だけを受ける。`1.5` `1e1` `-1` ` 1x` は整数ではない。 */
function integerOption(
  command: AuthoringCommand,
  name: string,
  value: string,
  min: number,
  max: number,
): number {
  if (!/^\d+$/.test(value)) {
    fail(command, `--${name} には整数を指定してください: ${value}`);
  }
  const parsed = Number(value);
  if (parsed < min || parsed > max) {
    fail(command, `--${name} は ${min}〜${max} の範囲で指定してください: ${value}`);
  }
  return parsed;
}

/** strict で読む。不明な引数・位置引数は node:util が拒否する（黙って捨てない）。 */
function readOptions<const O extends NonNullable<ParseArgsConfig['options']>>(
  command: AuthoringCommand,
  argv: readonly string[],
  options: O,
) {
  try {
    return parseArgs({ args: [...argv], strict: true, allowPositionals: false, options }).values;
  } catch (error) {
    // node:util の英語のメッセージは、どの引数が悪いかを伝える材料としてそのまま添える。
    fail(command, `引数を読めません: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** draft と revise で共通の引数 */
const COMMON_OPTIONS = {
  instructions: { type: 'string' },
  effort: { type: 'string' },
  verbosity: { type: 'string' },
  'timeout-minutes': { type: 'string' },
  'dry-run': { type: 'boolean' },
  'print-prompt': { type: 'boolean' },
} as const;

type CommonValues = {
  instructions?: string;
  effort?: string;
  verbosity?: string;
  'timeout-minutes'?: string;
  'dry-run'?: boolean;
  'print-prompt'?: boolean;
};

type CommonArgs = Pick<
  DraftArgs,
  'instructions' | 'effort' | 'verbosity' | 'timeoutMinutes' | 'dryRun' | 'printPrompt'
>;

/** draft と revise で共通の引数を検証する。省略された引数は結果に現れない。 */
function commonArgs(command: 'draft' | 'revise', values: CommonValues): CommonArgs {
  const dryRun = values['dry-run'] === true;
  const printPrompt = values['print-prompt'] === true;
  if (printPrompt && !dryRun) {
    fail(command, '--print-prompt は --dry-run と一緒のときだけ指定できます（プロンプトの確認用です）。');
  }

  const args: CommonArgs = { dryRun, printPrompt };

  const instructions = present(values.instructions);
  if (instructions !== undefined) args.instructions = instructions;

  const effort = present(values.effort);
  if (effort !== undefined) {
    if (!EFFORT_PATTERN.test(effort)) {
      fail(command, `--effort には小文字の英字だけを指定してください（例: high / xhigh）: ${effort}`);
    }
    args.effort = effort;
  }

  const verbosity = present(values.verbosity);
  if (verbosity !== undefined) {
    if (!(WRITER_VERBOSITIES as readonly string[]).includes(verbosity)) {
      fail(command, `--verbosity には ${WRITER_VERBOSITIES.join(' / ')} のいずれかを指定してください: ${verbosity}`);
    }
    args.verbosity = verbosity as WriterVerbosity;
  }

  const timeout = present(values['timeout-minutes']);
  if (timeout !== undefined) {
    args.timeoutMinutes = integerOption(
      command,
      'timeout-minutes',
      timeout,
      TIMEOUT_MINUTES.min,
      TIMEOUT_MINUTES.max,
    );
  }
  return args;
}

export function parseDoctorArgs(argv: readonly string[]): DoctorArgs {
  const values = readOptions('doctor', argv, { probe: { type: 'boolean' } });
  return { probe: values.probe === true };
}

export function parseDraftArgs(argv: readonly string[]): DraftArgs {
  const values = readOptions('draft', argv, {
    character: { type: 'string' },
    brief: { type: 'string' },
    request: { type: 'string' },
    ...COMMON_OPTIONS,
  });

  const character = present(values.character);
  if (!character) fail('draft', '--character が要ります。');
  if (!(CHARACTER_IDS as readonly string[]).includes(character)) {
    fail('draft', `--character には ${CHARACTER_IDS.join(' / ')} のいずれかを指定してください: ${character}`);
  }
  const brief = present(values.brief);
  if (!brief) fail('draft', '--brief が要ります。');
  const request = present(values.request);
  if (!request) fail('draft', '--request が要ります。');

  return {
    character: character as CharacterId,
    brief,
    request,
    ...commonArgs('draft', values),
  };
}

export function parseReviseArgs(argv: readonly string[]): ReviseArgs {
  const values = readOptions('revise', argv, {
    run: { type: 'string' },
    feedback: { type: 'string' },
    brief: { type: 'string' },
    ...COMMON_OPTIONS,
  });

  const run = present(values.run);
  if (!run) fail('revise', '--run が要ります。');
  const feedback = present(values.feedback);
  if (!feedback) fail('revise', '--feedback が要ります。');

  const args: ReviseArgs = { run, feedback, ...commonArgs('revise', values) };
  const brief = present(values.brief);
  if (brief !== undefined) args.brief = brief;
  return args;
}
