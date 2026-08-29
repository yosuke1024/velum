import { readdirSync, existsSync } from 'node:fs';
import { worldPath, appraisalDir } from '../lib/paths.js';
import { readYaml } from '../lib/storage.js';
import {
  ErasFileSchema,
  EraCanonFileSchema,
  LawsFileSchema,
  ERA_IDS,
} from '../schemas/world.js';
import {
  WorldAppraisalSchema,
  APPRAISAL_FILE,
  APPRAISAL_SIZE_LIMIT,
  APPRAISAL_SCHEMA_VERSION,
  type WorldAppraisal,
  type AppraisalEra,
} from '../schemas/appraisal.js';
import { ja, oneLine, both } from '../lib/bilingual.js';

/**
 * World Appraisal Snapshot のコンパイル。**生成を経ない、canon からの射影である。**
 *
 * Persona Snapshot が dispositions の1点だけ生成に頼るのに対し、世界の輪郭は
 * すべて手で書かれた canon にすでにある。射影だけなら、笑いを殺す圧縮も
 * 事実の捏造も起こらない——だから source フィールドは現れない。
 *
 * 射影の規律:
 *  - profile / values / taboos / events / absent … canon の appraisal 欄（手書き）
 *  - terms … institutions / places / cities / observances の**名前だけ**。
 *    note は持ち込まない。note には読者だけが知る注記が混ざりうる。
 *  - laws / expression_rules … world/canon/laws.yaml の ja 射影
 */
export function buildWorldAppraisal(
  version: number,
  season: number,
  now: string,
): WorldAppraisal {
  const erasFile = readYaml(worldPath('canon/eras.yaml'), ErasFileSchema);
  const laws = readYaml(worldPath('canon/laws.yaml'), LawsFileSchema);

  const eras = Object.fromEntries(
    ERA_IDS.map((id) => {
      const meta = erasFile.eras.find((era) => era.id === id);
      if (!meta) throw new Error(`eras.yaml に ${id} がありません`);
      const canon = readYaml(worldPath(`canon/${id}.yaml`), EraCanonFileSchema);

      const named = [
        ...(canon.institutions ?? []),
        ...(canon.places ?? []),
        ...(canon.cities ?? []),
      ].map((entry) => ja(entry.name));
      const observed = (canon.observances ?? []).map((o) => oneLine(o.name));

      const era: AppraisalEra = {
        name: both(meta.name),
        order: meta.order,
        years: meta.years,
        profile: oneLine(canon.appraisal.profile),
        values: canon.appraisal.values.map(oneLine),
        taboos: canon.appraisal.taboos.map(oneLine),
        terms: [...new Set([...named, ...observed])],
        events: canon.appraisal.events.map(oneLine),
        absent: canon.appraisal.absent.map(oneLine),
      };
      return [id, era];
    }),
  );

  const snapshot = WorldAppraisalSchema.parse({
    schema_version: APPRAISAL_SCHEMA_VERSION,
    version,
    compiled_at: now,
    season,
    laws: laws.laws.map((law) => ja(law.text)),
    expression_rules: laws.expression_rules.map(oneLine),
    eras,
  });

  // サイズ上限はコンパイル時にも見る。validate まで気づかないと、
  // 書き出した追記専用ファイルを消して番号を巻き戻すはめになる。
  const size = Buffer.byteLength(JSON.stringify(snapshot, null, 2));
  if (size > APPRAISAL_SIZE_LIMIT) {
    throw new Error(
      `World Appraisal Snapshot が ${size} bytes あります（上限 ${APPRAISAL_SIZE_LIMIT}）。` +
        ' canon の appraisal 欄を削ってください。',
    );
  }

  return snapshot;
}

/** 既存バージョン。追記のみで、番号は飛ばない（validate が守る）。 */
export function existingAppraisalVersions(): number[] {
  if (!existsSync(appraisalDir())) return [];
  return readdirSync(appraisalDir())
    .map((file) => APPRAISAL_FILE.exec(file))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]))
    .sort((a, b) => a - b);
}

export function nextAppraisalVersion(): number {
  const versions = existingAppraisalVersions();
  return versions.length ? versions[versions.length - 1]! + 1 : 1;
}
