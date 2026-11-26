import { messages } from "./messages.ts";

// SDK callers have historically received English diagnostics. The UI defaults to Chinese.
export const diagnosticLocale = "en";
export const defaultLocale = "zh";
type Locale = keyof typeof messages;
const localeNames = Object.keys(messages) as Locale[];
const supported = new Map(localeNames.map(locale => [locale.toLowerCase(), locale]));
export type MessageKey = keyof typeof messages[typeof defaultLocale];

export function resolveLocale(...preferences: string[]): Locale {
  for (const preference of preferences) {
    if (Object.hasOwn(messages, preference)) return preference as Locale;
    let tag: string;
    try { tag = new Intl.Locale(preference.trim()).baseName.toLowerCase(); }
    catch { continue; }
    while (tag) {
      const match = supported.get(tag);
      if (match) return match;
      const separator = tag.lastIndexOf("-");
      if (separator < 0) break;
      tag = tag.slice(0, separator);
    }
  }
  return defaultLocale;
}

export function translate(language: string, key: MessageKey, value = "") {
  return messages[resolveLocale(language)][key].replaceAll("{value}", () => value);
}

export class LocalizedError extends Error {
  readonly key: MessageKey;
  readonly value: string;
  constructor(key: MessageKey, value = "", language: string = diagnosticLocale, options?: ErrorOptions) {
    super(translate(language, key, value), options);
    this.key = key;
    this.value = value;
  }
  localize(language: string) {
    return translate(language, this.key, this.value);
  }
}
