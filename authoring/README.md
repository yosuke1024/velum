# authoring/ — Story を書くための入力

Astra（Codex CLI 経由の `gpt-6-astra`）に Story を書いてもらう制作経路の、入力と設定を置く。使い方は [docs/story-authoring.md](../docs/story-authoring.md)。

```text
writer.yaml          呼び出しの設定（モデル・effort・認証・timeout）。fallback は none
briefs/              writing brief（作者へ渡す設定資料）
prompts/             執筆用の最小限の指示・依頼文・Web 試作のプロンプト集（参照用）
SHA256SUMS           briefs/ と prompts/ の hash。テストが照合する
manuscripts/         人間が保存・採用を決めた原稿（まだ無い）
```

- **briefs/ と prompts/ の4ファイルは、以前の Web 試作で使ったものをそのまま写した。** 最初の比較では書き換えない。変えるときは新しいファイルを足し、`SHA256SUMS` の4ファイルは残す。
- **このリポジトリは公開されている。** ここに置いたものは誰でも読める。brief には主人公が知らない作者用の秘密が入っているが、同じ事実は `characters/riko/profile.yaml` と `relationships.yaml` にすでにある。未公開にしたい原稿は、ここではなく gitignore された `.story-runs/` に置いたままにする。
- 制作の run（原稿・実行記録）は `.story-runs/<run-id>/` に書かれ、コミットされない。`manuscripts/` へ写すのは人が決めたときだけで、写すこと自体は採用でも公開の承認でもない。
