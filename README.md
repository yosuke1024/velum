# Velum

**良い10話は、悪い100話に勝つ。**

Velum は PixTale の5人の同行者を育てる **Character Story Engine** です。AI によってキャラクターの物語を生成・構造化しますが、自動生成したものをそのまま公開しません。人間が選び、編集し、公開した Story だけが PixTale へ配信されます。

**成功の基準は、Story を読んだ人が「このキャラクターと一緒にいたい」「PixTale の同行者にしたい」と思うこと。** 世界観の完成度でも、生成の本数でもありません。

> World と Story は同行者を愛される存在にするために在り、PixTale は愛された同行者を連れて歩きます。

### なぜ作り直したのか

Velum は最初、**Autonomous Diary Generator** として始まりました。5人の主人公が毎日出来事を経験し、日記を書き、記憶と人格を蓄積していく——その全過程を公開する実験です。Season 1 の日記（2026-09-01〜）で、キャラクターを**識別できる**ところまでは届きました。しかし、**好きになれる**ところまでは届きませんでした。

そこで 2026-10-03、毎日の自動生成を止め、人物ごとに厳選して作る Story へ移りました。リコ（Riko）が最初の Pilot です。Season 1 の日記は消しません。**Experimental Diary Season 1 / Archive** として残し、失敗も、人間による修正も、等しく実験記録として公開し続けます。

---

## Story がどう作られ、どう公開されるか

```text
brief.md          人間の企画メモ（任意。この季で読者に残したいもの）
   ↓ npm run story:plan
plan.yaml         季の計画。人間が読んで直す
   ↓ npm run story:write
e01.ja.md / e01.en.md   AI の下書き（draft）
   ↓ 人間が読んで、直す          status: draft → reviewed
   ↓ 人間が公開を決める          status: reviewed → published
   ↓ npm run export:feed        手で回し、PR にコミットする
world/feed/stories/            PixTale が読む
```

- **生成 ≠ 公開。** 下書きは `draft` のまま公開されません。`reviewed` は「人間がこの本文を読んだ」の印で、`published` の話だけが feed に出ます。`story:write` は `published` に触れません。
- **1季は 8〜10 話。** 1話ごとに「読者にこの人の何を知ってほしいか」を決め、事件の起伏ではなく人物から組み立てます。形式（一人称・手紙・会話・記録・回想…）は話ごとに選べます。
- **解放は Journey Progress で。** PixTale で同行者と Scan を重ねるほど、その人物の次の話が読めるようになります。必要な進捗は話ごとに manifest が持ち、アプリには数字を持たせません。
- **cron はありません。** 毎日回る生成は止めました。export も PR の中で手で回します。

詳細は [docs/stories.md](docs/stories.md)。

---

## フィクションの開示

**このリポジトリの内容はすべてフィクションです。**

Velum という世界、そこに住む人物、彼らの物語と日記、その中で語られる出来事——いずれも実在しません。

- **Story** は AI（Cloudflare Workers AI 上の Gemma）が下書きし、**人間が選び、編集し、公開した**ものです。
- **Season 1 の日記**は AI が自動生成したもので、人間が選んで公開したものではありません。

どちらも人物の一人称で書かれていますが、そこに書かれた記憶・感情・意見は、実在の人物・団体・出来事とは一切関係ありません。

登場人物は自分をフィクションだと認識していません。それは演出であって、主張ではありません。

---

## 5つの時代と、5人の同行者

| 時代 | 年代 | 主人公 | 年齢 | アイテムへの問い |
|---|---|---|---|---|
| 原初の沈黙 | ~???–0 | [ウタ](characters/uta/) | 19 | これは何の兆しか |
| ギルドの時代 | 0–400 | [テオ](characters/teo/) | 16 | どう作られたか |
| 大収束 | 417 | [セヴラン](characters/sevran/) | 29 | 何が混ざったか |
| 破砕戦争 | 417–800 | [カヤ](characters/kaya/) | 26 | 誰が持っていたか |
| 静寂の時代 | 800–現在 | [リコ](characters/riko/) | 24 | まだ何ができるか |

各主人公には、関係を持つ人物が2人ずついます（全15人）。関係者は独立した主役を持たず、主人公から見た関係として管理されます。Story の人物も、この関係の中から出ます。

