import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { ROOT } from '../../src/lib/paths.js';
import { FAILURE_KINDS } from '../../src/story/authoring/codex-events.js';
import type { WriterConfig } from '../../src/story/authoring/config.js';
import {
  DRAFT_FRAMING,
  PROBE_FRAMING,
  PROBE_INSTRUCTIONS,
  PROBE_PROMPT,
  REVISE_FRAMING,
  draftPrompt,
  revisePrompt,
} from '../../src/story/authoring/prompt.js';
import {
  draftStory,
  failureAdvice,
  probeAstra,
  realAuthoringDeps,
  reviseStory,
  type AuthoringDeps,
  type DraftOptions,
  type ReviseOptions,
  type RunOutcome,
} from '../../src/story/authoring/run.js';
import { RunRecordSchema, type RunInput, type RunRecord } from '../../src/story/authoring/runs.js';
import {
  REAL,
  argAfter,
  failedTurnEvents,
  fakeShortRun,
  fakeSpawn,
  okEvents,
  toolCallEvents,
  type FakeBehavior,
  type FakeShortOptions,
  type SpawnCall,
} from '../helpers/fake-codex.js';

/**
 * 既定の秘密の照合（src/lib/secrets.ts の secretLeaksIn）は実データの人物 YAML を読む。このテストは実データに
 * 依存しないので、モジュールごと差し替える（deps.secretLeaks を渡すテストは、この差し替えを通らない）。
 * runs.ts は、書き込みの順の記録と、指定した書き込みの失敗（ディスクが一杯、など）を起こすために包む。
 * 包んだだけで、既定ではそのまま本物を呼ぶ。
 */
const { secretLeaksInMock, runsFaults } = vi.hoisted(() => ({
  secretLeaksInMock: vi.fn((_text: string): Array<{ owner: string; segment: string }> => []),
  runsFaults: {
    /** 書き込みの順（writeFileNoClobber はファイル名、moveNoClobber は `move:<移し先の名前>`、writeRunRecord は `write:run.json#<回数>`） */
    ops: [] as string[],
    /** このファイル名の writeFileNoClobber を失敗させる */
    failFile: null as string | null,
    /** この回数目の writeRunRecord を失敗させる（1 回目 = running、2 回目 = 終了時） */
    failRecordOn: null as number | null,
    recordCalls: 0,
  },
}));
vi.mock('../../src/lib/secrets.js', () => ({ secretLeaksIn: secretLeaksInMock }));
vi.mock('../../src/story/authoring/runs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/story/authoring/runs.js')>();
  const nameOf = (path: string): string => path.split(/[\\/]/).pop() ?? path;
  return {
    ...actual,
    writeFileNoClobber: (path: string, content: string | Uint8Array): void => {
      runsFaults.ops.push(nameOf(path));
      if (runsFaults.failFile === nameOf(path)) throw new Error(`disk full: ${nameOf(path)}`);
      actual.writeFileNoClobber(path, content);
    },
    moveNoClobber: (from: string, to: string): void => {
      runsFaults.ops.push(`move:${nameOf(to)}`);
      actual.moveNoClobber(from, to);
    },
    writeRunRecord: (runDir: string, record: RunRecord): void => {
      runsFaults.recordCalls += 1;
      runsFaults.ops.push(`write:run.json#${runsFaults.recordCalls}`);
      if (runsFaults.failRecordOn === runsFaults.recordCalls) throw new Error('disk full: run.json');
      actual.writeRunRecord(runDir, record);
    },
  };
});

/**
 * run.ts の結合テスト。偽の spawn / ShortRun だけを使い、本物の codex も、ネットワークも、
 * 別のプロバイダも呼ばない（fetch を差し替えて、呼ばれたら落ちるようにしてある）。
 * 原稿の中身は固定の文字列で、実データの人物・物語には依存しない。
 */

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'velum-authoring-')));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// ── ネットワークは呼ばれない ───────────────────────────────

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn((): never => {
    throw new Error('fetch は呼ばない（別のプロバイダへ行かない）');
  });
  vi.stubGlobal('fetch', fetchMock);
  secretLeaksInMock.mockReset();
  secretLeaksInMock.mockImplementation(() => []);
  runsFaults.ops = [];
  runsFaults.failFile = null;
  runsFaults.failRecordOn = null;
  runsFaults.recordCalls = 0;
});
afterEach(() => {
  const called = fetchMock.mock.calls.length;
  vi.unstubAllGlobals();
  expect(called, 'fetch が呼ばれた').toBe(0);
});

// ── 固定の入力 ─────────────────────────────────────────────

const INSTRUCTIONS = '最小の指示\n';
const BRIEF_NAME = 'velum_test_brief.md';
const BRIEF = '# 試作の設定資料\n\n主人公は港町に住む行商人で、朝市に立つ。\n';
const REQUEST = '設定資料「velum_test_brief.md」を使って、短編を一本書いてください。\n';
const FEEDBACK = '残したいところ：冒頭の市場の場面\n読めなかったところ：中盤の説明\n';
const BODY = 'あ'.repeat(1500);
const GOOD_OUTPUT = `# 試作の題\n\n${BODY}\n`;
const REVISED_BODY = 'い'.repeat(1500);
const REVISED_OUTPUT = `# 試作の題\n\n${REVISED_BODY}\n`;
const SECRET_OPENAI = 'sk-test-secret';
const SECRET_GEMINI = 'g-secret';
/** process.kill(pid, 0) が必ず ESRCH になる、存在しない pid */
const DEAD_PID = 2147483000;

const CONFIG: WriterConfig = {
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

const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const ok = (output: string): FakeBehavior => ({ events: okEvents(), output });
const RUNS_DIR = '.story-runs';

// ── 環境 ───────────────────────────────────────────────────

type FileSpec = string | Uint8Array | null;
type Script = FakeBehavior | FakeBehavior[] | ((call: SpawnCall) => FakeBehavior);

type EnvOptions = {
  /** 偽の codex のふるまい。配列なら spawn の順に使い、足りなければ最後のものを使う */
  script?: Script;
  short?: FakeShortOptions;
  /** null はファイルを作らない */
  instructions?: FileSpec;
  brief?: FileSpec;
  request?: FileSpec;
  abortSignal?: AbortSignal;
  timeoutMsOverride?: number;
  killGraceMs?: number;
  heartbeatMs?: number;
  pid?: number;
  secretLeaks?: (text: string) => Array<{ owner: string }>;
  makeWorkdir?: (ctx: { root: string; workRoot: string }) => string;
};

/** spawn の瞬間の run ディレクトリとロックの状態（実行前に何が置かれているかを見る） */
type AtSpawn = {
  runDir: string | null;
  files: string[];
  runJson: string | null;
  promptTxt: string | null;
  lock: string | null;
  cwdEntries: string[] | null;
};

function inspectAtSpawn(call: SpawnCall, runsRootDir: string): AtSpawn {
  const arg = call.args.find((a) => a.startsWith('model_instructions_file='));
  const instructionsFile = arg ? (JSON.parse(arg.slice('model_instructions_file='.length)) as string) : null;
  const runDir = instructionsFile ? dirname(instructionsFile) : null;
  const read = (name: string): string | null =>
    runDir && existsSync(join(runDir, name)) ? readFileSync(join(runDir, name), 'utf8') : null;
  const lockPath = join(runsRootDir, '.lock');
  return {
    runDir,
    files: runDir && existsSync(runDir) ? readdirSync(runDir).sort() : [],
    runJson: read('run.json'),
    promptTxt: read('prompt.txt'),
    lock: existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : null,
    cwdEntries: existsSync(call.options.cwd) ? readdirSync(call.options.cwd) : null,
  };
}

function makeEnv(options: EnvOptions = {}) {
  const base = mkdtempSync(join(tmp, 'env-'));
  const root = join(base, 'root');
  const workRoot = join(base, 'work');
  const runsRoot = join(root, RUNS_DIR);
  mkdirSync(join(root, 'authoring', 'prompts'), { recursive: true });
  mkdirSync(join(root, 'authoring', 'briefs'), { recursive: true });
  mkdirSync(join(root, 'characters', 'riko', 'stories', 's01'), { recursive: true });
  mkdirSync(workRoot, { recursive: true });

  const instructionsPath = join(root, 'authoring', 'prompts', 'instructions.txt');
  const briefPath = join(root, 'authoring', 'briefs', BRIEF_NAME);
  const requestPath = join(root, 'authoring', 'prompts', 'request.txt');
  const manifestPath = join(root, 'characters', 'riko', 'stories', 's01', 'manifest.yaml');
  const put = (path: string, spec: FileSpec | undefined, fallback: string): void => {
    const value = spec === undefined ? fallback : spec;
    if (value !== null) writeFileSync(path, value);
  };
  put(instructionsPath, options.instructions, INSTRUCTIONS);
  put(briefPath, options.brief, BRIEF);
  put(requestPath, options.request, REQUEST);
  writeFileSync(manifestPath, 'dummy: true\n');

  const script: Script = options.script ?? ok(GOOD_OUTPUT);
  const atSpawn: AtSpawn[] = [];
  let spawned = 0;
  const fake = fakeSpawn((call) => {
    atSpawn.push(inspectAtSpawn(call, runsRoot));
    const index = spawned;
    spawned += 1;
    if (typeof script === 'function') return script(call);
    if (Array.isArray(script)) return script[Math.min(index, script.length - 1)] ?? {};
    return script;
  });
  const short = fakeShortRun(options.short);

  const parentEnv: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    HOME: '/home/x',
    CODEX_HOME: '/home/x/.codex',
    OPENAI_API_KEY: SECRET_OPENAI,
    GEMINI_API_KEY: SECRET_GEMINI,
  };
  const envSnapshot: NodeJS.ProcessEnv = { ...parentEnv };

  const log: string[] = [];
  const created: string[] = [];
  let clock = Date.parse('2026-10-03T13:54:07.000Z');
  let counter = 0;

  const deps: AuthoringDeps = {
    root,
    runsRoot,
    config: CONFIG,
    env: parentEnv,
    shortRun: short.run,
    process: { spawn: fake.spawn, killGroup: fake.killGroup, now: () => Date.now() },
    now: () => {
      clock += 1000;
      return new Date(clock);
    },
    random: () => {
      counter += 1;
      return counter.toString(16).padStart(6, '0');
    },
    makeWorkdir: () => {
      const dir = options.makeWorkdir
        ? options.makeWorkdir({ root, workRoot })
        : mkdtempSync(join(workRoot, 'w-'));
      created.push(dir);
      return dir;
    },
    removeWorkdir: (dir) => rmSync(dir, { recursive: true, force: true }),
    log: (line) => {
      log.push(line);
    },
    pid: options.pid ?? process.pid,
    secretLeaks: options.secretLeaks ?? (() => []),
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    ...(options.timeoutMsOverride !== undefined ? { timeoutMsOverride: options.timeoutMsOverride } : {}),
    ...(options.killGraceMs !== undefined ? { killGraceMs: options.killGraceMs } : {}),
    ...(options.heartbeatMs !== undefined ? { heartbeatMs: options.heartbeatMs } : {}),
  };

  return {
    base,
    root,
    workRoot,
    runsRoot,
    instructionsPath,
    briefPath,
    requestPath,
    manifestPath,
    deps,
    fake,
    short,
    log,
    created,
    atSpawn,
    parentEnv,
    envSnapshot,
  };
}
type Env = ReturnType<typeof makeEnv>;

const draftOpts = (env: Env, over: Partial<DraftOptions> = {}): DraftOptions => ({
  characterId: 'riko',
  briefPath: env.briefPath,
  requestPath: env.requestPath,
  dryRun: false,
  printPrompt: false,
  ...over,
});

const reviseOpts = (
  runId: string,
  feedbackPath: string,
  over: Partial<ReviseOptions> = {},
): ReviseOptions => ({ runId, feedbackPath, dryRun: false, printPrompt: false, ...over });

