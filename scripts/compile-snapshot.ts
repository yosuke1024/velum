#!/usr/bin/env tsx
/**
 * Persona Snapshot をコンパイルする。
 *
 *   npm run snapshot                    5人ぶん
 *   npm run snapshot -- teo             ひとりだけ
 *   npm run snapshot -- teo --dry-run   何から圧縮するかだけ見る（生成しない）
 *
 * 日次では走らせない。Snapshot は追記のみで、PixTale はバージョンを固定して読むので、
 * 更新するのは人間が「この人格を配ってよい」と判断したときだけである。
 * 詳細は docs/persona-snapshot.md。
 */

import { CHARACTER_IDS } from '../src/schemas/world.js';
import { buildCompileContext, lifeFactsFrom, rememberedFrom } from '../src/compile/context.js';
import { compileSnapshot, existingVersions, nextVersion } from '../src/compile/compile.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const named = args.filter((a) => !a.startsWith('--'));

const targets = named.length ? named : [...CHARACTER_IDS];

for (const id of targets) {
  if (!(CHARACTER_IDS as readonly string[]).includes(id)) {
    console.error(`\n✗ ${id} という主人公はいません（${CHARACTER_IDS.join(', ')}）`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  let failed = 0;

  for (const id of targets) {
    const context = buildCompileContext(id);
    const versions = existingVersions(id);
    const { count, through } = context.diaries;

    console.log(`\n${context.profile.name.ja}（${id}）— v${nextVersion(id)}`);
    console.log(
      `  日記 ${count}本${through ? `（${through} まで）` : ''} / ` +
        `記憶 ${context.memories.memories.length}件 / ` +
        `人生の事実 ${lifeFactsFrom(context.canon).length}件`,
    );
    if (versions.length) {
      console.log(`  既存: v${versions.map((v) => String(v).padStart(4, '0')).join(', v')}`);
    }

    if (dryRun) {
      for (const memory of rememberedFrom(context.memories)) {
        console.log(`    ・${memory.weight} ${memory.summary}`);
      }
      continue;
    }

    const outcome = await compileSnapshot(id);

    if (!outcome.ok) {
      failed += 1;
      console.error('  ✗ ゲートの違反により破棄しました:');
      for (const violation of outcome.violations) {
        console.error(`      ${violation}`);
      }
      continue;
    }

    console.log(`  → ${outcome.path.split('/').slice(-4).join('/')}`);
    for (const disposition of outcome.snapshot.dispositions) {
      console.log(`    ・${disposition}`);
    }
  }

  if (dryRun) {
    console.log('\n--dry-run のため、Snapshot は書き出していません。');
    return;
  }

  if (failed) {
    console.error(
      `\n✗ ${failed}人ぶんを破棄しました。書き出した Snapshot はありません（その人物ぶん）。`,
    );
    console.error('  既存のバージョンはそのままなので、PixTale は動き続けます。');
    process.exit(1);
  }

  console.log('\n✓ 完了。PixTale がどのバージョンを読むかは、向こうのピンで決まります。');
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${(error as Error).message}`);
  process.exit(1);
});
