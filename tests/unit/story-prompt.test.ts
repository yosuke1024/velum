import { describe, it, expect } from 'vitest';
import { STORY_WRITE_LIMITS } from '../../src/schemas/limits.js';
import { CHARACTER_IDS } from '../../src/schemas/world.js';
import {
  STORY_FORMATS,
  StoryManifestSchema,
  StoryPlanSchema,
  type StoryPlan,
} from '../../src/schemas/story.js';
import { charPath } from '../../src/lib/paths.js';
import { readYaml } from '../../src/lib/storage.js';
import { ProfileSchema, RelationshipsSchema } from '../../src/schemas/character.js';
import { secretSegments } from '../../src/lib/secrets.js';
import { jsonSchema } from '../../src/lib/llm.js';
import { toStandardJsonSchema } from '../../src/lib/workers-ai.js';
import { buildStoryContext, type StoryContext } from '../../src/story/context.js';
import {
  BODY_JA_TARGET,
  STORY_EPISODE_EN_RESPONSE_SCHEMA,
  STORY_EPISODE_JA_RESPONSE_SCHEMA,
  STORY_FORMAT_GUIDE,
  STORY_PLAN_PROMPT_VERSION,
  STORY_PLAN_RESPONSE_SCHEMA,
  STORY_WRITE_PROMPT_VERSION,
  StoryEpisodeEnResponseSchema,
  StoryEpisodeJaResponseSchema,
  StoryPlanResponseSchema,
  buildEpisodeEnSystemPrompt,
  buildEpisodeEnUserPrompt,
  buildEpisodeJaSystemPrompt,
  buildEpisodeJaUserPrompt,
  buildStoryPlanSystemPrompt,
  buildStoryPlanUserPrompt,
  storyBoundsLines,
} from '../../src/story/prompt.js';

/** 空白の入り方に左右されない照合（src/lib/secrets.ts の secretLeaksIn と同じ見方）。 */
const flat = (text: string) => text.replace(/\s+/g, '');

/** 周りの2人の id を使った、テスト用の計画。 */
function planFor(context: StoryContext, count = 4): StoryPlan {
  const ids = context.people.map((person) => person.id);
  return StoryPlanSchema.parse({
    id: context.seriesId,
    character_id: context.characterId,
    season: 1,
    title: { ja: 'テストの季', en: 'A Test Season' },
    logline: 'この季が読者に残すもの（テスト）。',
    character_arc: {
      start: '季の始まりの人物（テスト）',
      emotional_change: '動くもの（テスト）',
      end: '季の終わりの人物（テスト）',
    },
    relationships: { focus: [ids[0]] },
    episodes: Array.from({ length: count }, (_, index) => ({
      order: index + 1,
      purpose: `第${index + 1}話の目的（テスト）`,
      situation: `第${index + 1}話の場面の種（テスト）`,
      format: STORY_FORMATS[index % STORY_FORMATS.length],
      people: index % 2 === 0 ? [ids[0]] : [],
      working_title: { ja: `仮題${index + 1}`, en: `Working Title ${index + 1}` },
    })),
  });
}

const withPlan = (context: StoryContext, count = 4): StoryContext => ({
  ...context,
  plan: planFor(context, count),
  manifest: null,
});

/** 人物ごとの、プロンプトへ渡してはいけない文の断片（本人も知らない真相・隠された事実）。 */
function hiddenSegments(id: string): Array<{ label: string; segment: string }> {
  const profile = readYaml(charPath(id, 'profile.yaml'), ProfileSchema);
  const relationships = readYaml(charPath(id, 'relationships.yaml'), RelationshipsSchema);
  const out = secretSegments(profile.core.secret_unknown_to_self).map((segment) => ({
    label: `${id}/secret_unknown_to_self`,
    segment,
  }));
  for (const person of relationships.people) {
    for (const segment of secretSegments(person.hidden_from_protagonist ?? '')) {
      out.push({ label: `${id}/${person.id}/hidden_from_protagonist`, segment });
    }
  }
  return out;
}

