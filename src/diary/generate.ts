import { generateJson } from '../lib/llm.js';
import { formatWorldDate } from '../lib/calendar.js';
import { charPath, diaryPath, entryPath, eventPath, failurePath } from '../lib/paths.js';
import { writeYaml, writeJson, writeText, exists, readJson } from '../lib/storage.js';
import { today } from '../lib/rotation.js';
import { DiaryResponseSchema } from '../schemas/patch.js';
import { DiaryEntrySchema, DiaryEventSchema } from '../schemas/diary.js';
import { FailureSchema } from '../schemas/season.js';
import { buildDiaryContext, type Day } from './context.js';
import { loadCharacterAsOf, readEventsAround } from './as-of.js';
import {
  buildDiarySystemPrompt,
  buildDiaryUserPrompt,
  DIARY_RESPONSE_SCHEMA,
  DIARY_PROMPT_VERSION,
} from './prompt.js';
import { gate } from './gate.js';
import { applyPatches, trimWorkingSets } from './apply.js';

export type DiaryOutcome =
  | { ok: true; title: string; truncated: string[]; backfilled: boolean }
  | { ok: false; violations: string[]; backfilled: boolean };

function frontMatter(fields: Record<string, string | number>): string {
  const lines = Object.entries(fields).map(
    ([key, value]) => `${key}: ${JSON.stringify(value)}`,
  );
  return ['---', ...lines, '---', ''].join('\n');
}

/**
 * 日記の段だけに使うモデル。
 *
 * 日記は製品そのものであり、季の計画（出来事の設計）とは求める質が違う。
 * VELUM_DIARY_MODEL が設定されていればそれを使い、無ければ generateJson の既定
 * （VELUM_MODEL → プロバイダの既定モデル）に落ちる。daily.yml は repo variable から渡すので、
 * 未設定なら空文字が来る——空は「未設定」として扱う。
 */
export function diaryModel(): string | undefined {
  const model = process.env.VELUM_DIARY_MODEL?.trim();
  return model ? model : undefined;
}

export async function generateDiary(
  day: Day,
  recentSummaries: string[] = [],
  options: {
    /** 直近の日記に定型の崩れがあれば false。省略時は許可。 */
    rareExpressionAllowed?: boolean;
    /**
     * 破棄された過去の日を、歴史としてだけ補う（docs/diary.md §9）。
     *
     * 人物はその日の朝の状態で書き（src/diary/as-of.ts）、状態ファイル・関係・記憶・
     * 人生の事実は一切書かない。書くのは日記・entries・events だけで、events には
     * 適用していない印が付く。失敗記録は消さずに、補った日を書き足す。
     */
    backfill?: boolean;
  } = {},
): Promise<DiaryOutcome> {
  const rareExpressionAllowed = options.rareExpressionAllowed ?? true;
  const backfill = options.backfill ?? false;
  const context = buildDiaryContext(
    day,
    recentSummaries,
    rareExpressionAllowed,
    backfill ? loadCharacterAsOf(day.turn.protagonist, day.date) : undefined,
  );
  const { profile } = context;
  const { turn } = day;

  const { data, model } = await generateJson(
    {
      system: buildDiarySystemPrompt(context),
      user: buildDiaryUserPrompt(context),
      responseSchema: DIARY_RESPONSE_SCHEMA,
      model: diaryModel(),
    },
    DiaryResponseSchema,
  );

  // プロンプトに書いた可否と同じ値で判定する。ずれれば、指示に従った日を失う。
  const verdict = gate(data, context.state, context.relationships, profile.id, {
    rareExpressionAllowed,
  });

  if (!verdict.ok) {
    // 補う試みが落ちたときは何も書かない。その日にはすでに元の失敗記録があり、
    // 上書きすれば最初に破棄された理由が消える。やり直しは同じ手順をもう一度回す。
    if (backfill) return { ok: false, violations: verdict.violations, backfilled: true };

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
    return { ok: false, violations: verdict.violations, backfilled: false };
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

  // 補うときは状態へ触れない。後の日がすでにその上に積まれている。
  if (!backfill) {
    writeYaml(charPath(id, 'current-state.yaml'), trimWorkingSets(result.state));
    writeYaml(charPath(id, 'relationships.yaml'), result.relationships);
    writeYaml(charPath(id, 'memories.yaml'), result.memories);
    writeYaml(charPath(id, 'canon.yaml'), result.canon);
  }

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
      ...(backfill && {
        backfill: {
          applied_to_state: false,
          filled_on: today(),
          state_as_of: readEventsAround(id, day.date).earlier.at(-1)?.date ?? null,
        },
      }),
    }),
  );

  // 失敗記録は消さない。一度破棄されたことも実験記録であり、補った日だけを書き足す。
  if (backfill && exists(failurePath(day.date, 'diary'))) {
    const failure = readJson(failurePath(day.date, 'diary'), FailureSchema);
    writeJson(failurePath(day.date, 'diary'), { ...failure, backfilled_on: today() });
  }

  return { ok: true, title: response.title_ja, truncated: verdict.truncated, backfilled: backfill };
}
