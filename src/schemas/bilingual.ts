import { z } from 'zod';

/**
 * 二言語の一文。サイトは 1言語 = 1 URL で、`/velum/en/` は英語しか出さない場所
 * である。読み出し側の作法は `src/lib/bilingual.ts` に書いてある。
 */
export const Bilingual = z.object({
  ja: z.string().min(1),
  en: z.string().min(1),
});

/**
 * まだ訳されていないかもしれない一文。
 *
 * 素の文字列は「未訳」であって「英語がある」ではない。読む側は必ず ja へ落とす
 * ので、英語ページには日本語が出る——無言で消すよりは見えているほうがよい。
 *
 * 手で書く固定層（profile / relationships / canon.formative_events）と、生成が
 * その場で両方書ける層（日記のタイトル・引用・気分）は `Bilingual` を必須にして、
 * 書いた時点で欠落が止まる形にしてある。ここが緩いのは、あとから訳す層だけ:
 *
 * - `canon.facts` — 日記の生成が1日1件まで追記する配列
 * - 季の計画の `title` / `shape` / `leaves_open` — 生成したあと人間が直すので、
 *   訳は直したあとに付ける（docs/seasons.md §10）
 */
export const MaybeBilingual = z.union([Bilingual, z.string().min(1)]);
