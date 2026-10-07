import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { charPath } from '../lib/paths.js';
import { listDatedFiles } from '../lib/storage.js';
import { DiaryEventSchema, type DiaryEvent } from '../schemas/diary.js';
import type {
  Canon,
  CurrentState,
  Memories,
  Relationships,
} from '../schemas/character.js';
import { PATCH_LIMITS } from '../schemas/limits.js';
import { loadCharacter } from './context.js';

/**
 * 過去の1日を、その日の時点の人物として書くための材料。
 *
 * 破棄された日をあとから補うとき（docs/diary.md §9）、いまの状態ファイルをそのまま
 * 渡すと、人物は「その日より後に起きたこと」を覚えたまま過去の日を書く。
 * ここでは、その日より後の events/ に残っている変化前の値（applied の from）を
 * 新しい順に戻して、その日の朝の状態を復元する。
 *
 * 記憶と人生の事実は、その日より前に得たものだけに絞る。日記の要約も同じ
 * （scripts/run-day.ts）。
 *
 * 復元は events/ だけを根拠にする。状態ファイルを人が手で直していれば、その差は
 * 戻らない。
 */

/** 日付つきのファイル名（YYYY-MM-DD.json）から日付を取る。 */
export const fileDate = (path: string): string => basename(path).slice(0, 10);

/** 懸念と考えの上限。trimWorkingSets（apply.ts）と同じ値。 */
const WORKING_SET_CAP = PATCH_LIMITS.newConcerns * 4;

/**
 * 懸念・考えのリストを、その日の朝の形へ戻す。
 *
 * 後の日に足されたものを除く。そのぶん古いものが上限に押し出されていたなら、
 * それより前の日に足されたものから拾い戻す（trimWorkingSets は古い順に落とす）。
 * 稼働開始時から持っていた項目が押し出されていた場合は、根拠が残っていないので戻らない。
 */
function rollBackWorkingSet(
  current: string[],
  addedLater: string[],
  addedEarlier: string[],
): string[] {
  const later = new Set(addedLater);
  const kept = current.filter((item) => !later.has(item));
  const trimmedAway = addedEarlier.filter((item) => !kept.includes(item) && !later.has(item));
  return [...trimmedAway, ...kept].slice(-WORKING_SET_CAP);
}

/**
 * 状態と関係を、指定した日の朝へ戻す。純粋関数。
 *
 * @param earlier その日より前の events（古い順）
 * @param later   その日より後の events（古い順）
 */
export function rollBack(
  current: { state: CurrentState; relationships: Relationships },
  earlier: DiaryEvent[],
  later: DiaryEvent[],
): { state: CurrentState; relationships: Relationships } {
  const state = structuredClone(current.state);
  const relationships = structuredClone(current.relationships);

  // 新しい日から順に「変化前」へ戻す。最後に戻すのがいちばん古い後日で、
  // その from がその日の朝の値になる。
  for (const event of [...later].reverse()) {
    const { applied } = event;
    state.mood = applied.mood[0];
    state.immediate_goal = applied.immediate_goal[0];
    state.doubt = applied.doubt[0];

    for (const change of applied.relationships) {
      const person = relationships.people.find((p) => p.id === change.id);
      if (!person) continue;
      person.trust = change.trust[0];
      person.wariness = change.wariness[0];
    }
    for (const change of applied.traits) {
      if (change.key in state.traits) state.traits[change.key] = change.from;
    }
    for (const change of applied.beliefs) {
      if (change.key in state.beliefs) state.beliefs[change.key] = change.from;
    }
    for (const change of applied.counters) {
      if (state.counters && change.key in state.counters) state.counters[change.key] = change.from;
    }
  }

  state.concerns = rollBackWorkingSet(
    state.concerns,
    later.flatMap((e) => e.applied.concerns_added),
    earlier.flatMap((e) => e.applied.concerns_added),
  );
  state.unresolved_thoughts = rollBackWorkingSet(
    state.unresolved_thoughts,
    later.flatMap((e) => e.applied.thoughts_added),
    earlier.flatMap((e) => e.applied.thoughts_added),
  );

  const previous = earlier.at(-1);
  state.updated_at = previous ? previous.date : state.updated_at;

  return { state, relationships };
}

/** その日より前に形になった記憶だけを残す。 */
export function memoriesBefore(memories: Memories, date: string): Memories {
  return {
    ...memories,
    memories: memories.memories.filter((memory) => memory.formed_on < date),
  };
}

/**
 * その日より前に加わった人生の事実だけを残す。
 * 人生を形づくった出来事（formative_events）と、日付のない事実は稼働前からあるので残す。
 */
export function canonBefore(canon: Canon, date: string): Canon {
  return {
    ...canon,
    facts: canon.facts.filter((fact) => !fact.added_on || fact.added_on < date),
  };
}

/** 主人公の events を、その日より前と後に分けて読む（その日自身は含まない）。 */
export function readEventsAround(
  id: string,
  date: string,
): { earlier: DiaryEvent[]; later: DiaryEvent[] } {
  const events = listDatedFiles(charPath(id, 'events'), '.json').map((path) =>
    DiaryEventSchema.parse(JSON.parse(readFileSync(path, 'utf8'))),
  );
  return {
    earlier: events.filter((event) => event.date < date),
    later: events.filter((event) => event.date > date),
  };
}

/** その日の朝の人物を読む。loadCharacter の過去版。 */
export function loadCharacterAsOf(id: string, date: string): ReturnType<typeof loadCharacter> {
  const now = loadCharacter(id);
  const { earlier, later } = readEventsAround(id, date);
  const { state, relationships } = rollBack(
    { state: now.state, relationships: now.relationships },
    earlier,
    later,
  );
  return {
    profile: now.profile,
    canon: canonBefore(now.canon, date),
    state,
    relationships,
    memories: memoriesBefore(now.memories, date),
  };
}
