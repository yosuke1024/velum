import { spawn as nodeSpawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import { closeSync, createWriteStream, openSync, unlinkSync, type WriteStream } from 'node:fs';
import type { Readable, Writable } from 'node:stream';

/**
 * Codex CLI の子プロセスを走らせる（長い1回の執筆と、短い確認コマンドの2種類）。
 *
 * spawn は依存注入する。テストは偽の子プロセス（PassThrough の stdin/stdout/stderr を持つ
 * EventEmitter）で、JSONL・stderr・exit code・途中の打ち切りを再現する。本物の codex は呼ばない。
 *
 * 長い実行の規律:
 * - stdin へ UTF-8 の依頼文を書いて閉じる。shell は介在しない（spawn に引数の配列を渡す）
 * - stdout は events.jsonl、stderr は stderr.log へ**ストリームで**書く。どちらも既存なら書かない（wx）
 * - 子はプロセスグループの先頭として起こし（detached）、打ち切るときはグループごと止める。
 *   npm の codex は node のラッパーが本体を子として起こすので、ラッパーだけを止めると本体が残りうる
 * - timeout（既定は設定の30分）を過ぎたら SIGTERM、killGraceMs 待っても終わらなければ SIGKILL。
 *   kill を始めたときは、結論が出たあとにもう1回だけグループへ SIGKILL を送る
 *   （SIGTERM を無視した孫が、先頭の 'close' で猶予の timer が消えたせいで残らないように）
 * - 子が 'exit' したのに 'close' が来ない（孫がパイプを握ったまま）ときは、exit から killGraceMs で見切り、
 *   exit の様子で結論する。孫のせいで正常終了が timeout まで待たされることはない
 * - abortSignal（親の Ctrl-C）でも同じ手順で止め、interrupted として返す。
 *   最初から aborted なら spawn せずに interrupted で返す（ファイルも作らない）
 * - killGroup が投げたら（グループがもう無い ESRCH など）、child.kill(signal) で代える
 * - 再試行はしない
 */

export interface ChildLike extends EventEmitter {
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly pid?: number | undefined;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type SpawnOptionsLike = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: ['pipe', 'pipe', 'pipe'];
  detached: boolean;
};

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsLike,
) => ChildLike;

/** プロセスグループへシグナルを送る（本物は process.kill(-pid, signal)）。失敗は握りつぶさず投げてよい。 */
export type KillGroup = (pid: number, signal: NodeJS.Signals) => void;

export type ProcessDeps = {
  spawn: SpawnLike;
  killGroup: KillGroup;
  now: () => number;
};

export type RunCodexInput = {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** stdin へ書く UTF-8 の文 */
  stdin: string;
  /** stdout の書き先（既存なら投げる） */
  stdoutPath: string;
  /** stderr の書き先（既存なら投げる） */
  stderrPath: string;
  timeoutMs: number;
  /** SIGTERM から SIGKILL までの猶予。既定 10000 */
  killGraceMs?: number;
  /** 経過の通知（既定 60000 ミリ秒ごと）。表示のためだけで、判定には使わない */
  onHeartbeat?: (elapsedMs: number) => void;
  heartbeatMs?: number;
  abortSignal?: AbortSignal;
};

export type RunCodexResult = {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  interrupted: boolean;
  /** spawn の失敗（'error' イベント。ENOENT など）の説明。無ければ null */
  spawnError: string | null;
  durationMs: number;
};

// ── 内部の道具 ─────────────────────────────────────────────

const DEFAULT_KILL_GRACE_MS = 10_000;
const DEFAULT_HEARTBEAT_MS = 60_000;

/** setTimeout の上限。これを超えると Node は 1 ミリ秒に丸めて即座に発火してしまうので、手前で止める。 */
const MAX_TIMER_MS = 2_147_483_647;
const clampTimerMs = (ms: number): number => Math.min(Math.max(ms, 0), MAX_TIMER_MS);

/** エラーの説明。errno の code（ENOENT など）が文面に無ければ前に添える。 */
function errorText(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== undefined && !error.message.includes(code) ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}

