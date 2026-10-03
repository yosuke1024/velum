# feed フィクスチャ（PixTale S5 の UI 開発用）

`world/feed/` の**完全な複製**に、ダミー日記6本とダミー Story を足したもの。
pixapps 側の Diary/World UI（rollout S5）が、実データの日記が存在しない期間
（velum の稼働開始は 2026-09-01）でも全状態を作れるように、また Stories UI が
本物の Story が1本も公開されていない期間でも全状態を作れるようにするための一式である。

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
| `world/feed/stories/index.json` / `riko-s01.json` / `teo-s01.json` | **ダミーの Story**（下記）。`tests/fixtures/stories/` から `npm run export:feed -- --fixtures` が生成 |

ダミー日記の日付はすべて **2026-09-01 より前**。実データの日記はその日以降に
しか存在しないので、日付を見ればダミーだと分かる。本番の feed
（`world/feed/`）にダミーは決して混ぜない。

## Story のフィクスチャ

`world/feed/stories/` に、Character Story の配布面（[docs/stories.md](../../../docs/stories.md) §6）
の見本がある。

| パス | 中身 |
|---|---|
| `world/feed/stories/index.json` | riko と teo の公開済みの季の一覧（本文なし） |
| `world/feed/stories/riko-s01.json` | ダミーの riko-s01。**公開済みの e01〜e03** だけが載っている |
| `world/feed/stories/teo-s01.json` | ダミーの teo-s01。公開済みの 2 話 |

素材は `tests/fixtures/stories/`（`characters/<id>/stories/s01/` の形）にある。そこでは
riko-s01 が **e01〜e03 published / e04 reviewed / e05 draft**、teo-s01 が 2 話 published
で、feed へ出るのは published の話だけであることを確かめるために、状態を混ぜてある。
feed の `riko-s01.json` に e04・e05 が無いのは、そのためである。

使い方は上と同じ。`npx serve tests/fixtures/feed` して、アプリの
`NEXT_PUBLIC_VELUM_FEED_BASE_URL=http://localhost:3000/` を向ける。
index は `http://localhost:3000/world/feed/stories/index.json`、各季の `path` も同じ
相対パス構造（`world/feed/stories/<series-id>.json`）を指す。

**本文は短いテスト用のダミーで、本物の Season ではない。** 本文・要約・解放条件
（`required_progress`）はアプリの UI の状態（ロック・解放・読了）を作るための値で、
実際のリコ第1季（`characters/riko/stories/s01/`）とは別物である。季の題と最初の
3話の題は、見本として本物の第1季の仮題を借りているが、本文は書き上がった物語ではない。
実データの Story は `world/feed/stories/`（本番。公開が無い間は `"characters": {}`）に
しか置かない。本番の feed にダミーは決して混ぜない。

## 更新

- プロフィール・時代・肖像が変わったら: `npm run export:feed -- --fixtures`
- ダミー日記を足す/直すときは `entries/` の JSON を編集してから同コマンド
  （`diary.json` が作り直される）。スキーマは `tests/unit/feed-fixtures.test.ts` が守る。
- ダミー Story を足す/直すときは `tests/fixtures/stories/` の manifest と本文を編集してから
  同コマンド（`world/feed/stories/` が作り直される）。`npm run export:feed -- --fixtures` は
  フィクスチャ側だけを書き換え、本番の `world/feed/` には触れない。
