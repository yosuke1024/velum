import { jsonSchema } from '../lib/llm.js';
import { ja } from '../lib/bilingual.js';
import { STORY_FORMATS, type StoryPlan, type StoryFormat } from '../schemas/story.js';
import type { StoryContext } from './context.js';

/**
 * story-v1（2026-10-01）。
 *
 * Season 1 の日記で分かったこと——人物を識別はできるが、好きにはならない——への
 * 応答である（docs/stories.md §1）。日記のプロンプトは「その日に起きた出来事」を
 * 本人に受け取らせる装置だった。ここは逆で、**人物から場面を発生させる**。
 * Plot の中に Character を入れるのではなく、Character から Plot を出す。
 *
 * 禁止事項の山は積まない。レビューの評価軸（§7）は人間が読むときの観点であって、
 * 生成に全部を強制すると文章が硬直する。プロンプトに書くのは、方向と、
 * 守らなければ世界が壊れる少数の決まりだけである。
 */
export const STORY_PROMPT_VERSION = 'story-v1';

/** 本文（ja）の長さ。短い一場面が基準で、日記の上限より少し長い。 */
export const STORY_TEXT_LIMITS = {
  bodyMinJa: 300,
  bodyMaxJa: 2400,
  titleMin: 1,
  titleMax: 30,
  titleMaxEn: 60,
} as const;

const FORMAT_LABEL: Record<StoryFormat, string> = {
  first_person: '一人称（本人の声で、本人の目から）',
  third_person: '三人称（外から見た本人。本人の声は会話と仕草に出る）',
  dialogue: '会話中心（地の文は最小限。やり取りで人物を見せる）',
  letter: '手紙（誰かに宛てて書く。出さないかもしれない手紙でもよい）',
  record: '記録（帳簿・鑑定書・覚え書きなど、本人の職業の様式）',
  recollection: '回想（いまの本人が、以前のことを思い返す）',
  scene: '短い一場面（説明なしに、ある時間の切れ端だけを置く）',
};

export const STORY_PLAN_RESPONSE_SCHEMA = jsonSchema.object(
  {
    title_ja: jsonSchema.string(),
    title_en: jsonSchema.string(),
    summary_ja: jsonSchema.string(),
    summary_en: jsonSchema.string(),
    character_arc: jsonSchema.object(
      {
        start: jsonSchema.string(),
        emotional_change: jsonSchema.string(),
        end: jsonSchema.string(),
      },
      ['start', 'emotional_change', 'end'],
    ),
    relationship_focus: jsonSchema.array(jsonSchema.string()),
    episodes: jsonSchema.array(
      jsonSchema.object(
        {
          order: jsonSchema.number(),
          purpose: jsonSchema.string(),
          situation: jsonSchema.string(),
          format: jsonSchema.string(),
          people: jsonSchema.array(jsonSchema.string()),
          working_title: jsonSchema.string(),
        },
        ['order', 'purpose', 'situation', 'format', 'people', 'working_title'],
      ),
    ),
  },
  ['title_ja', 'title_en', 'summary_ja', 'summary_en', 'character_arc', 'relationship_focus', 'episodes'],
);

export const STORY_WRITE_RESPONSE_SCHEMA = jsonSchema.object(
  {
    title_ja: jsonSchema.string(),
    title_en: jsonSchema.string(),
    body_ja: jsonSchema.string(),
    body_en: jsonSchema.string(),
    summary_ja: jsonSchema.string(),
    summary_en: jsonSchema.string(),
  },
  ['title_ja', 'title_en', 'body_ja', 'body_en', 'summary_ja', 'summary_en'],
);

