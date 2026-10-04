import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type {
  ChildLike,
  KillGroup,
  ShortResult,
  ShortRun,
  ShortRunOptions,
  SpawnLike,
  SpawnOptionsLike,
} from '../../src/story/authoring/codex-process.js';

/**
 * 本物の codex を一切起動しないための偽物。テストは live 推論を呼ばない。
 *
 * - fakeSpawn: 長い1回の実行（codex exec）の偽の子プロセス。stdin を集め、
 *   `--output-last-message` の次の引数のパスへ output を書き、stdout へ JSONL、stderr へ文を流し、
 *   'exit' → 'close' の順に発火する。hang なら、killGroup / kill が来るまで終わらない
 *   （ignoreSigterm は SIGTERM を、ignoreAllSignals はどの signal も無視する）。
 *   neverClose なら 'exit' だけを出して 'close' を出さず、stdout も開いたまま（孫がパイプを握った状況）。
 *   stdinError なら spawn の直後に child.stdin へ EPIPE の 'error' を出す。
 *   spawnError なら 'error' だけを発火する（'close' は来ない。実装が待ち続けないことを確かめる）
 * - fakeShortRun: 短い確認コマンドの偽物。live の exec（provider が DOCTOR_SENTINEL_PROVIDER でない exec）を
 *   ShortRun で呼ぼうとしたら投げる——doctor が推論を起こさないことの保証になる
 */

export const CLI_FIXTURE_DIR = fileURLToPath(
  new URL('../fixtures/authoring/cli-0.153.4/', import.meta.url),
);
export const readCliFixture = (name: string): string =>
  readFileSync(join(CLI_FIXTURE_DIR, name), 'utf8');

/** 実機の 0.153.4 の出力（login status は stderr に出る） */
export const REAL = {
  version: 'codex-cli 0.153.4',
  loginChatgpt: 'Logged in using ChatGPT',
  loginApiKey: 'Logged in using an API key - sk-proj-***ABCD',
  notLoggedIn: 'Not logged in',
  sentinelNotFound: 'Error: Model provider `velum-doctor-no-inference` not found',
  unknownField:
    'Error loading config.toml: unknown configuration field `features.velum_nope` in -c/--config override',
} as const;

// ── 長い実行 ───────────────────────────────────────────────

export type FakeBehavior = {
  /** stdout へ流す JSONL。オブジェクトは JSON.stringify、文字列はそのまま1行 */
  events?: Array<Record<string, unknown> | string>;
  stderr?: string;
  /** 正常終了の exit code（既定 0）。hang のときは使わない */
  exitCode?: number;
  /** --output-last-message へ書く文。null / undefined なら書かない */
  output?: string | null;
  /** 作業ディレクトリ（options.cwd）に残すファイル（Codex が何か書いた、を再現する） */
  workdirFiles?: Record<string, string>;
  /** kill が来るまで終わらない */
  hang?: boolean;
  /** hang のとき SIGTERM を無視する（SIGKILL で終わる） */
  ignoreSigterm?: boolean;
  /** hang のとき SIGTERM も SIGKILL も受け付けない（どの signal でも終わらない子を再現する） */
  ignoreAllSignals?: boolean;
  /**
   * 'exit' は出すが 'close' は出さず、stdout / stderr も開いたままにする。
   * 孫がパイプを握ったまま子だけが終わった状況（実物では 'close' が来ない）を再現する
   */
  neverClose?: boolean;
  /** spawn の直後に child.stdin へ EPIPE の 'error' を出す（子が stdin を読み切る前に終わった状況） */
  stdinError?: boolean;
  /** spawn の失敗（'error' だけを発火） */
  spawnError?: { code: string; message: string };
};

export type SpawnCall = {
  command: string;
  args: string[];
  options: SpawnOptionsLike;
  /** stdin に書かれたもの（end まで） */
  stdin: () => string;
  child: FakeChild;
};

export class FakeChild extends EventEmitter implements ChildLike {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid: number | undefined;
  readonly kills: Array<NodeJS.Signals | number | undefined> = [];
  finished = false;
  /** true なら finish() は 'exit' だけを出す（'close' を出さず、stdout / stderr も閉じない） */
  neverClose = false;
  onSignal: ((signal: NodeJS.Signals) => void) | null = null;

  constructor(pid: number | undefined) {
    super();
    this.pid = pid;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push(signal);
    if (typeof signal === 'string') this.onSignal?.(signal);
    else this.onSignal?.('SIGTERM');
    return true;
  }

  finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.finished) return;
    this.finished = true;
    if (!this.neverClose) {
      this.stdout.end();
      this.stderr.end();
    }
    setImmediate(() => {
      this.emit('exit', code, signal);
      if (!this.neverClose) setImmediate(() => this.emit('close', code, signal));
    });
  }
}

