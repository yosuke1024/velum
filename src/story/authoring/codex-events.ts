/**
 * `codex exec --json` のイベント（JSONL）を読み、失敗を分類する（純粋関数だけ）。
 *
 * `--json` は進捗イベントの形式であって、小説を JSON で書かせる指定ではない。本文は
 * `--output-last-message` のファイルから取る。ここでは本文を読まない。
 *
 * イベントの形（CLI 0.153.x の exec の JSONL）:
 *   {"type":"thread.started","thread_id":"..."}
 *   {"type":"turn.started"}
 *   {"type":"item.started"|"item.updated"|"item.completed","item":{"id":"...","type":"agent_message"|"reasoning"|...}}
 *   {"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":2,...}}
 *   {"type":"turn.failed","error":{"message":"..."}}
 *   {"type":"error","message":"..."}            ← 失敗の通知（turn.completed が続かなければ回復しない失敗）
 *
 * 執筆中に許すアイテムは agent_message と reasoning だけ。item の type が "error" のものは
 * 回復できた注意（再接続など）なので許して数えるが、ほかの種類（command_execution・file_change・
 * mcp_tool_call・web_search・todo_list・collab_agent_tool_call など）は「期待しないツールの呼び出し」で、
 * 本文がそろっていても失敗にする。設定での抑止が主で、この検査は補助である。
 */

export const ALLOWED_ITEM_TYPES: readonly string[] = ['agent_message', 'reasoning'];
/** 許すが、数えて warnings に出すアイテム */
export const NOTICE_ITEM_TYPES: readonly string[] = ['error'];

export type CodexEventSummary = {
  /** 空でない行の数 */
  lines: number;
  /** JSON として読めなかった行の数 */
  parseErrors: number;
  threadId: string | null;
  turnCompleted: boolean;
  /** turn.failed の error.message。turn.failed が無ければ null、あるのに message が無ければ '(理由なし)' */
  turnFailed: string | null;
  /** type: "error" のイベントの message（順に） */
  errors: string[];
  /** item.completed のアイテムの type ごとの件数（item.started だけで終わったものは item.started から数える） */
  itemTypes: Record<string, number>;
  /** ALLOWED_ITEM_TYPES / NOTICE_ITEM_TYPES に無い type（重複なし、出現順） */
  unexpectedItems: string[];
  /** item の type が "error" のアイテムの message（回復できた注意） */
  notices: string[];
  /** 完了した agent_message の数 */
  agentMessages: number;
  /** 最後の turn.completed の usage（数値の欄だけ）。無ければ null */
  usage: Record<string, number> | null;
  /**
   * イベントのどこかに文字列の `model` 欄があれば、その値と場所（例: "turn.completed.model"）。
   * 無ければ null（要求したモデルを写して「確認済み」にはしない）。
   */
  reportedModel: { value: string; source: string } | null;
};

type JsonObject = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** 理由の文面が無いときの印（turnFailed の仕様と同じ）。失敗の合図そのものは落とさず残す。 */
const NO_REASON = '(理由なし)';
const textOrNoReason = (value: unknown): string => {
  const text = asString(value);
  return text !== null && text.trim().length > 0 ? text : NO_REASON;
};

/** turn.failed の error（{ message } か文字列）から理由を取る */
const failureMessage = (error: unknown): string =>
  textOrNoReason(isRecord(error) ? error.message : error);

/** usage の数値の欄だけを残す（null・文字列・入れ子・真偽値は落とす） */
function numericFields(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]),
  );
  return Object.fromEntries(entries);
}

const ITEM_EVENT_TYPES: readonly string[] = ['item.started', 'item.updated', 'item.completed'];

