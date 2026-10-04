import { copyFileSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  DOCTOR_SENTINEL_PROVIDER,
  PROMPT_INPUT_MARKER,
  REQUIRED_EXEC_FLAGS,
  catalogArgs,
  codexExecArgs,
  execHelpArgs,
  loginStatusArgs,
  promptInputArgs,
  sanitizedEnv,
  versionArgs,
} from './codex-command.js';
import type { ShortResult } from './codex-process.js';
import {
  catalogModel,
  compareVersions,
  existingGlobalInstructionFiles,
  globalInstructionAdvice,
  outdatedCliMessage,
  parseCodexVersion,
  parseLoginStatus,
} from './preflight.js';
import { probeAstra, type AuthoringDeps, type RunOutcome } from './run.js';

/**
 * story:doctor — 新しい制作経路が動く状態かを確かめる。**既定では推論を呼ばない。**
 * `--probe` を明示したときだけ、固定の短い入力で Astra を1回呼ぶ（run.ts の probeAstra）。
 * テストのたびに疎通確認を繰り返さない（テストは偽の ShortRun / spawn だけを使う）。
 *
 * 検査（順に。name は表示と テストで使う固定の名前）:
 *   config        writer.yaml が読め、instructions のファイルがある
 *   gitignore     ルートの .gitignore に `.story-runs/` がある
 *   cli-version   `codex --version` が min_version 以上
 *   exec-flags    `codex exec --help` に REQUIRED_EXEC_FLAGS がすべてある
 *   auth          `codex login status`（exec と同じ上書き・同じ sanitizedEnv）が ChatGPT
 *   catalog       モデルがカタログにあり、effort が対応している（verbosity を設定していれば、その対応も）
 *   strict-config 本番と同じ引数一式を、provider だけ DOCTOR_SENTINEL_PROVIDER にして `codex exec --strict-config`。
 *                 stderr が「Model provider `<sentinel>` not found」で終われば ok（全キーが通り、通信の前に止まった）。
 *                 「unknown configuration field」「unknown variant」なら fail。stdout に thread.started が出たら fail
 *   isolation     `codex debug prompt-input`（推論しない）でモデルに見える開発者・ユーザーのブロックを並べる。
 *                 EXPECTED_PROMPT_BLOCKS は ok、KNOWN_RESIDUAL_PROMPT_BLOCKS は warn（公式設定で消せない既知の残留）、
 *                 FORBIDDEN_PROMPT_BLOCKS（Skills・Apps・プラグイン・グローバルの AGENTS.md の指示）は fail、それ以外は warn。
 *                 prompt-input は --ignore-user-config を受けないので、結果は近似である（detail に書く）。
 *                 加えて、$CODEX_HOME 直下のグローバルの指示ファイル（AGENTS.md・AGENTS.override.md）が
 *                 実在すれば、prompt-input の結果によらず fail（設定では消せず、Astra へ届くため。ファイルの有無だけを見る）
 *   env           子の環境から外す変数の名前（値は出さない）。常に ok
 *
 * fail が1つでもあれば ok: false。probe は fail が無いときだけ走る（warn は止めない）。
 *
 * 中断（deps.abortSignal）: どの ShortRun にも abortSignal を渡す。aborted になったら、まだ始めていない検査は
 * 起こさず、status 'fail'・detail '中断されたので実行していない' で報告する（probe も走らない）。
 */

export const DOCTOR_CHECK_NAMES = [
  'config',
  'gitignore',
  'cli-version',
  'exec-flags',
  'auth',
  'catalog',
  'strict-config',
  'isolation',
  'env',
] as const;
export type DoctorCheckName = (typeof DOCTOR_CHECK_NAMES)[number];

export type DoctorCheck = {
  name: DoctorCheckName;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
};

export type DoctorReport = {
  ok: boolean;
  checks: DoctorCheck[];
  cliVersion: string | null;
};

