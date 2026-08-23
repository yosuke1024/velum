import { generateJson } from '../lib/gemini.js';
import { formatWorldDate } from '../lib/calendar.js';
import { charPath, diaryPath, entryPath, eventPath, failurePath } from '../lib/paths.js';
import { writeYaml, writeJson, writeText } from '../lib/storage.js';
import { DiaryResponseSchema } from '../schemas/patch.js';
import { DiaryEntrySchema, DiaryEventSchema } from '../schemas/diary.js';
import { FailureSchema } from '../schemas/season.js';
import { buildDiaryContext, type Day } from './context.js';
import {
  buildDiarySystemPrompt,
  buildDiaryUserPrompt,
  DIARY_RESPONSE_SCHEMA,
  DIARY_PROMPT_VERSION,
} from './prompt.js';
import { gate } from './gate.js';
import { applyPatches, trimWorkingSets } from './apply.js';

export type DiaryOutcome =
  | { ok: true; title: string; truncated: string[] }
  | { ok: false; violations: string[] };

function frontMatter(fields: Record<string, string | number>): string {
  const lines = Object.entries(fields).map(
    ([key, value]) => `${key}: ${JSON.stringify(value)}`,
  );
  return ['---', ...lines, '---', ''].join('\n');
}

export async function generateDiary(
  day: Day,
  recentSummaries: string[] = [],
): Promise<DiaryOutcome> {
  const context = buildDiaryContext(day, recentSummaries);
  const { profile } = context;
  const { turn } = day;

  const { data, model } = await generateJson(
    {
      system: buildDiarySystemPrompt(context),
      user: buildDiaryUserPrompt(context),
      responseSchema: DIARY_RESPONSE_SCHEMA,
    },
    DiaryResponseSchema,
  );

  const verdict = gate(data, context.state, context.relationships, profile.id);

  if (!verdict.ok) {
    // 欠けた日は隠さない。状態ファイルにも日記にも何も書かず、失敗だけを残す。
    // 季の計画は消さないので、同じ日をやり直せば同じ出来事から書き直せる。
    writeJson(
      failurePath(day.date, 'diary'),
      FailureSchema.parse({
        date: day.date,
        era: turn.era,
        protagonist: turn.protagonist,
        season: turn.season,
        episode: turn.episode,
        stage: 'diary',
        reason: '構造ゲートの違反により破棄',
        violations: verdict.violations,
        recorded_at: new Date().toISOString(),
      }),
    );
    return { ok: false, violations: verdict.violations };
  }

  const response = verdict.response;
  const result = applyPatches(
    response,
    {
      state: context.state,
      relationships: context.relationships,
      memories: context.memories,
      canon: context.canon,
    },
    day.date,
  );

  const id = profile.id;

  writeYaml(charPath(id, 'current-state.yaml'), trimWorkingSets(result.state));
  writeYaml(charPath(id, 'relationships.yaml'), result.relationships);
  writeYaml(charPath(id, 'memories.yaml'), result.memories);
  writeYaml(charPath(id, 'canon.yaml'), result.canon);

  const meta = {
    date: day.date,
    era: turn.era,
    protagonist: id,
    season: turn.season,
    episode: turn.episode,
    beat: day.episode.beat,
    world_date: formatWorldDate(day.worldYear, day.episode.world_date),
  };

  // 前書きの見出しも、そのファイルの言語で書く。英語の日記に日本語の
  // タイトルが載っていると、読む側にも、あとで読み直す側にも嘘になる。
  writeText(
    diaryPath(id, day.date, 'ja'),
    `${frontMatter({ ...meta, lang: 'ja', title: response.title_ja, mood: response.mood_ja })}${response.body_ja.trim()}\n`,
  );
  writeText(
    diaryPath(id, day.date, 'en'),
    `${frontMatter({ ...meta, lang: 'en', title: response.title_en, mood: response.mood_en })}${response.body_en.trim()}\n`,
  );

  writeJson(
    entryPath(id, day.date),
    DiaryEntrySchema.parse({
      date: day.date,
      era: turn.era,
      protagonist: id,
      season: turn.season,
      episode: turn.episode,
      beat: day.episode.beat,
      world_date: { year: day.worldYear, ...day.episode.world_date },
      title: { ja: response.title_ja, en: response.title_en },
      quote: { ja: response.quote_ja, en: response.quote_en },
      mood: { ja: response.mood_ja, en: response.mood_en },
      rare_expression_used: response.rare_expression_used,
    }),
  );

  writeJson(
    eventPath(id, day.date),
    DiaryEventSchema.parse({
      date: day.date,
      protagonist: id,
      applied: result.applied,
      truncated: verdict.truncated,
      generation: {
        model,
        prompt_version: DIARY_PROMPT_VERSION,
        generated_at: new Date().toISOString(),
      },
    }),
  );

  return { ok: true, title: response.title_ja, truncated: verdict.truncated };
}
