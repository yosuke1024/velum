import { describe, it, expect } from 'vitest';
import {
  authoringUsage,
  parseDoctorArgs,
  parseDraftArgs,
  parseReviseArgs,
  type AuthoringCommand,
} from '../../src/story/authoring/args.js';
import { CHARACTER_IDS } from '../../src/schemas/world.js';

const DRAFT_BASE = ['--character', 'riko', '--brief', 'b.md', '--request', 'r.txt'];
const REVISE_BASE = ['--run', 'run-1', '--feedback', 'f.md'];

function thrownMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('エラーになるはずの引数が、黙って通った');
}

/**
 * エラーになること、使い方が添えられていること、使い方の部分を除いた本文が mention に触れていること
 * （使い方には全フラグの名前が載るので、本文だけを見ないと「何が悪いか」を確かめたことにならない）。
 */
function expectArgError(
  command: AuthoringCommand,
  parse: (argv: readonly string[]) => unknown,
  argv: readonly string[],
  mention: RegExp,
): void {
  const message = thrownMessage(() => parse(argv));
  const usage = authoringUsage(command);
  expect(message).toContain(usage);
  expect(message.replace(usage, '')).toMatch(mention);
}

const draftError = (argv: readonly string[], mention: RegExp) =>
  expectArgError('draft', parseDraftArgs, argv, mention);
const reviseError = (argv: readonly string[], mention: RegExp) =>
  expectArgError('revise', parseReviseArgs, argv, mention);
const doctorError = (argv: readonly string[], mention: RegExp) =>
  expectArgError('doctor', parseDoctorArgs, argv, mention);

