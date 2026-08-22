import { readdirSync } from 'node:fs';
import { worldPath, charPath, seasonPath } from '../lib/paths.js';
import { readYaml, exists } from '../lib/storage.js';
import { seededRandom, weightedPick } from '../lib/random.js';
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
  CanonSchema,
} from '../schemas/character.js';
import { SeasonPlanSchema, EPISODES_PER_SEASON } from '../schemas/season.js';
import {
  clockFor,
  formatWorldDate,
  seasonOf,
  upcomingObservances,
} from '../lib/calendar.js';

export type SeasonContext = {
  season: number;
  era: EraId;
  eraName: string;
  protagonist: CharacterId;
  protagonistName: string;
  role: string;
  seed: string;
  arc: { id: string; name: string; premise: string };
  unresolved: Array<{ id: string; question: string }>;
  canon: Array<{ id: string; fact: string }>;
  places: string[];
  people: Array<{ name: string; relation: string; summary: string }>;
  formativeEvents: string[];
  state: {
    mood: string;
    immediateGoal: string;
    doubt: string;
    concerns: string[];
    unresolvedThoughts: string[];
  };
  /** 素材として引いたイベントカード。そのまま出来事にはしない。 */
  cards: Array<{ id: string; prompt: string }>;
  /** 前の季が残したもの。第1話の起点になる。 */
  carriedOver: string | null;
  /** 世界の暦。季の始まりの時点。 */
  clock: { year: number | null; month: number; day: number };
  calendarLine: string;
  upcoming: Array<{ name: string; inDays: number | null; note: string | null }>;
};

/**
 * 季の計画を立てるための材料を集める。
 *
 * 日ごとの生成と違い、ここでは未解決スレッドを全部渡す。
 * 5話ぶんの形を作るには、何が宙に浮いているかを一望する必要があるため。
 */
export function buildSeasonContext(
  season: number,
  era: EraId,
  protagonist: CharacterId,
): SeasonContext {
  const seed = `season-${season}:${era}`;
  const random = seededRandom(seed);

  const eras = readYaml(worldPath('canon/eras.yaml'), ErasFileSchema);
  const eraDef = eras.eras.find((e) => e.id === era);
  if (!eraDef) throw new Error(`時代 ${era} が eras.yaml にありません`);

  const arcFile = readdirSync(worldPath('arcs'))
    .filter((f) => f.endsWith('.yaml'))
    .find((f) => f.startsWith(`${era}-`));
  if (!arcFile) throw new Error(`時代 ${era} のアークがありません`);
  const arc = readYaml(worldPath('arcs', arcFile), ArcFileSchema);

  const deck = readYaml(worldPath(`cards/${era}.yaml`), CardDeckFileSchema);
  // 5話ぶんの素材として、重複を許さずに引く。
  const cards: Array<{ id: string; prompt: string }> = [];
  const drawn = new Set<string>();
  for (let attempt = 0; attempt < 40 && cards.length < EPISODES_PER_SEASON + 2; attempt += 1) {
    const card = weightedPick(deck.cards, random);
    if (drawn.has(card.id)) continue;
    drawn.add(card.id);
    cards.push({ id: card.id, prompt: card.prompt });
  }

  const canon = readYaml(worldPath(`canon/${era}.yaml`), EraCanonFileSchema);
  const profile = readYaml(charPath(protagonist, 'profile.yaml'), ProfileSchema);
  const characterCanon = readYaml(charPath(protagonist, 'canon.yaml'), CanonSchema);
  const state = readYaml(
    charPath(protagonist, 'current-state.yaml'),
    CurrentStateSchema,
  );
  const relationships = readYaml(
    charPath(protagonist, 'relationships.yaml'),
    RelationshipsSchema,
  );

  // 前の季の第5話が残したものを引き継ぐ。
  let carriedOver: string | null = null;
  if (season > 1) {
    const previous = seasonPath(season - 1, era);
    if (exists(previous)) {
      const plan = readYaml(previous, SeasonPlanSchema);
      carriedOver = plan.episodes[EPISODES_PER_SEASON - 1]?.leaves_open ?? null;
    }
  }

  const clock = clockFor(era);
  const upcoming = upcomingObservances(era, clock, 60);

  return {
    season,
    era,
    eraName: eraDef.name.ja,
    protagonist,
    protagonistName: profile.name.ja,
    role: profile.role.ja,
    seed,
    arc: { id: arc.id, name: arc.name.ja, premise: arc.premise },
    unresolved: arc.unresolved,
    canon: canon.fixed,
    places: (canon.places ?? []).map((p) =>
      typeof p.name === 'string' ? p.name : p.name.ja,
    ),
    people: relationships.people.map((p) => ({
      name: p.name.ja,
      relation: p.relation,
      summary: p.summary.trim().replace(/\n/g, ' '),
    })),
    formativeEvents: [
      ...characterCanon.formative_events.map((e) => e.fact.trim().replace(/\n/g, ' ')),
      ...characterCanon.facts.map((f) => f.fact.trim().replace(/\n/g, ' ')),
    ],
    state: {
      mood: state.mood,
      immediateGoal: state.immediate_goal,
      doubt: state.doubt,
      concerns: state.concerns,
      unresolvedThoughts: state.unresolved_thoughts,
    },
    cards,
    carriedOver,
    clock: { year: clock.year, month: clock.month, day: clock.day },
    calendarLine: `${formatWorldDate(clock.year, clock)}（${seasonOf(clock.month)}）`,
    upcoming: upcoming.map((o) => ({ name: o.name, inDays: o.inDays, note: o.note })),
  };
}
