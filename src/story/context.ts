import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../lib/paths.js';
import { readYaml } from '../lib/storage.js';
import { ja } from '../lib/bilingual.js';
import {
  ProfileSchema,
  CanonSchema,
  RelationshipsSchema,
  type Profile,
  type Canon,
} from '../schemas/character.js';
import { ErasFileSchema, EraCanonFileSchema, type CharacterId } from '../schemas/world.js';

/**
 * Story を書くために渡す、人物の材料（docs/stories.md §7）。
 *
 * 日記の context（src/diary/context.ts）と同じ境界を守る——**本人が知らないこと
 * （core.secret_unknown_to_self・relationships[].hidden_from_protagonist）は渡さない。**
 * Story は三人称で書いてもよいが、作家が本人の知らない秘密を知っていれば、
 * 本文がそれを匂わせはじめる。読者だけが行間から気づける構造は、ここで守る。
 *
 * 日次の状態（current-state.yaml・memories.yaml）は渡さない。Story は
 * 「この人物がどんな人か」を伝えるためのもので、Season 1 の日記で起きた
 * 出来事の続きではない。Base Persona を安定させる（docs/stories.md §8）。
 */
export type StoryPerson = {
  id: string;
  name: string;
  relation: string;
  /** 本人から見た関係の要約（内部文）。hidden_from_protagonist は含まない。 */
  summary: string;
};

export type StoryContext = {
  characterId: CharacterId;
  profile: Profile;
  canon: Canon;
  eraName: string;
  /** 時代の固定事実。Story はこれと矛盾させない。 */
  fixedFacts: string[];
  /** 場所・組織の名前（ja）。固有名詞は軽く使う。 */
  places: string[];
  people: StoryPerson[];
  /** tests/fixtures/voice/<id>.md。声の基準。無ければ null。 */
  voiceSample: string | null;
};

const asName = (name: { ja: string; en: string } | string): string =>
  typeof name === 'string' ? name : name.ja;

export function buildStoryContext(characterId: CharacterId, root: string = ROOT): StoryContext {
  const profile = readYaml(join(root, 'characters', characterId, 'profile.yaml'), ProfileSchema);
  const canon = readYaml(join(root, 'characters', characterId, 'canon.yaml'), CanonSchema);
  const relationships = readYaml(
    join(root, 'characters', characterId, 'relationships.yaml'),
    RelationshipsSchema,
  );
  const eras = readYaml(join(root, 'world', 'canon', 'eras.yaml'), ErasFileSchema).eras;
  const eraCanon = readYaml(join(root, 'world', 'canon', `${profile.era}.yaml`), EraCanonFileSchema);
  const era = eras.find((e) => e.id === profile.era);

  const voicePath = join(root, 'tests', 'fixtures', 'voice', `${characterId}.md`);

  return {
    characterId,
    profile,
    canon,
    eraName: era ? era.name.ja : profile.era,
    fixedFacts: eraCanon.fixed.map((f) => f.fact.trim().replace(/\s*\n\s*/g, '')),
    places: [
      ...(eraCanon.institutions ?? []).map((p) => asName(p.name)),
      ...(eraCanon.places ?? []).map((p) => asName(p.name)),
      ...(eraCanon.cities ?? []).map((p) => asName(p.name)),
    ],
    people: relationships.people.map((person) => ({
      id: person.id,
      name: person.name.ja,
      relation: ja(person.relation),
      summary: ja(person.summary),
    })),
    voiceSample: existsSync(voicePath) ? readFileSync(voicePath, 'utf8').trim() : null,
  };
}