describe('プロンプトは、生成ゲートが落とせる上限をすべて述べる', () => {
  const lines = storyBoundsLines();
  const covered = new Set(lines.map((line) => line.limit));
  const riko = buildStoryContext('riko', 1);
  const jaPrompt = buildEpisodeJaSystemPrompt(riko);
  const enPrompt = buildEpisodeEnSystemPrompt(riko);

  for (const key of Object.keys(STORY_WRITE_LIMITS)) {
    it(`${key} に対応する説明がある`, () => {
      expect(covered.has(key as keyof typeof STORY_WRITE_LIMITS)).toBe(true);
    });
  }

  it('説明文に実際の数値が埋め込まれている', () => {
    for (const line of lines) {
      expect(line.text).toContain(String(STORY_WRITE_LIMITS[line.limit]));
    }
  });

  it('日本語版の呼び出しには ja の上限が、英語版には en の上限が、書かれている', () => {
    for (const line of lines) {
      const prompt = line.lang === 'ja' ? jaPrompt : enPrompt;
      expect(prompt).toContain(line.text);
      const other = line.lang === 'ja' ? enPrompt : jaPrompt;
      expect(other).not.toContain(line.text);
    }
  });

  it('計画のプロンプトには、仮題の長さの上限が書かれている', () => {
    const plan = buildStoryPlanSystemPrompt(8);
    expect(plan).toContain(String(STORY_WRITE_LIMITS.titleJaMaxChars));
    expect(plan).toContain(String(STORY_WRITE_LIMITS.titleEnMaxChars));
  });

  it('上限を超えると破棄される（切り詰められない）と伝える', () => {
    for (const line of lines) expect(line.text).toMatch(/破棄/);
    expect(jaPrompt).toMatch(/切り詰められるのではなく/);
  });

  it('本文の長さの目安は、上限の内側にある', () => {
    expect(BODY_JA_TARGET.min).toBeGreaterThanOrEqual(STORY_WRITE_LIMITS.bodyJaMinChars);
    expect(BODY_JA_TARGET.max).toBeLessThanOrEqual(STORY_WRITE_LIMITS.bodyJaMaxChars);
  });
});

