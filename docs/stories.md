# Character Story — 人間が選び、直し、公開する物語

Velum を **Character Story Engine** にする。5人の同行者それぞれについて、厳選した物語（Story）を作り、PixTale の Journey Progress で解放する。AI は下書きと構造化を担い、**公開は人間だけが決める**。

**実装状況:** 2026-10-03 基盤実装（Velum 側）。ソース・状態・feed・export・validate・生成 CLI・フィクスチャまで。PixTale 側の Stories UI と Journey Progress は未実装（§12 の第2・3段階）。

**制作の経路は [story-authoring.md](story-authoring.md) へ移った（2026-10-03）。** Astra（Codex CLI 経由の `gpt-6-astra`）が一つの完成した物語を書き、人間が採用してから数話へ分ける。この文書の台帳・状態・feed・export・validate はそのまま使う。§10・§11 の `story:plan` / `story:write`（話ごとに Gemma で下書き）は Legacy である。

旧 Diary Engine（日次の自動生成）は [diary.md](diary.md)・[seasons.md](seasons.md) に Legacy として残る。そこでいう「季」は旧 25 日計画のことで、この文書の Story の季（人物ひとりの 1〜12 話の束）とは別物である。

---

## 1. なぜ作り直したのか

Velum は Autonomous Diary Generator として始まった。5人の主人公が毎日出来事を経験し、日記を書き、記憶と人格を蓄積する。Season 1（2026-09-01〜）を回して分かったことは次のとおりである。

**日記は、人物を「識別できる」ところまでは届いた。「好きになれる」ところまでは届かなかった。**

- 毎日出す前提では、質のばらつきを選別できない。出来の悪い日も同じ重さで積み上がる。
- 「その日の夜に本人が日記を書く」という形式が、人物の見せ方を縛る。手紙も、会話も、回想も、第三者の視点も取れない。
- 構造化された状態（感情・信念・関係の差分）が主役になり、読者が人物と一緒にいたくなるかどうかは設計の中心になかった。

**良い10話は、悪い100話に勝つ。** 本数ではなく、1話ごとの出来を作る。そのために、自動で出すのをやめ、人間が選んで直す工程を置く。

| | Season 1（Diary Engine） | Character Story Engine |
|---|---|---|
| 目的 | 人物の人生を毎日記録する | 読者が人物を好きになる |
| 生成 | 毎朝の cron が自動で生成・自動で公開 | 手動。AI は下書きまで |
| 公開 | 生成と同時 | 人間が選び、直し、status を進めたものだけ |
| 単位 | 日記 1 本 = 1 日 | Character → Season → Episode（1季 1〜12 話） |
| 形式 | 日記だけ | 話ごとに選ぶ（§8） |
| 人物の変化 | 状態差分が Persona Snapshot へ流れる | Story では Base Persona を動かさない（§13） |

Season 1 の日記は消さない。**Experimental Diary Season 1 / Archive** として残す。反復も、矛盾も、人格の崩壊も、人間による修正も、等しく実験記録として残すのが Velum の原則である。日次の cron だけを止めた（2026-10-03、`.github/workflows/daily.yml` の `schedule` を削除）。コードは Legacy Diary Engine として、再現・調査・アーカイブのために残してある。

## 2. 成功の基準

> Story を読んだ人が、そのキャラクターと**もっと一緒にいたい**と思うこと。PixTale の同行者にしたいと思うこと。

生成した本数、世界観の網羅、設定の整合は成功の基準ではない。基準は読み手の中にある——Pilot（リコ）を実際に使い、Season 1 の日記を読んだときより愛着が上がるかを見る（§12 の第5段階）。

PixTale の **1 Scan = 1 推論** の原則は変わらない。Story は事前に作ったファイルをアプリが読むだけで、読むために AI を呼ばない。

## 3. ソースの構造

