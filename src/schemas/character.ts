import { z } from 'zod';
import { CharacterId, EraId } from './world.js';
import { MEMORY_IMPORTANCE, UNIT_RANGE } from './limits.js';
import { Bilingual, MaybeBilingual } from './bilingual.js';

const unit = () => z.number().min(UNIT_RANGE.min).max(UNIT_RANGE.max);

/**
 * 固定層。生成は絶対にこのファイルを書き換えない。
 * 書き込み可能な表現をどこにも作らないことが、検証ルールより強い保証になる。
 */
export const ProfileSchema = z.object({
  id: CharacterId,
  era: EraId,
  name: Bilingual,
  age: z.number().int().min(16).max(29),
  gender: z.enum(['male', 'female']),
  role: Bilingual,
  affiliation: z.string().min(1),
  /** 名の代わりに呼ばれる番号。人物ページの名札に出るので二言語で持つ。 */
  designation: Bilingual.optional(),

  appeal_axis: z.string().min(1),
  reader_distance: z.string().min(1),

  /**
   * World 詳細用の紹介文（feed の characters.json が出す。契約 §1.2）。
   * 読者が最初に読む2〜3文。core.secret_* に触れないこと——ここは秘密の
   * 「外側」だけを書く欄で、混入は npm run validate が検査する。
   */
  intro: Bilingual,

  core: z.object({
    wish: z.string().min(1),
    fear: z.string().min(1),
    contradiction: z.string().min(1),
    secret_hidden: z.string().min(1),
    secret_unknown_to_self: z.string().min(1),
    note: z.string().optional(),
  }),

  // register は生成プロンプト専用で、サイトへは出ない。出るものだけ二言語。
  voice: z.object({
    first_person: Bilingual,
    register: z.string().min(1),
    tic: Bilingual,
    never_says: Bilingual,
    closing: Bilingual,
  }),

  appraisal: z.object({
    question: Bilingual,
    focus: z.string().min(1),
    bias: Bilingual,
    humor: Bilingual,
    note: z.string().optional(),
  }),

  rare_expression: z.string().min(1),

  visual: z
    .object({
      build: z.string().min(1),
      hair: z.string().min(1),
      key_prop: z.string().min(1),
      palette: z.record(z.union([z.string(), z.array(z.string())])),
      acceptance: z.string().min(1),

      /**
       * 肖像 512×512 の切り出し元（sheet.png のピクセル座標、size は正方形の一辺）。
       * scripts/derive-portraits.ts がこれを読んで world/feed/portraits/<id>.png を作る。
       * シートを描き直したら、ここを合わせ直してから派生を作り直す。
       */
      portrait: z
        .object({
          x: z.number().int().min(0),
          y: z.number().int().min(0),
          size: z.number().int().min(1),
        })
        .optional(),

      /**
       * シートで確定した表記。`en` が絵に焼いた英字そのもので、描き直すときに
       * そのまま渡す文面である（docs/visual.md §3）。`ja` はその訳。
       *
       * サイトが出すのは captions と quote の2つだけなので、ここは `Bilingual`
       * を必須にする——訳が無ければ日本語ページに英語が残り、`/velum/en/` に
       * 日本語が出るのと同じ、読み手に見える欠陥になる。
       */
      sheet: z
        .object({
          base: z.string().min(1),
          captions: z.array(Bilingual).min(1),
          expressions: z.array(z.string().min(1)).min(1),
          quote: Bilingual,
        })
        .optional(),
    })
    .passthrough(),
});

/** 追記のみ。1日に最大1件の新事実。既存の書き換え・削除は生成側から行えない。 */
export const CanonSchema = z.object({
  id: CharacterId,
  /** 手で書く土台。追記されないので二言語を必須にできる。 */
  formative_events: z
    .array(
      z.object({
        id: z.string().min(1),
        fact: Bilingual,
      }),
    )
    .min(3),
  /** 日記の生成が1日1件まで追記する。生成が英語を出すまで素の文字列も受ける。 */
  facts: z.array(
    z.object({
      id: z.string().min(1),
      fact: MaybeBilingual,
      added_on: z.string().optional(),
      note: z.string().optional(),
    }),
  ),
});

/** 日次で動く層。差分で更新される。 */
export const CurrentStateSchema = z
  .object({
    id: CharacterId,
    updated_at: z.string().nullable(),
    mood: z.string().min(1),
    immediate_goal: z.string().min(1),
    doubt: z.string().min(1),
    concerns: z.array(z.string().min(1)),
    unresolved_thoughts: z.array(z.string().min(1)),
    traits: z.record(unit()),
    beliefs: z.record(unit()),
    habits: z.array(z.string().min(1)),
    /**
     * 数えているもの。カヤの「届けた人数」など、本人が口に出す数字。
     * プロンプトへ渡さないと、日記のたびに数が変わってしまう。
     */
    counters: z.record(z.number().int().min(0)).optional(),
  })
  .passthrough();

/**
 * 関係。関係者は独立した日記を持たないので、ここが彼らの唯一の記述場所になる。
 * hidden_from_protagonist は主人公が知らない事実であり、プロンプトへ渡してはいけない。
 */
export const RelationshipsSchema = z.object({
  id: CharacterId,
  people: z
    .array(
      z.object({
        id: z.string().min(1),
        name: Bilingual,
        relation: Bilingual,
        trust: unit(),
        wariness: unit(),
        summary: Bilingual,
        hidden_from_protagonist: z.string().optional(),
        visual: z.string().optional(),
        note: z.string().optional(),
        thread: z.string().optional(),

        /**
         * World 詳細用の紹介文（feed の characters.json が出す。契約 §1.2）。
         * 読者が最初に読む紹介文。summary（内部文）とは別物——秘密の「外側」
         * だけを書く欄で、混入は npm run validate が検査する。
         */
        intro: Bilingual,
        /**
         * 公開面（feed）で relation の代わりに使うラベル。無ければ relation を
         * そのまま出す。設定するのは2つの場合だけ:
         *   1. relation 自体が秘密に触れる（例: teo/lowe の「贋作師」を隠す）
         *   2. relation が「A・B」の中黒連結——執筆者向けのメモ体裁であり、
         *      名前の隣に出る短いラベルとしては読ませられない
         */
        public_relation: Bilingual.optional(),
      }),
    )
    .length(2), // 主人公1人につき関係者2人
});

export const MemoriesSchema = z.object({
  id: CharacterId,
  memories: z.array(
    z.object({
      id: z.string().min(1),
      summary: z.string().min(1),
      importance: z
        .number()
        .min(MEMORY_IMPORTANCE.min)
        .max(MEMORY_IMPORTANCE.max),
      formed_on: z.string(),
    }),
  ),
});

export type Profile = z.infer<typeof ProfileSchema>;
export type Canon = z.infer<typeof CanonSchema>;
export type CurrentState = z.infer<typeof CurrentStateSchema>;
export type Relationships = z.infer<typeof RelationshipsSchema>;
export type Memories = z.infer<typeof MemoriesSchema>;
