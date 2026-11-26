import { AssistantHost, type Json, NyxIDConnection, z } from "./index.ts";
import { WidgetSession } from "./widget-session.ts";
import { createNyxChatService, lookupNyxReply } from "./nyx-chat.ts";
import { BrowserAuthorization, type PreviousGrant } from "./widget-auth.ts";
import { widgetStyle } from "./widget-style.ts";
import { renderAssistantMarkdown } from "./markdown.ts";
import { widgetMessages } from "./widget-messages.ts";

type BrowserGrant = Awaited<ReturnType<BrowserAuthorization["connect"]>>;

export class NyxAssistantElement extends HTMLElement {
  #root = this.attachShadow({ mode: "open" });
  #language: keyof typeof widgetMessages = "zh";
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
  get access() { return this.#host ? this.#grant?.access : undefined; }
  get host() {
    return this.#host;
  }
  get z() {
    return z;
  }
  get #copy() {
    return widgetMessages[this.#language];
  }

  constructor() {
    super();
    // Only the static widget shell is assigned here.
    this.#root.innerHTML = `<style>${widgetStyle}</style>
      <button class="launch" part="launcher" type="button" aria-expanded="false" aria-controls="panel"><span class="bubble" part="launcher-icon" aria-hidden="true"></span><span class="launch-label"></span></button>
      <section hidden id="panel" class="panel" part="panel" role="dialog" aria-labelledby="title">
        <header part="header"><h2 id="title"><span class="identity" aria-hidden="true"></span><span class="title-label"></span></h2><button class="disconnect" part="secondary-action" type="button" hidden></button>
          <button class="close" part="close" type="button">×</button></header>
        <details class="access" hidden><summary></summary>
          <p></p><a target="_blank" rel="noopener noreferrer"></a></details>
        <div class="chat" role="log" aria-live="polite"></div>
        <div class="starters" hidden><slot name="prompt"></slot></div>
        <div class="controls"><p class="status" role="status"></p>
          <a class="verify" hidden target="_blank" rel="noopener noreferrer"></a>
          <p class="connect-hint"></p>
          <button class="connect" part="primary-action" type="button"></button>
          <form part="composer" hidden><textarea rows="1" part="input" required></textarea>
            <button class="send" part="primary-action send" type="submit"><span class="send-label"></span><span class="send-icon" aria-hidden="true">↑</span></button></form>
          <button class="resume" hidden type="button"></button>
          <button class="reset" hidden type="button"></button>
        </div>
      </section>`;
    this.#localize();
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
          !window.confirm(this.#copy.confirmReset)) return;
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
  #localize() {
    const copy = this.#copy;
    this.#el(".launch-label").textContent = copy.title;
    this.#el(".title-label").textContent = copy.title;
    this.#el(".close").setAttribute("aria-label", copy.close);
    this.#el(".chat").setAttribute("aria-label", copy.chat);
    this.#el(".access summary").textContent = copy.services;
    this.#el(".access a").textContent = copy.manage;
    this.#el(".connect-hint").textContent = copy.hint;
    this.#el(".connect").textContent = copy.connect;
    const input = this.#el<HTMLTextAreaElement>("textarea");
    input.setAttribute("aria-label", copy.message);
    input.placeholder = copy.placeholder;
    this.#el(".send").setAttribute("aria-label", copy.send);
    this.#el(".send-label").textContent = copy.send;
    this.#el(".resume").textContent = copy.resume;
    this.#el(".reset").textContent = copy.reset;
  }
  connectedCallback() {
    this.#language = this.lang.toLowerCase().split("-")[0] === "en" ? "en" : "zh";
    this.#localize();
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
      if (this.dataset.storage === undefined || this.dataset.storage === "local") void this.#connect(true);
    }
    window.addEventListener("storage", this.#storageChanged);
    window.addEventListener("pagehide", this.#pagehide);
    window.addEventListener("pageshow", this.#pageshow);
  }
  #storageChanged = (event: StorageEvent) => {
    if (this.#authorization?.persistent && (event.key === null || event.key === this.#authorization.credentialStorageKey)) {
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
    return (this.#authorization?.persistent ? undefined : revoke?.())?.catch(() => {
      if (!this.#host)
        this.#el(".status").textContent =
          this.#copy.verifyRevoke;
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
    const access = this.#el<HTMLDetailsElement>(".access");
    access.hidden = true;
    access.open = false;
    this.#el(".access p").textContent = "";
    this.#el(".access a").removeAttribute("href");
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
      this.#el(".access p").textContent = new Intl.ListFormat(this.#language).format(grant.access.services);
      this.#el<HTMLAnchorElement>(".access a").href = grant.access.managementUrl;
      this.#el(".access").hidden = false;
    }
    this.#controls();
    this.dispatchEvent(
      new CustomEvent("nyx-ready", {
        bubbles: true,
        composed: true,
        detail: { host, z },
      }),
    );
  }
  #createFlow() {
    const base = new URL(this.dataset.nyxid || "https://nyx.chrono-ai.fun");
    let storage: Storage | undefined;
    let credentialStorage: Storage | null | undefined;
    if (this.dataset.storage === "local") credentialStorage = localStorage;
    else if (this.dataset.storage !== undefined) credentialStorage = null;
    try { storage = sessionStorage; } catch { /* Storage is optional for this visit. */ }
    const services = (this.dataset.services ?? "llm-nyx,chrono-llm-public").split(",").map(s => s.trim());
    return new BrowserAuthorization({
      base, verificationOrigin: this.dataset.verificationOrigin || base.origin, services, storage, credentialStorage, language: this.#language,
      previousGrant: this.previousGrant, ownerId: this.dataset.ownerId, ownerType: this.dataset.ownerId ? "personal" : undefined, catalogServices: this.dataset.catalogServices?.split(","), clientLabel: location.hostname, keySource: this.dataset.keySource === "new" ? "new" : "existing",
    });
  }
  /** Open the widget and start or resume its NyxID connection. */
  connect() {
    this.#open(true);
    void this.#connect();
  }
  async #connect(restoreOnly = false) {
    if (this.#login) {
      if (!restoreOnly && this.#login.restoreOnly) {
        this.#login.restoreOnly = false;
        this.#controls();
      }
      return;
    }
    if (this.#host || this.#grant) return;
    const controller = new AbortController();
    const login = { controller, restoreOnly };
    const { signal } = controller;
    this.#login = login;
    this.#controls();
    this.#el(".status").textContent = this.#copy.connecting;
    try {
      const flow = this.#authorization ??= this.#createFlow();
      let grant = restoreOnly ? await flow.restore(signal) : undefined;
      if (!grant && !login.restoreOnly && !signal.aborted) grant = await flow.connect(signal,
        (url, code) => {
          const link = this.#el<HTMLAnchorElement>(".verify");
          link.href = url.href;
          link.textContent = this.#copy.openApproval;
          link.hidden = false;
          this.#el(".status").textContent = this.#copy.verifyCode(code);
          this.#controls();
        },
      );
      if (signal.aborted) {
        if (!flow.persistent) await grant?.revoke();
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
        else this.#el(".status").textContent = this.#copy.missingResponse;
      }
      if (!this.#el(".panel").hidden) this.#el("textarea").focus();
    } catch (error) {
      if (!signal.aborted)
        this.#el(".status").textContent =
          error instanceof Error ? error.message : this.#copy.connectFailed;
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
    this.#el(".status").textContent = this.#copy.revoking;
    let failed = false;
    try {
      await revoke();
    } catch {
      failed = true;
    }
    if (this.#grant?.revoke !== revoke) return;
    this.#revoking = false;
    if (!failed) this.#grant = undefined;
    this.#el(".status").textContent = failed ? this.#copy.revokeFailed : "";
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
    disconnect.textContent = waitingForApproval ? this.#copy.cancelApproval : this.#copy.disconnect;
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
    message.setAttribute("aria-label", isUser ? this.#copy.you : "Nyx");
    if (isUser) message.textContent = text;
    else {
      try {
        message.append(renderAssistantMarkdown(text, this.#copy.image));
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
      if (reply.type !== "answer") throw Error(this.#copy.previousAction);
      session.message(reply.text, false, reply.conversationId);
      this.#bind(this.#connection, this.#grant, session);
      this.dispatchEvent(new CustomEvent("nyx-answer", { detail: reply.text }));
    } catch (error) {
      if (!controller.signal.aborted) this.#el(".status").textContent = error instanceof Error ? error.message : this.#copy.recoverFailed;
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
        this.#el(".status").textContent = this.#copy.saveChatFailed;
        return;
      }
      this.#message(text, true);
      input.value = "";
    }
    this.#busy = true;
    this.#controls();
    this.#el(".status").textContent = resume
      ? this.#copy.recovering
      : this.#copy.waiting;
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
          error instanceof Error ? error.message : this.#copy.requestFailed;
    } finally {
      if (host === this.#host) {
        this.#busy = false;
        this.#controls();
      }
    }
  }
}
