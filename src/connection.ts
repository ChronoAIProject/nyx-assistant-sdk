import { agentIdentity, agentKeyResponse, type AgentIdentity } from "./agent-identity.ts";

/** NyxID's service proxy. The host supplies a fetch bound to its current credential. */
export class NyxIDConnection {
  readonly #base: URL;
  readonly #fetch: typeof fetch;

  constructor(baseUrl: string | URL, authenticatedFetch: typeof fetch = fetch) {
    this.#base = new URL(baseUrl);
    if (this.#base.username || this.#base.password || this.#base.search || this.#base.hash) {
      throw new Error("Use a NyxID base URL without credentials, query or fragment");
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(this.#base.hostname);
    if (this.#base.protocol !== "https:" && !(loopback && this.#base.protocol === "http:")) {
      throw new Error("NyxID requires HTTPS or a local development endpoint");
    }
    this.#fetch = authenticatedFetch;
  }

  /** Bind the credential delivered by NyxID Agent Key login to this API base. */
  static fromAgentKey(baseUrl: string | URL, credential: string) {
    if (!credential || /[\s,]/.test(credential)) throw new Error("Invalid Agent Key credential");
    return new NyxIDConnection(baseUrl, (url, init) => {
      const headers = new Headers(init?.headers);
      headers.delete("cookie");
      headers.delete("x-api-key");
      headers.set("Authorization", "Bearer " + credential);
      return fetch(url, { ...init, headers, credentials: "omit" });
    });
  }

  /** Read the live key, login and effective service connections from NyxID. */
  async getAgentIdentity(signal?: AbortSignal) {
    const response = await this.#request("api/v1/auth/agent-key/self", [], {
      cache: "no-store", credentials: "omit", signal,
    });
    if (!response.ok) throw new Error("NyxID Agent Key lookup failed (HTTP " + response.status + ")");
    const result = agentKeyResponse.safeParse(await response.json());
    if (!result.success) throw new Error("Invalid NyxID Agent Key metadata");
    return agentIdentity(result.data);
  }

  /** Paths are supplied as decoded segments. The caller selects an authorized service. */
  request(service: string, path: readonly string[], init: RequestInit = {}, query?: URLSearchParams) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(service) || !path.length) {
      throw new Error("Invalid NyxID service or endpoint");
    }
    return this.#request("api/v1/proxy/s/" + service, path, init, query);
  }

  /** Select one concrete service connection, including when several share a catalog slug. */
  requestService(service: AgentIdentity["services"][number], path: readonly string[], init: RequestInit = {}, query?: URLSearchParams) {
    const { id } = service;
    const slug = service.catalogSlug ?? service.slug;
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) {
      throw new Error("Expected a NyxID service connection UUID");
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error("Invalid NyxID service slug");
    const params = new URLSearchParams(query);
    params.set("_nyxid_via", id);
    return this.#request("api/v1/proxy/s/" + slug, path, init, params);
  }

  #request(route: string, path: readonly string[], init: RequestInit, query?: URLSearchParams) {
    if (path.some(part => !part || part === "." || part === ".." || /[/\\%?#]/.test(part))) {
      throw new Error("Invalid NyxID service or endpoint");
    }
    const url = new URL(this.#base);
    url.pathname = [url.pathname.replace(/\/$/, ""), route, ...path.map(encodeURIComponent)].join("/");
    url.search = query?.toString() ?? "";
    const request = this.#fetch;
    return request(url, { ...init, redirect: "error" });
  }
}
