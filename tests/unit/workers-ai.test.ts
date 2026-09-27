import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  toStandardJsonSchema,
  extractText,
  extractFinishReason,
  stripModelDecorations,
  generateJsonWorkersAi,
  WORKERS_AI_DEFAULT_MODEL,
} from '../../src/lib/workers-ai.js';
import { LlmError, jsonSchema } from '../../src/lib/llm.js';
import { DIARY_RESPONSE_SCHEMA } from '../../src/diary/prompt.js';
import { SEASON_RESPONSE_SCHEMA } from '../../src/season/prompt.js';

describe('Workers AI へ渡すスキーマ', () => {
  it('nullable を anyOf [型, null] に書き換える', () => {
    const converted = toStandardJsonSchema(jsonSchema.nullable(jsonSchema.string()));
    expect(converted).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] });
  });

  it('properties と items の中まで書き換え、nullable を残さない', () => {
    for (const schema of [DIARY_RESPONSE_SCHEMA, SEASON_RESPONSE_SCHEMA]) {
      const text = JSON.stringify(toStandardJsonSchema(schema));
      expect(text).not.toContain('nullable');
      expect(text).toContain('"anyOf"');
    }
  });

  it('冪等である', () => {
    const once = toStandardJsonSchema(DIARY_RESPONSE_SCHEMA);
    expect(toStandardJsonSchema(once)).toEqual(once);
  });

  it('nullable という名前のプロパティは書き換えない', () => {
    // 「properties の中のキー」は名前であって指示ではない。
    const schema = jsonSchema.object({ nullable: jsonSchema.boolean() }, ['nullable']);
    expect(toStandardJsonSchema(schema)).toEqual(schema);
  });
});

describe('応答の本文の取り出し', () => {
  it('OpenAI 形（choices）の文字列と text パート', () => {
    expect(extractText({ choices: [{ message: { content: '{"a":1}' } }] })).toBe('{"a":1}');
    expect(
      extractText({
        choices: [{ message: { content: [{ type: 'text', text: '{"a"' }, { type: 'text', text: ':1}' }] } }],
      }),
    ).toBe('{"a":1}');
  });

  it('旧来の形（response）は文字列でも解析済みでも受ける', () => {
    expect(extractText({ response: '{"a":1}' })).toBe('{"a":1}');
    expect(extractText({ response: { a: 1 } })).toBe('{"a":1}');
  });

  it('読めない形は null', () => {
    expect(extractText(null)).toBeNull();
    expect(extractText({ choices: [] })).toBeNull();
    expect(extractText({ other: 1 })).toBeNull();
  });

  it('finish_reason を読む', () => {
    expect(extractFinishReason({ choices: [{ finish_reason: 'length' }] })).toBe('length');
    expect(extractFinishReason({ response: 'x' })).toBeNull();
  });
});

describe('思考タグとコードフェンスの除去', () => {
  it('先頭の思考ブロックとフェンスを剥がし、JSON 本体だけを残す', () => {
    const text = '<think>考え中</think>\n```json\n{"a": "b}c"}\n```\n以上です。';
    expect(stripModelDecorations(text)).toBe('{"a": "b}c"}');
  });

  it('きれいな JSON には手を出さない', () => {
    const clean = '{"title_ja":"<think>は本文の一部</think>","n":[1,2]}';
    expect(stripModelDecorations(clean)).toBe(clean);
  });

  it('尻切れは開き括弧から末尾までを返し、JSON.parse を失敗させる', () => {
    const cut = stripModelDecorations('{"a": [1, 2');
    expect(cut).toBe('{"a": [1, 2');
    expect(() => JSON.parse(cut)).toThrow();
  });
});

describe('generateJsonWorkersAi', () => {
  const schema = z.object({ title_ja: z.string(), note: z.string().nullable() });
  const request = {
    system: 'sys',
    user: 'usr',
    responseSchema: jsonSchema.object(
      { title_ja: jsonSchema.string(), note: jsonSchema.nullable(jsonSchema.string()) },
      ['title_ja', 'note'],
    ),
  };

  beforeEach(() => {
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'acct');
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'tok');
    vi.stubEnv('VELUM_MODEL', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('JSON mode で呼び、本文を検証して返す', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          success: true,
          errors: [],
          result: {
            choices: [
              { finish_reason: 'stop', message: { content: '```json\n{"title_ja":"題","note":null}\n```' } },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, neurons: 1 },
          },
        }),
        { status: 200 },
      );
    });

    const result = await generateJsonWorkersAi(request, schema);
    expect(result.data).toEqual({ title_ja: '題', note: null });
    expect(result.model).toBe(WORKERS_AI_DEFAULT_MODEL);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/acct/ai/run/${WORKERS_AI_DEFAULT_MODEL}`,
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok');
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ]);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.max_completion_tokens).toBe(8192);
    expect(body.response_format.type).toBe('json_schema');
    expect(JSON.stringify(body.response_format.json_schema)).not.toContain('nullable');
  });

  it('鍵が無ければ呼ばずに止まる', async () => {
    vi.stubEnv('CLOUDFLARE_API_TOKEN', '');
    await expect(generateJsonWorkersAi(request, schema)).rejects.toThrow(/CLOUDFLARE_ACCOUNT_ID/);
  });

  it('認証エラー（4xx）は再試行しない', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return new Response('{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}', {
        status: 401,
      });
    });
    await expect(generateJsonWorkersAi(request, schema, { attempts: 3 })).rejects.toMatchObject({
      name: 'LlmError',
      status: 401,
      retryable: false,
    });
    expect(calls).toBe(1);
  });

  it('尻切れ（finish_reason: length）は上限の変数名を挙げて失敗する', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(
        JSON.stringify({
          success: true,
          result: { choices: [{ finish_reason: 'length', message: { content: '{"title_ja":"' } }] },
        }),
        { status: 200 },
      ),
    );
    const error = await generateJsonWorkersAi(request, schema, { attempts: 1 }).catch((e) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).message).toContain('VELUM_MAX_TOKENS');
    expect((error as LlmError).retryable).toBe(true);
  });
});
