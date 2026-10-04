import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  DOCTOR_SENTINEL_PROVIDER,
  FORCED_LOGIN_METHOD,
  ISOLATION_OVERRIDES,
  MODEL_PROVIDER,
  PROMPT_INPUT_MARKER,
  REQUIRED_EXEC_FLAGS,
  catalogArgs,
  codexExecArgs,
  execHelpArgs,
  isRemovedEnvKey,
  loginStatusArgs,
  promptInputArgs,
  redactArgs,
  sanitizedEnv,
  tomlString,
  versionArgs,
  type CodexExecArgsInput,
} from '../../src/story/authoring/codex-command.js';
import { readCliFixture } from '../helpers/fake-codex.js';

type Golden = {
  cli_version: string;
  verified_live: boolean;
  verified_on?: string;
  verified_with?: string;
  input: CodexExecArgsInput;
  args: string[];
};

const GOLDEN_PATH = fileURLToPath(
  new URL('../fixtures/authoring/codex-exec-args.json', import.meta.url),
);
const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Golden;

const BASE: CodexExecArgsInput = {
  model: 'gpt-6-astra',
  effort: 'high',
  verbosity: null,
  credentialsStore: 'keyring',
  instructionsFile: '/RUN/instructions.txt',
  outputLastMessage: '/RUN/manuscript.raw.md.partial',
  workdir: '/WORK',
};

/** args の中で first の直後に second が続く位置（無ければ -1）。 */
function indexOfPair(args: readonly string[], first: string, second: string): number {
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === first && args[i + 1] === second) return i;
  }
  return -1;
}
const hasPair = (args: readonly string[], first: string, second: string): boolean =>
  indexOfPair(args, first, second) >= 0;

const FORBIDDEN = [
  'resume',
  'fork',
  '--last',
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-bypass-hook-trust',
  '--ignore-rules',
  '--approve-for-me',
  '--yolo',
  'danger-full-access',
  'workspace-write',
  '--oss',
] as const;

const NASTY_PATH = '/tmp/リコ の "原稿"\\dir/instr.txt';

describe('codexExecArgs: 実機の記録（golden）', () => {
  it('fixture は 0.153.4 で live に確かめた引数（probe の run を記録している）', () => {
    expect(golden.cli_version).toBe('0.153.4');
    expect(golden.verified_live).toBe(true);
    expect(golden.verified_with).toMatch(/story:doctor -- --probe/);
    expect(golden.input).toEqual(BASE);
  });

  it('fixture の入力から、fixture の引数の配列がそのまま作られる', () => {
    expect(codexExecArgs(golden.input)).toEqual(golden.args);
  });

  it('fixture の隔離の上書きは ISOLATION_OVERRIDES と同じ内容・同じ順序', () => {
    const instructionsAt = golden.args.findIndex((a) => a.startsWith('model_instructions_file='));
    expect(instructionsAt).toBeGreaterThan(0);
    const tail = golden.args.slice(instructionsAt + 1, -1);
    expect(tail).toEqual(ISOLATION_OVERRIDES.flatMap((o) => ['-c', o]));
  });

  it('呼ぶたびに新しい配列を返し、入力を書き換えない', () => {
    const input = Object.freeze({ ...BASE });
    const first = codexExecArgs(input);
    first.push('--mutated');
    const second = codexExecArgs(input);
    expect(second).toEqual(golden.args);
    expect(second).not.toBe(first);
    expect(input).toEqual(BASE);
  });
});

