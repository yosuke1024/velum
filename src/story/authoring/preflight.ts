import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { WriterConfig } from './config.js';
import type { ShortResult, ShortRun } from './codex-process.js';
import { catalogArgs, loginStatusArgs, versionArgs } from './codex-command.js';

/**
 * 実行の前の確認（推論しない）。story:draft / story:revise / doctor --probe が、Astra を呼ぶ直前に必ず通す。
 * doctor はこれに加えて、設定の検査と隔離の確認をする（doctor.ts）。
 *
 * 1. `codex --version` が writer.yaml の cli.min_version 以上
 * 2. `codex login status`（exec と同じ forced_login_method / credentials_store の上書き、同じ sanitizedEnv）が
 *    「Logged in using ChatGPT」。API キーでのログインなら**実行しない**（forced_login_method の不一致で
 *    CLI がログアウトさせる副作用を、切り替えの手段にしない）。未ログインなら `codex login` を案内する
 * 3. `codex debug models` のカタログにモデルがあり、指定の effort がそのモデルの supported_reasoning_levels にある。
 *    カタログにあることは、アカウントで使えることの保証ではない（それは live の probe で確かめる）
 *
 * どれかが通らなければ problems に理由を入れて返す（投げない）。呼び出し側は problems があれば止まる。
 *
 * これらより先に、グローバルの指示ファイル（$CODEX_HOME/AGENTS.md・AGENTS.override.md）の有無を調べる（0）。
 * Codex は --ignore-user-config でも project_doc_max_bytes=0 でもこれを読み、モデルへの入力に混ぜる。
 * あれば codex を1つも起こさずに止める（ファイルの有無を見るだけで、読みも動かしも消しもしない）。
 *
 * abortSignal が aborted なら、次のコマンドを起こさず、problems に「中断」を入れて返す。
 */

export type LoginMethod = 'chatgpt' | 'api_key' | 'none' | 'unknown';

/** "codex-cli 0.153.4" → "0.153.4"。読めなければ null。 */
export function parseCodexVersion(text: string): string | null {
  // 先頭の語は codex / codex-cli。警告の行に混じった別の数字列を版と取り違えないよう、語に続く x.y.z だけを読む
  const match = /(?:^|\s)codex(?:-cli)?\s+v?(\d+\.\d+\.\d+)(?![\d.])/im.exec(text);
  return match?.[1] ?? null;
}

