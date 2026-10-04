import type { CredentialsStore, WriterVerbosity } from './config.js';

/**
 * Codex CLI へ渡す引数と環境（純粋関数だけ）。
 *
 * 執筆の Astra へ、リポジトリの設計会話・コーディング指示・ユーザーの開発用設定を渡さないための
 * 隔離はここに集まる。CLI 0.153.4 の実機で次を確かめてある（docs/story-authoring.md §4）:
 *
 * - `--strict-config` は `-c` の未知のキー・未知の値（enum）を推論の前に拒否する。
 *   だから下の上書きは「黙って無視される」ことがない。effort の値と instructions のファイルの有無は
 *   検証しないので、preflight と run の側で見る。
 * - `--ignore-user-config` はユーザー設定の `cli_auth_credentials_store` も読まなくなる。
 *   そのままでは保存済みのログインが見えない（file 扱いになる）ので、この非機密の設定だけを明示する。
 * - `skills.include_instructions=false` と `features.apps=false` で、Skills 一覧とプラグインの推薦が消える。
 * - Astra のカタログ（multi_agent_version v2）が足す `<multi_agent_role>` の開発者指示は、公式の設定では
 *   消せない（features.multi_agent / multi_agent_v2 を切っても残る）。既知の残留として doctor が示し、
 *   実行時にエージェントの起動が起きたらイベント検査で失敗にする。
 *
 * 組み立ては shell の文字列ではなく、spawn に渡す引数の配列。パスに空白・引用符・日本語があっても
 * shell は介在しない。`-c` の値は TOML として読まれるので、文字列は tomlString で引用する。
 */

export const FORCED_LOGIN_METHOD = 'chatgpt';
export const MODEL_PROVIDER = 'openai';

/**
 * doctor の設定検査で使う、存在しないプロバイダ名。CLI は設定をすべて読み・検証したあと、
 * プロバイダの解決で止まる（通信も推論も起きない）。この名前で止まったことが「設定は通った」の印になる。
 */
export const DOCTOR_SENTINEL_PROVIDER = 'velum-doctor-no-inference';

/**
 * 隔離のための固定の上書き（`-c key=value` の value 側まで含む）。順序も契約で、テストの fixture と一致させる。
 * ここに無い機能（MCP サーバ・プラグイン・hooks・記憶など）は --ignore-user-config と下の features で止める。
 */
export const ISOLATION_OVERRIDES: readonly string[] = [
  'approval_policy="never"',
  'project_doc_max_bytes=0',
  'web_search="disabled"',
  'history.persistence="none"',
  'skills.include_instructions=false',
  'features.shell_tool=false',
  'features.unified_exec=false',
  'features.apps=false',
  'features.plugins=false',
  'features.multi_agent=false',
  'features.multi_agent_v2=false',
  'features.hooks=false',
  'features.memories=false',
  'features.image_generation=false',
  'features.view_image=false',
  'features.goals=false',
  'features.tool_suggest=false',
  'features.browser_use=false',
  'features.computer_use=false',
  'tools.update_plan.enabled=false',
  'tools.experimental_request_user_input.enabled=false',
];

export type CodexExecArgsInput = {
  model: string;
  effort: string;
  /** null なら model_verbosity を渡さない（CLI・モデルの既定） */
  verbosity: WriterVerbosity | null;
  credentialsStore: CredentialsStore;
  /** 絶対パス。model_instructions_file として渡す */
  instructionsFile: string;
  /** 絶対パス。--output-last-message の書き先 */
  outputLastMessage: string;
  /** 絶対パス。Git リポジトリの外の、実行ごとの空の作業ディレクトリ（--cd） */
  workdir: string;
  /** 既定は MODEL_PROVIDER。doctor の設定検査だけが DOCTOR_SENTINEL_PROVIDER を渡す */
  provider?: string;
};

