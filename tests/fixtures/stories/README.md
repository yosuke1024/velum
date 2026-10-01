# Story フィクスチャ（Riko Season 1）

`characters/<id>/stories/s01/` と同じ構造を持つ、**テスト用のダミー Story**。
本番の `characters/riko/stories/s01/` とは別物で、本文は短い検証用の文である。
Riko の Season 1 の本物は、`npm run story:plan` → `npm run story:write` →
人間のレビュー → `published` の順で作る（docs/stories.md）。

## 何を見るためのものか

- published / reviewed / draft の3状態が混ざった manifest から、
  **published の話だけ**が feed へ出ること
- 第1話の required_progress が 0 で、以後が単調非減少であること
- 本文の ja / en が両方そのまま運ばれること
- front matter（`---` で囲んだメモ）が本文から落ちること

`npm run export:feed -- --fixtures` が、ここから
`tests/fixtures/feed/world/feed/stories/` を作り直す。