```text
characters/<id>/stories/s<NN>/
  manifest.yaml    台帳。季と話の状態・解放条件・題。本文から切り離す
  plan.yaml        story:plan の出力。人間が読んで直す（任意）
  brief.md         人間の企画メモ（任意）。story:plan のプロンプトに添える
  e<NN>.ja.md      本文（日本語）
  e<NN>.en.md      本文（英語）
```

季のディレクトリに置いてよいのは **manifest.yaml / plan.yaml / brief.md / `e\d\d.(ja|en).md` だけ**。それ以外のファイルは validate が落とす（前の実験の残骸や取り違えを見逃さないため）。ただし OS が勝手に作るメタデータ（macOS の `.DS_Store`）は無視する。

### ID

| 単位 | 形式 | 例 |
|---|---|---|
| 季（series） | `<character>-s<NN>` | `riko-s01` |
| 話（episode） | `<series>-e<NN>` | `riko-s01-e01` |

1季の話数は **1〜12**（スキーマの上限）。話数は作品に合わせる——新しい経路では採用した一作品を分けるので、8〜10 話へ水増ししない。Legacy の `story:plan` の既定は `world/stories.yaml` の `default_episode_count`（8）。ID と order は `src/schemas/story.ts` の `storySeriesId` / `storyEpisodeId` が作る。

### 本文の書式

本文は**プレーンテキスト**である。PixTale は本文を段落として描くだけで、Markdown を解釈しない。記法を書けば、そのまま記号として画面に出る。

- 段落は空行で区切る。段落内の改行は行替えとして読まれる（会話の行を分けたいときに使ってよい）
- front matter を付けない。本文だけを書く
- Markdown の装飾を使わない（`#` 見出し・`**` / `__` の強調・バッククォート・`](` のリンク・HTML タグ）
- 改行は LF のみ。日本語の本文はかな・漢字が 3 割以上、英語の本文は 5% 以下

`src/story/body.ts` の `storyBodyProblems()` が見る。長さは書式の検査では見ない（生成ゲートは長さも見るが、人間が書いた短い話を落とす理由はない）。feed へ出すときの正規化は `normalizeStoryBody()`（行末の空白を落とし、3つ以上続く改行を空行1つへ詰め、前後を整える）。

**英語版は翻訳ではない。** 同じ人物が、英語でその話を語り直す。直訳すると間合いが死ぬ（[diary.md](diary.md) §6 と同じ判断）。

## 4. 状態と不変条件

状態は **draft → reviewed → published** の3つで、**季にも話にもある**。

| 状態 | 意味 |
|---|---|
| `draft` | AI の下書き、または人間が書き途中のもの。誰にも読まれていない前提 |
| `reviewed` | **人間がこの本文を読んだ。** 公開の前段階 |
| `published` | 公開してよい。feed に出る |

状態を進めるのは**人の手**で、`manifest.yaml` を直接書き換える。コマンドは無い。

不変条件（`src/schemas/story.ts` の `storyManifestProblems()` が見る。スキーマと validate の両方が同じ関数を読む）:

- 話の status は季の status を越えない
- `published` の話は、第1話から**連続**している（第3話だけ公開すると、解放の階段に穴が開く）
- `reviewed` / `published` の話は、`title` が ja / en の両方あり、**本文も ja / en の両方ある**（本文の有無は validate がファイルで確かめる）
- `published` の季には、`published` の話が1話以上ある
- 第1話の `required_progress` は 0、季の中で単調非減少
- ID は `character_id` と `season`、`order` から決まる値と一致する。order は 1 から欠番なし

**feed へ出るのは、`published` の季の `published` の話だけ**（§6）。

### 書き直しと状態

- `story:write` が `reviewed` の話を書き直したら、その話は **`draft` へ戻る。** `reviewed` は「人間がこの本文を読んだ」の意味で、別の本文になったなら成り立たないため。
- **`published` の話は、`--force` でも `story:write` が書き直さない。** 公開済みを直すのは人間が手で行う。

