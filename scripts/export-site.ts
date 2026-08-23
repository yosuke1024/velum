#!/usr/bin/env tsx
/**
 * 公開サイトが読むデータを1枚の JSON へ書き出す。
 *
 *   npm run export                    dist/site.json へ
 *   npm run export -- --out <path>    書き出し先を指定
 *
 * サイト（pixapps-landing）は velum のディレクトリ構造も YAML も知らない。
 * 受け渡すのはこのファイルだけで、向こうはこれを HTML へ描画する。
 * 見た目と導線は向こうの仕事、事実はこちらの仕事。
 *
 * **本人が知らないことは入らない**（src/export/bundle.ts）。
 */

import { join } from 'node:path';
import { ROOT } from '../src/lib/paths.js';
import { writeJson } from '../src/lib/storage.js';
import { buildBundle } from '../src/export/bundle.js';

const args = process.argv.slice(2);
const outArg = args.find((a) => a.startsWith('--out='))?.split('=')[1];
const out = outArg ?? join(ROOT, 'dist', 'site.json');

const bundle = buildBundle(new Date().toISOString());
writeJson(out, bundle);

const withBody = bundle.entries.filter((e) => e.body.ja).length;
console.log(`✓ ${out.replace(ROOT, '')}`);
console.log(
  `  時代 ${bundle.eras.length} / 人物 ${bundle.characters.length} / ` +
    `日記 ${bundle.entries.length}本（本文あり ${withBody}） / ` +
    `欠けた日 ${bundle.failures.length} / 季 ${bundle.seasons.length}`,
);
if (bundle.entries.length === 0) {
  console.log(`  日記はまだ1本もありません。稼働開始は ${bundle.start_date}。`);
}
