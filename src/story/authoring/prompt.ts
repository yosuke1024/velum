/**
 * Astra へ stdin で渡す依頼文の組み立て（純粋関数だけ）。
 *
 * 初稿で渡すのは原則3つだけ: 最小限の執筆用指示（model_instructions_file。ここでは組まない）、
 * 承認済みの writing brief、今回の依頼文。brief と依頼文は**一字も変えずに**入れる。
 * コードが足すのは、添付の境界を示す枠（<attachment filename="..."> … </attachment>）だけで、
 * 枠の形は framing の版（DRAFT_FRAMING / REVISE_FRAMING）として run.json に残す。
 *
 * Web の試作では brief をプロジェクトの資料として添付し、依頼文が「設定資料「<ファイル名>」を使って」と
 * 名前で指していた。だから添付の filename には、元のファイル名をそのまま使う。
 *
 * 形（draft）:
 *
 *   <attachment filename="velum_riko_writing_brief.md">
 *   …brief の全文…
 *   </attachment>
 *
 *   …依頼文の全文…
 *
 * 形（revise）: brief の添付、原稿の添付（filename は manuscriptName）、そのあとにフィードバックの全文。
 * 区切りは draft と同じ空行1つ。brief と原稿のあいだは `</attachment>\n\n<attachment …>`、原稿とフィードバックの
 * あいだは `</attachment>\n\n` で、そのあとにフィードバックを**そのまま**置く（`<feedback>` などのタグや枠は付けない。
 * フィードバックは添付ではなく、依頼文と同じく一字も変えない）。
 * 改稿は元の原稿の**全文**を渡す（要約で代用しない）。依頼文・フィードバックの末尾には何も足さない。
 *
 * 添付の中身の末尾に改行が無ければ1つ足してから </attachment> を置く（中身は変えない）。
 * 中身・依頼文・フィードバックに `</attachment>` という文字列があれば、境界が曖昧になるので投げる。
 * filename の `&` `"` `<` `>` は文字参照にする。
 */

export const DRAFT_FRAMING = 'velum-astra-draft-v1';
export const REVISE_FRAMING = 'velum-astra-revise-v1';
export const PROBE_FRAMING = 'velum-astra-probe-v1';

/** 添付の終わりを示すタグ。中身にこれがあると、どこまでが添付か読み手に分からなくなる。 */
const CLOSING_TAG = '</attachment>';

/** 属性値として安全にする。`&` を先に変える（後だと、変えた結果の `&` をさらに変えてしまう）。 */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 入力の中に添付の終わりのタグがあれば投げる。黙って直したり落としたりはしない
 * （入力を一字も変えない約束なので、境界が曖昧になる入力はそもそも受け付けない）。
 */
function assertNoClosingTag(label: string, text: string): void {
  if (text.includes(CLOSING_TAG)) {
    throw new Error(
      `${label}に ${CLOSING_TAG} という文字列が含まれている。添付の境界が曖昧になるので組み立てられない`,
    );
  }
}

export function attachment(filename: string, content: string): string {
  assertNoClosingTag(`添付「${filename}」の中身`, content);
  // 中身は一字も変えない。末尾に改行が無いときだけ、タグを行頭に置くために1つ足す。
  const terminated = content.endsWith('\n') ? content : `${content}\n`;
  return `<attachment filename="${escapeAttribute(filename)}">\n${terminated}${CLOSING_TAG}`;
}

export function draftPrompt(input: { briefName: string; brief: string; request: string }): string {
  assertNoClosingTag('依頼文', input.request);
  // 依頼文は添付ではないので、枠で囲まず、末尾にも何も足さない。
  return `${attachment(input.briefName, input.brief)}\n\n${input.request}`;
}

export function revisePrompt(input: {
  briefName: string;
  brief: string;
  manuscriptName: string;
  manuscript: string;
  feedback: string;
}): string {
  assertNoClosingTag('フィードバック', input.feedback);
  // 原稿は要約せず全文を添付する。フィードバックは添付ではなく、空行1つのあとに全文を置く。
  return [
    attachment(input.briefName, input.brief),
    attachment(input.manuscriptName, input.manuscript),
    input.feedback,
  ].join('\n\n');
}

/**
 * doctor --probe の固定の入力。Astra が呼べて、この設定で応答が返ることだけを確かめる短いもの。
 * 執筆の資料は一切含めない。
 */
export const PROBE_INSTRUCTIONS = '日本語で、短く答えてください。\n';
export const PROBE_PROMPT = '動作確認です。「準備完了」とだけ返してください。\n';
