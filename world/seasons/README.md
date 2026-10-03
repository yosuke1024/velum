# [Legacy Diary Engine / Season 1 Archive]
#
# ここにあるのは旧 Diary Engine の「季」の計画（1人5話 × 5人の25日分）である。日次の
# 自動生成は 2026-10-03 に止めた（Character Story Engine への再設計。docs/stories.md）。
# 計画は消さずに残してあり、新しい季を立てる予定はない。Story の「季」
# （characters/<id>/stories/s<NN>/、人物ひとりの 8〜10 話の束）とは別物。
#
# 季の計画はここに置かれる。
#
#   <季3桁>/<時代>.yaml   例: 001/guilds.yaml
#
# 1人につき5話、5人で25日分。走らせる前に読んで、直してよい。
#
# サイトが出すのは title / shape / 各話の leaves_open の3種類だけで、この3つは
# { ja, en } で持つ。npm run plan は ja と en の両方を書く（どちらかが欠けるとスキーマが落とす）。
# 日本語を直したら en も直すこと（validate は未訳は数えるが、古い訳は見つけない）。
#
# 詳細は docs/seasons.md。