export const EXPECTED_PROMPT_BLOCKS: readonly string[] = [
  'permissions instructions',
  'collaboration_mode',
  'environment_context',
];
export const KNOWN_RESIDUAL_PROMPT_BLOCKS: readonly string[] = ['multi_agent_role', 'multi_agent_mode'];
/**
 * モデルに見えてはいけないブロック。'agents_md' は、グローバルの AGENTS.md（$CODEX_HOME/AGENTS.md・
 * AGENTS.override.md）が user のメッセージとして届いたもの（`# AGENTS.md instructions` で始まる文。
 * 実機では content_item_kinds が 'agents_md.instructions'）。タグ名のブロックではないので、promptInputBlocks が
 * この名前に分類する。
 */
export const FORBIDDEN_PROMPT_BLOCKS: readonly string[] = [
  'skills_instructions',
  'apps_instructions',
  'plugins_instructions',
  'recommended_plugins',
  'agents_md',
];

/** グローバルの AGENTS.md のブロックの印として promptInputBlocks が返す名前。 */
const AGENTS_MD_BLOCK = 'agents_md';
/** グローバルの AGENTS.md のブロックは、この見出しで始まる（`# AGENTS.md instructions` または `... for <dir>`）。 */
const AGENTS_MD_HEADING = /^\s*# AGENTS\.md instructions/i;

/**
 * prompt-input の JSON（[{ type, role, content: [{ type, text }] }]）から、各テキストの先頭のタグ名を並べる
 * （`<skills_instructions>\n...` → 'skills_instructions'、`<permissions instructions>` → 'permissions instructions'）。
 * グローバルの AGENTS.md のブロック（`# AGENTS.md instructions` で始まる文。または content_item_kinds
 * （internal_chat_message_metadata_passthrough）が 'agents_md' を示す部分）は 'agents_md'。
 * タグで始まらないテキストは、PROMPT_INPUT_MARKER と一致すれば markerFound に数え、そうでなければ '(text)'。
 */
export function promptInputBlocks(json: string): { blocks: string[]; markerFound: boolean } {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    throw new Error('prompt-input の出力が配列ではありません（形が想定と違います）');
  }
  const blocks: string[] = [];
  let markerFound = false;
  for (const item of parsed) {
    // メッセージ以外の要素（content を持たないもの）は、モデルに見える文ではないので数えない
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    const kinds = contentItemKinds(item);
    // content と同じ数なら、位置で対応づける。合わないときは、項目に1つでも agents_md があれば項目として1つ数える
    const aligned = kinds.length === item.content.length;
    let agentsMdCounted = false;
    item.content.forEach((part: unknown, index) => {
      if (!isRecord(part) || typeof part.text !== 'string') return;
      const kindSaysAgents = aligned && isAgentsMdKind(kinds[index]);
      if (kindSaysAgents || AGENTS_MD_HEADING.test(part.text)) {
        blocks.push(AGENTS_MD_BLOCK);
        agentsMdCounted = true;
        return;
      }
      const tag = LEADING_TAG.exec(part.text);
      if (tag?.[1] !== undefined) blocks.push(tag[1]);
      else if (part.text.trim() === PROMPT_INPUT_MARKER) markerFound = true;
      else blocks.push('(text)');
    });
    if (!aligned && !agentsMdCounted && kinds.some(isAgentsMdKind)) blocks.push(AGENTS_MD_BLOCK);
  }
  return { blocks, markerFound };
}

/** 項目の internal_chat_message_metadata_passthrough.content_item_kinds（文字列だけ）。無ければ空。 */
function contentItemKinds(item: Record<string, unknown>): Array<string | undefined> {
  const metadata = item.internal_chat_message_metadata_passthrough;
  const kinds = isRecord(metadata) ? metadata.content_item_kinds : undefined;
  if (!Array.isArray(kinds)) return [];
  return kinds.map((kind: unknown) => (typeof kind === 'string' ? kind : undefined));
}

const isAgentsMdKind = (kind: string | undefined): boolean => kind?.toLowerCase().includes('agents_md') === true;

/** 先頭のタグ。`<permissions instructions>` のように、名前に空白があってもよい。 */
const LEADING_TAG = /^\s*<([^<>\n]+)>/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// ── 検査の道具 ─────────────────────────────────────────────

