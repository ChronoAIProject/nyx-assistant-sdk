import { AssistantHost, type Json, type AgentIdentity, NyxIDConnection, z } from "./index.ts";
import { WidgetSession } from "./widget-session.ts";
import { createNyxChatService, lookupNyxReply } from "./nyx-chat.ts";
import { BrowserAuthorization, type PreviousGrant } from "./widget-auth.ts";
import { widgetStyle } from "./widget-style.ts";
import { renderAssistantMarkdown } from "./markdown.ts";

type BrowserGrant = Awaited<ReturnType<BrowserAuthorization["connect"]>>;

export class NyxAssistantElement extends HTMLElement {
  #root = this.attachShadow({ mode: "open" });
  #host?: AssistantHost;
  #login?: { controller: AbortController; restoreOnly: boolean };
  #grant?: BrowserGrant;
  #revoking = false;
  #authorization?: BrowserAuthorization;
  #busy = false;
  #session?: WidgetSession;
  #connection?: NyxIDConnection;
  #recovery?: AbortController;
  context: () => Json = () => ({ title: document.title, language: document.documentElement.lang });
  instructions?: string;
  previousGrant?: () => PreviousGrant | undefined;
  get busy() { return this.#busy; }
  get host() {
    return this.#host;
  }
  get z() {
    return z;
  }

  constructor() {
    super();
    // Only the static widget shell is assigned here.
    this.#root.innerHTML = `<style>${widgetStyle}</style>
      <button class="launch" part="launcher" type="button" aria-expanded="false" aria-controls="panel"><span class="bubble" part="launcher-icon" aria-hidden="true"></span>Nyx 助手</button>
      <section hidden id="panel" class="panel" part="panel" role="dialog" aria-labelledby="title">
        <header part="header"><h2 id="title"><span class="identity" aria-hidden="true"></span>Nyx 助手</h2><button class="disconnect" part="secondary-action" type="button" hidden>断开授权</button>
          <button class="close" part="close" type="button" aria-label="收起助手">×</button></header>
        <details class="agent" hidden>
          <summary class="service-count">已授权服务</summary>
          <p class="service-scope"></p>
          <ul aria-label="授权服务连接"></ul>
          <div class="agent-actions"><a class="manage" target="_blank" rel="noopener noreferrer">在 NyxID 调整权限 ↗</a>
            <button class="refresh-services" type="button">刷新服务</button></div>
          <span class="refresh-status" role="status"></span>
          <details class="key-info"><summary>Key 身份详情</summary><p></p></details>
        </details>
        <div class="chat" role="log" aria-label="聊天记录" aria-live="polite"></div>
        <div class="starters" hidden><slot name="prompt"></slot></div>
        <div class="controls"><p class="status" role="status"></p>
          <a class="verify" hidden target="_blank" rel="noopener noreferrer"></a>
          <p class="connect-hint">连接 NyxID 后，可以向助手提问或操作当前页面。</p>
          <button class="connect" part="primary-action" type="button">连接 NyxID</button>
          <form part="composer" hidden><textarea rows="1" part="input" aria-label="消息" placeholder="给 Nyx 发消息…" required></textarea>
            <button class="send" part="primary-action send" type="submit" aria-label="发送"><span class="send-label">发送</span><span class="send-icon" aria-hidden="true">↑</span></button></form>
          <button class="resume" hidden type="button">核对原请求</button>
          <button class="reset" hidden type="button">开始新对话</button>
        </div>
      </section>`;
    this.#el(".launch").onclick = () => this.#open(this.#el(".panel").hidden);
    const prompts = this.#el<HTMLSlotElement>('slot[name="prompt"]');
    prompts.onslotchange = () => this.#controls();
    prompts.addEventListener("click", (event) => {
      const button = event.composedPath().find(node =>
        node instanceof HTMLButtonElement && node.assignedSlot === prompts);
      if (!(button instanceof HTMLButtonElement) || !this.#host || this.#busy) return;
      const input = this.#el<HTMLTextAreaElement>("textarea");
      input.value = button.dataset.prompt || button.textContent.trim();
      input.focus();
    });
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
      if (this.#host?.pendingRequestId) void this.#send(true);
      else void this.#recover();
    };
    this.#el(".reset").onclick = () => {
      if (!this.#session || !this.#connection || this.#busy ||
          !window.confirm("已执行的操作仍然有效。确认已核对结果并开始新的对话？")) return;
      const session = this.#session;
      session.save({ messages: [] });
      this.#bind(this.#connection, this.#grant, session);
    };
    this.#el("textarea").onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void this.#send(false);
      }
    };
    this.#el(".panel").onkeydown = (e) => {
      if (e.key === "Escape" && this.getAttribute("layout") !== "embedded") this.#open(false);
    };
  }
  #el<T extends HTMLElement = HTMLElement>(selector: string): T {
    return this.#root.querySelector<T>(selector)!;
  }
  connectedCallback() {
    if (this.getAttribute("layout") === "embedded") {
      this.#el(".panel").hidden = false;
      this.#el(".panel").setAttribute("role", "region");
    }
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
    const revoke = this.#revoking ? undefined : this.#grant?.revoke;
    this.#grant = undefined;
    this.#revoking = false;
    this.#clearView();
    return (this.#persistent ? undefined : revoke?.())?.catch(() => {
      if (!this.#host)
        this.#el(".status").textContent =
          "请在 NyxID 核对浏览器子凭据的撤销状态。";
    });
  }
  #clearView() {
    this.#recovery?.abort();
    this.#session = undefined;
    this.#connection = undefined;
    this.#login?.controller.abort();
    this.#login = undefined;
    this.#host?.dispose();
    this.#host = undefined;
    this.#busy = false;
    const agent = this.#el<HTMLDetailsElement>(".agent");
    agent.hidden = true;
    agent.open = false;
    this.#el(".service-count").textContent = "已授权服务";
    this.#el(".service-scope").textContent = "";
    this.#el(".manage").removeAttribute("href");
    this.#el<HTMLButtonElement>(".refresh-services").onclick = null;
    this.#el(".refresh-status").textContent = "";
    this.#el<HTMLDetailsElement>(".key-info").open = false;
    this.#el(".key-info p").textContent = "";
    this.#el(".agent ul").replaceChildren();
    this.#el(".chat").replaceChildren();
    this.#el<HTMLTextAreaElement>("textarea").value = "";
    this.#el(".status").textContent = "";
    this.#el(".verify").hidden = true;
    this.#controls();
  }
  /** Open the login panel from a host control, or show the currently bound identity. */
  async openAgentIdentity() {
    this.#open(true);
    await this.#connect();
    const details = this.#el<HTMLDetailsElement>(".agent");
    if (!details.hidden) details.open = true;
  }

  /** Bind a credential-bound connection on login or identity change. */
  bind(connection: NyxIDConnection) {
    this.#bind(connection);
  }
  #showServices(identity: AgentIdentity) {
    this.#el(".service-count").textContent = `已授权服务（${identity.services.length} 个连接）`;
    const scope = identity.allowAllServices ? "全部服务" :
      identity.allowAutoConnectedServices ? "指定服务和自动连接的平台服务" : "指定服务";
    this.#el(".service-scope").textContent = [identity.name ?? identity.keyId, scope,
      identity.services.length === 0 ? "当前没有服务连接" : ""].filter(Boolean).join(" · ");
    this.#el(".key-info p").textContent = ["Key ID　" + identity.keyId, "所有者　" + identity.ownerId,
      "权限　" + identity.scopes.join(" · ")].join("\n");
    this.#el(".agent ul").replaceChildren(...identity.services.map(service => {
      const row = document.createElement("li");
      const name = service.catalogSlug ?? service.slug;
      const label = service.label !== name ? " · " + service.label : "";
      const state = !service.active ? "（已停用）" : service.credentialMissing ? "（缺少服务凭据）" : "";
      row.textContent = name + label + state;
      row.title = service.id;
      return row;
    }));
  }
  #bind(connection: NyxIDConnection, grant?: BrowserGrant, session?: WidgetSession) {
    if (grant && grant === this.#grant) this.#clearView();
    else void this.#release();
    this.#connection = connection;
    this.#session = session;
    const host = new AssistantHost(createNyxChatService(connection, {
      instructions: this.instructions,
      checkpoint: (requestId, response) => {
        if (session && this.#session === session) session.save({ ...session.state, pending: { requestId, ...response } });
      },
    }), () => this.context(), session?.state.conversation);
    for (const message of session?.state.messages ?? []) this.#message(message.text, message.user);
    this.#host = host;
    this.#grant = grant;
    if (grant) {
      const panel = this.#el<HTMLDetailsElement>(".agent");
      panel.hidden = false;
      panel.open = true;
      this.#showServices(grant.identity);
      this.#el<HTMLAnchorElement>(".manage").href = grant.managementUrl;
      const refresh = this.#el<HTMLButtonElement>(".refresh-services");
      const status = this.#el(".refresh-status");
      refresh.disabled = false;
      refresh.onclick = async () => {
        refresh.disabled = true;
        status.textContent = "正在读取授权…";
        try {
          const current = await connection.getAgentIdentity();
          if (host !== this.#host) return;
          if (current.keyId !== grant.keyId || current.credentialId !== grant.identity.credentialId) {
            throw Error("Agent Key login changed");
          }
          grant.identity = current;
          this.#showServices(current);
          status.textContent = "服务列表已更新。";
        } catch {
          if (host === this.#host) status.textContent = "刷新失败，当前显示上次读取的授权。";
        } finally {
          if (host === this.#host) refresh.disabled = false;
        }
      };
    }
    this.#controls();
    this.dispatchEvent(
      new CustomEvent("nyx-ready", {
        bubbles: true,
        composed: true,
        detail: { host, z, identity: grant?.identity, managementUrl: grant?.managementUrl },
      }),
    );
  }
  #persistent = false;
  #createFlow() {
    const base = new URL(this.dataset.nyxid || "https://nyx.chrono-ai.fun", document.baseURI);
    let storage: Storage | undefined;
    let credentialStorage: Storage | undefined;
    if (this.dataset.storage === "local") credentialStorage = localStorage;
    this.#persistent = Boolean(credentialStorage);
    try { storage = sessionStorage; } catch { /* Storage is optional for this visit. */ }
    const services = this.dataset.services === "@key" ? "@key" : (this.dataset.services ?? "llm-nyx,chrono-llm-public").split(",").map(s => s.trim());
    return new BrowserAuthorization({
      base, verificationOrigin: this.dataset.verificationOrigin || base.origin, services, storage, credentialStorage,
      previousGrant: this.previousGrant, ownerId: this.dataset.ownerId, ownerType: this.dataset.ownerId ? "personal" : undefined, catalogServices: this.dataset.catalogServices?.split(","), clientLabel: location.hostname, keySource: this.dataset.keySource === "new" ? "new" : "existing",
    });
  }
  async #connect(restoreOnly = false) {
    if (this.#login || this.#host || this.#grant) return;
    const controller = new AbortController();
    const login = { controller, restoreOnly };
    const { signal } = controller;
    this.#login = login;
    this.#controls();
    this.#el(".status").textContent = "正在连接 NyxID…";
    try {
      const flow = this.#authorization ??= this.#createFlow();
      const grant = restoreOnly ? await flow.restore(signal) : await flow.connect(signal,
        (url, code) => {
          const link = this.#el<HTMLAnchorElement>(".verify");
          link.href = url.href;
          link.textContent = "打开 NyxID 授权页";
          link.hidden = false;
          this.#el(".status").textContent = "在 NyxID 核对授权码 " + code;
          this.#controls();
        },
      );
      if (signal.aborted) {
        if (!this.#persistent) await grant?.revoke();
        return;
      }
      if (!grant) {
        this.#el(".status").textContent = "";
        return;
      }
      const session = this.dataset.session && new WidgetSession(this.dataset.session, flow.credentialStorageKey, grant.credentialId);
      this.#bind(grant.connection, grant, session || undefined);
      if (session && session.state.pending) {
        this.dispatchEvent(new Event("nyx-recovery"));
        if (session.state.pending.id) void this.#recover();
        else this.#el(".status").textContent = "原请求未取得响应编号，请先核对操作结果。";
      }
      if (!this.#el(".panel").hidden) this.#el("textarea").focus();
    } catch (error) {
      if (!signal.aborted)
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
    const revoke = this.#grant?.revoke;
    if (this.#revoking || (!revoke && this.#login?.restoreOnly !== false)) return;
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
    if (this.#grant?.revoke !== revoke) return;
    this.#revoking = false;
    if (!failed) this.#grant = undefined;
    this.#el(".status").textContent = failed ? "NyxID 未确认撤销，请重试断开授权。" : "";
    this.#controls();
    if (!this.#el(".panel").hidden) this.#el(failed ? ".disconnect" : ".connect").focus();
  }
  #controls() {
    this.dispatchEvent(new Event("nyx-state"));
    const pending = Boolean(this.#host?.pendingRequestId || this.#session?.state.pending);
    const waitingForApproval = this.#login?.restoreOnly === false;
    const disconnect = this.#el<HTMLButtonElement>(".disconnect");
    this.#el(".connect").hidden = Boolean(this.#host || this.#login || this.#grant);
    this.#el(".connect-hint").hidden = this.#el(".connect").hidden;
    disconnect.hidden = !this.#grant && !waitingForApproval;
    disconnect.disabled = this.#revoking;
    disconnect.textContent = waitingForApproval ? "停止等待授权" : "断开授权";
    this.#el("form").hidden = !this.#host;
    this.#el(".panel").toggleAttribute("data-connected", Boolean(this.#host));
    this.#el(".starters").hidden = !this.#host || this.#busy || pending ||
      this.#el(".chat").childElementCount > 0 ||
      !this.#el<HTMLSlotElement>('slot[name="prompt"]').assignedElements().length;
    this.#el<HTMLButtonElement>(".send").disabled = this.#busy || pending;
    this.#el(".resume").hidden = this.#busy || !(this.#host?.pendingRequestId || this.#session?.state.pending?.id);
    this.#el(".reset").hidden = this.#busy || !this.#session?.state.messages.length;
  }
  #open(open: boolean) {
    this.#el(".panel").hidden = !open;
    const launch = this.#el(".launch");
    launch.hidden = open && this.getAttribute("layout") !== "anchored";
    launch.setAttribute("aria-expanded", String(open));
    let focus = ".connect";
    if (this.#host) focus = "textarea";
    else if (this.#login || this.#revoking) focus = ".close";
    else if (this.#grant) focus = ".disconnect";
    this.#el(open ? focus : ".launch").focus();
  }
  #message(text: string, isUser: boolean) {
    const chat = this.#el(".chat");
    const follow = isUser || chat.scrollHeight - chat.clientHeight - chat.scrollTop <= 4;
    const message = document.createElement(isUser ? "p" : "div");
    message.className = isUser ? "msg user" : "msg markdown";
    message.setAttribute("aria-label", isUser ? "你" : "Nyx");
    if (isUser) message.textContent = text;
    else {
      try {
        message.append(renderAssistantMarkdown(text));
      } catch {
        // A rendering failure must still leave the confirmed source readable.
        message.classList.remove("markdown");
        message.style.whiteSpace = "pre-wrap";
        message.textContent = text;
      }
    }
    chat.append(message);
    if (isUser) chat.scrollTop = chat.scrollHeight;
    else if (follow) chat.scrollTop += message.getBoundingClientRect().top - chat.getBoundingClientRect().top;
  }
  async #recover() {
    const session = this.#session, pending = session?.state.pending;
    if (this.#busy || !this.#connection || !session || !pending?.id || !pending.conversationId) return;
    const controller = new AbortController();
    this.#recovery = controller;
    this.#busy = true;
    this.#controls();
    try {
      const reply = await lookupNyxReply(this.#connection, pending, { id: pending.id, conversationId: pending.conversationId }, controller.signal);
      if (controller.signal.aborted) return;
      if (reply.type !== "answer") throw Error("原窗口收到过页面操作。请核对后开始新对话。");
      session.message(reply.text, false, reply.conversationId);
      this.#bind(this.#connection, this.#grant, session);
      this.dispatchEvent(new CustomEvent("nyx-answer", { detail: reply.text }));
    } catch (error) {
      if (!controller.signal.aborted) this.#el(".status").textContent = error instanceof Error ? error.message : "无法核对原请求。";
    } finally {
      if (this.#session === session) { this.#busy = false; this.#controls(); }
    }
  }
  /** Use the same composer and transcript for an explicit host action. */
  sendMessage(text: string) {
    return this.#send(false, text);
  }
  async #send(resume: boolean, supplied?: string) {
    const host = this.#host,
      input = this.#el<HTMLTextAreaElement>("textarea");
    if (!host || this.#busy || Boolean(host.pendingRequestId) !== resume)
      return;
    const text = (supplied ?? input.value).trim();
    if (!resume && this.#session?.state.pending) return;
    if (!resume) {
      if (!text) return;
      try {
        this.#session?.message(text, true, host.conversationId);
      } catch {
        this.#el(".status").textContent = "无法保存聊天记录，请检查站点存储。";
        return;
      }
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
      this.#el(".status").textContent = "";
      this.#session?.message(answer, false, host.conversationId);
      this.#message(answer, false);
      this.dispatchEvent(new CustomEvent("nyx-answer", { detail: answer }));
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
