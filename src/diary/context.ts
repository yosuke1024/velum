import { charPath } from '../lib/paths.js';
import { readYaml } from '../lib/storage.js';
import {
  ProfileSchema,
  CanonSchema,
  CurrentStateSchema,
  RelationshipsSchema,
  MemoriesSchema,
  type Profile,
  type Canon,
  type CurrentState,
  type Relationships,
  type Memories,
} from '../schemas/character.js';
import type { Tick } from '../schemas/tick.js';

export type DiaryContext = {
  profile: Profile;
  canon: Canon;
  state: CurrentState;
  relationships: Relationships;
  memories: Memories;
  tick: Tick;
  /** 直近の日記の要約。全文は渡さない。 */
  recentSummaries: string[];
};

export function loadCharacter(id: string): {
  profile: Profile;
  canon: Canon;
  state: CurrentState;
  relationships: Relationships;
  memories: Memories;
} {
  return {
    profile: readYaml(charPath(id, 'profile.yaml'), ProfileSchema),
    canon: readYaml(charPath(id, 'canon.yaml'), CanonSchema),
    state: readYaml(charPath(id, 'current-state.yaml'), CurrentStateSchema),
    relationships: readYaml(
      charPath(id, 'relationships.yaml'),
      RelationshipsSchema,
    ),
    memories: readYaml(charPath(id, 'memories.yaml'), MemoriesSchema),
  };
}

export function buildDiaryContext(
  tick: Tick,
  recentSummaries: string[] = [],
): DiaryContext {
  return {
    ...loadCharacter(tick.protagonist),
    tick,
    recentSummaries,
  };
}

/**
 * 本人が知らない事実を取り除く。
 *
 * relationships の hidden_from_protagonist と core.secret_unknown_to_self は
 * プロンプトへ渡さない。渡せば、本人が知らないはずのことを語り始める。
 * 読者だけが行間から気づける構造は、モデルに秘密を教えないことで守られる。
 */
export function visibleRelationships(
  relationships: Relationships,
): Array<{
  id: string;
  name: string;
  relation: string;
  trust: number;
  wariness: number;
  summary: string;
}> {
  return relationships.people.map((person) => ({
    id: person.id,
    name: person.name.ja,
    relation: person.relation,
    trust: person.trust,
    wariness: person.wariness,
    summary: person.summary.trim().replace(/\n/g, ' '),
  }));
}
