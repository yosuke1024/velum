/**
 * Astra の最終応答（manuscript.raw.md）から、題と本文を取り分ける。
 *
 * コードが原稿に対して自動でしてよいことは、次の3つだけ（docs/story-authoring.md §6）:
 *   1. 改行コードの正規化（CRLF / CR → LF）。ほかの空白・記号・語句は変えない
 *   2. 先頭の題を、明示的な書式のときだけ別の欄へ取り出す
 *   3. 保存と hash の計算
 * 元の最終応答（raw）は必ずそのまま残る。ここは raw を書き換えない。
 *
 * 題の取り出しの規則（最初の空でない行だけを見る）:
 *   - markdown_heading: `# 題` 〜 `###### 題`（末尾の # と空白は落とす）
 *   - bold:             行全体が `**題**`
 *   - label:            `タイトル：題` / `題名：題` / `題：題` / `Title: 題`（全角・半角のコロン）
 *   - bracketed:        行全体が `『題』`（その行の次が空行か、それが最後の行のとき）
 * どれにも当たらなければ title は null で、本文は削らない（推測で1行目を落とさない）。
 * そのときは warnings に「題を判定できない。確認すること」を入れる。
 *
 * 本文 = 題の行より後ろ（題が無ければ全体）から、先頭と末尾の空行（空白だけの行）を除いたもの。
 * 行の中の空白・空行の数・記号は変えない。
 *
 * 語句を失っていないことの保証（assertNoTextLost）: 空白（改行を含む）をすべて除いたとき、
 * 正規化後の raw は「取り除いた題の行（あれば）+ 本文」と一致しなければならない。つまり、題の行を除いて
 * 空白でない字を1つも失っていない（空白だけの行を落とすのは許される）。崩れていたら投げて、保存させない。
 * 「本文が raw の部分文字列か」だけを見る検査では足りない（題の行の分や、本文の途中の欠けを見逃す）。
 *
 * 長さ・書式・秘密の断片は**異常検知**として warnings に出すだけで、失敗にも修復にもしない:
 *   - 本文が SHORT_BODY_CHARS 字未満（出力の切断かもしれない）
 *   - storyBodyProblems(body, 'ja')（feed へ載せる前に直す必要のある書式。例: Markdown の記法）
 *   - 本文の外の注記らしい行（行頭が 解説 / あとがき / 補足 / 注： / 字数 / 文字数 / ※）
 *   - secretLeaksIn に当たる断片（作者用の秘密が本文に出ている。断片そのものは書かない）
 */

import { secretLeaksIn } from '../../lib/secrets.js';
import { storyBodyProblems } from '../body.js';

export const SHORT_BODY_CHARS = 1000;

export type TitleRule = 'markdown_heading' | 'bold' | 'label' | 'bracketed';

export type Manuscript = {
  /** 改行だけを正規化した raw */
  normalized: string;
  title: string | null;
  titleRule: TitleRule | null;
  body: string;
  /** 本文の文字数（コードポイント。空白・改行を含む） */
  bodyChars: number;
  warnings: string[];
};

export function normalizeNewlines(text: string): string {
  // CRLF を1つの改行として数える（`\r\n` を先に1つにまとめ、残った単独の CR を LF にする）。
  // U+0085 / U+2028 / U+2029 など LF 以外の行区切りには触れない。
  return text.replace(/\r\n?/g, '\n');
}

/** 空白（改行を含む）をすべて除く。`\s` は String.prototype.trim と同じ範囲なので、空行の判定（isBlankLine）と一致する。 */
const withoutWhitespace = (text: string): string => text.replace(/\s+/gu, '');

/**
 * 題と本文の取り分けで、空白でない字を1つも失っていないことを確かめる（失っていれば投げる）。
 * 空白を除いた normalized が、removedTitleLine（取り除いた題の行。無ければ空文字）+ body と一致すること。
 * 文面には失った語句も本文も書かない（原稿の断片をエラー出力へ出さない）。
 */
export function assertNoTextLost(normalized: string, removedTitleLine: string, body: string): void {
  if (withoutWhitespace(normalized) !== withoutWhitespace(removedTitleLine) + withoutWhitespace(body)) {
    throw new Error(
      '内部エラー: 題と本文の取り分けで、空白でない字が合わなくなった（語句を失った、または重複した可能性）。保存しない',
    );
  }
}

export type ManuscriptOptions = {
  /** 秘密の断片の照合（既定は src/lib/secrets.ts の secretLeaksIn）。テストで差し替える */
  secretLeaks?: (text: string) => Array<{ owner: string }>;
};

/** 空白だけの行（空行を含む）。全角空白・タブも空白として扱う。 */
function isBlankLine(line: string): boolean {
  return line.trim() === '';
}

type TitleMatch = { title: string; rule: TitleRule };

// 題の書式。どれも「行頭から始まる」ことを要求する。字下げのある行は本文の段落（会話文の
// 『…』など）であることが多く、題と取り違えると本文の語句を失うため。行末の空白だけは許す。
const MARKDOWN_HEADING = /^#{1,6}\s+(.*)$/su;
const BOLD_TITLE = /^\*\*((?:(?!\*\*).)+)\*\*\s*$/su;
const LABELED_TITLE = /^(?:タイトル|題名|題|Title)[：:]\s*(\S.*?)\s*$/isu;
const BRACKETED_TITLE = /^『([^『』]+)』\s*$/u;