/** 短い確認コマンドの timeout。どれも推論しないので、固まったときだけ止める。 */
const SHORT_TIMEOUT_MS = 60_000;
/** detail に載せる、コマンド出力の先頭の長さ（文字数） */
const OUTPUT_HEAD_CHARS = 200;
/** strict-config の検査で、instructions の写しと -o の書き先に使う名前（作業ディレクトリの中） */
const DOCTOR_INSTRUCTIONS_COPY = 'instructions.txt';
const DOCTOR_LAST_MESSAGE = 'last-message.txt';
/** これらの行があれば、.story-runs/ は無視されている */
const GITIGNORE_ENTRIES: ReadonlySet<string> = new Set(['.story-runs/', '/.story-runs/', '.story-runs', '/.story-runs']);
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const outputHead = (text: string): string => {
  const chars = [...text.trim()];
  return chars.length > OUTPUT_HEAD_CHARS ? `${chars.slice(0, OUTPUT_HEAD_CHARS).join('')}…` : chars.join('');
};
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const result = (name: DoctorCheckName, status: DoctorCheck['status'], detail: string): DoctorCheck => ({
  name,
  status,
  detail,
});

/**
 * 検査の1回の実行。ShortRun が投げても止まらず、error に入れて返す（検査は互いに独立）。
 * 親の中断（deps.abortSignal）を ShortRun へ渡す。中断のあとの失敗は、その検査自体の不具合として案内しないよう、
 * error に「中断された」を添える。
 */
async function runShort(
  deps: AuthoringDeps,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
  extra: { cwd?: string; stdin?: string } = {},
): Promise<ShortResult> {
  let outcome: ShortResult;
  try {
    outcome = await deps.shortRun(args, { env, timeoutMs: SHORT_TIMEOUT_MS, abortSignal: deps.abortSignal, ...extra });
  } catch (error) {
    outcome = { exitCode: null, stdout: '', stderr: '', error: reasonOf(error) };
  }
  if (outcome.error !== null && isAborted(deps)) return { ...outcome, error: `中断された（${outcome.error}）` };
  return outcome;
}

const isAborted = (deps: AuthoringDeps): boolean => deps.abortSignal?.aborted === true;

/** 中断のため始めなかった検査の detail。 */
const INTERRUPTED_DETAIL = '中断されたので実行していない';

// ── 個々の検査 ─────────────────────────────────────────────

/** config: writer.yaml は読み込み済み（deps.config）。instructions のファイルが読めて、空でない。 */
function checkConfig(deps: AuthoringDeps): DoctorCheck {
  const { config } = deps;
  const path = join(deps.root, config.instructions);
  let bytes: Buffer;
  try {
    if (!statSync(path).isFile()) return result('config', 'fail', `instructions がファイルではありません: ${path}`);
    bytes = readFileSync(path);
  } catch (error) {
    return result('config', 'fail', `instructions を読めません: ${path}（${reasonOf(error)}）`);
  }
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    return result('config', 'fail', `instructions が UTF-8 として読めません: ${path}`);
  }
  if (text.trim() === '') return result('config', 'fail', `instructions が空です: ${path}`);
  if (text.includes('\0')) return result('config', 'fail', `instructions に NUL 文字が含まれています: ${path}`);
  const verbosity = config.verbosity ?? '未指定（CLI の既定）';
  return result(
    'config',
    'ok',
    `writer.yaml を読み込めた（model ${config.model}・effort ${config.reasoning_effort}・verbosity ${verbosity}）。instructions: ${config.instructions}（${bytes.byteLength} バイト）`,
  );
}

function checkGitignore(deps: AuthoringDeps): DoctorCheck {
  const path = join(deps.root, '.gitignore');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return result('gitignore', 'fail', `.gitignore を読めません（原稿と実行記録を公開リポジトリへ入れないために要ります）: ${path}（${reasonOf(error)}）`);
  }
  const listed = text.split('\n').some((line) => GITIGNORE_ENTRIES.has(line.replace(/\r$/, '').trim()));
  return listed
    ? result('gitignore', 'ok', '.gitignore に .story-runs/ がある')
    : result('gitignore', 'fail', '.gitignore に `.story-runs/` の行がありません（原稿と実行記録が公開リポジトリへ入りかねません）。行を足してください。');
}