| 主人公 | 人物 | 関係 |
|---|---|---|
| ウタ | ガルド | 氏族の長。声を信じない現実主義者 |
| ウタ | レン | 幼馴染の狩人。唯一、証明を求めずに信じる |
| テオ | ヴァレン大鑑定官 | 師匠。直感を禁じた張本人 |
| テオ | ロウ | 兄。時折、院の門前に現れる |
| セヴラン | ミルテ | 収束の日に裂け目へ消えた同僚 |
| セヴラン | フム | 本棚の影に住む、形の定まらない同居人 |
| カヤ | ダリ | 敵側の同業者。月に一度、橋で遺品を交換する |
| カヤ | イサ | 母。手紙だけの関係 |
| リコ | ガロン | 元師匠。没落した大目利き |
| リコ | ミオ | 市のたびに来る、売れない品ばかり眺める少女 |

### Pilot: リコ

最初に作るのはリコだけです。第1季『売れないもの / Things I Can't Sell』（8話）の台帳が [characters/riko/stories/s01/](characters/riko/stories/s01/) にあります。リコを 10〜20 回 Scan して使い、Season 1 の日記より愛着が持てるかを確かめてから、ほかの4人へ広げるかを決めます（[docs/stories.md](docs/stories.md) §12）。

---

## 構造

```text
characters/<id>/
  profile.yaml        固定層。人格の芯（Base Persona）
  canon.yaml          追記のみの人生設定
  relationships.yaml  周囲2人との関係
  stories/            Character Story のソース
    s<NN>/            1季ぶん
      manifest.yaml     台帳。季と話の状態（draft / reviewed / published）・解放条件・題
      plan.yaml         story:plan の出力。人間が直す
      brief.md          人間の企画メモ（任意）
      e<NN>.ja.md       本文（日本語）
      e<NN>.en.md       本文（英語）
  snapshots/          PixTale が使うバージョン付き Persona Snapshot
  diaries/ entries/ events/ current-state.yaml memories.yaml
                      Legacy Diary Engine の記録（Season 1 / Archive）

world/
  stories.yaml  Story の既定値（1季の話数・Journey Progress の階段）
  canon/        時代・場所・制度の固定事実（calendar.yaml — 12の月と五夜、365日の暦）
  personas.json いま PixTale へ配っている版を指すピン（ペルソナ・世界・既定の同行者）
  feed/         PixTale アプリが直接読む公開 feed
    stories/      Story（index.json と <series-id>.json）
    characters.json lore.json diary.json entries/ portraits/
  appraisal/    World Appraisal Snapshot（カード鑑定へ注入する世界の圧縮）
  arcs/ threads/ cards/ seasons/ clocks.yaml failures/
                Legacy Diary Engine の素材と記録

src/          スキーマと生成・書き出しのパイプライン
scripts/      CLI
tests/        スキーマ検証とフィクスチャ（tests/fixtures/ に PixTale UI 開発用のダミー feed）
docs/         仕様
```

---

## 使い方

```bash
npm install
npm run validate        # 全データをスキーマと設計上の検収条件に照らす（CI が回す）
npm test

# Story の制作（生成は GitHub Actions だけ。鍵は repo secret にしかない）
npm run story:plan  -- --character riko --season 1 [--episodes 8] [--force] [--dry-run]
npm run story:write -- --character riko --season 1 [--episode N [--force]] [--dry-run]

# Story が済んだら、公開用の feed を手で書き出して PR へ入れる
npm run export:feed                    # diary / world と stories を書き出す
npm run export:feed -- --fixtures      # PixTale UI 開発用のダミー feed を作り直す
```

- **`story:plan`** は `plan.yaml` を書き、`manifest.yaml` へ足りない話を足します（人間が直した status / required_progress / title / format は上書きしません。計画の format と working_title は manifest へ写しません）。`plan.yaml` は本文を書くまでの直せる計画で、manifest に title / format があればそちらが優先されます。
- **`story:write`** は `e<NN>.ja.md` / `e<NN>.en.md` を `draft` で書きます。manifest に題の無い話には、書いた題を `manifest.yaml` へ入れます（plan と manifest の format / 題が食い違えば、生成の前に注意します）。`reviewed` の話を書き直すと `draft` へ戻ります（reviewed は「人間がこの本文を読んだ」の意味だから）。`--force` は `--episode` と組み合わせたときだけ使え、1話ずつ上書きします。`published` は `--force` でも書き直しません。
- ワークフローは `.github/workflows/story.yml`（Actions → story → Run workflow）。下書きを起動したブランチへコミットするだけで、**公開はしません**。`main` に入っていないと起動できません。モデルを差し替えるときは repo variable `VELUM_STORY_MODEL`。
- 状態を進めるのは**人の手**です。`manifest.yaml` の `status` を書き換えて PR にします。
- `npm run validate` は、feed が素材と食い違っていると失敗します（「素材と食い違っています」）。export を回し忘れた PR は CI が止めます。

