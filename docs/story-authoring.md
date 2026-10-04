# Story の制作 — Astra に一作品を書いてもらう

Story の本文を、ローカルの公式 Codex CLI 経由で、ChatGPT 認証の `gpt-6-astra`（Astra）に書いてもらう制作経路。**Astra が一つの完成した物語を書き、人間が読んで採用してから、数話へ分ける。** 旧経路（`story:plan` → `story:write` で話ごとに下書きする）は Legacy として残す（§11）。

**実装状況（2026-10-03）:** PR 1 = 疎通確認（`story:doctor`）・初稿（`story:draft`）・改稿（`story:revise`）・原稿と実行記録の保存・モックテスト・Claude Code の Skill。分割（`story:split`）・既存の manifest への配置（`story:stage`）・英語版（`story:translate`）は PR 2、PixTale の段階解放は PR 3。配信の形（[stories.md](stories.md) の manifest / feed）は変えていない。

---

## 1. 決めたこと

- **Claude Code は実装・実行・ファイル管理・差分表示を担う。物語の本文（初稿・改稿・翻訳）は Astra が書く。** Claude が Astra の本文を黙って要約・整文・代筆しない。
- **初稿は一作品。** 話数・スキャン回数・解放条件・各話の役割を要求しない。分割は採用のあと（PR 2）。
- **fallback は無い。** 失敗したら止まる。OpenAI の従量課金 API・Workers AI・Gemini・Claude による本文生成へは切り替えない（`authoring/writer.yaml` の `fallback: none`、`src/story/authoring/` は旧経路の生成コードを import しない）。
- **ChatGPT の契約枠を、公式 Codex CLI の ChatGPT 認証で使う。** 利用枠を超えたら止まる。クレジットの購入・自動補充・課金設定の変更はしない。CLI だけで「無制限」「追加課金なし」を保証できるとは言わない。
- **生成・採用・分割の承認・公開は別々の工程。** 制作コマンドは manifest にも `characters/` にも触れず、公開もしない。AI の自己採点を公開の根拠にしない。
- **同じモデルでも、ChatGPT Web と Codex CLI で同じ品質・同じ文章になる保証は無い。** システム指示・ツール・入る文脈・推論設定が違う。この経路は条件の差を減らし、出力を改変せず、人間が品質を確かめられるようにするためのもので、Web との同等を示すものではない。

## 2. 構成

```text
ユーザー → Claude Code の /velum-story
             ↓
   npm run story:draft（src/story/authoring/）  入力を明示的に組み立て、hash を記録
             ↓
   codex exec --model gpt-6-astra             ChatGPT 認証 / 新しいセッション / 執筆専用の文脈
             ↓
   .story-runs/<run-id>/manuscript.raw.md     最終応答をそのまま保存（非公開・draft）
             ↓
   人間が読む → 必要なときだけ story:revise（新しい run。元の原稿は残る）
             ↓
   （PR 2）分割の提案 → コードが元の本文から機械的に切り出す → manifest の draft へ
```

Codex CLI は外部プロセスとして起動し、結果を受け取るだけ。MCP サーバ・常駐 daemon・独自の OAuth・ChatGPT の画面操作は使わない。

## 3. 準備と疎通確認

```bash
codex --version          # 0.153.0 以上（Astra の最小版）。自動更新はしない
codex login              # 未ログインなら。ChatGPT でログインする
npm install -g @openai/codex@<版>   # 版が足りないとき（npm で入れた場合）。確かめた版を指定して上げる
npm run story:doctor     # 推論を呼ばない検査
npm run story:doctor -- --probe   # 固定の短い入力で Astra を1回だけ呼ぶ（live）
```

`story:doctor` の検査（既定では推論しない）:

| 検査 | 内容 |
|---|---|
| config | `authoring/writer.yaml` が読め、執筆用指示のファイルがある |
| gitignore | `.story-runs/` が gitignore されている |
| cli-version | `codex --version` が `cli.min_version` 以上 |
| exec-flags | `codex exec --help` に使うフラグがすべてある |
| auth | `codex login status`（exec と同じ上書き・同じ環境）が ChatGPT |
| catalog | `codex debug models` にモデルがあり、effort（と verbosity）に対応している |
| strict-config | 本番と同じ引数一式を、provider だけ存在しない名前にして `--strict-config` で起動する。全設定が検証され、プロバイダの解決で止まれば ok（通信も推論も起きない） |
| isolation | `codex debug prompt-input`（推論しない）で、モデルに見えるブロックを並べる |
| env | 子の環境から外す変数の名前（値は出さない） |

