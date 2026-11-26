import "fake-indexeddb/auto";
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { BrowserAuthorization } from "../src/widget-auth.ts";

beforeEach(t => {
  // Model exclusive requests by name on Node versions without browser Web Locks.
  const tails = new Map<string, Promise<void>>();
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "locks");
  Object.defineProperty(navigator, "locks", { configurable: true, value: {
    request<T>(name: string, { signal }: LockOptions, run: () => Promise<T>) {
      const result = (tails.get(name) ?? Promise.resolve()).then(() => {
        signal?.throwIfAborted();
        return run();
      });
      tails.set(name, result.then(() => {}, () => {}));
      return result;
    },
  } });
  t.after(() => {
    if (descriptor) Object.defineProperty(navigator, "locks", descriptor);
    else Reflect.deleteProperty(navigator, "locks");
  });
});

function storage(): Storage {
  const rows = new Map<string,string>();
  return {
    get length() { return rows.size; }, clear: () => rows.clear(),
    getItem: k => rows.get(k) ?? null, key: i => [...rows.keys()][i] ?? null,
    removeItem: k => { rows.delete(k); }, setItem: (k,v) => { rows.set(k,v); },
  };
}
const current = {
  credential_id: "child", api_key: {
    id: "test-key", owner_id: "person", scopes: "read proxy", allow_all_services: false,
    allow_auto_connected_services: false, allow_all_nodes: false, allowed_node_ids: [],
    allowed_service_ids: ["chat"], effective_services: [
      { id: "chat", is_active: true, slug: "chat", catalog_service_slug: "llm-nyx" },
    ],
  },
};
test("a restored child is checked against live NyxID permissions before use", async t => {
  const local = storage();
  const flow = new BrowserAuthorization({base:"https://api.example", verificationOrigin:"https://id.example", services:["llm-nyx"], ownerId:"person", credentialStorage:local, clientLabel:"Test"});
  local.setItem(flow.credentialStorageKey, "child-only");
  const methods: string[] = [];
  t.mock.method(globalThis, "fetch", async (url:URL, init:RequestInit) => {
    assert.equal(url.pathname, "/api/v1/auth/agent-key/self");
    assert.equal(init.credentials, "omit");
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer child-only");
    methods.push(init.method ?? "GET");
    return Response.json(current);
  });
  const grant = await flow.restore(new AbortController().signal);
  assert.equal(grant?.ownerId, "person");
  const encrypted = local.getItem(flow.credentialStorageKey)!;
  assert.match(encrypted, /^nyx-sealed:v1:/);
  assert.ok(!encrypted.includes("child-only"));
  const reloaded = await flow.restore(new AbortController().signal);
  assert.equal(reloaded?.keyId, "test-key");
  await grant!.revoke();
  assert.deepEqual(methods, ["GET","GET","DELETE"]);
  assert.equal(flow.hasSavedGrant,false);
});
test("a changed scope revokes only the delivered child, a transient failure preserves it", async t => {
  const local = storage();
  const flow = new BrowserAuthorization({base:"https://api.example", verificationOrigin:"https://id.example", services:["chat"], credentialStorage:local, clientLabel:"Test"});
  local.setItem(flow.credentialStorageKey,"child-only");
  let first = true;
  const calls: string[] = [];
  t.mock.method(globalThis,"fetch", async (url:URL, init:RequestInit) => {
    calls.push(init.method ?? "GET");
    if(first) { first=false; return new Response(null,{status:503}); }
    return Response.json(current);
  });
  await assert.rejects(flow.restore(new AbortController().signal), /503/);
  assert.equal(flow.hasSavedGrant,true);
  await assert.rejects(flow.restore(new AbortController().signal), /撤销/);
  assert.deepEqual(calls,["GET","GET","DELETE"]);
  assert.equal(flow.hasSavedGrant,false);
});
test("the pending challenge resumes from the same tab without creating a second request", async t => {
  Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
  const tab = storage();
  const options = {base:"https://api.example", verificationOrigin:"https://id.example", services:["llm-nyx"], keySource:"new" as const, storage:tab, clientLabel:"Test"};
  const calls:string[]=[];
  t.mock.method(globalThis,"fetch",async (url:URL) => {
    calls.push(url.pathname);
    return Response.json({device_code:"device",user_code:"TEST-1234",expires_in:300,interval:2,verification_uri:"https://id.example/login/agent-key"});
  });
  for(let i=0;i<2;i++){
    const controller=new AbortController();
    await assert.rejects(new BrowserAuthorization(options).connect(controller.signal,(url,code)=>{
      assert.equal(code,"TEST-1234");assert.equal(url.searchParams.get("key_source"),"new");
      assert.equal(url.searchParams.get("services"),"llm-nyx");controller.abort();
    }),{name:"AbortError"});
  }
  assert.deepEqual(calls,["/api/v1/auth/agent-key/request"]);
  new BrowserAuthorization(options).cancel();assert.equal(tab.length,0);
});