describe('codexExecArgs: 必ず含まれるもの', () => {
  it('先頭は exec、最後は stdin を読む -', () => {
    const args = codexExecArgs(BASE);
    expect(args[0]).toBe('exec');
    expect(args[args.length - 1]).toBe('-');
    expect(args.filter((a) => a === '-')).toHaveLength(1);
  });

  it('設定とユーザー設定の隔離（--ignore-user-config / --strict-config）', () => {
    const args = codexExecArgs(BASE);
    expect(args).toContain('--ignore-user-config');
    expect(args).toContain('--strict-config');
  });

  it('モデル・sandbox・git・保存しない・JSON・色なし', () => {
    const args = codexExecArgs(BASE);
    expect(hasPair(args, '--model', 'gpt-6-astra')).toBe(true);
    expect(hasPair(args, '--sandbox', 'read-only')).toBe(true);
    expect(args).toContain('--skip-git-repo-check');
    expect(args).toContain('--ephemeral');
    expect(args).toContain('--json');
    expect(hasPair(args, '--color', 'never')).toBe(true);
  });

  it('作業ディレクトリと最終応答の書き先', () => {
    const args = codexExecArgs(BASE);
    expect(hasPair(args, '--cd', '/WORK')).toBe(true);
    expect(hasPair(args, '--output-last-message', '/RUN/manuscript.raw.md.partial')).toBe(true);
  });

  it('認証・provider・credentials store・effort の上書き', () => {
    const args = codexExecArgs(BASE);
    expect(hasPair(args, '-c', 'forced_login_method="chatgpt"')).toBe(true);
    expect(hasPair(args, '-c', 'model_provider="openai"')).toBe(true);
    expect(hasPair(args, '-c', 'cli_auth_credentials_store="keyring"')).toBe(true);
    expect(hasPair(args, '-c', 'model_reasoning_effort="high"')).toBe(true);
  });

  it('instructions ファイルは TOML 文字列で1つだけ渡す', () => {
    const args = codexExecArgs(BASE);
    const matches = args.filter((a) => a.startsWith('model_instructions_file='));
    expect(matches).toEqual(['model_instructions_file="/RUN/instructions.txt"']);
    expect(hasPair(args, '-c', 'model_instructions_file="/RUN/instructions.txt"')).toBe(true);
  });

  it('ISOLATION_OVERRIDES の全項目を、直前に -c を付けて1回ずつ含む', () => {
    const args = codexExecArgs(BASE);
    expect(ISOLATION_OVERRIDES.length).toBeGreaterThan(0);
    for (const override of ISOLATION_OVERRIDES) {
      const at = args.indexOf(override);
      expect(at, `含まれていない: ${override}`).toBeGreaterThan(0);
      expect(args[at - 1], `-c が直前に無い: ${override}`).toBe('-c');
      expect(args.filter((a) => a === override)).toHaveLength(1);
    }
  });

  it('-c の数は、認証4 + instructions 1 + 隔離の数（verbosity なし）', () => {
    const args = codexExecArgs(BASE);
    expect(args.filter((a) => a === '-c')).toHaveLength(4 + 1 + ISOLATION_OVERRIDES.length);
  });

  it('exec が使う長いフラグは、すべて REQUIRED_EXEC_FLAGS に載っている（doctor の照合から漏れない）', () => {
    const args = codexExecArgs(BASE);
    const longFlags = args.filter((a) => a.startsWith('--'));
    expect(longFlags.length).toBeGreaterThan(0);
    for (const flag of longFlags) {
      expect(REQUIRED_EXEC_FLAGS, `照合の対象外: ${flag}`).toContain(flag);
    }
  });
});

describe('codexExecArgs: 決して含まれないもの', () => {
  const variants: Array<[string, () => string[]]> = [
    ['既定', () => codexExecArgs(BASE)],
    ['verbosity あり', () => codexExecArgs({ ...BASE, verbosity: 'high' })],
    ['別の store と effort', () => codexExecArgs({ ...BASE, credentialsStore: 'file', effort: 'xhigh' })],
    ['doctor の provider', () => codexExecArgs({ ...BASE, provider: DOCTOR_SENTINEL_PROVIDER })],
    [
      '特殊なパス',
      () => codexExecArgs({ ...BASE, instructionsFile: NASTY_PATH, workdir: NASTY_PATH }),
    ],
  ];

  for (const [label, build] of variants) {
    it(`${label}: 禁止の引数が1つも無い`, () => {
      const args = build();
      for (const forbidden of FORBIDDEN) {
        expect(args, `含まれてはいけない: ${forbidden}`).not.toContain(forbidden);
      }
      for (const arg of args) {
        expect(arg.startsWith('--dangerously'), arg).toBe(false);
        expect(arg.includes('danger-full-access'), arg).toBe(false);
        expect(arg.includes('workspace-write'), arg).toBe(false);
        expect(arg.includes('bypass'), arg).toBe(false);
      }
    });
  }
});

