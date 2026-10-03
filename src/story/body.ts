/**
 * Story 本文の書式。
 *
 * 本文はプレーンテキストで、段落は空行区切り。段落内の改行はそのまま行替えとして
 * 読まれる（会話の行を分けたいときに使ってよい）。PixTale の読み手は本文を
 * `white-space: pre-wrap` の段落として描くだけで、Markdown を解釈しない。
 * だから見出し・強調・コード・リンクの記法は、そのまま記号として画面に出てしまう。
 *
 * ここは validate（ソースと feed の両方）と story:write のゲートが同じものを読む。
 * 面白いかどうかは見ない——形が壊れていないかだけを見る。
 */

/** 本文の正規化。行末の空白を落とし、3つ以上続く改行を空行1つに詰め、前後を整える。 */
export function normalizeStoryBody(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t　]+$/u, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const KANA_OR_KANJI = /[぀-ヿ㐀-鿿]/gu;

/** 本文に含まれるかな・漢字の割合（空白を除いた文字数に対して）。 */
export function japaneseRatio(text: string): number {
  const visible = [...text.replace(/\s+/g, '')];
  if (visible.length === 0) return 0;
  const japanese = text.match(KANA_OR_KANJI)?.length ?? 0;
  return japanese / visible.length;
}

/**
 * 書式の問題を列挙する（空なら問題なし）。長さはここでは見ない——
 * 生成ゲートは STORY_WRITE_LIMITS で見るが、人間が書いた短い話を落とす理由は無い。
 */
export function storyBodyProblems(text: string, lang: 'ja' | 'en'): string[] {
  const problems: string[] = [];
  if (text.includes('\r')) problems.push('改行は LF だけにすること（CR が混じっている）');
  if (text.trim().length === 0) {
    problems.push('本文が空です');
    return problems;
  }
  if (/^\s*---\s*$/.test(text.trimStart().split('\n')[0] ?? '')) {
    problems.push('先頭の --- は front matter と誤読される。本文だけを書くこと');
  }
  if (/^#{1,6}\s/m.test(text)) problems.push('Markdown の見出し（#）は使わない');
  if (/\*\*|__/.test(text)) problems.push('Markdown の強調（** / __）は使わない');
  if (/`/.test(text)) problems.push('バッククォートは使わない');
  if (/\]\(/.test(text)) problems.push('Markdown のリンク記法は使わない');
  if (/<\/?[a-zA-Z][^>]*>/.test(text)) problems.push('HTML タグは使わない');

  const ratio = japaneseRatio(text);
  if (lang === 'ja' && ratio < 0.3) {
    problems.push(`日本語の本文に見えません（かな・漢字が ${Math.round(ratio * 100)}%）`);
  }
  if (lang === 'en' && ratio > 0.05) {
    problems.push(`英語の本文に日本語が混じっています（かな・漢字が ${Math.round(ratio * 100)}%）`);
  }
  return problems;
}
