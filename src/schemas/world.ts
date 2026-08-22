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
