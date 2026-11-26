import assert from "node:assert/strict";
import test from "node:test";
import { createAgentKeyVerifier } from "../src/agent-verifier.ts";

const config = {
  issuer: "https://id.example", introspectionEndpoint: "https://api.example/oauth/introspect",
  clientId: "resource-client", clientSecret: "resource-secret", serviceId: "catalog-tickets",
};
const evidence = { active: true, token_type: "api_key", iss: config.issuer, aud: config.serviceId,
  sub: "owner", jti: "key", scope: "read proxy", permissions: [] };

test("a registered service receives the live key identity bound to its own audience", async t => {
  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    assert.equal(url.href, config.introspectionEndpoint);
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.equal(init.credentials, "omit");
    assert.deepEqual(Object.fromEntries(init.body as URLSearchParams), {
      token: "agent-credential", client_id: config.clientId, client_secret: config.clientSecret, service_id: config.serviceId,
    });
    return Response.json(evidence);
  });
  const verify = createAgentKeyVerifier(config);
  assert.deepEqual(await verify("agent-credential"), {
    issuer: config.issuer, serviceId: config.serviceId, keyId: "key", ownerId: "owner", scopes: ["read", "proxy"],
  });
});

test("denies inactive, expired, unrelated or incomplete evidence and reports upstream failure", async t => {
  const invalid = [{ active: false }, ...[{ aud: "another-service" }, { iss: "https://other.example" },
    { token_type: "access" }, { exp: 1 }, { jti: "" }, { scope: "read" }].map(fields => ({ ...evidence, ...fields }))];
  const replies = [...invalid.map(v => Response.json(v)), new Response(null, { status: 503 })];
  t.mock.method(globalThis, "fetch", async () => replies.shift()!);
  const verify = createAgentKeyVerifier(config);
  for (const _ of invalid) assert.equal(await verify("agent-credential"), null);
  await assert.rejects(verify("agent-credential"), /503/);
  assert.throws(() => createAgentKeyVerifier({ ...config, introspectionEndpoint: "http://api.example/oauth/introspect" }));
});