async function checkCliVersion(
  deps: AuthoringDeps,
  env: NodeJS.ProcessEnv,
): Promise<{ check: DoctorCheck; version: string | null }> {
  const { min_version: minimum, command } = deps.config.cli;
  const run = await runShort(deps, env, versionArgs());
  if (run.error !== null) {
    // 中断されたなら、cli.command や PATH の誤りではない。案内を付けない
    const hint = isAborted(deps) ? '' : '（cli.command と PATH を確認してください）';
    return {
      version: null,
      check: result('cli-version', 'fail', `${command} --version を実行できません: ${run.error}${hint}`),
    };
  }
  const text = `${run.stdout}\n${run.stderr}`;
  const version = parseCodexVersion(text);
  if (run.exitCode !== 0) {
    return {
      version,
      check: result('cli-version', 'fail', `${command} --version が exit ${run.exitCode} で終わりました: ${outputHead(run.stderr || run.stdout)}`),
    };
  }
  if (version === null) {
    return { version, check: result('cli-version', 'fail', `版を読めません: ${outputHead(text)}`) };
  }
  if (compareVersions(version, minimum) < 0) {
    return {
      version,
      check: result('cli-version', 'fail', outdatedCliMessage(version, minimum)),
    };
  }
  return { version, check: result('cli-version', 'ok', `codex-cli ${version}（必要な ${minimum} 以上）`) };
}

async function checkExecFlags(deps: AuthoringDeps, env: NodeJS.ProcessEnv): Promise<DoctorCheck> {
  const run = await runShort(deps, env, execHelpArgs());
  if (run.error !== null) return result('exec-flags', 'fail', `codex exec --help を実行できません: ${run.error}`);
  if (run.exitCode !== 0) {
    return result('exec-flags', 'fail', `codex exec --help が exit ${run.exitCode} で終わりました: ${outputHead(run.stderr || run.stdout)}`);
  }
  const text = `${run.stdout}\n${run.stderr}`;
  // `--config` が `--strict-config` の一部に当たらないよう、前後が語の文字でないものだけを数える
  const missing = REQUIRED_EXEC_FLAGS.filter(
    (flag) => !new RegExp(`(?<![\\w-])${escapeRegExp(flag)}(?![\\w-])`).test(text),
  );
  return missing.length > 0
    ? result('exec-flags', 'fail', `codex exec が受け付けないフラグがあります: ${missing.join(', ')}（CLI の版が合っていません）`)
    : result('exec-flags', 'ok', `必要な ${REQUIRED_EXEC_FLAGS.length} 個のフラグがある`);
}

async function checkAuth(deps: AuthoringDeps, env: NodeJS.ProcessEnv): Promise<DoctorCheck> {
  const store = deps.config.credentials_store;
  const run = await runShort(deps, env, loginStatusArgs(store));
  if (run.error !== null) return result('auth', 'fail', `codex login status を実行できません: ${run.error}`);
  // login status は stderr に出る。stdout と stderr をつないで読む
  const text = `${run.stdout}\n${run.stderr}`;
  const method = parseLoginStatus(text);
  if (method === 'chatgpt' && run.exitCode === 0) {
    return result('auth', 'ok', `ChatGPT でログイン済み（credentials_store: ${store}）`);
  }
  switch (method) {
    case 'chatgpt':
      return result('auth', 'fail', `login status の結果が食い違っています（exit ${run.exitCode} なのに ChatGPT でログイン済みと出ました）`);
    case 'api_key':
      return result('auth', 'fail', 'API キーでログインしています。この経路は ChatGPT のログインだけを使います（ご自身で `codex login` から ChatGPT のログインへ戻してください）');
    case 'none':
      return result('auth', 'fail', `未ログインです。\`codex login\` で ChatGPT にログインしてください（ログイン済みなのにこう出るなら、writer.yaml の credentials_store: ${store} が実際の保存先と合っていません）`);
    case 'unknown':
      return result('auth', 'fail', `login status の出力を読めません（exit ${run.exitCode}）: ${outputHead(text)}`);
  }
}

