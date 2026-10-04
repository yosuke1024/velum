import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  killActiveProcessGroups,
  realProcessDeps,
  runCodexProcess,
  shortRunner,
  type RunCodexInput,
} from '../../src/story/authoring/codex-process.js';

/**
 * 本物の子プロセス（node 自身）で、fake では確かめられないことを確かめる:
 * shell を介さず引数が一字違わず届くこと、日本語の stdin、孫ごとプロセスグループを止められること、
 * 親が落ちるときの安全網（killActiveProcessGroups）。本物の codex は呼ばない。
 *
 * 子の script は、日本語・空白・引用符を含むパスの下へ書く（パスの扱いも一緒に確かめる）。
 * POSIX のプロセスグループが前提なので、Windows では飛ばす。
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 引数をそのまま JSON にして stdout へ返し、stdin を読み切ってその内容も返す */
const ECHO_SCRIPT = `
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const stdin = Buffer.concat(chunks).toString('utf8');
  process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), stdin }) + '\\n');
});
`;

/**
 * 孫（SIGTERM を無視する）を起こす先頭のプロセス。引数: <孫の script> <pid を書くファイル> <自分も SIGTERM を無視するか 0|1> <mode>
 * - hold: 孫の stdio は捨て、自分は居座る（打ち切られるまで）
 * - exit-holding-pipe: 孫へ自分の stdio（パイプ）を渡し、自分はすぐ正常終了する（孫がパイプを握ったまま）
 * どちらも30秒で自分で消える（テストが失敗しても取り残さない）
 */
const LEADER_SCRIPT = `
const { spawn } = require('node:child_process');
const [grandScript, pidFile, ignoreTerm, mode] = process.argv.slice(2);
if (ignoreTerm === '1') process.on('SIGTERM', () => {});
if (mode === 'hold') {
  spawn(process.execPath, [grandScript, pidFile], { stdio: 'ignore' });
  setTimeout(() => process.exit(0), 30000);
} else {
  const grand = spawn(process.execPath, [grandScript, pidFile], { stdio: 'inherit' });
  grand.unref();
  process.exit(0);
}
`;

/** SIGTERM を無視して居座る孫。pid を（rename で原子的に）ファイルへ書く */
const GRANDCHILD_SCRIPT = `
const { renameSync, writeFileSync } = require('node:fs');
process.on('SIGTERM', () => {});
const pidFile = process.argv[2];
writeFileSync(pidFile + '.tmp', String(process.pid));
renameSync(pidFile + '.tmp', pidFile);
setTimeout(() => process.exit(0), 30000);
`;

