import { STORY_WRITE_LIMITS } from '../schemas/limits.js';
import { STORY_EPISODE_LIMITS, STORY_FORMATS } from '../schemas/story.js';
import { secretLeaksIn } from '../lib/secrets.js';
import { japaneseRatio, normalizeStoryBody, storyBodyProblems } from './body.js';
import type { StoryContext } from './context.js';
import type {
  StoryPlanResponse,
  StoryEpisodeJaResponse,
  StoryEpisodeEnResponse,
} from './prompt.js';

export type StoryGateResult<T> =
  | { ok: true; response: T }
  | { ok: false; violations: string[] };

/**
 * Story 生成の構造ゲート。
 *
 * 日記のゲート（src/diary/gate.ts）と同じ規律で、**違反はすべて破棄（fatal）**——
 * 切り詰めも自動修復もしない。出力は公開リポジトリへ届く。尻切れの本文や秘密の混ざった一文を
 * 「それらしく見える形」に直して通せば、壊れたプロンプトが人間のレビューの裏に隠れる。
 * 欠けた1話は目に見える。破棄しても失われるものはない（本文はまだ書かれておらず、
 * 同じ話を引き直せる）。
 *
 * 見るのは**形が壊れていないか**だけである。面白いか・人物らしいかは人間のレビューの仕事で、
 * ここには持たない（禁止を積まない、というオーナーの方針）。例外は世界を壊す次の2つ:
 * 秘密の混入と、言語の取り違え。
 *
 * 本文は normalizeStoryBody を通した形に揃えて返す（行末の空白・3連続以上の改行・前後の空白）。
 * これは正規形への整形であって、内容の修復ではない。長さと書式の判定は整形後の本文で行う。
 */

/** 日本語の文として読める割合の下限（本文と同じ。src/story/body.ts の storyBodyProblems） */
const JAPANESE_MIN_RATIO = 0.3;

const codePoints = (text: string) => [...text].length;
const wordCount = (text: string) => text.split(/\s+/).filter((word) => word.length > 0).length;

/** 題として読める形か。1行で、空でなく、上限以内で、その言語であること。 */
function titleProblems(title: string, lang: 'ja' | 'en', label: string): string[] {
  const problems: string[] = [];
  if (title.trim().length === 0) {
    problems.push(`${label} が空です`);
    return problems;
  }
  if (/[\r\n]/.test(title)) problems.push(`${label} が複数行です（題は1行）`);

  const max = lang === 'ja' ? STORY_WRITE_LIMITS.titleJaMaxChars : STORY_WRITE_LIMITS.titleEnMaxChars;
  const length = codePoints(title);
  if (length > max) problems.push(`${label} が ${length} 文字です（上限 ${max}）`);

  if (lang === 'ja' && japaneseRatio(title) < JAPANESE_MIN_RATIO) {
    problems.push(`${label} が日本語に見えません`);
  }
  if (lang === 'en' && japaneseRatio(title) > 0) {
    problems.push(`${label} に日本語が混じっています`);
  }
  return problems;
}

/** 計画の文（日本語で書かれるべき欄）。空でなく、日本語であること。 */
function planTextProblems(text: string, label: string): string[] {
  if (text.trim().length === 0) return [`${label} が空です`];
  if (japaneseRatio(text) < JAPANESE_MIN_RATIO) {
    return [`${label} が日本語に見えません`];
  }
  return [];
}

/**
 * 秘密の混入を検査する。
 *
 * 照合するのは**デコードした文字列そのもの**である。JSON に直してから照合すると、
 * 折り返された秘密の一文は改行が「\\n」の2文字になって、空白を除いても一致しなくなる
 * （src/lib/secrets.ts の既知の弱点）。ここは生成された文字列を直接渡すので、
 * 改行や空白の入り方に左右されない。
 *
 * **違反の文面に断片そのものは書かない。** 出力は Actions のログにも残る。
 * 秘密を隠すためのゲートが、秘密をログへ書き出しては意味がない。同じ理由で、
 * 生成された文の一部を引用する違反文も作らない（題や本文の抜粋をログへ流さない）。
 */