manifest の各話は、生成の記録（`generation`: model / prompt_version / generated_at）を持てる。**feed には出さない**（どのモデルで下書きしたかは制作側の記録）。

## 5. 台帳（manifest）と解放の階段

```yaml
id: riko-s01
character_id: riko
season: 1
title: { ja: 売れないもの, en: "Things I Can't Sell" }
status: draft
episodes:
  - id: riko-s01-e01
    order: 1
    required_progress: 0
    status: draft
    title: { ja: ミオは何も買わない, en: Mio Never Buys Anything }
  - id: riko-s01-e02
    order: 2
    required_progress: 2
    status: draft
    # ...
```

スキーマは **strict**。人間が手で直す台帳なので、`required_progres` のような打ち間違いが黙って捨てられ、別の欄の既定値で動いてしまうことを許さない。

### Journey Progress と解放

PixTale 側の抽象は次の一本である。

```text
Activity  →  Journey Progress  →  Story Unlock
```

- 最初の Activity は「**その同行者を選んだ状態で、Scan に成功したこと**」。1 回で Progress が 1 進む（人物ごとに別々）
- 話は `required_progress` に達したときに解放される
- **解放した話は端末に保存され、二度と再ロックしない。** 公開済みの話が feed から消えたり、`required_progress` が上がったりしても、一度開いた話は開いたまま。だから export は、公開済みの話が消える変更を拒否する（§7）
- Progress の保存は端末内。サーバ側の保存・同期は持たない

Activity の定義は将来 Scan 以外へ増やせるが、その場合も Story 側（この文書と feed）の数字は変わらない。**Progress の数字を知っているのは feed だけで、アプリにハードコードしない。**

### 既定の階段（`world/stories.yaml`）

```yaml
default_episode_count: 8
default_required_progress: [0, 2, 5, 9, 14, 20, 27, 35, 44, 54, 65, 77]
```

| 話 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| required_progress | 0 | 2 | 5 | 9 | 14 | 20 | 27 | 35 | 44 | 54 | 65 | 77 |

- **第1話は 0。** 同行者を選んだ時点で読める。まだ好きでもない人物のために「まず5回 Scan してください」と要求しても成立しない
- **序盤3話は早く解放する**（0, 2, 5）。人物を知ってから中盤へ進ませる
- 最初の8話は企画の表（0, 2, 5, 9, 14, 20, 27, 35）。9 話目以降は 8 話目までの間隔（+6, +7, +8）を延長したもの
- `story:plan` が manifest の各話へ転記する。**話ごとに manifest で直してよい**（単調非減少の範囲で）。直した値は `story:plan` が上書きしない

## 6. feed

```text
world/feed/stories/index.json        人物ごとの公開済みの季の一覧（本文なし）
world/feed/stories/<series-id>.json  1季ぶんの公開済みの全話（本文込み）
```

diary feed（[feed.md](feed.md)）と並列の配布面で、**既存ファイルの形も schema_version も動かさない。** 版は `STORIES_SCHEMA_VERSION`（現在 1）という別の定数で持つ。将来 stories だけ版を上げても、日記・人物・時代のファイルが旧アプリで一斉に不採用にならないようにするため。型は `src/schemas/feed.ts`。

### index.json

```json
{
  "schema_version": 1,
  "generated_at": "2026-10-03T00:00:00.000Z",
  "characters": {
    "riko": {
      "series": [
        {
          "id": "riko-s01",
          "character_id": "riko",
          "season": 1,
          "title": { "ja": "...", "en": "..." },
          "summary": { "ja": "...", "en": "..." },
          "path": "world/feed/stories/riko-s01.json",
          "revision": "a1b2c3d4e5f6",
          "episode_count": 3,
          "episodes": [
            { "id": "riko-s01-e01", "order": 1, "required_progress": 0, "title": { "ja": "...", "en": "..." } }
          ]
        }
      ]
    }
  }
}
```

