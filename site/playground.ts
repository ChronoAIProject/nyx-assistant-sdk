import { AssistantHost, z, type NyxIDService } from "../src/index.ts";
import { mountTickets } from "../examples/web/tickets.js";

const prompts = {
  read: { name: "read_filter", arguments: {} },
  open: { name: "set_filter", arguments: { filter: "open" } },
  closed: { name: "set_filter", arguments: { filter: "closed" } },
} as const;

const labels = { all: "全部", open: "待处理", closed: "已关闭" } as const;
const tickets = mountTickets();
const result = document.querySelector<HTMLElement>("#tool-result")!;
const resultState = document.querySelector<HTMLElement>("#result-state")!;
const summary = document.querySelector<HTMLElement>("#result-summary")!;
const actions = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-prompt]"));

// A fixed service adapter drives the real SDK and host tools without a network request.
const preview: NyxIDService = {
  async turn({ requestId, input, conversationId = "pages-preview" }) {
    if (input.type === "user") {
      if (!Object.hasOwn(prompts, input.text)) throw new Error("未知演练指令。");
      const prompt = prompts[input.text as keyof typeof prompts];
      return { type: "call", conversationId, callId: requestId, ...prompt };
    }

    const { result } = input;
    if (!result.ok) return { type: "answer", conversationId, text: result.message };
    const { filter, visibleRows } = result.value as ReturnType<typeof tickets.state>;
    return { type: "answer", conversationId, text: `「${labels[filter as keyof typeof labels]}」筛选下显示 ${visibleRows} 条工单。` };
  },
};

const host = new AssistantHost(preview, tickets.state);
tickets.registerTools(host, z);
host.subscribe((event) => {
  if (event.type !== "tool_result") return;
  resultState.textContent = event.result.ok ? "调用成功" : "宿主拒绝";
  resultState.dataset.status = event.result.ok ? "ok" : "error";
  result.textContent = `${event.name} → ${JSON.stringify(event.result)}`;
});

for (const button of actions) {
  button.addEventListener("click", async () => {
    for (const action of actions) action.disabled = true;
    try {
      summary.textContent = await host.send(button.dataset.prompt!);
    } catch (error) {
      resultState.textContent = "调用失败";
      resultState.dataset.status = "error";
      result.textContent = "";
      summary.textContent = error instanceof Error ? error.message : "无法运行演练。";
    } finally {
      for (const action of actions) action.disabled = false;
    }
  });
  button.disabled = false;
}

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-copy]")) {
  const source = document.getElementById(button.dataset.copy!)!;
  if (!navigator.clipboard) continue;
  button.hidden = false;
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(source.textContent!.trim());
      button.textContent = "已复制";
    } catch {
      const range = document.createRange();
      range.selectNodeContents(source);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      button.textContent = "已选中";
    }
  });
  button.addEventListener("blur", () => { button.textContent = "复制"; });
}
