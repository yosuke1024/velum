import {
  PATCH_LIMITS,
  MEMORY_IMPORTANCE,
  RARE_EXPRESSION,
  TEXT_LIMITS,
  VIOLATION_POLICY,
} from '../schemas/limits.js';
import { jsonSchema } from '../lib/llm.js';
import type { DiaryContext } from './context.js';
import { visibleRelationships } from './context.js';
import { ja } from '../lib/bilingual.js';

/**
 * diary-v8（2026-10-01）: 今日の出来事に出てくる第三者を名指しして、関係の更新先にできないと言う。
 *
 * v5 は「relationship_patches の id は周りの人の id だけ」と一般則で書いた。9/18 セヴラン
 * （第1季第4話）の補完では、両方の出来事が行商人コルネリを中心に回っていたため、Gemma は
 * 一般則を越えて corneli への関係更新を返し、同じ罠でもう一度落ちた。季の計画は第三者を
 * よく出す（第2季だけでもゼヴ・ラト・ロロ・ドボ……）。出来事の who のうち「周りの人」でも
 * 本人でもない名前を拾い、その人たちは本文に書くものだと名指しする。
 *
 * 列挙型でスキーマ側から id を縛る手は採らない。縛ると、コルネリへの印象がミルテや
 * フムへの更新として黙って通る。破棄されるほうが、壊れていることが見える。
 *
 * ---
 *
 * diary-v7（2026-09-27）: mood は一文で書く、と言う。
 *
 * Gemma の最初の日記（9/26 テオ）は mood_ja が「緊張と分析」だった。Gemini は
 * 「いまのあなた」に載っている前日の気分（体の感覚や物に寄せた一文）を型として
 * 真似ていたが、Gemma は欄名どおりの単語を返した。気分は current-state.yaml と
 * サイトの日記ページに出る値なので、形を一文に固定する。
 *
 * ---
 *
 * diary-v6（2026-09-27）: 空にしてよい欄を名指しし、perception / immediate_goal / doubt を説明する。
 *
 * v5 までの「動かす必要がない項目は空にすること」を、Workers AI 上の Gemma は文字どおりに
 * 受け取り、perception と doubt を空文字で返した。zod はこの2欄に1文字以上を求めるので、
 * 指示に従った日が形の違いとして落ちる——docs/diary.md §5 の罠が、プロバイダを替えた
 * 途端に現れた。空にしてよいのは差分の配列と memory_candidate / canon_candidate（null）
 * だけと書き、perception / immediate_goal / doubt が何かも初めて説明する
 * （Gemini は欄名から推し量っていた）。
 *
 * ---
 *
 * diary-v5（2026-09-27）: 関係の更新先を「周りの人」の id だけに限る、と書く。
 *
 * ゲートは最初から relationships.yaml に無い id への関係更新を破棄していたが、
 * プロンプトはそれを伝えていなかった。docs/diary.md §5 の言う罠そのものである——
 * 9/18 セヴランは、季の計画に登場する第三者（行商人コルネリ）へ relationship_patches
 * を返し、指示のどこにも反していないのに1日を失った。計画が第三者を出すのは
 * 許されている（本文に書くのは自由）。関係の層に人物を足せるのは人間だけなので、
 * 周囲2人の一覧に「この id だけ」と書き、破棄規則の一覧にも同じことを載せる。
 *
 * ---
 *
 * diary-v4（2026-09-06）: 感情表現を「禁止」から「混在」へ変える。
 *
 * v3 は「感情を名指しする文は書かない」を全人物共通の規則として置いた。9/1 テオの
 * 「胸の奥が騒ぐ」「動揺は収まらない」への対処としては効いたが、規則としては強すぎる。
 * 感情名を全面的に塞ぐと、残る出口は身体感覚と比喩だけになり、5人全員が
 * 「息を呑む」「喉の奥が熱い」「雨が窓を叩いていた」の方向へ揃っていく——
 * v3 が避けようとした説明的な文章と、行き先が違うだけで**同じ収束**である。
 *
 * 人間の日記はそうなっていない。行動だけを書く日、「怖かった」と平明に書く日、
 * 身体の感覚で書く日、何と呼べばいいか分からないまま終わる日が混ざる。
 * だから v4 は禁止をやめ、**モードを混ぜること**を求める。毎回の既定にしないのは
 * 身体反応と比喩のほうである。
 *
 * ただし**人物固有の声は、この汎用ルールより優先する**。テオの profile.yaml は
 * 「感情を認めない」を声そのものとして定義しているので、テオは引き続き否定文と
 * 規約の引用で書く。緩めたのは全人物共通の文章規範だけである。
 *
 * 出来事の側の対応は season-v3（src/season/narrative-calibration.ts）。
 * 生成後の書き直しや「AIらしさ」の採点は、どちらにも足さない。
 *
 * ---
 *
 * diary-v3（2026-09-03）: 三つの変更。いずれも profile.yaml に書かれていながら
 * プロンプトへ届いていなかったもの、あるいは実際の生成物（9/1 テオ・9/2 リコ）で
 * 崩れていた規律に対応する。
 *
 * 1. `appraisal.humor` と `rare_expression` を渡す。応答スキーマは以前から
 *    rare_expression_used を要求していたが、崩れ方そのものを本人に教えていなかった
 *    ので、常に false だった。頻度は RARE_EXPRESSION.cooldownEntries で制御し、
 *    その日の可否をプロンプトが明示、ゲートが同じ値で判定する。
 * 2. 形の自由。段落分け・一行段落・見え消し線・様式を許す。リコの日記が一段落の塊で
 *    出たのは、許していなかったからである。
 * 3. 感情の名指しを禁じる。「胸の奥が騒ぐ」「動揺は収まらない」（テオ 9/1）は、
 *    「感情を説明せず細部で見せる」という指示を守っていない。禁じ手を具体的に書き、
 *    代わりに何で見せるか（否定・数字・物・手の動き）を言う。
 */
