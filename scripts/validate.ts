#!/usr/bin/env tsx
/**
 * world/ と characters/ の全データをスキーマに照らして検証する。
 *
 * スキーマ違反だけでなく、ファイル間の整合も見る:
 *  - 5時代それぞれに主人公がいて、profile.yaml の era と一致するか
 *  - ローテーションが5時代を1回ずつ含むか
 *  - アーク・カードデッキが全時代ぶんあるか
 *  - 糸が参照する人物が実在するか
 *  - 推し軸・一人称・締めの型が5人で重複していないか
 *  - Persona Snapshot が追記のみで、番号が飛んでいないか
 *  - 配っているペルソナが、実在する Snapshot を指しているか
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import type { ZodTypeAny } from 'zod';

import {
  ERA_IDS,
  CHARACTER_IDS,
  ERA_PROTAGONIST,
  ErasFileSchema,
  RotationFileSchema,
  EraCanonFileSchema,
  ArcFileSchema,
  CardDeckFileSchema,
  ThreadsFileSchema,
} from '../src/schemas/world.js';
import {
  ProfileSchema,
  CanonSchema,
  CurrentStateSchema,
  RelationshipsSchema,
  MemoriesSchema,
} from '../src/schemas/character.js';
import { SeasonPlanSchema, BEATS, EPISODES_PER_SEASON } from '../src/schemas/season.js';
import { SnapshotSchema, SNAPSHOT_FILE } from '../src/schemas/snapshot.js';
import { PersonaManifestSchema } from '../src/schemas/manifest.js';
import { CalendarFileSchema, ClocksFileSchema } from '../src/schemas/world.js';
import { linearDay } from '../src/lib/calendar.js';
import { ja, isUntranslated } from '../src/lib/bilingual.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const problems: string[] = [];
/** 落とすほどではないが、黙って通してもいけないもの。未訳がこれである。 */
const notes: string[] = [];
let checked = 0;

function fail(where: string, message: string): void {
  problems.push(`${where}: ${message}`);
}

function load<T>(path: string, schema: ZodTypeAny, label: string): T | null {
  const rel = relative(ROOT, path);
  if (!existsSync(path)) {
    fail(rel, `${label} が存在しません`);
    return null;
  }
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(rel, `YAML を解析できません — ${(error as Error).message}`);
    return null;
  }
  const result = schema.safeParse(raw);
  checked += 1;
  if (!result.success) {
    for (const issue of result.error.issues) {
      const at = issue.path.length ? issue.path.join('.') : '(root)';
      fail(rel, `${at} — ${issue.message}`);
    }
    return null;
  }
  return result.data as T;
}

// ── world/canon ────────────────────────────────────────────────

const eras = load<{ eras: Array<Record<string, unknown>> }>(
  join(ROOT, 'world/canon/eras.yaml'),
  ErasFileSchema,
  '時代の定義',
);

if (eras) {
  const ids = eras.eras.map((e) => e.id as string);
  for (const id of ERA_IDS) {
    if (!ids.includes(id)) fail('world/canon/eras.yaml', `時代 ${id} がありません`);
  }
  for (const era of eras.eras) {
    const id = era.id as (typeof ERA_IDS)[number];
    const expected = ERA_PROTAGONIST[id];
    if (era.protagonist !== expected) {
      fail(
        'world/canon/eras.yaml',
        `${id} の主人公は ${expected} のはずですが ${String(era.protagonist)} になっています`,
      );
    }
  }
  const orders = eras.eras.map((e) => e.order as number).sort((a, b) => a - b);
  if (orders.join(',') !== '1,2,3,4,5') {
    fail('world/canon/eras.yaml', `order が 1..5 の一意な値になっていません（${orders.join(',')}）`);
  }
}

const rotation = load<{ order: string[] }>(
  join(ROOT, 'world/canon/rotation.yaml'),
  RotationFileSchema,
  'ローテーション',
);

if (rotation) {
  const unique = new Set(rotation.order);
  if (unique.size !== 5) {
    fail('world/canon/rotation.yaml', 'ローテーションは5時代を1回ずつ含む必要があります');
  }
}

for (const era of ERA_IDS) {
  const canon = load<{ era: string }>(
    join(ROOT, `world/canon/${era}.yaml`),
    EraCanonFileSchema,
    `${era} の canon`,
  );
  if (canon && canon.era !== era) {
    fail(`world/canon/${era}.yaml`, `era フィールドが ${canon.era} になっています`);
  }
}

// ── world/arcs ─────────────────────────────────────────────────

