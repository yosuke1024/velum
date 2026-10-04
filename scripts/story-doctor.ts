#!/usr/bin/env tsx
/**
 * 新しい制作経路（Codex CLI の Astra）が動く状態かを確かめる。docs/story-authoring.md §3。
 *
 *   npm run story:doctor                 推論は呼ばない。版・認証・モデルカタログ・設定の検査だけ
 *   npm run story:doctor -- --probe      検査が通れば、固定の短い入力で Astra を 1 回だけ実際に呼ぶ
 *
 * 検査: config / gitignore / cli-version / exec-flags / auth / catalog / strict-config / isolation / env。
 * ✗ が 1 つでもあれば終了コード 1（--probe を付けていても Astra は呼ばない）。! は警告で、止めない
 * （公式の設定では消せない既知の残留など）。--probe の応答は .story-runs/ に run として残る。
 *
 * 別のモデル・従量課金 API・別のプロバイダへは、どの検査も切り替えない。
 * Ctrl-C（SIGINT）・SIGTERM・SIGHUP は、起こしている Codex をグループごと止める（installCliSafety）。
 */

import { parseDoctorArgs } from '../src/story/authoring/args.js';
import { installCliSafety } from '../src/story/authoring/cli.js';
import { loadWriterConfig } from '../src/story/authoring/config.js';
import { runDoctor } from '../src/story/authoring/doctor.js';
import { formatDoctor } from '../src/story/authoring/report.js';
import { realAuthoringDeps } from '../src/story/authoring/run.js';

async function main(): Promise<void> {
  const args = parseDoctorArgs(process.argv.slice(2));
  const config = loadWriterConfig();

  const controller = new AbortController();
  installCliSafety(controller);
  const deps = realAuthoringDeps({ config, abortSignal: controller.signal });

  const result = await runDoctor({ probe: args.probe }, deps);
  const printed = formatDoctor(result, { probe: args.probe });
  if (printed.ok) console.log(printed.lines.join('\n'));
  else console.error(printed.lines.join('\n'));
  if (!printed.ok) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
