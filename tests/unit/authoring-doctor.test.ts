import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DOCTOR_CHECK_NAMES,
  EXPECTED_PROMPT_BLOCKS,
  FORBIDDEN_PROMPT_BLOCKS,
  KNOWN_RESIDUAL_PROMPT_BLOCKS,
  promptInputBlocks,
  runDoctor,
  type DoctorCheckName,
  type DoctorReport,
} from '../../src/story/authoring/doctor.js';
import {
  DOCTOR_SENTINEL_PROVIDER,
  ISOLATION_OVERRIDES,
  PROMPT_INPUT_MARKER,
  REQUIRED_EXEC_FLAGS,
  loginStatusArgs,
} from '../../src/story/authoring/codex-command.js';
import type { ShortResult, ShortRun } from '../../src/story/authoring/codex-process.js';
import type { WriterConfig } from '../../src/story/authoring/config.js';
import { PROBE_PROMPT } from '../../src/story/authoring/prompt.js';
import type { AuthoringDeps } from '../../src/story/authoring/run.js';
import {
  argAfter,
  failedTurnEvents,
  fakeShortRun,
  fakeSpawn,
  okEvents,
  readCliFixture,
  REAL,
  type FakeBehavior,
  type FakeShortOptions,
  type ShortCall,
} from '../helpers/fake-codex.js';

const tmp = mkdtempSync(join(tmpdir(), 'velum-authoring-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const BASE_CONFIG: WriterConfig = {
  provider: 'codex-cli',
  model: 'gpt-6-astra',
  reasoning_effort: 'high',
  verbosity: null,
  fallback: 'none',
  authentication: 'chatgpt',
  credentials_store: 'keyring',
  instructions: 'authoring/prompts/instructions.txt',
  timeout_minutes: 30,
  cli: { command: 'codex', min_version: '0.153.0' },
};

const BASE_ENV: NodeJS.ProcessEnv = {
  PATH: '/usr/bin',
  HOME: '/home/velum-test',
  CODEX_HOME: '/home/velum-test/.codex',
};

const SENTINEL_ARG = `model_provider="${DOCTOR_SENTINEL_PROVIDER}"`;
const isSentinelExec = (args: readonly string[]): boolean =>
  args[0] === 'exec' && args.includes(SENTINEL_ARG);
/** ShortRun 経由の live の exec（--help でも sentinel でもない exec）。あってはならない。 */
const isLiveExec = (args: readonly string[]): boolean =>
  args[0] === 'exec' && !args.includes('--help') && !args.includes(SENTINEL_ARG);

type Setup = {
  config?: Partial<WriterConfig>;
  /** null は .gitignore を作らない */
  gitignore?: string | null;
  /** false は instructions のファイルを作らない */
  instructions?: boolean;
  env?: NodeJS.ProcessEnv;
  short?: FakeShortOptions;
  /** 特定の ShortRun 呼び出しだけ結果を差し替える（null なら偽物に任せる） */
  override?: (args: readonly string[]) => ShortResult | null;
  spawn?: FakeBehavior;
  /** 親の中断（Ctrl-C）の代わり */
  abortSignal?: AbortSignal;
};

let counter = 0;

/** 一時ディレクトリの中に root を作り、偽の Codex だけを使う AuthoringDeps を組む。 */
function setup(options: Setup = {}) {
  counter += 1;
  const base = join(tmp, `case-${counter}`);
  const root = join(base, 'root');
  mkdirSync(root, { recursive: true });

  const config: WriterConfig = { ...BASE_CONFIG, ...options.config };
  if (options.gitignore !== null) {
    writeFileSync(join(root, '.gitignore'), options.gitignore ?? 'node_modules/\n.story-runs/\n');
  }
  if (options.instructions !== false) {
    const file = join(root, config.instructions);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '日本語で書いてください。\n');
  }

  const env: NodeJS.ProcessEnv = { ...(options.env ?? BASE_ENV) };
  const envBefore = { ...env };

  const short = fakeShortRun(options.short);
  const calls: ShortCall[] = [];
  const shortRun: ShortRun = async (args, runOptions) => {
    calls.push({ args: [...args], options: runOptions });
    const overridden = options.override?.(args) ?? null;
    return overridden ?? short.run(args, runOptions);
  };

  const spawn = fakeSpawn(options.spawn ?? { events: okEvents(), output: '準備完了' });
  const created: string[] = [];
  const removed: string[] = [];
  const logs: string[] = [];

  const deps: AuthoringDeps = {
    root,
    runsRoot: join(root, '.story-runs'),
    config,
    env,
    shortRun,
    process: { spawn: spawn.spawn, killGroup: spawn.killGroup, now: () => Date.now() },
    now: () => new Date('2026-10-03T10:00:00.000Z'),
    random: () => 'a1b2c3',
    makeWorkdir: () => {
      const dir = mkdtempSync(join(base, 'workdir-'));
      created.push(dir);
      return dir;
    },
    removeWorkdir: (dir) => {
      removed.push(dir);
      rmSync(dir, { recursive: true, force: true });
    },
    log: (line) => logs.push(line),
    pid: process.pid,
    heartbeatMs: 3_600_000,
    killGraceMs: 50,
    timeoutMsOverride: 20_000,
    secretLeaks: () => [],
    ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
  };

  return { deps, root, env, envBefore, spawn, calls, created, removed, logs };
}

const checkOf = (report: DoctorReport, name: DoctorCheckName) => {
  const found = report.checks.find((check) => check.name === name);
  if (!found) throw new Error(`検査 ${name} が報告にありません: ${report.checks.map((c) => c.name).join(', ')}`);
  return found;
};
const statusOf = (report: DoctorReport, name: DoctorCheckName) => checkOf(report, name).status;
const namesOf = (report: DoctorReport): string[] => report.checks.map((check) => check.name);

/** `-c <override>` の組が args にあるか。 */
function hasConfig(args: readonly string[], override: string): boolean {
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === '-c' && args[i + 1] === override) return true;
  }
  return false;
}

const FORBIDDEN_FLAGS = ['resume', 'fork', '--last', '--yolo', '--ignore-rules', '--approve-for-me'];
const hasForbiddenFlag = (args: readonly string[]): boolean =>
  args.some((arg) => FORBIDDEN_FLAGS.includes(arg) || arg.startsWith('--dangerously'));

const sentinelResult = (patch: Partial<ShortResult>): ShortResult => ({
  exitCode: 1,
  stdout: '',
  stderr: `${REAL.sentinelNotFound}\n`,
  error: null,
  ...patch,
});

const catalogWith = (slug: string, patch: Record<string, unknown>): string => {
  const parsed = JSON.parse(readCliFixture('models.json')) as { models: Array<Record<string, unknown>> };
  return JSON.stringify({
    ...parsed,
    models: parsed.models.map((model) => (model.slug === slug ? { ...model, ...patch } : model)),
  });
};