/**
 * stdout / stderr の書き先を、spawn する**前に**排他的（wx）に開く。既存なら EEXIST のまま投げる。
 * stderr の側で失敗したときは、こちらが wx で作ったばかりの stdout の空ファイルを片付ける
 * （残すと、同じ run ディレクトリでの次の実行を塞ぐ）。
 */
function openOutputFiles(stdoutPath: string, stderrPath: string): { stdout: number; stderr: number } {
  const stdout = openSync(stdoutPath, 'wx');
  try {
    return { stdout, stderr: openSync(stderrPath, 'wx') };
  } catch (error) {
    try {
      closeSync(stdout);
      unlinkSync(stdoutPath);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `${stderrPath} を開けず、作成済みの ${stdoutPath} の片付けにも失敗した: ${errorText(error)}`,
      );
    }
    throw error;
  }
}

/** ファイルへのストリーム書き込み。close は、書き込みが済んでファイルが閉じたあとに解決する。 */
type Sink = {
  stream: WriteStream;
  closed: Promise<void>;
  /** 書き込みに失敗していたら、その説明（原因は cause） */
  failure: () => Error | null;
};

function createSink(path: string, fd: number): Sink {
  // fd を渡すので、path は開き直しには使われない（エラー文のためだけ）
  const stream = createWriteStream(path, { fd });
  let failure: Error | null = null;
  stream.on('error', (error: Error) => {
    failure ??= new Error(`${path} への書き込みに失敗した: ${errorText(error)}`, { cause: error });
  });
  const closed = new Promise<void>((resolve) => {
    stream.once('close', () => resolve());
  });
  return { stream, closed, failure: () => failure };
}

/**
 * stdin へ UTF-8 で書いて閉じる（text が無ければ閉じるだけ）。
 * 子が stdin を読み切る前に終わると、stdin は 'error'（EPIPE）を出す。listener が無いと
 * プロセスごと落ちるので受けて記録する。その原因は子の exit code / stderr に現れる。
 * 返す関数は、記録した失敗（無ければ null）。
 */
function feedStdin(stdin: Writable, text: string | undefined): () => Error | null {
  let failure: Error | null = null;
  stdin.on('error', (error: Error) => {
    failure ??= error;
  });
  if (text === undefined) stdin.end();
  else stdin.end(Buffer.from(text, 'utf8'));
  return () => failure;
}

/** 子が正常に終わったのに stdin への書き込みが失敗していた、という矛盾の説明（依頼文が欠けた可能性） */
const stdinFailureText = (error: Error): string =>
  `stdin への書き込みに失敗した（依頼文を最後まで渡せていない可能性がある）: ${errorText(error)}`;

type Conclusion =
  | { kind: 'closed'; code: number | null; signal: NodeJS.Signals | null }
  | { kind: 'spawn-error'; message: string }
  | { kind: 'gave-up' };

/**
 * 長い1回の実行。子が終わり、stdout / stderr のファイルが閉じてから解決する。
 * 解決するのは結果であって、失敗の判定（exit code など）は呼び出し側（codex-events の classifyFailure）。
 * stdoutPath / stderrPath が既にあれば、spawn する前に投げる。
 */
