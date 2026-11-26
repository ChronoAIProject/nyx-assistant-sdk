import { z } from "zod";
import type { AgentIdentity } from "./agent-identity.ts";
import type { NyxIDConnection } from "./connection.ts";

const uuid = z.string().uuid();
const serviceId = uuid;

export const voiceAgentSchema = z.object({
  service_id: serviceId,
  agent_id: uuid,
  conversation_id: z.string().min(1).max(128),
  name: z.string().min(1).max(512).optional(),
  display_name: z.string().min(1).max(512).optional(),
  description: z.string().max(2000).optional(),
});

export const voicePreferencesSchema = z.object({
  service_id: serviceId,
  connection_id: uuid.nullable().optional(),
  key_source: z.enum(["platform", "own"]),
  model: z.string().min(1).max(200),
  voice: z.string().min(1).max(200).nullable().optional(),
  input_mode: z.enum(["automatic", "push_to_talk"]).default("automatic"),
  language: z.string().min(1).max(64).nullable().optional(),
  notify_on_completion: z.boolean().default(false),
});

export const voiceOptionSchema = z.object({
  service_id: serviceId,
  connection_id: uuid.nullable().optional(),
  key_source: z.enum(["platform", "own"]),
  model: z.string().min(1).max(200),
  model_label: z.string().optional(),
  default_model: z.boolean().optional(),
  voice: z.object({
    protocol: z.string(),
    voices: z.array(z.object({ id: z.string().min(1), label: z.string().optional() })).optional(),
  }).passthrough().optional(),
  available: z.boolean(),
  unavailable_reason: z.string().nullable().optional(),
}).passthrough();

export const voiceOptionsSchema = z.object({
  options: z.array(voiceOptionSchema),
  preferences: voicePreferencesSchema.nullable().optional(),
  greetings: z.boolean().optional(),
});

export const voiceSessionSchema = z.object({
  id: uuid,
  client_request_id: uuid.optional(),
  created_at: z.string().optional(),
  closed_at: z.string().nullable().optional(),
  generation: z.number().int().nonnegative(),
  state: z.enum(["starting", "active", "closing", "closed", "failed"]),
  muted: z.boolean().optional(),
  input_muted: z.boolean().optional(),
  end_requested: z.boolean().optional(),
  control_revision: z.number().int().nonnegative(),
  resumable: z.boolean().optional(),
}).passthrough();

export const voiceStartResponseSchema = z.object({
  session: voiceSessionSchema,
  sdp_answer: z.string().max(65536),
});

export const voiceSnapshotSchema = z.object({
  type: z.literal("snapshot"),
  session: voiceSessionSchema,
  captions: z.array(z.unknown()).optional(),
  tasks: z.array(z.unknown()).optional(),
}).passthrough();

export type VoiceAgent = z.infer<typeof voiceAgentSchema>;
export type VoicePreferences = z.input<typeof voicePreferencesSchema>;
export type VoiceOption = z.infer<typeof voiceOptionSchema>;
export type VoiceOptions = z.infer<typeof voiceOptionsSchema>;
export type VoiceSession = z.infer<typeof voiceSessionSchema>;
export type VoiceSnapshot = z.infer<typeof voiceSnapshotSchema>;

export const NYXBOT_VOICE_SERVICE = "nyxbot-voice";

type VoiceService = AgentIdentity["services"][number];

/** Select an exact published Bot Voice connection from a verified Agent Key. */
export function selectVoiceService(identity: AgentIdentity, requestedServiceId?: string): VoiceService {
  const matches = identity.services.filter(service =>
    service.active && (service.catalogSlug ?? service.slug) === NYXBOT_VOICE_SERVICE &&
    (!requestedServiceId || service.id === requestedServiceId));
  if (matches.length !== 1) {
    throw new Error(matches.length > 1
      ? "Multiple Bot Voice connections are authorized. Select one by service ID."
      : "No active Bot Voice connection is authorized for this Agent Key.");
  }
  return matches[0];
}

async function parseResponse<T>(response: Response, schema: z.ZodType<T>, label: string): Promise<T> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`${label} returned HTTP ${response.status}`);
  }
  return schema.parse(await response.json());
}

/** Discover and verify the Bot fixed by one exact Voice UserService. */
export async function discoverVoiceAgent(
  connection: NyxIDConnection,
  service: VoiceService,
  signal?: AbortSignal,
): Promise<VoiceAgent> {
  const response = await connection.requestService(service, ["voice", "agents"], {
    signal, cache: "no-store",
  });
  const payload = await parseResponse(response, z.object({ agents: z.array(voiceAgentSchema) }), "NyxID Voice discovery");
  if (payload.agents.length !== 1 || payload.agents[0].service_id !== service.id) {
    throw new Error("NyxID Voice discovery did not return the exact authorized Bot connection");
  }
  return payload.agents[0];
}

