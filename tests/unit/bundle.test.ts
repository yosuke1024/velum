import { describe, it, expect } from 'vitest';
import { charPath } from '../../src/lib/paths.js';
import { readYaml } from '../../src/lib/storage.js';
import { ProfileSchema, RelationshipsSchema } from '../../src/schemas/character.js';
import { CHARACTER_IDS, ERA_PROTAGONIST } from '../../src/schemas/world.js';
import { buildBundle } from '../../src/export/bundle.js';

const bundle = buildBundle('2026-08-23T00:00:00.000Z');
const serialized = JSON.stringify(bundle);

/** 照合に意味のある最小の長さ。これより短い断片はどこにでも現れる。 */
const MIN_NEEDLE = 8;

/** 和文が1文字でも混じっているか。英語ページに出てはいけないもの。 */
const japanese = /[ぁ-んァ-ヶ一-龠]/;

const segments = (secret: string): string[] =>
  secret
    .split(/[\n。]/)
    .map((part) => part.trim())
    .filter((part) => [...part].length >= MIN_NEEDLE);

/**
 * 束から漏れたものは、そのまま公開ページに描画される。
 *
 * 日記プロンプトと Persona Snapshot にも同じ規律があるが、守る対象はここが最も広い。
 * 読者だけが日記の行間から気づく構造は、サイトがそれを表示しないことで守られる。
 */
describe('本人が知らないことを、公開する束へ入れない', () => {
  for (const id of CHARACTER_IDS) {
    it(`${id} の秘密が束に入らない`, () => {
      const profile = readYaml(charPath(id, 'profile.yaml'), ProfileSchema);
      const relationships = readYaml(charPath(id, 'relationships.yaml'), RelationshipsSchema);

      for (const segment of segments(profile.core.secret_unknown_to_self)) {
        expect(serialized).not.toContain(segment);
      }
      for (const person of relationships.people) {
        if (!person.hidden_from_protagonist) continue;
        for (const segment of segments(person.hidden_from_protagonist)) {
          expect(serialized).not.toContain(segment);
        }
      }
    });
  }

  it('隠していること（本人は知っている）も、束には出さない', () => {
    // 読者に伏せる必要はないが、人物ページに書き出すものではない。
    // 日記の行間で気づかせるのが設計であり、要約して先に渡さない。
    for (const id of CHARACTER_IDS) {
      const profile = readYaml(charPath(id, 'profile.yaml'), ProfileSchema);
      const [first] = segments(profile.core.secret_hidden);
      if (first) expect(serialized).not.toContain(first);
    }
  });
});

describe('束の形', () => {
  it('5時代・5人ぶんある', () => {
    expect(bundle.eras).toHaveLength(5);
    expect(bundle.characters).toHaveLength(5);
  });

  it('時代と主人公の対応が world と一致する', () => {
    for (const character of bundle.characters) {
      expect(ERA_PROTAGONIST[character.era]).toBe(character.id);
    }
  });

  it('稼働開始日を渡す（サイトが「まだ始まっていない」を描けるように）', () => {
    expect(bundle.start_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('ローテーションを渡す（日付順が時代を飛び回ることの根拠）', () => {
    expect(new Set(bundle.rotation).size).toBe(5);
  });

  it('日記は日付の古い順に並ぶ', () => {
    const dates = bundle.entries.map((e) => e.date);
    expect(dates).toEqual([...dates].sort());
  });

  it('笑いの出どころを5人ぶん落とさない', () => {
    // PixTale が止まったのは出力が面白くなかったからで、人物ページでも同じ。
    const humors = new Set(bundle.characters.map((c) => c.appraisal.humor));
    expect(humors.size).toBe(5);
  });

  it('関係者から hidden_from_protagonist の欄ごと落ちている', () => {
    for (const character of bundle.characters) {
      for (const person of character.people) {
        expect(Object.keys(person)).toEqual(['id', 'name', 'relation', 'summary']);
      }
    }
  });

  it('シートの文面は二言語で来る（日本語ページに英語を残さない）', () => {
    // 1言語 = 1 URL。訳が無ければ人物ページの引用文と小物キャプションが
    // 英語のまま日本語ページに出る——`/velum/en/` に日本語が出るのと同じ欠陥。
    for (const character of bundle.characters) {
      const { sheet } = character.visual;
      if (!sheet) continue;
      for (const caption of sheet.captions) {
        expect(caption.ja).toMatch(japanese);
        expect(caption.en).toMatch(/[A-Za-z]/);
      }
      expect(sheet.quote.ja).toMatch(japanese);
      expect(sheet.quote.en).toMatch(/[A-Za-z]/);
    }
  });

  it('信念の見出しは二言語で来る（英語ページに状態キーを出さない）', () => {
    // 2026-09-01、最初の日記が公開された朝に `/velum/en/` の日記ページへ
    // 「規約は正しい」が出て、掲載側の言語ガードが同期を止めた。信念のキーは
    // current-state.yaml の引き当てキーなので日本語のままでよく、束が訳を
    // 添えて渡す——訳がここで欠けると、同じ止まり方をする。
    for (const id of CHARACTER_IDS) {
      const profile = readYaml(charPath(id, 'profile.yaml'), ProfileSchema);
      for (const belief of profile.beliefs) {
        expect(belief.en).toMatch(/[A-Za-z]/);
        expect(belief.en).not.toMatch(japanese);
      }
    }
    for (const entry of bundle.entries) {
      for (const belief of entry.applied?.beliefs ?? []) {
        expect(belief.key.ja).toMatch(japanese);
        expect(belief.key.en).toMatch(/[A-Za-z]/);
        expect(belief.key.en).not.toMatch(japanese);
      }
    }
  });

  it('人生の事実は二言語で来る（生成が追記したぶんも）', () => {
    // canon.facts は日記の生成が1日1件まで追記する。素の文字列を受けていた
    // ころは `both()` が英語へ日本語を落としたので、生成が1件足した日に
    // 人物ページの英語版が日本語を出すことになっていた。
    for (const character of bundle.characters) {
      for (const fact of character.life_facts) {
        expect(fact.ja).toMatch(japanese);
        expect(fact.en).toMatch(/[A-Za-z]/);
        expect(fact.en).not.toMatch(japanese);
      }
    }
  });

  it('改行を含んだままの文字列を渡さない（JSON に生の改行を残さない）', () => {
    for (const character of bundle.characters) {
      for (const fact of character.life_facts) {
        expect(fact.ja).not.toContain('\n');
        expect(fact.en).not.toContain('\n');
      }
      expect(character.voice.register).not.toContain('\n');
    }
  });
});
