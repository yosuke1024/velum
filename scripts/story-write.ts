#!/usr/bin/env tsx
/**
 * 【Legacy】人物の1季ぶんの物語の本文を下書きする（Character Story）。
 *
 * これは旧経路（generateJson による構造化出力の plan → write）。新しい制作経路は
 * `npm run story:draft`（Codex CLI の Astra が自由に書く。docs/story-authoring.md）。
 * 旧経路は動作を変えずに残してあるが、新しい物語はまず story:draft で書く。
 *
 *   npm run story:write -- --character riko --season 1               本文の無い話すべて
 *   npm run story:write -- --character riko --season 1 --episode 3   この1話だけ
 *   npm run story:write -- --character riko --season 1 --episode 3 --force   本文があっても書き直す
 *   npm run story:write -- --character riko --season 1 --episode 1 --dry-run プロンプトだけを出す
 *
 * 先に story:plan が要る（plan.yaml と manifest.yaml）。本文は e<NN>.ja.md / e<NN>.en.md として
 * 書かれ、台帳の話は必ず draft になる。reviewed だった話を書き直せば draft へ戻る。
 * **published の話は書き直さない**（--force でも）。公開を戻すのは、台帳の status を動かす人間の仕事。
 *
 * 構造ゲートに落ちた話は何も書かず、次の話へ進む。ひとつでも落ちれば、最後に終了コード 1 で終わる。
 * もう一度実行すれば、本文の無い話だけを引き直す。
 *
 * 生成は GitHub Actions（story.yml）でだけ回る。ローカルでは --dry-run だけが使える。
 */

import { parseStoryArgs } from '../src/story/args.js';
import { writeEpisodes } from '../src/story/write.js';

async function main(): Promise<void> {
  const args = parseStoryArgs(process.argv.slice(2), 'write');

  const outcome = await writeEpisodes({
    characterId: args.character,
    season: args.season,
    episode: args.episode,
    force: args.force,
    dryRun: args.dryRun,
  });

  // 破棄された話があれば失敗として終える（違反は writeEpisodes がすでに表示している）。
  if (outcome.status === 'done' && outcome.failed.length > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${(error as Error).message}`);
  process.exit(1);
});
