import { z } from 'zod';
import { jsonSchema } from '../lib/llm.js';
import { STORY_WRITE_LIMITS } from '../schemas/limits.js';
import { STORY_FORMATS, storyEpisodeId, type StoryFormat } from '../schemas/story.js';
import type { StoryContext } from './context.js';

/**
 * story-plan-v1 / story-write-v1（2026-10-03）: 初版。
 *
 * Character Story は、旧 Diary Engine の「季」（5話×5人の25日、固定5構造）とは別物である。
 * 目的は一つ——読者がこの人物を好きになり、いっしょに旅をしたいと思うこと。
 * 「よい10話は、悪い100話に勝つ」。したがってプロンプトは次の方向を向く。
 *
 * 1. 人物を筋の中に置かない。人物から筋を起こす。各話の目的（purpose）は
 *    「この回で読者に人物の何を知ってほしいか」であって、筋の段取りではない。
 *    旧 Season Plan の固定5構造は使わない。
 * 2. 形式を話ごとに選ぶ（STORY_FORMATS）。毎晩の日記の体裁は既定にしない。
 *    人物の声は保つが、「その日の夜に本人が書く」制約からは解放する。
 * 3. 固有名詞も世界の事情も知らない読者が読める。新しく名前の付く人物は1話に0〜2人まで、
 *    使うなら周りの2人を使う。
 * 4. 禁止を積まない（オーナーの方針）。足したのは方向づけと、世界を壊す少数の硬い規則だけ:
 *    超常の実在を確定させない／本人だけが知っていることを明かさない／Markdown を使わない。
 *    「良い文章かどうか」の基準は人間のレビューのものであって、生成ゲートには持たない。
 * 5. Base Persona だけの物語。Persona Snapshot がまだ進行度に追随しないので、
 *    人物が大きく変わる話は書かせない。
 *
 * Gemma への書き方は diary-v6 / v7 の教訓に従う。指示は文字どおりに読まれるので、
 * 空にしてよい欄を名指しし、全欄の言語・長さ・形を定義する。ゲートが落とせる上限は
 * すべて STORY_WRITE_LIMITS から文面を組み立てて書く（storyBoundsLines）。
 *
 * 英語版は本文の二度目の呼び出しで書く（直訳にしないため）。一度に二言語を返させると、
 * 長い本文の後半で英語が尻切れになり、片方の出来が落ちる（diary の実測）。
 *
 * ---
 *
 * 以後の変更は、この上に日付つきで積む。バージョンを上げたら、manifest の
 * generation.prompt_version に残るので、どの版で下書きされた本文かが読み返せる。
 */
export const STORY_PLAN_PROMPT_VERSION = 'story-plan-v1';
export const STORY_WRITE_PROMPT_VERSION = 'story-write-v1';

// ── 形式の説明 ─────────────────────────────────────────────

/**
 * 形式ごとの説明。計画（どれを選ぶか）と本文（どう書くか）の両方がここを読む。
 * 日記の体裁（日付・その日の締め）は、どの形式でも要らない。
 */
export const STORY_FORMAT_GUIDE: Record<StoryFormat, string> = {
  first_person:
    '一人称。本人が語る。独白でも、聞き手のいない語りでもよい。日記の体裁（日付・その日の締め）にしない。',
  third_person:
    '三人称。語り手が人物の行動と周りを、少し離れて描く。人物の話し方は台詞と仕草に残す。',
  dialogue:
    '会話が中心。地の文は最小限にする。誰が話しているかが、話し方で分かるようにする。',
  letter:
    '手紙。誰かに宛てて書く（周りの人でも、渡せない相手でもよい）。書く相手を意識した言い方になる。',
  record:
    '記録・帳面・メモ・値札など、人物が残す断片。形式そのものが人物を表す。',
  recollection:
    '回想。いまの人物が、過去のある場面を思い返す。いまと過去を行き来してよい。',
  scene:
    'ひとつの場面を、時間をあまり進めずに描く。短くてよい。',
};

function formatGuideLines(): string[] {
  return STORY_FORMATS.map((format) => `- ${format}: ${STORY_FORMAT_GUIDE[format]}`);
}

// ── 上限 ───────────────────────────────────────────────────

export type StoryBoundsLine = {
  limit: keyof typeof STORY_WRITE_LIMITS;
  lang: 'ja' | 'en';
  text: string;
};