`--probe` は fail が無いときだけ走り、`.story-runs/<時刻>-astra-probe-<6桁>/` に記録を残す（応答は `probe.raw.txt`）。テストのたびに疎通確認を繰り返さない（テストは偽の Codex だけを使う）。

### 実機で確認した CLI

| 項目 | 値 |
|---|---|
| CLI | `codex-cli 0.153.4`（npm `@openai/codex`） |
| 認証 | ChatGPT（`codex login status` → `Logged in using ChatGPT`。保存先は keyring） |
| カタログ | `gpt-6-astra`。effort は low / medium / high / xhigh / max / ultra、既定 medium。verbosity 対応、既定 low |
| live probe | 2026-10-04 に1回（`story:doctor --probe`）。exit 0・turn.completed・ツールの呼び出しなし・約 5.5 秒。応答は「準備完了」 |
| 実効モデル | **CLI からは確認できない**（exec の JSONL は thread.started / turn.started / item.completed / turn.completed だけで、モデル名を含まない）。run.json は `null` / `not_reported` |
| 入る文脈の量 | 46 バイトの指示と 73 バイトの依頼で input_tokens 3,795。差は CLI が足す開発者指示（§4 の表）など、こちらからは中身を確かめられない部分 |

## 4. Codex CLI の呼び出し

1候補につき新しい `codex exec` を1回。`resume` / `--last` / `fork` は使わない。組み立ては `src/story/authoring/codex-command.ts`、引数の正は `tests/fixtures/authoring/codex-exec-args.json`。

```text
codex exec --ignore-user-config --strict-config --model gpt-6-astra --sandbox read-only
  --skip-git-repo-check --ephemeral --json --color never --cd <作業ディレクトリ>
  --output-last-message <run>/manuscript.raw.md.partial
  -c forced_login_method="chatgpt" -c model_provider="openai"
  -c cli_auth_credentials_store="keyring" -c model_reasoning_effort="high"
  -c model_instructions_file="<run>/instructions.txt"
  -c approval_policy="never" -c project_doc_max_bytes=0 -c web_search="disabled"
  -c history.persistence="none" -c skills.include_instructions=false
  -c features.shell_tool=false -c features.unified_exec=false -c features.apps=false
  -c features.plugins=false -c features.multi_agent=false -c features.multi_agent_v2=false
  -c features.hooks=false -c features.memories=false -c features.image_generation=false
  -c features.view_image=false -c features.goals=false -c features.tool_suggest=false
  -c features.browser_use=false -c features.computer_use=false
  -c tools.update_plan.enabled=false -c tools.experimental_request_user_input.enabled=false
  -        ← 依頼文は stdin（UTF-8）
```

- **shell の文字列ではなく、spawn に渡す引数の配列。** パスに空白・引用符・日本語があっても shell は介在しない。`-c` の値は TOML として読まれるので、パスは引用して渡す。
- **`--strict-config`** が `-c` の未知のキー・未知の値を推論の前に拒否する（0.153.4 で確認）。上の上書きは「黙って無視される」ことがない。ただし effort の値と instructions のファイルの有無は CLI が検証しないので、こちらがカタログと照合し、ファイルを run の中に置いてから渡す。未対応の effort を黙って別の値に直さない。
- **`--ignore-user-config`** はユーザーの開発用の既定設定（モデル・MCP サーバ・プラグイン・通知など）を読まない。ただし `cli_auth_credentials_store` も読まなくなり、そのままでは保存済みのログインが見えない（`file` 扱いで「Not logged in」）。この非機密の設定だけを `writer.yaml` の `credentials_store` から明示する。認証ファイルを読んだり写したり、`CODEX_HOME` を変えたりはしない。
- **認証。** 実行の直前に `codex login status`（同じ上書き・同じ環境）が ChatGPT であることを確かめる。API キーでのログインなら実行しない（`forced_login_method` の不一致で CLI がログアウトさせる副作用を、切り替えの手段にしない）。
- **環境。** 子プロセスの環境は親の複製で、`OPENAI_*` / `AZURE_OPENAI_*` / `CODEX_API_KEY` / `CODEX_*BASE_URL` / `*_API_KEY` / `*_API_TOKEN` を外す。親の環境と設定は変えない。
- **作業ディレクトリ。** Git リポジトリの外に、実行ごとの空のディレクトリを作る（`--cd`）。Codex にファイルを編集させず、最終応答は `--output-last-message` から親プロセスが受け取る。
- **`--json`** は進捗イベントの形式であって、小説を JSON で書かせる指定ではない。初稿で `--output-schema` は使わない。
- **verbosity。** `writer.yaml` の `verbosity: null` は「渡さない」（CLI とモデルの既定。カタログ上 Astra の既定は low）。指定すれば `model_verbosity` として渡し、run に記録する。

