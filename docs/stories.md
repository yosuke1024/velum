# Character Story — 厳選して制作し、Journey Progress で解放する

PixTale の5人の同行者を「知るための物語」。AI で生成・構造化するが、**人間が読んで
選び、直し、公開した Story だけ**が PixTale へ配信される。

**実装状況:** 2026-10-01 に基盤を実装（`src/story/`、`src/export/stories.ts`、
`npm run story:plan` / `story:write`、`world/feed/stories/`）。Riko の第1季の本文は
別途制作する（§9）。

---

## 1. なぜ日記をやめたのか

Season 1（2026-09-01〜）では、5人が5日周期で日記を書き、状態・記憶・Persona Snapshot まで
一貫して生成できた。システムとしては成立している。

読者として読み返すと、**人物を識別することはできても、人物を好きにはならなかった。**
Velum の目的は日記を生成することではなく、**PixTale で同行する人物に愛着を持ってもらう
こと**である。そこから逆算して、Velum を Autonomous Diary Generator から
**Character Story Engine** へ変える。

> 面白い10話 > 面白くない100話

生成量・継続日数・自律性・設定量より、「この人物をもっと見たいか」「この人物と旅を
続けたいか」を優先する。Velum を自律生成デモとして最適化しない。

日記のエンジン（`npm run day`、`daily.yml`）は **Legacy** として残す。Season 1 の日記は
失敗や人間による修正も含めて実験記録であり、消さない（README「Legacy Diary Engine」）。
ただし自動スケジュールは止め、PixTale の主要導線からも外す。

## 2. 成功条件

旧: 人物が世界で毎日生活し、記憶を蓄積し、人格が成長する。

新: **Story を読んだユーザーが、その人物ともっと一緒にいたいと思う。**

各季の評価は、最後まで読んだときに「この人物についてもっと知りたい」「PixTale で
この人物を同行させたい」と感じられるか。起承転結の完成度や設定量は二次的である。

## 3. 構造

```text
characters/<id>/stories/
  s01/
    plan.yaml        季の計画。人間が読んで直す（§7）
    manifest.yaml    公開する単位の台帳。unlock 条件と状態（§5）。本文から切り離す
    e01.ja.md        本文（日本語）。プレーンテキスト、段落は空行区切り
    e01.en.md        本文（英語）
    e02.ja.md ...
```

単位は Character → Season → Episode。1季は 8〜10話を目安にする
（`DEFAULT_EPISODES_PER_STORY = 8`、上限 12）。

ID は `<character>-s<NN>`（季）と `<character>-s<NN>-e<NN>`（話）。
スキーマは `src/schemas/story.ts`、配置は `src/lib/paths.ts`。

## 4. Story の内容と形式

Story は「世界で何が起きたか」ではなく、**この人物がどんな人なのか**を伝えるために作る。

**Plot の中に Character を入れるのではなく、Character から Plot を発生させる。**
各話の出発点は「この回で読者に人物の何を知ってほしいか」であって、事件ではない。
ミオとの朝食、値切られて本気で腹を立てる、売った品を惜しくなって買い戻そうとする、
ガロンを遠くから見つけて隠れる——そういう回を積極的に入れる。

日記形式を必須にしない。話ごとに最も合う形式を選ぶ（`STORY_FORMATS`）:
一人称 / 三人称 / 会話中心 / 手紙 / 記録 / 回想 / 短い一場面。
人物の声（profile.yaml の voice）は維持するが、「本人がその日の夜に日記を書く」という
制約から解放する。

### レビューの評価軸（人間が読むときの観点。生成には強制しない）

各話を読んだあと:

- その人物について新しい何かが分かったか
- 設定ではなく、行動から性格が見えたか
- 誰かとの関係が見えたか
- 感情が少なくとも一度動いたか
- 固有名詞や世界設定を理解しなくても読めるか
- 次の話を読みたいと思えるか

生成プロンプトに大量の禁止事項を足して文章を硬直させない。プロンプト
（`src/story/prompt.ts`）に書くのは方向と、守らなければ世界が壊れる少数の決まりだけ。
構造ゲート（`src/story/write.ts` の `storyGate`）が見るのも形だけ——長さ・言語の混在・
Markdown 装飾。面白いかどうかはゲートが見ない。

