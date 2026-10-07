import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ZodTypeAny } from 'zod';
import type { LlmRequest } from '../../src/lib/llm.js';
import { charPath, storyBodyPath, storyManifestPath, storyPlanPath } from '../../src/lib/paths.js';
import { readYaml, writeYaml } from '../../src/lib/storage.js';
import { secretSegments } from '../../src/lib/secrets.js';
import { ProfileSchema } from '../../src/schemas/character.js';
import { STORY_WRITE_LIMITS } from '../../src/schemas/limits.js';
import {
  STORY_FORMATS,
  StoryManifestSchema,
  StoryPlanSchema,
  type StoryManifest,
  type StoryPlan,
} from '../../src/schemas/story.js';
import { buildStoryContext, type StoryContext } from '../../src/story/context.js';
import { gateEpisodeEn, gateEpisodeJa, gatePlan } from '../../src/story/gate.js';
import {
  PLAN_DRY_RUN_NOTICE,
  planStory,
  syncManifest,
  writeManifestFile,
  type GenerateJson,
} from '../../src/story/plan.js';
import {
  STORY_FORMAT_GUIDE,
  STORY_WRITE_PROMPT_VERSION,
  type StoryPlanResponse,
} from '../../src/story/prompt.js';
import { applyEpisodeWrite, WRITE_DRY_RUN_NOTICE, writeEpisodes } from '../../src/story/write.js';

const NOW = '2026-10-03T09:00:00.000Z';

const roots: string[] = [];
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'velum-story-'));
  roots.push(root);
  return root;
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

// ── 偽の生成 ───────────────────────────────────────────────

type Kind = 'plan' | 'ja' | 'en';
const kindOf = (request: LlmRequest): Kind => {
  const properties = (request.responseSchema.properties ?? {}) as Record<string, unknown>;
  if ('episodes' in properties) return 'plan';
  return 'body_ja' in properties ? 'ja' : 'en';
};

/**
 * ネットワークを使わない generateJson。本物と同じく、応答を zod で検めてから返す
 * （形の違いはここで落ち、値の範囲はゲートが見る）。
 */
function fakeGenerate(handler: (request: LlmRequest, kind: Kind, call: number) => unknown) {
  const calls: LlmRequest[] = [];
  const generate = (async (request: LlmRequest, schema: ZodTypeAny) => {
    calls.push(request);
    const data = schema.parse(handler(request, kindOf(request), calls.length));
    return { data, model: 'test-model', raw: JSON.stringify(data) };
  }) as unknown as GenerateJson;
  return { generate, calls };
}

const neverCalled = (): GenerateJson =>
  (async () => {
    throw new Error('generate が呼ばれてはいけない');
  }) as unknown as GenerateJson;

function collector() {
  const lines: string[] = [];
  const warnings: string[] = [];
  return {
    lines,
    warnings,
    log: (line: string) => lines.push(line),
    warn: (line: string) => warnings.push(line),
  };
}

// ── 材料 ───────────────────────────────────────────────────

const riko = buildStoryContext('riko', 1);
const [GARON, MIO] = riko.people.map((person) => person.id) as [string, string];

const JA_SENTENCE = '荷車の車輪が石畳で鳴った。値札の束を握り直して、リコは市の端に立った。';
const EN_SENTENCE = 'The cart rattled over the stones and she gripped the bundle of price tags again.';

/** 下限を満たす、書式の壊れていない日本語の本文。 */
const jaBody = (paragraphs = 4) =>
  Array.from({ length: paragraphs }, () => JA_SENTENCE.repeat(8)).join('\n\n');
const enBody = (paragraphs = 4) =>
  Array.from({ length: paragraphs }, () => `${EN_SENTENCE} `.repeat(4).trim()).join('\n\n');

function planResponse(count: number, overrides: Partial<StoryPlanResponse> = {}): StoryPlanResponse {
  return {
    title_ja: '売れないものの季',
    title_en: 'A Season of Things That Do Not Sell',
    logline: 'リコと一緒にいたい、と思えること。',
    arc_start: '値札を書き換え続けている。',
    arc_change: '売らないものが、少しだけ増える。',
    arc_end: '相変わらず値段を先に言う。',
    focus: [MIO],
    episodes: Array.from({ length: count }, (_, index) => ({
      purpose: `第${index + 1}話の目的。リコの商売の癖が分かる。`,
      situation: `第${index + 1}話の場面の種。市の端で荷車を広げる。`,
      format: STORY_FORMATS[index % STORY_FORMATS.length]!,
      people: index % 2 === 0 ? [MIO] : [],
      working_title_ja: `仮題${index + 1}`,
      working_title_en: `Working Title ${index + 1}`,
    })),
    ...overrides,
  };
}

function manifestOf(
  count: number,
  edit: (manifest: StoryManifest) => void = () => {},
): StoryManifest {
  const manifest: StoryManifest = {
    id: 'riko-s01',
    character_id: 'riko',
    season: 1,
    title: { ja: '売れないもの', en: 'Things I Cannot Sell' },
    status: 'draft',
    episodes: Array.from({ length: count }, (_, index) => ({
      id: `riko-s01-e${String(index + 1).padStart(2, '0')}`,
      order: index + 1,
      required_progress: [0, 2, 5, 9, 14, 20][index] ?? 30,
      status: 'draft' as const,
    })),
  };
  edit(manifest);
  return StoryManifestSchema.parse(manifest);
}

function planOf(count: number): StoryPlan {
  const response = planResponse(count);
  return StoryPlanSchema.parse({
    id: 'riko-s01',
    character_id: 'riko',
    season: 1,
    title: { ja: response.title_ja, en: response.title_en },
    logline: response.logline,
    character_arc: {
      start: response.arc_start,
      emotional_change: response.arc_change,
      end: response.arc_end,
    },
    relationships: { focus: response.focus },
    episodes: response.episodes.map((episode, index) => ({
      order: index + 1,
      purpose: episode.purpose,
      situation: episode.situation,
      format: episode.format,
      people: episode.people,
      working_title: { ja: episode.working_title_ja, en: episode.working_title_en },
    })),
  });
}

/** 一時 root に、台帳と計画（と、あれば本文）を置く。 */
function seed(
  root: string,
  options: { count?: number; manifest?: StoryManifest | null; plan?: StoryPlan | null } = {},
): void {
  const count = options.count ?? 3;
  const manifest = options.manifest === undefined ? manifestOf(count) : options.manifest;
  const plan = options.plan === undefined ? planOf(count) : options.plan;
  if (manifest) writeYaml(storyManifestPath('riko', 1, root), manifest);
  if (plan) writeYaml(storyPlanPath('riko', 1, root), plan);
}

const readManifest = (root: string) =>
  readYaml(storyManifestPath('riko', 1, root), StoryManifestSchema);
const readBody = (root: string, order: number, lang: 'ja' | 'en') =>
  readFileSync(storyBodyPath('riko', 1, order, lang, root), 'utf8');
const hasBody = (root: string, order: number, lang: 'ja' | 'en') =>
  existsSync(storyBodyPath('riko', 1, order, lang, root));

