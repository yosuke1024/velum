# feed フィクスチャ（PixTale S5 の UI 開発用）

`world/feed/` の**完全な複製**に、ダミー日記6本を足したもの。
pixapps 側の Diary/World UI（rollout S5）が、実データの日記が存在しない期間
（velum の稼働開始は 2026-09-01）でも全状態を作れるようにするための一式である。

## 使い方

このディレクトリを静的サーバの根として配信し、アプリの
`NEXT_PUBLIC_VELUM_FEED_BASE_URL` をそこへ向ける:

```bash
npx serve tests/fixtures/feed   # http://localhost:3000/world/feed/diary.json
```

本番の base URL（`https://raw.githubusercontent.com/yosuke1024/velum/main/`）と
同じパス構造（`world/feed/...`）なので、アプリ側のコードは切り替え不要。
JSON 内の `path` フィールドも同じ相対パスを指す。

## 中身

| ファイル | 由来 |
|---|---|
| `world/feed/characters.json` / `lore.json` / `portraits/*` | 実データ（`npm run export:feed -- --fixtures` が再生成） |
| `world/feed/entries/*.json` | **手書きのダミー日記**（このディレクトリが素材の正） |
| `world/feed/diary.json` | ダミー日記から自動生成 |

ダミー日記の日付はすべて **2026-09-01 より前**。実データの日記はその日以降に
しか存在しないので、日付を見ればダミーだと分かる。本番の feed
（`world/feed/`）にダミーは決して混ぜない。

## 更新

- プロフィール・時代・肖像が変わったら: `npm run export:feed -- --fixtures`
- ダミー日記を足す/直すときは `entries/` の JSON を編集してから同コマンド
  （`diary.json` が作り直される）。スキーマは `tests/unit/feed-fixtures.test.ts` が守る。
