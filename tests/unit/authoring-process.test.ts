import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  realProcessDeps,
  runCodexProcess,
  shortRunner,
  type KillGroup,
  type ProcessDeps,
  type RunCodexInput,
  type SpawnLike,
} from '../../src/story/authoring/codex-process.js';
import { FakeChild, REAL, argAfter, fakeSpawn, okEvents } from '../helpers/fake-codex.js';

const root = mkdtempSync(join(tmpdir(), 'velum-authoring-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, limitMs = 1000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > limitMs) throw new Error('waitFor: 条件が満たされなかった');
    await sleep(2);
  }
}

/** テストごとに空の作業ディレクトリを切る */
const freshDir = (): string => mkdtempSync(join(root, 'run-'));

const baseInput = (dir: string, overrides: Partial<RunCodexInput> = {}): RunCodexInput => ({
  command: 'codex',
  args: ['exec', '--json', '--output-last-message', join(dir, 'manuscript.raw.md.partial'), '-'],
  cwd: dir,
  env: { PATH: '/usr/bin', VELUM_TEST_ENV: '1' },
  stdin: '依頼文',
  stdoutPath: join(dir, 'events.jsonl'),
  stderrPath: join(dir, 'stderr.log'),
  timeoutMs: 5000,
  ...overrides,
});

type Fake = ReturnType<typeof fakeSpawn>;

const depsOf = (fake: Fake, now: () => number = () => Date.now()): ProcessDeps => ({
  spawn: fake.spawn,
  killGroup: fake.killGroup,
  now,
});

/**
 * spawn されたら abort する。実行が先に失敗・終了した場合は、spawn の待ちを打ち切ってそのまま進む
 * （失敗の理由は、呼び出し側が結果を await したときに現れる）。
 */
async function abortOnceSpawned(
  running: Promise<unknown>,
  fake: Fake,
  controller: AbortController,
): Promise<void> {
  running.catch(() => undefined); // 先に失敗しても未処理の rejection にしない
  const spawned = waitFor(() => fake.calls.length > 0);
  spawned.catch(() => undefined);
  await Promise.race([spawned, running.then(() => undefined, () => undefined)]);
  controller.abort();
}

/** 既存パスを拒むときのエラーの文面（EEXIST をそのまま、または日本語の説明のどちらでもよい） */
const EXISTS_MESSAGE = /EEXIST|exist|既|存在|上書/i;

