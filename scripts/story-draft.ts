#!/usr/bin/env tsx
/**
 * 人物の物語の初稿を、Codex CLI の Astra に自由に書かせる（新しい制作経路。docs/story-authoring.md）。
 *
 *   npm run story:draft -- --character riko --brief authoring/briefs/velum_riko_writing_brief.md \
 *     --request authoring/prompts/riko-first-request.txt --dry-run                  何を渡すかだけを出す（Codex を呼ばない）
 *   npm run story:draft -- --character riko --brief <brief> --request <依頼文> --dry-run --print-prompt
 *                                                                                     stdin へ渡す全文も出す
 *   npm run story:draft -- --character riko --brief <brief> --request <依頼文>        1 回だけ書かせる
 *   npm run story:draft -- ... --effort xhigh --verbosity low --timeout-minutes 60    writer.yaml の値を上書きする
 *
 * 先に `npm run story:doctor` で動く状態を確かめる。実行は 1 回 = Codex の `codex exec` 1 回。
 * 自動再試行・別モデル・別プロバイダへの切り替えは無い。失敗したら止まり、理由と人がすることを示す。
 *
 * 原稿は .story-runs/<run-id>/（gitignore）に draft として置くだけ。manifest・characters/・feed には
 * 触れず、公開もしない。相対パスは、実行したディレクトリからの相対として解決する。
 * Ctrl-C（SIGINT）・SIGTERM・SIGHUP（端末を閉じた）は Codex をプロセスグループごと止めて、interrupted の run として記録する
 * （落ち方の安全は src/story/authoring/cli.ts の installCliSafety）。
 */

import { resolve } from 'node:path';
import { parseDraftArgs } from '../src/story/authoring/args.js';
import { installCliSafety } from '../src/story/authoring/cli.js';
import { loadWriterConfig } from '../src/story/authoring/config.js';
import { formatRunOutcome } from '../src/story/authoring/report.js';
import { draftStory, realAuthoringDeps } from '../src/story/authoring/run.js';

async function main(): Promise<void> {
  const args = parseDraftArgs(process.argv.slice(2));
  const config = loadWriterConfig();

  const controller = new AbortController();
  installCliSafety(controller);
  const deps = realAuthoringDeps({ config, abortSignal: controller.signal });

  const outcome = await draftStory(
    {
      characterId: args.character,
      briefPath: resolve(process.cwd(), args.brief),
      requestPath: resolve(process.cwd(), args.request),
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
