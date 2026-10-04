import { killActiveProcessGroups } from './codex-process.js';

/**
 * story:doctor / story:draft / story:revise の 3 本の CLI に共通する「落ち方の安全」。
 *
 * 長い Codex の実行は、親（この CLI）が終わっても子が残りうる。Codex は detached（別のプロセスグループ）で
 * 起こしているので、親の死に道連れにならない。残すと、人が気づかないまま推論（と利用枠）を使い続ける。
 * そこで次の 3 つを、スクリプトごとに複製せず 1 か所に置く:
 *
 * 1. signal: SIGINT（Ctrl-C）・SIGTERM（kill）・SIGHUP（端末を閉じた・ssh が切れた）の最初の 1 回で
 *    AbortController を中断する。中断を受けた run が Codex をグループごと止め、interrupted として記録する。
 *    2 回目以降は何もしない（子の終了を確かめてから終わるので、待ってもらう）。SIGHUP を受ける listener を
 *    入れると Node の既定（即終了）が無くなる。だから SIGHUP も、SIGINT と同じ手順で止める
 * 2. stdout / stderr の 'error': EPIPE（`| head` などで読み手が先に閉じた）と EIO（hangup 後の端末への書き込み）は
 *    無視する。listener が無いと、'error' は未捕捉の例外になって親が落ち、Codex を残す。
 *    ほかの error（ENOSPC など）は握りつぶさず投げ直す（そのまま未捕捉の例外になる）
 * 3. exit: 親が終わるとき、まだ走っている Codex のプロセスグループへ SIGKILL を送る最後の安全網。
 *    'exit' の中は同期の処理しかできない（killActiveProcessGroups は同期）。通常の終了では、
 *    走っている子が無いので何も起きない
 *
 * deps.log（run.ts が進行を出す）は console.log を通る。console は書き込みの失敗を黙って捨てるので、
 * 閉じた pipe に書いても投げない。ここで足す stdout の listener は、console を通らない書き込みの保険。
 */

/** installCliSafety が使う process の部分。テストは EventEmitter で代える（本物の process には listener を足さない） */
export type CliProcess = {
  on(event: 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'exit', listener: () => void): unknown;
  readonly stdout: { on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown };
  readonly stderr: { on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown };
};

export type CliSafetyDeps = {
  /** exit で呼ぶ。既定は codex-process.ts の killActiveProcessGroups（同期・ESRCH は黙って次へ） */
  killActiveProcessGroups?: (signal: NodeJS.Signals) => void;
  /** 利用者への表示。既定は console.error。投げても中断は必ず行う */
  log?: (message: string) => void;
};

const CLI_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/** 読み手の消えた出力に書いたときの errno。これだけは無視する */
const IGNORED_STREAM_ERRORS: ReadonlySet<string> = new Set(['EPIPE', 'EIO']);

export function installCliSafety(
  controller: AbortController,
  proc: CliProcess = process,
  deps: CliSafetyDeps = {},
): void {
  const killGroups = deps.killActiveProcessGroups ?? killActiveProcessGroups;
  const log = deps.log ?? ((message: string): void => console.error(message));

  /** 表示は補助。端末が消えたあとで失敗しても、中断（Codex を止めること）を妨げない */
  const say = (message: string): void => {
    try {
      log(message);
    } catch {
      // 表示できなくても、止める処理は続ける
    }
  };

  for (const signal of CLI_SIGNALS) {
    proc.on(signal, () => {
      if (controller.signal.aborted) {
        say(`\n${signal}: すでに止めています。Codex の終了を確かめるまでお待ちください。`);
        return;
      }
      say(`\n${signal} を受け取りました。Codex を止めています（終了を確かめるまでお待ちください）…`);
      controller.abort();
    });
  }

  for (const stream of [proc.stdout, proc.stderr]) {
    stream.on('error', (error) => {
      if (error.code !== undefined && IGNORED_STREAM_ERRORS.has(error.code)) return;
      throw error;
    });
  }

  proc.on('exit', () => {
    killGroups('SIGKILL');
  });
}
