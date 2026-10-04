import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DoctorCheck, DoctorReport } from './doctor.js';
import { failureAdvice, type DryRunSummary, type RunOutcome } from './run.js';
import type { RunRecord } from './runs.js';

/**
 * scripts（story:doctor / story:draft / story:revise）が表示する文面。
 *
 * 文面は行の配列として組み立て、出力と終了コードは scripts が扱う（ここは console も process も触らない）。
 * ok: false は終了コード 1 に当たる（止まった・失敗した・検査が通らなかった）。
 * 値は run の記録（run.json）と dry-run の要約から取る。API キーなど環境変数の値は、ここへ来る前に
 * 落ちていて（名前だけが渡る）、表示することがない。
 */

export type Printable = { lines: string[]; ok: boolean };

const PURPOSE_LABEL: Record<DryRunSummary['purpose'], string> = {
  draft: 'story:draft',
  revise: 'story:revise',
  probe: 'doctor --probe',
};

/** 分。整数でなければ小数 1 桁（テスト用のミリ秒の上書きでも読める形に） */
const minutesOf = (ms: number): string => {
  const minutes = ms / 60_000;
  return Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1);
};

/** dry-run の要約。Codex を呼ばず、何も書かないことを先頭で示す。 */
export function formatDryRun(summary: DryRunSummary): string[] {
  const lines = [
    `── dry-run（${PURPOSE_LABEL[summary.purpose]}）: Codex を呼びません。ファイルも作りません ──`,
    `  モデル: ${summary.model}`,
    `  effort: ${summary.effort}`,
    `  verbosity: ${summary.verbosity ?? '未指定（CLI の既定）'}`,
    `  認証: ChatGPT（${summary.authentication}）`,
    `  認証情報の保存先: ${summary.credentialsStore}`,
    `  fallback: なし（${summary.fallback}）`,
    `  自動再試行: ${summary.retries} 回`,
    `  推論の呼び出し: ${summary.calls} 回`,
    `  timeout: ${minutesOf(summary.timeoutMs)} 分`,
    '入力:',
  ];
  for (const input of summary.inputs) {
    lines.push(`  - ${input.role}: ${input.source}`);
    lines.push(
      `      名前: ${input.name ?? '（なし）'} / ${input.bytes} bytes / ${input.chars} 字 / sha256 ${input.sha256}`,
    );
  }
  lines.push(
    `依頼文（stdin）: 枠 ${summary.prompt.framing} / ${summary.prompt.bytes} bytes / ${summary.prompt.chars} 字 / sha256 ${summary.prompt.sha256}`,
    `子の環境から外す変数（名前だけ。値は出さない）: ${summary.envRemoved.length > 0 ? summary.envRemoved.join(', ') : 'なし'}`,
    'codex の引数（<RUN_DIR> / <WORKDIR> は実行のたびに作るパス）:',
    ...summary.codexArgs.map((arg) => `  ${arg}`),
  );
  if (summary.promptText !== null) {
    lines.push(
      '── 依頼文の全文（stdin に渡す内容） ──',
      ...summary.promptText.replace(/\n$/, '').split('\n'),
      '── ここまで ──',
    );
  }
  return lines;
}

const usageText = (usage: Record<string, number> | null): string =>
  usage === null
    ? '（イベントに無い）'
    : Object.entries(usage)
        .map(([key, value]) => `${key} ${value}`)
        .join(' / ');

const warningLines = (warnings: readonly string[]): string[] =>
  warnings.length === 0 ? ['  warnings: なし'] : [`  warnings: ${warnings.length} 件`, ...warnings.map((w) => `    - ${w}`)];

function succeededLines(runId: string, runDir: string, record: RunRecord): string[] {
  const { output } = record;
  const files = [output?.raw_file, output?.body_file, record.diff?.file, 'run.json', 'events.jsonl', 'stderr.log'];
  const lines = [`✓ 成功: ${runId}`, `  run: ${runDir}`, `  ファイル: ${files.filter((f): f is string => typeof f === 'string').join(', ')}`];

  if (output !== null && output.body_file !== null) {
    lines.push(
      output.title === null
        ? '  題: 題を判定できなかった（本文は1行目から残してある。確認すること）'
        : `  題: ${output.title}（規則: ${output.title_rule ?? '不明'}）`,
      `  本文: ${output.body_chars ?? 0} 字`,
    );
  } else if (output !== null) {
    lines.push(`  最終応答: ${output.raw_file}（${output.raw_bytes} bytes）`);
  }
  lines.push(`  usage: ${usageText(record.events?.usage ?? null)}`);
  lines.push(
    record.effective.model === null
      ? '  実効モデル: not_reported（CLI から確認できない）'
      : `  実効モデル: ${record.effective.model}（出どころ: ${record.effective.model_source}）`,
  );
  lines.push(...warningLines(record.warnings));
  if (record.purpose !== 'probe') {
    lines.push(`  次: 原稿を読み、直すなら npm run story:revise -- --run ${runId} --feedback <feedback.md>`);
  }
  return lines;
}

