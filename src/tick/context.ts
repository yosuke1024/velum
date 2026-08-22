import { readdirSync } from 'node:fs';
import { worldPath, charPath } from '../lib/paths.js';
import { readYaml } from '../lib/storage.js';
import { seededRandom, weightedPick, pick } from '../lib/random.js';
import {
  EraCanonFileSchema,
  ArcFileSchema,
  CardDeckFileSchema,
  ErasFileSchema,
  type EraId,
  type CharacterId,
} from '../schemas/world.js';
import {
  ProfileSchema,
  CurrentStateSchema,
  RelationshipsSchema,
} from '../schemas/character.js';

export type TickContext = {
  date: string;
  era: EraId;
  eraName: string;
  eraFocus: string;
  protagonist: CharacterId;
  seed: string;
  card: { id: string; prompt: string };
  arc: { id: string; name: string; premise: string };
  thread: { id: string; question: string } | null;
  canon: Array<{ id: string; fact: string }>;
  places: string[];
  people: Array<{ name: string; relation: string; summary: string }>;
  protagonistName: string;
  role: string;
  state: {
    mood: string;
    immediateGoal: string;
    doubt: string;
    concerns: string[];
    unresolvedThoughts: string[];
  };
};

/**
 * その日の World Tick を作るための材料を集める。
 *
 * 完全ランダムにはしない。アーク・未解決スレッド・現在状態・イベントカード・乱数を
 * 組み合わせる。カードは「その日に起きうることの種」であって出来事そのものではなく、
 * 引いたあとにアークと現在状態へ照らして具体化する。
 */
export function buildTickContext(
  date: string,
  era: EraId,
  protagonist: CharacterId,
): TickContext {
  const seed = `${date}:${era}`;
  const random = seededRandom(seed);

  const eras = readYaml(worldPath('canon/eras.yaml'), ErasFileSchema);
  const eraDef = eras.eras.find((e) => e.id === era);
  if (!eraDef) throw new Error(`時代 ${era} が eras.yaml にありません`);

  const deck = readYaml(worldPath(`cards/${era}.yaml`), CardDeckFileSchema);
  const card = weightedPick(deck.cards, random);

  const arcFile = readdirSync(worldPath('arcs'))
    .filter((f) => f.endsWith('.yaml'))
    .find((f) => f.startsWith(`${era}-`));
  if (!arcFile) throw new Error(`時代 ${era} のアークがありません`);
  const arc = readYaml(worldPath('arcs', arcFile), ArcFileSchema);

  // 未解決スレッドは毎回ひとつだけ引く。全部渡すと、その日の焦点がぼやける。
  const thread = arc.unresolved.length
    ? pick(arc.unresolved, random)
    : null;

  const canon = readYaml(worldPath(`canon/${era}.yaml`), EraCanonFileSchema);
  const profile = readYaml(charPath(protagonist, 'profile.yaml'), ProfileSchema);
  const state = readYaml(
    charPath(protagonist, 'current-state.yaml'),
    CurrentStateSchema,
  );
  const relationships = readYaml(
    charPath(protagonist, 'relationships.yaml'),
    RelationshipsSchema,
  );

  return {
    date,
    era,
    eraName: eraDef.name.ja,
    eraFocus: eraDef.focus,
    protagonist,
    seed,
    card: { id: card.id, prompt: card.prompt },
    arc: { id: arc.id, name: arc.name.ja, premise: arc.premise },
    thread: thread ? { id: thread.id, question: thread.question } : null,
    canon: canon.fixed,
    places: (canon.places ?? []).map((p) =>
      typeof p.name === 'string' ? p.name : p.name.ja,
    ),
    people: relationships.people.map((p) => ({
      name: p.name.ja,
      relation: p.relation,
      summary: p.summary,
    })),
    protagonistName: profile.name.ja,
    role: profile.role.ja,
    state: {
      mood: state.mood,
      immediateGoal: state.immediate_goal,
      doubt: state.doubt,
      concerns: state.concerns,
      unresolvedThoughts: state.unresolved_thoughts,
    },
  };
}