/** JSONL 全体を読む。壊れた行は数えて飛ばす（投げない）。 */
export function summarizeEvents(jsonl: string): CodexEventSummary {
  let lines = 0;
  let parseErrors = 0;
  let threadId: string | null = null;
  let turnCompleted = false;
  let turnFailed: string | null = null;
  const errors: string[] = [];
  // Map で数えて最後にオブジェクトへ移す（アイテムの type が "__proto__" でも壊れない）
  const itemTypes = new Map<string, number>();
  const unexpectedItems: string[] = [];
  const notices: string[] = [];
  let agentMessages = 0;
  let usage: Record<string, number> | null = null;
  let reportedModel: CodexEventSummary['reportedModel'] = null;

  // 同じ id・同じ type のアイテムは、started → updated → completed を通して 1 件と数える
  const countedItems = new Set<string>();
  const completedItems = new Set<string>();
  // id の無いアイテム: started を数え、同じ type の completed はその started の続きと見なす
  const anonymousStarted = new Map<string, number>();

  const countItem = (itemType: string): void => {
    itemTypes.set(itemType, (itemTypes.get(itemType) ?? 0) + 1);
    const allowed = ALLOWED_ITEM_TYPES.includes(itemType) || NOTICE_ITEM_TYPES.includes(itemType);
    if (!allowed && !unexpectedItems.includes(itemType)) unexpectedItems.push(itemType);
  };

  const noteModel = (value: unknown, source: string): void => {
    const model = asString(value);
    if (reportedModel === null && model !== null && model.trim().length > 0) {
      reportedModel = { value: model, source };
    }
  };

  for (const rawLine of jsonl.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    lines += 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // 壊れた行は捨てるのではなく件数に残す（呼び出し側が run.json に記録する）
      parseErrors += 1;
      continue;
    }
    // null・数・配列・文字列・真偽値の行は、イベントではないので読み飛ばす（lines には数えてある）
    if (!isRecord(parsed)) continue;
    const type = asString(parsed.type);
    if (type === null) continue;

    noteModel(parsed.model, `${type}.model`);

    if (type === 'thread.started') {
      const id = asString(parsed.thread_id);
      if (threadId === null && id !== null) threadId = id;
    } else if (type === 'turn.completed') {
      turnCompleted = true;
      usage = numericFields(parsed.usage);
    } else if (type === 'turn.failed') {
      // 最初の失敗を根本の原因として残す
      if (turnFailed === null) turnFailed = failureMessage(parsed.error);
    } else if (type === 'error') {
      errors.push(textOrNoReason(parsed.message));
    } else if (ITEM_EVENT_TYPES.includes(type)) {
      const item = parsed.item;
      if (!isRecord(item)) continue;
      const itemType = asString(item.type);
      if (itemType === null) continue;
      noteModel(item.model, `${type}.item.model`);

      const rawId = item.id;
      const id = typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId) : null;
      const key = id === null ? null : `${id}\u0000${itemType}`;

      if (key !== null) {
        if (!countedItems.has(key)) {
          countedItems.add(key);
          countItem(itemType);
        }
      } else if (type === 'item.started') {
        countItem(itemType);
        anonymousStarted.set(itemType, (anonymousStarted.get(itemType) ?? 0) + 1);
      } else if (type === 'item.completed') {
        const pending = anonymousStarted.get(itemType) ?? 0;
        if (pending > 0) anonymousStarted.set(itemType, pending - 1);
        else countItem(itemType);
      }

      if (type === 'item.completed') {
        if (key !== null) {
          if (completedItems.has(key)) continue;
          completedItems.add(key);
        }
        if (itemType === 'agent_message') agentMessages += 1;
        if (itemType === 'error') notices.push(textOrNoReason(item.message));
      }
    }
  }

  return {
    lines,
    parseErrors,
    threadId,
    turnCompleted,
    turnFailed,
    errors,
    itemTypes: Object.fromEntries(itemTypes),
    unexpectedItems,
    notices,
    agentMessages,
    usage,
    reportedModel,
  };
}

export const FAILURE_KINDS = [
  'spawn_error',
  'interrupted',
  'timeout',
  'auth',
  'usage_limit',
  'model_unavailable',
  'config',
  'nonzero_exit',
  'turn_failed',
  'stream_error',
  'unexpected_tool',
  'no_turn_completed',
  'empty_output',
] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

export type Failure = { kind: FailureKind; message: string };

export type FailureInput = {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  interrupted: boolean;
  /** spawn 自体の失敗（ENOENT など）。無ければ null */
  spawnError: string | null;
  summary: CodexEventSummary;
  stderr: string;
  /** --output-last-message に書かれた文（無ければ null） */
  output: string | null;
};