/** semver（x.y.z）の比較。a < b なら負、等しければ 0、a > b なら正。 */
export function compareVersions(a: string, b: string): number {
  const left = semverParts(a);
  const right = semverParts(b);
  for (let index = 0; index < 3; index += 1) {
    const x = left[index] ?? 0;
    const y = right[index] ?? 0;
    // 各桁を数として比べる（"10" > "9"）。等しいときは -0 を作らず 0 を返す
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** "x.y.z" を 3 つの数にする。形が違えば黙って比べず投げる。 */
function semverParts(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) throw new Error(`版は x.y.z の形で指定してください: ${JSON.stringify(version)}`);
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (!parts.every((part) => Number.isSafeInteger(part))) {
    throw new Error(`版の桁が大きすぎます: ${JSON.stringify(version)}`);
  }
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/**
 * login status の出力（stdout と stderr をつないだもの）を読む:
 * "Logged in using ChatGPT" → chatgpt / "Logged in using an API key ..." → api_key /
 * "Not logged in" → none / それ以外 → unknown
 */
export function parseLoginStatus(text: string): LoginMethod {
  // "Not logged in" は "logged in" を含むので先に見る
  if (/not logged in/i.test(text)) return 'none';
  if (/logged in using chatgpt/i.test(text)) return 'chatgpt';
  if (/logged in using (?:an? )?api[\s_-]?key/i.test(text)) return 'api_key';
  // 読めないものを ChatGPT とは見なさない
  return 'unknown';
}

export type CatalogModel = {
  found: boolean;
  efforts: string[];
  defaultEffort: string | null;
  supportsVerbosity: boolean | null;
  defaultVerbosity: string | null;
};

/**
 * `codex debug models` の JSON（{ models: [{ slug, supported_reasoning_levels: [{effort}], default_reasoning_level,
 * support_verbosity, default_verbosity, ... }] }）から1つのモデルを引く。
 * JSON として読めなければ投げる。モデルが無ければ found: false（ほかは空・null）。
 * base_instructions などの大きな欄は読まない・返さない。
 */
export function catalogModel(json: string, slug: string): CatalogModel {
  const parsed: unknown = JSON.parse(json);
  const models = isRecord(parsed) ? parsed.models : undefined;
  if (!Array.isArray(models)) {
    // JSON ではあるが形が違う。「モデルが無い」と取り違えず、形の変化として知らせる
    throw new Error('モデルのカタログの形が想定と違います（models の配列がありません）');
  }

  // slug は完全一致。大きな欄（base_instructions など）は読まない
  const entry: unknown = models.find((model) => isRecord(model) && model.slug === slug);
  if (!isRecord(entry)) {
    return { found: false, efforts: [], defaultEffort: null, supportsVerbosity: null, defaultVerbosity: null };
  }

  const levels: unknown = entry.supported_reasoning_levels;
  const efforts = Array.isArray(levels)
    ? levels.flatMap((level: unknown) => (isRecord(level) && typeof level.effort === 'string' ? [level.effort] : []))
    : [];
  return {
    found: true,
    efforts,
    defaultEffort: typeof entry.default_reasoning_level === 'string' ? entry.default_reasoning_level : null,
    supportsVerbosity: typeof entry.support_verbosity === 'boolean' ? entry.support_verbosity : null,
    defaultVerbosity: typeof entry.default_verbosity === 'string' ? entry.default_verbosity : null,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export type PreflightResult = {
  cliVersion: string | null;
  login: LoginMethod;
  catalog: CatalogModel | null;
  problems: string[];
};

export type PreflightDeps = {
  run: ShortRun;
  /** sanitizedEnv を通した子の環境 */
  env: NodeJS.ProcessEnv;
  /** 親の中断。aborted なら次のコマンドを起こさず、problems に「中断された」を入れて返す */
  abortSignal?: AbortSignal;
  /** ファイルの有無（既定は existsSync）。グローバルの AGENTS.md の検査に使う。テストで差し替える */
  fileExists?: (path: string) => boolean;
};

/**
 * Codex がユーザー設定とは別に読み、--ignore-user-config でも project_doc_max_bytes=0 でも消えない
 * グローバルの指示ファイル（CODEX_HOME 直下。CODEX_HOME が無ければ HOME/.codex）。
 * どちらかがあれば、執筆の Astra へユーザーの開発用の指示が混ざるので、preflight は止める。
 */
export const GLOBAL_INSTRUCTION_FILES: readonly string[] = ['AGENTS.md', 'AGENTS.override.md'];

/**
 * env から CODEX_HOME を決める（CODEX_HOME、無ければ HOME/.codex。どちらも無ければ null）。
 * 空文字は「未設定」と見なす（Codex も空の CODEX_HOME を指定として扱わない前提で、HOME へ倒す）。
 */
export function codexHomeOf(env: NodeJS.ProcessEnv): string | null {
  const explicit = env.CODEX_HOME;
  if (explicit !== undefined && explicit !== '') return explicit;
  const home = env.HOME;
  if (home !== undefined && home !== '') return join(home, '.codex');
  return null;
}

/**
 * グローバルの指示ファイルのうち、実在するもののパス（GLOBAL_INSTRUCTION_FILES の順）。
 * 有無を見るだけで、読まない・動かさない・消さない。CODEX_HOME を決められなければ（env に HOME も無い）空。
 * preflight と doctor の isolation が同じ判定を使う。
 */
export function existingGlobalInstructionFiles(
  env: NodeJS.ProcessEnv,
  fileExists: (path: string) => boolean = existsSync,
): string[] {
  const home = codexHomeOf(env);
  if (home === null) return [];
  return GLOBAL_INSTRUCTION_FILES.map((name) => join(home, name)).filter((path) => fileExists(path));
}

/**
 * グローバルの指示ファイルがあるときの案内。パスを示し、Astra へ注入されること・設定では消せないこと・
 * 執筆の間だけ一時的に別の場所へ移すことを書く。こちらはファイルに触れない（削除も移動も勧めない・しない）。
 */
export function globalInstructionAdvice(paths: readonly string[]): string {
  return (
    `Codex のグローバルの指示ファイルがあります: ${paths.join('、')}。` +
    'Codex は --ignore-user-config や project_doc_max_bytes=0 を付けてもこのファイルを読み、' +
    '「# AGENTS.md instructions」としてモデルへの入力へ注入するため、執筆の Astra へ開発用の指示が混ざります（設定では防げません）。' +
    '執筆の間だけ、ご自身でこのファイルを別の場所へ一時的に移し、終わったら元へ戻してください。' +
    'こちらはこのファイルに触れません（有無を確かめるだけです）。'
  );
}

/**
 * CLI の版が必要な版より古いときの文面（preflight と doctor の cli-version が同じものを出す）。
 * 更新のしかた（npm で入れた場合）と、自動では更新しないことを示す。手順は docs/story-authoring.md §3。
 */
export function outdatedCliMessage(version: string, minimum: string): string {
  return (
    `Codex CLI の版が古すぎます（${version} < 必要な ${minimum} 以上）。` +
    'この経路は CLI を自動では更新しません。' +
    'npm で入れた場合は `npm install -g @openai/codex@<版>`（<版> は必要な版以上で、動作を確かめた版）でご自身で更新してください。' +
    '手順は docs/story-authoring.md §3。'
  );
}

/** 短い確認コマンドの timeout。どれも推論しないので、固まったときだけ止める。 */
const SHORT_TIMEOUT_MS = 60_000;
/** problems に載せる、コマンド出力の先頭の長さ（文字数） */
const OUTPUT_HEAD_CHARS = 200;

const outputHead = (text: string): string => {
  const chars = [...text.trim()];
  return chars.length > OUTPUT_HEAD_CHARS ? `${chars.slice(0, OUTPUT_HEAD_CHARS).join('')}…` : chars.join('');
};

/** 中断を受けたことを、各コマンドの失敗と取り違えず、preflight の外へ運ぶための内部の印。 */
class PreflightInterrupted extends Error {}

const INTERRUPTED_PROBLEM = '中断されたので、以降の確認を実行していません。';

export async function preflight(
  config: WriterConfig,
  request: { effort: string },
  deps: PreflightDeps,
): Promise<PreflightResult> {
  const problems: string[] = [];
  const options = { env: deps.env, timeoutMs: SHORT_TIMEOUT_MS, abortSignal: deps.abortSignal };

  let cliVersion: string | null = null;
  let login: LoginMethod = 'unknown';
  let catalog: CatalogModel | null = null;

  const assertNotInterrupted = (): void => {
    if (deps.abortSignal?.aborted === true) throw new PreflightInterrupted();
  };

  // ShortRun は失敗を error に入れて返す約束だが、投げられても止まらず problems に残す
  const exec = async (args: readonly string[]): Promise<ShortResult> => {
    // コマンドを起こす前に中断を見る（中断済みなら起こさない）
    assertNotInterrupted();
    let result: ShortResult;
    try {
      result = await deps.run(args, options);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      result = { exitCode: null, stdout: '', stderr: '', error: reason };
    }
    // 実行中に中断されたなら、結果（error: interrupted など）をそのコマンド自体の失敗として案内しない
    assertNotInterrupted();
    return result;
  };
  /** 実行できなかった（spawn の失敗・timeout）なら、その説明。実行できたなら null */
  const notRun = (label: string, result: ShortResult): string | null =>
    result.error === null ? null : `${label} を実行できませんでした: ${result.error}`;

  try {
    assertNotInterrupted();

    // 0. グローバルの指示ファイル。安く確かめられるので、codex を起こす前に見る。あれば何も起こさず止める
    const globalFiles = existingGlobalInstructionFiles(deps.env, deps.fileExists);
    if (globalFiles.length > 0) {
      problems.push(globalInstructionAdvice(globalFiles));
      return { cliVersion, login, catalog, problems };
    }

    // 1. CLI の版
    const versionResult = await exec(versionArgs());
    const versionNotRun = notRun('codex --version', versionResult);
    if (versionNotRun !== null) {
      // 実行ファイルが動かないなら、login status・debug models も同じ理由で落ちる。重ねて並べない
      problems.push(`${versionNotRun}（writer.yaml の cli.command と PATH を確認してください）`);
      return { cliVersion, login, catalog, problems };
    }
    cliVersion = parseCodexVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
    if (versionResult.exitCode !== 0) {
      problems.push(
        `codex --version が exit ${versionResult.exitCode} で終わりました: ${outputHead(versionResult.stderr || versionResult.stdout)}`,
      );
    } else if (cliVersion === null) {
      problems.push(
        `codex --version の出力から版を読めませんでした: ${outputHead(`${versionResult.stdout}\n${versionResult.stderr}`)}`,
      );
    } else if (compareVersions(cliVersion, config.cli.min_version) < 0) {
      problems.push(outdatedCliMessage(cliVersion, config.cli.min_version));
    }

    // 2. ログイン。login status は stderr に出るので stdout と stderr をつないで読む
    login = await checkLogin(config, exec, notRun, problems);

    // 3. モデルカタログ
    catalog = await checkCatalog(config, request, exec, notRun, problems);
  } catch (error) {
    if (!(error instanceof PreflightInterrupted)) throw error;
    // 確かめ終えた分の problems は残し、中断を足す。途中までの結果は信用しない（未確認のものは unknown / null のまま）
    problems.push(INTERRUPTED_PROBLEM);
  }

  return { cliVersion, login, catalog, problems };
}

type Exec = (args: readonly string[]) => Promise<ShortResult>;
type NotRun = (label: string, result: ShortResult) => string | null;

async function checkLogin(
  config: WriterConfig,
  exec: Exec,
  notRun: NotRun,
  problems: string[],
): Promise<LoginMethod> {
  const result = await exec(loginStatusArgs(config.credentials_store));
  const failure = notRun('codex login status', result);
  if (failure !== null) {
    problems.push(failure);
    return 'unknown';
  }

  const text = `${result.stdout}\n${result.stderr}`;
  const method = parseLoginStatus(text);
  if (method === 'chatgpt') {
    // exit が 0 でない「ログイン済み」は矛盾している。確かめられないものは ChatGPT とは見なさない
    if (result.exitCode !== 0) {
      problems.push(`codex login status の結果が食い違っています（exit ${result.exitCode} なのに ChatGPT でログイン済みと出ました）。`);
      return 'unknown';
    }
    return 'chatgpt';
  }
  if (method === 'api_key') {
    problems.push(
      'API キーでログインしているため、実行を中止します（forced_login_method の不一致で CLI がログアウトされる副作用を、切り替えの手段にしないため）。ChatGPT のログインへ戻す操作は、ご自身で `codex login` から行ってください。',
    );
  } else if (method === 'none') {
    problems.push(
      `未ログインです。\`codex login\` で ChatGPT にログインしてください。ログイン済みなのにこう出るときは、writer.yaml の credentials_store（${config.credentials_store}）が実際の保存先と合っていません。`,
    );
  } else {
    problems.push(`codex login status の出力を読めませんでした（exit ${result.exitCode}）: ${outputHead(text)}`);
  }
  return method;
}

async function checkCatalog(
  config: WriterConfig,
  request: { effort: string },
  exec: Exec,
  notRun: NotRun,
  problems: string[],
): Promise<CatalogModel | null> {
  const result = await exec(catalogArgs());
  const failure = notRun('codex debug models', result);
  if (failure !== null) {
    problems.push(failure);
    return null;
  }
  if (result.exitCode !== 0) {
    problems.push(`codex debug models が exit ${result.exitCode} で終わりました: ${outputHead(result.stderr || result.stdout)}`);
    return null;
  }

  let model: CatalogModel;
  try {
    model = catalogModel(result.stdout, config.model);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    problems.push(`codex debug models の出力を読めませんでした: ${reason}`);
    return null;
  }

  if (!model.found) {
    problems.push(
      `モデル ${config.model} が Codex のモデルカタログにありません（writer.yaml の model か、CLI の版を確認してください）。別のモデルへは切り替えません。`,
    );
  } else if (!model.efforts.includes(request.effort)) {
    // 黙って別の effort にしない。対応する一覧を示して止める
    const supported = model.efforts.length > 0 ? model.efforts.join(', ') : '（カタログに一覧がありません）';
    problems.push(
      `reasoning effort "${request.effort}" は ${config.model} が対応する値ではありません。対応する値: ${supported}。別の値へは自動で切り替えません。`,
    );
  }
  return model;
}
