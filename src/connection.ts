import { agentIdentity, agentKeyResponse, serviceConnection, serviceListResponse, type AgentIdentity } from "./agent-identity.ts";

export const NYXBOT_VOICE_SERVICE = "nyxbot-voice";
type Service = AgentIdentity["services"][number];

/** NyxID's service proxy. The host supplies a fetch bound to its current credential. */
export class NyxIDConnection {
  readonly #base: URL;
  readonly #fetch: typeof fetch;
  #credential?: string;

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

  /** Bind a child Agent Key credential to HTTP requests. */
  static fromAgentKey(baseUrl: string | URL, credential: string) {
    if (!credential || /[\s,]/.test(credential)) throw new Error("Invalid Agent Key credential");
    const connection = new NyxIDConnection(baseUrl, (url, init) => {
      const headers = new Headers(init?.headers);
      headers.delete("cookie");
      headers.delete("x-api-key");
      headers.set("Authorization", "Bearer " + credential);
      return fetch(url, { ...init, headers, credentials: "omit" });
    });
    connection.#credential = credential;
    return connection;
  }

  /** Read the live Agent Key identity and its exact authorized service connections. */
  async getAgentIdentity(signal?: AbortSignal) {
    const response = await this.#request(this.#url("api/v1/auth/agent-key/self", []), {
      cache: "no-store", credentials: "omit", signal,
    });
    if (!response.ok) throw new Error("NyxID Agent Key lookup failed (HTTP " + response.status + ")");
    const result = agentKeyResponse.safeParse(await response.json());
    if (!result.success) throw new Error("Invalid NyxID Agent Key metadata");
    return agentIdentity(result.data);
  }

  /** List the connections visible to an ordinary Agent Key or a login child with read scope. */
  async getServiceConnections(signal?: AbortSignal) {
    const response = await this.#request(this.#url("api/v1/keys", []), {
      cache: "no-store", credentials: "omit", signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`NyxID service discovery returned HTTP ${response.status}`);
    }
    return serviceListResponse.parse(await response.json()).keys.map(serviceConnection);
  }

  /** Paths are supplied as decoded segments. The caller selects an authorized service. */
  request(service: string, path: readonly string[], init: RequestInit = {}, query?: URLSearchParams) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(service) || !path.length) {
      throw new Error("Invalid NyxID service or endpoint");
    }
    return this.#request(this.#url("api/v1/proxy/s/" + service, path, query), init);
  }

  /** Select one concrete UserService when a catalog slug has multiple connections. */
  requestService(service: Service, path: readonly string[], init: RequestInit = {}, query?: URLSearchParams) {
    return this.#request(this.#serviceUrl(service, path, query), init);
  }

  #serviceUrl(service: Service, path: readonly string[], query?: URLSearchParams) {
    const slug = service.catalogSlug ?? service.slug;
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(service.id)) {
      throw new Error("Expected a NyxID service connection UUID");
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error("Invalid NyxID service slug");
    const params = new URLSearchParams(query);
    if (slug === NYXBOT_VOICE_SERVICE) {
      params.delete("_nyxid_via");
      return this.#url(`api/v1/proxy/${slug}/${service.id}`, path, params);
    }
    params.set("_nyxid_via", service.id);
    return this.#url("api/v1/proxy/s/" + slug, path, params);
  }

  /** Open a credential-bound WebSocket in runtimes that support custom headers. */
  openWebSocket<T>(service: Service, path: readonly string[], factory: (url: URL, credential: string) => T) {
    if (!this.#credential) throw new Error("This connection has no Agent Key WebSocket credential");
    const url = this.#serviceUrl(service, path);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return factory(url, this.#credential);
  }

  #url(route: string, path: readonly string[], query?: URLSearchParams) {
    if (path.some(part => !part || part === "." || part === ".." || /[/\\%?#]/.test(part))) {
      throw new Error("Invalid NyxID service or endpoint");
    }
    const url = new URL(this.#base);
    url.pathname = [url.pathname.replace(/\/$/, ""), route, ...path.map(encodeURIComponent)].join("/");
    url.search = query?.toString() ?? "";
    return url;
  }

  #request(url: URL, init: RequestInit) {
    const request = this.#fetch;
    return request(url, { ...init, redirect: "error" });
  }
}