const messageBlock = (role: 'developer' | 'user', texts: string[]) => ({
  type: 'message',
  role,
  content: texts.map((text) => ({ type: 'input_text', text })),
});

/** 実機の prompt-input に、開発者ブロックを1つ足したもの（印のユーザーブロックの直前）。 */
function promptInputWith(extraTexts: string[]): string {
  const items = JSON.parse(readCliFixture('prompt-input.json')) as unknown[];
  return JSON.stringify([...items.slice(0, -1), messageBlock('developer', extraTexts), items.at(-1)]);
}

/** 実機で見えた、グローバルの AGENTS.md のブロック（user ロールのメッセージ）。 */
const AGENTS_MD_TEXT = '# AGENTS.md instructions\n\n<INSTRUCTIONS>\nrule\n</INSTRUCTIONS>';
const agentsMdMessage = (text: string = AGENTS_MD_TEXT) => ({
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text }],
});

/** 実機の prompt-input の、印のユーザーブロックの直前に、任意の項目を足したもの。 */
function promptInputWithItems(extra: unknown[]): string {
  const items = JSON.parse(readCliFixture('prompt-input.json')) as unknown[];
  return JSON.stringify([...items.slice(0, -1), ...extra, items.at(-1)]);
}

let homeCounter = 0;
/** 一時ディレクトリの CODEX_HOME。指示ファイルの名前を渡すと、そのファイルを置く。 */
function codexHomeWith(...names: string[]): string {
  homeCounter += 1;
  const dir = join(tmp, `codex-home-${homeCounter}`);
  mkdirSync(dir, { recursive: true });
  for (const name of names) writeFileSync(join(dir, name), '# 開発用の指示\nrule\n');
  return dir;
}

// ── promptInputBlocks ───────────────────────────────────────

describe('promptInputBlocks: prompt-input の JSON からブロック名を並べる', () => {
  it('実機の fixture から、モデルに見えるブロックを順に取り出す（印は blocks に入れない）', () => {
    const result = promptInputBlocks(readCliFixture('prompt-input.json'));
    expect(result.blocks).toEqual([
      'permissions instructions',
      'collaboration_mode',
      'multi_agent_role',
      'multi_agent_mode',
      'environment_context',
    ]);
    expect(result.markerFound).toBe(true);
  });

  it('先頭のタグ名を取る（`<skills_instructions>\\n...` → skills_instructions）', () => {
    const json = JSON.stringify([
      messageBlock('developer', ['<skills_instructions>\n## Skills\n...', '<apps_instructions>\n...']),
    ]);
    expect(promptInputBlocks(json).blocks).toEqual(['skills_instructions', 'apps_instructions']);
  });

  it('タグ名に空白を含んでもよい（`<permissions instructions>`）。タグの直後に本文が続いていても取れる', () => {
    const json = JSON.stringify([
      messageBlock('developer', ['<permissions instructions>\n本文', '<collaboration_mode># Collaboration Mode: Default']),
    ]);
    expect(promptInputBlocks(json).blocks).toEqual(['permissions instructions', 'collaboration_mode']);
  });

  it('タグで始まらない文は "(text)"。印と一致するものだけが markerFound になる', () => {
    const json = JSON.stringify([messageBlock('user', ['ただの文です。'])]);
    const result = promptInputBlocks(json);
    expect(result.blocks).toEqual(['(text)']);
    expect(result.markerFound).toBe(false);
  });

  it('印の文字列は markerFound に数え、blocks には入れない', () => {
    const json = JSON.stringify([messageBlock('user', [PROMPT_INPUT_MARKER])]);
    const result = promptInputBlocks(json);
    expect(result.blocks).toEqual([]);
    expect(result.markerFound).toBe(true);
  });

  it('印が無ければ markerFound は false', () => {
    const json = JSON.stringify([messageBlock('developer', ['<permissions instructions>\nx'])]);
    expect(promptInputBlocks(json).markerFound).toBe(false);
  });

  it('空の配列は、ブロックなし・印なし', () => {
    expect(promptInputBlocks('[]')).toEqual({ blocks: [], markerFound: false });
  });

  it('メッセージをまたいでも、出てきた順に並べる', () => {
    const json = JSON.stringify([
      messageBlock('developer', ['<a_block>\nx']),
      messageBlock('user', ['<b_block>\nx', PROMPT_INPUT_MARKER]),
      messageBlock('developer', ['<c_block>\nx']),
    ]);
    const result = promptInputBlocks(json);
    expect(result.blocks).toEqual(['a_block', 'b_block', 'c_block']);
    expect(result.markerFound).toBe(true);
  });

  it('実機の形（user ロールの `# AGENTS.md instructions` で始まる文）は agents_md', () => {
    const result = promptInputBlocks(JSON.stringify([agentsMdMessage()]));
    expect(result.blocks).toEqual(['agents_md']);
    expect(result.markerFound).toBe(false);
  });

  it('実機の prompt-input にグローバルの AGENTS.md が混ざったら、agents_md が1つ増える（他の分類は変わらない）', () => {
    const result = promptInputBlocks(promptInputWithItems([agentsMdMessage()]));
    expect(result.blocks.filter((block) => block === 'agents_md')).toHaveLength(1);
    expect(result.blocks).toEqual(
      expect.arrayContaining(['permissions instructions', 'collaboration_mode', 'environment_context']),
    );
    expect(result.markerFound).toBe(true);
  });

  it('`# AGENTS.md instructions for <ディレクトリ>` の形でも、先頭に空白があっても agents_md', () => {
    expect(promptInputBlocks(JSON.stringify([agentsMdMessage('# AGENTS.md instructions for /work/dir\n\nrule')])).blocks).toEqual([
      'agents_md',
    ]);
    expect(promptInputBlocks(JSON.stringify([agentsMdMessage('\n  # AGENTS.md instructions\nrule')])).blocks).toEqual([
      'agents_md',
    ]);
  });

  it('文の途中に AGENTS.md と書いてあるだけの開発者ブロックは、agents_md にしない', () => {
    const json = JSON.stringify([
      messageBlock('developer', ['<multi_agent_mode>applicable AGENTS.md/skill instructions explicitly ask</multi_agent_mode>']),
    ]);
    expect(promptInputBlocks(json).blocks).toEqual(['multi_agent_mode']);
  });

  it('`<agents_md>` というタグで始まる文も agents_md', () => {
    expect(promptInputBlocks(JSON.stringify([messageBlock('developer', ['<agents_md>\nx'])])).blocks).toEqual([
      'agents_md',
    ]);
  });

  it('content_item_kinds が agents_md を示す部分は、文の見出しが違っても agents_md（content と同じ位置）', () => {
    const json = JSON.stringify([
      {
        ...messageBlock('user', ['<permissions instructions>\nx', 'ルールは次のとおり。']),
        internal_chat_message_metadata_passthrough: {
          content_item_kinds: ['permissions.instructions', 'agents_md.instructions'],
        },
      },
    ]);
    expect(promptInputBlocks(json).blocks).toEqual(['permissions instructions', 'agents_md']);
  });

  it('content_item_kinds の数が content と合わなくても、agents_md を含むなら項目として1つ数える', () => {
    const json = JSON.stringify([
      {
        ...messageBlock('user', ['<x_block>\nx', '<y_block>\ny']),
        internal_chat_message_metadata_passthrough: { content_item_kinds: ['agents_md.instructions'] },
      },
    ]);
    const blocks = promptInputBlocks(json).blocks;
    expect(blocks.filter((block) => block === 'agents_md')).toHaveLength(1);
    expect(blocks).toEqual(expect.arrayContaining(['x_block', 'y_block']));
  });

  it('content_item_kinds が agents_md を示さなければ、agents_md を足さない', () => {
    const json = JSON.stringify([
      {
        ...messageBlock('developer', ['<permissions instructions>\nx']),
        internal_chat_message_metadata_passthrough: { content_item_kinds: ['permissions.instructions'] },
      },
    ]);
    expect(promptInputBlocks(json).blocks).toEqual(['permissions instructions']);
  });

  it('禁止のブロックは agents_md を含み、死んだ user_instructions は含まない', () => {
    expect(FORBIDDEN_PROMPT_BLOCKS).toContain('agents_md');
    expect(FORBIDDEN_PROMPT_BLOCKS).not.toContain('user_instructions');
  });

  it('定数の分類は互いに重ならない', () => {
    const all = [...EXPECTED_PROMPT_BLOCKS, ...KNOWN_RESIDUAL_PROMPT_BLOCKS, ...FORBIDDEN_PROMPT_BLOCKS];
    expect(new Set(all).size).toBe(all.length);
  });
});

