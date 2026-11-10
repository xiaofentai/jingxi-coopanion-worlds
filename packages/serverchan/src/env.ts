/**
 * 部署目录里那两样不进设置页的东西：`.env` 里的 SendKey 与 `config.json` 里的语言。
 *
 * 密钥留在设置页的 `worlds.serverchan.sendkey` 里也行，但 `.env` 更不容易被备份、截图、
 * 贴进对话时带出去，所以设置留空时来这里找。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Language } from 'cortico/core/language.ts';

/** 设置页留空时读这个名字。 */
export const ENV_SENDKEY = 'SERVERCHAN_SENDKEY';

/** 读 `.env` 里的一个值：`export FOO=bar`、单双引号、行尾注释都认；没有就回空串。 */
export function dotEnvValue(file: string, name: string): string {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return '';
  }
  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const at = body.indexOf('=');
    if (at <= 0) continue;
    if (body.slice(0, at).trim() !== name) continue;
    return unquote(body.slice(at + 1).trim());
  }
  return '';
}

function unquote(value: string): string {
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const end = value.indexOf(quote, 1);
    if (end > 0) return value.slice(1, end);
  }
  const comment = value.indexOf(' #');
  return (comment === -1 ? value : value.slice(0, comment)).trim();
}

/** `config.json` 里的语言；读不到或写坏了都当中文。 */
export function readLanguage(botDir: string): Language {
  try {
    const raw = JSON.parse(readFileSync(join(botDir, 'config.json'), 'utf8')) as { language?: unknown };
    if (typeof raw.language === 'string' && raw.language.trim()) return raw.language as Language;
  } catch {
    // 默认中文
  }
  return 'zh';
}