function putBodies(root: string, order: number, ja = 'もとの本文', en = 'The old text'): void {
  for (const [lang, text] of [
    ['ja', ja],
    ['en', en],
  ] as const) {
    const path = storyBodyPath('riko', 1, order, lang, root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${text}\n`, 'utf8');
  }
}

/** 本文の呼び出しに、正しい応答を返す偽の生成。 */
const goodWriter = () =>
  fakeGenerate((_request, kind, call) => {
    if (kind === 'ja') return { title_ja: `生成された題${call}`, body_ja: jaBody() };
    return { title_en: `Generated Title ${call}`, body_en: enBody() };
  });

/** 呼び出しが何話目のものか。ユーザープロンプトの見出し（「— 第N話」）から読む。 */
const orderOf = (request: LlmRequest) => Number(/— 第(\d+)話/.exec(request.user)?.[1]);

// ── 計画 ───────────────────────────────────────────────────

describe('story:plan', () => {
  it('計画を plan.yaml に書き、台帳を作る', async () => {
    const root = makeRoot();
    const { generate, calls } = fakeGenerate(() => planResponse(8));
    const out = collector();

    const outcome = await planStory(
      { characterId: 'riko', season: 1 },
      { generate, now: () => NOW, root, log: out.log, warn: out.warn },
    );

    expect(outcome.status).toBe('planned');
    expect(calls).toHaveLength(1);

    const plan = readYaml(storyPlanPath('riko', 1, root), StoryPlanSchema);
    expect(plan.id).toBe('riko-s01');
    expect(plan.episodes.map((episode) => episode.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(plan.character_arc.start).toBe('値札を書き換え続けている。');
    expect(plan.relationships.focus).toEqual([MIO]);
    expect(plan.episodes[0]!.working_title).toEqual({ ja: '仮題1', en: 'Working Title 1' });
    // 記録はコードが刻む
    expect(plan.generation).toEqual({
      model: 'test-model',
      prompt_version: 'story-plan-v1',
      generated_at: NOW,
    });

    const manifest = readManifest(root);
    const ladder = riko.config.default_required_progress;
    expect(manifest.status).toBe('draft');
    expect(manifest.title).toEqual({ ja: '売れないものの季', en: 'A Season of Things That Do Not Sell' });
    expect(manifest.episodes).toHaveLength(8);
    manifest.episodes.forEach((episode, index) => {
      expect(episode.id).toBe(`riko-s01-e0${index + 1}`);
      expect(episode.status).toBe('draft');
      expect(episode.required_progress).toBe(ladder[index]);
      // 題と形式は台帳へ写さない（plan.yaml の直しが、台帳の値に黙って負けないように）
      expect(episode.title).toBeUndefined();
      expect(episode.format).toBeUndefined();
    });
    expect(outcome.status === 'planned' && outcome.manifestCreated).toBe(true);
    expect(out.warnings).toEqual([]);
  });

  it('話数の指定は既定より優先され、プロンプトに話数が書かれる', async () => {
    const root = makeRoot();
    const { generate, calls } = fakeGenerate(() => planResponse(3));

    await planStory(
      { characterId: 'riko', season: 1, episodes: 3 },
      { generate, now: () => NOW, root, log: () => {}, warn: () => {} },
    );

    expect(calls[0]!.system).toContain('ちょうど 3 話');
    expect(calls[0]!.user).toContain('全 3 話');
    expect(readYaml(storyPlanPath('riko', 1, root), StoryPlanSchema).episodes).toHaveLength(3);
    expect(readManifest(root).episodes).toHaveLength(3);
  });

  it('VELUM_STORY_MODEL があれば request.model に渡し、空なら渡さない', async () => {
    const root = makeRoot();
    vi.stubEnv('VELUM_STORY_MODEL', '  @cf/test/story-model ');
    const first = fakeGenerate(() => planResponse(2));
    await planStory(
      { characterId: 'riko', season: 1, episodes: 2 },
      { generate: first.generate, now: () => NOW, root, log: () => {}, warn: () => {} },
    );
    expect(first.calls[0]!.model).toBe('@cf/test/story-model');

    vi.stubEnv('VELUM_STORY_MODEL', '');
    const second = fakeGenerate(() => planResponse(2));
    await planStory(
      { characterId: 'riko', season: 1, episodes: 2, force: true },
      { generate: second.generate, now: () => NOW, root, log: () => {}, warn: () => {} },
    );
    expect(second.calls[0]!.model).toBeUndefined();
  });

  it('plan.yaml があれば、--force が無い限り何もしない', async () => {
    const root = makeRoot();
    const first = fakeGenerate(() => planResponse(3));
    await planStory(
      { characterId: 'riko', season: 1, episodes: 3 },
      { generate: first.generate, now: () => NOW, root, log: () => {}, warn: () => {} },
    );
    const before = readFileSync(storyPlanPath('riko', 1, root), 'utf8');

    const out = collector();
    const outcome = await planStory(
      { characterId: 'riko', season: 1, episodes: 3 },
      { generate: neverCalled(), now: () => NOW, root, log: out.log, warn: out.warn },
    );
    expect(outcome.status).toBe('skipped');
    expect(out.lines.join('\n')).toContain('--force');
    expect(readFileSync(storyPlanPath('riko', 1, root), 'utf8')).toBe(before);

    // --force なら作り直す
    const again = fakeGenerate(() => planResponse(3, { logline: '作り直した計画。' }));
    const forced = await planStory(
      { characterId: 'riko', season: 1, episodes: 3, force: true },
      { generate: again.generate, now: () => NOW, root, log: () => {}, warn: () => {} },
    );
    expect(forced.status).toBe('planned');
    expect(readYaml(storyPlanPath('riko', 1, root), StoryPlanSchema).logline).toBe('作り直した計画。');
  });

  it('台帳が既にあれば、人間が書いたものを変えずに、足りない話だけを足す', async () => {
    const root = makeRoot();
    const existing = manifestOf(2, (manifest) => {
      manifest.status = 'reviewed';
      manifest.summary = { ja: '人間の要約', en: 'A human summary' };
      manifest.episodes[0]!.status = 'reviewed';
      manifest.episodes[0]!.required_progress = 0;
      manifest.episodes[0]!.title = { ja: '人間の題', en: 'A Human Title' };
      manifest.episodes[0]!.format = 'letter';
      manifest.episodes[1]!.required_progress = 4;
    });
    seed(root, { manifest: existing, plan: null });

    const { generate } = fakeGenerate(() => planResponse(4));
    await planStory(
      { characterId: 'riko', season: 1, episodes: 4 },
      { generate, now: () => NOW, root, log: () => {}, warn: () => {} },
    );

    const manifest = readManifest(root);
    expect(manifest.status).toBe('reviewed');
    expect(manifest.title).toEqual(existing.title);
    expect(manifest.summary).toEqual(existing.summary);
    // 既存の話: 人間の値はそのまま
    expect(manifest.episodes[0]).toMatchObject({
      status: 'reviewed',
      required_progress: 0,
      title: { ja: '人間の題', en: 'A Human Title' },
      format: 'letter',
    });
    expect(manifest.episodes[1]).toMatchObject({ status: 'draft', required_progress: 4 });
    // 空いていた題と形式は、計画から埋めない（空のまま。足された話も同じ）
    for (const episode of manifest.episodes.slice(1)) {
      expect(episode.title).toBeUndefined();
      expect(episode.format).toBeUndefined();
    }
    // 計画にあって台帳に無い話は draft で足される
    expect(manifest.episodes.map((episode) => episode.status)).toEqual([
      'reviewed',
      'draft',
      'draft',
      'draft',
    ]);
  });

  it('台帳の先頭のコメントを失わない', async () => {
    const root = makeRoot();
    const path = storyManifestPath('riko', 1, root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      [
        '# 人間が書いた説明（消えてはいけない）',
        '# 二行目',
        '',
        'id: riko-s01',
        'character_id: riko',
        'season: 1',
        'title:',
        '  ja: 売れないもの',
        '  en: Things I Cannot Sell',
        'status: draft',
        'episodes:',
        '  # この話のメモ（消えてはいけない）',
        '  - id: riko-s01-e01',
        '    order: 1',
        '    required_progress: 0',
        '    status: draft',
        '',
      ].join('\n'),
      'utf8',
    );

    const { generate } = fakeGenerate(() => planResponse(2));
    await planStory(
      { characterId: 'riko', season: 1, episodes: 2 },
      { generate, now: () => NOW, root, log: () => {}, warn: () => {} },
    );

    const text = readFileSync(path, 'utf8');
    expect(text).toContain('# 人間が書いた説明（消えてはいけない）');
    expect(text).toContain('# 二行目');
    expect(text).toContain('# この話のメモ（消えてはいけない）');
    // 足されたものは入っていて、全体としてスキーマに合う
    expect(readManifest(root).episodes).toHaveLength(2);
    // 題は計画から埋めない
    expect(readManifest(root).episodes[0]!.title).toBeUndefined();
  });

  it('ゲートに落ちた計画は、何も書かない（話数・id・秘密）', async () => {
    const profile = readYaml(charPath('riko', 'profile.yaml'), ProfileSchema);
    const secret = secretSegments(profile.core.secret_unknown_to_self)[0]!;
    const cases: Array<[string, StoryPlanResponse, RegExp]> = [
      ['話数が違う', planResponse(7), /7 件です（ちょうど 8 件/],
      [
        '知らない人物の id',
        planResponse(8, {
          episodes: planResponse(8).episodes.map((episode, index) =>
            index === 2 ? { ...episode, people: ['nobody'] } : episode,
          ),
        }),
        /第3話の people の id「nobody」が「周りの人」にない/,
      ],
      [
        '秘密の混入（折り返された一文）',
        planResponse(8, {
          logline: `${secret.slice(0, 6)}\n${secret.slice(6)}がこの季の中心にある。`,
        }),
        /logline に、隠されている文/,
      ],
    ];

    for (const [name, response, expected] of cases) {
      const root = makeRoot();
      const { generate } = fakeGenerate(() => response);
      const out = collector();
      const outcome = await planStory(
        { characterId: 'riko', season: 1 },
        { generate, now: () => NOW, root, log: out.log, warn: out.warn },
      );

      expect(outcome.status, name).toBe('rejected');
      if (outcome.status !== 'rejected') continue;
      expect(outcome.violations.join('\n'), name).toMatch(expected);
      expect(existsSync(storyPlanPath('riko', 1, root)), name).toBe(false);
      expect(existsSync(storyManifestPath('riko', 1, root)), name).toBe(false);
      // 秘密そのものを、ログにも違反文にも書かない
      expect(out.warnings.join('\n'), name).not.toContain(secret);
      expect(outcome.violations.join('\n'), name).not.toContain(secret);
    }
  });

  it('--dry-run は LLM を呼ばず、何も書かず、プロンプトを出して終わる', async () => {
    const root = makeRoot();
    const out = collector();
    const outcome = await planStory(
      { characterId: 'riko', season: 1, dryRun: true },
      { generate: neverCalled(), now: () => NOW, root, log: out.log, warn: out.warn },
    );

    expect(outcome.status).toBe('dry-run');
    expect(existsSync(storyPlanPath('riko', 1, root))).toBe(false);
    expect(existsSync(storyManifestPath('riko', 1, root))).toBe(false);
    const printed = out.lines.join('\n');
    expect(printed).toContain('===== system =====');
    expect(printed).toContain('===== user =====');
    expect(out.lines[out.lines.length - 1]).toBe(PLAN_DRY_RUN_NOTICE);
    expect(PLAN_DRY_RUN_NOTICE).toBe('--dry-run のため、計画は生成しません。');
  });

  it('--force の再計画へ「すでに決まっている話」として渡すのは、台帳に実際にある題・形式だけ', async () => {
    const root = makeRoot();
    const first = fakeGenerate(() => planResponse(3));
    await planStory(
      { characterId: 'riko', season: 1, episodes: 3 },
      { generate: first.generate, now: () => NOW, root, log: () => {}, warn: () => {} },
    );

    // plan から写していないので、何も決まっていない
    const second = fakeGenerate(() => planResponse(3));
    await planStory(
      { characterId: 'riko', season: 1, episodes: 3, force: true },
      { generate: second.generate, now: () => NOW, root, log: () => {}, warn: () => {} },
    );
    expect(second.calls[0]!.user).not.toContain('すでに決まっている話');
    expect(second.calls[0]!.user).not.toContain('Working Title');

    // 人間が台帳に書いた題と形式だけが、変えないものとして渡る（出典は manifest.yaml）
    const manifest = readManifest(root);
    manifest.episodes[1]!.title = { ja: '人間の題', en: 'A Human Title' };
    manifest.episodes[1]!.format = 'letter';
    writeYaml(storyManifestPath('riko', 1, root), manifest);
    const third = fakeGenerate(() => planResponse(3));
    await planStory(
      { characterId: 'riko', season: 1, episodes: 3, force: true },
      { generate: third.generate, now: () => NOW, root, log: () => {}, warn: () => {} },
    );
    const user = third.calls[0]!.user;
    expect(user).toContain('## すでに決まっている話');
    expect(user).toContain('manifest.yaml');
    expect(user).toContain('第2話: 題「人間の題」（A Human Title）、形式 letter');
    expect(user).not.toContain('第1話: 題');
    expect(user).not.toContain('第3話: 題');
  });

  it('話数が範囲外なら生成せずに止まる', async () => {
    const root = makeRoot();
    await expect(
      planStory(
        { characterId: 'riko', season: 1, episodes: 13 },
        { generate: neverCalled(), root, log: () => {}, warn: () => {} },
      ),
    ).rejects.toThrow(/1〜12/);
  });
});

describe('syncManifest（純関数）', () => {
  const config = riko.config;

  it('台帳が無ければ、階段つきで draft の台帳を作る（話の題・形式は写さない）', () => {
    const plan = planOf(5);
    const { manifest, created, notes } = syncManifest(null, plan, config);

    expect(created).toBe(true);
    expect(manifest.status).toBe('draft');
    expect(manifest.title).toEqual(plan.title);
    expect(manifest.episodes.map((episode) => episode.required_progress)).toEqual(
      config.default_required_progress.slice(0, 5),
    );
    expect(manifest.episodes.every((episode) => episode.status === 'draft')).toBe(true);
    // 季の題は計画から（スキーマの必須）。話の title / format は、キーごと無い
    expect(manifest.episodes[0]).toEqual({
      id: 'riko-s01-e01',
      order: 1,
      required_progress: 0,
      status: 'draft',
    });
    expect('title' in manifest.episodes[0]!).toBe(false);
    expect('format' in manifest.episodes[0]!).toBe(false);
    expect(notes).toHaveLength(5);
    expect(StoryManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it('人間が書いたものは決して変えない', () => {
    const existing = manifestOf(3, (manifest) => {
      manifest.status = 'published';
      manifest.title = { ja: '人間の季題', en: 'Human Season Title' };
      manifest.episodes[0]!.status = 'published';
      manifest.episodes[0]!.title = { ja: '一話', en: 'One' };
      manifest.episodes[0]!.summary = { ja: '要約', en: 'Summary' };
      manifest.episodes[0]!.format = 'record';
      manifest.episodes[1]!.status = 'reviewed';
      manifest.episodes[1]!.required_progress = 7;
      manifest.episodes[1]!.title = { ja: '二話', en: 'Two' };
      manifest.episodes[2]!.required_progress = 9;
    });
    const snapshot = structuredClone(existing);

    const { manifest } = syncManifest(existing, planOf(3), config);

    // 入力は書き換えない
    expect(existing).toEqual(snapshot);
    expect(manifest.status).toBe('published');
    expect(manifest.title).toEqual(existing.title);
    expect(manifest.episodes[0]).toEqual(existing.episodes[0]);
    expect(manifest.episodes[1]!.status).toBe('reviewed');
    expect(manifest.episodes[1]!.required_progress).toBe(7);
    expect(manifest.episodes[1]!.title).toEqual({ ja: '二話', en: 'Two' });
    // 空いているところは、計画で埋めない
    expect(manifest.episodes[1]!.format).toBeUndefined();
    expect(manifest.episodes[2]!.title).toBeUndefined();
    expect(manifest.episodes[2]!.format).toBeUndefined();
    expect(StoryManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it('既存の話の title / format が空でも計画から写さない。足す話にも title / format は付かない', () => {
    const existing = manifestOf(2);
    const { manifest, notes } = syncManifest(existing, planOf(4), config);

    expect(manifest.episodes.slice(0, 2)).toEqual(existing.episodes);
    for (const episode of manifest.episodes) {
      expect(episode.title).toBeUndefined();
      expect(episode.format).toBeUndefined();
    }
    // 足した話の注意だけが出る（「仮題で埋めた」「計画の形式で埋めた」は出ない）
    expect(notes).toHaveLength(2);
    expect(notes.join('\n')).not.toContain('埋めた');
  });

  it('足す話の required_progress は階段から取り、前の話を下回らない', () => {
    const existing = manifestOf(2, (manifest) => {
      // 人間が階段を押し上げている
      manifest.episodes[1]!.required_progress = 100;
    });
    const { manifest, notes } = syncManifest(existing, planOf(4), config);

    expect(manifest.episodes.map((episode) => episode.required_progress)).toEqual([0, 100, 100, 100]);
    expect(notes.filter((note) => note.includes('draft で足した'))).toHaveLength(2);
    expect(StoryManifestSchema.safeParse(manifest).success).toBe(true);

    // 階段のほうが高ければ階段の値
    const normal = syncManifest(manifestOf(2), planOf(4), config).manifest;
    expect(normal.episodes.map((episode) => episode.required_progress)).toEqual(
      [0, 2, config.default_required_progress[2], config.default_required_progress[3]],
    );
  });

  it('計画に無い台帳の話は残し、注意を出す', () => {
    const existing = manifestOf(5);
    const { manifest, notes } = syncManifest(existing, planOf(3), config);

    expect(manifest.episodes).toHaveLength(5);
    expect(manifest.episodes.slice(3)).toEqual(existing.episodes.slice(3));
    expect(notes.join('\n')).toContain('第4〜5話があるが、計画には無い');
  });

  it('季が違えば止まる', () => {
    const other = { ...planOf(3), id: 'riko-s02' };
    expect(() => syncManifest(manifestOf(3), other, config)).toThrow(/季が違います/);
  });

  it('もう一度かけても変わらない（冪等）', () => {
    const once = syncManifest(null, planOf(4), config).manifest;
    const twice = syncManifest(once, planOf(4), config);
    expect(twice.manifest).toEqual(once);
    expect(twice.notes).toEqual([]);
  });
});

describe('writeManifestFile', () => {
  it('ファイルが無ければ作る', () => {
    const root = makeRoot();
    const path = storyManifestPath('riko', 1, root);
    writeManifestFile(path, manifestOf(2));
    expect(readYaml(path, StoryManifestSchema).episodes).toHaveLength(2);
  });

  it('内容が変わらなければ、ファイルに触れない', () => {
    const root = makeRoot();
    const path = storyManifestPath('riko', 1, root);
    mkdirSync(dirname(path), { recursive: true });
    const text = '# 手で書いた\nid: riko-s01\ncharacter_id: riko\nseason: 1\ntitle: {ja: あ, en: a}\nstatus: draft\nepisodes:\n  - {id: riko-s01-e01, order: 1, required_progress: 0, status: draft}\n';
    writeFileSync(path, text, 'utf8');
    writeManifestFile(path, readYaml(path, StoryManifestSchema));
    expect(readFileSync(path, 'utf8')).toBe(text);
  });
});

// ── 本文 ───────────────────────────────────────────────────

describe('story:write', () => {
  const deps = (root: string, generate: GenerateJson, out = collector()) => ({
    generate,
    now: () => NOW,
    root,
    log: out.log,
    warn: out.warn,
  });

  it('本文の無い話すべてに、日本語と英語を draft で書き、台帳へ記録する', async () => {
    const root = makeRoot();
    seed(root, { count: 3 });
    const { generate, calls } = goodWriter();

    const outcome = await writeEpisodes({ characterId: 'riko', season: 1 }, deps(root, generate));

    expect(outcome).toMatchObject({ status: 'done', written: [1, 2, 3], failed: [], demoted: [] });
    expect(calls).toHaveLength(6);

    for (const order of [1, 2, 3]) {
      expect(readBody(root, order, 'ja')).toBe(`${jaBody()}\n`);
      expect(readBody(root, order, 'en')).toBe(`${enBody()}\n`);
    }

    const manifest = readManifest(root);
    manifest.episodes.forEach((episode, index) => {
      expect(episode.status).toBe('draft');
      expect(episode.generation).toEqual({
        model: 'test-model',
        prompt_version: STORY_WRITE_PROMPT_VERSION,
        generated_at: NOW,
      });
      // 題は無かったので、生成された題で埋まる
      expect(episode.title).toEqual({
        ja: `生成された題${index * 2 + 1}`,
        en: `Generated Title ${index * 2 + 2}`,
      });
      // 形式は計画から
      expect(episode.format).toBe(planOf(3).episodes[index]!.format);
    });
  });

  it('英語版は、確定した日本語版の題と本文を渡して二度目に呼ぶ', async () => {
    const root = makeRoot();
    seed(root, { count: 1 });
    const { generate, calls } = goodWriter();

    await writeEpisodes({ characterId: 'riko', season: 1 }, deps(root, generate));

    expect(kindOf(calls[0]!)).toBe('ja');
    expect(kindOf(calls[1]!)).toBe('en');
    expect(calls[1]!.user).toContain('生成された題1');
    expect(calls[1]!.user).toContain(jaBody());
  });

  it('前の話の本文は次のプロンプトへ渡さず、目的と題だけ渡す', async () => {
    const root = makeRoot();
    seed(root, { count: 2 });
    const { generate, calls } = goodWriter();

    await writeEpisodes({ characterId: 'riko', season: 1 }, deps(root, generate));

    const secondJa = calls[2]!;
    expect(kindOf(secondJa)).toBe('ja');
    expect(secondJa.user).toContain('第1話「生成された題1」');
    expect(secondJa.user).toContain('第1話の目的。リコの商売の癖が分かる。');
    expect(secondJa.user).not.toContain(JA_SENTENCE);
    expect(secondJa.system).not.toContain(JA_SENTENCE);
  });

  it('すでに両方の本文がある話は飛ばし、足りない話だけ書く', async () => {
    const root = makeRoot();
    seed(root, { count: 3 });
    putBodies(root, 1);
    // 第2話は日本語だけ（英語が無い）→ 対象
    mkdirSync(dirname(storyBodyPath('riko', 1, 2, 'ja', root)), { recursive: true });
    writeFileSync(storyBodyPath('riko', 1, 2, 'ja', root), '日本語だけ\n', 'utf8');
    const { generate, calls } = goodWriter();

    const outcome = await writeEpisodes({ characterId: 'riko', season: 1 }, deps(root, generate));

    expect(outcome).toMatchObject({ written: [2, 3] });
    expect(calls).toHaveLength(4);
    expect(readBody(root, 1, 'ja')).toBe('もとの本文\n');
  });

  it('--episode で、書き終えた話は --force が無ければ書き直さない', async () => {
    const root = makeRoot();
    seed(root, { count: 2 });
    putBodies(root, 1);

    const out = collector();
    const outcome = await writeEpisodes(
      { characterId: 'riko', season: 1, episode: 1 },
      deps(root, neverCalledWriter(), out),
    );

    expect(outcome).toMatchObject({ status: 'done', written: [], skipped: [1] });
    expect(out.lines.join('\n')).toContain('--force');
    expect(readBody(root, 1, 'ja')).toBe('もとの本文\n');
  });

  it('--force は --episode の話を書き直す。reviewed なら draft へ戻す', async () => {
    const root = makeRoot();
    seed(root, {
      count: 2,
      manifest: manifestOf(2, (manifest) => {
        manifest.status = 'reviewed';
        manifest.episodes[0]!.status = 'reviewed';
        manifest.episodes[0]!.title = { ja: '人間の題', en: 'A Human Title' };
        manifest.episodes[1]!.status = 'reviewed';
        manifest.episodes[1]!.title = { ja: '二話', en: 'Two' };
      }),
    });
    putBodies(root, 1);
    putBodies(root, 2);
    const { generate } = goodWriter();
    const out = collector();

    const outcome = await writeEpisodes(
      { characterId: 'riko', season: 1, episode: 1, force: true },
      deps(root, generate, out),
    );

    expect(outcome).toMatchObject({ written: [1], demoted: [1] });
    expect(readBody(root, 1, 'ja')).toBe(`${jaBody()}\n`);
    // 触れていない話はそのまま
    expect(readBody(root, 2, 'ja')).toBe('もとの本文\n');

    const manifest = readManifest(root);
    expect(manifest.episodes[0]!.status).toBe('draft');
    expect(manifest.episodes[1]!.status).toBe('reviewed');
    // 人間が決めた題は、生成された題で上書きしない
    expect(manifest.episodes[0]!.title).toEqual({ ja: '人間の題', en: 'A Human Title' });
    expect(manifest.episodes[0]!.generation).toMatchObject({ generated_at: NOW });
    expect(out.lines.join('\n')).toContain('draft へ戻しました');
  });

  it('台帳に題があるときは、その題を使うよう頼み、生成された題の長さでは落とさない', async () => {
    const root = makeRoot();
    seed(root, {
      count: 1,
      manifest: manifestOf(1, (manifest) => {
        manifest.episodes[0]!.title = { ja: 'とても長い人間が決めた題'.repeat(5), en: 'A Fixed English Title' };
      }),
    });
    const { generate, calls } = fakeGenerate((_request, kind) =>
      kind === 'ja'
        ? { title_ja: '写し損ねた題'.repeat(10), body_ja: jaBody() }
        : { title_en: 'x'.repeat(100), body_en: enBody() },
    );

    const outcome = await writeEpisodes({ characterId: 'riko', season: 1 }, deps(root, generate));

    expect(outcome).toMatchObject({ written: [1], failed: [] });
    expect(calls[0]!.user).toContain('title_ja には、この題をそのまま書く');
    expect(calls[1]!.user).toContain('"A Fixed English Title"');
    expect(readManifest(root).episodes[0]!.title).toEqual({
      ja: 'とても長い人間が決めた題'.repeat(5),
      en: 'A Fixed English Title',
    });
  });

  it('story:plan のあとに plan.yaml の format を直せば、本文のプロンプトが変わる（台帳に写していない）', async () => {
    const root = makeRoot();
    const planner = fakeGenerate(() => planResponse(2));
    await planStory(
      { characterId: 'riko', season: 1, episodes: 2 },
      { generate: planner.generate, now: () => NOW, root, log: () => {}, warn: () => {} },
    );
    // plan の第1話は first_person。人間が letter へ直す
    const planPath = storyPlanPath('riko', 1, root);
    const plan = readYaml(planPath, StoryPlanSchema);
    expect(plan.episodes[0]!.format).toBe('first_person');
    plan.episodes[0]!.format = 'letter';
    writeYaml(planPath, plan);

    const out = collector();
    const { generate, calls } = goodWriter();
    await writeEpisodes({ characterId: 'riko', season: 1, episode: 1 }, deps(root, generate, out));

    expect(calls[0]!.user).toContain(`形式: letter（${STORY_FORMAT_GUIDE.letter}）`);
    expect(calls[0]!.user).not.toContain('形式: first_person');
    // 台帳が空なので食い違いではない。注意は出ない
    expect(out.warnings).toEqual([]);
    // 書いた形式が、台帳に残る
    expect(readManifest(root).episodes[0]!.format).toBe('letter');
  });

  it('台帳に format があれば plan より優先し、食い違いを生成の前に注意する（エラーにはしない）', async () => {
    const root = makeRoot();
    // plan の第1話は first_person、第2話は third_person
    seed(root, {
      count: 3,
      manifest: manifestOf(3, (manifest) => {
        manifest.episodes[0]!.format = 'scene'; // plan と違う
        manifest.episodes[1]!.format = 'third_person'; // plan と同じ（注意なし）
        // 第3話は空（注意なし）
      }),
    });
    const out = collector();
    let warningsAtFirstCall = -1;
    const { generate, calls } = fakeGenerate((_request, kind, call) => {
      if (call === 1) warningsAtFirstCall = out.warnings.length;
      return kind === 'ja'
        ? { title_ja: `生成された題${call}`, body_ja: jaBody() }
        : { title_en: `Generated Title ${call}`, body_en: enBody() };
    });

    const outcome = await writeEpisodes({ characterId: 'riko', season: 1 }, deps(root, generate, out));

    expect(outcome).toMatchObject({ status: 'done', written: [1, 2, 3], failed: [] });
    expect(calls[0]!.user).toContain(`形式: scene（${STORY_FORMAT_GUIDE.scene}）`);
    expect(calls[0]!.user).not.toContain('形式: first_person');
    // 台帳の形式が書いたものとして残り、後の話の「前の話」の欄にも台帳の形式が出る
    expect(readManifest(root).episodes[0]!.format).toBe('scene');
    expect(calls[2]!.user).toContain('第1話「生成された題1」（scene）');

    expect(out.warnings).toEqual([
      '第1話: manifest.yaml の format（scene）が plan.yaml（first_person）と違います。manifest が優先されます。直すなら manifest.yaml で。',
    ]);
    // 注意は生成の前（最初の呼び出しより先）に出ている
    expect(warningsAtFirstCall).toBe(1);
  });

  it('台帳の題が plan の仮題と違えば注意し、題は台帳のものに固定する。同じなら注意しない', async () => {
    const root = makeRoot();
    seed(root, {
      count: 2,
      manifest: manifestOf(2, (manifest) => {
        manifest.episodes[0]!.title = { ja: '人間の題', en: 'A Human Title' };
        // plan の仮題と同じ（注意なし）
        manifest.episodes[1]!.title = { ja: '仮題2', en: 'Working Title 2' };
      }),
    });
    const out = collector();
    const { generate, calls } = goodWriter();

    await writeEpisodes({ characterId: 'riko', season: 1 }, deps(root, generate, out));

    expect(out.warnings).toEqual([
      '第1話: manifest.yaml の title（人間の題 / A Human Title）が plan.yaml の working_title（仮題1 / Working Title 1）と違います。manifest が優先されます。直すなら manifest.yaml で。',
    ]);
    expect(calls[0]!.user).toContain('題はすでに「人間の題」と決まっている');
    expect(readManifest(root).episodes[0]!.title).toEqual({ ja: '人間の題', en: 'A Human Title' });
  });

  it('--dry-run でも、書く話の食い違いを注意する。対象でない話は注意しない', async () => {
    const root = makeRoot();
    seed(root, {
      count: 2,
      manifest: manifestOf(2, (manifest) => {
        manifest.episodes[0]!.format = 'scene';
        manifest.episodes[1]!.format = 'scene';
      }),
    });
    putBodies(root, 1); // 第1話は本文があり、対象外
    const out = collector();

    await writeEpisodes(
      { characterId: 'riko', season: 1, dryRun: true },
      deps(root, neverCalledWriter(), out),
    );

    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toContain('第2話: manifest.yaml の format（scene）が plan.yaml（third_person）と違います');
  });

  it('台帳に題が無い話は、plan の仮題を「仮題」として渡し、書いたあとの題を台帳へ埋める', async () => {
    const root = makeRoot();
    const planner = fakeGenerate(() => planResponse(2));
    await planStory(
      { characterId: 'riko', season: 1, episodes: 2 },
      { generate: planner.generate, now: () => NOW, root, log: () => {}, warn: () => {} },
    );
    expect(readManifest(root).episodes.every((episode) => episode.title === undefined)).toBe(true);

    // 第1話はモデルが仮題をそのまま使い、第2話は付け直す
    const { generate, calls } = fakeGenerate((request, kind) => {
      const order = orderOf(request);
      if (kind === 'ja') return { title_ja: order === 1 ? '仮題1' : '付け直した題', body_ja: jaBody() };
      return { title_en: order === 1 ? 'Working Title 1' : 'A Renamed Title', body_en: enBody() };
    });
    const out = collector();
    const outcome = await writeEpisodes({ characterId: 'riko', season: 1 }, deps(root, generate, out));

    expect(outcome).toMatchObject({ written: [1, 2], failed: [] });
    // 日本語版: 仮題を渡す（使っても付け直してもよい）。固定ではない
    expect(calls[0]!.user).toContain('計画の仮題は「仮題1」');
    expect(calls[0]!.user).not.toContain('題はすでに');
    expect(calls[2]!.user).toContain('計画の仮題は「仮題2」');
    // 英語版: 日本語版が仮題のまま題にしたときだけ、対になる英語の仮題を渡す
    expect(calls[1]!.user).toContain('計画の英語の仮題は "Working Title 1"');
    expect(calls[3]!.user).not.toContain('計画の英語の仮題');
    // 書いたあとの題が、空だった台帳の title を埋める
    const manifest = readManifest(root);
    expect(manifest.episodes[0]!.title).toEqual({ ja: '仮題1', en: 'Working Title 1' });
    expect(manifest.episodes[1]!.title).toEqual({ ja: '付け直した題', en: 'A Renamed Title' });
    // 台帳が空だったので、食い違いの注意は出ない
    expect(out.warnings).toEqual([]);
  });

  it('台帳に題が無いとき、生成された題は題のゲートを通る（長すぎれば破棄）', async () => {
    const root = makeRoot();
    seed(root, { count: 1 });
    const { generate } = fakeGenerate((_request, kind) =>
      kind === 'ja'
        ? { title_ja: 'あ'.repeat(STORY_WRITE_LIMITS.titleJaMaxChars + 1), body_ja: jaBody() }
        : { title_en: 'Title', body_en: enBody() },
    );

    const outcome = await writeEpisodes({ characterId: 'riko', season: 1 }, deps(root, generate));

    expect(outcome).toMatchObject({ written: [] });
    expect(outcome.status === 'done' && outcome.failed).toHaveLength(1);
    expect(readManifest(root).episodes[0]!.title).toBeUndefined();
  });

  it('published の話は、--force でも書き直さない（何も書かずに止まる）', async () => {
    const root = makeRoot();
    seed(root, {
      count: 3,
      manifest: manifestOf(3, (manifest) => {
        manifest.status = 'published';
        manifest.episodes[0]!.status = 'published';
        manifest.episodes[0]!.title = { ja: '一話', en: 'One' };
      }),
    });
    putBodies(root, 1);
    const before = readFileSync(storyManifestPath('riko', 1, root), 'utf8');

    await expect(
      writeEpisodes(
        { characterId: 'riko', season: 1, episode: 1, force: true },
        deps(root, neverCalledWriter()),
      ),
    ).rejects.toThrow(/published の話は書き直さない/);

    // --force が無ければ、本文のある話は対象にならず、飛ばされるだけ
    const skipped = await writeEpisodes(
      { characterId: 'riko', season: 1, episode: 1 },
      deps(root, neverCalledWriter()),
    );
    expect(skipped).toMatchObject({ written: [], skipped: [1] });

    // 本文の無い published の話が自動の対象に入るときも、1話も書かずに止まる
    rmSync(storyBodyPath('riko', 1, 1, 'ja', root));
    await expect(
      writeEpisodes({ characterId: 'riko', season: 1 }, deps(root, neverCalledWriter())),
    ).rejects.toThrow(/riko-s01-e01 は published です/);

    expect(readFileSync(storyManifestPath('riko', 1, root), 'utf8')).toBe(before);
    expect(hasBody(root, 2, 'ja')).toBe(false);
    expect(hasBody(root, 1, 'en')).toBe(true);
  });

  it('--force は --episode と組み合わせたときだけ使える', async () => {
    const root = makeRoot();
    seed(root, { count: 2 });
    await expect(
      writeEpisodes(
        { characterId: 'riko', season: 1, force: true },
        deps(root, neverCalledWriter()),
      ),
    ).rejects.toThrow(/--episode と組み合わせて/);
  });

  it('ゲートに落ちた話は何も書かず、次の話へ進み、失敗として返す', async () => {
    const root = makeRoot();
    seed(root, { count: 3 });
    const { generate, calls } = fakeGenerate((request, kind) => {
      const order = orderOf(request);
      if (kind === 'ja') {
        // 第1話の日本語版は短すぎる
        return { title_ja: `題${order}`, body_ja: order === 1 ? 'あまりに短い。' : jaBody() };
      }
      // 第2話の英語版は日本語が混じっている
      return {
        title_en: `Title ${order}`,
        body_en: order === 2 ? `${enBody()}\n\n${JA_SENTENCE.repeat(3)}` : enBody(),
      };
    });
    const out = collector();

    const outcome = await writeEpisodes({ characterId: 'riko', season: 1 }, deps(root, generate, out));

    expect(outcome.status).toBe('done');
    if (outcome.status !== 'done') return;
    expect(outcome.written).toEqual([3]);
    expect(outcome.failed.map((failure) => failure.order)).toEqual([1, 2]);
    expect(outcome.failed[0]!.violations.join('\n')).toMatch(/本文（日本語）が \d+ 文字です（下限 600）/);
    expect(outcome.failed[1]!.violations.join('\n')).toMatch(/英語の本文に日本語が混じっています/);

    // 落ちた話は、日本語版が通っていても何も書かない
    for (const order of [1, 2]) {
      expect(hasBody(root, order, 'ja')).toBe(false);
      expect(hasBody(root, order, 'en')).toBe(false);
    }
    expect(hasBody(root, 3, 'ja')).toBe(true);

    // 台帳は、書けた話だけが動く
    const manifest = readManifest(root);
    expect(manifest.episodes[0]).toEqual(manifestOf(3).episodes[0]);
    expect(manifest.episodes[1]).toEqual(manifestOf(3).episodes[1]);
    expect(manifest.episodes[2]!.generation).toBeDefined();
    expect(out.warnings.join('\n')).toContain('構造ゲートの違反により破棄しました');
    // 第1話は日本語版で落ちたので、英語版は呼んでいない（ja, ja, en, ja, en）
    expect(calls.map(kindOf)).toEqual(['ja', 'ja', 'en', 'ja', 'en']);
  });

  it('LLM のエラーは全体を止める。書けた話はディスクに残る', async () => {
    const root = makeRoot();
    seed(root, { count: 3 });
    const { generate } = fakeGenerate((_request, kind, call) => {
      if (call > 2) throw new Error('Workers AI が 503 を返しました');
      return kind === 'ja'
        ? { title_ja: '題', body_ja: jaBody() }
        : { title_en: 'Title', body_en: enBody() };
    });

    await expect(
      writeEpisodes({ characterId: 'riko', season: 1 }, deps(root, generate)),
    ).rejects.toThrow(/503/);

    expect(hasBody(root, 1, 'ja')).toBe(true);
    expect(hasBody(root, 1, 'en')).toBe(true);
    expect(hasBody(root, 2, 'ja')).toBe(false);
    expect(readManifest(root).episodes[0]!.generation).toBeDefined();
    expect(readManifest(root).episodes[1]!.generation).toBeUndefined();
  });

  it('--dry-run は LLM を呼ばず、何も書かず、最初の対象のプロンプトを出す', async () => {
    const root = makeRoot();
    seed(root, { count: 3 });
    putBodies(root, 1);
    const out = collector();

    const outcome = await writeEpisodes(
      { characterId: 'riko', season: 1, dryRun: true },
      deps(root, neverCalledWriter(), out),
    );

    expect(outcome).toEqual({ status: 'dry-run', target: 2 });
    expect(hasBody(root, 2, 'ja')).toBe(false);
    const printed = out.lines.join('\n');
    expect(printed).toContain('対象: 第2話');
    expect(printed).toContain('===== 日本語版 system =====');
    expect(printed).toContain('===== 英語版 user');
    expect(printed).toContain('第2話の目的。リコの商売の癖が分かる。');
    expect(out.lines[out.lines.length - 1]).toBe(WRITE_DRY_RUN_NOTICE);
  });

  it('計画が無ければ、story:plan を案内して止まる', async () => {
    const root = makeRoot();
    seed(root, { count: 2, plan: null });
    await expect(
      writeEpisodes({ characterId: 'riko', season: 1 }, deps(root, neverCalledWriter())),
    ).rejects.toThrow(/npm run story:plan -- --character riko --season 1/);
  });

  it('台帳が無ければ止まる', async () => {
    const root = makeRoot();
    seed(root, { count: 2, manifest: null });
    await expect(
      writeEpisodes({ characterId: 'riko', season: 1 }, deps(root, neverCalledWriter())),
    ).rejects.toThrow(/manifest\.yaml がありません/);
  });

  it('計画に無い話番号は指定できない', async () => {
    const root = makeRoot();
    seed(root, { count: 2 });
    await expect(
      writeEpisodes(
        { characterId: 'riko', season: 1, episode: 5 },
        deps(root, neverCalledWriter()),
      ),
    ).rejects.toThrow(/plan\.yaml に第5話がありません/);
  });

  it('VELUM_STORY_MODEL を日本語版と英語版の両方の呼び出しへ渡す', async () => {
    const root = makeRoot();
    seed(root, { count: 1 });
    vi.stubEnv('VELUM_STORY_MODEL', '@cf/test/story-model');
    const { generate, calls } = goodWriter();

    await writeEpisodes({ characterId: 'riko', season: 1 }, deps(root, generate));
    expect(calls.map((call) => call.model)).toEqual(['@cf/test/story-model', '@cf/test/story-model']);
  });
});

/** 呼ばれたら失敗する、本文用の偽の生成。 */
function neverCalledWriter(): GenerateJson {
  return neverCalled();
}

describe('applyEpisodeWrite（純関数）', () => {
  const update = {
    title: { ja: '生成された題', en: 'Generated' },
    format: 'scene' as const,
    generation: { model: 'm', prompt_version: 'story-write-v1', generated_at: NOW },
  };

  it('draft に固め、題と形式は空いているときだけ埋め、生成の記録を置く', () => {
    const base = manifestOf(2, (manifest) => {
      manifest.episodes[1]!.title = { ja: '決まった題', en: 'Fixed' };
      manifest.episodes[1]!.format = 'letter';
    });
    const snapshot = structuredClone(base);

    const first = applyEpisodeWrite(base, 1, update);
    expect(first.demoted).toBe(false);
    expect(first.manifest.episodes[0]).toMatchObject({
      status: 'draft',
      title: update.title,
      format: 'scene',
      generation: update.generation,
    });

    const second = applyEpisodeWrite(base, 2, update);
    expect(second.manifest.episodes[1]).toMatchObject({
      title: { ja: '決まった題', en: 'Fixed' },
      format: 'letter',
    });
    // 入力は書き換えない
    expect(base).toEqual(snapshot);
  });

  it('reviewed は draft へ戻し（demoted）、published は拒む', () => {
    const base = manifestOf(2, (manifest) => {
      manifest.status = 'published';
      manifest.episodes[0]!.status = 'published';
      manifest.episodes[0]!.title = { ja: '一', en: 'One' };
      manifest.episodes[1]!.status = 'reviewed';
      manifest.episodes[1]!.title = { ja: '二', en: 'Two' };
    });
    expect(applyEpisodeWrite(base, 2, update)).toMatchObject({ demoted: true });
    expect(applyEpisodeWrite(base, 2, update).manifest.episodes[1]!.status).toBe('draft');
    expect(() => applyEpisodeWrite(base, 1, update)).toThrow(/published/);
    expect(() => applyEpisodeWrite(base, 9, update)).toThrow(/第9話/);
  });
});

// ── ゲート ─────────────────────────────────────────────────

describe('構造ゲート', () => {
  const profile = readYaml(charPath('riko', 'profile.yaml'), ProfileSchema);
  const secret = secretSegments(profile.core.secret_unknown_to_self)[0]!;
  const L = STORY_WRITE_LIMITS;
  const context: StoryContext = riko;

  describe('日本語版', () => {
    const base = { title_ja: 'ミオは何も買わない', body_ja: jaBody() };

    it('正しい応答を通し、本文を正規形に整えて返す', () => {
      const verdict = gateEpisodeJa({
        title_ja: ' 題 ',
        body_ja: `\n\n${jaBody(2)}   \n\n\n\n${jaBody(2)}\n`,
      });
      expect(verdict.ok).toBe(true);
      if (!verdict.ok) return;
      expect(verdict.response.title_ja).toBe('題');
      expect(verdict.response.body_ja).toBe(`${jaBody(2)}\n\n${jaBody(2)}`);
    });

    it('長さの上限と下限（文字数）', () => {
      const short = gateEpisodeJa({ ...base, body_ja: 'みじかい。' });
      expect(short.ok).toBe(false);
      const long = gateEpisodeJa({ ...base, body_ja: 'あ'.repeat(L.bodyJaMaxChars + 1) });
      expect(!long.ok && long.violations.join('\n')).toContain(`上限 ${L.bodyJaMaxChars}`);
      expect(gateEpisodeJa({ ...base, body_ja: 'あ'.repeat(L.bodyJaMaxChars) }).ok).toBe(true);
      expect(gateEpisodeJa({ ...base, body_ja: 'あ'.repeat(L.bodyJaMinChars) }).ok).toBe(true);
      expect(gateEpisodeJa({ ...base, body_ja: 'あ'.repeat(L.bodyJaMinChars - 1) }).ok).toBe(false);
    });

    it('題の長さ・複数行・言語', () => {
      const tooLong = gateEpisodeJa({ ...base, title_ja: 'あ'.repeat(L.titleJaMaxChars + 1) });
      expect(!tooLong.ok && tooLong.violations.join('\n')).toContain(`上限 ${L.titleJaMaxChars}`);
      expect(gateEpisodeJa({ ...base, title_ja: 'あ'.repeat(L.titleJaMaxChars) }).ok).toBe(true);
      expect(gateEpisodeJa({ ...base, title_ja: '一行目\n二行目' }).ok).toBe(false);
      expect(gateEpisodeJa({ ...base, title_ja: 'Mio Never Buys Anything' }).ok).toBe(false);
      expect(gateEpisodeJa({ ...base, title_ja: '   ' }).ok).toBe(false);
    });

    it('Markdown・日本語でない本文・CR は破棄する（直さない）', () => {
      for (const body of [
        `# 見出し\n\n${jaBody()}`,
        `${jaBody()}\n\n**強調**`,
        `---\n${jaBody()}`,
        jaBody().replace(/\n\n/g, '\r\n\r\n'),
        `${EN_SENTENCE} `.repeat(60),
      ]) {
        expect(gateEpisodeJa({ ...base, body_ja: body }).ok, body.slice(0, 20)).toBe(false);
      }
    });

    it('題が固定のときは、捨てる題を検査しない', () => {
      const verdict = gateEpisodeJa(
        { title_ja: 'x'.repeat(100), body_ja: jaBody() },
        { titleFixed: true },
      );
      expect(verdict.ok).toBe(true);
    });

    it('本人も知らない真相を含む本文は、折り返されていても破棄する', () => {
      const wrapped = `${secret.slice(0, 5)}\n${secret.slice(5, 11)}\n\n${secret.slice(11)}`;
      for (const body of [`${jaBody()}\n\n${secret}`, `${jaBody()}\n\n${wrapped}`]) {
        const verdict = gateEpisodeJa({ ...base, body_ja: body });
        expect(verdict.ok).toBe(false);
        if (verdict.ok) continue;
        expect(verdict.violations.join('\n')).toContain('隠されている文（riko）の断片');
        // 断片そのものは、違反文へ書かない
        expect(verdict.violations.join('\n')).not.toContain(secret.slice(0, 8));
      }
    });
  });

  describe('英語版', () => {
    const base = { title_en: 'Mio Never Buys Anything', body_en: enBody() };

    it('正しい応答を通す', () => {
      expect(gateEpisodeEn(base).ok).toBe(true);
    });

    it('長さの上限と下限（語数）', () => {
      const word = 'word ';
      expect(gateEpisodeEn({ ...base, body_en: word.repeat(L.bodyEnMinWords - 1) }).ok).toBe(false);
      expect(gateEpisodeEn({ ...base, body_en: word.repeat(L.bodyEnMinWords) }).ok).toBe(true);
      expect(gateEpisodeEn({ ...base, body_en: word.repeat(L.bodyEnMaxWords) }).ok).toBe(true);
      const long = gateEpisodeEn({ ...base, body_en: word.repeat(L.bodyEnMaxWords + 1) });
      expect(!long.ok && long.violations.join('\n')).toContain(`上限 ${L.bodyEnMaxWords}`);
    });

    it('題は英語で、上限以内', () => {
      expect(gateEpisodeEn({ ...base, title_en: 'a'.repeat(L.titleEnMaxChars + 1) }).ok).toBe(false);
      expect(gateEpisodeEn({ ...base, title_en: 'a'.repeat(L.titleEnMaxChars) }).ok).toBe(true);
      expect(gateEpisodeEn({ ...base, title_en: 'Mio は何も買わない' }).ok).toBe(false);
    });

    it('英語の本文に日本語が混じれば破棄する', () => {
      const verdict = gateEpisodeEn({ ...base, body_en: `${enBody()}\n\n${JA_SENTENCE.repeat(3)}` });
      expect(verdict.ok).toBe(false);
    });
  });

  describe('計画', () => {
    it('正しい計画を通す', () => {
      expect(gatePlan(planResponse(8), context, 8).ok).toBe(true);
    });

    it('話数・形式・id・言語・題の長さを検査する', () => {
      const episodes = planResponse(3).episodes;
      const bad = gatePlan(
        planResponse(3, {
          title_en: 'タイトル',
          focus: [],
          episodes: [
            { ...episodes[0]!, format: 'diary' },
            { ...episodes[1]!, people: [MIO, MIO] },
            { ...episodes[2]!, working_title_ja: 'あ'.repeat(L.titleJaMaxChars + 1), purpose: 'English only.' },
          ],
        }),
        context,
        3,
      );
      expect(bad.ok).toBe(false);
      if (bad.ok) return;
      const text = bad.violations.join('\n');
      expect(text).toContain('季の題（英語） に日本語が混じっています');
      expect(text).toContain('focus が空です');
      expect(text).toContain('第1話の format「diary」が選択肢にない');
      expect(text).toContain('第2話の people に同じ id「mio」が2回ある');
      expect(text).toContain(`第3話の仮題（日本語） が ${L.titleJaMaxChars + 1} 文字です`);
      expect(text).toContain('第3話の purpose が日本語に見えません');
    });

    it('周りの人に無い id は、people にも focus にも書けない', () => {
      const verdict = gatePlan(planResponse(2, { focus: ['mio', 'lolo'] }), context, 2);
      expect(!verdict.ok && verdict.violations.join('\n')).toContain('focus の id「lolo」が「周りの人」にない');
      expect(GARON).not.toBe(MIO);
    });

    it('秘密の混入は、どの欄でも破棄する', () => {
      const episodes = planResponse(2).episodes;
      const verdict = gatePlan(
        planResponse(2, {
          episodes: [{ ...episodes[0]!, situation: `ある日、${secret}。` }, episodes[1]!],
        }),
        context,
        2,
      );
      expect(!verdict.ok && verdict.violations.join('\n')).toContain('第1話の situation に、隠されている文');
    });
  });
});