export async function runCodexProcess(
  input: RunCodexInput,
  deps: ProcessDeps,
): Promise<RunCodexResult> {
  const startedAt = deps.now();
  const elapsedMs = (): number => deps.now() - startedAt;
  const graceMs = input.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const abortSignal = input.abortSignal;

  // 最初から中断されているなら、spawn もファイルの作成もしない
  if (abortSignal?.aborted) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      interrupted: true,
      spawnError: null,
      durationMs: elapsedMs(),
    };
  }

  // 以降 spawn と listener の登録まで await を挟まない（abort がその間に来て取りこぼされないように）
  const fds = openOutputFiles(input.stdoutPath, input.stderrPath);
  const stdoutSink = createSink(input.stdoutPath, fds.stdout);
  const stderrSink = createSink(input.stderrPath, fds.stderr);
  const sinks = [stdoutSink, stderrSink];

  /** ファイルが閉じるのを待つ。書き込みに失敗していたら、記録が欠けているので投げる */
  const closeSinks = async (): Promise<void> => {
    await Promise.all(sinks.map((sink) => sink.closed));
    const failure = stdoutSink.failure() ?? stderrSink.failure();
    if (failure !== null) throw failure;
  };

  let child: ChildLike;
  try {
    child = deps.spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
  } catch (error) {
    // spawn が同期的に投げた（引数の不正など）。ファイルを閉じ、spawn の失敗として記録して返す
    for (const sink of sinks) sink.stream.end();
    await closeSinks();
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      interrupted: false,
      spawnError: errorText(error),
      durationMs: elapsedMs(),
    };
  }

  // 実行中に変わる状態。closure から書き換えるので、let ではなくオブジェクトにまとめる
  const state = {
    timedOut: false,
    interrupted: false,
    killStarted: false,
    lastSignalSent: null as NodeJS.Signals | null,
    /** 'exit' で知った終了の様子（'close' が来ないまま見切るときの代わり） */
    exit: null as { code: number | null; signal: NodeJS.Signals | null } | null,
    /** 起こせた子の側の異常（kill の失敗、stdio が開けない、読み取りエラー）。最初の1件 */
    runtimeError: null as string | null,
    heartbeatFailure: null as { error: unknown } | null,
  };
  const timers: {
    timeout?: NodeJS.Timeout;
    escalate?: NodeJS.Timeout;
    giveUp?: NodeJS.Timeout;
    /** 'exit' のあと 'close' を待つ猶予 */
    exitGrace?: NodeJS.Timeout;
    heartbeat?: NodeJS.Timeout;
  } = {};
  /** 結論が出て cleanup した後は true。遅れて届く 'exit' が新しい timer を作らないための印 */
  let settled = false;

  let conclude!: (conclusion: Conclusion) => void;
  const concluded = new Promise<Conclusion>((resolve) => {
    // Promise は最初の解決だけが効く。'close' と 'error' と見切りが重なっても二重にならない
    conclude = resolve;
  });

  const noteRuntimeError = (message: string): void => {
    state.runtimeError ??= message;
  };

  /**
   * シグナルをプロセスグループへ送る。グループへ送れなかったとき（ESRCH など、グループがもう無い）は、
   * 子そのものへ送って代える。代えた先でも届かなければ、子はもう居ないか、見切りの timer が引き取る。
   */
  const sendSignal = (signal: NodeJS.Signals): void => {
    state.lastSignalSent = signal;
    if (child.pid !== undefined) {
      try {
        deps.killGroup(child.pid, signal);
        return;
      } catch {
        // フォールバックへ
      }
    }
    child.kill(signal);
  };

  /** SIGTERM → killGraceMs 後に SIGKILL → さらに killGraceMs 後に見切る。2回目以降は何もしない */
  const beginKill = (): void => {
    if (state.killStarted) return;
    state.killStarted = true;
    sendSignal('SIGTERM');
    timers.escalate = setTimeout(() => {
      sendSignal('SIGKILL');
      timers.giveUp = setTimeout(() => conclude({ kind: 'gave-up' }), clampTimerMs(graceMs));
    }, clampTimerMs(graceMs));
  };

  child.on('error', (error: Error) => {
    if (child.pid === undefined) {
      // 起こせなかった（ENOENT など）。'close' は来ないので待たずに終える
      conclude({ kind: 'spawn-error', message: errorText(error) });
    } else {
      noteRuntimeError(`子プロセスのエラー: ${errorText(error)}`);
    }
  });
  child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    state.exit = { code, signal };
    // 'close' は stdio が全部閉じてから。孫がパイプを握っていると、子が終わっても来ない。
    // 出力を読み切る猶予として killGraceMs だけ待ち、それでも来なければ exit の様子で見切る
    if (!settled && timers.exitGrace === undefined) {
      timers.exitGrace = setTimeout(() => conclude({ kind: 'gave-up' }), clampTimerMs(graceMs));
    }
  });
  // 'close' は終了に加えて stdio が閉じたあと。出力を読み切ってから解決するための合図
  child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
    conclude({ kind: 'closed', code, signal });
  });

  // stdout / stderr はストリームでファイルへ。pipe が背圧を扱い、子の出力の終わりでファイルも閉じる
  const pipes: Array<{ source: Readable | null; sink: Sink; label: string }> = [
    { source: child.stdout, sink: stdoutSink, label: 'stdout' },
    { source: child.stderr, sink: stderrSink, label: 'stderr' },
  ];
  for (const { source, sink, label } of pipes) {
    if (source === null) {
      noteRuntimeError(`子プロセスの ${label} が開かれていない`);
      sink.stream.end();
      beginKill();
      continue;
    }
    source.on('error', (error: Error) => {
      noteRuntimeError(`${label} の読み取りに失敗した: ${errorText(error)}`);
    });
    source.pipe(sink.stream);
    sink.stream.on('error', () => {
      // 書き込み先が壊れた。記録できない実行を続けても仕方ないので止める。
      // 子が詰まらないよう、残りは読み捨てる（失敗そのものは closeSinks が投げる）
      source.unpipe(sink.stream);
      source.resume();
      beginKill();
    });
  }

  let stdinFailure: () => Error | null = () => null;
  if (child.stdin === null) {
    noteRuntimeError('子プロセスの stdin が開かれていない');
    beginKill();
  } else {
    stdinFailure = feedStdin(child.stdin, input.stdin);
  }

  const onAbort = (): void => {
    state.interrupted = true;
    beginKill();
  };
  abortSignal?.addEventListener('abort', onAbort, { once: true });

  timers.timeout = setTimeout(() => {
    if (state.exit !== null) {
      // 子は timeout より前に終わっている（'close' だけが孫のせいで来ない）。
      // timeout で打ち切ったわけではないので timedOut にせず、kill もせず、待つのをやめる
      conclude({ kind: 'gave-up' });
      return;
    }
    state.timedOut = true;
    beginKill();
  }, clampTimerMs(input.timeoutMs));

  const onHeartbeat = input.onHeartbeat;
  if (onHeartbeat !== undefined) {
    timers.heartbeat = setInterval(() => {
      try {
        onHeartbeat(elapsedMs());
      } catch (error) {
        // 表示のための通知が投げても、実行は止めない。以降の通知をやめ、終わってから投げる
        state.heartbeatFailure = { error };
        clearInterval(timers.heartbeat);
      }
    }, clampTimerMs(input.heartbeatMs ?? DEFAULT_HEARTBEAT_MS));
  }

  /** timer と abort の listener を外す。終わった子へ後から signal を送らないために、結論が出たらすぐ呼ぶ */
  const cleanup = (): void => {
    settled = true;
    clearTimeout(timers.timeout);
    clearTimeout(timers.escalate);
    clearTimeout(timers.giveUp);
    clearTimeout(timers.exitGrace);
    clearInterval(timers.heartbeat);
    abortSignal?.removeEventListener('abort', onAbort);
  };

  let conclusion: Conclusion;
  try {
    conclusion = await concluded;
  } finally {
    cleanup();
  }

  // 結論の時点の exit の様子。以降に届く 'exit' では結果を変えない
  const exitInfo = state.exit;

  if (state.killStarted && child.pid !== undefined) {
    // kill を始めた実行は、結論が出たら最後にもう1回、グループへ SIGKILL を送る。
    // 'close' で猶予の timer を消したあとに、SIGTERM を無視した孫がグループに残っていても止める。
    // もうグループが無ければ（ESRCH）それでよい。失敗は握りつぶす（best-effort。結果は変えない）
    try {
      deps.killGroup(child.pid, 'SIGKILL');
    } catch {
      // グループはもう無い
    }
  }

  if (conclusion.kind !== 'closed') {
    // 'close' が来ない終わり方（spawn の失敗、または孫がパイプを握ったまま）。これ以上は待たない。
    // ファイルを閉じ、子の側のストリームも手放す
    for (const { source, sink } of pipes) {
      source?.unpipe(sink.stream);
      source?.destroy();
      sink.stream.end();
    }
  }
  await closeSinks();
  if (state.heartbeatFailure !== null) throw state.heartbeatFailure.error;

  const base = { timedOut: state.timedOut, interrupted: state.interrupted, durationMs: elapsedMs() };
  if (conclusion.kind === 'spawn-error') {
    return { ...base, exitCode: null, signal: null, spawnError: conclusion.message };
  }

  // 'close' が来なかったときは exit の様子で答える。exit も無ければ（どの signal でも終わらない）、最後に送った signal
  const exitCode = conclusion.kind === 'closed' ? conclusion.code : (exitInfo?.code ?? null);
  const signal =
    conclusion.kind === 'closed'
      ? conclusion.signal
      : exitInfo !== null
        ? exitInfo.signal
        : state.lastSignalSent;
  const stdinProblem = stdinFailure();
  const cleanExit = exitCode === 0 && signal === null;
  const spawnError =
    state.runtimeError ?? (cleanExit && stdinProblem !== null ? stdinFailureText(stdinProblem) : null);
  return { ...base, exitCode, signal, spawnError };
}