async function checkCatalog(deps: AuthoringDeps, env: NodeJS.ProcessEnv): Promise<DoctorCheck> {
  const { config } = deps;
  const run = await runShort(deps, env, catalogArgs());
  if (run.error !== null) return result('catalog', 'fail', `codex debug models を実行できません: ${run.error}`);
  if (run.exitCode !== 0) {
    return result('catalog', 'fail', `codex debug models が exit ${run.exitCode} で終わりました: ${outputHead(run.stderr || run.stdout)}`);
  }
  let model: ReturnType<typeof catalogModel>;
  try {
    model = catalogModel(run.stdout, config.model);
  } catch (error) {
    return result('catalog', 'fail', `codex debug models の出力を読めません: ${reasonOf(error)}`);
  }
  if (!model.found) {
    return result('catalog', 'fail', `モデル ${config.model} が Codex のモデルカタログにありません（writer.yaml の model か CLI の版を確認してください。別のモデルへは切り替えません）`);
  }
  const effort = config.reasoning_effort;
  if (!model.efforts.includes(effort)) {
    const supported = model.efforts.length > 0 ? model.efforts.join(', ') : '（カタログに一覧がありません）';
    return result('catalog', 'fail', `reasoning effort "${effort}" は ${config.model} が対応する値ではありません。対応する値: ${supported}（別の値へは自動で切り替えません）`);
  }
  let verbosityNote = 'verbosity は未指定（CLI の既定）';
  if (config.verbosity !== null) {
    if (model.supportsVerbosity !== true) {
      return result('catalog', 'fail', `verbosity "${config.verbosity}" を設定していますが、${config.model} が対応することをカタログから確認できません（support_verbosity: ${String(model.supportsVerbosity)}）`);
    }
    verbosityNote = `verbosity "${config.verbosity}" に対応`;
  }
  // カタログにあることは、アカウントで使えることの保証ではない（それは --probe で確かめる）
  return result('catalog', 'ok', `${config.model} は effort "${effort}" に対応（対応: ${model.efforts.join(', ')}）。${verbosityNote}。アカウントで使えるかは --probe で確かめる`);
}

/**
 * strict-config: 本番と同じ引数一式を、provider だけ存在しない名前にして `codex exec --strict-config` へ渡す。
 * CLI は全設定を読んで検証したあと provider の解決で止まる（通信も推論も起きない）ので、その止まり方で
 * 「全キーが通った」と判る。instructions は作業ディレクトリへ写して渡す（本物の run と同じく、ファイルを指す）。
 */
async function checkStrictConfig(deps: AuthoringDeps, env: NodeJS.ProcessEnv): Promise<DoctorCheck> {
  const { config } = deps;
  let dir: string | null = null;
  let check: DoctorCheck;
  try {
    dir = deps.makeWorkdir();
    const instructionsCopy = join(dir, DOCTOR_INSTRUCTIONS_COPY);
    try {
      copyFileSync(join(deps.root, config.instructions), instructionsCopy);
    } catch (error) {
      throw new Error(`instructions の写しを作れません（config の検査を見てください）: ${reasonOf(error)}`, { cause: error });
    }
    const args = codexExecArgs({
      model: config.model,
      effort: config.reasoning_effort,
      verbosity: config.verbosity,
      credentialsStore: config.credentials_store,
      instructionsFile: instructionsCopy,
      outputLastMessage: join(dir, DOCTOR_LAST_MESSAGE),
      workdir: dir,
      provider: DOCTOR_SENTINEL_PROVIDER,
    });
    check = evaluateStrictConfig(await runShort(deps, env, args, { cwd: dir, stdin: '' }));
  } catch (error) {
    check = result('strict-config', 'fail', reasonOf(error));
  }
  if (dir !== null) {
    try {
      deps.removeWorkdir(dir);
    } catch (error) {
      // 消せなかったことは、検査の結果に添えて残す（ok を warn に落とす）
      const note = `検査用の作業ディレクトリを消せませんでした（${dir}）: ${reasonOf(error)}`;
      check = result('strict-config', check.status === 'ok' ? 'warn' : check.status, `${check.detail} / ${note}`);
    }
  }
  return check;
}

const SENTINEL_NOT_FOUND = new RegExp(`Model provider \`${escapeRegExp(DOCTOR_SENTINEL_PROVIDER)}\` not found`);
const CONFIG_REJECTED = /unknown configuration field|unknown variant|Error loading config/i;
const THREAD_STARTED = /"type"\s*:\s*"thread\.started"/;

