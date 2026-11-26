import { LocalizedError, type MessageKey, widgetText } from "./widget-i18n.ts";
import { AssistantHost, type Json, NyxIDConnection, z } from "./index.ts";
import { WidgetSession } from "./widget-session.ts";
import { createNyxChatService, lookupNyxReply } from "./nyx-chat.ts";
import { BrowserAuthorization, type PreviousGrant } from "./widget-auth.ts";
import { widgetStyle } from "./widget-style.ts";
import { renderAssistantMarkdown } from "./markdown.ts";

export class NyxAssistantElement extends HTMLElement {
  #root = this.attachShadow({ mode: "open" });
  #host?: AssistantHost;
  #login?: { controller: AbortController; restoreOnly: boolean };
  #revoke?: () => Promise<void>;
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

  static observedAttributes = ["lang"];
  #status?: { key: MessageKey; value?: string; diagnostic?: string };

  #text(key: MessageKey, value?: string) {
    return widgetText(this.lang, key, value);
  }
  #showStatus(key?: MessageKey, value?: string, diagnostic?: string) {
    this.#status = key && { key, value, diagnostic };
    this.#renderStatus();
  }
  #renderStatus() {
    const status = this.#status;
    this.#el(".status").textContent = status
      ? [this.#text(status.key, status.value), status.diagnostic].filter(Boolean).join(" ")
      : "";
  }
  #showError(error: unknown, fallback: MessageKey) {
    if (error instanceof LocalizedError) this.#showStatus(error.key, error.value);
    else if (error instanceof TypeError && error.message === "Failed to fetch") this.#showStatus("network");
    else if (error instanceof DOMException && error.name === "TimeoutError") this.#showStatus("timeout");
    else this.#showStatus(fallback, undefined, error instanceof Error ? error.message : undefined);
  }
  #renderLabels() {
    for (const el of this.#root.querySelectorAll<HTMLElement>("[data-label]")) {
      el.textContent = this.#text(el.dataset.label as MessageKey);
    }
    for (const el of this.#root.querySelectorAll<HTMLElement>("[data-aria]")) {
      el.setAttribute("aria-label", this.#text(el.dataset.aria as MessageKey));
    }
    this.#el<HTMLTextAreaElement>("textarea").placeholder = this.#text("placeholder");
    this.#el(".disconnect").textContent = this.#text(this.#login?.restoreOnly === false ? "stopApproval" : "disconnect");
    this.#renderStatus();
  }
  attributeChangedCallback() { this.#renderLabels(); }

  constructor() {
    super();
    // Only the static widget shell is assigned here.
    this.#root.innerHTML = `<style>${widgetStyle}</style>
      <button class="launch" part="launcher" type="button" aria-expanded="false" aria-controls="panel"><span class="bubble" part="launcher-icon" aria-hidden="true"></span><span data-label="title"></span></button>
      <section hidden id="panel" class="panel" part="panel" role="dialog" aria-labelledby="title">
        <header part="header"><h2 id="title"><span class="identity" aria-hidden="true"></span><span data-label="title"></span></h2><button class="disconnect" part="secondary-action" type="button" hidden></button>
          <button class="close" part="close" type="button" data-aria="close">×</button></header>
        <div class="chat" role="log" data-aria="history" aria-live="polite"></div>
        <div class="starters" hidden><slot name="prompt"></slot></div>
        <div class="controls"><p class="status" role="status"></p>
          <a class="verify" data-label="verifyLink" hidden target="_blank" rel="noopener noreferrer"></a>
          <p class="connect-hint" data-label="connectHint"></p>
          <button class="connect" part="primary-action" type="button" data-label="connect"></button>
          <form part="composer" hidden><textarea rows="1" part="input" data-aria="message" required></textarea>
            <button class="send" part="primary-action send" type="submit" data-aria="send"><span class="send-label" data-label="send"></span><span class="send-icon" aria-hidden="true">↑</span></button></form>
          <button class="resume" hidden type="button" data-label="resume"></button>
          <button class="reset" hidden type="button" data-label="reset"></button>
        </div>
      </section>`;
    this.#renderLabels();
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
          !window.confirm(this.#text("resetConfirm"))) return;
      const session = this.#session;
      session.save({ messages: [] });
      this.#bind(this.#connection, this.#revoke, session);
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
    const revoke = this.#revoking ? undefined : this.#revoke;
    this.#revoke = undefined;
    this.#revoking = false;
    this.#clearView();
    return (this.#persistent ? undefined : revoke?.())?.catch(() => {
      if (!this.#host)
        this.#showStatus("revocationStatus");
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
    this.#el(".chat").replaceChildren();
    this.#el<HTMLTextAreaElement>("textarea").value = "";
    this.#showStatus();
    this.#el(".verify").hidden = true;
    this.#controls();
  }
  /** Bind a credential-bound connection on login or identity change. */
  bind(connection: NyxIDConnection) {
    this.#bind(connection);
  }
  #bind(connection: NyxIDConnection, revoke?: () => Promise<void>, session?: WidgetSession) {
    void this.#release();
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
      previousGrant: this.previousGrant, ownerId: this.dataset.ownerId, ownerType: this.dataset.ownerId ? "personal" : undefined, catalogServices: this.dataset.catalogServices?.split(","), clientLabel: location.hostname, keySource: this.dataset.keySource === "new" ? "new" : "existing",
    });
  }
  async #connect(restoreOnly = false) {
    if (this.#login || this.#host || this.#revoke) return;
    const controller = new AbortController();
    const login = { controller, restoreOnly };
    const { signal } = controller;
    this.#login = login;
    this.#controls();
    this.#showStatus("connecting");
    try {
      const flow = this.#authorization ??= this.#createFlow();
      const grant = restoreOnly ? await flow.restore(signal) : await flow.connect(signal,
        (url, code) => {
          const link = this.#el<HTMLAnchorElement>(".verify");
          link.href = url.href;
          link.hidden = false;
          this.#showStatus("verifyCode", code);
          this.#controls();
        },
      );
      if (signal.aborted) {
        if (!this.#persistent) await grant?.revoke();
        return;
      }
      if (!grant) {
        this.#showStatus();
        return;
      }
      const session = this.dataset.session && new WidgetSession(this.dataset.session, flow.credentialStorageKey, grant.credentialId);
      this.#bind(grant.connection, grant.revoke, session || undefined);
      if (session && session.state.pending) {
        this.dispatchEvent(new Event("nyx-recovery"));
        if (session.state.pending.id) void this.#recover();
        else this.#showStatus("noResponseId");
      }
      if (!this.#el(".panel").hidden) this.#el("textarea").focus();
    } catch (error) {
      if (!signal.aborted)
        this.#showError(error, "connectFailed");
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
    if (this.#revoking || (!revoke && this.#login?.restoreOnly !== false)) return;
    this.#authorization?.cancel();
    if (!revoke) {
      void this.#release();
      this.#el(".connect").focus();
      return;
    }
    this.#revoking = true;
    this.#clearView();
    this.#showStatus("revoking");
    let failed = false;
    try {
      await revoke();
    } catch {
      failed = true;
    }
    if (this.#revoke !== revoke) return;
    this.#revoking = false;
    if (!failed) this.#revoke = undefined;
    this.#showStatus(failed ? "revokeFailed" : undefined);
    this.#controls();
    if (!this.#el(".panel").hidden) this.#el(failed ? ".disconnect" : ".connect").focus();
  }
  #controls() {
    this.dispatchEvent(new Event("nyx-state"));
    const pending = Boolean(this.#host?.pendingRequestId || this.#session?.state.pending);
    const waitingForApproval = this.#login?.restoreOnly === false;
    const disconnect = this.#el<HTMLButtonElement>(".disconnect");
    this.#el(".connect").hidden = Boolean(this.#host || this.#login || this.#revoke);
    this.#el(".connect-hint").hidden = this.#el(".connect").hidden;
    disconnect.hidden = !this.#revoke && !waitingForApproval;
    disconnect.disabled = this.#revoking;
    disconnect.textContent = this.#text(waitingForApproval ? "stopApproval" : "disconnect");
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
    else if (this.#revoke) focus = ".disconnect";
    this.#el(open ? focus : ".launch").focus();
  }
  #message(text: string, isUser: boolean) {
    const chat = this.#el(".chat");
    const follow = isUser || chat.scrollHeight - chat.clientHeight - chat.scrollTop <= 4;
    const message = document.createElement(isUser ? "p" : "div");
    message.className = isUser ? "msg user" : "msg markdown";
    if (isUser) message.dataset.aria = "you";
    message.setAttribute("aria-label", isUser ? this.#text("you") : "Nyx");
    if (isUser) message.textContent = text;
    else {
      try {
        message.append(renderAssistantMarkdown(text, this.#text("image")));
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
      if (reply.type !== "answer") throw new LocalizedError("previousAction");
      session.message(reply.text, false, reply.conversationId);
      this.#bind(this.#connection, this.#revoke, session);
      this.dispatchEvent(new CustomEvent("nyx-answer", { detail: reply.text }));
    } catch (error) {
      if (!controller.signal.aborted) this.#showError(error, "recoverFailed");
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
        this.#showStatus("storageFailed");
        return;
      }
      this.#message(text, true);
      input.value = "";
    }
    this.#busy = true;
    this.#controls();
    this.#showStatus(resume ? "checking" : "waiting");
    try {
      const answer = await (resume ? host.resume() : host.send(text));
      if (host !== this.#host) return;
      this.#showStatus();
      this.#session?.message(answer, false, host.conversationId);
      this.#message(answer, false);
      this.dispatchEvent(new CustomEvent("nyx-answer", { detail: answer }));
    } catch (error) {
      if (host === this.#host)
        this.#showError(error, "requestFailed");
    } finally {
      if (host === this.#host) {
        this.#busy = false;
        this.#controls();
      }
    }
  }
}
