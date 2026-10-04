import { describe, it, expect } from 'vitest';
import {
  ALLOWED_ITEM_TYPES,
  FAILURE_KINDS,
  NOTICE_ITEM_TYPES,
  classifyFailure,
  summarizeEvents,
  type CodexEventSummary,
  type FailureInput,
  type FailureKind,
} from '../../src/story/authoring/codex-events.js';
import { REAL, failedTurnEvents, okEvents, toolCallEvents } from '../helpers/fake-codex.js';

// 注意: 本番関数は import 時には呼ばない（スタブが投げても収集が壊れないよう、呼び出しはすべて it の中）。

type EventLine = Record<string, unknown> | string;

const toJsonl = (events: readonly EventLine[], eol = '\n'): string =>
  events.map((event) => (typeof event === 'string' ? event : JSON.stringify(event))).join(eol);

const summarize = (events: readonly EventLine[]): CodexEventSummary => summarizeEvents(toJsonl(events));

const OK_USAGE = {
  input_tokens: 4100,
  cached_input_tokens: 0,
  output_tokens: 6200,
  reasoning_output_tokens: 1800,
};

const TOOL_ITEM_TYPES = [
  'command_execution',
  'file_change',
  'mcp_tool_call',
  'web_search',
  'todo_list',
  'collab_agent_tool_call',
] as const;

const thread = { type: 'thread.started', thread_id: 'thread-x' };
const turnStarted = { type: 'turn.started' };
const completedItem = (id: string, type: string, extra: Record<string, unknown> = {}) => ({
  type: 'item.completed',
  item: { id, type, ...extra },
});
const startedItem = (id: string, type: string) => ({ type: 'item.started', item: { id, type } });
const turnCompleted = (extra: Record<string, unknown> = {}) => ({
  type: 'turn.completed',
  usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
  ...extra,
});

// ── 定数 ───────────────────────────────────────────────────

describe('authoring/codex-events の定数', () => {
  it('執筆中に許すアイテムは agent_message と reasoning だけ', () => {
    expect([...ALLOWED_ITEM_TYPES]).toEqual(['agent_message', 'reasoning']);
  });

  it('許して数える注意のアイテムは error だけ', () => {
    expect([...NOTICE_ITEM_TYPES]).toEqual(['error']);
  });

  it('失敗の種類は仕様の 13 種', () => {
    expect([...FAILURE_KINDS]).toEqual([
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
    ]);
  });
});

// ── summarizeEvents ────────────────────────────────────────

describe('summarizeEvents: 正常な実行', () => {
  const expectedOk: CodexEventSummary = {
    lines: 5,
    parseErrors: 0,
    threadId: 'thread-test-1',
    turnCompleted: true,
    turnFailed: null,
    errors: [],
    itemTypes: { reasoning: 1, agent_message: 1 },
    unexpectedItems: [],
    notices: [],
    agentMessages: 1,
    usage: OK_USAGE,
    reportedModel: null,
  };

  it('典型的な okEvents を要約する', () => {
    expect(summarize(okEvents())).toEqual(expectedOk);
  });

  it('末尾に改行があっても同じ', () => {
    expect(summarizeEvents(`${toJsonl(okEvents())}\n`)).toEqual(expectedOk);
  });

  it('CRLF の改行でも読める', () => {
    expect(summarizeEvents(toJsonl(okEvents(), '\r\n'))).toEqual(expectedOk);
    expect(summarizeEvents(`${toJsonl(okEvents(), '\r\n')}\r\n`)).toEqual(expectedOk);
  });

  it('空文字列は何も起きていない状態になる（投げない）', () => {
    expect(summarizeEvents('')).toEqual({
      lines: 0,
      parseErrors: 0,
      threadId: null,
      turnCompleted: false,
      turnFailed: null,
      errors: [],
      itemTypes: {},
      unexpectedItems: [],
      notices: [],
      agentMessages: 0,
      usage: null,
      reportedModel: null,
    });
  });

  it('thread.started が無ければ threadId は null', () => {
    expect(summarize([turnStarted, completedItem('item_0', 'agent_message'), turnCompleted()]).threadId).toBeNull();
  });

  it('完了した agent_message の数を数える', () => {
    const summary = summarize([
      thread,
      turnStarted,
      completedItem('item_0', 'agent_message', { text: 'a' }),
      completedItem('item_1', 'reasoning'),
      completedItem('item_2', 'agent_message', { text: 'b' }),
      turnCompleted(),
    ]);
    expect(summary.agentMessages).toBe(2);
    expect(summary.itemTypes).toEqual({ agent_message: 2, reasoning: 1 });
  });
});

