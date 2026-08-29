import { readFileSync } from "node:fs";
import {
  charPath,
  worldPath,
  feedRelPath,
  feedEntryName,
} from "../lib/paths.js";
import { readYaml, listDatedFiles } from "../lib/storage.js";
import { ProfileSchema } from "../schemas/character.js";
import { DiaryEntrySchema, type DiaryEntry } from "../schemas/diary.js";
import {
  ErasFileSchema,
  LawsFileSchema,
  EraCanonFileSchema,
  GlossaryFileSchema,
  CHARACTER_IDS,
  DEFAULT_COMPANION,
  ERA_IDS,
} from "../schemas/world.js";
import {
  FEED_SCHEMA_VERSION,
  DIARY_FEED_WINDOW,
  PORTRAIT_SIZE,
  FeedCharactersSchema,
  FeedLoreSchema,
  FeedDiarySchema,
  FeedEntryFileSchema,
  type FeedCharacters,
  type FeedLore,
  type FeedDiary,
  type FeedEntryFile,
} from "../schemas/feed.js";
import { readManifest } from "../compile/publish.js";
import { readDiaryBody } from "./bundle.js";
import { bothForReaders, oneLine, type Bilingual } from "../lib/bilingual.js";
import type { PersonaManifest } from "../schemas/manifest.js";

/**
 * PixTale アプリが読む feed の束（world/feed/）。
 *
 * サイトの束（bundle.ts）と似ているが、守る対象が違う——こちらは商用アプリの
 * 契約面であり、形は pixapps 側 `pixtale_v2_contracts.md` §1 が正である。
 * フィールドの削除・改名はしない。増やすのは自由。
 *
 * **秘匿情報（core.secret_*・hidden_from_protagonist）はここに入らない。**
 * 型がそもそも参照していないことに加え、`npm run validate` が書き出した
 * ファイルを断片照合で検査する（src/lib/secrets.ts）。
 */

/** World タブ・同行者選択が読む characters.json。 */
export function buildCharactersFeed(
  now: string,
  manifest: PersonaManifest = readManifest(),
): FeedCharacters {
  const characters = CHARACTER_IDS.map((id) => {
    const profile = readYaml(charPath(id, "profile.yaml"), ProfileSchema);
    return {
      id: profile.id,
      era: profile.era,
      name: bothForReaders(profile.name),
      role: bothForReaders(profile.role),
      age: profile.age,
      affiliation: profile.affiliation,
      intro: bothForReaders(profile.intro),
      portrait: {
        path: feedRelPath("portraits", `${id}.png`),
        width: PORTRAIT_SIZE,
        height: PORTRAIT_SIZE,
      },
    };
  });

  return FeedCharactersSchema.parse({
    schema_version: FEED_SCHEMA_VERSION,
    generated_at: now,
    // 真の値はピン。ピンがまだ立っていなければ契約 §3.2 の既定値。
    default_companion_id: manifest.default_companion ?? DEFAULT_COMPANION,
    characters,
  });
}

/**
 * 時代別 canon（world/canon/<era>.yaml）を ERA_IDS 順に横断し、summary を
 * 持つ institutions だけを組織として集める（summary が無いものは自然に
 * 除外——例: guilds.yaml の vesper-workshop）。並び順は ERA_IDS 順 → 各
 * ファイル内の記載順で決定的にする（readdirSync 等の順序依存は使わない）。
 * note は読者だけが知る注記が混ざりうるので出さない。
 */
function collectOrganizations(): FeedLore["organizations"] {
  return ERA_IDS.flatMap((id) => {
    const canon = readYaml(worldPath(`canon/${id}.yaml`), EraCanonFileSchema);
    return (canon.institutions ?? []).flatMap((entry) => {
      if (!entry.summary) return [];
      return [
        {
          id: entry.id,
          era: id,
          name: bothForReaders(entry.name),
          summary: bothForReaders(entry.summary),
        },
      ];
    });
  });
}