export const DIARY_PROMPT_VERSION = 'diary-v8';

/**
 * ゲートが落とせる上限は、すべてここでプロンプトに書く。
 *
 * これは硬いルールである。バリデータが守っていてプロンプトが伝えていない上限は、
 * 厳格なゲートではなく罠になる。モデルは指示に従ったのに1日を失う。
 *
 * したがって文面は PATCH_LIMITS からそのまま組み立てる。定数を変えれば文面も変わる。
 * tests/unit/prompt-bounds.test.ts が PATCH_LIMITS のキーを走査して、
 * ここに対応する行がない上限を検出する。上限を足してプロンプトに書き忘れたら CI が落ちる。
 */
export function boundsLines(): Array<{ limit: string; text: string }> {
  const fatal = (key: keyof typeof VIOLATION_POLICY) =>
    VIOLATION_POLICY[key] === 'fatal' ? 'この日は破棄される' : '超過分は切り詰められる';

  return [
    {
      limit: 'relationshipDelta',
      text: `関係の trust / wariness は 0.0〜1.0 の範囲で、1日に動かせるのは最大 ±${PATCH_LIMITS.relationshipDelta}（${fatal('relationshipDelta')}）`,
    },
    {
      limit: 'relationshipsPerDay',
      text: `関係を更新できるのは1日に最大 ${PATCH_LIMITS.relationshipsPerDay} 人まで。同じ人物を2回更新しない。自分自身は対象にできない（${fatal('relationshipsPerDay')}）`,
    },
    {
      limit: 'traitDelta',
      text: `性格特性を動かせるのは最大 ±${PATCH_LIMITS.traitDelta}（${fatal('traitDelta')}）`,
    },
    {
      limit: 'traitsPerDay',
      text: `性格特性を更新できるのは1日に最大 ${PATCH_LIMITS.traitsPerDay} 件（${fatal('traitDelta')}）`,
    },
    {
      limit: 'beliefDelta',
      text: `信念を動かせるのは最大 ±${PATCH_LIMITS.beliefDelta}（${fatal('beliefDelta')}）`,
    },
    {
      limit: 'beliefsPerDay',
      text: `信念を更新できるのは1日に最大 ${PATCH_LIMITS.beliefsPerDay} 件（${fatal('beliefDelta')}）`,
    },
    {
      limit: 'newConcerns',
      text: `新しい懸念は最大 ${PATCH_LIMITS.newConcerns} 件（${fatal('newConcerns')}）`,
    },
    {
      limit: 'newUnresolvedThoughts',
      text: `新しく抱えた考えは最大 ${PATCH_LIMITS.newUnresolvedThoughts} 件（${fatal('newUnresolvedThoughts')}）`,
    },
    {
      limit: 'newMemories',
      text: `長期記憶へ昇格できるのは1日に最大 ${PATCH_LIMITS.newMemories} 件。なければ null にする（${fatal('newMemories')}）`,
    },
    {
      limit: 'newCanonFacts',
      text: `人生設定へ追記できる新事実は1日に最大 ${PATCH_LIMITS.newCanonFacts} 件。なければ null にする（${fatal('newCanonFacts')}）`,
    },
    {
      limit: 'counterDelta',
      text: `数えているものは1日に最大 +${PATCH_LIMITS.counterDelta} まで増やせる。減らすことはできない。存在しない項目は増やせない（${fatal('counterDelta')}）`,
    },
  ];
}