function evaluateStrictConfig(run: ShortResult): DoctorCheck {
  if (run.error !== null) return result('strict-config', 'fail', `検査の実行に失敗しました: ${run.error}`);
  if (THREAD_STARTED.test(run.stdout)) {
    return result('strict-config', 'fail', '検査のはずが、推論が始まりました（stdout に thread.started）。CLI の動作が想定と違います。以後 story:draft を実行しないでください');
  }
  const rejected = run.stderr.split(/\r?\n/).find((line) => CONFIG_REJECTED.test(line));
  if (rejected !== undefined) {
    return result('strict-config', 'fail', `Codex が設定の上書きを拒否しました（CLI の版の変更が疑われます）: ${outputHead(rejected)}`);
  }
  if (SENTINEL_NOT_FOUND.test(run.stderr)) {
    return result('strict-config', 'ok', '全キー・全値が --strict-config を通り、provider の解決で止まった（通信も推論もしていない）');
  }
  return result('strict-config', 'fail', `想定外の終わり方です（exit ${run.exitCode}）。provider の解決で止まる想定でした: ${outputHead(run.stderr || run.stdout)}`);
}

/**
 * isolation: prompt-input（推論しない）で、モデルに見える開発者・ユーザーのブロックを分類する。
 * 本番と同じく、root の外の空の作業ディレクトリで動かす（リポジトリの中で動かすと、本番には無い
 * プロジェクトの文脈が見えうる）。instructions もそのディレクトリの写しを指す。終わったら消す。
 */
async function checkIsolation(deps: AuthoringDeps, env: NodeJS.ProcessEnv): Promise<DoctorCheck> {
  const { config } = deps;
  // グローバルの指示ファイルは設定では消えず、prompt-input の出力にも頼れない（実行できない・形が変わる）。
  // 有無をファイルシステムで直接見て、あれば fail にする（preflight が止めるのと同じ判定）
  const globalFiles = existingGlobalInstructionFiles(env);
  let dir: string | null = null;
  let check: DoctorCheck;
  try {
    dir = deps.makeWorkdir();
    const instructionsCopy = join(dir, DOCTOR_INSTRUCTIONS_COPY);
    try {
      copyFileSync(join(deps.root, config.instructions), instructionsCopy);
    } catch (error) {
      throw new Error(`instructions の写しを作れません（config の検査を見てください）: ${reasonOf(error)}`, { cause: error });
    }
    const run = await runShort(
      deps,
      env,
      promptInputArgs({
        model: config.model,
        effort: config.reasoning_effort,
        verbosity: config.verbosity,
        credentialsStore: config.credentials_store,
        instructionsFile: instructionsCopy,
      }),
      { cwd: dir },
    );
    check = evaluateIsolation(run);
  } catch (error) {
    check = result('isolation', 'warn', `隔離を確認できません: ${reasonOf(error)}${ISOLATION_APPROX}`);
  }
  if (globalFiles.length > 0) {
    check = result('isolation', 'fail', `${globalInstructionAdvice(globalFiles)} / ${check.detail}`);
  }
  if (dir !== null) {
    try {
      deps.removeWorkdir(dir);
    } catch (error) {
      const note = `検査用の作業ディレクトリを消せませんでした（${dir}）: ${reasonOf(error)}`;
      check = result('isolation', check.status === 'ok' ? 'warn' : check.status, `${check.detail} / ${note}`);
    }
  }
  return check;
}

const ISOLATION_APPROX = '（prompt-input は --ignore-user-config を受けないので、結果は近似である）';

