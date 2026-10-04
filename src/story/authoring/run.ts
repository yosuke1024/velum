import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ROOT } from '../../lib/paths.js';
import { secretLeaksIn } from '../../lib/secrets.js';
import type { CharacterId } from '../../schemas/world.js';
import { codexExecArgs, redactArgs, sanitizedEnv, tomlString } from './codex-command.js';
import {
  FAILURE_KINDS,
  classifyFailure,
  summarizeEvents,
  type CodexEventSummary,
  type FailureKind,
} from './codex-events.js';
import {
  realProcessDeps,
  runCodexProcess,
  shortRunner,
  type ProcessDeps,
  type ShortRun,
} from './codex-process.js';
import { EFFORT_PATTERN, type WriterConfig, type WriterVerbosity } from './config.js';
import { unifiedDiff } from './diff.js';
import { splitManuscript } from './manuscript.js';
import { preflight } from './preflight.js';
import {
  DRAFT_FRAMING,
  PROBE_FRAMING,
  PROBE_INSTRUCTIONS,
  PROBE_PROMPT,
  REVISE_FRAMING,
  draftPrompt,
  revisePrompt,
} from './prompt.js';
import {
  RUN_RECORD_SCHEMA,
  RunLockError,
  acquireRunLock,
  createRunDir,
  findRunDir,
  moveNoClobber,
  newRunId,
  readRunRecord,
  runsRoot as runsRootOf,
  writeFileNoClobber,
  writeRunRecord,
  type RunInput,
  type RunPurpose,
  type RunRecord,
} from './runs.js';

/**
 * 制作の run を1回実行する（story:draft / story:revise / doctor --probe の本体）。
 *
 * 1回の run = 新しい `codex exec` 1回。resume も再試行も別プロバイダも無い。流れ:
 *
 *   入力を読む（UTF-8・空でない・NUL なし）→ 依頼文を組む（prompt.ts）
 *   → 作者用の秘密の一覧を読めるか確かめる（draft / revise のみ。読めなければ、利用枠を使う前に止める）
 *   → dry-run ならここで要約を返して終わり（codex を一切起動しない・何も書かない）
 *   → preflight（版・ChatGPT 認証・カタログ。推論しない。中断されていたら blocked）
 *   → 作業ディレクトリを作って検査 → ロック（.story-runs/.lock）
 *   → run のディレクトリを作り、入力の写し・prompt.txt・run.json（running）を置く
 *   → Git の外の空の作業ディレクトリで codex exec（stdin に prompt、-o は manuscript.raw.md.partial）
 *   → イベントを読み、失敗を分類（codex-events.ts）
 *   → 成功なら manuscript.body.txt を書く（改行の正規化と題の分離だけ。manuscript.ts）。revise は親の本文との
 *     revision.diff も書く。そのあとで .partial を manuscript.raw.md へ移す（上書きしない）。
 *     raw が現れるのは、本文と差分が揃ったあとだけ（本文や差分を書けなかった run に、raw は残らない）
 *   → run.json を最終の状態で書き、ロックを外す
 *
 * 失敗した run の出力は .partial のまま残し、manuscript.raw.md にしない（成功や公開可能として扱わない）。
 * 制作コマンドは characters/ の manifest や本文に触れない。公開もしない。
 *
 * 親の run（revise）のファイルは読むだけで、決して書き換えない。親の raw の hash が記録と違えば止まる。
 *
 * 入力の誤り（ファイルが無い・空・UTF-8 でない・NUL を含む・添付の枠と衝突する、revise の親が無い・
 * 成功していない・raw の hash が記録と違う）は Error を投げる。どれも run のディレクトリを作る前、
 * ロックを取る前に判る。作者用の秘密の一覧（人物の YAML）を読めないときも、入力の誤りとして投げる
 * （draft / revise のみ。deps.secretLeaks ?? secretLeaksIn を空文字で 1 回呼んで確かめる）。
 * preflight とロックで止まったとき、preflight のあとに中断されていたときは、投げずに { status: 'blocked' } を返す。
 * 作業ディレクトリが root の中にあれば、spawn せずに投げる（ロックと run のディレクトリを作る前に確かめる）。
 *
 * 細部の決まり:
 * - dry-run は preflight も走らせない（codex を一切起動しない。ShortRun も呼ばない）
 * - inputs の name: brief は添付の名前（元のファイル名、revise は親の記録の name）、manuscript は
 *   'manuscript.md'、instructions / request / feedback は null。chars はコードポイント数、bytes は UTF-8 のバイト数
 * - manuscript.body.txt の中身は `body + '\n'`。output.body_sha256 はこのファイルのバイト列の hash、
 *   output.body_chars は Manuscript.bodyChars（末尾の改行を含まない）
 * - 失敗した run の record.output は null。.partial が残っていれば warnings にそのファイル名（run の中の相対名）を書く
 *   （完成稿ではない）
 * - run.json の warnings と failure.message に、絶対パスを残さない。run の中のファイルは相対名で書き、
 *   ほかは <RUN_DIR> / <WORKDIR> / <ROOT> / <RUNS_ROOT> / <TMPDIR> に置き換える（Codex の stderr や error イベントの
 *   文面に混じったパスも。置き換えは失敗の分類より先に行う。パスの中の語で誤分類しない）
 * - revise は成功すれば revision.diff を必ず書く（本文が同じなら空のファイルで、diff.changed は false）
 * - 何も問題の無い run の warnings は空（実効モデルが未報告なことは effective に書き、warnings には入れない）
 * - 作業ディレクトリに Codex が何か残していたら warnings に書く（「作業ディレクトリ」という語を含める）
 */

export type AuthoringDeps = {
  /** リポジトリ root（入力の source をここからの相対で記録する） */
  root: string;
  /** .story-runs の場所 */
  runsRoot: string;
  config: WriterConfig;
  /** 親の環境。子へは sanitizedEnv を通した複製を渡す。これ自体は変えない */
  env: NodeJS.ProcessEnv;
  shortRun: ShortRun;
  process: ProcessDeps;
  now: () => Date;
  /** 6桁の16進 */
  random: () => string;
  /** Git リポジトリの外に、空の作業ディレクトリを作って絶対パスを返す */
  makeWorkdir: () => string;
  removeWorkdir: (dir: string) => void;
  log: (line: string) => void;
  pid: number;
  abortSignal?: AbortSignal;
  heartbeatMs?: number;
  killGraceMs?: number;
  /** テスト用: timeout を分ではなくミリ秒で上書きする（記録の requested.timeout_ms もこの値になる） */
  timeoutMsOverride?: number;
  /**
   * 秘密の断片の照合（既定は secretLeaksIn）。テストで差し替える（本物の依存 realAuthoringDeps は設定しない）。
   * draft / revise は、利用枠を使う前に、これを空文字で 1 回呼んで、一覧を読めることを確かめる。
   */
  secretLeaks?: (text: string) => Array<{ owner: string }>;
};

