import { relative } from 'node:path';
import { ROOT, manifestPath, snapshotPath } from '../lib/paths.js';
import { readJson, writeJson, exists } from '../lib/storage.js';
import {
  PersonaManifestSchema,
  MANIFEST_NOTE,
  type PersonaManifest,
} from '../schemas/manifest.js';
import type { Snapshot } from '../schemas/snapshot.js';

const EMPTY: PersonaManifest = {
  updated_at: null,
  season: null,
  note: MANIFEST_NOTE,
  personas: {},
};

export function readManifest(): PersonaManifest {
  return exists(manifestPath())
    ? readJson(manifestPath(), PersonaManifestSchema)
    : EMPTY;
}

/**
 * 配る。**作ることとは別の操作である。**
 *
 * Snapshot を書いただけでは PixTale の出力は変わらない。ここを通って初めて変わる。
 * 分けてある理由は、仕様§7 の本丸——「笑いを殺していないか」——が自動で判定できないからで、
 * 人が読んでから配るか、読まずに配るかを、この関数を呼ぶか呼ばないかで選べるようにしてある。
 *
 * コンパイルに失敗した人物は、ここへ来ない。その人物のピンは前のままで、
 * PixTale はその人格を語り続ける。ピンは人物ごとに独立している。
 */
export function publish(
  snapshots: Snapshot[],
  now: string,
  season: number | null,
): PersonaManifest {
  const manifest = nextManifest(readManifest(), snapshots, now, season);
  writeJson(manifestPath(), manifest);
  return manifest;
}

/**
 * 次のマニフェストを組み立てる。書き込みはしない。
 *
 * 分けてあるのは、テストが world/personas.json を書き換えずに済むようにするため。
 * 配るという操作はファイル1枚の書き換えなので、その中身の決まり方だけを取り出せる。
 */
export function nextManifest(
  current: PersonaManifest,
  snapshots: Snapshot[],
  now: string,
  season: number | null,
): PersonaManifest {
  const manifest = structuredClone(current);

  for (const snapshot of snapshots) {
    manifest.personas[snapshot.character] = {
      character: snapshot.character,
      era: snapshot.era,
      version: snapshot.version,
      path: relative(ROOT, snapshotPath(snapshot.character, snapshot.version)),
      diaries: snapshot.source.diaries,
      through: snapshot.source.through,
      published_at: now,
    };
  }

  manifest.updated_at = now;
  if (season !== null) manifest.season = season;
  manifest.note = MANIFEST_NOTE;

  return PersonaManifestSchema.parse(manifest);
}

/** まだ誰も配っていない状態。 */
export const emptyManifest = (): PersonaManifest => structuredClone(EMPTY);