// ── runDoctor: 全部通るとき ─────────────────────────────────

describe('runDoctor（probe なし）: 全部通るとき', () => {
  it('ok は true。検査は固定の名前と順序で全部報告する', async () => {
    const { deps } = setup();
    const { report } = await runDoctor({ probe: false }, deps);

    expect(report.ok).toBe(true);
    expect(namesOf(report)).toEqual([...DOCTOR_CHECK_NAMES]);
    expect(report.cliVersion).toBe('0.153.4');
  });

  it('隔離以外の検査は ok。isolation は既知の残留で warn（warn は ok を止めない）', async () => {
    const { deps } = setup();
    const { report } = await runDoctor({ probe: false }, deps);

    for (const name of DOCTOR_CHECK_NAMES) {
      if (name === 'isolation') continue;
      expect(statusOf(report, name), name).toBe('ok');
    }
    expect(statusOf(report, 'isolation')).toBe('warn');
    expect(report.checks.some((check) => check.status === 'fail')).toBe(false);
  });

  it('isolation の detail は、残留している multi_agent_role を示し、結果が近似であることを書く', async () => {
    const { deps } = setup();
    const { report } = await runDoctor({ probe: false }, deps);
    const detail = checkOf(report, 'isolation').detail;

    expect(detail).toContain('multi_agent_role');
    expect(detail).toContain('近似');
  });

  it('probe の結果は null。推論の子プロセスは1つも起こさない（spawn 0 回）', async () => {
    const { deps, spawn } = setup();
    const { probe } = await runDoctor({ probe: false }, deps);

    expect(probe).toBeNull();
    expect(spawn.calls).toHaveLength(0);
  });

  it('ShortRun で exec を呼ぶのは --help と、provider が sentinel の strict-config 検査の2回だけ', async () => {
    const { deps, calls } = setup();
    await runDoctor({ probe: false }, deps);

    expect(calls.filter((call) => isLiveExec(call.args))).toEqual([]);
    const execs = calls.filter((call) => call.args[0] === 'exec');
    expect(execs).toHaveLength(2);
    expect(execs.filter((call) => call.args.includes('--help'))).toHaveLength(1);
    expect(execs.filter((call) => isSentinelExec(call.args))).toHaveLength(1);
  });

  it('短い確認コマンドは固定の引数で呼ぶ（--version / exec --help / debug models）', async () => {
    const { deps, calls } = setup();
    await runDoctor({ probe: false }, deps);
    const argLists = calls.map((call) => call.args);

    expect(argLists).toContainEqual(['--version']);
    expect(argLists).toContainEqual(['exec', '--help']);
    expect(argLists).toContainEqual(['debug', 'models']);
  });

  it('login status は exec と同じ認証の上書き（設定の credentials_store）で呼ぶ', async () => {
    const { deps, calls } = setup();
    await runDoctor({ probe: false }, deps);

    const login = calls.filter((call) => call.args[0] === 'login');
    expect(login).toHaveLength(1);
    expect(login[0]?.args).toEqual(loginStatusArgs('keyring'));

    const other = setup({ config: { credentials_store: 'file' } });
    await runDoctor({ probe: false }, other.deps);
    const otherLogin = other.calls.find((call) => call.args[0] === 'login');
    expect(otherLogin?.args).toEqual(loginStatusArgs('file'));
  });

  it('strict-config の呼び出しは、本番と同じ引数一式で provider だけ sentinel（--strict-config と隔離の上書きすべて）', async () => {
    const { deps, calls } = setup();
    await runDoctor({ probe: false }, deps);

    const call = calls.find((c) => isSentinelExec(c.args));
    expect(call).toBeDefined();
    const args = call?.args ?? [];

    expect(args[0]).toBe('exec');
    expect(args).toContain('--strict-config');
    expect(args).toContain('--ignore-user-config');
    expect(argAfter(args, '--model')).toBe('gpt-6-astra');
    expect(argAfter(args, '--sandbox')).toBe('read-only');
    expect(args).toContain('--ephemeral');
    expect(args).toContain('--json');
    expect(args.at(-1)).toBe('-');
    expect(hasConfig(args, SENTINEL_ARG)).toBe(true);
    expect(hasConfig(args, 'model_provider="openai"')).toBe(false);
    expect(hasConfig(args, 'forced_login_method="chatgpt"')).toBe(true);
    expect(hasConfig(args, 'cli_auth_credentials_store="keyring"')).toBe(true);
    expect(hasConfig(args, 'model_reasoning_effort="high"')).toBe(true);
    expect(args.some((arg) => arg.startsWith('model_instructions_file='))).toBe(true);
    // verbosity が null なら渡さない
    expect(args.some((arg) => arg.startsWith('model_verbosity='))).toBe(false);
    for (const override of ISOLATION_OVERRIDES) {
      expect(hasConfig(args, override), override).toBe(true);
    }
    expect(hasForbiddenFlag(args)).toBe(false);
    expect(call?.options.timeoutMs).toBeGreaterThan(0);
  });

  it('verbosity を設定していれば、strict-config の検査にも model_verbosity を含める', async () => {
    const { deps, calls } = setup({ config: { verbosity: 'low' } });
    const { report } = await runDoctor({ probe: false }, deps);

    expect(statusOf(report, 'catalog')).toBe('ok');
    const call = calls.find((c) => isSentinelExec(c.args));
    expect(hasConfig(call?.args ?? [], 'model_verbosity="low"')).toBe(true);
  });

  it('strict-config の --cd は makeWorkdir の作った作業ディレクトリ（root の外）', async () => {
    const { deps, calls, created, root } = setup();
    await runDoctor({ probe: false }, deps);

    const call = calls.find((c) => isSentinelExec(c.args));
    const cd = argAfter(call?.args ?? [], '--cd');
    expect(cd).toBeDefined();
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(created).toContain(cd);
    expect(cd?.startsWith(root)).toBe(false);
  });

  it('prompt-input は、本番と同じく root の外の空の作業ディレクトリで動かし、あとで消す', async () => {
    // リポジトリの中で動かすと、本番（Git の外の空のディレクトリ）には無い文脈が見えうる
    const { deps, calls, created, root } = setup();
    await runDoctor({ probe: false }, deps);

    const call = calls.find((c) => c.args[0] === 'debug' && c.args[1] === 'prompt-input');
    const cwd = call?.options.cwd;
    expect(cwd).toBeDefined();
    expect(created).toContain(cwd);
    expect(cwd?.startsWith(root)).toBe(false);
    expect(existsSync(cwd ?? '')).toBe(false);
    // instructions も、その作業ディレクトリの中の写しを指す（本番は run の中の写しを渡す）
    const instructions = (call?.args ?? []).find((arg) => arg.startsWith('model_instructions_file='));
    expect(instructions).toBeDefined();
    expect(JSON.parse(instructions?.slice('model_instructions_file='.length) ?? '""').startsWith(cwd ?? '//')).toBe(
      true,
    );
  });

  it('prompt-input の呼び出しは、exec と同じ上書きと model、最後に印の文字列', async () => {
    const { deps, calls } = setup();
    await runDoctor({ probe: false }, deps);

    const call = calls.find((c) => c.args[0] === 'debug' && c.args[1] === 'prompt-input');
    expect(call).toBeDefined();
    const args = call?.args ?? [];
    expect(args.at(-1)).toBe(PROMPT_INPUT_MARKER);
    expect(hasConfig(args, 'model="gpt-6-astra"')).toBe(true);
    expect(hasConfig(args, 'forced_login_method="chatgpt"')).toBe(true);
    for (const override of ISOLATION_OVERRIDES) {
      expect(hasConfig(args, override), override).toBe(true);
    }
    // prompt-input は --ignore-user-config を受けない
    expect(args).not.toContain('--ignore-user-config');
    expect(hasForbiddenFlag(args)).toBe(false);
  });

  it('検査が作った作業ディレクトリは、終わったあとに消えている', async () => {
    const { deps, created, removed } = setup();
    await runDoctor({ probe: false }, deps);

    expect(created.length).toBeGreaterThanOrEqual(1);
    for (const dir of created) {
      expect(removed, dir).toContain(dir);
      expect(existsSync(dir), dir).toBe(false);
    }
  });

  it('失敗した検査があっても、作業ディレクトリは消す', async () => {
    const { deps, created } = setup({
      short: { strictConfigStderr: REAL.unknownField },
    });
    await runDoctor({ probe: false }, deps);

    for (const dir of created) expect(existsSync(dir), dir).toBe(false);
  });

  it('probe なしの doctor は、制作の run を1つも作らない', async () => {
    const { deps } = setup();
    await runDoctor({ probe: false }, deps);

    const entries = existsSync(deps.runsRoot) ? readdirSync(deps.runsRoot) : [];
    expect(entries).toEqual([]);
  });

  it('親の環境を変えない', async () => {
    const { deps, env, envBefore } = setup({
      env: { ...BASE_ENV, OPENAI_API_KEY: 'sk-test-secret', CODEX_API_KEY: 'sk-codex-secret' },
    });
    await runDoctor({ probe: false }, deps);

    expect(deps.env).toBe(env);
    expect(env).toEqual(envBefore);
    expect(env.OPENAI_API_KEY).toBe('sk-test-secret');
  });
});

