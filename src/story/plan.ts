import { readFileSync, writeFileSync } from 'node:fs';
import { isMap, isScalar, isSeq, parseDocument, type Document } from 'yaml';
import { generateJson } from '../lib/llm.js';
import { storyManifestPath, storyPlanPath } from '../lib/paths.js';
import { exists, writeYaml } from '../lib/storage.js';
import {
  StoryManifestSchema,
  StoryPlanSchema,
  STORY_EPISODE_LIMITS,
  storyEpisodeId,
  type StoriesConfig,
  type StoryManifest,
  type StoryPlan,
} from '../schemas/story.js';
import type { CharacterId } from '../schemas/world.js';
import { buildStoryContext, describeStoryContext } from './context.js';
import { gatePlan } from './gate.js';
import {
  buildStoryPlanSystemPrompt,
  buildStoryPlanUserPrompt,
  STORY_PLAN_PROMPT_VERSION,
  STORY_PLAN_RESPONSE_SCHEMA,
  StoryPlanResponseSchema,
} from './prompt.js';

/**
 * 季の計画（story:plan）。
 *
 * 生成するのは plan.yaml——人間が読んで直す内部ファイルで、公開物ではない。
 * 構造（order・id・required_progress・状態）はモデルに任せずコードが刻む。モデルが返すのは
 * 「各話の目的・場面の種・形式・出る人・仮題」だけで、並び順は応答の並びで決まる
 * （旧 Season Plan が beat の並びをコードで決めたのと同じ理由）。
 *
 * 計画のあと、台帳（manifest.yaml）を**足すだけ**で揃える（syncManifest）。
 * 人間が台帳に書いたもの——状態・unlock 条件・題・形式——は、どの場合も書き換えない。
 * 計画の形式（format）と仮題（working_title）は台帳へ写さない。plan.yaml は本文を書くまでの
 * 直せる計画で、台帳の題・形式は「決まったこと」を置く場所——自動で埋めると、plan.yaml を直しても
 * 台帳の値が優先されて黙って無視される（story:write が決める。src/story/write.ts）。
 *
 * **生成 ≠ 公開。** ここは status を draft 以上にしない。
 */

/** generateJson と同じ形。テストはここへ偽物を差し込み、ネットワークを使わずに回す。 */
export type GenerateJson = typeof generateJson;

export type StoryDeps = {
  generate?: GenerateJson;
  /** 記録に刻む現在時刻（ISO 8601）。生成物に混ざる唯一の「変わるもの」。 */
  now?: () => string;
  /** 台帳・計画・本文の置き場（既定はリポジトリ root）。テストは一時ディレクトリを渡す。 */
  root?: string;
  log?: (line: string) => void;
  warn?: (line: string) => void;
};

export type ResolvedDeps = Required<Omit<StoryDeps, 'root'>> & { root: string | undefined };

export function resolveDeps(deps: StoryDeps): ResolvedDeps {
  return {
    generate: deps.generate ?? generateJson,
    now: deps.now ?? (() => new Date().toISOString()),
    root: deps.root,
    log: deps.log ?? ((line) => console.log(line)),
    warn: deps.warn ?? ((line) => console.error(line)),
  };
}

/**
 * 物語の段だけに使うモデル。日記の VELUM_DIARY_MODEL（src/diary/generate.ts の diaryModel）と同じ作り。
 * 設定されていればそれを使い、無ければ generateJson の既定（VELUM_MODEL → プロバイダの既定）に落ちる。
 * story.yml は repo variable から渡すので、未設定なら空文字が来る——空は「未設定」として扱う。
 * 計画と本文の両方がこれを読む。使ったモデルは plan.yaml / manifest の generation.model に残る。
 */
export function storyModel(): string | undefined {
  const model = process.env.VELUM_STORY_MODEL?.trim();
  return model ? model : undefined;
}

// ── 台帳の同期 ─────────────────────────────────────────────

export type ManifestSync = {
  manifest: StoryManifest;
  /** 何を足したか（人間が読む日本語。変更が無ければ空） */
  notes: string[];
  created: boolean;
};

/**
 * 計画に合わせて台帳を揃える。**足すだけ**の純関数。
 *
 * 台帳が無ければ作る（draft、各話は draft・階段の required_progress つき）。季の title だけは
 * スキーマの必須なので、計画の title を写す。各話の title / format は**写さない**
 * （draft の話は、どちらも無くてよい）。
 * あれば、人間が書いたものは決して変えない:
 *
 *   - 季の id / title / summary / status、既存の話の status / required_progress / title /
 *     summary / format / generation は、そのまま。title / format が無い話も、空のまま残す。
 *   - 計画にあって台帳に無い話は、title / format 無しの draft で末尾へ足す。required_progress は
 *     stories.yaml の階段から取るが、前の話の値を下回らない（人間が階段を直していても、
 *     単調非減少の不変条件を壊さない）。
 *   - 台帳にあって計画に無い話は、消さずに残す（注意だけ出す）。
 *
 * 入力は書き換えない。
 */
