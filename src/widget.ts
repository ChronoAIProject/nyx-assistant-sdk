import { AssistantHost, NyxIDConnection, z } from "./index.ts";
import { createNyxChatService } from "./nyx-chat.ts";
import { BrowserAuthorization } from "./widget-auth.ts";
import { widgetStyle } from "./widget-style.ts";

class NyxAssistantElement extends HTMLElement {
  #root = this.attachShadow({ mode: "open" });
  #host?: AssistantHost;
  #login?: AbortController;
  #revoke?: () => Promise<void>;
  #revoking = false;
  #authorization?: BrowserAuthorization;
  #busy = false;
  get host() {
    return this.#host;
  }
  get z() {
    return z;
  }

  constructor() {
    super();
    // Only static markup is parsed. Page titles, messages and service output use textContent.
    this.#root.innerHTML = `<style>${widgetStyle}</style>
      <button class="launch" type="button" aria-expanded="false" aria-controls="panel"><span class="bubble" aria-hidden="true"></span>Nyx 助手</button>
      <section hidden id="panel" class="panel" role="dialog" aria-labelledby="title">
        <header><h2 id="title">Nyx 助手</h2><button class="disconnect" type="button" hidden>断开授权</button>
          <button class="close" type="button" aria-label="收起助手">×</button></header>
        <div class="chat" role="log" aria-label="聊天记录" aria-live="polite"></div>
        <div class="controls"><p class="status" role="status"></p>
          <a class="verify" hidden target="_blank" rel="noopener noreferrer"></a>
          <button class="connect" type="button">连接 NyxID</button>
          <form hidden><textarea aria-label="消息" placeholder="给 Nyx 发消息…" required></textarea>
            <button class="send" type="submit">发送</button></form>
          <button class="resume" hidden type="button">核对原请求</button>
        </div>
      </section>`;
    this.#el(".launch").onclick = () => this.#open(true);
    this.#el(".close").onclick = () => this.#open(false);
    this.#el(".connect").onclick = () => {
      void this.#connect();
    };
    this.#el(".disconnect").onclick = () => {
      void this.#disconnect();
    };
    this.#el("form").onsubmit = (e) => {
      e.preventDefault();
      void this.#send(false);
    };
    this.#el(".resume").onclick = () => {
      void this.#send(true);
    };
    this.#el("textarea").onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void this.#send(false);
      }
    };
    this.#el(".panel").onkeydown = (e) => {
      if (e.key === "Escape") this.#open(false);
    };
  }
  #el<T extends HTMLElement = HTMLElement>(selector: string): T {
    return this.#root.querySelector<T>(selector)!;
  }
  connectedCallback() {
    if (this.hasAttribute("data-proxy")) {
      this.bind(
        new NyxIDConnection(new URL(this.dataset.proxy || "/", location.href)),
      );
    } else {
      this.#controls();
      if (this.dataset.storage === "local") void this.#connect(true);
    }
    window.addEventListener("storage", this.#storageChanged);
    window.addEventListener("pagehide", this.#pagehide);
    window.addEventListener("pageshow", this.#pageshow);
  }
  #storageChanged = (event: StorageEvent) => {
    if (this.#persistent && (event.key === null || event.key === this.#authorization?.credentialStorageKey)) {
      void this.#release();
      void this.#connect(true);
    }
  };
  #pagehide = () => this.#release();
  #pageshow = (event: PageTransitionEvent) => {
    if (event.persisted) {
      this.disconnectedCallback();
      this.connectedCallback();
    }
  };
  disconnectedCallback() {
    window.removeEventListener("storage", this.#storageChanged);
    window.removeEventListener("pagehide", this.#pagehide);
    window.removeEventListener("pageshow", this.#pageshow);
    this.#release();
  }
  #release() {
    const revoke = this.#revoking ? undefined : this.#revoke;
    this.#revoke = undefined;
    this.#revoking = false;
    this.#clearView();
    return (this.#persistent ? undefined : revoke?.())?.catch(() => {
      if (!this.#host)
        this.#el(".status").textContent =
          "请在 NyxID 核对浏览器子凭据的撤销状态。";
    });
  }
  #clearView() {
    this.#login?.abort();
    this.#login = undefined;
    this.#host?.dispose();
    this.#host = undefined;
    this.#busy = false;
    this.#el(".chat").replaceChildren();
    this.#el<HTMLTextAreaElement>("textarea").value = "";
    this.#el(".status").textContent = "";
    this.#el(".verify").hidden = true;
    this.#controls();
  }
  /** Bind a credential-bound connection on login or identity change. */
  bind(connection: NyxIDConnection) {
    this.#bind(connection);
  }
  #bind(connection: NyxIDConnection, revoke?: () => Promise<void>) {
    void this.#release();
    const host = new AssistantHost(createNyxChatService(connection), () => ({
      title: document.title,
      language: document.documentElement.lang,
    }));
    this.#host = host;
    this.#revoke = revoke;
    this.#controls();
    this.dispatchEvent(
      new CustomEvent("nyx-ready", {
        bubbles: true,
        composed: true,
        detail: { host, z },
      }),
    );
  }
  #persistent = false;
  #createFlow() {
    const base = new URL(this.dataset.nyxid || "https://nyx.chrono-ai.fun");
    let storage: Storage | undefined;
    let credentialStorage: Storage | undefined;
    if (this.dataset.storage === "local") credentialStorage = localStorage;
    this.#persistent = Boolean(credentialStorage);
    try { storage = sessionStorage; } catch { /* Storage is optional for this visit. */ }
    const services = (this.dataset.services ?? "llm-nyx,chrono-llm-public").split(",").map(s => s.trim());
    return new BrowserAuthorization({
      base, verificationOrigin: this.dataset.verificationOrigin || base.origin, services, storage, credentialStorage,
      clientLabel: location.hostname, keySource: this.dataset.keySource === "new" ? "new" : "existing",
    });
  }
  async #connect(restoreOnly = false) {
    if (this.#login || this.#host || this.#revoke) return;
    const login = new AbortController();
    this.#login = login;
    this.#controls();
    this.#el(".status").textContent = "正在连接 NyxID…";
    try {
      const flow = this.#authorization ??= this.#createFlow();
      const restored = await flow.restore(login.signal);
      if (login.signal.aborted) return;
      if (restoreOnly && !restored) {
        this.#el(".status").textContent = "";
        return;
      }
      const grant = restored ?? await flow.connect(login.signal,
        (url, code) => {
          const link = this.#el<HTMLAnchorElement>(".verify");
          link.href = url.href;
          link.textContent = "打开 NyxID 授权页";
          link.hidden = false;
          this.#el(".status").textContent = "在 NyxID 核对授权码 " + code;
          this.#controls();
        },
      );
      if (login.signal.aborted) {
        if (!restored && !this.#persistent) await grant.revoke();
        return;
      }
      this.#bind(grant.connection, grant.revoke);
      if (!this.#el(".panel").hidden) this.#el("textarea").focus();
    } catch (error) {
      if (!login.signal.aborted)
        this.#el(".status").textContent =
          error instanceof Error ? error.message : "无法连接 NyxID。";
    } finally {
      if (this.#login === login) {
        this.#login = undefined;
        this.#el(".verify").hidden = true;
        this.#controls();
      }
    }
  }
  async #disconnect() {
    const revoke = this.#revoke;
    if (this.#revoking || (!revoke && this.#el(".verify").hidden)) return;
    this.#authorization?.cancel();
    if (!revoke) {
      void this.#release();
      this.#el(".connect").focus();
      return;
    }
    this.#revoking = true;
    this.#clearView();
    this.#el(".status").textContent = "正在撤销 NyxID 授权…";
    let failed = false;
    try {
      await revoke();
    } catch {
      failed = true;
    }
    if (this.#revoke !== revoke) return;
    this.#revoking = false;
    if (!failed) this.#revoke = undefined;
    this.#el(".status").textContent = failed ? "NyxID 未确认撤销，请重试断开授权。" : "";
    this.#controls();
    if (!this.#el(".panel").hidden) this.#el(failed ? ".disconnect" : ".connect").focus();
  }
  #controls() {
    const pending = Boolean(this.#host?.pendingRequestId);
    const waitingForApproval = Boolean(this.#login && !this.#el(".verify").hidden);
    const disconnect = this.#el<HTMLButtonElement>(".disconnect");
    this.#el(".connect").hidden = Boolean(this.#host || this.#login || this.#revoke);
    disconnect.hidden = !this.#revoke && !waitingForApproval;
    disconnect.disabled = this.#revoking;
    disconnect.textContent = waitingForApproval ? "停止等待授权" : "断开授权";
    this.#el("form").hidden = !this.#host;
    this.#el<HTMLButtonElement>(".send").disabled = this.#busy || pending;
    this.#el(".resume").hidden = this.#busy || !pending;
  }
  #open(open: boolean) {
    this.#el(".panel").hidden = !open;
    const launch = this.#el(".launch");
    launch.hidden = open;
    launch.setAttribute("aria-expanded", String(open));
    let focus = ".connect";
    if (this.#host) focus = "textarea";
    else if (this.#login || this.#revoking) focus = ".close";
    else if (this.#revoke) focus = ".disconnect";
    this.#el(open ? focus : ".launch").focus();
  }
  #message(text: string, isUser: boolean) {
    const chat = this.#el(".chat"),
      message = document.createElement("p");
    message.className = isUser ? "msg user" : "msg";
    message.setAttribute("aria-label", isUser ? "你" : "Nyx");
    message.textContent = text;
    chat.append(message);
    chat.scrollTop = chat.scrollHeight;
  }
  async #send(resume: boolean) {
    const host = this.#host,
      input = this.#el<HTMLTextAreaElement>("textarea");
    if (!host || this.#busy || Boolean(host.pendingRequestId) !== resume)
      return;
    const text = input.value.trim();
    if (!resume) {
      if (!text) return;
      this.#message(text, true);
      input.value = "";
    }
    this.#busy = true;
    this.#controls();
    this.#el(".status").textContent = resume
      ? "正在核对原请求…"
      : "正在等待回复…";
    try {
      const answer = await (resume ? host.resume() : host.send(text));
      if (host !== this.#host) return;
      this.#message(answer, false);
      this.#el(".status").textContent = "";
    } catch (error) {
      if (host === this.#host)
        this.#el(".status").textContent =
          error instanceof Error ? error.message : "请求失败。";
    } finally {
      if (host === this.#host) {
        this.#busy = false;
        this.#controls();
      }
    }
  }
}

const script = document.currentScript as HTMLScriptElement | null;
function mount() {
  if (document.querySelector("nyx-assistant")) return;
  const widget = document.createElement("nyx-assistant");
  for (const name of ["data-nyxid", "data-verification-origin", "data-proxy", "data-services", "data-key-source", "data-storage"]) {
    if (script?.hasAttribute(name))
      widget.setAttribute(name, script.getAttribute(name)!);
  }
  if (script?.dataset.position === "left")
    widget.setAttribute("position", "left");
  document.body.append(widget);
}
if (!customElements.get("nyx-assistant")) {
  customElements.define("nyx-assistant", NyxAssistantElement);
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
}
