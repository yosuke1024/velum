import { describe, it, expect } from 'vitest';
import {
  WorldAppraisalSchema,
  APPRAISAL_SIZE_LIMIT,
  appraisalFileName,
} from '../../src/schemas/appraisal.js';
import { buildWorldAppraisal } from '../../src/appraisal/compile.js';
import { nextWorldPin, nextManifest, emptyManifest } from '../../src/compile/publish.js';
import { PersonaManifestSchema } from '../../src/schemas/manifest.js';
import { ERA_IDS } from '../../src/schemas/world.js';
import { forbiddenSecretSegments } from '../../src/lib/secrets.js';
import type { Snapshot } from '../../src/schemas/snapshot.js';

const NOW = '2026-08-29T00:00:00.000Z';
const snapshot = buildWorldAppraisal(1, 1, NOW);

describe('World Appraisal Snapshot のコンパイル', () => {
  it('スキーマに合う', () => {
    expect(() => WorldAppraisalSchema.parse(snapshot)).not.toThrow();
    expect(snapshot.version).toBe(1);
    expect(snapshot.season).toBe(1);
  });

  it('5時代すべてが入り、order と years が eras.yaml と揃う', () => {
    for (const id of ERA_IDS) {
      expect(snapshot.eras[id]).toBeDefined();
    }
    const orders = ERA_IDS.map((id) => snapshot.eras[id].order).sort((a, b) => a - b);
    expect(orders).toEqual([1, 2, 3, 4, 5]);
  });

  it('固有名詞は canon の名前から射影される', () => {
    expect(snapshot.eras.guilds.terms).toContain('大鑑定院');
    expect(snapshot.eras.convergence.terms).toContain('アルヴィス');
    expect(snapshot.eras.silent.terms).toContain('北の市');
  });

  it('固有名詞は名前だけで、canon の note は持ち込まない', () => {
    // note には読者だけが知る注記（人物との血縁など）が混ざりうる。
    // 出してよいのは名前そのものだけである。
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('テオの実家');
    expect(serialized).not.toContain('前身にあたる');
  });

  it('重複した固有名詞は1度だけ出る', () => {
    // 北の市は silent の places と observances の両方にある。
    for (const id of ERA_IDS) {
      const terms = snapshot.eras[id].terms;
      expect(new Set(terms).size).toBe(terms.length);
    }
  });

  it('生の改行を残さない（プロンプト素材は1行 = 1文）', () => {
    for (const id of ERA_IDS) {
      const era = snapshot.eras[id];
      expect(era.profile).not.toContain('\n');
      for (const line of [...era.values, ...era.taboos, ...era.events, ...era.absent]) {
        expect(line).not.toContain('\n');
      }
    }
    for (const law of snapshot.laws) expect(law).not.toContain('\n');
  });

  it('サイズ上限 12KB に収まる', () => {
    expect(Buffer.byteLength(JSON.stringify(snapshot, null, 2))).toBeLessThanOrEqual(
      APPRAISAL_SIZE_LIMIT,
    );
  });

  it('生成を経ない射影なので source を持たない', () => {
    expect(snapshot.source).toBeUndefined();
  });

  it('決定性 — 同じ素材と時刻からは同じ Snapshot ができる', () => {
    expect(JSON.stringify(buildWorldAppraisal(1, 1, NOW))).toBe(JSON.stringify(snapshot));
  });
});

describe('秘匿情報を World Appraisal Snapshot に含めない', () => {
  const serialized = JSON.stringify(snapshot).replace(/\s+/g, '');
  for (const { owner, segment } of forbiddenSecretSegments()) {
    it(`${owner} の秘密の断片が現れない（${segment.slice(0, 12)}…）`, () => {
      expect(serialized).not.toContain(segment.replace(/\s+/g, ''));
    });
  }
});

// ── ピンの拡張（契約 §2.1）────────────────────────────────────

const personaSnapshot = {
  version: 2,
  character: 'teo',
  era: 'guilds',
  source: { diaries: 25, through: '2026-09-25', memories: 3, model: 'm', prompt_version: 'p' },
} as unknown as Snapshot;

describe('world / default_companion のピン', () => {
  it('world ピンを additive に足し、既存の personas を動かさない', () => {
    const current = nextManifest(emptyManifest(), [personaSnapshot], NOW, 1);
    const next = nextWorldPin(current, 1, NOW);

    expect(next.world).toEqual({
      version: 1,
      path: 'world/appraisal/v0001.json',
      published_at: NOW,
    });
    expect(next.personas).toEqual(current.personas);
    expect(next.season).toBe(current.season);
  });

  it('default_companion が未設定なら teo を立てる', () => {
    const next = nextWorldPin(emptyManifest(), 1, NOW);
    expect(next.default_companion).toBe('teo');
  });

  it('人が選んだ default_companion は上書きしない', () => {
    // 戻すのも選ぶのも人の操作。publish がそれを黙って teo へ戻してはいけない。
    const current = { ...emptyManifest(), default_companion: 'riko' as const };
    const next = nextWorldPin(current, 2, NOW);
    expect(next.default_companion).toBe('riko');
  });

  it('ピンの path はファイル名規約 vNNNN.json と一致する', () => {
    const next = nextWorldPin(emptyManifest(), 12, NOW);
    expect(next.world?.path).toBe(`world/appraisal/${appraisalFileName(12)}`);
  });

  it('Persona の publish が world ピンを消さない', () => {
    // ピンファイルは1枚。季末の Persona publish と世界の publish が
    // 互いのフィールドを壊すと、向こうのプロキシが 404 を踏む。
    const withWorld = nextWorldPin(emptyManifest(), 1, NOW);
    const after = nextManifest(withWorld, [personaSnapshot], NOW, 1);
    expect(after.world).toEqual(withWorld.world);
    expect(after.default_companion).toBe(withWorld.default_companion);
  });

  it('拡張前の personas.json もそのまま読める（additive 契約）', () => {
    const legacy = {
      updated_at: null,
      season: null,
      note: 'note',
      personas: {},
    };
    expect(() => PersonaManifestSchema.parse(legacy)).not.toThrow();
  });
});