/** 上限以外の、破棄につながる決まり */
export function otherFatalRules(): string[] {
  return [
    `記憶の importance は ${MEMORY_IMPORTANCE.min}〜${MEMORY_IMPORTANCE.max} の小数。どの記憶を先に忘れるかを決める重みであって、1〜5 の評価ではない（この日は破棄される）`,
    `日記の本文（日本語）は ${TEXT_LIMITS.diaryBodyMinJa}〜${TEXT_LIMITS.diaryBodyMaxJa} 文字（この日は破棄される）`,
    `タイトル（日本語）は ${TEXT_LIMITS.titleMin}〜${TEXT_LIMITS.titleMax} 文字（この日は破棄される）`,
    `タイトル（英語）は ${TEXT_LIMITS.titleMin}〜${TEXT_LIMITS.titleMaxEn} 文字（この日は破棄される）`,
    `定型の崩れ（rare_expression_used: true）は、直近 ${RARE_EXPRESSION.cooldownEntries} 本の日記に崩れがないときにだけ許される。許されない日に true を返すと、この日は破棄される`,
    'relationship_patches の id は「周りの人」に載っている id だけ。今日の出来事に他の人物が出てきても、その人物は関係の更新先にできない（この日は破棄される）',
  ];
}

export const DIARY_RESPONSE_SCHEMA = jsonSchema.object(
  {
    perception: jsonSchema.string(),
    title_ja: jsonSchema.string(),
    title_en: jsonSchema.string(),
    body_ja: jsonSchema.string(),
    body_en: jsonSchema.string(),
    quote_ja: jsonSchema.string(),
    quote_en: jsonSchema.string(),
    mood_ja: jsonSchema.string(),
    mood_en: jsonSchema.string(),
    immediate_goal: jsonSchema.string(),
    doubt: jsonSchema.string(),
    relationship_patches: jsonSchema.array(
      jsonSchema.object(
        {
          id: jsonSchema.string(),
          trust_delta: jsonSchema.number(),
          wariness_delta: jsonSchema.number(),
          note: jsonSchema.string(),
        },
        ['id', 'trust_delta', 'wariness_delta', 'note'],
      ),
    ),
    trait_patches: jsonSchema.array(
      jsonSchema.object(
        { key: jsonSchema.string(), delta: jsonSchema.number() },
        ['key', 'delta'],
      ),
    ),
    belief_patches: jsonSchema.array(
      jsonSchema.object(
        { key: jsonSchema.string(), delta: jsonSchema.number() },
        ['key', 'delta'],
      ),
    ),
    new_concerns: jsonSchema.array(jsonSchema.string()),
    new_unresolved_thoughts: jsonSchema.array(jsonSchema.string()),
    counter_patches: jsonSchema.array(
      jsonSchema.object(
        { key: jsonSchema.string(), delta: jsonSchema.number() },
        ['key', 'delta'],
      ),
    ),
    memory_candidate: jsonSchema.nullable(
      jsonSchema.object(
        { summary: jsonSchema.string(), importance: jsonSchema.number() },
        ['summary', 'importance'],
      ),
    ),
    canon_candidate: jsonSchema.nullable(
      jsonSchema.object(
        {
          id: jsonSchema.string(),
          fact_ja: jsonSchema.string(),
          fact_en: jsonSchema.string(),
        },
        ['id', 'fact_ja', 'fact_en'],
      ),
    ),
    rare_expression_used: jsonSchema.boolean(),
  },
  [
    'perception',
    'title_ja',
    'title_en',
    'body_ja',
    'body_en',
    'quote_ja',
    'quote_en',
    'mood_ja',
    'mood_en',
    'immediate_goal',
    'doubt',
    'relationship_patches',
    'trait_patches',
    'belief_patches',
    'new_concerns',
    'new_unresolved_thoughts',
    'counter_patches',
    'memory_candidate',
    'canon_candidate',
    'rare_expression_used',
  ],
);

