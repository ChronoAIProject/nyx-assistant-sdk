// Each native window starts one instance of this process over private stdin/stdout pipes.
import { createInterface } from "node:readline";
import catalog from "./locales.json" with { type: "json" };
import { z } from "zod";
import { AssistantHost, LocalizedError, NyxIDConnection } from "@chronoai/nyx-assistant-sdk";
import { createNyxChatService } from "@chronoai/nyx-assistant-sdk/nyx-chat";

const language = Object.hasOwn(catalog.locales, process.argv[2]) ? process.argv[2] : catalog.defaultLocale;
const copy = catalog.locales[language];
const post = message => process.stdout.write(JSON.stringify(message) + "\n");
const pending = new Map();
function native(name, args, signal) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const abort = () => { pending.delete(id); reject(signal.reason); };
    signal.throwIfAborted();
    signal.addEventListener("abort", abort, { once: true });
    pending.set(id, result => { signal.removeEventListener("abort", abort); resolve(result); });
    post({ type: "call", id, name, args });
  });
}
const base = process.env.NYXID_BASE_URL;
const key = process.env.NYXID_AGENT_KEY;
const host = base && key ? new AssistantHost(createNyxChatService(new NyxIDConnection(base, (url, init) => {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${key}`);
  return fetch(url, { ...init, headers });
})), () => ({ view: "native-list", language })) : undefined;

if (host) host.language = language;

host?.registerTool({ name: "read_selection", description: copy.readTool,
  parameters: z.object({}), execute: (args, signal) => native("read_selection", args, signal) });
host?.registerTool({ name: "set_mark", description: copy.markTool,
  parameters: z.object({ id: z.string(), marked: z.boolean() }), execute: (args, signal) => native("set_mark", args, signal) });
const lines = createInterface({ input: process.stdin });
lines.on("line", async line => {
  try {
    const message = JSON.parse(line);
    if (message.type === "result") {
      const resolve = pending.get(message.id);
      pending.delete(message.id);
      resolve?.(message.result);
    } else if (message.type === "send" || message.type === "resume") {
      if (!host) throw Error(copy.configure);
      const text = await (message.type === "send" ? host.send(message.text) : host.resume());
      post({ type: "answer", text });
    }
  } catch (error) {
    const text = error instanceof LocalizedError ? error.localize(language) : error.message;
    post({ type: "error", text, pending: Boolean(host?.pendingRequestId) });
  }
});
lines.on("close", () => host?.dispose());