export function syncManifest(
  existing: StoryManifest | null,
  plan: StoryPlan,
  config: StoriesConfig,
): ManifestSync {
  if (existing && existing.id !== plan.id) {
    throw new Error(`台帳（${existing.id}）と計画（${plan.id}）の季が違います`);
  }
  plan.episodes.forEach((episode, index) => {
    if (episode.order !== index + 1) {
      throw new Error(
        `plan の話番号が 1 から連続していません（${index + 1} 番目が第${episode.order}話）`,
      );
    }
  });

  const notes: string[] = [];
  const manifest: StoryManifest = existing
    ? structuredClone(existing)
    : {
        id: plan.id,
        character_id: plan.character_id,
        season: plan.season,
        title: { ...plan.title },
        status: 'draft',
        episodes: [],
      };

  for (const planned of plan.episodes) {
    const current = manifest.episodes[planned.order - 1];

    // 既存の話は触らない（title / format が無くても、計画で埋めない）。
    if (current) continue;

    const previous = manifest.episodes[manifest.episodes.length - 1];
    const ladder = config.default_required_progress[planned.order - 1] ?? 0;
    const requiredProgress = Math.max(ladder, previous?.required_progress ?? 0);
    manifest.episodes.push({
      id: storyEpisodeId(plan.id, planned.order),
      order: planned.order,
      required_progress: requiredProgress,
      status: 'draft',
    });
    notes.push(
      `第${planned.order}話を draft で足した（required_progress ${requiredProgress}）`,
    );
  }

  if (manifest.episodes.length > plan.episodes.length) {
    notes.push(
      `台帳には第${plan.episodes.length + 1}〜${manifest.episodes.length}話があるが、計画には無い（台帳のまま残す）`,
    );
  }

  return { manifest, notes, created: existing === null };
}

// ── 台帳の書き出し ─────────────────────────────────────────

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 既存の YAML ノードへ、新しい値を差し込む。変わらない欄は触らないので、
 * 人間が書いたコメント・書式・引用符がそのまま残る。足りない欄は末尾へ足し、
 * 無くなった欄は消す。
 */
function mergeNode(doc: Document, current: unknown, next: unknown): unknown {
  if (isMap(current) && isPlainObject(next)) {
    for (const pair of [...current.items]) {
      const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
      if (!(key in next) || next[key] === undefined) current.delete(key);
    }
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined) continue;
      current.set(key, mergeNode(doc, current.get(key, true), value));
    }
    return current;
  }
  if (isSeq(current) && Array.isArray(next)) {
    next.forEach((value, index) => {
      if (index < current.items.length) {
        current.set(index, mergeNode(doc, current.items[index], value));
      } else {
        current.add(doc.createNode(value));
      }
    });
    while (current.items.length > next.length) current.delete(current.items.length - 1);
    return current;
  }
  if (isScalar(current) && !isPlainObject(next) && !Array.isArray(next)) {
    if (current.value !== next) current.value = next;
    return current;
  }
  return doc.createNode(next);
}

/**
 * 台帳を書く。ファイルがあれば、差分だけを既存の YAML へ差し込む。
 *
 * 台帳は人間が手で直す。先頭の説明コメントや、話ごとのメモを、story:plan / story:write が
 * 走るたびに失ってはいけない（単純に stringify し直すとコメントは全部消える）。
 * 内容が変わらなければ、ファイルには触れない。
 */
export function writeManifestFile(path: string, manifest: StoryManifest): void {
  if (!exists(path)) {
    writeYaml(path, manifest);
    return;
  }

  const doc = parseDocument(readFileSync(path, 'utf8'));
  if (doc.errors.length > 0) {
    throw new Error(`${path} を YAML として読めません: ${doc.errors[0]?.message ?? ''}`);
  }
  const before = JSON.stringify(doc.toJS());
  doc.contents = mergeNode(doc, doc.contents, manifest) as typeof doc.contents;
  // 意味が同じなら書かない（YAML の書式を整え直しただけの差分を、コミットに積まない）。
  if (JSON.stringify(doc.toJS()) === before) return;
  writeFileSync(path, doc.toString({ lineWidth: 0, defaultStringType: 'PLAIN' }), 'utf8');
}

// ── 計画する ───────────────────────────────────────────────

export type PlanStoryOptions = {
  characterId: CharacterId;
  season: number;
  /** 話数。省略すると stories.yaml の default_episode_count */
  episodes?: number;
  /** 計画済みでも作り直す */
  force?: boolean;
  /** プロンプトだけを出す（LLM を呼ばず、何も書かない） */
  dryRun?: boolean;
};