/** 'ps' で状態を見て、死んでいるが親に回収されていない（zombie）ものも「消えた」と数える */
function isGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return true; // ESRCH
  }
  try {
    const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return state.startsWith('Z');
  } catch (error) {
    // ps が pid を見つけられなかった（消えた）。ps 自体が無ければ判定できないので「まだ居る」とする
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

describe.skipIf(process.platform === 'win32')('実プロセス: codex-process', () => {
  const env = { PATH: process.env.PATH ?? '' };
  let root = '';
  let dir = '';
  let echoScript = '';
  let leaderScript = '';
  let grandScript = '';
  /** テストが起こした孫の pid。失敗しても afterAll で止める */
  const leftoverPids: number[] = [];

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'velum-authoring-real-'));
    // 日本語・空白・単引用符・二重引用符を含む作業ディレクトリ
    dir = join(root, `日本語 の "dir" 's'`);
    mkdirSync(dir);
    echoScript = join(dir, 'echo 日本語 "q".cjs');
    leaderScript = join(dir, 'leader 日本語 "q".cjs');
    grandScript = join(dir, 'grandchild 日本語 "q".cjs');
    writeFileSync(echoScript, ECHO_SCRIPT, 'utf8');
    writeFileSync(leaderScript, LEADER_SCRIPT, 'utf8');
    writeFileSync(grandScript, GRANDCHILD_SCRIPT, 'utf8');
  });

  afterAll(() => {
    for (const pid of leftoverPids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // もう居ない
      }
    }
    rmSync(root, { recursive: true, force: true });
  });

  /** 孫が pid を書くのを待って読む。読んだ pid は後始末の対象に加える */
  async function readPid(file: string): Promise<number> {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {
        const text = readFileSync(file, 'utf8');
        if (/^\d+$/.test(text)) {
          const pid = Number(text);
          leftoverPids.push(pid);
          return pid;
        }
      } catch {
        // まだ無い
      }
      await sleep(25);
    }
    throw new Error(`孫の pid が ${file} に書かれなかった`);
  }

  const runInput = (tag: string, overrides: Partial<RunCodexInput>): RunCodexInput => ({
    command: process.execPath,
    args: [echoScript],
    cwd: dir,
    env,
    stdin: '',
    stdoutPath: join(dir, `${tag}.events.jsonl`),
    stderrPath: join(dir, `${tag}.stderr.log`),
    timeoutMs: 15_000,
    killGraceMs: 300,
    ...overrides,
  });

  describe('引数と stdin', () => {
    it('shell を介さない: 特殊な引数が一字違わず届き、コマンドは実行されない', { timeout: 15_000 }, async () => {
      const tricky = [
        '$(touch MARK)',
        ';touch MARK',
        '`touch MARK`',
        '"quoted"',
        "it's a 'single'",
        '&& touch MARK',
        '| touch MARK',
        '> MARK',
        '$HOME ${HOME} ~',
        '*',
        '日本語 の 引数 ',
        '',
        '--flag=a b',
      ];
      const input = runInput('args', { args: [echoScript, ...tricky] });
      const result = await runCodexProcess(input, realProcessDeps());

      expect(result).toMatchObject({ exitCode: 0, signal: null, timedOut: false, spawnError: null });
      const echoed = JSON.parse(readFileSync(input.stdoutPath, 'utf8')) as { argv: string[]; stdin: string };
      expect(echoed.argv).toEqual(tricky);
      // shell が評価していれば、子の cwd に MARK ができている
      expect(existsSync(join(dir, 'MARK'))).toBe(false);
    });

    it('stdin の日本語・引用符・改行・長い文が、バイト単位で欠けずに届く', { timeout: 15_000 }, async () => {
      const stdin = `こんにちは "世界" '引用' \`バッククォート\` $(x)\n二行目\n\n${'日本語の長い文。'.repeat(30_000)}末尾`;
      const input = runInput('stdin', { stdin });
      const result = await runCodexProcess(input, realProcessDeps());

      expect(result).toMatchObject({ exitCode: 0, signal: null, timedOut: false, spawnError: null });
      const echoed = JSON.parse(readFileSync(input.stdoutPath, 'utf8')) as { argv: string[]; stdin: string };
      expect(echoed.stdin).toBe(stdin);
      expect(echoed.argv).toEqual([]);
    });

    it('shortRunner も、引数と stdin を一字違わず渡し、stdout を日本語のまま集める', { timeout: 15_000 }, async () => {
      const run = shortRunner(process.execPath, realProcessDeps());
      const result = await run([echoScript, '$(touch MARK)', '日本語'], {
        env,
        cwd: dir,
        timeoutMs: 10_000,
        stdin: '入力: こんにちは',
      });

      expect(result.error).toBeNull();
      expect(result.exitCode).toBe(0);
      const echoed = JSON.parse(result.stdout) as { argv: string[]; stdin: string };
      expect(echoed).toEqual({ argv: ['$(touch MARK)', '日本語'], stdin: '入力: こんにちは' });
      expect(existsSync(join(dir, 'MARK'))).toBe(false);
    });
  });

  describe('プロセスグループ', () => {
    it.each([
      { label: '先頭は SIGTERM で終わるが、孫は SIGTERM を無視する', leaderIgnoresSigterm: false },
      { label: '先頭も孫も SIGTERM を無視する（猶予後の SIGKILL が要る）', leaderIgnoresSigterm: true },
    ])(
      'timeout で、孫ごとグループを止める: $label',
      async ({ leaderIgnoresSigterm }) => {
        const tag = leaderIgnoresSigterm ? 'group-both' : 'group-grand';
        const pidFile = join(dir, `${tag}.pid`);
        const input = runInput(tag, {
          args: [leaderScript, grandScript, pidFile, leaderIgnoresSigterm ? '1' : '0', 'hold'],
          timeoutMs: 1500,
          killGraceMs: 300,
        });
        const result = await runCodexProcess(input, realProcessDeps());

        expect(result).toMatchObject({ timedOut: true, interrupted: false, spawnError: null });
        const grandPid = await readPid(pidFile);
        // 孫が SIGTERM を無視して居座っていても、結論のあとにグループへ送る SIGKILL で消える
        await expect.poll(() => isGone(grandPid), { timeout: 4000, interval: 50 }).toBe(true);
      },
      20_000,
    );

    it('先頭が正常終了したあと、孫がパイプを握ったままでも、killGraceMs で見切って exit 0 を返す', { timeout: 8000 }, async () => {
      const pidFile = join(dir, 'holder.pid');
      const input = runInput('holder', {
        args: [leaderScript, grandScript, pidFile, '0', 'exit-holding-pipe'],
        timeoutMs: 20_000, // timeout に救われていないことを確かめる（孫は30秒生きる）
        killGraceMs: 400,
      });
      const startedAt = Date.now();
      const result = await runCodexProcess(input, realProcessDeps());
      const waitedMs = Date.now() - startedAt;
      // 孫は取り残される（このテストが起こしたものなので、afterAll で止める）
      await readPid(pidFile);

      expect(result).toMatchObject({
        exitCode: 0,
        signal: null,
        timedOut: false,
        interrupted: false,
        spawnError: null,
      });
      expect(waitedMs).toBeLessThan(6000);
    });

    it('shortRunner(realProcessDeps()) も、timeout で孫ごとグループを止める', { timeout: 20_000 }, async () => {
      const pidFile = join(dir, 'short-group.pid');
      const run = shortRunner(process.execPath, realProcessDeps());
      const result = await run([leaderScript, grandScript, pidFile, '1', 'hold'], {
        env,
        cwd: dir,
        timeoutMs: 1500,
      });

      expect(result.exitCode).toBeNull();
      expect(result.error).toMatch(/timeout/i);
      const grandPid = await readPid(pidFile);
      await expect.poll(() => isGone(grandPid), { timeout: 4000, interval: 50 }).toBe(true);
    });
  });

  describe('killActiveProcessGroups（親が落ちるときの安全網）', () => {
    const spawnOptions = (detached: boolean) =>
      ({ cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], detached }) as const;
    const FOREVER = ['-e', 'setTimeout(() => {}, 30000)'];

    it('走っている detached の子のグループへ、同期でシグナルを送る', { timeout: 15_000 }, async () => {
      const deps = realProcessDeps();
      const child = deps.spawn(process.execPath, FOREVER, spawnOptions(true));
      const pid = child.pid;
      expect(typeof pid).toBe('number');
      if (pid !== undefined) leftoverPids.push(pid);
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => resolve({ code, signal }));
      });

      killActiveProcessGroups('SIGKILL');

      const outcome = await Promise.race([
        exited,
        sleep(5000).then(() => 'まだ走っている' as const),
      ]);
      expect(outcome).toEqual({ code: null, signal: 'SIGKILL' });
    });

    it('detached でない子には触れず、終わった子のグループへは送らず、何も無くても投げない', { timeout: 15_000 }, async () => {
      const deps = realProcessDeps();

      // 終わった detached の子: 'close' のあとは覚えていない
      const quick = deps.spawn(process.execPath, ['-e', ''], spawnOptions(true));
      const quickPid = quick.pid;
      await new Promise<void>((resolve) => quick.once('close', () => resolve()));

      // detached でない子: 数えない
      const plain = deps.spawn(process.execPath, FOREVER, spawnOptions(false));
      const plainPid = plain.pid;
      expect(typeof plainPid).toBe('number');
      if (plainPid !== undefined) leftoverPids.push(plainPid);
      const plainExited = new Promise<void>((resolve) => plain.once('exit', () => resolve()));

      const spy = vi.spyOn(process, 'kill');
      let targets: number[] = [];
      try {
        expect(() => killActiveProcessGroups('SIGKILL')).not.toThrow();
        // mockRestore は呼び出しの記録も消すので、戻す前に取っておく
        targets = spy.mock.calls.map(([pid]) => pid);
      } finally {
        spy.mockRestore();
      }
      expect(targets).not.toContain(-(quickPid ?? 0));
      expect(targets).not.toContain(-(plainPid ?? 0));
      expect(targets).not.toContain(plainPid);

      // 触れていないので、まだ走っている
      expect(plainPid !== undefined && isGone(plainPid)).toBe(false);
      plain.kill('SIGKILL');
      await plainExited;
    });
  });
});
