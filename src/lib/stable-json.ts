import { existsSync, readFileSync } from 'node:fs';
import { writeJson } from './storage.js';

/**
 * 「内容が同じなら書かない」の比較。feed の書き出し（scripts/export-feed.ts）と、
 * 素材との食い違い検査（scripts/validate.ts・src/story/check.ts）が同じ物差しを使う。
 *
 * generated_at の違いは「変わった」と数えない。これだけのために毎日ファイルを
 * 書き換えると、raw の ETag が無意味に変わり、アプリの再検証が空振りし続ける。
 * 物差しが書き出しと検査で食い違うと、書き出した直後に validate が赤くなる——
 * だから比較はここ1か所に置く。
 *
 * 比べるのは最上位の generated_at だけ。入れ子の同名フィールドは内容として比べる。
 */

/** 最上位の generated_at を無視して、2つの JSON 値が同じ内容か。 */
export function sameIgnoringGeneratedAt(a: unknown, b: unknown): boolean {
  const strip = (value: unknown): string =>
    JSON.stringify({ ...(value as Record<string, unknown>), generated_at: null });
  return strip(a) === strip(b);
}

/** 内容が同じなら書かない。generated_at の違いは「変わった」と数えない。 */
export function writeStable(path: string, value: unknown): 'unchanged' | 'written' {
  if (existsSync(path)) {
    try {
      const current = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (sameIgnoringGeneratedAt(current, value)) return 'unchanged';
    } catch {
      // 壊れたファイルは書き直す。
    }
  }
  writeJson(path, value);
  return 'written';
}