describe('codexExecArgs: verbosity', () => {
  it('null なら model_verbosity を渡さない', () => {
    const args = codexExecArgs({ ...BASE, verbosity: null });
    expect(args.some((a) => a.includes('model_verbosity'))).toBe(false);
  });

  it('medium なら effort の直後・instructions の直前に -c model_verbosity="medium"', () => {
    const args = codexExecArgs({ ...BASE, verbosity: 'medium' });
    const effortAt = indexOfPair(args, '-c', 'model_reasoning_effort="high"');
    expect(effortAt).toBeGreaterThan(0);
    expect(args[effortAt + 2]).toBe('-c');
    expect(args[effortAt + 3]).toBe('model_verbosity="medium"');
    expect(args[effortAt + 4]).toBe('-c');
    expect(args[effortAt + 5]?.startsWith('model_instructions_file=')).toBe(true);
  });

  it.each(['low', 'medium', 'high'] as const)('%s は model_verbosity として TOML 文字列で渡る', (verbosity) => {
    const args = codexExecArgs({ ...BASE, verbosity });
    expect(hasPair(args, '-c', `model_verbosity="${verbosity}"`)).toBe(true);
    expect(args.filter((a) => a.includes('model_verbosity'))).toHaveLength(1);
  });

  it('verbosity の2要素を除けば、null のときの引数と完全に一致する', () => {
    const withVerbosity = codexExecArgs({ ...BASE, verbosity: 'medium' });
    expect(withVerbosity).toHaveLength(golden.args.length + 2);
    const expected = [...golden.args];
    const effortValueAt = expected.indexOf('model_reasoning_effort="high"');
    expect(effortValueAt).toBeGreaterThan(0);
    expected.splice(effortValueAt + 1, 0, '-c', 'model_verbosity="medium"');
    expect(withVerbosity).toEqual(expected);
  });
});

describe('codexExecArgs: provider・model・effort・store の反映', () => {
  it('既定の provider は MODEL_PROVIDER、認証は FORCED_LOGIN_METHOD', () => {
    expect(MODEL_PROVIDER).toBe('openai');
    expect(FORCED_LOGIN_METHOD).toBe('chatgpt');
  });

  it('provider を渡すとその名前になり、openai は残らない（doctor の設定検査）', () => {
    expect(DOCTOR_SENTINEL_PROVIDER).toBe('velum-doctor-no-inference');
    const args = codexExecArgs({ ...BASE, provider: DOCTOR_SENTINEL_PROVIDER });
    expect(hasPair(args, '-c', `model_provider="${DOCTOR_SENTINEL_PROVIDER}"`)).toBe(true);
    expect(args).not.toContain('model_provider="openai"');
    // provider の1要素以外は、既定の引数と同じ
    const expected = golden.args.map((a) =>
      a === 'model_provider="openai"' ? `model_provider="${DOCTOR_SENTINEL_PROVIDER}"` : a,
    );
    expect(args).toEqual(expected);
  });

  it('model・effort は渡した値が使われ、前の値は残らない', () => {
    const args = codexExecArgs({ ...BASE, model: 'gpt-test-model', effort: 'xhigh' });
    expect(hasPair(args, '--model', 'gpt-test-model')).toBe(true);
    expect(hasPair(args, '-c', 'model_reasoning_effort="xhigh"')).toBe(true);
    expect(args).not.toContain('gpt-6-astra');
    expect(args).not.toContain('model_reasoning_effort="high"');
  });

  it.each(['keyring', 'file', 'auto'] as const)('credentials store %s が -c に入る', (store) => {
    const args = codexExecArgs({ ...BASE, credentialsStore: store });
    expect(hasPair(args, '-c', `cli_auth_credentials_store="${store}"`)).toBe(true);
    expect(args.filter((a) => a.startsWith('cli_auth_credentials_store='))).toHaveLength(1);
  });
});