export type PlanOutcome =
  | { status: 'dry-run' }
  | { status: 'skipped'; reason: string }
  | { status: 'rejected'; violations: string[] }
  | {
      status: 'planned';
      plan: StoryPlan;
      manifest: StoryManifest;
      manifestCreated: boolean;
      notes: string[];
    };

export const PLAN_DRY_RUN_NOTICE = '--dry-run のため、計画は生成しません。';

export async function planStory(
  options: PlanStoryOptions,
  deps: StoryDeps = {},
): Promise<PlanOutcome> {
  const { generate, now, root, log, warn } = resolveDeps(deps);
  const { characterId, season } = options;

  const context = buildStoryContext(characterId, season, { root });
  const count = options.episodes ?? context.config.default_episode_count;
  if (
    !Number.isInteger(count) ||
    count < STORY_EPISODE_LIMITS.min ||
    count > STORY_EPISODE_LIMITS.max
  ) {
    throw new Error(
      `話数は ${STORY_EPISODE_LIMITS.min}〜${STORY_EPISODE_LIMITS.max} の整数で指定してください: ${count}`,
    );
  }

  const planFile = storyPlanPath(characterId, season, root);
  const manifestFile = storyManifestPath(characterId, season, root);

  log(`${context.profile.name} — ${context.seriesId} の計画（全 ${count} 話）`);
  for (const line of describeStoryContext(context)) log(`  ${line}`);

  const system = buildStoryPlanSystemPrompt(count);
  const user = buildStoryPlanUserPrompt(context, count);

  if (options.dryRun) {
    if (exists(planFile) && !options.force) {
      log(`\n  （plan.yaml はすでにあります。実際の実行では --force が無いと飛ばします）`);
    }
    log('\n===== system =====');
    log(system);
    log('\n===== user =====');
    log(user);
    log('');
    log(PLAN_DRY_RUN_NOTICE);
    return { status: 'dry-run' };
  }

  if (exists(planFile) && !options.force) {
    const reason = 'plan.yaml はすでにあります。作り直すには --force を付けてください';
    log(`\n  ${reason}`);
    return { status: 'skipped', reason };
  }

  const { data, model } = await generate(
    {
      system,
      user,
      responseSchema: STORY_PLAN_RESPONSE_SCHEMA,
      model: storyModel(),
    },
    StoryPlanResponseSchema,
  );

  const verdict = gatePlan(data, context, count);
  if (!verdict.ok) {
    warn('\n✗ 構造ゲートの違反により、この計画を破棄しました:');
    for (const violation of verdict.violations) warn(`    ${violation}`);
    warn('  plan.yaml も manifest.yaml も変更していません。もう一度実行すれば引き直せます。');
    return { status: 'rejected', violations: verdict.violations };
  }

  // 構造はコードが刻む。モデルの返した並び順が、そのまま第1話からの順になる。
  const response = verdict.response;
  const plan = StoryPlanSchema.parse({
    id: context.seriesId,
    character_id: characterId,
    season,
    title: { ja: response.title_ja.trim(), en: response.title_en.trim() },
    logline: response.logline.trim(),
    character_arc: {
      start: response.arc_start.trim(),
      emotional_change: response.arc_change.trim(),
      end: response.arc_end.trim(),
    },
    relationships: { focus: response.focus },
    episodes: response.episodes.map((episode, index) => ({
      order: index + 1,
      purpose: episode.purpose.trim(),
      situation: episode.situation.trim(),
      format: episode.format,
      people: episode.people,
      working_title: {
        ja: episode.working_title_ja.trim(),
        en: episode.working_title_en.trim(),
      },
    })),
    generation: { model, prompt_version: STORY_PLAN_PROMPT_VERSION, generated_at: now() },
  });

  const synced = syncManifest(context.manifest, plan, context.config);
  const manifest = StoryManifestSchema.parse(synced.manifest);

  // 台帳を先に書く。plan.yaml が先だと、台帳の書き込みが失敗したとき「計画済み」で飛ばされ、
  // 台帳が揃わないまま残る。台帳は足すだけなので、先に書いて計画が失敗しても再実行で収まる。
  writeManifestFile(manifestFile, manifest);
  writeYaml(planFile, plan);

  log(`\n  「${plan.title.ja}」（${plan.title.en}）`);
  log(`  ${plan.logline}`);
  for (const episode of plan.episodes) {
    log(`    第${episode.order}話 ${episode.format}「${episode.working_title.ja}」: ${episode.purpose}`);
  }
  log(`\n  plan.yaml を書きました。${synced.created ? 'manifest.yaml を作りました。' : 'manifest.yaml を揃えました。'}`);
  for (const note of synced.notes) log(`    ・${note}`);
  log('  走らせる前に読んで、直してよいものです。');

  return {
    status: 'planned',
    plan,
    manifest,
    manifestCreated: synced.created,
    notes: synced.notes,
  };
}