export type CommonRunOptions = {
  /** 既定は writer.yaml の instructions */
  instructionsPath?: string;
  /** 既定は writer.yaml の reasoning_effort */
  effort?: string;
  /** 既定は writer.yaml の verbosity。null は渡さない */
  verbosity?: WriterVerbosity | null;
  /** 既定は writer.yaml の timeout_minutes */
  timeoutMinutes?: number;
  dryRun: boolean;
  /** dry-run のとき、組み立てた依頼文の全文も表示する */
  printPrompt: boolean;
};

export type DraftOptions = CommonRunOptions & {
  characterId: CharacterId;
  briefPath: string;
  requestPath: string;
};

/**
 * 改稿。brief と執筆用指示は、**既定で親の run の写し**を使う（条件を親と揃える。
 * CommonRunOptions.instructionsPath の既定はここでは writer.yaml ではなく親の instructions.txt）。
 */
export type ReviseOptions = CommonRunOptions & {
  runId: string;
  feedbackPath: string;
  /** 既定は親の run の brief の写し（添付の名前も親の記録の name） */
  briefPath?: string;
};

/** dry-run の要約。実際の run と同じものから組み立て、何も書かずに返す。 */
export type DryRunSummary = {
  purpose: 'draft' | 'revise' | 'probe';
  model: string;
  effort: string;
  verbosity: string | null;
  authentication: 'chatgpt';
  credentialsStore: string;
  fallback: 'none';
  retries: 0;
  /** この run が起こす推論の呼び出しの数（常に 1） */
  calls: 1;
  timeoutMs: number;
  /** file は空文字（まだ写していない） */
  inputs: RunInput[];
  prompt: { framing: string; sha256: string; bytes: number; chars: number };
  /** <RUN_DIR> / <WORKDIR> の置き換え済み */
  codexArgs: string[];
  envRemoved: string[];
  /** printPrompt のときだけ */
  promptText: string | null;
};

export type RunOutcome =
  | { status: 'dry-run'; summary: DryRunSummary }
  /** preflight やロックで止まった。run のディレクトリは作っていない */
  | { status: 'blocked'; problems: string[] }
  | { status: 'succeeded'; runId: string; runDir: string; record: RunRecord }
  | { status: 'failed'; runId: string; runDir: string; record: RunRecord };


// ── 実装 ───────────────────────────────────────────────────
//
// 3つの入口（draft / revise / probe）は、入力を読んで RunPlan を組むところまでが違い、
// あとは同じ経路（dry-run の要約 または startRun）を通る。経路を分けない理由: draft と probe で
// 隔離・記録・後始末の規律がずれると、片方だけ別モデルや別の環境で動く入口になりうる。

/** run の中の写しの名前 */
const INSTRUCTIONS_FILE = 'instructions.txt';
const BRIEF_FILE = 'brief.md';
const REQUEST_FILE = 'request.txt';
const PARENT_MANUSCRIPT_FILE = 'manuscript.parent.md';
const FEEDBACK_FILE = 'feedback.md';
const PROMPT_FILE = 'prompt.txt';
const EVENTS_FILE = 'events.jsonl';
const STDERR_FILE = 'stderr.log';
const MANUSCRIPT_RAW_FILE = 'manuscript.raw.md';
const PROBE_RAW_FILE = 'probe.raw.txt';
const BODY_FILE = 'manuscript.body.txt';
const DIFF_FILE = 'revision.diff';
/** -o の書き先は「<最終の名前>.partial」。成功したときだけ最終の名前へ移す */
const PARTIAL_SUFFIX = '.partial';

/** 改稿の元の原稿として添付するときの名前（親の run のファイル名は Astra に見せない） */
const MANUSCRIPT_ATTACHMENT_NAME = 'manuscript.md';
const PROBE_SOURCE = 'builtin:probe';
const PROBE_SUBJECT = 'astra';

/** writer.yaml のスキーマ（config.ts）・args.ts と同じ範囲 */
const TIMEOUT_MINUTES = { min: 1, max: 240 } as const;
/** dry-run の要約と記録の codex_args に出す、実際のパスの代わりの印 */
const RUN_DIR_PLACEHOLDER = '<RUN_DIR>';
const WORKDIR_PLACEHOLDER = '<WORKDIR>';
/** warnings に並べる、作業ディレクトリに残ったファイル名の上限 */
const LEFTOVERS_SHOWN = 5;

/** 実行に渡す入力 1 件。bytes は元のファイルのバイト列（写しはこれをそのまま書く）。 */
type PlannedInput = {
  role: RunInput['role'];
  source: string;
  name: string | null;
  /** run の中の写しの名前 */
  file: string;
  bytes: Uint8Array;
  /** bytes を UTF-8 として読んだ文字列（依頼文の組み立てに使う） */
  text: string;
};

/** 改稿の元になる、検証済みの親の run */
type ParentRun = {
  runId: string;
  dir: string;
  record: RunRecord;
  characterId: string;
  /** 親の最終応答のファイル名（run:<id>/<ファイル> として出どころに残す） */
  rawFile: string;
  /** 親の manuscript.raw.md（hash を記録と照合済み） */
  manuscript: Uint8Array;
  manuscriptText: string;
  /** 親の manuscript.body.txt の中身（hash を記録と照合済み） */
  bodyText: string;
  bodySha256: string;
};

type RunPlan = {
  purpose: RunPurpose;
  /** run ID の人物の欄（probe は 'astra'） */
  subject: string;
  characterId: string | null;
  parent: ParentRun | null;
  framing: string;
  promptText: string;
  inputs: PlannedInput[];
  /** 成功したときの最終応答の名前（manuscript.raw.md / probe.raw.txt） */
  rawFile: string;
  /** 題と本文を取り分けるか（draft / revise は取り分け、probe は取り分けない） */
  splitsBody: boolean;
  effort: string;
  verbosity: WriterVerbosity | null;
  timeoutMs: number;
};

const sha256Of = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const charsOf = (text: string): number => [...text].length;
const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const errorCodeOf = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;

/** 無いときだけ（ENOENT）そのパスを返す。権限などほかの失敗は握り潰さず投げる。 */
function realpathOrResolve(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if (errorCodeOf(error) !== 'ENOENT') throw error;
    return resolve(path);
  }
}

