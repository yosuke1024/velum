#!/usr/bin/env tsx
/**
 * Persona Snapshot をコンパイルする。
 *
 *   npm run snapshot                    5人ぶんコンパイルする（配らない）
 *   npm run snapshot -- teo             ひとりだけ
 *   npm run snapshot -- teo --dry-run   何から圧縮するかだけ見る（生成しない）
 *   npm run snapshot -- --publish       コンパイルして、そのまま配る
 *   npm run snapshot -- --if-season-end 季の最終日でなければ何もしない（日次から呼ばれる形）
 *
 * **作ることと、配ることは別の操作である。**
 *
 * --publish を付けなければ world/personas.json は動かず、PixTale の出力は
 * 1文字も変わらない。付ければ変わる。日次ワークフローは季の最終日にこれを
 * --publish なしで走らせるので、いまは人が読んでから配る形になっている。
 *
 * **全自動にしたくなったら、ワークフローの1行に --publish を足すだけでよい。**
 * 人が介在する箇所は、構造ではなくこのフラグ1つに閉じてある。
 *
 * 詳細は docs/persona-snapshot.md。
 */

import { CHARACTER_IDS } from '../src/schemas/world.js';
import { buildCompileContext, lifeFactsFrom, rememberedFrom } from '../src/compile/context.js';
import { compileSnapshot, existingVersions, nextVersion } from '../src/compile/compile.js';
import { publish, readManifest } from '../src/compile/publish.js';
import { isSeasonEnd, today, turnFor } from '../src/lib/rotation.js';
import type { Snapshot } from '../src/schemas/snapshot.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const shouldPublish = args.includes('--publish');
const onlyAtSeasonEnd = args.includes('--if-season-end');
const dateArg = args.find((a) => a.startsWith('--date='))?.split('=')[1];
const seasonArg = args.find((a) => a.startsWith('--season='))?.split('=')[1];
const named = args.filter((a) => !a.startsWith('--'));

const date = dateArg || today();

/**
 * 季の最終日でなければ、何もせずに終わる（成功として）。
 *
 * 日次ワークフローはこれを毎日呼ぶ。25日に1度だけ中身が動く。
 * 判定をワークフローの shell ではなくここへ置いてあるのは、
 * ローテーションの算術がすでに src/lib/rotation.ts にあり、テストもそこにあるからである。
 */
if (onlyAtSeasonEnd && !isSeasonEnd(date)) {
  const turn = turnFor(date);
  console.log(
    `${date} は第${turn.season}季 第${turn.episode}話。季の途中なので、Snapshot はコンパイルしません。`,
  );
  process.exit(0);
}

/** 何季ぶんの人格かは、日付から決まる。手で数えない。 */
const season = seasonArg
  ? Number(seasonArg)
  : onlyAtSeasonEnd
    ? turnFor(date).season
    : null;

const targets = named.length ? named : [...CHARACTER_IDS];

for (const id of targets) {
  if (!(CHARACTER_IDS as readonly string[]).includes(id)) {
    console.error(`\n✗ ${id} という主人公はいません（${CHARACTER_IDS.join(', ')}）`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  let failed = 0;
  const compiled: Snapshot[] = [];
  const pinned = readManifest();

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
    const current = pinned.personas[id];
    console.log(
      `  いま配っているもの: ${current ? `v${String(current.version).padStart(4, '0')}` : 'なし'}`,
    );

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

    compiled.push(outcome.snapshot);
    console.log(`  → ${outcome.path.split('/').slice(-4).join('/')}`);
    for (const disposition of outcome.snapshot.dispositions) {
      console.log(`    ・${disposition}`);
    }
  }

  if (dryRun) {
    console.log('\n--dry-run のため、Snapshot は書き出していません。');
    return;
  }

  if (shouldPublish && compiled.length) {
    const manifest = publish(compiled, new Date().toISOString(), season);
    console.log('\n配りました（world/personas.json）:');
    for (const snapshot of compiled) {
      const entry = manifest.personas[snapshot.character];
      console.log(`  ${snapshot.character} → v${String(entry?.version).padStart(4, '0')}`);
    }
    console.log('  PixTale は次に personas.json を読んだ時点で、この人格に切り替わります。');
  } else if (compiled.length) {
    console.log(
      '\nまだ配っていません。world/personas.json は動いていないので、PixTale の出力は変わりません。',
    );
    console.log('  読んでよければ:  npm run snapshot -- --publish');
  }

  if (failed) {
    console.error(
      `\n✗ ${failed}人ぶんを破棄しました。その人物の Snapshot は書き出していません。`,
    );
    console.error('  その人物のピンは前のままなので、PixTale はその人格を語り続けます。');
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${(error as Error).message}`);
  process.exit(1);
});
