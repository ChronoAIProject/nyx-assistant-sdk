import assert from "node:assert/strict";
import test from "node:test";
import { NyxIDConnection } from "../src/connection.ts";
import {
  NYXBOT_VOICE_SERVICE,
  VoiceClient,
  discoverVoiceAgent,
  selectVoiceService,
} from "../src/voice.ts";

const serviceId = "11111111-1111-4111-8111-111111111111";
const providerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const agentId = "22222222-2222-4222-8222-222222222222";
const conversationId = "33333333-3333-4333-8333-333333333333";
const sessionId = "44444444-4444-4444-8444-444444444444";

function identity() {
  return {
    keyId: "key",
    name: "Panel key",
    ownerId: "owner",
    ownerType: "personal",
    credentialId: "child",
    credentialExpiresAt: null,
    keyExpiresAt: null,
    scopes: ["proxy"],
    allowAllServices: false,
    services: [{
      id: serviceId, slug: "nyxbot-voice-" + serviceId.replaceAll("-", ""), catalogSlug: NYXBOT_VOICE_SERVICE,
      label: "Bot voice", active: true, status: "active", credentialMissing: false,
    }],
  } as const;
}

test("selectVoiceService requires one active exact Bot Voice connection", () => {
  const service = selectVoiceService(identity());
  assert.equal(service.id, serviceId);
  assert.throws(() => selectVoiceService({ ...identity(), services: [] }), /No active Bot Voice/);
  assert.throws(() => selectVoiceService({
    ...identity(), services: [...identity().services, { ...identity().services[0], id: "55555555-5555-4555-8555-555555555555" }],
  }), /Multiple Bot Voice/);
});

test("discovery uses the exact UserService route and rejects a mismatched Bot", async () => {
  const requests: URL[] = [];
  let publishedId = serviceId;
  const connection = new NyxIDConnection("https://id.example", async (url) => {
    requests.push(new URL(url));
    return Response.json({ agents: [{ service_id: publishedId, agent_id: agentId, conversation_id: conversationId, display_name: null }] });
  });
  const agent = await discoverVoiceAgent(connection, identity().services[0]);
  assert.equal(agent.agent_id, agentId);
  assert.equal(agent.display_name, null);
  assert.equal(requests[0].pathname, `/api/v1/proxy/nyxbot-voice/${serviceId}/voice/agents`);
  assert.equal(requests[0].search, "");
  publishedId = providerId;
  await assert.rejects(discoverVoiceAgent(connection, identity().services[0]), /exact authorized Bot connection/);
});