describe('計画のプロンプト', () => {
  it('話数をちょうどの件数として強く述べる', () => {
    const prompt = buildStoryPlanSystemPrompt(8);
    expect(prompt).toContain('ちょうど 8 話');
    expect(prompt).toContain('7 件でも 9 件でも');

    const user = buildStoryPlanUserPrompt(buildStoryContext('riko', 1), 10);
    expect(user).toContain('全 10 話');
    expect(user).toContain('episodes はちょうど 10 件');
  });

  it('旧 Season Plan の固定5構造の語を持ち込まない', () => {
    // 発端→展開→転機→危機→決着は廃止した。目的は「人物の何を知ってほしいか」である。
    const prompt = buildStoryPlanSystemPrompt(8);
    for (const word of ['発端', '展開', '転機', '危機', '決着']) {
      expect(prompt).not.toContain(word);
    }
  });

  it('各話の目的を、筋の段取りではなく「人物の何を知ってほしいか」として定義する', () => {
    const prompt = buildStoryPlanSystemPrompt(8);
    expect(prompt).toContain('この回で読者に人物の何を知ってほしいか');
    expect(prompt).toContain('人物を筋の中に置かない');
  });

  it('形式の選択肢をすべて載せる', () => {
    const prompt = buildStoryPlanSystemPrompt(8);
    for (const format of STORY_FORMATS) {
      expect(prompt).toContain(`- ${format}: ${STORY_FORMAT_GUIDE[format]}`);
    }
  });

  it('空にしてよい欄を名指しする（Gemma は文字どおりに読む）', () => {
    const prompt = buildStoryPlanSystemPrompt(8);
    expect(prompt).toMatch(/空にしてよいのは、episodes の各 people が空の配列のとき/);
    // 全欄の言語・長さ・形が定義されている
    for (const field of [
      'title_ja',
      'title_en',
      'logline',
      'arc_start',
      'arc_change',
      'arc_end',
      'focus',
      'purpose',
      'situation',
      'format',
      'people',
      'working_title_ja',
      'working_title_en',
    ]) {
      expect(prompt).toContain(`- ${field}:`);
    }
  });

  it('硬い規則は世界を壊すものだけで、禁止を積まない', () => {
    const prompt = buildStoryPlanSystemPrompt(8);
    const section = prompt.split('## 世界を壊さないために（これだけは守る）')[1]!.split('## 返す欄')[0]!;
    const rules = section.split('\n').filter((line) => line.startsWith('- '));
    expect(rules.length).toBeLessThanOrEqual(3);
    expect(section).toContain('超常や奇跡の実在を確定させない');
    expect(section).toContain('本人だけが知っていること');
  });

  it('企画メモがあれば添え、無ければ節ごと出さない', () => {
    const riko = buildStoryContext('riko', 1);
    const withBrief = buildStoryPlanUserPrompt(
      { ...riko, brief: 'テスト用の企画メモ: 朝食の回を入れたい' },
      8,
    );
    expect(withBrief).toContain('## 季の企画メモ');
    expect(withBrief).toContain('テスト用の企画メモ: 朝食の回を入れたい');

    const without = buildStoryPlanUserPrompt({ ...riko, brief: null }, 8);
    expect(without).not.toContain('企画メモ');
  });

  it('manifest.yaml にすでにある題と形式を、変えないものとして渡す', () => {
    const riko = buildStoryContext('riko', 1);
    const manifest = StoryManifestSchema.parse({
      id: riko.seriesId,
      character_id: 'riko',
      season: 1,
      title: { ja: 'テスト', en: 'Test' },
      status: 'draft',
      episodes: [
        {
          id: `${riko.seriesId}-e01`,
          order: 1,
          required_progress: 0,
          status: 'draft',
          title: { ja: '決まっている題', en: 'A Fixed Title' },
          format: 'letter',
        },
        { id: `${riko.seriesId}-e02`, order: 2, required_progress: 2, status: 'draft' },
      ],
    });
    const prompt = buildStoryPlanUserPrompt({ ...riko, manifest }, 8);
    expect(prompt).toContain('## すでに決まっている話');
    // 出典が manifest.yaml であることを言う
    expect(prompt).toContain('manifest.yaml にすでに題や形式が書かれている話');
    expect(prompt).toContain('題「決まっている題」（A Fixed Title）、形式 letter');
    // 何も決まっていない第2話は載せない
    expect(prompt).not.toContain('第2話: ');
  });

  it('周りの人は id つきで渡す（people / focus に書かせるため）', () => {
    const riko = buildStoryContext('riko', 1);
    const prompt = buildStoryPlanUserPrompt(riko, 8);
    for (const person of riko.people) {
      expect(prompt).toContain(`${person.name}（${person.relation}／id: ${person.id}）`);
    }
  });

  it('前の季の計画があれば、同じ目的を繰り返さないよう添える', () => {
    const riko = buildStoryContext('riko', 2);
    const previous = planFor({ ...riko, seriesId: 'riko-s01' });
    const prompt = buildStoryPlanUserPrompt({ ...riko, previousPlan: previous }, 8);
    expect(prompt).toContain('前の季（第1季「テストの季」）の計画');
    expect(prompt).toContain('第1話の目的: 第1話の目的（テスト）');
  });
});