// ── env ─────────────────────────────────────────────────────

describe('runDoctor: 環境（env 検査と、子へ渡す環境）', () => {
  const secretEnv: NodeJS.ProcessEnv = {
    ...BASE_ENV,
    OPENAI_API_KEY: 'sk-test-secret',
    OPENAI_BASE_URL: 'https://proxy.example/v1',
    CODEX_API_KEY: 'sk-codex-secret',
    AZURE_OPENAI_ENDPOINT: 'https://azure-secret.example',
    GEMINI_API_KEY: 'g-secret-value',
  };
  const secretValues = [
    'sk-test-secret',
    'https://proxy.example/v1',
    'sk-codex-secret',
    'https://azure-secret.example',
    'g-secret-value',
  ];
  const removedNames = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'GEMINI_API_KEY'];

  it('env の detail は外す変数の名前を示し、値は出さない。status は常に ok', async () => {
    const { deps } = setup({ env: secretEnv });
    const { report } = await runDoctor({ probe: false }, deps);
    const check = checkOf(report, 'env');

    expect(check.status).toBe('ok');
    expect(check.detail).toContain('OPENAI_API_KEY');
    for (const name of removedNames) expect(check.detail, name).toContain(name);
    for (const value of secretValues) expect(check.detail, value).not.toContain(value);
  });

  it('報告・ログのどこにも、環境変数の値は出ない', async () => {
    const { deps, logs } = setup({ env: secretEnv });
    const { report } = await runDoctor({ probe: false }, deps);

    const text = `${JSON.stringify(report)}\n${logs.join('\n')}`;
    for (const value of secretValues) expect(text, value).not.toContain(value);
  });

  it('どの短いコマンドにも、API キー・endpoint の上書きを外した環境の複製を渡す（CODEX_HOME は残す）', async () => {
    const { deps, calls, env } = setup({ env: secretEnv });
    await runDoctor({ probe: false }, deps);

    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const call of calls) {
      for (const name of removedNames) {
        expect(call.options.env, `${call.args.join(' ')}: ${name}`).not.toHaveProperty(name);
      }
      expect(call.options.env.PATH).toBe('/usr/bin');
      expect(call.options.env.CODEX_HOME).toBe('/home/velum-test/.codex');
      expect(call.options.env).not.toBe(env);
      expect(call.options.timeoutMs).toBeGreaterThan(0);
    }
    // 親の環境は残っている
    expect(env.OPENAI_API_KEY).toBe('sk-test-secret');
  });

  it('外す変数が無い環境でも、env は ok', async () => {
    const { deps } = setup();
    const { report } = await runDoctor({ probe: false }, deps);

    expect(statusOf(report, 'env')).toBe('ok');
  });
});