function secretViolations(fields: Array<[label: string, text: string]>): string[] {
  const present = fields.filter(([, text]) => text.length > 0);
  // 全部をつないで1回だけ照合する（秘密の一覧は毎回ファイルから読むので、欄ごとには回さない）。
  if (secretLeaksIn(present.map(([, text]) => text).join('\n')).length === 0) return [];

  const violations: string[] = [];
  for (const [label, text] of present) {
    const owners = [...new Set(secretLeaksIn(text).map((leak) => leak.owner))];
    for (const owner of owners) {
      violations.push(
        `${label} に、隠されている文（${owner}）の断片が含まれている`,
      );
    }
  }
  // 欄をまたいだ偶然の一致。見逃すより落とすほうがよい。
  if (violations.length === 0) {
    violations.push('生成された文の全体に、隠されている文の断片が含まれている（欄をまたいでいる）');
  }
  return violations;
}

const fail = (violations: string[]): { ok: false; violations: string[] } => ({
  ok: false,
  violations,
});

// ── 計画 ───────────────────────────────────────────────────

/**
 * 計画の応答を検査する。
 *
 * 話数・形式・出る人の id・題の長さ・言語・秘密。話の並び（order）と構造はコードが刻むので、
 * ここでは応答の「中身」だけを見る。
 */
export function gatePlan(
  response: StoryPlanResponse,
  context: StoryContext,
  requestedCount: number,
): StoryGateResult<StoryPlanResponse> {
  const violations: string[] = [];

  if (
    !Number.isInteger(requestedCount) ||
    requestedCount < STORY_EPISODE_LIMITS.min ||
    requestedCount > STORY_EPISODE_LIMITS.max
  ) {
    violations.push(
      `話数の指定が ${requestedCount} です（${STORY_EPISODE_LIMITS.min}〜${STORY_EPISODE_LIMITS.max}）`,
    );
  }
  if (response.episodes.length !== requestedCount) {
    violations.push(
      `episodes が ${response.episodes.length} 件です（ちょうど ${requestedCount} 件であること）`,
    );
  }

  violations.push(...titleProblems(response.title_ja, 'ja', '季の題（日本語）'));
  violations.push(...titleProblems(response.title_en, 'en', '季の題（英語）'));
  violations.push(...planTextProblems(response.logline, 'logline'));
  violations.push(...planTextProblems(response.arc_start, 'arc_start'));
  violations.push(...planTextProblems(response.arc_change, 'arc_change'));
  violations.push(...planTextProblems(response.arc_end, 'arc_end'));

  const known = new Set(context.people.map((person) => person.id));
  const idProblems = (ids: string[], label: string): string[] => {
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (!known.has(id)) {
        problems.push(
          `${label} の id「${id}」が「周りの人」にない（${[...known].join(' / ')} のいずれか）`,
        );
      } else if (seen.has(id)) {
        problems.push(`${label} に同じ id「${id}」が2回ある`);
      }
      seen.add(id);
    }
    return problems;
  };

  if (response.focus.length === 0) violations.push('focus が空です（周りの人の id を1〜2個）');
  violations.push(...idProblems(response.focus, 'focus'));

  response.episodes.forEach((episode, index) => {
    const label = `第${index + 1}話`;
    violations.push(...planTextProblems(episode.purpose, `${label}の purpose`));
    violations.push(...planTextProblems(episode.situation, `${label}の situation`));
    if (!(STORY_FORMATS as readonly string[]).includes(episode.format)) {
      violations.push(
        `${label}の format「${episode.format}」が選択肢にない（${STORY_FORMATS.join(' / ')}）`,
      );
    }
    violations.push(...idProblems(episode.people, `${label}の people`));
    violations.push(...titleProblems(episode.working_title_ja, 'ja', `${label}の仮題（日本語）`));
    violations.push(...titleProblems(episode.working_title_en, 'en', `${label}の仮題（英語）`));
  });

  // 計画は人間が読む内部ファイルだが、公開リポジトリに置かれる。秘密の一文が混ざれば同じこと。
  const fields: Array<[string, string]> = [
    ['季の題（日本語）', response.title_ja],
    ['季の題（英語）', response.title_en],
    ['logline', response.logline],
    ['arc_start', response.arc_start],
    ['arc_change', response.arc_change],
    ['arc_end', response.arc_end],
  ];
  response.episodes.forEach((episode, index) => {
    const label = `第${index + 1}話`;
    fields.push(
      [`${label}の purpose`, episode.purpose],
      [`${label}の situation`, episode.situation],
      [`${label}の仮題（日本語）`, episode.working_title_ja],
      [`${label}の仮題（英語）`, episode.working_title_en],
    );
  });
  violations.push(...secretViolations(fields));

  return violations.length ? fail(violations) : { ok: true, response };
}

