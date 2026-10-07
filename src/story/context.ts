import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT,
  charPath,
  worldPath,
  storySeasonDir,
  storyManifestPath,
  storyPlanPath,
  storiesConfigPath,
} from '../lib/paths.js';
import { readYaml, exists } from '../lib/storage.js';
import { ja, oneLine } from '../lib/bilingual.js';
import {
  ProfileSchema,
  CanonSchema,
  RelationshipsSchema,
} from '../schemas/character.js';
import {
  ERA_IDS,
  ERA_PROTAGONIST,
  EraCanonFileSchema,
  ErasFileSchema,
  type CharacterId,
  type EraId,
} from '../schemas/world.js';
import {
  StoriesConfigSchema,
  StoryManifestSchema,
  StoryPlanSchema,
  storySeriesId,
  type StoriesConfig,
  type StoryManifest,
  type StoryPlan,
} from '../schemas/story.js';
import { visibleRelationships } from '../diary/context.js';

/**
 * Character Story を書くための材料（プロンプトへ渡す平らなデータ）。
 *
 * **本人が知らないことは、ここへ入れない。** この型のどこにも現れないものがある:
 *
 *   - core.secret_unknown_to_self        本人も知らない真相
 *   - relationships[].hidden_from_protagonist
 *   - relationships[].thread / trust / wariness   物語の都合のメタと数値
 *   - core.note / appeal_axis / reader_distance   設計メモ。人物の中身ではない
 *   - world/threads/*・current-state.yaml・memories.yaml   日記の実験が動かした層
 *
 * 型で担保し、さらに src/story/gate.ts が出来上がった文を照合する（二重に守る）。
 * Story は日記の実験とは切り離した、Base Persona だけの物語である——Persona Snapshot が
 * まだ進行度に追随しないので、人物が大きく変わる話は書かない（docs/stories.md）。
 *
 * profile.core.secret_hidden（本人は知っている）は渡す。ただしプロンプト側で
 * 「動機として使ってよいが、本文で説明したり明かしたりしない」と添える。
 */
export type StoryContext = {
  characterId: CharacterId;
  season: number;
  seriesId: string;
  era: { id: EraId; name: string };
  profile: {
    name: string;
    nameEn: string;
    role: string;
    age: number;
    wish: string;
    fear: string;
    contradiction: string;
    /** 本人だけが知っていること。動機として使ってよいが、本文では明かさない。 */
    secretHidden: string;
    voice: {
      firstPerson: string;
      register: string;
      tic: string;
      neverSays: string;
      closing: string;
    };
    /** 英語版を書くときの声。日本語の欄の訳ではなく、本人が英語で話すときの形。 */
    voiceEn: {
      firstPerson: string;
      tic: string;
      neverSays: string;
      closing: string;
    };
    humor: string;
    appraisal: { question: string; focus: string; bias: string };
    /** 定型が崩れる瞬間。季に1度まで。 */
    rareExpression: string;
  };
  /** 周りの人。trust / wariness / thread / hidden_from_protagonist は持たない。 */
  people: Array<{ id: string; name: string; nameEn: string; relation: string; summary: string }>;
  /** 人生の出来事（canon.yaml の formative_events だけ。日記が追記した facts は含めない） */
  formativeEvents: string[];
  /** 時代の固定事実（world/canon/<era>.yaml）と場所の名前 */
  canonFacts: string[];
  places: string[];
  /** 人間が書いた声の見本（tests/fixtures/voice/<id>.md）。無ければ null。 */
  voiceSample: string | null;
  /** 季の企画メモ（characters/<id>/stories/s<NN>/brief.md）。計画の段だけが使う。無ければ null。 */
  brief: string | null;
  config: StoriesConfig;
  /** 既存の台帳・計画（無ければ null）。人間が直したものが正。 */
  manifest: StoryManifest | null;
  plan: StoryPlan | null;
  /** 前の季の計画。同じ目的の回を繰り返さないために計画の段だけが読む。 */
  previousPlan: StoryPlan | null;
};

/** 時代の逆引き。ERA_PROTAGONIST が正で、profile.era との一致は validate が見る。 */
export function eraOf(characterId: CharacterId): EraId {
  const era = ERA_IDS.find((id) => ERA_PROTAGONIST[id] === characterId);
  if (!era) throw new Error(`人物 ${characterId} の時代が ERA_PROTAGONIST にありません`);
  return era;
}

/** 声の見本の置き場。テスト用の fixture だが、生成にとっては「基準」である。 */
export const voiceSamplePath = (characterId: string) =>
  join(ROOT, 'tests', 'fixtures', 'voice', `${characterId}.md`);

/** 季の企画メモ。人間が書く。paths.ts の台帳・計画と同じ季のディレクトリに置く。 */
export const storyBriefPath = (characterId: string, season: number, root: string = ROOT) =>
  join(storySeasonDir(characterId, season, root), 'brief.md');

