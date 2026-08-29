# Diary/World feed と World Appraisal Snapshot

PixTale 2.0 へ渡す2つ目・3つ目の配布面。契約の正は pixapps 側
`docs/current/pixtale_v2_contracts.md`（§1 feed / §2 World Appraisal）で、
このドキュメントは velum 側の実装の説明である。

**実装状況:** S4 で実装済み（2026-08-29）。feed は日次 cron が更新、
World Appraisal は季末に手動でコンパイル・publish する。

---

## 1. 3つの配布面と、その読み手

```text
world/feed/        → PixTale アプリが raw GitHub で直接読む（唯一アプリ直の面）
world/appraisal/   → PixTale プロキシがピン経由で読む
characters/*/snapshots/ → 同上（Persona Snapshot。docs/persona-snapshot.md）
```

ピンは3面とも `world/personas.json` の1枚に統合されている。S4 で
`world`（World Appraisal の版）と `default_companion`（既定の同行者 = teo）を
additive に足した。**フィールドの削除・改名はしない**——この規約が
リポジトリ間の互換のすべてである。

## 2. world/feed/ の中身

| パス | 用途 | 更新契機 | 上限 |
|---|---|---|---|
| `characters.json` | World タブ・同行者選択 | プロフィール変更時 | 64KB |
| `lore.json` | 時代の要約と世界法則 | canon 変更時 | 64KB |
| `diary.json` | 日記一覧（最新90件・新しい順） | 日次 cron | 200KB |
| `entries/<date>-<id>.json` | 日記全文。発行後は不変 | 生成時1回 | 32KB |
| `portraits/<id>.png` | 肖像 512×512 | シート変更時 | 200KB |

書き出しは `npm run export:feed`（日次 cron の generate と validate の間）。
**内容が変わらない日はファイルが動かない**——`generated_at` だけの差は
「変わった」と数えず、書かない。raw の ETag を無意味に揺らさないためである。

素材との対応:

- `characters.json` … `profile.yaml` の公開欄 + S4 で書いた `intro`。
  `default_companion_id` はピンの転記
- `lore.json` … `eras.yaml` の `summary`（S4 で執筆）+ `world/canon/laws.yaml`
- `diary.json` / `entries/` … `characters/*/entries/`（内部形式）からの変換。
  `excerpt` は内部の `quote` の転用。本文は `diaries/*.md` から

## 3. 秘匿情報は feed に入らない

`core.secret_hidden`・`core.secret_unknown_to_self`・
`relationships[].hidden_from_protagonist` は feed のどの欄にも現れない。
三重に守っている:

1. **型** — feed のビルダー（`src/export/feed.ts`）がそもそも参照しない
2. **検証** — `npm run validate` が書き出したバイト列を断片照合で検査する
   （`src/lib/secrets.ts`。文単位に割った断片で見るので、一文だけの漏れも捕まる）
3. **テスト** — ビルダー出力とフィクスチャに同じ照合を当てる

`intro`（紹介文）と `summary`（時代要約）は S4 で書いた公開文で、
秘密の「外側」だけを書く。書き換えたら validate が混入を見張る。

## 4. 肖像の派生

`npm run portraits` が `characters/<id>/sheet.png` から 512×512 を切り出す。
切り出し座標は `profile.yaml` の `visual.portrait`（`{x, y, size}`、シートの
ピクセル座標）。シートを描き直したら、座標を合わせてから再実行する。
日次 cron は肖像に触らない——更新契機は「シートが変わったとき」だけ。

上限 200KB は palette 化（256色）で守る。収まらない絵柄では品質を
段階的に落とし、それでも溢れたらスクリプトが止まる。

## 5. World Appraisal Snapshot

カード鑑定のプロンプトに注入する「世界の圧縮」。`world/appraisal/vNNNN.json`
（追記のみ・連番・上書き禁止・12KB 以下・日本語単一）。

**生成を経ない。すべて canon からの射影である。**

- `laws` / `expression_rules` … `world/canon/laws.yaml`
- 時代ごとの `profile / values / taboos / events / absent` …
  各 `world/canon/<era>.yaml` の `appraisal:` 欄（手書き）
- `terms` … institutions / places / cities / observances の**名前だけ**。
  note は持ち込まない（読者だけが知る注記が混ざりうるため）

```bash
npm run appraisal               # 次の版をコンパイル（配らない）
npm run appraisal -- --publish  # コンパイルして、ピンも立てる
```

Persona Snapshot と同じ規律——**作ることと配ることは別**。更新は季末に
Persona と同時で、日次では回さない。内容が最新版と同じなら、版は増えない。

## 6. フィクスチャ（pixapps S5 用）

`tests/fixtures/feed/` に feed の完全な複製 + ダミー日記6本。実データの
日記が存在しない期間（稼働開始 2026-09-01 より前）に、pixapps 側が
Diary/World UI の全状態を作るためのもの。使い方は同ディレクトリの README。

## 7. 変えてよいもの / いけないもの

- 変えてよい: velum 内部のファイル構造・内部スキーマ（feed は毎回射影し直す）
- 増やしてよい: feed / appraisal / ピンのフィールド（additive）
- **いけない**: `world/feed/` 配下のパス構造、既存フィールドの削除・改名、
  発行済み `entries/*` と `appraisal/v*` の書き換え、era ID の変更