describe('codexExecArgs: 空白・引用符・バックスラッシュ・日本語を含むパス', () => {
  it('instructions のパスは TOML 文字列として1要素になり、JSON.parse で元のパスに戻る', () => {
    const args = codexExecArgs({ ...BASE, instructionsFile: NASTY_PATH });
    const elements = args.filter((a) => a.startsWith('model_instructions_file='));
    expect(elements).toHaveLength(1);
    const element = elements[0] as string;
    expect(JSON.parse(element.slice('model_instructions_file='.length))).toBe(NASTY_PATH);
    // -c の直後の1要素そのもの（shell の引用・連結は無い）
    expect(hasPair(args, '-c', element)).toBe(true);
  });

  it('改行・タブを含むパスも元に戻り、要素の中に生の改行は残らない', () => {
    const odd = '/tmp/a b\tc\nd/指示 "x".txt';
    const args = codexExecArgs({ ...BASE, instructionsFile: odd });
    const element = args.find((a) => a.startsWith('model_instructions_file=')) as string;
    expect(JSON.parse(element.slice('model_instructions_file='.length))).toBe(odd);
    expect(element.includes('\n')).toBe(false);
  });

  it('--cd と --output-last-message のパスは引用せず、そのまま1要素で渡る', () => {
    const workdir = '/tmp/作業 dir/"w"\\x';
    const out = '/tmp/リコ の "原稿"\\run/manuscript.raw.md.partial';
    const args = codexExecArgs({ ...BASE, workdir, outputLastMessage: out });
    expect(args[args.indexOf('--cd') + 1]).toBe(workdir);
    expect(args[args.indexOf('--output-last-message') + 1]).toBe(out);
    expect(args.filter((a) => a === workdir)).toHaveLength(1);
    expect(args.filter((a) => a === out)).toHaveLength(1);
  });

  it('特殊なパスでも、引数の個数は変わらない（空白で分割されない）', () => {
    const args = codexExecArgs({
      ...BASE,
      instructionsFile: NASTY_PATH,
      workdir: NASTY_PATH,
      outputLastMessage: NASTY_PATH,
    });
    expect(args).toHaveLength(golden.args.length);
  });
});

describe('tomlString', () => {
  it('普通の文字列は二重引用符で囲むだけ', () => {
    expect(tomlString('abc')).toBe('"abc"');
    expect(tomlString('')).toBe('""');
    expect(tomlString('/RUN/instructions.txt')).toBe('"/RUN/instructions.txt"');
  });

  it('二重引用符は \\" にする', () => {
    expect(tomlString('a"b')).toBe(String.raw`"a\"b"`);
  });

  it('バックスラッシュは \\\\ にする', () => {
    expect(tomlString('a\\b')).toBe(String.raw`"a\\b"`);
  });

  it('改行は \\n にし、生の改行を残さない', () => {
    const out = tomlString('line1\nline2');
    expect(out).toBe(String.raw`"line1\nline2"`);
    expect(out.includes('\n')).toBe(false);
  });

  it('日本語はそのまま（UTF-8）', () => {
    expect(tomlString('リコ')).toBe('"リコ"');
    expect(tomlString('原稿 の 指示')).toBe('"原稿 の 指示"');
  });

  it('どの文字列も JSON.parse で元に戻る（TOML の basic string と互換）', () => {
    const samples = [
      'plain',
      'with "quote"',
      'back\\slash',
      'new\nline',
      'tab\there',
      'リコ の "原稿"\\dir',
      'ctrl\u0001char',
      '/tmp/a b/c',
    ];
    for (const sample of samples) {
      expect(JSON.parse(tomlString(sample))).toBe(sample);
    }
  });
});

