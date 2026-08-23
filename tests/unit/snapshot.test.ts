import { describe, it, expect } from 'vitest';
import { SNAPSHOT_LIMITS } from '../../src/schemas/limits.js';
import { CHARACTER_IDS } from '../../src/schemas/world.js';
import { charPath } from '../../src/lib/paths.js';
import { readYaml } from '../../src/lib/storage.js';
import { RelationshipsSchema } from '../../src/schemas/character.js';
import {
  snapshotBoundsLines,
  buildSnapshotSystemPrompt,
  buildSnapshotUserPrompt,
} from '../../src/compile/prompt.js';
import { buildCompileContext } from '../../src/compile/context.js';
import { assemble, nextVersion, existingVersions } from '../../src/compile/compile.js';
import { gateSnapshot, nameNeedles } from '../../src/compile/gate.js';
import type { Snapshot } from '../../src/schemas/snapshot.js';
import { nextManifest, emptyManifest } from '../../src/compile/publish.js';
import { PersonaManifestSchema } from '../../src/schemas/manifest.js';
import { isSeasonEnd, turnFor } from '../../src/lib/rotation.js';

const GENERATION = { model: 'test', compiled_at: '2026-09-15T00:00:00.000Z' };

function snapshotFor(id: string, dispositions: string[]): Snapshot {
  return assemble(buildCompileContext(id), 1, dispositions, GENERATION);
}

const relationshipsOf = (id: string) =>
  readYaml(charPath(id, 'relationships.yaml'), RelationshipsSchema);

/**
 * 日記のプロンプトと同じ規律。ゲートが落とせる上限は、すべてプロンプトに書かれていなければ、
 * 厳格なゲートではなく罠になる。
 */
describe('Snapshot のプロンプトは、ゲートが落とせる上限をすべて述べる', () => {
  const covered = new Set(snapshotBoundsLines().map((line) => line.limit));

  for (const key of Object.keys(SNAPSHOT_LIMITS)) {
    it(`${key} に対応する説明がある`, () => {
      expect(covered.has(key)).toBe(true);
    });
  }

  it('説明文に実際の数値が埋め込まれている', () => {
    const text = snapshotBoundsLines()
      .map((line) => line.text)
      .join('\n');
    expect(text).toContain(String(SNAPSHOT_LIMITS.dispositions));
    expect(text).toContain(String(SNAPSHOT_LIMITS.dispositionMaxJa));
  });

  it('切り詰めではなく破棄だと伝える', () => {
    // Snapshot の中身はすべて PixTale へ届くので、切り詰めは静かな欠落になる。
    const text = snapshotBoundsLines().map((l) => l.text).join('\n');
    expect(text).toContain('破棄');
    expect(text).not.toContain('切り詰め');
  });
});

describe('Snapshot のプロンプト', () => {
  const prompt = buildSnapshotSystemPrompt();

  it('出来事ではなく、出来事が残したものを求める', () => {
    expect(prompt).toMatch(/残った振る舞い/);
    expect(prompt).toMatch(/出来事を書かない/);
  });

  it('関係者の名前を出さないよう指示する', () => {
    // Tale コメントを読む側は、この人たちを誰ひとり知らない。
    expect(prompt).toMatch(/人物の名前を出さない/);
  });

  it('直近の出来事へ偏らせないよう指示する', () => {
    expect(prompt).toMatch(/直近の出来事へ偏らせない/);
  });

  it('可笑しさを削らないよう指示する', () => {
    // PixTale が止まったのは出力が面白くなかったからで、ここが本丸。
    expect(prompt).toMatch(/可笑しさを削らない/);
  });
});

describe('本人が知らないことは、どこにも出さない', () => {
  for (const id of CHARACTER_IDS) {
    it(`${id} の秘密がプロンプトにも Snapshot にも入らない`, () => {
      const context = buildCompileContext(id);
      const relationships = relationshipsOf(id);
      const prompt = [
        buildSnapshotSystemPrompt(),
        buildSnapshotUserPrompt(context),
      ].join('\n');
      const snapshot = JSON.stringify(snapshotFor(id, ['何も捨てない']));

      // 隠していることは本人が知っているので、材料には入る。
      expect(prompt).toContain(context.profile.core.secret_hidden.trim().slice(0, 12));

      // 本人も知らないことは、材料にも出来上がりにも入らない。
      const unknown = context.profile.core.secret_unknown_to_self.trim().slice(0, 20);
      expect(prompt).not.toContain(unknown);
      expect(snapshot).not.toContain(unknown);

      for (const person of relationships.people) {
        if (!person.hidden_from_protagonist) continue;
        const hidden = person.hidden_from_protagonist.trim().slice(0, 20);
        expect(prompt).not.toContain(hidden);
        expect(snapshot).not.toContain(hidden);
      }
    });
  }
});