### 隔離で消せたもの・消せないもの

`codex debug prompt-input` で確かめた、上の設定のときにモデルへ見えるブロック（0.153.4）:

| ブロック | 扱い |
|---|---|
| 執筆用指示（`model_instructions_file`） | Codex の組み込み指示（"You are Codex…"）を置き換える |
| `<permissions instructions>` | sandbox が read-only であることの説明 |
| `<collaboration_mode>` | 既定のモードの説明 |
| `<environment_context>` | 作業ディレクトリ・日付・タイムゾーン |
| `<multi_agent_role>` / `<multi_agent_mode>` | **既知の残留。** Astra のカタログ（multi_agent_version v2）が足す。`features.multi_agent` / `multi_agent_v2` を切っても公式の設定では消えない。実行時にエージェントの起動が起きたら失敗にする |
| `<skills_instructions>` / `<recommended_plugins>` / Apps・プラグインの指示 / プロジェクトの AGENTS.md | 消した（`skills.include_instructions=false`・`features.apps=false`・`project_doc_max_bytes=0`・`--ignore-user-config`）。doctor は現れたら fail |
| `# AGENTS.md instructions`（`$CODEX_HOME/AGENTS.md`・`AGENTS.override.md`） | **設定では消せない。** `--ignore-user-config` が読まないのは `config.toml` だけで、グローバルの AGENTS.md は別に読まれる。だから、このファイルがあれば `story:draft` / `story:revise` / `--probe` は**起動しない**（preflight が止める）。使うときは一時的に別の場所へ移す（こちらでは消さない・動かさない）。doctor も fail にする |

ユーザー設定を無視しただけで全機能が確実に消えたとは言わない。管理者のポリシー（requirements）は回避しない。`--dangerously-*`・sandbox の bypass・`--ignore-rules` は使わない。

本文の生成中に、許したもの（`agent_message` / `reasoning`）以外のアイテム——コマンドの実行・ファイルの変更・MCP・検索・計画・エージェントの起動——がイベントに現れたら、本文がそろっていても失敗にする。設定での抑止が主で、イベントの検査は補助である。

## 5. 入力

`authoring/` に、以前の Web 試作で使った資料をそのまま置いた。**最初の比較では Claude が要約・改善しない。** hash は `authoring/SHA256SUMS`（テストが照合する）。

| ファイル | 使い方 |
|---|---|
| `authoring/prompts/velum_story_project_instructions.txt` | 執筆用の最小限の指示。`model_instructions_file` |
| `authoring/briefs/velum_riko_writing_brief.md` | writing brief。依頼文へ添付として入れる |
| `authoring/prompts/riko-first-request.txt` | 最初の依頼文。候補の間で同じものを使う |
| `authoring/prompts/velum_story_prompts.md` | Web 試作の手順と、改稿・点検のプロンプトの雛形（参照用。Astra へは渡さない） |

初稿で Astra へ渡すのは3つだけ: 執筆用指示・brief・依頼文。stdin の依頼文は次の形で、brief と依頼文は一字も変えない。コードが足すのは添付の境界だけ（版 `velum-astra-draft-v1`）。Web の試作で brief をプロジェクトの資料として添付し、依頼文が「設定資料「velum_riko_writing_brief.md」を使って」と名前で指していたので、添付の名前は元のファイル名にしてある。

