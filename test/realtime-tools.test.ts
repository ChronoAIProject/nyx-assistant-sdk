import assert from "node:assert/strict";
import test from "node:test";
import { AssistantHost, NyxIDConnection, z, type AgentIdentity } from "../src/index.ts";
import { RealtimeTools } from "../src/realtime-tools.ts";

function setup() {
  const host = new AssistantHost({ turn: () => assert.fail("unexpected text turn") }, () => ({ rows: 2 }));
  const identity: AgentIdentity = { keyId: "key", name: undefined, ownerId: "owner", ownerType: undefined,
    credentialId: "child", credentialExpiresAt: null, keyExpiresAt: null, scopes: ["proxy"],
    allowAllServices: false, allowAutoConnectedServices: false, services: [] };
  const controller = new AbortController();
  const bind = () => new RealtimeTools({ host, instructions: () => "Speak softly" },
    new NyxIDConnection("https://example.com"), identity, controller.signal);
  return { host, controller, identity, bind };
}
const response = (name: string, args: string, id = "call1") => ({ status: "completed", output: [
  { type: "function_call", status: "completed", name, call_id: id, arguments: args },
] });
test("temporary calls use advertised tools once, validate inputs and respect removal", async () => {
  const { host, bind } = setup();
  let count = 0;
  const register = () => host.registerTool({ name: "apply", description: "Apply selection", parameters: z.object({}),
    execute: () => ({ ok: true, value: ++count }) });
  const remove = register();
  const tools = bind();
  assert.deepEqual(tools.tools.map(t => t.name), ["apply", "_page_context"]);
  assert.match(tools.instructions, /Speak softly/);
  const events: object[] = [];
  const send = (e: object) => events.push(e);
  const call = response("apply", "{}");
  await tools.respond({ ...call, status: "cancelled" }, send);
  assert.equal(events.length, 0);
  await Promise.all([tools.respond(call, send), tools.respond(call, send)]);
  assert.equal(count, 1);
  assert.equal(events.length, 2);
  await tools.respond(response("apply", '{"extra":42}', "bad"), send);
  assert.match(JSON.stringify(events.at(-2)), /invalid_arguments/);
  remove(); register();
  await tools.respond(response("apply", "{}", "removed"), send);
  assert.match(JSON.stringify(events.at(-2)), /tool_unavailable/);
  assert.equal(count, 1);
});

test("hangup fences later output and queued calls", async () => {
  const { host, controller, bind } = setup();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let calls = 0;
  host.registerTool({ name: "wait", description: "Wait", parameters: z.object({}), async execute(_, signal) {
    calls++; entered.resolve(); await release.promise; assert.equal(signal.aborted, true); return { ok: true, value: 1 };
  } });
  const tools = bind(), send = () => assert.fail("output after hangup");
  const first = tools.respond(response("wait", "{}"), send);
  const next = tools.respond(response("wait", "{}", "second"), send);
  await entered.promise; controller.abort(); release.resolve(); await Promise.all([first, next]);
  assert.equal(calls, 1);
});