## 5. 状態と公開 — 生成 ≠ 公開

manifest.yaml が季と話の状態を持つ。

```text
draft  →  reviewed  →  published
```

- **feed へ出るのは、季と話の両方が published のものだけ。** 草稿は人間が読まずに
  公開されることがない。
- 話の状態は季の状態より先へ進めない（draft の季に published の話は作れない）。
- published の話は第1話から連続している（第3話だけ公開、はできない。解放の階段に穴が開く）。
- 書き直した話は draft へ戻る（reviewed は「この本文を読んだ」の印なので、本文が変われば無効）。
- published の話は `story:write --force` でも書き直せない。先に status を戻す。

これらはスキーマ（`StoryManifestSchema` の superRefine）が持つ不変条件で、`npm run validate`
がファイル間の整合（本文の有無・ディレクトリ名・feed との食い違い）を見る。

### Unlock 条件

各話は `required_progress` を持つ。PixTale で同行者を選んで Scan に成功するごとに
その人物の **Journey Progress** が 1 進み、閾値に達した話が解放される。

既定の階段は `world/stories.yaml`:

| Episode | Required Progress |
|---:|---:|
| 1 | 0 |
| 2 | 2 |
| 3 | 5 |
| 4 | 9 |
| 5 | 14 |
| 6 | 20 |
| 7 | 27 |
| 8 | 35 |

第1話は 0——同行者を選んだ時点で読める。まだ好きでもない人物のために「まず5回
Scan してください」と要求しても成立しない。序盤3話は早く解放し、人物を知ってから
中盤へ進ませる。**この数字はアプリにハードコードしない。** manifest が話ごとの値を
持ち、feed がそれを運ぶ。話ごとに manifest で直してよい（単調非減少であること）。

PixTale 側は Scan 回数と Story を直接結合せず、Activity → Journey Progress → Story Unlock
の抽象層を挟む。初期実装の Activity は Scan だけで、Battle・Realm・Title などは将来
Progress へ加える。一度 unlock した話は端末に記録し、閾値を変えても再ロックされない。

## 6. feed — world/feed/stories/

既存の diary feed（`docs/feed.md`）は壊さない。schema_version も動かさない。
Story feed を**並列に追加**する。

| パス | 用途 | 上限 |
|---|---|---|
| `world/feed/stories/index.json` | 人物ごとの、公開済みの季の一覧 | 16KB |
| `world/feed/stories/<story-id>.json` | 1季ぶんの全話（本文込み） | 256KB |

```jsonc
// index.json
{
  "schema_version": 1,
  "generated_at": "…",
  "characters": {
    "riko": {
      "series": [{ "id": "riko-s01", "season": 1, "title": { "ja": "…", "en": "…" },
                   "path": "world/feed/stories/riko-s01.json", "episode_count": 3 }]
    }
  }
}
// riko-s01.json
{
  "schema_version": 1, "generated_at": "…",
  "id": "riko-s01", "character_id": "riko", "season": 1,
  "title": { "ja": "…", "en": "…" }, "summary": { "ja": "…", "en": "…" },   // summary は任意
  "status": "published",
  "path": "world/feed/stories/riko-s01.json",
  "episodes": [{
    "id": "riko-s01-e01", "order": 1, "required_progress": 0,
    "title": { "ja": "…", "en": "…" }, "format": "first_person",            // format / summary は任意
    "body": { "ja": "…", "en": "…" }                                        // プレーンテキスト。段落は空行区切り
  }]
}
```

- `index.json` は公開が1本も無くても書く（`characters: {}`）。アプリが 404 を
  「取得失敗」ではなく「まだ無い」と読めるようにするため。
- 公開を取り下げた季のファイルは `npm run export:feed` が消す。index に無いファイルが
  残っていれば validate が落とす。
- 秘匿情報（`core.secret_*`・`hidden_from_protagonist`）は validate が断片照合で検査する。
  本文は人間がレビューしてから published にする前提だが、検査は残す。
- 変えてよいもの / いけないものは diary feed と同じ規約（`docs/feed.md` §7）。

## 7. 制作の流れ