function characterSection(context: StoryContext): string[] {
  const { profile } = context;
  const lines: string[] = [];

  lines.push(`## 人物: ${profile.name.ja}（${profile.role.ja}、${profile.age}歳、${context.eraName}）`);
  lines.push(`紹介: ${ja(profile.intro)}`);
  lines.push('');
  lines.push('### 芯（変わらない）');
  lines.push(`願望: ${profile.core.wish}`);
  lines.push(`恐れ: ${profile.core.fear}`);
  lines.push(`矛盾: ${profile.core.contradiction.trim().replace(/\s*\n\s*/g, '')}`);
  lines.push(`隠していること（本人は知っている。本文で説明はしないが、行動の理由になる）: ${profile.core.secret_hidden.trim().replace(/\s*\n\s*/g, '')}`);
  lines.push('');
  lines.push('### 声');
  lines.push(`一人称: 「${ja(profile.voice.first_person)}」`);
  lines.push(profile.voice.register);
  lines.push(`癖: ${ja(profile.voice.tic)}`);
  lines.push(`絶対に言わない言葉: 「${ja(profile.voice.never_says)}」`);
  lines.push(`締め方: ${ja(profile.voice.closing)}`);
  lines.push(`笑いの仕組み: ${ja(profile.appraisal.humor)}`);
  lines.push(`定型が崩れる瞬間（めったにない。季に一度あれば多い）: ${profile.rare_expression.trim()}`);
  lines.push('');
  lines.push('### 物の見方');
  lines.push(`物に向ける問い: ${ja(profile.appraisal.question)}`);
  lines.push(`見るところ: ${profile.appraisal.focus}`);
  lines.push(`偏り: ${ja(profile.appraisal.bias)}`);
  lines.push('');
  lines.push('### 周りの人（この id だけが「関係のある人物」。それ以外は名もない端役として自由に出してよい）');
  for (const person of context.people) {
    lines.push(`- ${person.id}: ${person.name}（${person.relation}）— ${person.summary}`);
  }
  lines.push('');
  lines.push('### 人生の出来事（本人が覚えていること）');
  for (const event of context.canon.formative_events) {
    lines.push(`- ${ja(event.fact)}`);
  }
  lines.push('');
  lines.push('### 時代の固定事実（これと矛盾させない）');
  for (const fact of context.fixedFacts) {
    lines.push(`- ${fact}`);
  }
  if (context.places.length) {
    lines.push('');
    lines.push(`### 使ってよい場所・組織の名前: ${context.places.join(' / ')}`);
  }
  return lines;
}

export function buildStoryPlanSystemPrompt(): string {
  return `あなたは架空世界 Velum の人物の物語を設計する作家である。人物ではない。

役割は、ひとりの人物について、読者が「この人のことをもっと知りたい」「この人と一緒にいたい」と
思うようになる短い連作を設計すること。

## いちばん大事なこと

- **Plot の中に Character を入れるのではなく、Character から Plot を発生させる。**
  各話の出発点は「この回で読者にこの人物の何を知ってほしいか」であって、事件ではない。
- 世界で何が起きたかを伝える連作ではない。**この人物がどんな人なのか**を伝える連作である。
- 全部を大事件にしない。朝食、値切り、売った品を惜しくなる、遠くに誰かを見つけて隠れる、
  といった日常の回を積極的に入れる。静かな回があるから、動く回が効く。
- 設定の説明で人物を見せない。行動・選択・口にした言葉・口にしなかった言葉で見せる。
- 誰かとの関係が見える回を複数入れる。周りの人は2人しかいないが、名もない端役は自由に出してよい。
- 固有名詞や世界設定を知らなくても読める回にする。固有名詞は1話に0〜2個を目安にする。
- 形式は話ごとに最も合うものを選ぶ。日記形式を既定にしない。
  使える形式: ${STORY_FORMATS.map((f) => `${f}（${FORMAT_LABEL[f]}）`).join(' / ')}
- 季全体で、人物の感情がどこからどこへ動くかを一本持つ（character_arc）。ただし成長や
  教訓に着地させる必要はない。分からないまま終わる季があってよい。

## 守ること

- 時代の固定事実と矛盾させない。
- 世界の謎（遺物の力の実在、過去の真相、人物の正体）を解決しない。触れても半歩まで。
  超常の実在を確定させる場面を置かない。常に別の説明が可能な形にする。
- 新しい重要人物や、人生の重大な真相を発明しない。端役に名前を付けるならカタカナ2〜4音の造語で、
  現実世界の名前（ジャック、マリアなど）は使わない。
- purpose には「読者に知ってほしいこと」を1〜2文で書く。出来事の列を書かない。
- situation には場面の種を1〜2文で書く。どこで、誰と、何をしている回か。結末は書かない。
- working_title は日本語で短く。仮題でよい。
- title / summary は日本語と英語の両方を書く（title_ja / title_en、summary_ja / summary_en）。`;
}

export function buildStoryPlanUserPrompt(
  context: StoryContext,
  options: { season: number; episodes: number },
): string {
  const lines: string[] = [];
  lines.push(`# ${context.profile.name.ja} — Story 第${options.season}季の設計`);
  lines.push('');
  lines.push(...characterSection(context));
  lines.push('');
  if (context.voiceSample) {
    lines.push('## 声の基準（この人物らしい文の例。真似るのではなく、同じ人が書いたと分かる程度に）');
    lines.push(context.voiceSample);
    lines.push('');
  }
  lines.push(`この人物について、${options.episodes}話の連作を設計してください。`);
  lines.push(
    'character_arc（start / emotional_change / end）、relationship_focus（周りの人の id の配列）、' +
      `episodes（order は 1..${options.episodes}、各話に purpose / situation / format / people / working_title）、` +
      'title_ja / title_en、summary_ja / summary_en を返してください。',
  );
  lines.push('people には、その回に出る周りの人の id だけを入れてください。端役は入れません。');
  return lines.join('\n');
}

