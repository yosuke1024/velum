import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ROOT } from '../../src/lib/paths.js';
import { storyUsage } from '../../src/story/args.js';
import { WRITER_CONFIG_PATH, loadWriterConfig } from '../../src/story/authoring/config.js';

/**
 * リポジトリの実ファイルに対する契約。materials を変えないこと、gitignore、package.json の script、
 * Claude Code の Skill、旧経路（Gemini / Workers AI / 旧 story パイプライン）を import しないこと、
 * 旧コマンドが Legacy と案内すること。
 * 実データ（人物の設定・原稿の中身）の値は assertion に使わない。
 * 一部は、あとの工程でファイルが加わるまで Red になる。
 */

const AUTHORING_DIR = join(ROOT, 'authoring');
const AUTHORING_SRC_DIR = join(ROOT, 'src', 'story', 'authoring');

const sha256Of = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

// ── materials ───────────────────────────────────────────────

const MATERIAL_PATHS = [
  'briefs/velum_riko_writing_brief.md',
  'prompts/velum_story_project_instructions.txt',
  'prompts/riko-first-request.txt',
  'prompts/velum_story_prompts.md',
];

function readSums(): Map<string, string> {
  const text = readFileSync(join(AUTHORING_DIR, 'SHA256SUMS'), 'utf8');
  const sums = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    const match = /^([0-9a-f]{64}) {2}(\S.*)$/.exec(line);
    if (!match) throw new Error(`SHA256SUMS の行の形が違います: ${line}`);
    const [, sha, path] = match;
    if (sha === undefined || path === undefined) throw new Error(`SHA256SUMS を読めません: ${line}`);
    if (sums.has(path)) throw new Error(`SHA256SUMS に同じパスが2回あります: ${path}`);
    sums.set(path, sha);
  }
  return sums;
}

describe('materials: authoring/SHA256SUMS', () => {
  it('固定する資料は4つで、パスは authoring/ からの相対', () => {
    expect([...readSums().keys()].sort()).toEqual([...MATERIAL_PATHS].sort());
  });

  it('各行の hash が、実ファイルの sha256 と一致する（資料は一字も変えない）', () => {
    for (const [path, sha] of readSums()) {
      const file = join(AUTHORING_DIR, path);
      expect(existsSync(file), path).toBe(true);
      expect(sha256Of(file), path).toBe(sha);
    }
  });

  it('writer.yaml の instructions は、SHA256SUMS に固定された資料を指す', () => {
    const doc = parse(readFileSync(WRITER_CONFIG_PATH, 'utf8')) as { instructions?: unknown };
    expect(typeof doc.instructions).toBe('string');
    const instructions = String(doc.instructions);
    expect(instructions.startsWith('authoring/')).toBe(true);
    expect(readSums().has(instructions.slice('authoring/'.length))).toBe(true);
  });
});

// ── gitignore ───────────────────────────────────────────────

describe('.gitignore', () => {
  it('.story-runs/ の行がある（原稿・実行記録を公開リポジトリへ入れない）', () => {
    const lines = readFileSync(join(ROOT, '.gitignore'), 'utf8')
      .split('\n')
      .map((line) => line.replace(/\r$/, '').trim());
    expect(lines).toContain('.story-runs/');
  });
});

// ── package.json / scripts ──────────────────────────────────

describe('package.json の scripts', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };

  it('story:doctor / story:draft / story:revise がある', () => {
    expect(pkg.scripts['story:doctor']).toBe('tsx scripts/story-doctor.ts');
    expect(pkg.scripts['story:draft']).toBe('tsx scripts/story-draft.ts');
    expect(pkg.scripts['story:revise']).toBe('tsx scripts/story-revise.ts');
  });

  it('旧経路の story:plan / story:write は残っている（Legacy として）', () => {
    expect(pkg.scripts['story:plan']).toBe('tsx scripts/story-plan.ts');
    expect(pkg.scripts['story:write']).toBe('tsx scripts/story-write.ts');
  });

  it('script が指すファイルが存在する', () => {
    for (const name of ['story-doctor.ts', 'story-draft.ts', 'story-revise.ts', 'story-plan.ts', 'story-write.ts']) {
      expect(existsSync(join(ROOT, 'scripts', name)), name).toBe(true);
    }
  });
});

// ── Claude Code の Skill ────────────────────────────────────

const SKILL_PATH = join(ROOT, '.claude', 'skills', 'velum-story', 'SKILL.md');

