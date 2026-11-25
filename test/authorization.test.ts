import test from "node:test";
import assert from "node:assert/strict";
import { BrowserAuthorization } from "../src/widget-auth.ts";

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
  assert.equal(local.getItem(flow.credentialStorageKey), "child-only");
  await grant!.revoke();
  assert.deepEqual(methods, ["GET","DELETE"]);
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