/** World Lore 基本（時代・世界法則・組織・用語集）が読む lore.json。 */
export function buildLoreFeed(now: string): FeedLore {
  const eras = readYaml(worldPath("canon/eras.yaml"), ErasFileSchema).eras;
  const laws = readYaml(worldPath("canon/laws.yaml"), LawsFileSchema);
  const glossary = readYaml(
    worldPath("canon/glossary.yaml"),
    GlossaryFileSchema,
  );

  return FeedLoreSchema.parse({
    schema_version: FEED_SCHEMA_VERSION,
    generated_at: now,
    eras: [...eras]
      .sort((a, b) => a.order - b.order)
      .map((era) => ({
        id: era.id,
        order: era.order,
        years: era.years,
        name: bothForReaders(era.name),
        summary: bothForReaders(era.summary),
      })),
    laws: laws.laws.map((law) => ({
      id: law.id,
      text: bothForReaders(law.text),
    })),
    organizations: collectOrganizations(),
    // 記載順どおりに出す。note は出さない。
    glossary: glossary.glossary.map((term) => ({
      id: term.id,
      term: bothForReaders(term.term),
      text: bothForReaders(term.text),
    })),
  });
}

export const feedEntryId = (entry: DiaryEntry): string =>
  `${entry.date}-${entry.protagonist}`;

/** 本文の整形。段落の空行区切りは保ち、3行以上の空行だけ詰める。 */
const normalizeBody = (text: string): string =>
  text.trim().replace(/\n{3,}/g, "\n\n");

/** 日記1本ぶんの全文ファイル（entries/<date>-<id>.json）。発行後は不変。 */
export function feedEntryFrom(
  entry: DiaryEntry,
  body: Bilingual,
): FeedEntryFile {
  const id = feedEntryId(entry);
  return FeedEntryFileSchema.parse({
    schema_version: FEED_SCHEMA_VERSION,
    id,
    date: entry.date,
    character_id: entry.protagonist,
    era: entry.era,
    season: entry.season,
    episode: entry.episode,
    world_date: entry.world_date,
    title: bothForReaders(entry.title),
    // 一覧用抜粋。velum 内部の quote を転用する（契約 §1.2）。
    excerpt: bothForReaders(entry.quote),
    mood: bothForReaders(entry.mood),
    path: feedRelPath("entries", feedEntryName(entry.date, entry.protagonist)),
    body: {
      ja: normalizeBody(body.ja),
      // 訳がまだ無ければ日本語のまま出す（消さずに見せる。src/lib/bilingual.ts の作法）。
      en: normalizeBody(body.en || body.ja),
    },
  });
}

/** 一覧 diary.json。最新90件・新しい順。本文は持たない。 */
export function diaryFeedFrom(files: FeedEntryFile[], now: string): FeedDiary {
  const entries = [...files]
    .sort((a, b) => b.id.localeCompare(a.id))
    .slice(0, DIARY_FEED_WINDOW)
    .map(({ body, schema_version, ...listed }) => listed);

  return FeedDiarySchema.parse({
    schema_version: FEED_SCHEMA_VERSION,
    generated_at: now,
    entries,
  });
}

/**
 * 書かれた日記の全部を feed の形へ。日本語本文が無い日記はデータ不整合なので
 * 落とすのではなく止める——黙って1本消えるほうが、止まるより発見が遅い。
 */
export function collectFeedEntryFiles(): FeedEntryFile[] {
  const files: FeedEntryFile[] = [];

  for (const id of CHARACTER_IDS) {
    for (const path of listDatedFiles(charPath(id, "entries"), ".json")) {
      const entry = DiaryEntrySchema.parse(
        JSON.parse(readFileSync(path, "utf8")),
      );
      const ja = readDiaryBody(id, entry.date, "ja");
      if (!ja) {
        throw new Error(
          `${id} の ${entry.date} に日記本文（ja）がありません: ${path}`,
        );
      }
      const en = readDiaryBody(id, entry.date, "en");
      files.push(feedEntryFrom(entry, { ja, en: en ?? ja }));
    }
  }

  return files;
}
