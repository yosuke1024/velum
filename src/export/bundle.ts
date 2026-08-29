import { readFileSync } from 'node:fs';
import { charPath, worldPath, seasonDir } from '../lib/paths.js';
import { readYaml, listDatedFiles, exists } from '../lib/storage.js';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ErasFileSchema,
  RotationFileSchema,
  CHARACTER_IDS,
  type EraId,
  type CharacterId,
} from '../schemas/world.js';
import {
  ProfileSchema,
  CanonSchema,
  RelationshipsSchema,
} from '../schemas/character.js';
import { DiaryEntrySchema, DiaryEventSchema } from '../schemas/diary.js';
import { SeasonPlanSchema, FailureSchema } from '../schemas/season.js';
import { oneLine } from '../compile/context.js';
import { both } from '../lib/bilingual.js';

/**
 * 公開サイトが読むデータの束。
 *
 * サイト（pixapps-landing）は velum のディレクトリ構造も YAML も知らない。
 * 知る必要もない——受け渡すのはこの JSON 1枚である。
 *
 * **本人が知らないことは、ここへ入れない。**
 *
 * profile.core.secret_unknown_to_self と relationships[].hidden_from_protagonist は
 * この型のどこにも現れない。日記プロンプト（src/diary/context.ts）と
 * Persona Snapshot（src/compile/context.ts）と同じ規律だが、守る対象が最も広い——
 * ここから漏れたものは、そのまま公開ページに描画される。
 *
 * 読者だけが日記の行間から気づく構造は、サイトがそれを表示しないことで守られる。
 * 除外は型で担保し、tests/unit/bundle.test.ts が出来上がりを照合する。
 */
export type SiteBundle = ReturnType<typeof buildBundle>;

/** 日記本文の front matter は `key: <JSON>` の行で書かれている（src/diary/generate.ts）。 */
function splitFrontMatter(markdown: string): { meta: Record<string, unknown>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(markdown);
  if (!match) return { meta: {}, body: markdown.trim() };

  const meta: Record<string, unknown> = {};
  for (const line of (match[1] ?? '').split('\n')) {
    const at = line.indexOf(': ');
    if (at === -1) continue;
    try {
      meta[line.slice(0, at)] = JSON.parse(line.slice(at + 2));
    } catch {
      meta[line.slice(0, at)] = line.slice(at + 2);
    }
  }
  return { meta, body: (match[2] ?? '').trim() };
}

/** 日記本文を読む。サイトの束と feed（src/export/feed.ts）の両方が使う。 */
export function readDiaryBody(id: string, date: string, lang: 'ja' | 'en'): string | null {
  const [year, month] = date.split('-');
  const path = join(charPath(id, 'diaries'), year ?? '', month ?? '', `${date}.${lang}.md`);
  if (!existsSync(path)) return null;
  return splitFrontMatter(readFileSync(path, 'utf8')).body;
}

/** 5人ぶんの人物像。芯・声・物の見方と、周りの人。秘密は落とす。 */
function buildCharacters() {
  return CHARACTER_IDS.map((id) => {
    const profile = readYaml(charPath(id, 'profile.yaml'), ProfileSchema);
    const canon = readYaml(charPath(id, 'canon.yaml'), CanonSchema);
    const relationships = readYaml(charPath(id, 'relationships.yaml'), RelationshipsSchema);

    const { visual } = profile;
    return {
      id: profile.id,
      era: profile.era,
      name: profile.name,
      age: profile.age,
      role: profile.role,
      affiliation: profile.affiliation,
      ...(profile.designation ? { designation: profile.designation } : {}),
      appeal_axis: profile.appeal_axis,

      // 芯。secret_hidden は本人が知っているので出す。secret_unknown_to_self は出さない。
      core: {
        wish: oneLine(profile.core.wish),
        fear: oneLine(profile.core.fear),
        contradiction: oneLine(profile.core.contradiction),
      },

      // サイトが出す欄は { ja, en } のまま渡す。1言語 = 1 URL なので、
      // どちらを出すかは向こうが決める。register / focus / rare_expression は
      // 生成プロンプト専用でサイトへ出ないため、日本語のままでよい。
      voice: {
        first_person: both(profile.voice.first_person),
        register: oneLine(profile.voice.register),
        tic: both(profile.voice.tic),
        never_says: both(profile.voice.never_says),
        closing: both(profile.voice.closing),
        rare_expression: oneLine(profile.rare_expression),
      },

      appraisal: {
        question: both(profile.appraisal.question),
        focus: profile.appraisal.focus,
        bias: both(profile.appraisal.bias),
        humor: both(profile.appraisal.humor),
      },

      visual: {
        build: oneLine(visual.build),
        hair: oneLine(visual.hair),
        clothing: typeof visual.clothing === 'string' ? oneLine(visual.clothing) : null,
        key_prop: oneLine(visual.key_prop),
        palette: visual.palette,
        // シートで確定した文面。`en` は絵に焼いた英字そのもの、`ja` はその訳。
        // 1言語 = 1 URL なので、両方渡して向こうが選ぶ。
        sheet: visual.sheet
          ? {
              ...visual.sheet,
              captions: visual.sheet.captions.map(both),
              quote: both(visual.sheet.quote),
            }
          : null,
      },

      /** 動かない人生の事実。canon 由来。 */
      life_facts: [
        ...canon.formative_events.map((e) => both(e.fact)),
        ...canon.facts.map((f) => both(f.fact)),
      ],

      /** 周りの人。hidden_from_protagonist は落とす。 */
      people: relationships.people.map((person) => ({
        id: person.id,
        name: person.name,
        relation: both(person.relation),
        summary: both(person.summary),
      })),
    };
  });
}