/** relative() の結果が、基準のディレクトリの外（または別のドライブ）を指すか */
const escapesBase = (rel: string): boolean => rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);

/**
 * 入力の出どころ。リポジトリの中なら root からの相対（/ 区切り）、外なら `external:<ファイル名>`。
 * シンボリックリンクは実体で見る（root の中のリンクが外を指すなら、出どころは外）。
 */
function sourceOf(root: string, path: string): string {
  const rel = relative(realpathOrResolve(root), realpathOrResolve(path));
  if (rel === '' || escapesBase(rel)) return `external:${basename(path)}`;
  return rel.split(sep).join('/');
}

/**
 * UTF-8 として読む。BOM も文字として残す（ignoreBOM）。ここで落とすと、記録した hash（元のバイト列）と
 * Astra へ渡す文字列が食い違い、「一字も変えない」が崩れる。
 */
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** 入力として読めるか（UTF-8・空でない・NUL なし）を確かめて文字列にする。誤りは投げる。 */
function decodeInput(bytes: Uint8Array, label: string, where: string): string {
  let text: string;
  try {
    text = STRICT_UTF8.decode(bytes);
  } catch (error) {
    throw new Error(`${label}が UTF-8 として読めません: ${where}`, { cause: error });
  }
  if (text.trim() === '') throw new Error(`${label}が空です（空白だけも不可）: ${where}`);
  if (text.includes('\0')) throw new Error(`${label}に NUL 文字が含まれています: ${where}`);
  return text;
}

function readSourceFile(path: string, label: string): Buffer {
  try {
    return readFileSync(path);
  } catch (error) {
    throw new Error(`${label}を読めません: ${path}（${reasonOf(error)}）`, { cause: error });
  }
}

/** 呼び出し側が指したファイルを入力として読む。出どころは root からの相対 / external。 */
function loadUserInput(
  deps: AuthoringDeps,
  spec: { role: RunInput['role']; path: string; file: string; label: string; name: string | null },
): PlannedInput {
  const path = resolve(spec.path);
  const bytes = readSourceFile(path, spec.label);
  return {
    role: spec.role,
    source: sourceOf(deps.root, path),
    name: spec.name,
    file: spec.file,
    bytes,
    text: decodeInput(bytes, spec.label, path),
  };
}

/** 組み込みの固定入力（probe）。 */
function builtinInput(role: RunInput['role'], file: string, text: string): PlannedInput {
  return { role, source: PROBE_SOURCE, name: null, file, bytes: Buffer.from(text, 'utf8'), text };
}

const describeInput = (input: PlannedInput, file: string): RunInput => ({
  role: input.role,
  source: input.source,
  name: input.name,
  file,
  sha256: sha256Of(input.bytes),
  bytes: input.bytes.byteLength,
  chars: charsOf(input.text),
});

const promptInfo = (plan: RunPlan): DryRunSummary['prompt'] => ({
  framing: plan.framing,
  sha256: sha256Of(plan.promptText),
  bytes: Buffer.byteLength(plan.promptText, 'utf8'),
  chars: charsOf(plan.promptText),
});

/** 指定が無ければ writer.yaml の値。範囲外の値は黙って丸めず投げる。 */
function resolveSettings(
  options: CommonRunOptions,
  deps: AuthoringDeps,
): Pick<RunPlan, 'effort' | 'verbosity' | 'timeoutMs'> {
  const effort = options.effort ?? deps.config.reasoning_effort;
  if (!EFFORT_PATTERN.test(effort)) {
    throw new Error(`effort は小文字の英字だけで指定してください: ${JSON.stringify(effort)}`);
  }
  const verbosity = options.verbosity === undefined ? deps.config.verbosity : options.verbosity;
  const minutes = options.timeoutMinutes ?? deps.config.timeout_minutes;
  if (!Number.isInteger(minutes) || minutes < TIMEOUT_MINUTES.min || minutes > TIMEOUT_MINUTES.max) {
    throw new Error(
      `timeout は ${TIMEOUT_MINUTES.min}〜${TIMEOUT_MINUTES.max} 分の整数で指定してください: ${minutes}`,
    );
  }
  const timeoutMs = deps.timeoutMsOverride ?? minutes * 60_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`timeout（ミリ秒）は正の整数にしてください: ${timeoutMs}`);
  }
  return { effort, verbosity, timeoutMs };
}

// ── 親の run（revise） ─────────────────────────────────────

/** 記録に書かれたファイル名が、run のディレクトリの外へ出ない名前か */
function assertPlainFileName(name: string): void {
  if (name === '' || name === '.' || name === '..' || basename(name) !== name) {
    throw new Error(`親の run の記録にあるファイル名が不正です: ${JSON.stringify(name)}`);
  }
}

/** 親の run のファイルを読み、記録の hash と照合する（違えば書き換えられている）。読むだけで、書かない。 */
function readParentFile(parentDir: string, runId: string, name: string, expectedSha256: string, label: string): Buffer {
  assertPlainFileName(name);
  const path = join(parentDir, name);
  const bytes = readSourceFile(path, `親の run（${runId}）の${label}`);
  if (sha256Of(bytes) !== expectedSha256) {
    throw new Error(
      `親の run（${runId}）の${label}の hash が run.json の記録と違います（書き換えられた可能性）。改稿の元にしません: ${path}`,
    );
  }
  return bytes;
}

function loadParentRun(deps: AuthoringDeps, runId: string): ParentRun {
  const dir = findRunDir(deps.runsRoot, runId);
  const record = readRunRecord(dir);
  if (record.run_id !== runId) {
    throw new Error(`run.json の run_id（${record.run_id}）がディレクトリ名（${runId}）と違います: ${dir}`);
  }
  if (record.purpose !== 'draft' && record.purpose !== 'revise') {
    throw new Error(`親の run（${runId}）は ${record.purpose} です。改稿の元にできるのは draft / revise の run だけです`);
  }
  if (record.status !== 'succeeded') {
    throw new Error(
      `親の run（${runId}）は成功していません（status: ${record.status}）。失敗した run の出力は完成稿ではないので、改稿の元にしません`,
    );
  }
  const output = record.output;
  if (output === null) throw new Error(`親の run（${runId}）の記録に出力がありません`);
  if (output.body_file === null || output.body_sha256 === null) {
    throw new Error(`親の run（${runId}）の記録に本文（${BODY_FILE}）がありません`);
  }
  if (record.character_id === null) throw new Error(`親の run（${runId}）の記録に人物がありません`);

  const manuscript = readParentFile(dir, runId, output.raw_file, output.raw_sha256, '原稿（raw）');
  const body = readParentFile(dir, runId, output.body_file, output.body_sha256, '本文');
  return {
    runId,
    dir,
    record,
    characterId: record.character_id,
    rawFile: output.raw_file,
    manuscript,
    manuscriptText: decodeInput(manuscript, `親の run（${runId}）の原稿`, join(dir, output.raw_file)),
    bodyText: new TextDecoder('utf-8', { ignoreBOM: true }).decode(body),
    bodySha256: output.body_sha256,
  };
}