describe('組み立て', () => {
  it('笑いの出どころを5人ぶん落とさない', () => {
    // 育った人格が真面目になりすぎて笑いを殺すのが、この企画の最悪の失敗モード。
    const humors = new Set<string>();
    for (const id of CHARACTER_IDS) {
      const snapshot = snapshotFor(id, ['何も捨てない']);
      const { humor } = buildCompileContext(id).profile.appraisal;
      expect(snapshot.appraisal.humor).toBe(
        humor.trim().replace(/\s*\n\s*/g, ' '),
      );
      humors.add(snapshot.appraisal.humor);
    }
    // 5人が同じ笑い方に収束していたら、この Snapshot は5人ぶんの意味がない。
    expect(humors.size).toBe(CHARACTER_IDS.length);
  });

  it('レア表現を載せる（Tale コメントのレア演出になる）', () => {
    const snapshot = snapshotFor('teo', ['何も捨てない']);
    expect(snapshot.voice.rare_expression).toContain('すごい');
  });

  it('信念と性格を強い順に並べる', () => {
    const snapshot = snapshotFor('teo', ['何も捨てない']);
    const strengths = snapshot.values.map((v) => v.strength);
    const levels = snapshot.temperament.map((t) => t.level);
    expect(strengths).toEqual([...strengths].sort((a, b) => b - a));
    expect(levels).toEqual([...levels].sort((a, b) => b - a));
  });

  it('人生の事実を1行へ均す（JSON に改行を残さない）', () => {
    const snapshot = snapshotFor('teo', ['何も捨てない']);
    for (const fact of snapshot.life_facts) {
      expect(fact).not.toContain('\n');
    }
    expect(snapshot.life_facts.length).toBeGreaterThanOrEqual(3);
  });

  it('日記が1本もなければ、そう記録する', () => {
    const snapshot = snapshotFor('teo', ['何も捨てない']);
    expect(snapshot.source.through).toBeNull();
    expect(snapshot.source.diaries).toBe(0);
  });

  it('生成の産物は dispositions だけで、他は同じ材料から同じものが出る', () => {
    const first = snapshotFor('teo', ['a', 'b']);
    const second = snapshotFor('teo', ['a', 'b']);
    expect(second).toEqual(first);
  });

  it('知識境界に、その時代とその年代が入る', () => {
    const snapshot = snapshotFor('teo', ['何も捨てない']);
    expect(snapshot.knowledge_boundary.era).toBe('ギルドの時代');
    expect(snapshot.knowledge_boundary.years).toBe('0–4,000');
    expect(snapshot.knowledge_boundary.note).toMatch(/自分の時代より後を知らない/);
  });
});

describe('ゲート', () => {
  const profile = buildCompileContext('teo').profile;
  const relationships = relationshipsOf('teo');
  const check = (dispositions: string[]) =>
    gateSnapshot(snapshotFor('teo', dispositions), profile, relationships);

  it('まっとうなものは通す', () => {
    expect(check(['口約束を信用しない', '無銘の物ほど長く見てしまう']).ok).toBe(true);
  });

  it('癖が1件もなければ破棄する', () => {
    const verdict = check([]);
    expect(verdict.ok).toBe(false);
  });

  it('件数が上限を超えたら破棄する', () => {
    const many = Array.from(
      { length: SNAPSHOT_LIMITS.dispositions + 1 },
      (_, i) => `癖その${i}`,
    );
    const verdict = check(many);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.violations.join()).toContain('上限');
  });

  it('長すぎる癖は破棄する', () => {
    const verdict = check(['あ'.repeat(SNAPSHOT_LIMITS.dispositionMaxJa + 1)]);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.violations.join()).toContain('文字');
  });

  it('同じ癖が重複していたら破棄する', () => {
    expect(check(['口約束を信用しない', '口約束を信用しない']).ok).toBe(false);
  });

  it('関係者の名前が入っていたら破棄する', () => {
    // 「ヴァレン大鑑定官」の呼び名だけでも落とす。読む側はこの人を知らない。
    const verdict = check(['ヴァレンの前では規約を先に出す']);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.violations.join()).toContain('名前');
  });

  it('英語表記の名前でも破棄する', () => {
    expect(check(['Never trusts Lowe with a receipt']).ok).toBe(false);
  });

  it('本人が知らない秘密が混ざっていたら破棄する', () => {
    // 型の上では起こり得ないが、あとから profile を流し込む変更が入ったときに
    // 壊れるのは CI ではなく PixTale が語る人格なので、出来上がりを照合する。
    const snapshot = snapshotFor('teo', ['何も捨てない']);
    snapshot.life_facts.push(profile.core.secret_unknown_to_self.trim());
    const verdict = gateSnapshot(snapshot, profile, relationships);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.violations.join()).toContain('本人も知らない秘密');
  });

  it('関係者の隠された事実が混ざっていたら破棄する', () => {
    const snapshot = snapshotFor('teo', ['何も捨てない']);
    const hidden = relationships.people.find((p) => p.hidden_from_protagonist);
    snapshot.dispositions.push(hidden?.hidden_from_protagonist?.trim() ?? '');
    const verdict = gateSnapshot(snapshot, profile, relationships);
    expect(verdict.ok).toBe(false);
  });
});