describe('story:draft の引数', () => {
  it('必須の3つだけで読める', () => {
    expect(parseDraftArgs(DRAFT_BASE)).toEqual({
      character: 'riko',
      brief: 'b.md',
      request: 'r.txt',
      dryRun: false,
      printPrompt: false,
    });
  });

  it('省略できる引数は、省略すれば結果に現れない', () => {
    const args = parseDraftArgs(DRAFT_BASE);
    expect(args.instructions).toBeUndefined();
    expect(args.effort).toBeUndefined();
    expect(args.verbosity).toBeUndefined();
    expect(args.timeoutMinutes).toBeUndefined();
  });

  it('--k=v の形も受ける', () => {
    expect(
      parseDraftArgs(['--character=teo', '--brief=b.md', '--request=r.txt']),
    ).toEqual({
      character: 'teo',
      brief: 'b.md',
      request: 'r.txt',
      dryRun: false,
      printPrompt: false,
    });

    expect(
      parseDraftArgs([
        '--character=kaya',
        '--brief=b.md',
        '--request=r.txt',
        '--instructions=i.txt',
        '--effort=max',
        '--verbosity=low',
        '--timeout-minutes=45',
      ]),
    ).toEqual({
      character: 'kaya',
      brief: 'b.md',
      request: 'r.txt',
      instructions: 'i.txt',
      effort: 'max',
      verbosity: 'low',
      timeoutMinutes: 45,
      dryRun: false,
      printPrompt: false,
    });
  });

  it('省略できる引数をすべて付けて読める', () => {
    expect(
      parseDraftArgs([
        ...DRAFT_BASE,
        '--instructions',
        'i.txt',
        '--effort',
        'xhigh',
        '--verbosity',
        'medium',
        '--timeout-minutes',
        '45',
        '--dry-run',
        '--print-prompt',
      ]),
    ).toEqual({
      character: 'riko',
      brief: 'b.md',
      request: 'r.txt',
      instructions: 'i.txt',
      effort: 'xhigh',
      verbosity: 'medium',
      timeoutMinutes: 45,
      dryRun: true,
      printPrompt: true,
    });
  });

  it('--dry-run だけなら、プロンプトは印字しない', () => {
    const args = parseDraftArgs([...DRAFT_BASE, '--dry-run']);
    expect(args.dryRun).toBe(true);
    expect(args.printPrompt).toBe(false);
  });

  it('人物は CHARACTER_IDS のいずれか', () => {
    for (const id of CHARACTER_IDS) {
      expect(
        parseDraftArgs(['--character', id, '--brief', 'b.md', '--request', 'r.txt']).character,
      ).toBe(id);
    }
    draftError(['--character', 'nobody', '--brief', 'b.md', '--request', 'r.txt'], /--character/);
  });

  it('パスは解決せず、そのまま返す（空白・日本語を含んでもよい）', () => {
    const args = parseDraftArgs([
      '--character',
      'riko',
      '--brief',
      './資料/brief 1.md',
      '--request',
      '../r.txt',
      '--instructions',
      '/abs/path/i.txt',
    ]);
    expect(args.brief).toBe('./資料/brief 1.md');
    expect(args.request).toBe('../r.txt');
    expect(args.instructions).toBe('/abs/path/i.txt');
  });

  it('呼び出し側の配列（読み取り専用）を変えない', () => {
    const argv = Object.freeze([...DRAFT_BASE, '--dry-run']);
    expect(() => parseDraftArgs(argv)).not.toThrow();
    expect(argv).toEqual([...DRAFT_BASE, '--dry-run']);
  });

  it('--character / --brief / --request は必須', () => {
    draftError(['--brief', 'b.md', '--request', 'r.txt'], /--character/);
    draftError(['--character', 'riko', '--request', 'r.txt'], /--brief/);
    draftError(['--character', 'riko', '--brief', 'b.md'], /--request/);
    draftError([], /--character|--brief|--request/);
  });

  it('空文字（Actions の未設定入力）は「無い」として扱う', () => {
    // 必須の値が空なら、無いのと同じ
    draftError(['--character', 'riko', '--brief', '', '--request', 'r.txt'], /--brief/);
    draftError(['--character', 'riko', '--brief', 'b.md', '--request='], /--request/);
    draftError(['--character', '', '--brief', 'b.md', '--request', 'r.txt'], /--character/);

    // 省略できる値が空なら、指定しなかったのと同じ
    const args = parseDraftArgs([
      ...DRAFT_BASE,
      '--instructions',
      '',
      '--effort=',
      '--verbosity',
      '',
      '--timeout-minutes',
      '',
    ]);
    expect(args).toEqual({
      character: 'riko',
      brief: 'b.md',
      request: 'r.txt',
      dryRun: false,
      printPrompt: false,
    });
    expect(args.instructions).toBeUndefined();
    expect(args.effort).toBeUndefined();
    expect(args.verbosity).toBeUndefined();
    expect(args.timeoutMinutes).toBeUndefined();
  });

  it('不明な引数・位置引数は黙って捨てずにエラー', () => {
    draftError([...DRAFT_BASE, '--forse'], /--forse/);
    draftError([...DRAFT_BASE, 'extra'], /extra/);
  });

  it('旧経路の引数（--season / --episode / --plan）と revise の引数は受けない', () => {
    draftError([...DRAFT_BASE, '--season', '1'], /--season/);
    draftError([...DRAFT_BASE, '--season=1'], /--season/);
    draftError([...DRAFT_BASE, '--episode', '3'], /--episode/);
    draftError([...DRAFT_BASE, '--episodes', '8'], /--episodes/);
    draftError([...DRAFT_BASE, '--plan', 'plan.yaml'], /--plan/);
    draftError([...DRAFT_BASE, '--run', 'run-1'], /--run/);
    draftError([...DRAFT_BASE, '--feedback', 'f.md'], /--feedback/);
  });

  it('--print-prompt は --dry-run と一緒のときだけ', () => {
    draftError([...DRAFT_BASE, '--print-prompt'], /--print-prompt/);
    draftError([...DRAFT_BASE, '--print-prompt'], /--dry-run/);
  });

  it('--effort は小文字の英字だけ（対応するかどうかは preflight が見る）', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
      expect(parseDraftArgs([...DRAFT_BASE, '--effort', effort]).effort).toBe(effort);
    }
    // 対応しない名前でも、形が合えばここでは通す（黙って別の値に直しもしない）
    expect(parseDraftArgs([...DRAFT_BASE, '--effort', 'superhigh']).effort).toBe('superhigh');

    draftError([...DRAFT_BASE, '--effort', 'High'], /--effort/);
    draftError([...DRAFT_BASE, '--effort', 'x-high'], /--effort/);
    draftError([...DRAFT_BASE, '--effort', 'high2'], /--effort/);
    draftError([...DRAFT_BASE, '--effort=HIGH'], /--effort/);
  });

  it('--verbosity は low / medium / high だけ', () => {
    for (const verbosity of ['low', 'medium', 'high'] as const) {
      expect(parseDraftArgs([...DRAFT_BASE, '--verbosity', verbosity]).verbosity).toBe(verbosity);
    }
    draftError([...DRAFT_BASE, '--verbosity', 'loud'], /--verbosity/);
    draftError([...DRAFT_BASE, '--verbosity', 'High'], /--verbosity/);
  });

  it('--timeout-minutes は 1〜240 の整数だけ', () => {
    expect(parseDraftArgs([...DRAFT_BASE, '--timeout-minutes', '1']).timeoutMinutes).toBe(1);
    expect(parseDraftArgs([...DRAFT_BASE, '--timeout-minutes', '240']).timeoutMinutes).toBe(240);
    expect(parseDraftArgs([...DRAFT_BASE, '--timeout-minutes=30']).timeoutMinutes).toBe(30);

    draftError([...DRAFT_BASE, '--timeout-minutes', '0'], /--timeout-minutes/);
    draftError([...DRAFT_BASE, '--timeout-minutes', '241'], /--timeout-minutes/);
    draftError([...DRAFT_BASE, '--timeout-minutes', '1.5'], /--timeout-minutes/);
    draftError([...DRAFT_BASE, '--timeout-minutes', 'thirty'], /--timeout-minutes/);
    draftError([...DRAFT_BASE, '--timeout-minutes', '1e1'], /--timeout-minutes/);
    // 値が - で始まる `--timeout-minutes -5` は node:util がオプションの欠落と読む。どちらでも黙って通らない。
    draftError([...DRAFT_BASE, '--timeout-minutes=-5'], /--timeout-minutes/);
    expect(() => parseDraftArgs([...DRAFT_BASE, '--timeout-minutes', '-5'])).toThrow();
  });
});

