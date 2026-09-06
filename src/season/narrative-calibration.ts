import { seededRandom } from '../lib/random.js';

/**
 * Narrative Calibration — 季ごとに「物語上の許可」を2〜3個だけ配る。
 *
 * 季の計画は物語の形を作るための構造であり、それ自体は維持する。だが構造が毎季
 * 同じように効くと、5話は必ず一本の因果鎖になり、決着は必ず主人公の理解で閉じる。
 * 25日 × 5時代を何季も回したとき、崩れるのは1季の出来ではなく**全季が同じ形へ
 * 収束すること**のほうである。
 *
 * そこで、緩めてよい箇所を小さなカタログにして、季ごとに少数だけ選んで渡す。
 *
 * 三つの規律がある。
 *
 * 1. **チェックリストにしない。** 毎季すべて適用すると、カタログはただの別の
 *    テンプレートになる。「横道に逸れ、外部要因で決着し、関係がこじれ、回収しない
 *    小物が残る話」が毎季続けば、それは一本道と同じ退屈さである。
 * 2. **義務にしない。** 許可であって指示ではない。使わない季があってよい。
 * 3. **文章の後処理を足さない。** ここで扱うのは出来事の構造だけで、生成後の
 *    書き直しや「AIらしさ」の採点は行わない（docs/seasons.md §11）。
 *
 * 選択は seed から決まる。同じ季を作り直しても同じ許可が出る——イベントカードと
 * 同じ理由で、やり直したときに「その季がどういう季だったか」が変わっては困る。
 */

/** 1季に配る許可の数。少数であることがこの仕組みの本体である。 */
export const MOVES_PER_SEASON = { min: 2, max: 3 } as const;

/** 許可が効くかどうかを決める、季の材料の側の条件。 */
export type NarrativeSituation = {
  /** 主人公の周囲にいる人物の数。0 なら「他者が動かす」系の許可は出せない。 */
  peopleCount: number;
  /** 季のあいだに来る節目の数。暦が横から動かせるかどうか。 */
  observanceCount: number;
};

export type NarrativeMove = {
  id: string;
  /** 人間が計画を読むときの見出し。 */
  label: string;
  /** プロンプトへ出す一文。「〜してよい」の形で書く。禁止や義務にしない。 */
  permission: string;
  /**
   * この季の材料でその許可が意味を持つか。持たないなら選ばない——
   * 相手のいない摩擦や、節目のない暦の横槍を無理に発動させても、
   * モデルは辻褄合わせに人物を発明するだけである。
   */
  applies: (situation: NarrativeSituation) => boolean;
};

const always = () => true;
const needsOthers = (s: NarrativeSituation) => s.peopleCount > 0;
const needsOffstage = (s: NarrativeSituation) => s.peopleCount > 0 || s.observanceCount > 0;

/**
 * カタログ。**並び順は決定性の一部**なので、足すときは末尾に足す。
 * 途中へ挿すと、過去の季を作り直したときに別の許可が出る。
 */
export const NARRATIVE_MOVES: readonly NarrativeMove[] = [
  {
    id: 'causal_sidewind',
    label: '横から動く',
    permission:
      '5話のうち1話は、前の話の結果からではなく、暦・第三者・制度・主人公の見ていないところで進んでいた事情から動き出してよい。',
    applies: needsOffstage,
  },
  {
    id: 'external_driver',
    label: '外が決める',
    permission:
      '転機や決着を、主人公の選択だけで起こさなくてよい。他者の都合、制度の運用、間の悪い偶然が結果を決めてよい。',
    applies: needsOffstage,
  },
  {
    id: 'partial_resolution',
    label: '片はつくが、分からない',
    permission:
      '第5話は片がつくが、主人公が理解・納得・成長して締める必要はない。何が起きたのか分からないまま次の季へ渡してよい。',
    applies: always,
  },
  {
    id: 'delayed_recontextualization',
    label: '後から見え方が変わる',
    permission:
      'すでにある普通の情報（台帳の記載、誰かの予定、物の来歴）の一部を後の話で出し、前の出来事の見え方を変えてよい。' +
      'ただし、これで謎の答えや超常の実在を新たに確定させない——見え方が変わるだけで、真相は宙に浮いたままにする。',
    applies: always,
  },
  {
    id: 'texture_without_payoff',
    label: '回収しない',
    permission:
      '後で回収しない小さな出来事・会話・物を、季のどこかに1つ残してよい。伏線に見えなくてよい。',
    applies: always,
  },
  {
    id: 'relationship_friction',
    label: '和解しない',
    permission:
      '周囲の人物との関係を、理解や和解の方向だけへ動かさなくてよい。本筋と関係のない摩擦や、埋まらない距離が残ってよい。',
    applies: needsOthers,
  },
  {
    id: 'offstage_consequence',
    label: '見ていないところで起きる',
    permission:
      '重要な結果の一部が、主人公の見ていないところで起きてよい。主人公は後から、又聞きや痕跡でそれを知る。',
    applies: needsOthers,
  },
  {
    id: 'asymmetric_depth',
    label: '密度を揃えない',
    permission:
      '5話の密度を揃えなくてよい。ある話は深く長く、ある話は短く静かでよい。すべての話に山を作らない。',
    applies: always,
  },
];

const BY_ID = new Map(NARRATIVE_MOVES.map((move) => [move.id, move]));

/** 記録された id から許可を引く。知らない id は落とす（人間が YAML を直せるため）。 */
export function movesFromIds(ids: readonly string[]): NarrativeMove[] {
  return ids.map((id) => BY_ID.get(id)).filter((move): move is NarrativeMove => Boolean(move));
}

/** Fisher–Yates。順序そのものが seed から決まる必要があるので、sort は使わない。 */
function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j] as T, result[i] as T];
  }
  return result;
}

function sameSet(a: readonly NarrativeMove[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const ids = new Set(b);
  return a.every((move) => ids.has(move.id));
}

/**
 * この季に配る許可を選ぶ。
 *
 * 乱数は `${seed}:narrative` の**別の流れ**から引く。イベントカードと同じ流れを
 * 使うと、許可を1個足しただけで過去の季の引き札が変わる。カードの再現性は
 * 「その季に何が起きるはずだったか」を保つための約束なので、ここは分ける。
 */
export function selectNarrativeMoves(
  seed: string,
  situation: NarrativeSituation,
  previousIds: readonly string[] = [],
): NarrativeMove[] {
  const available = NARRATIVE_MOVES.filter((move) => move.applies(situation));
  if (available.length <= MOVES_PER_SEASON.min) return available.slice();

  const random = seededRandom(`${seed}:narrative`);
  const order = shuffled(available, random);
  const count = Math.min(
    available.length,
    random() < 0.5 ? MOVES_PER_SEASON.min : MOVES_PER_SEASON.max,
  );

  const chosen = order.slice(0, count);

  // 直前の季と丸ごと同じ集合になったら、1枠だけ入れ替える。同じ許可が続くこと自体は
  // 構わないが、二季続けて同一だと「この時代はそういう形」という別の型ができる。
  if (previousIds.length && sameSet(chosen, previousIds)) {
    const replacement = order.slice(count).find((move) => !previousIds.includes(move.id));
    if (replacement) chosen[chosen.length - 1] = replacement;
  }

  return chosen;
}
