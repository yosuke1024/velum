import { generateJson } from '../lib/gemini.js';
import { charPath, diaryPath, entryPath, eventPath, failurePath } from '../lib/paths.js';
import { writeYaml, writeJson, writeText } from '../lib/storage.js';
import { DiaryResponseSchema } from '../schemas/patch.js';
import { DiaryEntrySchema, DiaryEventSchema } from '../schemas/diary.js';
import { FailureSchema, type Tick } from '../schemas/tick.js';
import { buildDiaryContext } from './context.js';
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

function frontMatter(fields: Record<string, string>): string {
  const lines = Object.entries(fields).map(
    ([key, value]) => `${key}: ${JSON.stringify(value)}`,
  );
  return ['---', ...lines, '---', ''].join('\n');
}

export async function generateDiary(
  tick: Tick,
  recentSummaries: string[] = [],
): Promise<DiaryOutcome> {
  const context = buildDiaryContext(tick, recentSummaries);
  const { profile } = context;

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
    writeJson(
      failurePath(tick.date, 'diary'),
      FailureSchema.parse({
        date: tick.date,
        era: tick.era,
        protagonist: tick.protagonist,
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
    tick.date,
  );

  const id = profile.id;

  writeYaml(charPath(id, 'current-state.yaml'), trimWorkingSets(result.state));
  writeYaml(charPath(id, 'relationships.yaml'), result.relationships);
  writeYaml(charPath(id, 'memories.yaml'), result.memories);
  writeYaml(charPath(id, 'canon.yaml'), result.canon);

  const meta = {
    date: tick.date,
    era: tick.era,
    protagonist: id,
    title: response.title,
    mood: response.mood,
  };

  writeText(
    diaryPath(id, tick.date, 'ja'),
    `${frontMatter({ ...meta, lang: 'ja' })}${response.body_ja.trim()}\n`,
  );
  writeText(
    diaryPath(id, tick.date, 'en'),
    `${frontMatter({ ...meta, lang: 'en' })}${response.body_en.trim()}\n`,
  );

  writeJson(
    entryPath(id, tick.date),
    DiaryEntrySchema.parse({
      date: tick.date,
      era: tick.era,
      protagonist: id,
      title: response.title,
      quote: response.quote,
      mood: response.mood,
      rare_expression_used: response.rare_expression_used,
      tick_card: tick.card.id,
    }),
  );

  writeJson(
    eventPath(id, tick.date),
    DiaryEventSchema.parse({
      date: tick.date,
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

  return { ok: true, title: response.title, truncated: verdict.truncated };
}