export function argAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export function fakeSpawn(behavior: FakeBehavior | ((call: SpawnCall) => FakeBehavior)) {
  const calls: SpawnCall[] = [];
  const groupKills: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const children = new Map<number, FakeChild>();
  let nextPid = 4242;

  const spawn: SpawnLike = (command, args, options) => {
    const decide = (call: SpawnCall) => (typeof behavior === 'function' ? behavior(call) : behavior);
    const chunks: Buffer[] = [];
    // spawn の失敗は pid を持たない
    const probe: SpawnCall = {
      command,
      args: [...args],
      options,
      stdin: () => Buffer.concat(chunks).toString('utf8'),
      child: new FakeChild(undefined),
    };
    const b = decide(probe);
    const child = new FakeChild(b.spawnError ? undefined : nextPid++);
    child.neverClose = b.neverClose ?? false;
    const call: SpawnCall = { ...probe, child };
    calls.push(call);
    child.stdin.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));

    if (b.spawnError) {
      setImmediate(() => {
        const error = Object.assign(new Error(b.spawnError!.message), { code: b.spawnError!.code });
        child.emit('error', error);
      });
      return child;
    }
    children.set(child.pid!, child);

    if (b.stdinError) {
      // 実物の EPIPE と同じく、'error' を出す。子の exit より前（次の check フェーズ）に届く
      setImmediate(() => {
        child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      });
    }

    const complete = () => {
      const out = argAfter(args, '--output-last-message');
      if (out && b.output !== undefined && b.output !== null) writeFileSync(out, b.output, 'utf8');
      for (const [name, text] of Object.entries(b.workdirFiles ?? {})) {
        writeFileSync(join(options.cwd, name), text, 'utf8');
      }
      for (const event of b.events ?? []) {
        child.stdout.write(`${typeof event === 'string' ? event : JSON.stringify(event)}\n`);
      }
      if (b.stderr) child.stderr.write(b.stderr);
      child.finish(b.exitCode ?? 0, null);
    };

    if (b.hang) {
      child.onSignal = (signal) => {
        if (b.ignoreAllSignals) return;
        if (signal === 'SIGTERM' && b.ignoreSigterm) return;
        if (b.stderr) child.stderr.write(b.stderr);
        child.finish(null, signal);
      };
    } else {
      // 実物と同じく、stdin が閉じてから仕事をする
      child.stdin.on('finish', () => setImmediate(complete));
    }
    return child;
  };

  const killGroup: KillGroup = (pid, signal) => {
    groupKills.push({ pid, signal });
    const child = children.get(pid);
    if (!child) throw Object.assign(new Error(`kill ESRCH ${pid}`), { code: 'ESRCH' });
    child.onSignal?.(signal);
  };

  return { spawn, killGroup, calls, groupKills };
}

// ── 典型的なイベント列 ─────────────────────────────────────

export const okEvents = (extra: { model?: string } = {}): Array<Record<string, unknown>> => [
  { type: 'thread.started', thread_id: 'thread-test-1' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: '' } },
  {
    type: 'item.completed',
    item: { id: 'item_1', type: 'agent_message', text: '（本文は --output-last-message に書かれる）' },
  },
  {
    type: 'turn.completed',
    usage: { input_tokens: 4100, cached_input_tokens: 0, output_tokens: 6200, reasoning_output_tokens: 1800 },
    ...(extra.model ? { model: extra.model } : {}),
  },
];

export const toolCallEvents = (itemType: string): Array<Record<string, unknown>> => [
  { type: 'thread.started', thread_id: 'thread-test-2' },
  { type: 'turn.started' },
  { type: 'item.started', item: { id: 'item_0', type: itemType } },
  { type: 'item.completed', item: { id: 'item_0', type: itemType } },
  { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'x' } },
  { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
];

export const failedTurnEvents = (message: string): Array<Record<string, unknown>> => [
  { type: 'thread.started', thread_id: 'thread-test-3' },
  { type: 'turn.started' },
  { type: 'error', message },
  { type: 'turn.failed', error: { message } },
];

// ── 短い確認コマンド ───────────────────────────────────────

export type FakeShortOptions = {
  /** `codex --version` の stdout（既定は REAL.version） */
  version?: string;
  /** `codex login status` の stderr（既定は REAL.loginChatgpt） */
  login?: string;
  /** `codex debug models` の stdout（既定は実機のカタログの fixture） */
  catalog?: string;
  /** `codex exec --help`（既定は実機の fixture） */
  execHelp?: string;
  /** `codex debug prompt-input`（既定は実機の fixture） */
  promptInput?: string;
  /** strict-config の検査（provider が sentinel の exec）の stderr（既定は REAL.sentinelNotFound） */
  strictConfigStderr?: string;
  /** 任意のコマンドを spawn の失敗にする（例: codex が PATH に無い） */
  missingCli?: boolean;
};

export type ShortCall = { args: string[]; options: ShortRunOptions };

export function fakeShortRun(options: FakeShortOptions = {}) {
  const calls: ShortCall[] = [];
  const ok = (stdout: string, stderr = ''): ShortResult => ({ exitCode: 0, stdout, stderr, error: null });

  const run: ShortRun = async (args, runOptions) => {
    calls.push({ args: [...args], options: runOptions });
    if (options.missingCli) {
      return { exitCode: null, stdout: '', stderr: '', error: 'spawn codex ENOENT' };
    }
    const [first, second] = args;
    if (first === '--version') return ok(`${options.version ?? REAL.version}\n`);
    if (first === 'login' && second === 'status') {
      const text = options.login ?? REAL.loginChatgpt;
      return { exitCode: text === REAL.notLoggedIn ? 1 : 0, stdout: '', stderr: `${text}\n`, error: null };
    }
    if (first === 'debug' && second === 'models') return ok(options.catalog ?? readCliFixture('models.json'));
    if (first === 'debug' && second === 'prompt-input') {
      return ok(options.promptInput ?? readCliFixture('prompt-input.json'));
    }
    if (first === 'exec' && args.includes('--help')) return ok(options.execHelp ?? readCliFixture('exec-help.txt'));
    if (first === 'exec') {
      if (!args.includes('model_provider="velum-doctor-no-inference"')) {
        throw new Error(`ShortRun で live の exec を呼ぼうとした: ${args.join(' ')}`);
      }
      return { exitCode: 1, stdout: '', stderr: `${options.strictConfigStderr ?? REAL.sentinelNotFound}\n`, error: null };
    }
    throw new Error(`fakeShortRun: 想定外のコマンド: ${args.join(' ')}`);
  };

  return { run, calls };
}
