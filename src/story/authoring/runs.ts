import { randomBytes } from 'node:crypto';
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { ROOT } from '../../lib/paths.js';
import { FAILURE_KINDS } from './codex-events.js';

/**
 * 制作の run（.story-runs/<run-id>/）。gitignore の下で、日常の試作と実行記録を置く。
 *
 * 制作物と公開物を分ける。既存の characters/<id>/stories/sNN/ は置けるファイル名が限られているので、
 * run の記録はそこへ置かない。公開リポジトリへも入れない。
 *
 * 規律:
 * - run のディレクトリは実行ごとに新しく作る（既存の名前なら作らずに投げる）
 * - run の中のファイルは**上書きしない**（writeFileNoClobber）。例外は run.json だけで、
 *   実行中 → 終了の状態を、一時ファイルからの rename で丸ごと差し替える（途中で壊れた run.json を残さない）
 * - 生成コマンドは同時に1つだけ（.story-runs/.lock）。ChatGPT の利用枠を二重に使わない
 *
 * run の status（running / succeeded / failed）と stage（generated / revised / probe）は制作側の概念で、
 * 公開の台帳（manifest）の draft / reviewed / published とは別物。制作コマンドは manifest に触れない。
 */

export const RUNS_DIR_NAME = '.story-runs';
export const LOCK_FILE_NAME = '.lock';
export const RUN_RECORD_FILE = 'run.json';
export const RUN_RECORD_SCHEMA = 'velum-story-run/v1';

export const runsRoot = (root: string = ROOT): string => join(root, RUNS_DIR_NAME);

export const RUN_PURPOSES = ['draft', 'revise', 'probe'] as const;
export type RunPurpose = (typeof RUN_PURPOSES)[number];

/**
 * run ID: `<YYYYMMDD>T<HHMMSS>Z-<subject>-<purpose>-<6桁の16進>`（UTC）。
 * subject は人物の id（probe は 'astra'）。例: `20261003T225400Z-riko-draft-1a2b3c`。
 * 名前順が時刻順になる。パスとして安全な文字だけ（RUN_ID_PATTERN）。
 */
export const RUN_ID_PATTERN = /^\d{8}T\d{6}Z-[a-z0-9]+-(draft|revise|probe)-[0-9a-f]{6}$/;

export function newRunId(input: {
  now: Date;
  subject: string;
  purpose: RunPurpose;
  /** 6桁の16進を返す */
  random: () => string;
}): string {
  // subject と random はパスの一部になる。形の合わない値は、ID を組む前に断る
  if (!/^[a-z0-9]+$/.test(input.subject)) {
    throw new Error(`run ID の subject は小文字英数字だけです: ${JSON.stringify(input.subject)}`);
  }
  const suffix = input.random();
  if (!/^[0-9a-f]{6}$/.test(suffix)) {
    throw new Error(`run ID の乱数部は小文字16進の6桁です: ${JSON.stringify(suffix)}`);
  }
  // toISOString は常に UTC。`2026-10-03T13:54:07.123Z` → `20261003T135407Z`（ミリ秒は入れない）
  const stamp = input.now.toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '');
  const id = `${stamp}-${input.subject}-${input.purpose}-${suffix}`;
  if (!RUN_ID_PATTERN.test(id)) {
    throw new Error(`run ID の形に合いません: ${JSON.stringify(id)}`);
  }
  return id;
}

/** run のディレクトリを作る（親の .story-runs は必要なら作る）。同じ名前があれば投げる。 */
export function createRunDir(runsRootDir: string, runId: string): string {
  assertRunIdShape(runId);
  mkdirSync(runsRootDir, { recursive: true });
  const dir = join(runsRootDir, runId);
  try {
    // recursive にしない: 既存の名前なら EEXIST になり、他の run の中身に触れない
    mkdirSync(dir);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      throw new Error(`run のディレクトリは既にあります（run は実行ごとに新しく作ります）: ${runId}`, {
        cause: error,
      });
    }
    throw error;
  }
  return dir;
}

/**
 * 既存の run を探す。ID の形（RUN_ID_PATTERN）を先に見て、パスの外へ出る指定（`../x` など）を拒む。
 * 無ければ「どの ID が無いか」を添えて投げる。
 */
