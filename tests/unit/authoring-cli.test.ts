import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installCliSafety } from '../../src/story/authoring/cli.js';

/**
 * 3 本の CLI（story:doctor / story:draft / story:revise）に共通する「落ち方の安全」と、
 * CLI 自体の smoke test。本物の codex は呼ばない。
 *
 * - installCliSafety は process 相当の EventEmitter を注入して、signal・stdout/stderr の error・exit の
 *   振る舞いを確かめる（本物の process には listener を足さない）
 * - smoke test は tsx で本物のスクリプトを子プロセスとして起こす。PATH を空のディレクトリにして、
 *   万一 codex を起こす実装に変わっても ENOENT で止まるようにする。story-doctor は codex を起こすので走らせない
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const SCRIPTS = ['story-doctor.ts', 'story-draft.ts', 'story-revise.ts'] as const;

// ── installCliSafety ───────────────────────────────────────

/** process の代わり。stdout / stderr も EventEmitter（'error' だけを使う） */
function fakeProcess() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const proc = Object.assign(new EventEmitter(), { stdout, stderr });
  return { proc, stdout, stderr };
}

/** installCliSafety を偽の process に入れる。表示した文と、exit 時に送られた signal を集める */
function install(options: { log?: (message: string) => void } = {}) {
  const controller = new AbortController();
  const fake = fakeProcess();
  const messages: string[] = [];
  const killed: NodeJS.Signals[] = [];
  installCliSafety(controller, fake.proc, {
    log: options.log ?? ((message) => messages.push(message)),
    killActiveProcessGroups: (signal) => killed.push(signal),
  });
  return { controller, messages, killed, ...fake };
}

const errno = (code: string, message = `write ${code}`): NodeJS.ErrnoException =>
  Object.assign(new Error(message), { code });

/** emit が投げたものを返す（投げなければ undefined） */
function thrownBy(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('installCliSafety: signal', () => {
  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)('最初の %s で中断し、Codex を止めている旨を表示する', (signal) => {
    const { controller, proc, messages } = install();
    expect(controller.signal.aborted).toBe(false);

    proc.emit(signal);

    expect(controller.signal.aborted).toBe(true);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(signal);
    expect(messages[0]).toContain('Codex を止めています');
  });

  it('SIGHUP（端末が閉じた）でも SIGINT と同じく中断する', () => {
    const { controller, proc } = install();
    proc.emit('SIGHUP');
    expect(controller.signal.aborted).toBe(true);
  });

  it('2 つ目以降の signal は投げず、もう止めている旨を表示するだけで、中断をやり直さない', () => {
    const { controller, proc, messages } = install();
    let aborts = 0;
    controller.signal.addEventListener('abort', () => (aborts += 1));

    proc.emit('SIGINT');
    expect(thrownBy(() => proc.emit('SIGINT'))).toBeUndefined();
    expect(thrownBy(() => proc.emit('SIGTERM'))).toBeUndefined();
    expect(thrownBy(() => proc.emit('SIGHUP'))).toBeUndefined();

    expect(aborts).toBe(1);
    expect(messages).toHaveLength(4);
    expect(messages[0]).toContain('Codex を止めています');
    for (const later of messages.slice(1)) expect(later).toContain('すでに止めています');
    expect(messages[2]).toContain('SIGTERM');
    expect(messages[3]).toContain('SIGHUP');
  });

  it('表示が投げても、中断は必ず行われる（端末が消えたあとの表示失敗で Codex を残さない）', () => {
    const { controller, proc } = install({
      log: () => {
        throw errno('EIO', 'write EIO');
      },
    });
    expect(thrownBy(() => proc.emit('SIGHUP'))).toBeUndefined();
    expect(controller.signal.aborted).toBe(true);
  });

  it('注入した process にだけ listener を足す（本物の process には足さない）', () => {
    const before = {
      sigint: process.listenerCount('SIGINT'),
      sighup: process.listenerCount('SIGHUP'),
      exit: process.listenerCount('exit'),
      stdout: process.stdout.listenerCount('error'),
      stderr: process.stderr.listenerCount('error'),
    };
    const { proc, stdout, stderr } = install();

    expect(proc.listenerCount('SIGINT')).toBe(1);
    expect(proc.listenerCount('SIGTERM')).toBe(1);
    expect(proc.listenerCount('SIGHUP')).toBe(1);
    expect(proc.listenerCount('exit')).toBe(1);
    expect(stdout.listenerCount('error')).toBe(1);
    expect(stderr.listenerCount('error')).toBe(1);
    expect({
      sigint: process.listenerCount('SIGINT'),
      sighup: process.listenerCount('SIGHUP'),
      exit: process.listenerCount('exit'),
      stdout: process.stdout.listenerCount('error'),
      stderr: process.stderr.listenerCount('error'),
    }).toEqual(before);
  });
});