describe('summarizeEvents: 申告されたモデル（reportedModel）', () => {
  it('model の欄が無ければ null（要求したモデルを写して確認済みにしない）', () => {
    expect(summarize(okEvents()).reportedModel).toBeNull();
  });

  it('turn.completed の model を場所つきで返す', () => {
    expect(summarize(okEvents({ model: 'gpt-6-astra-2026-09' })).reportedModel).toEqual({
      value: 'gpt-6-astra-2026-09',
      source: 'turn.completed.model',
    });
  });

  it('item の中の model は item.completed.item.model として返す', () => {
    const summary = summarize([
      thread,
      turnStarted,
      { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'x', model: 'm' } },
      turnCompleted(),
    ]);
    expect(summary.reportedModel).toEqual({ value: 'm', source: 'item.completed.item.model' });
  });

  it('thread.started の model も場所つきで返す', () => {
    const summary = summarize([
      { type: 'thread.started', thread_id: 'thread-x', model: 'm-thread' },
      turnStarted,
      completedItem('item_0', 'agent_message'),
      turnCompleted(),
    ]);
    expect(summary.reportedModel).toEqual({ value: 'm-thread', source: 'thread.started.model' });
  });

  it.each<unknown>([123, true, null, { id: 'gpt-6-astra' }, ['gpt-6-astra']])(
    '文字列でない model（%j）は無視する',
    (value) => {
      const summary = summarize([
        thread,
        turnStarted,
        completedItem('item_0', 'agent_message', { text: 'x', model: value }),
        turnCompleted({ model: value }),
      ]);
      expect(summary.reportedModel).toBeNull();
    },
  );

  it('turn.completed の model が文字列でないとき、item の文字列の model を拾う', () => {
    const summary = summarize([
      thread,
      turnStarted,
      completedItem('item_0', 'agent_message', { text: 'x', model: 'm-item' }),
      turnCompleted({ model: 42 }),
    ]);
    expect(summary.reportedModel).toEqual({ value: 'm-item', source: 'item.completed.item.model' });
  });
});

describe('summarizeEvents: 期待しないツールの呼び出し', () => {
  it.each(TOOL_ITEM_TYPES)('%s は unexpectedItems に入り、itemTypes に数えられる', (itemType) => {
    const summary = summarize(toolCallEvents(itemType));
    expect(summary.unexpectedItems).toEqual([itemType]);
    // item.started と item.completed が同じ id のとき、1 件として数える
    expect(summary.itemTypes).toEqual({ [itemType]: 1, agent_message: 1 });
    expect(summary.turnCompleted).toBe(true);
    expect(summary.agentMessages).toBe(1);
    expect(summary.notices).toEqual([]);
  });

  it('同じ種類は重複なしで、最初に現れた順に並べる', () => {
    const summary = summarize([
      thread,
      turnStarted,
      completedItem('item_0', 'web_search'),
      completedItem('item_1', 'command_execution'),
      completedItem('item_2', 'web_search'),
      completedItem('item_3', 'command_execution'),
      completedItem('item_4', 'agent_message', { text: 'x' }),
      turnCompleted(),
    ]);
    expect(summary.unexpectedItems).toEqual(['web_search', 'command_execution']);
    expect(summary.itemTypes).toEqual({ web_search: 2, command_execution: 2, agent_message: 1 });
  });

  it('許す種類（agent_message・reasoning・error）は unexpectedItems に入らない', () => {
    const summary = summarize([
      thread,
      turnStarted,
      completedItem('item_0', 'reasoning'),
      completedItem('item_1', 'file_change'),
      completedItem('item_2', 'error', { message: 'Reconnecting... 1/5' }),
      completedItem('item_3', 'agent_message', { text: 'x' }),
      turnCompleted(),
    ]);
    expect(summary.unexpectedItems).toEqual(['file_change']);
  });

  it('item.started だけで終わったアイテムも itemTypes に数え、unexpectedItems に出す', () => {
    const summary = summarize([thread, turnStarted, startedItem('item_0', 'command_execution')]);
    expect(summary.itemTypes).toEqual({ command_execution: 1 });
    expect(summary.unexpectedItems).toEqual(['command_execution']);
    expect(summary.turnCompleted).toBe(false);
    expect(summary.agentMessages).toBe(0);
  });

  it('item.started → item.updated → item.completed は同じ id なら 1 件', () => {
    const summary = summarize([
      thread,
      turnStarted,
      startedItem('item_0', 'mcp_tool_call'),
      { type: 'item.updated', item: { id: 'item_0', type: 'mcp_tool_call' } },
      completedItem('item_0', 'mcp_tool_call'),
      turnCompleted(),
    ]);
    expect(summary.itemTypes).toEqual({ mcp_tool_call: 1 });
    expect(summary.unexpectedItems).toEqual(['mcp_tool_call']);
  });

  it('item.started だけの agent_message は itemTypes に数えるが、完了した agent_message ではない', () => {
    const summary = summarize([thread, turnStarted, startedItem('item_0', 'agent_message')]);
    expect(summary.itemTypes).toEqual({ agent_message: 1 });
    expect(summary.agentMessages).toBe(0);
    expect(summary.unexpectedItems).toEqual([]);
  });
});

