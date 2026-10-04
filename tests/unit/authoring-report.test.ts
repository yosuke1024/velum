import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { DoctorReport } from '../../src/story/authoring/doctor.js';
import { formatDoctor, formatDryRun, formatRunOutcome } from '../../src/story/authoring/report.js';
import type { DryRunSummary, RunOutcome } from '../../src/story/authoring/run.js';
import { RUN_RECORD_SCHEMA, type RunRecord } from '../../src/story/authoring/runs.js';

/**
 * scripts が表示する文面の組み立て（report.ts）。表示は純粋に組み立てて、scripts は出力と終了コードだけを扱う。
 * 値は固定の文字列で、実データの人物・原稿には依存しない。
 */

const tmp = mkdtempSync(join(tmpdir(), 'velum-authoring-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const HASH = 'a'.repeat(64);

const SUMMARY: DryRunSummary = {
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
  inputs: [
    { role: 'instructions', source: 'authoring/prompts/i.txt', name: null, file: '', sha256: HASH, bytes: 12, chars: 6 },
    { role: 'brief', source: 'authoring/briefs/b.md', name: 'b.md', file: '', sha256: HASH, bytes: 345, chars: 120 },
  ],
  prompt: { framing: 'velum-astra-draft-v1', sha256: HASH, bytes: 400, chars: 150 },
  codexArgs: ['exec', '--model', 'gpt-6-astra', '--cd', '<WORKDIR>', '-'],
  envRemoved: ['OPENAI_API_KEY'],
  promptText: null,
};

function record(over: Partial<RunRecord> = {}): RunRecord {
  return {
    schema: RUN_RECORD_SCHEMA,
    run_id: '20261003T135407Z-riko-draft-000001',
    purpose: 'draft',
    stage: 'generated',
    parent_run_id: null,
    character_id: 'riko',
    status: 'succeeded',
    started_at: '2026-10-03T13:54:07.000Z',
    finished_at: '2026-10-03T13:55:07.000Z',
    duration_ms: 60000,
    cli: { command: 'codex', version: '0.153.4', min_version: '0.153.0' },
    requested: {
      provider: 'codex-cli',
      model: 'gpt-6-astra',
      reasoning_effort: 'high',
      verbosity: null,
      authentication: 'chatgpt',
      credentials_store: 'keyring',
      fallback: 'none',
      retries: 0,
      timeout_ms: 1800000,
    },
    effective: { model: null, model_source: 'not_reported' },
    auth_check: { method: 'chatgpt', checked_with: 'codex login status' },
    inputs: [],
    prompt: { file: 'prompt.txt', framing: 'velum-astra-draft-v1', sha256: HASH, bytes: 1, chars: 1 },
    codex_args: [],
    env_removed: [],
    process: { exit_code: 0, signal: null, timed_out: false, interrupted: false, spawn_error: null },
    events: null,
    output: {
      raw_file: 'manuscript.raw.md',
      raw_sha256: HASH,
      raw_bytes: 100,
      body_file: 'manuscript.body.txt',
      body_sha256: HASH,
      body_chars: 1500,
      title: '試作の題',
      title_rule: 'markdown_heading',
    },
    diff: null,
    failure: null,
    warnings: [],
    ...over,
  };
}

const text = (lines: string[]): string => lines.join('\n');

describe('formatDryRun', () => {
  it('モデル・認証・fallback なし・再試行 0・呼び出し 1 回・timeout を示す', () => {
    const out = text(formatDryRun(SUMMARY));

    expect(out).toContain('gpt-6-astra');
    expect(out).toContain('high');
    expect(out).toContain('chatgpt');
    expect(out).toContain('keyring');
    expect(out).toMatch(/fallback[^\n]*none|fallback[^\n]*なし/);
    expect(out).toMatch(/再試行[^\n]*0/);
    expect(out).toMatch(/呼び出し[^\n]*1/);
    expect(out).toMatch(/30\s*分/);
  });

  it('verbosity が null なら「未指定（CLI の既定）」、指定があればその値', () => {
    expect(text(formatDryRun(SUMMARY))).toContain('未指定（CLI の既定）');
    const medium = text(formatDryRun({ ...SUMMARY, verbosity: 'medium' }));
    expect(medium).toContain('medium');
    expect(medium).not.toContain('未指定（CLI の既定）');
  });

  it('入力ごとに role・source・name・bytes・chars・sha256 を示す', () => {
    const out = text(formatDryRun(SUMMARY));

    for (const expected of ['instructions', 'authoring/prompts/i.txt', 'brief', 'authoring/briefs/b.md', 'b.md', '345', '120', HASH]) {
      expect(out).toContain(expected);
    }
  });

  it('依頼文の枠・hash・大きさ、外す環境変数の名前、codex の引数（1 行に 1 つ）を示す', () => {
    const lines = formatDryRun(SUMMARY);
    const out = text(lines);

    expect(out).toContain('velum-astra-draft-v1');
    expect(out).toContain('400');
    expect(out).toContain('150');
    expect(out).toContain('OPENAI_API_KEY');
    for (const arg of SUMMARY.codexArgs) expect(lines).toContain(`  ${arg}`);
  });

  it('外す変数が無ければ「なし」と書く', () => {
    expect(text(formatDryRun({ ...SUMMARY, envRemoved: [] }))).toContain('なし');
  });

  it('promptText があるときだけ、区切りのあとに全文を出す', () => {
    expect(text(formatDryRun(SUMMARY))).not.toContain('依頼文の全文');
    const lines = formatDryRun({ ...SUMMARY, promptText: '全文の1行目\n全文の2行目\n' });
    const out = text(lines);
    expect(out).toContain('依頼文の全文');
    expect(out.indexOf('全文の1行目')).toBeGreaterThan(out.indexOf('依頼文の全文'));
    expect(out).toContain('全文の2行目');
  });
});

describe('formatRunOutcome', () => {
  it('dry-run は要約を出し、成功扱い（終了コード 0）', () => {
    const printed = formatRunOutcome({ status: 'dry-run', summary: SUMMARY });

    expect(printed.ok).toBe(true);
    expect(text(printed.lines)).toContain('gpt-6-astra');
  });

  it('成功: run ID・ディレクトリ・ファイル・題・本文の文字数・usage・実効モデルを示す', () => {
    const runDir = join(tmp, 'run-ok');
    const rec = record({
      events: {
        file: 'events.jsonl',
        lines: 5,
        parse_errors: 0,
        thread_id: 't',
        turn_completed: true,
        item_types: {},
        unexpected_items: [],
        agent_messages: 1,
        usage: { input_tokens: 4100, output_tokens: 6200 },
      },
    });
    const printed = formatRunOutcome({ status: 'succeeded', runId: rec.run_id, runDir, record: rec });
    const out = text(printed.lines);

    expect(printed.ok).toBe(true);
    for (const expected of [rec.run_id, runDir, 'manuscript.raw.md', 'manuscript.body.txt', '試作の題', '1500', 'input_tokens', '4100', 'output_tokens', '6200']) {
      expect(out).toContain(expected);
    }
    expect(out).toContain('not_reported（CLI から確認できない）');
  });

  it('実効モデルを CLI が報告していれば、その値と出どころを示す', () => {
    const rec = record({ effective: { model: 'gpt-6-astra-2026-09', model_source: 'turn.completed.model' } });
    const out = text(formatRunOutcome({ status: 'succeeded', runId: rec.run_id, runDir: tmp, record: rec }).lines);

    expect(out).toContain('gpt-6-astra-2026-09');
    expect(out).toContain('turn.completed.model');
    expect(out).not.toContain('not_reported');
  });

  it('題を判定できなかった run は、その旨を示す', () => {
    const rec = record({
      output: { ...record().output!, title: null, title_rule: null },
    });
    const out = text(formatRunOutcome({ status: 'succeeded', runId: rec.run_id, runDir: tmp, record: rec }).lines);

    expect(out).toContain('題を判定できなかった');
  });

  it('warnings があれば 1 件ずつ示す。無ければ「なし」', () => {
    const quiet = text(formatRunOutcome({ status: 'succeeded', runId: 'x', runDir: tmp, record: record() }).lines);
    expect(quiet).toMatch(/warnings[^\n]*なし/);

    const rec = record({ warnings: ['本文が短い', '題を判定できない'] });
    const loud = text(formatRunOutcome({ status: 'succeeded', runId: rec.run_id, runDir: tmp, record: rec }).lines);
    expect(loud).toContain('本文が短い');
    expect(loud).toContain('題を判定できない');
  });

  it('改稿の成功は、差分のファイルを示す', () => {
    const rec = record({
      purpose: 'revise',
      diff: { file: 'revision.diff', parent_body_sha256: HASH, changed: true },
    });
    const out = text(formatRunOutcome({ status: 'succeeded', runId: rec.run_id, runDir: tmp, record: rec }).lines);

    expect(out).toContain('revision.diff');
  });

  it('probe の成功は、本文の欄を出さず、最終応答のファイルを示す', () => {
    const rec = record({
      purpose: 'probe',
      output: {
        raw_file: 'probe.raw.txt',
        raw_sha256: HASH,
        raw_bytes: 12,
        body_file: null,
        body_sha256: null,
        body_chars: null,
        title: null,
        title_rule: null,
      },
    });
    const out = text(formatRunOutcome({ status: 'succeeded', runId: rec.run_id, runDir: tmp, record: rec }).lines);

    expect(out).toContain('probe.raw.txt');
    expect(out).not.toContain('題を判定できなかった');
  });

  it('blocked は問題を 1 件ずつ示し、終了コード 1 相当（ok: false）', () => {
    const printed = formatRunOutcome({ status: 'blocked', problems: ['未ログインです', 'ロックがあります'] });

    expect(printed.ok).toBe(false);
    const out = text(printed.lines);
    expect(out).toContain('未ログインです');
    expect(out).toContain('ロックがあります');
    expect(out).toContain('run のディレクトリは作っていません');
  });

  it('失敗: 種類・理由・人がすること・残った途中の出力のパスを示し、ok は false', () => {
    const runDir = join(tmp, 'run-failed');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'manuscript.raw.md.partial'), '途中');
    const rec = record({
      status: 'failed',
      output: null,
      failure: { kind: 'usage_limit', message: '利用上限に達しました。' },
    });
    const outcome: RunOutcome = { status: 'failed', runId: rec.run_id, runDir, record: rec };
    const printed = formatRunOutcome(outcome);
    const out = text(printed.lines);

    expect(printed.ok).toBe(false);
    expect(out).toContain('usage_limit');
    expect(out).toContain('利用上限に達しました。');
    expect(out).toContain('待');
    expect(out).toContain(join(runDir, 'manuscript.raw.md.partial'));
    expect(out).toContain('完成稿ではない');
    expect(out.toLowerCase()).not.toContain('gemini');
  });

  it('失敗: 途中の出力の warning（run の中の相対名）は、パスの行と重ねて出さない', () => {
    const runDir = join(tmp, 'run-failed-warning-relative');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'manuscript.raw.md.partial'), '途中');
    const rec = record({
      status: 'failed',
      output: null,
      failure: { kind: 'nonzero_exit', message: '正常に終了しませんでした。' },
      warnings: ['失敗した run の出力が残っている（完成稿ではない）: manuscript.raw.md.partial', '別の注意'],
    });
    const printed = formatRunOutcome({ status: 'failed', runId: rec.run_id, runDir, record: rec });
    const out = text(printed.lines);

    // 絶対パスの行は 1 回だけ。相対名の warning を重ねて出さない
    expect(printed.lines.filter((line) => line.includes('manuscript.raw.md.partial'))).toEqual([
      `  途中の出力（完成稿ではない）: ${join(runDir, 'manuscript.raw.md.partial')}`,
    ]);
    // ほかの warning は残し、件数は重複を除いた数
    expect(out).toContain('別の注意');
    expect(out).toContain('warnings: 1 件');
  });

  it('失敗: 途中の出力の warning だけなら、重ねずに warnings は「なし」', () => {
    const runDir = join(tmp, 'run-failed-warning-only');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'manuscript.raw.md.partial'), '途中');
    const rec = record({
      status: 'failed',
      output: null,
      failure: { kind: 'nonzero_exit', message: '正常に終了しませんでした。' },
      warnings: ['失敗した run の出力が残っている（完成稿ではない）: manuscript.raw.md.partial'],
    });
    const out = text(formatRunOutcome({ status: 'failed', runId: rec.run_id, runDir, record: rec }).lines);

    expect(out).toMatch(/warnings[^\n]*なし/);
  });

  it('失敗: ファイルが無くなっていれば、途中の出力の warning は消さずに残す（手がかりを失わない）', () => {
    const runDir = join(tmp, 'run-failed-warning-orphan');
    mkdirSync(runDir, { recursive: true });
    const rec = record({
      status: 'failed',
      output: null,
      failure: { kind: 'nonzero_exit', message: '正常に終了しませんでした。' },
      warnings: ['失敗した run の出力が残っている（完成稿ではない）: manuscript.raw.md.partial'],
    });
    const out = text(formatRunOutcome({ status: 'failed', runId: rec.run_id, runDir, record: rec }).lines);

    expect(out).toContain('warnings: 1 件');
    expect(out).toContain('manuscript.raw.md.partial');
  });

  it('失敗: 絶対パスで書かれた古い記録の warning も、重ねて出さない', () => {
    const runDir = join(tmp, 'run-failed-warning-legacy');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'manuscript.raw.md.partial'), '途中');
    const rec = record({
      status: 'failed',
      output: null,
      failure: { kind: 'nonzero_exit', message: '正常に終了しませんでした。' },
      warnings: [`失敗した run の出力が残っている（完成稿ではない）: ${join(runDir, 'manuscript.raw.md.partial')}`],
    });
    const printed = formatRunOutcome({ status: 'failed', runId: rec.run_id, runDir, record: rec });

    expect(printed.lines.filter((line) => line.includes('manuscript.raw.md.partial'))).toHaveLength(1);
    expect(text(printed.lines)).toMatch(/warnings[^\n]*なし/);
  });

  it('途中の出力が無い失敗は、パスの行を出さない', () => {
    const runDir = join(tmp, 'run-failed-nopartial');
    mkdirSync(runDir, { recursive: true });
    const rec = record({ status: 'failed', output: null, failure: { kind: 'spawn_error', message: '起動できません' } });
    const out = text(formatRunOutcome({ status: 'failed', runId: rec.run_id, runDir, record: rec }).lines);

    expect(out).toContain('spawn_error');
    expect(out).not.toContain('.partial');
  });
});

