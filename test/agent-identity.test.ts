import assert from "node:assert/strict";
import test from "node:test";
import { NyxIDConnection } from "../src/index.ts";

const first = "eb87caa2-ea66-47d9-8b9f-0d415b228c92";
const second = "541aca68-f6ef-4319-b9de-849b89f24769";
const self = {
  credential_id: "login-1", api_key: {
    id: "agent-key-1", name: "NyxBot", owner_type: "org", owner_id: "team-1",
    scopes: "read proxy", allow_all_services: true, allow_auto_connected_services: true,
    allow_all_nodes: true, allowed_node_ids: [], allowed_service_ids: [],
    effective_services: [first, second].map((id, i) => ({
      id, slug: "tickets-" + i, catalog_service_slug: "tickets", is_active: true,
    })),
  },
};

test("the login credential identifies the key and calls distinct connections to the same service", async t => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    calls.push(url.href);
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer login-secret");
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    if (url.pathname.endsWith("/self")) return Response.json(self);
    return new Response(null, { status: url.searchParams.get("_nyxid_via") === first ? 204 : 403 });
  });
  const agent = NyxIDConnection.fromAgentKey("https://id.example/nyx", "login-secret");
  const identity = await agent.getAgentIdentity();
  assert.equal(identity.keyId, "agent-key-1");
  assert.equal(identity.ownerId, "team-1");
  assert.equal(identity.credentialId, "login-1");
  assert.deepEqual(identity.scopes, ["read", "proxy"]);
  assert.deepEqual(identity.services.map(s => s.id), [first, second]);
  assert.ok(!JSON.stringify(identity).includes("login-secret"));
  for (const [i, service] of identity.services.entries()) {
    const reply = await agent.requestService(service, ["tickets", "a b"], {
      headers: { Authorization: "Bearer unrelated" },
    }, new URLSearchParams({ state: "open" }));
    assert.equal(reply.status, i === 0 ? 204 : 403);
  }
  assert.deepEqual(calls, [
    "https://id.example/nyx/api/v1/auth/agent-key/self",
    ...[first, second].map(id => "https://id.example/nyx/api/v1/proxy/s/tickets/tickets/a%20b?state=open&_nyxid_via=" + id),
  ]);
});

test("each identity lookup uses the current NyxID response and fails closed", async t => {
  const replies = [Response.json(self), Response.json({ credential: "undisclosed" }), new Response(null, { status: 401 })];
  t.mock.method(globalThis, "fetch", async () => replies.shift()!);
  const agent = NyxIDConnection.fromAgentKey("https://id.example", "login-secret");
  await agent.getAgentIdentity();
  await assert.rejects(agent.getAgentIdentity(), /metadata/i);
  await assert.rejects(agent.getAgentIdentity(), /401/);
  const service = { id: first, slug: "tickets", catalogSlug: null, label: "Tickets", active: true,
    status: undefined, credentialMissing: false };
  assert.throws(() => agent.requestService({ ...service, id: "../auth" }, []));
  assert.throws(() => agent.requestService(service, [".."]));
});
