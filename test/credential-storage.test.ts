import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { createStore, get } from "idb-keyval";
import { sealCredential, openCredential } from "../src/credential-storage.ts";

test("different bindings cannot decrypt the grant, concurrent writers share a non-exportable key", async () => {
  const [a,b] = await Promise.all([sealCredential("account-a","child"), sealCredential("account-a","child")]);
  assert.notEqual(a,b);
  assert.equal(await openCredential("account-a",a),"child");
  assert.equal(await openCredential("account-a",b),"child");
  assert.equal(await openCredential("account-b",a),undefined);
  const key = await get<CryptoKey>("aes-gcm-v1",createStore("nyx-assistant-credentials","keys"));
  assert.equal(key?.extractable,false);
  await assert.rejects(crypto.subtle.exportKey("raw",key!));
});
