import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

test("the distributed widget displays the approved key, then clears it on disconnect", async t => {
  const dom = new JSDOM('<nyx-assistant data-nyxid="https://id.example" data-verification-origin="https://nyx.example" data-services="@key"></nyx-assistant>', {
    url: "https://site.example/", runScripts: "outside-only",
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const revoked = Promise.withResolvers<void>();
  Object.assign(window, { AbortSignal, AbortController, Headers, Response, TextEncoder, TextDecoder });
  const key = {
    id: "agent-id", name: "My NyxBot", owner_id: "owner-id", scopes: "proxy", allow_all_services: false,
    allow_auto_connected_services: false, allow_all_nodes: false, allowed_node_ids: [], allowed_service_ids: [],
    effective_services: [
      { id: "work", slug: "gmail-work", catalog_service_slug: "gmail", label: "工作邮箱", is_active: true },
      { id: "personal", slug: "gmail-personal", catalog_service_slug: "gmail", label: "私人邮箱", is_active: false },
    ],
  };
  let refreshedKey = { ...key, allow_auto_connected_services: true, effective_services: [] };
  let selfStatus = 200;
  window.fetch = async (url: URL, init: RequestInit) => {
    if (url.pathname.endsWith("/request")) return Response.json({
      device_code: "device", user_code: "TEST-ABCD", verification_uri: "https://nyx.example/login/agent-key", interval: 1, expires_in: 300,
    });
    if (url.pathname.endsWith("/poll")) return Response.json({
      credential_id: "login-id", credential: "login-secret", api_key: key,
    });
    assert.equal(url.href, "https://id.example/api/v1/auth/agent-key/self");
    if (init.method !== "DELETE") {
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer login-secret");
      return Response.json({ credential_id: "login-id", api_key: refreshedKey }, { status: selfStatus });
    }
    assert.equal(init.method, "DELETE");
    revoked.resolve();
    return new Response(null, { status: 204 });
  };
  window.eval(await readFile(new URL("../browser/nyx-widget.js", import.meta.url), "utf8"));
  const widget = window.document.querySelector("nyx-assistant");
  let ready;
  widget.addEventListener("nyx-ready", event => { ready = event.detail.identity; });
  await widget.openAgentIdentity();
  assert.equal(ready.keyId, "agent-id");
  const details = widget.shadowRoot.querySelector("details");
  assert.ok(details.open && !details.hidden);
  assert.match(details.textContent, /agent-id/);
  const summary = details.querySelector("summary");
  assert.match(summary.textContent, /已授权服务.*2/);
  const services = details.querySelector("ul");
  assert.match(services.textContent, /gmail.*工作邮箱/s);
  assert.match(services.textContent, /gmail.*私人邮箱.*停用/s);
  const manage = details.querySelector("a");
  assert.equal(manage.href, "https://nyx.example/keys/api-key/agent-id");
  assert.equal(manage.target, "_blank");
  const refresh = details.querySelector("button");
  await refresh.onclick();
  assert.match(summary.textContent, /已授权服务.*0/);
  assert.match(details.textContent, /自动连接/);
  assert.match(details.textContent, /当前没有服务连接/);
  refreshedKey = { ...refreshedKey, allow_all_services: true };
  await refresh.onclick();
  assert.match(details.textContent, /全部服务/);
  selfStatus = 503;
  await refresh.onclick();
  assert.match(details.querySelector('[role="status"]').textContent, /刷新失败/);
  assert.equal(refresh.disabled, false);
  assert.doesNotMatch(details.textContent, /login-secret/);
  widget.shadowRoot.querySelector(".disconnect").click();
  await revoked.promise;
  assert.ok(details.hidden);
  assert.doesNotMatch(details.textContent, /agent-id|工作邮箱|私人邮箱/);
  assert.equal(manage.hasAttribute("href"), false);
});
