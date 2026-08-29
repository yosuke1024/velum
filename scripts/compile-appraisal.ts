#!/usr/bin/env tsx
/**
 * World Appraisal Snapshot をコンパイルする。
 *
 *   npm run appraisal                    次の版を world/appraisal/ へ書く（配らない）
 *   npm run appraisal -- --dry-run       書かずに中身を見る
 *   npm run appraisal -- --publish       コンパイルして、そのままピンを立てる
 *   npm run appraisal -- --season=2      季を明示（省略時は world/seasons/ の最新）
 *
 * **作ることと、配ることは別の操作である**（Persona Snapshot と同じ規律）。
 * --publish を付けなければ world/personas.json は動かず、PixTale プロキシの
 * 読む世界は変わらない。
 *
 * 更新周期は季末（25日ごと）に Persona と同時（契約 §2.1）。日次では回さない——
 * 鑑定の文脈に日単位の鮮度は要らない。素材は canon の手書き欄なので、
 * 内容が変わっていなければ新しい版は作らない。
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { relative } from 'node:path';
import { ROOT, appraisalPath, worldPath } from '../src/lib/paths.js';
import { writeJson } from '../src/lib/storage.js';
import {
  buildWorldAppraisal,
  existingAppraisalVersions,
  nextAppraisalVersion,
} from '../src/appraisal/compile.js';
import { publishWorld, readManifest } from '../src/compile/publish.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const shouldPublish = args.includes('--publish');
const seasonArg = args.find((a) => a.startsWith('--season='))?.split('=')[1];

/** 季は world/seasons/ の最新ディレクトリから。手で数えない。 */
function latestSeason(): number {
  const root = worldPath('seasons');
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name));
  if (!dirs.length) throw new Error('world/seasons/ に季がありません');
  return Math.max(...dirs);
}

const season = seasonArg ? Number(seasonArg) : latestSeason();
const version = nextAppraisalVersion();
const now = new Date().toISOString();

const snapshot = buildWorldAppraisal(version, season, now);
const size = Buffer.byteLength(JSON.stringify(snapshot, null, 2));

console.log(`World Appraisal Snapshot — v${String(version).padStart(4, '0')}（第${season}季）`);
console.log(
  `  時代 5 / 法則 ${snapshot.laws.length} / 見立て規則 ${snapshot.expression_rules.length} / ${size} bytes`,
);

const versions = existingAppraisalVersions();
if (versions.length) {
  console.log(`  既存: v${versions.map((v) => String(v).padStart(4, '0')).join(', v')}`);

  // 内容が変わっていなければ、番号だけ進む版を作らない。
  const latest = JSON.parse(
    readFileSync(appraisalPath(versions[versions.length - 1]!), 'utf8'),
  ) as Record<string, unknown>;
  const strip = (v: unknown) =>
    JSON.stringify({ ...(v as Record<string, unknown>), version: 0, compiled_at: '' });
  if (strip(latest) === strip(snapshot) && !dryRun) {
    const latestVersion = versions[versions.length - 1]!;
    console.log('\n内容が最新版と同じです。新しい版は作りません。');
    if (shouldPublish) {
      // 版は増やさず、既存の最新版へピンだけ立てる。
      const manifest = publishWorld(latestVersion, now);
      console.log(`配りました: world → v${String(manifest.world?.version).padStart(4, '0')}`);
      console.log(`  default_companion → ${manifest.default_companion}`);
    }
    process.exit(0);
  }
}

if (dryRun) {
  console.log(JSON.stringify(snapshot, null, 2));
  console.log('\n--dry-run のため、書き出していません。');
  process.exit(0);
}

const path = appraisalPath(version);
if (existsSync(path)) {
  // 追記のみ。既存バージョンには触れない。
  console.error(`✗ ${relative(ROOT, path)} は既に存在します`);
  process.exit(1);
}
writeJson(path, snapshot);
console.log(`  → ${relative(ROOT, path)}`);

if (shouldPublish) {
  const manifest = publishWorld(version, now);
  console.log('\n配りました（world/personas.json）:');
  console.log(`  world → v${String(manifest.world?.version).padStart(4, '0')}`);
  console.log(`  default_companion → ${manifest.default_companion}`);
} else {
  const pinned = readManifest().world;
  console.log(
    `\nまだ配っていません。ピンは${pinned ? ` v${String(pinned.version).padStart(4, '0')} のまま` : '立っていません'}。`,
  );
  console.log('  読んでよければ:  npm run appraisal -- --publish');
}
