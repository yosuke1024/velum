import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { parse, stringify } from 'yaml';
import type { ZodTypeAny, z } from 'zod';

export function readYaml<S extends ZodTypeAny>(
  path: string,
  schema: S,
): z.infer<S> {
  const raw = parse(readFileSync(path, 'utf8'));
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'} — ${i.message}`)
      .join('\n  ');
    throw new Error(`${path} がスキーマに合いません:\n  ${issues}`);
  }
  return result.data;
}

export function writeYaml(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    stringify(value, { lineWidth: 0, defaultStringType: 'PLAIN' }),
    'utf8',
  );
}

export function readJson<S extends ZodTypeAny>(
  path: string,
  schema: S,
): z.infer<S> {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'} — ${i.message}`)
      .join('\n  ');
    throw new Error(`${path} がスキーマに合いません:\n  ${issues}`);
  }
  return result.data;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
}

export const exists = (path: string): boolean => existsSync(path);

/**
 * datedPath で <YYYY>/<MM>/ へ割ったファイルを、古い順に列挙する。
 * ディレクトリ名が日付そのものなので、名前順が日付順になる。
 */
export function listDatedFiles(root: string, suffix: string): string[] {
  if (!existsSync(root)) return [];

  const files: string[] = [];
  for (const year of readdirSync(root).sort()) {
    const yearDir = join(root, year);
    for (const month of readdirSync(yearDir).sort()) {
      const monthDir = join(yearDir, month);
      for (const file of readdirSync(monthDir).sort()) {
        if (file.endsWith(suffix)) files.push(join(monthDir, file));
      }
    }
  }
  return files;
}