describe('本文のプロンプト', () => {
  const riko = withPlan(buildStoryContext('riko', 1));

  it('声のしるしを載せる（一人称・癖・絶対に言わない言葉・笑いの仕組み）', () => {
    const prompt = buildEpisodeJaSystemPrompt(riko);
    const { voice, humor, appraisal } = riko.profile;
    expect(prompt).toContain(`一人称は「${voice.firstPerson}」`);
    expect(prompt).toContain(voice.register);
    expect(prompt).toContain(`癖: ${voice.tic}`);
    expect(prompt).toContain(`絶対に言わない言葉: 「${voice.neverSays}」`);
    expect(prompt).toContain(`笑いの仕組み: ${humor}`);
    expect(prompt).toContain(`物に向ける問い: ${appraisal.question}`);
    expect(prompt).toContain(riko.profile.rareExpression);
  });

  it('定型が崩れる瞬間は「季に1度まで」「目的か場面の種に書かれたときだけ」と伝える', () => {
    const prompt = buildEpisodeJaSystemPrompt(riko);
    expect(prompt).toContain('季に1度まで');
    expect(prompt).toContain('目的か場面の種に、その崩れが書かれているときにだけ使う');
  });

  it('本人だけが知っていることを、動機に使ってよいが明かさないものとして渡す', () => {
    const prompt = buildEpisodeJaSystemPrompt(riko);
    expect(prompt).toContain(
      `本人だけが知っていること——動機として使ってよいが、本文で説明したり明かしたりしない: ${riko.profile.secretHidden}`,
    );
  });

  it('人生の出来事と声の見本を載せ、見本は写さないものとして渡す', () => {
    const prompt = buildEpisodeJaSystemPrompt(riko);
    for (const event of riko.formativeEvents) expect(prompt).toContain(event);
    expect(riko.voiceSample).not.toBeNull();
    expect(prompt).toContain('文・数字・言い回しを写さない');
    // 見本ファイルの見出しは、プロンプトの節（##）と取り違えない形になっている
    expect(prompt).not.toContain('## 日記（通常日）');
    expect(prompt).toContain('【日記（通常日）】');
  });

  it('形式を毎晩の日記にしない・世界の予備知識なしで読めるよう方向づける', () => {
    const prompt = buildEpisodeJaSystemPrompt(riko);
    expect(prompt).toContain('毎晩の日記の体裁（その日の締め）にしない');
    expect(prompt).toContain('世界の予備知識がなくても読めるようにする');
    expect(prompt).toContain('新しく名前の付く人物は、この話で0〜2人まで');
    expect(prompt).toContain('人物の性格が大きく変わる話にしない');
  });

  it('本文はプレーンテキストで、Markdown を使わないと伝える', () => {
    const prompt = buildEpisodeJaSystemPrompt(riko);
    expect(prompt).toContain('プレーンテキスト');
    expect(prompt).toContain('段落は空行ひとつで区切る');
    expect(prompt).toContain('Markdown や装飾は使わない');
  });

  it('返す欄を定義し、空にしないと言う', () => {
    const prompt = buildEpisodeJaSystemPrompt(riko);
    expect(prompt).toContain('**どちらも必須。空文字にしない。**');
    expect(prompt).toContain('- title_ja:');
    expect(prompt).toContain('- body_ja:');
    const en = buildEpisodeEnSystemPrompt(riko);
    expect(en).toContain('- title_en:');
    expect(en).toContain('- body_en:');
  });

  it('日本語版のユーザープロンプトは、この話の目的・場面・形式と、前後の話の目的を渡す', () => {
    const prompt = buildEpisodeJaUserPrompt(riko, 2);
    const plan = riko.plan!;
    const second = plan.episodes[1]!;

    expect(prompt).toContain(`目的（この回で読者に知ってほしいこと）: ${second.purpose}`);
    expect(prompt).toContain(`場面の種: ${second.situation}`);
    expect(prompt).toContain(`形式: ${second.format}（${STORY_FORMAT_GUIDE[second.format]}）`);
    // 前の話は目的だけ（本文は渡さない）、後の話は先取りしないものとして
    expect(prompt).toContain('前の話（本文は渡さない');
    expect(prompt).toContain(`第1話（${plan.episodes[0]!.format}）: ${plan.episodes[0]!.purpose}`);
    expect(prompt).toContain('後の話（この話では先取りしない）');
    expect(prompt).toContain(`第3話: ${plan.episodes[2]!.purpose}`);
    expect(prompt).toContain(`第4話: ${plan.episodes[3]!.purpose}`);
  });

  it('第1話は「読者が最初に出会う話」と伝え、前の話の節を出さない', () => {
    const prompt = buildEpisodeJaUserPrompt(riko, 1);
    expect(prompt).toContain('読者がこの人物と最初に出会う');
    expect(prompt).not.toContain('## 前の話');
  });

  it('台帳にすでに題があれば、その題を title_ja にそのまま書かせ、前の話は題つきで渡す', () => {
    const manifest = StoryManifestSchema.parse({
      id: riko.seriesId,
      character_id: 'riko',
      season: 1,
      title: { ja: 'テスト', en: 'Test' },
      status: 'draft',
      episodes: [
        {
          id: `${riko.seriesId}-e01`,
          order: 1,
          required_progress: 0,
          status: 'draft',
          title: { ja: '一話の題', en: 'One' },
        },
        {
          id: `${riko.seriesId}-e02`,
          order: 2,
          required_progress: 2,
          status: 'draft',
          title: { ja: '二話の題', en: 'Two' },
        },
      ],
    });
    const prompt = buildEpisodeJaUserPrompt({ ...riko, manifest }, 2);
    expect(prompt).toContain('題はすでに「二話の題」と決まっている。title_ja には、この題をそのまま書く');
    expect(prompt).toContain('第1話「一話の題」');

    const without = buildEpisodeJaUserPrompt(riko, 2);
    expect(without).toContain('題は、本文を書いたあとで付ける');
    // 台帳に題が無ければ、計画の仮題を「使っても付け直してもよい」ものとして渡す（固定ではない）
    expect(without).toContain(`計画の仮題は「${riko.plan!.episodes[1]!.working_title.ja}」`);
    expect(without).toContain('付け直してよい');
    expect(without).not.toContain('題はすでに');
  });

  it('形式は台帳の値が plan より優先で、前の話の欄にも台帳の形式を出す。台帳が空なら plan の形式', () => {
    const planFormat = (order: number) => riko.plan!.episodes[order - 1]!.format;
    const override = planFormat(1) === 'scene' ? 'letter' : 'scene';
    const manifest = StoryManifestSchema.parse({
      id: riko.seriesId,
      character_id: 'riko',
      season: 1,
      title: { ja: 'テスト', en: 'Test' },
      status: 'draft',
      episodes: [
        { id: `${riko.seriesId}-e01`, order: 1, required_progress: 0, status: 'draft', format: override },
        { id: `${riko.seriesId}-e02`, order: 2, required_progress: 2, status: 'draft' },
      ],
    });

    const first = buildEpisodeJaUserPrompt({ ...riko, manifest }, 1);
    expect(first).toContain(`形式: ${override}（${STORY_FORMAT_GUIDE[override]}）`);

    const second = buildEpisodeJaUserPrompt({ ...riko, manifest }, 2);
    expect(second).toContain(`形式: ${planFormat(2)}（${STORY_FORMAT_GUIDE[planFormat(2)]}）`);
    expect(second).toContain(`第1話（${override}）:`);

    // 台帳が無い（null）ときは plan の形式
    expect(buildEpisodeJaUserPrompt(riko, 1)).toContain(`形式: ${planFormat(1)}（`);
  });

  it('その話に出る人だけを「出る人」として挙げる', () => {
    const prompt = buildEpisodeJaUserPrompt(riko, 1);
    const first = riko.people[0]!;
    expect(prompt).toContain(`この話に出る周りの人: ${first.name}`);
    const nobody = buildEpisodeJaUserPrompt(riko, 2);
    expect(nobody).toContain('この話に、周りの人は出ない。');
  });

  it('計画の無い文脈では、本文のプロンプトを作らない', () => {
    expect(() => buildEpisodeJaUserPrompt({ ...riko, plan: null }, 1)).toThrow(/plan\.yaml/);
    expect(() => buildEpisodeJaUserPrompt(riko, 9)).toThrow(/第9話/);
  });

  it('英語版は、直訳ではなく同じ人物が英語で語る文章を求め、名前の綴りの表を渡す', () => {
    const system = buildEpisodeEnSystemPrompt(riko);
    expect(system).toContain('直訳ではない');
    expect(system).toContain('段落の切れ目と間は、日本語版と同じにする');
    expect(system).toContain(`${riko.profile.name} → ${riko.profile.nameEn}`);
    for (const person of riko.people) {
      expect(system).toContain(`${person.name} → ${person.nameEn}`);
    }
    expect(system).toContain(riko.profile.voiceEn.tic);
    expect(system).toContain('英語だけで書く');
  });

  it('英語版のユーザープロンプトは、完成した日本語版の題と本文を渡す', () => {
    const user = buildEpisodeEnUserPrompt(riko, 1, { title: '日本語の題', body: '日本語の本文です。\n\n二段落目。' });
    expect(user).toContain('題: 日本語の題');
    expect(user).toContain('日本語の本文です。\n\n二段落目。');
    expect(user).toContain('直訳でなくてよい');

    const fixed = buildEpisodeEnUserPrompt(
      riko,
      1,
      { title: '日本語の題', body: '本文' },
      { fixedTitleEn: 'Fixed Title' },
    );
    expect(fixed).toContain('title_en には、この題をそのまま書く');
    expect(fixed).toContain('"Fixed Title"');

    // 題が決まっていなければ、計画の英語の仮題を、使っても付け直してもよいものとして渡せる
    const working = buildEpisodeEnUserPrompt(
      riko,
      1,
      { title: '日本語の題', body: '本文' },
      { workingTitleEn: 'Working Title' },
    );
    expect(working).toContain('計画の英語の仮題は "Working Title"');
    expect(working).toContain('付け直してよい');
    expect(working).not.toContain('title_en には、この題をそのまま書く');
    expect(user).not.toContain('計画の英語の仮題');
  });

  it('プロンプトの版は、manifest に残す識別子として決まっている', () => {
    expect(STORY_PLAN_PROMPT_VERSION).toBe('story-plan-v1');
    expect(STORY_WRITE_PROMPT_VERSION).toBe('story-write-v1');
  });
});

