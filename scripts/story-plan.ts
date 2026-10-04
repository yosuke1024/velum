#!/usr/bin/env tsx
/**
 * 【Legacy】人物の1季ぶんの物語の計画を立てる（Character Story）。
 *
 * これは旧経路（generateJson による構造化出力の plan → write）。新しい制作経路は
 * `npm run story:draft`（Codex CLI の Astra が自由に書く。docs/story-authoring.md）。
 * 旧経路は動作を変えずに残してあるが、新しい物語はまず story:draft で書く。
 *
 *   npm run story:plan -- --character riko --season 1
 *   npm run story:plan -- --character riko --season 1 --episodes 10
 *   npm run story:plan -- --character riko --season 1 --force      計画済みでも作り直す
 *   npm run story:plan -- --character riko --season 1 --dry-run    プロンプトだけを出す
 *
 * 計画は characters/<id>/stories/s<NN>/plan.yaml に置かれ、同時に manifest.yaml
 * （公開の台帳）が揃う。**走らせる前に読んで、直してよい。** 台帳に人間が書いたもの
 * （status・required_progress・題・形式）は、ここでは書き換えない。
 *
 * 生成 ≠ 公開。ここでは何も公開されない（status は draft のまま）。
 * 生成は GitHub Actions（story.yml）でだけ回る——Cloudflare の鍵は repo secret にしかない。
 * ローカルでは --dry-run だけが使える（鍵は要らない）。
 */

import { parseStoryArgs } from '../src/story/args.js';
import { planStory } from '../src/story/plan.js';

async function main(): Promise<void> {
  const args = parseStoryArgs(process.argv.slice(2), 'plan');

  const outcome = await planStory({
    characterId: args.character,
    season: args.season,
    episodes: args.episodes,
    force: args.force,
    dryRun: args.dryRun,
  });

  // 計画の破棄は失敗として返す（ゲートの違反は planStory がすでに表示している）。
  if (outcome.status === 'rejected') process.exit(1);
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${(error as Error).message}`);
  process.exit(1);
});