- **公開が1本も無くても書く**（`"characters": {}`）。アプリが「取得失敗」と「まだ無い」を区別できるように
- `characters` は `CHARACTER_IDS` の順で、公開済みの季を1本以上持つ人物だけ。人物ごとの `series` は season の昇順
- `episodes` は公開済みの話の `{ id, order, required_progress, title }`。ロックされた行の表示と解放判定は index だけで済む。`episode_count` は `episodes` の長さ
- `summary` は無くてよい

### `<series-id>.json`

```json
{
  "schema_version": 1,
  "generated_at": "2026-10-03T00:00:00.000Z",
  "id": "riko-s01",
  "character_id": "riko",
  "season": 1,
  "title": { "ja": "...", "en": "..." },
  "summary": { "ja": "...", "en": "..." },
  "status": "published",
  "path": "world/feed/stories/riko-s01.json",
  "revision": "a1b2c3d4e5f6",
  "episodes": [
    {
      "id": "riko-s01-e01",
      "order": 1,
      "required_progress": 0,
      "title": { "ja": "...", "en": "..." },
      "summary": { "ja": "...", "en": "..." },
      "format": "first_person",
      "body": { "ja": "...", "en": "..." }
    }
  ]
}
```

- 載るのは `status: published` の話だけ。不変条件（§4）から、第1話から連続している
- `summary` / `format` は無くてよい。`body` はプレーンテキスト（§3）で、`normalizeStoryBody` を通す
- `path` は `world/feed/stories/<series-id>.json`（base URL からの相対。diary feed と同じ規約）

### 上限

| ファイル | 上限 |
|---|---|
| `index.json` | 64KB |
| `<series-id>.json` | 256KB（日本語は1字3バイト。12話・2言語を見込む） |

### revision

`revision` は、季ファイルの内容の版である。**`generated_at` と `revision` を除いた季オブジェクトを `JSON.stringify`（キー順はスキーマの形どおりで決定的）して、sha256 の先頭12桁**を取る。同じ値が index の季の要約にも入る。アプリはキャッシュ済みの季ファイルと index の `revision` を比べ、違えば取り直す。本文を1字直せば revision が変わる。

### ロックされた本文は秘匿ではない

ロックされた話の本文も、raw GitHub から誰でも読める。**解放は UX であって秘匿ではない。** velum は公開リポジトリなので、draft の本文も git の中で見える。読まれて困るものは、そもそもリポジトリに入れない。人物の秘密（`secret_unknown_to_self` など）を守る仕組みは §7 の secrets の検査である。

## 7. export と validate

```bash
npm run export:feed                     diary / world と stories の両方を書き出す
npm run export:feed -- --allow-withdraw 公開済みの話が消える変更を許す
npm run export:feed -- --fixtures       フィクスチャを作り直す（§14）
```

**cron は無い。** 手で回し、PR にコミットする。CI の `npm run validate` が feed と素材の食い違いで落ちる（「素材と食い違っています」）ので、回し忘れた PR は main に入らない。

規則:

- **`index.json` は常に書く。** 公開が無ければ `"characters": {}`
- 公開済み（季と話の両方が `published`）の季ごとに `<series-id>.json` を書く。本文は `normalizeStoryBody` を通す
- **`ja` か `en` の本文が欠けた公開済みの話はエラー**（例外）。en から ja への穴埋めはしない
- **冪等。** 内容が同じなら、`generated_at` だけが違うファイルは書き換えない（raw の ETag を無駄に揺らさないため。diary feed と同じ約束）。ビルダーは `now` だけを変動入力にとる
- 公開を取り下げた季のファイルは削除する

### 再ロックしないためのガード

解放した話は端末に残り、再ロックしない（§5）。だから**以前公開した話の ID が、書き出し後に消える変更は、exit 1 で拒否する**。取り下げが本当に必要なときだけ `--allow-withdraw` を付ける。話を差し替えたいなら、ID を保ったまま本文を直す（revision が変わり、アプリが取り直す）。

### validate が見るもの

