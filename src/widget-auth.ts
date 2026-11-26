import { agentIdentity, agentKeyResponse } from "./agent-identity.ts";
import { defaultLocale, LocalizedError, type MessageKey } from "./i18n.ts";
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
const officialRelay = "https://nyx-assistant-sdk-chronoai.apps.nyxid.ai";

export interface PreviousGrant {
  credential: string;
  /** Remove this exact old record after encrypted storage and live verification. */
  forget(): void;
}
export interface BrowserAuthorizationOptions {
  language?: string;
  previousGrant?: () => PreviousGrant | undefined;
  base?: string | URL;
  verificationOrigin?: string;
  /** Explicit service slugs for a restricted grant, or the grants on the key approved at NyxID. */
  services: readonly string[] | "@key";
  keySource?: "existing" | "new";
  ownerId?: string;
  ownerType?: "personal";
  catalogServices?: readonly string[];
  clientLabel: string;
  /** Supply tab-local storage to resume a pending request after reloading. */
  storage?: Storage;
  /** Defaults to localStorage in browsers with Web Locks, IndexedDB and Web Crypto.
   * Pass null for an in-memory login or a Storage to select the encrypted grant store.
   * The non-exportable key lives in IndexedDB. Each restored grant is checked with NyxID.
   */
  credentialStorage?: Storage | null;
}

function defaultCredentialStorage() {
  try {
    if (typeof window !== "undefined" && window.navigator.locks && window.crypto?.subtle && window.indexedDB) {
      return window.localStorage;
    }
  } catch { /* Browser storage access can be denied for this origin. */ }
}

function matchesRequestedServices(key: z.infer<typeof agentKeyResponse>["api_key"], requested: string[]) {
  const rows = key.effective_services;
  const services = new Set(rows.map(row => row.catalog_service_slug ?? row.slug));
  const ids = new Set(rows.map(row => row.id));
  const scopes = key.scopes.trim().split(/\s+/);
  return !key.allow_all_services && !key.allow_auto_connected_services && !key.allow_all_nodes &&
    key.allowed_node_ids.length === 0 &&
    scopes.includes("proxy") && scopes.every(s => s === "proxy" || s === "read") &&
    rows.every(s => s.is_active && serviceSlug.safeParse(s.slug).success &&
      (s.catalog_service_slug == null || serviceSlug.safeParse(s.catalog_service_slug).success)) &&
    services.size === requested.length && requested.every(s => services.has(s)) &&
    ids.size === new Set(key.allowed_service_ids).size && key.allowed_service_ids.every(id => ids.has(id));
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
  readonly #services: string[] | "@key";
  readonly #options: BrowserAuthorizationOptions;
  readonly #storageKey: string;
  #active?: AbortController;

  #error(key: MessageKey, value = "") {
    return new LocalizedError(key, value, this.#options.language ?? defaultLocale);
  }

  constructor(options: BrowserAuthorizationOptions) {
    this.#base = new URL(options.base ?? officialRelay);
    new NyxIDConnection(this.#base);
    this.#base.pathname = this.#base.pathname.replace(/\/?$/, "/");
    const verification = new URL(options.verificationOrigin ?? (this.#base.origin === officialRelay ? "https://nyxid.ai" : this.#base.origin));
    new NyxIDConnection(verification);
    this.#origin = verification.origin;
    this.#services = options.services === "@key" ? "@key" : [...new Set(z.array(serviceSlug).min(1).parse(options.services))].sort();
    this.#options = { ...options };
    if (options.credentialStorage === undefined) this.#options.credentialStorage = defaultCredentialStorage();
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

  get persistent() {
    return Boolean(this.#options.credentialStorage);
  }

  async #withGrantLock<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    if (!this.#options.credentialStorage) return run();
    const locks = globalThis.navigator?.locks;
    if (!locks) throw this.#error("locksRequired");
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
    if (!response.ok) throw this.#error("restoreFailed", String(response.status));
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
    if (this.#active) throw this.#error("approvalActive");
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
        requested_profile: this.#services === "@key" ? undefined : "nyx-widget", client_label: this.#options.clientLabel,
        client_app: "nyx-assistant-sdk", client_form_factor: "browser",
      }, active);
      if (!reply.ok) throw this.#error("approvalFailed", String(reply.status));
      const value = challenge.parse(await reply.json());
      pending = { ...value, expiresAt: Date.now() + value.expires_in * 1000, nextPollAt: Date.now() + value.interval * 1000 };
    }
    const url = new URL(pending.verification_uri);
    if (url.origin !== this.#origin || url.pathname !== "/login/agent-key" || url.username || url.password || url.hash) {
      this.cancel();
      throw this.#error("invalidApprovalUrl");
    }
    url.search = new URLSearchParams({
      user_code: pending.user_code, login_type: "agent", key_source: this.#options.keySource ?? "existing",
      ...(this.#services === "@key" ? {} : { permissions: "proxy", services: this.#services.join(",") }),
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
        throw this.#error("approvalEnded");
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
      if (!response.ok && response.status !== 401) throw this.#error("revokeFailed");
      if (record) this.#forget(record);
    };
    const parsed = agentKeyResponse.safeParse(delivery);
    const key = parsed.data?.api_key;
    const identity = parsed.data && agentIdentity(parsed.data);
    if (signal.aborted || !key || !identity || (this.#options.ownerId && key.owner_id !== this.#options.ownerId) ||
        (this.#options.ownerType && key.owner_type !== this.#options.ownerType) ||
        this.#options.catalogServices?.some(slug => !key.effective_services.some(row => row.catalog_service_slug === slug)) ||
        (this.#services !== "@key" && !matchesRequestedServices(key, this.#services))) {
      await revokeChild();
      throw this.#error("invalidGrant");
    }
    if (!record && this.#options.credentialStorage) {
      try {
        record = await sealCredential(this.credentialStorageKey, credential);
        signal.throwIfAborted();
        this.#options.credentialStorage.setItem(this.credentialStorageKey, record);
      }
      catch { await revokeChild(); throw this.#error("saveGrantFailed"); }
    }
    const connection = NyxIDConnection.fromAgentKey(this.#base, credential);
    const revoke = () => this.#withGrantLock(undefined, revokeChild);
    const services = new Set(identity.services.map(row => row.catalogSlug ?? row.slug));
    const access = Object.freeze({
      services: Object.freeze([...services].sort()),
      managementUrl: new URL("/keys/api-key/" + encodeURIComponent(key.id), this.#origin).href,
    });
    return { identity, connection, revoke, access, managementUrl: access.managementUrl, ownerId: key.owner_id, keyId: key.id, credentialId: identity.credentialId };
  }
}