describe('本人が知らないことを、プロンプトへ渡さない', () => {
  for (const id of CHARACTER_IDS) {
    it(`${id}: 本人も知らない真相と隠された事実を、どのプロンプトにも入れない`, () => {
      const context = withPlan(buildStoryContext(id, 1));
      const prompts: Record<string, string> = {
        'plan system': buildStoryPlanSystemPrompt(8),
        'plan user': buildStoryPlanUserPrompt(context, 8),
        'ja system': buildEpisodeJaSystemPrompt(context),
        'en system': buildEpisodeEnSystemPrompt(context),
      };
      for (const order of [1, 2, 3, 4]) {
        prompts[`ja user ${order}`] = buildEpisodeJaUserPrompt(context, order);
        prompts[`en user ${order}`] = buildEpisodeEnUserPrompt(context, order, {
          title: '題',
          body: '本文',
        });
      }

      const hidden = hiddenSegments(id);
      // 断片が取れていること自体を確かめる（空の一覧では、何も検査していない）
      expect(hidden.length).toBeGreaterThan(0);

      for (const [name, prompt] of Object.entries(prompts)) {
        const stripped = flat(prompt);
        for (const { label, segment } of hidden) {
          expect(
            stripped.includes(flat(segment)),
            `${id} の ${name} に ${label} の断片が入っている`,
          ).toBe(false);
        }
      }
    });

    it(`${id}: 設計メモ・関係の数値・糸のメタも渡さない`, () => {
      const profile = readYaml(charPath(id, 'profile.yaml'), ProfileSchema);
      const relationships = readYaml(charPath(id, 'relationships.yaml'), RelationshipsSchema);
      const context = withPlan(buildStoryContext(id, 1));
      const all = flat(
        [
          buildStoryPlanUserPrompt(context, 8),
          buildEpisodeJaSystemPrompt(context),
          buildEpisodeJaUserPrompt(context, 1),
          buildEpisodeEnSystemPrompt(context),
        ].join('\n'),
      );

      expect(all).not.toContain(flat(profile.appeal_axis));
      expect(all).not.toContain(flat(profile.reader_distance));
      // core.note は設計メモ。時代の固定事実（公開の canon）に同じ文があるときは、そちらから入る。
      const canon = flat(context.canonFacts.join('\n'));
      for (const segment of secretSegments(profile.core.note ?? '')) {
        if (canon.includes(flat(segment))) continue;
        expect(all).not.toContain(flat(segment));
      }
      for (const person of relationships.people) {
        for (const segment of secretSegments(person.thread ?? '')) {
          expect(all).not.toContain(flat(segment));
        }
      }
    });

    it(`${id}: 文脈の型が、関係の数値・メタ・秘密の欄を持たない`, () => {
      const context = buildStoryContext(id, 1);
      for (const person of context.people) {
        expect(Object.keys(person).sort()).toEqual(['id', 'name', 'nameEn', 'relation', 'summary']);
      }
      expect(JSON.stringify(context)).not.toMatch(/secret_unknown_to_self|hidden_from_protagonist|wariness/);
    });
  }

  it('本人が知っている秘密（secret_hidden）は渡す', () => {
    // 動機として使ってよいので、プロンプトにある。隠されているのは「本人も知らない」ほう。
    const context = buildStoryContext('riko', 1);
    const profile = readYaml(charPath('riko', 'profile.yaml'), ProfileSchema);
    const [first] = secretSegments(profile.core.secret_hidden);
    expect(first).toBeDefined();
    expect(flat(buildEpisodeJaSystemPrompt(context))).toContain(flat(first!));
  });
});

