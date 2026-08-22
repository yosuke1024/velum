#!/usr/bin/env tsx
/**
 * その日の日記を書かせる。
 *
 *   npm run day                 今日
 *   npm run day -- 2026-09-01   日付を指定
 *
 * 出来事はここでは作らない。季の計画（world/seasons/）から、その日の話を取り出す。
 * 計画がなければ何もせずに終わる——先に npm run plan を実行すること。
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { turnFor } from '../src/lib/rotation.js';
import { charPath, seasonPath } from '../src/lib/paths.js';
import { readYaml, exists } from '../src/lib/storage.js';
import { SeasonPlanSchema } from '../src/schemas/season.js';
import { generateDiary } from '../src/diary/generate.js';
import type { Day } from '../src/diary/context.js';

const args = process.argv.slice(2);
const dateArg = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const date = dateArg ?? new Date().toISOString().slice(0, 10);
const dryRun = args.includes('--dry-run');

/**
 * 直近の日記の要約。全文ではなく要約だけを渡す。
 * 日記を再入力して人格を自己更新させると、自己模倣と反復が起きる。
 */
function recentSummaries(id: string, limit = 4): string[] {
  const root = charPath(id, 'entries');
  if (!existsSync(root)) return [];

  const files: string[] = [];
  for (const year of readdirSync(root).sort()) {
    for (const month of readdirSync(join(root, year)).sort()) {
      for (const file of readdirSync(join(root, year, month)).sort()) {
        if (file.endsWith('.json')) files.push(join(root, year, month, file));
      }
    }
  }

  return files.slice(-limit).map((path) => {
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
    `${date} — 第${turn.season}季 第${turn.episode}話 / ${turn.era} / ${turn.protagonist}`,
  );

  const planFile = seasonPath(turn.season, turn.era);
  if (!exists(planFile)) {
    console.error(
      `\n✗ 第${turn.season}季 ${turn.era} の計画がありません。\n` +
        `  先に次を実行してください:\n\n` +
        `    npm run plan -- --season ${turn.season}\n`,
    );
    process.exit(1);
  }

  const plan = readYaml(planFile, SeasonPlanSchema);
  const episode = plan.episodes.find((e) => e.number === turn.episode);
  if (!episode) {
    console.error(`\n✗ 第${turn.season}季 ${turn.era} に第${turn.episode}話がありません。`);
    process.exit(1);
  }

  // 前の話が残したもの。第1話なら前の季の第5話から引き継ぐ。
  const previous = plan.episodes.find((e) => e.number === turn.episode - 1);
  let carriedOver = previous?.leaves_open ?? null;
  if (!previous && turn.season > 1) {
    const before = seasonPath(turn.season - 1, turn.era);
    if (exists(before)) {
      const beforePlan = readYaml(before, SeasonPlanSchema);
      carriedOver = beforePlan.episodes.at(-1)?.leaves_open ?? null;
    }
  }

  console.log(`  ${plan.title} — ${episode.beat}`);
  for (const event of episode.events) {
    console.log(`    ・${event.where}: ${event.summary}`);
  }

  if (dryRun) {
    console.log('\n  --dry-run のため、日記は生成しません。');
    return;
  }

  const day: Day = { date, turn, episode, carriedOver };
  const outcome = await generateDiary(day, recentSummaries(turn.protagonist));

  if (!outcome.ok) {
    console.error('\n✗ 構造ゲートの違反により、この日を破棄しました:');
    for (const violation of outcome.violations) {
      console.error(`    ${violation}`);
    }
    console.error('\n  失敗の記録は world/failures/ に残しました。');
    console.error('  状態ファイルは変更していません。季の計画は残っているので、');
    console.error('  同じ日をやり直せば同じ出来事から書き直せます。');
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
