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

  /** Paths are supplied as decoded segments. The caller selects an authorized service. */
  request(service: string, path: readonly string[], init: RequestInit = {}, query?: URLSearchParams) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(service) || !path.length ||
        path.some(part => !part || part === "." || part === ".." || /[/\\%?#]/.test(part))) {
      throw new Error("Invalid NyxID service or endpoint");
    }
    const url = new URL(this.#base);
    url.pathname = [url.pathname.replace(/\/$/, ""), "api/v1/proxy/s", service, ...path.map(encodeURIComponent)].join("/");
    url.search = query?.toString() ?? "";
    const request = this.#fetch;
    return request(url, { ...init, redirect: "error" });
  }
}
