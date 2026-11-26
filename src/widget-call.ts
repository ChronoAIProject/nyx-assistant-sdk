import type { NyxIDConnection } from "./connection.ts";
import { LocalizedError } from "./i18n.ts";
import { VoiceClient, type VoicePreferences, type VoiceSnapshot } from "./voice.ts";
import type { AgentIdentity } from "./agent-identity.ts";

type Service = AgentIdentity["services"][number];

async function gatherIce(peer: RTCPeerConnection, signal: AbortSignal) {
  await peer.setLocalDescription(await peer.createOffer());
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(6000)]);
  while (peer.iceGatheringState !== "complete") {
    timeout.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        timeout.removeEventListener("abort", finish);
        peer.removeEventListener("icegatheringstatechange", finish);
        if (timeout.aborted) reject(timeout.reason);
        else resolve();
      };
      timeout.addEventListener("abort", finish, { once: true });
      peer.addEventListener("icegatheringstatechange", finish, { once: true });
    });
  }
  return peer.localDescription!.sdp;
}

// This worklet runs in a 24 kHz context. The browser resamples the microphone.
// It outputs silence and transfers 20 ms mono packets only during an utterance.
const captureModule = `
  class VoiceCapture extends AudioWorkletProcessor {
    constructor() {
      super();
      this.port.onmessage = ({data}) => { this.turn = data; this.samples = []; };
    }
    process(inputs) {
      if (this.turn && inputs[0][0]) {
        for (const sample of inputs[0][0]) {
          this.samples.push(Math.round(Math.max(-1, Math.min(1, sample)) * 32767));
          if (this.samples.length === 480) {
            const bytes = new Int16Array(this.samples).buffer;
            this.port.postMessage({turn: this.turn, bytes}, [bytes]);
            this.samples = [];
          }
        }
      }
      return true;
    }
  }
  registerProcessor("nyx-voice-capture", VoiceCapture);`;

export class WidgetCall {
  readonly #client: VoiceClient;
  readonly #abort = new AbortController();
  readonly #audio = new Audio();
  readonly #failed: (error: Error) => void;
  #media?: MediaStream;
  #peer?: RTCPeerConnection;
  #context?: AudioContext;
  #capture?: AudioWorkletNode;
  #playback = new Set<AudioBufferSourceNode>();
  #nextTime = 0;
  #playedMs = 0;
  #turn = 0;
  #talking = false;
  #beat?: number;
  #deadline?: number;
  #ending?: Promise<void>;