export type ShortResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** spawn の失敗や timeout の説明。無ければ null */
  error: string | null;
};

export type ShortRunOptions = {
  env: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs: number;
  /** 渡せば stdin へ書いて閉じる。渡さなければ stdin はすぐ閉じる（入力待ちで止まらない） */
  stdin?: string;
  /**
   * 親の中断（Ctrl-C など）。aborted になったら子を止め（killGroup があればグループごと）、
   * error に 'interrupted' を含めて解決する。最初から aborted なら spawn しない。
   */
  abortSignal?: AbortSignal;
};

/** 短い確認コマンド（--version / login status / debug models など）。stdout / stderr はメモリへ集める。 */
export type ShortRun = (args: readonly string[], options: ShortRunOptions) => Promise<ShortResult>;

/**
 * 子との縁を切る。解決したあとに、終わらない子や、パイプを握ったままの子孫が
 * 呼び出し側の event loop を引き止めないよう、stdio を手放してハンドルを unref する。
 */
function releaseChild(child: ChildLike): void {
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
  // ChildLike は unref を要求しない（本物の ChildProcess は持つ）
  const unref: unknown = 'unref' in child ? child.unref : undefined;
  if (typeof unref === 'function') unref.call(child);
}

/**
 * 本物の spawn を使う ShortRun。timeout / abort で SIGKILL して error に書く。
 * killGroup を渡すと detached（プロセスグループの先頭）で起こし、止めるときはグループごと（失敗したら child.kill で代える）。
 * 渡さなければ detached ではなく child.kill だけ。解決したあとは子の stdio を手放し、unref する。
 */