describe('照合する名前の形', () => {
  it('肩書きつきの名前から呼び名を取り出す', () => {
    const needles = nameNeedles({ ja: 'ヴァレン大鑑定官', en: 'Vallen, Grand Appraiser' });
    expect(needles).toContain('ヴァレン');
    expect(needles).toContain('Vallen');
  });

  it('短い名前はそのまま使う', () => {
    expect(nameNeedles({ ja: 'ロウ', en: 'Lowe' })).toContain('ロウ');
  });
});

describe('バージョン', () => {
  it('README.md をバージョンとして数えない', () => {
    // snapshots/ には README.md が置いてある。v0001.json だけを見る。
    for (const id of CHARACTER_IDS) {
      expect(existingVersions(id)).toEqual([]);
      expect(nextVersion(id)).toBe(1);
    }
  });

  it('次の番号は、いちばん大きい番号の次', () => {
    expect(nextVersion('teo')).toBe(existingVersions('teo').length + 1);
  });
});

describe('季の切れ目', () => {
  it('25日目が季の最終日で、24日目はまだ途中', () => {
    // 2026-09-01 が1日目。第1季は 09-01〜09-25。
    expect(isSeasonEnd('2026-09-24')).toBe(false);
    expect(isSeasonEnd('2026-09-25')).toBe(true);
    expect(isSeasonEnd('2026-09-26')).toBe(false);
  });

  it('最終日には5人全員が第5話を書き終えている', () => {
    // これより前に圧縮すると、その季を生きていない人格ができる。
    const written = new Set<string>();
    for (let day = 0; day < 25; day += 1) {
      const date = new Date(Date.UTC(2026, 8, 1 + day)).toISOString().slice(0, 10);
      const turn = turnFor(date);
      if (turn.episode === 5) written.add(turn.protagonist);
      if (isSeasonEnd(date)) expect(written.size).toBe(CHARACTER_IDS.length);
    }
  });

  it('第2季も25日ごとに切れる', () => {
    expect(isSeasonEnd('2026-10-20')).toBe(true);
    expect(turnFor('2026-10-20').season).toBe(2);
  });
});

describe('配ること', () => {
  const now = '2026-09-25T21:30:00.000Z';
  const teo = snapshotFor('teo', ['口約束を信用しない']);

  it('配ると、その版を指す', () => {
    const manifest = nextManifest(emptyManifest(), [teo], now, 1);
    const entry = manifest.personas.teo;
    expect(entry?.version).toBe(1);
    expect(entry?.path).toBe('characters/teo/snapshots/v0001.json');
    expect(entry?.era).toBe('guilds');
    expect(manifest.season).toBe(1);
  });

  it('コンパイルしただけでは、まだ何も配られていない', () => {
    // Snapshot を書いても personas.json が動かなければ、PixTale の出力は変わらない。
    expect(emptyManifest().personas).toEqual({});
    expect(emptyManifest().updated_at).toBeNull();
  });

  it('ピンは人物ごとに独立している', () => {
    // ある人物のコンパイルが落ちても、その人のピンは前のまま。
    // PixTale はその人格を語り続ける。
    const first = nextManifest(
      emptyManifest(),
      [teo, snapshotFor('riko', ['値札を先に見る'])],
      now,
      1,
    );
    const second = nextManifest(
      first,
      [assemble(buildCompileContext('teo'), 2, ['別の癖'], GENERATION)],
      '2026-10-20T21:30:00.000Z',
      2,
    );
    expect(second.personas.teo?.version).toBe(2);
    expect(second.personas.riko?.version).toBe(1);
    expect(second.personas.riko?.published_at).toBe(now);
  });

  it('人格を戻すのは、version を書き換えるだけで済む', () => {
    // 追記のみなので、進めたあとも v0001 のファイルは消えていない。
    const advanced = nextManifest(
      nextManifest(emptyManifest(), [teo], now, 1),
      [assemble(buildCompileContext('teo'), 2, ['別の癖'], GENERATION)],
      '2026-10-20T21:30:00.000Z',
      2,
    );
    expect(advanced.personas.teo?.version).toBe(2);

    // 戻す操作は、このファイルの数字ひとつの書き換えである。
    const rolledBack = structuredClone(advanced);
    rolledBack.personas.teo = {
      ...advanced.personas.teo!,
      version: 1,
      path: 'characters/teo/snapshots/v0001.json',
    };
    expect(PersonaManifestSchema.safeParse(rolledBack).success).toBe(true);
    expect(rolledBack.personas.riko).toEqual(advanced.personas.riko);
  });
});
