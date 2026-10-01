import { z } from 'zod';
import { generateJson } from '../lib/llm.js';
import { readYaml, writeYaml, writeText, exists } from '../lib/storage.js';
import { ROOT } from '../lib/paths.js';
import {
  StoryPlanSchema,
  StoryManifestSchema,
  type StoryManifest,
  type StoryFormat,
} from '../schemas/story.js';
import type { CharacterId } from '../schemas/world.js';
import { buildStoryContext } from './context.js';
import {
  buildStoryWriteSystemPrompt,
  buildStoryWriteUserPrompt,
  STORY_WRITE_RESPONSE_SCHEMA,
  STORY_TEXT_LIMITS,
} from './prompt.js';
import { storyPaths } from './paths.js';
import type { Generate } from './plan.js';

const WriteResponseSchema = z.object({
  title_ja: z.string().min(1),
  title_en: z.string().min(1),
  body_ja: z.string().min(1),
  body_en: z.string().min(1),
  summary_ja: z.string().min(1),
  summary_en: z.string().min(1),
});

export type WriteResponse = z.infer<typeof WriteResponseSchema>;

const JAPANESE = /[ぁ-んァ-ヶ一-龠]/;

/**
 * 構造ゲート。直すのは「形」だけで、面白さは見ない——それは人間のレビューの仕事
 * （docs/stories.md §7）。落ちた回は書かれず、理由だけが返る。
 */
export function storyGate(response: WriteResponse): string[] {
  const violations: string[] = [];
  const bodyJa = [...response.body_ja.trim()].length;
  if (bodyJa < STORY_TEXT_LIMITS.bodyMinJa || bodyJa > STORY_TEXT_LIMITS.bodyMaxJa) {
    violations.push(
      `本文（日本語）が ${bodyJa} 文字（${STORY_TEXT_LIMITS.bodyMinJa}〜${STORY_TEXT_LIMITS.bodyMaxJa}）`,
    );
  }
  const titleJa = [...response.title_ja.trim()].length;
  if (titleJa < STORY_TEXT_LIMITS.titleMin || titleJa > STORY_TEXT_LIMITS.titleMax) {
    violations.push(`タイトル（日本語）が ${titleJa} 文字（${STORY_TEXT_LIMITS.titleMin}〜${STORY_TEXT_LIMITS.titleMax}）`);
  }
  if ([...response.title_en.trim()].length > STORY_TEXT_LIMITS.titleMaxEn) {
    violations.push(`タイトル（英語）が ${STORY_TEXT_LIMITS.titleMaxEn} 文字を超えています`);
  }
  if (!JAPANESE.test(response.body_ja)) violations.push('本文（日本語）に日本語がありません');
  if (JAPANESE.test(response.body_en)) violations.push('本文（英語）に日本語の文字が残っています');
  if (JAPANESE.test(response.title_en)) violations.push('タイトル（英語）に日本語の文字が残っています');
  if (/^#{1,6}\s|\*\*/m.test(response.body_ja) || /^#{1,6}\s|\*\*/m.test(response.body_en)) {
    violations.push('本文に Markdown の見出しや強調があります');
  }
  return violations;
}

export type WriteStoryOptions = {
  characterId: CharacterId;
  season: number;
  order: number;
  root?: string;
  generate?: Generate;
  /** 本文がすでにあっても書き直す。published の話は force でも書き直せない。 */
  force?: boolean;
};

export type WriteStoryOutcome =
  | { ok: true; title: string; skipped?: false }
  | { ok: true; title: string; skipped: true }
  | { ok: false; violations: string[] };

/** 本文の整形。段落の空行区切りは保ち、3行以上の空行だけ詰める。 */
const normalizeBody = (text: string): string => text.trim().replace(/\n{3,}/g, '\n\n');

/**
 * 1話を書く。plan.yaml の purpose / situation から本文（ja / en）を生成し、
 * manifest の title / summary を埋める。**status は draft のまま。** 公開は人間が
 * manifest.yaml を直して進める。
 */
export async function writeStoryEpisode(options: WriteStoryOptions): Promise<WriteStoryOutcome> {
  const root = options.root ?? ROOT;
  const generate = options.generate ?? generateJson;
  const paths = storyPaths(options.characterId, options.season, root);

  if (!exists(paths.plan)) {
    throw new Error(`計画がありません: ${paths.plan}（先に npm run story:plan を実行してください）`);
  }
  const plan = readYaml(paths.plan, StoryPlanSchema);
  const manifest: StoryManifest = exists(paths.manifest)
    ? readYaml(paths.manifest, StoryManifestSchema)
    : (() => {
        throw new Error(`manifest がありません: ${paths.manifest}`);
      })();

  const planned = plan.episodes.find((e) => e.order === options.order);
  if (!planned) throw new Error(`第${options.season}季に第${options.order}話の計画がありません`);
  const listed = manifest.episodes.find((e) => e.order === options.order);
  if (!listed) throw new Error(`manifest に第${options.order}話がありません（story:plan で同期してください）`);

  if (listed.status === 'published') {
    throw new Error(`第${options.order}話は published です。書き直すなら、先に manifest.yaml の status を戻してください`);
  }
  if (!options.force && exists(paths.episode(options.order, 'ja'))) {
    return { ok: true, title: listed.title?.ja ?? planned.working_title ?? '', skipped: true };
  }

  const context = buildStoryContext(options.characterId, root);
  const format: StoryFormat = listed.format ?? planned.format;

  // これまでの話。本文は渡さず、要約だけ渡す（日記と同じ理由——再入力は自己模倣を招く）。
  const previous = manifest.episodes
    .filter((e) => e.order < options.order)
    .map((e) => {
      const planOf = plan.episodes.find((p) => p.order === e.order);
      return {
        order: e.order,
        title: e.title?.ja ?? null,
        summary: e.summary?.ja ?? planOf?.purpose ?? '',
      };
    });

  const { data } = await generate(
    {
      system: buildStoryWriteSystemPrompt(context, format),
      user: buildStoryWriteUserPrompt(context, plan, options.order, previous),
      responseSchema: STORY_WRITE_RESPONSE_SCHEMA,
    },
    WriteResponseSchema,
  );

  const violations = storyGate(data);
  if (violations.length) return { ok: false, violations };

  writeText(paths.episode(options.order, 'ja'), normalizeBody(data.body_ja));
  writeText(paths.episode(options.order, 'en'), normalizeBody(data.body_en));

  const updated = StoryManifestSchema.parse({
    ...manifest,
    episodes: manifest.episodes.map((e) =>
      e.order === options.order
        ? {
            ...e,
            // 書き直したら草稿に戻る。reviewed は「この本文を読んだ」の印なので、本文が変われば無効。
            status: 'draft' as const,
            title: { ja: data.title_ja.trim(), en: data.title_en.trim() },
            summary: { ja: data.summary_ja.trim(), en: data.summary_en.trim() },
            format,
          }
        : e,
    ),
  });
  writeYaml(paths.manifest, updated);

  return { ok: true, title: data.title_ja.trim() };
}
