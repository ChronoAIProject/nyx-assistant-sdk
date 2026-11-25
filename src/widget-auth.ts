import { NyxIDConnection } from "./connection.ts";
import { z } from "zod";

const challenge = z.object({
  device_code: z.string().min(1),
  user_code: z.string().regex(/^[A-Z0-9-]{4,32}$/),
  verification_uri: z.string().url(),
  interval: z.number().int().min(1).max(600),
  expires_in: z.number().int().positive().max(600),
});

export async function authorizeBrowser(
  base: URL,
  verificationOrigin: string,
  signal: AbortSignal,
  showLink: (url: URL, code: string) => void,
) {
  const endpoint = (action: string) =>
    new URL("api/v1/auth/agent-key/" + action, base);
  const post = (action: string, body: object, abort: AbortSignal) =>
    fetch(endpoint(action), {
      method: "POST",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: abort,
    });
  const reply = await post(
    "request",
    {
      requested_profile: "nyx-widget",
      client_label: location.hostname,
      client_app: "nyx-assistant-sdk",
      client_form_factor: "browser",
    },
    signal,
  );
  if (!reply.ok)
    throw Error("NyxID 授权请求失败（HTTP " + reply.status + "）。");
  const pending = challenge.parse(await reply.json());
  const url = new URL(pending.verification_uri);
  if (
    url.origin !== verificationOrigin ||
    url.pathname !== "/login/agent-key" ||
    url.username ||
    url.password
  ) {
    throw Error("授权页面地址与配置的 NyxID 登录站点不符。");
  }
  url.search = new URLSearchParams({
    user_code: pending.user_code,
    login_type: "agent",
    key_source: "existing",
    permissions: "proxy",
    services: "llm-nyx,chrono-llm-public",
  }).toString();
  signal.throwIfAborted();
  showLink(url, pending.user_code);
  const lifetime = AbortSignal.any([
    signal,
    AbortSignal.timeout(pending.expires_in * 1000),
  ]);
  let delay = pending.interval * 1000;
  for (;;) {
    await new Promise<void>((resolve, reject) => {
      lifetime.throwIfAborted();
      const abort = () => {
        clearTimeout(timer);
        reject(lifetime.reason);
      };
      const timer = setTimeout(() => {
        lifetime.removeEventListener("abort", abort);
        resolve();
      }, delay);
      lifetime.addEventListener("abort", abort, { once: true });
    });
    const response = await post(
      "poll",
      { device_code: pending.device_code },
      lifetime,
    );
    const delivery = await response.json();
    if (response.ok) {
      const { credential } = z
        .object({ credential: z.string().min(1) })
        .parse(delivery);
      const connection = new NyxIDConnection(base, (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("Authorization", "Bearer " + credential);
        return fetch(input, { ...init, credentials: "omit", headers });
      });
      return {
        connection,
        async revoke() {
          const result = await fetch(endpoint("self"), {
            method: "DELETE",
            redirect: "error",
            credentials: "omit",
            keepalive: true,
            headers: { Authorization: "Bearer " + credential },
          });
          if (!result.ok && result.status !== 401)
            throw Error("NyxID 未确认撤销，请在账号中核对。");
        },
      };
    }
    if (delivery.error === "agent_key_login_slow_down") delay += 5000;
    else if (delivery.error !== "agent_key_login_pending")
      throw Error("NyxID 授权未完成，请重新连接。");
  }
}
