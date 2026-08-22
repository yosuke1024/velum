import { readFileSync } from 'node:fs';
import { charPath, worldPath } from '../lib/paths.js';
import { readYaml, listDatedFiles } from '../lib/storage.js';
import { ErasFileSchema, type EraId } from '../schemas/world.js';
import { SNAPSHOT_SELECTION } from '../schemas/limits.js';
import { loadCharacter, visibleRelationships } from '../diary/context.js';
import type {
  Profile,
  Canon,
  CurrentState,
  Memories,
} from '../schemas/character.js';

/**
 * Snapshot を組み立てる材料。
 *
 * **本人が知らないことは、ここへ入れない。**
 *
 * profile.core.secret_unknown_to_self と relationships[].hidden_from_protagonist は
 * この型のどこにも現れない。Snapshot は PixTale の Tale コメントへそのまま注入されるので、
 * ここへ混ぜれば、本人が知らないはずのことをその人物が語り出す。
 *
 * 日記の側（src/diary/context.ts）と同じ規律だが、守る対象が違う——
 * あちらはプロンプト、こちらは公開ファイルである。除外は型で担保し、
 * さらに src/compile/gate.ts が出来上がった Snapshot を照合する。
 *
 * secret_unknown_to_self の「結果として現れる着眼点」は入る。テオが
 * 「量産品にすら作り手の物語を視てしまう」ことは appraisal に書いてあり、
 * その正体が何であるかはどこにも書いていない。
 */
export type CompileContext = {
  profile: Profile;
  canon: Canon;
  state: CurrentState;
  memories: Memories;

  /** 時代の定義。知識境界を組み立てるために読む。 */
  era: {
    id: EraId;
    name: { ja: string; en: string };
    years: string;
    assignment: string;
  };

  /** 関係。hidden_from_protagonist を落としたもの。 */
  people: Array<{
    id: string;
    name: string;
    relation: string;
    trust: number;
    wariness: number;
    summary: string;
  }>;

  /** 何本の日記から圧縮したか。 */
  diaries: { count: number; through: string | null };
};

/** 書かれた日記の本数と、最新の日付。entries を数える（日記本文は読まない）。 */
export function diaryStats(id: string): { count: number; through: string | null } {
  const files = listDatedFiles(charPath(id, 'entries'), '.json');
  const last = files.at(-1);
  if (!last) return { count: 0, through: null };

  const entry = JSON.parse(readFileSync(last, 'utf8')) as { date?: string };
  return { count: files.length, through: entry.date ?? null };
}

export function buildCompileContext(id: string): CompileContext {
  const character = loadCharacter(id);
  const { profile } = character;

  const eras = readYaml(worldPath('canon/eras.yaml'), ErasFileSchema);
  const eraDef = eras.eras.find((e) => e.id === profile.era);
  if (!eraDef) throw new Error(`時代 ${profile.era} が eras.yaml にありません`);

  return {
    profile,
    canon: character.canon,
    state: character.state,
    memories: character.memories,
    era: {
      id: eraDef.id,
      name: eraDef.name,
      years: eraDef.years,
      assignment: eraDef.assignment,
    },
    people: visibleRelationships(character.relationships),
    diaries: diaryStats(id),
  };
}

/** importance の高い順。同点なら新しいものを先に。 */
export function rememberedFrom(memories: Memories) {
  return [...memories.memories]
    .sort(
      (a, b) =>
        b.importance - a.importance || b.formed_on.localeCompare(a.formed_on),
    )
    .slice(0, SNAPSHOT_SELECTION.memories)
    .map((memory) => ({
      summary: oneLine(memory.summary),
      weight: memory.importance,
      formed_on: memory.formed_on,
    }));
}

/**
 * 動かない人生の事実。
 * formative_events は必ず全部載せる——人生の土台であり、選別の対象ではない。
 * 日々追記された canon 事実は、新しいものから拾う。
 */
export function lifeFactsFrom(canon: Canon): string[] {
  return [
    ...canon.formative_events.map((event) => oneLine(event.fact)),
    ...canon.facts.slice(-SNAPSHOT_SELECTION.canonFacts).map((f) => oneLine(f.fact)),
  ];
}

/** YAML の複数行文字列を1行へ均す。JSON にすると改行がそのまま残るため。 */
export function oneLine(text: string): string {
  return text.trim().replace(/\s*\n\s*/g, ' ');
}
