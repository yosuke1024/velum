import { describe, it, expect, afterAll, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../../src/lib/paths.js';
import {
  LOCK_FILE_NAME,
  RUN_ID_PATTERN,
  RUN_RECORD_FILE,
  RUN_RECORD_SCHEMA,
  RUNS_DIR_NAME,
  RunLockError,
  RunRecordSchema,
  acquireRunLock,
  createRunDir,
  findRunDir,
  moveNoClobber,
  newRunId,
  readRunRecord,
  runsRoot,
  writeFileNoClobber,
  writeRunRecord,
  type RunRecord,
} from '../../src/story/authoring/runs.js';

const tmp = mkdtempSync(join(tmpdir(), 'velum-authoring-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** テストごとに新しい空ディレクトリを作る */
const freshDir = (name: string): string => mkdtempSync(join(tmp, `${name}-`));

/** 投げられた Error を受け取る。スタブの「not implemented」を「投げた」と数えない */
function thrown(fn: () => unknown): Error {
  let caught: unknown;
  let didThrow = false;
  try {
    fn();
  } catch (e) {
    didThrow = true;
    caught = e;
  }
  expect(didThrow, '投げられるはずだった').toBe(true);
  expect(caught).toBeInstanceOf(Error);
  const err = caught as Error;
  expect(err.message).not.toMatch(/not implemented/);
  return err;
}

const ID_DRAFT = '20261003T135407Z-riko-draft-1a2b3c';
const NOW = new Date('2026-10-03T13:54:07.123Z');
const idFor = (subject = 'riko', purpose: 'draft' | 'revise' | 'probe' = 'draft', random = '1a2b3c') =>
  newRunId({ now: NOW, subject, purpose, random: () => random });

describe('runsRoot と定数', () => {
  it('runsRoot(root) は root 直下の .story-runs', () => {
    const root = join(tmp, 'some-root');
    expect(runsRoot(root)).toBe(join(root, '.story-runs'));
    expect(RUNS_DIR_NAME).toBe('.story-runs');
  });

  it('引数なしならリポジトリのルート直下', () => {
    expect(runsRoot()).toBe(join(ROOT, RUNS_DIR_NAME));
  });

  it('ロックと記録のファイル名', () => {
    expect(LOCK_FILE_NAME).toBe('.lock');
    expect(RUN_RECORD_FILE).toBe('run.json');
  });
});

describe('newRunId', () => {
  it('<UTC の日時>-<subject>-<purpose>-<6桁16進> の形になり、ミリ秒は入らない', () => {
    const id = newRunId({ now: NOW, subject: 'riko', purpose: 'draft', random: () => '1a2b3c' });
    expect(id).toBe('20261003T135407Z-riko-draft-1a2b3c');
    expect(id).toMatch(RUN_ID_PATTERN);
  });

  it('probe は subject に astra を取れる', () => {
    const id = newRunId({ now: NOW, subject: 'astra', purpose: 'probe', random: () => '1a2b3c' });
    expect(id).toBe('20261003T135407Z-astra-probe-1a2b3c');
    expect(id).toMatch(RUN_ID_PATTERN);
  });

  it('revise の目的も ID に入る', () => {
    const id = idFor('teo', 'revise', 'abcdef');
    expect(id).toBe('20261003T135407Z-teo-revise-abcdef');
    expect(id).toMatch(RUN_ID_PATTERN);
  });

  it('時刻は UTC で数える（日付をまたぐ瞬間も UTC のまま）', () => {
    const id = newRunId({
      now: new Date('2026-12-31T23:59:59.999Z'),
      subject: 'riko',
      purpose: 'draft',
      random: () => '000000',
    });
    expect(id).toBe('20261231T235959Z-riko-draft-000000');
  });

  it('名前順が時刻順になる', () => {
    const early = newRunId({
      now: new Date('2026-10-03T09:00:00Z'),
      subject: 'riko',
      purpose: 'draft',
      random: () => 'ffffff',
    });
    const late = newRunId({
      now: new Date('2026-10-03T10:00:00Z'),
      subject: 'riko',
      purpose: 'draft',
      random: () => '000000',
    });
    expect([late, early].sort()).toEqual([early, late]);
  });

  it('random は呼ばれた値がそのまま入る（関数が毎回の値を返す）', () => {
    const random = vi.fn().mockReturnValueOnce('0a0b0c').mockReturnValueOnce('d0e0f0');
    const first = newRunId({ now: NOW, subject: 'riko', purpose: 'draft', random });
    const second = newRunId({ now: NOW, subject: 'riko', purpose: 'draft', random });
    expect(first.endsWith('-0a0b0c')).toBe(true);
    expect(second.endsWith('-d0e0f0')).toBe(true);
  });

  it('subject が小文字英数字でなければ投げる（パスへ出られる値も含む）', () => {
    expect(idFor('riko')).toMatch(RUN_ID_PATTERN); // 対照: 正しい subject は通る
    for (const subject of ['Riko', '../x', '', 'ri-ko', 'ri ko', 'riko/x', 'りこ']) {
      thrown(() => idFor(subject));
    }
  });

  it('random が小文字16進の6桁でなければ投げる', () => {
    expect(idFor('riko', 'draft', '1a2b3c')).toMatch(RUN_ID_PATTERN); // 対照
    for (const random of ['XYZ', '1234567', '12345', '', 'ABCDEF', 'ghijkl', '12 456']) {
      thrown(() => idFor('riko', 'draft', random));
    }
  });
});

describe('createRunDir', () => {
  it('親の .story-runs が無ければ作って、run のディレクトリを返す', () => {
    const root = freshDir('create');
    const rr = runsRoot(root);
    expect(existsSync(rr)).toBe(false);
    const dir = createRunDir(rr, ID_DRAFT);
    expect(dir).toBe(join(rr, ID_DRAFT));
    expect(statSync(rr).isDirectory()).toBe(true);
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('同じ ID をもう一度作ると投げ、中に置いたファイルはそのまま', () => {
    const rr = join(freshDir('create-dup'), '.story-runs');
    const dir = createRunDir(rr, ID_DRAFT);
    writeFileSync(join(dir, 'keep.txt'), '残す');
    const err = thrown(() => createRunDir(rr, ID_DRAFT));
    expect(err.message).toContain(ID_DRAFT);
    expect(readFileSync(join(dir, 'keep.txt'), 'utf8')).toBe('残す');
    expect(readdirSync(dir)).toEqual(['keep.txt']);
  });

  it('別の ID なら同じ親の下に並べて作れる', () => {
    const rr = join(freshDir('create-two'), '.story-runs');
    const a = createRunDir(rr, idFor('riko', 'draft', 'aaaaaa'));
    const b = createRunDir(rr, idFor('riko', 'draft', 'bbbbbb'));
    expect(a).not.toBe(b);
    expect(readdirSync(rr).sort()).toEqual(
      [idFor('riko', 'draft', 'aaaaaa'), idFor('riko', 'draft', 'bbbbbb')].sort(),
    );
  });
});

describe('findRunDir', () => {
  it('既存の run の ID なら、そのディレクトリを返す', () => {
    const rr = join(freshDir('find'), '.story-runs');
    const created = createRunDir(rr, ID_DRAFT);
    expect(findRunDir(rr, ID_DRAFT)).toBe(created);
  });

  it('パスの外へ出る指定・形の違う ID は拒む（実在するディレクトリを指していても）', () => {
    const root = freshDir('find-bad');
    const rr = join(root, '.story-runs');
    const created = createRunDir(rr, ID_DRAFT);
    expect(findRunDir(rr, ID_DRAFT)).toBe(created); // 対照: 正しい ID は通る
    mkdirSync(join(root, 'x'), { recursive: true }); // '../x' が実在する
    mkdirSync(join(rr, 'abc'), { recursive: true }); // 'abc' が実在する
    for (const bad of ['../x', 'abc', 'x/../../etc', '', '.', '..', `${ID_DRAFT}/..`, `../${ID_DRAFT}`]) {
      thrown(() => findRunDir(rr, bad));
    }
  });

  it('形が正しくても存在しない ID は、どの ID が無いかを添えて投げる', () => {
    const rr = join(freshDir('find-missing'), '.story-runs');
    createRunDir(rr, ID_DRAFT);
    const missing = idFor('riko', 'draft', 'ffffff');
    const err = thrown(() => findRunDir(rr, missing));
    expect(err.message).toContain(missing);
  });

  it('.story-runs 自体が無くても、存在しない ID として投げる', () => {
    const rr = join(freshDir('find-noroot'), '.story-runs');
    const err = thrown(() => findRunDir(rr, ID_DRAFT));
    expect(err.message).toContain(ID_DRAFT);
  });
});

describe('writeFileNoClobber', () => {
  it('文字列を UTF-8 で書く', () => {
    const dir = freshDir('wnc-str');
    const path = join(dir, 'a.txt');
    writeFileNoClobber(path, '日本語の本文\n二行目');
    expect(readFileSync(path, 'utf8')).toBe('日本語の本文\n二行目');
    expect(readdirSync(dir)).toEqual(['a.txt']);
  });

  it('Uint8Array をそのままのバイトで書く', () => {
    const dir = freshDir('wnc-bytes');
    const path = join(dir, 'b.bin');
    const bytes = new Uint8Array([0x00, 0xff, 0xe3, 0x81, 0x82, 0x0a, 0x0d]);
    writeFileNoClobber(path, bytes);
    expect([...readFileSync(path)]).toEqual([...bytes]);
    expect(readdirSync(dir)).toEqual(['b.bin']);
  });

  it('空の文字列でも空のファイルを作る', () => {
    const dir = freshDir('wnc-empty');
    const path = join(dir, 'empty.txt');
    writeFileNoClobber(path, '');
    expect(readFileSync(path, 'utf8')).toBe('');
    expect(readdirSync(dir)).toEqual(['empty.txt']);
  });

  it('既にあれば投げ、既存の中身は変わらず、一時ファイルも残さない', () => {
    const dir = freshDir('wnc-exists');
    const path = join(dir, 'a.txt');
    writeFileNoClobber(path, '最初'); // 対照: 無ければ書ける
    const err = thrown(() => writeFileNoClobber(path, '上書きしたい'));
    expect(err).toBeInstanceOf(Error);
    expect(readFileSync(path, 'utf8')).toBe('最初');
    expect(readdirSync(dir)).toEqual(['a.txt']);
  });

  it('Uint8Array でも、既にあれば投げて中身は変わらない', () => {
    const dir = freshDir('wnc-exists-bytes');
    const path = join(dir, 'a.bin');
    writeFileSync(path, 'orig');
    writeFileNoClobber(join(dir, 'other.bin'), new Uint8Array([1])); // 対照
    thrown(() => writeFileNoClobber(path, new Uint8Array([1, 2, 3])));
    expect(readFileSync(path, 'utf8')).toBe('orig');
    expect(readdirSync(dir).sort()).toEqual(['a.bin', 'other.bin']);
  });

  it('成功のあとも失敗のあとも、ディレクトリには意図したファイルだけが残る', () => {
    const dir = freshDir('wnc-no-temp');
    writeFileNoClobber(join(dir, 'one.txt'), '1');
    writeFileNoClobber(join(dir, 'two.txt'), '2');
    expect(readdirSync(dir).sort()).toEqual(['one.txt', 'two.txt']);
    thrown(() => writeFileNoClobber(join(dir, 'one.txt'), 'x'));
    thrown(() => writeFileNoClobber(join(dir, 'two.txt'), 'y'));
    expect(readdirSync(dir).sort()).toEqual(['one.txt', 'two.txt']);
  });

  it('置き場のディレクトリが無ければ投げ、何も作らない', () => {
    const dir = freshDir('wnc-nodir');
    writeFileNoClobber(join(dir, 'ok.txt'), 'ok'); // 対照
    const missing = join(dir, 'nope', 'a.txt');
    thrown(() => writeFileNoClobber(missing, 'x'));
    expect(existsSync(join(dir, 'nope'))).toBe(false);
    expect(readdirSync(dir)).toEqual(['ok.txt']);
  });
});

describe('moveNoClobber', () => {
  it('別の名前へ移す（元は消え、移し先に同じ中身が残る）', () => {
    const dir = freshDir('mnc');
    const from = join(dir, 'manuscript.raw.md.partial');
    const to = join(dir, 'manuscript.raw.md');
    writeFileSync(from, '原稿の本文\n');
    moveNoClobber(from, to);
    expect(existsSync(from)).toBe(false);
    expect(readFileSync(to, 'utf8')).toBe('原稿の本文\n');
    expect(readdirSync(dir)).toEqual(['manuscript.raw.md']);
  });

  it('移し先があれば投げ、両方のファイルは変わらない', () => {
    const dir = freshDir('mnc-exists');
    const from = join(dir, 'from.txt');
    const to = join(dir, 'to.txt');
    writeFileSync(from, '移したい');
    writeFileSync(to, '先にあった');
    const other = join(dir, 'free.txt');
    moveNoClobber(from, other); // 対照: 空いている名前へは移せる
    writeFileSync(from, '移したい');
    thrown(() => moveNoClobber(from, to));
    expect(readFileSync(from, 'utf8')).toBe('移したい');
    expect(readFileSync(to, 'utf8')).toBe('先にあった');
    expect(readdirSync(dir).sort()).toEqual(['free.txt', 'from.txt', 'to.txt']);
  });

  it('元が無ければ投げ、移し先を作らない', () => {
    const dir = freshDir('mnc-nosrc');
    writeFileSync(join(dir, 'present.txt'), 'x');
    moveNoClobber(join(dir, 'present.txt'), join(dir, 'moved.txt')); // 対照
    thrown(() => moveNoClobber(join(dir, 'gone.txt'), join(dir, 'dest.txt')));
    expect(existsSync(join(dir, 'dest.txt'))).toBe(false);
    expect(readdirSync(dir)).toEqual(['moved.txt']);
  });
});

describe('acquireRunLock', () => {
  const info = { pid: 123, command: 'story:draft', acquiredAt: '2026-10-03T13:54:07.123Z' };
  const lockOf = (rr: string): string => join(rr, LOCK_FILE_NAME);
  const readLock = (rr: string): unknown => JSON.parse(readFileSync(lockOf(rr), 'utf8'));

  it('.story-runs/.lock を { pid, command, acquired_at } の JSON で作る', () => {
    const rr = freshDir('lock-create');
    const release = acquireRunLock(rr, info, () => true);
    expect(typeof release).toBe('function');
    expect(readLock(rr)).toEqual({
      pid: 123,
      command: 'story:draft',
      acquired_at: '2026-10-03T13:54:07.123Z',
    });
  });

  it('持ち主が生きている間の2回目は RunLockError で、「実行中」と言い、ロックは変わらない', () => {
    const rr = freshDir('lock-alive');
    acquireRunLock(rr, info, () => true);
    const isAlive = vi.fn((_pid: number) => true);
    const err = thrown(() =>
      acquireRunLock(rr, { pid: 456, command: 'story:revise', acquiredAt: '2026-10-03T14:00:00.000Z' }, isAlive),
    );
    expect(err).toBeInstanceOf(RunLockError);
    expect(err.name).toBe('RunLockError');
    expect(err.message).toContain('実行中');
    expect(isAlive).toHaveBeenCalledWith(123); // 確かめるのは持ち主の pid
    expect(readLock(rr)).toEqual({
      pid: 123,
      command: 'story:draft',
      acquired_at: '2026-10-03T13:54:07.123Z',
    });
    expect(readdirSync(rr)).toEqual([LOCK_FILE_NAME]);
  });

  it('持ち主がもういない古いロックは RunLockError。パスを示し、ロックは消さない', () => {
    const rr = freshDir('lock-stale');
    acquireRunLock(rr, info, () => true);
    const err = thrown(() =>
      acquireRunLock(rr, { pid: 456, command: 'story:revise', acquiredAt: '2026-10-03T14:00:00.000Z' }, () => false),
    );
    expect(err).toBeInstanceOf(RunLockError);
    expect(err.message).toContain(lockOf(rr));
    expect(existsSync(lockOf(rr))).toBe(true);
    expect(readLock(rr)).toEqual({
      pid: 123,
      command: 'story:draft',
      acquired_at: '2026-10-03T13:54:07.123Z',
    });
    expect(readdirSync(rr)).toEqual([LOCK_FILE_NAME]);
  });

  it('古いロックの案内: 前の run の Codex が残っているかもしれないことと確かめ方を、手で削除する手順より先に示す', () => {
    const rr = freshDir('lock-stale-codex');
    acquireRunLock(rr, info, () => true);
    const err = thrown(() =>
      acquireRunLock(rr, { pid: 456, command: 'story:revise', acquiredAt: '2026-10-03T14:00:00.000Z' }, () => false),
    );
    // 親（制作コマンド）が kill -9 で落ちても、別のプロセスグループの Codex は動き続けることがある
    expect(err.message).toContain('pgrep -fl "codex exec"');
    expect(err.message).toMatch(/Codex[^。]*(残って|動いて)/);
    expect(err.message.indexOf('pgrep')).toBeLessThan(err.message.indexOf('手で削除'));
    // 案内を足しても、ロックのパスと「消さない」は変わらない
    expect(err.message).toContain(lockOf(rr));
    expect(existsSync(lockOf(rr))).toBe(true);
  });

  it('持ち主が生きているときの案内に、pgrep の確認は混ぜない（そのコマンド自身の Codex が動いているだけ）', () => {
    const rr = freshDir('lock-alive-plain');
    acquireRunLock(rr, info, () => true);
    const err = thrown(() =>
      acquireRunLock(rr, { pid: 456, command: 'story:revise', acquiredAt: '2026-10-03T14:00:00.000Z' }, () => true),
    );
    expect(err.message).toContain('実行中');
    expect(err.message).not.toContain('pgrep');
  });

  it('解放の関数でロックが消え、そのあとは取り直せる', () => {
    const rr = freshDir('lock-release');
    const release = acquireRunLock(rr, info, () => true);
    expect(existsSync(lockOf(rr))).toBe(true);
    release();
    expect(existsSync(lockOf(rr))).toBe(false);
    const again = acquireRunLock(rr, { ...info, pid: 456 }, () => true);
    expect(readLock(rr)).toMatchObject({ pid: 456 });
    again();
    expect(existsSync(lockOf(rr))).toBe(false);
  });

  it('解放を2回呼んでもよい', () => {
    const rr = freshDir('lock-release-twice');
    const release = acquireRunLock(rr, info, () => true);
    release();
    expect(() => release()).not.toThrow();
    expect(existsSync(lockOf(rr))).toBe(false);
  });

  it('解放を2回呼んでも、そのあいだに別の実行が取ったロックは消さない', () => {
    const rr = freshDir('lock-release-twice-other');
    const releaseA = acquireRunLock(rr, info, () => true);
    releaseA();
    const releaseB = acquireRunLock(rr, { ...info, pid: 456, command: 'story:revise' }, () => true);
    releaseA(); // 古い解放をもう一度
    expect(existsSync(lockOf(rr))).toBe(true);
    expect(readLock(rr)).toMatchObject({ pid: 456, command: 'story:revise' });
    releaseB();
    expect(existsSync(lockOf(rr))).toBe(false);
  });

  it('ロックが別の pid のものに置き換わっていたら、解放は消さない', () => {
    const rr = freshDir('lock-replaced');
    const release = acquireRunLock(rr, info, () => true);
    const other = { pid: 999, command: 'story:revise', acquired_at: '2026-10-03T15:00:00.000Z' };
    writeFileSync(lockOf(rr), `${JSON.stringify(other)}\n`);
    release();
    expect(existsSync(lockOf(rr))).toBe(true);
    expect(readLock(rr)).toEqual(other);
  });

  it('isAlive の既定は process.kill(pid, 0): 生きている pid なら「実行中」', () => {
    const rr = freshDir('lock-default-alive');
    acquireRunLock(rr, { ...info, pid: process.pid });
    const err = thrown(() => acquireRunLock(rr, { ...info, pid: process.pid + 1 }));
    expect(err).toBeInstanceOf(RunLockError);
    expect(err.message).toContain('実行中');
  });

  it('isAlive の既定: 終わった子プロセスの pid なら古いロックとして、パスを示す', () => {
    const child = spawnSync(process.execPath, ['-e', '0']);
    expect(child.status).toBe(0);
    const deadPid = child.pid;
    expect(deadPid).toBeGreaterThan(0);
    const rr = freshDir('lock-default-dead');
    acquireRunLock(rr, { ...info, pid: deadPid });
    const err = thrown(() => acquireRunLock(rr, { ...info, pid: process.pid }));
    expect(err).toBeInstanceOf(RunLockError);
    expect(err.message).toContain(lockOf(rr));
    expect(existsSync(lockOf(rr))).toBe(true);
  });
});

describe('writeRunRecord / readRunRecord', () => {
  const hex = (c: string): string => c.repeat(64);

  const runningRecord = (): RunRecord => ({
    schema: RUN_RECORD_SCHEMA,
    run_id: ID_DRAFT,
    purpose: 'draft',
    stage: 'generated',
    parent_run_id: null,
    character_id: 'riko',
    status: 'running',
    started_at: '2026-10-03T13:54:07.123Z',
    finished_at: null,
    duration_ms: null,
    cli: { command: 'codex', version: 'codex-cli 0.153.4', min_version: '0.153.0' },
    requested: {
      provider: 'codex-cli',
      model: 'gpt-6-astra',
      reasoning_effort: 'medium',
      verbosity: 'low',
      authentication: 'chatgpt',
      credentials_store: 'auto',
      fallback: 'none',
      retries: 0,
      timeout_ms: 1_800_000,
    },
    effective: { model: null, model_source: 'not_reported' },
    auth_check: { method: 'chatgpt', checked_with: 'codex login status' },
    inputs: [
      {
        role: 'instructions',
        source: 'authoring/prompts/fixture-instructions.md',
        name: null,
        file: 'instructions.txt',
        sha256: hex('a'),
        bytes: 120,
        chars: 60,
      },
      {
        role: 'brief',
        source: 'external:fixture-brief.md',
        name: 'brief',
        file: 'brief.md',
        sha256: hex('b'),
        bytes: 300,
        chars: 100,
      },
    ],
    prompt: {
      file: 'prompt.txt',
      framing: 'fixture-framing',
      sha256: hex('c'),
      bytes: 500,
      chars: 200,
    },
    codex_args: ['exec', '--json', '-C', '<WORKDIR>', '-o', '<RUN_DIR>/manuscript.raw.md.partial'],
    env_removed: ['OPENAI_API_KEY'],
    process: null,
    events: null,
    output: null,
    diff: null,
    failure: null,
    warnings: [],
  });

  const succeededRecord = (): RunRecord => ({
    ...runningRecord(),
    status: 'succeeded',
    finished_at: '2026-10-03T14:10:07.123Z',
    duration_ms: 960_000,
    process: { exit_code: 0, signal: null, timed_out: false, interrupted: false, spawn_error: null },
    events: {
      file: 'events.jsonl',
      lines: 6,
      parse_errors: 0,
      thread_id: 'thread-fixture',
      turn_completed: true,
      item_types: { agent_message: 1, reasoning: 2 },
      unexpected_items: [],
      agent_messages: 1,
      usage: { input_tokens: 10, output_tokens: 20 },
    },
    output: {
      raw_file: 'manuscript.raw.md',
      raw_sha256: hex('d'),
      raw_bytes: 400,
      body_file: 'manuscript.body.txt',
      body_sha256: hex('e'),
      body_chars: 120,
      title: '固定の題',
      title_rule: 'markdown-h1',
    },
    warnings: ['固定の注意'],
  });

  const failedRecord = (): RunRecord => ({
    ...runningRecord(),
    status: 'failed',
    finished_at: '2026-10-03T14:24:07.123Z',
    duration_ms: 1_800_000,
    process: { exit_code: null, signal: 'SIGTERM', timed_out: true, interrupted: false, spawn_error: null },
    events: null,
    output: null,
    failure: { kind: 'timeout', message: '30 分で打ち切りました' },
  });

  const revisedRecord = (): RunRecord => ({
    ...succeededRecord(),
    run_id: '20261003T150000Z-riko-revise-abcdef',
    purpose: 'revise',
    stage: 'revised',
    parent_run_id: ID_DRAFT,
    diff: { file: 'revision.diff', parent_body_sha256: hex('f'), changed: true },
  });

  /** run.json を、書き込み関数を通さずに置く（読む側の検証を確かめる） */
  const putRaw = (dir: string, value: unknown): void => {
    writeFileSync(join(dir, RUN_RECORD_FILE), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  };

  it('テストで組んだ記録は RunRecordSchema を満たす（前提の確認）', () => {
    for (const record of [runningRecord(), succeededRecord(), failedRecord(), revisedRecord()]) {
      expect(() => RunRecordSchema.parse(record)).not.toThrow();
    }
  });

  it('書いて読むと同じ記録が返る', () => {
    const dir = freshDir('rec-roundtrip');
    const record = runningRecord();
    writeRunRecord(dir, record);
    expect(existsSync(join(dir, RUN_RECORD_FILE))).toBe(true);
    expect(readRunRecord(dir)).toEqual(record);
  });

  it('run.json は JSON として読める（書いた記録の内容そのまま）', () => {
    const dir = freshDir('rec-json');
    const record = succeededRecord();
    writeRunRecord(dir, record);
    expect(JSON.parse(readFileSync(join(dir, RUN_RECORD_FILE), 'utf8'))).toEqual(record);
  });

  it('成功・失敗・改稿のどの形の記録も往復できる', () => {
    for (const record of [succeededRecord(), failedRecord(), revisedRecord()]) {
      const dir = freshDir('rec-forms');
      writeRunRecord(dir, record);
      expect(readRunRecord(dir)).toEqual(record);
    }
  });

  it('もう一度書くと差し替わる（running → succeeded）。一時ファイルは残らない', () => {
    const dir = freshDir('rec-replace');
    writeRunRecord(dir, runningRecord());
    expect(readRunRecord(dir).status).toBe('running');
    expect(readdirSync(dir)).toEqual([RUN_RECORD_FILE]);
    writeRunRecord(dir, succeededRecord());
    expect(readRunRecord(dir)).toEqual(succeededRecord());
    expect(readRunRecord(dir).status).toBe('succeeded');
    expect(readdirSync(dir)).toEqual([RUN_RECORD_FILE]);
  });

  it('run のほかのファイルには触れない', () => {
    const dir = freshDir('rec-others');
    writeFileSync(join(dir, 'prompt.txt'), '依頼文');
    writeFileSync(join(dir, 'events.jsonl'), '{"type":"turn.started"}\n');
    writeRunRecord(dir, runningRecord());
    writeRunRecord(dir, failedRecord());
    expect(readdirSync(dir).sort()).toEqual(['events.jsonl', 'prompt.txt', RUN_RECORD_FILE]);
    expect(readFileSync(join(dir, 'prompt.txt'), 'utf8')).toBe('依頼文');
    expect(readFileSync(join(dir, 'events.jsonl'), 'utf8')).toBe('{"type":"turn.started"}\n');
  });

  /** 正しい記録は読める（対照）うえで、渡した値の run.json は読めない */
  const expectRejected = (name: string, value: unknown): void => {
    const okDir = freshDir(`${name}-ok`);
    putRaw(okDir, runningRecord());
    expect(readRunRecord(okDir)).toEqual(runningRecord());
    const dir = freshDir(name);
    putRaw(dir, value);
    thrown(() => readRunRecord(dir));
  };

  it('知らないキーのある run.json は読めない', () => {
    expectRejected('rec-unknown-key', { ...runningRecord(), extra: 1 });
  });

  it('入れ子の中の知らないキーも読めない', () => {
    const rec = runningRecord();
    expectRejected('rec-nested-unknown', { ...rec, requested: { ...rec.requested, extra: true } });
  });

  it('fallback が none 以外（gemini）の記録は読めない', () => {
    const rec = runningRecord();
    expectRejected('rec-fallback', { ...rec, requested: { ...rec.requested, fallback: 'gemini' } });
  });

  it('retries が 0 以外（1）の記録は読めない', () => {
    const rec = runningRecord();
    expectRejected('rec-retries', { ...rec, requested: { ...rec.requested, retries: 1 } });
  });

  it('run_id が形に合わない記録は読めない', () => {
    expectRejected('rec-bad-id', { ...runningRecord(), run_id: 'not-a-run-id' });
    expectRejected('rec-bad-parent', { ...runningRecord(), parent_run_id: '../x' });
  });

  it('schema の版が違う記録は読めない', () => {
    expectRejected('rec-schema', { ...runningRecord(), schema: 'velum-story-run/v0' });
  });

  it('sha256 が 64 桁の16進でない記録は読めない', () => {
    const rec = succeededRecord();
    expectRejected('rec-sha', { ...rec, prompt: { ...rec.prompt, sha256: 'abc' } });
  });

  it('JSON として壊れた run.json は読めない', () => {
    expectRejected('rec-broken', '{ "schema": "velum-story-run/v1", ');
  });

  it('run.json が無ければ読めない', () => {
    const dir = freshDir('rec-missing');
    writeRunRecord(freshDir('rec-missing-ok'), runningRecord()); // 対照
    thrown(() => readRunRecord(dir));
  });
});