/** マルチバイト文字の途中で chunk を切って stdout / stderr へ流す偽の spawn */
function splitMultibyteSpawn(stdoutText: string, stderrText: string, cuts: number[]): SpawnLike {
  const writeChunks = async (stream: PassThrough, text: string) => {
    const buffer = Buffer.from(text, 'utf8');
    let previous = 0;
    for (const cut of [...cuts, buffer.length]) {
      const end = Math.min(cut, buffer.length);
      if (end > previous) stream.write(buffer.subarray(previous, end));
      previous = Math.max(previous, end);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };
  return () => {
    const child = new FakeChild(7001);
    child.stdin.on('finish', () => {
      void (async () => {
        await writeChunks(child.stdout, stdoutText);
        await writeChunks(child.stderr, stderrText);
        child.finish(0, null);
      })();
    });
    return child;
  };
}

describe('runCodexProcess: 正常終了', () => {
  it('spawn へ command・args・options を渡し、shell を介さない', async () => {
    const dir = freshDir();
    const fake = fakeSpawn({ events: okEvents() });
    const args = Object.freeze([
      'exec',
      '--json',
      '--output-last-message',
      join(dir, 'manuscript.raw.md.partial'),
      '-',
    ]);
    const env = { PATH: '/usr/bin', VELUM_TEST_ENV: '1' };
    const envBefore = JSON.stringify(process.env);
    await runCodexProcess(baseInput(dir, { args, env }), depsOf(fake));

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.command).toBe('codex');
    expect(call.args).toEqual([...args]);
    expect(Array.isArray(call.args)).toBe(true);
    expect(call.options).toEqual({
      cwd: dir,
      env: { PATH: '/usr/bin', VELUM_TEST_ENV: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    expect(argAfter(call.args, '--output-last-message')).toBe(join(dir, 'manuscript.raw.md.partial'));
    // 渡した env を書き換えない。親の環境も変えない
    expect(env).toEqual({ PATH: '/usr/bin', VELUM_TEST_ENV: '1' });
    expect(JSON.stringify(process.env)).toBe(envBefore);
  });

  it('stdin へ UTF-8 の入力をそのまま書いて閉じる（日本語・引用符・改行）', async () => {
    const dir = freshDir();
    const fake = fakeSpawn({ events: okEvents() });
    const stdin = 'こんにちは "世界" \'引用\' `バッククォート`\n二行目\n\n三行目の末尾 \\n はそのまま';
    await runCodexProcess(baseInput(dir, { stdin }), depsOf(fake));
    expect(fake.calls[0]!.stdin()).toBe(stdin);
  });

  it('stdout の JSONL を events.jsonl へ一字違わず書き、stderr を stderr.log へ書く', async () => {
    const dir = freshDir();
    const events = [
      ...okEvents(),
      '{"type":"item.completed","item":{"id":"item_9","type":"agent_message","text":"日本語の行"}}',
    ];
    const fake = fakeSpawn({ events, stderr: '警告: stderr の文\nreading prompt from stdin\n' });
    const input = baseInput(dir);
    await runCodexProcess(input, depsOf(fake));

    const expected = `${events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n')}\n`;
    // 解決した時点でファイルは閉じている（すぐ読んで全部ある）
    expect(readFileSync(input.stdoutPath, 'utf8')).toBe(expected);
    expect(readFileSync(input.stderrPath, 'utf8')).toBe('警告: stderr の文\nreading prompt from stdin\n');
  });

  it('{exitCode:0, signal:null, timedOut:false, interrupted:false, spawnError:null} で解決する', async () => {
    const dir = freshDir();
    const fake = fakeSpawn({ events: okEvents() });
    const result = await runCodexProcess(baseInput(dir), depsOf(fake));
    expect(result).toMatchObject({
      exitCode: 0,
      signal: null,
      timedOut: false,
      interrupted: false,
      spawnError: null,
    });
    expect(typeof result.durationMs).toBe('number');
  });

  it('durationMs は deps.now() の開始と終了の差', async () => {
    const dir = freshDir();
    const fake = fakeSpawn({ events: okEvents() });
    let calls = 0;
    const now = () => (calls++ === 0 ? 1000 : 4500);
    const result = await runCodexProcess(baseInput(dir), depsOf(fake, now));
    expect(result.durationMs).toBe(3500);
  });

  it('大きな出力（約450KB・3000行）も取りこぼさず、解決した時点で全部ファイルにある', async () => {
    const dir = freshDir();
    const lines = Array.from({ length: 3000 }, (_, i) =>
      JSON.stringify({
        type: 'item.completed',
        item: { id: `item_${i}`, type: 'agent_message', text: `行${i} ${'あ'.repeat(30)}` },
      }),
    );
    const fake = fakeSpawn({ events: lines });
    const input = baseInput(dir);
    await runCodexProcess(input, depsOf(fake));
    expect(readFileSync(input.stdoutPath, 'utf8')).toBe(`${lines.join('\n')}\n`);
  });

  it('マルチバイト文字の途中で chunk が切れても、ファイルの中身はバイト単位で一致する', async () => {
    const dir = freshDir();
    const stdoutText = '{"text":"日本語の物語"}\n';
    const stderrText = '標準エラー: 日本語\n';
    const input = baseInput(dir);
    const spawn = splitMultibyteSpawn(stdoutText, stderrText, [2, 5, 7, 13]);
    await runCodexProcess(input, { spawn, killGroup: () => undefined, now: () => Date.now() });
    expect(readFileSync(input.stdoutPath)).toEqual(Buffer.from(stdoutText, 'utf8'));
    expect(readFileSync(input.stderrPath)).toEqual(Buffer.from(stderrText, 'utf8'));
  });

  it('stdout / stderr 以外のファイルを作らず、子が書いた -o のファイルには触れない', async () => {
    const dir = freshDir();
    const fake = fakeSpawn({ events: okEvents(), output: '本文（子が書いたもの）' });
    await runCodexProcess(baseInput(dir), depsOf(fake));
    expect(readdirSync(dir).sort()).toEqual(['events.jsonl', 'manuscript.raw.md.partial', 'stderr.log']);
    expect(readFileSync(join(dir, 'manuscript.raw.md.partial'), 'utf8')).toBe('本文（子が書いたもの）');
  });

  it('exit code 3 はそのまま返す（失敗の判定は呼び出し側）', async () => {
    const dir = freshDir();
    const fake = fakeSpawn({ events: okEvents(), stderr: 'boom\n', exitCode: 3 });
    const input = baseInput(dir);
    const result = await runCodexProcess(input, depsOf(fake));
    expect(result).toMatchObject({
      exitCode: 3,
      signal: null,
      timedOut: false,
      interrupted: false,
      spawnError: null,
    });
    expect(readFileSync(input.stderrPath, 'utf8')).toBe('boom\n');
  });

  it('正常終了したあとは、timeout の SIGTERM / SIGKILL タイマーが残らない', async () => {
    const dir = freshDir();
    const fake = fakeSpawn({ events: okEvents() });
    await runCodexProcess(baseInput(dir, { timeoutMs: 40, killGraceMs: 20 }), depsOf(fake));
    await sleep(100);
    expect(fake.groupKills).toEqual([]);
    expect(fake.calls[0]!.child.kills).toEqual([]);
  });
});

describe('runCodexProcess: 既存ファイルは上書きしない', () => {
  it('stdoutPath が既にあれば spawn する前に投げ、中身は変えない', async () => {
    const dir = freshDir();
    const input = baseInput(dir);
    writeFileSync(input.stdoutPath, 'KEEP-STDOUT');
    const fake = fakeSpawn({ events: okEvents() });
    await expect(runCodexProcess(input, depsOf(fake))).rejects.toThrow(EXISTS_MESSAGE);
    expect(fake.calls).toHaveLength(0);
    expect(readFileSync(input.stdoutPath, 'utf8')).toBe('KEEP-STDOUT');
  });

  it('stderrPath が既にあれば spawn する前に投げ、中身は変えない', async () => {
    const dir = freshDir();
    const input = baseInput(dir);
    writeFileSync(input.stderrPath, 'KEEP-STDERR');
    const fake = fakeSpawn({ events: okEvents() });
    await expect(runCodexProcess(input, depsOf(fake))).rejects.toThrow(EXISTS_MESSAGE);
    expect(fake.calls).toHaveLength(0);
    expect(readFileSync(input.stderrPath, 'utf8')).toBe('KEEP-STDERR');
  });
});

describe('runCodexProcess: timeout', () => {
  it('timeoutMs を過ぎたらプロセスグループへ SIGTERM を送り、timedOut で解決する', async () => {
    const dir = freshDir();
    const fake = fakeSpawn({ hang: true, stderr: '途中の stderr\n' });
    const input = baseInput(dir, { timeoutMs: 30, killGraceMs: 30 });
    const result = await runCodexProcess(input, depsOf(fake));

    const pid = fake.calls[0]!.child.pid!;
    expect(fake.groupKills).toContainEqual({ pid, signal: 'SIGTERM' });
    expect(result.timedOut).toBe(true);
    expect(result.interrupted).toBe(false);
    expect(result.signal).toBe('SIGTERM');
    expect(result.exitCode).toBeNull();
    expect(result.spawnError).toBeNull();
    // 打ち切られても stderr の分はファイルに残る
    expect(readFileSync(input.stderrPath, 'utf8')).toBe('途中の stderr\n');
  });

  it('SIGTERM で終わったなら、猶予を待つ SIGKILL は送らない（結論のあとの後始末の SIGKILL が1回だけ）', async () => {
    const dir = freshDir();
    const fake = fakeSpawn({ hang: true });
    // 猶予を十分長くしておく。解決した時点で SIGKILL が見えるなら、それは猶予を待たない後始末の1回
    await runCodexProcess(baseInput(dir, { timeoutMs: 30, killGraceMs: 5000 }), depsOf(fake));
    const pid = fake.calls[0]!.child.pid!;
    expect(fake.groupKills).toEqual([
      { pid, signal: 'SIGTERM' },
      { pid, signal: 'SIGKILL' },
    ]);
    await sleep(100);
    expect(fake.groupKills).toHaveLength(2);
  });

  it('SIGTERM を無視する子には、killGraceMs 後に SIGKILL を送る', async () => {
    const dir = freshDir();
    const fake = fakeSpawn({ hang: true, ignoreSigterm: true });
    const result = await runCodexProcess(baseInput(dir, { timeoutMs: 30, killGraceMs: 30 }), depsOf(fake));

    const pid = fake.calls[0]!.child.pid!;
    // 猶予後の SIGKILL に加えて、結論のあとの後始末の SIGKILL がもう1回
    expect(fake.groupKills).toEqual([
      { pid, signal: 'SIGTERM' },
      { pid, signal: 'SIGKILL' },
      { pid, signal: 'SIGKILL' },
    ]);
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe('SIGKILL');
  });

  it('timeout 中に onHeartbeat が経過時間つきで呼ばれ、解決後は呼ばれない', async () => {
    const dir = freshDir();
    const fake = fakeSpawn({ hang: true });
    const onHeartbeat = vi.fn<(elapsedMs: number) => void>();
    await runCodexProcess(
      baseInput(dir, { timeoutMs: 60, killGraceMs: 30, heartbeatMs: 10, onHeartbeat }),
      depsOf(fake),
    );
    expect(onHeartbeat.mock.calls.length).toBeGreaterThanOrEqual(1);
    for (const [elapsedMs] of onHeartbeat.mock.calls) expect(elapsedMs).toBeGreaterThan(0);

    const countAtResolve = onHeartbeat.mock.calls.length;
    await sleep(60);
    expect(onHeartbeat.mock.calls.length).toBe(countAtResolve);
  });
});

describe('runCodexProcess: 中断（AbortSignal）', () => {
  it('実行中に abort されたらグループへ SIGTERM を送り、interrupted で解決する', async () => {
    const dir = freshDir();
    const fake = fakeSpawn({ hang: true });
    const controller = new AbortController();
    const running = runCodexProcess(
      baseInput(dir, { abortSignal: controller.signal, timeoutMs: 10_000, killGraceMs: 30 }),
      depsOf(fake),
    );
    await abortOnceSpawned(running, fake, controller);
    const result = await running;

    const pid = fake.calls[0]!.child.pid!;
    expect(fake.groupKills).toContainEqual({ pid, signal: 'SIGTERM' });
    expect(result.interrupted).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.signal).toBe('SIGTERM');
    expect(result.spawnError).toBeNull();
  });

  it('abort のあとも SIGTERM を無視する子は、killGraceMs 後に SIGKILL で止める', async () => {
    const dir = freshDir();
    const fake = fakeSpawn({ hang: true, ignoreSigterm: true });
    const controller = new AbortController();
    const running = runCodexProcess(
      baseInput(dir, { abortSignal: controller.signal, timeoutMs: 10_000, killGraceMs: 30 }),
      depsOf(fake),
    );
    await abortOnceSpawned(running, fake, controller);
    const result = await running;

    expect(fake.groupKills.map((k) => k.signal)).toEqual(['SIGTERM', 'SIGKILL', 'SIGKILL']);
    expect(result.interrupted).toBe(true);
    expect(result.signal).toBe('SIGKILL');
  });

  it('最初から aborted なら spawn せず、ファイルも作らず、interrupted で解決する', async () => {
    const dir = freshDir();
    const fake = fakeSpawn({ events: okEvents() });
    const input = baseInput(dir, { abortSignal: AbortSignal.abort() });
    const result = await runCodexProcess(input, depsOf(fake));

    expect(fake.calls).toHaveLength(0);
    expect(result.interrupted).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.spawnError).toBeNull();
    expect(existsSync(input.stdoutPath)).toBe(false);
    expect(existsSync(input.stderrPath)).toBe(false);
  });

  it('正常終了したあとに abort されても、何も kill しない', async () => {
    const dir = freshDir();
    const fake = fakeSpawn({ events: okEvents() });
    const controller = new AbortController();
    const result = await runCodexProcess(
      baseInput(dir, { abortSignal: controller.signal }),
      depsOf(fake),
    );
    expect(result.interrupted).toBe(false);
    controller.abort();
    await sleep(30);
    expect(fake.groupKills).toEqual([]);
    expect(fake.calls[0]!.child.kills).toEqual([]);
  });
});

describe('runCodexProcess: spawn の失敗', () => {
  it('spawn の error イベントで待ち続けず、spawnError つきで解決する', { timeout: 2000 }, async () => {
    const dir = freshDir();
    const fake = fakeSpawn({ spawnError: { code: 'ENOENT', message: 'spawn codex ENOENT' } });
    const result = await runCodexProcess(baseInput(dir, { timeoutMs: 60_000 }), depsOf(fake));

    expect(result.spawnError).toContain('ENOENT');
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.interrupted).toBe(false);
    // pid が無いので、プロセスグループへ何も送らない
    expect(fake.groupKills).toEqual([]);
  });
});

