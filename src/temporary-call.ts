import type { AgentIdentity } from "./agent-identity.ts";
import type { NyxIDConnection } from "./connection.ts";
import { LocalizedError } from "./i18n.ts";
import { gatherIce } from "./widget-call.ts";
import { RealtimeTour } from "./realtime-tour.ts";
import { TabScreenshot } from "./tab-screenshot.ts";
import { RealtimeTools, type VoiceApplication } from "./realtime-tools.ts";

type Service = AgentIdentity["services"][number];

/** One WebRTC call billed through the user's exact OpenAI service connection. */
export class TemporaryCall {
  readonly #stop = new AbortController();
  readonly #audio = new Audio();
  #media?: MediaStream;
  #peer?: RTCPeerConnection;
  #deadline?: number;
  #check?: number;
  #muted = false;
  readonly screenshots?: TabScreenshot;
  toggleSharing() {
    return this.screenshots?.active ? this.screenshots.stop() : this.screenshots?.share(this.#stop.signal);
  }

  readonly #connection: NyxIDConnection;
  readonly #service: Service;
  readonly #live: (muted: boolean) => void;
  readonly #caption: (id: string, speaker: string, text: string) => void;
  readonly #failed: (error: unknown) => void;
  readonly #application?: VoiceApplication;
  readonly #identity?: AgentIdentity;

  constructor(connection: NyxIDConnection, service: Service, live: (muted: boolean) => void,
    caption: (id: string, speaker: string, text: string) => void, failed: (error: unknown) => void,
    application?: VoiceApplication, identity?: AgentIdentity, sharingChanged: () => void = () => {}) {
    if (application?.screenshots && TabScreenshot.supported()) this.screenshots = new TabScreenshot(sharingChanged);
    this.#connection = connection;
    this.#service = service;
    this.#live = live;
    this.#caption = caption;
    this.#failed = failed;
    this.#application = application;
    this.#identity = identity;
  }

  async start() {
    const signal = this.#stop.signal;
    if (!navigator.mediaDevices?.getUserMedia) throw new LocalizedError("microphoneUnavailable");
    if (typeof RTCPeerConnection === "undefined") throw new LocalizedError("voiceUnavailable");
    const media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } });
    if (signal.aborted) {
      media.getTracks().forEach(track => track.stop());
      signal.throwIfAborted();
    }
    this.#media = media;
    const peer = this.#peer = new RTCPeerConnection();
    for (const track of media.getAudioTracks()) {
      track.onended = () => this.#failed(new LocalizedError("microphoneUnavailable"));
      peer.addTrack(track, media);
    }
    peer.ontrack = ({ track, streams }) => {
      this.#audio.srcObject = streams[0] ?? new MediaStream([track]);
      void this.#audio.play().catch(() => { if (!signal.aborted) this.#failed(new LocalizedError("playbackFailed")); });
    };
    peer.onconnectionstatechange = () => {
      if (!signal.aborted && peer.connectionState === "failed") this.#failed(new LocalizedError("voiceLost"));
    };
    const events = peer.createDataChannel("oai-events");
    const createResponse = () => {
      if (!signal.aborted && events.readyState === "open") events.send(JSON.stringify({type: "response.create"}));
    };
    const tour = this.#application?.guidedTour ? new RealtimeTour(createResponse) : undefined;
    signal.addEventListener("abort", () => tour?.setActive(false), {once: true});
    const tools = this.#application && this.#identity && new RealtimeTools(this.#application, this.#connection, this.#identity, signal,
      this.screenshots && (() => this.screenshots!.frame(this.#peer?.sctp?.maxMessageSize ?? 65536)), tour && (active => tour.setActive(active)));
    events.onopen = () => {
      clearTimeout(this.#deadline);
      this.#live(this.#muted);
      this.#check = window.setTimeout(() => void this.#checkGrant(), 15_000);
    };
    events.onclose = () => { if (!signal.aborted) this.#failed(new LocalizedError("voiceLost")); };
    let greeted = false;
    events.onmessage = ({ data }) => {
      if (signal.aborted || typeof data !== "string") return;
      try {
        const event = JSON.parse(data);
        tour?.observe(event);
        if (event.type === "session.created" && this.#application?.guidedTour && !greeted) {
          greeted = true;
          events.send(JSON.stringify({type: "response.create", response: {tool_choice: "none",
            instructions: [tools?.instructions, "Opening greeting only. Introduce yourself briefly in the configured default language, invite the visitor to say Start the tour, then wait for them to speak."].filter(Boolean).join("\n")
          }}));
        }
        if (event.type === "response.done" && tools) {
          void tools.respond(event.response, out => events.send(JSON.stringify(out))).catch(error => {
            if (!signal.aborted) this.#failed(error);
          });
          return;
        }
        if (event.type === "error") { this.#failed(new LocalizedError("voiceFailed")); return; }
        if (typeof event.item_id !== "string" || typeof event.transcript !== "string") return;
        if (event.type === "conversation.item.input_audio_transcription.completed") this.#caption(event.item_id, "user", event.transcript);
        if (event.type === "response.output_audio_transcript.done") this.#caption(event.item_id, "assistant", event.transcript);
      } catch { /* Unknown provider events do not affect the media stream. */ }
    };
    const sdp = await gatherIce(peer, signal);
    signal.throwIfAborted();
    const form = new FormData();
    form.append("sdp", sdp);
    form.append("session", JSON.stringify({
      type: "realtime", model: this.#application?.model?.()?.trim() || "gpt-realtime",
      instructions: tools?.instructions ?? "You are a voice assistant. Reply briefly in the language the user speaks.",
      tools: tools?.tools,
      audio: { input: { transcription: { model: "whisper-1" } } },
    }));
    const response = await this.#connection.requestService(this.#service, ["realtime", "calls"], {
      method: "POST", body: form, signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    });
    if (!response.ok) throw new LocalizedError("voiceHttp", String(response.status));
    const answer = await response.text();
    signal.throwIfAborted();
    if (!answer.startsWith("v=0") || answer.length > 65536) throw new LocalizedError("voiceFailed");
    this.#deadline = window.setTimeout(() => this.#failed(new LocalizedError("timeout")), 30_000);
    await peer.setRemoteDescription({ type: "answer", sdp: answer });
  }

  async #checkGrant() {
    const signal = this.#stop.signal;
    try {
      const identity = await this.#connection.getAgentIdentity(AbortSignal.any([signal, AbortSignal.timeout(7000)]));
      signal.throwIfAborted();
      if (!identity.services.some(row => row.id === this.#service.id && row.active && (row.catalogSlug ?? row.slug) === "llm-openai"))
        throw new LocalizedError("voiceAccessLost");
      this.#check = window.setTimeout(() => void this.#checkGrant(), 15_000);
    } catch { if (!signal.aborted) this.#failed(new LocalizedError("voiceAccessLost")); }
  }
  async mute(muted: boolean) {
    this.#muted = muted;
    this.#media?.getAudioTracks().forEach(track => { track.enabled = !muted; });
    this.#live(muted);
  }
  async end() {
    this.#stop.abort();
    this.screenshots?.stop();
    clearTimeout(this.#deadline);
    clearTimeout(this.#check);
    this.#media?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    this.#peer?.close();
    this.#audio.pause();
    this.#audio.srcObject = null;
  }
}
