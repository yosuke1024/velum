#!/usr/bin/env tsx
/**
 * Character Story の本文を書く（docs/stories.md）。
 *
 *   npm run story:write -- --character riko --season 1               計画の全話（本文の無い話だけ）
 *   npm run story:write -- --character riko --season 1 --episode 3   1話だけ
 *   npm run story:write -- --character riko --season 1 --force       本文があっても書き直す
 *
 * 本文は characters/<id>/stories/sNN/eNN.{ja,en}.md に置かれ、manifest.yaml の
 * title / summary が埋まる。**status は draft のまま。生成 ≠ 公開。**
 * 公開するのは人間で、読んでから manifest.yaml の status を reviewed → published と
 * 進め、npm run export:feed で feed へ出す。published の話は --force でも書き直せない。
 *
 * 構造ゲート（長さ・言語の混在・Markdown 装飾）に落ちた話は書かれず、理由だけが出る。
 * 面白いかどうかはゲートが見ない。それは読む人の仕事である。
 */

import { CHARACTER_IDS, type CharacterId } from '../src/schemas/world.js';
import { StoryPlanSchema } from '../src/schemas/story.js';
import { readYaml, exists } from '../src/lib/storage.js';
import { writeStoryEpisode } from '../src/story/write.js';
import { storyPaths } from '../src/story/paths.js';

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

const characterId = flag('character') as CharacterId | undefined;
const season = Number(flag('season') ?? '1');
const onlyEpisode = flag('episode') ? Number(flag('episode')) : undefined;
const force = args.includes('--force');

if (!characterId || !(CHARACTER_IDS as readonly string[]).includes(characterId)) {
  console.error(`--character には ${CHARACTER_IDS.join(' / ')} のいずれかを指定してください。`);
  process.exit(1);
}
if (!Number.isInteger(season) || season < 1) {
  console.error('--season には1以上の整数を指定してください。');
  process.exit(1);
}
if (onlyEpisode !== undefined && (!Number.isInteger(onlyEpisode) || onlyEpisode < 1)) {
  console.error('--episode には1以上の整数を指定してください。');
  process.exit(1);
}

async function main(): Promise<void> {
  const paths = storyPaths(characterId!, season);
  if (!exists(paths.plan)) {
    console.error(`\n✗ 計画がありません: ${paths.plan}\n  先に npm run story:plan -- --character ${characterId} --season ${season} を実行してください。`);
    process.exit(1);
  }
  const plan = readYaml(paths.plan, StoryPlanSchema);
  const orders = onlyEpisode ? [onlyEpisode] : plan.episodes.map((e) => e.order);

  let failed = 0;
  for (const order of orders) {
    const outcome = await writeStoryEpisode({ characterId: characterId!, season, order, force });
    if (!outcome.ok) {
      failed += 1;
      console.error(`  第${order}話: 構造ゲートの違反により書きませんでした`);
      for (const violation of outcome.violations) console.error(`    ${violation}`);
      continue;
    }
    if (outcome.skipped) {
      console.log(`  第${order}話: 本文があるため飛ばします（--force で書き直せます）`);
      continue;
    }
    console.log(`  第${order}話:「${outcome.title}」を書きました（draft）`);
  }

  console.log('');
  console.log(`本文は ${paths.dir} に置きました。読んで直し、manifest.yaml の status を進めてください。`);
  if (failed) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${(error as Error).message}`);
  process.exit(1);
});
