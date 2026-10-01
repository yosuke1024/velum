import { describe, it, expect } from 'vitest';
import { buildStoryContext } from '../../src/story/context.js';
import {
  buildStoryPlanSystemPrompt,
  buildStoryPlanUserPrompt,
  buildStoryWriteSystemPrompt,
  buildStoryWriteUserPrompt,
  STORY_TEXT_LIMITS,
} from '../../src/story/prompt.js';
import { storyGate } from '../../src/story/write.js';
import { charPath } from '../../src/lib/paths.js';
import { readYaml } from '../../src/lib/storage.js';
import { ProfileSchema, RelationshipsSchema } from '../../src/schemas/character.js';
import { secretSegments } from '../../src/lib/secrets.js';
import { StoryPlanSchema, STORY_FORMATS } from '../../src/schemas/story.js';

const context = buildStoryContext('riko');

const plan = StoryPlanSchema.parse({
  id: 'riko-s01',
  character_id: 'riko',
  season: 1,
  character_arc: {
    start: '売れない品を抱えたまま、売ることだけを考えている',
    emotional_change: '売れない理由を、自分の側に見つけはじめる',
    end: '売らない、と口に出さずに決める',
  },
  relationships: { focus: ['mio', 'garon'] },
  episodes: [
    { order: 1, purpose: 'リコとミオの日常を見せる', situation: '市の隅の荷車。ミオが来て、何も買わずに帰る', format: 'first_person', people: ['mio'], working_title: 'ミオは何も買わない' },
    { order: 2, purpose: '値切られて本気で腹を立てる人であること', situation: '北の市の裏路地で客に値切られる', format: 'scene', people: [] },
  ],
});

describe('Story の材料（context）', () => {
  it('周りの人と人生の出来事と時代の固定事実を持つ', () => {
    expect(context.people.map((p) => p.id)).toEqual(['garon', 'mio']);
    expect(context.canon.formative_events.length).toBeGreaterThan(0);
    expect(context.fixedFacts.length).toBeGreaterThan(0);
    expect(context.eraName).toBe('静寂の時代');
  });

  it('声の基準（tests/fixtures/voice/riko.md）を読む', () => {
    expect(context.voiceSample).toContain('あたし');
  });
});

describe('Story のプロンプトは、本人が知らないことを渡さない', () => {
  const profile = readYaml(charPath('riko', 'profile.yaml'), ProfileSchema);
  const relationships = readYaml(charPath('riko', 'relationships.yaml'), RelationshipsSchema);
  const prompts = [
    buildStoryPlanUserPrompt(context, { season: 1, episodes: 8 }),
    buildStoryWriteUserPrompt(context, plan, 1, []),
    buildStoryWriteSystemPrompt(context, 'first_person'),
  ].join('\n');

  it('secret_unknown_to_self の断片が現れない', () => {
    for (const segment of secretSegments(profile.core.secret_unknown_to_self)) {
      expect(prompts.replace(/\s+/g, '')).not.toContain(segment.replace(/\s+/g, ''));
    }
  });

  it('hidden_from_protagonist の断片が現れない', () => {
    for (const person of relationships.people) {
      if (!person.hidden_from_protagonist) continue;
      for (const segment of secretSegments(person.hidden_from_protagonist)) {
        expect(prompts.replace(/\s+/g, '')).not.toContain(segment.replace(/\s+/g, ''));
      }
    }
  });

  it('本人が知っている秘密（secret_hidden）は渡す——行動の理由になる', () => {
    const first = secretSegments(profile.core.secret_hidden)[0]!;
    expect(prompts.replace(/\s+/g, '')).toContain(first.replace(/\s+/g, ''));
  });

  it('日次の状態（気分・懸念）は渡さない。Story は Base Persona で書く', () => {
    expect(prompts).not.toContain('気分:');
    expect(prompts).not.toContain('懸念:');
  });
});