- manifest の strict スキーマと不変条件（§4）、`plan.yaml` のスキーマ
- 季のディレクトリに置いてよいファイル名（§3）、ディレクトリ名と manifest の `season` の一致
- 本文の書式（§3）。`reviewed` / `published` は ja / en の両方が必須
- plan の `people` が、その人物の `relationships.yaml` の people の id であること
- **secrets。** 配布してはいけない秘密（本人が知っていて明かさない `core.secret_hidden` と、本人も知らない `core.secret_unknown_to_self`・`relationships[].hidden_from_protagonist`）の文断片が混じっていないか。**draft を含む Story のソースすべて**と、feed の両方を見る。照合は空白を除いた部分一致で、シリアライズした JSON の中では改行が `\n`（バックスラッシュ + n）の2文字になり、折り返された秘密の一文が素通りしてしまう。そのため feed は**デコードした文字列の値にも**同じ照合を当てる（`src/lib/secrets.ts`）
- feed のスキーマ・サイズ上限・素材との一致（drift）・孤児ファイル（素材に無い季のファイル）・index と季ファイルの整合

validate の方針は日記と同じで、**自動修復はしない。** 違反は表示して落とす（[diary.md](diary.md) §4）。

## 8. コンテンツの原則

### 人物から出す

**Plot の中にリコを入れるのではなく、リコから Plot を起こす。** 設定の事件を消化するための話にしない。毎日の商売と人づきあいの中の行動で、その人が何者かを見せる。

- 各話は「この回で読者に人物の何を知ってほしいか」から作る。事件の起伏（発端・展開・転機・危機・決着）ではない。**旧 Season Plan の固定5構造は使わない**
- 性格は説明せず、行動で見せる
- 季ぜんぶを大事件にしない。小さな日常の回を入れる
- 人物の魅力の半分を落とさない。たとえばリコは陽気さが半分で、不安と罪悪感だけで季を埋めない。口上を客の前で演じ、ありふれた品に大げさに驚いてから値段をきっちり言う場面がほしい
- 周りの人（ガロン・ミオ）は噂ではなく、姿の見える場面に出してよい。1話に出す関係者は絞る
- 固有名詞やロアを知らなくても読めること。世界観は、読む動機の前に置かない

### 形式は話ごとに選ぶ

日記形式を必須にしない。人物の声は保つが、「本人がその夜に日記を書く」という制約からは解放する。`format`:

| format | 内容 |
|---|---|
| `first_person` | 本人の一人称 |
| `third_person` | 三人称 |
| `dialogue` | 会話が中心 |
| `letter` | 手紙 |
| `record` | 帳簿・鑑定書・記録 |
| `recollection` | 回想 |
| `scene` | ひとつの場面 |

同じ形式を並べ続けない。季のあいだに変化があること。

### リコ 第1季の回の例（人間の企画メモ）

`characters/riko/stories/s01/brief.md` にある。

- ミオとの朝食
- 値切られて本気で腹を立てる
- 売った品を惜しくなって、買い戻そうとする
- ガロンを遠くから見つけて、隠れる
- 偽物だと思って売ったものが、誰かにとって大切なものになる
- お金に困っているのに、本当に好きなものだけは売れない

## 9. 人間のレビュー基準

`draft` → `reviewed` の前に、人間が次を見る。**生成のゲートではない。** 自動で落とす条件にはせず、読む人が判断する。出来の悪い話は reviewed にしない、というだけである。

- この話で、人物について**新しく知ったこと**があるか
- 性格が、説明ではなく**行動**を通して見えるか
- **関係**（誰かとの間）が見えるか
- 感情が**少なくとも一度動く**か
- 固有名詞やロアを知らなくても**読める**か
- **次の話を読みたく**なるか

6つのうち、満たさないものが多い話は書き直す。直す単位は話で、直したら本文だけでなく、題・要約・英語版も同じ手で合わせる（直す単位は「話」であって「言語」ではない。古い訳は機械には見つけられない）。