/**
 * 失敗を1つに分類する（成功なら null）。判定の順:
 *
 * 1. spawn_error → interrupted → timeout
 * 2. 失敗の文面（errors・turnFailed・stderr）の分類: auth → usage_limit → model_unavailable → config
 *    - auth: unauthorized / 401 / not logged in / login / authentication / forced_login_method
 *    - usage_limit: usage limit / usageLimitExceeded / hit your ... limit / rate limit / 429 / quota
 *    - model_unavailable: model ... (not found|not supported|does not exist|unavailable|not available) /
 *      unsupported model / invalid model
 *    - config: Error loading config / unknown configuration field / unknown variant
 *    文面の分類は、exit が 0 以外・turn.failed・（turn が完了していないときの）error イベントのどれかが
 *    あるときだけ行う（成功した実行の stderr の雑音や、回復した再接続の通知で誤判定しない）
 * 3. nonzero_exit（exit が 0 以外、または signal で終わった）
 * 4. turn_failed → stream_error（type: "error" のイベントがあり、turn.completed が無い）
 *    error イベントのあとに turn.completed が来ていれば、途中で切れたのではない（再接続の通知などが
 *    top-level の error として出ることがある）。失敗にせず、run の側が warnings に残す
 * 5. unexpected_tool（exit 0 でも）
 * 6. no_turn_completed
 * 7. empty_output（output が null か、空白だけ）
 *
 * message は人が読む短い説明（日本語）。原因の文面があれば先頭 300 字を添える。
 */
export function classifyFailure(input: FailureInput): Failure | null {
  const { summary } = input;

  // 1. 起動できなかった・中断された・時間切れ。これらは文面の分類より先（打ち切りの途中の stderr に
  //    401 や 429 の文字があっても、原因は打ち切りの側にある）
  if (input.spawnError !== null) {
    return {
      kind: 'spawn_error',
      message: withCause('codex を起動できませんでした。cli.command と PATH を確認してください。', input.spawnError),
    };
  }
  if (input.interrupted) {
    return {
      kind: 'interrupted',
      message: '中断されました（Ctrl-C など）。途中の出力は完成稿として扱いません。',
    };
  }
  if (input.timedOut) {
    return {
      kind: 'timeout',
      message: '時間切れで打ち切りました。途中の出力は完成稿として扱いません（自動では再試行しません）。',
    };
  }

  // 正常に終わった（exit 0 で signal 無し）か。exit が null で signal も無い終わり方も正常ではない
  const exitedCleanly = input.exitCode === 0 && input.signal === null;

  // 2. 失敗の文面の分類。成功した実行の stderr の雑音で誤判定しないよう、失敗の兆候があるときだけ行う
  // error イベントは、turn が完了しなかったときだけ失敗の兆候と見る（完了していれば回復した通知）
  const unrecoveredErrors = summary.errors.length > 0 && !summary.turnCompleted;
  const hasFailureSign = !exitedCleanly || summary.turnFailed !== null || unrecoveredErrors;
  if (hasFailureSign) {
    const sources = [...summary.errors, summary.turnFailed ?? '', input.stderr].filter(
      (text) => text.trim().length > 0,
    );
    for (const entry of TEXT_KINDS) {
      const source = sources.find((text) => entry.pattern.test(text));
      if (source !== undefined) {
        return { kind: entry.kind, message: withCause(entry.message, relevantText(source, entry.pattern)) };
      }
    }
  }

  // 3. 終了状態
  if (!exitedCleanly) {
    const status =
      input.signal !== null
        ? `signal ${input.signal}${input.exitCode !== null ? `・exit ${input.exitCode}` : ''}`
        : `exit ${input.exitCode ?? 'なし'}`;
    return {
      kind: 'nonzero_exit',
      message: withCause(`codex が正常に終了しませんでした（${status}）。`, defaultCause(input)),
    };
  }

  // 4. turn の失敗・回復しないストリームのエラー
  if (summary.turnFailed !== null) {
    return { kind: 'turn_failed', message: withCause('ターンが失敗しました。', summary.turnFailed) };
  }
  if (unrecoveredErrors) {
    return {
      kind: 'stream_error',
      message: withCause('回復しないエラーイベントが出ました（本文があっても完成稿にしません）。', summary.errors[0] ?? null),
    };
  }

  // 5. 期待しないツールの呼び出し（exit 0・本文ありでも失敗）
  if (summary.unexpectedItems.length > 0) {
    return {
      kind: 'unexpected_tool',
      message: `執筆中に期待しないツールの呼び出しがありました（${summary.unexpectedItems.join(', ')}）。本文があっても失敗として扱います。`,
    };
  }

  // 6. 完了の印が無い
  if (!summary.turnCompleted) {
    return {
      kind: 'no_turn_completed',
      message: 'turn.completed が来ませんでした（出力が途中で切れた可能性）。完成稿として扱いません。',
    };
  }

  // 7. 最終応答が空（長さの検査はしない。1 文字でもあれば成功）
  if (input.output === null || input.output.trim().length === 0) {
    return {
      kind: 'empty_output',
      message: '最終応答（--output-last-message）が空でした。完成稿として扱いません。',
    };
  }

  return null;
}

