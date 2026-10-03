#!/usr/bin/env tsx
/**
 * PixTale アプリが読む feed を world/feed/ へ書き出す。
 *
 *   npm run export:feed                          world/feed/ へ
 *   npm run export:feed -- --allow-withdraw      公開済みの話を取り下げる書き出しを通す
 *   npm run export:feed -- --fixtures            tests/fixtures/feed/ を作り直す（PixTale の UI 開発用）
 *
 * 書き出すもの: characters.json・lore.json・diary.json と entries/、そして
 * Character Story の stories/（index.json と、published の季ごとの <series-id>.json）。
 * 契約面は world/feed/ 配下だけ（pixapps 側 pixtale_v2_contracts.md §1）。
 * アプリはこのパス構造を raw GitHub の URL としてそのまま読むので、動かさない。
 *
 * **日次 cron はこれを回さない。** 書き出しは手で行い、PR にコミットする。素材（人物・
 * canon・日記・stories のソース）を直して書き出し忘れても、validate が素材との食い違いを
 * 検出するので、feed が古いまま main に入ることはない。
 *
 * **内容が変わらないときは、ファイルも動かない。** generated_at だけのために
 * コミットを積むと、raw の ETag が無意味に変わり、アプリの再検証が空振りし続ける。
 * 中身を比べて、同じなら書かない。
 *
 * **公開済みの話は消さない（再ロック防止）。** いま world/feed/stories/ にある話が
 * 新しい書き出しから消えるなら、1ファイルも書かずに止まる。アプリで読み終えた話が
 * ロックに戻るのは、ソースの手違いか rebase の巻き戻りのことが多い。意図して取り下げる
 * ときだけ --allow-withdraw を付ける（警告を出して書く）。
 *
 * --fixtures は同じビルダーで tests/fixtures/feed/ を再生成する。違いは日記と stories
 * のソース——実データの日記は 2026-09-01 まで存在しないので、fixture には手書きの
 * ダミー日記（entries/ に置いた JSON）を使い、stories は tests/fixtures/stories/ の
 * ダミーの季（リコとテオ）を読む。
 */

import { readFileSync, existsSync, readdirSync, copyFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ROOT, feedDir, feedPortraitPath } from '../src/lib/paths.js';
import { writeStable } from '../src/lib/stable-json.js';
import {
  buildCharactersFeed,
  buildLoreFeed,
  collectFeedEntryFiles,
  diaryFeedFrom,
} from '../src/export/feed.js';
import {
  buildStoriesFeed,
  collectStorySources,
  isStorySeriesFileName,
  withdrawnEpisodeIds,
} from '../src/export/stories.js';
import { FeedEntryFileSchema, type FeedEntryFile } from '../src/schemas/feed.js';
import { CHARACTER_IDS } from '../src/schemas/world.js';

const args = process.argv.slice(2);
const fixtures = args.includes('--fixtures');
const allowWithdraw = args.includes('--allow-withdraw');

for (const arg of args) {
  if (arg !== '--fixtures' && arg !== '--allow-withdraw') {
    console.error(`✗ 不明な引数です: ${arg}（--fixtures / --allow-withdraw）`);
    process.exit(1);
  }
}

/** fixture の根。この下に world/feed/ を鏡写しにする——アプリの base URL の根と同じ形。 */
const FIXTURE_ROOT = join(ROOT, 'tests', 'fixtures', 'feed');
/** fixture の stories のソースの根。この下に characters/<id>/stories/ を置く。 */
const FIXTURE_STORIES_ROOT = join(ROOT, 'tests', 'fixtures', 'stories');

const outDir = fixtures ? join(FIXTURE_ROOT, 'world', 'feed') : feedDir();
const storiesOutDir = join(outDir, 'stories');

async function main(): Promise<void> {
  const now = new Date().toISOString();
  const results: Array<[string, 'unchanged' | 'written']> = [];
  const removed: string[] = [];

  // ── stories: 組み立てと再ロック防止（何かを書く前に済ませる）──────
  // 途中まで書いてから止まると、feed が半端な状態で残る。先に全部を組み、
  // 止めるべきならここで止める。

  const { index: storiesIndex, series: storySeries } = buildStoriesFeed(
    collectStorySources(fixtures ? FIXTURE_STORIES_ROOT : ROOT),
    now,
  );

  const withdrawn = withdrawnEpisodeIds(storiesOutDir, storySeries);
  if (withdrawn.length && !allowWithdraw) {
    console.error('\n✗ 公開済みの話が、この書き出しでは消えます。何も書かずに止めました:\n');
    for (const id of withdrawn) console.error(`  ${id}`);
    console.error('\n  アプリで読み終えた話がロックに戻ります。ソースの status が意図せず下がっていないか');
    console.error('  （または rebase で巻き戻っていないか）を確かめてください。');
    console.error('  取り下げが意図どおりなら --allow-withdraw を付けて再実行します。\n');
    process.exit(1);
  }

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

  // ── stories/ ───────────────────────────────────────────────────
  // index.json は公開が0本でも書く（`characters: {}`）。季ファイルは published の季だけ。

  results.push(['stories/index.json', writeStable(join(storiesOutDir, 'index.json'), storiesIndex)]);
  for (const series of storySeries) {
    results.push([
      `stories/${series.id}.json`,
      writeStable(join(storiesOutDir, `${series.id}.json`), series),
    ]);
  }

  // もう published でない季のファイルは消す。index.json と、季ファイルの名前に
  // 当たらないものには触れない。
  if (existsSync(storiesOutDir)) {
    const keep = new Set(storySeries.map((s) => `${s.id}.json`));
    for (const name of readdirSync(storiesOutDir).filter(isStorySeriesFileName).sort()) {
      if (keep.has(name)) continue;
      unlinkSync(join(storiesOutDir, name));
      removed.push(`stories/${name}`);
    }
  }

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

  if (written.length || removed.length) {
    console.log(`✓ ${label} を更新しました（${written.length}/${results.length} ファイル）:`);
    for (const [name] of written) console.log(`  ${name}`);
    for (const name of removed) console.log(`  ${name}（削除: もう公開していない季）`);
  } else {
    console.log(`✓ ${label} は最新です。変更はありません。`);
  }
  console.log(`  日記 ${entryFiles.length}本${fixtures ? '（ダミー）' : ''}`);
  const storyEpisodes = storySeries.reduce((sum, s) => sum + s.episodes.length, 0);
  console.log(
    `  ストーリー 公開 ${storySeries.length}季 / ${storyEpisodes}話${fixtures ? '（ダミー）' : ''}`,
  );

  if (withdrawn.length) {
    console.warn(`\n⚠ --allow-withdraw: 公開済みの話 ${withdrawn.length} 話を取り下げました:`);
    for (const id of withdrawn) console.warn(`  ${id}`);
    console.warn('  アプリで読み終えた話も、次の同期でロックに戻ります。');
  }

  if (missing.length) {
    console.warn(`\n⚠ 肖像がありません: ${missing.join(', ')}`);
    console.warn('  characters.json が指す先が 404 になります。npm run portraits で派生を作ってください。');
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('\n✗ ' + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