/**
 * `codex exec` の引数（先頭は 'exec'、最後は stdin を読む '-'）。順序は次のとおりで固定:
 *
 *   exec --ignore-user-config --strict-config --model <model> --sandbox read-only
 *   --skip-git-repo-check --ephemeral --json --color never --cd <workdir>
 *   --output-last-message <out>
 *   -c forced_login_method="chatgpt" -c model_provider="<provider>"
 *   -c cli_auth_credentials_store="<store>" -c model_reasoning_effort="<effort>"
 *   [-c model_verbosity="<verbosity>"]
 *   -c model_instructions_file=<tomlString(instructionsFile)>
 *   ...ISOLATION_OVERRIDES をそれぞれ -c で...
 *   -
 *
 * resume / fork / --last / --dangerously-* / --ignore-rules / --approve-for-me は決して含めない。
 */
export function codexExecArgs(input: CodexExecArgsInput): string[] {
  return [
    'exec',
    '--ignore-user-config',
    '--strict-config',
    '--model',
    input.model,
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '--ephemeral',
    '--json',
    '--color',
    'never',
    '--cd',
    input.workdir,
    '--output-last-message',
    input.outputLastMessage,
    ...configFlags(input.provider ?? MODEL_PROVIDER, input),
    '-',
  ];
}

/**
 * exec と prompt-input が共有する `-c` の並び（認証 → provider → store → effort → [verbosity] →
 * instructions → ISOLATION_OVERRIDES）。2つの経路で値がずれると、doctor が見る「隔離の近似」が
 * 本番の exec と別物になるので、組み立てはここ1か所にする。
 */
function configFlags(
  provider: string,
  input: Pick<
    CodexExecArgsInput,
    'effort' | 'verbosity' | 'credentialsStore' | 'instructionsFile'
  >,
): string[] {
  const overrides = [
    `forced_login_method=${tomlString(FORCED_LOGIN_METHOD)}`,
    `model_provider=${tomlString(provider)}`,
    `cli_auth_credentials_store=${tomlString(input.credentialsStore)}`,
    `model_reasoning_effort=${tomlString(input.effort)}`,
  ];
  if (input.verbosity !== null) {
    overrides.push(`model_verbosity=${tomlString(input.verbosity)}`);
  }
  overrides.push(
    `model_instructions_file=${tomlString(input.instructionsFile)}`,
    ...ISOLATION_OVERRIDES,
  );
  return overrides.flatMap((override) => ['-c', override]);
}

/** 対になっていないサロゲート（UTF-16 のコード単位で見る） */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * TOML の基本文字列として引用する。JSON の文字列表記は TOML の basic string と互換
 * （\" \\ \n \t \uXXXX）なので JSON.stringify で足りる。日本語はそのまま（TOML は UTF-8）。
 */
export function tomlString(value: string): string {
  // 対になっていないサロゲートは TOML の文字（Unicode スカラー値）ではない。JSON.stringify は
  // \uD800 のような形で出すが、TOML としては不正で、CLI がその -c の値をどう読むかは保証できない
  // （別の値として黙って通る恐れがある）。だから引用せずに落とす。
  if (LONE_SURROGATE.test(value)) {
    throw new Error('TOML の文字列にできない文字（対になっていないサロゲート）が含まれています');
  }
  // JSON は U+007F（DEL）を生のまま出すが、TOML の basic string では制御文字として必ずエスケープが要る。
  return JSON.stringify(value).replaceAll('\u007f', '\\u007f');
}

/**
 * 子プロセスへ渡さない環境変数か。API キーと API endpoint の上書きを外す:
 * `OPENAI_` / `AZURE_OPENAI_` で始まるもの、`CODEX_API_KEY`、`CODEX_` で始まり `BASE_URL` で終わるもの、
 * `_API_KEY` / `_API_TOKEN` で終わるもの（Velum の旧経路の鍵も Codex へは要らない）。
 * `CODEX_HOME` は消さない（保存済みの認証の場所。動かさない）。
 */
export function isRemovedEnvKey(key: string): boolean {
  // Windows の環境変数名は大文字小文字を区別しない。外す側へ倒して、大文字に揃えて判定する。
  const name = key.toUpperCase();
  if (name.startsWith('OPENAI_') || name.startsWith('AZURE_OPENAI_')) return true;
  if (name === 'CODEX_API_KEY') return true;
  if (name.startsWith('CODEX_') && name.endsWith('BASE_URL')) return true;
  return name.endsWith('_API_KEY') || name.endsWith('_API_TOKEN');
}