// ── 本文（日本語） ─────────────────────────────────────────

/**
 * 日本語版の応答を検査する。
 *
 * `titleFixed` は、台帳に人間が決めた題があるとき（その題がそのまま使われ、生成された題は
 * 捨てられる）。捨てる題を検査すると、人間が決めた長い題をモデルが写しただけで落ちる。
 */
export function gateEpisodeJa(
  response: StoryEpisodeJaResponse,
  options: { titleFixed?: boolean } = {},
): StoryGateResult<StoryEpisodeJaResponse> {
  const violations: string[] = [];
  const title = response.title_ja.trim();
  const body = normalizeStoryBody(response.body_ja);

  if (!options.titleFixed) violations.push(...titleProblems(title, 'ja', '題（日本語）'));

  violations.push(...storyBodyProblems(body, 'ja').map((problem) => `本文（日本語）: ${problem}`));
  if (body.length > 0) {
    const length = codePoints(body);
    if (length < STORY_WRITE_LIMITS.bodyJaMinChars) {
      violations.push(`本文（日本語）が ${length} 文字です（下限 ${STORY_WRITE_LIMITS.bodyJaMinChars}）`);
    }
    if (length > STORY_WRITE_LIMITS.bodyJaMaxChars) {
      violations.push(`本文（日本語）が ${length} 文字です（上限 ${STORY_WRITE_LIMITS.bodyJaMaxChars}）`);
    }
  }

  const fields: Array<[string, string]> = [['本文（日本語）', body]];
  if (!options.titleFixed) fields.push(['題（日本語）', title]);
  violations.push(...secretViolations(fields));

  return violations.length
    ? fail(violations)
    : { ok: true, response: { title_ja: title, body_ja: body } };
}

// ── 本文（英語） ───────────────────────────────────────────

export function gateEpisodeEn(
  response: StoryEpisodeEnResponse,
  options: { titleFixed?: boolean } = {},
): StoryGateResult<StoryEpisodeEnResponse> {
  const violations: string[] = [];
  const title = response.title_en.trim();
  const body = normalizeStoryBody(response.body_en);

  if (!options.titleFixed) violations.push(...titleProblems(title, 'en', '題（英語）'));

  violations.push(...storyBodyProblems(body, 'en').map((problem) => `本文（英語）: ${problem}`));
  if (body.length > 0) {
    const words = wordCount(body);
    if (words < STORY_WRITE_LIMITS.bodyEnMinWords) {
      violations.push(`本文（英語）が ${words} 語です（下限 ${STORY_WRITE_LIMITS.bodyEnMinWords}）`);
    }
    if (words > STORY_WRITE_LIMITS.bodyEnMaxWords) {
      violations.push(`本文（英語）が ${words} 語です（上限 ${STORY_WRITE_LIMITS.bodyEnMaxWords}）`);
    }
  }

  const fields: Array<[string, string]> = [['本文（英語）', body]];
  if (!options.titleFixed) fields.push(['題（英語）', title]);
  violations.push(...secretViolations(fields));

  return violations.length
    ? fail(violations)
    : { ok: true, response: { title_en: title, body_en: body } };
}