describe('story:revise の引数', () => {
  it('--run と --feedback だけで読める', () => {
    expect(parseReviseArgs(REVISE_BASE)).toEqual({
      run: 'run-1',
      feedback: 'f.md',
      dryRun: false,
      printPrompt: false,
    });
  });

  it('--k=v の形も受ける', () => {
    expect(parseReviseArgs(['--run=run-1', '--feedback=f.md'])).toEqual({
      run: 'run-1',
      feedback: 'f.md',
      dryRun: false,
      printPrompt: false,
    });
  });

  it('省略できる引数をすべて付けて読める', () => {
    expect(
      parseReviseArgs([
        ...REVISE_BASE,
        '--brief',
        'b2.md',
        '--instructions',
        'i.txt',
        '--effort',
        'xhigh',
        '--verbosity',
        'high',
        '--timeout-minutes',
        '60',
        '--dry-run',
        '--print-prompt',
      ]),
    ).toEqual({
      run: 'run-1',
      feedback: 'f.md',
      brief: 'b2.md',
      instructions: 'i.txt',
      effort: 'xhigh',
      verbosity: 'high',
      timeoutMinutes: 60,
      dryRun: true,
      printPrompt: true,
    });
  });

  it('--run と --feedback は必須', () => {
    reviseError(['--feedback', 'f.md'], /--run/);
    reviseError(['--run', 'run-1'], /--feedback/);
    reviseError([], /--run|--feedback/);
  });

  it('空文字は「無い」として扱う', () => {
    reviseError(['--run', '', '--feedback', 'f.md'], /--run/);
    reviseError(['--run', 'run-1', '--feedback='], /--feedback/);

    const args = parseReviseArgs([...REVISE_BASE, '--brief', '', '--instructions=', '--effort', '']);
    expect(args).toEqual({ run: 'run-1', feedback: 'f.md', dryRun: false, printPrompt: false });
    expect(args.brief).toBeUndefined();
    expect(args.instructions).toBeUndefined();
    expect(args.effort).toBeUndefined();
  });

  it('draft の引数（--character / --request）と旧経路の引数は受けない', () => {
    reviseError([...REVISE_BASE, '--character', 'riko'], /--character/);
    reviseError([...REVISE_BASE, '--request', 'r.txt'], /--request/);
    reviseError([...REVISE_BASE, '--season', '1'], /--season/);
    reviseError([...REVISE_BASE, '--episode', '2'], /--episode/);
    reviseError([...REVISE_BASE, '--plan', 'plan.yaml'], /--plan/);
  });

  it('不明な引数・位置引数は黙って捨てずにエラー', () => {
    reviseError([...REVISE_BASE, '--forse'], /--forse/);
    reviseError([...REVISE_BASE, 'extra'], /extra/);
  });

  it('--print-prompt は --dry-run と一緒のときだけ', () => {
    reviseError([...REVISE_BASE, '--print-prompt'], /--print-prompt/);
    reviseError([...REVISE_BASE, '--print-prompt'], /--dry-run/);
    expect(parseReviseArgs([...REVISE_BASE, '--dry-run', '--print-prompt'])).toMatchObject({
      dryRun: true,
      printPrompt: true,
    });
  });

  it('--effort / --verbosity / --timeout-minutes は draft と同じ検証', () => {
    reviseError([...REVISE_BASE, '--effort', 'High'], /--effort/);
    reviseError([...REVISE_BASE, '--verbosity', 'loud'], /--verbosity/);
    reviseError([...REVISE_BASE, '--timeout-minutes', '0'], /--timeout-minutes/);
    reviseError([...REVISE_BASE, '--timeout-minutes', '241'], /--timeout-minutes/);
    reviseError([...REVISE_BASE, '--timeout-minutes', '1.5'], /--timeout-minutes/);
    expect(parseReviseArgs([...REVISE_BASE, '--timeout-minutes', '240']).timeoutMinutes).toBe(240);
  });
});