export function findRunDir(runsRootDir: string, runId: string): string {
  assertRunIdShape(runId);
  const dir = join(runsRootDir, runId);
  let isDirectory = false;
  try {
    isDirectory = statSync(dir).isDirectory();
  } catch (error) {
    // 無いことだけを「見つからない」にする。権限など他の失敗は握り潰さず、そのまま投げる
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  if (!isDirectory) {
    throw new Error(`run が見つかりません: ${runId}（探した場所: ${runsRootDir}）`);
  }
  return dir;
}

/** run ID の形を確かめる。パスの外へ出る値（`../x`・`a/b`・空）はここで止まる。 */
function assertRunIdShape(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`run ID の形が正しくありません: ${JSON.stringify(runId)}（例: 20261003T225400Z-riko-draft-1a2b3c）`);
  }
}

/** Node のシステムエラーの code（無ければ undefined） */
function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

/**
 * 後始末つきで元の失敗を投げ直す。後始末まで失敗したら、握り潰さずに両方を AggregateError で残す。
 * 後始末の対象がもう無い（ENOENT）のは、望んだ状態になっているので失敗に数えない。
 */
function rethrowAfterCleanup(original: unknown, cleanup: () => void, what: string): never {
  try {
    cleanup();
  } catch (cleanupError) {
    if (errorCode(cleanupError) !== 'ENOENT') {
      throw new AggregateError(
        [original, cleanupError],
        `${what}（後始末にも失敗しました。手で確かめてください）`,
      );
    }
  }
  throw original;
}

/** 同じディレクトリに置く一時ファイルの名前。実行ごと・呼び出しごとに別になる。 */
function tempPathFor(path: string): string {
  return join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
}

/**
 * 一時ファイルを新しく（wx）作って中身を書き、閉じる。作れたら一時ファイルのパスを返す。
 * 書き込みの途中で失敗したら一時ファイルを消して投げる（何も残さない）。
 */
function writeTempFile(path: string, content: string | Uint8Array): string {
  const temp = tempPathFor(path);
  const fd = openSync(temp, 'wx'); // 開けなければ何も作られていない。そのまま投げる
  try {
    try {
      writeFileSync(fd, content);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    return rethrowAfterCleanup(error, () => unlinkSync(temp), '一時ファイルへの書き込みに失敗しました');
  }
  return temp;
}

/**
 * 上書きしない書き込み。同じディレクトリの一時ファイルへ書いてから link で置き、一時ファイルを消す。
 * 既にあれば投げる（既存の中身は変わらない）。途中で落ちても、半端なファイルを目的の名前で残さない。
 */
export function writeFileNoClobber(path: string, content: string | Uint8Array): void {
  const temp = writeTempFile(path, content);
  try {
    // link は移し先があれば EEXIST で失敗する。rename と違って既存を上書きしない
    linkSync(temp, path);
  } catch (error) {
    const reason =
      errorCode(error) === 'EEXIST'
        ? new Error(`既にあるファイルは上書きしません: ${path}`, { cause: error })
        : error;
    return rethrowAfterCleanup(reason, () => unlinkSync(temp), `ファイルを置けませんでした: ${path}`);
  }
  // 目的の名前は置けた。一時ファイルの名前だけを外す（中身は同じ inode で残る）
  unlinkSync(temp);
}

/** 既存のファイルを、上書きせずに別の名前へ移す（link して元を消す）。移し先があれば投げる。 */
export function moveNoClobber(from: string, to: string): void {
  try {
    // 元が無ければ ENOENT、移し先があれば EEXIST。どちらも何も作らずに失敗する
    linkSync(from, to);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      throw new Error(`移し先に既にファイルがあります: ${to}`, { cause: error });
    }
    throw error;
  }
  try {
    unlinkSync(from);
  } catch (error) {
    // 元を外せなかったら、いま作った移し先を戻して、移す前の状態へ返す（両方残る状態にしない）
    rethrowAfterCleanup(error, () => unlinkSync(to), `ファイルを移せませんでした: ${from} → ${to}`);
  }
}

export class RunLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunLockError';
  }
}