/**
 * ゲートが落とせる上限は、すべてここでプロンプトに書く。
 *
 * 日記の側（src/diary/prompt.ts の boundsLines）と同じ硬い規則である。バリデータが守っていて
 * プロンプトが伝えていない上限は、厳格なゲートではなく罠になる。モデルは指示に従ったのに
 * 1話を失う。文面は STORY_WRITE_LIMITS から組み立てるので、定数を変えれば文面も変わる。
 *
 * tests/unit/story-prompt.test.ts が STORY_WRITE_LIMITS のキーを走査して、
 * ここに対応する行がない上限を検出する。上限を足してここに書き忘れたら CI が落ちる。
 *
 * `lang` はどの呼び出しのプロンプトに載せるか。日本語版の呼び出しは ja の行を、
 * 英語版の呼び出しは en の行を読む。題の上限は計画（working_title）も読む。
 */
export function storyBoundsLines(): StoryBoundsLine[] {
  const L = STORY_WRITE_LIMITS;
  return [
    {
      limit: 'bodyJaMinChars',
      lang: 'ja',
      text: `本文（日本語）は ${L.bodyJaMinChars} 文字以上。下回ると、この話は破棄される`,
    },
    {
      limit: 'bodyJaMaxChars',
      lang: 'ja',
      text: `本文（日本語）は ${L.bodyJaMaxChars} 文字以下。上回ると、この話は破棄される`,
    },
    {
      limit: 'titleJaMaxChars',
      lang: 'ja',
      text: `題（日本語）は ${L.titleJaMaxChars} 文字以内で、空にしない。超えると、破棄される`,
    },
    {
      limit: 'bodyEnMinWords',
      lang: 'en',
      text: `本文（英語）は ${L.bodyEnMinWords} 語以上。下回ると、この話は破棄される`,
    },
    {
      limit: 'bodyEnMaxWords',
      lang: 'en',
      text: `本文（英語）は ${L.bodyEnMaxWords} 語以下。上回ると、この話は破棄される`,
    },
    {
      limit: 'titleEnMaxChars',
      lang: 'en',
      text: `題（英語）は ${L.titleEnMaxChars} 文字以内で、空にしない。超えると、破棄される`,
    },
  ];
}

/**
 * 本文の長さの目安（日本語・文字数）。上限ではなくゲートも見ない——下限すれすれに寄る癖と、
 * 上限へ膨らむ癖の両方を、真ん中へ戻すための数字である。STORY_WRITE_LIMITS の内側に
 * 収まることはテストが見る。
 */
export const BODY_JA_TARGET = { min: 1200, max: 2200 } as const;

const boundsFor = (lang: 'ja' | 'en') =>
  storyBoundsLines()
    .filter((line) => line.lang === lang)
    .map((line) => `- ${line.text}`);

// ── 応答の形 ───────────────────────────────────────────────

/**
 * 応答の形は二重に持つ——Gemma へ渡す JSON Schema と、受け取った JSON を検める zod。
 * 同じファイルに置くのは、片方だけ直して食い違うのを防ぐため。
 *
 * zod は型と「空文字でない」までを見る。値の範囲（話数・長さ・id・形式・秘密）は
 * src/story/gate.ts が見る——形が違えば引き直す価値があるが、範囲違反はその回の破棄である。
 */
export const STORY_PLAN_RESPONSE_SCHEMA = jsonSchema.object(
  {
    title_ja: jsonSchema.string(),
    title_en: jsonSchema.string(),
    logline: jsonSchema.string(),
    arc_start: jsonSchema.string(),
    arc_change: jsonSchema.string(),
    arc_end: jsonSchema.string(),
    focus: jsonSchema.array(jsonSchema.string()),
    episodes: jsonSchema.array(
      jsonSchema.object(
        {
          purpose: jsonSchema.string(),
          situation: jsonSchema.string(),
          format: jsonSchema.enum(STORY_FORMATS),
          people: jsonSchema.array(jsonSchema.string()),
          working_title_ja: jsonSchema.string(),
          working_title_en: jsonSchema.string(),
        },
        ['purpose', 'situation', 'format', 'people', 'working_title_ja', 'working_title_en'],
      ),
    ),
  },
  ['title_ja', 'title_en', 'logline', 'arc_start', 'arc_change', 'arc_end', 'focus', 'episodes'],
);

