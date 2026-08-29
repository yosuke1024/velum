#!/usr/bin/env tsx
/**
 * PixTale アプリが読む feed を world/feed/ へ書き出す。
 *
 *   npm run export:feed               world/feed/ へ（日次 cron が呼ぶ）
 *   npm run export:feed -- --fixtures tests/fixtures/feed/ を作り直す（S5 の UI 開発用）
 *
 * 契約面は world/feed/ 配下だけ（pixapps 側 pixtale_v2_contracts.md §1）。
 * アプリはこのパス構造を raw GitHub の URL としてそのまま読むので、動かさない。
 *
 * **内容が変わらない日は、ファイルも動かない。** generated_at だけのために
 * 毎日コミットを積むと、raw の ETag が無意味に変わり、アプリの再検証が
 * 空振りし続ける。中身を比べて、同じなら書かない。
 *
 * --fixtures は同じビルダーで tests/fixtures/feed/ を再生成する。違いは
 * 日記だけ——実データの日記は 2026-09-01 まで存在しないので、fixture には
 * 手書きのダミー日記（entries/ に置いた JSON）をそのまま使う。
 */

import { readFileSync, existsSync, readdirSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ROOT, feedDir, feedPortraitPath } from '../src/lib/paths.js';
import { writeJson } from '../src/lib/storage.js';
import {
  buildCharactersFeed,
  buildLoreFeed,
  collectFeedEntryFiles,
  diaryFeedFrom,
} from '../src/export/feed.js';
import { FeedEntryFileSchema, type FeedEntryFile } from '../src/schemas/feed.js';
import { CHARACTER_IDS } from '../src/schemas/world.js';

const fixtures = process.argv.slice(2).includes('--fixtures');

/** fixture の根。この下に world/feed/ を镜す——アプリの base URL の根と同じ形。 */
const FIXTURE_ROOT = join(ROOT, 'tests', 'fixtures', 'feed');

const outDir = fixtures ? join(FIXTURE_ROOT, 'world', 'feed') : feedDir();

/** 内容が同じなら書かない。generated_at の違いは「変わった」と数えない。 */
function writeStable(path: string, value: unknown): 'unchanged' | 'written' {
  if (existsSync(path)) {
    try {
      const current = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      const strip = (v: unknown) =>
        JSON.stringify({ ...(v as Record<string, unknown>), generated_at: null });
      if (strip(current) === strip(value)) return 'unchanged';
    } catch {
      // 壊れたファイルは書き直す。
    }
  }
  writeJson(path, value);
  return 'written';
}

const now = new Date().toISOString();
const results: Array<[string, 'unchanged' | 'written']> = [];

// ── characters.json / lore.json ────────────────────────────────

results.push(['characters.json', writeStable(join(outDir, 'characters.json'), buildCharactersFeed(now))]);
results.push(['lore.json', writeStable(join(outDir, 'lore.json'), buildLoreFeed(now))]);

// ── diary.json と entries/ ─────────────────────────────────────

let entryFiles: FeedEntryFile[];

if (fixtures) {
  // fixture の日記はダミー（手書き）。entries/ にある JSON がそのまま素材である。
  const entriesDir = join(outDir, 'entries');
  entryFiles = existsSync(entriesDir)
    ? readdirSync(entriesDir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => FeedEntryFileSchema.parse(JSON.parse(readFileSync(join(entriesDir, f), 'utf8'))))
    : [];
} else {
  entryFiles = collectFeedEntryFiles();
  for (const file of entryFiles) {
    // 発行後は不変の建前だが、同じ素材から同じ内容を書き直すのは不変のうち。
    results.push([file.path, writeStable(join(ROOT, file.path), file)]);
  }
}

results.push(['diary.json', writeStable(join(outDir, 'diary.json'), diaryFeedFrom(entryFiles, now))]);

// ── portraits ──────────────────────────────────────────────────
// 派生は scripts/derive-portraits.ts の仕事。ここでは在庫だけ確かめる。
// fixture へは実物をそのまま複製する。

const missing: string[] = [];
for (const id of CHARACTER_IDS) {
  const source = feedPortraitPath(id);
  if (!existsSync(source)) {
    missing.push(id);
    continue;
  }
  if (fixtures) {
    const target = join(outDir, 'portraits', `${id}.png`);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
}

// ── 結果 ───────────────────────────────────────────────────────

const written = results.filter(([, r]) => r === 'written');
const label = fixtures ? 'tests/fixtures/feed' : 'world/feed';

if (written.length) {
  console.log(`✓ ${label} を更新しました（${written.length}/${results.length} ファイル）:`);
  for (const [name] of written) console.log(`  ${name}`);
} else {
  console.log(`✓ ${label} は最新です。変更はありません。`);
}
console.log(`  日記 ${entryFiles.length}本${fixtures ? '（ダミー）' : ''}`);

if (missing.length) {
  console.warn(`\n⚠ 肖像がありません: ${missing.join(', ')}`);
  console.warn('  characters.json が指す先が 404 になります。npm run portraits で派生を作ってください。');
  process.exitCode = 1;
}