## 10. 制作フローと CLI（Legacy）

> **新しい制作経路は [story-authoring.md](story-authoring.md)（`story:doctor` / `story:draft` / `story:revise`）。** この節の `story:plan` → `story:write`（Workers AI の Gemma で話ごとに下書き・Actions でだけ生成）は Legacy として残してあるが、新しい制作の既定の手順ではない。

```text
brief.md を書く（人）
  → npm run story:plan   plan.yaml と manifest を作る（AI）
  → plan.yaml を読んで直す（人）
  → npm run story:write  本文を draft で書く（AI）
  → 読んで直す、reviewed にする（人）
  → published にする（人）
  → npm run export:feed、PR（人）
```

### 生成は GitHub Actions だけ

鍵（Cloudflare Workers AI の `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN`）は repo secret にしかない。ローカルで生成を回すのではなく、Actions の `story` ワークフローを使う。ローカルで回せるのは `--dry-run`（何を渡すかの確認）と、生成を伴わない validate / export / test である。

```bash
npm run story:plan  -- --character riko --season 1 [--episodes 8] [--force] [--dry-run]
npm run story:write -- --character riko --season 1 [--episode N [--force]] [--dry-run]
```

| コマンド | 書くもの | 規則 |
|---|---|---|
| `story:plan` | `plan.yaml` と、manifest の同期 | `--episodes` の既定は `world/stories.yaml` の値。manifest の同期は**足すだけ**で、**人間が直した status / required_progress / title / format を上書きしない**。計画の `format` と `working_title` は manifest へ**写さない**（足される話は title / format の無い draft）。`plan.yaml` は本文を書くまでの直せる計画である |
| `story:write` | `e<NN>.ja.md` と `e<NN>.en.md`（draft） | **2回の呼び出し。** まず日本語、次に英語（同じ人物が英語でその話を語る）。`--episode` で1話だけ。`--force`（`--episode` と組み合わせたときだけ）でその話の既存の本文を上書き——季全体の一括上書きはできない（レビュー済みの直しを一度に失わないため）。`reviewed` は draft へ戻り、`published` には `--force` でも触れない。**題と形式は manifest が優先**: 形式は `manifest.format ?? plan.format`、題は manifest にあればその題で固定（生成の題は捨てる）。manifest に題が無ければ plan の `working_title` を仮題として渡し、書いたあとの題で manifest の空の `title` を埋める（`format` も空なら、書いた形式を入れる）。plan と manifest の `format` / 題が食い違う話は、生成の前に注意を出す（エラーにはしない） |

`--dry-run` は何も書かない。プロンプトのバージョンは `story-plan-v1` / `story-write-v1`。

**題と形式を直す場所。** 本文を書くまでは `plan.yaml`（`format` / `working_title`）を直す——次の `story:write` がそれを使う。manifest に `title` / `format` が書かれた話（人間が書いたもの、または `story:write` が書いた本文から入れたもの）は、manifest の値が優先され、`plan.yaml` を直しても効かない。そのときは `manifest.yaml` を直す（食い違えば `story:write` が注意する）。

### ワークフロー `.github/workflows/story.yml`

Actions → story → Run workflow。`workflow_dispatch` の入力は `command`（`plan` | `write`）、`character`、`season`、`episode`、`episodes`、`force`。**起動したブランチへ下書きをコミットするだけで、公開はしない。** 読んで直して status を進めるのは PR の中で人が行う。

- ワークフローのファイルが `main` に入っていないと、起動できない（404）
- モデルは repo variable `VELUM_STORY_MODEL`（任意）で差し替える。使ったモデルは manifest の `generation.model` に残る
- Story は日付を持たないので、生成が失敗しても欠ける日は生まれない。失敗したらやり直すだけである

## 11. plan.yaml・brief.md・プロンプト

### plan.yaml