他のコマンド:

```bash
npm run snapshot        # Persona Snapshot をコンパイルする（配らない。--publish で配る）
npm run appraisal       # World Appraisal Snapshot をコンパイルする（--publish で配る）
npm run portraits       # 肖像 512×512 をシートから派生させる
```

Persona Snapshot と World Appraisal は**自動では配りません**。人が読んでから、`snapshot.yml` の publish 入力か `--publish` で配ります。肖像はシートが変わったときだけ手で作り直します。詳細は [docs/persona-snapshot.md](docs/persona-snapshot.md) と [docs/feed.md](docs/feed.md)。

### キャラクターシート

5人のビジュアルは `profile.yaml` の `visual` が正です。**シートに焼き込まれた文字ではありません。**

画像生成は部分修正ができず毎回描き直すので、「ここは維持して」と書いた欄は保持されず引き直されます。確定した表記は `visual.sheet` に置いてあり、次にシートを描かせるときはそこから全項目を書き下します。理由と手順は [docs/visual.md](docs/visual.md)。

---

## PixTale との関係

このリポジトリと PixTale のあいだに、実行時の連携はありません。受け渡すのは**公開ファイルの一方向の取得だけ**です。面は4つあります。

```text
velum: world/feed/（characters / lore / diary / entries / portraits）   → PixTale アプリが直接読む
velum: world/feed/stories/（index.json / <series-id>.json）            → PixTale アプリが直接読む（Story と解放条件）
velum: world/appraisal/v0001.json                                       ↘
velum: characters/<id>/snapshots/v0007.json                              → PixTale Proxy がピン経由で取得し、
         ↑ どの版を読むかは world/personas.json                            プロンプトへ注入してキャッシュ
```

| 面 | 読み手 | 中身 |
|---|---|---|
| `world/feed/stories/` | アプリ | 公開済みの Story と、話ごとの解放条件（`required_progress`） |
| `world/feed/` の diary / world | アプリ | 人物・時代・肖像と、日記（Archive として凍結） |
| `world/appraisal/` | Proxy | カード鑑定へ注入する世界の圧縮 |
| `characters/<id>/snapshots/` | Proxy | Persona Snapshot。`world/personas.json` が版を指す |

この設計のおかげで、こちらの制作が止まっても壊れても PixTale は動き続け、人格が不自然に変化したらバージョンを戻すだけで元に戻せます。

**PixTale の「1 Scan = 1 推論」は変わりません。** Story の本文は事前に作ったファイルを読むだけで、アプリは Story のために AI を呼びません。Story 解放の進捗（Journey Progress）の保存もアプリ側（端末内）で、サーバへは持ちません。

**Story Season 1 のあいだ、Persona Snapshot の Base Persona は安定させます。** Story の中で人物が変わっても、Snapshot へは反映しません。ユーザーごとに進捗が違うので、全員へ同じ Snapshot を配る現在の仕組みでは、読んだ話と人格の食い違いが起きるためです。進捗に応じた Snapshot は第2段階の構想です（[docs/persona-snapshot.md](docs/persona-snapshot.md) §4.9）。

**このリポジトリは Story と人物の公開記録であり、PixTale が使うのは配布面にあるものだけです。** ここで描かれた個々の出来事が、PixTale で鑑定される個々のアイテムの正史になるわけではありません。

---

## Legacy Diary Engine（Season 1 / Archive）

> **2026-10-03 に自動生成を止めました（`daily.yml` の schedule を削除）。** コードとデータは、再現・調査・アーカイブのために残してあります。以下は Season 1 の仕組みの要約で、現在の運用ではありません。詳細は [docs/diary.md](docs/diary.md) と [docs/seasons.md](docs/seasons.md)。