describe('isRemovedEnvKey', () => {
  it.each([
    'OPENAI_API_KEY',
    'CODEX_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_API_BASE',
    'OPENAI_ORG_ID',
    'OPENAI_FOO',
    'AZURE_OPENAI_ENDPOINT',
    'AZURE_OPENAI_API_KEY',
    'AZURE_OPENAI_FOO',
    'CODEX_FOO_BASE_URL',
    'CODEX_BASE_URL',
    'GEMINI_API_KEY',
    'ANTHROPIC_API_KEY',
    'CLOUDFLARE_API_TOKEN',
    'SOME_SERVICE_API_TOKEN',
  ])('%s は外す', (key) => {
    expect(isRemovedEnvKey(key)).toBe(true);
  });

  it.each([
    'CODEX_HOME',
    'CODEX_FOO',
    'PATH',
    'HOME',
    'LANG',
    'SSL_CERT_FILE',
    'HTTPS_PROXY',
    'NODE_OPTIONS',
    'CLOUDFLARE_ACCOUNT_ID',
    'TMPDIR',
  ])('%s は残す', (key) => {
    expect(isRemovedEnvKey(key)).toBe(false);
  });
});

describe('sanitizedEnv', () => {
  const SECRET_VALUES = {
    OPENAI_API_KEY: 'sk-test-openai-0001',
    CODEX_API_KEY: 'sk-test-codex-0002',
    OPENAI_BASE_URL: 'https://example.invalid/openai-base',
    OPENAI_API_BASE: 'https://example.invalid/openai-api-base',
    OPENAI_ORG_ID: 'org-test-0003',
    AZURE_OPENAI_ENDPOINT: 'https://example.invalid/azure',
    AZURE_OPENAI_API_KEY: 'azure-test-0004',
    CODEX_FOO_BASE_URL: 'https://example.invalid/codex-foo',
    GEMINI_API_KEY: 'gemini-test-0005',
    ANTHROPIC_API_KEY: 'anthropic-test-0006',
    CLOUDFLARE_API_TOKEN: 'cf-test-0007',
  } satisfies Record<string, string>;

  const KEPT_VALUES = {
    CODEX_HOME: '/home/someone/.codex',
    PATH: '/usr/local/bin:/usr/bin',
    HOME: '/home/someone',
    LANG: 'ja_JP.UTF-8',
    SSL_CERT_FILE: '/etc/ssl/cert.pem',
    HTTPS_PROXY: 'http://proxy.invalid:8080',
    NODE_OPTIONS: '--max-old-space-size=4096',
    CLOUDFLARE_ACCOUNT_ID: 'account-test-0008',
  } satisfies Record<string, string>;

  const makeParent = (): NodeJS.ProcessEnv => ({ ...SECRET_VALUES, ...KEPT_VALUES });

  it('API キーと endpoint の上書きを外し、それ以外はそのまま残す', () => {
    const { env } = sanitizedEnv(makeParent());
    expect(env).toEqual(KEPT_VALUES);
    for (const key of Object.keys(SECRET_VALUES)) {
      expect(Object.hasOwn(env, key), `残っている: ${key}`).toBe(false);
    }
  });

  it('CODEX_HOME は動かさず、元の値のまま残る', () => {
    const { env } = sanitizedEnv(makeParent());
    expect(env.CODEX_HOME).toBe(KEPT_VALUES.CODEX_HOME);
  });

  it('removed は外した変数の名前だけを名前順で返す（値は返さない）', () => {
    const { removed } = sanitizedEnv(makeParent());
    expect(removed).toEqual([
      'ANTHROPIC_API_KEY',
      'AZURE_OPENAI_API_KEY',
      'AZURE_OPENAI_ENDPOINT',
      'CLOUDFLARE_API_TOKEN',
      'CODEX_API_KEY',
      'CODEX_FOO_BASE_URL',
      'GEMINI_API_KEY',
      'OPENAI_API_BASE',
      'OPENAI_API_KEY',
      'OPENAI_BASE_URL',
      'OPENAI_ORG_ID',
    ]);
    expect(removed).toEqual([...removed].sort());
    const serialized = JSON.stringify(removed);
    for (const value of Object.values(SECRET_VALUES)) {
      expect(serialized.includes(value), `値が漏れている: ${value}`).toBe(false);
    }
  });

  it('親の環境（引数）は書き換えない。返す env は新しいオブジェクト', () => {
    const parent = makeParent();
    const snapshot = { ...parent };
    const result = sanitizedEnv(parent);
    expect(result.env).not.toBe(parent);
    expect(parent).toEqual(snapshot);
    for (const key of Object.keys(SECRET_VALUES)) {
      expect(parent[key]).toBe((SECRET_VALUES as Record<string, string>)[key]);
    }
  });

  it('返した env を書き換えても親へは届かない', () => {
    const parent = makeParent();
    const snapshot = { ...parent };
    const { env } = sanitizedEnv(parent);
    env.PATH = '/changed';
    env.ADDED = 'x';
    delete env.HOME;
    expect(parent).toEqual(snapshot);
  });

  it('親が空なら、空の env と空の removed', () => {
    expect(sanitizedEnv({})).toEqual({ env: {}, removed: [] });
  });

  it('外すものが無ければ removed は空で、env は親と同じ内容', () => {
    const parent = { ...KEPT_VALUES };
    const result = sanitizedEnv(parent);
    expect(result.removed).toEqual([]);
    expect(result.env).toEqual(parent);
    expect(result.env).not.toBe(parent);
  });
});

