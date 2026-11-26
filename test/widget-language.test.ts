import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("", { url: "https://example.test" });
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