test("VoiceClient starts, opens authenticated controls and sends bounded controls", async () => {
  const requests: { url: URL; init: RequestInit }[] = [];
  const socket = {
    readyState: 1,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    frames: [] as string[],
    send(frame: string) { this.frames.push(frame); },
    close() { this.readyState = 3; this.onclose?.(); },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    requests.push({ url, init });
    if (url.pathname.endsWith("/voice/sessions")) {
      return Response.json({
        session: { id: sessionId, generation: 1, state: "active", control_revision: 2, muted: false },
        sdp_answer: "v=0\r\n",
      });
    }
    if (url.pathname.endsWith("/control")) {
      return Response.json({ id: sessionId, generation: 1, state: "closed", control_revision: 3, muted: false });
    }
    if (url.pathname.endsWith("/announcements")) return Response.json({ state: "queued" });
    throw new Error(`unexpected ${url}`);
  };
  try {
    const connection = NyxIDConnection.fromAgentKey("https://id.example", "child-secret");
    const client = new VoiceClient(connection, identity().services[0], {
      socket: (url, credential) => {
        assert.equal(url.href, `wss://id.example/api/v1/proxy/nyxbot-voice/${serviceId}/voice/sessions/${sessionId}/stream`);
        assert.equal(credential, "child-secret");
        return socket;
      },
    });
    const result = await client.start({
      preferences: { service_id: providerId, key_source: "platform", model: "gpt-live-1" },
      sdpOffer: "v=0\r\n",
      agentId,
    });
    assert.equal(result.session.id, sessionId);
    assert.equal(requests[0].url.pathname, `/api/v1/proxy/nyxbot-voice/${serviceId}/voice/sessions`);
    assert.equal(requests[0].url.search, "");
    assert.equal(new Headers(requests[0].init.headers).get("authorization"), "Bearer child-secret");
    const body = JSON.parse(String(requests[0].init.body));
    assert.equal(body.service_id, serviceId);
    assert.equal(body.preferences.service_id, providerId);
    assert.equal(body.agent_id, agentId);
    assert.equal(client.heartbeat(1234, true), true);
    assert.equal(JSON.parse(socket.frames[0]).playback_ms, 1234);
    await client.announce({ text: "准备好了" });
    assert.equal(requests.at(-1)?.url.pathname.endsWith("/announcements"), true);
    await client.control("end");
    assert.equal(requests.at(-1)?.url.pathname.endsWith("/control"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Bot Voice keeps the deployment prefix and options query; other services keep their generic route", async () => {
  const urls: URL[] = [];
  const connection = new NyxIDConnection("https://id.example/nyx/", async (url) => {
    urls.push(new URL(url));
    return Response.json({ options: [] });
  });
  const service = identity().services[0];
  await new VoiceClient(connection, service).getOptions(conversationId);
  assert.equal(urls[0].href, `https://id.example/nyx/api/v1/proxy/nyxbot-voice/${serviceId}/voice/options?conversation_id=${conversationId}`);
  await connection.requestService({ ...service, catalogSlug: "llm-nyx" }, ["models"]);
  assert.equal(urls[1].href, `https://id.example/nyx/api/v1/proxy/s/llm-nyx/models?_nyxid_via=${serviceId}`);
});

test("PCM relay waits for an active snapshot, brackets input and pairs audio with its watermark", async () => {
  const session = { id: sessionId, state: "starting", generation: 1, control_revision: 0 };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ session, sdp_answer: "" });
  const sent: (ArrayBuffer | string)[] = [];
  const socket = {
    readyState: 1, binaryType: "blob",
    send(data: ArrayBuffer | string) { sent.push(data); },
    close() {},
    onopen: null, onclose: null, onerror: null,
    onmessage: null as ((event: { data: unknown }) => void) | null,
  };
  const emit = (data: unknown) => socket.onmessage!({ data });
  const audio: [ArrayBuffer, number][] = [];
  const errors: Error[] = [];
  let flushes = 0;
  const client = new VoiceClient(NyxIDConnection.fromAgentKey("http://localhost", "fixture"), identity().services[0], {
    socket: () => socket,
    onAudio: (frame, endMs) => audio.push([frame, endMs]),
    onAudioFlush: () => flushes++,
    onError: error => errors.push(error),
  });
  const pcm = new Int16Array(480).fill(1000).buffer;
  try {
    await client.start({ preferences: { service_id: providerId, key_source: "platform", model: "grok-voice-latest" }, sdpOffer: "" });
    assert.equal(socket.binaryType, "arraybuffer");
    assert.equal(client.beginInput(), false);
    emit(JSON.stringify({ type: "snapshot", session: { ...session, state: "active" } }));
    assert.equal(client.sendPcm(pcm), false);
    assert.equal(client.beginInput(), true);
    assert.equal(client.beginInput(), false);
    assert.throws(() => client.sendPcm(new ArrayBuffer(1922)), /PCM16/);
    assert.equal(client.sendPcm(pcm), true);
    assert.equal(client.commitInput(), true);
    assert.equal(client.commitInput(), false);
    assert.deepEqual(sent, ['{"type":"ptt_begin"}', pcm, '{"type":"ptt_commit"}']);
    emit('{"type":"audio","generation":0,"end_ms":10}');
    emit(pcm);
    assert.deepEqual(audio, []);
    emit('{"type":"audio","generation":1,"end_ms":20}');
    emit(pcm);
    assert.deepEqual(audio, [[pcm, 20]]);
    emit('{"type":"audio_flush","generation":1}');
    emit('{"type":"future_event"}');
    assert.equal(flushes, 1);
    assert.deepEqual(errors, []);
    emit(pcm);
    assert.match(errors.pop()!.message, /header/);
    emit('{"type":"start_failed","error":{"message":"Provider unavailable"}}');
    assert.equal(errors.pop()!.message, "Provider unavailable");
  } finally {
    client.close();
    globalThis.fetch = originalFetch;
  }
});

test("ordinary Agent Keys select a published Bot from the authorized /keys inventory", async () => {
  const connection = new NyxIDConnection("http://localhost:3001", async (url) => {
    assert.equal(new URL(url).pathname, "/api/v1/keys");
    return Response.json({ keys: [{
      id: serviceId, slug: `nyxbot-voice-${serviceId}`, catalog_service_slug: NYXBOT_VOICE_SERVICE,
      label: "Panel Voice", is_active: true, status: "active", credential_missing: false,
    }] });
  });
  const services = await connection.getServiceConnections();
  assert.equal(selectVoiceService({ services }, serviceId).label, "Panel Voice");
});

test("closing while the start request is in flight ends the acknowledged session", async () => {
  let finish!: (response: Response) => void;
  let ends = 0;
  const active = { id: sessionId, state: "active", generation: 1, control_revision: 0 };
  const connection = new NyxIDConnection("http://localhost:3001", async (url, init) => {
    if (new URL(url).pathname.endsWith("/sessions")) return new Promise<Response>(resolve => { finish = resolve; });
    assert.equal(JSON.parse(String(init?.body)).action, "end");
    ends++;
    return Response.json({ ...active, state: "closing", end_requested: true, control_revision: 1 });
  });
  const client = new VoiceClient(connection, identity().services[0]);
  const input = { preferences: { service_id: providerId, key_source: "platform" as const, model: "gpt-live-1" }, sdpOffer: "v=0\r\n" };
  const pending = client.start(input);
  await assert.rejects(client.start(input), /already active/);
  client.close();
  finish(Response.json({ session: active, sdp_answer: "v=0\r\n" }));
  await assert.rejects(pending, /closed during startup/);
  assert.equal(ends, 1);
});
