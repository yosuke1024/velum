#!/usr/bin/env tsx
/**
 * 季の計画を立てる。1人につき5話、5人で25日分。
 *
 *   npm run plan -- --season 1            5時代ぶんまとめて
 *   npm run plan -- --season 1 --era guilds   1時代だけ作り直す
 *
 * 生成した計画は world/seasons/<季>/<時代>.yaml に置かれる。
 * **走らせる前に読んで、直してよい。** 出来事を前もって決める狙いは、
 * 物語の形を作ることと、人間が読んで直せるようにすることの両方である。
 */

import { ERA_IDS, ERA_PROTAGONIST, type EraId } from '../src/schemas/world.js';
import { seasonPath } from '../src/lib/paths.js';
import { ja } from '../src/lib/bilingual.js';
import { exists } from '../src/lib/storage.js';
import { seasonStartDate } from '../src/lib/rotation.js';
import { planSeason } from '../src/season/plan.js';
import { DAYS_PER_SEASON } from '../src/schemas/season.js';

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

const season = Number(flag('season') ?? '1');
const onlyEra = flag('era') as EraId | undefined;
const force = args.includes('--force');

if (!Number.isInteger(season) || season < 1) {
  console.error('--season には1以上の整数を指定してください。');
  process.exit(1);
}
if (onlyEra && !ERA_IDS.includes(onlyEra)) {
  console.error(`--era には ${ERA_IDS.join(' / ')} のいずれかを指定してください。`);
  process.exit(1);
}

async function main(): Promise<void> {
  const eras = onlyEra ? [onlyEra] : [...ERA_IDS];
  const start = seasonStartDate(season);

  console.log(
    `第${season}季（${start} から ${DAYS_PER_SEASON} 日）の計画を立てます。\n`,
  );

  for (const era of eras) {
    const path = seasonPath(season, era);

    if (exists(path) && !force) {
      console.log(`  ${era}: 計画済みのため飛ばします（--force で作り直せます）`);
      continue;
    }

    const protagonist = ERA_PROTAGONIST[era];
    const plan = await planSeason(season, era, protagonist);

    console.log(`  ${era} / ${protagonist} —「${ja(plan.title)}」`);
    console.log(`    ${ja(plan.shape)}`);
    for (const episode of plan.episodes) {
      const first = episode.events[0];
      console.log(`    第${episode.number}話 ${episode.beat}: ${first?.summary ?? ''}`);
    }
    console.log('');
  }

  console.log('計画を world/seasons/ に書き出しました。');
  console.log('走らせる前に読んで、直してよいものです。');
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${(error as Error).message}`);
  process.exit(1);
});