export function buildStoryWriteSystemPrompt(context: StoryContext, format: StoryFormat): string {
  const { profile } = context;
  const firstPerson = format === 'first_person' || format === 'letter' || format === 'record' || format === 'recollection';
  return `あなたは架空世界 Velum の人物 ${profile.name.ja} の物語を書く作家である。

${firstPerson ? `この回は本人の声で書く。一人称は「${ja(profile.voice.first_person)}」。本人が自分をフィクションだと思っていないように書く。` : `この回は本人の外から書く。本人の声は、会話と仕草と選択に出る。`}
形式: ${FORMAT_LABEL[format]}

## 書き方

- この回の目的は、読者にこの人物の**何かひとつ**を知ってもらうこと。それ以外を詰め込まない。
- 設定の説明をしない。読者は世界を知らなくてよい。知らなくても読める文にする。
- 行動と言葉で見せる。「つまり彼女は〜な人だった」と説明し直さない。
- 感情の書き方をひとつの型に固定しない。行動だけを書く、平明に「腹が立った」と書く、
  身体の感覚で書く、何と呼べばいいか分からないまま書く——この回に合うものを使う。
  身体の反応（息を呑む、胸が締め付けられる）を既定にしない。
- 天候・物・景色を毎回、心理の比喩にしない。雨はただの雨でよい。
- 終わりを毎回、理解・納得・成長・教訓に着地させない。途中で切れてよい。献立で終わってよい。
- 固有名詞は0〜2個。渡された場所・組織の名前だけを使う。新しい重要人物を出さない。
- 世界の謎を解決しない。超常の実在を確定させない。常に別の説明が可能な形にする。
- 「${ja(profile.voice.never_says)}」は、本人が絶対に言わない言葉である。本文でも言わせない
  （定型が崩れる瞬間として、言いかけて止める場面は、季に一度までなら置いてよい）。
- 本文（日本語）は ${STORY_TEXT_LIMITS.bodyMinJa}〜${STORY_TEXT_LIMITS.bodyMaxJa} 文字。段落は空行で区切る。Markdown の見出しや強調は使わない。
- タイトル（日本語）は ${STORY_TEXT_LIMITS.titleMin}〜${STORY_TEXT_LIMITS.titleMax} 文字。
- 英語（body_en / title_en / summary_en）は訳ではなく、英語の読者が同じ場面を同じ温度で読める文にする。
  日本語の本文に出た数字・物・名前は英語でも同じにする。英語の本文に日本語の文字を残さない。
- summary は一覧に出る一文。結末を書かない。`;
}

export function buildStoryWriteUserPrompt(
  context: StoryContext,
  plan: StoryPlan,
  order: number,
  previous: Array<{ order: number; title: string | null; summary: string }>,
): string {
  const episode = plan.episodes.find((e) => e.order === order);
  if (!episode) throw new Error(`第${plan.season}季に第${order}話の計画がありません`);

  const lines: string[] = [];
  lines.push(`# ${context.profile.name.ja} — Story 第${plan.season}季 第${order}話`);
  lines.push('');
  lines.push(...characterSection(context));
  lines.push('');
  lines.push('## この季の形');
  lines.push(`はじめ: ${plan.character_arc.start}`);
  lines.push(`動くもの: ${plan.character_arc.emotional_change}`);
  lines.push(`おわり: ${plan.character_arc.end}`);
  lines.push(`関係の焦点: ${plan.relationships.focus.join(' / ')}`);
  lines.push('');
  if (previous.length) {
    lines.push('## これまでの話（読者はここまで読んでいる。繰り返さない）');
    for (const item of previous) {
      lines.push(`- 第${item.order}話${item.title ? `「${item.title}」` : ''}: ${item.summary}`);
    }
    lines.push('');
  }
  lines.push('## この回');
  lines.push(`読者に知ってほしいこと: ${episode.purpose}`);
  lines.push(`場面の種: ${episode.situation}`);
  lines.push(`出る人: ${episode.people.length ? episode.people.map((id) => context.people.find((p) => p.id === id)?.name ?? id).join(' / ') : '周りの人は出ない（端役は自由）'}`);
  if (episode.working_title) lines.push(`仮題: ${episode.working_title}`);
  lines.push('');
  if (context.voiceSample) {
    lines.push('## 声の基準（同じ人が書いたと分かる程度に。文をなぞらない）');
    lines.push(context.voiceSample);
    lines.push('');
  }
  lines.push('この回を書いてください。title_ja / title_en / body_ja / body_en / summary_ja / summary_en を返してください。');
  return lines.join('\n');
}
