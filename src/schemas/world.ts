import { z } from 'zod';

export const ERA_IDS = [
  'primordial',
  'guilds',
  'convergence',
  'fracture',
  'silent',
] as const;

export const CHARACTER_IDS = ['uta', 'teo', 'sevran', 'kaya', 'riko'] as const;

export const EraId = z.enum(ERA_IDS);
export const CharacterId = z.enum(CHARACTER_IDS);

// 値（zod スキーマ）と同名の型も出す。呼び出し側が両方使うため。
export type EraId = z.infer<typeof EraId>;
export type CharacterId = z.infer<typeof CharacterId>;

/** 各時代の主人公。ルーティングと検証の両方が参照する。 */
export const ERA_PROTAGONIST: Record<
  (typeof ERA_IDS)[number],
  (typeof CHARACTER_IDS)[number]
> = {
  primordial: 'uta',
  guilds: 'teo',
  convergence: 'sevran',
  fracture: 'kaya',
  silent: 'riko',
};

const Bilingual = z.object({
  ja: z.string().min(1),
  en: z.string().min(1),
});

export const EraSchema = z.object({
  id: EraId,
  name: Bilingual,
  years: z.string().min(1),
  order: z.number().int().min(1).max(5),
  protagonist: CharacterId,
  assignment: z.string().min(1),
  question: Bilingual,
  focus: z.string().min(1),
  humor: z.string().min(1),
  palette: z.object({
    base: z.array(z.string()).min(1),
    accent: z.string(),
  }),
});

export const ErasFileSchema = z.object({
  eras: z.array(EraSchema).length(5),
});

export const RotationFileSchema = z.object({
  start_date: z.string().nullable(),
  order: z.array(EraId).length(5),
});

const NamedEntry = z.object({
  id: z.string().min(1),
  name: z.union([Bilingual, z.string().min(1)]),
  note: z.string().optional(),
});

/**
 * 祭・節目の日付指定。3つの形がある:
 *   { month, day }        月の中の一日
 *   { months: [...] }     季節帯（峠の閉山期など）
 *   { intercalary: true } 五夜（どの月にも属さない5日）
 */
export const WhenSchema = z
  .object({
    month: z.number().int().min(1).max(12).optional(),
    day: z.number().int().min(1).max(30).optional(),
    months: z.array(z.number().int().min(1).max(12)).min(1).optional(),
    intercalary: z.boolean().optional(),
  })
  .refine(
    (w) => w.intercalary === true || w.month !== undefined || w.months !== undefined,
    { message: 'month / months / intercalary のいずれかが必要です' },
  );

export const ObservanceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  when: WhenSchema,
  note: z.string().optional(),
});

export const EraCanonFileSchema = z.object({
  era: EraId,
  fixed: z
    .array(
      z.object({
        id: z.string().min(1),
        fact: z.string().min(1),
      }),
    )
    .min(1),
  institutions: z.array(NamedEntry).optional(),
  places: z.array(NamedEntry).optional(),
  cities: z.array(NamedEntry).optional(),
  calendar_note: z.string().optional(),
  observances: z.array(ObservanceSchema).optional(),
});

export const CalendarFileSchema = z.object({
  year_days: z.literal(365),
  months: z
    .array(
      z.object({
        number: z.number().int().min(1).max(12),
        name: Bilingual,
        season: z.enum(['春', '夏', '秋', '冬']),
      }),
    )
    .length(12),
  intercalary: z.object({
    name: Bilingual,
    days: z.literal(5),
    note: z.string().optional(),
  }),
});

/**
 * 各時代の「いま」。季の計画が進める。
 * primordial の year は null（サナ氏族は年を数えない）。
 * convergence の year は 417 のまま変わらない（終わらない年）。
 */
export const ClocksFileSchema = z.object({
  clocks: z
    .array(
      z.object({
        era: EraId,
        year: z.number().int().nullable(),
        month: z.number().int().min(1).max(13),
        day: z.number().int().min(1).max(30),
      }),
    )
    .length(5),
});

export const ArcFileSchema = z.object({
  id: z.string().min(1),
  era: EraId,
  protagonist: CharacterId,
  status: z.enum(['active', 'resolved', 'paused']),
  name: Bilingual,
  premise: z.string().min(1),
  unresolved: z
    .array(
      z.object({
        id: z.string().min(1),
        question: z.string().min(1),
      }),
    )
    .min(1),
});

export const CardDeckFileSchema = z.object({
  era: EraId,
  cards: z
    .array(
      z.object({
        id: z.string().min(1),
        weight: z.number().int().min(1).max(10),
        prompt: z.string().min(1),
      }),
    )
    .min(5),
});

export const ThreadsFileSchema = z.object({
  threads: z
    .array(
      z.object({
        id: z.string().min(1),
        name: Bilingual,
        summary: z.string().min(1),
        note: z.string().optional(),
        touches: z
          .array(
            z.object({
              // 'present' は PixTale 本体（現代）を指す
              era: z.union([EraId, z.literal('present')]),
              who: z.string().nullable(),
              role: z.string().min(1),
            }),
          )
          .min(2),
      }),
    )
    .min(1),
});
