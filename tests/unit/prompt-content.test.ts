import { describe, it, expect } from 'vitest';
import { buildTickContext } from '../../src/tick/context.js';
import { buildTickUserPrompt, buildTickSystemPrompt } from '../../src/tick/prompt.js';
import { buildDiaryUserPrompt, buildDiarySystemPrompt } from '../../src/diary/prompt.js';
import { loadCharacter } from '../../src/diary/context.js';
import { TickSchema, type Tick } from '../../src/schemas/tick.js';

const tick: Tick = TickSchema.parse({
  date: '2026-09-01',
  era: 'guilds',
  protagonist: 'teo',
  card: { id: 'appraisal-duty', prompt: '持ち込み鑑定の当番が回ってくる。' },
  arc: { id: 'guilds-provisional-sigil', thread: 'why-no-recommendation' },
  events: [
    {
      summary: '真鍮商が燭台を持ち込み、先輩三人が黄金期の逸品と判定した',
      where: '大鑑定院',
      who: ['先輩鑑定士'],
    },
  ],
  world_change: null,
  generation: {
    model: 'gemini-3.5-flash',
    prompt_version: 'tick-v1',
    seed: '2026-09-01:guilds',
    generated_at: '2026-09-01T00:00:00.000Z',
  },
});

describe('World Tick のプロンプト', () => {
  const context = buildTickContext('2026-09-01', 'guilds', 'teo');

  it('固定事実を渡す', () => {
    const prompt = buildTickUserPrompt(context);
    expect(prompt).toContain('物は嘘をつかない');
  });

  it('アークと現在状態を渡す', () => {
    const prompt = buildTickUserPrompt(context);
    expect(prompt).toContain('仮銘審査');
    expect(prompt).toContain(context.state.mood);
  });

  it('引いたカードを渡す', () => {
    const prompt = buildTickUserPrompt(context);
    expect(prompt).toContain(context.card.prompt);
  });

  it('感情や解釈を書かないよう指示する', () => {
    // Tick は「起きた事実」であって、人物がどう受け取ったかではない。
    // ここで主観が混ざると、日記が事実を上書きできてしまう。
    const prompt = buildTickSystemPrompt();
    expect(prompt).toMatch(/出来事だけを書く/);
    expect(prompt).toMatch(/感情|内面/);
  });

  it('毎日を事件にしないよう指示する', () => {
    const prompt = buildTickSystemPrompt();
    expect(prompt).toMatch(/何も起きない日/);
  });
});

describe('日記のプロンプト', () => {
  const character = loadCharacter('teo');
  const context = { ...character, tick, recentSummaries: [] };

  it('Tick の出来事を渡す', () => {
    const prompt = buildDiaryUserPrompt(context);
    expect(prompt).toContain('燭台');
    expect(prompt).toContain('大鑑定院');
  });

  it('関係先の id を渡す（差分の宛先になるため）', () => {
    const prompt = buildDiaryUserPrompt(context);
    expect(prompt).toContain('id: vallen');
    expect(prompt).toContain('id: lowe');
  });

  it('現在の特性と信念を数値で渡す', () => {
    const prompt = buildDiaryUserPrompt(context);
    expect(prompt).toContain('pride');
    expect(prompt).toContain('規約は正しい');
  });

  it('直近の日記は要約だけを渡し、全文は渡さない', () => {
    const withHistory = {
      ...context,
      recentSummaries: ['2026-08-27「座金は逆だ」— 別に、悔しくはない。'],
    };
    const prompt = buildDiaryUserPrompt(withHistory);

    expect(prompt).toContain('座金は逆だ');
    expect(prompt).toMatch(/引き写さない/);
  });

  it('声の定型を渡す', () => {
    const prompt = buildDiarySystemPrompt(context);
    expect(prompt).toContain('私');
    expect(prompt).toContain(character.profile.voice.never_says);
  });

  it('レア表現をめったに使わないよう伝える', () => {
    const prompt = buildDiarySystemPrompt(context);
    expect(prompt).toMatch(/めったにない/);
  });
});
