import assert from "node:assert/strict";
import { test } from "node:test";
import { officialRelay } from "../src/relay.ts";
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

for (const voiceEnabled of [true, false]) {
  test(`widget requests configured chat and voice services together (voice=${voiceEnabled})`, async t => {
    const widget = new NyxAssistantElement();
    widget.dataset.storage = "memory";
    if (!voiceEnabled) widget.dataset.keySource = "new";
    if (!voiceEnabled) widget.dataset.voice = "false";
    const services = ["chrono-llm-public", "llm-nyx"];
    if (voiceEnabled) services.push("llm-openai");
    let requests = 0;
    t.mock.method(globalThis, "fetch", async (input: URL, init: RequestInit) => {
      assert.equal(input.origin, officialRelay);
      if (input.pathname.endsWith("/request")) {
        requests++;
        assert.equal(JSON.parse(String(init.body)).requested_profile, "nyx-widget");
        return Response.json({ device_code: "device", user_code: "ABC-DEF",
          verification_uri: "https://nyxid.ai/login/agent-key", interval: 1, expires_in: 60 });
      }
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({ credential: "test-child", credential_id: "first", api_key: {
        id: "widget-key", owner_id: "me", scopes: "proxy", allow_all_services: false, allow_all_nodes: false,
        allow_auto_connected_services: false, allowed_node_ids: [], allowed_service_ids: services,
        effective_services: services.map(slug => ({ id: slug, slug, is_active: true })),
      } });
    });
    document.body.append(widget);
    try {
      assert.equal(widget.voiceEnabled, voiceEnabled);
      widget.connect();
      await new Promise(resolve => setTimeout(resolve, 0));
      const view = widget.shadowRoot!;
      const login = new URL(view.querySelector<HTMLAnchorElement>(".verify")!.href);
      assert.equal(login.origin, "https://nyxid.ai");
      assert.equal(login.searchParams.get("key_source"), "new");
      assert.equal(login.searchParams.get("permissions"), "proxy");
      assert.deepEqual(login.searchParams.get("services")!.split(",").sort(), services);
      await new Promise<void>(resolve => widget.addEventListener("nyx-ready", () => resolve(), { once: true }));
      const phone = view.querySelector<HTMLButtonElement>(".voice-toggle")!;
      assert.equal(phone.hidden, !voiceEnabled);
      const input = view.querySelector("textarea")!;
      input.value = "hello"; input.dispatchEvent(new Event("input"));
      assert.equal(phone.hidden, true);
      assert.equal(view.querySelector<HTMLButtonElement>(".send")!.hidden, false);
      assert.equal(requests, 1);
    } finally {
      widget.remove();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  });
}

test("the default widget reuses its previous catalog voice grant for a temporary call", { timeout: 3500 }, async t => {
  const { TemporaryCall } = await import("../src/temporary-call.ts");
  const { promise: started, resolve: connected } = Promise.withResolvers<void>();
  const start = t.mock.method(TemporaryCall.prototype, "start", async () => connected());
  for (const [name, value] of [["Option", dom.window.Option], ["Audio", dom.window.Audio]] as const) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : Reflect.deleteProperty(globalThis, name));
  }
  t.mock.method(TemporaryCall.prototype, "end", async () => {});
  const requested = ["chrono-llm-public", "llm-nyx", "llm-openai"];
  const rows = [...requested, "nyxbot-voice"].map((slug, i) => ({
    id: "00000000-0000-4000-8000-00000000000" + i,
    slug, catalog_service_slug: slug, is_active: true,
  }));
  const identity = { credential_id: "child", api_key: {
    id: "old-widget-key", owner_id: "owner", scopes: "proxy",
    allow_all_services: false, allow_all_nodes: false, allow_auto_connected_services: false,
    allowed_node_ids: [], allowed_service_ids: rows.map(r => r.id), effective_services: rows,
  } };
  const paths: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    paths.push((init.method ?? "GET") + " " + url.pathname);
    if (url.pathname.endsWith("/request")) return Response.json({ device_code: "device", user_code: "ABC-DEF",
      verification_uri: "https://nyxid.ai/login/agent-key", interval: 1, expires_in: 60 });
    if (url.pathname.endsWith("/poll")) return Response.json({ ...identity, credential: "child" });
    if (url.pathname.endsWith("/self")) return init.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json(identity);
    throw Error("Unexpected route: " + url.pathname);
  });
  const widget = new NyxAssistantElement();
  widget.dataset.storage = "memory";
  document.body.append(widget);
  const ready = new Promise<void>(resolve => widget.addEventListener("nyx-ready", () => resolve(), { once: true }));
  try {
    widget.connect();
    await new Promise(resolve => setTimeout(resolve, 0));
    const view = widget.shadowRoot!;
    const link = new URL(view.querySelector<HTMLAnchorElement>(".verify")!.href);
    assert.deepEqual(link.searchParams.get("services")!.split(","), requested);
    await ready;
    assert.deepEqual(widget.access?.services, [...requested, "nyxbot-voice"].sort());
    view.querySelector<HTMLButtonElement>(".voice-toggle")!.click();
    await started;
    assert.equal(start.mock.callCount(), 1);
    assert.deepEqual(paths, ["POST /api/v1/auth/agent-key/request", "POST /api/v1/auth/agent-key/poll", "GET /api/v1/auth/agent-key/self"]);
  } finally {
    widget.remove();
    await new Promise(resolve => setTimeout(resolve, 0));
  }
});

