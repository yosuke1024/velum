---
name: velum-story
description: AstraでVelumの完成原稿を制作し、承認後に連載へ整える
disable-model-invocation: true
argument-hint: "[draft|revise|split|stage] [対象と依頼]"
---

# /velum-story — Astra で Story の原稿を作る

ユーザーの依頼: $ARGUMENTS

ローカルの Codex CLI 経由で、ChatGPT 認証の `gpt-6-astra`（Astra）に Velum の物語を書いてもらう。仕様は `docs/story-authoring.md`。この Skill は入力を確かめ、決まった npm コマンドを実行し、生成されたファイルと状態を示すだけである。

## 必ず守ること

- **本文は Astra が書く。** Claude は原稿の本文を書かない・要約しない・整文しない・直さない・足さない。結果を示すときもパスと記録を案内し、本文を改変して貼らない（ユーザーが求めたら、ファイルの全文をそのまま見せてよい）。
- **入力を勝手に変えない。** 依頼文・brief・執筆用指示を変えてよいのは、ユーザーが変更を頼んだときだけ。変えるときは新しいファイルを作り、`authoring/briefs/`・`authoring/prompts/` の既存のファイル（`authoring/SHA256SUMS` で固定）は書き換えない。
- **依頼の文を shell に渡さない。** 上の依頼からサブコマンドと対象（人物・run ID・ファイル）だけを読み取り、下のコマンドの決まった引数に当てはめる。フィードバックなどの自由な文は、ファイルに書いてからパスで渡す。
- **live の前に必ず示して、承認を得る。** Astra を呼ぶ前に `--dry-run` の結果（モデル・effort・verbosity・認証方式・入力のファイルと SHA-256・呼び出し回数・timeout・再試行 0・fallback なし）をユーザーに示し、明示の承認を得てから実行する。1回の承認は1回の run だけに効く。
- **止まる。** 失敗しても自動で再試行しない。別モデル・OpenAI の従量課金 API・Workers AI・Gemini・Claude へ切り替えない。利用枠の超過なら止まって報告する。課金・クレジット・ログイン方式の設定を変えない。
- **公開しない。** `characters/`（manifest と本文）・`world/feed/` に触れない。`export:feed` を回さない。`.story-runs/` の原稿をコミットしない（公開リポジトリ）。採用・分割・公開はユーザーが決める。

## サブコマンド

### draft — 一作品の初稿

1. 引数を決める。指定が無ければ既定の執筆資料と依頼文:
   `--character riko --brief authoring/briefs/velum_riko_writing_brief.md --request authoring/prompts/riko-first-request.txt`
   effort / verbosity / timeout は、ユーザーが指定したときだけ `--effort` / `--verbosity` / `--timeout-minutes` を足す（既定は `authoring/writer.yaml`）。
2. `npm run story:draft -- <引数> --dry-run` を実行し、要約をユーザーに示して承認を求める。
3. 承認されたら、同じ引数で `--dry-run` を外して実行する。数分から最大30分かかるので、Bash の `run_in_background` で走らせ、完了の通知を待つ（途中でもう一度起動しない。ロックで止まる）。Bash の `timeout` は、Codex の上限（既定 30 分。`--timeout-minutes` を付けたらその値）より **5 分以上長い**ミリ秒にする（既定なら 2100000 以上）。ツールの側が先に止めると、timeout ではなく中断として記録される。
4. 終わったら次を示す: run ID、成功か失敗か（失敗なら種類と、表示された「人がすること」）、`.story-runs/<run-id>/manuscript.raw.md` と `manuscript.body.txt` のパス、題、文字数、warnings、usage、実効モデル（`not_reported` ならそのまま「CLI からは確認できない」と書く）。

### revise — 指定の原稿の改稿

1. 対象は成功した run の ID。フィードバックは**ユーザーの言葉をそのまま**ファイルにする（`authoring/prompts/velum_story_prompts.md` §3 の「残したいところ」「読めなかったところ」の雛形に沿う）。Claude が感想を作文・補足しない。足りなければユーザーに聞く。置き場所は `.story-runs/feedback/<日時>.md`。
2. `npm run story:revise -- --run <run-id> --feedback <file> --dry-run` → 示して承認 → `--dry-run` を外して実行（background）。
3. 新しい run ID、`revision.diff` のパス、語単位の差分を見るコマンド（`docs/story-authoring.md` §7。`LC_ALL=en_US.UTF-8` を前に付ける）を示す。元の run は残っている。

### doctor — 疎通確認

`npm run story:doctor`（推論しない）。`--probe` は Astra を1回呼ぶ live なので、draft と同じく事前に示して承認を得る（Bash の timeout も draft と同じく長めに）。

`$CODEX_HOME/AGENTS.md`（または `AGENTS.override.md`）があると、Astra へユーザーの開発用の指示が混ざるので、draft / revise / probe は止まる。そのときはユーザーに伝え、移すかどうかはユーザーが決める（Claude がそのファイルを動かしたり消したりしない）。

## 原稿の置き場所

`.story-runs/` は実行したチェックアウトの中にできる（git worktree ならその worktree の中で、gitignore されている）。ユーザーが読む前に、その worktree を消したり片付けたりしない。終わったら、原稿がどの worktree のどこにあるかを必ず伝える。

### split / stage / translate

まだ実装されていない（PR 2）。そう伝えて何もしない。Claude が自分で原稿を分けたり、manifest へ写したり、訳したりしない。
