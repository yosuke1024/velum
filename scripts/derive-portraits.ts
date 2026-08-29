#!/usr/bin/env tsx
/**
 * 肖像 512×512 を characters/<id>/sheet.png から派生させる。
 *
 *   npm run portraits              5人ぶん world/feed/portraits/ へ
 *   npm run portraits -- teo       ひとりだけ
 *
 * 切り出し位置は profile.yaml の `visual.portrait`（{x, y, size}、sheet.png の
 * ピクセル座標）。シートを描き直したら、座標を合わせ直してから再実行する。
 *
 * 日次 cron はこれを回さない——肖像の更新契機は「シートが変わったとき」だけで、
 * 派生した PNG はコミットされた配布物である（契約 §1.1: 更新契機「変更時」）。
 *
 * サイズ上限 200KB は契約の値。palette 化（256色）で illustration はよく縮む。
 * 上限を超えたら、ここで落とす——validate まで運ばない。
 */

import { charPath, feedPortraitPath } from '../src/lib/paths.js';
import { readYaml } from '../src/lib/storage.js';
import { ProfileSchema } from '../src/schemas/character.js';
import { CHARACTER_IDS } from '../src/schemas/world.js';
import { FEED_SIZE_LIMITS, PORTRAIT_SIZE } from '../src/schemas/feed.js';
import sharp from 'sharp';

const named = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const targets = named.length ? named : [...CHARACTER_IDS];

for (const id of targets) {
  if (!(CHARACTER_IDS as readonly string[]).includes(id)) {
    console.error(`✗ ${id} という主人公はいません（${CHARACTER_IDS.join(', ')}）`);
    process.exit(1);
  }
}

async function derive(id: string): Promise<void> {
  const profile = readYaml(charPath(id, 'profile.yaml'), ProfileSchema);
  const crop = profile.visual.portrait;
  if (!crop) {
    throw new Error(`characters/${id}/profile.yaml に visual.portrait がありません`);
  }

  const sheet = charPath(id, 'sheet.png');
  const meta = await sharp(sheet).metadata();
  if (
    crop.x + crop.size > (meta.width ?? 0) ||
    crop.y + crop.size > (meta.height ?? 0)
  ) {
    throw new Error(
      `${id} の切り出し（x=${crop.x}, y=${crop.y}, size=${crop.size}）が` +
        ` sheet.png（${meta.width}×${meta.height}）からはみ出しています`,
    );
  }

  const out = feedPortraitPath(id);
  const cropped = sharp(sheet)
    .extract({ left: crop.x, top: crop.y, width: crop.size, height: crop.size })
    .resize(PORTRAIT_SIZE, PORTRAIT_SIZE);

  // 上限に収まる最高品質を使う。絵柄によって palette 化の縮み方が違うので、
  // 品質を段階的に落として最初に収まったものを採る。
  let buffer: Buffer | null = null;
  let used = 0;
  for (const quality of [90, 80, 70, 60, 50]) {
    const candidate = await cropped
      .clone()
      .png({ compressionLevel: 9, palette: true, quality })
      .toBuffer();
    if (candidate.byteLength <= FEED_SIZE_LIMITS.portrait) {
      buffer = candidate;
      used = quality;
      break;
    }
  }
  if (!buffer) {
    throw new Error(
      `${id} の肖像が品質 50 でも上限 ${FEED_SIZE_LIMITS.portrait} bytes に収まりません`,
    );
  }

  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, buffer);

  console.log(
    `✓ ${id.padEnd(6)} → world/feed/portraits/${id}.png ` +
      `（${Math.round(buffer.byteLength / 1024)}KB, 品質 ${used}, ` +
      `切り出し x=${crop.x} y=${crop.y} size=${crop.size}）`,
  );
}

for (const id of targets) {
  await derive(id);
}
