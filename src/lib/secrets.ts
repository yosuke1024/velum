import { charPath } from './paths.js';
import { readYaml } from './storage.js';
import { ProfileSchema, RelationshipsSchema } from '../schemas/character.js';
import { CHARACTER_IDS } from '../schemas/world.js';

/**
 * 配布物に混じってはいけない文の一覧。
 *
 * 秘匿情報は3か所にある: `core.secret_hidden`・`core.secret_unknown_to_self`・
 * `relationships[].hidden_from_protagonist`。日記プロンプト・Persona Snapshot・
 * サイトの束・そして feed / World Appraisal Snapshot——守る境界は増えたが、
 * 守る対象の定義はここ1か所である。
 *
 * 照合は「全文一致」ではなく「文ごとの断片」で行う。全文だけを見ると、
 * 秘密の一文だけが漏れたときに素通りする。
 */

/** 照合に意味のある最小の長さ。これより短い断片はどこにでも現れる。 */
const MIN_NEEDLE = 8;

export function secretSegments(secret: string): string[] {
  return secret
    .split(/[\n。]/)
    .map((part) => part.trim())
    .filter((part) => [...part].length >= MIN_NEEDLE);
}

export function forbiddenSecretSegments(): Array<{ owner: string; segment: string }> {
  const out: Array<{ owner: string; segment: string }> = [];

  for (const id of CHARACTER_IDS) {
    const profile = readYaml(charPath(id, 'profile.yaml'), ProfileSchema);
    const relationships = readYaml(charPath(id, 'relationships.yaml'), RelationshipsSchema);

    for (const secret of [profile.core.secret_hidden, profile.core.secret_unknown_to_self]) {
      for (const segment of secretSegments(secret)) out.push({ owner: id, segment });
    }
    for (const person of relationships.people) {
      if (!person.hidden_from_protagonist) continue;
      for (const segment of secretSegments(person.hidden_from_protagonist)) {
        out.push({ owner: `${id}/${person.id}`, segment });
      }
    }
  }

  return out;
}

/**
 * 漏れの検査。空白を除いた上での部分一致で見る——YAML の折り返しや
 * JSON 整形で空白の入り方が変わっても、同じ文は同じ文である。
 */
export function secretLeaksIn(haystack: string): Array<{ owner: string; segment: string }> {
  const flattened = haystack.replace(/\s+/g, '');
  return forbiddenSecretSegments().filter(({ segment }) =>
    flattened.includes(segment.replace(/\s+/g, '')),
  );
}
