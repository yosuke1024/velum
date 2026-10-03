import { storyBodyPath, storyManifestPath } from '../lib/paths.js';
import { exists, writeText } from '../lib/storage.js';
import {
  StoryManifestSchema,
  storyEpisodeId,
  type StoryFormat,
  type StoryGeneration,
  type StoryManifest,
  type StoryPlan,
} from '../schemas/story.js';
import type { Bilingual } from '../lib/bilingual.js';
import type { CharacterId } from '../schemas/world.js';
import { buildStoryContext, describeStoryContext, type StoryContext } from './context.js';
import { gateEpisodeEn, gateEpisodeJa } from './gate.js';
import { resolveDeps, storyModel, writeManifestFile, type StoryDeps } from './plan.js';
import {
  buildEpisodeEnSystemPrompt,
  buildEpisodeEnUserPrompt,
  buildEpisodeJaSystemPrompt,
  buildEpisodeJaUserPrompt,
  STORY_EPISODE_EN_RESPONSE_SCHEMA,
  STORY_EPISODE_JA_RESPONSE_SCHEMA,
  STORY_WRITE_PROMPT_VERSION,
  StoryEpisodeEnResponseSchema,
  StoryEpisodeJaResponseSchema,
} from './prompt.js';

/**
 * 本文の下書き（story:write）。
 *
 * 計画（plan.yaml）の各話について、日本語版を書かせ、それを渡して英語版を書かせる。
 * 本文は characters/<id>/stories/s<NN>/e<NN>.ja.md / .en.md へ書く。
 *
 * **生成 ≠ 公開。** 書かれた話は必ず draft になる。reviewed だった話を書き直せば draft へ戻し
 * （本文が変わったのに「読んだ」ままにしない）、published の話は書き直さない——--force でも。
 * 公開済みの話をすり替える経路を、ここには作らない。公開を戻すのは人間が台帳の status を
 * 動かす仕事で、その上で書き直す。
 *
 * 前の話の**本文**は次の話のプロンプトへ渡さない（目的と題だけ）。本文を再入力すると、
 * 話どうしが自己模倣して同じ形へ収束する（日記の最近の要約と同じ判断）。
 *
 * 題と形式の正:
 *   - plan.yaml は、本文を書くまでの直せる計画。manifest.yaml に題・形式があれば、そちらが優先される。
 *   - 形式は manifest.format ?? plan.format。題は、manifest に題があればそれで固定
 *     （生成の題は捨て、題のゲートも見ない）。無ければ plan の working_title を「仮題」として渡し、
 *     書いたあとの題で manifest の title を埋める。
 *   - plan と manifest が食い違う話は、生成の前に注意を出す（エラーにはしない）。
 *
 * 失敗の扱い:
 *   - ゲート違反  その話だけ破棄（何も書かない）。次の話へ進み、最後に失敗として返す。
 *   - LLM のエラー  全体を止める（鍵の不備などは次の話でも同じになる）。書けた話は
 *                   すでにディスクにあるので、再実行は本文の無い話から続きを書く。
 */

export type WriteStoryOptions = {
  characterId: CharacterId;
  season: number;
  /** この1話だけ書く。省略すると、本文（ja か en）の無い話すべて */
  episode?: number;
  /** 本文がある話を書き直す（--episode と組み合わせる） */
  force?: boolean;
  dryRun?: boolean;
};

export type WriteOutcome =
  | { status: 'dry-run'; target: number | null }
  | {
      status: 'done';
      written: number[];
      skipped: number[];
      /** reviewed から draft へ戻した話 */
      demoted: number[];
      failed: Array<{ order: number; violations: string[] }>;
    };

export const WRITE_DRY_RUN_NOTICE = '--dry-run のため、本文は生成しません。';

// ── 台帳の更新 ─────────────────────────────────────────────

/**
 * 本文を書いたあとの台帳。純関数で、入力は書き換えない。
 *
 *   - status は draft に固める（reviewed なら demoted を立てる。published は書き直さない）。
 *   - title は**無いときだけ**生成した題で埋める。人間が決めた題は変えない。
 *   - format は無いときだけ、本文を書いた形式（manifest.format ?? plan.format）で埋める。
 *   - generation は毎回、最後に書いたときの記録で置き換える。
 */
