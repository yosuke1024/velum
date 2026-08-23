import { readdirSync, existsSync } from 'node:fs';
import { z } from 'zod';
import { generateJson } from '../lib/gemini.js';
import { charPath, snapshotDir, snapshotPath } from '../lib/paths.js';
import { writeJson, readYaml, exists } from '../lib/storage.js';
import { RelationshipsSchema } from '../schemas/character.js';
import { SNAPSHOT_SELECTION } from '../schemas/limits.js';
import { SnapshotSchema, SNAPSHOT_FILE, type Snapshot } from '../schemas/snapshot.js';
import {
  buildCompileContext,
  lifeFactsFrom,
  rememberedFrom,
  oneLine,
  type CompileContext,
} from './context.js';
import {
  buildSnapshotSystemPrompt,
  buildSnapshotUserPrompt,
  SNAPSHOT_RESPONSE_SCHEMA,
  SNAPSHOT_PROMPT_VERSION,
} from './prompt.js';
import { gateSnapshot } from './gate.js';
import { ja } from '../lib/bilingual.js';

const SnapshotResponseSchema = z.object({
  dispositions: z.array(z.string().min(1)),
});

export type CompileOutcome =
  | { ok: true; snapshot: Snapshot; path: string }
  | { ok: false; violations: string[] };

/** 既に置かれている Snapshot のバージョン。小さい順。 */
export function existingVersions(id: string): number[] {
  const dir = snapshotDir(id);
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .map((file) => SNAPSHOT_FILE.exec(file)?.[1])
    .filter((match): match is string => match !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

export function nextVersion(id: string): number {
  const versions = existingVersions(id);
  return (versions.at(-1) ?? 0) + 1;
}

/**
 * 決定的に決まる部分を組み立てる。
 *
 * Snapshot のほとんどはここで決まる——profile・canon・current-state・memories の
 * 射影であって、生成の産物ではない。生成を経るのは dispositions だけである。
 * 圧縮が必要なのがそこだけだからで、必要のないところまで生成に通せば、
 * 動かないはずの人格の芯が回すたびに揺れる。
 */
export function assemble(
  context: CompileContext,
  version: number,
  dispositions: string[],
  generation: { model: string; compiled_at: string },
): Snapshot {
  const { profile, state, era } = context;

  return SnapshotSchema.parse({
    version,
    character: profile.id,
    era: profile.era,
    compiled_at: generation.compiled_at,

    source: {
      diaries: context.diaries.count,
      through: context.diaries.through,
      memories: context.memories.memories.length,
      model: generation.model,
      prompt_version: SNAPSHOT_PROMPT_VERSION,
    },

    identity: {
      name: profile.name,
      age: profile.age,
      role: profile.role,
      affiliation: profile.affiliation,
      ...(profile.designation ? { designation: profile.designation } : {}),
    },

    voice: {
      first_person: ja(profile.voice.first_person),
      register: oneLine(profile.voice.register),
      tic: ja(profile.voice.tic),
      never_says: ja(profile.voice.never_says),
      closing: ja(profile.voice.closing),
      rare_expression: oneLine(profile.rare_expression),
    },

    appraisal: {
      question: ja(profile.appraisal.question),
      focus: profile.appraisal.focus,
      bias: ja(profile.appraisal.bias),
      humor: ja(profile.appraisal.humor),
    },

    // 強い順。同点は YAML に書かれた順のまま（Array#sort は安定）。
    values: Object.entries(state.beliefs)
      .map(([belief, strength]) => ({ belief, strength }))
      .sort((a, b) => b.strength - a.strength),

    temperament: Object.entries(state.traits)
      .map(([trait, level]) => ({ trait, level }))
      .sort((a, b) => b.level - a.level),

    standing: {
      mood: state.mood,
      pursuing: state.immediate_goal,
      doubting: state.doubt,
      weighing: state.concerns.slice(-SNAPSHOT_SELECTION.standing).map(oneLine),
      unsettled: state.unresolved_thoughts
        .slice(-SNAPSHOT_SELECTION.standing)
        .map(oneLine),
      habits: state.habits.map(oneLine),
    },

    life_facts: lifeFactsFrom(context.canon),
    remembered: rememberedFrom(context.memories),
    dispositions,

    knowledge_boundary: {
      era: era.name.ja,
      years: era.years,
      familiar: era.assignment,
      note: '自分の時代より後を知らない。時代の外にある物は、知っている言葉に置き換えて読む。',
    },
  });
}

/**
 * Persona Snapshot を1本コンパイルする。
 *
 * 追記のみ。既存バージョンは上書きしない。ゲートに落ちたら何も書かない——
 * PixTale はバージョンを固定して読むので、こちらが1本書けなくても
 * 直近の安定版が使われ続ける。
 */
export async function compileSnapshot(id: string): Promise<CompileOutcome> {
  const context = buildCompileContext(id);

  const { data, model } = await generateJson(
    {
      system: buildSnapshotSystemPrompt(),
      user: buildSnapshotUserPrompt(context),
      responseSchema: SNAPSHOT_RESPONSE_SCHEMA,
    },
    SnapshotResponseSchema,
  );

  const version = nextVersion(id);
  const snapshot = assemble(context, version, data.dispositions.map(oneLine), {
    model,
    compiled_at: new Date().toISOString(),
  });

  // ゲートは、context が落としたものを、context 経由ではなくファイルから読んで照合する。
  // context を信じて照合すれば、context が壊れた日に照合も一緒に壊れる。
  const relationships = readYaml(
    charPath(id, 'relationships.yaml'),
    RelationshipsSchema,
  );
  const verdict = gateSnapshot(snapshot, context.profile, relationships);
  if (!verdict.ok) return { ok: false, violations: verdict.violations };

  const path = snapshotPath(id, version);
  if (exists(path)) {
    throw new Error(`${path} は既に存在します。Snapshot は上書きしません。`);
  }
  writeJson(path, snapshot);

  return { ok: true, snapshot, path };
}