export function shortRunner(
  command: string,
  deps: Pick<ProcessDeps, 'spawn'> & Partial<Pick<ProcessDeps, 'killGroup'>>,
): ShortRun {
  return (args, options) =>
    new Promise<ShortResult>((resolve) => {
      const abortSignal = options.abortSignal;
      // 最初から中断されているなら、spawn しない
      if (abortSignal?.aborted) {
        resolve({ exitCode: null, stdout: '', stderr: '', error: 'interrupted: 開始前に中断されていたので起動しなかった' });
        return;
      }

      let timer: NodeJS.Timeout | undefined;
      let child: ChildLike | undefined;
      const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
      let settled = false;

      /** SIGKILL で止める。killGroup があればグループごと。届かなければ（ESRCH など）子そのものへ */
      const stopChild = (): void => {
        if (child === undefined) return;
        if (deps.killGroup !== undefined && child.pid !== undefined) {
          try {
            deps.killGroup(child.pid, 'SIGKILL');
            return;
          } catch {
            // フォールバックへ
          }
        }
        child.kill('SIGKILL');
      };

      const onAbort = (): void => {
        stopChild();
        settle(null, 'interrupted: 親の中断を受けたので SIGKILL した');
      };

      /** 最初の1回だけ効く。集めた分を文字列にして解決する */
      const settle = (exitCode: number | null, error: string | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        abortSignal?.removeEventListener('abort', onAbort);
        resolve({
          exitCode,
          // Buffer のまま結合してから復号する。chunk の境界がマルチバイト文字の途中でも壊れない
          stdout: Buffer.concat(chunks.stdout).toString('utf8'),
          stderr: Buffer.concat(chunks.stderr).toString('utf8'),
          error,
        });
        if (child !== undefined) releaseChild(child);
      };

      try {
        child = deps.spawn(command, args, {
          cwd: options.cwd ?? process.cwd(),
          env: options.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: deps.killGroup !== undefined,
        });
      } catch (error) {
        settle(null, errorText(error));
        return;
      }
      const spawned = child;
      // spawn から listener の登録まで await を挟まない（abort の取りこぼしを防ぐ）
      abortSignal?.addEventListener('abort', onAbort, { once: true });

      let runtimeError: string | null = null;
      for (const label of ['stdout', 'stderr'] as const) {
        const stream = spawned[label];
        if (stream === null) {
          runtimeError ??= `子プロセスの ${label} が開かれていない`;
          continue;
        }
        stream.on('data', (chunk: Buffer | string) => {
          chunks[label].push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
        });
        stream.on('error', (error: Error) => {
          runtimeError ??= `${label} の読み取りに失敗した: ${errorText(error)}`;
        });
      }

      let stdinFailure: () => Error | null = () => null;
      if (spawned.stdin === null) runtimeError ??= '子プロセスの stdin が開かれていない';
      else stdinFailure = feedStdin(spawned.stdin, options.stdin);

      spawned.on('error', (error: Error) => {
        if (spawned.pid === undefined) {
          // 起こせなかった（ENOENT など）。'close' は来ないので待たない
          settle(null, errorText(error));
        } else {
          runtimeError ??= `子プロセスのエラー: ${errorText(error)}`;
        }
      });
      spawned.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
        const stdinProblem = stdinFailure();
        const error =
          runtimeError ??
          (signal !== null ? `シグナル ${signal} で終了した` : null) ??
          (code === 0 && stdinProblem !== null ? stdinFailureText(stdinProblem) : null);
        settle(code, error);
      });

      timer = setTimeout(() => {
        // 短い確認が終わらない。SIGKILL して、集まった分だけで解決する（close は待たない）
        stopChild();
        settle(null, `timeout: ${options.timeoutMs} ミリ秒以内に終わらなかったので SIGKILL した`);
      }, clampTimerMs(options.timeoutMs));
    });
}