describe('短いコマンドの引数', () => {
  it('loginStatusArgs は exec と同じ認証の上書きを付ける', () => {
    expect(loginStatusArgs('keyring')).toEqual([
      'login',
      'status',
      '-c',
      'forced_login_method="chatgpt"',
      '-c',
      'cli_auth_credentials_store="keyring"',
    ]);
  });

  it.each(['file', 'auto'] as const)('loginStatusArgs: store %s も反映する', (store) => {
    const args = loginStatusArgs(store);
    expect(args.slice(0, 2)).toEqual(['login', 'status']);
    expect(hasPair(args, '-c', `cli_auth_credentials_store="${store}"`)).toBe(true);
    expect(hasPair(args, '-c', 'forced_login_method="chatgpt"')).toBe(true);
  });

  it('versionArgs / execHelpArgs / catalogArgs', () => {
    expect(versionArgs()).toEqual(['--version']);
    expect(execHelpArgs()).toEqual(['exec', '--help']);
    expect(catalogArgs()).toEqual(['debug', 'models']);
  });

  it('呼ぶたびに新しい配列を返す（呼び出し側が書き換えても次へ響かない）', () => {
    const a = versionArgs();
    a.push('--mutated');
    expect(versionArgs()).toEqual(['--version']);
    const b = loginStatusArgs('keyring');
    b.push('--mutated');
    expect(loginStatusArgs('keyring')).toHaveLength(6);
  });
});

