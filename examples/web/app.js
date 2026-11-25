import { AssistantHost, NyxIDConnection } from "@chronoai/nyx-assistant-sdk";
import { createNyxChatService } from "@chronoai/nyx-assistant-sdk/nyx-chat";
import { z } from "zod";

const issues = [
  { name: "核对发票", state: "open" },
  { name: "整理清单", state: "closed" },
  { name: "更新地址", state: "open" },
];
const byId = id => document.getElementById(id);
const filter = byId("filter");
const answer = byId("answer");
const rows = byId("rows");

function render() {
  rows.replaceChildren();
  for (const item of issues.filter(item => filter.value === "all" || item.state === filter.value)) {
    const row = rows.insertRow();
    row.insertCell().textContent = item.name;
    row.insertCell().textContent = item.state === "open" ? "待处理" : "已关闭";
  }
  byId("count").textContent = `${rows.rows.length} 条`;
}
filter.onchange = render;
render();
const connection = new NyxIDConnection(location.origin);
const host = new AssistantHost(createNyxChatService(connection), () => ({ view: "tickets" }));
const state = () => ({ filter: filter.value, visibleRows: rows.rows.length });
host.registerTool({ name: "read_filter", description: "Read the current filter and displayed row count.",
  parameters: z.object({}), execute: () => ({ ok: true, value: state() }) });
host.registerTool({ name: "set_filter", description: "Set the ticket filter and report the displayed row count.",
  parameters: z.object({ filter: z.enum(["all", "open", "closed"]) }), execute(input) {
    if (byId("readonly").checked) return { ok: false, code: "read_only", message: "此页面为只读模式。" };
    filter.value = input.filter;
    render();
    return { ok: true, value: state() };
  } });
async function submit(action) {
  byId("send").disabled = true;
  byId("resume").hidden = true;
  answer.textContent = "正在等待 NyxID 服务…";
  try { answer.textContent = await action(); }
  catch (error) { answer.textContent = error.message; }
  finally {
    byId("resume").hidden = !host.pendingRequestId;
    byId("send").disabled = Boolean(host.pendingRequestId);
  }
}
document.querySelector("form").onsubmit = event => {
  event.preventDefault(); void submit(() => host.send(byId("prompt").value));
};
byId("resume").onclick = () => void submit(() => host.resume());
window.addEventListener("pagehide", () => host.dispose(), { once: true });
