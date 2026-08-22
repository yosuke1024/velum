import type { TickContext } from './context.js';
import { jsonSchema } from '../lib/gemini.js';

export const TICK_PROMPT_VERSION = 'tick-v1';

export const TICK_RESPONSE_SCHEMA = jsonSchema.object(
  {
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
  },
  ['events', 'world_change'],
);

export function buildTickSystemPrompt(): string {
  return `あなたは架空世界 Velum の出来事を記録する装置である。人物ではない。

役割は、その日その時代で「何が起きたか」を書くこと。ただそれだけ。

守ること:

- 出来事だけを書く。人物がそれをどう感じたか、何を思ったかは書かない。
  感情・解釈・内面は、このあとの別の工程が担当する。ここで書くと、事実と主観が混ざる。
- 固定事実（canon）と矛盾させない。矛盾したその日は破棄される。
- 出来事は1〜3件。多すぎると一日が事件で埋まり、日常が消える。
  何も起きない日には、何も起きない日の出来事を1件だけ書く。
- 引いたイベントカードを、そのまま出来事にしない。
  カードは種であり、アークと人物の現在状態に照らして具体化する。
  同じカードでも、その人がいま何に焦っているかで別の日になる。
- 未解決スレッドは、必ずしも前へ進めなくてよい。触れない日があってよい。
  毎日進む物語は、毎日クライマックスになる。
- 固定していない細部（通行人の名前、天候、品物）は自由に作ってよい。
- 世界の側の変化がない日は world_change を null にする。`;
}

export function buildTickUserPrompt(context: TickContext): string {
  const lines: string[] = [];

  lines.push(`日付: ${context.date}`);
  lines.push(`時代: ${context.eraName}`);
  lines.push(`この時代の主人公: ${context.protagonistName}（${context.role}）`);
  lines.push('');

  lines.push('## 固定事実（これと矛盾させない）');
  for (const fact of context.canon) {
    lines.push(`- ${fact.fact.trim().replace(/\n/g, ' ')}`);
  }
  lines.push('');

  if (context.places.length) {
    lines.push(`## 場所`);
    lines.push(context.places.join(' / '));
    lines.push('');
  }

  lines.push('## 進行中のアーク');
  lines.push(`${context.arc.name}: ${context.arc.premise.trim()}`);
  lines.push('');

  if (context.thread) {
    lines.push('## いま宙に浮いている問い');
    lines.push(context.thread.question);
    lines.push('（触れても、触れなくてもよい）');
    lines.push('');
  }

  lines.push('## 周囲の人物');
  for (const person of context.people) {
    lines.push(`- ${person.name}（${person.relation}）: ${person.summary.trim().replace(/\n/g, ' ')}`);
  }
  lines.push('');

  lines.push('## 主人公のいまの状態');
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

  lines.push('## 今日引いたイベントカード');
  lines.push(context.card.prompt);
  lines.push('');

  lines.push('この材料から、今日この時代で起きたことを書いてください。');

  return lines.join('\n');
}
