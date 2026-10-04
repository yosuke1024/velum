import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DRAFT_FRAMING,
  PROBE_FRAMING,
  PROBE_INSTRUCTIONS,
  PROBE_PROMPT,
  REVISE_FRAMING,
  attachment,
  draftPrompt,
  revisePrompt,
} from '../../src/story/authoring/prompt.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const material = (relative: string): Buffer => readFileSync(join(REPO_ROOT, relative));

const CLOSE = '</attachment>';

type RevisePromptInput = Parameters<typeof revisePrompt>[0];

/** 検査が実際に投げたことを確かめる（スタブの 'not implemented' では合格にしない）。 */
function expectBoundaryError(fn: () => unknown): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).not.toMatch(/not implemented/i);
}

describe('attachment', () => {
  it('filename と中身を <attachment> で囲む', () => {
    expect(attachment('a.md', 'x')).toBe('<attachment filename="a.md">\nx\n</attachment>');
  });

  it('中身がすでに改行で終わっていれば、改行を足さない', () => {
    expect(attachment('a.md', 'x\n')).toBe('<attachment filename="a.md">\nx\n</attachment>');
  });

  it('中身の末尾の空行は、そのまま残す', () => {
    expect(attachment('a.md', 'x\n\n')).toBe('<attachment filename="a.md">\nx\n\n</attachment>');
  });

  it('中身の先頭の空行・字下げ・行末の空白・CRLF を変えない', () => {
    expect(attachment('a.md', '\n\n  　x  \r\ny\r\n\n')).toBe(
      '<attachment filename="a.md">\n\n\n  　x  \r\ny\r\n\n</attachment>',
    );
  });

  it('filename の " < & > を文字参照にする', () => {
    expect(attachment('"<&>', 'x')).toBe(
      '<attachment filename="&quot;&lt;&amp;&gt;">\nx\n</attachment>',
    );
  });

  it('filename に元から文字参照のような文字列があれば、& を先に文字参照にする', () => {
    expect(attachment('a&lt;b.md', 'x')).toBe('<attachment filename="a&amp;lt;b.md">\nx\n</attachment>');
  });

  it('日本語の filename はそのまま入れる', () => {
    expect(attachment('設定資料.md', 'x')).toBe('<attachment filename="設定資料.md">\nx\n</attachment>');
  });

  it('中身に </attachment> があれば投げる（境界が曖昧になる）', () => {
    expectBoundaryError(() => attachment('a.md', `前\n${CLOSE}\n後`));
    expectBoundaryError(() => attachment('a.md', `途中で${CLOSE}`));
  });
});

describe('draftPrompt', () => {
  it('brief の添付、空行、依頼文の全文の順に並べる', () => {
    expect(draftPrompt({ briefName: 'b.md', brief: 'B\n', request: 'R\n' })).toBe(
      '<attachment filename="b.md">\nB\n</attachment>\n\nR\n',
    );
  });

  it('brief の末尾に改行が無ければ足してから閉じる。依頼文には何も足さない', () => {
    expect(draftPrompt({ briefName: 'b.md', brief: 'B', request: 'R' })).toBe(
      '<attachment filename="b.md">\nB\n</attachment>\n\nR',
    );
  });

  it('依頼文は一字も変えない（先頭の空行・行末の空白・CRLF も）', () => {
    const request = '\n  依頼  \r\n続き  \r\n\n';
    const prompt = draftPrompt({ briefName: 'b.md', brief: 'B\n', request });
    expect(prompt).toBe(`<attachment filename="b.md">\nB\n</attachment>\n\n${request}`);
    expect(prompt.endsWith(request)).toBe(true);
  });

  it('brief の CRLF は正規化せず、そのまま入れる', () => {
    const brief = '一行目\r\n二行目\r\n';
    const prompt = draftPrompt({ briefName: 'b.md', brief, request: 'R\n' });
    expect(prompt).toBe('<attachment filename="b.md">\n一行目\r\n二行目\r\n</attachment>\n\nR\n');
    expect(prompt).toContain('一行目\r\n二行目\r\n');
  });

  it('briefName は添付の filename になり、文字参照にする', () => {
    const prompt = draftPrompt({ briefName: 'a"b.md', brief: 'B\n', request: 'R\n' });
    expect(prompt.startsWith('<attachment filename="a&quot;b.md">\n')).toBe(true);
  });

  it('brief に </attachment> があれば投げる', () => {
    expectBoundaryError(() =>
      draftPrompt({ briefName: 'b.md', brief: `前${CLOSE}後\n`, request: 'R\n' }),
    );
  });
});