// ── 失敗する検査 ────────────────────────────────────────────

type FailCase = { title: string; check: DoctorCheckName; setup: Setup };

const failCases: FailCase[] = [
  { title: 'API キーでログインしている', check: 'auth', setup: { short: { login: REAL.loginApiKey } } },
  { title: '未ログイン', check: 'auth', setup: { short: { login: REAL.notLoggedIn } } },
  {
    title: 'login status の実行が失敗（timeout）',
    check: 'auth',
    setup: {
      override: (args) =>
        args[0] === 'login'
          ? { exitCode: null, stdout: '', stderr: '', error: 'timeout after 30000ms' }
          : null,
    },
  },
  { title: 'CLI が最低の版より古い（0.152.0）', check: 'cli-version', setup: { short: { version: 'codex-cli 0.152.0' } } },
  { title: 'CLI の版の出力が読めない', check: 'cli-version', setup: { short: { version: 'weird output' } } },
  { title: 'codex が見つからない', check: 'cli-version', setup: { short: { missingCli: true } } },
  {
    title: 'exec --help に --strict-config が無い',
    check: 'exec-flags',
    setup: { short: { execHelp: readCliFixture('exec-help.txt').replaceAll('--strict-config', '--strict-cfg') } },
  },
  {
    title: '設定の effort がカタログに無い（superhigh）',
    check: 'catalog',
    setup: { config: { reasoning_effort: 'superhigh' } },
  },
  {
    title: '設定のモデルがカタログに無い',
    check: 'catalog',
    setup: { config: { model: 'gpt-not-in-catalog' } },
  },
  { title: 'カタログが壊れた JSON', check: 'catalog', setup: { short: { catalog: 'not json {' } } },
  {
    title: 'verbosity を設定したがモデルが対応していない',
    check: 'catalog',
    setup: {
      config: { verbosity: 'low' },
      short: { catalog: catalogWith('gpt-6-astra', { support_verbosity: false }) },
    },
  },
  {
    title: '.gitignore に .story-runs/ が無い',
    check: 'gitignore',
    setup: { gitignore: 'node_modules/\ndist/\n' },
  },
  { title: '.gitignore が無い', check: 'gitignore', setup: { gitignore: null } },
  {
    title: '.story-runs/ がコメントアウトされている',
    check: 'gitignore',
    setup: { gitignore: '# .story-runs/\nnode_modules/\n' },
  },
  { title: 'instructions のファイルが無い', check: 'config', setup: { instructions: false } },
  {
    title: 'strict-config: 未知の設定キー',
    check: 'strict-config',
    setup: { short: { strictConfigStderr: REAL.unknownField } },
  },
  {
    title: 'strict-config: 未知の enum 値',
    check: 'strict-config',
    setup: {
      short: {
        strictConfigStderr:
          'Error loading config.toml: unknown variant `bogus`, expected one of `never`, `on-request` in -c/--config override',
      },
    },
  },
  {
    title: 'strict-config: sentinel 以外の provider が見つからないと言って止まった',
    check: 'strict-config',
    setup: { short: { strictConfigStderr: 'Error: Model provider `openai` not found' } },
  },
  {
    title: 'strict-config: 想定外のエラーで止まった',
    check: 'strict-config',
    setup: { short: { strictConfigStderr: 'Error: something unexpected happened' } },
  },
  {
    title: 'strict-config: stdout に thread.started が出た（推論が始まった）',
    check: 'strict-config',
    setup: {
      override: (args) =>
        isSentinelExec(args)
          ? sentinelResult({ exitCode: 0, stdout: `${JSON.stringify({ type: 'thread.started', thread_id: 't1' })}\n` })
          : null,
    },
  },
  {
    title: 'strict-config: 実行の失敗（timeout）',
    check: 'strict-config',
    setup: {
      override: (args) =>
        isSentinelExec(args)
          ? { exitCode: null, stdout: '', stderr: '', error: 'timeout after 30000ms' }
          : null,
    },
  },
  ...FORBIDDEN_PROMPT_BLOCKS.map(
    (tag): FailCase => ({
      title: `モデルに ${tag} のブロックが見える`,
      check: 'isolation',
      setup: { short: { promptInput: promptInputWith([`<${tag}>\n中身`]) } },
    }),
  ),
  {
    title: '開発者ブロックに <skills_instructions> が見える',
    check: 'isolation',
    setup: { short: { promptInput: promptInputWith(['<skills_instructions>\n## Skills\n...']) } },
  },
];