function writeRepoFile(env: Env, rel: string, content: string): string {
  const path = join(env.root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

// ── 結果の取り出し ─────────────────────────────────────────

type Succeeded = Extract<RunOutcome, { status: 'succeeded' }>;
type Failed = Extract<RunOutcome, { status: 'failed' }>;
type DryRun = Extract<RunOutcome, { status: 'dry-run' }>;

function describeOutcome(outcome: RunOutcome): string {
  switch (outcome.status) {
    case 'dry-run':
      return 'dry-run';
    case 'blocked':
      return `blocked: ${outcome.problems.join(' / ')}`;
    case 'succeeded':
      return `succeeded: ${outcome.runId}`;
    case 'failed':
      return `failed: ${JSON.stringify(outcome.record.failure)}`;
  }
}

function succeeded(outcome: RunOutcome): Succeeded {
  if (outcome.status !== 'succeeded') throw new Error(`succeeded を期待したが ${describeOutcome(outcome)}`);
  return outcome;
}
function failed(outcome: RunOutcome): Failed {
  if (outcome.status !== 'failed') throw new Error(`failed を期待したが ${describeOutcome(outcome)}`);
  return outcome;
}
function dryRunOf(outcome: RunOutcome): DryRun['summary'] {
  if (outcome.status !== 'dry-run') throw new Error(`dry-run を期待したが ${describeOutcome(outcome)}`);
  return outcome.summary;
}
function blockedOf(outcome: RunOutcome): string[] {
  if (outcome.status !== 'blocked') throw new Error(`blocked を期待したが ${describeOutcome(outcome)}`);
  return outcome.problems;
}

/** 投げられた Error を受け取る。スタブの「not implemented」を「投げた」と数えない */
async function rejected(fn: () => Promise<unknown>): Promise<Error> {
  let caught: unknown;
  let didThrow = false;
  try {
    await fn();
  } catch (e) {
    didThrow = true;
    caught = e;
  }
  expect(didThrow, '投げられるはずだった').toBe(true);
  expect(caught).toBeInstanceOf(Error);
  const err = caught as Error;
  expect(err.message).not.toMatch(/not implemented/);
  return err;
}

// ── ファイルの読み取り ─────────────────────────────────────

const readText = (dir: string, name: string): string => readFileSync(join(dir, name), 'utf8');
const listDir = (dir: string): string[] => readdirSync(dir).sort();
const readRecord = (runDir: string): RunRecord =>
  RunRecordSchema.parse(JSON.parse(readText(runDir, 'run.json')));

const byRole = (inputs: readonly RunInput[], role: RunInput['role']): RunInput => {
  const found = inputs.find((input) => input.role === role);
  if (!found) throw new Error(`入力 ${role} が無い: ${inputs.map((i) => i.role).join(',')}`);
  return found;
};

/** 中身の hash を、ディレクトリも含めて取る（変わっていないことの確認） */
function treeSnapshot(dir: string, skip: (rel: string) => boolean = () => false): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const rel = relative(dir, path);
      if (skip(rel)) continue;
      if (entry.isDirectory()) {
        out[`${rel}/`] = 'dir';
        walk(path);
      } else {
        out[rel] = sha256(readFileSync(path));
      }
    }
  };
  walk(dir);
  return out;
}
const skipRuns = (rel: string): boolean => rel === RUNS_DIR || rel.startsWith(`${RUNS_DIR}${sep}`);

/** .story-runs の下の run のディレクトリ（ロックを除く） */
const runDirNames = (env: Env): string[] =>
  existsSync(env.runsRoot) ? readdirSync(env.runsRoot).filter((name) => name !== '.lock') : [];
const lockPathOf = (env: Env): string => join(env.runsRoot, '.lock');

function writeLock(env: Env, pid: number): string {
  mkdirSync(env.runsRoot, { recursive: true });
  const path = lockPathOf(env);
  writeFileSync(
    path,
    `${JSON.stringify({ pid, command: 'story:draft', acquired_at: '2026-10-03T00:00:00.000Z' })}\n`,
  );
  return path;
}