function evaluateIsolation(run: ShortResult): DoctorCheck {
  const approx = ISOLATION_APPROX;
  if (run.error !== null) {
    return result('isolation', 'warn', `codex debug prompt-input を実行できず、隔離を確認できません: ${run.error}${approx}`);
  }
  if (run.exitCode !== 0) {
    return result('isolation', 'warn', `codex debug prompt-input が exit ${run.exitCode} で終わり、隔離を確認できません: ${outputHead(run.stderr || run.stdout)}${approx}`);
  }
  let seen: ReturnType<typeof promptInputBlocks>;
  try {
    seen = promptInputBlocks(run.stdout);
  } catch (error) {
    return result('isolation', 'warn', `prompt-input の出力を読めず、隔離を確認できません: ${reasonOf(error)}${approx}`);
  }

  const blocks = [...new Set(seen.blocks)];
  const forbidden = blocks.filter((block) => FORBIDDEN_PROMPT_BLOCKS.includes(block));
  const residual = blocks.filter((block) => KNOWN_RESIDUAL_PROMPT_BLOCKS.includes(block));
  const unknown = blocks.filter(
    (block) =>
      !EXPECTED_PROMPT_BLOCKS.includes(block) &&
      !KNOWN_RESIDUAL_PROMPT_BLOCKS.includes(block) &&
      !FORBIDDEN_PROMPT_BLOCKS.includes(block),
  );
  const listed = `モデルに見えるブロック: ${blocks.join(', ') || '（なし）'}`;

  if (forbidden.length > 0) {
    return result('isolation', 'fail', `モデルに見えてはいけないブロックがあります: ${forbidden.join(', ')}。${listed}${approx}`);
  }
  const notes: string[] = [];
  if (residual.length > 0) {
    notes.push(`公式の設定では消せない既知の残留: ${residual.join(', ')}（実行中にエージェントの起動が起きたらイベント検査で失敗にする）`);
  }
  if (unknown.length > 0) notes.push(`知らないブロック: ${unknown.join(', ')}（内容を確かめること）`);
  if (!seen.markerFound) notes.push('印の文字列が出力に無い（prompt-input の出力が想定と違う可能性）');
  return notes.length > 0
    ? result('isolation', 'warn', `${listed}。${notes.join('。')}${approx}`)
    : result('isolation', 'ok', `${listed}（期待どおり）${approx}`);
}

function checkEnv(removed: readonly string[]): DoctorCheck {
  return result(
    'env',
    'ok',
    removed.length > 0
      ? `子プロセスの環境から外す変数（名前だけ。値は出さない）: ${removed.join(', ')}`
      : '子プロセスの環境から外す変数はない（API キー・endpoint の上書きは設定されていない）',
  );
}

// ── runDoctor ──────────────────────────────────────────────

export async function runDoctor(
  options: { probe: boolean },
  deps: AuthoringDeps,
): Promise<{ report: DoctorReport; probe: RunOutcome | null }> {
  // 子へ渡す環境は、exec と同じ sanitize を通した複製。親の環境は変えない
  const childEnv = sanitizedEnv(deps.env);
  const env = childEnv.env;

  // 検査は互いに独立。1つが失敗しても、残りを全部走らせて報告する（順序は DOCTOR_CHECK_NAMES）。
  // ただし中断（Ctrl-C）されたら、まだ始めていない検査は起こさず、fail（中断）で報告する
  const step = async (name: DoctorCheckName, run: () => DoctorCheck | Promise<DoctorCheck>): Promise<DoctorCheck> =>
    isAborted(deps) ? result(name, 'fail', INTERRUPTED_DETAIL) : await run();

  const configCheck = await step('config', () => checkConfig(deps));
  const gitignoreCheck = await step('gitignore', () => checkGitignore(deps));
  const cliVersion = isAborted(deps)
    ? { check: result('cli-version', 'fail', INTERRUPTED_DETAIL), version: null }
    : await checkCliVersion(deps, env);
  const execFlagsCheck = await step('exec-flags', () => checkExecFlags(deps, env));
  const authCheck = await step('auth', () => checkAuth(deps, env));
  const catalogCheck = await step('catalog', () => checkCatalog(deps, env));
  const strictConfigCheck = await step('strict-config', () => checkStrictConfig(deps, env));
  const isolationCheck = await step('isolation', () => checkIsolation(deps, env));
  const envCheck = await step('env', () => checkEnv(childEnv.removed));

  const checks: DoctorCheck[] = [
    configCheck,
    gitignoreCheck,
    cliVersion.check,
    execFlagsCheck,
    authCheck,
    catalogCheck,
    strictConfigCheck,
    isolationCheck,
    envCheck,
  ];
  const report: DoctorReport = {
    ok: checks.every((check) => check.status !== 'fail'),
    checks,
    cliVersion: cliVersion.version,
  };

  // 推論を呼ぶのは、--probe が明示され、fail が1つも無く、中断されていないときだけ（warn は止めない）
  const probe = options.probe && report.ok && !isAborted(deps) ? await probeAstra({ dryRun: false }, deps) : null;
  return { report, probe };
}