describe('runDoctor: 検査が通らないとき', () => {
  for (const failCase of failCases) {
    it(`${failCase.title} → ${failCase.check} が fail で、ok は false。検査は全部報告し、推論は呼ばない`, async () => {
      const { deps, spawn, calls } = setup(failCase.setup);
      const { report, probe } = await runDoctor({ probe: false }, deps);

      expect(statusOf(report, failCase.check)).toBe('fail');
      expect(report.ok).toBe(false);
      expect(namesOf(report)).toEqual([...DOCTOR_CHECK_NAMES]);
      expect(probe).toBeNull();
      expect(spawn.calls).toHaveLength(0);
      expect(calls.filter((call) => isLiveExec(call.args))).toEqual([]);
    });

    it(`${failCase.title} → probe を要求しても Astra は呼ばない（probe は null・spawn 0 回）`, async () => {
      const { deps, spawn, calls } = setup(failCase.setup);
      const { report, probe } = await runDoctor({ probe: true }, deps);

      expect(report.ok).toBe(false);
      expect(probe).toBeNull();
      expect(spawn.calls).toHaveLength(0);
      expect(calls.filter((call) => isLiveExec(call.args))).toEqual([]);
    });
  }

  it('検査は互いに独立（strict-config が失敗しても、ほかの検査は ok のまま）', async () => {
    const { deps } = setup({ short: { strictConfigStderr: REAL.unknownField } });
    const { report } = await runDoctor({ probe: false }, deps);

    expect(statusOf(report, 'strict-config')).toBe('fail');
    for (const name of ['config', 'gitignore', 'cli-version', 'exec-flags', 'auth', 'catalog', 'env'] as const) {
      expect(statusOf(report, name), name).toBe('ok');
    }
  });

  it('exec-flags: 足りないフラグの名前を detail に示す', async () => {
    const { deps } = setup({
      short: { execHelp: readCliFixture('exec-help.txt').replaceAll('--strict-config', '--strict-cfg') },
    });
    const { report } = await runDoctor({ probe: false }, deps);

    expect(checkOf(report, 'exec-flags').detail).toContain('--strict-config');
  });

  for (const flag of REQUIRED_EXEC_FLAGS) {
    it(`exec-flags: ${flag} だけが無い exec --help でも fail`, async () => {
      const others = REQUIRED_EXEC_FLAGS.filter((other) => other !== flag);
      const help = ['Usage: codex exec [OPTIONS]', ...others.map((other) => `      ${other} <VALUE>`)].join('\n');
      const { deps } = setup({ short: { execHelp: `${help}\n` } });
      const { report } = await runDoctor({ probe: false }, deps);

      expect(statusOf(report, 'exec-flags')).toBe('fail');
      expect(checkOf(report, 'exec-flags').detail).toContain(flag);
    });
  }

  it('exec-flags: 必要なフラグがすべてある exec --help なら ok', async () => {
    const help = ['Usage: codex exec [OPTIONS]', ...REQUIRED_EXEC_FLAGS.map((flag) => `      ${flag} <VALUE>`)].join('\n');
    const { deps } = setup({ short: { execHelp: `${help}\n` } });
    const { report } = await runDoctor({ probe: false }, deps);

    expect(statusOf(report, 'exec-flags')).toBe('ok');
  });

  it('cli-version: 失敗しても読めた版は報告する。読めなければ null', async () => {
    const old = await runDoctor(
      { probe: false },
      setup({ short: { version: 'codex-cli 0.152.0' } }).deps,
    );
    expect(old.report.cliVersion).toBe('0.152.0');

    const unreadable = await runDoctor({ probe: false }, setup({ short: { version: 'weird output' } }).deps);
    expect(unreadable.report.cliVersion).toBeNull();

    const missing = await runDoctor({ probe: false }, setup({ short: { missingCli: true } }).deps);
    expect(missing.report.cliVersion).toBeNull();
  });

  it('cli-version: 最低の版（min_version）ちょうどは通る。最低の版は設定から取る', async () => {
    const exact = await runDoctor(
      { probe: false },
      setup({ short: { version: 'codex-cli 0.153.0' } }).deps,
    );
    expect(statusOf(exact.report, 'cli-version')).toBe('ok');

    const stricter = await runDoctor(
      { probe: false },
      setup({ config: { cli: { command: 'codex', min_version: '0.200.0' } } }).deps,
    );
    expect(statusOf(stricter.report, 'cli-version')).toBe('fail');
  });

  it('catalog: カタログが対応する effort（max・ultra を含む）は ok', async () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
      const { deps } = setup({ config: { reasoning_effort: effort } });
      const { report } = await runDoctor({ probe: false }, deps);
      expect(statusOf(report, 'catalog'), effort).toBe('ok');
    }
  });

  it('catalog: verbosity を設定していなければ、モデルが verbosity に対応しなくても ok', async () => {
    const { deps } = setup({
      config: { verbosity: null },
      short: { catalog: catalogWith('gpt-6-astra', { support_verbosity: false }) },
    });
    const { report } = await runDoctor({ probe: false }, deps);

    expect(statusOf(report, 'catalog')).toBe('ok');
  });

  it('config: instructions のファイルがあれば ok', async () => {
    const { deps } = setup();
    const { report } = await runDoctor({ probe: false }, deps);

    expect(statusOf(report, 'config')).toBe('ok');
    expect(existsSync(join(deps.root, deps.config.instructions))).toBe(true);
  });

  it('gitignore: .story-runs/ の行があれば ok（ほかの行があっても、行末の空白があっても）', async () => {
    const { deps } = setup({ gitignore: 'node_modules/\r\n.story-runs/\r\ndist/\r\n' });
    const { report } = await runDoctor({ probe: false }, deps);

    expect(statusOf(report, 'gitignore')).toBe('ok');
  });

  it('codex が見つからなくても、投げずに報告する', async () => {
    const { deps } = setup({ short: { missingCli: true } });
    const { report, probe } = await runDoctor({ probe: true }, deps);

    expect(report.ok).toBe(false);
    expect(probe).toBeNull();
    expect(statusOf(report, 'cli-version')).toBe('fail');
    expect(statusOf(report, 'auth')).not.toBe('ok');
  });
});

// ── isolation ───────────────────────────────────────────────

describe('runDoctor: isolation（prompt-input の分類）', () => {
  it('期待するブロックだけなら ok', async () => {
    const promptInput = JSON.stringify([
      messageBlock('developer', ['<permissions instructions>\nx', '<collaboration_mode># x']),
      messageBlock('user', ['<environment_context>\nx']),
      messageBlock('user', [PROMPT_INPUT_MARKER]),
    ]);
    const { deps } = setup({ short: { promptInput } });
    const { report } = await runDoctor({ probe: false }, deps);

    expect(statusOf(report, 'isolation')).toBe('ok');
    expect(report.ok).toBe(true);
  });

  it('既知の残留（multi_agent_role / multi_agent_mode）は warn で、ok は止めない', async () => {
    for (const tag of KNOWN_RESIDUAL_PROMPT_BLOCKS) {
      const promptInput = JSON.stringify([
        messageBlock('developer', ['<permissions instructions>\nx', `<${tag}>x`]),
        messageBlock('user', ['<environment_context>\nx', PROMPT_INPUT_MARKER]),
      ]);
      const { deps } = setup({ short: { promptInput } });
      const { report } = await runDoctor({ probe: false }, deps);

      expect(statusOf(report, 'isolation'), tag).toBe('warn');
      expect(checkOf(report, 'isolation').detail, tag).toContain(tag);
      expect(report.ok, tag).toBe(true);
    }
  });

  it('知らないブロックは warn（fail にはしない）。名前を detail に示す', async () => {
    const { deps } = setup({ short: { promptInput: promptInputWith(['<some_new_block>\n中身']) } });
    const { report } = await runDoctor({ probe: false }, deps);

    expect(statusOf(report, 'isolation')).toBe('warn');
    expect(checkOf(report, 'isolation').detail).toContain('some_new_block');
    expect(report.ok).toBe(true);
  });

  it('禁止のブロック（Skills など）は fail で、detail にその名前を示す', async () => {
    const { deps } = setup({
      short: { promptInput: promptInputWith(['<skills_instructions>\n## Skills\n...']) },
    });
    const { report } = await runDoctor({ probe: false }, deps);

    expect(statusOf(report, 'isolation')).toBe('fail');
    expect(checkOf(report, 'isolation').detail).toContain('skills_instructions');
    expect(report.ok).toBe(false);
  });

  it('禁止のブロックと既知の残留が両方あれば、全体は fail', async () => {
    const { deps } = setup({
      short: { promptInput: promptInputWith(['<recommended_plugins>\n中身', '<multi_agent_role>x']) },
    });
    const { report } = await runDoctor({ probe: false }, deps);

    expect(statusOf(report, 'isolation')).toBe('fail');
  });

  it('prompt-input の実行が失敗しても、投げず、ok とは報告しない', async () => {
    const { deps } = setup({
      override: (args) =>
        args[0] === 'debug' && args[1] === 'prompt-input'
          ? { exitCode: 1, stdout: '', stderr: 'boom\n', error: null }
          : null,
    });
    const { report } = await runDoctor({ probe: false }, deps);

    expect(statusOf(report, 'isolation')).not.toBe('ok');
  });

  it('prompt-input が JSON として読めなくても、投げず、ok とは報告しない', async () => {
    const { deps } = setup({ short: { promptInput: 'not json {' } });
    const { report } = await runDoctor({ probe: false }, deps);

    expect(statusOf(report, 'isolation')).not.toBe('ok');
  });
});