describe('revisePrompt', () => {
  const input = {
    briefName: 'b.md',
    brief: '設定資料の全文。\n行末の空白  \n',
    manuscriptName: 'm.md',
    manuscript: '# 題\n\n原稿の全文。\r\n続き。\n',
    feedback: '直しの依頼。\n二行目。',
  } as const;

  it('brief の添付、原稿の添付、フィードバックの順に並ぶ', () => {
    const prompt = revisePrompt(input);
    const briefAttachment = attachment(input.briefName, input.brief);
    const manuscriptAttachment = attachment(input.manuscriptName, input.manuscript);

    expect(prompt.startsWith(briefAttachment)).toBe(true);
    const afterBrief = prompt.slice(briefAttachment.length);
    const manuscriptAt = afterBrief.indexOf(manuscriptAttachment);
    expect(manuscriptAt).toBeGreaterThan(0);
    expect(afterBrief.slice(0, manuscriptAt)).toMatch(/^\s+$/);

    const afterManuscript = afterBrief.slice(manuscriptAt + manuscriptAttachment.length);
    expect(afterManuscript.endsWith(input.feedback)).toBe(true);
    expect(afterManuscript.slice(0, afterManuscript.length - input.feedback.length)).toMatch(/^\s+$/);
  });

  it('原稿の添付の filename は manuscriptName', () => {
    const prompt = revisePrompt(input);
    expect(prompt).toContain('<attachment filename="m.md">\n');
    expect(prompt).toContain('<attachment filename="b.md">\n');
  });

  it('枠と3つの入力のほかに、コードは何も書き足さない', () => {
    const prompt = revisePrompt(input);
    const rest = prompt
      .replace(attachment(input.briefName, input.brief), '')
      .replace(attachment(input.manuscriptName, input.manuscript), '');
    expect(rest.endsWith(input.feedback)).toBe(true);
    expect(rest.slice(0, rest.length - input.feedback.length).trim()).toBe('');
  });

  it('20000字の原稿も、全文を入れる（要約・切り詰めをしない）', () => {
    const manuscript = Array.from({ length: 20000 }, (_, i) =>
      i % 400 === 399 ? '\n' : String.fromCharCode(0x3041 + (i % 80)),
    ).join('');
    expect([...manuscript].length).toBe(20000);
    const prompt = revisePrompt({ ...input, manuscript });
    expect(prompt).toContain(manuscript);
    expect(prompt).toContain(attachment('m.md', manuscript));
  });

  it('フィードバックは一字も変えず、末尾に置く（CRLF・末尾の改行なしも）', () => {
    const feedback = '  先頭の空白あり\r\n二行目  ';
    const prompt = revisePrompt({ ...input, feedback });
    expect(prompt.endsWith(feedback)).toBe(true);
    expect(prompt.slice(0, prompt.length - feedback.length).endsWith('\n')).toBe(true);
  });

  it('brief の CRLF と原稿の CRLF は、そのまま入れる', () => {
    const prompt = revisePrompt({
      ...input,
      brief: '資料\r\n',
      manuscript: '原稿\r\n',
    });
    expect(prompt).toContain('資料\r\n</attachment>');
    expect(prompt).toContain('原稿\r\n</attachment>');
  });

  const withClose: Array<[string, Partial<RevisePromptInput>]> = [
    ['brief', { brief: `前${CLOSE}後\n` }],
    ['manuscript', { manuscript: `前\n${CLOSE}\n後\n` }],
    ['feedback', { feedback: `前${CLOSE}後` }],
  ];
  it.each(withClose)('%s に </attachment> があれば投げる', (_name, override) => {
    expectBoundaryError(() => revisePrompt({ ...input, ...override }));
  });
});