const arcEras = new Set<string>();
for (const file of readdirSync(join(ROOT, 'world/arcs')).filter((f) => f.endsWith('.yaml'))) {
  const arc = load<{ era: string; protagonist: string }>(
    join(ROOT, 'world/arcs', file),
    ArcFileSchema,
    'アーク',
  );
  if (!arc) continue;
  arcEras.add(arc.era);
  const expected = ERA_PROTAGONIST[arc.era as (typeof ERA_IDS)[number]];
  if (arc.protagonist !== expected) {
    fail(`world/arcs/${file}`, `${arc.era} の主人公は ${expected} のはずです`);
  }
}
for (const era of ERA_IDS) {
  if (!arcEras.has(era)) fail('world/arcs', `${era} のアークがありません`);
}

// ── world/cards ────────────────────────────────────────────────

for (const era of ERA_IDS) {
  const deck = load<{ era: string; cards: Array<{ id: string }> }>(
    join(ROOT, `world/cards/${era}.yaml`),
    CardDeckFileSchema,
    `${era} のイベントカード`,
  );
  if (!deck) continue;
  const ids = deck.cards.map((c) => c.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length) {
    fail(`world/cards/${era}.yaml`, `カード ID が重複しています: ${[...new Set(dupes)].join(', ')}`);
  }
}

// ── characters ─────────────────────────────────────────────────

const profiles = new Map<string, Record<string, any>>();
const knownPeople = new Set<string>(CHARACTER_IDS);

for (const id of CHARACTER_IDS) {
  const dir = join(ROOT, 'characters', id);

  const profile = load<Record<string, any>>(
    join(dir, 'profile.yaml'),
    ProfileSchema,
    `${id} の profile`,
  );
  if (profile) {
    profiles.set(id, profile);
    if (profile.id !== id) fail(`characters/${id}/profile.yaml`, `id が ${profile.id} になっています`);
    if (ERA_PROTAGONIST[profile.era as (typeof ERA_IDS)[number]] !== id) {
      fail(`characters/${id}/profile.yaml`, `era ${profile.era} の主人公は ${id} ではありません`);
    }
  }

  load(join(dir, 'canon.yaml'), CanonSchema, `${id} の canon`);
  load(join(dir, 'current-state.yaml'), CurrentStateSchema, `${id} の current-state`);
  load(join(dir, 'memories.yaml'), MemoriesSchema, `${id} の memories`);

  const rel = load<{ people: Array<{ id: string }> }>(
    join(dir, 'relationships.yaml'),
    RelationshipsSchema,
    `${id} の relationships`,
  );
  if (rel) {
    for (const person of rel.people) {
      if (person.id === id) {
        fail(`characters/${id}/relationships.yaml`, '自分自身を関係先にできません');
      }
      knownPeople.add(person.id);
    }
  }
}

// ── 5人が重ならないこと（設計上の検収条件） ───────────────────

/**
 * 5人が重ならないことを見る。
 *
 * 値は `ja()` へ落としてから比べる。二言語の欄は `{ ja, en }` の**オブジェクト**で
 * 来るので、そのまま Map の鍵にすると参照が毎回違い、重複が永久に見つからない。
 */
function assertDistinct(field: string, pick: (p: Record<string, any>) => unknown): void {
  const seen = new Map<string, string>();
  for (const [id, profile] of profiles) {
    const value = ja(pick(profile) as string | { ja: string; en: string });
    const owner = seen.get(value);
    if (owner) {
      fail('characters', `${field} が ${owner} と ${id} で重複しています（${value}）`);
    }
    seen.set(value, id);
  }
}

if (profiles.size === CHARACTER_IDS.length) {
  assertDistinct('一人称', (p) => p.voice.first_person);
  assertDistinct('締めの型', (p) => p.voice.closing);
  assertDistinct('推し軸', (p) => p.appeal_axis);
  assertDistinct('ファンとの距離感', (p) => p.reader_distance);
  assertDistinct('アイテムへの問い', (p) => p.appraisal.question);

  const ages = [...profiles.values()].map((p) => p.age as number);
  if (new Set(ages).size !== ages.length) {
    fail('characters', `年齢が重複しています（${ages.join(', ')}）`);
  }
}

// ── world/canon/calendar.yaml と world/clocks.yaml ─────────────

load(join(ROOT, 'world/canon/calendar.yaml'), CalendarFileSchema, '暦');

const clocks = load<{ clocks: Array<{ era: string; year: number | null }> }>(
  join(ROOT, 'world/clocks.yaml'),
  ClocksFileSchema,
  '時計',
);

