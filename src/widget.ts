import { AssistantHost, NyxIDConnection, z } from "./index.ts";
import { createNyxChatService } from "./nyx-chat.ts";
import { authorizeBrowser } from "./widget-auth.ts";
import { widgetStyle } from "./widget-style.ts";

class NyxAssistantElement extends HTMLElement {
  #root = this.attachShadow({ mode: "open" });
  #host?: AssistantHost;
  #login?: AbortController;
  #revoke?: () => Promise<void>;
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
    } else this.#controls();
    window.addEventListener("pagehide", this.#pagehide);
    window.addEventListener("pageshow", this.#pageshow);
  }
  #pagehide = () => this.#release();
  #pageshow = (event: PageTransitionEvent) => {
    if (event.persisted) {
      this.disconnectedCallback();
      this.connectedCallback();
    }
  };
  disconnectedCallback() {
    window.removeEventListener("pagehide", this.#pagehide);
    window.removeEventListener("pageshow", this.#pageshow);
    this.#release();
  }
  #release() {
    this.#login?.abort();
    this.#login = undefined;
    this.#host?.dispose();
    this.#host = undefined;
    this.#busy = false;
    this.#el(".chat").replaceChildren();
    this.#el<HTMLTextAreaElement>("textarea").value = "";
    this.#el(".status").textContent = "";
    this.#el(".verify").hidden = true;
    const revoke = this.#revoke;
    this.#revoke = undefined;
    this.#controls();
    return revoke?.().catch(() => {
      if (!this.#host)
        this.#el(".status").textContent =
          "请在 NyxID 核对浏览器子凭据的撤销状态。";
    });
  }
  /** Bind a credential-bound connection on login or identity change. */
  bind(connection: NyxIDConnection) {
    void this.#release();
    const host = new AssistantHost(createNyxChatService(connection), () => ({
      title: document.title,
      language: document.documentElement.lang,
    }));
    this.#host = host;
    this.#controls();
    this.dispatchEvent(
      new CustomEvent("nyx-ready", {
        bubbles: true,
        composed: true,
        detail: { host, z },
      }),
    );
  }
  async #connect() {
    if (this.#login || this.#host) return;
    const login = new AbortController();
    this.#login = login;
    this.#controls();
    this.#el(".status").textContent = "正在连接 NyxID…";
    try {
      const base = new URL(this.dataset.nyxid || "https://nyx.chrono-ai.fun");
      new NyxIDConnection(base);
      base.pathname = base.pathname.replace(/\/?$/, "/");
      const grant = await authorizeBrowser(
        base,
        new URL(this.dataset.verificationOrigin || base.origin).origin,
        login.signal,
        (url, code) => {
          const link = this.#el<HTMLAnchorElement>(".verify");
          link.href = url.href;
          link.textContent = "打开 NyxID 授权页";
          link.hidden = false;
          this.#el(".status").textContent = "在 NyxID 核对授权码 " + code;
        },
      );
      if (login.signal.aborted) {
        await grant.revoke();
        return;
      }
      this.bind(grant.connection);
      this.#revoke = grant.revoke;
      this.#controls();
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
    await this.#release();
    this.#el(".connect").focus();
  }
  #controls() {
    const pending = Boolean(this.#host?.pendingRequestId);
    this.#el(".connect").hidden = Boolean(this.#host || this.#login);
    this.#el(".disconnect").hidden = !this.#revoke && !this.#login;
    this.#el("form").hidden = !this.#host;
    this.#el<HTMLButtonElement>(".send").disabled = this.#busy || pending;
    this.#el(".resume").hidden = this.#busy || !pending;
  }
  #open(open: boolean) {
    this.#el(".panel").hidden = !open;
    const launch = this.#el(".launch");
    launch.hidden = open;
    launch.setAttribute("aria-expanded", String(open));
    const focus = this.#host ? "textarea" : this.#login ? ".close" : ".connect";
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
  for (const name of ["data-nyxid", "data-verification-origin", "data-proxy"]) {
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
