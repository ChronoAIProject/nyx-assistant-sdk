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
      id: serviceId, slug: "nyxbot-voice", catalogSlug: NYXBOT_VOICE_SERVICE,
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
  const connection = new NyxIDConnection("https://id.example", async (url) => {
    requests.push(new URL(url));
    return Response.json({ agents: [{ service_id: serviceId, agent_id: agentId, conversation_id: conversationId, display_name: "Kitchen Bot" }] });
  });
  const agent = await discoverVoiceAgent(connection, identity().services[0]);
  assert.equal(agent.agent_id, agentId);
  assert.equal(requests[0].pathname, "/api/v1/proxy/s/nyxbot-voice/voice/agents");
  assert.equal(requests[0].search, `?_nyxid_via=${serviceId}`);
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
        assert.equal(url.href, `wss://id.example/api/v1/proxy/s/nyxbot-voice/voice/sessions/${sessionId}/stream?_nyxid_via=${serviceId}`);
        assert.equal(credential, "child-secret");
        return socket;
      },
    });
    const mismatchClient = new VoiceClient(connection, identity().services[0]);
    await assert.rejects(mismatchClient.start({
      preferences: { service_id: agentId, key_source: "platform", model: "gpt-live-1" },
      sdpOffer: "v=0\r\n",
      agentId,
    }), /Voice preference service changed/);
    const result = await client.start({
      preferences: { service_id: serviceId, key_source: "platform", model: "gpt-live-1" },
      sdpOffer: "v=0\r\n",
      agentId,
    });
    assert.equal(result.session.id, sessionId);
    assert.equal(requests[0].url.search, `?_nyxid_via=${serviceId}`);
    assert.equal(new Headers(requests[0].init.headers).get("authorization"), "Bearer child-secret");
    const body = JSON.parse(String(requests[0].init.body));
    assert.equal(body.service_id, serviceId);
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