export function applyEpisodeWrite(
  manifest: StoryManifest,
  order: number,
  update: { title: Bilingual; format: StoryFormat; generation: StoryGeneration },
): { manifest: StoryManifest; demoted: boolean } {
  const next = structuredClone(manifest);
  const episode = next.episodes.find((candidate) => candidate.order === order);
  if (!episode) throw new Error(`台帳に第${order}話がありません`);
  if (episode.status === 'published') {
    throw new Error(
      `${episode.id} は published です。published の話は書き直さない。先に manifest の status を戻すこと`,
    );
  }

  const demoted = episode.status === 'reviewed';
  episode.status = 'draft';
  if (episode.title === undefined) episode.title = { ...update.title };
  if (episode.format === undefined) episode.format = update.format;
  episode.generation = { ...update.generation };
  return { manifest: next, demoted };
}

// ── 対象の決め方 ───────────────────────────────────────────

const hasBody = (
  characterId: CharacterId,
  season: number,
  order: number,
  root: string | undefined,
  lang: 'ja' | 'en',
) => exists(storyBodyPath(characterId, season, order, lang, root));

/**
 * 書く話を決める。ここで落とす違反は、1話も生成しないうちに知らせる（途中まで書いて止まらない）。
 */
function chooseTargets(
  options: WriteStoryOptions,
  context: StoryContext,
  root: string | undefined,
  log: (line: string) => void,
): { targets: number[]; skipped: number[] } {
  const { characterId, season } = options;
  const plan = context.plan!;
  const manifest = context.manifest!;

  if (options.force && options.episode === undefined) {
    throw new Error(
      '--force は --episode と組み合わせて使います。季の全話を書き直すときも、1話ずつ指定してください' +
        '（本文の直しを、まとめて上書きしてしまわないため）。',
    );
  }

  const skipped: number[] = [];
  let targets: number[];

  if (options.episode !== undefined) {
    const order = options.episode;
    if (!plan.episodes.some((episode) => episode.order === order)) {
      throw new Error(`plan.yaml に第${order}話がありません（全 ${plan.episodes.length} 話）`);
    }
    const both =
      hasBody(characterId, season, order, root, 'ja') &&
      hasBody(characterId, season, order, root, 'en');
    if (both && !options.force) {
      log(`  第${order}話はすでに本文があります。書き直すには --force を付けてください。`);
      skipped.push(order);
      targets = [];
    } else {
      targets = [order];
    }
  } else {
    targets = plan.episodes
      .filter(
        (episode) =>
          !hasBody(characterId, season, episode.order, root, 'ja') ||
          !hasBody(characterId, season, episode.order, root, 'en'),
      )
      .map((episode) => episode.order);
  }

  // 台帳にある話だけを書く。published は、--force でも書き直さない。
  for (const order of targets) {
    const episode = manifest.episodes.find((candidate) => candidate.order === order);
    if (!episode) {
      throw new Error(
        `manifest.yaml に第${order}話がありません。台帳に話を足してください` +
          '（plan.yaml へ手で話を足したときは、manifest.yaml にも同じ order の話が要ります）',
      );
    }
    if (episode.status === 'published') {
      throw new Error(
        `${episode.id} は published です。published の話は書き直さない。先に manifest の status を戻すこと`,
      );
    }
  }

  return { targets, skipped };
}

// ── plan と manifest の食い違い ────────────────────────────

/**
 * 書く話のうち、plan.yaml と manifest.yaml で format か題が食い違うものへの注意。
 *
 * 食い違いは manifest に値があるとき（かつ plan と違うとき）だけ。manifest が空なら plan の値が
 * 使われるので、食い違いではない。manifest が優先されるのに、plan.yaml を直した人は気づかない——
 * だから、黙って無視せず、生成の前に知らせる（エラーにはしない。人間が manifest に書いた値が正）。
 */