/**
 * 子プロセス用の環境の**複製**を返す。親の環境（引数）は変えない。
 * removed は外した変数の名前（値は返さない・記録しない）を名前順で。
 */
export function sanitizedEnv(parent: NodeJS.ProcessEnv): {
  env: NodeJS.ProcessEnv;
  removed: string[];
} {
  const env: NodeJS.ProcessEnv = {};
  const removed: string[] = [];
  for (const [key, value] of Object.entries(parent)) {
    // 未設定（undefined）は、子へ渡す変数でも外した変数でもない。
    if (value === undefined) continue;
    if (isRemovedEnvKey(key)) removed.push(key);
    else env[key] = value;
  }
  // 値は返さない・記録しない。名前だけを、実行のたびに同じ順で。
  return { env, removed: removed.sort() };
}

/**
 * `codex login status` の引数。exec と同じ認証の上書き（forced_login_method と credentials_store）を付けて、
 * exec が実際に使う認証の経路を確かめる。
 */
export function loginStatusArgs(credentialsStore: CredentialsStore): string[] {
  return [
    'login',
    'status',
    '-c',
    `forced_login_method=${tomlString(FORCED_LOGIN_METHOD)}`,
    '-c',
    `cli_auth_credentials_store=${tomlString(credentialsStore)}`,
  ];
}

/** `codex --version` */
export function versionArgs(): string[] {
  return ['--version'];
}

/** `codex exec --help` */
export function execHelpArgs(): string[] {
  return ['exec', '--help'];
}

/** `codex debug models`（モデルカタログ。推論しない） */
export function catalogArgs(): string[] {
  return ['debug', 'models'];
}

/**
 * `codex debug prompt-input` の引数（推論しない）。exec と同じ -c 上書き（認証・provider・effort・
 * verbosity・instructions・ISOLATION_OVERRIDES）と `-c model="<model>"` を付け、最後に印の文字列
 * PROMPT_INPUT_MARKER を置く。prompt-input は --ignore-user-config を受けないので、結果は近似である。
 */
export const PROMPT_INPUT_MARKER = 'VELUM-ISOLATION-PREVIEW';
export function promptInputArgs(
  input: Omit<CodexExecArgsInput, 'outputLastMessage' | 'workdir' | 'provider'>,
): string[] {
  return [
    'debug',
    'prompt-input',
    '-c',
    `model=${tomlString(input.model)}`,
    ...configFlags(MODEL_PROVIDER, input),
    PROMPT_INPUT_MARKER,
  ];
}

/** exec が必ず受け付けなければならないフラグ（doctor が exec --help と照合する）。 */
export const REQUIRED_EXEC_FLAGS: readonly string[] = [
  '--ignore-user-config',
  '--strict-config',
  '--model',
  '--sandbox',
  '--skip-git-repo-check',
  '--ephemeral',
  '--json',
  '--color',
  '--cd',
  '--output-last-message',
  '--config',
];

/**
 * 記録用に、引数の中の絶対パスを置き換える（run.json と表示。個人のパスを残さない）。
 * replacements は { 置き換える文字列: 置き換え後 }。長いものから順に、すべての出現を置き換える。
 */
export function redactArgs(
  args: readonly string[],
  replacements: Readonly<Record<string, string>>,
): string[] {
  // 長いキーを先に。短いキー（'/a'）が先に置き換わると、長いキー（'/a/run'）が壊れて一致しなくなる。
  // 長さが同じなら文字の順で並べ、オブジェクトのキーの並び順に結果が依らないようにする。
  // 空のキーは「置き換える対象が無い」ものとして飛ばす（split('') は全文字の間に挿入してしまう）。
  const ordered = Object.entries(replacements)
    .filter(([from]) => from.length > 0)
    .sort(([a], [b]) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  // split/join は文字列そのままの置き換え。正規表現や `$&` のような置換パターンとして解釈しない。
  return args.map((arg) => ordered.reduce((text, [from, to]) => text.split(from).join(to), arg));
}
