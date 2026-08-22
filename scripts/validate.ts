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

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const problems: string[] = [];
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

function assertDistinct(field: string, pick: (p: Record<string, any>) => string): void {
  const seen = new Map<string, string>();
  for (const [id, profile] of profiles) {
    const value = pick(profile);
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

// ── 結果 ───────────────────────────────────────────────────────

if (problems.length) {
  console.error(`\n✗ ${problems.length} 件の問題が見つかりました\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error('');
  process.exit(1);
}

console.log(`✓ ${checked} ファイルを検証しました。問題ありません。`);
console.log(`  時代 ${ERA_IDS.length} / 主人公 ${CHARACTER_IDS.length} / 登場人物 ${knownPeople.size}`);
