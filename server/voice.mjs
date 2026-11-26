import WebSocket, { WebSocketServer } from "ws";

const uuid = "[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}";
const prefix = "^/api/v1/proxy/nyxbot-voice/" + uuid + "/voice/";
const read = new RegExp(prefix + "(?:agents|options(?:\\?conversation_id=[A-Za-z0-9._~%+:-]{1,384})?|sessions/" + uuid + ")$");
const write = new RegExp(prefix + "(?:sessions|sessions/" + uuid + "/(?:control|announcements))$");
const stream = new RegExp(prefix + "sessions/" + uuid + "/stream$");

export function voiceMethods(path) {
  if (read.test(path)) return ["GET"];
  if (write.test(path)) return ["POST"];
  return [];
}

export function attachVoiceStreams(server, upstream, origins, request) {
  const limit = 256 * 1024;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: limit, perMessageDeflate: false });
  server.on("upgrade", (req, socket, head) => {
    if (!stream.test(req.url) || !origins.has(req.headers.origin) || req.headers["sec-websocket-protocol"]) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(req, socket, head, browser => {
      let remote;
      let authenticating = false;
      const controller = new AbortController();
      const stop = () => {
        clearTimeout(timer);
        controller.abort();
        remote?.terminate();
        browser.terminate();
      };
      const timer = setTimeout(stop, 10_000);
      const forward = (target, data, binary) => {
        if (target?.readyState !== WebSocket.OPEN || target.bufferedAmount > limit) return stop();
        target.send(data, { binary }, error => { if (error) stop(); });
      };
      browser.on("error", stop);
      browser.once("close", stop);
      browser.on("message", async (data, binary) => {
        if (remote) return forward(remote, data, binary);
        if (authenticating || binary || data.length > 4096) return stop();
        authenticating = true;
        try {
          const { type, credential } = JSON.parse(data.toString());
          if (type !== "authenticate" || typeof credential !== "string" || !/^[!-~]+$/.test(credential) || credential.includes(",")) return stop();
          const headers = { Authorization: "Bearer " + credential };
          const self = await request(upstream + "/api/v1/auth/agent-key/self", { headers, redirect: "error", signal: controller.signal });
          await self.body?.cancel();
          if (!self.ok || controller.signal.aborted) return stop();
          const url = new URL(req.url, upstream);
          url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
          remote = new WebSocket(url, { headers, maxPayload: limit, perMessageDeflate: false, followRedirects: false });
          remote.once("open", () => clearTimeout(timer));
          remote.on("message", (frame, binary) => forward(browser, frame, binary));
          remote.on("error", stop);
          remote.once("close", stop);
        } catch {
          stop();
        }
      });
    });
  });
  server.once("close", () => sockets.close());
  return server;
}