describe('計画のプロンプト', () => {
  const system = buildStoryPlanSystemPrompt();
  const user = buildStoryPlanUserPrompt(context, { season: 1, episodes: 8 });

  it('Character から Plot を出す、と言う', () => {
    expect(system).toContain('Character から Plot を発生させる');
    expect(system).toContain('読者にこの人物の何を知ってほしいか');
  });

  it('日常の回を求め、全部を事件にしない', () => {
    expect(system).toContain('全部を大事件にしない');
  });

  it('形式の語彙を全部伝える', () => {
    for (const format of STORY_FORMATS) expect(system).toContain(format);
  });

  it('世界の謎を解決しない', () => {
    expect(system).toContain('解決しない');
  });

  it('周りの人の id と名前、話数、季を渡す', () => {
    expect(user).toContain('- mio: ミオ');
    expect(user).toContain('- garon: ガロン');
    expect(user).toContain('8話の連作');
    expect(user).toContain('第1季');
  });
});

describe('本文のプロンプト', () => {
  it('この回の目的と場面の種を渡し、前の話は要約だけ渡す', () => {
    const user = buildStoryWriteUserPrompt(context, plan, 2, [
      { order: 1, title: 'ミオは何も買わない', summary: 'ミオが来て、何も買わずに帰った' },
    ]);
    expect(user).toContain('値切られて本気で腹を立てる');
    expect(user).toContain('北の市の裏路地');
    expect(user).toContain('第1話「ミオは何も買わない」: ミオが来て');
  });

  it('形式に応じて一人称か三人称かを指示する', () => {
    expect(buildStoryWriteSystemPrompt(context, 'first_person')).toContain('一人称は「あたし」');
    expect(buildStoryWriteSystemPrompt(context, 'third_person')).toContain('本人の外から書く');
    expect(buildStoryWriteSystemPrompt(context, 'letter')).toContain('手紙');
  });

  it('ゲートが見る上限をプロンプトに書く（罠を作らない）', () => {
    const system = buildStoryWriteSystemPrompt(context, 'scene');
    expect(system).toContain(`${STORY_TEXT_LIMITS.bodyMinJa}〜${STORY_TEXT_LIMITS.bodyMaxJa} 文字`);
    expect(system).toContain(`${STORY_TEXT_LIMITS.titleMin}〜${STORY_TEXT_LIMITS.titleMax} 文字`);
  });

  it('絶対に言わない言葉を伝える', () => {
    expect(buildStoryWriteSystemPrompt(context, 'scene')).toContain('売り物じゃない');
  });

  it('計画に無い話は求められない', () => {
    expect(() => buildStoryWriteUserPrompt(context, plan, 9, [])).toThrow(/第9話/);
  });
});

describe('本文の構造ゲート', () => {
  const ok = {
    title_ja: 'ミオは何も買わない',
    title_en: 'Mio Never Buys Anything',
    body_ja: 'あ'.repeat(STORY_TEXT_LIMITS.bodyMinJa) + '\n\n' + 'い'.repeat(100),
    body_en: 'Eleven copper. '.repeat(40),
    summary_ja: '一覧の一文。',
    summary_en: 'One line for the list.',
  };

  it('形が合えば通す', () => {
    expect(storyGate(ok)).toEqual([]);
  });

  it('短すぎる本文を落とす', () => {
    expect(storyGate({ ...ok, body_ja: 'あ'.repeat(STORY_TEXT_LIMITS.bodyMinJa - 1) })).toHaveLength(1);
  });

  it('英語の本文に日本語が残っていれば落とす', () => {
    expect(storyGate({ ...ok, body_en: 'Eleven copper. 銅貨。' }).some((v) => v.includes('英語'))).toBe(true);
  });

  it('Markdown の装飾を落とす', () => {
    expect(storyGate({ ...ok, body_ja: `## 見出し\n${ok.body_ja}` }).some((v) => v.includes('Markdown'))).toBe(true);
  });

  it('長すぎるタイトルを落とす', () => {
    expect(storyGate({ ...ok, title_ja: 'あ'.repeat(STORY_TEXT_LIMITS.titleMax + 1) }).some((v) => v.includes('タイトル'))).toBe(true);
  });
});