/**
 * 生成コマンドのロックを取る（.story-runs/.lock を wx で作る。中身は { pid, command, acquired_at }）。
 * .story-runs が無ければ作る。自分のロックかどうかは pid と acquired_at の両方で見る。
 * 取れなければ RunLockError:
 * - 持ち主の pid が生きている → 「別の制作コマンドが実行中」
 * - 持ち主がもういない → 古いロック。自動では消さず、パスと、その run の Codex が残っているかもしれないこと
 *   （確かめ方: `pgrep -fl "codex exec"`）を示して、人に確かめてもらう
 * 戻り値は解放の関数（自分のロックのときだけ消す。2回呼んでもよい）。
 * isAlive は既定で process.kill(pid, 0) が通るか。
 */
export function acquireRunLock(
  runsRootDir: string,
  info: { pid: number; command: string; acquiredAt: string },
  isAlive?: (pid: number) => boolean,
): () => void {
  if (!Number.isInteger(info.pid) || info.pid <= 0) {
    // pid 0 や負の値は kill(2) では「プロセスグループ」の意味になる。持ち主の確認を誤らせない
    throw new RunLockError(`ロックの pid は正の整数にしてください: ${info.pid}`);
  }
  const alive = isAlive ?? isProcessAlive;
  mkdirSync(runsRootDir, { recursive: true });
  const lockPath = join(runsRootDir, LOCK_FILE_NAME);
  const body = `${JSON.stringify({
    pid: info.pid,
    command: info.command,
    acquired_at: info.acquiredAt,
  } satisfies LockContent)}\n`;

  // wx で作れた方が持ち主。既にあれば持ち主を調べて断る。調べる直前に持ち主が解放していたら、取り直す
  let fd: number | undefined;
  for (let attempt = 0; fd === undefined && attempt < LOCK_ATTEMPTS; attempt++) {
    try {
      fd = openSync(lockPath, 'wx');
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      const contention = contendedLockError(lockPath, alive);
      if (contention !== null) throw contention;
    }
  }
  if (fd === undefined) {
    throw new RunLockError(`ロックを取れませんでした（取得と解放が重なり続けました）: ${lockPath}`);
  }

  try {
    try {
      writeFileSync(fd, body);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    // 中身を書けなかった作りかけのロックを残さない（自分が作った直後なので、消してよい）
    return rethrowAfterCleanup(error, () => unlinkSync(lockPath), `ロックを書けませんでした: ${lockPath}`);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseOwnLock(lockPath, info.pid, info.acquiredAt);
  };
}

/** 持ち主が解放した直後と重なったときの取り直しの上限（これを超えて重なり続けることは無い。無限に回さないための歯止め） */
const LOCK_ATTEMPTS = 3;

/** ロックファイルの中身（将来キーが増えても読めるよう、知らないキーは許す） */
const LockContentSchema = z.object({
  pid: z.number().int().positive(),
  command: z.string(),
  acquired_at: z.string(),
});
type LockContent = z.infer<typeof LockContentSchema>;

/** 既定の生存確認。シグナル 0 は送らずに「送れるか」だけを見る。EPERM は「いるが権限が無い」なので生きている。 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

type LockRead =
  | { kind: 'ok'; content: LockContent }
  /** 読む直前に消えた（持ち主が解放した） */
  | { kind: 'gone' }
  /** あるが読めない・形が違う（書き込み途中、手での編集、壊れ） */
  | { kind: 'unreadable'; reason: string };

/** 既存のロックを読む。無い・読めない・形が違うは種類で返す。それ以外の失敗（権限など）は投げる。 */
function readLockContent(lockPath: string): LockRead {
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { kind: 'gone' };
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { kind: 'unreadable', reason: 'JSON として読めません（書き込み途中かもしれません）' };
  }
  const parsed = LockContentSchema.safeParse(json);
  if (!parsed.success) return { kind: 'unreadable', reason: '期待する形ではありません' };
  return { kind: 'ok', content: parsed.data };
}

/**
 * ロックが既にあったときの RunLockError。持ち主が生きていれば「実行中」、いなければ古いロック。
 * 調べる間に消えていたら null（取り直してよい）。
 */