describe('runCodexProcess: killGroup が投げたとき', () => {
  const throwing = (attempts: Array<{ pid: number; signal: NodeJS.Signals }>): KillGroup => (pid, signal) => {
    attempts.push({ pid, signal });
    throw Object.assign(new Error(`kill ESRCH ${pid}`), { code: 'ESRCH' });
  };

  it('child.kill(signal) で代えて、それでも解決する', async () => {
    const dir = freshDir();
    const fake = fakeSpawn({ hang: true });
    const attempts: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const result = await runCodexProcess(baseInput(dir, { timeoutMs: 30, killGraceMs: 30 }), {
      spawn: fake.spawn,
      killGroup: throwing(attempts),
      now: () => Date.now(),
    });

    expect(attempts[0]).toEqual({ pid: fake.calls[0]!.child.pid, signal: 'SIGTERM' });
    expect(fake.calls[0]!.child.kills).toContain('SIGTERM');
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe('SIGTERM');
  });

  it('SIGKILL のときも child.kill(SIGKILL) で代える', async () => {
    const dir = freshDir();
    const fake = fakeSpawn({ hang: true, ignoreSigterm: true });
    const attempts: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const result = await runCodexProcess(baseInput(dir, { timeoutMs: 30, killGraceMs: 30 }), {
      spawn: fake.spawn,
      killGroup: throwing(attempts),
      now: () => Date.now(),
    });

    // 後始末の SIGKILL（結論のあと）も killGroup を試すが、終わった子への child.kill では代えない
    expect(attempts.map((a) => a.signal)).toEqual(['SIGTERM', 'SIGKILL', 'SIGKILL']);
    expect(fake.calls[0]!.child.kills).toEqual(['SIGTERM', 'SIGKILL']);
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe('SIGKILL');
  });
});