  constructor(connection: NyxIDConnection, service: Service, snapshot: (value: VoiceSnapshot) => void, failed: (error: Error) => void) {
    this.#failed = failed;
    this.#client = new VoiceClient(connection, service, {
      socket: (url, credential) => {
        const socket = new WebSocket(url);
        socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "authenticate", credential })), { once: true });
        return socket;
      },
      onSnapshot: value => {
        if (this.#abort.signal.aborted) return;
        const s = value.session;
        const live = s.state === "active" && !s.end_requested && !s.muted && !s.input_muted;
        if (!live) this.talk(false);
        for (const track of this.#media?.getAudioTracks() ?? []) track.enabled = live && (!this.#context || this.#talking);
        if (s.state === "active") clearTimeout(this.#deadline);
        this.#beat ??= window.setInterval(() => {
          const playing = this.#context ? this.#playback.size > 0 && this.#context.state === "running" : !this.#audio.paused;
          this.#client.heartbeat(this.#context ? this.#playedMs : this.#audio.currentTime * 1000, playing);
        }, 1000);
        snapshot(value);
      },
      onAudio: (pcm, endMs) => this.#play(pcm, endMs),
      onAudioFlush: () => this.#flush(),
      onError: failed,
    });
  }

  async start(agentId: string, preferences: VoicePreferences, pcm: boolean) {
    const signal = this.#abort.signal;
    if (!navigator.mediaDevices?.getUserMedia) throw new LocalizedError("microphoneUnavailable");
    const media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true } });
    if (signal.aborted) {
      media.getTracks().forEach(track => track.stop());
      signal.throwIfAborted();
    }
    this.#media = media;
    for (const track of media.getAudioTracks()) {
      track.enabled = false;
      track.onended = () => this.#failed(new LocalizedError("microphoneUnavailable"));
    }
    let offer = "";
    if (pcm) {
      const context = this.#context = new AudioContext({ sampleRate: 24000 });
      await context.resume();
      const url = URL.createObjectURL(new Blob([captureModule], { type: "text/javascript" }));
      try { await context.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
      signal.throwIfAborted();
      const node = this.#capture = new AudioWorkletNode(context, "nyx-voice-capture");
      context.createMediaStreamSource(media).connect(node).connect(context.destination);
      node.port.onmessage = ({ data }) => {
        if (this.#talking && data.turn === this.#turn) this.#client.sendPcm(data.bytes);
      };
    } else {
      const peer = this.#peer = new RTCPeerConnection();
      for (const track of media.getAudioTracks()) peer.addTrack(track, media);
      peer.createDataChannel("oai-events");
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "failed") this.#failed(new LocalizedError("voiceLost"));
      };
      peer.ontrack = ({ track, streams }) => {
        this.#audio.srcObject = streams[0] ?? new MediaStream([track]);
        void this.#audio.play().catch(() => { if (!signal.aborted) this.#failed(new LocalizedError("playbackFailed")); });
      };
      offer = await gatherIce(peer, signal);
    }
    signal.throwIfAborted();
    this.#deadline = window.setTimeout(() => this.#failed(new LocalizedError("timeout")), 45000);
    // Keep the start response after cancellation so VoiceClient can end the allocated session.
    const result = await this.#client.start({ agentId, preferences, sdpOffer: offer }, AbortSignal.timeout(45000));
    signal.throwIfAborted();
    if (this.#peer) await this.#peer.setRemoteDescription({ type: "answer", sdp: result.sdp_answer });
  }

  mute(muted: boolean) {
    if (muted) {
      this.talk(false);
      this.#media?.getAudioTracks().forEach(track => { track.enabled = false; });
    }
    return this.#client.control(muted ? "mute" : "unmute", AbortSignal.timeout(7000));
  }

  talk(enabled: boolean) {
    if (enabled === this.#talking) return;
    if (enabled && !this.#client.beginInput()) return;
    this.#talking = enabled;
    this.#capture?.port.postMessage(enabled ? ++this.#turn : 0);
    if (this.#context) for (const track of this.#media?.getAudioTracks() ?? []) track.enabled = enabled;
    if (!enabled) this.#client.commitInput();
  }

  #play(pcm: ArrayBuffer, endMs: number) {
    const context = this.#context;
    if (!context || this.#abort.signal.aborted) return;
    if (this.#nextTime - context.currentTime > 5) throw new LocalizedError("playbackFailed");
    const samples = new Int16Array(pcm);
    const audio = context.createBuffer(1, samples.length, 24000);
    const channel = audio.getChannelData(0);
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 32768;
    const source = context.createBufferSource();
    source.buffer = audio;
    source.connect(context.destination);
    const at = Math.max(context.currentTime, this.#nextTime);
    this.#nextTime = at + audio.duration;
    this.#playback.add(source);
    source.onended = () => {
      if (this.#playback.delete(source)) this.#playedMs = Math.max(this.#playedMs, endMs);
      source.disconnect();
    };
    source.start(at);
  }
  #flush() {
    for (const source of this.#playback) source.stop();
    this.#playback.clear();
    this.#nextTime = 0;
  }

  end() {
    if (this.#ending) return this.#ending;
    this.#abort.abort();
    clearTimeout(this.#deadline);
    clearInterval(this.#beat);
    this.talk(false);
    this.#media?.getTracks().forEach(track => track.stop());
    this.#peer?.close();
    this.#audio.pause();
    this.#audio.srcObject = null;
    this.#capture?.port.close();
    this.#capture?.disconnect();
    this.#flush();
    void this.#context?.close().catch(() => {});
    const session = this.#client.session;
    this.#ending = (async () => {
      try {
        if (session && !session.end_requested && !["closed", "failed"].includes(session.state))
          await this.#client.control("end", AbortSignal.timeout(7000));
      } finally { this.#client.close(); }
    })();
    return this.#ending;
  }
}
