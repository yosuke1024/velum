# Velum

**PixTale の5人の同行者に、人生を与える。**

Velum は [PixTale](https://pixapps.ai/) の5人の同行者を育てる **Character Story Engine** です。AI によってキャラクターの物語を生成・構造化しますが、**自動生成したものをそのまま公開しません。** 人間が選び、編集し、公開した Story だけが PixTale へ配信されます。

Story はカレンダーではなく、PixTale でその人物と旅をした分（**Journey Progress**）で順次解放されます。目指すのは「AI が毎日生きる世界」の技術デモではなく、**ユーザーが好きになる人物**です。

> 面白い10話 > 面白くない100話

このリポジトリは、その全過程の公開記録です。世界設定も、人物の芯も、Story の計画と本文も、そして **Season 1 の日記エンジンが毎日書いた日記**（2026-09-01〜、いまは Legacy）も、すべてここに残ります。**反復も、矛盾も、人間による修正も、方針の転換も、等しく実験記録として残します。**

人物の芯は圧縮されて **Persona Snapshot** になり、PixTale が写真から見つけた Echo を、その人固有の目で語るために使われます。

---

## フィクションの開示

**このリポジトリの内容はすべてフィクションです。**

Velum という世界、そこに住む人物、彼らの日記、その中で語られる出来事——いずれも実在しません。日記の本文は AI（Cloudflare Workers AI 上の Gemma）が生成したものであり、人物の一人称で書かれていますが、そこに書かれた記憶・感情・意見は、実在の人物・団体・出来事とは一切関係ありません。

登場人物は自分をフィクションだと認識していません。それは演出であって、主張ではありません。

---

## Character Story — 厳選して制作し、旅で解放する

```text
characters/<id>/stories/s01/
  plan.yaml       季の計画。人間が読んで直す
  manifest.yaml   公開する単位の台帳。unlock 条件（required_progress）と状態
  e01.ja.md       本文（日本語）
  e01.en.md       本文（英語）
```

Story は「世界で何が起きたか」ではなく、**この人物がどんな人なのか**を伝えるために作ります。Plot の中に Character を入れるのではなく、Character から Plot を発生させる。朝食、値切り、売った品を惜しくなる、遠くに誰かを見つけて隠れる——そういう回を積極的に入れます。形式も話ごとに選びます（一人称・三人称・会話・手紙・記録・回想・一場面）。

```text
draft  →  reviewed  →  published
```

**生成 ≠ 公開。** 状態は manifest.yaml が持ち、feed へ出るのは季と話の両方が `published` のものだけです。人間が読まずに公開される経路はありません。

PixTale で同行者を選んで Scan に成功するごとに、その人物の Journey Progress が 1 進みます。各話は `required_progress`（既定の階段は `world/stories.yaml`: 0 / 2 / 5 / 9 / 14 / 20 / 27 / 35 …）に達したときに解放されます。第1話は 0——同行者を選んだ時点で読めます。

最初は **Riko** を Pilot にします。詳細は [docs/stories.md](docs/stories.md)。

---

## 5つの時代と、5人の語り手

| 時代 | 年代 | 主人公 | 年齢 | アイテムへの問い |
|---|---|---|---|---|
| 原初の沈黙 | ~???–0 | [ウタ](characters/uta/) | 19 | これは何の兆しか |
| ギルドの時代 | 0–400 | [テオ](characters/teo/) | 16 | どう作られたか |
| 大収束 | 417 | [セヴラン](characters/sevran/) | 29 | 何が混ざったか |
| 破砕戦争 | 417–800 | [カヤ](characters/kaya/) | 26 | 誰が持っていたか |
| 静寂の時代 | 800–現在 | [リコ](characters/riko/) | 24 | まだ何ができるか |

各主人公には、関係を持つ人物が2人ずついます（全15人）。関係者は独立した日記を持たず、主人公から見た関係として管理されます。

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

---

## Legacy Diary Engine（Season 1、自動実行は停止）

ここから下の「ローテーション」「季」「仕組み」は、2026-09-01 から 2026-10-01 まで回した**日次の日記エンジン**の説明です。システムとしては成立しましたが、読者として読み返すと「人物を識別はできるが、好きにはならない」——その評価から Character Story へ移りました（[docs/stories.md](docs/stories.md) §1）。

コードもデータも消していません。`npm run day` と `daily.yml` は手動（workflow_dispatch）からは回せますが、**cron は外してあります。** Season 1 の日記は `characters/*/diaries/` と `world/feed/diary.json` に Archive として残り、PixTale の主要導線からは外れます。

### 日記のローテーション

**書くのは1日ひとりです。** ギルド → 静寂 → 大収束 → 破砕 → 原初 の5日周期で回り、各主人公は5日に1回書きます。

読み方は2通りあります。**日付順**に読むと5つの時代を毎日飛び回ることになり、**時代順**に読むとひとりの物語を続けて追うことになります。同じ日記が、並べ方で別の意味を持ちます。

---

## 季（シーズン）— 出来事は前もって組み立てる

**1人につき5話、5人で25日分。** 出来事はその日に即興で作らず、季の頭でまとめて計画します。

```text
第1話 発端  →  第2話 展開  →  第3話 転機  →  第4話 危機  →  第5話 決着
```

その日に即興で作ると、物語の形がどこにもありません。発端も転機も決着もなく、昨日の設定を今日が壊します。そしてもうひとつ、こちらのほうが大きい理由があります——**計画は人間が読んで直せます**。`world/seasons/` に YAML で書き出されるので、走らせる前に25日分すべてを読み、気に入らない展開を書き換えられます。

**人物が世界へ反応するのは日ごと、世界が人物へ反応するのは季ごとです。** 25日に一度、その時点の人物状態を読んで次の季を組み立てます。詳細は [docs/seasons.md](docs/seasons.md)。

---

## 仕組み

```text
季の計画の1話      その日に何が起きるか（前もって決めてある）
   ↓
人物が認識した事実  同じ出来事でも、誰が見たかで認識が変わる
   ↓
状態の差分         感情・信念・関係・目的の変化。すべて上限つきの差分
   ↓
日記              人間向けの主観的な表現。日本語と英語で残す
   ↓
長期記憶          months 単位で覚えておく価値のあるものだけ昇格
```

日記だけを再入力して人格を自己更新させる方式は採りません。自己模倣・性格の極端化・反復を起こしやすいためです。**計画された出来事と構造化された人物状態を正とし、日記は人間向けの主観表現として扱います。**

### 変わらないもの / 変わるもの

| 層 | 安定性 | 書き込むもの |
|---|---|---|
| **Profile** | 永久に固定 | なし（人間だけが編集する） |
| **Canon** | 追記のみ | 1日に最大1件の新事実 |
| **Current State** | 日次で変動 | 状態差分 |
| **Relationships** | 交流のあった日だけ | 関係差分 |
| **Memories** | 昇格したときだけ | 1日に最大1件 |

差分にはすべて上限があります（[docs/diary.md](docs/diary.md)）。**上限を超えた値はクランプせず、その日を破棄します。** クランプは壊れたプロンプトを「それらしく見える状態」の裏に隠しますが、欠けた1日は目に見えるからです。

---

## 構造

```text
world/
  canon/        時代・場所・制度の固定事実。生成がこれと矛盾したら破棄する
                （calendar.yaml — 12の月と五夜からなる365日の暦。全時代共通）
  stories.yaml  Journey Progress の既定の階段（Story の unlock 条件の既定値）
  personas.json いま PixTale へ配っている版を指すピン（ペルソナ・世界・既定の同行者）
  feed/         PixTale アプリが直接読む公開 feed（人物・時代・肖像・Story・Legacy の日記一覧）
    stories/    Story feed（index.json と <story-id>.json。published だけが出る）
  appraisal/    World Appraisal Snapshot（カード鑑定へ注入する世界の圧縮）
  clocks.yaml   [Legacy] 各時代の「いま」。季の計画が立つたびに進む
  arcs/         [Legacy] 進行中の物語アーク
  threads/      未解決スレッドと、時代を跨ぐ5本の糸
  cards/        [Legacy] イベントカード（季を組み立てるときの素材）
  seasons/      [Legacy] 日記の季の計画。1人5話 × 5人 = 25日分

characters/<id>/
  profile.yaml        固定層。人格の芯
  canon.yaml          追記のみの人生設定
  relationships.yaml  周囲2人との関係
  stories/            Character Story（plan.yaml / manifest.yaml / eNN.{ja,en}.md）
  snapshots/          PixTale が使うバージョン付き Persona Snapshot
  current-state.yaml  [Legacy] 日次で動く層
  memories.yaml       [Legacy] 長期記憶
  diaries/            [Legacy] Season 1 の日記（ja / en）。Archive

src/          スキーマと生成パイプライン
scripts/      CLI
tests/        スキーマ検証と、声の基準となるフィクスチャ
```

---

## 使い方

```bash
npm install
npm run validate            # 全データをスキーマと設計上の検収条件に照らす
npm test                    # スキーマ、構造ゲート、feed、Story の制作フロー

npm run story:plan  -- --character riko --season 1   # 季を設計する（plan.yaml / manifest.yaml を draft で）
npm run story:write -- --character riko --season 1   # 本文を書かせる（draft のまま）
# 読む。直す。manifest.yaml の status を reviewed → published へ進める。
npm run export:feed                                  # published だけが world/feed/stories/ へ出る
```

**生成と公開は別の操作です。** `story:write` が書いた本文は、manifest.yaml の status を人が進めるまで feed に出ません。`story:plan` は人間が manifest に書いた題・状態・unlock 条件を `--force` でも消しません。詳細は [docs/stories.md](docs/stories.md)。

### Legacy: 日記エンジン

```bash
npm run plan -- --season 1  # 第1季（25日分）の出来事を組み立てる
npm run day                 # 今日の日記を書かせる（cron は停止済み。手動でだけ回せる）
```

順序があります。**先に季を計画し、それから日を回します。** 計画のない日を回そうとすると、何も書かずに失敗します——ここで黙って緑を返すと、世界が止まったことに誰も気づかないまま日が過ぎるためです。季の残りが最後の1周（5日）に入ると、`npm run day` が次の季の計画がまだ無いことを警告します。

`npm run plan` の生成物は `world/seasons/001/` に置かれます。**走らせる前に読んで、直してよいものです。** `npm run day -- 2026-09-05 --dry-run` を使うと、その日に何が起きる予定かだけを確認できます。

構造ゲートに違反した日は、状態ファイルを一切変更せずに `world/failures/` へ失敗記録だけを残します。季の計画は消さないので、同じ日をやり直せば同じ出来事から書き直せます。

```bash
npm run snapshot            # Persona Snapshot をコンパイルする
```

Snapshot は日次では作らず、**季の切れ目（25日ごと）**にコンパイルします。1日ごとに人格が動くと、PixTale から見れば同じ人物が毎日別人になるためです。

**作ることと、配ることは別です。** Snapshot を書いても PixTale の出力は変わりません。変わるのは `world/personas.json`（いま配っている版を指すピン）が動いたときだけです。人格が変になったら、このファイルの数字ひとつを戻せば元に戻ります——Snapshot は追記のみなので、戻す先は消えていません。

詳細は [docs/persona-snapshot.md](docs/persona-snapshot.md)。

```bash
npm run export:feed         # PixTale アプリが読む feed（world/feed/）を書き出す
npm run appraisal           # World Appraisal Snapshot をコンパイルする（--publish で配る）
npm run portraits           # 肖像 512×512 をシートから派生させる
```

feed は `npm run export:feed` で書き出します（Story を published にしたとき、プロフィールや
canon を直したとき。日次 cron は止めてあります）。World Appraisal は Persona と同じく
**季末にコンパイルし、人が読んでから配ります**。肖像はシートが変わったときだけ
手で作り直します。詳細は [docs/feed.md](docs/feed.md) と [docs/stories.md](docs/stories.md) §6。

### モデル

生成は Cloudflare Workers AI 上の Gemma で、既定は `@cf/google/gemma-4-26b-a4b-it`（`src/lib/workers-ai.ts`）。PixTale のプロキシと同じ系統に揃えてある。呼び出しには repo secret の `CLOUDFLARE_ACCOUNT_ID` と `CLOUDFLARE_API_TOKEN`（Workers AI の Read / Edit 権限）が要る。無料枠は 1 日 10,000 neurons で、日記 1 本が 200 neurons 前後。

環境変数で上書きできる。

| 変数 | 効く範囲 | 用途 |
|---|---|---|
| `VELUM_PROVIDER` | 全段 | `workers-ai`（既定）か `gemini`。Gemini に戻すときは `GEMINI_API_KEY` も要る（`src/lib/gemini.ts`） |
| `VELUM_MODEL` | 全段（季の計画・日記・Snapshot） | 既定モデルの差し替え |
| `VELUM_DIARY_MODEL` | **日記の段だけ** | 日記は製品そのものなので、季の計画と別のモデルへ振れる。`daily.yml` は repo variable `VELUM_DIARY_MODEL` から渡す。未設定なら `VELUM_MODEL` → 既定 |
| `VELUM_MAX_TOKENS` | Workers AI | 出力の上限トークン。既定 8192。日記は本文 2 言語と差分で 4〜5k になる |
| `VELUM_LLM_TIMEOUT_MS` | Workers AI | 1 回の呼び出しの上限。既定 180000 |

どのモデルで書かれたかは `characters/<id>/events/<日付>.json` の `generation.model` に残るので、切り替えた日が
あとから分かる。日記の質を比べるときは、この列で切ってから読むこと。

### キャラクターシート

5人のビジュアルは `profile.yaml` の `visual` が正です。**シートに焼き込まれた文字ではありません。**

画像生成は部分修正ができず毎回描き直すので、「ここは維持して」と書いた欄は保持されず引き直されます。確定した表記は `visual.sheet` に置いてあり、次にシートを描かせるときはそこから全項目を書き下します。理由と手順は [docs/visual.md](docs/visual.md)。

---

## PixTale との関係

このリポジトリと PixTale のあいだに、実行時の連携はありません。受け渡すのは**公開ファイルの一方向の取得だけ**です。面は3つあります。

```text
velum: world/feed/                      → PixTale アプリが直接読む（人物・時代・肖像・Legacy の日記）
velum: world/feed/stories/              → 同上。Story（published だけ）。Journey Progress で解放
velum: world/appraisal/v0001.json       ↘
velum: characters/<id>/snapshots/v0007.json → PixTale Proxy がピン経由で取得し、
         ↑ どの版を読むかは world/personas.json     プロンプトへ注入してキャッシュ
```

Story の解放はユーザーごとに進度が違うので、**Story 第1季では Base Persona を安定させ、Story による人格変化を Snapshot へ即時反映しません**（[docs/stories.md](docs/stories.md) §8）。Progress 連動の Snapshot は第二段階です。

この設計のおかげで、こちらの生成が止まっても壊れても PixTale は動き続け、人格が不自然に変化したらバージョンを戻すだけで元に戻せます。

**このリポジトリは人物の全記録であり、PixTale が使うのは公開済みの Story と、人物の芯から生成された Snapshot だけです。** ここで起きた個々の出来事が、PixTale で鑑定される個々のアイテムの正史になるわけではありません。

---

## ライセンス

コードとコンテンツで分かれています。詳細は [LICENSING.md](LICENSING.md) を参照してください。

- **ソフトウェア**（`src/`, `scripts/`, `tests/`, 技術ドキュメント）— MIT
- **世界とキャラクター**（`world/`, `characters/`）— CC BY-NC 4.0

---

Produced by [PixApps](https://pixapps.ai/)
