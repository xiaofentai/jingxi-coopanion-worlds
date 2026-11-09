/** 临时替身：只在本地冒烟测试里顶替宿主提供的 `cortico/core/language.ts`。 */
export type Language = string;

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && value.length > 0;
}