/**
 * 最初の空でない行（lines[index]）が、明示的な題の書式かを調べる。
 * 題の中身が空になるもの（`# ` や `****` など）は題として取らない。
 */
function detectTitle(lines: readonly string[], index: number): TitleMatch | null {
  const line = lines[index] ?? '';

  const heading = MARKDOWN_HEADING.exec(line);
  if (heading) {
    // 末尾の # と空白は題に含めない（`## 題 ##` → `題`）。
    const title = (heading[1] ?? '').replace(/[\s#]+$/u, '');
    return title === '' ? null : { title, rule: 'markdown_heading' };
  }

  const bold = BOLD_TITLE.exec(line);
  if (bold) {
    const title = (bold[1] ?? '').trim();
    return title === '' ? null : { title, rule: 'bold' };
  }

  const label = LABELED_TITLE.exec(line);
  if (label) {
    const title = label[1] ?? '';
    return title === '' ? null : { title, rule: 'label' };
  }

  const bracketed = BRACKETED_TITLE.exec(line);
  if (bracketed) {
    // 『…』 だけの行は、本文の最初の会話文でもありうる。題と見なすのは、次が空行か最後の行のときだけ。
    const next = lines[index + 1];
    if (next === undefined || isBlankLine(next)) {
      const title = (bracketed[1] ?? '').trim();
      return title === '' ? null : { title, rule: 'bracketed' };
    }
  }

  return null;
}

/** 先頭と末尾の空行（空白だけの行）を落とす。途中の空行と、各行の中の空白には触れない。 */
function trimBlankEdges(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && isBlankLine(lines[start] ?? '')) start += 1;
  while (end > start && isBlankLine(lines[end - 1] ?? '')) end -= 1;
  return lines.slice(start, end);
}

/** 本文の外の注記らしい行（解説・あとがき・字数の報告など）の行頭。字下げは許す。 */
const NOTE_LINE = /^[ \t　]*(?:解説|あとがき|補足|注[：:]|字数|文字数|※)/u;

/** 注記らしい行の、本文の中での行番号（1 始まり）。 */
function noteLineNumbers(body: string): number[] {
  const numbers: number[] = [];
  body.split('\n').forEach((line, index) => {
    if (NOTE_LINE.test(line)) numbers.push(index + 1);
  });
  return numbers;
}

/** warning に並べる行番号の上限。それ以上は件数だけを示す。 */
const NOTE_LINES_SHOWN = 5;

export function splitManuscript(raw: string, options: ManuscriptOptions = {}): Manuscript {
  const secretLeaks = options.secretLeaks ?? secretLeaksIn;

  const normalized = normalizeNewlines(raw);
  const lines = normalized.split('\n');

  // 見るのは最初の空でない行だけ。途中の見出しや、1行目の書式の無い文は題にしない。
  const firstContent = lines.findIndex((line) => !isBlankLine(line));
  const titleMatch = firstContent === -1 ? null : detectTitle(lines, firstContent);

  // 題があればその行より後ろ、無ければ全体。題が無いときに1行目を落とさない（推測しない）。
  const afterTitle = titleMatch === null ? lines : lines.slice(firstContent + 1);
  const body = trimBlankEdges(afterTitle).join('\n');

  // 取り除いたのは「題の行」と「先頭・末尾の空行」だけのはず。空白を除いたとき、normalized が
  // 「題の行 + 本文」と一致しなければ、空白でない字を失っている。起きないはずだが、起きたら保存させない。
  assertNoTextLost(normalized, titleMatch === null ? '' : (lines[firstContent] ?? ''), body);

  const bodyChars = [...body].length;
  const warnings: string[] = [];

  if (titleMatch === null) {
    warnings.push('題を判定できない（先頭の行が題の書式ではない。1行目は本文として残してある）。確認すること');
  }

  if (bodyChars < SHORT_BODY_CHARS) {
    warnings.push(
      `本文が ${bodyChars} 字しかない（${SHORT_BODY_CHARS} 字未満）。出力が途中で切れた可能性がある。確認すること`,
    );
  }

  for (const problem of storyBodyProblems(body, 'ja')) {
    warnings.push(`書式: ${problem}`);
  }

  const noteLines = noteLineNumbers(body);
  if (noteLines.length > 0) {
    const shown = noteLines.slice(0, NOTE_LINES_SHOWN).join(', ');
    const rest = noteLines.length > NOTE_LINES_SHOWN ? ` ほか ${noteLines.length - NOTE_LINES_SHOWN} 行` : '';
    warnings.push(
      `本文の外の注記らしい行がある（本文の ${shown} 行目${rest}）。物語の本文ではない文が混じっていないか確認すること`,
    );
  }

  // 照合は題も含めた normalized 全体に当てる（本文は normalized の部分文字列なので、本文の断片は
  // 必ず拾える。題に秘密が混じったときも見逃さない）。断片そのものは warning に書かない。
  const owners = [...new Set(secretLeaks(normalized).map((leak) => leak.owner))];
  if (owners.length > 0) {
    warnings.push(
      `作者用の秘密の断片が原稿に出ている（所有者: ${owners.join(', ')}）。断片は表示しない。確認すること`,
    );
  }

  return {
    normalized,
    title: titleMatch?.title ?? null,
    titleRule: titleMatch?.rule ?? null,
    body,
    bodyChars,
    warnings,
  };
}
