import { z } from "zod";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/);
const stateSchema = z.object({
  messages: z.array(z.object({ text: z.string(), user: z.boolean() })).max(30),
  conversation: id.optional(),
  pending: z.object({ requestId: id, id: id.optional(), conversationId: id.optional() }).optional(),
});
type State = z.infer<typeof stateSchema>;

/** A verified child credential and a host-defined scope own this tab's transcript. */
export class WidgetSession {
  readonly #key: string;
  state: State;
  constructor(scope: string, grantKey: string, credentialId: string) {
    this.#key = "nyx-assistant:chat:" + JSON.stringify([grantKey, credentialId, scope]);
    const raw = sessionStorage.getItem(this.#key);
    this.state = raw ? stateSchema.parse(JSON.parse(raw)) : { messages: [] };
  }
  save(state: State) {
    sessionStorage.setItem(this.#key, JSON.stringify(state));
    this.state = state;
  }
  message(text: string, user: boolean, conversation?: string) {
    const messages = [...this.state.messages, { user, text }].slice(-30);
    while (messages.length > 1 && messages.reduce((n, m) => n + m.text.length, 0) > 150000) messages.shift();
    this.save({ messages, conversation, pending: user ? this.state.pending : undefined });
  }
}
