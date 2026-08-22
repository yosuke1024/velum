#!/usr/bin/env tsx
/**
 * その日の一日を回す。Tick を生成し、番の主人公に日記を書かせる。
 *
 *   npm run day                 今日
 *   npm run day -- 2026-09-01   日付を指定
 *   npm run day -- --tick-only  Tick だけ
 *
 * 進むのは1日ひとつの時代だけ。番でない時代の時間は止まっている。
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { turnFor } from '../src/lib/rotation.js';
import { charPath, tickPath } from '../src/lib/paths.js';
import { readJson, exists } from '../src/lib/storage.js';
import { TickSchema } from '../src/schemas/tick.js';
import { generateTick } from '../src/tick/generate.js';
import { generateDiary } from '../src/diary/generate.js';

const args = process.argv.slice(2);
const tickOnly = args.includes('--tick-only');
const dateArg = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const date = dateArg ?? new Date().toISOString().slice(0, 10);

/**
 * 直近の日記の要約。全文ではなく要約だけを渡す。
 * 日記を再入力して人格を自己更新させると、自己模倣と反復が起きる。
 */
function recentSummaries(id: string, limit = 4): string[] {
  const root = charPath(id, 'entries');
  if (!existsSync(root)) return [];

  const files: string[] = [];
  for (const year of readdirSync(root).sort()) {
    const yearDir = join(root, year);
    for (const month of readdirSync(yearDir).sort()) {
      const monthDir = join(yearDir, month);
      for (const file of readdirSync(monthDir).sort()) {
        if (file.endsWith('.json')) files.push(join(monthDir, file));
      }
    }
  }

  return files
    .slice(-limit)
    .map((path) => {
      const entry = JSON.parse(readFileSync(path, 'utf8')) as {
        date: string;
        title: string;
        quote: string;
      };
      return `${entry.date}「${entry.title}」— ${entry.quote}`;
    });
}

async function main(): Promise<void> {
  const turn = turnFor(date);
  console.log(
    `${date} — ${turn.era} / ${turn.protagonist}（稼働 ${turn.dayIndex + 1} 日目）`,
  );

  let tick;
  if (exists(tickPath(date))) {
    console.log('  Tick は生成済み。再利用します。');
    tick = readJson(tickPath(date), TickSchema);
  } else {
    tick = await generateTick(date, turn.era, turn.protagonist);
    console.log(`  Tick: ${tick.card.id} — ${tick.events.length} 件の出来事`);
    for (const event of tick.events) {
      console.log(`    ・${event.where}: ${event.summary}`);
    }
  }

  if (tickOnly) return;

  const outcome = await generateDiary(tick, recentSummaries(turn.protagonist));

  if (!outcome.ok) {
    console.error('\n✗ 構造ゲートの違反により、この日を破棄しました:');
    for (const violation of outcome.violations) {
      console.error(`    ${violation}`);
    }
    console.error('\n  失敗の記録は world/failures/ に残しました。');
    console.error('  状態ファイルは変更していません。');
    process.exit(1);
  }

  console.log(`  日記:「${outcome.title}」`);
  for (const note of outcome.truncated) {
    console.log(`  切り詰め: ${note}`);
  }
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${(error as Error).message}`);
  process.exit(1);
});
