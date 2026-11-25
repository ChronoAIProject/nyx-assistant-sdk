import { z } from "zod";
export { z } from "zod";
export { NyxIDConnection } from "./connection.ts";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ToolResult =
  | { ok: true; value: Json }
  | { ok: false; code: string; message: string };

export interface ToolDescription {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type TurnInput =
  | { type: "user"; text: string }
  | { type: "tool_result"; callId: string; name: string; result: ToolResult };

export interface TurnRequest {
  requestId: string;
  instanceId: string;
  conversationId?: string;
  context: Json;
  tools: ToolDescription[];
  input: TurnInput;
}

export type ServiceReply = { conversationId: string } & (
  | { type: "answer"; text: string }
  | { type: "call"; callId: string; name: string; arguments: unknown }
);

export interface NyxIDService {
  /** Retrying the same requestId must retrieve or resume the original turn. */
  turn(request: TurnRequest, signal: AbortSignal, onText: (text: string) => void): Promise<ServiceReply>;
}

export type AssistantEvent =
  | { type: "text"; text: string }
  | { type: "tool_result"; name: string; callId: string; result: ToolResult };

interface RegisteredTool {
  descriptor: ToolDescription;
  lifetime: AbortController;
  invoke(args: unknown, signal: AbortSignal): Promise<ToolResult>;
}

interface Pending {
  request: TurnRequest;
  bindings: Map<string, RegisteredTool>;
  calls: number;
}

/** One host per window and identity. Dispose on logout or window teardown. */
export class AssistantHost {
  readonly instanceId = crypto.randomUUID();
  readonly #service: NyxIDService;
  readonly #context: () => Json;
  readonly #tools = new Map<string, RegisteredTool>();
  readonly #listeners = new Set<(event: AssistantEvent) => void>();
  readonly #lifetime = new AbortController();
  readonly #receipts = new Map<string, { name: string; args: string; result: ToolResult }>();
  #active?: AbortController;
  #pending?: Pending;
  #conversationId?: string;

  constructor(service: NyxIDService, context: () => Json = () => null) {
    this.#service = service;
    this.#context = context;
  }

  get conversationId() { return this.#conversationId; }
  get pendingRequestId() { return this.#pending?.request.requestId; }

  subscribe(listener: (event: AssistantEvent) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: AssistantEvent) {
    for (const listener of this.#listeners) {
      // UI subscribers are observers; a rendering error must not replay a mutation.
      try { listener(structuredClone(event)); } catch (error) { console.error(error); }
    }
  }

  registerTool<T extends z.ZodObject>(tool: {
    name: string;
    description: string;
    parameters: T;
    execute: (args: z.output<T>, signal: AbortSignal) => ToolResult | Promise<ToolResult>;
  }): () => void {
    this.#lifetime.signal.throwIfAborted();
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(tool.name) || !tool.description.trim()) {
      throw new Error("Invalid tool name or description");
    }
    if (this.#tools.has(tool.name)) throw new Error("Tool already registered");
    const schema = tool.parameters.strict();
    const registered: RegisteredTool = {
      descriptor: {
        name: tool.name, description: tool.description,
        inputSchema: z.toJSONSchema(schema, { io: "input" }),
      },
      lifetime: new AbortController(),
      async invoke(args, signal) {
        const parsed = schema.safeParse(args);
        if (!parsed.success) return { ok: false, code: "invalid_arguments", message: "Arguments do not match this tool's schema." };
        try {
          signal.throwIfAborted();
          return await tool.execute(parsed.data as z.output<T>, signal);
        } catch {
          return { ok: false, code: "outcome_unknown", message: "Verify the host state before retrying." };
        }
      },
    };
    this.#tools.set(tool.name, registered);
    return () => {
      registered.lifetime.abort();
      if (this.#tools.get(tool.name) === registered) this.#tools.delete(tool.name);
    };
  }

  #prepare(input: TurnInput, calls: number): Pending {
    const bindings = new Map(this.#tools);
    return {
      bindings, calls,
      request: structuredClone({
        instanceId: this.instanceId, requestId: crypto.randomUUID(), conversationId: this.#conversationId,
        input, context: this.#context(), tools: [...bindings.values()].map(tool => tool.descriptor),
      }),
    };
  }

  send(text: string): Promise<string> {
    this.#lifetime.signal.throwIfAborted();
    if (!text.trim()) throw new Error("Message is empty");
    if (this.#active || this.#pending) throw new Error("A turn is active or needs recovery");
    this.#pending = this.#prepare({ type: "user", text }, 0);
    return this.resume();
  }

  /** Stops observing the service. A submitted service turn can still complete. */
  stopWaiting() { this.#active?.abort(); }

  dispose() {
    this.#lifetime.abort();
    this.stopWaiting();
    this.#pending = undefined;
    this.#conversationId = undefined;
    for (const tool of this.#tools.values()) tool.lifetime.abort();
    this.#tools.clear();
    this.#receipts.clear();
    this.#listeners.clear();
  }

  async resume(): Promise<string> {
    this.#lifetime.signal.throwIfAborted();
    if (this.#active || !this.#pending) throw new Error("No interrupted turn to resume");
    const active = new AbortController();
    this.#active = active;
    try {
      while (this.#pending) {
        const pending = this.#pending;
        active.signal.throwIfAborted();
        const reply = await this.#service.turn(structuredClone(pending.request), active.signal,
          text => { if (!active.signal.aborted) this.#emit({ type: "text", text }); });
        active.signal.throwIfAborted();
        if (!reply.conversationId || (this.#conversationId && reply.conversationId !== this.#conversationId)) {
          throw new Error("Service changed the conversation identity");
        }
        this.#conversationId = reply.conversationId;
        if (reply.type === "answer") {
          this.#pending = undefined;
          return reply.text;
        }
        if (!reply.callId || pending.calls >= 16) throw new Error("Invalid or excessive tool calls");
        // Prepare the continuation before executing anything that can change the host.
        const resultInput: TurnInput = { type: "tool_result", name: reply.name, callId: reply.callId,
          result: { ok: false, code: "outcome_unknown", message: "Verify the host state before retrying." } };
        const next = this.#prepare(resultInput, pending.calls + 1);
        this.#pending = next;
        const tool = pending.bindings.get(reply.name);
        let result: ToolResult = { ok: false, code: "tool_unavailable", message: "Tool is unavailable in this instance." };
        const args = JSON.stringify(reply.arguments);
        const existing = this.#receipts.get(reply.callId);
        if (existing && (existing.name !== reply.name || existing.args !== args)) {
          result = { ok: false, code: "call_conflict", message: "Call ID was already used for another request." };
        } else if (tool && this.#tools.get(reply.name) === tool) {
          result = existing?.result ?? await tool.invoke(reply.arguments, AbortSignal.any([active.signal, tool.lifetime.signal]));
        }
        this.#lifetime.signal.throwIfAborted();
        if (!existing) this.#receipts.set(reply.callId, { name: reply.name, args, result: structuredClone(result) });
        next.request.input = structuredClone({ ...resultInput, result });
        // Keep a recoverable result even if the host cannot build a fresh snapshot.
        this.#pending = this.#prepare(next.request.input, next.calls);
        this.#emit({ type: "tool_result", name: reply.name, callId: reply.callId, result });
      }
      throw new Error("Host closed");
    } finally {
      this.#active = undefined;
    }
  }
}
