import { z } from 'zod';
import { CharacterId, EraId } from './world.js';

/**
 * いま配っているペルソナ。**PixTale が最初に取りに来る1枚。**
 *
 * ピンを PixTale 側ではなく velum 側に置く。理由は2つある。
 *
 * ひとつは、公開ファイルを raw で取る方式ではディレクトリ一覧が取れないこと。
 * これがなければ、向こうは v0007.json を直接叩くしかなく、v0008 が出たことに気づけない。
 *
 * もうひとつは、戻し方である。人格が変になったとき、直すのは PixTale の
 * デプロイではなく、このファイルの数字ひとつになる。
 *
 *   PixTale: personas.json を短い TTL で取得
 *              → version の指す Snapshot を取得
 *              → KV へ長い TTL でキャッシュ
 *
 * 季の終わりに新しい Snapshot が書かれても、**ここが動かないかぎり
 * PixTale の出力は1文字も変わらない。** 配ることと、作ることは別の操作である。
 */
export const PersonaManifestSchema = z.object({
  updated_at: z.string().nullable(),
  /** ここまでの季が反映されている、という目印。null は未公開。 */
  season: z.number().int().min(1).nullable(),
  note: z.string(),
  personas: z.record(
    z.object({
      character: CharacterId,
      era: EraId,
      version: z.number().int().min(1),
      /** リポジトリ root からの相対パス。PixTale はこれをそのまま取りに来る。 */
      path: z.string().min(1),
      /** この人格が何本の日記から圧縮されたか。ピンを戻す判断の材料。 */
      diaries: z.number().int().min(0),
      through: z.string().nullable(),
      published_at: z.string(),
    }),
  ),
});

export type PersonaManifest = z.infer<typeof PersonaManifestSchema>;

export const MANIFEST_NOTE =
  'PixTale はこのファイルを読み、version の指す Snapshot を取得する。' +
  '人格を戻すときは version を以前の番号へ書き換える（ファイルは追記のみなので消えていない）。';
