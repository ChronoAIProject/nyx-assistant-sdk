import { widgetMessages } from "./widget-messages.ts";

export type MessageKey = keyof typeof widgetMessages.zh;

export function widgetText(lang: string, key: MessageKey, value = "") {
  const entry = widgetMessages[lang.toLowerCase().split("-")[0] === "en" ? "en" : "zh"][key];
  return typeof entry === "function" ? entry(value) : entry.replace("{value}", () => value);
}

/** Keeps the original diagnostic for programmatic callers and its translation for the widget. */
export class LocalizedError extends Error {
  readonly key: MessageKey;
  readonly value: string;
  constructor(key: MessageKey, value = "", diagnosticLang = "zh") {
    super(widgetText(diagnosticLang, key, value));
    this.key = key;
    this.value = value;
  }
}
