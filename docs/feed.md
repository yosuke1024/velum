# Diary/World feed・Story feed・World Appraisal Snapshot

PixTale 2.0 へ渡す配布面のうち、Persona Snapshot 以外の3つ。契約の正は pixapps 側
`docs/current/pixtale_v2_contracts.md`（§1 feed / §2 World Appraisal）で、
このドキュメントは velum 側の実装の説明である。

**実装状況:** Diary/World feed と World Appraisal は S4 で実装済み（2026-08-29）。
Story feed（`world/feed/stories/`）は 2026-10-03 に追加した（[stories.md](stories.md)）。

**更新の契機（2026-10-03 以降）:** 日次 cron は止めた。feed は**手動で
`npm run export:feed` を回し、PR にコミットする**。World Appraisal も人が読んで
から手動でコンパイル・publish する。日記（`diary.json` / `entries/`）の更新は
cron とともに止まっており、Archive として凍結している（§2）。

---

## 1. 配布面と、その読み手

```text
world/feed/            → PixTale アプリが raw GitHub で直接読む（アプリ直の面）
world/feed/stories/    → 同上（Character Story。docs/stories.md）
world/appraisal/       → PixTale プロキシがピン経由で読む
characters/*/snapshots/ → 同上（Persona Snapshot。docs/persona-snapshot.md）
```

ピンは3面とも `world/personas.json` の1枚に統合されている。S4 で
`world`（World Appraisal の版）と `default_companion`（既定の同行者 = teo）を
additive に足した。**フィールドの削除・改名はしない**——この規約が
リポジトリ間の互換のすべてである。

## 2. world/feed/ の中身

| パス | 用途 | 更新契機 | 上限 |
|---|---|---|---|
| `characters.json` | World タブ・同行者選択 | プロフィール変更時（手動 export） | 64KB |
| `lore.json` | 時代の要約と世界法則 | canon 変更時（手動 export） | 64KB |
| `diary.json` | 日記一覧（最新90件・新しい順）。**Archive** | 凍結（2026-10-03 の cron 停止まで日次） | 200KB |
| `entries/<date>-<id>.json` | 日記全文。発行後は不変。**Archive** | 凍結（生成時1回だった） | 32KB |
| `portraits/<id>.png` | 肖像 512×512 | シート変更時（手動） | 200KB |
| `stories/index.json` | Story の一覧（人物ごとの公開済みの季と話。本文なし） | 手動 export（PR） | 64KB |
| `stories/<series-id>.json` | 1季ぶんの公開済みの全話（本文込み） | 手動 export（PR） | 256KB |

書き出しは `npm run export:feed`。**手動で回し、PR にコミットする**（cron は無い）。
`npm run validate`（CI）は、feed が素材と食い違っていると「素材と食い違っています」
で落ちるので、回し忘れた PR は main に入らない。
**内容が変わらなければファイルは動かない**——`generated_at` だけの差は
「変わった」と数えず、書かない。raw の ETag を無意味に揺らさないためである。

**日記（`diary.json` と `entries/`）は Archive である。** 2026-10-03 に日次 cron を
止めて以降、新しい日記は増えない。契約のパスは保ったまま、消さない
（Experimental Diary Season 1 / Archive）。アプリ側は、これらが今後更新されない
前提で読むこと。

`stories/` は diary feed と並列の面で、既存ファイルの形も `schema_version` も動かさない
（`STORIES_SCHEMA_VERSION` は別の定数）。**公開済み（季と話の両方が published）だけ**が載り、
`index.json` は公開が無くても書く（`characters: {}`）。形・revision・解放の規則・
export のガード（公開済みの話を消す変更は拒否）は [stories.md](stories.md) §5〜§7。

素材との対応:

- `characters.json` … `profile.yaml` の公開欄 + S4 で書いた `intro`。
  `default_companion_id` はピンの転記
- `lore.json` … `eras.yaml` の `summary`（S4 で執筆）+ `world/canon/laws.yaml`
- `diary.json` / `entries/` … `characters/*/entries/`（内部形式）からの変換。
  `excerpt` は内部の `quote` の転用。本文は `diaries/*.md` から（Archive）
- `stories/` … `characters/<id>/stories/s<NN>/` の `manifest.yaml` と本文からの射影。
  公開済みの話だけ（[stories.md](stories.md) §3〜§6）

## 3. 秘匿情報は feed に入らない

`core.secret_hidden`・`core.secret_unknown_to_self`・
`relationships[].hidden_from_protagonist` は feed のどの欄にも現れない。
三重に守っている:

1. **型** — feed のビルダー（`src/export/feed.ts`）がそもそも参照しない
2. **検証** — `npm run validate` が書き出したバイト列を断片照合で検査する
   （`src/lib/secrets.ts`。文単位に割った断片で見るので、一文だけの漏れも捕まる）
3. **テスト** — ビルダー出力とフィクスチャに同じ照合を当てる

**シリアライズした JSON だけを見ると、折り返された一文を見逃す。** JSON の中では
改行が `\n`（バックスラッシュと n の2文字）になり、空白を除いても残るので、
途中で折り返された秘密の一文は部分一致をすり抜ける。そのため feed の検査は、
**デコードした文字列の値にも**同じ照合を当てる。Story のソース（`characters/<id>/stories/` の
本文・manifest・plan・brief）は、draft を含めて同じ照合を通す。

Story の生成プロンプトには、`secret_unknown_to_self` と `hidden_from_protagonist` を入れない。
本人が知っている `secret_hidden` は、動機として使うだけで本文では明かさない、という指示つきで渡す。
ただしモデルが漏らす可能性も、人間が直した文章に混じる可能性もあるので、3つとも、生成した本文は
ゲートで、Story のソースと feed はすべて validate で照合する。

`intro`（紹介文）と `summary`（時代要約）は S4 で書いた公開文で、
秘密の「外側」だけを書く。書き換えたら validate が混入を見張る。

## 4. 肖像の派生

`npm run portraits` が `characters/<id>/sheet.png` から 512×512 を切り出す。
切り出し座標は `profile.yaml` の `visual.portrait`（`{x, y, size}`、シートの
ピクセル座標）。シートを描き直したら、座標を合わせてから再実行する。
肖像は自動では作り直さない——更新契機は「シートが変わったとき」だけ（手動）。

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

Persona Snapshot と同じ規律——**作ることと配ることは別**。更新は人が読んで
から手動で行い（日次 cron はもう無い）、自動では配らない。内容が最新版と同じなら、版は増えない。

## 6. フィクスチャ（pixapps S5 用）

`tests/fixtures/feed/` に feed の完全な複製 + ダミー日記6本 + ダミー Story
（`world/feed/stories/`。riko-s01 は published 3話、teo-s01 は 2話）。実データの
日記が存在しない期間（稼働開始 2026-09-01 より前）や、Story が1本も公開されて
いない期間に、pixapps 側が Diary/World UI と Stories UI の全状態を作るためのもの。
使い方は同ディレクトリの README。

## 7. 変えてよいもの / いけないもの

- 変えてよい: velum 内部のファイル構造・内部スキーマ（feed は毎回射影し直す）
- 増やしてよい: feed / appraisal / ピンのフィールド（additive）
- **いけない**: `world/feed/` 配下のパス構造、既存フィールドの削除・改名、
  発行済み `entries/*` と `appraisal/v*` の書き換え、era ID の変更、
  **公開済みの Story の話 ID の削除**（解放済みの話は端末に残り再ロックしないため。
  取り下げが必要なときだけ `--allow-withdraw` を付ける。[stories.md](stories.md) §7）