function contendedLockError(lockPath: string, isAlive: (pid: number) => boolean): RunLockError | null {
  const lock = readLockContent(lockPath);
  if (lock.kind === 'gone') return null;
  if (lock.kind === 'unreadable') {
    return new RunLockError(
      `ロックファイルがありますが、持ち主を確かめられません（${lock.reason}）。` +
        `別の制作コマンドが動いていないことを確かめてから、手で削除してください: ${lockPath}`,
    );
  }
  const { pid, command, acquired_at: acquiredAt } = lock.content;
  if (isAlive(pid)) {
    return new RunLockError(
      `別の制作コマンドが実行中です（pid ${pid}、${command}、開始 ${acquiredAt}）。終わってからやり直してください。` +
        `ロック: ${lockPath}`,
    );
  }
  // 持ち主（制作コマンド）が kill -9 などで落ちても、Codex は別のプロセスグループで動き続けていることがある。
  // その Codex が残っていると、ロックを消して次を起こしたとき ChatGPT の利用枠を二重に使う
  return new RunLockError(
    `古いロックが残っています（持ち主の pid ${pid}（${command}、開始 ${acquiredAt}）はもういません）。` +
      `ただし、その run が起こした Codex は、まだ動いている可能性があります。` +
      `\`pgrep -fl "codex exec"\` で残っていないか確かめ、あれば終わるのを待つか止めてください。` +
      `自動では消しません。別の制作コマンドも Codex も動いていないことを確かめてから、手で削除してください: ${lockPath}`,
  );
}

/**
 * 自分のロックのときだけ消す。pid と acquired_at の両方が合うものを自分のものとする
 * （同じ pid の別の実行や、別の実行に取り直されたロックは消さない）。既に無ければ何もしない。
 * 中身が読めないロックは自分のものと言えないので消さず、投げる（次の取得でも同じ理由で止まる）。
 */