/** 親の run が保存した入力の写し（brief / instructions）を、新しい run の入力として引き継ぐ。 */
function inheritedInput(parent: ParentRun, role: 'brief' | 'instructions', file: string, label: string): PlannedInput {
  const recorded = parent.record.inputs.find((input) => input.role === role);
  if (recorded === undefined) {
    throw new Error(`親の run（${parent.runId}）の記録に ${role} がありません`);
  }
  const bytes = readParentFile(parent.dir, parent.runId, recorded.file, recorded.sha256, label);
  return {
    role,
    source: `run:${parent.runId}/${recorded.file}`,
    name: recorded.name,
    file,
    bytes,
    text: decodeInput(bytes, `親の run（${parent.runId}）の${label}`, join(parent.dir, recorded.file)),
  };
}

// ── 入口 ───────────────────────────────────────────────────

function planFor(options: CommonRunOptions, deps: AuthoringDeps, plan: Omit<RunPlan, 'effort' | 'verbosity' | 'timeoutMs'>): RunPlan {
  return { ...plan, ...resolveSettings(options, deps) };
}

/**
 * 作者用の秘密の一覧（人物の profile.yaml / relationships.yaml から組む。1 プロセスで 1 度だけ読み、以後は使い回す）を、
 * 実行より前に読めるか確かめる。本文の照合（manuscript.ts）は Astra の応答が返ったあとに初めて一覧を読むので、
 * YAML が壊れていると、利用枠を使い切ってから失敗する。先に空文字で 1 回呼び、読めなければここで止める
 * （ロック・run のディレクトリ・preflight・spawn より前。何も作らない）。結果は見ない（空文字に当たる断片は無い）。
 */
function assertSecretListReadable(deps: AuthoringDeps): void {
  try {
    (deps.secretLeaks ?? secretLeaksIn)('');
  } catch (error) {
    throw new Error(
      `作者用の秘密の一覧（人物の profile.yaml / relationships.yaml）を読めません。原稿の照合ができないので、利用枠を使う前に止めました: ${reasonOf(error)}`,
      { cause: error },
    );
  }
}

/** dry-run なら要約だけを返し、そうでなければ run を起こす。 */
function executePlan(
  plan: RunPlan,
  deps: AuthoringDeps,
  mode: { dryRun: boolean; printPrompt: boolean },
): Promise<RunOutcome> {
  if (mode.dryRun) return Promise.resolve({ status: 'dry-run', summary: dryRunSummary(plan, deps, mode.printPrompt) });
  return startRun(plan, deps);
}

export async function draftStory(options: DraftOptions, deps: AuthoringDeps): Promise<RunOutcome> {
  const instructions = loadUserInput(deps, {
    role: 'instructions',
    path: options.instructionsPath ?? join(deps.root, deps.config.instructions),
    file: INSTRUCTIONS_FILE,
    label: '執筆用の指示',
    name: null,
  });
  const briefPath = resolve(options.briefPath);
  const brief = loadUserInput(deps, {
    role: 'brief',
    path: briefPath,
    file: BRIEF_FILE,
    label: 'brief',
    name: basename(briefPath),
  });
  const request = loadUserInput(deps, {
    role: 'request',
    path: options.requestPath,
    file: REQUEST_FILE,
    label: '依頼文',
    name: null,
  });
  // 添付の枠と衝突する入力は、ここで投げる（run のディレクトリもロックも、まだ作っていない）
  const promptText = draftPrompt({ briefName: basename(briefPath), brief: brief.text, request: request.text });

  const plan = planFor(options, deps, {
    purpose: 'draft',
    subject: options.characterId,
    characterId: options.characterId,
    parent: null,
    framing: DRAFT_FRAMING,
    promptText,
    inputs: [instructions, brief, request],
    rawFile: MANUSCRIPT_RAW_FILE,
    splitsBody: true,
  });
  assertSecretListReadable(deps);
  return executePlan(plan, deps, options);
}

export async function reviseStory(options: ReviseOptions, deps: AuthoringDeps): Promise<RunOutcome> {
  const parent = loadParentRun(deps, options.runId);

  const instructions =
    options.instructionsPath !== undefined
      ? loadUserInput(deps, {
          role: 'instructions',
          path: options.instructionsPath,
          file: INSTRUCTIONS_FILE,
          label: '執筆用の指示',
          name: null,
        })
      : inheritedInput(parent, 'instructions', INSTRUCTIONS_FILE, '執筆用の指示の写し');

  let brief: PlannedInput;
  if (options.briefPath !== undefined) {
    const briefPath = resolve(options.briefPath);
    brief = loadUserInput(deps, { role: 'brief', path: briefPath, file: BRIEF_FILE, label: 'brief', name: basename(briefPath) });
  } else {
    brief = inheritedInput(parent, 'brief', BRIEF_FILE, 'brief の写し');
  }
  if (brief.name === null) throw new Error(`親の run（${parent.runId}）の記録の brief に名前がありません`);

  const feedback = loadUserInput(deps, {
    role: 'feedback',
    path: options.feedbackPath,
    file: FEEDBACK_FILE,
    label: 'フィードバック',
    name: null,
  });
  const manuscript: PlannedInput = {
    role: 'manuscript',
    source: `run:${parent.runId}/${parent.rawFile}`,
    name: MANUSCRIPT_ATTACHMENT_NAME,
    file: PARENT_MANUSCRIPT_FILE,
    bytes: parent.manuscript,
    text: parent.manuscriptText,
  };
  const promptText = revisePrompt({
    briefName: brief.name,
    brief: brief.text,
    manuscriptName: MANUSCRIPT_ATTACHMENT_NAME,
    manuscript: manuscript.text,
    feedback: feedback.text,
  });

  const plan = planFor(options, deps, {
    purpose: 'revise',
    subject: parent.characterId,
    characterId: parent.characterId,
    parent,
    framing: REVISE_FRAMING,
    promptText,
    inputs: [instructions, brief, manuscript, feedback],
    rawFile: MANUSCRIPT_RAW_FILE,
    splitsBody: true,
  });
  assertSecretListReadable(deps);
  return executePlan(plan, deps, options);
}