test("a catalog-only voice grant can refresh the same key and select a newly published Bot", async t => {
  const { WidgetVoice } = await import("../src/widget-voice.ts");
  const { NyxIDConnection } = await import("../src/connection.ts");
  t.mock.method(globalThis, "fetch", fetchResponse);
  const savedOption = Object.getOwnPropertyDescriptor(globalThis, "Option");
  Object.defineProperty(globalThis, "Option", { configurable: true, value: dom.window.Option });
  t.after(() => savedOption ? Object.defineProperty(globalThis, "Option", savedOption) : Reflect.deleteProperty(globalThis, "Option"));
  const generic = "035140d4-3b95-4515-a1b6-1eaef20cf266";
  const published = "adba29b6-9e56-4b88-a5ea-69fb4dc0eb60";
  const row = (id: string) => ({ id, slug: "nyxbot-voice", label: "NyxBot Voice", is_active: true });
  let identities = 0;
  async function fetchResponse(input: URL) {
    if (input.pathname.endsWith("/self")) {
      const ids = ++identities === 1 ? [generic] : [generic, published];
      return Response.json({ credential_id: "child", api_key: {
        id: "key", owner_id: "owner", scopes: "proxy", allow_all_services: false, allow_auto_connected_services: false,
        allow_all_nodes: false, allowed_node_ids: [], allowed_service_ids: ids, effective_services: ids.map(row),
      } });
    }
    if (input.pathname.includes(generic)) return Response.json({ error: "api_key_scope_forbidden",
      message: "API key scope forbidden: Voice connection is unavailable" }, { status: 403 });
    if (input.pathname.endsWith("/agents")) return Response.json({ agents: [
      { service_id: published, agent_id: published, name: "My Bot", conversation_id: "thread" },
    ] });
    return Response.json({ options: [] });
  }
  const root = document.createElement("div"), toggle = document.createElement("button");
  const voice = new WidgetVoice(root, toggle, document.createElement("div"), key => key, () => {});
  const keyUrl = "https://login.example/keys/api-key/key";
  voice.setConnection(NyxIDConnection.fromAgentKey("https://relay.example", "child"), keyUrl);
  toggle.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(root.querySelector(".voice-status")!.textContent, "voiceNeedsBinding");
  const setup = root.querySelector<HTMLAnchorElement>(".voice-setup")!;
  assert.equal(setup.href, "https://login.example/assistant?details=grants");
  assert.equal(setup.hidden, false);
  assert.equal(root.querySelector<HTMLAnchorElement>(".voice-key")!.href, keyUrl);
  root.querySelector<HTMLButtonElement>(".voice-retry")!.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(root.querySelector(".voice-name")!.textContent, "My Bot");
  assert.equal(root.querySelectorAll(".voice-bot option").length, 1);
  assert.equal(root.querySelector<HTMLElement>(".voice-repair")!.hidden, true);
  assert.equal(identities, 2);
  await voice.setConnection();
  assert.equal(setup.hidden, true);
  assert.equal(setup.hasAttribute("href"), false);
});
