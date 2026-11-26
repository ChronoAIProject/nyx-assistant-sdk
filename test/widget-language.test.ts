import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<html lang="zh-CN"></html>', { url: "https://example.test" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, location: dom.window.location });
const { NyxAssistantElement } = await import("../src/widget.ts");
dom.window.customElements.define("nyx-assistant", NyxAssistantElement);

test("changing widget language preserves its inputs and localizes a pending authorization failure", async () => {
  const widget = document.createElement("nyx-assistant");
  widget.dataset.nyxid = "https://example.test";
  document.body.append(widget);
  const view = widget.shadowRoot!;
  const input = view.querySelector("textarea")!;
  input.value = "keep my draft";
  assert.equal(view.querySelector(".connect")!.textContent, "连接 NyxID");
  widget.lang = "en-US";
  assert.equal(view.querySelector(".connect")!.textContent, "Connect to NyxID");
  assert.equal(input.getAttribute("aria-label"), "Message");
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(null, { status: 403 });
    view.querySelector<HTMLButtonElement>(".connect")!.click();
    await new Promise<void>((resolve) => {
      const observer = new dom.window.MutationObserver(() => {
        if (view.querySelector(".status")!.textContent.includes("403")) {
          observer.disconnect();
          resolve();
        }
      });
      observer.observe(view.querySelector(".status")!, { childList: true });
    });
    assert.match(view.querySelector(".status")!.textContent, /authorization request failed \(HTTP 403\)/);
    widget.lang = "zh-CN";
    assert.match(view.querySelector(".status")!.textContent, /授权请求失败（HTTP 403）/);
    assert.equal(input.value, "keep my draft");
  } finally {
    globalThis.fetch = original;
    widget.remove();
  }
});

test("a widget inherits page language and keeps the connected host when language changes", async () => {
  document.documentElement.lang = "en-GB";
  const widget = new NyxAssistantElement();
  widget.dataset.proxy = "/";
  document.body.append(widget);
  try {
    const view = widget.shadowRoot!;
    const input = view.querySelector("textarea")!;
    const host = widget.host;
    input.value = "draft";
    assert.equal(input.placeholder, "Message Nyx…");
    document.documentElement.lang = "zh-Hans";
    await Promise.resolve();
    assert.equal(input.placeholder, "给 Nyx 发消息…");
    widget.lang = "en-AU";
    assert.equal(input.placeholder, "Message Nyx…");
    assert.equal(input.value, "draft");
    assert.equal(widget.host, host);
    widget.removeAttribute("lang");
    assert.equal(input.placeholder, "给 Nyx 发消息…");
  } finally {
    widget.remove();
    document.documentElement.lang = "zh-CN";
  }
});

test("browser language preferences are tried in order with Chinese as the final fallback", () => {
  document.documentElement.removeAttribute("lang");
  const navigator = dom.window.navigator;
  const widget = new NyxAssistantElement();
  widget.dataset.proxy = "/";
  try {
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["fr-FR", "en-CA"] });
    document.body.append(widget);
    const title = widget.shadowRoot!.querySelector(".title-label")!;
    assert.equal(title.textContent, "Nyx Assistant");
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["invalid tag", "fr-FR"] });
    window.dispatchEvent(new dom.window.Event("languagechange"));
    assert.equal(title.textContent, "Nyx 助手");
  } finally {
    widget.remove();
    Reflect.deleteProperty(navigator, "languages");
    document.documentElement.lang = "zh-CN";
  }
});