function releaseOwnLock(lockPath: string, pid: number, acquiredAt: string): void {
  const lock = readLockContent(lockPath);
  if (lock.kind === 'gone') return;
  if (lock.kind === 'unreadable') {
    throw new RunLockError(`ロックを解放できません。中身を確かめられません（${lock.reason}）: ${lockPath}`);
  }
  if (lock.content.pid !== pid || lock.content.acquired_at !== acquiredAt) return;
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const RUN_INPUT_ROLES = ['instructions', 'brief', 'request', 'manuscript', 'feedback'] as const;

export const RunInputSchema = z
  .object({
    role: z.enum(RUN_INPUT_ROLES),
    /** どこから来たか。リポジトリの中なら root からの相対、run からなら `run:<run-id>/<file>`、外なら `external:<basename>` */
    source: z.string().min(1),
    /** 依頼文の中で添付として見せた名前（instructions は null） */
    name: z.string().min(1).nullable(),
    /** run の中の写し */
    file: z.string().min(1),
    sha256: Sha256,
    bytes: z.number().int().nonnegative(),
    chars: z.number().int().nonnegative(),
  })
  .strict();
export type RunInput = z.infer<typeof RunInputSchema>;

export const RunRecordSchema = z
  .object({
    schema: z.literal(RUN_RECORD_SCHEMA),
    run_id: z.string().regex(RUN_ID_PATTERN),
    purpose: z.enum(RUN_PURPOSES),
    stage: z.enum(['generated', 'revised', 'probe']),
    parent_run_id: z.string().regex(RUN_ID_PATTERN).nullable(),
    character_id: z.string().min(1).nullable(),
    status: z.enum(['running', 'succeeded', 'failed']),
    started_at: z.string().min(1),
    finished_at: z.string().min(1).nullable(),
    duration_ms: z.number().int().nonnegative().nullable(),
    cli: z
      .object({
        command: z.string().min(1),
        version: z.string().min(1),
        min_version: z.string().min(1),
      })
      .strict(),
    requested: z
      .object({
        provider: z.literal('codex-cli'),
        model: z.string().min(1),
        reasoning_effort: z.string().min(1),
        verbosity: z.string().nullable(),
        authentication: z.literal('chatgpt'),
        credentials_store: z.string().min(1),
        fallback: z.literal('none'),
        retries: z.literal(0),
        timeout_ms: z.number().int().positive(),
      })
      .strict(),
    /** CLI のメタデータから確かめられた値。確かめられなければ value は null、source は 'not_reported' */
    effective: z
      .object({
        model: z.string().nullable(),
        model_source: z.string().min(1),
      })
      .strict(),
    /** 実行の直前に codex login status で確かめた認証 */
    auth_check: z
      .object({
        method: z.enum(['chatgpt', 'api_key', 'none', 'unknown']),
        checked_with: z.literal('codex login status'),
      })
      .strict(),
    inputs: z.array(RunInputSchema),
    prompt: z
      .object({
        file: z.string().min(1),
        framing: z.string().min(1),
        sha256: Sha256,
        bytes: z.number().int().nonnegative(),
        chars: z.number().int().nonnegative(),
      })
      .strict(),
    /** 実際に渡した引数。絶対パスは <RUN_DIR> / <WORKDIR> に置き換えてある */
    codex_args: z.array(z.string()),
    /** 子の環境から外した変数の名前（値は残さない） */
    env_removed: z.array(z.string()),
    process: z
      .object({
        exit_code: z.number().int().nullable(),
        signal: z.string().nullable(),
        timed_out: z.boolean(),
        interrupted: z.boolean(),
        spawn_error: z.string().nullable(),
      })
      .strict()
      .nullable(),
    events: z
      .object({
        file: z.string().min(1),
        lines: z.number().int().nonnegative(),
        parse_errors: z.number().int().nonnegative(),
        thread_id: z.string().nullable(),
        turn_completed: z.boolean(),
        item_types: z.record(z.number().int().nonnegative()),
        unexpected_items: z.array(z.string()),
        agent_messages: z.number().int().nonnegative(),
        usage: z.record(z.number()).nullable(),
      })
      .strict()
      .nullable(),
    output: z
      .object({
        raw_file: z.string().min(1),
        raw_sha256: Sha256,
        raw_bytes: z.number().int().nonnegative(),
        body_file: z.string().min(1).nullable(),
        body_sha256: Sha256.nullable(),
        body_chars: z.number().int().nonnegative().nullable(),
        title: z.string().nullable(),
        title_rule: z.string().nullable(),
      })
      .strict()
      .nullable(),
    diff: z
      .object({
        file: z.string().min(1),
        parent_body_sha256: Sha256,
        changed: z.boolean(),
      })
      .strict()
      .nullable(),
    failure: z
      .object({
        kind: z.enum(FAILURE_KINDS),
        message: z.string(),
      })
      .strict()
      .nullable(),
    warnings: z.array(z.string()),
  })
  .strict();
export type RunRecord = z.infer<typeof RunRecordSchema>;

/** run.json を書く（一時ファイル → rename。run.json だけは状態の更新のため差し替えてよい）。 */
export function writeRunRecord(runDir: string, record: RunRecord): void {
  const target = join(runDir, RUN_RECORD_FILE);
  // 契約に合わない記録は書かない（fallback や retries の約束を破った記録を残さない）
  const parsed = RunRecordSchema.safeParse(record);
  if (!parsed.success) {
    throw new Error(`run.json の記録が契約に合いません: ${describeIssues(parsed.error)}`, {
      cause: parsed.error,
    });
  }
  const temp = writeTempFile(target, `${JSON.stringify(parsed.data, null, 2)}\n`);
  try {
    // rename は同じディレクトリの中で原子的に差し替える。読む側は旧版か新版のどちらかだけを見る
    renameSync(temp, target);
  } catch (error) {
    rethrowAfterCleanup(error, () => unlinkSync(temp), `run.json を差し替えられませんでした: ${target}`);
  }
}

/** run.json を読んで検証する。 */
export function readRunRecord(runDir: string): RunRecord {
  const path = join(runDir, RUN_RECORD_FILE);
  const raw = readFileSync(path, 'utf8'); // 無ければ ENOENT（パス入り）のまま投げる
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(`run.json が JSON として読めません: ${path}`, { cause: error });
  }
  const parsed = RunRecordSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`run.json が契約に合いません（${path}）: ${describeIssues(parsed.error)}`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/** zod の指摘を「キーの場所: 内容」の1行にする */
function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}
