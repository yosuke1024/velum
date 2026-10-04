import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { ROOT } from '../../src/lib/paths.js';
import { WRITER_CONFIG_PATH, loadWriterConfig } from '../../src/story/authoring/config.js';

const tmp = mkdtempSync(join(tmpdir(), 'velum-authoring-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let counter = 0;

/** 実際の writer.yaml を読み、変更を加えた写しを一時ファイルへ書いてそのパスを返す。 */
function writeVariant(mutate: (doc: Record<string, unknown>) => void): string {
  const doc = parse(readFileSync(WRITER_CONFIG_PATH, 'utf8')) as Record<string, unknown>;
  mutate(doc);
  counter += 1;
  const dir = join(tmp, `variant-${counter}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'writer.yaml');
  writeFileSync(path, stringify(doc));
  return path;
}

function writeRaw(text: string): string {
  counter += 1;
  const dir = join(tmp, `raw-${counter}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'writer.yaml');
  writeFileSync(path, text);
  return path;
}

function cliOf(doc: Record<string, unknown>): Record<string, unknown> {
  return doc.cli as Record<string, unknown>;
}

describe('loadWriterConfig: 実際の authoring/writer.yaml', () => {
  it('設定の場所は リポジトリ root の authoring/writer.yaml', () => {
    expect(WRITER_CONFIG_PATH).toBe(join(ROOT, 'authoring', 'writer.yaml'));
    expect(existsSync(WRITER_CONFIG_PATH)).toBe(true);
  });

  it('Astra を Codex CLI・ChatGPT 認証・fallback なしで呼ぶ設定を読む', () => {
    const config = loadWriterConfig();
    expect(config.provider).toBe('codex-cli');
    expect(config.model).toBe('gpt-6-astra');
    expect(config.reasoning_effort).toBe('high');
    expect(config.fallback).toBe('none');
    expect(config.authentication).toBe('chatgpt');
    expect(config.verbosity).toBeNull();
    expect(config.timeout_minutes).toBe(30);
    expect(config.cli.min_version).toBe('0.153.0');
  });

  it('CLI のコマンド名と credentials store を持つ', () => {
    const config = loadWriterConfig();
    expect(config.cli.command).toBe('codex');
    expect(config.credentials_store).toBe('keyring');
  });

  it('instructions のパスは、リポジトリ root からの相対で存在するファイルを指す', () => {
    const config = loadWriterConfig();
    expect(config.instructions.startsWith('/')).toBe(false);
    expect(existsSync(join(ROOT, config.instructions))).toBe(true);
  });

  it('引数なしと、既定のパスを渡したときで結果が同じ', () => {
    expect(loadWriterConfig(WRITER_CONFIG_PATH)).toEqual(loadWriterConfig());
  });

  it('旧経路の VELUM_MODEL / VELUM_STORY_MODEL の環境変数は読まない', () => {
    const before = {
      VELUM_MODEL: process.env.VELUM_MODEL,
      VELUM_STORY_MODEL: process.env.VELUM_STORY_MODEL,
    };
    process.env.VELUM_MODEL = 'some-other-model';
    process.env.VELUM_STORY_MODEL = 'another-other-model';
    try {
      const config = loadWriterConfig();
      expect(config.model).toBe('gpt-6-astra');
      expect(config.fallback).toBe('none');
    } finally {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe('loadWriterConfig: 渡したパスから読む', () => {
  it('実ファイルの写しは同じ設定になる', () => {
    const copy = writeVariant(() => {});
    expect(loadWriterConfig(copy)).toEqual(loadWriterConfig());
  });

  it('値を変えた写しは、その値で読める（読み込み先が固定されていない）', () => {
    const path = writeVariant((doc) => {
      doc.model = 'gpt-test-model';
      doc.timeout_minutes = 45;
    });
    const config = loadWriterConfig(path);
    expect(config.model).toBe('gpt-test-model');
    expect(config.timeout_minutes).toBe(45);
  });

  it.each(['low', 'medium', 'high'] as const)('verbosity %s は受け付ける', (verbosity) => {
    const path = writeVariant((doc) => {
      doc.verbosity = verbosity;
    });
    expect(loadWriterConfig(path).verbosity).toBe(verbosity);
  });

  it.each(['keyring', 'file', 'auto'] as const)('credentials_store %s は受け付ける', (store) => {
    const path = writeVariant((doc) => {
      doc.credentials_store = store;
    });
    expect(loadWriterConfig(path).credentials_store).toBe(store);
  });

  it('timeout_minutes は 1〜240 の整数', () => {
    for (const minutes of [1, 240]) {
      const path = writeVariant((doc) => {
        doc.timeout_minutes = minutes;
      });
      expect(loadWriterConfig(path).timeout_minutes).toBe(minutes);
    }
  });
});

describe('loadWriterConfig: 契約を破る設定は読み込みで落ちる', () => {
  it('知らないトップレベルのキー（名前をエラーに含める）', () => {
    const path = writeVariant((doc) => {
      doc.extra_option = true;
    });
    expect(() => loadWriterConfig(path)).toThrow(/extra_option/);
  });

  it('fallback に none 以外（gemini）を書けない', () => {
    const path = writeVariant((doc) => {
      doc.fallback = 'gemini';
    });
    expect(() => loadWriterConfig(path)).toThrow(/fallback/);
  });

  it('provider に codex-cli 以外（openai-api）を書けない', () => {
    const path = writeVariant((doc) => {
      doc.provider = 'openai-api';
    });
    expect(() => loadWriterConfig(path)).toThrow(/provider/);
  });

  it('authentication に chatgpt 以外（api_key）を書けない', () => {
    const path = writeVariant((doc) => {
      doc.authentication = 'api_key';
    });
    expect(() => loadWriterConfig(path)).toThrow(/authentication/);
  });

  it('timeout_minutes が 0 は不可', () => {
    const path = writeVariant((doc) => {
      doc.timeout_minutes = 0;
    });
    expect(() => loadWriterConfig(path)).toThrow(/timeout_minutes/);
  });

  it('timeout_minutes が上限超え・小数・文字列は不可', () => {
    for (const bad of [241, 1.5, '30', -1]) {
      const path = writeVariant((doc) => {
        doc.timeout_minutes = bad;
      });
      expect(() => loadWriterConfig(path), `timeout_minutes=${String(bad)}`).toThrow(
        /timeout_minutes/,
      );
    }
  });

  it('reasoning_effort の形が不正（High!）は不可', () => {
    const path = writeVariant((doc) => {
      doc.reasoning_effort = 'High!';
    });
    expect(() => loadWriterConfig(path)).toThrow(/reasoning_effort/);
  });

  it('reasoning_effort が空・数字・大文字は不可', () => {
    for (const bad of ['', 'high2', 'HIGH']) {
      const path = writeVariant((doc) => {
        doc.reasoning_effort = bad;
      });
      expect(() => loadWriterConfig(path), `reasoning_effort=${bad}`).toThrow(/reasoning_effort/);
    }
  });

  it('credentials_store に cloud は不可', () => {
    const path = writeVariant((doc) => {
      doc.credentials_store = 'cloud';
    });
    expect(() => loadWriterConfig(path)).toThrow(/credentials_store/);
  });

  it('verbosity に low/medium/high/null 以外は不可', () => {
    const path = writeVariant((doc) => {
      doc.verbosity = 'loud';
    });
    expect(() => loadWriterConfig(path)).toThrow(/verbosity/);
  });

  it('model が空は不可', () => {
    const path = writeVariant((doc) => {
      doc.model = '';
    });
    expect(() => loadWriterConfig(path)).toThrow(/model/);
  });

  it('instructions が空は不可', () => {
    const path = writeVariant((doc) => {
      doc.instructions = '';
    });
    expect(() => loadWriterConfig(path)).toThrow(/instructions/);
  });

  it('必須の欄が欠けていれば、その欄の名前を添えて落ちる', () => {
    for (const field of ['model', 'fallback', 'authentication', 'timeout_minutes', 'cli']) {
      const path = writeVariant((doc) => {
        delete doc[field];
      });
      expect(() => loadWriterConfig(path), `欠落: ${field}`).toThrow(new RegExp(field));
    }
  });

  it('cli の中の知らないキーは不可', () => {
    const path = writeVariant((doc) => {
      cliOf(doc).auto_update = true;
    });
    expect(() => loadWriterConfig(path)).toThrow(/auto_update/);
  });

  it('cli.min_version が semver でなければ不可', () => {
    for (const bad of ['0.153', 'v0.153.0', 'latest']) {
      const path = writeVariant((doc) => {
        cliOf(doc).min_version = bad;
      });
      expect(() => loadWriterConfig(path), `min_version=${bad}`).toThrow(/min_version/);
    }
  });

  it('cli.command が空は不可', () => {
    const path = writeVariant((doc) => {
      cliOf(doc).command = '';
    });
    expect(() => loadWriterConfig(path)).toThrow(/command/);
  });

  it('自動再試行の回数のような設定は、持てない（strict）', () => {
    const path = writeVariant((doc) => {
      doc.max_retries = 3;
    });
    expect(() => loadWriterConfig(path)).toThrow(/max_retries/);
  });
});

/** 投げられたエラーの message。投げなければ失敗。未実装のスタブの throw を「落ちた」と数えないために使う。 */
function thrownMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    expect(message, '未実装のスタブの throw は「設定が不正」ではない').not.toMatch(/not implemented/i);
    return message;
  }
  throw new Error('投げられなかった');
}

describe('loadWriterConfig: ファイルそのものの問題', () => {
  it('存在しないパスは、そのパスを添えて落ちる', () => {
    const message = thrownMessage(() =>
      loadWriterConfig(join(tmp, 'does-not-exist', 'writer.yaml')),
    );
    expect(message).toContain('does-not-exist');
  });

  it('YAML として壊れていれば落ちる', () => {
    const path = writeRaw('provider: codex-cli\n  model: [unclosed\n');
    expect(thrownMessage(() => loadWriterConfig(path)).length).toBeGreaterThan(0);
  });

  it('空のファイル・オブジェクトでない YAML は落ちる', () => {
    for (const text of ['', '- a\n- b\n', 'just a string\n']) {
      const path = writeRaw(text);
      expect(thrownMessage(() => loadWriterConfig(path)).length, JSON.stringify(text)).toBeGreaterThan(0);
    }
  });
});