describe('実際の materials（brief と最初の依頼文）', () => {
  const BRIEF_NAME = 'velum_riko_writing_brief.md';

  it('brief は添付の中に1バイトも変わらず入る', () => {
    const briefBytes = material('authoring/briefs/velum_riko_writing_brief.md');
    const requestBytes = material('authoring/prompts/riko-first-request.txt');
    const prompt = draftPrompt({
      briefName: BRIEF_NAME,
      brief: briefBytes.toString('utf8'),
      request: requestBytes.toString('utf8'),
    });

    const opening = `<attachment filename="${BRIEF_NAME}">\n`;
    expect(prompt.startsWith(opening)).toBe(true);
    const closeAt = prompt.indexOf(CLOSE);
    expect(closeAt).toBeGreaterThan(opening.length);
    const inner = prompt.slice(opening.length, closeAt);
    expect(sha256(Buffer.from(inner, 'utf8'))).toBe(sha256(briefBytes));
  });

  it('プロンプトの末尾は依頼文そのもの（1バイトも変わらない）', () => {
    const briefBytes = material('authoring/briefs/velum_riko_writing_brief.md');
    const requestBytes = material('authoring/prompts/riko-first-request.txt');
    const request = requestBytes.toString('utf8');
    const prompt = draftPrompt({
      briefName: BRIEF_NAME,
      brief: briefBytes.toString('utf8'),
      request,
    });

    expect(prompt.endsWith(request)).toBe(true);
    const closeAt = prompt.indexOf(CLOSE);
    const tail = prompt.slice(closeAt + CLOSE.length);
    expect(tail.startsWith('\n\n')).toBe(true);
    expect(sha256(Buffer.from(tail.slice(2), 'utf8'))).toBe(sha256(requestBytes));
  });

  it('枠・brief・依頼文のほかに、コードは何も書き足さない', () => {
    const briefBytes = material('authoring/briefs/velum_riko_writing_brief.md');
    const requestBytes = material('authoring/prompts/riko-first-request.txt');
    const brief = briefBytes.toString('utf8');
    const request = requestBytes.toString('utf8');
    const prompt = draftPrompt({ briefName: BRIEF_NAME, brief, request });
    const expectedLength =
      `<attachment filename="${BRIEF_NAME}">\n`.length +
      brief.length +
      (brief.endsWith('\n') ? 0 : 1) +
      `${CLOSE}\n\n`.length +
      request.length;
    expect(prompt.length).toBe(expectedLength);
  });
});

describe('framing の版と probe の固定入力', () => {
  it('DRAFT / REVISE / PROBE の framing は、空でなく、互いに違う', () => {
    const framings = [DRAFT_FRAMING, REVISE_FRAMING, PROBE_FRAMING];
    for (const framing of framings) expect(framing.length).toBeGreaterThan(0);
    expect(new Set(framings).size).toBe(3);
  });

  it('PROBE_PROMPT と PROBE_INSTRUCTIONS は短く、人物の名前を含まない', () => {
    for (const text of [PROBE_PROMPT, PROBE_INSTRUCTIONS]) {
      expect(text.length).toBeGreaterThan(0);
      expect(text.length).toBeLessThan(200);
      expect(text).not.toContain('リコ');
    }
  });

  it('probe の入力には、執筆の資料（添付の枠）を含めない', () => {
    expect(PROBE_PROMPT).not.toContain('<attachment');
    expect(PROBE_INSTRUCTIONS).not.toContain('<attachment');
  });
});