export const StoryPlanResponseSchema = z.object({
  title_ja: z.string().min(1),
  title_en: z.string().min(1),
  logline: z.string().min(1),
  arc_start: z.string().min(1),
  arc_change: z.string().min(1),
  arc_end: z.string().min(1),
  focus: z.array(z.string()),
  episodes: z.array(
    z.object({
      purpose: z.string().min(1),
      situation: z.string().min(1),
      // 取りうる値はゲートが見る（JSON Schema の enum で出力側も絞ってある）。
      format: z.string().min(1),
      people: z.array(z.string()),
      working_title_ja: z.string().min(1),
      working_title_en: z.string().min(1),
    }),
  ),
});
export type StoryPlanResponse = z.infer<typeof StoryPlanResponseSchema>;

export const STORY_EPISODE_JA_RESPONSE_SCHEMA = jsonSchema.object(
  { title_ja: jsonSchema.string(), body_ja: jsonSchema.string() },
  ['title_ja', 'body_ja'],
);
export const StoryEpisodeJaResponseSchema = z.object({
  title_ja: z.string().min(1),
  body_ja: z.string().min(1),
});
export type StoryEpisodeJaResponse = z.infer<typeof StoryEpisodeJaResponseSchema>;

export const STORY_EPISODE_EN_RESPONSE_SCHEMA = jsonSchema.object(
  { title_en: jsonSchema.string(), body_en: jsonSchema.string() },
  ['title_en', 'body_en'],
);
export const StoryEpisodeEnResponseSchema = z.object({
  title_en: z.string().min(1),
  body_en: z.string().min(1),
});
export type StoryEpisodeEnResponse = z.infer<typeof StoryEpisodeEnResponseSchema>;

// ── 共通の部品 ─────────────────────────────────────────────

/** 本人だけが知っていること。動機には使ってよいが、本文で説明したり明かしたりしない。 */
function secretLine(context: StoryContext): string {
  return `本人だけが知っていること——動機として使ってよいが、本文で説明したり明かしたりしない: ${context.profile.secretHidden}`;
}

function coreLines(context: StoryContext): string[] {
  const { profile } = context;
  return [
    `願望: ${profile.wish}`,
    `恐れ: ${profile.fear}`,
    `矛盾: ${profile.contradiction}`,
    secretLine(context),
  ];
}

function voiceLines(context: StoryContext): string[] {
  const { voice, humor, appraisal } = context.profile;
  return [
    `一人称は「${voice.firstPerson}」。`,
    voice.register,
    `癖: ${voice.tic}`,
    `笑いの仕組み: ${humor}`,
    `物に向ける問い: ${appraisal.question}`,
    `見るところ: ${appraisal.focus}`,
    `偏り: ${appraisal.bias}`,
    `絶対に言わない言葉: 「${voice.neverSays}」。表記を変えても言わない。台詞でも地の文でも書かない。`,
    `締めの癖: ${voice.closing}（毎話に付けない。効く話にだけ使う）`,
  ];
}

function rareExpressionLines(context: StoryContext): string[] {
  return [
    `定型が崩れる瞬間は、この人物にめったに起きない（季に1度まで）。起きるときは、こう出る: ${context.profile.rareExpression}`,
    'この話の目的か場面の種に、その崩れが書かれているときにだけ使う。書かれていなければ使わない。',
  ];
}

function peopleLines(context: StoryContext, withIdHint = true): string[] {
  return context.people.map(
    (person) =>
      `- ${person.name}（${person.relation}${withIdHint ? `／id: ${person.id}` : ''}）: ${person.summary}`,
  );
}

function worldLines(context: StoryContext): string[] {
  const lines: string[] = [];
  lines.push(`## 時代の固定事実（${context.era.name}。矛盾させない。説明のために使わない）`);
  for (const fact of context.canonFacts) lines.push(`- ${fact}`);
  if (context.places.length) {
    lines.push('');
    lines.push('## 場所');
    lines.push(context.places.join(' / '));
  }
  return lines;
}

/**
 * 見本ファイルの見出しを、プロンプトの節と取り違えない形に直す。
 * 先頭の `# 人物名` は落とし、`## 日記` のような小見出しは【日記】にする。
 */