describe('story:doctor の引数', () => {
  it('何も無ければ probe: false、--probe で true', () => {
    expect(parseDoctorArgs([])).toEqual({ probe: false });
    expect(parseDoctorArgs(['--probe'])).toEqual({ probe: true });
  });

  it('不明な引数・位置引数は黙って捨てずにエラー', () => {
    doctorError(['--forse'], /--forse/);
    doctorError(['extra'], /extra/);
    doctorError(['--probe', 'extra'], /extra/);
  });

  it('draft / revise の引数は受けない', () => {
    doctorError(['--dry-run'], /--dry-run/);
    doctorError(['--character', 'riko'], /--character/);
  });
});

describe('使い方', () => {
  it('draft / revise / doctor それぞれのコマンド名を示す', () => {
    expect(authoringUsage('draft')).toContain('story:draft');
    expect(authoringUsage('revise')).toContain('story:revise');
    expect(authoringUsage('doctor')).toContain('story:doctor');
  });

  it('doctor の使い方に --probe がある', () => {
    expect(authoringUsage('doctor')).toContain('--probe');
  });

  it('draft の使い方に、必須と省略できる引数がそろう', () => {
    const usage = authoringUsage('draft');
    for (const flag of [
      '--character',
      '--brief',
      '--request',
      '--instructions',
      '--effort',
      '--verbosity',
      '--timeout-minutes',
      '--dry-run',
      '--print-prompt',
    ]) {
      expect(usage, flag).toContain(flag);
    }
  });

  it('revise の使い方に、必須と省略できる引数がそろう', () => {
    const usage = authoringUsage('revise');
    for (const flag of [
      '--run',
      '--feedback',
      '--brief',
      '--instructions',
      '--effort',
      '--verbosity',
      '--timeout-minutes',
      '--dry-run',
      '--print-prompt',
    ]) {
      expect(usage, flag).toContain(flag);
    }
  });

  it('エラーには使い方が付く（引数が全く無いとき）', () => {
    const draft = thrownMessage(() => parseDraftArgs([]));
    expect(draft).toContain(authoringUsage('draft'));
    const revise = thrownMessage(() => parseReviseArgs([]));
    expect(revise).toContain(authoringUsage('revise'));
    const doctor = thrownMessage(() => parseDoctorArgs(['--forse']));
    expect(doctor).toContain(authoringUsage('doctor'));
  });
});