describe('summarizeEvents: 注意（item の type が error）', () => {
  it('message を notices に入れ、unexpectedItems や errors には入れない', () => {
    const summary = summarize([
      thread,
      turnStarted,
      completedItem('item_0', 'error', { message: 'Reconnecting... 2/5' }),
      completedItem('item_1', 'error', { message: 'Reconnecting... 3/5' }),
      completedItem('item_2', 'agent_message', { text: 'x' }),
      turnCompleted(),
    ]);
    expect(summary.notices).toEqual(['Reconnecting... 2/5', 'Reconnecting... 3/5']);
    expect(summary.unexpectedItems).toEqual([]);
    expect(summary.errors).toEqual([]);
    expect(summary.turnFailed).toBeNull();
    expect(summary.itemTypes).toMatchObject({ error: 2, agent_message: 1 });
  });
});

describe('summarizeEvents: error と turn.failed', () => {
  it('type: error のイベントの message を順に errors へ入れる', () => {
    const summary = summarize([
      thread,
      turnStarted,
      { type: 'error', message: 'first problem' },
      { type: 'error', message: 'second problem' },
    ]);
    expect(summary.errors).toEqual(['first problem', 'second problem']);
    expect(summary.turnFailed).toBeNull();
    expect(summary.turnCompleted).toBe(false);
  });

  it('turn.failed の error.message を turnFailed へ入れる', () => {
    const summary = summarize([thread, turnStarted, { type: 'turn.failed', error: { message: 'boom' } }]);
    expect(summary.turnFailed).toBe('boom');
    expect(summary.errors).toEqual([]);
    expect(summary.turnCompleted).toBe(false);
  });

  it('failedTurnEvents は errors と turnFailed の両方に同じ message が入る', () => {
    const summary = summarize(failedTurnEvents('stream died'));
    expect(summary.errors).toEqual(['stream died']);
    expect(summary.turnFailed).toBe('stream died');
    expect(summary.turnCompleted).toBe(false);
    expect(summary.threadId).toBe('thread-test-3');
  });
});