test("persistent enrollment requires Web Locks before requesting a challenge", async t => {
  Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
  const flow = new BrowserAuthorization({
    base: "https://api.example", verificationOrigin: "https://id.example", services: ["llm-nyx"],
    clientLabel: "Test", credentialStorage: storage(),
  });
  const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("unexpected enrollment request"));
  await assert.rejects(flow.connect(new AbortController().signal, () => assert.fail("unexpected link")), /Web Locks/);
  assert.equal(fetch.mock.callCount(), 0);
});

test("overlapping persistent connects share one child and disconnect is recoverable", { timeout: 3000 }, async t => {
  const local = storage();
  const options = { base: "https://api.example", verificationOrigin: "https://id.example",
    services: ["llm-nyx"], clientLabel: "Test", credentialStorage: local };
  const firstTab = storage();
  const secondTab = storage();
  const first = new BrowserAuthorization({ ...options, storage: firstTab });
  const second = new BrowserAuthorization({ ...options, storage: secondTab });
  const { signal } = new AbortController();
  const pollStarted = Promise.withResolvers<void>();
  const approved = Promise.withResolvers<void>();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let requests = 0;
  let deliveries = 0;
  let active = false;
  let revokeStatus = 503;
  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    assert.equal(url.origin, "https://api.example");
    assert.equal(init.credentials, "omit");
    switch (url.pathname) {
      case "/api/v1/auth/agent-key/request":
        assert.equal(++requests, 1, "the second tab must reuse the saved grant");
        return Response.json({ device_code: "device-first", user_code: "TEST-1234",
          expires_in: 300, interval: 1, verification_uri: "https://id.example/login/agent-key" });
      case "/api/v1/auth/agent-key/poll":
        assert.equal(JSON.parse(String(init.body)).device_code, "device-first");
        pollStarted.resolve();
        await approved.promise;
        deliveries++;
        active = true;
        return Response.json({ ...current, credential: "child-only" });
      case "/api/v1/auth/agent-key/self":
        assert.equal(new Headers(init.headers).get("Authorization"), "Bearer child-only");
        if (!active) return new Response(null, { status: 401 });
        if (init.method !== "DELETE") return Response.json(current);
        if (revokeStatus === 204) active = false;
        return new Response(null, { status: revokeStatus });
      default:
        assert.fail("Unexpected NyxID request " + url.pathname);
    }
  });

  const firstConnect = first.connect(signal, (url, code) => {
    assert.equal(code, "TEST-1234");
    assert.equal(url.searchParams.get("key_source"), "existing");
    now += 1000;
  });
  await pollStarted.promise;
  assert.equal(firstTab.length, 1);
  const secondConnect = second.connect(signal, () => assert.fail("a second approval link was shown"));
  approved.resolve();
  const [firstGrant, secondGrant] = await Promise.all([firstConnect, secondConnect]);
  assert.equal(requests, 1);
  assert.equal(deliveries, 1);
  assert.equal(firstGrant.keyId, "test-key");
  assert.equal(secondGrant.keyId, firstGrant.keyId);
  assert.equal(firstTab.length, 0);
  assert.equal(secondTab.length, 0);

  const record = local.getItem(first.credentialStorageKey);
  assert.match(record!, /^nyx-sealed:v1:/);
  const reloaded = new BrowserAuthorization({ ...options, storage: firstTab });
  assert.equal((await reloaded.restore(signal))?.keyId, firstGrant.keyId);
  await assert.rejects(secondGrant.revoke(), /重试/);
  assert.equal(active, true);
  assert.equal(local.getItem(first.credentialStorageKey), record);

  revokeStatus = 204;
  await firstGrant.revoke();
  assert.equal(active, false);
  assert.equal(local.length, 0);
  assert.deepEqual(await Promise.all([first.restore(signal), second.restore(signal)]), [undefined, undefined]);
});
