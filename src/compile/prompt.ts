import { SNAPSHOT_LIMITS } from '../schemas/limits.js';
import { jsonSchema } from '../lib/gemini.js';
import type { CompileContext } from './context.js';
import { lifeFactsFrom, rememberedFrom, oneLine } from './context.js';
import { ja } from '../lib/bilingual.js';

export const SNAPSHOT_PROMPT_VERSION = 'snapshot-v1';

/**
 * ゲートが落とせる上限は、すべてここでプロンプトに書く。
 *
 * 日記の側（src/diary/prompt.ts）と同じ硬いルールである。バリデータが守っていて
 * プロンプトが伝えていない上限は、厳格なゲートではなく罠になる。
 *
 * tests/unit/snapshot.test.ts が SNAPSHOT_LIMITS のキーを走査するので、
 * 上限を足してここに書き忘れると CI が落ちる。
 */
export function snapshotBoundsLines(): Array<{ limit: string; text: string }> {
  return [
    {
      limit: 'dispositions',
      text: `癖は ${SNAPSHOT_LIMITS.dispositions} 件まで（超えるとこの Snapshot は破棄される）`,
    },
    {
      limit: 'dispositionMaxJa',
      text: `癖ひとつは ${SNAPSHOT_LIMITS.dispositionMaxJa} 文字以内（超えるとこの Snapshot は破棄される）`,
    },
  ];
}

export const SNAPSHOT_RESPONSE_SCHEMA = jsonSchema.object(
  { dispositions: jsonSchema.array(jsonSchema.string()) },
  ['dispositions'],
);

/**
 * 人生から、残ったものだけを取り出させる。
 *
 * 出来事は日記に残っていればよい。Tale コメントに必要なのは、
 * その出来事が人物へ残した振る舞いのほうだけである。
 */
export function buildSnapshotSystemPrompt(): string {
  return [
    'あなたは、ひとりの人物の人生の記録から、その人生が残したものだけを取り出す。',
    '',
    '出来事そのものは要らない。出来事の結果として、その人物に残った振る舞い・態度・癖を書く。',
    '',
    '例:',
    '  人生に起きたこと: 親友に約束を破られた',
    '  残ったもの:',
    '    - 口約束を信用しない',
    '    - 書面や証拠を重視する',
    '    - 親しい相手ほど慎重に距離を測る',
    '',
    '## 守ること',
    '',
    '- **人物の名前を出さない。**「師匠が」「兄が」「長が」も書かない。これを読む側は、その人たちを誰ひとり知らない。関係が残した癖だけを書く。',
    '- **出来事を書かない。**「〜の一件以来」「〜を見てから」も書かない。何が起きたかは別の場所に残っている。',
    '- **直近の出来事へ偏らせない。** 最後に起きたことではなく、人生全体に均した形で書く。',
    '- 理由を説明しない。「〜なので」「〜のため」を書かない。振る舞いだけを書く。',
    '- 抽象的な性格語（誠実、慎重、優しい）で終わらせない。何をするか・何をしないかで書く。',
    '- 同じことを言い換えて並べない。1件ずつ違う振る舞いにする。',
    '- **この人物の可笑しさを削らない。** 生真面目な要約にすると、この人物は死ぬ。物の見方の偏りや、目的からずれた執着は、そのまま癖として残す。',
    '',
    '## 上限',
    '',
    ...snapshotBoundsLines().map((bound) => `- ${bound.text}`),
    '',
    '上限を超えた分は切り詰められない。この Snapshot ごと破棄される。',
  ].join('\n');
}

export function buildSnapshotUserPrompt(context: CompileContext): string {
  const { profile, state, people, era } = context;
  const lines: string[] = [];

  lines.push(`## 人物`);
  lines.push(`${profile.name.ja}。${profile.role.ja}。${profile.age}歳。${era.name.ja}に生きている。`);
  lines.push('');

  lines.push('## 芯');
  lines.push(`願望: ${oneLine(profile.core.wish)}`);
  lines.push(`恐れ: ${oneLine(profile.core.fear)}`);
  lines.push(`矛盾: ${oneLine(profile.core.contradiction)}`);
  lines.push(`隠していること: ${oneLine(profile.core.secret_hidden)}`);
  lines.push('');

  lines.push('## 物の見方');
  lines.push(`物に向ける問い: ${ja(profile.appraisal.question)}`);
  lines.push(`見るところ: ${profile.appraisal.focus}`);
  lines.push(`偏り: ${ja(profile.appraisal.bias)}`);
  lines.push(`可笑しさの出どころ: ${ja(profile.appraisal.humor)}`);
  lines.push('');

  lines.push('## 人生に起きたこと');
  for (const fact of lifeFactsFrom(context.canon)) {
    lines.push(`- ${fact}`);
  }
  lines.push('');

  const remembered = rememberedFrom(context.memories);
  if (remembered.length) {
    lines.push('## 覚えていること（重い順）');
    for (const memory of remembered) {
      lines.push(`- ${memory.summary}`);
    }
    lines.push('');
  }

  lines.push('## 関係');
  lines.push(
    '名前は癖を作った材料であって、書き出すものではない。ここから残った振る舞いだけを取り出す。',
  );
  for (const person of people) {
    lines.push(
      `- ${person.relation}: 信頼 ${person.trust} 警戒 ${person.wariness} — ${person.summary}`,
    );
  }
  lines.push('');

  lines.push('## いまの状態');
  lines.push(`気分: ${state.mood}`);
  lines.push(`直近の目的: ${state.immediate_goal}`);
  lines.push(`迷い: ${state.doubt}`);
  if (state.concerns.length) lines.push(`気にかかっていること: ${state.concerns.join(' / ')}`);
  if (state.habits.length) lines.push(`癖として既にわかっているもの: ${state.habits.join(' / ')}`);
  lines.push('');

  lines.push('### 性格（0.0〜1.0）');
  lines.push(
    Object.entries(state.traits)
      .map(([key, value]) => `${key}: ${value}`)
      .join(' / '),
  );
  lines.push('### 信じていること（0.0〜1.0）');
  lines.push(
    Object.entries(state.beliefs)
      .map(([key, value]) => `${key}: ${value}`)
      .join(' / '),
  );
  lines.push('');

  lines.push(
    `この人生が残した癖を ${SNAPSHOT_LIMITS.dispositions} 件以内で挙げてください。`,
  );
  lines.push(
    '「癖として既にわかっているもの」をそのまま書き写さない。そこに書かれていないものを、人生から取り出してください。',
  );

  return lines.join('\n');
}