if (clocks) {
  const eras = new Set(clocks.clocks.map((c) => c.era));
  for (const era of ERA_IDS) {
    if (!eras.has(era)) fail('world/clocks.yaml', `時代 ${era} の時計がありません`);
  }
  for (const clock of clocks.clocks) {
    // 年の数え方は時代ごとの canon。primordial は数えず、convergence は終わらない。
    if (clock.era === 'primordial' && clock.year !== null) {
      fail('world/clocks.yaml', 'primordial の year は null（サナ氏族は年を数えない）');
    }
    if (clock.era !== 'primordial' && clock.year === null) {
      fail('world/clocks.yaml', `${clock.era} の year が null です`);
    }
    if (clock.era === 'convergence' && clock.year !== 4217) {
      fail('world/clocks.yaml', `convergence の year は 4217 のまま変わりません（いま ${clock.year}）`);
    }
  }
}

// ── world/seasons ──────────────────────────────────────────────
// 計画は人間が読んで直すファイルなので、直したものが壊れていないかを見る。

const seasonsRoot = join(ROOT, 'world/seasons');
if (existsSync(seasonsRoot)) {
  const seasonDirs = readdirSync(seasonsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const dir of seasonDirs) {
    const seasonDir = join(seasonsRoot, dir);
    for (const file of readdirSync(seasonDir).filter((f) => f.endsWith('.yaml'))) {
      const rel = `world/seasons/${dir}/${file}`;
      const plan = load<{
        season: number;
        era: string;
        protagonist: string;
        episodes: Array<{ number: number; beat: string }>;
      }>(join(seasonDir, file), SeasonPlanSchema, '季の計画');
      if (!plan) continue;

      const era = file.replace(/\.yaml$/, '');
      if (plan.era !== era) {
        fail(rel, `era が ${plan.era} になっています（ファイル名は ${era}）`);
      }
      if (plan.season !== Number(dir)) {
        fail(rel, `season が ${plan.season} になっています（ディレクトリは ${dir}）`);
      }
      const expected = ERA_PROTAGONIST[era as (typeof ERA_IDS)[number]];
      if (expected && plan.protagonist !== expected) {
        fail(rel, `${era} の主人公は ${expected} のはずです`);
      }

      const numbers = plan.episodes.map((e) => e.number);
      const wanted = Array.from({ length: EPISODES_PER_SEASON }, (_, i) => i + 1);
      if (numbers.join(',') !== wanted.join(',')) {
        fail(rel, `話番号が 1..${EPISODES_PER_SEASON} の順になっていません（${numbers.join(',')}）`);
      }
      // 発端 → 展開 → 転機 → 危機 → 決着 の並びは崩さない。
      const beats = plan.episodes.map((e) => e.beat);
      if (beats.join(',') !== BEATS.join(',')) {
        fail(rel, `beat の並びが ${BEATS.join(' → ')} になっていません`);
      }

      // 日付は単調非減少で、季の中で年をまたがない。
      const typed = plan as unknown as {
        year_in_world: number | null;
        episodes: Array<{ number: number; world_date: { month: number; day: number } }>;
      };
      let previousDay = -1;
      for (const episode of typed.episodes) {
        const current = linearDay(episode.world_date);
        if (current < previousDay) {
          fail(rel, `第${episode.number}話の日付が前の話より過去です`);
        }
        previousDay = current;
      }
      if (era === 'primordial' && typed.year_in_world !== null) {
        fail(rel, 'primordial の year_in_world は null です');
      }
      if (era === 'convergence' && typed.year_in_world !== 4217) {
        fail(rel, 'convergence の year_in_world は 4217 です');
      }
    }
  }
}

// ── characters/*/snapshots ─────────────────────────────────────
// PixTale はここをバージョン固定で読む。追記のみで、番号は飛ばない。
// 番号が飛べば、向こうのピンが存在しないファイルを指しうる。

for (const id of CHARACTER_IDS) {
  const dir = join(ROOT, 'characters', id, 'snapshots');
  if (!existsSync(dir)) continue;

  const versions: number[] = [];
  for (const file of readdirSync(dir)) {
    const match = SNAPSHOT_FILE.exec(file);
    if (!match) continue; // README.md など

    const rel = `characters/${id}/snapshots/${file}`;
    const version = Number(match[1]);
    versions.push(version);

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch (error) {
      fail(rel, `JSON を解析できません — ${(error as Error).message}`);
      continue;
    }
    const result = SnapshotSchema.safeParse(raw);
    checked += 1;
    if (!result.success) {
      for (const issue of result.error.issues) {
        fail(rel, `${issue.path.length ? issue.path.join('.') : '(root)'} — ${issue.message}`);
      }
      continue;
    }
    if (result.data.version !== version) {
      fail(rel, `version が ${result.data.version} になっています（ファイル名は v${match[1]}）`);
    }
    if (result.data.character !== id) {
      fail(rel, `character が ${result.data.character} になっています`);
    }
  }

  versions.sort((a, b) => a - b);
  const wanted = versions.map((_, i) => i + 1);
  if (versions.join(',') !== wanted.join(',')) {
    fail(
      `characters/${id}/snapshots`,
      `バージョンが 1.. の連番になっていません（${versions.join(', ')}）`,
    );
  }
}