Velum は Autonomous Diary Generator として、5人の主人公が毎日その日の出来事を経験し、日記を書き、記憶と価値観と人間関係を蓄積する実験でした。**反復も、矛盾も、人格の崩壊も、人間による修正も、等しく実験記録として残します。** 日記は消さず、feed の `diary.json` と `entries/` も契約のパスのまま残します（更新は止まっています）。

### 日記のローテーション

**書くのは1日ひとりでした。** ギルド → 静寂 → 大収束 → 破砕 → 原初 の5日周期で回り、各主人公は5日に1回書きます。日付順に読むと5つの時代を毎日飛び回り、時代順に読むとひとりの物語を続けて追えます。

### 季（シーズン）

**1人につき5話、5人で25日分。** 出来事はその日に即興で作らず、季の頭でまとめて計画しました（`world/seasons/`）。計画は YAML で書き出され、人間が読んで直せます。**人物が世界へ反応するのは日ごと、世界が人物へ反応するのは季ごと**です。

ここでいう「季」は、この旧 25 日計画のことです。Story の季（人物ひとりの 8〜10 話の束）とは別物です。

### 仕組み

```text
季の計画の1話  →  人物が認識した事実  →  状態の差分  →  日記（日本語・英語）  →  長期記憶
```

日記だけを再入力して人格を自己更新させる方式は採りませんでした（自己模倣・極端化・反復を起こしやすいため）。**計画された出来事と構造化された人物状態を正とし、日記は人間向けの主観表現として扱います。**

| 層 | 安定性 | 書き込むもの |
|---|---|---|
| **Profile** | 永久に固定 | なし（人間だけが編集する） |
| **Canon** | 追記のみ | 1日に最大1件の新事実 |
| **Current State** | 日次で変動 | 状態差分 |
| **Relationships** | 交流のあった日だけ | 関係差分 |
| **Memories** | 昇格したときだけ | 1日に最大1件 |

差分にはすべて上限があり、**上限を超えた値はクランプせず、その日を破棄します**（欠けた1日は目に見えるため）。Story の取り込みでも同じ方針で、自動修復せず、違反を表示して捨てます。

### 使い方（再現用）

```bash
npm run plan -- --season 1                  # 季（25日分）の出来事を組み立てる
npm run day -- 2026-09-05 [--dry-run]       # その日の日記を書かせる
npm run snapshot                            # Persona Snapshot をコンパイルする
```

先に季を計画し、それから日を回します。計画のない日を回すと、何も書かずに失敗します。ワークフローは `daily.yml`（手動のみ・date 必須）と `plan.yml`。`daily.yml` は Persona Snapshot を配りません。

### モデルと環境変数

生成は Cloudflare Workers AI 上の Gemma で、既定は `@cf/google/gemma-4-26b-a4b-it`（`src/lib/workers-ai.ts`）。呼び出しには repo secret の `CLOUDFLARE_ACCOUNT_ID` と `CLOUDFLARE_API_TOKEN`（Workers AI の Read / Edit 権限）が要ります。

| 変数 | 効く範囲 | 用途 |
|---|---|---|
| `VELUM_PROVIDER` | 全段 | `workers-ai`（既定）か `gemini`。Gemini に戻すときは `GEMINI_API_KEY` も要る（`src/lib/gemini.ts`） |
| `VELUM_MODEL` | 全段（季の計画・日記・Snapshot） | 既定モデルの差し替え |
| `VELUM_DIARY_MODEL` | 日記の段だけ | 未設定なら `VELUM_MODEL` → 既定（repo variable から `daily.yml` が渡す） |
| `VELUM_MAX_TOKENS` | Workers AI | 出力の上限トークン。既定 8192 |
| `VELUM_LLM_TIMEOUT_MS` | Workers AI | 1 回の呼び出しの上限。既定 180000 |

どのモデルで書かれたかは `characters/<id>/events/<日付>.json` の `generation.model` に残ります。

---

## ライセンス

コードとコンテンツで分かれています。詳細は [LICENSING.md](LICENSING.md) を参照してください。

- **ソフトウェア**（`src/`, `scripts/`, `tests/`, 技術ドキュメント）— MIT
- **世界とキャラクター**（`world/`, `characters/`。Story のソースと本文も含む）— CC BY-NC 4.0

---

Produced by [PixApps](https://pixapps.ai/)
