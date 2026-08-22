/**
 * 生成が1日に動かせる量の上限。
 *
 * この定数はスキーマ・バリデータ・プロンプトの三者が同じものを読む。
 * バリデータが落とせる上限をプロンプトが伝えていない状態は、厳格なゲートではなく罠である。
 * プロンプト生成側は必ずここから文面を組み立てること。
 */
export const PATCH_LIMITS = {
  /** 関係値（trust / wariness）の1日あたりの最大変化量 */
  relationshipDelta: 0.05,
  /** 1日に patch できる関係の数。自分自身は対象にできない */
  relationshipsPerDay: 2,
  /** 性格特性の1日あたりの最大変化量 */
  traitDelta: 0.05,
  /** 1日に調整できる特性の数 */
  traitsPerDay: 2,
  /** 信念の1日あたりの最大変化量 */
  beliefDelta: 0.1,
  /** 1日に調整できる信念の数 */
  beliefsPerDay: 1,
  /** 1日に追加できる懸念の数 */
  newConcerns: 2,
  /** 1日に追加できる未解決の思考の数 */
  newUnresolvedThoughts: 2,
  /** 1日に昇格できる長期記憶の数 */
  newMemories: 1,
  /** 1日に追記できる canon 事実の数 */
  newCanonFacts: 1,
  /**
   * 数えているもの（カヤの届けた人数など）の1日あたりの最大増分。
   * 減らすことはできない——届けた人数は減らない。
   */
  counterDelta: 5,
} as const;

/**
 * 長期記憶の重み。
 * どの記憶を先に忘れるかを決める重みであり、1〜5 の評価ではない。
 */
export const MEMORY_IMPORTANCE = { min: 0, max: 1 } as const;

/** 関係値・特性・信念に共通の値域 */
export const UNIT_RANGE = { min: 0, max: 1 } as const;

/**
 * 上限違反の扱い。
 *
 * fatal   — その日を破棄する。状態ファイルにも公開ページにも到達しない。
 * truncate — 警告して切り詰める。翌日のプロンプトに載るだけのもの。
 *
 * クランプは壊れたプロンプトを「それらしく見える状態」の裏に隠す。
 * 欠けた1日は目に見える。だから届く先が状態ファイルか描画かであるものは fatal にする。
 */
export const VIOLATION_POLICY = {
  relationshipDelta: 'fatal',
  relationshipsPerDay: 'fatal',
  relationshipTargetUnknown: 'fatal',
  relationshipTargetSelf: 'fatal',
  relationshipPatchedTwice: 'fatal',
  traitDelta: 'fatal',
  beliefDelta: 'fatal',
  memoryImportanceRange: 'fatal',
  newMemories: 'fatal',
  newCanonFacts: 'fatal',
  counterDelta: 'fatal',
  counterUnknown: 'fatal',
  diaryTooShort: 'fatal',
  newConcerns: 'truncate',
  newUnresolvedThoughts: 'truncate',
} as const;

/** 日記本文の下限・上限（文字数） */
export const TEXT_LIMITS = {
  diaryBodyMinJa: 200,
  diaryBodyMaxJa: 1200,
  titleMin: 2,
  titleMax: 40,
} as const;

/**
 * Persona Snapshot の生成が返すものの上限。
 *
 * PATCH_LIMITS と同じ規律で扱う——ゲートとプロンプトの両者がここを読み、
 * tests/unit/snapshot.test.ts がキーを走査して、プロンプトに書かれていない上限を検出する。
 *
 * Snapshot の中身はすべて PixTale の Tale コメントへ届く。したがって
 * 切り詰め（truncate）はなく、違反はすべてその回の破棄である。
 * 切り詰めれば、上限を超えたぶんだけ人格が静かに欠けた Snapshot が
 * 「それらしく見える形」で PixTale へ流れていく。
 */
export const SNAPSHOT_LIMITS = {
  /** 人生が残した癖として書ける件数 */
  dispositions: 6,
  /** 癖ひとつの長さ（文字） */
  dispositionMaxJa: 60,
} as const;

/**
 * Snapshot へ載せる量。
 *
 * 上限ではなく選択である——生成が決めるのではなく、こちらが人生から抜き出す数を決める。
 * プロンプトへ書く必要がないのはこのためで、SNAPSHOT_LIMITS とは別に置いてある。
 */
export const SNAPSHOT_SELECTION = {
  /** importance の高い順に載せる長期記憶の数 */
  memories: 8,
  /** 人生の事実として載せる canon の追記の数（新しいものから） */
  canonFacts: 8,
  /** いま気にかかっていること・片づいていない考えの、それぞれの件数 */
  standing: 4,
} as const;
