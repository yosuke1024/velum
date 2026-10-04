import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, it, expect } from 'vitest';
import {
  GLOBAL_INSTRUCTION_FILES,
  catalogModel,
  codexHomeOf,
  compareVersions,
  parseCodexVersion,
  parseLoginStatus,
  preflight,
} from '../../src/story/authoring/preflight.js';
import { loginStatusArgs } from '../../src/story/authoring/codex-command.js';
import type { WriterConfig } from '../../src/story/authoring/config.js';
import type { ShortResult, ShortRun } from '../../src/story/authoring/codex-process.js';
import { fakeShortRun, readCliFixture, REAL } from '../helpers/fake-codex.js';

const config: WriterConfig = {
  provider: 'codex-cli',
  model: 'gpt-6-astra',
  reasoning_effort: 'high',
  verbosity: null,
  fallback: 'none',
  authentication: 'chatgpt',
  credentials_store: 'keyring',
  instructions: 'authoring/prompts/x.txt',
  timeout_minutes: 30,
  cli: { command: 'codex', min_version: '0.153.0' },
};

const tmp = mkdtempSync(join(tmpdir(), 'velum-authoring-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let homeCounter = 0;
/** 空の CODEX_HOME（グローバルの指示ファイルが無い）。実機の ~/.codex を読まないよう、必ず一時ディレクトリを指す。 */
function emptyCodexHome(): string {
  homeCounter += 1;
  const dir = join(tmp, `codex-home-${homeCounter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** sanitizedEnv を通した子の環境の代わり（同じオブジェクトが各コマンドへ渡ることを見る） */
const childEnv = (): NodeJS.ProcessEnv => ({
  PATH: '/usr/bin',
  HOME: '/home/velum-test',
  CODEX_HOME: emptyCodexHome(),
});

const catalogWithout = (slug: string): string => {
  const parsed = JSON.parse(readCliFixture('models.json')) as { models: Array<{ slug: string }> };
  return JSON.stringify({ ...parsed, models: parsed.models.filter((m) => m.slug !== slug) });
};

/** fakeShortRun の上に、特定のコマンドだけ結果を差し替える。呼ばれた引数はここでも記録する。 */
function withOverride(
  base: ReturnType<typeof fakeShortRun>,
  match: (args: readonly string[]) => boolean,
  result: ShortResult,
) {
  const calls: string[][] = [];
  const run: ShortRun = async (args, options) => {
    calls.push([...args]);
    return match(args) ? result : base.run(args, options);
  };
  return { run, calls };
}

const hasExecCall = (calls: ReadonlyArray<{ args: readonly string[] }>): boolean =>
  calls.some((call) => call.args[0] === 'exec');

describe('preflight: parseCodexVersion', () => {
  it('"codex-cli 0.153.4" から版を取り出す', () => {
    expect(parseCodexVersion('codex-cli 0.153.4\n')).toBe('0.153.4');
    expect(parseCodexVersion(REAL.version)).toBe('0.153.4');
  });

  it('読めなければ null', () => {
    expect(parseCodexVersion('garbage')).toBeNull();
    expect(parseCodexVersion('')).toBeNull();
  });
});

describe('preflight: compareVersions', () => {
  it('a が新しければ正', () => {
    expect(compareVersions('0.153.4', '0.153.0')).toBeGreaterThan(0);
    expect(compareVersions('0.154.0', '0.153.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '0.999.999')).toBeGreaterThan(0);
  });

  it('a が古ければ負', () => {
    expect(compareVersions('0.152.9', '0.153.0')).toBeLessThan(0);
    expect(compareVersions('0.153.0', '0.153.4')).toBeLessThan(0);
  });

  it('等しければ 0', () => {
    // -0 を取り違えないよう === で見る
    expect(compareVersions('0.153.4', '0.153.4') === 0).toBe(true);
  });

  it('各桁を数として比べる（文字列比較にしない）', () => {
    expect(compareVersions('0.153.10', '0.153.9')).toBeGreaterThan(0);
    expect(compareVersions('0.153.9', '0.153.10')).toBeLessThan(0);
    expect(compareVersions('0.20.0', '0.3.0')).toBeGreaterThan(0);
  });
});

describe('preflight: parseLoginStatus', () => {
  it('ChatGPT でのログイン', () => {
    expect(parseLoginStatus(REAL.loginChatgpt)).toBe('chatgpt');
    expect(parseLoginStatus(`${REAL.loginChatgpt}\n`)).toBe('chatgpt');
  });

  it('API キーでのログイン', () => {
    expect(parseLoginStatus(REAL.loginApiKey)).toBe('api_key');
    expect(parseLoginStatus('Logged in using an API key')).toBe('api_key');
  });

  it('未ログイン', () => {
    expect(parseLoginStatus(REAL.notLoggedIn)).toBe('none');
  });

  it('それ以外は unknown（読めないものを ChatGPT とは見なさない）', () => {
    expect(parseLoginStatus('weird')).toBe('unknown');
    expect(parseLoginStatus('')).toBe('unknown');
  });
});

describe('preflight: catalogModel', () => {
  const fixture = readCliFixture('models.json');

  it('gpt-6-astra を引く', () => {
    const model = catalogModel(fixture, 'gpt-6-astra');
    expect(model.found).toBe(true);
    expect(model.efforts).toEqual(expect.arrayContaining(['high', 'xhigh', 'max']));
    expect(model.efforts).toEqual(
      expect.arrayContaining(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
    );
    expect(model.defaultEffort).toBe('medium');
    expect(model.supportsVerbosity).toBe(true);
    expect(model.defaultVerbosity).toBe('low');
  });

  it('モデルごとに対応する effort が違う（別のモデルの欄を読まない）', () => {
    const model = catalogModel(fixture, 'gpt-5.5');
    expect(model.found).toBe(true);
    expect(model.efforts).toContain('xhigh');
    expect(model.efforts).not.toContain('max');
    expect(model.efforts).not.toContain('ultra');
  });

  it('知らない slug は found: false で、ほかは空・null', () => {
    const model = catalogModel(fixture, 'gpt-nonexistent');
    expect(model.found).toBe(false);
    expect(model.efforts).toEqual([]);
    expect(model.defaultEffort).toBeNull();
    expect(model.supportsVerbosity).toBeNull();
    expect(model.defaultVerbosity).toBeNull();
  });

  it('slug は完全一致（前方一致で別のモデルを引かない）', () => {
    expect(catalogModel(fixture, 'gpt-6').found).toBe(false);
    expect(catalogModel(fixture, 'gpt-6-astra-x').found).toBe(false);
  });

  it('models が空なら found: false', () => {
    expect(catalogModel(JSON.stringify({ models: [] }), 'gpt-6-astra').found).toBe(false);
  });

  it('JSON として読めなければ投げる（読めるなら、モデルが無くても投げない）', () => {
    expect(() => catalogModel(fixture, 'gpt-nonexistent')).not.toThrow();
    expect(() => catalogModel('not json {', 'gpt-6-astra')).toThrow();
    expect(() => catalogModel('', 'gpt-6-astra')).toThrow();
  });

  it('欄が無いモデルは、無い欄を null / 空で返す', () => {
    const model = catalogModel(JSON.stringify({ models: [{ slug: 'bare' }] }), 'bare');
    expect(model.found).toBe(true);
    expect(model.efforts).toEqual([]);
    expect(model.defaultEffort).toBeNull();
    expect(model.supportsVerbosity).toBeNull();
    expect(model.defaultVerbosity).toBeNull();
  });

  it('base_instructions などの大きな欄は返さない', () => {
    const json = JSON.stringify({
      models: [
        {
          slug: 'gpt-6-astra',
          supported_reasoning_levels: [{ effort: 'high', description: 'h' }],
          default_reasoning_level: 'high',
          support_verbosity: false,
          default_verbosity: null,
          base_instructions: 'BIG-BASE-INSTRUCTIONS-MARKER '.repeat(50),
        },
      ],
    });
    const model = catalogModel(json, 'gpt-6-astra');
    expect(Object.keys(model).sort()).toEqual(
      ['defaultEffort', 'defaultVerbosity', 'efforts', 'found', 'supportsVerbosity'].sort(),
    );
    expect(JSON.stringify(model)).not.toContain('BIG-BASE-INSTRUCTIONS-MARKER');
    expect(model.supportsVerbosity).toBe(false);
    expect(model.defaultVerbosity).toBeNull();
    expect(model.efforts).toEqual(['high']);
  });
});

describe('preflight: 全部通るとき', () => {
  it('problems は空で、版・ログイン・カタログを返す', async () => {
    const env = childEnv();
    const short = fakeShortRun();
    const result = await preflight(config, { effort: 'high' }, { run: short.run, env });

    expect(result.problems).toEqual([]);
    expect(result.cliVersion).toBe('0.153.4');
    expect(result.login).toBe('chatgpt');
    expect(result.catalog?.found).toBe(true);
    expect(result.catalog?.efforts).toContain('high');
  });

  it('呼ぶのは --version / login status / debug models だけ（exec は呼ばない）', async () => {
    const env = childEnv();
    const short = fakeShortRun();
    await preflight(config, { effort: 'high' }, { run: short.run, env });

    expect(short.calls.map((call) => call.args)).toEqual([
      ['--version'],
      loginStatusArgs('keyring'),
      ['debug', 'models'],
    ]);
    expect(hasExecCall(short.calls)).toBe(false);
  });

  it('どのコマンドも、渡された env（sanitizedEnv を通したもの）をそのまま使う', async () => {
    const env = childEnv();
    const short = fakeShortRun();
    await preflight(config, { effort: 'high' }, { run: short.run, env });

    expect(short.calls.length).toBe(3);
    for (const call of short.calls) {
      expect(call.options.env).toBe(env);
      expect(call.options.timeoutMs).toBeGreaterThan(0);
    }
  });

  it('login status の引数は設定の credentials_store に従う', async () => {
    const env = childEnv();
    const short = fakeShortRun();
    await preflight(
      { ...config, credentials_store: 'file' },
      { effort: 'high' },
      { run: short.run, env },
    );

    const login = short.calls.find((call) => call.args[0] === 'login');
    expect(login?.args).toEqual(loginStatusArgs('file'));
  });

  it('最低の版ちょうど・それより新しい版は通る', async () => {
    for (const version of ['codex-cli 0.153.0', 'codex-cli 0.154.2', 'codex-cli 1.0.0']) {
      const result = await preflight(
        config,
        { effort: 'high' },
        { run: fakeShortRun({ version }).run, env: childEnv() },
      );
      expect(result.problems).toEqual([]);
    }
  });

  it('最低の版は設定（cli.min_version）から取る', async () => {
    const result = await preflight(
      { ...config, cli: { command: 'codex', min_version: '0.200.0' } },
      { effort: 'high' },
      { run: fakeShortRun().run, env: childEnv() },
    );
    expect(result.cliVersion).toBe('0.153.4');
    expect(result.problems.some((problem) => problem.includes('0.200.0'))).toBe(true);
  });

  it('effort は依頼（request）のものを見る。設定の reasoning_effort ではない', async () => {
    const short = fakeShortRun();
    const result = await preflight(
      { ...config, reasoning_effort: 'superhigh' },
      { effort: 'xhigh' },
      { run: short.run, env: childEnv() },
    );
    expect(result.problems).toEqual([]);
  });

  it('カタログが対応する effort（max・ultra を含む）は通る', async () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
      const result = await preflight(
        config,
        { effort },
        { run: fakeShortRun().run, env: childEnv() },
      );
      expect(result.problems, effort).toEqual([]);
    }
  });

  it('login status が stdout に出る版でも読める（stdout と stderr をつなぐ）', async () => {
    const short = withOverride(
      fakeShortRun(),
      (args) => args[0] === 'login',
      { exitCode: 0, stdout: `${REAL.loginChatgpt}\n`, stderr: '', error: null },
    );
    const result = await preflight(config, { effort: 'high' }, { run: short.run, env: childEnv() });
    expect(result.login).toBe('chatgpt');
    expect(result.problems).toEqual([]);
  });
});

describe('preflight: 通らないとき（problems に入れて返す。投げない。exec は呼ばない）', () => {
  it('CLI の版が最低より古い', async () => {
    const short = fakeShortRun({ version: 'codex-cli 0.152.9' });
    const result = await preflight(config, { effort: 'high' }, { run: short.run, env: childEnv() });

    expect(result.cliVersion).toBe('0.152.9');
    expect(result.problems.length).toBeGreaterThan(0);
    expect(result.problems.some((problem) => problem.includes('0.153.0'))).toBe(true);
    expect(hasExecCall(short.calls)).toBe(false);
  });

  it('版の出力が読めない', async () => {
    const short = fakeShortRun({ version: 'weird output' });
    const result = await preflight(config, { effort: 'high' }, { run: short.run, env: childEnv() });

    expect(result.cliVersion).toBeNull();
    expect(result.problems.length).toBeGreaterThan(0);
    expect(hasExecCall(short.calls)).toBe(false);
  });

  it('API キーでログインしている → 実行しない（切り替えの副作用を避ける）', async () => {
    const short = fakeShortRun({ login: REAL.loginApiKey });
    const result = await preflight(config, { effort: 'high' }, { run: short.run, env: childEnv() });

    expect(result.login).toBe('api_key');
    const problem = result.problems.find((text) => text.includes('API キー'));
    expect(problem).toBeDefined();
    expect(problem).toMatch(/実行しな|中止/);
    expect(hasExecCall(short.calls)).toBe(false);
  });

  it('未ログイン → codex login を案内する', async () => {
    const short = fakeShortRun({ login: REAL.notLoggedIn });
    const result = await preflight(config, { effort: 'high' }, { run: short.run, env: childEnv() });

    expect(result.login).toBe('none');
    expect(result.problems.some((problem) => problem.includes('codex login'))).toBe(true);
    expect(hasExecCall(short.calls)).toBe(false);
  });

  it('login status の実行が失敗（timeout など） → ChatGPT とは見なさない', async () => {
    const short = withOverride(
      fakeShortRun(),
      (args) => args[0] === 'login',
      { exitCode: null, stdout: '', stderr: '', error: 'timeout after 30000ms' },
    );
    const result = await preflight(config, { effort: 'high' }, { run: short.run, env: childEnv() });

    expect(result.login).not.toBe('chatgpt');
    expect(result.problems.length).toBeGreaterThan(0);
    expect(short.calls.some((args) => args[0] === 'exec')).toBe(false);
  });

  it('codex が見つからない → 投げずに problems', async () => {
    const short = fakeShortRun({ missingCli: true });
    const result = await preflight(config, { effort: 'high' }, { run: short.run, env: childEnv() });

    expect(result.problems.length).toBeGreaterThan(0);
    expect(result.cliVersion).toBeNull();
    expect(result.login).not.toBe('chatgpt');
    expect(result.catalog?.found ?? false).toBe(false);
    expect(hasExecCall(short.calls)).toBe(false);
  });

  it('モデルがカタログに無い', async () => {
    const short = fakeShortRun({ catalog: catalogWithout('gpt-6-astra') });
    const result = await preflight(config, { effort: 'high' }, { run: short.run, env: childEnv() });

    expect(result.catalog?.found).toBe(false);
    expect(result.problems.some((problem) => problem.includes('gpt-6-astra'))).toBe(true);
    expect(hasExecCall(short.calls)).toBe(false);
  });

  it('モデルは設定（model）から取る', async () => {
    const short = fakeShortRun();
    const result = await preflight(
      { ...config, model: 'gpt-not-in-catalog' },
      { effort: 'high' },
      { run: short.run, env: childEnv() },
    );

    expect(result.catalog?.found).toBe(false);
    expect(result.problems.some((problem) => problem.includes('gpt-not-in-catalog'))).toBe(true);
  });

  it('対応しない effort → 対応する一覧を示す。黙って別の effort にしない', async () => {
    const short = fakeShortRun();
    const result = await preflight(
      config,
      { effort: 'superhigh' },
      { run: short.run, env: childEnv() },
    );

    expect(result.problems.length).toBeGreaterThan(0);
    const problem = result.problems.find((text) => text.includes('superhigh'));
    expect(problem).toBeDefined();
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
      expect(problem).toContain(effort);
    }
    // 代わりの effort を提案・採用する欄は結果に無い
    expect(Object.keys(result).filter((key) => /effort/i.test(key))).toEqual([]);
    expect(hasExecCall(short.calls)).toBe(false);
  });

  it('effort の対応はモデルごとに見る（gpt-5.5 は max・ultra に対応しない）', async () => {
    const short = fakeShortRun();
    const result = await preflight(
      { ...config, model: 'gpt-5.5' },
      { effort: 'max' },
      { run: short.run, env: childEnv() },
    );

    const problem = result.problems.find((text) => text.includes('max'));
    expect(problem).toBeDefined();
    expect(problem).toContain('xhigh');
  });

  it('カタログが壊れた JSON → 投げずに problems', async () => {
    const short = fakeShortRun({ catalog: 'not json {' });
    const result = await preflight(config, { effort: 'high' }, { run: short.run, env: childEnv() });

    expect(result.problems.length).toBeGreaterThan(0);
    expect(result.catalog?.found ?? false).toBe(false);
    expect(hasExecCall(short.calls)).toBe(false);
  });

  it('debug models の実行が失敗 → 投げずに problems', async () => {
    const short = withOverride(
      fakeShortRun(),
      (args) => args[0] === 'debug' && args[1] === 'models',
      { exitCode: 1, stdout: '', stderr: 'boom\n', error: null },
    );
    const result = await preflight(config, { effort: 'high' }, { run: short.run, env: childEnv() });

    expect(result.problems.length).toBeGreaterThan(0);
    expect(short.calls.some((args) => args[0] === 'exec')).toBe(false);
  });
});

// ── グローバルの指示ファイル（$CODEX_HOME/AGENTS.md）──────────────

describe('preflight: codexHomeOf', () => {
  it('CODEX_HOME があればそれを使う（HOME より優先）', () => {
    expect(codexHomeOf({ CODEX_HOME: '/data/codex', HOME: '/home/u' })).toBe('/data/codex');
  });

  it('CODEX_HOME が無ければ HOME/.codex', () => {
    expect(codexHomeOf({ HOME: '/home/u' })).toBe(join('/home/u', '.codex'));
  });

  it('CODEX_HOME が空文字なら、無いものとして HOME/.codex', () => {
    expect(codexHomeOf({ CODEX_HOME: '', HOME: '/home/u' })).toBe(join('/home/u', '.codex'));
  });

  it('どちらも無ければ null', () => {
    expect(codexHomeOf({ PATH: '/usr/bin' })).toBeNull();
    expect(codexHomeOf({ CODEX_HOME: '', HOME: '' })).toBeNull();
  });
});

describe('preflight: GLOBAL_INSTRUCTION_FILES', () => {
  it('AGENTS.md と AGENTS.override.md の2つ', () => {
    expect([...GLOBAL_INSTRUCTION_FILES].sort()).toEqual(['AGENTS.md', 'AGENTS.override.md']);
  });
});

describe('preflight: グローバルの AGENTS.md があれば止まる（Codex の設定では消せず、Astra へ届くため）', () => {
  const codexHome = '/velum-test-codex-home';
  const filesPresent =
    (...names: string[]) =>
    (path: string): boolean =>
      names.some((name) => path === join(codexHome, name));
  const envAt = (): NodeJS.ProcessEnv => ({ PATH: '/usr/bin', HOME: '/home/velum-test', CODEX_HOME: codexHome });

  it('AGENTS.md がある → problems にそのパスを入れ、どの codex コマンドも起こさない（最初に調べる）', async () => {
    const short = fakeShortRun();
    const result = await preflight(
      config,
      { effort: 'high' },
      { run: short.run, env: envAt(), fileExists: filesPresent('AGENTS.md') },
    );

    expect(result.problems.length).toBeGreaterThan(0);
    expect(result.problems.some((problem) => problem.includes(join(codexHome, 'AGENTS.md')))).toBe(true);
    expect(short.calls).toEqual([]);
    expect(result.cliVersion).toBeNull();
    expect(result.login).not.toBe('chatgpt');
  });

  it('AGENTS.override.md だけでも止まる', async () => {
    const short = fakeShortRun();
    const result = await preflight(
      config,
      { effort: 'high' },
      { run: short.run, env: envAt(), fileExists: filesPresent('AGENTS.override.md') },
    );

    expect(result.problems.some((problem) => problem.includes(join(codexHome, 'AGENTS.override.md')))).toBe(true);
    expect(result.problems.some((problem) => problem.includes(join(codexHome, 'AGENTS.md')))).toBe(false);
    expect(short.calls).toEqual([]);
  });

  it('両方あれば、両方のパスを示す', async () => {
    const result = await preflight(
      config,
      { effort: 'high' },
      { run: fakeShortRun().run, env: envAt(), fileExists: filesPresent('AGENTS.md', 'AGENTS.override.md') },
    );

    const text = result.problems.join('\n');
    expect(text).toContain(join(codexHome, 'AGENTS.md'));
    expect(text).toContain(join(codexHome, 'AGENTS.override.md'));
  });

  it('文面は、Astra へ注入されること・一時的に別の場所へ移すことを説明し、削除を勧めない', async () => {
    const result = await preflight(
      config,
      { effort: 'high' },
      { run: fakeShortRun().run, env: envAt(), fileExists: filesPresent('AGENTS.md') },
    );

    const problem = result.problems.find((text) => text.includes(join(codexHome, 'AGENTS.md')));
    expect(problem).toBeDefined();
    expect(problem).toMatch(/注入|届|混ざ/);
    expect(problem).toContain('一時的');
    expect(problem).toMatch(/移/);
    expect(problem).not.toMatch(/削除|消して|rm /);
  });

  it('CODEX_HOME が無ければ HOME/.codex を調べる', async () => {
    const seen: string[] = [];
    await preflight(
      config,
      { effort: 'high' },
      {
        run: fakeShortRun().run,
        env: { PATH: '/usr/bin', HOME: '/home/velum-test' },
        fileExists: (path) => {
          seen.push(path);
          return false;
        },
      },
    );

    expect(seen).toContain(join('/home/velum-test', '.codex', 'AGENTS.md'));
    expect(seen).toContain(join('/home/velum-test', '.codex', 'AGENTS.override.md'));
  });

  it('CODEX_HOME があれば、そこだけを調べる（HOME/.codex は見ない）', async () => {
    const seen: string[] = [];
    await preflight(
      config,
      { effort: 'high' },
      {
        run: fakeShortRun().run,
        env: envAt(),
        fileExists: (path) => {
          seen.push(path);
          return false;
        },
      },
    );

    expect(seen.length).toBeGreaterThan(0);
    for (const path of seen) expect(path.startsWith(codexHome)).toBe(true);
  });

  it('fileExists を渡さなければ、実際のファイルを見る（一時ディレクトリの CODEX_HOME）', async () => {
    const home = emptyCodexHome();
    const clean = await preflight(
      config,
      { effort: 'high' },
      { run: fakeShortRun().run, env: { PATH: '/usr/bin', HOME: '/home/velum-test', CODEX_HOME: home } },
    );
    expect(clean.problems).toEqual([]);

    writeFileSync(join(home, 'AGENTS.md'), '# 開発用の指示\n');
    const short = fakeShortRun();
    const blocked = await preflight(
      config,
      { effort: 'high' },
      { run: short.run, env: { PATH: '/usr/bin', HOME: '/home/velum-test', CODEX_HOME: home } },
    );
    expect(blocked.problems.some((problem) => problem.includes(join(home, 'AGENTS.md')))).toBe(true);
    expect(short.calls).toEqual([]);
  });

  it('ファイルには触れない（preflight が止めても、ファイルは残る）', async () => {
    const home = emptyCodexHome();
    const file = join(home, 'AGENTS.md');
    writeFileSync(file, 'keep me\n');
    await preflight(
      config,
      { effort: 'high' },
      { run: fakeShortRun().run, env: { PATH: '/usr/bin', HOME: '/home/velum-test', CODEX_HOME: home } },
    );
    expect(readFileSync(file, 'utf8')).toBe('keep me\n');
  });

  it('どちらも無ければ、いつもどおり3つのコマンドを実行して通る', async () => {
    const short = fakeShortRun();
    const result = await preflight(
      config,
      { effort: 'high' },
      { run: short.run, env: envAt(), fileExists: () => false },
    );

    expect(result.problems).toEqual([]);
    expect(short.calls).toHaveLength(3);
  });
});

// ── 中断 ────────────────────────────────────────────────────

describe('preflight: 親の中断（abortSignal）', () => {
  it('どの短いコマンドにも abortSignal をそのまま渡す', async () => {
    const controller = new AbortController();
    const short = fakeShortRun();
    await preflight(
      config,
      { effort: 'high' },
      { run: short.run, env: childEnv(), abortSignal: controller.signal },
    );

    expect(short.calls).toHaveLength(3);
    for (const call of short.calls) expect(call.options.abortSignal).toBe(controller.signal);
  });

  it('最初から中断されていれば、コマンドを1つも起こさず「中断」を problems に入れて返す', async () => {
    const controller = new AbortController();
    controller.abort();
    const short = fakeShortRun();
    const result = await preflight(
      config,
      { effort: 'high' },
      { run: short.run, env: childEnv(), abortSignal: controller.signal },
    );

    expect(short.calls).toEqual([]);
    expect(result.problems.some((problem) => problem.includes('中断'))).toBe(true);
    expect(result.cliVersion).toBeNull();
    expect(result.login).not.toBe('chatgpt');
    expect(result.catalog).toBeNull();
  });

  it('1つ目のコマンドの実行中に中断されたら、次のコマンドを起こさない', async () => {
    const controller = new AbortController();
    const base = fakeShortRun();
    const calls: string[][] = [];
    const run: ShortRun = async (args, options) => {
      calls.push([...args]);
      const result = await base.run(args, options);
      controller.abort();
      return result;
    };
    const result = await preflight(
      config,
      { effort: 'high' },
      { run, env: childEnv(), abortSignal: controller.signal },
    );

    expect(calls).toEqual([['--version']]);
    expect(result.problems.some((problem) => problem.includes('中断'))).toBe(true);
  });

  it('2つ目（login status）の実行中に中断されたら、3つ目（debug models）を起こさない', async () => {
    const controller = new AbortController();
    const base = fakeShortRun();
    const calls: string[][] = [];
    const run: ShortRun = async (args, options) => {
      calls.push([...args]);
      const result = await base.run(args, options);
      if (args[0] === 'login') controller.abort();
      return result;
    };
    const result = await preflight(
      config,
      { effort: 'high' },
      { run, env: childEnv(), abortSignal: controller.signal },
    );

    expect(calls).toEqual([['--version'], loginStatusArgs('keyring')]);
    expect(result.problems.some((problem) => problem.includes('中断'))).toBe(true);
  });

  it('実行中に中断された（ShortRun が interrupted の error を返した）ことを、PATH の誤りとして案内しない', async () => {
    const controller = new AbortController();
    const run: ShortRun = async () => {
      controller.abort();
      return { exitCode: null, stdout: '', stderr: '', error: 'interrupted: 親の中断で止めた' };
    };
    const result = await preflight(
      config,
      { effort: 'high' },
      { run, env: childEnv(), abortSignal: controller.signal },
    );

    expect(result.problems.some((problem) => problem.includes('中断'))).toBe(true);
    expect(result.problems.some((problem) => problem.includes('PATH'))).toBe(false);
    expect(result.cliVersion).toBeNull();
  });

  it('中断されていなければ、problems に「中断」は出ない', async () => {
    const controller = new AbortController();
    const result = await preflight(
      config,
      { effort: 'high' },
      { run: fakeShortRun().run, env: childEnv(), abortSignal: controller.signal },
    );
    expect(result.problems).toEqual([]);
  });
});

// ── CLI が古いときの更新の案内 ──────────────────────────────

describe('preflight: CLI の版が古いとき、更新のしかたを示す（spec §5.4。自動では更新しない）', () => {
  it('npm での更新コマンド・自動更新しないこと・docs の節を示す', async () => {
    const short = fakeShortRun({ version: 'codex-cli 0.152.9' });
    const result = await preflight(config, { effort: 'high' }, { run: short.run, env: childEnv() });

    const problem = result.problems.find((text) => text.includes('0.153.0'));
    expect(problem).toBeDefined();
    expect(problem).toContain('0.152.9');
    expect(problem).toContain('npm install -g @openai/codex@<版>');
    expect(problem).toMatch(/自動(?:では|で)?更新(?:し|され)(?:ません|ない)/);
    expect(problem).toContain('docs/story-authoring.md §3');
  });
});
