import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { sdkServer } from "../server/server.mjs";

test("static server forwards scoped child requests, streams Responses, and isolates origins", async t => {
  const origin = "https://site.example";
  const requests = [];
  const server = sdkServer({ upstreamOrigin: "https://id.example", origins: [origin],
    request: async (url, options) => {
      const headers = new Headers(options.headers);
      requests.push({ url, headers });
      if (url.endsWith("/self") && headers.get("authorization") !== "Bearer child") return Response.json({}, { status: 401 });
      if (url.endsWith("/responses")) return new Response("data: reply\n\n", { headers: { "content-type": "text/event-stream" } });
      return Response.json({ ok: true }, { headers: { "set-cookie": "private=1" } });
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port + "/api/v1/";
  const path = base + "proxy/s/llm-nyx/v1/responses";
  const post = { method: "POST", headers: { origin, authorization: "Bearer child", "content-type": "application/json", "idempotency-key": "example" }, body: "{}" };
  const pre = await fetch(path, { method: "OPTIONS", headers: { origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,idempotency-key" } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), origin);
  assert.equal(pre.headers.has("access-control-allow-credentials"), false);
  const result = await fetch(path, post);
  assert.equal(await result.text(), "data: reply\n\n");
  assert.equal(result.headers.get("content-type"), "text/event-stream");
  assert.deepEqual(requests.map(row => new URL(row.url).pathname), ["/api/v1/auth/agent-key/self", "/api/v1/proxy/s/llm-nyx/v1/responses"]);
  assert.equal(requests[1].headers.get("idempotency-key"), "example");
  assert.equal(requests[1].headers.has("origin"), false);
  assert.equal((await fetch(path, { ...post, headers: { ...post.headers, authorization: "Bearer parent" } })).status, 401);
  assert.equal((await fetch(path, { ...post, headers: { ...post.headers, cookie: "session=fixture" } })).status, 403);
  assert.equal((await fetch(path, { ...post, headers: { ...post.headers, origin: "https://other.example" } })).status, 403);
  const child = await fetch(base + "auth/agent-key/self", { headers: { origin, authorization: "Bearer child" } });
  assert.equal(child.headers.has("set-cookie"), false);
  assert.equal((await fetch(base + "auth/agent-key/approve", post)).status, 404);
  assert.equal((await fetch(path + "/original", { headers: { origin, authorization: "Bearer child" } })).status, 200);
});

for (const event of ["deadline", "browser disconnect"]) {
  test(`Responses handles ${event} while waiting for downstream drain`, { timeout: 3_000 }, async t => {
    const deadline = new AbortController();
    t.mock.method(AbortSignal, "timeout", milliseconds => {
      assert.equal(milliseconds, 300_000);
      return deadline.signal;
    });
    const stalled = Promise.withResolvers();
    const turn = Promise.withResolvers();
    let upstreamSignal;
    const server = sdkServer({ upstreamOrigin: "https://id.example", origins: [],
      request: async (url, options) => {
        if (url.endsWith("/self")) return new Response();
        if (options.method === "GET") return Response.json(await turn.promise);
        upstreamSignal = options.signal;
        let started = false;
        return new Response(new ReadableStream({
          pull(controller) {
            if (!started) {
              started = true;
              controller.enqueue(new TextEncoder().encode("data: reply\n\n"));
              return;
            }
            controller.close();
            turn.resolve("reply");
          },
          cancel() { turn.resolve(null); },
        }, { highWaterMark: 0 }));
      },
    });
    server.prependOnceListener("request", (_req, res) => {
      t.mock.method(res, "write", () => {
        stalled.resolve();
        return false;
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    }));
    const path = `http://127.0.0.1:${server.address().port}/api/v1/proxy/s/llm-nyx/v1/responses`;
    const authorization = "Bearer child";
    const response = await fetch(path, {
      method: "POST", headers: { authorization, "content-type": "application/json" }, body: "{}",
    });
    assert.equal(response.status, 200);
    await stalled.promise;
    if (event === "deadline") {
      deadline.abort();
      await assert.rejects(response.text());
      assert.equal(await turn.promise, null);
    } else {
      await response.body.cancel();
      assert.equal(await turn.promise, "reply");
      assert.equal(upstreamSignal.aborted, false);
      const recovered = await fetch(path + "/original", { headers: { authorization } });
      assert.equal(await recovered.json(), "reply");
    }
  });
}

test("browser voice uses a fixed upstream and authenticates the stream with the delivered child", { timeout: 8000 }, async t => {
  const { createRequire } = await import("node:module");
  const require = createRequire(new URL("../server/package.json", import.meta.url));
  const { WebSocket, WebSocketServer } = require("ws");
  const { createServer } = await import("node:http");
  const origin = "https://widget.example";
  const service = "22caf9db-4c7d-4712-89e8-09c96c58489b";
  const session = "c681b53d-dbb6-4d84-82d5-96a30df3de47";
  const path = "/api/v1/proxy/nyxbot-voice/" + service + "/voice/";
  const remote = createServer((req, res) => {
    if (req.headers.authorization !== "Bearer child") res.writeHead(401);
    res.end("{}");
  }).listen(0, "127.0.0.1");
  await once(remote, "listening");
  const sockets = new WebSocketServer({ server: remote });
  sockets.on("connection", (ws, req) => {
    assert.equal(req.headers.authorization, "Bearer child");
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.url, path + "sessions/" + session + "/stream");
    ws.send('{"type":"snapshot"}');
    ws.on("message", (data, binary) => ws.send(data, { binary }));
  });
  const relay = sdkServer({ upstreamOrigin: "http://127.0.0.1:" + remote.address().port, origins: [origin] }).listen(0, "127.0.0.1");
  await once(relay, "listening");
  const base = "http://127.0.0.1:" + relay.address().port;
  const headers = { origin, authorization: "Bearer child" };
  t.after(() => { for (const ws of sockets.clients) ws.terminate(); sockets.close(); remote.close(); relay.close(); });
  assert.equal((await fetch(base + path + "options?conversation_id=one", { headers })).status, 200);
  assert.equal((await fetch(base + path + "sessions", { headers })).status, 405);
  assert.equal((await fetch(base + path + "agents", { headers: { ...headers, authorization: "Bearer parent" } })).status, 401);
  const url = base.replace("http:", "ws:") + path + "sessions/" + session + "/stream";
  const ws = new WebSocket(url, { origin });
  await once(ws, "open");
  const ready = once(ws, "message");
  ws.send(JSON.stringify({ type: "authenticate", credential: "child" }));
  assert.equal((await ready)[0].toString(), '{"type":"snapshot"}');
  const reply = once(ws, "message");
  ws.send(Buffer.from([33, 12, 0, 42]));
  const [bytes, binary] = await reply;
  assert.equal(binary, true);
  assert.deepEqual(bytes, Buffer.from([33, 12, 0, 42]));
  ws.close();
  await once(ws, "close");
});

test("temporary voice forwards SDP only to the selected OpenAI connection", async t => {
  const requests = [];
  const server = sdkServer({ upstreamOrigin: "https://id.example", origins: [], request: async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith("/self")) return Response.json({api_key:{effective_services:[
      {id:"22caf9db-4c7d-4712-89e8-09c96c58489b",slug:"llm-openai",is_active:true},
    ]}});
    return new Response("v=0", { headers: { "Content-Type": "application/sdp" } });
  } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  const path = "/api/v1/proxy/s/llm-openai/realtime/calls";
  const query = "?_nyxid_via=22caf9db-4c7d-4712-89e8-09c96c58489b";
  const form = new FormData();
  form.set("sdp", "v=0");
  const post = { method: "POST", headers: { Authorization: "Bearer child" }, body: form };
  for (const target of [path, path + query + "&model=other", path + "?_nyxid_via=unknown"]) {
    assert.equal((await fetch(base + target, post)).status, 404);
  }
  assert.equal((await fetch(base + path + query, { method: "POST", body: form })).status, 401);
  assert.equal((await fetch(base + path + query, { ...post, body: "{}" })).status, 415);
  assert.equal(requests.length, 0);
  const answer = await fetch(base + path + query, post);
  assert.equal(await answer.text(), "v=0");
  assert.deepEqual(requests.map(r => r.url), ["https://id.example/api/v1/auth/agent-key/self", "https://id.example" + path + query]);
  assert.match(requests[1].options.headers.get("content-type"), /^multipart\/form-data; boundary=/);
  assert.match(requests[1].options.body.toString(), /name="sdp"/);
});
