import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { AssistantHost, NyxIDConnection } from "../src/index.ts";
import { createNyxChatService } from "../src/nyx-chat.ts";

test("invokes a fetch supplied by the browser as a standalone function", async () => {
  const transport = async function (this: unknown) {
    assert.equal(this, undefined);
    return new Response();
  };
  const connection = new NyxIDConnection("https://example.test", transport);
  await connection.request("llm-nyx", ["v1", "responses"]);
});

function response(id: string, text: string) {
  return { id, conversation: { id: "conv_1" }, status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }] };
}

function stream(events: unknown[]) {
  const bytes = new TextEncoder().encode(events.map(data => "data: " + JSON.stringify(data) + "\r\n\r\n").join(""));
  const body = new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close(); } });
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

test("uses NyxID proxy, committed assistant call, result and conversation", async () => {
  let turns = 0;
  const service = createNyxChatService(new NyxIDConnection("https://example.test", async (url, init) => {
    assert.equal(String(url), "https://example.test/api/v1/proxy/s/llm-nyx/v1/responses");
    const body = JSON.parse(String(init?.body));
    const req = JSON.parse(body.input);
    assert.equal(req.requestId, new Headers(init?.headers).get("Idempotency-Key"));
    assert.equal(body.model, "nyxagent/chat");
    turns++;
    const call = { name: "count", arguments: {}, requestId: req.requestId };
    if (turns === 1) return stream([
      { type: "response.output_text.delta", delta: "```nyx-host-call\n{}\n```" },
      { type: "response.completed", response: response("resp_1", "```nyx-host-call\n" + JSON.stringify(call) + "\n```") },
    ]);
    assert.equal(body.conversation, "conv_1");
    assert.deepEqual(req.input, { type: "tool_result", callId: "resp_1", name: "count", result: { ok: true, value: 3 } });
    return stream([{ type: "response.completed", response: response("resp_2", "共三行") }]);
  }));
  const h = new AssistantHost(service);
  let executions = 0;
  h.registerTool({ name: "count", description: "Count", parameters: z.object({}),
    execute: () => { executions++; return { ok: true, value: 3 }; } });
  assert.equal(await h.send("count"), "共三行"); assert.equal(executions, 1);
});

test("recovers original saved response after stream interruption using GET", async () => {
  const methods: string[] = [];
  const h = new AssistantHost(createNyxChatService(new NyxIDConnection("http://localhost:3001", async (url, init) => {
    methods.push(init?.method ?? "GET");
    if (init?.method === "POST") return stream([{ type: "response.created",
      response: { id: "resp_1", conversation: { id: "conv_1" } } }]);
    assert.ok(String(url).endsWith("/responses/resp_1"));
    return Response.json(response("resp_1", "done"));
  })));
  await assert.rejects(h.send("hello"), /without a confirmed result/);
  assert.equal(await h.resume(), "done"); assert.deepEqual(methods, ["POST", "GET"]);
});

test("rejects a stale request token, even in a completed reply", async () => {
  const h = new AssistantHost(createNyxChatService(new NyxIDConnection("https://example.test", async () =>
    Response.json(response("resp_1", '```nyx-host-call\n{"requestId":"old","name":"change","arguments":{}}\n```'))
  )));
  await assert.rejects(h.send("hello"), /Stale host tool request/);
});

test("preserves Markdown boundaries and indentation across text parts", async () => {
  const value = response("resp_1", "    indented code\n\n**com");
  value.output[0].content.push({ type: "output_text", text: "plete**  \nlast line\n" });
  const service = createNyxChatService(new NyxIDConnection("https://example.test", async () => Response.json(value)));
  const host = new AssistantHost(service);
  assert.equal(await host.send("read"), "    indented code\n\n**complete**  \nlast line\n");
});
