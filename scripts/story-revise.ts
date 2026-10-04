#!/usr/bin/env tsx
/**
 * 成功した run の原稿を、フィードバックに沿って Astra に改稿させる（新しい制作経路。docs/story-authoring.md §7）。
 *
 *   npm run story:revise -- --run <run-id> --feedback <feedback.md> --dry-run         何を渡すかだけを出す（Codex を呼ばない）
 *   npm run story:revise -- --run <run-id> --feedback <feedback.md> --dry-run --print-prompt
 *                                                                                     元の原稿の全文を含む依頼文も出す
 *   npm run story:revise -- --run <run-id> --feedback <feedback.md>                   1 回だけ改稿させる
 *   npm run story:revise -- --run <run-id> --feedback <fb.md> --brief <新しい brief>   brief を差し替える
 *
 * 渡すのは「元の原稿の全文 + brief + フィードバック」（要約で代用しない）。brief と執筆用指示は、既定で
 * 親の run の写しを使う（条件を親と揃える）。親の run は書き換えず、成功した run だけが元になれる。
 * 親の raw の hash が記録と違えば止まる。新しい run に、親の本文との差分 revision.diff が残る。
 *
 * 実行は 1 回 = `codex exec` 1 回。自動再試行・別モデル・別プロバイダへの切り替えは無い。
 * 原稿は .story-runs/（gitignore）に置くだけで、manifest・characters/・feed に触れず、公開もしない。
 * 相対パスは、実行したディレクトリからの相対として解決する。Ctrl-C（SIGINT）・SIGTERM・SIGHUP は Codex をグループごと止める
 * （落ち方の安全は src/story/authoring/cli.ts の installCliSafety）。
 */

import { resolve } from 'node:path';
import { parseReviseArgs } from '../src/story/authoring/args.js';
import { installCliSafety } from '../src/story/authoring/cli.js';
import { loadWriterConfig } from '../src/story/authoring/config.js';
import { formatRunOutcome } from '../src/story/authoring/report.js';
import { realAuthoringDeps, reviseStory } from '../src/story/authoring/run.js';

async function main(): Promise<void> {
  const args = parseReviseArgs(process.argv.slice(2));
  const config = loadWriterConfig();

  const controller = new AbortController();
  installCliSafety(controller);
  const deps = realAuthoringDeps({ config, abortSignal: controller.signal });

  const outcome = await reviseStory(
    {
      runId: args.run,
      feedbackPath: resolve(process.cwd(), args.feedback),
      ...(args.brief !== undefined ? { briefPath: resolve(process.cwd(), args.brief) } : {}),
      ...(args.instructions !== undefined ? { instructionsPath: resolve(process.cwd(), args.instructions) } : {}),
      ...(args.effort !== undefined ? { effort: args.effort } : {}),
      ...(args.verbosity !== undefined ? { verbosity: args.verbosity } : {}),
      ...(args.timeoutMinutes !== undefined ? { timeoutMinutes: args.timeoutMinutes } : {}),
      dryRun: args.dryRun,
      printPrompt: args.printPrompt,
    },
    deps,
  );

  const printed = formatRunOutcome(outcome);
  if (printed.ok) console.log(printed.lines.join('\n'));
  else console.error(printed.lines.join('\n'));
  if (!printed.ok) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
