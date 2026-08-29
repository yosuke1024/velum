/**
 * 二言語の一文をどちら向きに読むか。
 *
 * サイトは 1言語 = 1 URL で、`/velum/en/` は英語しか出さない場所である。そこへ
 * 日本語が出るのは読み手に見える欠陥なので、固定層のフィールドはスキーマで
 * `{ ja, en }` を必須にしてある（`src/schemas/character.ts`）。
 *
 * いっぽう生成は日本語で回る——プロンプトも、日記の一次生成もすべて日本語なので、
 * 生成側の読み出しは `ja()` で日本語に落とす。英語が要るのはサイトへの書き出し
 * （`src/export/bundle.ts`）だけである。
 *
 * `canon.facts` だけは素の文字列も来る。日記の生成が1日1件まで追記する配列で、
 * 生成はまだ英語を出せないため。素の文字列は「未訳」であって「英語がある」では
 * ないので、`pick(x, 'en')` はそのとき日本語へ落ちる——英語ページに日本語が出る
 * ことになるが、無言で消すよりは見えているほうがよい。
 */

export type Bilingual = { ja: string; en: string };
export type MaybeBilingual = Bilingual | string;

const isBilingual = (value: MaybeBilingual): value is Bilingual =>
  typeof value === 'object' && value !== null && 'ja' in value;

/** YAML の複数行文字列を1行へ均す。JSON にすると改行がそのまま残るため。 */
export function oneLine(text: string): string {
  return text.trim().replace(/\s*\n\s*/g, ' ');
}

/** 日本語の文中に半角空白を作らないための文字クラス（和文の約物・仮名・漢字・全角）。 */
const CJK = '\\u3000-\\u303f\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uff00-\\uffef';

/**
 * 読み手に見せる文字列向けの1行化。
 *
 * YAML の折り返しは見た目の整形にすぎないが、`oneLine()` はそれを一律で
 * 半角空白に変換する。英語はそれで正しいいっぽう、日本語では「季節ごとに
 * 野営地を」のように文中へ空白が残り、読み手に見える欠陥になる。折り返しの
 * 両側がともに和文のときだけ、空白を入れずに繋ぐ。
 *
 * `oneLine()` 自体は変えない。あちらは発行済みの World Appraisal Snapshot
 * （`world/appraisal/v*.json`、発行後は書き換えない契約）も通っており、
 * 出力が変われば不変性を破ってしまう。読み手向けの feed だけがこちらを使う。
 */
export function oneLineForReaders(text: string): string {
  return text
    .trim()
    .replace(new RegExp(`(?<=[${CJK}])\\s*\\n\\s*(?=[${CJK}])`, 'g'), '')
    .replace(/\s*\n\s*/g, ' ');
}

/** 読み手向けに両方を1行へ均す。`both()` と同じく、訳が無ければ日本語へ落ちる。 */
export function bothForReaders(value: MaybeBilingual): Bilingual {
  const pair = isBilingual(value) ? value : { ja: value, en: value };
  return {
    ja: oneLineForReaders(pair.ja),
    en: oneLineForReaders(pair.en || pair.ja),
  };
}

/** 生成が読む向き。プロンプトは日本語で書かれているので、常に日本語へ落とす。 */
export function ja(value: MaybeBilingual): string {
  return oneLine(isBilingual(value) ? value.ja : value);
}

/** サイトが読む向き。訳が無ければ日本語へ落ちる（消さずに見せる）。 */
export function pick(value: MaybeBilingual, lang: 'ja' | 'en'): string {
  if (!isBilingual(value)) return oneLine(value);
  return oneLine(value[lang] || value.ja);
}

/** 両方を1行へ均して持ち回る。サイトへ書き出すときの形。 */
export function both(value: MaybeBilingual): Bilingual {
  return { ja: pick(value, 'ja'), en: pick(value, 'en') };
}

/** 未訳のまま英語ページへ出る一文か。検証が数えるために使う。 */
export function isUntranslated(value: MaybeBilingual): boolean {
  return !isBilingual(value);
}