/** doctor --probe の live 呼び出し（固定の短い入力。PROBE_INSTRUCTIONS / PROBE_PROMPT）。 */
export async function probeAstra(
  options: { dryRun: boolean },
  deps: AuthoringDeps,
): Promise<RunOutcome> {
  const plan = planFor({ dryRun: options.dryRun, printPrompt: false }, deps, {
    purpose: 'probe',
    subject: PROBE_SUBJECT,
    characterId: null,
    parent: null,
    framing: PROBE_FRAMING,
    promptText: PROBE_PROMPT,
    inputs: [
      builtinInput('instructions', INSTRUCTIONS_FILE, PROBE_INSTRUCTIONS),
      builtinInput('request', REQUEST_FILE, PROBE_PROMPT),
    ],
    rawFile: PROBE_RAW_FILE,
    splitsBody: false,
  });
  return executePlan(plan, deps, { dryRun: options.dryRun, printPrompt: false });
}

// ── dry-run ────────────────────────────────────────────────

/**
 * これから起こす run の要約。実際の run と同じ plan・同じ引数の組み立て（codexExecArgs）から作り、
 * 何も書かず、codex も ShortRun も起こさない。パスは <RUN_DIR> / <WORKDIR> の印にしてある。
 */
function dryRunSummary(plan: RunPlan, deps: AuthoringDeps, printPrompt: boolean): DryRunSummary {
  const { config } = deps;
  return {
    purpose: plan.purpose,
    model: config.model,
    effort: plan.effort,
    verbosity: plan.verbosity,
    authentication: config.authentication,
    credentialsStore: config.credentials_store,
    fallback: config.fallback,
    retries: 0,
    calls: 1,
    timeoutMs: plan.timeoutMs,
    inputs: plan.inputs.map((input) => describeInput(input, '')),
    prompt: promptInfo(plan),
    codexArgs: codexExecArgs({
      model: config.model,
      effort: plan.effort,
      verbosity: plan.verbosity,
      credentialsStore: config.credentials_store,
      instructionsFile: `${RUN_DIR_PLACEHOLDER}/${INSTRUCTIONS_FILE}`,
      outputLastMessage: `${RUN_DIR_PLACEHOLDER}/${plan.rawFile}${PARTIAL_SUFFIX}`,
      workdir: WORKDIR_PLACEHOLDER,
    }),
    envRemoved: sanitizedEnv(deps.env).removed,
    promptText: printPrompt ? plan.promptText : null,
  };
}

// ── 後始末 ─────────────────────────────────────────────────

