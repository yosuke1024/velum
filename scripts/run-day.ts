#!/usr/bin/env tsx
/**
 * その日の日記を書かせる。
 *
 *   npm run day                 今日（JST）
 *   npm run day -- 2026-09-01   日付を指定
 *
 * 出来事はここでは作らない。季の計画（world/seasons/）から、その日の話を取り出す。
 * 計画がなければ何もせずに終わる——先に npm run plan を実行すること。
 */

import { readFileSync } from 'node:fs';
import { turnFor, today, daysLeftInSeason, seasonStartDate } from '../src/lib/rotation.js';
import { charPath, seasonPath, entryPath } from '../src/lib/paths.js';
import { readYaml, exists, listDatedFiles } from '../src/lib/storage.js';
import { calendarLineFor, formatWorldDate } from '../src/lib/calendar.js';
import { SeasonPlanSchema, DAYS_PER_SEASON, EPISODES_PER_SEASON } from '../src/schemas/season.js';
import { ERA_IDS } from '../src/schemas/world.js';
import { generateDiary } from '../src/diary/generate.js';
import type { Day } from '../src/diary/context.js';
import { ja, type MaybeBilingual } from '../src/lib/bilingual.js';

const args = process.argv.slice(2);
const dateArg = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const date = dateArg ?? today();
const dryRun = args.includes('--dry-run');

/**
 * 直近の日記の要約。全文ではなく要約だけを渡す。
 * 日記を再入力して人格を自己更新させると、自己模倣と反復が起きる。
 */
function recentSummaries(id: string, limit = 4): string[] {
  const files = listDatedFiles(charPath(id, 'entries'), '.json');

  return files.slice(-limit).map((path) => {
    const entry = JSON.parse(readFileSync(path, 'utf8')) as {
      date: string;
      title: MaybeBilingual;
      quote: MaybeBilingual;
    };
    // プロンプトへ戻す文字列。二言語で持っていても、読むのは日本語のほう。
    return `${entry.date}「${ja(entry.title)}」— ${ja(entry.quote)}`;
  });
}

/** 最後の1周（5日）に入ったら知らせる。5人が1回ずつ書くあいだ、毎朝出る。 */
const NOTICE_WITHIN_DAYS = DAYS_PER_SEASON / EPISODES_PER_SEASON;

/**
 * 季の終わりが近いのに次の季の計画が無ければ、まだ緑のうちに知らせる。
 *
 * 計画は自動では立たない——それがこの構造の主目的である（docs/seasons.md §1）。
 * だから次の季の初日に計画が無ければ、その朝からジョブは赤くなり、
 * 人が npm run plan を回すまで毎日欠け続ける。赤くなってから気づいたのでは、
 * その日はもう欠けている。
 */
function noticeIfSeasonRunningOut(date: string, season: number): void {
  const left = daysLeftInSeason(date);
  if (left > NOTICE_WITHIN_DAYS) return;

  const next = season + 1;
  const unplanned = ERA_IDS.filter((era) => !exists(seasonPath(next, era)));
  if (unplanned.length === 0) return;

  const from = seasonStartDate(next);
  const notice =
    `第${season}季は残り${left}日。${from} から第${next}季が始まりますが、` +
    `計画がまだありません（${unplanned.join(' / ')}）。` +
    `その朝までに npm run plan -- --season ${next} を回してください。`;

  console.log(`\n  ⚠ ${notice}`);
  // 緑のまま流れていかないよう、GitHub Actions では run の注釈にも残す。
  if (process.env.GITHUB_ACTIONS) console.log(`::warning::${notice}`);
}

async function main(): Promise<void> {
  const turn = turnFor(date);
  console.log(
    `${date} — 第${turn.season}季 第${turn.episode}話 / ${turn.era} / ${turn.protagonist}`,
  );

  // 同じ日の二重生成を防ぐ。cron と手動実行が重なっても、
  // 状態差分が二重に適用されることはない。
  if (!dryRun && exists(entryPath(turn.protagonist, date))) {
    console.log('  この日の日記は生成済みです。何もしません。');
    return;
  }

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
  let carriedOver = previous ? ja(previous.leaves_open) : null;
  if (!previous && turn.season > 1) {
    const before = seasonPath(turn.season - 1, turn.era);
    if (exists(before)) {
      const beforePlan = readYaml(before, SeasonPlanSchema);
      const last = beforePlan.episodes.at(-1);
      carriedOver = last ? ja(last.leaves_open) : null;
    }
  }

  const worldDate = formatWorldDate(plan.year_in_world, episode.world_date);
  console.log(`  ${ja(plan.title)} — ${episode.beat}（${worldDate}）`);
  for (const event of episode.events) {
    console.log(`    ・${event.where}: ${event.summary}`);
  }

  noticeIfSeasonRunningOut(date, turn.season);

  if (dryRun) {
    console.log('\n  --dry-run のため、日記は生成しません。');
    return;
  }

  const day: Day = {
    date,
    turn,
    episode,
    carriedOver,
    worldYear: plan.year_in_world,
    calendarLine: calendarLineFor(turn.era, plan.year_in_world, episode.world_date),
  };
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