export function planManifestDisagreements(
  plan: StoryPlan,
  manifest: StoryManifest,
  orders: readonly number[],
): string[] {
  const lines: string[] = [];
  const tail = 'manifest が優先されます。直すなら manifest.yaml で。';
  for (const order of orders) {
    const planned = plan.episodes.find((episode) => episode.order === order);
    const recorded = manifest.episodes.find((episode) => episode.order === order);
    if (!planned || !recorded) continue;

    if (recorded.format !== undefined && recorded.format !== planned.format) {
      lines.push(
        `第${order}話: manifest.yaml の format（${recorded.format}）が plan.yaml（${planned.format}）と違います。${tail}`,
      );
    }
    if (
      recorded.title !== undefined &&
      (recorded.title.ja !== planned.working_title.ja || recorded.title.en !== planned.working_title.en)
    ) {
      lines.push(
        `第${order}話: manifest.yaml の title（${recorded.title.ja} / ${recorded.title.en}）が` +
          ` plan.yaml の working_title（${planned.working_title.ja} / ${planned.working_title.en}）と違います。${tail}`,
      );
    }
  }
  return lines;
}

// ── 書く ───────────────────────────────────────────────────

export async function writeEpisodes(
  options: WriteStoryOptions,
  deps: StoryDeps = {},
): Promise<WriteOutcome> {
  const { generate, now, root, log, warn } = resolveDeps(deps);
  const { characterId, season } = options;

  const context = buildStoryContext(characterId, season, { root });
  if (!context.plan) {
    throw new Error(
      `plan.yaml がありません（${context.seriesId}）。先に次を実行してください:\n\n` +
        `    npm run story:plan -- --character ${characterId} --season ${season}\n`,
    );
  }
  if (!context.manifest) {
    throw new Error(
      `manifest.yaml がありません（${context.seriesId}）。story:plan が計画と一緒に作ります`,
    );
  }

  log(`${context.profile.name} — ${context.seriesId} の本文`);
  for (const line of describeStoryContext(context)) log(`  ${line}`);

  const { targets, skipped } = chooseTargets(options, context, root, log);

  // 生成の前に、plan.yaml と manifest.yaml の食い違いを知らせる（manifest が優先される）。
  for (const line of planManifestDisagreements(context.plan, context.manifest, targets)) warn(line);

  if (options.dryRun) {
    const first = targets[0];
    if (first === undefined) {
      log('\n  書く話がありません（本文はそろっています）。');
    } else {
      log(`\n  対象: 第${first}話（${targets.length > 1 ? `ほか ${targets.length - 1} 話を続けて書く` : 'この1話'}）`);
      log('\n===== 日本語版 system =====');
      log(buildEpisodeJaSystemPrompt(context));
      log('\n===== 日本語版 user =====');
      log(buildEpisodeJaUserPrompt(context, first));
      log('\n===== 英語版 system =====');
      log(buildEpisodeEnSystemPrompt(context));
      log('\n===== 英語版 user（日本語版は生成後に入る） =====');
      const fixed = context.manifest.episodes.find((episode) => episode.order === first)?.title;
      log(
        buildEpisodeEnUserPrompt(
          context,
          first,
          {
            title: fixed?.ja ?? '（ここに日本語版の題が入る）',
            body: '（ここに日本語版の本文が入る）',
          },
          { fixedTitleEn: fixed?.en },
        ),
      );
    }
    log('');
    log(WRITE_DRY_RUN_NOTICE);
    return { status: 'dry-run', target: first ?? null };
  }

  if (targets.length === 0) {
    log('\n  書く話がありません。');
    return { status: 'done', written: [], skipped, demoted: [], failed: [] };
  }

  const manifestFile = storyManifestPath(characterId, season, root);
  let manifest = context.manifest;
  const written: number[] = [];
  const demoted: number[] = [];
  const failed: Array<{ order: number; violations: string[] }> = [];

  for (const order of targets) {
    // 直前の話で埋まった題を、次の話のプロンプトに反映するため、台帳は更新した版で渡す。
    const current: StoryContext = { ...context, manifest };
    const planned = context.plan.episodes.find((episode) => episode.order === order)!;
    const manifestEpisode = manifest.episodes.find((episode) => episode.order === order)!;
    const fixedTitle = manifestEpisode.title;
    const format = manifestEpisode.format ?? planned.format;

    log(`\n  第${order}話 ${format}: ${planned.purpose}`);

    // 日本語版
    log('    日本語版を書かせています…');
    const ja = await generate(
      {
        system: buildEpisodeJaSystemPrompt(current),
        user: buildEpisodeJaUserPrompt(current, order),
        responseSchema: STORY_EPISODE_JA_RESPONSE_SCHEMA,
        model: storyModel(),
      },
      StoryEpisodeJaResponseSchema,
    );
    const jaVerdict = gateEpisodeJa(ja.data, { titleFixed: fixedTitle !== undefined });
    if (!jaVerdict.ok) {
      warn(`    ✗ 第${order}話（日本語版）を、構造ゲートの違反により破棄しました:`);
      for (const violation of jaVerdict.violations) warn(`        ${violation}`);
      failed.push({ order, violations: jaVerdict.violations });
      continue;
    }
    const titleJa = fixedTitle?.ja ?? jaVerdict.response.title_ja;

    // 英語版（完成した日本語版を渡す。直訳ではなく、同じ人物が英語で語る文章にさせる）
    log('    英語版を書かせています…');
    const en = await generate(
      {
        system: buildEpisodeEnSystemPrompt(current),
        user: buildEpisodeEnUserPrompt(
          current,
          order,
          { title: titleJa, body: jaVerdict.response.body_ja },
          {
            fixedTitleEn: fixedTitle?.en,
            // 日本語版が仮題のまま題にしたときだけ、対になる英語の仮題を渡す。
            workingTitleEn: titleJa === planned.working_title.ja ? planned.working_title.en : undefined,
          },
        ),
        responseSchema: STORY_EPISODE_EN_RESPONSE_SCHEMA,
        model: storyModel(),
      },
      StoryEpisodeEnResponseSchema,
    );
    const enVerdict = gateEpisodeEn(en.data, { titleFixed: fixedTitle !== undefined });
    if (!enVerdict.ok) {
      warn(`    ✗ 第${order}話（英語版）を、構造ゲートの違反により破棄しました（日本語版も書きません）:`);
      for (const violation of enVerdict.violations) warn(`        ${violation}`);
      failed.push({ order, violations: enVerdict.violations });
      continue;
    }
    const titleEn = fixedTitle?.en ?? enVerdict.response.title_en;

    // 台帳を先に書く。本文が先だと、書き直しで reviewed のまま本文だけが変わった状態が
    // 途中の失敗で残りうる。台帳が先なら、失敗しても draft へ戻っているだけで害がない。
    const applied = applyEpisodeWrite(manifest, order, {
      title: { ja: titleJa, en: titleEn },
      format,
      generation: {
        model: ja.model === en.model ? ja.model : `${ja.model} / ${en.model}`,
        prompt_version: STORY_WRITE_PROMPT_VERSION,
        generated_at: now(),
      },
    });
    manifest = StoryManifestSchema.parse(applied.manifest);
    writeManifestFile(manifestFile, manifest);

    writeText(storyBodyPath(characterId, season, order, 'ja', root), jaVerdict.response.body_ja);
    writeText(storyBodyPath(characterId, season, order, 'en', root), enVerdict.response.body_en);

    written.push(order);
    log(
      `    ✓ ${storyEpisodeId(context.seriesId, order)}「${titleJa}」を draft で書きました` +
        `（日本語 ${[...jaVerdict.response.body_ja].length} 文字）`,
    );
    if (applied.demoted) {
      demoted.push(order);
      log('      reviewed だったので、本文が変わったため draft へ戻しました。読み直してから status を進めてください。');
    }
  }

  if (failed.length > 0) {
    warn(
      `\n  ${failed.length} 話が破棄されました（第${failed.map((f) => f.order).join('・')}話）。` +
        'もう一度実行すれば、本文の無い話だけを引き直せます。',
    );
  }
  if (written.length > 0) {
    log('\n  本文は draft です。読んで直してから、manifest の status を進めてください。');
  }

  return { status: 'done', written, skipped, demoted, failed };
}