/** 後始末を全部走らせ、投げられたものを集める（途中で止めない）。 */
function collectErrors(steps: ReadonlyArray<() => void>): unknown[] {
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      step();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

/** 元の失敗に、後始末の失敗を添える。後始末が成功していれば元の失敗をそのまま返す。 */
function withCleanupErrors(original: unknown, cleanupErrors: readonly unknown[]): unknown {
  if (cleanupErrors.length === 0) return original;
  return new AggregateError(
    [original, ...cleanupErrors],
    `${reasonOf(original)}（後始末にも失敗しました: ${cleanupErrors.map(reasonOf).join(' / ')}）`,
  );
}

/** 作業ディレクトリは、Git の外・root の外・空でなければならない（Codex にリポジトリを見せない）。 */
function assertUsableWorkdir(workdir: string, root: string): void {
  if (!isAbsolute(workdir)) {
    throw new Error(`作業ディレクトリは絶対パスでなければなりません: ${workdir}`);
  }
  const rel = relative(realpathOrResolve(root), realpathSync(workdir));
  if (rel === '' || !escapesBase(rel)) {
    throw new Error(
      `作業ディレクトリがリポジトリ（${root}）の中にあります。Codex にリポジトリを見せないため、起動しません: ${workdir}`,
    );
  }
  if (readdirSync(workdir).length > 0) {
    throw new Error(`作業ディレクトリが空ではありません。起動しません: ${workdir}`);
  }
}

/** 無いときだけ null。権限などほかの失敗は握り潰さず投げる。 */
function readOptional(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch (error) {
    if (errorCodeOf(error) === 'ENOENT') return null;
    throw error;
  }
}

function listOptional(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch (error) {
    if (errorCodeOf(error) === 'ENOENT') return [];
    throw error;
  }
}

// ── 実行 ───────────────────────────────────────────────────

type StartContext = {
  childEnv: ReturnType<typeof sanitizedEnv>;
  cliVersion: string;
  workdir: string;
  /** 作業ディレクトリを消す（2回呼んでも1回だけ消す） */
  dropWorkdir: () => void;
};

const stageOf = (purpose: RunPurpose): RunRecord['stage'] =>
  purpose === 'draft' ? 'generated' : purpose === 'revise' ? 'revised' : 'probe';

const commandOf = (purpose: RunPurpose): string =>
  purpose === 'draft' ? 'story:draft' : purpose === 'revise' ? 'story:revise' : 'story:doctor --probe';

/**
 * run を起こす。順序:
 *   preflight（止まれば blocked。そのあと中断されていても blocked）→ 作業ディレクトリを作って検査（root の中なら投げる）
 *   → ロック（取れなければ blocked）→ run のディレクトリ以降（runInNewDir）→ 後始末（ロック・作業ディレクトリ）
 *
 * 作業ディレクトリは、preflight が通ってから作る（止まった run が何も作らない）。ロックと run の
 * ディレクトリは、作業ディレクトリの検査が済んでから作る（検査で投げても、どちらも残さない）。
 * preflight は最大で数分かかりうる（短い確認コマンド 3 本）。その間に Ctrl-C が来ていたら、Codex を起動しない
 * （起動してから中断を見つけて「interrupted の run」を残すより、何も作らずに止める）。
 */
async function startRun(plan: RunPlan, deps: AuthoringDeps): Promise<RunOutcome> {
  const { config } = deps;
  const childEnv = sanitizedEnv(deps.env);

  const pre = await preflight(
    config,
    { effort: plan.effort },
    {
      run: deps.shortRun,
      env: childEnv.env,
      ...(deps.abortSignal !== undefined ? { abortSignal: deps.abortSignal } : {}),
    },
  );
  if (deps.abortSignal?.aborted === true) {
    // preflight 自身も中断を problems に入れて返すことがある。どちらでも、ここで止まる
    return { status: 'blocked', problems: ['中断されました（Codex は起動していません）'] };
  }
  if (pre.problems.length > 0) return { status: 'blocked', problems: pre.problems };
  if (pre.cliVersion === null || pre.login !== 'chatgpt') {
    // problems が空なのに、版や認証が確かめられていない。通すより止める
    return {
      status: 'blocked',
      problems: ['実行前の確認の結果が不完全です（CLI の版か ChatGPT のログインを確かめられていません）。story:doctor を実行してください。'],
    };
  }

  const workdir = deps.makeWorkdir();
  let workdirRemoved = false;
  const dropWorkdir = (): void => {
    if (workdirRemoved) return;
    workdirRemoved = true;
    deps.removeWorkdir(workdir);
  };
  try {
    assertUsableWorkdir(workdir, deps.root);
  } catch (error) {
    throw withCleanupErrors(error, collectErrors([dropWorkdir]));
  }

  let releaseLock: () => void;
  try {
    releaseLock = acquireRunLock(deps.runsRoot, {
      pid: deps.pid,
      command: commandOf(plan.purpose),
      acquiredAt: deps.now().toISOString(),
    });
  } catch (error) {
    const cleanupErrors = collectErrors([dropWorkdir]);
    if (error instanceof RunLockError && cleanupErrors.length === 0) {
      return { status: 'blocked', problems: [error.message] };
    }
    throw withCleanupErrors(error, cleanupErrors);
  }

  let outcome: RunOutcome | null = null;
  let failure: { error: unknown } | null = null;
  try {
    outcome = await runInNewDir(plan, deps, { childEnv, cliVersion: pre.cliVersion, workdir, dropWorkdir });
  } catch (error) {
    failure = { error };
  }
  const cleanupErrors = collectErrors([releaseLock, dropWorkdir]);
  if (failure !== null) throw withCleanupErrors(failure.error, cleanupErrors);
  if (cleanupErrors.length > 0 || outcome === null) {
    throw new AggregateError(cleanupErrors, `後始末に失敗しました: ${cleanupErrors.map(reasonOf).join(' / ')}`);
  }
  return outcome;
}

/**
 * ロックを持った状態で、run のディレクトリを作り、codex を1回だけ起こし、結果を保存する。
 * 途中で投げたときは、その場所を投げ直す Error の文面に添える。文面は実際の状態と合わせる:
 * running の run.json を置けていれば「running のまま残っている」、置く前に落ちたなら「run.json はまだない」。
 * 挙げるファイルは、いま run のディレクトリに実際にあるものだけ（まだ起こしていないのに events.jsonl があるとは言わない）。
 */
async function runInNewDir(plan: RunPlan, deps: AuthoringDeps, context: StartContext): Promise<RunOutcome> {
  const startedAt = deps.now();
  const runId = newRunId({ now: startedAt, subject: plan.subject, purpose: plan.purpose, random: deps.random });
  const runDir = createRunDir(deps.runsRoot, runId);
  const progress: RunProgress = { runJsonWritten: false };
  try {
    return await executeRun(plan, deps, context, { runId, runDir, startedAt, progress });
  } catch (error) {
    throw new Error(
      `run ${runId} を最後まで記録できませんでした（${describeRunDirState(runDir, progress)}）: ${reasonOf(error)}`,
      { cause: error },
    );
  }
}

/** executeRun がどこまで進んだか（runInNewDir が、落ちたときの案内を実際の状態に合わせるため） */
type RunProgress = {
  /** running の run.json を置けた */
  runJsonWritten: boolean;
};

/** 投げ直す Error に添える、run のディレクトリの実際の状態。ファイル名は、いまあるものだけ。 */
function describeRunDirState(runDir: string, progress: RunProgress): string {
  let present: string;
  try {
    const names = listOptional(runDir);
    present = names.length > 0 ? names.join(', ') : '（まだ何もありません）';
  } catch (error) {
    // 一覧を取れなくても、元の失敗を隠さない
    present = `（一覧を取れませんでした: ${reasonOf(error)}）`;
  }
  const state = progress.runJsonWritten
    ? 'run.json は running のまま残っています'
    : 'run.json はまだありません。run は起こしていません';
  return `${state}。${runDir} にあるファイル: ${present}`;
}

async function executeRun(
  plan: RunPlan,
  deps: AuthoringDeps,
  context: StartContext,
  run: { runId: string; runDir: string; startedAt: Date; progress: RunProgress },
): Promise<RunOutcome> {
  const { config } = deps;
  const { runId, runDir, startedAt, progress } = run;
  const pathIn = (name: string): string => join(runDir, name);

  // 入力の写し（元のバイト列のまま）と、stdin へ渡す全文。実行の前に置く
  for (const input of plan.inputs) writeFileNoClobber(pathIn(input.file), input.bytes);
  writeFileNoClobber(pathIn(PROMPT_FILE), plan.promptText);

  const rawFile = plan.rawFile;
  const partialFile = `${rawFile}${PARTIAL_SUFFIX}`;
  const args = codexExecArgs({
    model: config.model,
    effort: plan.effort,
    verbosity: plan.verbosity,
    credentialsStore: config.credentials_store,
    instructionsFile: pathIn(INSTRUCTIONS_FILE),
    outputLastMessage: pathIn(partialFile),
    workdir: context.workdir,
  });
  // 記録には絶対パスを残さない。-c の値は TOML の文字列として引用されるので、引用したあとの形も置き換える
  const replacements: Record<string, string> = {};
  for (const [path, placeholder] of [
    [runDir, RUN_DIR_PLACEHOLDER],
    [context.workdir, WORKDIR_PLACEHOLDER],
  ] as const) {
    replacements[path] = placeholder;
    replacements[tomlString(path).slice(1, -1)] = placeholder;
  }
  // 記録の文面（warnings・failure・spawn_error）用には、root などの環境のパスも置き換える。Codex の stderr や
  // error イベントの文面には、run・作業ディレクトリ以外のパスも混ざりうる。長いキーから先に置き換わるので、
  // run のディレクトリが root の下にあっても <RUN_DIR> になる。
  const textReplacements: Record<string, string> = { ...replacements };
  for (const [path, placeholder] of [
    [deps.runsRoot, '<RUNS_ROOT>'],
    [deps.root, '<ROOT>'],
    [tmpdir(), '<TMPDIR>'],
    [realpathOrResolve(tmpdir()), '<TMPDIR>'],
  ] as const) {
    // '/' のような短すぎるパスは、文面のあちこちに現れるので置き換えない
    if (path.length > 1 && !(path in textReplacements)) textReplacements[path] = placeholder;
  }
  const scrub = (text: string): string => redactArgs([text], textReplacements)[0] ?? text;

  const running: RunRecord = {
    schema: RUN_RECORD_SCHEMA,
    run_id: runId,
    purpose: plan.purpose,
    stage: stageOf(plan.purpose),
    parent_run_id: plan.parent?.runId ?? null,
    character_id: plan.characterId,
    status: 'running',
    started_at: startedAt.toISOString(),
    finished_at: null,
    duration_ms: null,
    cli: { command: config.cli.command, version: context.cliVersion, min_version: config.cli.min_version },
    requested: {
      provider: config.provider,
      model: config.model,
      reasoning_effort: plan.effort,
      verbosity: plan.verbosity,
      authentication: config.authentication,
      credentials_store: config.credentials_store,
      fallback: config.fallback,
      retries: 0,
      timeout_ms: plan.timeoutMs,
    },
    effective: { model: null, model_source: 'not_reported' },
    auth_check: { method: 'chatgpt', checked_with: 'codex login status' },
    inputs: plan.inputs.map((input) => describeInput(input, input.file)),
    prompt: { file: PROMPT_FILE, ...promptInfo(plan) },
    codex_args: redactArgs(args, replacements),
    env_removed: context.childEnv.removed,
    process: null,
    events: null,
    output: null,
    diff: null,
    failure: null,
    warnings: [],
  };
  writeRunRecord(runDir, running);
  progress.runJsonWritten = true;

  const timeoutMinutes = Math.round(plan.timeoutMs / 60_000);
  deps.log(`run ${runId}: Astra へ依頼しました（上限 ${timeoutMinutes} 分。Ctrl-C で止められます）`);
  const result = await runCodexProcess(
    {
      command: config.cli.command,
      args,
      cwd: context.workdir,
      env: context.childEnv.env,
      stdin: plan.promptText,
      stdoutPath: pathIn(EVENTS_FILE),
      stderrPath: pathIn(STDERR_FILE),
      timeoutMs: plan.timeoutMs,
      onHeartbeat: (elapsedMs) => {
        deps.log(`run ${runId}: 実行中（経過 ${Math.floor(elapsedMs / 60_000)} 分 / 上限 ${timeoutMinutes} 分）`);
      },
      ...(deps.heartbeatMs !== undefined ? { heartbeatMs: deps.heartbeatMs } : {}),
      ...(deps.killGraceMs !== undefined ? { killGraceMs: deps.killGraceMs } : {}),
      ...(deps.abortSignal !== undefined ? { abortSignal: deps.abortSignal } : {}),
    },
    deps.process,
  );

  // 実行のあとに読むもの。最初から中断されたときは、events / stderr のファイル自体が無い
  const eventsBytes = readOptional(pathIn(EVENTS_FILE));
  const stderrBytes = readOptional(pathIn(STDERR_FILE));
  // Codex の stderr・イベント・spawn の失敗の文面には、run・作業ディレクトリ・root のパスが混ざりうる。
  // 記録（warnings・failure）へ出る前に、失敗の分類より先に置き換える（パスの中の語で誤分類せず、
  // 原因の先頭 300 字の切り詰めでパスが途中で切れて残ることもない）。events.jsonl と stderr.log の中身は変えない
  const rawSummary = summarizeEvents(eventsBytes === null ? '' : eventsBytes.toString('utf8'));
  const summary: CodexEventSummary = {
    ...rawSummary,
    turnFailed: rawSummary.turnFailed === null ? null : scrub(rawSummary.turnFailed),
    errors: rawSummary.errors.map(scrub),
    notices: rawSummary.notices.map(scrub),
  };
  const spawnError = result.spawnError === null ? null : scrub(result.spawnError);
  const partialBytes = readOptional(pathIn(partialFile));
  const partial = partialBytes === null ? null : decodeOutput(partialBytes);
  const failureFound = classifyFailure({
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    interrupted: result.interrupted,
    spawnError,
    summary,
    stderr: stderrBytes === null ? '' : scrub(stderrBytes.toString('utf8')),
    output: partial === null ? null : partial.text,
  });

  const warnings: string[] = [];
  let output: RunRecord['output'] = null;
  let diff: RunRecord['diff'] = null;

  if (failureFound === null) {
    // 成功。classifyFailure は、最終応答が無ければ empty_output にする。ここで無いのは内部の矛盾
    if (partialBytes === null || partial === null) {
      throw new Error(`内部エラー: 成功と判定したのに最終応答（${partialFile}）がありません: ${runDir}`);
    }
    // 題と本文の取り分けは先に済ませる（投げるなら、ファイルを動かす前に）
    const manuscript = plan.splitsBody
      ? splitManuscript(partial.text, deps.secretLeaks !== undefined ? { secretLeaks: deps.secretLeaks } : {})
      : null;
    if (!partial.valid) {
      warnings.push(
        '最終応答が UTF-8 として正しくない（raw はそのまま保存した。本文は置換文字を含む）。確認すること',
      );
    }
    const rawOutput = { raw_file: rawFile, raw_sha256: sha256Of(partialBytes), raw_bytes: partialBytes.byteLength };

    if (manuscript === null) {
      output = { ...rawOutput, body_file: null, body_sha256: null, body_chars: null, title: null, title_rule: null };
    } else {
      warnings.push(...manuscript.warnings);
      const bodyFileText = `${manuscript.body}\n`;
      writeFileNoClobber(pathIn(BODY_FILE), bodyFileText);
      output = {
        ...rawOutput,
        body_file: BODY_FILE,
        body_sha256: sha256Of(bodyFileText),
        body_chars: manuscript.bodyChars,
        title: manuscript.title,
        title_rule: manuscript.titleRule,
      };
      if (plan.parent !== null) {
        // 親の本文との差分は、変わらなくても必ず書く（空のファイル = 変わらなかった、という記録）
        const diffText = unifiedDiff(plan.parent.bodyText, bodyFileText, {
          a: `a/${plan.parent.runId}/${BODY_FILE}`,
          b: `b/${runId}/${BODY_FILE}`,
        });
        writeFileNoClobber(pathIn(DIFF_FILE), diffText);
        diff = { file: DIFF_FILE, parent_body_sha256: plan.parent.bodySha256, changed: diffText !== '' };
      }
    }
    // raw の昇格は、本文と差分を書き終えてから。ここより前に落ちた run には、raw（manuscript.raw.md）が現れない。
    // raw があるのは、本文と差分が揃った run だけ（そのあと run.json を完成させる）
    moveNoClobber(pathIn(partialFile), pathIn(rawFile));
  } else if (partialBytes !== null) {
    // 失敗した run の出力。完成稿にはしない（.partial のまま残す）。run.json には絶対パスを残さず、run の中の名前で書く
    warnings.push(`失敗した run の出力が残っている（完成稿ではない）: ${partialFile}`);
  }

  if (summary.parseErrors > 0) {
    warnings.push(`${EVENTS_FILE} に JSON として読めない行が ${summary.parseErrors} 行ある`);
  }
  if (summary.notices.length > 0) {
    warnings.push(`回復できた注意（再接続など）が ${summary.notices.length} 件あった: ${summary.notices[0] ?? ''}`);
  }
  if (failureFound === null && summary.errors.length > 0) {
    // turn は完了しているので失敗にはしない（codex-events の classifyFailure）。何が起きたかは残す
    warnings.push(
      `error イベントが ${summary.errors.length} 件あったが、そのあと turn は完了した（回復したとみなした）: ${summary.errors[0] ?? ''}`,
    );
  }

  // Codex が作業ディレクトリに何か残していないか。確かめてから消す（消せなかったことも記録する）
  const leftovers = listOptional(context.workdir);
  if (leftovers.length > 0) {
    const shown = leftovers.slice(0, LEFTOVERS_SHOWN).join(', ');
    const rest = leftovers.length > LEFTOVERS_SHOWN ? ` ほか ${leftovers.length - LEFTOVERS_SHOWN} 件` : '';
    warnings.push(
      `作業ディレクトリに Codex が ${leftovers.length} 件のファイルを残していた（${shown}${rest}）。執筆の結果は取り消さない。何を書いたか確認すること`,
    );
  }
  try {
    context.dropWorkdir();
  } catch (error) {
    warnings.push(`作業ディレクトリを消せなかった（${WORKDIR_PLACEHOLDER}）: ${scrub(reasonOf(error))}`);
  }

  const finishedAt = deps.now();
  const record: RunRecord = {
    ...running,
    status: failureFound === null ? 'succeeded' : 'failed',
    finished_at: finishedAt.toISOString(),
    duration_ms: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    effective:
      summary.reportedModel === null
        ? { model: null, model_source: 'not_reported' }
        : { model: summary.reportedModel.value, model_source: summary.reportedModel.source },
    process: {
      exit_code: result.exitCode,
      signal: result.signal,
      timed_out: result.timedOut,
      interrupted: result.interrupted,
      spawn_error: spawnError,
    },
    events:
      eventsBytes === null
        ? null
        : {
            file: EVENTS_FILE,
            lines: summary.lines,
            parse_errors: summary.parseErrors,
            thread_id: summary.threadId,
            turn_completed: summary.turnCompleted,
            item_types: summary.itemTypes,
            unexpected_items: summary.unexpectedItems,
            agent_messages: summary.agentMessages,
            usage: summary.usage,
          },
    output,
    diff,
    // 絶対パスを残さない最後の砦（上の分類前の置き換えと、各 warning が相対名・印で書かれていることが本線）
    failure: failureFound === null ? null : { kind: failureFound.kind, message: scrub(failureFound.message) },
    warnings: warnings.map(scrub),
  };
  writeRunRecord(runDir, record);

  return failureFound === null
    ? { status: 'succeeded', runId, runDir, record }
    : { status: 'failed', runId, runDir, record };
}

/**
 * 最終応答のバイト列を文字列にする。UTF-8 として正しくなければ、置換文字つきで読み、valid: false を返す
 * （呼び出し側が warnings に記録する。raw はバイト列のまま保存するので、内容は失われない）。
 */
function decodeOutput(bytes: Uint8Array): { text: string; valid: boolean } {
  try {
    return { text: STRICT_UTF8.decode(bytes), valid: true };
  } catch {
    return { text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes), valid: false };
  }
}