```text
<attachment filename="velum_riko_writing_brief.md">
…brief の全文…
</attachment>

…依頼文の全文…
```

**渡さないもの:** この経路の実装指示書・リポジトリ・旧日記・旧 plan・状態差分・公開用の JSON schema・テストの採点条件・スキャンの閾値・Claude の筋書き・無関係な会話。

**作者だけが知ること。** brief には、主人公が知らない作者用の秘密（首飾りの正体・ミオの系譜）が入っている。旧経路は「本人が知らないことはプロンプトに入れない」（[stories.md](stories.md) §11）だが、この経路は整合のために作者へ渡す。作者用の秘密が入力にあることを理由に、主人公にそれを説明させない。同じ事実はすでに公開リポジトリの `characters/riko/profile.yaml` と `relationships.yaml` にあるので、brief をコミットしても新たに明かすことにはならない。本文に秘密の断片が出たら、run の warnings に出る（断片そのものは書かない）。

新しい人物・小さな出来事は未承認の創作候補で、自動で正史にはしない。Canon との照合は採用前の別工程（`velum_story_prompts.md` §5）。

## 6. 原稿の扱い

コードが原稿に対して自動でしてよいのは次の3つだけ（`src/story/authoring/manuscript.ts`）:

1. 改行コードの正規化（CRLF / CR → LF）
2. 先頭の題を、明示的な書式のときだけ取り出す（`# 題`・`**題**`・`タイトル：題`・行全体が `『題』`）。判定できなければ本文を削らずに warnings で確認を求める
3. 保存と hash の計算

元の最終応答（`manuscript.raw.md`）は必ずそのまま残る。本文（`manuscript.body.txt`）は、改行を正規化した raw から題の行と前後の空行を除いた連続した部分で、ファイルはその末尾に改行を1つ付けたもの。空白を除いて比べると「正規化した raw = 題の行 + 本文」が必ず成り立つ（成り立たなければ保存しない）。

**自動でしないこと:** 長さを合わせる要約、語尾の統一、決め台詞の追加、出ていない人物の追加、旧日記の voice fixture の追加、字数合わせの切り捨て、解説や自己採点の混入を削って成功扱いにすること。

長さ・書式・注記らしい行・秘密の断片は**異常検知**として warnings に出すだけで、失敗にも修復にもしない。3,000〜5,000 字から少し外れた良い原稿を捨てるゲートにはしない。

## 7. 改稿

```bash
npm run story:revise -- --run <run-id> --feedback <feedback.md>
```

`元の原稿の全文 + writing brief + フィードバック` を Astra へ渡す新しい run（版 `velum-astra-revise-v1`）。Claude の要約で代用しない。brief と執筆用指示は、既定で親の run の写しを使う（条件を親と揃える）。フィードバックは `velum_story_prompts.md` §3 の雛形（「残したいところ」「読めなかったところ」）で書く。

元の run は書き換えない（親の raw の hash が記録と違えば止まる）。新しい run に、親の本文との差分 `revision.diff` が残る。日本語は段落が1行になりがちなので、語の単位で見るなら:

```bash
LC_ALL=en_US.UTF-8 git diff --no-index --word-diff=color --word-diff-regex=. .story-runs/<親>/manuscript.body.txt .story-runs/<子>/manuscript.body.txt
```

`LC_ALL` を UTF-8 にしないと、`.` が1バイトに当たり、日本語が文字の途中で切れて表示される。行単位の `revision.diff` が既定の確かめ方である。

## 8. 保存と記録

```text
.story-runs/<run-id>/            gitignore。日常の試作と実行記録
  instructions.txt  brief.md  request.txt     入力の写し（revise は manuscript.parent.md と feedback.md）
  prompt.txt                     stdin へ渡した全文
  run.json                       記録（下）
  events.jsonl  stderr.log       Codex の出力（ストリームで保存）
  manuscript.raw.md              最終応答そのもの（成功時だけ。上書きしない）
  manuscript.raw.md.partial      失敗した run の出力（完成稿へ昇格させない）
  manuscript.body.txt            改行の正規化と題の分離だけ
  revision.diff                  改稿のとき
authoring/manuscripts/<character>/<work-id>/   人間が保存・採用を決めた原稿（コミットすれば公開される）
```

