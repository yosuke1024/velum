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

type SecretSegment = { owner: string; segment: string };

/**
 * 一覧は1プロセスで1度だけ組む。照合は配布ファイルと本文のたびに呼ばれ、
 * そのつど 5人ぶんの YAML を読み直すと validate が無駄に遅くなる。
 * 秘密は人間しか書き換えられず、1回の実行のあいだは動かない。
 */
let cached: SecretSegment[] | null = null;

export function forbiddenSecretSegments(): SecretSegment[] {
  cached ??= buildForbiddenSecretSegments();
  return cached;
}

function buildForbiddenSecretSegments(): SecretSegment[] {
  const out: SecretSegment[] = [];

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
export function secretLeaksIn(haystack: string): SecretSegment[] {
  const flattened = haystack.replace(/\s+/g, '');
  return forbiddenSecretSegments().filter(({ segment }) =>
    flattened.includes(segment.replace(/\s+/g, '')),
  );
}

/** JSON の中の文字列値を、入れ子ごと集める。 */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
}

/**
 * JSON として配る文字列の漏れの検査。
 *
 * 生のテキストへ secretLeaksIn を当てるだけでは足りない。JSON では本文中の改行が
 * 2文字（バックスラッシュと n）になって直列化されるので、秘密の一文が本文で
 * 折り返されていると、空白を除いた照合をすり抜ける。そこで、生のテキストに加えて、
 * **デコードした文字列値**（本物の改行に戻ったもの）も照合する。
 *
 * JSON として読めないテキストは、生のテキストの照合だけを返す。
 */
export function secretLeaksInJson(text: string): SecretSegment[] {
  const found = new Map<string, SecretSegment>();
  const remember = (leaks: SecretSegment[]) => {
    for (const leak of leaks) found.set(`${leak.owner}\u0000${leak.segment}`, leak);
  };

  remember(secretLeaksIn(text));

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [...found.values()];
  }
  const strings: string[] = [];
  collectStrings(parsed, strings);
  remember(secretLeaksIn(strings.join('\n')));

  return [...found.values()];
}
