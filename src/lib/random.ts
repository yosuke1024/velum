/**
 * 日付から決まる乱数。
 *
 * 同じ日を再実行したら同じカードを引く。生成が失敗した日をやり直すとき、
 * カードまで変わってしまうと「その日に何が起きるはずだったか」が失われるため。
 */

function hash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32。分布の質は用途に十分で、実装が短く読める。 */
export function seededRandom(seed: string): () => number {
  let state = hash(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 重み付き抽選。weight が高いほど引かれやすい。 */
export function weightedPick<T extends { weight: number }>(
  items: readonly T[],
  random: () => number,
): T {
  if (items.length === 0) throw new Error('抽選対象が空です');
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let roll = random() * total;
  for (const item of items) {
    roll -= item.weight;
    if (roll <= 0) return item;
  }
  return items[items.length - 1] as T;
}

export function pick<T>(items: readonly T[], random: () => number): T {
  if (items.length === 0) throw new Error('抽選対象が空です');
  return items[Math.floor(random() * items.length)] as T;
}