function readOptionalText(path: string): string | null {
  if (!exists(path)) return null;
  const text = readFileSync(path, 'utf8').trim();
  return text.length > 0 ? text : null;
}

/**
 * 材料を集める。人物・時代のデータは常に実リポジトリ（ROOT）から読み、
 * 台帳・計画・企画メモだけ `root` から読む（テストでは一時ディレクトリへ向ける）。
 *
 * 台帳・計画が壊れていれば、ここで落とす（スキーマ違反のまま生成を進めない）。
 */
export function buildStoryContext(
  characterId: CharacterId,
  season: number,
  options: { root?: string } = {},
): StoryContext {
  const root = options.root ?? ROOT;
  const eraId = eraOf(characterId);

  const profile = readYaml(charPath(characterId, 'profile.yaml'), ProfileSchema);
  const canon = readYaml(charPath(characterId, 'canon.yaml'), CanonSchema);
  const relationships = readYaml(charPath(characterId, 'relationships.yaml'), RelationshipsSchema);

  const eras = readYaml(worldPath('canon/eras.yaml'), ErasFileSchema);
  const eraDef = eras.eras.find((era) => era.id === eraId);
  if (!eraDef) throw new Error(`時代 ${eraId} が eras.yaml にありません`);
  const eraCanon = readYaml(worldPath(`canon/${eraId}.yaml`), EraCanonFileSchema);

  // 関係の見えてよい部分だけを、日記と同じ関数で取り出す。trust / wariness はここで落とす。
  const names = new Map(relationships.people.map((person) => [person.id, person.name.en]));
  const people = visibleRelationships(relationships).map((person) => ({
    id: person.id,
    name: person.name,
    nameEn: names.get(person.id) ?? person.name,
    relation: person.relation,
    summary: person.summary,
  }));

  const manifestFile = storyManifestPath(characterId, season, root);
  const planFile = storyPlanPath(characterId, season, root);
  const previousPlanFile = storyPlanPath(characterId, season - 1, root);

  const manifest = exists(manifestFile) ? readYaml(manifestFile, StoryManifestSchema) : null;
  const plan = exists(planFile) ? readYaml(planFile, StoryPlanSchema) : null;
  const previousPlan =
    season > 1 && exists(previousPlanFile) ? readYaml(previousPlanFile, StoryPlanSchema) : null;

  return {
    characterId,
    season,
    seriesId: storySeriesId(characterId, season),
    era: { id: eraId, name: eraDef.name.ja },
    profile: {
      name: profile.name.ja,
      nameEn: profile.name.en,
      role: profile.role.ja,
      age: profile.age,
      wish: oneLine(profile.core.wish),
      fear: oneLine(profile.core.fear),
      contradiction: oneLine(profile.core.contradiction),
      secretHidden: oneLine(profile.core.secret_hidden),
      voice: {
        firstPerson: ja(profile.voice.first_person),
        register: oneLine(profile.voice.register),
        tic: ja(profile.voice.tic),
        neverSays: ja(profile.voice.never_says),
        closing: ja(profile.voice.closing),
      },
      voiceEn: {
        firstPerson: oneLine(profile.voice.first_person.en),
        tic: oneLine(profile.voice.tic.en),
        neverSays: oneLine(profile.voice.never_says.en),
        closing: oneLine(profile.voice.closing.en),
      },
      humor: ja(profile.appraisal.humor),
      appraisal: {
        question: ja(profile.appraisal.question),
        focus: oneLine(profile.appraisal.focus),
        bias: ja(profile.appraisal.bias),
      },
      rareExpression: oneLine(profile.rare_expression),
    },
    people,
    formativeEvents: canon.formative_events.map((event) => ja(event.fact)),
    canonFacts: eraCanon.fixed.map((fact) => oneLine(fact.fact)),
    places: (eraCanon.places ?? []).map((place) =>
      typeof place.name === 'string' ? place.name : place.name.ja,
    ),
    voiceSample: readOptionalText(voiceSamplePath(characterId)),
    brief: readOptionalText(storyBriefPath(characterId, season, root)),
    config: readYaml(storiesConfigPath(), StoriesConfigSchema),
    manifest,
    plan,
    previousPlan,
  };
}

/**
 * --dry-run が最初に出す要約。何を材料に読んだかが一目で分かるように。
 * 秘密を含む欄は出さない（ここに出るのは件数と有無だけ）。
 */
export function describeStoryContext(context: StoryContext): string[] {
  return [
    `人物: ${context.profile.name}（${context.characterId}）／ ${context.era.name}`,
    `周りの人: ${context.people.map((person) => `${person.name}（${person.id}）`).join('、')}`,
    `声の見本: ${context.voiceSample ? 'あり' : 'なし'} ／ 企画メモ: ${context.brief ? `あり（${[...context.brief].length} 文字）` : 'なし'}`,
    `台帳: ${context.manifest ? `あり（${context.manifest.episodes.length} 話）` : 'なし'} ／ 計画: ${context.plan ? `あり（${context.plan.episodes.length} 話）` : 'なし'}`,
  ];
}
