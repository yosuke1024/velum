#!/usr/bin/env tsx
/**
 * Character Story の季の計画を立てる（docs/stories.md）。
 *
 *   npm run story:plan -- --character riko --season 1               8話で計画する
 *   npm run story:plan -- --character riko --season 1 --episodes 10
 *   npm run story:plan -- --character riko --season 1 --force       計画済みでも作り直す
 *   npm run story:plan -- --character riko --season 1 --dry-run     プロンプトだけ見る（生成しない）
 *
 * 生成物は characters/<id>/stories/sNN/plan.yaml と manifest.yaml（draft）。
 * **走らせる前に読んで、直してよい。** manifest にすでに人間が書いた title / status /
 * required_progress があれば、--force でも消さない（src/story/plan.ts の syncManifest）。
 * 本文はここでは書かない——npm run story:write が別に書く。
 */

import { CHARACTER_IDS, type CharacterId } from '../src/schemas/world.js';
import { DEFAULT_EPISODES_PER_STORY } from '../src/schemas/story.js';
import { exists } from '../src/lib/storage.js';
import { planStory } from '../src/story/plan.js';
import { storyPaths } from '../src/story/paths.js';
import { buildStoryContext } from '../src/story/context.js';
import { buildStoryPlanSystemPrompt, buildStoryPlanUserPrompt } from '../src/story/prompt.js';

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

const characterId = flag('character') as CharacterId | undefined;
const season = Number(flag('season') ?? '1');
const episodes = Number(flag('episodes') ?? String(DEFAULT_EPISODES_PER_STORY));
const force = args.includes('--force');
const dryRun = args.includes('--dry-run');

if (!characterId || !(CHARACTER_IDS as readonly string[]).includes(characterId)) {
  console.error(`--character には ${CHARACTER_IDS.join(' / ')} のいずれかを指定してください。`);
  process.exit(1);
}
if (!Number.isInteger(season) || season < 1) {
  console.error('--season には1以上の整数を指定してください。');
  process.exit(1);
}

async function main(): Promise<void> {
  const paths = storyPaths(characterId!, season);

  if (dryRun) {
    const context = buildStoryContext(characterId!);
    console.log('--- system ---\n');
    console.log(buildStoryPlanSystemPrompt());
    console.log('\n--- user ---\n');
    console.log(buildStoryPlanUserPrompt(context, { season, episodes }));
    console.log('\n--dry-run のため、生成しません。');
    return;
  }

  if (exists(paths.plan) && !force) {
    console.log(`計画済みです: ${paths.plan}（--force で作り直せます）`);
    return;
  }

  console.log(`${characterId} の Story 第${season}季（${episodes}話）を設計します。\n`);
  const { plan, manifest } = await planStory({ characterId: characterId!, season, episodes });

  console.log(`「${manifest.title.ja}」— ${manifest.title.en}`);
  console.log(`  はじめ: ${plan.character_arc.start}`);
  console.log(`  動くもの: ${plan.character_arc.emotional_change}`);
  console.log(`  おわり: ${plan.character_arc.end}`);
  console.log('');
  for (const episode of plan.episodes) {
    const listed = manifest.episodes.find((e) => e.order === episode.order);
    console.log(
      `  第${episode.order}話 [${episode.format}] progress ${listed?.required_progress ?? '?'} ${episode.working_title ?? ''}`,
    );
    console.log(`    ${episode.purpose}`);
  }
  console.log('');
  console.log(`計画を ${paths.plan} に、台帳を ${paths.manifest} に書きました。`);
  console.log('読んで直してから、npm run story:write で本文を書かせてください。status は draft のままです。');
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${(error as Error).message}`);
  process.exit(1);
});
