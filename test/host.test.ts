import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { AssistantHost, LocalizedError, type TurnRequest, type NyxIDService } from "../src/index.ts";

function call(name: string, id: string, args: unknown = {}) {
  return { type: "call" as const, conversationId: "session", callId: id, name, arguments: args };
}
function answer(text: string) { return { type: "answer" as const, conversationId: "session", text }; }
const ok = (value: string) => ({ ok: true as const, value });

test("uses a live read to write only to the originating instance and returns the host result", async () => {
  const received: TurnRequest[] = [];
  const service: NyxIDService = { async turn(req) {
    received.push(req);
    if (req.input.type === "user") return call("read", "1");
    assert.ok(req.input.result.ok);
    if (req.input.name === "read") return call("write", "2", { value: req.input.result.value });
    assert.equal(req.context, "written");
    return answer(String(req.input.result.value));
  }};
  const secret = crypto.randomUUID();
  let context = "initial";
  const a = new AssistantHost(service, () => context);
  const b = new AssistantHost(service);
  a.registerTool({ name: "read", description: "Read selection", parameters: z.object({}), execute: () => ok(secret) });
  for (const h of [a, b]) h.registerTool({ name: "write", description: "Apply selection", parameters: z.object({ value: z.string() }), execute: ({ value }) => {
    assert.equal(h, a); assert.equal(value, secret); context = "written"; return ok(value);
  } });
  assert.equal(await a.send("Apply current selection"), secret);
  assert.deepEqual(received.map(x => x.instanceId), Array(3).fill(a.instanceId));
});

test("keeps the exact continuation across interruption and never dispatches a duplicate mutation", async () => {
  let writes = 0;
  let attempt = 0;
  const submissions: TurnRequest[] = [];
  const h = new AssistantHost({ async turn(req) {
    submissions.push(req);
    if (req.input.type === "user") return call("write", "original");
    if (++attempt === 1) throw Error("offline");
    if (attempt === 2) return call("write", "original");
    return answer("ok");
  } });
  h.registerTool({ name: "write", description: "Increment", parameters: z.object({}), execute: () => ok(String(++writes)) });
  await assert.rejects(h.send("increment"), /offline/);
  assert.equal(await h.resume(), "ok");
  assert.deepEqual(submissions[1], submissions[2]);
  assert.equal(writes, 1);
});

test("revocation, invalid input and refusal are reported without calling a replacement", async () => {
  for (const condition of ["revoked", "invalid", "denied"]) {
    let writes = 0;
    const h = new AssistantHost({ async turn(req) {
      if (req.input.type === "tool_result") {
        assert.equal(req.input.result.ok, false);
        if (!req.input.result.ok) return answer(req.input.result.code);
      }
      if (condition === "revoked") { unregister(); register(); }
      return call("apply", "c", condition === "invalid" ? { extra: 1 } : {});
    } });
    function register() { return h.registerTool({ name: "apply", description: "Apply", parameters: z.object({}), execute() {
      writes++; return { ok: false, code: "denied", message: "Read only" };
    } }); }
    const unregister = register();
    assert.equal(await h.send("apply"), { revoked: "tool_unavailable", invalid: "invalid_arguments", denied: "denied" }[condition]);
    assert.equal(writes, condition === "denied" ? 1 : 0);
  }
});

test("disposing the host fences a delayed response after an identity change", async () => {
  const gate = Promise.withResolvers<void>();
  const h = new AssistantHost({ async turn() { await gate.promise; return call("write", "late"); } });
  let writes = 0;
  h.registerTool({ name: "write", description: "Write", parameters: z.object({}), execute: () => ok(String(++writes)) });
  const pending = h.send("write");
  h.dispose();
  gate.resolve();
  await assert.rejects(pending); assert.equal(writes, 0);
});

test("a host localizes its own errors and tool failures while preserving stable result codes", async () => {
  const h = new AssistantHost({ async turn(request) {
    if (request.input.type === "user") return call("unknown_tool", "c");
    const { result } = request.input;
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("Expected a tool failure");
    assert.equal(result.code, "tool_unavailable");
    return answer(result.message);
  } });
  h.language = "zh-Hans-CN";
  assert.throws(() => h.send(""), /消息为空/);
  assert.equal(await h.send("试用"), "当前实例无法使用此工具。");
  h.language = "en-GB";
  assert.throws(() => h.send(""), /Message is empty/);
});

test("service diagnostics use the calling host's language and preserve the original error", async () => {
  const error = new LocalizedError("turnHttp", "503");
  const host = new AssistantHost({ async turn() { throw error; } });
  host.language = "zh-CN";
  await assert.rejects(host.send("你好"), thrown => thrown instanceof LocalizedError &&
    thrown.message === "NyxID 聊天请求失败（HTTP 503）。" && thrown.cause === error);
  assert.equal(error.message, "NyxID turn returned HTTP 503");
});