describe('installCliSafety: stdout / stderr の error', () => {
  const streams = ['stdout', 'stderr'] as const;

  it.each(streams.flatMap((stream) => (['EPIPE', 'EIO'] as const).map((code) => [stream, code] as const)))(
    '%s の %s は握りつぶす（閉じた pipe・hangup 後の書き込みで親が落ちて Codex を残さない）',
    (stream, code) => {
      const fake = install();
      expect(thrownBy(() => fake[stream].emit('error', errno(code)))).toBeUndefined();
    },
  );

  it.each(streams)('%s のそれ以外の error（ENOSPC・code なし）は投げ直す', (stream) => {
    const fake = install();

    const full = errno('ENOSPC', 'write ENOSPC');
    expect(thrownBy(() => fake[stream].emit('error', full))).toBe(full);

    const plain = new Error('code のないエラー');
    expect(thrownBy(() => fake[stream].emit('error', plain))).toBe(plain);
  });

  it('error を握りつぶしても中断はしない（出力が壊れただけでは run を止めない）', () => {
    const { controller, stdout } = install();
    stdout.emit('error', errno('EPIPE'));
    expect(controller.signal.aborted).toBe(false);
  });
});

describe('installCliSafety: exit', () => {
  it('exit で、起こしている Codex のプロセスグループへ SIGKILL を同期で送る', () => {
    const { proc, killed } = install();
    expect(killed).toEqual([]);

    proc.emit('exit', 1);

    expect(killed).toEqual(['SIGKILL']);
  });

  it('signal を受けた時点では SIGKILL しない（子の終了を確かめる猶予は run 側が持つ）', () => {
    const { proc, killed } = install();
    proc.emit('SIGINT');
    proc.emit('SIGHUP');
    expect(killed).toEqual([]);
  });
});

// ── 3 本の CLI が共通の helper を使う ────────────────────────

describe('CLI スクリプト: 共通の installCliSafety を使う', () => {
  it.each(SCRIPTS)('%s は installCliSafety を使い、signal / exit の処理を自前で持たない', (script) => {
    const source = readFileSync(join(REPO_ROOT, 'scripts', script), 'utf8');
    expect(source).toContain("from '../src/story/authoring/cli.js'");
    expect(source).toContain('installCliSafety(controller)');
    expect(source).not.toContain('abortOnSignals');
    expect(source).not.toMatch(/process\.on\(/);
  });
});

// ── smoke test（本物のスクリプトを tsx で起こす）──────────────

type CliResult = { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

let sandbox: string;
/** 空の PATH。codex を起こそうとしても ENOENT になる */
let emptyBin: string;
let feedbackPath: string;

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'velum-authoring-cli-'));
  emptyBin = join(sandbox, 'empty-bin');
  mkdirSync(emptyBin);
  feedbackPath = join(sandbox, 'feedback.md');
  writeFileSync(feedbackPath, 'テスト用のフィードバック\n', 'utf8');
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/** scripts/<script> を tsx で走らせる。cwd は repo root。timeout を過ぎたら SIGKILL して、そのまま結果を返す。 */
function runScript(script: string, args: readonly string[], timeoutMs = 30_000): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, join(REPO_ROOT, 'scripts', script), ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, PATH: emptyBin },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    child.stdout.on('data', (chunk: Buffer) => chunks.stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => chunks.stderr.push(chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolvePromise({
        status,
        signal,
        stdout: Buffer.concat(chunks.stdout).toString('utf8'),
        stderr: Buffer.concat(chunks.stderr).toString('utf8'),
      });
    });
  });
}

/** .story-runs の中身（無ければ null）。run の前後で変わっていないことの確認に使う */
function storyRunsListing(): string[] | null {
  const dir = join(REPO_ROOT, '.story-runs');
  return existsSync(dir) ? readdirSync(dir).sort() : null;
}

describe('CLI スクリプト: smoke（tsx で本物を起こす。codex は起こさない）', () => {
  it(
    'story:draft --dry-run は実際の materials で、呼び出し 1 回・モデルを示して終了コード 0。.story-runs を作らない',
    async () => {
      const before = storyRunsListing();

      const result = await runScript('story-draft.ts', [
        '--character',
        'riko',
        '--brief',
        join(REPO_ROOT, 'authoring', 'briefs', 'velum_riko_writing_brief.md'),
        '--request',
        join(REPO_ROOT, 'authoring', 'prompts', 'riko-first-request.txt'),
        '--dry-run',
      ]);

      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('推論の呼び出し: 1 回');
      expect(result.stdout).toContain('gpt-6-astra');
      // .story-runs が無かったなら作られていない。あったなら中身が増えていない
      expect(storyRunsListing()).toEqual(before);
    },
    30_000,
  );

  it(
    'story:revise は存在しない run を、終了コード 1 と run が無い旨のメッセージで断る（--dry-run でも）',
    async () => {
      const before = storyRunsListing();

      const result = await runScript('story-revise.ts', [
        '--run',
        '20260101T000000Z-riko-draft-000000',
        '--feedback',
        feedbackPath,
        '--dry-run',
      ]);

      expect(result.signal).toBeNull();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('run が見つかりません');
      expect(result.stderr).toContain('20260101T000000Z-riko-draft-000000');
      expect(storyRunsListing()).toEqual(before);
    },
    30_000,
  );

  it(
    'story:draft を --character なしで起こすと、終了コード 1 と使い方を出す',
    async () => {
      const result = await runScript('story-draft.ts', []);

      expect(result.signal).toBeNull();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('--character が要ります');
      expect(result.stderr).toContain('使い方: npm run story:draft');
      expect(result.stdout).toBe('');
    },
    30_000,
  );
});