describe('summarizeEvents: 壊れた行・空行', () => {
  const head = okEvents().slice(0, 1);
  const tail = okEvents().slice(1);

  it('JSON として読めない行は parseErrors に数えて飛ばす（投げない）', () => {
    const jsonl = toJsonl([...head, '{oops', ...tail, 'not json']);
    expect(() => summarizeEvents(jsonl)).not.toThrow();
    const summary = summarizeEvents(jsonl);
    expect(summary.parseErrors).toBe(2);
    // 空でない行の数には壊れた行も含む
    expect(summary.lines).toBe(7);
    // 壊れた行の前後の正しい行は読めている
    expect(summary.threadId).toBe('thread-test-1');
    expect(summary.turnCompleted).toBe(true);
    expect(summary.usage).toEqual(OK_USAGE);
    expect(summary.itemTypes).toEqual({ reasoning: 1, agent_message: 1 });
  });

  it('壊れた行だけの入力でも投げない', () => {
    const summary = summarizeEvents('{oops\nnot json\n');
    expect(summary.parseErrors).toBe(2);
    expect(summary.lines).toBe(2);
    expect(summary.turnCompleted).toBe(false);
    expect(summary.threadId).toBeNull();
  });

  it('空行は無視する（lines にも parseErrors にも数えない）', () => {
    const [first, ...rest] = okEvents();
    const jsonl = ['', JSON.stringify(first), '', '', ...rest.map((e) => JSON.stringify(e)), ''].join('\n');
    const summary = summarizeEvents(jsonl);
    expect(summary.lines).toBe(5);
    expect(summary.parseErrors).toBe(0);
    expect(summary.turnCompleted).toBe(true);
  });

  it('空白だけの行も空行として無視する', () => {
    const [first, ...rest] = okEvents();
    const jsonl = ['   ', JSON.stringify(first), '\t', ...rest.map((e) => JSON.stringify(e)), '  \t '].join('\n');
    const summary = summarizeEvents(jsonl);
    expect(summary.lines).toBe(5);
    expect(summary.parseErrors).toBe(0);
  });

  it('オブジェクトでない JSON の行（null・数・配列・文字列）でも投げない', () => {
    const jsonl = toJsonl(['null', '123', '[]', '"text"', 'true', ...okEvents()]);
    expect(() => summarizeEvents(jsonl)).not.toThrow();
    const summary = summarizeEvents(jsonl);
    expect(summary.lines).toBe(10);
    expect(summary.turnCompleted).toBe(true);
    expect(summary.itemTypes).toEqual({ reasoning: 1, agent_message: 1 });
    expect(summary.unexpectedItems).toEqual([]);
  });

  it('知らない type や item の欠けたイベントは無視して投げない', () => {
    const jsonl = toJsonl([
      ...head,
      { type: 'thread.weird', foo: 1 },
      {},
      { type: 'item.completed' },
      { type: 'item.started', item: null },
      { type: 'error' },
      ...tail,
    ]);
    expect(() => summarizeEvents(jsonl)).not.toThrow();
    const summary = summarizeEvents(jsonl);
    expect(summary.turnCompleted).toBe(true);
    expect(summary.itemTypes).toEqual({ reasoning: 1, agent_message: 1 });
    expect(summary.unexpectedItems).toEqual([]);
    expect(summary.parseErrors).toBe(0);
  });
});

describe('summarizeEvents: usage', () => {
  it('数値の欄だけを残す（数値でない欄は落とす）', () => {
    const summary = summarize([
      thread,
      turnStarted,
      completedItem('item_0', 'agent_message', { text: 'x' }),
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 10,
          cached_input_tokens: null,
          output_tokens: '20',
          reasoning_output_tokens: { n: 1 },
          total_tokens: 7,
          ratio: 1.5,
          flags: [1, 2],
          ok: true,
        },
      },
    ]);
    expect(summary.usage).toEqual({ input_tokens: 10, total_tokens: 7, ratio: 1.5 });
  });

  it('最後の turn.completed の usage を採る', () => {
    const summary = summarize([
      thread,
      turnStarted,
      { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } },
      turnStarted,
      { type: 'turn.completed', usage: { input_tokens: 30, output_tokens: 40 } },
    ]);
    expect(summary.turnCompleted).toBe(true);
    expect(summary.usage).toEqual({ input_tokens: 30, output_tokens: 40 });
  });

  it('turn.completed が無ければ usage は null', () => {
    expect(summarize([thread, turnStarted]).usage).toBeNull();
  });

  it('turn.completed に usage が無ければ null（完了は true）', () => {
    const summary = summarize([thread, turnStarted, { type: 'turn.completed' }]);
    expect(summary.turnCompleted).toBe(true);
    expect(summary.usage).toBeNull();
  });
});

// ── classifyFailure ────────────────────────────────────────

/** 成功を既定にした入力（exit 0・完了済み・本文あり）。差分だけ上書きする */
const base = (override: Partial<FailureInput> = {}): FailureInput => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  interrupted: false,
  spawnError: null,
  summary: summarize(okEvents()),
  stderr: '',
  output: 'あ'.repeat(10),
  ...override,
});

/** 失敗の文面を turn.failed と error イベントに載せ、exit 1 で終わった実行 */
const failedRun = (text: string, override: Partial<FailureInput> = {}): FailureInput =>
  base({ exitCode: 1, summary: summarize(failedTurnEvents(text)), output: null, ...override });

/** turn.failed だけ（error イベント無し） */
const turnFailedOnly = (text: string): Array<Record<string, unknown>> => [
  thread,
  turnStarted,
  { type: 'turn.failed', error: { message: text } },
];

/** error イベントだけ（turn.failed 無し・turn.completed 無し） */
const errorOnly = (text: string): Array<Record<string, unknown>> => [
  thread,
  turnStarted,
  { type: 'error', message: text },
];

const kindOf = (input: FailureInput): FailureKind | null => classifyFailure(input)?.kind ?? null;