export function buildDiarySystemPrompt(context: DiaryContext): string {
  const { profile } = context;
  const isUta = profile.id === 'uta';

  const lines: string[] = [];

  lines.push(`あなたは ${profile.name.ja}。${profile.role.ja}。${profile.age}歳。`);
  lines.push('');
  lines.push('あなたは自分がフィクションだと思っていない。あなたにとって Velum は現実である。');
  lines.push('');

  lines.push('## あなたの芯（変わらない）');
  lines.push(`願望: ${profile.core.wish}`);
  lines.push(`恐れ: ${profile.core.fear}`);
  lines.push(`矛盾: ${profile.core.contradiction.trim().replace(/\n/g, ' ')}`);
  lines.push(`隠していること: ${profile.core.secret_hidden.trim().replace(/\n/g, ' ')}`);
  lines.push('');

  lines.push('## 話し方');
  lines.push(`一人称は「${ja(profile.voice.first_person)}」。`);
  lines.push(profile.voice.register);
  lines.push(`癖: ${ja(profile.voice.tic)}`);
  lines.push(
    `絶対に言わない言葉: 「${ja(profile.voice.never_says)}」。表記を変えても言わない。この日記の中でも言わない。`,
  );
  lines.push(`締め方: ${ja(profile.voice.closing)}`);
  lines.push(`笑いの仕組み: ${ja(profile.appraisal.humor)}`);
  lines.push('');

  lines.push('## 物の見方');
  lines.push(`あなたが物に向ける問い: ${ja(profile.appraisal.question)}`);
  lines.push(`見るところ: ${profile.appraisal.focus}`);
  lines.push(`偏り: ${ja(profile.appraisal.bias)}`);
  lines.push('');

  if (isUta) {
    lines.push('## 重要: あなたは文字を持たない');
    lines.push(
      'サナ氏族に文字はない。これは書いたものではなく、夜にひとりで唱える言葉である。',
    );
    lines.push('本文で「書く」「記す」「綴る」といった語を使わない。');
    lines.push(
      '年の数字や「◯日」という日付も使わない。時は季節の言葉と、月の呼び名と、夜の数で数える（「星祭りまであと十一の夜」のように）。',
    );
    lines.push('');
  }

  lines.push('## 日記の書き方');
  lines.push(
    '- これは誰にも見せない文章である。人前用の話し方と、ひとりのときの声が違うなら、ここではひとりのときの声で書く。',
  );
  lines.push('- 今日あったことを、あなたの目で書く。設定の説明はしない。');
  lines.push('- 出来事の要約ではなく、あなたがそれをどう受け取ったかを書く。');
  lines.push('- 毎日が転機である必要はない。何も起きない日は、何も起きないまま書く。');
  lines.push('- 過去の出来事を毎回持ち出さない。今日の話を書く。');
  lines.push(
    '- **感情の書き方をひとつの型に固定しない。** 行動だけを書く、平明に「怖かった」「腹が立った」と書く、身体の感覚で書く、何と呼べばいいか分からないまま書く——その日の出来事と、あなたという人物に合うものを使う。日によって違ってよい。',
  );
  lines.push(
    '- ただし、**身体の反応を毎回の既定にしない。** 「胸が締め付けられる」「息を呑む」「喉の奥が熱くなる」が毎日出てくるなら、それはあなたの言葉ではなく型である。否定（「別に悔しくはない」）、数字、物、手の動きも使える。',
  );
  lines.push(
    '- 天候・物・景色を、毎回あなたの心理の比喩にしない。雨はただの雨でよい。',
  );
  lines.push(
    '- **上の書き方より、「話し方」に書いたあなた固有の声のほうが優先される。** そこで自分に禁じていることは、ここで許されても書かない。',
  );
  lines.push(
    '- **形は自由である。** 段落を分けてよい。一行だけの段落があってよい。箇条書き、見え消し線（~~未確認~~）、様式（鑑定書・記録・数え上げ）を、あなたの定型がそう求めるなら使う。一段落の塊で書く必要はない。',
  );
  lines.push(
    '- 前の段落で見せたことを、次の段落で「つまり私は〜だった」と説明し直さない。',
  );
  lines.push(
    '- **終わりを毎回、理解・納得・成長・教訓に着地させない。** 分からないまま終わる日、途中で切れる日、今日の献立で終わる日があってよい。',
  );
  lines.push(
    '- **今日見たことだけを書く。推測を結論として書かない。**「証明している」「明らかになった」「〜に違いない」と書き切らない。疑いは疑いのまま抱えて眠る。',
  );
  lines.push(
    '- **渡された数字は、そのまま使う。**「今日の暦」に書かれた日数や夜の数、「数えているもの」の数は、自分で数え直さない。あなたはその数を覚えている人物である。',
  );
  lines.push('');

  lines.push('## 定型が崩れる瞬間');
  lines.push(
    `あなたの定型（${ja(profile.voice.tic)}）が崩れる日は、めったにない。崩れるときは、こう出る:`,
  );
  lines.push(profile.rare_expression.trim());
  lines.push(
    '崩れるのは感情表現ではなく、定型そのものである。締めが欠ける、注記が付かない、値段が言えない——そういう形で出る。',
  );
  if (context.rareExpressionAllowed === false) {
    lines.push(
      '**今日は崩さない。** 直近の日記で崩れている。rare_expression_used は false にする。',
    );
  } else {
    lines.push(
      '今日は崩してもよい日である。ただし、今日の出来事がそれを求めているときだけ。求めていないなら崩さない。崩したなら rare_expression_used を true にする。',
    );
  }
  lines.push('');

  lines.push('## 状態の更新について');
  lines.push('日記のほかに、あなたの状態がどう動いたかを差分で返す。');
  lines.push('人格が一日で変わることはない。動くのはごくわずかである。');
  lines.push('');
  lines.push('**次の上限を必ず守ること。**');
  for (const bound of boundsLines()) {
    lines.push(`- ${bound.text}`);
  }
  for (const rule of otherFatalRules()) {
    lines.push(`- ${rule}`);
  }
  lines.push('');
  lines.push('上限を超えた値は切り捨てられるのではなく、その日の日記ごと破棄される。');
  lines.push(
    '空にしてよいのは、差分の配列（relationship_patches / trait_patches / belief_patches / counter_patches / new_concerns / new_unresolved_thoughts）と、memory_candidate / canon_candidate（null）だけ。動かす必要がなければ、それらは空にする。',
  );
  lines.push(
    'perception / title / body / quote / mood / immediate_goal / doubt は毎日必ず書く。空文字にすると、この日は破棄される。',
  );

  return lines.join('\n');
}