describe('runCodexProcess: close が来ないとき（孫がパイプを握ったまま子だけ終わる）', () => {
  it('正常終了（exit 0）のあと、killGraceMs だけ待ち、exit の情報で解決する（timedOut にしない）', { timeout: 3000 }, async () => {
    const dir = freshDir();
    const events = okEvents();
    const fake = fakeSpawn({ events, neverClose: true });
    // timeout は長くして、timeout に救われていないことを確かめる
    const input = baseInput(dir, { timeoutMs: 10_000, killGraceMs: 60 });
    const startedAt = Date.now();
    const result = await runCodexProcess(input, depsOf(fake));
    const waitedMs = Date.now() - startedAt;

    expect(result).toMatchObject({
      exitCode: 0,
      signal: null,
      timedOut: false,
      interrupted: false,
      spawnError: null,
    });
    // exit の直後には見切らない（パイプに残っている出力を読む猶予）。ただし猶予より先へは待たない
    expect(waitedMs).toBeGreaterThanOrEqual(40);
    expect(waitedMs).toBeLessThan(2000);
    // 見切るまでに届いた出力は、ファイルに残っている
    expect(readFileSync(input.stdoutPath, 'utf8')).toBe(`${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
    // 何も kill しない（グループにも子にも）。見切りの timer も残らない
    await sleep(100);
    expect(fake.groupKills).toEqual([]);
    expect(fake.calls[0]!.child.kills).toEqual([]);
  });

  it('timeout の時点で exit が済んでいたら、timedOut にせず、kill もせず、待つのをやめて解決する', { timeout: 3000 }, async () => {
    const dir = freshDir();
    const fake = fakeSpawn({ events: okEvents(), neverClose: true });
    // 猶予は長い。exit（数ミリ秒後）のあとに timeout（150ms）が来て、そこで待つのをやめる
    const input = baseInput(dir, { timeoutMs: 150, killGraceMs: 5000 });
    const startedAt = Date.now();
    const result = await runCodexProcess(input, depsOf(fake));

    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(result).toMatchObject({
      exitCode: 0,
      signal: null,
      timedOut: false,
      interrupted: false,
      spawnError: null,
    });
    await sleep(50);
    expect(fake.groupKills).toEqual([]);
    expect(fake.calls[0]!.child.kills).toEqual([]);
  });

  it('timeout で SIGTERM → SIGKILL を送り、exit だけ来て close が来なくても、exit の情報で見切る', { timeout: 3000 }, async () => {
    const dir = freshDir();
    const fake = fakeSpawn({ hang: true, ignoreSigterm: true, neverClose: true });
    const result = await runCodexProcess(baseInput(dir, { timeoutMs: 30, killGraceMs: 30 }), depsOf(fake));

    const pid = fake.calls[0]!.child.pid!;
    // 猶予後の SIGKILL のあと、結論のあとの後始末の SIGKILL がもう1回
    expect(fake.groupKills).toEqual([
      { pid, signal: 'SIGTERM' },
      { pid, signal: 'SIGKILL' },
      { pid, signal: 'SIGKILL' },
    ]);
    expect(result).toMatchObject({
      exitCode: null,
      signal: 'SIGKILL',
      timedOut: true,
      interrupted: false,
      spawnError: null,
    });
  });

  it('SIGTERM で exit した子の close が来なくても、その signal を返して見切る', { timeout: 3000 }, async () => {
    const dir = freshDir();
    const fake = fakeSpawn({ hang: true, neverClose: true });
    const result = await runCodexProcess(baseInput(dir, { timeoutMs: 30, killGraceMs: 30 }), depsOf(fake));

    const pid = fake.calls[0]!.child.pid!;
    expect(fake.groupKills[0]).toEqual({ pid, signal: 'SIGTERM' });
    expect(result).toMatchObject({ exitCode: null, signal: 'SIGTERM', timedOut: true, interrupted: false });
  });

  it('どの signal でも終わらない子は、SIGTERM → SIGKILL のあと killGraceMs で見切り、最後に SIGKILL をもう1回送る', { timeout: 3000 }, async () => {
    const dir = freshDir();
    const fake = fakeSpawn({ hang: true, ignoreAllSignals: true });
    const input = baseInput(dir, { timeoutMs: 30, killGraceMs: 30 });
    const result = await runCodexProcess(input, depsOf(fake));

    const pid = fake.calls[0]!.child.pid!;
    expect(fake.groupKills).toEqual([
      { pid, signal: 'SIGTERM' },
      { pid, signal: 'SIGKILL' },
      { pid, signal: 'SIGKILL' },
    ]);
    // exit も close も来ていない。最後に送った signal を返す
    expect(result).toMatchObject({
      exitCode: null,
      signal: 'SIGKILL',
      timedOut: true,
      interrupted: false,
      spawnError: null,
    });
    // 見切ったあとは、子のストリームを手放している
    expect(fake.calls[0]!.child.stdout.destroyed).toBe(true);
    expect(fake.calls[0]!.child.stderr.destroyed).toBe(true);
  });

  it('見切ったあとに子が exit しても、新しい timer を作らない（呼び出し側のプロセスを引き止めない）', { timeout: 3000 }, async () => {
    const dir = freshDir();
    const fake = fakeSpawn({ hang: true, ignoreAllSignals: true });
    await runCodexProcess(baseInput(dir, { timeoutMs: 30, killGraceMs: 30 }), depsOf(fake));

    const spy = vi.spyOn(globalThis, 'setTimeout');
    try {
      fake.calls[0]!.child.finish(null, 'SIGKILL');
      // finish は setImmediate で exit を出す。check フェーズを2回回して届かせる
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      // 猶予（30ms）の timer が作られていない。他の用途の setTimeout は数えない
      expect(spy.mock.calls.filter(([, delay]) => delay === 30)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('runCodexProcess: kill を始めたあとの後始末の SIGKILL', () => {
  it('abort で SIGTERM が効いて close まで来ても、結論のあとにグループへ SIGKILL を1回送る', async () => {
    const dir = freshDir();
    const fake = fakeSpawn({ hang: true });
    const controller = new AbortController();
    const running = runCodexProcess(
      baseInput(dir, { abortSignal: controller.signal, timeoutMs: 10_000, killGraceMs: 5000 }),
      depsOf(fake),
    );
    await abortOnceSpawned(running, fake, controller);
    const result = await running;

    const pid = fake.calls[0]!.child.pid!;
    expect(result.interrupted).toBe(true);
    // 猶予（5秒）を待たずに SIGKILL が見えるなら、それは後始末の1回
    expect(fake.groupKills).toEqual([
      { pid, signal: 'SIGTERM' },
      { pid, signal: 'SIGKILL' },
    ]);
  });

  it('後始末の SIGKILL が投げても（グループがもう無い）握りつぶし、結果を変えず、child.kill でも代えない', async () => {
    const dir = freshDir();
    const fake = fakeSpawn({ hang: true });
    const attempts: NodeJS.Signals[] = [];
    const killGroup: KillGroup = (pid, signal) => {
      attempts.push(signal);
      if (signal === 'SIGKILL') throw Object.assign(new Error(`kill ESRCH ${pid}`), { code: 'ESRCH' });
      fake.killGroup(pid, signal);
    };
    const result = await runCodexProcess(baseInput(dir, { timeoutMs: 30, killGraceMs: 5000 }), {
      spawn: fake.spawn,
      killGroup,
      now: () => Date.now(),
    });

    expect(attempts).toEqual(['SIGTERM', 'SIGKILL']);
    expect(result).toMatchObject({ timedOut: true, signal: 'SIGTERM', spawnError: null });
    // 終わった子へ child.kill を重ねない（SIGTERM は killGroup が届けた）
    expect(fake.calls[0]!.child.kills).toEqual([]);
  });

  it('kill を始めていなければ（正常終了）、後始末の SIGKILL も送らない', async () => {
    const dir = freshDir();
    const fake = fakeSpawn({ events: okEvents() });
    await runCodexProcess(baseInput(dir, { timeoutMs: 10_000, killGraceMs: 10 }), depsOf(fake));
    await sleep(50);
    expect(fake.groupKills).toEqual([]);
  });
});

describe('runCodexProcess: stdin への書き込みの失敗（EPIPE）', () => {
  it('子が異常終了（exit 1）していれば、exit code を保ったまま解決する（spawnError にしない）', async () => {
    const dir = freshDir();
    const fake = fakeSpawn({ stdinError: true, exitCode: 1, stderr: '入力を読む前に終わった\n' });
    const input = baseInput(dir);
    const result = await runCodexProcess(input, depsOf(fake));

    expect(result).toMatchObject({
      exitCode: 1,
      signal: null,
      timedOut: false,
      interrupted: false,
      spawnError: null,
    });
    expect(readFileSync(input.stderrPath, 'utf8')).toBe('入力を読む前に終わった\n');
  });

  it('子が正常終了（exit 0）なのに stdin が失敗していたら、spawnError に stdin と書く', async () => {
    const dir = freshDir();
    const fake = fakeSpawn({ stdinError: true, events: okEvents() });
    const result = await runCodexProcess(baseInput(dir), depsOf(fake));

    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.spawnError).not.toBeNull();
    expect(result.spawnError).toMatch(/stdin/);
    expect(result.spawnError).toContain('EPIPE');
  });
});

describe('shortRunner', () => {
  const env = { PATH: '/usr/bin', VELUM_TEST_ENV: '1' };

  it('command と args を spawn へ渡し、cwd / env をそのまま通す', async () => {
    const dir = freshDir();
    const fake = fakeSpawn({ events: ['codex-cli 0.153.4'] });
    const run = shortRunner('codex', { spawn: fake.spawn });
    await run(['--version'], { env, cwd: dir, timeoutMs: 2000 });

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.command).toBe('codex');
    expect(call.args).toEqual(['--version']);
    expect(call.options.cwd).toBe(dir);
    expect(call.options.env).toEqual(env);
  });

  it('stdout と stderr を文字列で集め、exit code を返す', async () => {
    const fake = fakeSpawn({ events: ['codex-cli 0.153.4'], stderr: '注意: stderr の文\n' });
    const run = shortRunner('codex', { spawn: fake.spawn });
    const result = await run(['--version'], { env, cwd: freshDir(), timeoutMs: 2000 });
    expect(result).toEqual({
      exitCode: 0,
      stdout: 'codex-cli 0.153.4\n',
      stderr: '注意: stderr の文\n',
      error: null,
    });
  });

  it('login status のように stderr にだけ出る出力も取れる', async () => {
    const fake = fakeSpawn({ stderr: `${REAL.loginChatgpt}\n` });
    const run = shortRunner('codex', { spawn: fake.spawn });
    const result = await run(['login', 'status'], { env, cwd: freshDir(), timeoutMs: 2000 });
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(`${REAL.loginChatgpt}\n`);
    expect(result.exitCode).toBe(0);
  });

  it('0 以外の exit code もそのまま返す（error にはしない）', async () => {
    const fake = fakeSpawn({ stderr: `${REAL.notLoggedIn}\n`, exitCode: 1 });
    const run = shortRunner('codex', { spawn: fake.spawn });
    const result = await run(['login', 'status'], { env, cwd: freshDir(), timeoutMs: 2000 });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(`${REAL.notLoggedIn}\n`);
    expect(result.error).toBeNull();
  });

  it('stdin を渡さなければすぐ閉じる（入力待ちで止まらない）', async () => {
    const fake = fakeSpawn({ events: ['ok'] });
    const run = shortRunner('codex', { spawn: fake.spawn });
    // 偽の子は stdin が閉じてから終わる。閉じなければ、ここで止まる
    const result = await run(['debug', 'models'], { env, cwd: freshDir(), timeoutMs: 10_000 });
    expect(result.exitCode).toBe(0);
    expect(result.error).toBeNull();
    expect(fake.calls[0]!.stdin()).toBe('');
  });

  it('stdin を渡したら UTF-8 でそのまま書いて閉じる', async () => {
    const fake = fakeSpawn({ events: ['ok'] });
    const run = shortRunner('codex', { spawn: fake.spawn });
    const stdin = '入力 "引用"\n二行目';
    const result = await run(['exec', '-'], { env, cwd: freshDir(), timeoutMs: 10_000, stdin });
    expect(result.exitCode).toBe(0);
    expect(fake.calls[0]!.stdin()).toBe(stdin);
  });

  it('マルチバイト文字の途中で chunk が切れても、文字化けさせずに集める', async () => {
    const stdoutText = '{"models":[{"slug":"日本語"}]}\n';
    const stderrText = 'エラー: 日本語の文\n';
    const spawn = splitMultibyteSpawn(stdoutText, stderrText, [3, 8, 15, 22]);
    const run = shortRunner('codex', { spawn });
    const result = await run(['debug', 'models'], { env, cwd: freshDir(), timeoutMs: 10_000 });
    expect(result.stdout).toBe(stdoutText);
    expect(result.stderr).toBe(stderrText);
  });

  it('timeout したら SIGKILL で止め、error に timeout と書く', async () => {
    const fake = fakeSpawn({ hang: true });
    const run = shortRunner('codex', { spawn: fake.spawn });
    const result = await run(['--version'], { env, cwd: freshDir(), timeoutMs: 30 });

    expect(result.error).not.toBeNull();
    expect(result.error).toMatch(/timeout|timed out|タイムアウト|時間/i);
    expect(fake.calls[0]!.child.kills).toContain('SIGKILL');
  });

  it('spawn の失敗は待ち続けず、error に説明を書く', { timeout: 2000 }, async () => {
    const fake = fakeSpawn({ spawnError: { code: 'ENOENT', message: 'spawn codex ENOENT' } });
    const run = shortRunner('codex', { spawn: fake.spawn });
    // timeoutMs を長くして、timeout に救われていないことを確かめる
    const result = await run(['--version'], { env, cwd: freshDir(), timeoutMs: 60_000 });

    expect(result.error).not.toBeNull();
    expect(result.error).toContain('ENOENT');
    expect(result.exitCode).toBeNull();
  });

  it('正常終了したあとは timeout のタイマーが残らない', async () => {
    const fake = fakeSpawn({ events: ['ok'] });
    const run = shortRunner('codex', { spawn: fake.spawn });
    await run(['--version'], { env, cwd: freshDir(), timeoutMs: 40 });
    await sleep(100);
    expect(fake.calls[0]!.child.kills).toEqual([]);
  });
});

describe('shortRunner: プロセスグループと中断', () => {
  const env = { PATH: '/usr/bin', VELUM_TEST_ENV: '1' };

  it('killGroup を渡すと detached で起こす。渡さなければ detached ではない', async () => {
    const withGroup = fakeSpawn({ events: ['ok'] });
    await shortRunner('codex', { spawn: withGroup.spawn, killGroup: withGroup.killGroup })(['--version'], {
      env,
      cwd: freshDir(),
      timeoutMs: 2000,
    });
    expect(withGroup.calls[0]!.options.detached).toBe(true);

    const without = fakeSpawn({ events: ['ok'] });
    await shortRunner('codex', { spawn: without.spawn })(['--version'], { env, cwd: freshDir(), timeoutMs: 2000 });
    expect(without.calls[0]!.options.detached).toBe(false);
  });

  it('killGroup があれば、timeout はグループへ SIGKILL を送り、child.kill は使わない', async () => {
    const fake = fakeSpawn({ hang: true });
    const run = shortRunner('codex', { spawn: fake.spawn, killGroup: fake.killGroup });
    const result = await run(['--version'], { env, cwd: freshDir(), timeoutMs: 30 });

    const pid = fake.calls[0]!.child.pid!;
    expect(fake.groupKills).toEqual([{ pid, signal: 'SIGKILL' }]);
    expect(fake.calls[0]!.child.kills).toEqual([]);
    expect(result.exitCode).toBeNull();
    expect(result.error).toMatch(/timeout/i);
  });

  it('killGroup が投げたら（グループがもう無い）、child.kill(SIGKILL) で代える', async () => {
    const fake = fakeSpawn({ hang: true });
    const attempts: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const killGroup: KillGroup = (pid, signal) => {
      attempts.push({ pid, signal });
      throw Object.assign(new Error(`kill ESRCH ${pid}`), { code: 'ESRCH' });
    };
    const run = shortRunner('codex', { spawn: fake.spawn, killGroup });
    const result = await run(['--version'], { env, cwd: freshDir(), timeoutMs: 30 });

    expect(attempts).toEqual([{ pid: fake.calls[0]!.child.pid!, signal: 'SIGKILL' }]);
    expect(fake.calls[0]!.child.kills).toEqual(['SIGKILL']);
    expect(result.error).toMatch(/timeout/i);
  });

  it('abort されたら、グループへ SIGKILL を送り、error に interrupted と書いて待たずに解決する', async () => {
    const fake = fakeSpawn({ hang: true });
    const run = shortRunner('codex', { spawn: fake.spawn, killGroup: fake.killGroup });
    const controller = new AbortController();
    const running = run(['--version'], { env, cwd: freshDir(), timeoutMs: 10_000, abortSignal: controller.signal });
    expect(fake.calls).toHaveLength(1);
    controller.abort();
    const result = await running;

    const pid = fake.calls[0]!.child.pid!;
    expect(fake.groupKills).toEqual([{ pid, signal: 'SIGKILL' }]);
    expect(fake.calls[0]!.child.kills).toEqual([]);
    expect(result.exitCode).toBeNull();
    expect(result.error).toContain('interrupted');
  });

  it('killGroup が無いときの abort は child.kill(SIGKILL) で止める', async () => {
    const fake = fakeSpawn({ hang: true });
    const run = shortRunner('codex', { spawn: fake.spawn });
    const controller = new AbortController();
    const running = run(['--version'], { env, cwd: freshDir(), timeoutMs: 10_000, abortSignal: controller.signal });
    controller.abort();
    const result = await running;

    expect(fake.calls[0]!.child.kills).toEqual(['SIGKILL']);
    expect(fake.groupKills).toEqual([]);
    expect(result.error).toContain('interrupted');
  });

  it('最初から aborted なら spawn せず、interrupted で解決する', async () => {
    const fake = fakeSpawn({ events: ['ok'] });
    const run = shortRunner('codex', { spawn: fake.spawn, killGroup: fake.killGroup });
    const result = await run(['--version'], {
      env,
      cwd: freshDir(),
      timeoutMs: 2000,
      abortSignal: AbortSignal.abort(),
    });

    expect(fake.calls).toHaveLength(0);
    expect(result.exitCode).toBeNull();
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(result.error).toContain('interrupted');
  });

  it('正常に終わったあとの abort では、何も kill しない', async () => {
    const fake = fakeSpawn({ events: ['ok'] });
    const run = shortRunner('codex', { spawn: fake.spawn, killGroup: fake.killGroup });
    const controller = new AbortController();
    const result = await run(['--version'], { env, cwd: freshDir(), timeoutMs: 2000, abortSignal: controller.signal });
    expect(result.error).toBeNull();

    controller.abort();
    await sleep(30);
    expect(fake.groupKills).toEqual([]);
    expect(fake.calls[0]!.child.kills).toEqual([]);
  });

  it('終わらない子でも、解決したら stdin / stdout / stderr を手放し、unref する（子孫が event loop を引き止めない）', async () => {
    const fake = fakeSpawn({ hang: true, ignoreAllSignals: true });
    const unref = vi.fn<() => void>();
    const spawn: SpawnLike = (command, args, options) =>
      Object.assign(fake.spawn(command, args, options), { unref });
    const run = shortRunner('codex', { spawn, killGroup: fake.killGroup });
    const result = await run(['--version'], { env, cwd: freshDir(), timeoutMs: 30 });

    const child = fake.calls[0]!.child;
    expect(result.error).toMatch(/timeout/i);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(child.stdin.destroyed).toBe(true);
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it('正常に終わったときも unref する。unref を持たない子（ChildLike）でも投げない', async () => {
    const fake = fakeSpawn({ events: ['ok'] });
    const unref = vi.fn<() => void>();
    const withUnref: SpawnLike = (command, args, options) =>
      Object.assign(fake.spawn(command, args, options), { unref });
    const result = await shortRunner('codex', { spawn: withUnref, killGroup: fake.killGroup })(['--version'], {
      env,
      cwd: freshDir(),
      timeoutMs: 2000,
    });
    expect(result).toEqual({ exitCode: 0, stdout: 'ok\n', stderr: '', error: null });
    expect(unref).toHaveBeenCalledTimes(1);

    const plain = fakeSpawn({ events: ['ok'] });
    await expect(
      shortRunner('codex', { spawn: plain.spawn })(['--version'], { env, cwd: freshDir(), timeoutMs: 2000 }),
    ).resolves.toMatchObject({ exitCode: 0, error: null });
  });
});

describe('realProcessDeps', () => {
  it('spawn / killGroup / now の関数を持つ（呼び出しはしない）', () => {
    const deps = realProcessDeps();
    expect(typeof deps.spawn).toBe('function');
    expect(typeof deps.killGroup).toBe('function');
    expect(typeof deps.now).toBe('function');
    const first = deps.now();
    expect(Number.isFinite(first)).toBe(true);
    expect(deps.now()).toBeGreaterThanOrEqual(first);
  });
});