// ── world/personas.json ────────────────────────────────────────
// PixTale が最初に取りに来る1枚。ここが実在しないファイルを指すと、
// こちらの CI が緑のまま向こうが 404 を踏む。

{
  const path = join(ROOT, 'world/personas.json');
  const manifest = load<{
    personas: Record<string, { character: string; version: number; path: string }>;
  }>(path, PersonaManifestSchema, '配っているペルソナ');

  if (manifest) {
    for (const [id, entry] of Object.entries(manifest.personas)) {
      if (entry.character !== id) {
        fail('world/personas.json', `${id} の character が ${entry.character} になっています`);
      }
      if (!existsSync(join(ROOT, entry.path))) {
        fail('world/personas.json', `${id} が指す ${entry.path} が存在しません`);
      }
      const expected = `characters/${id}/snapshots/v${String(entry.version).padStart(4, '0')}.json`;
      if (entry.path !== expected) {
        fail('world/personas.json', `${id} の path と version が食い違っています（${entry.path}）`);
      }
    }
  }
}

// ── world/threads ──────────────────────────────────────────────

const threads = load<{ threads: Array<{ id: string; touches: Array<{ who: string | null }> }> }>(
  join(ROOT, 'world/threads/cross-era.yaml'),
  ThreadsFileSchema,
  '時代を跨ぐ糸',
);

if (threads) {
  // 糸が参照する人物のうち、キャラクターらしき ID は実在を確認する。
  // 組織・制度（grand-court など）は canon 側にあるので、ここでは人物だけを見る。
  const peopleRefs = new Set(
    threads.threads.flatMap((t) => t.touches.map((x) => x.who).filter((w): w is string => !!w)),
  );
  for (const ref of peopleRefs) {
    if (!knownPeople.has(ref) && !ref.includes('-')) {
      fail('world/threads/cross-era.yaml', `人物 ${ref} が characters/ に存在しません`);
    }
  }
}

// ── 未訳の棚卸し ───────────────────────────────────────────────
// サイトは 1言語 = 1 URL で、訳の無い欄は `/velum/en/` に日本語のまま出る。
// 落とさないのは、生成した直後の季がまだ訳されていないのは正常だからである。
// ただし黙って通すと、そのまま公開ページに残る——数えて見せる。

{
  const untranslated: string[] = [];

  if (existsSync(seasonsRoot)) {
    for (const dir of readdirSync(seasonsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()) {
      for (const file of readdirSync(join(seasonsRoot, dir)).filter((f) => f.endsWith('.yaml'))) {
        const raw = parse(readFileSync(join(seasonsRoot, dir, file), 'utf8'));
        const result = SeasonPlanSchema.safeParse(raw);
        if (!result.success) continue; // スキーマ違反は上で報告済み

        const plan = result.data;
        const rel = `world/seasons/${dir}/${file}`;
        if (isUntranslated(plan.title)) untranslated.push(`${rel}: title`);
        if (isUntranslated(plan.shape)) untranslated.push(`${rel}: shape`);
        for (const episode of plan.episodes) {
          if (isUntranslated(episode.leaves_open)) {
            untranslated.push(`${rel}: 第${episode.number}話 leaves_open`);
          }
        }
      }
    }
  }

  if (untranslated.length) {
    notes.push(
      `英語ページに日本語のまま出る欄が ${untranslated.length} 件あります（docs/seasons.md §10）:`,
      ...untranslated.map((line) => `  ${line}`),
    );
  }
}

// ── 結果 ───────────────────────────────────────────────────────

if (problems.length) {
  console.error(`\n✗ ${problems.length} 件の問題が見つかりました\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error('');
  process.exit(1);
}

console.log(`✓ ${checked} ファイルを検証しました。問題ありません。`);
console.log(`  時代 ${ERA_IDS.length} / 主人公 ${CHARACTER_IDS.length} / 登場人物 ${knownPeople.size}`);

if (notes.length) {
  console.log('');
  console.log('未訳:');
  for (const note of notes) console.log(`  ${note}`);
}