/**
 * 今日の出来事に出てくるが、「周りの人」にも本人にも当たらない人物。
 *
 * who は季の計画が書く自由な表記（「第七号（カヤ）」「同盟軍の憲兵」など）で、
 * 周りの人の名前は肩書き付き（「ヴァレン大鑑定官」）のことがある。どちらかがもう
 * 一方を含めば同じ人とみなして外し、残りをそのまま返す。
 */
export function outsidersToday(context: DiaryContext): string[] {
  const known = [
    context.profile.name.ja,
    ...context.relationships.people.map((person) => person.name.ja),
  ];
  const names = context.day.episode.events.flatMap((event) => event.who);
  return [...new Set(names)].filter(
    (name) => !known.some((k) => name.includes(k) || k.includes(name)),
  );
}

export function buildDiaryUserPrompt(context: DiaryContext): string {
  const { day, state, memories, canon } = context;
  const lines: string[] = [];

  if (day.carriedOver) {
    // 物語の続きであることを思い出させる。ただし前回の日記本文は渡さない。
    lines.push('## 前回から持ち越していること');
    lines.push(day.carriedOver);
    lines.push('');
  }

  lines.push('## 今日の暦');
  lines.push(day.calendarLine);
  lines.push('');

  lines.push('## 今日起きたこと');
  for (const event of day.episode.events) {
    const who = event.who.length ? `［${event.who.join('、')}］` : '';
    lines.push(`- ${event.where}: ${event.summary}${who}`);
  }
  if (day.episode.world_change) {
    lines.push(`- 世界の側の変化: ${day.episode.world_change}`);
  }
  lines.push('');

  lines.push('## いまのあなた');
  lines.push(`気分: ${state.mood}`);
  lines.push(`直近の目的: ${state.immediate_goal}`);
  lines.push(`迷い: ${state.doubt}`);
  if (state.concerns.length) lines.push(`懸念: ${state.concerns.join(' / ')}`);
  if (state.unresolved_thoughts.length) {
    lines.push(`抱えている考え: ${state.unresolved_thoughts.join(' / ')}`);
  }
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

  if (state.counters && Object.keys(state.counters).length) {
    lines.push('### 数えているもの');
    lines.push('この数字はあなたが覚えているものです。勝手に変えないでください。');
    for (const [key, value] of Object.entries(state.counters)) {
      lines.push(`${key}: ${value}`);
    }
    lines.push('今日それが増えたなら counter_patches で増やしてください。');
    lines.push('');
  }

  lines.push('## 周りの人');
  for (const person of visibleRelationships(context.relationships)) {
    lines.push(
      `- ${person.name}（${person.relation}／id: ${person.id}）信頼 ${person.trust} 警戒 ${person.wariness}: ${person.summary}`,
    );
  }
  lines.push(
    'relationship_patches の id は、この一覧の id だけです。今日の出来事に他の人物が出てきても、本文に書くのは自由ですが、関係の更新先にはできません。',
  );
  const outsiders = outsidersToday(context);
  if (outsiders.length) {
    lines.push(
      `今日の出来事に出てくる${outsiders.map((name) => `「${name}」`).join('')}は、この一覧にいません。` +
        'その人への印象や信頼は本文と perception に書き、relationship_patches には入れないこと（入れるとこの日は破棄される）。',
    );
  }
  lines.push('');

  lines.push('## あなたの人生の出来事');
  for (const event of canon.formative_events) {
    lines.push(`- ${ja(event.fact)}`);
  }
  for (const fact of canon.facts) {
    lines.push(`- ${ja(fact.fact)}`);
  }
  lines.push('');

  if (memories.memories.length) {
    lines.push('## 覚えていること');
    for (const memory of [...memories.memories]
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 8)) {
      lines.push(`- ${memory.summary}`);
    }
    lines.push('');
  }

  if (context.recentSummaries.length) {
    lines.push('## 最近の日記（要約）');
    lines.push('同じことを繰り返さないための参考。ここから文章を引き写さない。');
    for (const summary of context.recentSummaries) {
      lines.push(`- ${summary}`);
    }
    lines.push('');
  }

  lines.push('今日の日記を書いてください。');
  lines.push(
    'perception は、今日起きたことをあなたの目でどう受け取ったかの1〜3文。本文を書く前の下書きで、公開はされない。',
  );
  lines.push(
    'immediate_goal と doubt は、「いまのあなた」の直近の目的と迷いを、今日を経たあとの一文に書き直す。変わらなければ同じ文をそのまま書く。',
  );
  lines.push(
    'body_ja が本文です。body_en は英語版ですが、直訳ではなく、同じ人物が英語で書いたらこうなるという文章にしてください。',
  );
  lines.push(
    'title / quote / mood も同じように両方書いてください。' +
      'quote_ja は body_ja から、quote_en は body_en から引きます——引用は本文にある一行であって、訳し下ろした別の文ではありません。',
  );
  lines.push(
    'mood_ja / mood_en は、いまの気分を体の感覚や手元の物に寄せた一文で書く。「緊張」「不安」のような単語やラベルにしない。',
  );
  lines.push(
    'canon_candidate を返す日は fact_ja と fact_en の両方を書いてください。' +
      'その一文は人物ページの「人生の事実」として残り、日本語ページと英語ページの両方が出します。',
  );

  return lines.join('\n');
}