describe('promptInputArgs', () => {
  const input = {
    model: 'gpt-6-astra',
    effort: 'high',
    verbosity: null,
    credentialsStore: 'keyring',
    instructionsFile: '/RUN/instructions.txt',
  } as const;

  it('先頭は debug prompt-input、末尾は PROMPT_INPUT_MARKER', () => {
    expect(PROMPT_INPUT_MARKER).toBe('VELUM-ISOLATION-PREVIEW');
    const args = promptInputArgs(input);
    expect(args.slice(0, 2)).toEqual(['debug', 'prompt-input']);
    expect(args[args.length - 1]).toBe(PROMPT_INPUT_MARKER);
    expect(args.filter((a) => a === PROMPT_INPUT_MARKER)).toHaveLength(1);
  });

  it('モデルは -c model="..." で渡し、認証・provider・effort・instructions を exec と同じ値で付ける', () => {
    const args = promptInputArgs(input);
    expect(hasPair(args, '-c', 'model="gpt-6-astra"')).toBe(true);
    expect(hasPair(args, '-c', 'forced_login_method="chatgpt"')).toBe(true);
    expect(hasPair(args, '-c', 'model_provider="openai"')).toBe(true);
    expect(hasPair(args, '-c', 'cli_auth_credentials_store="keyring"')).toBe(true);
    expect(hasPair(args, '-c', 'model_reasoning_effort="high"')).toBe(true);
    expect(hasPair(args, '-c', 'model_instructions_file="/RUN/instructions.txt"')).toBe(true);
  });

  it('ISOLATION_OVERRIDES の全項目を、直前に -c を付けて含む', () => {
    const args = promptInputArgs(input);
    for (const override of ISOLATION_OVERRIDES) {
      const at = args.indexOf(override);
      expect(at, `含まれていない: ${override}`).toBeGreaterThan(0);
      expect(args[at - 1]).toBe('-c');
    }
  });

  it('exec 専用のフラグは含まない', () => {
    const args = promptInputArgs(input);
    for (const flag of [
      '--ignore-user-config',
      '--strict-config',
      '--json',
      '--ephemeral',
      '--output-last-message',
      '--cd',
    ]) {
      expect(args, `含まれてはいけない: ${flag}`).not.toContain(flag);
    }
    expect(args).not.toContain('exec');
  });

  it('禁止の引数は含まない', () => {
    const args = promptInputArgs({ ...input, verbosity: 'high' });
    for (const forbidden of FORBIDDEN) {
      expect(args, `含まれてはいけない: ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('verbosity は null なら渡さず、渡せば model_verbosity として付く', () => {
    expect(promptInputArgs(input).some((a) => a.includes('model_verbosity'))).toBe(false);
    const args = promptInputArgs({ ...input, verbosity: 'low' });
    expect(hasPair(args, '-c', 'model_verbosity="low"')).toBe(true);
  });

  it('特殊なパスの instructions も1要素の TOML 文字列で渡る', () => {
    const args = promptInputArgs({ ...input, instructionsFile: NASTY_PATH });
    const element = args.find((a) => a.startsWith('model_instructions_file=')) as string;
    expect(JSON.parse(element.slice('model_instructions_file='.length))).toBe(NASTY_PATH);
  });
});

describe('redactArgs', () => {
  it('置き換え対象のすべての出現を置き換える（1要素に複数回あっても）', () => {
    const args = ['--cd', '/a/run/work', '-c', 'x="/a/run/one:/a/run/two"', '--flag', '/a/run'];
    expect(redactArgs(args, { '/a/run': '<RUN_DIR>' })).toEqual([
      '--cd',
      '<RUN_DIR>/work',
      '-c',
      'x="<RUN_DIR>/one:<RUN_DIR>/two"',
      '--flag',
      '<RUN_DIR>',
    ]);
  });

  it('長いキーを先に置き換える（短いキーが先でも、オブジェクトの並び順に依らない）', () => {
    const args = ['/a/run/instructions.txt', '/a/other', '/a/run'];
    const expected = ['<RUN_DIR>/instructions.txt', '<X>/other', '<RUN_DIR>'];
    expect(redactArgs(args, { '/a/run': '<RUN_DIR>', '/a': '<X>' })).toEqual(expected);
    expect(redactArgs(args, { '/a': '<X>', '/a/run': '<RUN_DIR>' })).toEqual(expected);
  });

  it('新しい配列を返し、入力の配列は変えない', () => {
    const args = ['--cd', '/a/run/work'];
    const snapshot = [...args];
    const out = redactArgs(args, { '/a/run': '<RUN_DIR>' });
    expect(out).not.toBe(args);
    expect(args).toEqual(snapshot);
  });

  it('置き換えが無くても新しい配列（同じ内容）を返す', () => {
    const args = ['exec', '--json'];
    const out = redactArgs(args, {});
    expect(out).toEqual(args);
    expect(out).not.toBe(args);
    const unmatched = redactArgs(args, { '/nowhere': '<N>' });
    expect(unmatched).toEqual(args);
    expect(unmatched).not.toBe(args);
  });

  it('キーも置き換え後も文字そのもの（正規表現や $& として解釈しない）', () => {
    const args = ['/tmp/a.b/x', '/tmp/aXb/x', '(p)'];
    expect(redactArgs(args, { '/tmp/a.b': '<P>' })).toEqual(['<P>/x', '/tmp/aXb/x', '(p)']);
    expect(redactArgs(args, { '(p)': '<$&>' })).toEqual(['/tmp/a.b/x', '/tmp/aXb/x', '<$&>']);
  });

  it('日本語・空白・引用符を含むパスも置き換える', () => {
    const args = ['--cd', NASTY_PATH, `model_instructions_file=${JSON.stringify(NASTY_PATH)}`];
    const out = redactArgs(args, { [NASTY_PATH]: '<INSTRUCTIONS>' });
    expect(out[1]).toBe('<INSTRUCTIONS>');
    // JSON 引用された形は別の文字列なので、そのキーでは置き換わらない（呼び出し側が両方を渡す）
    expect(out[2]).toBe(args[2]);
  });

  it('実際の exec 引数から、実行ディレクトリと作業ディレクトリの絶対パスが消える', () => {
    const args = codexExecArgs({
      ...BASE,
      instructionsFile: '/RUN/instructions.txt',
      outputLastMessage: '/RUN/manuscript.raw.md.partial',
      workdir: '/WORK/w',
    });
    const out = redactArgs(args, { '/RUN': '<RUN_DIR>', '/WORK/w': '<WORKDIR>' });
    expect(out).toHaveLength(args.length);
    for (const arg of out) {
      expect(arg.includes('/RUN'), arg).toBe(false);
      expect(arg.includes('/WORK'), arg).toBe(false);
    }
    expect(hasPair(out, '--cd', '<WORKDIR>')).toBe(true);
    expect(hasPair(out, '--output-last-message', '<RUN_DIR>/manuscript.raw.md.partial')).toBe(true);
    expect(hasPair(out, '-c', 'model_instructions_file="<RUN_DIR>/instructions.txt"')).toBe(true);
  });
});

describe('REQUIRED_EXEC_FLAGS', () => {
  const help = readCliFixture('exec-help.txt');
  const mentions = (flag: string): boolean => {
    const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`).test(help);
  };

  it('0.153.4 の exec --help に、すべてのフラグが載っている', () => {
    expect(REQUIRED_EXEC_FLAGS.length).toBeGreaterThan(0);
    for (const flag of REQUIRED_EXEC_FLAGS) {
      expect(mentions(flag), `exec --help に無い: ${flag}`).toBe(true);
    }
  });

  it('隔離と非対話に欠かせないフラグを落としていない', () => {
    for (const flag of [
      '--ignore-user-config',
      '--strict-config',
      '--ephemeral',
      '--output-last-message',
      '--config',
    ]) {
      expect(REQUIRED_EXEC_FLAGS).toContain(flag);
    }
  });

  it('危険なフラグを「必須」として登録していない', () => {
    for (const flag of REQUIRED_EXEC_FLAGS) {
      expect(flag.startsWith('--dangerously')).toBe(false);
      expect(flag).not.toBe('--yolo');
      expect(flag).not.toBe('--ignore-rules');
    }
  });

  it('重複が無い', () => {
    expect(new Set(REQUIRED_EXEC_FLAGS).size).toBe(REQUIRED_EXEC_FLAGS.length);
  });
});