describe('runDoctor: isolation（グローバルの AGENTS.md）', () => {
  it('prompt-input にグローバルの AGENTS.md のブロックが見えたら fail。detail に agents_md を示し、probe は走らない', async () => {
    const { deps, spawn } = setup({ short: { promptInput: promptInputWithItems([agentsMdMessage()]) } });
    const { report, probe } = await runDoctor({ probe: true }, deps);

    expect(statusOf(report, 'isolation')).toBe('fail');
    expect(checkOf(report, 'isolation').detail).toContain('agents_md');
    expect(report.ok).toBe(false);
    expect(probe).toBeNull();
    expect(spawn.calls).toHaveLength(0);
  });

  it('content_item_kinds だけが agents_md を示す prompt-input でも fail', async () => {
    const item = {
      ...messageBlock('user', ['見出しの違う文']),
      internal_chat_message_metadata_passthrough: { content_item_kinds: ['agents_md.instructions'] },
    };
    const { deps } = setup({ short: { promptInput: promptInputWithItems([item]) } });
    const { report } = await runDoctor({ probe: false }, deps);

    expect(statusOf(report, 'isolation')).toBe('fail');
  });

  for (const name of ['AGENTS.md', 'AGENTS.override.md']) {
    it(`CODEX_HOME に ${name} があれば、prompt-input が清潔でも fail（ファイルの有無を直接見る）`, async () => {
      const home = codexHomeWith(name);
      const { deps, spawn } = setup({ env: { ...BASE_ENV, CODEX_HOME: home } });
      const { report, probe } = await runDoctor({ probe: true }, deps);

      const check = checkOf(report, 'isolation');
      expect(check.status).toBe('fail');
      expect(check.detail).toContain(join(home, name));
      expect(check.detail).toContain('一時的');
      expect(check.detail).toMatch(/移/);
      expect(check.detail).not.toMatch(/削除|消して|rm /);
      expect(report.ok).toBe(false);
      expect(probe).toBeNull();
      expect(spawn.calls).toHaveLength(0);
      // 検査はほかの検査に影響しない。ファイルには触れない
      for (const other of ['config', 'gitignore', 'cli-version', 'exec-flags', 'auth', 'catalog', 'strict-config'] as const) {
        expect(statusOf(report, other), other).toBe('ok');
      }
      expect(existsSync(join(home, name))).toBe(true);
      expect(readFileSync(join(home, name), 'utf8')).toBe('# 開発用の指示\nrule\n');
    });
  }

  it('prompt-input の実行が失敗しても、グローバルの AGENTS.md があれば fail（warn に落とさない）', async () => {
    const home = codexHomeWith('AGENTS.md');
    const { deps } = setup({
      env: { ...BASE_ENV, CODEX_HOME: home },
      override: (args) =>
        args[0] === 'debug' && args[1] === 'prompt-input'
          ? { exitCode: 1, stdout: '', stderr: 'boom\n', error: null }
          : null,
    });
    const { report } = await runDoctor({ probe: false }, deps);

    expect(statusOf(report, 'isolation')).toBe('fail');
    expect(checkOf(report, 'isolation').detail).toContain(join(home, 'AGENTS.md'));
  });

  it('CODEX_HOME が無ければ HOME/.codex を見る', async () => {
    const fakeHome = join(tmp, 'fake-home-for-fallback');
    mkdirSync(join(fakeHome, '.codex'), { recursive: true });
    writeFileSync(join(fakeHome, '.codex', 'AGENTS.md'), 'x\n');
    const { deps } = setup({ env: { PATH: '/usr/bin', HOME: fakeHome } });
    const { report } = await runDoctor({ probe: false }, deps);

    expect(statusOf(report, 'isolation')).toBe('fail');
    expect(checkOf(report, 'isolation').detail).toContain(join(fakeHome, '.codex', 'AGENTS.md'));
  });

  it('指示ファイルが無い CODEX_HOME なら、いつもどおり（既知の残留で warn）', async () => {
    const { deps } = setup({ env: { ...BASE_ENV, CODEX_HOME: codexHomeWith() } });
    const { report } = await runDoctor({ probe: false }, deps);

    expect(statusOf(report, 'isolation')).toBe('warn');
    expect(report.ok).toBe(true);
  });
});

// ── 中断 ────────────────────────────────────────────────────

describe('runDoctor: 親の中断（abortSignal）', () => {
  const INTERRUPTED = '中断されたので実行していない';

  it('どの短いコマンドにも abortSignal をそのまま渡す', async () => {
    const controller = new AbortController();
    const { deps, calls } = setup({ abortSignal: controller.signal });
    await runDoctor({ probe: false }, deps);

    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const call of calls) expect(call.options.abortSignal, call.args.join(' ')).toBe(controller.signal);
  });

  it('最初から中断されていれば、ShortRun を1回も呼ばず、全検査が fail（中断）。probe は走らない', async () => {
    const controller = new AbortController();
    controller.abort();
    const { deps, calls, spawn, created } = setup({ abortSignal: controller.signal });
    const { report, probe } = await runDoctor({ probe: true }, deps);

    expect(calls).toEqual([]);
    expect(spawn.calls).toHaveLength(0);
    expect(created).toEqual([]);
    expect(probe).toBeNull();
    expect(report.ok).toBe(false);
    expect(namesOf(report)).toEqual([...DOCTOR_CHECK_NAMES]);
    for (const check of report.checks) {
      expect(check.status, check.name).toBe('fail');
      expect(check.detail, check.name).toBe(INTERRUPTED);
    }
    expect(report.cliVersion).toBeNull();
  });

  it('途中で中断されたら、それ以降の検査は起こさず fail（中断）。そこまでの結果は残る', async () => {
    const controller = new AbortController();
    const { deps, calls, spawn } = setup({
      abortSignal: controller.signal,
      override: (args) => {
        if (args[0] === '--version') controller.abort();
        return null;
      },
    });
    const { report, probe } = await runDoctor({ probe: true }, deps);

    expect(calls.map((call) => call.args)).toEqual([['--version']]);
    expect(spawn.calls).toHaveLength(0);
    expect(probe).toBeNull();
    expect(report.ok).toBe(false);
    expect(namesOf(report)).toEqual([...DOCTOR_CHECK_NAMES]);
    for (const name of ['config', 'gitignore', 'cli-version'] as const) {
      expect(statusOf(report, name), name).toBe('ok');
    }
    for (const name of ['exec-flags', 'auth', 'catalog', 'strict-config', 'isolation', 'env'] as const) {
      expect(statusOf(report, name), name).toBe('fail');
      expect(checkOf(report, name).detail, name).toBe(INTERRUPTED);
    }
    expect(report.cliVersion).toBe('0.153.4');
  });

  it('最後に走る短い検査（isolation）の実行中に中断されても、probe は走らず ok は false', async () => {
    const controller = new AbortController();
    const { deps, spawn } = setup({
      abortSignal: controller.signal,
      override: (args) => {
        if (args[0] === 'debug' && args[1] === 'prompt-input') controller.abort();
        return null;
      },
    });
    const { report, probe } = await runDoctor({ probe: true }, deps);

    expect(probe).toBeNull();
    expect(spawn.calls).toHaveLength(0);
    expect(report.ok).toBe(false);
    expect(statusOf(report, 'env')).toBe('fail');
    expect(checkOf(report, 'env').detail).toBe(INTERRUPTED);
  });

  it('実行中に中断された（ShortRun が interrupted の error を返した）検査は、PATH の誤りとして案内せず、中断として示す', async () => {
    const controller = new AbortController();
    const { deps } = setup({
      abortSignal: controller.signal,
      override: (args) => {
        if (args[0] !== '--version') return null;
        controller.abort();
        return { exitCode: null, stdout: '', stderr: '', error: 'interrupted: 親の中断で止めた' };
      },
    });
    const { report } = await runDoctor({ probe: false }, deps);

    const check = checkOf(report, 'cli-version');
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('中断');
    expect(check.detail).not.toContain('PATH');
  });

  it('中断されていなければ、「中断」の文言は報告のどこにも出ない', async () => {
    const controller = new AbortController();
    const { deps } = setup({ abortSignal: controller.signal });
    const { report } = await runDoctor({ probe: false }, deps);

    expect(JSON.stringify(report)).not.toContain('中断');
  });
});

