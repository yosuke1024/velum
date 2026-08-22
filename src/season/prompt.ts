import type { SeasonContext } from './context.js';
import { jsonSchema } from '../lib/gemini.js';
import { BEATS, EPISODES_PER_SEASON } from '../schemas/season.js';

export const SEASON_PROMPT_VERSION = 'season-v1';

export const SEASON_RESPONSE_SCHEMA = jsonSchema.object(
  {
    title: jsonSchema.string(),
    shape: jsonSchema.string(),
    episodes: jsonSchema.array(
      jsonSchema.object(
        {
          number: jsonSchema.number(),
          beat: jsonSchema.string(),
          events: jsonSchema.array(
            jsonSchema.object(
              {
                summary: jsonSchema.string(),
                where: jsonSchema.string(),
                who: jsonSchema.array(jsonSchema.string()),
              },
              ['summary', 'where', 'who'],
            ),
          ),
          world_change: jsonSchema.nullable(jsonSchema.string()),
          leaves_open: jsonSchema.string(),
        },
        ['number', 'beat', 'events', 'world_change', 'leaves_open'],
      ),
    ),
  },
  ['title', 'shape', 'episodes'],
);

export function buildSeasonSystemPrompt(): string {
  return `あなたは架空世界 Velum の出来事を組み立てる装置である。人物ではない。

役割は、ひとりの主人公をめぐる${EPISODES_PER_SEASON}話ぶんの出来事を、
ひとつづきの物語として設計すること。

## ${EPISODES_PER_SEASON}話の形

${BEATS.map((beat, i) => `第${i + 1}話「${beat}」`).join(' → ')}

- 第1話 発端: 問題が具体的な形をとる。まだ引き返せる。
- 第2話 展開: 話が込み入る。単純だと思っていたことが単純でなくなる。
- 第3話 転機: 何かが変わる。前の2話の前提がひとつ崩れる。
- 第4話 危機: 逃げ道がなくなる。選ばなければならなくなる。
- 第5話 決着: 片がつく。ただし世界は終わらない。次の季へ残り火を置く。

## 守ること

- **出来事だけを書く。** 人物がそれをどう感じたか、何を思ったかは書かない。
  感情・解釈・内面は、このあと本人が日記で書く。ここで書くと、事実と主観が混ざる。
- **${EPISODES_PER_SEASON}話がつながっていること。** 各話は前の話の結果の上に立つ。
  独立した${EPISODES_PER_SEASON}日ではなく、ひとつの物語の${EPISODES_PER_SEASON}場面である。
- **固定事実（canon）と矛盾させない。**
- 1話の出来事は1〜3件。多すぎると一日が事件で埋まり、日常が消える。
- **全部の話を事件にしない。** ${EPISODES_PER_SEASON}話のうち1話くらいは、
  表向き何も起きない日でよい。静かな日があるから、動く日が効く。
- 未解決の問いを全部片づけようとしない。この季で扱うのは1つか2つでよい。
  残りは残したまま次の季へ渡す。
- イベントカードは素材である。そのまま出来事にせず、
  アークと人物の状況に照らして具体化する。使わないカードがあってよい。
- 固定していない細部（通行人の名前、天候、品物）は自由に作ってよい。
- leaves_open には、その話が次へ持ち越すものを書く。
  第5話の leaves_open は、次の季の第1話が拾える形にする。`;
}

export function buildSeasonUserPrompt(context: SeasonContext): string {
  const lines: string[] = [];

  lines.push(`# 第${context.season}季 — ${context.eraName}`);
  lines.push(`主人公: ${context.protagonistName}（${context.role}）`);
  lines.push('');

  lines.push('## 固定事実（これと矛盾させない）');
  for (const fact of context.canon) {
    lines.push(`- ${fact.fact.trim().replace(/\n/g, ' ')}`);
  }
  lines.push('');

  if (context.places.length) {
    lines.push('## 場所');
    lines.push(context.places.join(' / '));
    lines.push('');
  }

  lines.push('## アーク');
  lines.push(`${context.arc.name}: ${context.arc.premise.trim()}`);
  lines.push('');

  lines.push('## 宙に浮いている問い');
  lines.push('この季で扱うのは1つか2つでよい。全部片づけようとしない。');
  for (const item of context.unresolved) {
    lines.push(`- ${item.question}`);
  }
  lines.push('');

  lines.push('## 周囲の人物');
  for (const person of context.people) {
    lines.push(`- ${person.name}（${person.relation}）: ${person.summary}`);
  }
  lines.push('');

  lines.push('## 主人公の人生の出来事');
  for (const event of context.formativeEvents) {
    lines.push(`- ${event}`);
  }
  lines.push('');

  lines.push('## 季の始まりの時点での主人公の状態');
  lines.push(`気分: ${context.state.mood}`);
  lines.push(`直近の目的: ${context.state.immediateGoal}`);
  lines.push(`迷い: ${context.state.doubt}`);
  if (context.state.concerns.length) {
    lines.push(`懸念: ${context.state.concerns.join(' / ')}`);
  }
  if (context.state.unresolvedThoughts.length) {
    lines.push(`抱えている考え: ${context.state.unresolvedThoughts.join(' / ')}`);
  }
  lines.push('');

  if (context.carriedOver) {
    lines.push('## 前の季が残したもの');
    lines.push(context.carriedOver);
    lines.push('第1話はここから始めてよい。');
    lines.push('');
  }

  lines.push('## 素材として引いたイベントカード');
  lines.push('そのまま出来事にしない。使わないカードがあってよい。');
  for (const card of context.cards) {
    lines.push(`- ${card.prompt}`);
  }
  lines.push('');

  lines.push(
    `この材料から、第${context.season}季の${EPISODES_PER_SEASON}話ぶんの出来事を組み立ててください。`,
  );
  lines.push(
    'shape には、この5話でどういう形を描くのかを2〜3文で書いてください（人間が読んで直すための要約です）。',
  );

  return lines.join('\n');
}
