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
import type { Episode } from '../schemas/season.js';
import type { Turn } from '../lib/rotation.js';
import { ja } from '../lib/bilingual.js';

/** その日に書く材料。季の計画から取り出した1話ぶん。 */
export type Day = {
  date: string;
  turn: Turn;
  episode: Episode;
  /** 前の話が残したもの。物語の続きであることを本人に思い出させる。 */
  carriedOver: string | null;
  /** 世界の暦上の年。primordial は null。 */
  worldYear: number | null;
  /** 「今日の暦」。時代ごとの声で整形済み（src/lib/calendar.ts）。 */
  calendarLine: string;
};

export type DiaryContext = {
  profile: Profile;
  canon: Canon;
  state: CurrentState;
  relationships: Relationships;
  memories: Memories;
  day: Day;
  /** 直近の日記の要約。全文は渡さない。 */
  recentSummaries: string[];
  /**
   * 今日、定型を崩してよいか。直近 RARE_EXPRESSION.cooldownEntries 本の日記に崩れが
   * なければ true。省略時は true（呼び出し側が履歴を見ていないとき）。
   * プロンプトが可否を明示し、ゲートが同じ値で判定する——両者は必ず同じ値を読む。
   */
  rareExpressionAllowed?: boolean;
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
  day: Day,
  recentSummaries: string[] = [],
  rareExpressionAllowed = true,
): DiaryContext {
  return {
    ...loadCharacter(day.turn.protagonist),
    day,
    recentSummaries,
    rareExpressionAllowed,
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
    relation: ja(person.relation),
    trust: person.trust,
    wariness: person.wariness,
    summary: ja(person.summary),
  }));
}
