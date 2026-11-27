import type { NyxIDConnection } from "./connection.ts";
import type { AgentIdentity } from "./agent-identity.ts";
import { LocalizedError, type MessageKey } from "./i18n.ts";
import { VoiceClient, VoiceConnectionUnavailable, type VoiceAgent, type VoiceOption, type VoiceOptions } from "./voice.ts";
import { TemporaryCall } from "./temporary-call.ts";
import type { VoiceApplication } from "./realtime-tools.ts";
import { WidgetCall } from "./widget-call.ts";

type Service = AgentIdentity["services"][number];
type VoiceService = "llm-openai" | "nyxbot-voice" | "auto";
export class WidgetVoice {
  #root: HTMLElement;
  #call?: TemporaryCall | WidgetCall;
  #temporary: Service[] = [];
  #load?: AbortController;
  #connection?: NyxIDConnection;
  #app?: VoiceApplication;
  #identity?: AgentIdentity;
  #voiceService: VoiceService = "auto";
  #bots: { service: Service; agent: VoiceAgent }[] = [];
  #agent?: VoiceAgent;
  #choices?: VoiceOptions;
  #status?: MessageKey;
  #detail = "";
  #statusValue = "";
  #text: (key: MessageKey, value?: string) => string;
  #visible = false;
  #ending?: Promise<void>;
  #toggle: HTMLButtonElement;
  #chat: HTMLElement;
  #changed: () => void;
  #captions = new Map<string, HTMLElement>();
  #startedAt = 0;
  #timer?: number;
  #muted = false;
  get open() { return this.#visible; }

  constructor(root: HTMLElement, toggle: HTMLButtonElement, chat: HTMLElement, text: (key: MessageKey, value?: string) => string, changed: () => void) {
    this.#root = root;
    this.#toggle = toggle;
    this.#chat = chat;
    this.#text = text;
    this.#changed = changed;
    root.innerHTML = `
      <div class="voice-bar">
        <span class="call-mark" aria-hidden="true"><span class="wave"><i></i><i></i><i></i><i></i><i></i></span></span>
        <div class="voice-identity"><strong class="voice-name"></strong><span class="voice-status" role="status"></span></div>
        <time class="voice-time" hidden></time>
        <button type="button" class="voice-back" data-aria="backToChat">×</button>
      </div>
      <details class="voice-settings" hidden><summary data-label="voiceSettings"></summary>
        <label hidden><span data-label="voiceBot"></span><select class="voice-bot"></select></label>
        <label hidden><span data-label="voiceProvider"></span><select class="voice-provider"></select></label>
      </details>
      <div class="voice-repair" hidden>
        <a class="voice-setup" data-label="openVoiceAccess" hidden target="_blank" rel="noopener noreferrer"></a>
        <a class="voice-key" data-label="openVoiceKey" hidden target="_blank" rel="noopener noreferrer"></a>
        <button type="button" class="voice-retry" data-label="refreshBots"></button>
      </div>
      <div class="voice-actions">
        <button type="button" class="voice-start" data-label="voiceStart" hidden></button>
        <button type="button" class="voice-mute" hidden></button>
        <button type="button" class="voice-share" hidden></button>
        <button type="button" class="voice-talk" data-label="voiceTalk" hidden></button>
        <button type="button" class="voice-end" data-label="voiceEnd" hidden></button>
      </div>`;
    toggle.onclick = () => {
      if (!this.#connection || this.#visible) return;
      this.#visible = true;
      this.#toggle.setAttribute("aria-expanded", "true");
      this.#changed();
      this.#el(".voice-name").textContent = this.#text("voiceCall");
      this.#el(".voice-back").focus();
      void this.#discover();
    };
    this.#el(".voice-back").onclick = () => { void this.reset(); toggle.focus(); };
    this.#el(".voice-retry").onclick = () => void this.#discover();
    this.#el(".voice-mute").onclick = async () => {
      const call = this.#call;
      if (!call) return;
      const button = this.#el<HTMLButtonElement>(".voice-mute");
      button.disabled = true;
      try { await call.mute(!this.#muted); }
      catch (error) { if (this.#call === call) this.#error(error); }
      finally { button.disabled = false; }
    };
    const share = this.#el<HTMLButtonElement>(".voice-share");
    share.onclick = async () => {
      const call = this.#call;
      if (!(call instanceof TemporaryCall)) return;
      share.disabled = true;
      try { await call.toggleSharing(); if (call === this.#call) this.#setStatus("voiceLive"); }
      catch { if (call === this.#call) this.#setStatus("shareHint"); }
      finally { share.disabled = false; }
    };
    this.#select(".voice-bot").onchange = () => void this.#options();
    this.#select(".voice-provider").onchange = () => this.#ready();
    this.#el(".voice-start").onclick = () => void this.#start();
    this.#el(".voice-end").onclick = () => void this.#finish();
    const talk = this.#el<HTMLButtonElement>(".voice-talk");
    talk.onpointerdown = event => { talk.setPointerCapture(event.pointerId); this.#talk(true); };
    talk.onpointerup = talk.onlostpointercapture = talk.onpointercancel = talk.onblur = () => this.#talk(false);
    talk.onkeydown = event => {
      if (event.key === " " || event.key === "Enter") { event.preventDefault(); this.#talk(true); }
    };
    talk.onkeyup = () => this.#talk(false);
  }
  #talk(pressed: boolean) {
    if (this.#call instanceof WidgetCall) this.#call.talk(pressed);
  }
  #el<T extends HTMLElement = HTMLElement>(selector: string) { return this.#root.querySelector<T>(selector)!; }
  #select(selector: string) { return this.#el<HTMLSelectElement>(selector); }
  setConnection(connection?: NyxIDConnection, managementUrl?: string, voiceService: VoiceService = "auto", app?: VoiceApplication) {
    const ended = this.reset();
    this.#connection = connection;
    this.#app = app;
    this.#voiceService = voiceService;
    const setup = this.#el<HTMLAnchorElement>(".voice-setup");
    const key = this.#el<HTMLAnchorElement>(".voice-key");
    setup.hidden = key.hidden = !managementUrl;
    if (managementUrl) {
      setup.href = new URL("/assistant?details=grants", managementUrl).href;
      key.href = managementUrl;
    } else {
      setup.removeAttribute("href");
      key.removeAttribute("href");
    }
    return ended;
  }
  reset() {
    this.#load?.abort();
    this.#load = undefined;
    const ending = this.#finish();
    this.#visible = false;
    this.#temporary = [];
    this.#identity = undefined;
    this.#agent = this.#choices = undefined;
    this.#toggle.setAttribute("aria-expanded", "false");
    this.#el<HTMLDetailsElement>(".voice-settings").open = false;
    this.#el(".voice-settings").hidden = true;
    this.#el(".voice-back").hidden = false;
    this.#changed();
    for (const label of this.#root.querySelectorAll("label")) label.hidden = true;
    this.#setStatus();
    return ending;
  }
  #setStatus(key?: MessageKey, detail = "", value = "") {
    this.#status = key;
    this.#detail = detail;
    this.#statusValue = value;
    this.localize();
  }
  localize() {
    const sharing = this.#call instanceof TemporaryCall && !!this.#call.screenshots?.active;
    this.#el(".voice-share").textContent = this.#text(sharing ? "stopShare" : "shareTab");
    this.#el(".voice-share").setAttribute("aria-pressed", String(sharing));
    this.#el(".voice-mute").textContent = this.#text(this.#muted ? "voiceUnmute" : "voiceMute");
    this.#el(".voice-status").textContent = this.#status ? [this.#text(this.#status, this.#statusValue), this.#detail].filter(Boolean).join(" ") : "";
  }
  #error(error: unknown) {
    if (error instanceof LocalizedError) this.#setStatus(error.key, "", error.value);
    else if (error instanceof DOMException && error.name === "NotAllowedError") this.#setStatus("microphoneDenied");
    else this.#setStatus("voiceFailed", error instanceof Error ? error.message : "");
  }
  #loading() {
    this.#load?.abort();
    this.#load = new AbortController();
    this.#agent = this.#choices = undefined;
    this.#el(".voice-start").hidden = true;
    this.#select(".voice-provider").parentElement!.hidden = true;
    this.#setStatus("voiceLoading");
    return this.#load.signal;
  }
  async #chooseTemporary(services: Service[]) {
    this.#temporary = services;
    this.#el(".voice-name").textContent = this.#app?.name || this.#text("temporaryVoice");
    const select = this.#select(".voice-provider");
    select.replaceChildren(...services.map(s => new Option(s.label + " · " + s.id.slice(0, 8), s.id)));
    if (services.length === 1) return this.#start();
    select.prepend(new Option(this.#text("voiceProvider"), ""));
    select.value = "";
    select.parentElement!.hidden = this.#el(".voice-settings").hidden = false;
    this.#el<HTMLDetailsElement>(".voice-settings").open = true;
    this.#ready();
  }
  async #discover() {
    const signal = this.#loading();
    this.#el(".voice-repair").hidden = this.#el(".voice-settings").hidden = true;
    this.#bots = [];
    this.#temporary = [];
    try {
      if (!this.#connection!.hasAgentKey) throw new LocalizedError("voiceProxy");
      const connection = this.#connection!;
      const identity = await connection.getAgentIdentity(signal);
      signal.throwIfAborted();
      this.#identity = identity;
      const services = this.#voiceService === "llm-openai" ? [] :
        identity.services.filter(s => s.active && (s.catalogSlug ?? s.slug) === "nyxbot-voice");
      const bots = [];
      for (const service of services) {
        signal.throwIfAborted();
        try {
          const agent = await new VoiceClient(connection, service).getAgent(signal);
          bots.push({ service, agent });
        } catch (error) {
          if (!(error instanceof VoiceConnectionUnavailable)) throw error;
        }
      }
      signal.throwIfAborted();
      this.#bots = bots;
      if (!bots.length) {
        if (this.#voiceService !== "nyxbot-voice") {
          const providers = identity.services.filter(s => s.active && (s.catalogSlug ?? s.slug) === "llm-openai");
          if (providers.length) { await this.#chooseTemporary(providers); return; }
        }
        this.#el(".voice-repair").hidden = false;
        if (!services.length) this.#el(".voice-setup").hidden = true;
        if (this.#voiceService === "llm-openai") throw new LocalizedError("voiceNoProvider");
        throw new LocalizedError(services.length ? "voiceNeedsBinding" : "voiceNoBot");
      }
      const bot = this.#select(".voice-bot");
      bot.replaceChildren(...bots.map(({ service, agent }) => new Option(agent.display_name || agent.name || service.label, service.id)));
      if (bots.length > 1) {
        bot.prepend(new Option(this.#text("chooseBot"), ""));
        bot.value = "";
      }
      bot.parentElement!.hidden = this.#bots.length === 1;
      this.#el(".voice-settings").hidden = false;
      this.#el<HTMLDetailsElement>(".voice-settings").open = this.#bots.length > 1;
      await this.#options();
    } catch (error) { if (!signal.aborted) this.#error(error); }
  }
  #selectedBot() { return this.#bots.find(b => b.service.id === this.#select(".voice-bot").value); }
  async #options() {
    const signal = this.#loading();
    const bot = this.#selectedBot();
    if (!bot) { this.#setStatus("chooseBot"); return; }
    try {
      const { service, agent } = bot;
      const client = new VoiceClient(this.#connection!, service);
      const choices = await client.getOptions(agent.conversation_id, signal);
      signal.throwIfAborted();
      this.#agent = agent;
      this.#el(".voice-name").textContent = agent.display_name || agent.name || service.label;
      this.#choices = choices;
      const select = this.#select(".voice-provider");
      const options = choices.options.map((o, i) => {
        const label = [o.model_label ?? o.model, this.#text(o.key_source === "own" ? "ownKey" : "platformKey"), o.connection_id?.slice(0, 8)].filter(Boolean).join(" · ");
        const option = new Option(label, String(i));
        option.disabled = !o.available || !["openai_live", "xai_realtime"].includes(o.voice?.protocol ?? "");
        if (o.unavailable_reason) option.title = o.unavailable_reason;
        return option;
      });
      select.replaceChildren(...options);
      select.parentElement!.hidden = !options.length;
      const saved = choices.preferences;
      const preferred = saved ? choices.options.findIndex(o => o.service_id === saved.service_id && o.key_source === saved.key_source &&
        o.connection_id == saved.connection_id && o.model === saved.model) : options.findIndex(o => !o.disabled);
      select.selectedIndex = preferred;
      this.#ready();
      const needsChoice = preferred < 0 || (!saved && options.filter(o => !o.disabled).length > 1);
      this.#el<HTMLDetailsElement>(".voice-settings").open = needsChoice;
      if (this.#bots.length === 1 && !needsChoice && this.#option()) await this.#start();
    } catch (error) { if (!signal.aborted) this.#error(error); }
  }
  #option(): VoiceOption | undefined {
    const select = this.#select(".voice-provider");
    if (select.selectedIndex < 0 || select.selectedOptions[0]?.disabled) return;
    return this.#choices?.options[select.selectedIndex];
  }
  #ready() {
    const ready = Boolean(this.#option() || this.#temporary.some(s => s.id === this.#select(".voice-provider").value));
    this.#el(".voice-start").hidden = !ready;
    this.#setStatus(ready ? "voiceReady" : "voiceNoProvider");
  }
  async #start() {
    if (this.#call || this.#ending) return;
    const selected = this.#temporary.find(s => s.id === this.#select(".voice-provider").value);
    const option = this.#option(), bot = this.#selectedBot(), agent = this.#agent;
    if (!selected && (!option || !bot || !agent)) return;
    this.#captions.clear();
    this.#startedAt = 0;
    this.#muted = false;
    const pcm = option?.voice?.protocol === "xai_realtime";
    const live = (muted: boolean, inputMuted = false) => {
      if (this.#call !== call) return;
      this.#el(".voice-share").hidden = !(call instanceof TemporaryCall && call.screenshots);
      this.#muted = muted;
      this.#el(".voice-mute").setAttribute("aria-pressed", String(muted));
      this.#el(".voice-mute").hidden = false;
      if (!this.#startedAt) {
        this.#startedAt = Date.now();
        const time = this.#el(".voice-time");
        time.hidden = false;
        time.textContent = "0:00";
        this.#timer = window.setInterval(() => {
          const seconds = Math.floor((Date.now() - this.#startedAt) / 1000);
          time.textContent = Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
        }, 1000);
      }
      this.#setStatus("voiceLive");
      this.#el(".voice-talk").hidden = !pcm || muted || inputMuted;
    };
    const failed = (error: unknown) => { if (this.#call === call) void this.#finish(error); };
    const call: TemporaryCall | WidgetCall = selected
      ? new TemporaryCall(this.#connection!, selected, live, (id, speaker, text) => {
          if (this.#call === call) this.#renderCaptions([{ id, speaker, text }]);
        }, failed, this.#app, this.#identity, () => this.localize())
      : new WidgetCall(this.#connection!, bot!.service, snapshot => {
          if (this.#call !== call) return;
          this.#renderCaptions(snapshot.captions ?? []);
          const session = snapshot.session;
          if (session.end_requested || ["failed", "closed"].includes(session.state)) {
            void this.#finish(session.state === "failed" ? new LocalizedError("voiceFailed") : undefined);
          } else if (session.state === "active") live(!!session.muted, !!session.input_muted);
        }, failed);
    this.#call = call;
    this.#el(".voice-start").hidden = true;
    this.#el(".voice-end").hidden = false;
    this.#el(".voice-back").hidden = true;
    this.#root.dataset.call = "true";
    this.#el<HTMLDetailsElement>(".voice-settings").open = false;
    this.#el(".voice-settings").hidden = true;
    this.#el(".voice-end").focus();
    this.#select(".voice-bot").disabled = this.#select(".voice-provider").disabled = true;
    this.#setStatus("voiceStarting");
    try {
      if (call instanceof TemporaryCall) { await call.start(); return; }
      if (!option || !agent) return;
      const saved = this.#choices?.preferences;
      const voice = option.voice?.voices?.find(v => v.id === saved?.voice)?.id ?? option.voice?.voices?.[0]?.id;
      await call.start(agent.agent_id, {
        service_id: option.service_id, connection_id: option.connection_id, key_source: option.key_source,
        model: option.model, voice, language: saved?.language, input_mode: pcm ? "push_to_talk" : "automatic",
      }, pcm);
    } catch (error) { if (this.#call === call) await this.#finish(error); }
  }
  #renderCaptions(captions: unknown[]) {
    const follow = this.#chat.scrollHeight - this.#chat.scrollTop - this.#chat.clientHeight < 8;
    for (const caption of captions) {
      if (!caption || typeof caption !== "object" || !("id" in caption) || typeof caption.id !== "string" ||
          !("text" in caption) || typeof caption.text !== "string" || !caption.text || !("speaker" in caption)) continue;
      const user = caption.speaker === "user";
      if (!user && caption.speaker !== "assistant") continue;
      let row = this.#captions.get(caption.id);
      if (!row) {
        const block = document.createElement("div");
        block.className = user ? "msg user call-caption" : "msg call-caption";
        const byline = document.createElement("small");
        byline.textContent = user ? this.#text("you") : this.#el(".voice-name").textContent;
        row = document.createElement("span");
        block.append(byline, row);
        this.#chat.append(block);
        this.#captions.set(caption.id, row);
      }
      if (row.textContent !== caption.text) row.textContent = caption.text;
    }
    if (follow) this.#chat.scrollTop = this.#chat.scrollHeight;
  }
  async #finish(error?: unknown) {
    const call = this.#call;
    if (!call) return this.#ending;
    this.#call = undefined;
    this.#el(".voice-share").hidden = true;
    this.#el(".voice-end").hidden = this.#el(".voice-talk").hidden = true;
    clearInterval(this.#timer);
    this.#el(".voice-mute").hidden = this.#el(".voice-time").hidden = true;
    this.#el(".voice-back").hidden = false;
    delete this.#root.dataset.call;
    const ending = this.#ending = call.end();
    try { await ending; }
    catch (endError) { error ??= endError; }
    finally { this.#ending = undefined; }
    this.#select(".voice-bot").disabled = this.#select(".voice-provider").disabled = false;
    if (this.#visible) {
      this.#ready();
      if (error) {
        this.#el(".voice-settings").hidden = false;
        this.#error(error);
      } else {
        void this.reset();
        this.#toggle.focus();
      }
    }
  }
}
