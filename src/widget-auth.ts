import { NyxIDConnection } from "./connection.ts";
import { isSealed, openCredential, sealCredential } from "./credential-storage.ts";
import { z } from "zod";

const serviceSlug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const challenge = z.object({
  device_code: z.string().min(1).max(4096),
  user_code: z.string().regex(/^[A-Z0-9-]{4,32}$/),
  verification_uri: z.string().url(),
  interval: z.number().int().min(1).max(600),
  expires_in: z.number().int().positive().max(600),
});
const enrollment = challenge.extend({
  expiresAt: z.number().finite(), nextPollAt: z.number().finite(),
});
const keySummary = z.object({
  id: z.string().min(1), owner_id: z.string().min(1), owner_type: z.string().optional(), scopes: z.string(),
  allow_all_services: z.literal(false), allow_auto_connected_services: z.literal(false),
  allow_all_nodes: z.literal(false), allowed_node_ids: z.array(z.string()).length(0),
  allowed_service_ids: z.array(z.string()).min(1),
  effective_services: z.array(z.object({
    id: z.string(), slug: serviceSlug, catalog_service_slug: serviceSlug.nullish(), is_active: z.literal(true),
  })).min(1),
});

export interface PreviousGrant {
  credential: string;
  /** Remove this exact old record after encrypted storage and live verification. */
  forget(): void;
}
export interface BrowserAuthorizationOptions {
  previousGrant?: () => PreviousGrant | undefined;
  base: string | URL;
  verificationOrigin: string;
  services: readonly string[];
  keySource?: "existing" | "new";
  ownerId?: string;
  ownerType?: "personal";
  catalogServices?: readonly string[];
  clientLabel: string;
  /** Supply tab-local storage to resume a pending request after reloading. */
  storage?: Storage;
  /** Origin-local storage for the encrypted child credential. Requires Web Locks.
   * The non-exportable key lives in IndexedDB. Each restored grant is checked with NyxID.
   */
  credentialStorage?: Storage;
}

function sleepUntil(timestamp: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, Math.max(0, timestamp - Date.now()));
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** One flow per host identity. Each delivered grant owns a single child credential. */
export class BrowserAuthorization {
  readonly #base: URL;
  readonly #origin: string;
  readonly #services: string[];
  readonly #options: BrowserAuthorizationOptions;
  readonly #storageKey: string;
  #active?: AbortController;

