# Visual

5人のキャラクターシートと、`profile.yaml` の `visual` の関係。

**実装状況:** シート候補2枚目を基準として確定（2026-08-23）。確定した表記は `characters/*/profile.yaml` の `visual.sheet` にある。

---

## 1. 「維持してください」は、画像生成に対しては機能しない

キャラクターシートの修正を依頼したとき、指示書はこう書いた。

> シートの体裁は完成しています。レイアウト、書体、セクション構成、全体のトーンは**そのまま維持**してください。変更するのは以下に列挙した箇所のみです。

これは画像生成にとって従いようのない指示である。**部分修正ができず、毎回まっさらから描き直すため。** 「維持して」と書いた欄は保持されるのではなく、毎回引き直される。結果として、修正版1枚ではなく候補が何枚も出てくる。

指示自体は正しく働いた。優先順に並べた5項目——セヴランの年号 1174→4217、ウタの装飾削減と生成り化、カヤの `Guild Seven` → `No. Seven`、テオの年齢感、リコのルーペ名称——は**すべて反映された**。

ずれたのは、指示しなかった欄のほうである。

## 2. カヤだけが repo と一致した

| | `profile.yaml`（正） | シート |
|---|---|---|
| **カヤ** | `Relic Returner, the Reclaimers' Guild — No. Seven` | **一致** |
| テオ 所属 | `the Grand Court of Appraisal`（大鑑定院） | `The Appraisers' Guild` |
| セヴラン 役職 | `Last Scribe of the Record House` | Scribe / Recorder / Chronicler / Archivist… 毎枚違う |
| セヴラン 所属 | `record-house`（記録院） | Archive Accord / Convergence Institute… すべて創作 |
| ウタ 所属 | `sana`（**サナ氏族**） | Listening Clan / First Circle / Hearth of Whispers… **「サナ」が一度も出ない** |

**カヤだけが合っているのは偶然ではない。** 5人のうち彼女だけ、指示書が所属名と番号を文面でそのまま書き下していた。

> 書き下した欄は通り、書かなかった欄は創作される。

引用文も同じである。指示書が「維持」とだけ書いたテオ・セヴラン・ウタの引用文は毎枚違うものになり、カヤとリコ——文面を引用して示した2人——だけが保持された。

## 3. だから、文字は repo が持つ

シートに焼き込まれた文字は、生成のたびに引き直される。加えて、綴りが壊れることもある（ある候補には `I write so that it willd ris happen again` という崩れた行があった）。

したがって、**役職・所属・小物のキャプション・引用文の正は `profile.yaml` である。** シートはそれを絵にしたものであって、逆ではない。シート上の表記が `profile.yaml` と食い違ったら、直すのはシートのほうである。

確定した英文は `visual.sheet` に置いてある。

```yaml
visual:
  sheet:
    base: 候補2枚目（2026-08-23 確定）
    captions:
      - "SIGIL TAG (ISSUED) — Blank. To be earned."
      ...
    expressions: [...]
    quote: "..."
```

## 4. 次にシートを描かせるとき

**「維持して」と書かない。毎回、全項目を書き下す。**

`profile.yaml` から渡すもの:

| 渡すもの | どこから |
|---|---|
| 名前・年齢・役職・所属 | `name` / `age` / `role` / `affiliation` / `designation` |
| 体格・髪・衣装・配色 | `visual.build` / `hair` / `clothing` / `palette` |
| 小物とキャプション | `visual.key_prop` / `props` / `sheet.captions` |
| 表情差分 | `visual.sheet.expressions` |
| 引用文 | `visual.sheet.quote` |
| 描いてはいけないもの | `visual.never_drawn` / `not_held`、および各人の禁則 |

最後の行は落とさないこと。カヤに武器のシルエットが入ると設計が壊れ、ウタに冠が乗ると「与えられた権威」を持ってしまう。**描かないものの指定は、描くものの指定と同じだけ要る。**

## 5. まだ決まっていないこと

- **テオの真鍮のルーペ**と**ウタの骨笛**は、`props` にあるがシート2枚目に描かれていない。持たせるかは未確定（`profile.yaml` に注記済み）
- **テオ・セヴラン・ウタの引用文**は、2枚目のものを暫定で確定とした。もともと固定されていなかったため、差し替えは自由
- シートから `profile.yaml` へ画像生成プロンプトを組み立てるスクリプトは未実装