// ── 失敗の案内 ─────────────────────────────────────────────

const GENERIC_ADVICE =
  'run のディレクトリの events.jsonl と stderr.log を見て、原因を確かめてください。自動では再試行しません。';

const FAILURE_ADVICE: Record<FailureKind, string> = {
  auth: 'ターミナルで `codex login`（ChatGPT でログイン）をやり直してから、もう一度実行してください。API キーなど別の認証には切り替えません。',
  usage_limit:
    '利用枠・レート制限の回復を待ってから実行し直してください（自動では再試行しません）。購入・課金設定の変更はしません。別のモデルへは切り替えません。',
  model_unavailable:
    'このアカウントでそのモデルが使えるか、Codex CLI の版が足りているかを確かめてください（`npm run story:doctor`）。別のモデルへは切り替えません。',
  config:
    'Codex が設定の上書きを受け付けませんでした。CLI の版が変わった可能性があります。`npm run story:doctor` で確かめてください。',
  timeout:
    '上限の時間を超えたので打ち切りました。`--timeout-minutes` を検討してください（途中の出力は完成稿にしません。自動では再試行しません）。',
  interrupted: '中断されました。もう一度実行するかどうかは、人が決めてください（途中の出力は完成稿にしません）。',
  unexpected_tool:
    '執筆中にツールの呼び出しがありました。隔離の設定を `npm run story:doctor` で確かめてください（本文があっても完成稿にしません）。',
  spawn_error:
    'codex を起動できませんでした。writer.yaml の cli.command と PATH を確かめ、`npm run story:doctor` を実行してください。',
  empty_output: GENERIC_ADVICE,
  no_turn_completed: GENERIC_ADVICE,
  turn_failed: GENERIC_ADVICE,
  stream_error: GENERIC_ADVICE,
  nonzero_exit: GENERIC_ADVICE,
};