function skillFrontmatter(): Record<string, unknown> {
  if (!existsSync(SKILL_PATH)) throw new Error(`Skill がありません: ${SKILL_PATH}`);
  const text = readFileSync(SKILL_PATH, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error('SKILL.md の先頭に YAML frontmatter がありません');
  const parsed: unknown = parse(match[1] ?? '');
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('SKILL.md の frontmatter がマップではありません');
  }
  return parsed as Record<string, unknown>;
}

describe('Claude Code の Skill: .claude/skills/velum-story/SKILL.md', () => {
  it('ファイルがある', () => {
    expect(existsSync(SKILL_PATH)).toBe(true);
  });

  it('name は velum-story', () => {
    expect(skillFrontmatter().name).toBe('velum-story');
  });

  it('モデルが勝手に呼び出さない（disable-model-invocation: true）。生成は人が明示して始める', () => {
    expect(skillFrontmatter()['disable-model-invocation']).toBe(true);
  });

  it('description と argument-hint が空でない文字列', () => {
    const front = skillFrontmatter();
    expect(typeof front.description).toBe('string');
    expect(String(front.description).trim().length).toBeGreaterThan(0);
    expect(typeof front['argument-hint']).toBe('string');
    expect(String(front['argument-hint']).trim().length).toBeGreaterThan(0);
  });

  it('本文がある（frontmatter だけではない）', () => {
    if (!existsSync(SKILL_PATH)) throw new Error(`Skill がありません: ${SKILL_PATH}`);
    const body = readFileSync(SKILL_PATH, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    expect(body.trim().length).toBeGreaterThan(0);
  });
});

// ── 旧経路を import しない ──────────────────────────────────

/** 旧経路（別モデル・従量課金 API の呼び出し、旧 story パイプライン）のモジュール。拡張子なしの絶対パス。 */
const FORBIDDEN_MODULES = [
  join(ROOT, 'src', 'lib', 'llm'),
  join(ROOT, 'src', 'lib', 'gemini'),
  join(ROOT, 'src', 'lib', 'workers-ai'),
  join(ROOT, 'src', 'lib', 'llm-core'),
  join(ROOT, 'src', 'story', 'plan'),
  join(ROOT, 'src', 'story', 'write'),
  join(ROOT, 'src', 'story', 'context'),
  join(ROOT, 'src', 'story', 'prompt'),
];

/** 従量課金 API の SDK など、bare specifier で入ってくるもの。 */
const FORBIDDEN_PACKAGES = /^(openai|@openai\/|@anthropic-ai\/|anthropic$|@google\/|@google-ai\/|@google-cloud\/|google-auth-library)/;

/** import / export ... from / import() / require() のモジュール指定子を取り出す。コメントの行は見ない。 */
function moduleSpecifiers(text: string): string[] {
  const code = text
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n');
  const patterns = [
    /\bfrom\s*(['"])([^'"\n]+)\1/g,
    /\bimport\s*(['"])([^'"\n]+)\1/g,
    /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
    /\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
  ];
  const found: string[] = [];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      const specifier = match[2];
      if (specifier !== undefined) found.push(specifier);
    }
  }
  return found;
}

/** file の中の、禁止されたモジュールへの指定子。 */
function forbiddenImports(file: string, text: string): string[] {
  return moduleSpecifiers(text).filter((specifier) => {
    if (specifier.startsWith('.')) {
      const resolved = resolve(dirname(file), specifier).replace(/\.(js|ts|mjs|cjs)$/, '');
      return FORBIDDEN_MODULES.includes(resolved);
    }
    return FORBIDDEN_PACKAGES.test(specifier);
  });
}

function tsFilesIn(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...tsFilesIn(path));
    else if (name.endsWith('.ts')) files.push(path);
  }
  return files.sort();
}

describe('src/story/authoring/ は旧経路を import しない（fallback の入口を作らない）', () => {
  const files = tsFilesIn(AUTHORING_SRC_DIR);

  it('検査の対象が空ではない（run.ts と doctor.ts を含む）', () => {
    const names = files.map((file) => file.slice(AUTHORING_SRC_DIR.length + 1));
    expect(names).toEqual(expect.arrayContaining(['run.ts', 'doctor.ts', 'codex-command.ts']));
  });

  it('lib/llm・lib/gemini・lib/workers-ai・lib/llm-core・story/plan・story/write・story/context・story/prompt を import しない', () => {
    const offenders = files.flatMap((file) =>
      forbiddenImports(file, readFileSync(file, 'utf8')).map((specifier) => `${file}: ${specifier}`),
    );
    expect(offenders).toEqual([]);
  });

  it('新しい制作コマンドの scripts（あれば）も旧経路を import しない', () => {
    const scripts = ['story-doctor.ts', 'story-draft.ts', 'story-revise.ts']
      .map((name) => join(ROOT, 'scripts', name))
      .filter((file) => existsSync(file));
    const offenders = scripts.flatMap((file) =>
      forbiddenImports(file, readFileSync(file, 'utf8')).map((specifier) => `${file}: ${specifier}`),
    );
    expect(offenders).toEqual([]);
  });
});

describe('import 検査の道具そのもの（検査が空振りしないことの確認）', () => {
  const file = join(AUTHORING_SRC_DIR, 'sample.ts');

  it('複数行の import・export from・動的 import・require の指定子を拾う', () => {
    const text = [
      "import {",
      '  generateJson,',
      "} from '../../lib/llm.js';",
      "export * from '../plan.js';",
      "const lazy = await import('../../lib/gemini.js');",
      "const old = require('../../lib/workers-ai');",
      "import '../../lib/llm-core.js';",
    ].join('\n');
    expect(forbiddenImports(file, text).sort()).toEqual(
      [
        '../../lib/llm.js',
        '../plan.js',
        '../../lib/gemini.js',
        '../../lib/workers-ai',
        '../../lib/llm-core.js',
      ].sort(),
    );
  });

  it('旧 story の write / context / prompt も禁止（authoring 自身の ./prompt.js は許す）', () => {
    expect(forbiddenImports(file, "import { x } from '../write.js';")).toEqual(['../write.js']);
    expect(forbiddenImports(file, "import { x } from '../context.js';")).toEqual(['../context.js']);
    expect(forbiddenImports(file, "import { x } from '../prompt.js';")).toEqual(['../prompt.js']);
    expect(forbiddenImports(file, "import { x } from './prompt.js';")).toEqual([]);
    expect(forbiddenImports(file, "import { x } from './runs.js';")).toEqual([]);
  });

  it('従量課金 API の SDK も禁止。標準ライブラリ・zod・yaml・paths は許す', () => {
    expect(forbiddenImports(file, "import OpenAI from 'openai';")).toEqual(['openai']);
    expect(forbiddenImports(file, "import Anthropic from '@anthropic-ai/sdk';")).toEqual(['@anthropic-ai/sdk']);
    expect(forbiddenImports(file, "import { GoogleGenAI } from '@google/genai';")).toEqual(['@google/genai']);
    expect(forbiddenImports(file, "import { join } from 'node:path';")).toEqual([]);
    expect(forbiddenImports(file, "import { z } from 'zod';")).toEqual([]);
    expect(forbiddenImports(file, "import { ROOT } from '../../lib/paths.js';")).toEqual([]);
  });

  it('コメントの中の記述は見ない', () => {
    const text = [
      '/**',
      " * 旧経路の import { generateJson } from '../../lib/llm.js' は使わない。",
      ' */',
      "// import { x } from '../plan.js';",
      "import { y } from './runs.js';",
    ].join('\n');
    expect(forbiddenImports(file, text)).toEqual([]);
  });

  it('src/story/ の外の同名ファイルは別物として扱う（解決したパスで比べる）', () => {
    const other = join(ROOT, 'src', 'other', 'sample.ts');
    expect(forbiddenImports(other, "import { x } from './plan.js';")).toEqual([]);
    expect(forbiddenImports(join(ROOT, 'src', 'story', 'sample.ts'), "import { x } from './plan.js';")).toEqual([
      './plan.js',
    ]);
  });
});

// ── 旧コマンドの案内 ────────────────────────────────────────

describe('旧コマンド（story:plan / story:write）の usage', () => {
  for (const mode of ['plan', 'write'] as const) {
    it(`story:${mode} の usage は Legacy と書き、story:draft を案内する`, () => {
      const usage = storyUsage(mode);
      expect(usage).toContain('Legacy');
      expect(usage).toContain('story:draft');
    });

    it(`story:${mode} の usage は、従来の使い方の行も残す`, () => {
      const usage = storyUsage(mode);
      expect(usage).toContain(`npm run story:${mode}`);
      expect(usage).toContain('--dry-run');
    });
  }
});

// ── 設定 ────────────────────────────────────────────────────

describe('loadWriterConfig: 実際の authoring/writer.yaml', () => {
  it('読み込めて、fallback は none（別モデルへ落とさない）', () => {
    const config = loadWriterConfig();
    expect(config.fallback).toBe('none');
  });

  it('認証は ChatGPT、呼び出しは Codex CLI だけ', () => {
    const config = loadWriterConfig();
    expect(config.authentication).toBe('chatgpt');
    expect(config.provider).toBe('codex-cli');
  });
});