function formatVoiceSample(sample: string): string {
  return sample
    .split('\n')
    .filter((line) => !/^#\s/.test(line))
    .map((line) => line.replace(/^#{2,6}\s+(.*)$/, '【$1】'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function voiceSampleLines(context: StoryContext): string[] {
  if (!context.voiceSample) return [];
  return [
    '## 声の見本（人間が書いた。温度の参考にだけ使う。文・数字・言い回しを写さない）',
    formatVoiceSample(context.voiceSample),
  ];
}

// ── 計画 ───────────────────────────────────────────────────

/**
 * 計画の系。人物ではなく「設計する装置」として話す（旧 Season Plan と同じ立ち位置）。
 * 人物のデータは user 側で渡す。話数は呼び出しごとに違うので、ここへ明示する。
 */
export function buildStoryPlanSystemPrompt(episodeCount: number): string {
  const titleBounds = boundsFor('ja')
    .concat(boundsFor('en'))
    .filter((line) => line.includes('題'));

  return [
    'あなたは、PixTale の同行者（ひとりの人物）の物語を、1季ぶん設計する装置である。人物ではない。',
    '',
    '## 何のための物語か',
    '',
    '読者がこの人物を好きになり、いっしょに旅をしたいと思うこと。それがすべてである。',
    '話数の多さに価値はない。よい少数の話は、悪い100話に勝つ。',
    '',
    '## 話数',
    '',
    `**この季は、ちょうど ${episodeCount} 話である。** episodes は ${episodeCount} 件。` +
      `${episodeCount - 1} 件でも ${episodeCount + 1} 件でも、この計画は破棄される。`,
    '',
    '## 設計の考え方',
    '',
    '- **人物を筋の中に置かない。人物から筋を起こす。** 世界で何が起きたかではなく、この人が何を大事にし、何に弱く、何を面白がるかが見える話にする。',
    '- **各話の purpose は、「この回で読者に人物の何を知ってほしいか」を一文で書く。** 事件の起こし方や盛り上げ方（筋の段取り）ではない。話どうしが因果の鎖でつながっている必要はない。1話ごとに、人物の違う面が見えること。',
    '- 人物は、行動と、周りの人との関係で見せる。性格を説明する話にしない。',
    '- すべてを大事件にしない。日常の回、笑える回、静かな回を混ぜる。「笑いの仕組み」を持つ人物なら、その笑いが実際に出る回を入れる。不安や後ろめたさだけで季を埋めない。',
    '- 場面の種（situation）は、世界の事情を知らない読者にも伝わる出来事にする。説明がなければ成立しない話にしない。',
    '- 周りの2人を中心に使う。新しく名前の付く人物は、1話につき0〜2人まで。端役に名前は要らない。',
    '- 季の終わりに、人物が別人になっていてはいけない。動くのは、気持ちの距離や小さな選択ぐらいである。芯（願望・恐れ・矛盾）は変えない。',
    '- 形式（format）は話ごとに選ぶ。毎回同じ形にしない。毎晩の日記の体裁を既定にしない。ただし、時代の固定事実と両立する形式を選ぶ（文字を持たない人々の話に、手紙や記録は使えない）。',
    '- この人物の「定型が崩れる瞬間」は、季に1度まで。使うなら、その回の purpose か situation に、それと分かるように書く。使わなくてもよい。',
    '',
    '## 形式（format）の選択肢',
    '',
    ...formatGuideLines(),
    '',
    '## 世界を壊さないために（これだけは守る）',
    '',
    '- 超常や奇跡の実在を確定させない。起きたことには、別の説明が可能な余地を残す。',
    '- 「本人だけが知っていること」は動機に使ってよいが、どの話でも説明したり明かしたりしない。それを明かす回を作らない。',
    '- 与えられた材料にない、人物の過去の重大な真相や、新しい重要人物を発明しない。',
    '',
    '## 返す欄',
    '',
    '**すべて必須。** 空にしてよいのは、episodes の各 people が空の配列のとき（その回に周りの人が出ない）だけ。ほかの欄を、空文字や空の配列にしない。',
    '',
    '- title_ja: 季の題。日本語。',
    '- title_en: 季の題。英語。',
    '- logline: この季が読者に残すもの。日本語で1〜3文。',
    '- arc_start: 季の始まりの人物。日本語で1〜2文。',
    '- arc_change: 季のあいだに人物の内側で動くもの。小さな動きでよい。日本語で1〜2文。',
    '- arc_end: 季の終わりの人物。日本語で1〜2文。成長や教訓に着地させなくてよい。',
    '- focus: この季でとくに描く周りの人の id。「周りの人」に載っている id から1〜2個。名前ではなく id を書く。',
    `- episodes: 第1話から順に、ちょうど ${episodeCount} 件。order は書かない（並び順で決まる）。各要素は次の欄を持つ。`,
    '  - purpose: 日本語で1文。この回で読者に人物の何を知ってほしいか。事件の説明にしない。',
    '  - situation: 日本語で1〜3文。場面の種。誰がどこで何をしているか。結末は書かない。',
    `  - format: ${STORY_FORMATS.join(' / ')} のどれか1つ。`,
    '  - people: この回に出る周りの人の id の配列。0〜2個。「周りの人」に載っている id だけ。新しい人物の名前は situation の中にだけ書き、ここには書けない。',
    '  - working_title_ja: 仮題。日本語。',
    '  - working_title_en: 仮題。英語。',
    '',
    '題の上限:',
    ...titleBounds,
    '上限を超えた計画は、切り詰められるのではなく、計画ごと破棄される。',
  ].join('\n');
}

export function buildStoryPlanUserPrompt(context: StoryContext, episodeCount: number): string {
  const { profile } = context;
  const lines: string[] = [];

  lines.push(`# ${profile.name}の物語 — 第${context.season}季（全 ${episodeCount} 話）`);
  lines.push(`${profile.role}、${profile.age}歳。時代: ${context.era.name}。`);
  lines.push('');

  if (context.brief) {
    lines.push('## 季の企画メモ（人間が書いた。方向づけとして読む。そのまま写さない）');
    lines.push(context.brief);
    lines.push('');
  }

  if (context.previousPlan) {
    const previous = context.previousPlan;
    lines.push(`## 前の季（第${previous.season}季「${previous.title.ja}」）の計画`);
    lines.push('同じ目的の回を繰り返さない。');
    lines.push(`季の終わりの人物: ${previous.character_arc.end}`);
    for (const episode of previous.episodes) {
      lines.push(`- 第${episode.order}話の目的: ${episode.purpose}`);
    }
    lines.push('');
  }

  const decided = (context.manifest?.episodes ?? []).filter(
    (episode) => episode.title !== undefined || episode.format !== undefined,
  );
  if (decided.length) {
    lines.push('## すでに決まっている話');
    lines.push(
      'manifest.yaml にすでに題や形式が書かれている話（人間が決めたもの、または書き終えた本文から入ったもの）。変えない。この題・形式に合う目的と場面にし、working_title にも同じ題を書く。',
    );
    for (const episode of decided) {
      const parts: string[] = [];
      if (episode.title) parts.push(`題「${episode.title.ja}」（${episode.title.en}）`);
      if (episode.format) parts.push(`形式 ${episode.format}`);
      lines.push(`- 第${episode.order}話: ${parts.join('、')}`);
    }
    lines.push('');
  }

  lines.push('## 人物（変わらない）');
  lines.push(...coreLines(context));
  lines.push('');

  lines.push('## 話し方と物の見方');
  lines.push(...voiceLines(context));
  lines.push(...rareExpressionLines(context));
  lines.push('');

  lines.push('## 周りの人（people と focus には、この id を書く）');
  lines.push(...peopleLines(context));
  lines.push('');

  lines.push('## 人生の出来事');
  for (const event of context.formativeEvents) lines.push(`- ${event}`);
  lines.push('');

  lines.push(...worldLines(context));
  lines.push('');

  const sample = voiceSampleLines(context);
  if (sample.length) {
    lines.push(...sample);
    lines.push('');
  }

  lines.push(`この材料から、第${context.season}季の計画を返してください。`);
  lines.push(
    `**episodes はちょうど ${episodeCount} 件。** 第1話から第${episodeCount}話まで、1話ずつ違う面を見せてください。`,
  );
  lines.push(
    'people と focus には、「周りの人」の id だけを書く。名前や、載っていない id を書かない。',
  );

  return lines.join('\n');
}

// ── 本文（日本語） ─────────────────────────────────────────

/**
 * 日本語版の系。人物のデータと声は、季をとおして変わらないのでここに置く。
 * 話ごとの材料（目的・場面・形式）は user 側。
 */
export function buildEpisodeJaSystemPrompt(context: StoryContext): string {
  const { profile } = context;
  const lines: string[] = [];

  lines.push(`あなたは、${profile.name}（${profile.role}、${profile.age}歳）の物語を書く書き手である。`);
  lines.push('');
  lines.push(
    'PixTale という旅の相棒アプリで、読者はこの人物を同行者に選んだ。この物語の目的は、読者がこの人物を好きになり、いっしょに旅をしたいと思うことである。',
  );
  lines.push('');

  lines.push('## 人物（変わらない）');
  lines.push(...coreLines(context));
  lines.push('');

  lines.push('## 声');
  lines.push(...voiceLines(context));
  lines.push(...rareExpressionLines(context));
  lines.push('');

  lines.push('## 人生の出来事');
  for (const event of context.formativeEvents) lines.push(`- ${event}`);
  lines.push('');

  const sample = voiceSampleLines(context);
  if (sample.length) {
    lines.push(...sample);
    lines.push('');
  }

  lines.push('## 書き方');
  lines.push(
    '- **人物は、行動と、周りの人とのやりとりで見せる。**「彼女は〜な人だ」と性格を説明しない。',
  );
  lines.push(
    '- この話の「目的」が読者に伝わるように書く。目的に関係のない出来事を足さない。世界の事情の説明は要らない。',
  );
  lines.push(
    '- **世界の予備知識がなくても読めるようにする。** 固有名詞は、読者に必要なものだけを出す。新しく名前の付く人物は、この話で0〜2人まで。端役に名前は要らない。使うなら、周りの人を使う。',
  );
  lines.push(
    '- 形式は、この話に指定されたものに従う。毎晩の日記の体裁（その日の締め）にしない。',
  );
  lines.push(
    '- 人物の声を保つ。本人が語らない形式（三人称・記録など）でも、台詞・仕草・間に「声」に書いた癖を出す。',
  );
  lines.push(
    '- 終わりを、理解・納得・成長・教訓に着地させなくてよい。分からないまま終わってよい。',
  );
  lines.push(
    '- 人物の性格が大きく変わる話にしない。この人物は、この話の前と後で同じ人である。',
  );
  lines.push('');

  lines.push('## 世界を壊さないために（これだけは守る）');
  lines.push(
    '- 超常や奇跡の実在を確定させない。起きたことには、別の説明が可能な余地を残す。誰かが「偶然だ」と言える形にする。',
  );
  lines.push(
    '- 「本人だけが知っていること」を、本文で説明しない・明かさない。',
  );
  lines.push(
    '- 与えられた材料にない、人物の過去の重大な真相や、新しい重要人物を発明しない。',
  );
  lines.push('');

  lines.push('## 本文の形式（守らないと、この話は破棄される）');
  lines.push(
    '- プレーンテキストで書く。段落は空行ひとつで区切る。段落の中の改行は、そのまま行替えとして読まれる（会話の行を分けるときに使ってよい）。',
  );
  lines.push(
    '- Markdown や装飾は使わない。# の見出し、** や __ の強調、バッククォート、[ ]( ) のリンク、HTML タグを書かない。本文を --- で始めない。',
  );
  lines.push(
    '- 本文の頭に、題や「第N話」を書かない。題は title_ja に書く。',
  );
  lines.push('- 本文は日本語で書く。');
  lines.push('');

  lines.push('## 長さの上限');
  lines.push(...boundsFor('ja'));
  lines.push(
    `上限を超えた話は、切り詰められるのではなく、その話ごと破棄される。目安は ${BODY_JA_TARGET.min}〜${BODY_JA_TARGET.max} 文字。`,
  );
  lines.push('');

  lines.push('## 返す欄');
  lines.push('**どちらも必須。空文字にしない。**');
  lines.push(
    `- title_ja: この話の題。日本語。${STORY_WRITE_LIMITS.titleJaMaxChars} 文字以内の1行。番号（第N話）は付けない。`,
  );
  lines.push(
    `- body_ja: この話の本文。日本語。${STORY_WRITE_LIMITS.bodyJaMinChars}〜${STORY_WRITE_LIMITS.bodyJaMaxChars} 文字。上の形式で書く。`,
  );

  return lines.join('\n');
}

export function buildEpisodeJaUserPrompt(context: StoryContext, order: number): string {
  const plan = context.plan;
  if (!plan) throw new Error('plan.yaml がありません（本文の呼び出しには計画が要る）');
  const episode = plan.episodes.find((e) => e.order === order);
  if (!episode) throw new Error(`plan.yaml に第${order}話がありません`);

  const manifestEpisodes = context.manifest?.episodes ?? [];
  const manifestEpisode = manifestEpisodes.find((e) => e.order === order);
  const titleOf = (n: number) => manifestEpisodes.find((e) => e.order === n)?.title?.ja;
  // 台帳に形式があれば、それが正（plan より優先）。無ければ plan の形式。
  const formatOf = (n: number) =>
    manifestEpisodes.find((e) => e.order === n)?.format ?? plan.episodes.find((e) => e.order === n)?.format;
  const format = formatOf(order) ?? episode.format;

  const lines: string[] = [];
  lines.push(`# ${plan.title.ja} — 第${order}話（全 ${plan.episodes.length} 話）`);
  lines.push('');

  lines.push('## この季が描こうとしていること');
  lines.push(plan.logline);
  lines.push(`季の始まりの人物: ${plan.character_arc.start}`);
  lines.push(`季のあいだに動くもの: ${plan.character_arc.emotional_change}`);
  lines.push(`季の終わりの人物: ${plan.character_arc.end}`);
  lines.push('これは季全体の見取り図で、この話で全部を描くわけではない。');
  lines.push('');

  lines.push('## この話');
  lines.push(`目的（この回で読者に知ってほしいこと）: ${episode.purpose}`);
  lines.push(`場面の種: ${episode.situation}`);
  lines.push(`形式: ${format}（${STORY_FORMAT_GUIDE[format]}）`);
  if (order === 1) {
    lines.push('これは第1話である。読者がこの人物と最初に出会う。世界の説明から入らない。');
  }

  const present = episode.people
    .map((id) => context.people.find((person) => person.id === id))
    .filter((person): person is NonNullable<typeof person> => person !== undefined);
  if (present.length) {
    lines.push(`この話に出る周りの人: ${present.map((person) => person.name).join('、')}`);
  } else {
    lines.push('この話に、周りの人は出ない。');
  }

  if (manifestEpisode?.title) {
    lines.push(
      `題はすでに「${manifestEpisode.title.ja}」と決まっている。title_ja には、この題をそのまま書く。この題に合う話にする。`,
    );
  } else {
    lines.push(
      `題は、本文を書いたあとで付ける。title_ja に書く。計画の仮題は「${episode.working_title.ja}」。本文に合うならそのまま使ってよく、合わなければ付け直してよい。`,
    );
  }
  lines.push('');

  lines.push('## 周りの人');
  lines.push(...peopleLines(context, false));
  lines.push('');

  if (order > 1) {
    lines.push('## 前の話（本文は渡さない。同じ目的・同じ場面を繰り返さない）');
    for (const earlier of plan.episodes.filter((e) => e.order < order)) {
      const title = titleOf(earlier.order);
      lines.push(
        `- 第${earlier.order}話${title ? `「${title}」` : ''}（${formatOf(earlier.order)}）: ${earlier.purpose}`,
      );
    }
    lines.push('');
  }

  const later = plan.episodes.filter((e) => e.order > order);
  if (later.length) {
    lines.push('## 後の話（この話では先取りしない）');
    for (const next of later) {
      lines.push(`- 第${next.order}話: ${next.purpose}`);
    }
    lines.push('');
  }

  lines.push(...worldLines(context));
  lines.push('');

  lines.push(`第${order}話（${storyEpisodeId(plan.id, order)}）を書いてください。`);
  lines.push('title_ja と body_ja を返す。body_ja は、上の目的が読者に伝わる話にする。');

  return lines.join('\n');
}

// ── 本文（英語） ───────────────────────────────────────────

/** 日本語版の名前を、英語ではどう綴るか。人物と周りの人。 */
function nameTableLines(context: StoryContext): string[] {
  return [
    `- ${context.profile.name} → ${context.profile.nameEn}`,
    ...context.people.map((person) => `- ${person.name} → ${person.nameEn}`),
  ];
}

/**
 * 英語版の系。二度目の呼び出しで、日本語版の完成した題と本文を渡して書かせる。
 * 直訳にしない——「同じ人物が英語で語ったらこうなる」文章にする。
 */
export function buildEpisodeEnSystemPrompt(context: StoryContext): string {
  const { profile } = context;
  const { voiceEn } = profile;
  const lines: string[] = [];

  lines.push(
    `あなたは、${profile.name}（${profile.nameEn}）の物語の英語版を書く人である。日本語版はすでにできている。`,
  );
  lines.push('');

  lines.push('## 仕事');
  lines.push(
    '- **直訳ではない。** 同じ人物が英語で語ったら（書いたら）こうなる、という文章にする。',
  );
  lines.push(
    '- 場面・出来事・段落の切れ目と間は、日本語版と同じにする。足さず、省かない。',
  );
  lines.push('- 日本語版の秘密の扱いも同じにする。本人だけが知っていることを、説明したり明かしたりしない。');
  lines.push('');

  lines.push('## 英語での声');
  lines.push(`一人称・話しぶり: ${voiceEn.firstPerson}`);
  lines.push(`癖: ${voiceEn.tic}`);
  lines.push(
    `絶対に言わない言葉: "${voiceEn.neverSays}"。言い換えても言わない。台詞でも地の文でも書かない。`,
  );
  lines.push(`締めの癖（日本語版にあるときだけ）: ${voiceEn.closing}`);
  lines.push('');

  lines.push('## 名前');
  lines.push('日本語版の名前は、英語では次の綴りで書く。');
  lines.push(...nameTableLines(context));
  lines.push('表にない名前（新しく出てきた人物など）は、ローマ字で綴る。');
  lines.push('');

  lines.push('## 本文の形式（守らないと、この話は破棄される）');
  lines.push(
    '- プレーンテキストで書く。段落は空行ひとつで区切る。段落の中の改行は、そのまま行替えとして読まれる。',
  );
  lines.push(
    '- Markdown や装飾は使わない。# の見出し、** や __ の強調、バッククォート、[ ]( ) のリンク、HTML タグを書かない。本文を --- で始めない。',
  );
  lines.push('- 本文の頭に、題や "Episode N" を書かない。題は title_en に書く。');
  lines.push('- **英語だけで書く。** 日本語の文字（かな・漢字）を、本文にも題にも混ぜない。');
  lines.push('');

  lines.push('## 長さの上限');
  lines.push(...boundsFor('en'));
  lines.push('上限を超えた話は、切り詰められるのではなく、その話ごと破棄される。');
  lines.push('');

  lines.push('## 返す欄');
  lines.push('**どちらも必須。空文字にしない。**');
  lines.push(
    `- title_en: この話の題。英語。${STORY_WRITE_LIMITS.titleEnMaxChars} 文字以内の1行。番号は付けない。`,
  );
  lines.push(
    `- body_en: この話の本文。英語。${STORY_WRITE_LIMITS.bodyEnMinWords}〜${STORY_WRITE_LIMITS.bodyEnMaxWords} 語。上の形式で書く。`,
  );

  return lines.join('\n');
}

export function buildEpisodeEnUserPrompt(
  context: StoryContext,
  order: number,
  japanese: { title: string; body: string },
  options: {
    /** 台帳で題が決まっているとき、その英語の題（そのまま title_en に書かせる） */
    fixedTitleEn?: string;
    /** 題が決まっていないとき、計画の英語の仮題（使っても、付け直してもよい） */
    workingTitleEn?: string;
  } = {},
): string {
  const lines: string[] = [];
  const seriesTitle = context.plan?.title.ja ?? context.manifest?.title.ja ?? context.seriesId;

  lines.push(`# ${seriesTitle} — 第${order}話の英語版`);
  lines.push('');
  lines.push('## 日本語版（完成したもの）');
  lines.push(`題: ${japanese.title}`);
  lines.push('');
  lines.push('本文:');
  lines.push(japanese.body);
  lines.push('');

  if (options.fixedTitleEn) {
    lines.push(
      `題の英語はすでに "${options.fixedTitleEn}" と決まっている。title_en には、この題をそのまま書く。`,
    );
  } else {
    lines.push('題の英語は、直訳でなくてよい。この話の題として、英語の読者にいちばん自然なものにする。');
    if (options.workingTitleEn) {
      lines.push(
        `計画の英語の仮題は "${options.workingTitleEn}"。この日本語版の題と対になる。合うならそのまま使ってよく、合わなければ付け直してよい。`,
      );
    }
  }
  lines.push('この日本語版の英語版を、title_en と body_en で返してください。');

  return lines.join('\n');
}