  constructor(options: BrowserAuthorizationOptions) {
    this.#base = new URL(options.base);
    new NyxIDConnection(this.#base);
    this.#base.pathname = this.#base.pathname.replace(/\/?$/, "/");
    const verification = new URL(options.verificationOrigin);
    new NyxIDConnection(verification);
    this.#origin = verification.origin;
    this.#services = [...new Set(z.array(serviceSlug).min(1).parse(options.services))].sort();
    this.#options = { ...options };
    this.#storageKey = "nyx-assistant:pending:" + JSON.stringify([
      this.#base.href, this.#origin, options.ownerId ?? null, this.#services, options.keySource ?? "existing",
    ]);
  }

  #request(action: string, body: object, signal: AbortSignal) {
    return fetch(new URL("api/v1/auth/agent-key/" + action, this.#base), {
      method: "POST", credentials: "omit", redirect: "error", cache: "no-store",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
    });
  }

  cancel() {
    this.#active?.abort();
    this.#options.storage?.removeItem(this.#storageKey);
  }

  get credentialStorageKey() {
    return this.#storageKey.replace("nyx-assistant:pending:", "nyx-assistant:grant:");
  }

  get hasSavedGrant() {
    return Boolean(this.#options.credentialStorage?.getItem(this.credentialStorageKey));
  }

  async #withGrantLock<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    if (!this.#options.credentialStorage) return run();
    const locks = globalThis.navigator?.locks;
    if (!locks) throw Error("浏览器需要支持 Web Locks 才能使用站点授权存储。");
    return locks.request(this.credentialStorageKey, { signal }, run);
  }

  async restore(signal: AbortSignal) {
    if (!this.hasSavedGrant && !this.#options.previousGrant) return undefined;
    return this.#withGrantLock(signal, async () => {
      const store = this.#options.credentialStorage;
      const previous = this.#options.previousGrant?.();
      if (!store || !previous) return this.#restore(signal);
      const record = store.getItem(this.credentialStorageKey);
      if (record && await openCredential(this.credentialStorageKey, record) !== previous.credential)
        return this.#restore(signal);
      if (!record) {
        const sealed = await sealCredential(this.credentialStorageKey, previous.credential);
        signal.throwIfAborted();
        store.setItem(this.credentialStorageKey, sealed);
      }
      const grant = await this.#restore(signal);
      signal.throwIfAborted();
      previous.forget();
      return grant;
    });
  }

  async #restore(signal: AbortSignal) {
    const store = this.#options.credentialStorage;
    if (!store) return undefined;
    signal.throwIfAborted();
    let record = store.getItem(this.credentialStorageKey);
    if (!record) return undefined;
    let credential: string | undefined;
    if (isSealed(record)) {
      credential = await openCredential(this.credentialStorageKey, record);
      if (!credential) {
        this.#forget(record);
        return undefined;
      }
    } else {
      // Migrate a grant written by alpha.4 before any network operation.
      credential = record;
      const sealed = await sealCredential(this.credentialStorageKey, credential);
      signal.throwIfAborted();
      if (store.getItem(this.credentialStorageKey) !== record) return undefined;
      store.setItem(this.credentialStorageKey, sealed);
      record = sealed;
    }
    const response = await fetch(new URL("api/v1/auth/agent-key/self", this.#base), {
      credentials: "omit", redirect: "error", cache: "no-store", signal,
      headers: { Authorization: "Bearer " + credential },
    });
    if (response.status === 401) {
      this.#forget(record);
      return undefined;
    }
    if (!response.ok) throw Error("无法核验已保存的 NyxID 授权（HTTP " + response.status + "）。");
    const identity = await response.json();
    signal.throwIfAborted();
    if (store.getItem(this.credentialStorageKey) !== record) return undefined;
    return this.#grant({ ...identity, credential }, signal, record);
  }

  #forget(record: string) {
    const store = this.#options.credentialStorage;
    if (store?.getItem(this.credentialStorageKey) === record) store.removeItem(this.credentialStorageKey);
  }

  #saved() {
    const raw = this.#options.storage?.getItem(this.#storageKey);
    if (raw && raw.length < 16384) {
      try {
        const value = enrollment.parse(JSON.parse(raw));
        const now = Date.now();
        if (value.expiresAt > now && value.expiresAt <= now + 600000 && value.nextPollAt <= value.expiresAt) return value;
      } catch { /* Invalid or expired entries are replaced by a new request. */ }
    }
    this.#options.storage?.removeItem(this.#storageKey);
    return undefined;
  }

  async connect(signal: AbortSignal, showLink: (url: URL, code: string) => void) {
    if (this.#active) throw Error("此实例已有待完成的 NyxID 授权。");
    const controller = new AbortController();
    const active = AbortSignal.any([signal, controller.signal]);
    this.#active = controller;
    try {
      // Hold the slot from the saved-grant check through delivery so only one tab can enroll.
      return await this.#withGrantLock(active, async () => {
        const saved = await this.#restore(active);
        return saved ?? this.#enroll(active, showLink);
      });
    } finally {
      this.#active = undefined;
    }
  }

  async #enroll(active: AbortSignal, showLink: (url: URL, code: string) => void) {
    active.throwIfAborted();
    let pending = this.#saved();
    if (!pending) {
      const reply = await this.#request("request", {
        requested_profile: "nyx-widget", client_label: this.#options.clientLabel,
        client_app: "nyx-assistant-sdk", client_form_factor: "browser",
      }, active);
      if (!reply.ok) throw Error("NyxID 授权请求失败（HTTP " + reply.status + "）。");
      const value = challenge.parse(await reply.json());
      pending = { ...value, expiresAt: Date.now() + value.expires_in * 1000, nextPollAt: Date.now() + value.interval * 1000 };
    }
    const url = new URL(pending.verification_uri);
    if (url.origin !== this.#origin || url.pathname !== "/login/agent-key" || url.username || url.password || url.hash) {
      this.cancel();
      throw Error("授权页面地址与配置的 NyxID 登录站点不符。");
    }
    url.search = new URLSearchParams({
      user_code: pending.user_code, login_type: "agent", key_source: this.#options.keySource ?? "existing",
      permissions: "proxy", services: this.#services.join(","),
    }).toString();
    active.throwIfAborted();
    const store = this.#options.storage;
    store?.setItem(this.#storageKey, JSON.stringify(pending));
    showLink(url, pending.user_code);
    const lifetime = AbortSignal.any([active, AbortSignal.timeout(Math.max(0, pending.expiresAt - Date.now()))]);
    let interval = pending.interval * 1000;
    for (;;) {
      await sleepUntil(pending.nextPollAt, lifetime);
      const response = await this.#request("poll", { device_code: pending.device_code }, lifetime);
      const delivery = await response.json();
      if (response.ok) {
        store?.removeItem(this.#storageKey);
        return await this.#grant(delivery, active);
      }
      if (delivery.error === "agent_key_login_slow_down") interval += 5000;
      else if (delivery.error !== "agent_key_login_pending") {
        store?.removeItem(this.#storageKey);
        throw Error("NyxID 授权已拒绝、已交付或已过期，请重新连接。");
      }
      pending.nextPollAt = Math.min(Date.now() + interval, pending.expiresAt);
      store?.setItem(this.#storageKey, JSON.stringify(pending));
    }
  }

  async #grant(delivery: unknown, signal: AbortSignal, record?: string) {
    const { credential } = z.object({ credential: z.string().min(1) }).parse(delivery);
    const revokeChild = async () => {
      const response = await fetch(new URL("api/v1/auth/agent-key/self", this.#base), {
        method: "DELETE", redirect: "error", credentials: "omit", keepalive: true,
        headers: { Authorization: "Bearer " + credential },
      });
      if (!response.ok && response.status !== 401) throw Error("NyxID 未确认撤销，请重试断开授权。");
      if (record) this.#forget(record);
    };
    const parsed = z.object({ credential_id: z.string().min(1), api_key: keySummary }).safeParse(delivery);
    const key = parsed.data?.api_key;
    const services = new Set(key?.effective_services.map(row => row.catalog_service_slug ?? row.slug));
    const ids = new Set(key?.effective_services.map(row => row.id));
    const scopes = key?.scopes.trim().split(/\s+/) ?? [];
    if (signal.aborted || !key || (this.#options.ownerId && key.owner_id !== this.#options.ownerId) ||
        (this.#options.ownerType && key.owner_type !== this.#options.ownerType) ||
        this.#options.catalogServices?.some(slug => !key.effective_services.some(row => row.catalog_service_slug === slug)) ||
        !scopes.includes("proxy") || scopes.some(s => s !== "proxy" && s !== "read") ||
        services.size !== this.#services.length || this.#services.some(s => !services.has(s)) ||
        ids.size !== new Set(key.allowed_service_ids).size || key.allowed_service_ids.some(id => !ids.has(id))) {
      await revokeChild();
      throw Error("本次浏览器授权已撤销。请选择请求的账号、proxy 权限和页面列出的服务。");
    }
    if (!record && this.#options.credentialStorage) {
      try {
        record = await sealCredential(this.credentialStorageKey, credential);
        signal.throwIfAborted();
        this.#options.credentialStorage.setItem(this.credentialStorageKey, record);
      }
      catch { await revokeChild(); throw Error("浏览器无法保存此授权，请检查站点存储设置。"); }
    }
    const connection = new NyxIDConnection(this.#base, (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", "Bearer " + credential);
      return fetch(input, { ...init, credentials: "omit", headers });
    });
    const revoke = () => this.#withGrantLock(undefined, revokeChild);
    return { connection, revoke, ownerId: key.owner_id, keyId: key.id, credentialId: parsed.data!.credential_id };
  }
}
