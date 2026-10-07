#!/usr/bin/env tsx
/**
 * その日の日記を書かせる。**Legacy Diary Engine。**
 *
 *   npm run day                 今日（JST）
 *   npm run day -- 2026-09-01   日付を指定
 *   npm run day -- 2026-09-18 --backfill
 *                               破棄された過去の日を、歴史としてだけ補う（docs/diary.md §9）。
 *                               その日の朝の人物で書き、状態ファイルは動かさない。
 *
 * 日次の自動生成（cron）は 2026-10-03 に止めた（Character Story Engine への再設計。
 * docs/stories.md）。これは Season 1 の再現・調査・アーカイブのために残してあるコードで、
 * 動作は止める前と変えていない。日記は消さない（Experimental Diary Season 1 / Archive）。
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
import { RARE_EXPRESSION } from '../src/schemas/limits.js';
import { ERA_IDS } from '../src/schemas/world.js';
import { generateDiary } from '../src/diary/generate.js';
import type { Day } from '../src/diary/context.js';
import { ja, type MaybeBilingual } from '../src/lib/bilingual.js';
import { fileDate } from '../src/diary/as-of.js';

const args = process.argv.slice(2);
const dateArg = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const date = dateArg ?? today();
const dryRun = args.includes('--dry-run');
const backfill = args.includes('--backfill');

/** 要約として渡す直近の日記の本数。 */
const SUMMARY_LIMIT = 4;

/**
 * 直近の日記から、プロンプトへ渡すものを二つ取り出す。
 *
 * - 要約。全文ではなく要約だけを渡す。日記を再入力して人格を自己更新させると、
 *   自己模倣と反復が起きる。
 * - 定型を崩してよいか。直近 RARE_EXPRESSION.cooldownEntries 本に崩れがあれば、
 *   今日は崩せない（docs/diary.md §8）。プロンプトとゲートが同じ値を読む。
 */
function recentEntries(
  id: string,
  /** 過去の日を補うとき、その日より前の日記だけを数える。後の日の要約を渡せば、未来を知ったまま書く。 */
  before?: string,
): { summaries: string[]; rareExpressionAllowed: boolean } {
  const files = listDatedFiles(charPath(id, 'entries'), '.json').filter(
    (path) => !before || fileDate(path) < before,
  );
  const window = Math.max(SUMMARY_LIMIT, RARE_EXPRESSION.cooldownEntries);
  const entries = files.slice(-window).map(
    (path) =>
      JSON.parse(readFileSync(path, 'utf8')) as {
        date: string;
        title: MaybeBilingual;
        quote: MaybeBilingual;
        rare_expression_used?: boolean;
      },
  );

  return {
    // プロンプトへ戻す文字列。二言語で持っていても、読むのは日本語のほう。
    summaries: entries
      .slice(-SUMMARY_LIMIT)
      .map((entry) => `${entry.date}「${ja(entry.title)}」— ${ja(entry.quote)}`),
    rareExpressionAllowed: !entries
      .slice(-RARE_EXPRESSION.cooldownEntries)
      .some((entry) => entry.rare_expression_used === true),
  };
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
  console.log('[Legacy Diary Engine] 日次生成は 2026-10-03 に停止済み。再現・調査用（docs/stories.md）。');

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

  // 補うのは「その日より後の日記がすでにある」日だけ。後が無ければ、いまの状態が
  // その日の朝の状態そのものなので、普通に書けばよい（状態も進めるべきである）。
  if (backfill) {
    const later = listDatedFiles(charPath(turn.protagonist, 'entries'), '.json')
      .map(fileDate)
      .filter((d) => d > date);
    if (later.length === 0) {
      console.error(
        `\n✗ ${turn.protagonist} には ${date} より後の日記がありません。` +
          '補う必要はないので、--backfill を外して普通に書いてください。',
      );
      process.exit(1);
    }
    console.log(
      `  補完: ${date} の朝の状態で書きます（後の日記 ${later.length} 本ぶんを戻す）。状態ファイルは動かしません。`,
    );
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

  // 過去の日を補うときは、季の残りを数えても意味がない。
  if (!backfill) noticeIfSeasonRunningOut(date, turn.season);

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
  const recent = recentEntries(turn.protagonist, backfill ? date : undefined);
  if (!recent.rareExpressionAllowed) {
    console.log('  直近の日記に定型の崩れがあるため、今日は崩さない。');
  }
  const outcome = await generateDiary(day, recent.summaries, {
    rareExpressionAllowed: recent.rareExpressionAllowed,
    backfill,
  });

  if (!outcome.ok && outcome.backfilled) {
    console.error('\n✗ 構造ゲートの違反により、補完を見送りました:');
    for (const violation of outcome.violations) {
      console.error(`    ${violation}`);
    }
    console.error('\n  何も書いていません。元の失敗記録はそのまま残っています。');
    console.error('  同じ手順をもう一度回せば、同じ出来事から書き直せます。');
    process.exit(1);
  }

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

  console.log(`  日記:「${outcome.title}」${outcome.backfilled ? '（補完・状態は不変）' : ''}`);
  for (const note of outcome.truncated) {
    console.log(`  切り詰め: ${note}`);
  }
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${(error as Error).message}`);
  process.exit(1);
});