```yaml
id: riko-s01
character_id: riko
season: 1
title: { ja: ..., en: ... }
logline: この季で読者に残したいもの（一〜三文）
character_arc:
  start: 季のはじめの人物
  emotional_change: 季のあいだに動くもの
  end: 季のおわりの人物。成長や教訓に着地させなくてよい
relationships:
  focus: [mio, garon]          # relationships.yaml の people の id
episodes:
  - order: 1
    purpose: この回で読者に人物の何を知ってほしいか（事件ではなく人物の側から）
    situation: 場面の種。結末は書かない
    format: scene              # §8 の format
    people: [mio]              # この回に出る周りの人の id。端役は書かない
    working_title: { ja: ..., en: ... }
generation: { model: ..., prompt_version: story-plan-v1, generated_at: ... }
```

**固定の5構造（発端→展開→転機→危機→決着）は廃止した。** 各話の `purpose` は Plot Beat ではなく、「読者に人物の何を知ってほしいか」である。plan.yaml は人間が読んで直すファイルで、文は日本語だけでよい（題だけ ja / en）。

**plan.yaml は、本文を書くまでの直せる計画である。** `format` と `working_title` を直せば、次の `story:write` がそれを使う（`story:plan` は両方とも manifest へ写さないので、直しが黙って負けることはない）。ただし manifest の話に `title` / `format` があれば、そちらが優先される。`story:write` は、manifest の `title` が空の話に、書いた題を入れる。`story:plan --force` の再計画へは、manifest にすでにある題・形式だけを「すでに決まっている話」として渡す。

### brief.md

人間の企画メモ（任意）。story:plan のプロンプトに添える。この季で読者に残したいもの、入れたい回、避けたいことを自由に書く。リコ第1季の例が `characters/riko/stories/s01/brief.md`。brief はリポジトリの公開物なので、人物が知らない秘密は書かない。

### プロンプトに入れるもの

- 人物の profile / voice / relationships
- 人生の formative events と、時代の固定事実（era の fixed）
- 声の基準（voice baseline）
- brief.md

### 入れないもの

- **`secret_unknown_to_self` と `hidden_from_protagonist`**（本人が知らないことは入れない。Persona Snapshot・日記プロンプトと同じ規律）。これは Legacy の `story:plan` / `story:write` の規律で、Astra の経路は整合のため作者用の秘密を brief に含めて作者へ渡す（[story-authoring.md](story-authoring.md) §5）
- 現在の状態（current-state）と記憶（memories）。Story は **Base Persona** から書く。日記が積み上げた状態は、Story に流れ込まない（§13）

## 12. Pilot と段階

**リコが Pilot。** 第1季『売れないもの / Things I Can't Sell』（8話）。台帳は `characters/riko/stories/s01/manifest.yaml`（draft）、企画メモは同じディレクトリの `brief.md`。季の題と最初の3話の題は企画時のもので、manifest に書いてある（人間が決めた題として優先される）。第4話以降の題は、`story:write` が本文を書いたあとに入れる。`plan.yaml` の `working_title` は、manifest に題の無い話の仮題として、`story:write` のプロンプトへ渡る。

| 段階 | 内容 |
|---|---|
| 1 | **Velum foundation**（この PR）。ソース・状態・feed・export・validate・生成 CLI・フィクスチャ。`world/feed/stories/index.json` は空 |
| 2 | **PixTale Stories UI。** feed を読んで一覧・本文を描く。フィクスチャ（§14）で先に作れる |
| 3 | **Journey Progress。** Activity → Progress → Unlock。解放した話は端末に保存し、再ロックしない |
| 4 | **リコ第1季の制作。** Astra の初稿 → 人間が読む → 必要なら Astra の改稿 → 採用 → 分割 → 人間のレビュー → 公開（[story-authoring.md](story-authoring.md)） |
| 5 | **評価。** リコを 10〜20 回 Scan して使う。Season 1 の日記より愛着が上がったか。**それを確かめてから**、ウタ・テオ・セヴラン・カヤへ広げる |