```bash
npm run story:plan  -- --character riko --season 1              # 8話で季を設計 → plan.yaml / manifest.yaml（draft）
npm run story:plan  -- --character riko --season 1 --episodes 10
npm run story:plan  -- --character riko --season 1 --dry-run    # プロンプトだけ見る
npm run story:write -- --character riko --season 1              # 本文の無い話を全部書く（draft）
npm run story:write -- --character riko --season 1 --episode 3  # 1話だけ
npm run story:write -- --character riko --season 1 --force      # 本文があっても書き直す（published は不可）
# 読む。直す。manifest.yaml の status を reviewed → published へ進める。
npm run export:feed                                             # published だけが world/feed/stories/ へ
npm run validate
```

### plan.yaml

旧 Season Plan の固定5構造（発端→展開→転機→危機→決着）は使わない。

```yaml
character_arc:
  start: …               # 季のはじめの人物
  emotional_change: …    # 季のあいだに動くもの
  end: …                 # 季のおわりの人物。成長や教訓に着地させる必要はない
relationships:
  focus: [mio, garon]
episodes:
  - order: 1
    purpose: "RikoとMioの日常を見せる"   # 読者に知ってほしいこと。Plot Beat ではない
    situation: "市の隅の荷車。…"        # 場面の種。結末は書かない
    format: first_person
    people: [mio]                        # 周りの人の id だけ。端役は書かない
    working_title: ミオは何も買わない
```

`story:plan` は manifest を**同期**する——人間が manifest に書いた title / status /
required_progress は `--force` でも消さない。計画に増えた話だけを draft で足し、
計画から消えた話は残す（`src/story/plan.ts` の `syncManifest`）。

### 生成に渡すもの / 渡さないもの

渡す: profile（芯・声・物の見方・本人が知っている秘密）、周りの人（本人から見た要約）、
人生の出来事、時代の固定事実、場所の名前、声の基準（`tests/fixtures/voice/<id>.md`）。

渡さない: `core.secret_unknown_to_self`、`hidden_from_protagonist`（日記と同じ境界。
作家が本人の知らない秘密を知っていれば、本文がそれを匂わせはじめる）。
`current-state.yaml`・`memories.yaml`（Story は Base Persona で書く。§8）。

## 8. Persona Snapshot との関係

Story の解放はユーザーごとに進度が違う。第8話まで読んだユーザーと第1話しか読んでいない
ユーザーが同じ Persona Snapshot を見ると、同行者が Story を先取りしたり、まだ経験して
いない人格変化を示したりしうる。

MVP ではこれを避けるため、**Story 第1季では Base Persona を安定させ、Story による重大な
人格変化を Snapshot へ即時反映しない。** まず「人物を知るための Story」として運用する。

Progress 連動の Snapshot（Journey Progress → Persona Stage → Snapshot Version を PixTale
Proxy が選ぶ）は第二段階で設計する。今回の MVP には含めない。

## 9. 進め方（Riko を Pilot にする）

最初から5人ぶんを作らない。Riko から始める——Season 1 でも人物として最も分かりやすく、
ミオ / ガロンという関係者が機能し、商売・偽物・本物・金銭という日常の題材があり、
PixTale の「物の鑑定」とテーマが近い。

1. 基盤（このドキュメント）— 実装済み
2. PixTale の Stories 画面と Journey Progress — pixapps 側
3. Riko 第1季の制作 — `story:plan` → `story:write` → 人間レビュー → 修正 → published
4. 評価 — 自分で Riko を同行者にして 10〜20 Scan し、Season 1 の日記より愛着が増えたか
5. 成功した場合のみ Uta / Teo / Sevran / Kaya へ展開

`characters/riko/stories/s01/manifest.yaml` には draft の台帳だけが置いてある
（題「売れないもの」、8話、既定の階段）。plan.yaml と本文はまだ無い。

## 10. フィクスチャ

`tests/fixtures/stories/` に Riko 第1季のダミー Story（published 3話 / reviewed 1話 /
draft 1話）がある。`npm run export:feed -- --fixtures` が
`tests/fixtures/feed/world/feed/stories/` を作り直し、PixTale の Stories UI は本番に
公開済みの季が無い期間もこれで全状態を作れる。本文はテスト用の短い文で、本物の
Riko 第1季とは別物である。
