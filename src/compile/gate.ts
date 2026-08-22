import { SNAPSHOT_LIMITS } from '../schemas/limits.js';
import type { Profile, Relationships } from '../schemas/character.js';
import type { Snapshot } from '../schemas/snapshot.js';

export type SnapshotGateResult =
  | { ok: true }
  | { ok: false; violations: string[] };

/** 照合に意味のある最小の長さ。これより短い断片はどこにでも現れる。 */
const MIN_NEEDLE = 8;

/**
 * Snapshot の構造ゲート。
 *
 * 日記のゲートと違い、切り詰め（truncate）がない。Snapshot の中身は
 * すべて PixTale の Tale コメントへ届くので、到達先の線引き（docs/diary.md §4）に従えば
 * 全項目が破棄である。切り詰めれば、上限を超えたぶんだけ人格が静かに欠けたものが
 * 「それらしく見える形」で PixTale へ流れる。
 *
 * 破棄しても失われるものはない。Snapshot は追記のみで、PixTale は
 * バージョンを固定して読む。生成が止まっても直近の安定版が使われ続ける。
 */
export function gateSnapshot(
  snapshot: Snapshot,
  profile: Profile,
  relationships: Relationships,
): SnapshotGateResult {
  const violations: string[] = [];

  // ── 癖の件数と長さ ──────────────────────────────────────
  if (snapshot.dispositions.length === 0) {
    violations.push('人生が残した癖が1件もない');
  }
  if (snapshot.dispositions.length > SNAPSHOT_LIMITS.dispositions) {
    violations.push(
      `癖が ${snapshot.dispositions.length} 件（上限 ${SNAPSHOT_LIMITS.dispositions}）`,
    );
  }
  for (const disposition of snapshot.dispositions) {
    const length = [...disposition].length;
    if (length > SNAPSHOT_LIMITS.dispositionMaxJa) {
      violations.push(
        `癖「${disposition.slice(0, 20)}…」が ${length} 文字（上限 ${SNAPSHOT_LIMITS.dispositionMaxJa}）`,
      );
    }
  }
  const unique = new Set(snapshot.dispositions);
  if (unique.size !== snapshot.dispositions.length) {
    violations.push('同じ癖が重複している');
  }

  // ── 関係者の名前 ────────────────────────────────────────
  // Tale コメントを読む側は、この人たちを誰ひとり知らない。
  // 「師匠に言われたとおり」と書かれても、読者には誰のことか分からない。
  for (const person of relationships.people) {
    for (const needle of nameNeedles(person.name)) {
      const hit = snapshot.dispositions.find((d) =>
        d.toLowerCase().includes(needle.toLowerCase()),
      );
      if (hit) {
        violations.push(`癖に関係者の名前が入っている（${needle}）:「${hit}」`);
        break;
      }
    }
  }

  // ── 本人が知らないこと ──────────────────────────────────
  // src/compile/context.ts は型の上でこれらを持たないので、通常は起こり得ない。
  // 起こるとすれば、あとから profile や relationships をまるごと流し込む変更が入ったときで、
  // そのとき壊れるのは CI ではなく、PixTale が語る人格である。だから出来上がりを照合する。
  const serialized = JSON.stringify(snapshot);
  const secrets = [
    { label: '本人も知らない秘密', text: profile.core.secret_unknown_to_self },
    ...relationships.people.flatMap((person) =>
      person.hidden_from_protagonist
        ? [
            {
              label: `${person.id} の隠された事実`,
              text: person.hidden_from_protagonist,
            },
          ]
        : [],
    ),
  ];

  for (const { label, text: secret } of secrets) {
    const leaked = segments(secret).find((segment) => serialized.includes(segment));
    if (leaked) {
      violations.push(`${label}が Snapshot に混ざっている:「${leaked}」`);
    }
  }

  return violations.length ? { ok: false, violations } : { ok: true };
}

/**
 * 照合する名前の形。
 *
 * ja 名の先頭のカタカナ列が呼び名である（「ヴァレン大鑑定官」→「ヴァレン」）。
 * 短い呼び名は他の語に紛れ込むことがあるが、その場合に起きるのは破棄であって漏れではない。
 * 破棄は見えるので、やり直せばよい。
 */
export function nameNeedles(name: { ja: string; en: string }): string[] {
  const needles = new Set<string>([name.ja, name.en]);

  const katakana = /^[゠-ヿ]+/.exec(name.ja)?.[0];
  if (katakana && [...katakana].length >= 2) needles.add(katakana);

  const first = name.en.split(/[\s,]+/)[0];
  if (first && first.length >= 3) needles.add(first);

  return [...needles];
}

/** 秘密の文章を、照合に使える断片へ割る。 */
function segments(secret: string): string[] {
  return secret
    .split(/[\n。]/)
    .map((part) => part.trim())
    .filter((part) => [...part].length >= MIN_NEEDLE);
}