export interface VoiceSocket {
  readonly readyState: number;
  send(data: string | ArrayBuffer): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export type VoiceSocketFactory = (url: URL, credential: string) => VoiceSocket;

export interface VoiceClientOptions {
  socket?: VoiceSocketFactory;
  onSnapshot?: (snapshot: VoiceSnapshot) => void;
  onError?: (error: Error) => void;
}

export interface StartVoiceInput {
  preferences: VoicePreferences;
  sdpOffer: string;
  clientRequestId?: string;
  agentId?: string;
}

/** Agent-Key Voice transport for the published nyxbot-voice service. */
export class VoiceClient {
  readonly #connection: NyxIDConnection;
  readonly #service: VoiceService;
  readonly #options: VoiceClientOptions;
  #session?: VoiceSession;
  #socket?: VoiceSocket;
  #closed = false;
  #heartbeatRevision = 0;

  constructor(connection: NyxIDConnection, service: VoiceService, options: VoiceClientOptions = {}) {
    this.#connection = connection;
    this.#service = service;
    this.#options = options;
  }

  get session() { return this.#session; }
  get service() { return this.#service; }

  async getAgent(signal?: AbortSignal) {
    return discoverVoiceAgent(this.#connection, this.#service, signal);
  }

  async getOptions(conversationId?: string, signal?: AbortSignal): Promise<VoiceOptions> {
    const query = conversationId ? new URLSearchParams({ conversation_id: conversationId }) : undefined;
    const response = await this.#connection.requestService(this.#service, ["voice", "options"], {
      signal, cache: "no-store",
    }, query);
    return parseResponse(response, voiceOptionsSchema, "NyxID Voice options");
  }

  async start(input: StartVoiceInput, signal?: AbortSignal) {
    if (this.#session && !["closed", "failed"].includes(this.#session.state)) {
      throw new Error("A Voice call is already active");
    }
    const preferences = voicePreferencesSchema.parse(input.preferences);
    if (preferences.service_id !== this.#service.id) throw new Error("Voice preference service changed");
    if (input.sdpOffer.length > 65536) throw new Error("Voice SDP offer is too large");
    const agent = input.agentId;
    if (agent && !uuid.safeParse(agent).success) throw new Error("Invalid Voice Bot ID");
    const response = await this.#connection.requestService(this.#service, ["voice", "sessions"], {
      method: "POST", signal, cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(agent ? { agent_id: agent } : {}),
        service_id: this.#service.id,
        client_request_id: input.clientRequestId ?? crypto.randomUUID(),
        preferences,
        sdp_offer: input.sdpOffer,
      }),
    });
    const result = await parseResponse(response, voiceStartResponseSchema, "NyxID Voice start");
    this.#session = result.session;
    this.#closed = false;
    this.#heartbeatRevision = 0;
    if (this.#options.socket) this.#openControls();
    return result;
  }

  #openControls() {
    const session = this.#session;
    const factory = this.#options.socket;
    if (!session || !factory || this.#closed) return;
    const socket = this.#connection.openWebSocket(this.#service,
      ["voice", "sessions", session.id, "stream"], factory);
    this.#socket = socket;
    socket.onmessage = event => {
      try {
        const snapshot = voiceSnapshotSchema.parse(typeof event.data === "string" ? JSON.parse(event.data) : event.data);
        if (snapshot.session.id !== this.#session?.id) throw new Error("Voice snapshot identity changed");
        this.#session = snapshot.session;
        this.#options.onSnapshot?.(snapshot);
      } catch (error) {
        this.#options.onError?.(error instanceof Error ? error : new Error("Invalid Voice control message"));
      }
    };
    socket.onerror = () => this.#options.onError?.(new Error("NyxID Voice control connection failed"));
    socket.onclose = () => { if (!this.#closed) this.#options.onError?.(new Error("NyxID Voice control connection closed")); };
  }

  heartbeat(playbackMs = 0, playbackAudible = false) {
    const session = this.#session;
    if (!session || this.#socket?.readyState !== 1) return false;
    this.#socket.send(JSON.stringify({
      type: "heartbeat", generation: session.generation, revision: ++this.#heartbeatRevision,
      playback_ms: Math.max(0, Math.floor(playbackMs)), playback_audible: Boolean(playbackAudible),
    }));
    return true;
  }

  async control(action: "mute" | "unmute" | "end", signal?: AbortSignal) {
    const session = this.#session;
    if (!session) throw new Error("No Voice call is active");
    const response = await this.#connection.requestService(this.#service,
      ["voice", "sessions", session.id, "control"], {
        method: "POST", signal, cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command_id: crypto.randomUUID(), expected_revision: session.control_revision, action }),
      });
    const next = await parseResponse(response, voiceSessionSchema, "NyxID Voice control");
    this.#session = next;
    if (action === "end") this.close();
    return next;
  }

  async announce(input: { text: string } | { greeting: true }, signal?: AbortSignal) {
    const session = this.#session;
    if (!session) throw new Error("No Voice call is active");
    if ("text" in input && (input.text.length === 0 || input.text.length > 300)) throw new Error("Voice announcement text must be 1–300 characters");
    const response = await this.#connection.requestService(this.#service,
      ["voice", "sessions", session.id, "announcements"], {
        method: "POST", signal, cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: crypto.randomUUID(), ...input }),
      });
    return parseResponse(response, z.object({ state: z.string() }).passthrough(), "NyxID Voice announcement");
  }

  close() {
    this.#closed = true;
    this.#socket?.close();
    this.#socket = undefined;
  }
}