describe('classifyFailure: 成功', () => {
  it('exit 0・turn.completed・本文ありは null', () => {
    expect(classifyFailure(base())).toBeNull();
  });

  it('成功した実行の stderr の雑音（401 など）で誤判定しない', () => {
    const stderr = [
      'WARN telemetry endpoint returned HTTP 401',
      'hint: run `codex login` to refresh',
      'rate limit 429 on a background request; quota unaffected',
      'model metadata not found in cache, using defaults',
      'Error loading plugin cache',
    ].join('\n');
    expect(classifyFailure(base({ stderr }))).toBeNull();
  });

  it('401 だけの stderr でも成功は null', () => {
    expect(classifyFailure(base({ stderr: 'HTTP 401' }))).toBeNull();
  });

  it('回復できた注意（item の type が error）があっても成功は null', () => {
    const summary = summarize([
      thread,
      turnStarted,
      completedItem('item_0', 'error', { message: 'Reconnecting... 1/5' }),
      completedItem('item_1', 'agent_message', { text: 'x' }),
      turnCompleted(),
    ]);
    expect(classifyFailure(base({ summary }))).toBeNull();
  });

  it('モデルを申告した成功も null', () => {
    expect(classifyFailure(base({ summary: summarize(okEvents({ model: 'gpt-6-astra-2026-09' })) }))).toBeNull();
  });

  it('入力を書き換えない', () => {
    const input = failedRun('The turn ended unexpectedly.', { stderr: 'some stderr' });
    const before = JSON.stringify(input);
    classifyFailure(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('classifyFailure: プロセス自体の失敗', () => {
  it('spawn の失敗は spawn_error', () => {
    const failure = classifyFailure(
      base({ exitCode: null, spawnError: 'spawn codex ENOENT', summary: summarize([]), output: null }),
    );
    expect(failure?.kind).toBe('spawn_error');
  });

  it('interrupted は interrupted（timedOut も立っていても）', () => {
    expect(kindOf(base({ exitCode: null, signal: 'SIGINT', interrupted: true, output: null }))).toBe('interrupted');
    expect(
      kindOf(base({ exitCode: null, signal: 'SIGTERM', interrupted: true, timedOut: true, output: null })),
    ).toBe('interrupted');
  });

  it('timedOut は timeout', () => {
    expect(kindOf(base({ exitCode: null, signal: 'SIGTERM', timedOut: true, output: null }))).toBe('timeout');
  });

  it('spawn_error は interrupted・timeout より先', () => {
    expect(
      kindOf(
        base({
          exitCode: null,
          spawnError: 'spawn codex ENOENT',
          interrupted: true,
          timedOut: true,
          summary: summarize([]),
          output: null,
        }),
      ),
    ).toBe('spawn_error');
  });

  it('interrupted は timeout より先', () => {
    expect(kindOf(base({ exitCode: null, signal: 'SIGTERM', interrupted: true, timedOut: true }))).toBe('interrupted');
  });

  it('timeout は文面の分類（auth など）より先', () => {
    expect(
      kindOf(failedRun('unexpected status 401 Unauthorized', { exitCode: null, signal: 'SIGTERM', timedOut: true })),
    ).toBe('timeout');
    expect(
      kindOf(base({ exitCode: null, signal: 'SIGTERM', timedOut: true, stderr: '429 Too Many Requests', output: null })),
    ).toBe('timeout');
  });

  it('interrupted は文面の分類より先', () => {
    expect(
      kindOf(failedRun("You've hit your usage limit.", { exitCode: null, signal: 'SIGINT', interrupted: true })),
    ).toBe('interrupted');
  });
});

describe('classifyFailure: 失敗の文面の分類', () => {
  const AUTH_TEXTS = [
    'unexpected status 401 Unauthorized',
    'Not logged in',
    'Login is required (forced_login_method = chatgpt)',
    'Authentication required',
  ];
  const USAGE_TEXTS = [
    "You've hit your usage limit. Upgrade to Pro or try again later.",
    'usageLimitExceeded',
    "You've hit your weekly limit. It resets in 3 days.",
    'rate limit exceeded for requests',
    '429 Too Many Requests',
    'insufficient quota',
  ];
  const MODEL_TEXTS = [
    'The model `gpt-6-astra` does not exist or you do not have access to it.',
    'The model `gpt-6-astra` is not supported when using Codex with a ChatGPT account.',
    'model gpt-6-astra not found',
    'The requested model is unavailable right now',
    'unsupported model: gpt-x',
    'invalid model: gpt-x',
  ];
  const CONFIG_TEXTS = [
    'Error loading config.toml: unknown configuration field `x` in -c/--config override',
    REAL.unknownField,
    'unknown variant `bogus`, expected one of `low`, `medium`, `high`',
  ];

  /** 同じ文面を、文面が現れうる 4 か所に置いた入力 */
  const placements = (text: string): Array<[string, FailureInput]> => [
    ['turn.failed + error（exit 1）', failedRun(text)],
    ['turn.failed のみ（exit 0）', base({ summary: summarize(turnFailedOnly(text)), output: null })],
    ['error イベントのみ（exit 0）', base({ summary: summarize(errorOnly(text)), output: null })],
    ['stderr のみ（exit 1）', base({ exitCode: 1, summary: summarize([]), stderr: `${text}\n`, output: null })],
  ];

  const table: Array<[FailureKind, readonly string[]]> = [
    ['auth', AUTH_TEXTS],
    ['usage_limit', USAGE_TEXTS],
    ['model_unavailable', MODEL_TEXTS],
    ['config', CONFIG_TEXTS],
  ];

  for (const [kind, texts] of table) {
    describe(`${kind}`, () => {
      it.each(texts)(`「%s」は ${kind} と判定する（どの場所にあっても）`, (text) => {
        for (const [where, input] of placements(text)) {
          expect(kindOf(input), `${where}: ${text}`).toBe(kind);
        }
      });
    });
  }

  it('REAL.notLoggedIn（実機の login status の文）は auth', () => {
    expect(kindOf(base({ exitCode: 1, summary: summarize([]), stderr: `${REAL.notLoggedIn}\n`, output: null }))).toBe('auth');
  });

  it('stderr のみ・exit 1・turn イベント無しの config（unknown configuration field）', () => {
    const failure = classifyFailure(
      base({
        exitCode: 1,
        summary: summarize([]),
        stderr: 'Error loading config.toml: unknown configuration field `x` in -c/--config override',
        output: null,
      }),
    );
    expect(failure?.kind).toBe('config');
  });

  it('exit 0 でも turn.failed があれば stderr の文面も分類に使う', () => {
    const input = base({
      summary: summarize(turnFailedOnly('The turn ended unexpectedly.')),
      stderr: 'unexpected status 401 Unauthorized\n',
      output: null,
    });
    expect(kindOf(input)).toBe('auth');
  });

  it('文面の優先は auth → usage_limit → model_unavailable → config', () => {
    expect(kindOf(failedRun("401 Unauthorized. You've hit your usage limit."))).toBe('auth');
    expect(kindOf(failedRun("You've hit your usage limit. The model `x` does not exist."))).toBe('usage_limit');
    expect(
      kindOf(failedRun('The model `x` does not exist. Error loading config.toml: unknown variant `bogus`')),
    ).toBe('model_unavailable');
  });

  it('文面の分類は複数の場所をまとめて見る（stderr に auth、turn.failed に usage limit なら auth）', () => {
    const input = failedRun("You've hit your usage limit.", { stderr: 'unexpected status 401 Unauthorized\n' });
    expect(kindOf(input)).toBe('auth');
  });

  it('文面の分類は nonzero_exit より先', () => {
    expect(kindOf(failedRun('unexpected status 401 Unauthorized', { exitCode: 2 }))).toBe('auth');
    expect(kindOf(failedRun('429 Too Many Requests', { exitCode: null, signal: 'SIGKILL' }))).toBe('usage_limit');
  });
});

describe('classifyFailure: 終了状態と turn の状態', () => {
  it('exit が 0 以外で、文面が分類に当たらなければ nonzero_exit', () => {
    expect(
      kindOf(base({ exitCode: 2, summary: summarize([]), stderr: 'Segmentation fault (core dumped)\n', output: null })),
    ).toBe('nonzero_exit');
  });

  it('exit null と signal（SIGKILL）で終わったら nonzero_exit', () => {
    expect(
      kindOf(base({ exitCode: null, signal: 'SIGKILL', summary: summarize([thread, turnStarted]), output: null })),
    ).toBe('nonzero_exit');
  });

  it('exit が 0 以外なら、turn.completed があり本文があっても nonzero_exit', () => {
    expect(kindOf(base({ exitCode: 3 }))).toBe('nonzero_exit');
  });

  it('nonzero_exit は turn_failed より先（文面が分類に当たらないとき）', () => {
    expect(kindOf(failedRun('The turn ended unexpectedly.', { exitCode: 1 }))).toBe('nonzero_exit');
  });

  it('exit 0 で turn.failed があれば turn_failed（文面が分類に当たらないとき）', () => {
    expect(
      kindOf(base({ summary: summarize(turnFailedOnly('The turn ended unexpectedly.')), output: null })),
    ).toBe('turn_failed');
    expect(kindOf(base({ summary: summarize(failedTurnEvents('The turn ended unexpectedly.')), output: null }))).toBe(
      'turn_failed',
    );
  });

  it('exit 0 で error イベントがあり turn.completed が無ければ stream_error', () => {
    expect(
      kindOf(base({ summary: summarize(errorOnly('stream disconnected before completion')), output: null })),
    ).toBe('stream_error');
  });

  it('error イベントがあれば、本文があっても stream_error（empty_output にはならない）', () => {
    expect(kindOf(base({ summary: summarize(errorOnly('stream disconnected before completion')) }))).toBe(
      'stream_error',
    );
  });

  // 再接続の通知（"stream disconnected - retrying ..."）が top-level の error として出ても、
  // そのあと turn が完了していれば、途中で切れたのではない。失敗にすると、書き上がった原稿と
  // 利用枠を捨てることになる（warnings に残すのは run の側）。
  const recoveredThenCompleted = (text: string): Array<Record<string, unknown>> => [
    thread,
    turnStarted,
    { type: 'error', message: text },
    { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'x' } },
    { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
  ];

  it('error イベントのあとに turn.completed があり、exit 0・本文ありなら成功（null）', () => {
    const summary = summarize(
      recoveredThenCompleted('stream disconnected - retrying sampling request (1/5 in 200ms)...'),
    );
    expect(summary.errors.length).toBe(1);
    expect(summary.turnCompleted).toBe(true);
    expect(kindOf(base({ summary }))).toBeNull();
  });

  it('回復した error の文面に 429 や 401 があっても、turn が完了していれば文面で分類しない', () => {
    expect(kindOf(base({ summary: summarize(recoveredThenCompleted('429 Too Many Requests; retrying')) }))).toBeNull();
    expect(kindOf(base({ summary: summarize(recoveredThenCompleted('401 Unauthorized; retrying after auth recovery')) }))).toBeNull();
  });

  it('回復した error があっても、exit が 0 以外なら成功にしない', () => {
    const summary = summarize(recoveredThenCompleted('429 Too Many Requests; retrying'));
    expect(kindOf(base({ summary, exitCode: 1 }))).toBe('usage_limit');
  });

  it('turn_failed は stream_error より先（両方あるとき）', () => {
    const summary = summarize(failedTurnEvents('The turn ended unexpectedly.'));
    expect(summary.errors.length).toBeGreaterThan(0);
    expect(kindOf(base({ summary, output: null }))).toBe('turn_failed');
  });

  it('turn_failed は unexpected_tool より先', () => {
    const summary = summarize([
      thread,
      turnStarted,
      completedItem('item_0', 'command_execution'),
      { type: 'turn.failed', error: { message: 'The turn ended unexpectedly.' } },
    ]);
    expect(kindOf(base({ summary }))).toBe('turn_failed');
  });

  it.each(TOOL_ITEM_TYPES)('exit 0・本文ありでも %s の呼び出しがあれば unexpected_tool', (itemType) => {
    expect(kindOf(base({ summary: summarize(toolCallEvents(itemType)) }))).toBe('unexpected_tool');
  });

  it('unexpected_tool は no_turn_completed より先', () => {
    const summary = summarize([thread, turnStarted, startedItem('item_0', 'web_search')]);
    expect(kindOf(base({ summary }))).toBe('unexpected_tool');
  });

  it('turn.completed が無く error も無ければ no_turn_completed', () => {
    expect(kindOf(base({ summary: summarize([thread, turnStarted]) }))).toBe('no_turn_completed');
    expect(kindOf(base({ summary: summarize([]) }))).toBe('no_turn_completed');
  });

  it('no_turn_completed は empty_output より先', () => {
    expect(kindOf(base({ summary: summarize([thread, turnStarted]), output: null }))).toBe('no_turn_completed');
  });

  it('output が null なら empty_output', () => {
    expect(kindOf(base({ output: null }))).toBe('empty_output');
  });

  it('output が空文字列でも、空白だけでも empty_output', () => {
    expect(kindOf(base({ output: '' }))).toBe('empty_output');
    expect(kindOf(base({ output: '  \n\t' }))).toBe('empty_output');
  });

  it('本文が 1 文字でもあれば成功（切り詰め・長さの検査はしない）', () => {
    expect(classifyFailure(base({ output: 'あ' }))).toBeNull();
  });
});

describe('classifyFailure: message', () => {
  const builders: Record<FailureKind, () => FailureInput> = {
    spawn_error: () =>
      base({ exitCode: null, spawnError: 'spawn codex ENOENT', summary: summarize([]), output: null }),
    interrupted: () => base({ exitCode: null, signal: 'SIGINT', interrupted: true, output: null }),
    timeout: () => base({ exitCode: null, signal: 'SIGTERM', timedOut: true, output: null }),
    auth: () => failedRun('unexpected status 401 Unauthorized'),
    usage_limit: () => failedRun("You've hit your usage limit. Upgrade to Pro or try again later."),
    model_unavailable: () => failedRun('The model `gpt-6-astra` does not exist or you do not have access to it.'),
    config: () =>
      base({
        exitCode: 1,
        summary: summarize([]),
        stderr: 'Error loading config.toml: unknown configuration field `x` in -c/--config override',
        output: null,
      }),
    nonzero_exit: () =>
      base({ exitCode: 2, summary: summarize([]), stderr: 'Segmentation fault (core dumped)', output: null }),
    turn_failed: () => base({ summary: summarize(turnFailedOnly('The turn ended unexpectedly.')), output: null }),
    stream_error: () =>
      base({ summary: summarize(errorOnly('stream disconnected before completion')), output: null }),
    unexpected_tool: () => base({ summary: summarize(toolCallEvents('command_execution')) }),
    no_turn_completed: () => base({ summary: summarize([thread, turnStarted]) }),
    empty_output: () => base({ output: null }),
  };

  it.each(FAILURE_KINDS)('%s: 想定した種類で、message は空でない日本語の説明', (kind) => {
    const failure = classifyFailure(builders[kind]());
    expect(failure).not.toBeNull();
    expect(failure?.kind).toBe(kind);
    expect(typeof failure?.message).toBe('string');
    expect(failure?.message.trim().length).toBeGreaterThan(0);
    expect(failure?.message).toMatch(/[぀-ヿ㐀-鿿]/);
  });

  it.each<[string, FailureKind, string, (cause: string) => FailureInput]>([
    ['turn.failed の文面', 'turn_failed', 'The turn ended unexpectedly.', (c) => base({ summary: summarize(turnFailedOnly(c)), output: null })],
    ['error イベントの文面', 'stream_error', 'stream disconnected before completion', (c) => base({ summary: summarize(errorOnly(c)), output: null })],
    ['spawn の失敗の文面', 'spawn_error', 'spawn codex ENOENT', (c) => base({ exitCode: null, spawnError: c, summary: summarize([]), output: null })],
    ['auth の文面', 'auth', 'unexpected status 401 Unauthorized', (c) => failedRun(c)],
    ['config の stderr', 'config', REAL.unknownField, (c) => base({ exitCode: 1, summary: summarize([]), stderr: c, output: null })],
    ['nonzero_exit の stderr', 'nonzero_exit', 'Segmentation fault (core dumped)', (c) => base({ exitCode: 2, summary: summarize([]), stderr: c, output: null })],
  ])('%s: 短い原因の文面は message にそのまま含まれる', (_label, kind, cause, build) => {
    const failure = classifyFailure(build(cause));
    expect(failure?.kind).toBe(kind);
    expect(failure?.message).toContain(cause);
  });

  const HEAD = 'CAUSE-HEAD ';
  const LONG_CAUSE = `${HEAD}${'z'.repeat(1000)}`;

  it.each<[FailureKind, (cause: string) => FailureInput]>([
    ['turn_failed', (c) => base({ summary: summarize(turnFailedOnly(c)), output: null })],
    ['stream_error', (c) => base({ summary: summarize(errorOnly(c)), output: null })],
    ['spawn_error', (c) => base({ exitCode: null, spawnError: c, summary: summarize([]), output: null })],
  ])('%s: 1000 字の原因は先頭だけを添え、原因の部分は 300 字を超えない', (kind, build) => {
    expect(LONG_CAUSE.length).toBeGreaterThan(1000);
    const failure = classifyFailure(build(LONG_CAUSE));
    expect(failure?.kind).toBe(kind);
    const message = failure?.message ?? '';
    // 原因の先頭は残る
    expect(message).toContain('CAUSE-HEAD');
    // 原因全文（1000 字の z）は入らない。z は日本語の説明には現れないので、原因の部分の長さの上限になる
    const zCount = (message.match(/z/g) ?? []).length;
    expect(zCount).toBeLessThanOrEqual(300 - HEAD.length);
    expect(message).not.toContain(LONG_CAUSE);
  });
});
