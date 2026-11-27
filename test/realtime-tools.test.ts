import assert from "node:assert/strict";
import test from "node:test";
import { AssistantHost, NyxIDConnection, z, type AgentIdentity } from "../src/index.ts";
import { RealtimeTour } from "../src/realtime-tour.ts";
import { RealtimeTools } from "../src/realtime-tools.ts";

function setup() {
  const host = new AssistantHost({ turn: () => assert.fail("unexpected text turn") }, () => ({ rows: 2 }));
  const identity: AgentIdentity = { keyId: "key", name: undefined, ownerId: "owner", ownerType: undefined,
    credentialId: "child", credentialExpiresAt: null, keyExpiresAt: null, scopes: ["proxy"],
    allowAllServices: false, allowAutoConnectedServices: false, services: [] };
  const controller = new AbortController();
  const bind = (screenshot?: () => string | undefined, setTourActive?: (active: boolean) => void) => new RealtimeTools({ host, instructions: () => "Speak softly" },
    new NyxIDConnection("https://example.com"), identity, controller.signal, screenshot, setTourActive);
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

test("screenshots enter the Realtime conversation as image input only when shared", async () => {
  const {bind} = setup();
  let image: string | undefined;
  const tools = bind(() => image);
  const events: object[] = [];
  const send = (event: object) => events.push(event);
  await tools.respond(response("_page_screenshot", "{}"), send);
  assert.match(JSON.stringify(events[0]), /unavailable/);
  assert.equal(events.length, 2);
  events.length = 0;
  image = "data:image/jpeg;base64,/9j/";
  await tools.respond(response("_page_screenshot", "{}", "shared"), send);
  assert.doesNotMatch(JSON.stringify(events[0]), /base64/);
  assert.deepEqual(events[1], {type: "conversation.item.create", item: {type: "message",
    role: "user", content: [{type: "input_image", image_url: image}]}});
  assert.deepEqual(events[2], {type: "response.create"});
});

test("guided calls can pause and resume silent-interval responses", async () => {
  const {bind} = setup();
  const states: boolean[] = [];
  const tools = bind(undefined, active => states.push(active));
  for (const active of [false, true]) {
    const events: object[] = [];
    await tools.respond(response("_tour_playback", JSON.stringify({active}), String(active)), e => events.push(e));
    assert.equal(states.at(-1), active);
  }
});

test("a guided turn resumes after audio drains, and yields to tools, speech and pause", t => {
  t.mock.timers.enable({apis: ["setTimeout"]});
  let next = 0;
  const tour = new RealtimeTour(() => { next++; });
  const emit = (type: string) => tour.observe({type});
  emit("response.created"); emit("response.done"); emit("output_audio_buffer.stopped");
  t.mock.timers.tick(10000);
  assert.equal(next, 0, "wait for the visitor after the greeting");
  tour.setActive(true);
  emit("response.created");
  emit("output_audio_buffer.started");
  emit("response.done");
  t.mock.timers.tick(5000);
  assert.equal(next, 0);
  emit("output_audio_buffer.stopped");
  t.mock.timers.tick(5000);
  assert.equal(next, 1);
  tour.observe({type: "response.done", response: {output: [{type: "function_call"}]}});
  t.mock.timers.tick(5000);
  assert.equal(next, 1);
  emit("response.created"); emit("response.done"); emit("input_audio_buffer.speech_started");
  t.mock.timers.tick(5000);
  assert.equal(next, 1);
  emit("input_audio_buffer.speech_stopped"); emit("response.created"); emit("response.done");
  tour.setActive(false);
  t.mock.timers.tick(5000);
  assert.equal(next, 1);
});

test("briefings belong to an active tour and reach only its natural continuations", t => {
  t.mock.timers.enable({apis: ["setTimeout"]});
  const periods: AbortSignal[] = [], turns: (string | undefined)[] = [];
  let reads = 0;
  const tour = new RealtimeTour(note => turns.push(note), signal => {
    periods.push(signal);
    return () => {
      if (++reads > 1) throw new Error("unavailable");
      return "a".repeat(500);
    };
  });
  const tick = () => t.mock.timers.tick(5000);
  tour.observe({type: "response.done"}); tick();
  assert.equal(periods.length, 0);
  tour.setActive(true); tour.setActive(true);
  assert.equal(periods.length, 1);
  tour.observe({type: "output_audio_buffer.started"});
  tour.observe({type: "response.done"}); tick();
  assert.equal(reads, 0);
  tour.observe({type: "output_audio_buffer.stopped"}); tick();
  assert.deepEqual(turns, ["a".repeat(384)]);
  tour.observe({type: "response.done"}); tour.setActive(false); tick();
  assert.ok(periods[0].aborted);
  assert.equal(reads, 1);
  tour.setActive(true);
  assert.equal(periods.length, 2);
  tour.observe({type: "response.done"}); tick();
  assert.deepEqual(turns, ["a".repeat(384), undefined]);
});
