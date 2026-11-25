// Each native window starts one instance of this process over private stdin/stdout pipes.
import { createInterface } from "node:readline";
import { z } from "zod";
import { AssistantHost, NyxIDConnection } from "@chronoai/nyx-assistant-sdk";
import { createNyxChatService } from "@chronoai/nyx-assistant-sdk/nyx-chat";

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
})), () => ({ view: "native-list" })) : undefined;

host?.registerTool({ name: "read_selection", description: "Read the selected row ID and its marked state from this window.",
  parameters: z.object({}), execute: (args, signal) => native("read_selection", args, signal) });
host?.registerTool({ name: "set_mark", description: "Set the mark of the selected row, identified by ID, in this window.",
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
      if (!host) throw Error("请为原生示例配置 NYXID_BASE_URL 和 NYXID_AGENT_KEY");
      const text = await (message.type === "send" ? host.send(message.text) : host.resume());
      post({ type: "answer", text });
    }
  } catch (error) { post({ type: "error", text: error.message, pending: Boolean(host?.pendingRequestId) }); }
});
lines.on("close", () => host?.dispose());
