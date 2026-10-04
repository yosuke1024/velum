/**
 * 改稿の差分（revision.diff）。人が「どこが変わったか」を見るためのもので、何かの判定には使わない。
 *
 * 行単位の unified diff（`--- a` / `+++ b` / `@@ -l,s +l,s @@`、文脈 context 行）。
 * 依存を足さないため、最長共通部分列（LCS）で自前に組む。日本語の本文は段落が1行になりがちなので、
 * 語単位で見たいときは `git diff --no-index --word-diff=color --word-diff-regex=.` を案内する。
 * 同じ内容なら空文字を返す。末尾の改行の有無は `\ No newline at end of file` で示す。
 */
export function unifiedDiff(
  a: string,
  b: string,
  labels: { a: string; b: string },
  context = 3,
): string {
  if (!Number.isInteger(context) || context < 0) {
    throw new RangeError(`context は 0 以上の整数にしてください: ${context}`);
  }
  const aLines = splitLines(a);
  const bLines = splitLines(b);
  const ops = editScript(aLines, bLines);
  const hunks = buildHunks(ops, context);
  if (hunks.length === 0) return '';

  const out: string[] = [`--- ${labels.a}`, `+++ ${labels.b}`];
  for (const hunk of hunks) {
    out.push(
      `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
    );
    for (const op of hunk.ops) {
      out.push(`${TAG[op.kind]}${op.text}`);
      // 改行で終わらない行（ファイルの最後の行だけがそうなり得る）の直後に印を付ける
      if (!op.terminated) out.push(NO_NEWLINE_MARK);
    }
  }
  return `${out.join('\n')}\n`;
}

const NO_NEWLINE_MARK = '\\ No newline at end of file';

type OpKind = 'equal' | 'delete' | 'insert';
const TAG: Record<OpKind, string> = { equal: ' ', delete: '-', insert: '+' };

/** 行。raw は終端の改行を含む元の文字列（比較の単位）。 */
interface Line {
  raw: string;
  /** 終端の改行を除いた本文 */
  text: string;
  /** 終端が改行か。false になり得るのはファイルの最後の行だけ */
  terminated: boolean;
}

interface Op {
  kind: OpKind;
  text: string;
  terminated: boolean;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  ops: Op[];
}

/**
 * 終端の改行を付けたまま行に割る。`x` と `x\n` は別の行として比べる（GNU diff と同じ）ので、
 * 末尾の改行の有無だけが違う2つは「同じ」にならず、差分に出る。空文字は 0 行。
 */
function splitLines(text: string): Line[] {
  const raws = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  return raws.map((raw) => {
    const terminated = raw.endsWith('\n');
    return { raw, text: terminated ? raw.slice(0, -1) : raw, terminated };
  });
}

/**
 * 最短の編集列（= LCS を残す削除と追加）を Myers の O(ND) 法で求める。
 * 先頭と末尾の共通部分は先に外す（改稿は大半の行が同じなので、探索が小さく済む）。
 * 変更の塊の中は「削除してから追加」の順に揃える（GNU diff の見慣れた並び）。
 */
function editScript(a: Line[], b: Line[]): Op[] {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix]?.raw === b[prefix]?.raw) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix]?.raw === b[b.length - 1 - suffix]?.raw
  ) {
    suffix++;
  }

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);

  const toOp = (kind: OpKind, line: Line): Op => ({
    kind,
    text: line.text,
    terminated: line.terminated,
  });
  const ops: Op[] = [];
  for (const line of a.slice(0, prefix)) ops.push(toOp('equal', line));
  ops.push(...orderChangeBlocks(myers(midA, midB)));
  for (const line of a.slice(a.length - suffix)) ops.push(toOp('equal', line));
  return ops;
}

/** 行を整数の ID にして（同じ raw は同じ ID）から Myers を走らせ、編集列を Op で返す。 */
function myers(a: Line[], b: Line[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];

  const ids = new Map<string, number>();
  const idOf = (line: Line): number => {
    const known = ids.get(line.raw);
    if (known !== undefined) return known;
    const id = ids.size;
    ids.set(line.raw, id);
    return id;
  };
  const aIds = a.map(idOf);
  const bIds = b.map(idOf);

  const max = n + m;
  // v[k + offset] = 対角線 k（x - y）上で届いた最も右の x
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] = d 手目を終えた時点の、対角線 -d..d の v（巻き戻しで使う）
  const trace: Int32Array[] = [];

  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number))) {
        x = v[offset + k + 1] as number; // 下へ（b の行を追加）
      } else {
        x = (v[offset + k - 1] as number) + 1; // 右へ（a の行を削除）
      }
      let y = x - k;
      while (x < n && y < m && aIds[x] === bIds[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) found = true;
    }
    trace.push(v.slice(offset - d, offset + d + 1));
  }
  if (!found) {
    // d は max まで回れば必ず終点に届く。ここへ来るのは実装の誤り。
    throw new Error('差分の計算が終点に届きませんでした（内部エラー）');
  }

  // 終点から巻き戻す
  const reversed: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d - 1] as Int32Array; // d-1 手目を終えた時点。添字は k + (d - 1)
    const at = (k: number): number => prev[k + (d - 1)] as number;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      reversed.push({ kind: 'equal', text: (a[x - 1] as Line).text, terminated: (a[x - 1] as Line).terminated });
      x--;
      y--;
    }
    if (x === prevX) {
      const line = b[y - 1] as Line;
      reversed.push({ kind: 'insert', text: line.text, terminated: line.terminated });
      y--;
    } else {
      const line = a[x - 1] as Line;
      reversed.push({ kind: 'delete', text: line.text, terminated: line.terminated });
      x--;
    }
  }
  // d = 0: 原点からの共通部分だけが残る
  while (x > 0 && y > 0) {
    reversed.push({ kind: 'equal', text: (a[x - 1] as Line).text, terminated: (a[x - 1] as Line).terminated });
    x--;
    y--;
  }
  return reversed.reverse();
}

/** 連続する変更（削除・追加）の塊ごとに、削除を先に・追加を後に並べ直す。 */
function orderChangeBlocks(ops: Op[]): Op[] {
  const out: Op[] = [];
  let i = 0;
  while (i < ops.length) {
    if ((ops[i] as Op).kind === 'equal') {
      out.push(ops[i] as Op);
      i++;
      continue;
    }
    const deletes: Op[] = [];
    const inserts: Op[] = [];
    while (i < ops.length && (ops[i] as Op).kind !== 'equal') {
      const op = ops[i] as Op;
      (op.kind === 'delete' ? deletes : inserts).push(op);
      i++;
    }
    out.push(...deletes, ...inserts);
  }
  return out;
}

/**
 * 編集列を hunk に割る。変更と変更の間の共通行が 2×context 以下なら、文脈が重なるので1つにまとめる。
 * 件数が 0 の側の開始行は「その直前の行番号」（GNU diff と同じ。ファイルの先頭なら 0）。
 */
function buildHunks(ops: Op[], context: number): Hunk[] {
  const changed: number[] = [];
  ops.forEach((op, i) => {
    if (op.kind !== 'equal') changed.push(i);
  });
  if (changed.length === 0) return [];

  // 変更の添字を、文脈が重なるものどうしでまとめる（[先頭の変更, 末尾の変更]）
  const groups: Array<[number, number]> = [];
  let first = changed[0] as number;
  let last = first;
  for (const index of changed.slice(1)) {
    if (index - last - 1 <= 2 * context) {
      last = index;
    } else {
      groups.push([first, last]);
      first = index;
      last = index;
    }
  }
  groups.push([first, last]);

  // 各 op の手前までに a / b を何行消費したか
  const aBefore: number[] = [];
  const bBefore: number[] = [];
  let aSeen = 0;
  let bSeen = 0;
  for (const op of ops) {
    aBefore.push(aSeen);
    bBefore.push(bSeen);
    if (op.kind !== 'insert') aSeen++;
    if (op.kind !== 'delete') bSeen++;
  }

  return groups.map(([firstChange, lastChange]) => {
    const start = Math.max(0, firstChange - context);
    const end = Math.min(ops.length - 1, lastChange + context);
    const slice = ops.slice(start, end + 1);
    const oldCount = slice.filter((op) => op.kind !== 'insert').length;
    const newCount = slice.filter((op) => op.kind !== 'delete').length;
    const aStart = aBefore[start] as number;
    const bStart = bBefore[start] as number;
    return {
      oldStart: oldCount === 0 ? aStart : aStart + 1,
      oldCount,
      newStart: newCount === 0 ? bStart : bStart + 1,
      newCount,
      ops: slice,
    };
  });
}