// ── CLI が古いときの更新の案内 ──────────────────────────────

describe('runDoctor: cli-version（CLI が古いとき、更新のしかたを示す。自動では更新しない）', () => {
  it('npm での更新コマンド・自動更新しないこと・docs の節を示す', async () => {
    const { deps } = setup({ short: { version: 'codex-cli 0.152.0' } });
    const { report } = await runDoctor({ probe: false }, deps);

    const check = checkOf(report, 'cli-version');
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('0.152.0');
    expect(check.detail).toContain('0.153.0');
    expect(check.detail).toContain('npm install -g @openai/codex@<版>');
    expect(check.detail).toMatch(/自動(?:では|で)?更新(?:し|され)(?:ません|ない)/);
    expect(check.detail).toContain('docs/story-authoring.md §3');
  });
});

// ── probe ───────────────────────────────────────────────────

describe('runDoctor（probe あり）', () => {
  it('全部通れば、Astra を1回だけ呼ぶ（warn は止めない）。応答は run として保存される', async () => {
    const { deps, spawn } = setup();
    const { report, probe } = await runDoctor({ probe: true }, deps);

    expect(report.ok).toBe(true);
    expect(statusOf(report, 'isolation')).toBe('warn');
    expect(spawn.calls).toHaveLength(1);
    if (!probe || probe.status !== 'succeeded') {
      throw new Error(`probe が成功していません: ${JSON.stringify(probe)}`);
    }
    expect(probe.record.purpose).toBe('probe');
    expect(probe.record.stage).toBe('probe');
    expect(probe.record.status).toBe('succeeded');
    expect(probe.record.requested.model).toBe('gpt-6-astra');
    expect(probe.record.requested.fallback).toBe('none');
    expect(probe.record.requested.retries).toBe(0);
    expect(probe.runDir.startsWith(deps.runsRoot)).toBe(true);
    expect(readFileSync(join(probe.runDir, 'probe.raw.txt'), 'utf8')).toBe('準備完了');
  });

  it('probe の子プロセスは、固定の短い入力・本番の引数・sanitize した環境で起こす（執筆の資料は含めない）', async () => {
    const { deps, spawn, calls } = setup({
      env: { ...BASE_ENV, OPENAI_API_KEY: 'sk-test-secret' },
    });
    await runDoctor({ probe: true }, deps);

    expect(spawn.calls).toHaveLength(1);
    const call = spawn.calls[0];
    const args = call?.args ?? [];
    expect(call?.command).toBe('codex');
    expect(args[0]).toBe('exec');
    expect(args).toContain('--strict-config');
    expect(args).toContain('--ignore-user-config');
    expect(argAfter(args, '--model')).toBe('gpt-6-astra');
    expect(hasConfig(args, 'model_provider="openai"')).toBe(true);
    expect(hasConfig(args, SENTINEL_ARG)).toBe(false);
    expect(hasConfig(args, 'forced_login_method="chatgpt"')).toBe(true);
    for (const override of ISOLATION_OVERRIDES) {
      expect(hasConfig(args, override), override).toBe(true);
    }
    expect(hasForbiddenFlag(args)).toBe(false);

    const stdin = call?.stdin() ?? '';
    expect(stdin).toContain(PROBE_PROMPT);
    expect(stdin).not.toContain('<attachment');

    expect(call?.options.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(call?.options.env.CODEX_HOME).toBe('/home/velum-test/.codex');
    expect(call?.options.detached).toBe(true);

    // 推論は ShortRun ではなく spawn だけ
    expect(calls.filter((c) => isLiveExec(c.args))).toEqual([]);
  });

  it('probe が失敗しても、再試行しない（spawn は1回）。途中の出力を応答として昇格させない', async () => {
    const { deps, spawn } = setup({
      spawn: {
        events: failedTurnEvents('usage limit reached'),
        exitCode: 1,
        output: '途中までの出力',
      },
    });
    const { probe } = await runDoctor({ probe: true }, deps);

    expect(spawn.calls).toHaveLength(1);
    if (!probe || probe.status !== 'failed') {
      throw new Error(`probe が失敗として返っていません: ${JSON.stringify(probe)}`);
    }
    expect(probe.record.status).toBe('failed');
    expect(probe.record.failure).not.toBeNull();
    expect(existsSync(join(probe.runDir, 'probe.raw.txt'))).toBe(false);
  });

  it('probe の作業ディレクトリも、終わったあとに消えている', async () => {
    const { deps, created } = setup();
    await runDoctor({ probe: true }, deps);

    expect(created.length).toBeGreaterThanOrEqual(1);
    for (const dir of created) expect(existsSync(dir), dir).toBe(false);
  });
});

describe('DOCTOR_SENTINEL_PROVIDER', () => {
  it('偽の ShortRun が見分ける名前と同じ', () => {
    expect(DOCTOR_SENTINEL_PROVIDER).toBe('velum-doctor-no-inference');
  });
});