async function waitFor(condition: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error('待ち時間切れ');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 失敗・成功のあとに必ず守られる後始末（ロック・作業ディレクトリ） */
function expectCleanedUp(env: Env): void {
  expect(existsSync(lockPathOf(env)), 'ロックが残っている').toBe(false);
  for (const dir of env.created) expect(existsSync(dir), `作業ディレクトリが残っている: ${dir}`).toBe(false);
}

/** outcome の record と、ディスクの run.json が同じであること */
function expectRecordPersisted(outcome: Succeeded | Failed): void {
  expect(readRecord(outcome.runDir)).toEqual(outcome.record);
}

const RUN_ID_DRAFT = /^20261003T1354\d\dZ-riko-draft-[0-9a-f]{6}$/;

// ── draft: dry-run ─────────────────────────────────────────

describe('draftStory: dry-run', () => {
  it('codex も preflight も起こさず、何も書かずに、これから起こす run の要約を返す', async () => {
    const env = makeEnv();
    const before = treeSnapshot(env.base);

    const summary = dryRunOf(await draftStory(draftOpts(env, { dryRun: true }), env.deps));

    expect(env.fake.calls).toHaveLength(0);
    expect(env.short.calls).toHaveLength(0);
    expect(existsSync(env.runsRoot)).toBe(false);
    expect(readdirSync(env.workRoot)).toEqual([]);
    expect(treeSnapshot(env.base)).toEqual(before);

    expect(summary).toMatchObject({
      purpose: 'draft',
      model: 'gpt-6-astra',
      effort: 'high',
      verbosity: null,
      authentication: 'chatgpt',
      credentialsStore: 'keyring',
      fallback: 'none',
      retries: 0,
      calls: 1,
      timeoutMs: 30 * 60 * 1000,
    });
  });

  it('入力の hash・名前・出どころは、実際のファイルから取る', async () => {
    const env = makeEnv();
    const summary = dryRunOf(await draftStory(draftOpts(env, { dryRun: true }), env.deps));

    expect(summary.inputs).toHaveLength(3);
    const instructions = byRole(summary.inputs, 'instructions');
    expect(instructions).toMatchObject({
      source: 'authoring/prompts/instructions.txt',
      name: null,
      file: '',
      sha256: sha256(INSTRUCTIONS),
      bytes: Buffer.byteLength(INSTRUCTIONS),
      chars: [...INSTRUCTIONS].length,
    });
    const brief = byRole(summary.inputs, 'brief');
    expect(brief).toMatchObject({
      source: `authoring/briefs/${BRIEF_NAME}`,
      name: 'velum_test_brief.md',
      file: '',
      sha256: sha256(BRIEF),
      bytes: Buffer.byteLength(BRIEF),
      chars: [...BRIEF].length,
    });
    const request = byRole(summary.inputs, 'request');
    expect(request).toMatchObject({
      source: 'authoring/prompts/request.txt',
      file: '',
      sha256: sha256(REQUEST),
      bytes: Buffer.byteLength(REQUEST),
      chars: [...REQUEST].length,
    });
  });

  it('リポジトリの外の brief は external:<ファイル名> で記録し、添付の名前は元のファイル名', async () => {
    const env = makeEnv();
    const outside = join(env.base, 'outside_brief.md');
    writeFileSync(outside, '外にある設定資料\n');

    const summary = dryRunOf(
      await draftStory(draftOpts(env, { dryRun: true, briefPath: outside }), env.deps),
    );

    expect(byRole(summary.inputs, 'brief')).toMatchObject({
      source: 'external:outside_brief.md',
      name: 'outside_brief.md',
      sha256: sha256('外にある設定資料\n'),
    });
  });

  it('依頼文は draftPrompt の結果で、hash と大きさがその全文と一致する', async () => {
    const env = makeEnv();
    const summary = dryRunOf(await draftStory(draftOpts(env, { dryRun: true }), env.deps));

    const prompt = draftPrompt({ briefName: BRIEF_NAME, brief: BRIEF, request: REQUEST });
    expect(summary.prompt).toEqual({
      framing: DRAFT_FRAMING,
      sha256: sha256(prompt),
      bytes: Buffer.byteLength(prompt),
      chars: [...prompt].length,
    });
  });

  it('codex の引数は <RUN_DIR> / <WORKDIR> に置き換わり、実際の絶対パスを含まない', async () => {
    const env = makeEnv();
    const summary = dryRunOf(await draftStory(draftOpts(env, { dryRun: true }), env.deps));

    const joined = summary.codexArgs.join('\n');
    expect(joined).toContain('<RUN_DIR>');
    expect(joined).toContain('<WORKDIR>');
    expect(argAfter(summary.codexArgs, '--cd')).toBe('<WORKDIR>');
    expect(argAfter(summary.codexArgs, '--output-last-message')).toBe(
      '<RUN_DIR>/manuscript.raw.md.partial',
    );
    expect(summary.codexArgs.some((a) => a.includes('<RUN_DIR>/instructions.txt'))).toBe(true);
    for (const forbidden of new Set([tmp, tmpdir(), env.base, env.root, env.workRoot])) {
      expect(joined, `絶対パス ${forbidden} が残っている`).not.toContain(forbidden);
    }
  });

  it('子の環境から外す変数の名前を示す（値は出さず、CODEX_HOME は外さない）', async () => {
    const env = makeEnv();
    const summary = dryRunOf(await draftStory(draftOpts(env, { dryRun: true }), env.deps));

    expect(summary.envRemoved).toContain('OPENAI_API_KEY');
    expect(summary.envRemoved).toContain('GEMINI_API_KEY');
    expect(summary.envRemoved).not.toContain('CODEX_HOME');
    expect(JSON.stringify(summary)).not.toContain(SECRET_OPENAI);
    expect(JSON.stringify(summary)).not.toContain(SECRET_GEMINI);
  });

  it('promptText は printPrompt のときだけ。そのときは組み立てた全文', async () => {
    const env = makeEnv();
    const quiet = dryRunOf(await draftStory(draftOpts(env, { dryRun: true }), env.deps));
    expect(quiet.promptText).toBeNull();

    const loud = dryRunOf(
      await draftStory(draftOpts(env, { dryRun: true, printPrompt: true }), env.deps),
    );
    expect(loud.promptText).toBe(draftPrompt({ briefName: BRIEF_NAME, brief: BRIEF, request: REQUEST }));
    expect(existsSync(env.runsRoot)).toBe(false);
  });

  it('effort / verbosity / timeout の指定は要約と引数に反映され、writer.yaml の値より優先する', async () => {
    const env = makeEnv();
    const summary = dryRunOf(
      await draftStory(
        draftOpts(env, { dryRun: true, effort: 'xhigh', verbosity: 'low', timeoutMinutes: 5 }),
        env.deps,
      ),
    );

    expect(summary).toMatchObject({ effort: 'xhigh', verbosity: 'low', timeoutMs: 5 * 60 * 1000 });
    expect(summary.codexArgs).toContain('model_reasoning_effort="xhigh"');
    expect(summary.codexArgs).toContain('model_verbosity="low"');
  });

  it('verbosity は未指定なら writer.yaml の値、null なら渡さない', async () => {
    const env = makeEnv();
    env.deps.config = { ...CONFIG, verbosity: 'medium' };

    const inherited = dryRunOf(await draftStory(draftOpts(env, { dryRun: true }), env.deps));
    expect(inherited.verbosity).toBe('medium');
    expect(inherited.codexArgs).toContain('model_verbosity="medium"');

    const none = dryRunOf(
      await draftStory(draftOpts(env, { dryRun: true, verbosity: null }), env.deps),
    );
    expect(none.verbosity).toBeNull();
    expect(none.codexArgs.some((a) => a.startsWith('model_verbosity'))).toBe(false);
  });

  it('instructionsPath の指定は writer.yaml の instructions より優先する', async () => {
    const env = makeEnv();
    const alt = writeRepoFile(env, 'authoring/prompts/alt.txt', '別の指示\n');

    const summary = dryRunOf(
      await draftStory(draftOpts(env, { dryRun: true, instructionsPath: alt }), env.deps),
    );

    expect(byRole(summary.inputs, 'instructions')).toMatchObject({
      source: 'authoring/prompts/alt.txt',
      sha256: sha256('別の指示\n'),
    });
  });

  it('入力の誤りは dry-run でも投げる（brief が無い）', async () => {
    const env = makeEnv({ brief: null });
    const err = await rejected(() => draftStory(draftOpts(env, { dryRun: true }), env.deps));
    expect(err.message).toContain(BRIEF_NAME);
    expect(env.fake.calls).toHaveLength(0);
  });
});

// ── draft: 入力の誤り ──────────────────────────────────────

describe('draftStory: 入力の誤りは、何も作る前に投げる', () => {
  const cases: Array<{ name: string; options: EnvOptions; mention: string | RegExp }> = [
    { name: 'brief のファイルが無い', options: { brief: null }, mention: BRIEF_NAME },
    { name: 'brief が空', options: { brief: '' }, mention: BRIEF_NAME },
    { name: 'brief が UTF-8 でない', options: { brief: Buffer.from([0xff, 0xfe]) }, mention: BRIEF_NAME },
    { name: 'brief に NUL がある', options: { brief: 'あ\0い' }, mention: BRIEF_NAME },
    {
      name: 'brief に </attachment> がある（添付の枠と衝突する）',
      options: { brief: '前\n</attachment>\n後\n' },
      mention: /attachment/,
    },
    { name: '依頼文のファイルが無い', options: { request: null }, mention: 'request.txt' },
    { name: '依頼文が空', options: { request: '' }, mention: 'request.txt' },
    { name: '依頼文が UTF-8 でない', options: { request: Buffer.from([0xff, 0xfe]) }, mention: 'request.txt' },
    { name: '依頼文に NUL がある', options: { request: 'あ\0い' }, mention: 'request.txt' },
    { name: '執筆用指示のファイルが無い', options: { instructions: null }, mention: 'instructions.txt' },
    { name: '執筆用指示が空', options: { instructions: '' }, mention: 'instructions.txt' },
    {
      name: '執筆用指示が UTF-8 でない',
      options: { instructions: Buffer.from([0xff, 0xfe]) },
      mention: 'instructions.txt',
    },
  ];

  it.each(cases)('$name', async ({ options, mention }) => {
    const env = makeEnv(options);
    const err = await rejected(() => draftStory(draftOpts(env), env.deps));

    if (typeof mention === 'string') expect(err.message).toContain(mention);
    else expect(err.message).toMatch(mention);
    expect(env.fake.calls, 'spawn された').toHaveLength(0);
    expect(env.short.calls, 'preflight が走った').toHaveLength(0);
    expect(existsSync(env.runsRoot), '.story-runs が作られた').toBe(false);
    expect(env.created, '作業ディレクトリが作られた').toEqual([]);
  });

  it('作業ディレクトリが root の中にあれば、spawn せずに投げる', async () => {
    const env = makeEnv({
      makeWorkdir: ({ root }) => {
        const dir = join(root, 'inside-work');
        mkdirSync(dir);
        return dir;
      },
    });

    await rejected(() => draftStory(draftOpts(env), env.deps));

    expect(env.fake.calls).toHaveLength(0);
    expect(existsSync(lockPathOf(env)), 'ロックが残っている').toBe(false);
  });
});

// ── draft: preflight とロックで止まる ──────────────────────

describe('draftStory: 実行前の確認で止まる（投げずに blocked を返す）', () => {
  const blockedCases: Array<{ name: string; short: FakeShortOptions; effort?: string; problem?: RegExp }> = [
    { name: 'API キーでのログイン', short: { login: REAL.loginApiKey } },
    { name: '未ログイン（codex login を案内する）', short: { login: REAL.notLoggedIn }, problem: /codex login/ },
    { name: 'CLI が最小の版より古い', short: { version: 'codex-cli 0.152.9' } },
    { name: 'codex が PATH に無い', short: { missingCli: true } },
    { name: 'カタログにモデルが無い', short: { catalog: JSON.stringify({ models: [] }) } },
    {
      name: 'カタログに無い effort（別の値に直さない）',
      short: {},
      effort: 'superhigh',
      problem: /superhigh/,
    },
  ];

  it.each(blockedCases)('$name', async ({ short, effort, problem }) => {
    const env = makeEnv({ short });
    const outcome = await draftStory(draftOpts(env, effort ? { effort } : {}), env.deps);

    const problems = blockedOf(outcome);
    expect(problems.length).toBeGreaterThan(0);
    if (problem) expect(problems.join('\n')).toMatch(problem);
    expect(env.fake.calls, 'spawn された').toHaveLength(0);
    expect(runDirNames(env), 'run のディレクトリが作られた').toEqual([]);
    expect(existsSync(lockPathOf(env)), 'ロックが残っている').toBe(false);
    expect(env.created).toEqual([]);
  });

  it('API キーのログインでは、ログアウトを起こしかねない exec を一度も起こさない', async () => {
    const env = makeEnv({ short: { login: REAL.loginApiKey } });
    blockedOf(await draftStory(draftOpts(env), env.deps));

    expect(env.short.calls.some((c) => c.args[0] === 'login' && c.args[1] === 'status')).toBe(true);
    expect(env.short.calls.some((c) => c.args[0] === 'exec')).toBe(false);
  });

  it('別の制作コマンドがロックを持っていれば（pid が生きている）blocked。ロックには触れない', async () => {
    const env = makeEnv({ pid: process.pid + 1 });
    const lockPath = writeLock(env, process.pid);
    const before = readFileSync(lockPath, 'utf8');

    const outcome = await draftStory(draftOpts(env), env.deps);

    expect(blockedOf(outcome).length).toBeGreaterThan(0);
    expect(env.fake.calls).toHaveLength(0);
    expect(runDirNames(env)).toEqual([]);
    expect(readFileSync(lockPath, 'utf8')).toBe(before);
  });

  it('持ち主のいない古いロックは自動で消さず、パスを示して blocked', async () => {
    const env = makeEnv();
    const lockPath = writeLock(env, DEAD_PID);
    const before = readFileSync(lockPath, 'utf8');

    const outcome = await draftStory(draftOpts(env), env.deps);

    expect(blockedOf(outcome).join('\n')).toContain('.lock');
    expect(env.fake.calls).toHaveLength(0);
    expect(runDirNames(env)).toEqual([]);
    expect(readFileSync(lockPath, 'utf8'), '古いロックが書き換わった').toBe(before);
  });
});

// ── draft: 成功 ────────────────────────────────────────────

async function successfulDraft(options: EnvOptions = {}) {
  const env = makeEnv(options);
  const outcome = succeeded(await draftStory(draftOpts(env), env.deps));
  const call = env.fake.calls[0];
  if (!call) throw new Error('spawn されていない');
  return { env, outcome, call, runDir: outcome.runDir, record: outcome.record };
}

describe('draftStory: 成功', () => {
  it('draft として保存され、公開に必要なファイルは作らない', async () => {
    const { env, outcome, runDir } = await successfulDraft();

    expect(outcome.status).toBe('succeeded');
    expect(outcome.runId).toMatch(RUN_ID_DRAFT);
    expect(runDir).toBe(join(env.runsRoot, outcome.runId));
    expect(listDir(runDir)).toEqual(
      [
        'brief.md',
        'events.jsonl',
        'instructions.txt',
        'manuscript.body.txt',
        'manuscript.raw.md',
        'prompt.txt',
        'request.txt',
        'run.json',
        'stderr.log',
      ].sort(),
    );
    expect(existsSync(join(runDir, 'manuscript.raw.md.partial'))).toBe(false);
  });

  it('manuscript.raw.md は Codex の最終応答そのもの（バイトが一致する）', async () => {
    const { runDir } = await successfulDraft();

    expect(readFileSync(join(runDir, 'manuscript.raw.md')).equals(Buffer.from(GOOD_OUTPUT))).toBe(true);
  });

  it('manuscript.body.txt は題の行を除いた本文で、題や元の語句を失わない', async () => {
    const { runDir, record } = await successfulDraft();

    const body = readText(runDir, 'manuscript.body.txt');
    expect(body.startsWith(BODY)).toBe(true);
    expect(body.slice(BODY.length)).toMatch(/^\n?$/);
    expect(body).not.toContain('試作の題');
    expect(record.output).toMatchObject({
      body_file: 'manuscript.body.txt',
      body_sha256: sha256(readFileSync(join(runDir, 'manuscript.body.txt'))),
      body_chars: 1500,
      title: '試作の題',
      title_rule: 'markdown_heading',
    });
  });

  it('events.jsonl と stderr.log は、Codex の出力をそのまま保存する', async () => {
    const stderr = 'ログの雑音\n';
    const { runDir, record } = await successfulDraft({
      script: { events: okEvents(), output: GOOD_OUTPUT, stderr },
    });

    expect(readText(runDir, 'events.jsonl')).toBe(
      `${okEvents()
        .map((event) => JSON.stringify(event))
        .join('\n')}\n`,
    );
    expect(readText(runDir, 'stderr.log')).toBe(stderr);
    // 成功した実行の stderr の雑音は、失敗にも警告にもしない
    expect(record.status).toBe('succeeded');
    expect(record.warnings).toEqual([]);
  });

  it('run.json は記録の schema に合い、来歴が揃っている', async () => {
    const { env, outcome, runDir, record, call } = await successfulDraft();

    const parsed = RunRecordSchema.parse(JSON.parse(readText(runDir, 'run.json')));
    expect(parsed).toEqual(record);
    expectRecordPersisted(outcome);

    expect(record).toMatchObject({
      run_id: outcome.runId,
      purpose: 'draft',
      stage: 'generated',
      parent_run_id: null,
      character_id: 'riko',
      status: 'succeeded',
      failure: null,
    });
    expect(record.cli).toEqual({ command: 'codex', version: '0.153.4', min_version: '0.153.0' });
    expect(record.requested).toEqual({
      provider: 'codex-cli',
      model: 'gpt-6-astra',
      reasoning_effort: 'high',
      verbosity: null,
      authentication: 'chatgpt',
      credentials_store: 'keyring',
      fallback: 'none',
      retries: 0,
      timeout_ms: 30 * 60 * 1000,
    });
    expect(record.auth_check).toEqual({ method: 'chatgpt', checked_with: 'codex login status' });
    expect(record.warnings).toEqual([]);

    // 入力の写しと hash
    expect(record.inputs).toHaveLength(3);
    expect(byRole(record.inputs, 'instructions')).toMatchObject({
      source: 'authoring/prompts/instructions.txt',
      name: null,
      file: 'instructions.txt',
      sha256: sha256(INSTRUCTIONS),
    });
    expect(byRole(record.inputs, 'brief')).toMatchObject({
      source: `authoring/briefs/${BRIEF_NAME}`,
      name: 'velum_test_brief.md',
      file: 'brief.md',
      sha256: sha256(BRIEF),
    });
    expect(byRole(record.inputs, 'request')).toMatchObject({
      source: 'authoring/prompts/request.txt',
      file: 'request.txt',
      sha256: sha256(REQUEST),
    });
    expect(readText(runDir, 'instructions.txt')).toBe(INSTRUCTIONS);
    expect(readText(runDir, 'brief.md')).toBe(BRIEF);
    expect(readText(runDir, 'request.txt')).toBe(REQUEST);

    // 依頼文: prompt.txt = stdin = 記録の hash
    expect(record.prompt.file).toBe('prompt.txt');
    expect(record.prompt.framing).toBe(DRAFT_FRAMING);
    expect(record.prompt.sha256).toBe(sha256(readFileSync(join(runDir, 'prompt.txt'))));
    expect(record.prompt.sha256).toBe(sha256(call.stdin()));

    // 出力
    expect(record.output).toMatchObject({
      raw_file: 'manuscript.raw.md',
      raw_sha256: sha256(GOOD_OUTPUT),
      raw_bytes: Buffer.byteLength(GOOD_OUTPUT),
    });

    // イベントと終了
    expect(record.events).toMatchObject({
      file: 'events.jsonl',
      lines: okEvents().length,
      parse_errors: 0,
      thread_id: 'thread-test-1',
      turn_completed: true,
      item_types: { reasoning: 1, agent_message: 1 },
      unexpected_items: [],
      agent_messages: 1,
      usage: { input_tokens: 4100, output_tokens: 6200 },
    });
    expect(record.process).toEqual({
      exit_code: 0,
      signal: null,
      timed_out: false,
      interrupted: false,
      spawn_error: null,
    });
    expect(Number.isNaN(Date.parse(record.started_at))).toBe(false);
    expect(Number.isNaN(Date.parse(record.finished_at ?? ''))).toBe(false);
    expect(record.duration_ms).toBeGreaterThanOrEqual(0);

    // 引数の記録: 絶対パスは置き換わり、実際の引数と対応する
    const replaced = call.args.map((arg) =>
      arg.split(runDir).join('<RUN_DIR>').split(call.options.cwd).join('<WORKDIR>'),
    );
    expect(record.codex_args).toEqual(replaced);
    expect(record.codex_args.some((a) => a.includes('<RUN_DIR>'))).toBe(true);
    expect(record.codex_args.some((a) => a.includes('<WORKDIR>'))).toBe(true);
    const joined = record.codex_args.join('\n');
    for (const forbidden of new Set([tmp, tmpdir(), env.base, env.root, env.workRoot])) {
      expect(joined).not.toContain(forbidden);
    }
    expect(record.env_removed).toEqual(['GEMINI_API_KEY', 'OPENAI_API_KEY']);
  });

  it('実効モデルは、CLI が報告しなければ null（要求したモデルを写して確認済みにしない）', async () => {
    const { record } = await successfulDraft();

    expect(record.effective).toEqual({ model: null, model_source: 'not_reported' });
  });

  it('CLI がモデル名をイベントで報告したときは、その値と出どころを記録する', async () => {
    const { record } = await successfulDraft({
      script: { events: okEvents({ model: 'gpt-6-astra-2026-09' }), output: GOOD_OUTPUT },
    });

    expect(record.effective.model).toBe('gpt-6-astra-2026-09');
    expect(record.effective.model_source).not.toBe('not_reported');
    expect(record.effective.model_source.length).toBeGreaterThan(0);
  });

  it('codex は 1 回だけ起こす。引数は writer.yaml に従い、危険なフラグを含まない', async () => {
    const { env, call, runDir } = await successfulDraft();

    expect(env.fake.calls).toHaveLength(1);
    expect(call.command).toBe('codex');
    const args = call.args;
    expect(args[0]).toBe('exec');
    expect(args[args.length - 1]).toBe('-');
    expect(argAfter(args, '--model')).toBe('gpt-6-astra');
    expect(argAfter(args, '--sandbox')).toBe('read-only');
    expect(args).toContain('--ignore-user-config');
    expect(args).toContain('--strict-config');
    expect(args).toContain('--ephemeral');
    expect(args).toContain('forced_login_method="chatgpt"');
    expect(args).toContain('cli_auth_credentials_store="keyring"');
    expect(args).toContain('model_reasoning_effort="high"');
    expect(args.some((a) => a.startsWith('model_verbosity'))).toBe(false);
    expect(args).toContain(`model_instructions_file=${JSON.stringify(join(runDir, 'instructions.txt'))}`);
    expect(argAfter(args, '--cd')).toBe(call.options.cwd);
    expect(argAfter(args, '--output-last-message')).toBe(join(runDir, 'manuscript.raw.md.partial'));
    for (const forbidden of ['resume', 'fork', '--last', '--yolo', '--ignore-rules']) {
      expect(args, forbidden).not.toContain(forbidden);
    }
    expect(args.some((a) => a.startsWith('--dangerously'))).toBe(false);
  });

  it('stdin に渡すのは prompt.ts が組んだ依頼文（brief と依頼文は一字も変えない）', async () => {
    const { call, runDir } = await successfulDraft();

    const prompt = draftPrompt({ briefName: BRIEF_NAME, brief: BRIEF, request: REQUEST });
    expect(call.stdin()).toBe(prompt);
    expect(readText(runDir, 'prompt.txt')).toBe(prompt);
    expect(call.stdin()).toContain(BRIEF);
    expect(call.stdin()).toContain(REQUEST);
  });

  it('子の環境から API キーを外し、CODEX_HOME は残す。親の環境は変えない', async () => {
    const { env, call } = await successfulDraft();

    const childEnv = call.options.env;
    expect(childEnv).not.toHaveProperty('OPENAI_API_KEY');
    expect(childEnv).not.toHaveProperty('GEMINI_API_KEY');
    expect(childEnv.CODEX_HOME).toBe('/home/x/.codex');
    expect(childEnv.PATH).toBe('/usr/bin');
    expect(childEnv).not.toBe(env.deps.env);
    expect(env.deps.env).toEqual(env.envSnapshot);

    // 認証の確認（短いコマンド）も、同じ環境で行う
    expect(env.short.calls.length).toBeGreaterThan(0);
    for (const shortCall of env.short.calls) {
      expect(shortCall.options.env).not.toHaveProperty('OPENAI_API_KEY');
      expect(shortCall.options.env).not.toHaveProperty('GEMINI_API_KEY');
      expect(shortCall.options.env.CODEX_HOME).toBe('/home/x/.codex');
    }
  });

  it('作業ディレクトリは root の外の空のディレクトリで、終わったら消える', async () => {
    const { env, call } = await successfulDraft();

    const workdir = call.options.cwd;
    expect(env.created).toEqual([workdir]);
    expect(isAbsolute(workdir)).toBe(true);
    expect(relative(env.root, workdir).startsWith('..')).toBe(true);
    expect(call.options.detached).toBe(true);
    expect(call.options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(env.atSpawn[0]?.cwdEntries).toEqual([]);
    expectCleanedUp(env);
  });

  it('spawn の時点で、入力の写し・prompt.txt・running の run.json・ロックが揃っている', async () => {
    const { env, call, runDir } = await successfulDraft();

    const at = env.atSpawn[0];
    expect(at?.runDir).toBe(runDir);
    expect(at?.files).toEqual(
      expect.arrayContaining(['instructions.txt', 'brief.md', 'request.txt', 'prompt.txt', 'run.json']),
    );
    expect(at?.promptTxt).toBe(call.stdin());

    const running = RunRecordSchema.parse(JSON.parse(at?.runJson ?? 'null'));
    expect(running).toMatchObject({
      status: 'running',
      purpose: 'draft',
      character_id: 'riko',
      finished_at: null,
      duration_ms: null,
      process: null,
      events: null,
      output: null,
      failure: null,
    });
    expect(running.inputs).toHaveLength(3);

    const lock = JSON.parse(at?.lock ?? 'null') as { pid: number; command: string };
    expect(lock.pid).toBe(env.deps.pid);
    expect(typeof lock.command).toBe('string');
    expect(existsSync(lockPathOf(env))).toBe(false);
  });

  it('manifest・characters/・materials に触れない', async () => {
    const env = makeEnv();
    const before = treeSnapshot(env.root, skipRuns);

    succeeded(await draftStory(draftOpts(env), env.deps));

    expect(treeSnapshot(env.root, skipRuns)).toEqual(before);
    expect(readFileSync(env.manifestPath, 'utf8')).toBe('dummy: true\n');
    expect(runDirNames(env)).toHaveLength(1);
  });

  it('API キーの値は、run の記録にも log にも残らない', async () => {
    const { env, runDir } = await successfulDraft();

    for (const name of listDir(runDir)) {
      const text = readFileSync(join(runDir, name), 'utf8');
      expect(text, name).not.toContain(SECRET_OPENAI);
      expect(text, name).not.toContain(SECRET_GEMINI);
    }
    const logged = env.log.join('\n');
    expect(logged).not.toContain(SECRET_OPENAI);
    expect(logged).not.toContain(SECRET_GEMINI);
  });

  it('dry-run の要約は、実際の run の記録と同じ内容から組み立てられている', async () => {
    const env = makeEnv();
    const summary = dryRunOf(await draftStory(draftOpts(env, { dryRun: true }), env.deps));
    const { record } = succeeded(await draftStory(draftOpts(env), env.deps));

    expect(summary.codexArgs).toEqual(record.codex_args);
    expect(summary.envRemoved).toEqual(record.env_removed);
    expect(summary.inputs).toEqual(record.inputs.map((input) => ({ ...input, file: '' })));
    expect(summary.prompt).toEqual({
      framing: record.prompt.framing,
      sha256: record.prompt.sha256,
      bytes: record.prompt.bytes,
      chars: record.prompt.chars,
    });
    expect(summary.timeoutMs).toBe(record.requested.timeout_ms);
  });

  it('ロックは実行中だけ。run が終わったら外れ、次の run を起こせる', async () => {
    const env = makeEnv({ script: [ok(GOOD_OUTPUT), ok(REVISED_OUTPUT)] });

    const first = succeeded(await draftStory(draftOpts(env), env.deps));
    const second = succeeded(await draftStory(draftOpts(env), env.deps));

    expect(first.runId).not.toBe(second.runId);
    expect(runDirNames(env).sort()).toEqual([first.runId, second.runId].sort());
    expect(existsSync(lockPathOf(env))).toBe(false);
    // 最初の run のファイルは、2 回目で触られない
    expect(readText(first.runDir, 'manuscript.raw.md')).toBe(GOOD_OUTPUT);
    expect(readText(second.runDir, 'manuscript.raw.md')).toBe(REVISED_OUTPUT);
  });

  it('作業ディレクトリに Codex が残したファイルがあれば、警告に出す（成功は取り消さない）', async () => {
    const { record, runDir } = await successfulDraft({
      script: { events: okEvents(), output: GOOD_OUTPUT, workdirFiles: { 'notes.txt': '勝手なメモ' } },
    });

    expect(record.status).toBe('succeeded');
    expect(record.warnings.join('\n')).toMatch(/作業ディレクトリ|workdir|work directory/i);
    expect(existsSync(join(runDir, 'notes.txt'))).toBe(false);
    expect(listDir(runDir)).not.toContain('notes.txt');
  });

  it('回復した error イベント（turn は完了）があっても成功にし、その文面を警告に残す', async () => {
    const events = okEvents();
    // turn.started の直後に、再接続の通知を差し込む
    events.splice(2, 0, { type: 'error', message: 'stream disconnected - retrying sampling request (1/5)' });
    const { record, runDir } = await successfulDraft({ script: { events, output: GOOD_OUTPUT } });

    expect(record.status).toBe('succeeded');
    expect(record.failure).toBeNull();
    expect(existsSync(join(runDir, 'manuscript.raw.md'))).toBe(true);
    expect(record.warnings.join('\n')).toContain('stream disconnected - retrying sampling request (1/5)');
  });
});

// ── draft: 原稿は書き換えず、異常は警告に出すだけ ──────────

describe('draftStory: 原稿は書き換えない', () => {
  it('CRLF の原稿でも raw はそのまま残り、body は LF になる', async () => {
    const crlf = `# 試作の題\r\n\r\n${BODY}\r\n`;
    const { runDir, record } = await successfulDraft({ script: ok(crlf) });

    expect(readFileSync(join(runDir, 'manuscript.raw.md')).equals(Buffer.from(crlf))).toBe(true);
    expect(record.output?.raw_sha256).toBe(sha256(crlf));
    const body = readText(runDir, 'manuscript.body.txt');
    expect(body).not.toContain('\r');
    expect(body.startsWith(BODY)).toBe(true);
  });

  it('短すぎる原稿も失敗にせず、そのまま保存して警告に出す', async () => {
    const short = `# 短い題\n\n${'い'.repeat(20)}\n`;
    const { runDir, record } = await successfulDraft({ script: ok(short) });

    expect(record.status).toBe('succeeded');
    expect(record.warnings.length).toBeGreaterThan(0);
    expect(readText(runDir, 'manuscript.raw.md')).toBe(short);
    expect(existsSync(join(runDir, 'manuscript.raw.md.partial'))).toBe(false);
  });

  it('題を判定できない原稿は、1行目を落とさず、題を null にして警告に出す', async () => {
    const untitled = `${'う'.repeat(1500)}\n`;
    const { runDir, record } = await successfulDraft({ script: ok(untitled) });

    expect(record.status).toBe('succeeded');
    expect(record.output?.title).toBeNull();
    expect(record.output?.title_rule).toBeNull();
    expect(record.warnings.length).toBeGreaterThan(0);
    expect(readText(runDir, 'manuscript.body.txt')).toContain('う'.repeat(1500));
  });

  it('秘密の断片が本文に出ていれば警告にする。成功は取り消さず、断片そのものは書かない', async () => {
    const leaks = vi.fn((text: string) => (text.includes('い') ? [{ owner: 'riko' }] : []));
    const leaky = `# 試作の題\n\n${'い'.repeat(1500)}\n`;
    const { record, runDir } = await successfulDraft({ script: ok(leaky), secretLeaks: leaks });

    expect(leaks).toHaveBeenCalled();
    expect(record.status).toBe('succeeded');
    expect(record.warnings.length).toBeGreaterThan(0);
    expect(record.warnings.join('\n')).not.toContain('い'.repeat(20));
    expect(readText(runDir, 'manuscript.raw.md')).toBe(leaky);
  });
});

// ── draft: 失敗 ────────────────────────────────────────────

describe('draftStory: 失敗した run の出力は完成稿にしない', () => {
  it('利用枠の上限: usage_limit。.partial のまま残し、再試行しない', async () => {
    const env = makeEnv({
      script: {
        events: failedTurnEvents("You've hit your usage limit. Try again later."),
        exitCode: 1,
        output: 'partial text',
      },
    });

    const outcome = failed(await draftStory(draftOpts(env), env.deps));

    expect(outcome.record.status).toBe('failed');
    expect(outcome.record.failure?.kind).toBe('usage_limit');
    expect(outcome.record.failure?.message.length).toBeGreaterThan(0);
    expect(existsSync(join(outcome.runDir, 'manuscript.raw.md'))).toBe(false);
    expect(readText(outcome.runDir, 'manuscript.raw.md.partial')).toBe('partial text');
    expect(existsSync(join(outcome.runDir, 'manuscript.body.txt'))).toBe(false);
    expect(outcome.record.output?.body_file ?? null).toBeNull();
    expect(outcome.record.process).toMatchObject({ exit_code: 1, timed_out: false, interrupted: false });
    expect(outcome.record.events?.turn_completed).toBe(false);
    expect(outcome.record.finished_at).not.toBeNull();
    expect(outcome.record.duration_ms).not.toBeNull();
    expect(env.fake.calls, '再試行された').toHaveLength(1);
    expectRecordPersisted(outcome);
    expectCleanedUp(env);
  });

  it('出力が無い: empty_output', async () => {
    const env = makeEnv({ script: { events: okEvents(), output: null } });

    const outcome = failed(await draftStory(draftOpts(env), env.deps));

    expect(outcome.record.failure?.kind).toBe('empty_output');
    expect(existsSync(join(outcome.runDir, 'manuscript.raw.md'))).toBe(false);
    expect(existsSync(join(outcome.runDir, 'manuscript.body.txt'))).toBe(false);
    expect(env.fake.calls).toHaveLength(1);
    expectRecordPersisted(outcome);
    expectCleanedUp(env);
  });

  it('空白だけの出力も empty_output で、完成稿にしない', async () => {
    const env = makeEnv({ script: { events: okEvents(), output: '  \n\n' } });

    const outcome = failed(await draftStory(draftOpts(env), env.deps));

    expect(outcome.record.failure?.kind).toBe('empty_output');
    expect(existsSync(join(outcome.runDir, 'manuscript.raw.md'))).toBe(false);
  });

  it.each(['command_execution', 'mcp_tool_call', 'collab_agent_tool_call'])(
    '執筆中の期待しないツール（%s）は、本文がそろっていても unexpected_tool',
    async (itemType) => {
      const env = makeEnv({ script: { events: toolCallEvents(itemType), exitCode: 0, output: GOOD_OUTPUT } });

      const outcome = failed(await draftStory(draftOpts(env), env.deps));

      expect(outcome.record.failure?.kind).toBe('unexpected_tool');
      expect(outcome.record.events?.unexpected_items).toContain(itemType);
      expect(existsSync(join(outcome.runDir, 'manuscript.raw.md'))).toBe(false);
      expect(readText(outcome.runDir, 'manuscript.raw.md.partial')).toBe(GOOD_OUTPUT);
      expect(existsSync(join(outcome.runDir, 'manuscript.body.txt'))).toBe(false);
      expectRecordPersisted(outcome);
      expectCleanedUp(env);
    },
  );

  it('spawn の失敗: spawn_error。待ち続けず、running のまま残さない', async () => {
    const env = makeEnv({
      script: { spawnError: { code: 'ENOENT', message: 'spawn codex ENOENT' } },
    });

    const outcome = failed(await draftStory(draftOpts(env), env.deps));

    expect(outcome.record.status).toBe('failed');
    expect(outcome.record.failure?.kind).toBe('spawn_error');
    expect(outcome.record.process?.spawn_error).toContain('ENOENT');
    expect(existsSync(join(outcome.runDir, 'manuscript.raw.md'))).toBe(false);
    expectRecordPersisted(outcome);
    expectCleanedUp(env);
  });

  it('timeout: プロセスグループを止め、requested.timeout_ms に上書きした値を記録する', async () => {
    const env = makeEnv({
      script: { hang: true },
      timeoutMsOverride: 40,
      killGraceMs: 20,
    });

    const outcome = failed(await draftStory(draftOpts(env), env.deps));

    expect(outcome.record.failure?.kind).toBe('timeout');
    expect(outcome.record.requested.timeout_ms).toBe(40);
    expect(outcome.record.process).toMatchObject({ timed_out: true, interrupted: false });
    const pid = env.fake.calls[0]?.child.pid;
    expect(env.fake.groupKills.some((k) => k.pid === pid && k.signal === 'SIGTERM')).toBe(true);
    expect(existsSync(join(outcome.runDir, 'manuscript.raw.md'))).toBe(false);
    expect(env.fake.calls).toHaveLength(1);
    expectRecordPersisted(outcome);
    expectCleanedUp(env);
  });

  it('Ctrl-C（abortSignal）: interrupted。再試行しない', async () => {
    const controller = new AbortController();
    const env = makeEnv({ script: { hang: true }, abortSignal: controller.signal, killGraceMs: 20 });

    const promise = draftStory(draftOpts(env), env.deps);
    let settled = false;
    promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    // spawn されるまで待つ（先に終わってしまったら、その結果をそのまま検査する）
    await waitFor(() => env.fake.calls.length > 0 || settled);
    controller.abort();
    const outcome = failed(await promise);

    expect(outcome.record.failure?.kind).toBe('interrupted');
    expect(outcome.record.process).toMatchObject({ interrupted: true, timed_out: false });
    expect(env.fake.groupKills.length).toBeGreaterThan(0);
    expect(existsSync(join(outcome.runDir, 'manuscript.raw.md'))).toBe(false);
    expect(env.fake.calls).toHaveLength(1);
    expectRecordPersisted(outcome);
    expectCleanedUp(env);
  });

  it('経過の通知（heartbeat）は log に出る', async () => {
    const quiet = makeEnv({ script: { hang: true }, timeoutMsOverride: 200, killGraceMs: 20, heartbeatMs: 60_000 });
    failed(await draftStory(draftOpts(quiet), quiet.deps));
    const noisy = makeEnv({ script: { hang: true }, timeoutMsOverride: 200, killGraceMs: 20, heartbeatMs: 10 });
    failed(await draftStory(draftOpts(noisy), noisy.deps));

    expect(noisy.log.length).toBeGreaterThan(quiet.log.length);
  });
});

// ── revise ─────────────────────────────────────────────────

async function draftedEnv(options: EnvOptions = {}) {
  const env = makeEnv({ script: [ok(GOOD_OUTPUT), ok(REVISED_OUTPUT)], ...options });
  const feedbackPath = writeRepoFile(env, 'authoring/feedback/fb.md', FEEDBACK);
  const parent = succeeded(await draftStory(draftOpts(env), env.deps));
  return { env, parent, feedbackPath };
}

describe('reviseStory: 改稿は新しい run で、元の run は書き換えない', () => {
  it('親の全文・brief・フィードバックを渡す新しい run を作り、来歴を記録する', async () => {
    const { env, parent, feedbackPath } = await draftedEnv();

    const child = succeeded(await reviseStory(reviseOpts(parent.runId, feedbackPath), env.deps));

    expect(child.runId).not.toBe(parent.runId);
    expect(child.runId).toMatch(/^20261003T1354\d\dZ-riko-revise-[0-9a-f]{6}$/);
    const { record } = child;
    expect(record).toMatchObject({
      status: 'succeeded',
      purpose: 'revise',
      stage: 'revised',
      parent_run_id: parent.runId,
      character_id: 'riko',
      failure: null,
    });
    expectRecordPersisted(child);

    expect(byRole(record.inputs, 'manuscript')).toMatchObject({
      source: `run:${parent.runId}/manuscript.raw.md`,
      name: 'manuscript.md',
      file: 'manuscript.parent.md',
      sha256: sha256(GOOD_OUTPUT),
    });
    expect(byRole(record.inputs, 'brief')).toMatchObject({
      source: `run:${parent.runId}/brief.md`,
      name: 'velum_test_brief.md',
      file: 'brief.md',
      sha256: sha256(BRIEF),
    });
    expect(byRole(record.inputs, 'feedback')).toMatchObject({
      source: 'authoring/feedback/fb.md',
      file: 'feedback.md',
      sha256: sha256(FEEDBACK),
    });
    // 執筆用指示は親と同じ内容（条件を揃える）
    expect(byRole(record.inputs, 'instructions')).toMatchObject({
      file: 'instructions.txt',
      sha256: sha256(INSTRUCTIONS),
    });
    expect(record.prompt.framing).toBe(REVISE_FRAMING);

    expect(listDir(child.runDir)).toEqual(
      [
        'brief.md',
        'events.jsonl',
        'feedback.md',
        'instructions.txt',
        'manuscript.body.txt',
        'manuscript.parent.md',
        'manuscript.raw.md',
        'prompt.txt',
        'revision.diff',
        'run.json',
        'stderr.log',
      ].sort(),
    );
    expect(readText(child.runDir, 'manuscript.parent.md')).toBe(GOOD_OUTPUT);
    expect(readText(child.runDir, 'feedback.md')).toBe(FEEDBACK);
    expect(readText(child.runDir, 'manuscript.raw.md')).toBe(REVISED_OUTPUT);
  });

  it('stdin に、親の raw の全文とフィードバックを一字も変えずに渡す', async () => {
    const { env, parent, feedbackPath } = await draftedEnv();

    const child = succeeded(await reviseStory(reviseOpts(parent.runId, feedbackPath), env.deps));

    const call = env.fake.calls[1];
    expect(call).toBeDefined();
    const stdin = call?.stdin() ?? '';
    expect(stdin).toContain(GOOD_OUTPUT);
    expect(stdin).toContain(FEEDBACK);
    expect(stdin).toContain(BRIEF);
    expect(stdin).toBe(
      revisePrompt({
        briefName: BRIEF_NAME,
        brief: BRIEF,
        manuscriptName: 'manuscript.md',
        manuscript: GOOD_OUTPUT,
        feedback: FEEDBACK,
      }),
    );
    expect(readText(child.runDir, 'prompt.txt')).toBe(stdin);
    expect(child.record.prompt.sha256).toBe(sha256(stdin));
    // 新しい run の中の instructions を使う
    expect(call?.args).toContain(
      `model_instructions_file=${JSON.stringify(join(child.runDir, 'instructions.txt'))}`,
    );
    expect(argAfter(call?.args ?? [], '--output-last-message')).toBe(
      join(child.runDir, 'manuscript.raw.md.partial'),
    );
  });

  it('親の run のファイルは、1 バイトも変わらない', async () => {
    const { env, parent, feedbackPath } = await draftedEnv();
    const before = treeSnapshot(parent.runDir);

    succeeded(await reviseStory(reviseOpts(parent.runId, feedbackPath), env.deps));

    expect(treeSnapshot(parent.runDir)).toEqual(before);
    expect(readRecord(parent.runDir)).toEqual(parent.record);
    expect(existsSync(lockPathOf(env))).toBe(false);
  });

  it('revision.diff は親の本文との差分で、記録に親の本文の hash を残す', async () => {
    const { env, parent, feedbackPath } = await draftedEnv();

    const child = succeeded(await reviseStory(reviseOpts(parent.runId, feedbackPath), env.deps));

    expect(child.record.diff).toEqual({
      file: 'revision.diff',
      parent_body_sha256: sha256(readFileSync(join(parent.runDir, 'manuscript.body.txt'))),
      changed: true,
    });
    const diff = readText(child.runDir, 'revision.diff');
    expect(diff).toContain('@@');
    expect(diff).toContain(`-${BODY}`);
    expect(diff).toContain(`+${REVISED_BODY}`);
  });

  it('本文が変わらなければ diff.changed は false で、差分は空', async () => {
    const { env, parent, feedbackPath } = await draftedEnv({ script: ok(GOOD_OUTPUT) });

    const child = succeeded(await reviseStory(reviseOpts(parent.runId, feedbackPath), env.deps));

    expect(child.record.diff).toMatchObject({ file: 'revision.diff', changed: false });
    // 変わらなくても revision.diff は必ず書く（空のファイル = 変わらなかった、という記録）
    const diffPath = join(child.runDir, 'revision.diff');
    expect(existsSync(diffPath)).toBe(true);
    expect(readFileSync(diffPath).byteLength).toBe(0);
    expect(listDir(child.runDir)).toContain('revision.diff');
  });

  it('briefPath を指定すれば、親の写しではなくそのファイルを使う', async () => {
    const { env, parent, feedbackPath } = await draftedEnv();
    const otherBrief = writeRepoFile(env, 'authoring/briefs/other_brief.md', '# 別の設定資料\n');

    const child = succeeded(
      await reviseStory(reviseOpts(parent.runId, feedbackPath, { briefPath: otherBrief }), env.deps),
    );

    expect(byRole(child.record.inputs, 'brief')).toMatchObject({
      source: 'authoring/briefs/other_brief.md',
      name: 'other_brief.md',
      sha256: sha256('# 別の設定資料\n'),
    });
    const stdin = env.fake.calls[1]?.stdin() ?? '';
    expect(stdin).toContain('# 別の設定資料\n');
    expect(stdin).not.toContain(BRIEF);
  });

  it('dry-run は何も書かず、codex も起こさない', async () => {
    const { env, parent, feedbackPath } = await draftedEnv();
    const before = treeSnapshot(env.base);
    const shortCalls = env.short.calls.length;

    const summary = dryRunOf(
      await reviseStory(reviseOpts(parent.runId, feedbackPath, { dryRun: true }), env.deps),
    );

    expect(treeSnapshot(env.base)).toEqual(before);
    expect(env.fake.calls).toHaveLength(1);
    expect(env.short.calls).toHaveLength(shortCalls);
    expect(runDirNames(env)).toEqual([parent.runId]);
    expect(summary).toMatchObject({
      purpose: 'revise',
      model: 'gpt-6-astra',
      fallback: 'none',
      retries: 0,
      calls: 1,
    });
    expect(summary.prompt.framing).toBe(REVISE_FRAMING);
    const prompt = revisePrompt({
      briefName: BRIEF_NAME,
      brief: BRIEF,
      manuscriptName: 'manuscript.md',
      manuscript: GOOD_OUTPUT,
      feedback: FEEDBACK,
    });
    expect(summary.prompt.sha256).toBe(sha256(prompt));
    expect(byRole(summary.inputs, 'manuscript').sha256).toBe(sha256(GOOD_OUTPUT));
    expect(byRole(summary.inputs, 'feedback').sha256).toBe(sha256(FEEDBACK));
    expect(byRole(summary.inputs, 'brief').sha256).toBe(sha256(BRIEF));
  });

  it('dry-run + printPrompt は、親の全文を含む依頼文を表示する', async () => {
    const { env, parent, feedbackPath } = await draftedEnv();

    const summary = dryRunOf(
      await reviseStory(
        reviseOpts(parent.runId, feedbackPath, { dryRun: true, printPrompt: true }),
        env.deps,
      ),
    );

    expect(summary.promptText).toContain(GOOD_OUTPUT);
    expect(summary.promptText).toContain(FEEDBACK);
  });

  describe('入力の誤りは、何も作る前に投げる', () => {
    /** 親の run だけが残っていること（子の run・ロック・追加の spawn が無い） */
    function expectNothingCreated(env: Env, parentIds: string[], spawns: number): void {
      expect(runDirNames(env).sort()).toEqual([...parentIds].sort());
      expect(env.fake.calls, 'spawn された').toHaveLength(spawns);
      expect(existsSync(lockPathOf(env)), 'ロックが残っている').toBe(false);
    }

    it('親の run が成功していない', async () => {
      const env = makeEnv({
        script: {
          events: failedTurnEvents("You've hit your usage limit. Try again later."),
          exitCode: 1,
          output: 'partial text',
        },
      });
      const feedbackPath = writeRepoFile(env, 'authoring/feedback/fb.md', FEEDBACK);
      const parent = failed(await draftStory(draftOpts(env), env.deps));

      await rejected(() => reviseStory(reviseOpts(parent.runId, feedbackPath), env.deps));

      expectNothingCreated(env, [parent.runId], 1);
      // 失敗した run の .partial を、完成稿として親にしない
      expect(existsSync(join(parent.runDir, 'manuscript.raw.md'))).toBe(false);
    });

    it('親の manuscript.raw.md が記録の hash と違う（改ざん）', async () => {
      const { env, parent, feedbackPath } = await draftedEnv();
      const rawPath = join(parent.runDir, 'manuscript.raw.md');
      rmSync(rawPath, { force: true });
      writeFileSync(rawPath, `${GOOD_OUTPUT}勝手に足した一文\n`);
      const tampered = treeSnapshot(parent.runDir);

      await rejected(() => reviseStory(reviseOpts(parent.runId, feedbackPath), env.deps));

      expectNothingCreated(env, [parent.runId], 1);
      expect(treeSnapshot(parent.runDir), '親の run が書き換わった').toEqual(tampered);
    });

    it('存在しない run ID', async () => {
      const { env, parent, feedbackPath } = await draftedEnv();

      await rejected(() =>
        reviseStory(reviseOpts('20261003T000000Z-riko-draft-ffffff', feedbackPath), env.deps),
      );

      expectNothingCreated(env, [parent.runId], 1);
    });

    it('パスの外へ出る run ID（../）', async () => {
      const { env, parent, feedbackPath } = await draftedEnv();

      await rejected(() => reviseStory(reviseOpts('../evil', feedbackPath), env.deps));
      await rejected(() => reviseStory(reviseOpts(`../${parent.runId}`, feedbackPath), env.deps));

      expectNothingCreated(env, [parent.runId], 1);
    });

    it('フィードバックのファイルが無い', async () => {
      const { env, parent } = await draftedEnv();

      const err = await rejected(() =>
        reviseStory(reviseOpts(parent.runId, join(env.root, 'authoring', 'feedback', 'none.md')), env.deps),
      );

      expect(err.message).toContain('none.md');
      expectNothingCreated(env, [parent.runId], 1);
    });

    it('フィードバックが空', async () => {
      const { env, parent } = await draftedEnv();
      const empty = writeRepoFile(env, 'authoring/feedback/empty.md', '');

      await rejected(() => reviseStory(reviseOpts(parent.runId, empty), env.deps));

      expectNothingCreated(env, [parent.runId], 1);
    });

    it('フィードバックが UTF-8 でない', async () => {
      const { env, parent } = await draftedEnv();
      const bad = join(env.root, 'authoring', 'feedback', 'bad.md');
      writeFileSync(bad, Buffer.from([0xff, 0xfe]));

      await rejected(() => reviseStory(reviseOpts(parent.runId, bad), env.deps));

      expectNothingCreated(env, [parent.runId], 1);
    });
  });
});

// ── probe ──────────────────────────────────────────────────

describe('probeAstra: 固定の短い入力で 1 回だけ呼ぶ', () => {
  it('固定の指示と入力を渡し、記録の目的は probe（人物なし・本文の分離なし）', async () => {
    const env = makeEnv({ script: ok('準備完了\n') });

    const outcome = succeeded(await probeAstra({ dryRun: false }, env.deps));

    expect(env.fake.calls).toHaveLength(1);
    const call = env.fake.calls[0];
    expect(call?.stdin()).toBe(PROBE_PROMPT);
    expect(readText(outcome.runDir, 'instructions.txt')).toBe(PROBE_INSTRUCTIONS);
    expect(readText(outcome.runDir, 'prompt.txt')).toBe(PROBE_PROMPT);

    const { record } = outcome;
    expect(outcome.runId).toMatch(/^20261003T1354\d\dZ-astra-probe-[0-9a-f]{6}$/);
    expect(record).toMatchObject({
      purpose: 'probe',
      stage: 'probe',
      parent_run_id: null,
      character_id: null,
      status: 'succeeded',
      failure: null,
    });
    expect(record.output).toMatchObject({
      raw_file: 'probe.raw.txt',
      raw_sha256: sha256('準備完了\n'),
      body_file: null,
      body_sha256: null,
    });
    expect(readText(outcome.runDir, 'probe.raw.txt')).toBe('準備完了\n');
    expect(record.prompt).toMatchObject({
      file: 'prompt.txt',
      framing: PROBE_FRAMING,
      sha256: sha256(PROBE_PROMPT),
    });
    expect(byRole(record.inputs, 'instructions')).toMatchObject({
      source: 'builtin:probe',
      sha256: sha256(PROBE_INSTRUCTIONS),
    });
    expect(byRole(record.inputs, 'request')).toMatchObject({
      source: 'builtin:probe',
      sha256: sha256(PROBE_PROMPT),
    });
    expect(record.inputs.some((input) => input.role === 'brief')).toBe(false);
    expect(record.warnings).toEqual([]);

    const files = listDir(outcome.runDir);
    expect(files).toEqual(
      expect.arrayContaining([
        'instructions.txt',
        'request.txt',
        'prompt.txt',
        'run.json',
        'events.jsonl',
        'stderr.log',
        'probe.raw.txt',
      ]),
    );
    expect(files.some((name) => name.startsWith('manuscript'))).toBe(false);
    expect(files).not.toContain('brief.md');
    expect(files.some((name) => name.endsWith('.partial'))).toBe(false);

    expect(argAfter(call?.args ?? [], '--model')).toBe('gpt-6-astra');
    expect(call?.args).not.toContain('resume');
    expectRecordPersisted(outcome);
    expectCleanedUp(env);
  });

  it('writer.yaml の執筆用指示や brief は渡さない', async () => {
    const env = makeEnv({ script: ok('準備完了\n') });

    succeeded(await probeAstra({ dryRun: false }, env.deps));

    const stdin = env.fake.calls[0]?.stdin() ?? '';
    expect(stdin).not.toContain(BRIEF);
    expect(stdin).not.toContain(REQUEST);
    expect(stdin).not.toContain(INSTRUCTIONS);
  });

  it('dry-run は codex も preflight も起こさず、何も書かない', async () => {
    const env = makeEnv();
    const before = treeSnapshot(env.base);

    const summary = dryRunOf(await probeAstra({ dryRun: true }, env.deps));

    expect(summary).toMatchObject({
      purpose: 'probe',
      model: 'gpt-6-astra',
      authentication: 'chatgpt',
      fallback: 'none',
      retries: 0,
      calls: 1,
    });
    expect(summary.prompt.framing).toBe(PROBE_FRAMING);
    expect(summary.prompt.sha256).toBe(sha256(PROBE_PROMPT));
    expect(byRole(summary.inputs, 'instructions').source).toBe('builtin:probe');
    expect(env.fake.calls).toHaveLength(0);
    expect(env.short.calls).toHaveLength(0);
    expect(treeSnapshot(env.base)).toEqual(before);
    expect(existsSync(env.runsRoot)).toBe(false);
  });

  it('preflight が通らなければ blocked（API キーのログインでは呼ばない）', async () => {
    const env = makeEnv({ short: { login: REAL.loginApiKey } });

    const problems = blockedOf(await probeAstra({ dryRun: false }, env.deps));

    expect(problems.length).toBeGreaterThan(0);
    expect(env.fake.calls).toHaveLength(0);
    expect(runDirNames(env)).toEqual([]);
    expect(existsSync(lockPathOf(env))).toBe(false);
  });

  it('利用枠の上限で失敗したら、usage_limit として記録し、再試行しない', async () => {
    const env = makeEnv({
      script: {
        events: failedTurnEvents("You've hit your usage limit. Try again later."),
        exitCode: 1,
        output: 'partial',
      },
    });

    const outcome = failed(await probeAstra({ dryRun: false }, env.deps));

    expect(outcome.record.failure?.kind).toBe('usage_limit');
    expect(existsSync(join(outcome.runDir, 'probe.raw.txt'))).toBe(false);
    expect(env.fake.calls).toHaveLength(1);
    expectRecordPersisted(outcome);
    expectCleanedUp(env);
  });
});

// ── 記録の一貫性・来歴 ─────────────────────────────────────

/** 偽の codex の呼び出しから、その run のディレクトリ（model_instructions_file の置き場）を取る */
function runDirOfCall(call: SpawnCall): string {
  const arg = call.args.find((a) => a.startsWith('model_instructions_file=')) ?? '';
  return dirname(JSON.parse(arg.slice('model_instructions_file='.length)) as string);
}

function onlyCall(env: Env): SpawnCall {
  const call = env.fake.calls[0];
  if (!call) throw new Error('spawn されていない');
  return call;
}

describe('run.json の warnings と failure に、絶対パスを残さない', () => {
  /** 環境ごとに違う絶対パス（run・作業ディレクトリ・root・.story-runs・OS の一時ディレクトリ） */
  const forbiddenPaths = (env: Env, runDir: string, workdir: string): string[] => [
    ...new Set([runDir, workdir, env.root, env.runsRoot, tmpdir(), realpathSync(tmpdir())]),
  ];

  it('失敗した run: 途中の出力の warning は run の中の相対名で、failure の文面にもパスを残さない', async () => {
    const holder = { root: '' };
    const env = makeEnv({
      script: (call) => ({
        events: okEvents().slice(0, 2),
        exitCode: 1,
        // 実際の Codex の stderr に混ざりうる環境のパス（run が先頭に近いので、原因の 300 字の切り詰めに残る）
        stderr: `codex: 読めません ${join(runDirOfCall(call), 'x.txt')} / cwd ${call.options.cwd} / repo ${holder.root} / tmp ${tmpdir()}\n`,
        output: '途中の文',
        workdirFiles: { 'notes.txt': '勝手なメモ' },
      }),
    });
    holder.root = env.root;

    const outcome = failed(await draftStory(draftOpts(env), env.deps));

    const workdir = onlyCall(env).options.cwd;
    const record = readRecord(outcome.runDir);
    expect(record.warnings).toContain('失敗した run の出力が残っている（完成稿ではない）: manuscript.raw.md.partial');
    expect(record.warnings.join('\n')).toMatch(/作業ディレクトリ/);
    expect(record.failure?.message).toContain('読めません');
    expect(record.failure?.message).toContain('<WORKDIR>');
    const recorded = JSON.stringify({ warnings: record.warnings, failure: record.failure });
    for (const path of forbiddenPaths(env, outcome.runDir, workdir)) {
      expect(recorded, `記録に ${path} が残っている`).not.toContain(path);
    }
    expect(record).toEqual(outcome.record);
    expectCleanedUp(env);
  });

  it('パスの中に分類のきっかけになる語（login）があっても、それだけで auth と判定しない', async () => {
    const env = makeEnv({
      script: (call) => ({
        events: okEvents().slice(0, 2),
        exitCode: 1,
        stderr: `codex: 読めません cwd ${call.options.cwd}\n`,
        output: '途中の文',
      }),
      // 作業ディレクトリの名前に login を含める。パスを置き換えてから分類するので、文面には残らない
      makeWorkdir: ({ workRoot }) => mkdtempSync(join(workRoot, 'login-')),
    });

    const outcome = failed(await draftStory(draftOpts(env), env.deps));

    expect(outcome.record.failure?.kind).toBe('nonzero_exit');
    expect(outcome.record.failure?.message).toContain('読めません');
    expect(outcome.record.failure?.message).not.toContain('login-');
  });

  it('成功した run の warnings も同じ（回復した error イベントの文面に混じったパスは置き換える）', async () => {
    const env = makeEnv({
      script: (call) => {
        const events = okEvents();
        // turn.started の直後に、作業ディレクトリのパスを含む再接続の通知を差し込む（turn は完了する）
        events.splice(2, 0, { type: 'error', message: `reconnecting: cannot reach ${call.options.cwd}` });
        return { events, output: GOOD_OUTPUT, workdirFiles: { 'notes.txt': '勝手なメモ' } };
      },
    });

    const { record } = succeeded(await draftStory(draftOpts(env), env.deps));

    const workdir = onlyCall(env).options.cwd;
    const warnings = record.warnings.join('\n');
    expect(record.status).toBe('succeeded');
    expect(warnings).toContain('reconnecting');
    expect(warnings).toContain('<WORKDIR>');
    for (const path of forbiddenPaths(env, join(env.runsRoot, record.run_id), workdir)) {
      expect(warnings, `warnings に ${path} が残っている`).not.toContain(path);
    }
  });

  it('作業ディレクトリを消せなかった warning は <WORKDIR> で書き、理由の中のパスも置き換える', async () => {
    const env = makeEnv();
    env.deps.removeWorkdir = (dir) => {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(`EACCES: permission denied, rmdir '${dir}'`);
    };

    const { record } = succeeded(await draftStory(draftOpts(env), env.deps));

    const workdir = onlyCall(env).options.cwd;
    const warning = record.warnings.find((w) => w.includes('作業ディレクトリを消せなかった'));
    expect(warning).toBeDefined();
    expect(warning).toContain('<WORKDIR>');
    expect(warning).toContain('EACCES');
    expect(JSON.stringify(record.warnings)).not.toContain(workdir);
  });

  it('spawn の失敗（failure.message と process.spawn_error）にも、パスを残さない', async () => {
    const env = makeEnv({
      script: (call) => ({
        spawnError: { code: 'ENOENT', message: `spawn codex ENOENT (cwd: ${call.options.cwd})` },
      }),
    });

    const outcome = failed(await draftStory(draftOpts(env), env.deps));

    const workdir = onlyCall(env).options.cwd;
    expect(outcome.record.failure?.kind).toBe('spawn_error');
    expect(outcome.record.failure?.message).toContain('ENOENT');
    expect(JSON.stringify(readRecord(outcome.runDir))).not.toContain(workdir);
  });
});

// ── 作者用の秘密の一覧の事前確認 ───────────────────────────

describe('作者用の秘密の一覧は、利用枠を使う前に読んで確かめる', () => {
  const broken = (_text: string): Array<{ owner: string }> => {
    throw new Error('profile.yaml を読めません（YAML が壊れている）');
  };

  it('draft: 一覧を読めなければ、ロック・run のディレクトリ・spawn・preflight より前に、入力の誤りとして投げる', async () => {
    const leaks = vi.fn(broken);
    const env = makeEnv({ secretLeaks: leaks });

    const err = await rejected(() => draftStory(draftOpts(env), env.deps));

    expect(err.message).toMatch(/秘密/);
    expect(err.message).toContain('YAML が壊れている');
    expect(leaks).toHaveBeenCalledTimes(1);
    expect(leaks).toHaveBeenCalledWith('');
    expect(env.fake.calls, 'spawn された').toHaveLength(0);
    expect(env.short.calls, 'preflight が走った').toHaveLength(0);
    expect(existsSync(env.runsRoot), '.story-runs が作られた').toBe(false);
    expect(env.created, '作業ディレクトリが作られた').toEqual([]);
  });

  it('draft の dry-run でも、一覧を読めなければ投げる（本番の run と同じ確認）', async () => {
    const env = makeEnv({ secretLeaks: vi.fn(broken) });

    const err = await rejected(() => draftStory(draftOpts(env, { dryRun: true }), env.deps));

    expect(err.message).toMatch(/秘密/);
    expect(existsSync(env.runsRoot)).toBe(false);
  });

  it('revise: 一覧を読めなければ、親の run は変えず、子の run もロックも作らない', async () => {
    const { env, parent, feedbackPath } = await draftedEnv();
    const before = treeSnapshot(parent.runDir);
    const shortCalls = env.short.calls.length;
    const leaks = vi.fn(broken);
    env.deps.secretLeaks = leaks;

    const err = await rejected(() => reviseStory(reviseOpts(parent.runId, feedbackPath), env.deps));

    expect(err.message).toMatch(/秘密/);
    expect(leaks).toHaveBeenCalledTimes(1);
    expect(leaks).toHaveBeenCalledWith('');
    expect(env.fake.calls, '再び spawn された').toHaveLength(1);
    expect(env.short.calls, 'preflight が走った').toHaveLength(shortCalls);
    expect(runDirNames(env)).toEqual([parent.runId]);
    expect(treeSnapshot(parent.runDir)).toEqual(before);
    expect(existsSync(lockPathOf(env))).toBe(false);
    expect(env.created, '作業ディレクトリが作られた').toHaveLength(1);
  });

  it('probe は原稿を取り分けないので、秘密の一覧を使わない', async () => {
    const leaks = vi.fn(broken);
    const env = makeEnv({ secretLeaks: leaks });

    const outcome = await probeAstra({ dryRun: false }, env.deps);

    expect(outcome.status).toBe('succeeded');
    expect(leaks).not.toHaveBeenCalled();
    expect(secretLeaksInMock).not.toHaveBeenCalled();
  });

  it('成功する run: 最初の呼び出しは空文字の事前確認で、spawn も preflight より前。そのあと原稿の照合に使う', async () => {
    const seen: Array<{ text: string; spawns: number; shorts: number }> = [];
    const holder: { env: Env | null } = { env: null };
    const leaks = vi.fn((text: string): Array<{ owner: string }> => {
      seen.push({
        text,
        spawns: holder.env?.fake.calls.length ?? -1,
        shorts: holder.env?.short.calls.length ?? -1,
      });
      return [];
    });
    const env = makeEnv({ secretLeaks: leaks });
    holder.env = env;

    succeeded(await draftStory(draftOpts(env), env.deps));

    expect(seen[0]).toEqual({ text: '', spawns: 0, shorts: 0 });
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.slice(1).some((entry) => entry.text.includes(BODY) && entry.spawns === 1)).toBe(true);
  });

  it('事前確認の結果は見ない（空文字で断片が返っても、それだけでは止めない）', async () => {
    const env = makeEnv({ secretLeaks: () => [{ owner: 'riko' }] });

    const { record } = succeeded(await draftStory(draftOpts(env), env.deps));

    expect(record.status).toBe('succeeded');
    expect(env.fake.calls).toHaveLength(1);
  });

  it('deps.secretLeaks が無ければ、src/lib/secrets.ts の secretLeaksIn で確かめる（読めなければ投げる）', async () => {
    secretLeaksInMock.mockImplementation(broken as (text: string) => Array<{ owner: string; segment: string }>);
    const env = makeEnv();
    delete env.deps.secretLeaks;

    const err = await rejected(() => draftStory(draftOpts(env), env.deps));

    expect(err.message).toMatch(/秘密/);
    expect(secretLeaksInMock).toHaveBeenCalledTimes(1);
    expect(secretLeaksInMock).toHaveBeenCalledWith('');
    expect(env.fake.calls).toHaveLength(0);
    expect(env.short.calls).toHaveLength(0);
    expect(existsSync(env.runsRoot)).toBe(false);
    expect(env.created).toEqual([]);
  });

  it('deps.secretLeaks が無い run: 既定の照合が見つけた断片は、所有者だけを warning に書く（断片は書かない）', async () => {
    const SEGMENT = 'CANARY-SEGMENT-X';
    secretLeaksInMock.mockImplementation(() => [{ owner: 'riko', segment: SEGMENT }]);
    const env = makeEnv();
    delete env.deps.secretLeaks;

    const { record, runDir } = succeeded(await draftStory(draftOpts(env), env.deps));

    const warnings = record.warnings.join('\n');
    expect(record.status).toBe('succeeded');
    expect(warnings).toContain('riko');
    expect(warnings).not.toContain(SEGMENT);
    expect(readText(runDir, 'run.json')).not.toContain(SEGMENT);
    expect(secretLeaksInMock.mock.calls[0]).toEqual(['']);
    expect(secretLeaksInMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    // 原稿は取り消さない
    expect(readText(runDir, 'manuscript.raw.md')).toBe(GOOD_OUTPUT);
  });
});

// ── raw の昇格の順序 ───────────────────────────────────────

describe('manuscript.raw.md は、本文と差分が揃ってから昇格する', () => {
  it('draft: manuscript.body.txt を書いてから raw へ移し、そのあとで run.json を完成させる', async () => {
    await successfulDraft();

    const ops = runsFaults.ops;
    const body = ops.indexOf('manuscript.body.txt');
    const move = ops.indexOf('move:manuscript.raw.md');
    const final = ops.indexOf('write:run.json#2');
    expect(body).toBeGreaterThanOrEqual(0);
    expect(move).toBeGreaterThan(body);
    expect(final).toBeGreaterThan(move);
  });

  it('revise: manuscript.body.txt と revision.diff を書いてから raw へ移す', async () => {
    const { env, parent, feedbackPath } = await draftedEnv();
    runsFaults.ops = [];

    succeeded(await reviseStory(reviseOpts(parent.runId, feedbackPath), env.deps));

    const ops = runsFaults.ops;
    const body = ops.indexOf('manuscript.body.txt');
    const diff = ops.indexOf('revision.diff');
    const move = ops.indexOf('move:manuscript.raw.md');
    expect(body).toBeGreaterThanOrEqual(0);
    expect(diff).toBeGreaterThan(body);
    expect(move).toBeGreaterThan(diff);
  });

  it('probe: 本文も差分も無いので、raw（probe.raw.txt）はそのまま移す', async () => {
    const env = makeEnv();

    const outcome = succeeded(await probeAstra({ dryRun: false }, env.deps));

    expect(runsFaults.ops).toContain('move:probe.raw.txt');
    expect(listDir(outcome.runDir)).toContain('probe.raw.txt');
    expect(listDir(outcome.runDir)).not.toContain('probe.raw.txt.partial');
  });

  it('draft: 本文を書けなかったら、raw は作られず、出力は .partial のまま（run.json は running）', async () => {
    runsFaults.failFile = 'manuscript.body.txt';
    const env = makeEnv();

    const err = await rejected(() => draftStory(draftOpts(env), env.deps));

    expect(err.message).toContain('manuscript.body.txt');
    const [runId] = runDirNames(env);
    const runDir = join(env.runsRoot, runId ?? '');
    expect(existsSync(join(runDir, 'manuscript.raw.md')), 'raw が本文より先に昇格した').toBe(false);
    expect(readText(runDir, 'manuscript.raw.md.partial')).toBe(GOOD_OUTPUT);
    expect(readRecord(runDir).status).toBe('running');
    expectCleanedUp(env);
  });

  it('revise: 差分を書けなかったら、本文はあっても raw は作られない', async () => {
    const { env, parent, feedbackPath } = await draftedEnv();
    runsFaults.failFile = 'revision.diff';

    const err = await rejected(() => reviseStory(reviseOpts(parent.runId, feedbackPath), env.deps));

    expect(err.message).toContain('revision.diff');
    const childId = runDirNames(env).find((name) => name !== parent.runId);
    expect(childId).toBeDefined();
    const childDir = join(env.runsRoot, childId ?? '');
    expect(listDir(childDir)).toContain('manuscript.body.txt');
    expect(existsSync(join(childDir, 'manuscript.raw.md')), 'raw が差分より先に昇格した').toBe(false);
    expect(readText(childDir, 'manuscript.raw.md.partial')).toBe(REVISED_OUTPUT);
    expect(readRecord(childDir).status).toBe('running');
    // 親の run は変わらない
    expect(readRecord(parent.runDir)).toEqual(parent.record);
    expectCleanedUp(env);
  });
});

// ── 記録に失敗したときの案内 ───────────────────────────────

describe('run を最後まで記録できなかったときの案内は、実際の状態と合っている', () => {
  it('running の run.json を書く前に落ちたら「run.json はまだありません」と言い、あるファイルだけを挙げる', async () => {
    runsFaults.failRecordOn = 1;
    const env = makeEnv();

    const err = await rejected(() => draftStory(draftOpts(env), env.deps));

    const [runId] = runDirNames(env);
    const runDir = join(env.runsRoot, runId ?? '');
    const present = listDir(runDir);
    expect(present.length).toBeGreaterThan(0);
    expect(existsSync(join(runDir, 'run.json'))).toBe(false);
    expect(err.message).toContain('disk full: run.json');
    expect(err.message).toContain(runId ?? '');
    expect(err.message).toContain('run.json はまだありません');
    expect(err.message).not.toContain('running のまま');
    for (const name of present) expect(err.message, `ある ${name} を挙げていない`).toContain(name);
    // まだ起こしていないので、これらは無い。無いものを「ある」と言わない
    for (const missing of ['events.jsonl', 'stderr.log', '.partial', 'manuscript.raw.md']) {
      expect(err.message, `無い ${missing} を挙げている`).not.toContain(missing);
    }
    expect(env.fake.calls, 'run.json が無いのに spawn された').toHaveLength(0);
    expectCleanedUp(env);
  });

  it('running の run.json を置いたあとに落ちたら、running のまま残っていると言い、あるファイルを挙げる', async () => {
    runsFaults.failRecordOn = 2;
    const env = makeEnv();

    const err = await rejected(() => draftStory(draftOpts(env), env.deps));

    const [runId] = runDirNames(env);
    const runDir = join(env.runsRoot, runId ?? '');
    expect(readRecord(runDir).status).toBe('running');
    expect(err.message).toContain('disk full: run.json');
    expect(err.message).toContain('running のまま');
    expect(err.message).not.toContain('run.json はまだありません');
    for (const name of listDir(runDir)) expect(err.message, `ある ${name} を挙げていない`).toContain(name);
    // 成功した出力は raw へ移したあとなので、.partial はもう無い
    expect(listDir(runDir)).not.toContain('manuscript.raw.md.partial');
    expect(err.message).not.toContain('.partial');
    expectCleanedUp(env);
  });
});

// ── 中断 ───────────────────────────────────────────────────

describe('実行前の確認のあとで中断されていたら、Codex を起動しない', () => {
  function expectNotStarted(env: Env, problems: string[]): void {
    expect(problems.join('\n')).toMatch(/中断/);
    expect(env.fake.calls, 'spawn された').toHaveLength(0);
    expect(runDirNames(env), 'run のディレクトリが作られた').toEqual([]);
    expect(existsSync(lockPathOf(env)), 'ロックが作られた').toBe(false);
    expect(env.created, '作業ディレクトリが作られた').toEqual([]);
  }

  it('最初から中断されていれば blocked（中断）。codex も run のディレクトリもロックも作らない', async () => {
    const controller = new AbortController();
    controller.abort();
    const env = makeEnv({ abortSignal: controller.signal });

    expectNotStarted(env, blockedOf(await draftStory(draftOpts(env), env.deps)));
  });

  it('preflight の最中に中断されたら blocked（中断）。確認が通っていても codex を起動しない', async () => {
    const controller = new AbortController();
    const env = makeEnv({ abortSignal: controller.signal });
    const inner = env.deps.shortRun;
    env.deps.shortRun = async (...params: Parameters<typeof inner>) => {
      const result = await inner(...params);
      // 最後の確認（モデルのカタログ）の結果が返る直前に Ctrl-C が来た、という状況
      if (params[0][0] === 'debug' && params[0][1] === 'models') controller.abort();
      return result;
    };

    expectNotStarted(env, blockedOf(await draftStory(draftOpts(env), env.deps)));
  });

  it('改稿でも同じ（親の run は変わらず、子の run は作らない）', async () => {
    const controller = new AbortController();
    const { env, parent, feedbackPath } = await draftedEnv({ abortSignal: controller.signal });
    const before = treeSnapshot(parent.runDir);
    controller.abort();

    const problems = blockedOf(await reviseStory(reviseOpts(parent.runId, feedbackPath), env.deps));

    expect(problems.join('\n')).toMatch(/中断/);
    expect(env.fake.calls, '再び spawn された').toHaveLength(1);
    expect(runDirNames(env)).toEqual([parent.runId]);
    expect(treeSnapshot(parent.runDir)).toEqual(before);
    expect(existsSync(lockPathOf(env))).toBe(false);
    expect(env.created, '作業ディレクトリが作られた').toHaveLength(1);
  });

  it('probe も同じ', async () => {
    const controller = new AbortController();
    controller.abort();
    const env = makeEnv({ abortSignal: controller.signal });

    expectNotStarted(env, blockedOf(await probeAstra({ dryRun: false }, env.deps)));
  });

  it('中断されていなければ、signal を持っているだけでは止まらない', async () => {
    const controller = new AbortController();
    const env = makeEnv({ abortSignal: controller.signal });

    const outcome = succeeded(await draftStory(draftOpts(env), env.deps));

    expect(outcome.status).toBe('succeeded');
    expect(env.fake.calls).toHaveLength(1);
  });
});

// ── BOM ────────────────────────────────────────────────────

describe('BOM（EF BB BF）で始まる入力は、一字も 1 バイトも変えない', () => {
  const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
  const withBom = (text: string): Buffer => Buffer.concat([BOM, Buffer.from(text, 'utf8')]);
  const U_FEFF = '﻿';

  it('draft: brief・依頼文・執筆用指示が BOM で始まっても、stdin と prompt.txt は U+FEFF を残し、写しはバイトが一致し、hash は元のバイト列', async () => {
    const instructions = withBom(INSTRUCTIONS);
    const brief = withBom(BRIEF);
    const request = withBom(REQUEST);

    const { call, runDir, record } = await successfulDraft({ instructions, brief, request });

    // 依頼文（stdin）: BOM も文字として残る（落とすと、記録した hash と Astra へ渡した文字列が食い違う）
    const prompt = draftPrompt({ briefName: BRIEF_NAME, brief: `${U_FEFF}${BRIEF}`, request: `${U_FEFF}${REQUEST}` });
    expect(call.stdin()).toBe(prompt);
    expect(call.stdin()).toContain(`${U_FEFF}${BRIEF}`);
    expect(call.stdin()).toContain(`${U_FEFF}${REQUEST}`);
    expect(readFileSync(join(runDir, 'prompt.txt')).equals(Buffer.from(prompt, 'utf8'))).toBe(true);
    expect(readFileSync(join(runDir, 'prompt.txt')).includes(BOM)).toBe(true);
    expect(record.prompt.sha256).toBe(sha256(prompt));

    // 写しは元のバイト列そのまま。記録した hash・大きさも元のバイト列のもの（chars は BOM も 1 字）
    const copies: Array<{ role: RunInput['role']; file: string; source: Buffer }> = [
      { role: 'instructions', file: 'instructions.txt', source: instructions },
      { role: 'brief', file: 'brief.md', source: brief },
      { role: 'request', file: 'request.txt', source: request },
    ];
    for (const { role, file, source } of copies) {
      const copy = readFileSync(join(runDir, file));
      expect(copy.equals(source), `${file} の写しがバイトで一致しない`).toBe(true);
      expect(copy.subarray(0, 3).equals(BOM), `${file} の BOM が落ちた`).toBe(true);
      expect(byRole(record.inputs, role)).toMatchObject({
        file,
        sha256: sha256(source),
        bytes: source.byteLength,
        chars: [...source.toString('utf8')].length,
      });
    }
  });

  it('revise: BOM で始まるフィードバックも、そのまま渡して残す', async () => {
    const { env, parent } = await draftedEnv();
    const feedback = withBom(FEEDBACK);
    const feedbackPath = join(env.root, 'authoring', 'feedback', 'bom.md');
    mkdirSync(dirname(feedbackPath), { recursive: true });
    writeFileSync(feedbackPath, feedback);

    const child = succeeded(await reviseStory(reviseOpts(parent.runId, feedbackPath), env.deps));

    const call = env.fake.calls[1];
    expect(call?.stdin()).toContain(`${U_FEFF}${FEEDBACK}`);
    expect(readFileSync(join(child.runDir, 'feedback.md')).equals(feedback)).toBe(true);
    expect(byRole(child.record.inputs, 'feedback')).toMatchObject({
      sha256: sha256(feedback),
      bytes: feedback.byteLength,
    });
  });
});

// ── failureAdvice ──────────────────────────────────────────

describe('failureAdvice: 失敗の種類ごとに、人がすること', () => {
  it.each([...FAILURE_KINDS])('%s には説明がある', (kind) => {
    const advice = failureAdvice(kind);

    expect(typeof advice).toBe('string');
    expect(advice.trim().length).toBeGreaterThan(0);
    // どの失敗でも、別のモデル・別のプロバイダへの切り替えは案内しない
    const lower = advice.toLowerCase();
    expect(lower).not.toContain('gemini');
    expect(lower).not.toContain('workers');
  });

  it('usage_limit は、枠の回復を待つことを案内する（別モデルへは誘導しない）', () => {
    const advice = failureAdvice('usage_limit');

    expect(advice).toContain('待');
    const lower = advice.toLowerCase();
    expect(lower).not.toContain('gemini');
    expect(lower).not.toContain('workers');
  });

  it('auth は codex login を、config と unexpected_tool は story:doctor を案内する', () => {
    expect(failureAdvice('auth')).toContain('codex login');
    expect(failureAdvice('config')).toContain('story:doctor');
    expect(failureAdvice('unexpected_tool')).toContain('story:doctor');
  });
});

// ── realAuthoringDeps ──────────────────────────────────────

describe('realAuthoringDeps: 本物の依存（codex は起動しない）', () => {
  it('実環境の既定値を持つ', () => {
    const controller = new AbortController();
    const deps = realAuthoringDeps({ config: CONFIG, abortSignal: controller.signal });

    expect(deps.root).toBe(ROOT);
    expect(deps.runsRoot).toBe(join(ROOT, RUNS_DIR));
    expect(deps.config).toEqual(CONFIG);
    expect(deps.pid).toBe(process.pid);
    expect(deps.abortSignal).toBe(controller.signal);
    expect(deps.env.PATH).toBe(process.env.PATH);
    expect(typeof deps.shortRun).toBe('function');
    expect(typeof deps.process.spawn).toBe('function');
    expect(typeof deps.process.killGroup).toBe('function');
    expect(typeof deps.process.now()).toBe('number');
    expect(deps.now()).toBeInstanceOf(Date);
    expect(deps.random()).toMatch(/^[0-9a-f]{6}$/);
    expect(typeof deps.log).toBe('function');
  });

  it('abortSignal を渡さなければ持たない', () => {
    expect(realAuthoringDeps({ config: CONFIG }).abortSignal).toBeUndefined();
  });

  it('secretLeaks は設定しない（既定の secretLeaksIn を使い、テスト用の差し替えを本物へ混ぜない）', () => {
    const deps = realAuthoringDeps({ config: CONFIG });

    expect(deps.secretLeaks).toBeUndefined();
    expect('secretLeaks' in deps).toBe(false);
    expect('secretLeaks' in realAuthoringDeps({ config: CONFIG, abortSignal: new AbortController().signal })).toBe(false);
  });

  it('作業ディレクトリは Git リポジトリの外の空のディレクトリで、removeWorkdir で消える', () => {
    const deps = realAuthoringDeps({ config: CONFIG });
    const first = deps.makeWorkdir();
    const second = deps.makeWorkdir();
    try {
      expect(first).not.toBe(second);
      for (const dir of [first, second]) {
        expect(isAbsolute(dir)).toBe(true);
        expect(existsSync(dir)).toBe(true);
        expect(readdirSync(dir)).toEqual([]);
        expect(relative(ROOT, realpathSync(dir)).startsWith('..')).toBe(true);
        const git = spawnSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], {
          encoding: 'utf8',
        });
        expect(String(git.stdout ?? '').trim()).not.toBe('true');
      }
    } finally {
      deps.removeWorkdir(first);
      deps.removeWorkdir(second);
    }
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
    expect(basename(first).length).toBeGreaterThan(0);
  });
});