/** 失敗の種類ごとの、人がすること（表示用）。課金や別モデルへの切り替えは案内しない。 */
export function failureAdvice(kind: string): string {
  return (FAILURE_KINDS as readonly string[]).includes(kind)
    ? FAILURE_ADVICE[kind as FailureKind]
    : GENERIC_ADVICE;
}

// ── 本物の依存 ─────────────────────────────────────────────

/** 本物の依存。abortSignal は scripts が SIGINT / SIGTERM から作る。 */
export function realAuthoringDeps(options: {
  config: WriterConfig;
  abortSignal?: AbortSignal;
}): AuthoringDeps {
  const processDeps = realProcessDeps();
  return {
    root: ROOT,
    runsRoot: runsRootOf(ROOT),
    config: options.config,
    env: process.env,
    shortRun: shortRunner(options.config.cli.command, processDeps),
    process: processDeps,
    now: () => new Date(),
    random: () => randomBytes(3).toString('hex'),
    // OS の一時ディレクトリは Git リポジトリの外。実体のパスで返し、シンボリックリンク越しに root と混同しない
    makeWorkdir: () => mkdtempSync(join(realpathSync(tmpdir()), 'velum-astra-')),
    removeWorkdir: (dir) => rmSync(dir, { recursive: true, force: true }),
    log: (line) => {
      console.log(line);
    },
    pid: process.pid,
    heartbeatMs: 60_000,
    ...(options.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
  };
}