/** 原因の文面として添える長さの上限（文字数。サロゲートペアは 1 字と数える） */
const CAUSE_MAX_CHARS = 300;

/** 原因の先頭 300 字。切ったときは末尾に … を付ける。 */
function headOf(text: string): string {
  const chars = [...text.trim()];
  return chars.length > CAUSE_MAX_CHARS ? `${chars.slice(0, CAUSE_MAX_CHARS).join('')}…` : chars.join('');
}

function withCause(description: string, cause: string | null): string {
  if (cause === null || cause.trim().length === 0) return description;
  return `${description} 原因: ${headOf(cause)}`;
}

/**
 * 分類に当たった文面から、添える原因を選ぶ。複数行（stderr のログ）なら当たった最初の行、
 * 1 行（turn.failed・error イベント）ならその全体。
 */
function relevantText(source: string, pattern: RegExp): string {
  const matched = source.split(/\r?\n/).find((line) => pattern.test(line));
  return (matched ?? source).trim();
}

/** 文面の分類に当たらなかったときの原因: turn.failed → 最初の error イベント → stderr の順 */
function defaultCause(input: FailureInput): string | null {
  const candidates = [input.summary.turnFailed, input.summary.errors[0] ?? null, input.stderr];
  return candidates.find((text) => text !== null && text.trim().length > 0) ?? null;
}

/**
 * 失敗の文面の分類（順序が優先順位）。パターンは状態を持たない（g フラグ無し）。
 * model_unavailable の "model provider ..." は設定の話なのでモデルの不在とは見ない。
 */
const TEXT_KINDS: ReadonlyArray<{
  kind: 'auth' | 'usage_limit' | 'model_unavailable' | 'config';
  pattern: RegExp;
  message: string;
}> = [
  {
    kind: 'auth',
    pattern: /unauthorized|(?<!\d)401(?!\d)|not logged in|login|authentication|forced_login_method/i,
    message: 'ChatGPT の認証が通りません。`codex login` でログインし直してください（別の認証・API キーへは切り替えません）。',
  },
  {
    kind: 'usage_limit',
    pattern: /usage\s*limit|usageLimitExceeded|hit your\b[^.\n]{0,40}limit|rate[\s_-]?limit|(?<!\d)429(?!\d)|quota/i,
    message: '利用上限に達しました。上限が戻ってから実行し直してください（別のモデルへは切り替えません）。',
  },
  {
    kind: 'model_unavailable',
    pattern:
      /\bmodel\b(?!\s+provider)[^\n]{0,120}?(?:not found|not supported|does not exist|unavailable|not available)|unsupported model|invalid model/i,
    message: '指定のモデルを使えません。writer.yaml の model と story:doctor を確認してください（別のモデルへは切り替えません）。',
  },
  {
    kind: 'config',
    pattern: /Error loading config|unknown configuration field|unknown variant/i,
    message: 'Codex が設定の上書きを受け付けませんでした。CLI の版の変更が疑われます。story:doctor で確認してください。',
  },
];