/** realProcessDeps の spawn が detached で起こした、いま走っている子の pid（= プロセスグループ id） */
const activeGroups = new Set<number>();

/** 本物の依存（node:child_process の spawn と process.kill(-pid)）。 */
export function realProcessDeps(): ProcessDeps {
  return {
    spawn: (command, args, options) => {
      const child = nodeSpawn(command, args, options);
      const pid = child.pid;
      if (options.detached && pid !== undefined) {
        // 終わるまで覚えておく（killActiveProcessGroups の対象）。起こせなかった子は pid が無い
        activeGroups.add(pid);
        const forget = (): void => {
          activeGroups.delete(pid);
        };
        child.once('exit', forget);
        child.once('close', forget);
      }
      return child;
    },
    // 負の pid はプロセスグループ全体を指す（POSIX。detached で起こした子はグループの先頭）。
    // 失敗（ESRCH など）は握りつぶさず投げる。呼び出し側が child.kill で代える
    killGroup: (pid, signal) => {
      process.kill(-pid, signal);
    },
    now: Date.now,
  };
}

/**
 * いま走っている（detached で起こした）子のプロセスグループへ、同期でシグナルを送る。
 * 親が終わるとき（process.on('exit')）の安全網: detached の子は親の死で道連れにならないので、
 * 例外や SIGHUP で親が落ちても Codex を残さない。グループがもう無ければ（ESRCH）黙って次へ。
 * realProcessDeps の spawn が detached で起こした子だけを数える（'close' / 'exit' で外す）。
 */
export function killActiveProcessGroups(signal: NodeJS.Signals): void {
  // 走査中に 'exit' で集合が変わっても壊れないよう、写しを回す
  for (const pid of [...activeGroups]) {
    try {
      process.kill(-pid, signal);
    } catch {
      // グループがもう無い（ESRCH）など。exit handler の中で投げないよう、残りへ進む
    }
  }
}