/** 書かれた日記。日付順（古い順）。本文は ja / en の両方。 */
function buildEntries() {
  const entries = [];

  for (const id of CHARACTER_IDS) {
    for (const path of listDatedFiles(charPath(id, 'entries'), '.json')) {
      const entry = DiaryEntrySchema.parse(JSON.parse(readFileSync(path, 'utf8')));

      // その日に人格がどう動いたか。日記の裏側として描画する。
      const eventPath = path.replace(`${'/entries/'}`, '/events/');
      const applied = existsSync(eventPath)
        ? DiaryEventSchema.parse(JSON.parse(readFileSync(eventPath, 'utf8'))).applied
        : null;

      entries.push({
        ...entry,
        body: {
          ja: readDiaryBody(id, entry.date, 'ja'),
          en: readDiaryBody(id, entry.date, 'en'),
        },
        applied,
      });
    }
  }

  return entries.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 欠けた日。
 *
 * 隠さない。反復も、矛盾も、人格の崩壊も、失敗も、等しく実験記録である。
 * サイトは一覧で日付を飛ばして詰めず、ここを空欄として描く。
 */
function buildFailures() {
  const dir = worldPath('failures');
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => FailureSchema.parse(JSON.parse(readFileSync(join(dir, f), 'utf8'))))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** 季の計画。何が起きる予定だったかを、読者も読める。 */
function buildSeasons() {
  const root = worldPath('seasons');
  if (!existsSync(root)) return [];

  const seasons = [];
  for (const dir of readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()) {
    for (const file of readdirSync(join(root, dir)).filter((f) => f.endsWith('.yaml'))) {
      const plan = readYaml(join(root, dir, file), SeasonPlanSchema);
      // サイトが出すのは title / shape / leaves_open の3つだけ。訳が無ければ
      // `both()` が en を日本語で埋める——英語ページに日本語が出るが、無言で
      // 消すよりよい。未訳は `npm run validate` が数えて見せる。
      seasons.push({
        season: plan.season,
        era: plan.era,
        protagonist: plan.protagonist,
        title: both(plan.title),
        shape: both(plan.shape),
        year_in_world: plan.year_in_world,
        episodes: plan.episodes.map((e) => ({
          number: e.number,
          beat: e.beat,
          world_date: e.world_date,
          leaves_open: both(e.leaves_open),
        })),
      });
    }
  }
  return seasons;
}

export function buildBundle(now: string) {
  const eras = readYaml(worldPath('canon/eras.yaml'), ErasFileSchema).eras.map((era) => ({
    id: era.id,
    name: era.name,
    years: era.years,
    order: era.order,
    protagonist: era.protagonist,
    question: era.question,
    focus: era.focus,
    // 読者向けの時代要約。時代ページが世界記述の置き場になる——/pixtale/lore は
    // 時代の詳細をここへ委ね、ゲーム側の意味（カードへの付与）だけを持つ。
    summary: both(era.summary),
    palette: era.palette,
  }));

  const rotation = readYaml(worldPath('canon/rotation.yaml'), RotationFileSchema);
  const entries = buildEntries();

  return {
    generated_at: now,
    /** 稼働開始日。ここより前に日記は存在しない。 */
    start_date: rotation.start_date,
    /** 読み方の順序。日付順はこの5日周期で時代を飛び回る。 */
    rotation: rotation.order,
    eras,
    characters: buildCharacters(),
    entries,
    failures: buildFailures(),
    seasons: buildSeasons(),
  };
}