/** run のディレクトリに残った、失敗した run の出力（.partial）のファイル名。完成稿ではない。 */
function partialFiles(runDir: string): string[] {
  try {
    return readdirSync(runDir)
      .filter((name) => name.endsWith('.partial'))
      .sort();
  } catch (error) {
    // run のディレクトリが無いなら、残った出力も無い。権限などほかの失敗は握り潰さない
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

function failedLines(runId: string, runDir: string, record: RunRecord): string[] {
  const failure = record.failure;
  const kind = failure?.kind ?? 'unknown';
  const partials = partialFiles(runDir);
  const lines = [
    `✗ 失敗: ${kind}（run ${runId}）`,
    `  run: ${runDir}`,
    `  理由: ${failure?.message ?? '（記録なし）'}`,
    `  対処: ${failureAdvice(kind)}`,
  ];
  // 画面には、run のディレクトリを付けた絶対パスで出す（run.json の warnings には絶対パスを残さない）
  for (const name of partials) lines.push(`  途中の出力（完成稿ではない）: ${join(runDir, name)}`);
  // 途中の出力の warning は、run の中の相対名（古い記録では絶対パス）で、上の行と同じファイルを指す。重ねて出さない。
  // ファイル名を含むかどうかで見るので、相対名でも絶対パスでも落とせる。ファイルが無くなっていれば残す
  lines.push(...warningLines(record.warnings.filter((w) => !partials.some((name) => w.includes(name)))));
  return lines;
}

/** draft / revise / probe の結果。dry-run は成功扱い（ok: true）、止まった・失敗は ok: false。 */
export function formatRunOutcome(outcome: RunOutcome): Printable {
  switch (outcome.status) {
    case 'dry-run':
      return { lines: formatDryRun(outcome.summary), ok: true };
    case 'blocked':
      return {
        lines: [
          '✗ 実行できません（run のディレクトリは作っていません）:',
          ...outcome.problems.map((problem) => `  - ${problem}`),
        ],
        ok: false,
      };
    case 'succeeded':
      return { lines: succeededLines(outcome.runId, outcome.runDir, outcome.record), ok: true };
    case 'failed':
      return { lines: failedLines(outcome.runId, outcome.runDir, outcome.record), ok: false };
  }
}

const CHECK_MARK: Record<DoctorCheck['status'], string> = { ok: '✓', warn: '!', fail: '✗' };

/** story:doctor の結果。--probe を要求したのに呼ばなかったときは、その理由（検査が通らなかった）を示す。 */
export function formatDoctor(
  result: { report: DoctorReport; probe: RunOutcome | null },
  options: { probe: boolean },
): Printable {
  const { report, probe } = result;
  const width = Math.max(...report.checks.map((check) => check.name.length));
  const failures = report.checks.filter((check) => check.status === 'fail').length;
  const lines = [
    options.probe
      ? 'story:doctor（--probe あり: 検査が通れば、Astra を 1 回だけ実際に呼びます）'
      : 'story:doctor（推論は呼びません）',
    ...report.checks.map((check) => `  ${CHECK_MARK[check.status]} ${check.name.padEnd(width)}  ${check.detail}`),
    `CLI の版: ${report.cliVersion ?? '読めなかった'}`,
    report.ok ? '検査: 通りました（! は警告で、止めません）' : `検査: 通らないものがあります（✗ ${failures} 件）`,
  ];

  let ok = report.ok;
  if (probe !== null) {
    const printed = formatRunOutcome(probe);
    lines.push('probe:', ...printed.lines.map((line) => `  ${line}`));
    ok = ok && printed.ok;
  } else if (options.probe) {
    lines.push('probe は呼んでいません（検査が通らなかったため。直してからもう一度）');
  }
  return { lines, ok };
}