5人分を一括で生成しない。1人の季がうまくいくと確かめるまで、広げない。

## 13. Persona Snapshot との関係

**Story Season 1 のあいだ、Base Persona は安定させる。** Story の中で人物が変わっても（自信を持つ、ガロンと向き合う）、Persona Snapshot へは反映しない。理由は、ユーザーごとに Journey Progress が違うこと。同じ Snapshot をユーザー全員へ配る現在の仕組みで人格を動かすと、読んだ話の数と人格が食い違う——第2話までしか読んでいないユーザーのリコが、第8話の後のリコとして Tale を語ることになる。

Persona Snapshot 自体は引き続き現役の配布面で、Season 1 の日記から作った版がそのまま配られている。ただし**自動配布はやめた**（日次 cron とともに、季末の自動コンパイル・配布を廃止した）。配布は `snapshot.yml` の publish 入力だけ。

**第2段階の構想（この MVP には含めない）:**

```text
Journey Progress  →  Persona Stage  →  Snapshot Version（PixTale Proxy が選ぶ）
```

進捗が進むと、その人物の「段階」に対応する版の Snapshot を PixTale Proxy が選ぶ。**この MVP では扱わない**（非目標、§15）。詳細は [persona-snapshot.md](persona-snapshot.md) §4.9。

## 14. フィクスチャ

PixTale の Stories UI（第2段階）を、本物のリコ第1季が書き上がる前に開発するための一式。

```text
tests/fixtures/stories/                       ソース（ダミー）
  characters/riko/stories/s01/                dummy riko-s01: e01〜e03 published / e04 reviewed / e05 draft
  characters/teo/stories/s01/                 dummy teo-s01: 2 話 published
tests/fixtures/feed/world/feed/stories/       書き出した feed
  index.json  riko-s01.json  teo-s01.json
```

- 再生成: `npm run export:feed -- --fixtures`（ソースは `tests/fixtures/stories/`）
- 使い方: `npx serve tests/fixtures/feed` して、アプリの `NEXT_PUBLIC_VELUM_FEED_BASE_URL=http://localhost:3000/` を向ける
- **本文は短いテスト用のダミーで、本物の Season ではない。** 状態の分布（published / reviewed / draft の混在）は、feed に載るのが published だけであることを確かめるためのもの
- 実データの assertion をテストに書かない。可変のライブデータの値（本物の話の題や本数）ではなく、フィクスチャを使う

詳細は `tests/fixtures/feed/README.md`。

## 15. 非目標

この MVP でやらないこと。

- **実行時の AI による Story 生成。** アプリは事前に作った本文を読むだけ
- **Story を読むための追加の AI 呼び出し。** 1 Scan = 1 推論の原則は変えない
- **Journey Progress のサーバ保存・同期。** 端末内に持つ
- **Battle / Realm との統合**
- **進捗に応じた Snapshot**（§13 の第2段階の構想）
- **旧 Diary データの削除。** Season 1 は Archive として残す
- **5人分の一括生成。** Pilot（リコ）で確かめてから

## 16. 計測（PixTale 側）

成功の基準（§2）を確かめるために、PixTale が次のイベントを計測する。**計測は PixTale が持つ。** velum はイベントを送らないし、受け取らない。

| イベント | いつ | 付ける値 |
|---|---|---|
| `character_story_unlocked` | 話が解放されたとき | `character_id`, `series_id`, `story_id`, `episode`, `required_progress`, `progress` |
| `character_story_opened` | 話を開いたとき（本文を読み込めたとき） | `character_id`, `series_id`, `story_id`, `episode`, `required_progress` |
| `character_story_completed` | 本文の終わりまで読んだとき | 同上 |

`series_id` は季の ID（例 `riko-s01`）、`story_id` は話の ID（例 `riko-s01-e01`）、`episode` は話の order、`progress` は解放時点の Journey Progress。イベントの定義は PixTale 側が正で、第5段階の評価（§12）の材料にする。