run ID は `<UTC 時刻>-<人物>-<draft|revise|probe>-<6桁>`（例 `20261003T225400Z-riko-draft-1a2b3c`）。

`run.json` に残すもの: run ID・目的・親 run・人物・CLI の版・要求したモデル / effort / verbosity・認証方式と確認の方法・入力と依頼文の SHA-256・時刻・exit code・出力の hash と文字数・usage・イベントの要約・warnings・失敗の種類。

**実効モデル。** CLI のイベントにモデル名が出ていればそれを記録し、出ていなければ `null`（`model_source: not_reported`）。要求したモデルを写して「確認済み」にはしない。モデル自身に名前を答えさせる方法は使わない。同じ入力を記録しても、将来まったく同じ本文が再生成できるとは言わない。ここで確保するのは入力と出力の来歴である。

ファイルは上書きしない（一時ファイルから link で置く）。生成コマンドは同時に1つだけ（`.story-runs/.lock`）。古いロックは自動で消さない。

**`.story-runs/` はコマンドを実行したチェックアウト（git worktree ならその worktree）の中にできる。** gitignore されているので、原稿しか作っていない worktree は「変更なし」に見え、`git worktree remove` で一緒に消える。読む前に worktree を消さない。残す原稿は `authoring/manuscripts/` へ写す（コミットすれば公開される）か、リポジトリの外へ控える。

## 9. 失敗

| 種類 | 何が起きたか | 人がすること |
|---|---|---|
| auth | 認証の失敗 | `codex login`（ChatGPT） |
| usage_limit | 利用枠・レート制限 | 枠の回復を待つ。購入・課金設定の変更はしない |
| model_unavailable | モデルが使えない | アカウントと CLI の版を確かめる。別モデルへ切り替えない |
| config | 設定キー・値の拒否 | `npm run story:doctor` |
| timeout | 上限（既定 30 分）を超えた | `--timeout-minutes` を検討。途中の出力は完成稿にしない |
| interrupted | Ctrl-C など | もう一度実行するかを人が決める |
| unexpected_tool | 執筆中にツールの呼び出し | 隔離の設定を確かめる（`story:doctor`） |
| empty_output / no_turn_completed / turn_failed / stream_error / nonzero_exit / spawn_error | そのほか | `events.jsonl` と `stderr.log` を見る |

**自動再試行は 0 回。** 特に枠切れと timeout を繰り返さない。打ち切るときは子プロセスのグループごと止める（SIGTERM → 猶予のあと SIGKILL）。

Codex は親とは別のプロセスグループで動く（Ctrl-C を確実に受けて、グループごと止めるため）。親は SIGINT・SIGTERM・SIGHUP（端末を閉じたとき）を受けて Codex を止め、`interrupted` として記録する。親が例外で落ちるときも、終了の直前に Codex のグループへ SIGKILL を送る。**親が SIGKILL されたとき（`kill -9`・OS の強制終了）だけは止められない。** そのときは run.json が `running` のまま・ロックが残る。次の実行は「古いロック」で止まるので、`pgrep -fl "codex exec"` で前の Codex が残っていないか確かめてから、ロックを消す。

## 10. Claude Code から

`.claude/skills/velum-story/SKILL.md`。ユーザーが `/velum-story` で明示して起動する（モデルからは起動しない）。

```text
/velum-story draft リコの独立した短編を1本。既定の執筆資料と依頼文でAstraを使ってください。
/velum-story revise <run-id> 残したいところ：… 読めなかったところ：…
```

Skill は入力を確かめ、まず `--dry-run` でモデル・認証・入力・呼び出し回数を示し、承認を得てから実行し、生成ファイルと状態を示す。本文を書き直さない。依頼文を変えるのはユーザーが頼んだときだけ。公開しない。

## 11. 旧経路（Legacy）

`story:plan` / `story:write`（Workers AI の Gemma で話ごとに下書き、Actions の `story.yml`）は残してあるが、新しい制作の既定の手順からは外した。この経路の Skill から旧経路へ戻る分岐は無い。配信側（manifest・本文・feed・export・validate）は [stories.md](stories.md) のまま変わらない。