describe('応答の形', () => {
  it('JSON Schema と zod が同じ欄を持つ', () => {
    const keys = (schema: Record<string, unknown>) =>
      Object.keys(schema.properties as Record<string, unknown>).sort();

    expect(keys(STORY_PLAN_RESPONSE_SCHEMA)).toEqual(Object.keys(StoryPlanResponseSchema.shape).sort());
    expect(keys(STORY_EPISODE_JA_RESPONSE_SCHEMA)).toEqual(
      Object.keys(StoryEpisodeJaResponseSchema.shape).sort(),
    );
    expect(keys(STORY_EPISODE_EN_RESPONSE_SCHEMA)).toEqual(
      Object.keys(StoryEpisodeEnResponseSchema.shape).sort(),
    );
    // すべての欄が required（空にしてよい欄は「空」で返させる）
    for (const schema of [
      STORY_PLAN_RESPONSE_SCHEMA,
      STORY_EPISODE_JA_RESPONSE_SCHEMA,
      STORY_EPISODE_EN_RESPONSE_SCHEMA,
    ]) {
      expect([...(schema.required as string[])].sort()).toEqual(keys(schema));
    }
  });

  it('形式は選択肢を閉じた enum で渡す', () => {
    const episodes = (STORY_PLAN_RESPONSE_SCHEMA.properties as Record<string, any>).episodes;
    expect(episodes.items.properties.format).toEqual({ type: 'string', enum: [...STORY_FORMATS] });
    expect(episodes.items.required).toContain('format');
  });

  it('Workers AI へ渡す標準形でも enum と integer が落ちない', () => {
    const converted = toStandardJsonSchema(
      jsonSchema.object({ kind: jsonSchema.enum(['a', 'b']), n: jsonSchema.integer() }, ['kind', 'n']),
    );
    expect(converted).toEqual({
      type: 'object',
      properties: { kind: { type: 'string', enum: ['a', 'b'] }, n: { type: 'integer' } },
      required: ['kind', 'n'],
    });
    expect(JSON.stringify(toStandardJsonSchema(STORY_PLAN_RESPONSE_SCHEMA))).toContain('"enum"');
  });

  it('zod は空文字を形の違いとして退ける（再試行できる）', () => {
    expect(StoryEpisodeJaResponseSchema.safeParse({ title_ja: '題', body_ja: '' }).success).toBe(false);
    expect(StoryEpisodeEnResponseSchema.safeParse({ title_en: 'T', body_en: 'x' }).success).toBe(true);
    // people だけは空の配列でよい
    const ok = StoryPlanResponseSchema.safeParse({
      title_ja: 'a',
      title_en: 'a',
      logline: 'a',
      arc_start: 'a',
      arc_change: 'a',
      arc_end: 'a',
      focus: ['x'],
      episodes: [
        {
          purpose: 'a',
          situation: 'a',
          format: 'scene',
          people: [],
          working_title_ja: 'a',
          working_title_en: 'a',
        },
      ],
    });
    expect(ok.success).toBe(true);
  });
});