describe('formatDoctor', () => {
  const report: DoctorReport = {
    ok: true,
    cliVersion: '0.153.4',
    checks: [
      { name: 'config', status: 'ok', detail: '設定は読めた' },
      { name: 'isolation', status: 'warn', detail: '既知の残留がある' },
      { name: 'auth', status: 'fail', detail: '未ログイン' },
    ],
  };

  it('検査ごとに状態・名前・detail を示し、CLI の版を示す', () => {
    const out = text(formatDoctor({ report, probe: null }, { probe: false }).lines);

    for (const expected of ['config', '設定は読めた', 'isolation', '既知の残留がある', 'auth', '未ログイン', '0.153.4']) {
      expect(out).toContain(expected);
    }
  });

  it('fail が無く probe も要求していなければ ok（warn は止めない）', () => {
    const passing: DoctorReport = { ...report, checks: report.checks.filter((check) => check.status !== 'fail') };

    expect(formatDoctor({ report: passing, probe: null }, { probe: false }).ok).toBe(true);
  });

  it('fail があれば ok は false。--probe を要求していたら、呼ばなかったことを示す', () => {
    const printed = formatDoctor({ report: { ...report, ok: false }, probe: null }, { probe: true });

    expect(printed.ok).toBe(false);
    expect(text(printed.lines)).toContain('probe は呼んでいません');
  });

  it('probe が成功すれば ok。失敗すれば probe の失敗を示して ok は false', () => {
    const passing: DoctorReport = { ...report, checks: report.checks.filter((check) => check.status !== 'fail') };
    const good = record({
      purpose: 'probe',
      output: {
        raw_file: 'probe.raw.txt',
        raw_sha256: HASH,
        raw_bytes: 12,
        body_file: null,
        body_sha256: null,
        body_chars: null,
        title: null,
        title_rule: null,
      },
    });
    const ok = formatDoctor(
      { report: passing, probe: { status: 'succeeded', runId: good.run_id, runDir: tmp, record: good } },
      { probe: true },
    );
    expect(ok.ok).toBe(true);
    expect(text(ok.lines)).toContain(good.run_id);

    const bad = record({ status: 'failed', output: null, failure: { kind: 'auth', message: '認証が通りません' } });
    const ng = formatDoctor(
      { report: passing, probe: { status: 'failed', runId: bad.run_id, runDir: tmp, record: bad } },
      { probe: true },
    );
    expect(ng.ok).toBe(false);
    expect(text(ng.lines)).toContain('codex login');
  });

  it('probe がロックや確認で止まった（blocked）なら、ok は false', () => {
    const passing: DoctorReport = { ...report, checks: report.checks.filter((check) => check.status !== 'fail') };
    const printed = formatDoctor(
      { report: passing, probe: { status: 'blocked', problems: ['別の制作コマンドが実行中です'] } },
      { probe: true },
    );

    expect(printed.ok).toBe(false);
    expect(text(printed.lines)).toContain('別の制作コマンドが実行中です');
  });
});
