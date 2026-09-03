import { describe, it, expect } from 'vitest';
import { buildSeasonContext } from '../../src/season/context.js';
import { buildSeasonUserPrompt, buildSeasonSystemPrompt } from '../../src/season/prompt.js';
import { buildDiaryUserPrompt, buildDiarySystemPrompt } from '../../src/diary/prompt.js';
import { loadCharacter, type Day } from '../../src/diary/context.js';
import { EpisodeSchema, BEATS, EPISODES_PER_SEASON } from '../../src/schemas/season.js';
import type { Turn } from '../../src/lib/rotation.js';
import { ja } from '../../src/lib/bilingual.js';

const turn: Turn = {
  era: 'guilds',
  protagonist: 'teo',
  dayIndex: 0,
  season: 1,
  episode: 1,
};

const episode = EpisodeSchema.parse({
  number: 1,
  beat: '発端',
  world_date: { month: 7, day: 4 },
  events: [
    {
      summary: '真鍮商が燭台を持ち込み、先輩三人が黄金期の逸品と判定した',
      where: '大鑑定院',
      who: ['先輩鑑定士'],
    },
  ],
  world_change: null,
  leaves_open: {
    ja: '座金の向きを誰も見ていない',
    en: 'Nobody has looked at which way the washer faces',
  },
});

const day: Day = {
  date: '2026-09-01',
  turn,
  episode,
  carriedOver: null,
  worldYear: 375,
  calendarLine: '375年 星の月4日（秋）。仮銘審査まであと26日',
};

describe('季の計画のプロンプト', () => {
  const context = buildSeasonContext(1, 'guilds', 'teo');

  it('固定事実を渡す', () => {
    expect(buildSeasonUserPrompt(context)).toContain('物は嘘をつかない');
  });

  it('未解決の問いを全部渡す', () => {
    // 日ごとの生成と違い、5話の形を作るには何が宙に浮いているかの一望が要る。
    const prompt = buildSeasonUserPrompt(context);
    for (const item of context.unresolved) {
      expect(prompt).toContain(item.question);
    }
  });

  it('5話の形を指示する', () => {
    const prompt = buildSeasonSystemPrompt();
    for (const beat of BEATS) {
      expect(prompt).toContain(beat);
    }
  });

  it('5話がつながっていることを求める', () => {
    const prompt = buildSeasonSystemPrompt();
    expect(prompt).toMatch(/前の話の結果の上に立つ/);
    expect(prompt).toMatch(/独立した.*日ではなく/);
  });

  it('感情や解釈を書かないよう指示する', () => {
    // 出来事だけを書かせる。ここで主観が混ざると、日記が事実を上書きできてしまう。
    const prompt = buildSeasonSystemPrompt();
    expect(prompt).toMatch(/出来事だけを書く/);
    expect(prompt).toMatch(/感情|内面/);
  });

  it('全部の話を事件にしないよう指示する', () => {
    expect(buildSeasonSystemPrompt()).toMatch(/何も起きない日でよい/);
  });

  it('問いを全部片づけないよう指示する', () => {
    expect(buildSeasonSystemPrompt()).toMatch(/全部片づけようとしない/);
  });

  it('カードは素材であり、そのまま使わないと指示する', () => {
    expect(buildSeasonSystemPrompt()).toMatch(/イベントカードは素材/);
    expect(buildSeasonUserPrompt(context)).toMatch(/そのまま出来事にしない/);
  });

  it('謎を解決しないよう指示する', () => {
    // 第1季の生成が、父の改ざん・裂け目の仕組み・奇跡の実在を「判明」させた反省。
    const prompt = buildSeasonSystemPrompt();
    expect(prompt).toMatch(/解決することは違う/);
    expect(prompt).toMatch(/「判明」させる出来事を置かない/);
    expect(prompt).toMatch(/別の説明が可能な形/);
    expect(prompt).toMatch(/「偶然だ」と言える余地/);
  });

  it('現実の世界の名前を使わないよう指示する', () => {
    expect(buildSeasonSystemPrompt()).toMatch(/現実の世界の名前/);
  });

  it('5話ぶんより多めにカードを引く（使わない札があってよい）', () => {
    expect(context.cards.length).toBeGreaterThan(EPISODES_PER_SEASON);
  });

  it('第1季には持ち越しがない', () => {
    expect(context.carriedOver).toBeNull();
  });
});

describe('日記のプロンプト', () => {
  const character = loadCharacter('teo');
  const context = { ...character, day, recentSummaries: [] };

  it('計画された出来事を渡す', () => {
    const prompt = buildDiaryUserPrompt(context);
    expect(prompt).toContain('燭台');
    expect(prompt).toContain('大鑑定院');
  });

  it('前の話から持ち越したものを渡す', () => {
    const withCarry = {
      ...context,
      day: { ...day, carriedOver: '推薦状の話がまだ出ていない' },
    };
    const prompt = buildDiaryUserPrompt(withCarry);
    expect(prompt).toContain('持ち越していること');
    expect(prompt).toContain('推薦状の話がまだ出ていない');
  });

  it('第1話には持ち越しの節を出さない', () => {
    expect(buildDiaryUserPrompt(context)).not.toContain('持ち越していること');
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
    // プロンプトは日本語で書く。二言語の欄からは日本語を採る。
    expect(prompt).toContain(ja(character.profile.voice.never_says));
  });

  it('レア表現をめったに使わないよう伝える', () => {
    expect(buildDiarySystemPrompt(context)).toMatch(/めったにない/);
  });

  // diary-v3（2026-09-03）。profile.yaml にあってプロンプトへ届いていなかったもの。
  it('崩れ方そのもの（rare_expression）を渡す', () => {
    const prompt = buildDiarySystemPrompt(context);
    expect(prompt).toContain(character.profile.rare_expression.trim().slice(0, 10));
    expect(prompt).toMatch(/定型が崩れる瞬間/);
  });

  it('笑いの仕組みを渡す', () => {
    expect(buildDiarySystemPrompt(context)).toContain(
      ja(character.profile.appraisal.humor).slice(0, 10),
    );
  });

  it('今日崩してよいかを明示し、ゲートと同じ値を読む', () => {
    // 省略時は許可。履歴を見ていない呼び出し（テスト・dry-run）で崩れを禁じない。
    expect(buildDiarySystemPrompt(context)).toMatch(/崩してもよい日/);
    expect(buildDiarySystemPrompt({ ...context, rareExpressionAllowed: true })).toMatch(/崩してもよい日/);
    const cooling = buildDiarySystemPrompt({ ...context, rareExpressionAllowed: false });
    expect(cooling).toMatch(/今日は崩さない/);
    expect(cooling).not.toMatch(/崩してもよい日/);
  });

  it('感情の名指しを禁じ、代わりに何で見せるかを言う', () => {
    // 9/1 テオ「胸の奥が騒ぐ」「動揺は収まらない」の反省。
    const prompt = buildDiarySystemPrompt(context);
    expect(prompt).toMatch(/感情を名指しする文は書かない/);
    expect(prompt).toMatch(/否定/);
    expect(prompt).toMatch(/数字、物/);
  });

  it('形の自由を許す（段落・一行段落・見え消し線・様式）', () => {
    // 9/2 リコが一段落の塊で出た反省。見本は短い段落と改行で笑いを落としている。
    const prompt = buildDiarySystemPrompt(context);
    expect(prompt).toMatch(/形は自由である/);
    expect(prompt).toMatch(/段落を分けてよい/);
    expect(prompt).toMatch(/見え消し線/);
  });
});

describe('数字と結論の扱い', () => {
  const character = loadCharacter('teo');
  const context = { ...character, day, recentSummaries: [] };

  it('渡された数字を数え直さないよう指示する', () => {
    // ウタが「あと10夜」と渡されて「あと九の夜」と書いた回の反省。
    const prompt = buildDiarySystemPrompt(context);
    expect(prompt).toMatch(/渡された数字は、そのまま使う/);
    expect(prompt).toMatch(/自分で数え直さない/);
  });

  it('推測を結論として書かないよう指示する', () => {
    // テオが「この座金が証明している」と書き切った回の反省。
    const prompt = buildDiarySystemPrompt(context);
    expect(prompt).toMatch(/推測を結論として書かない/);
    expect(prompt).toMatch(/疑いは疑いのまま/);
  });
});
