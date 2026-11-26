import { AssistantHost, z, type NyxIDService } from "../src/index.ts";
import { mountTickets } from "../examples/web/tickets.js";
import type { NyxAssistantElement } from "../src/widget.ts";
import { locales } from "./locales.mjs";

const prompts = {
  read: { name: "read_filter", arguments: {} },
  open: { name: "set_filter", arguments: { filter: "open" } },
  closed: { name: "set_filter", arguments: { filter: "closed" } },
} as const;

const copy = locales[document.documentElement.dataset.locale as keyof typeof locales];
const list = new Intl.ListFormat(copy.lang);
const tickets = mountTickets(copy.tickets);
const widget = document.querySelector<NyxAssistantElement>("nyx-assistant")!;
const connect = document.querySelector<HTMLButtonElement>("#connect-nyxid")!;
const manage = document.querySelector<HTMLAnchorElement>("#manage-key")!;
const services = document.querySelector<HTMLElement>("#key-services")!;
function renderAccess() {
  const access = widget.access;
  connect.hidden = Boolean(access);
  manage.hidden = services.hidden = !access;
  if (access) manage.href = access.managementUrl;
  else manage.removeAttribute("href");
  services.textContent = access ? copy.demo.services(list.format(access.services)) : "";
}
widget.addEventListener("nyx-state", renderAccess);
customElements.whenDefined("nyx-assistant").then(() => {
  connect.disabled = false;
  connect.onclick = () => widget.connect();
  renderAccess();
});
widget.addEventListener("nyx-ready", (event) => {
  const { host, z: widgetZ } = (event as CustomEvent<{ host: AssistantHost; z: typeof z }>).detail;
  tickets.registerTools(host, widgetZ);
});
const result = document.querySelector<HTMLElement>("#tool-result")!;
const resultState = document.querySelector<HTMLElement>("#result-state")!;
const summary = document.querySelector<HTMLElement>("#result-summary")!;
const actions = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-prompt]"));

// A fixed service adapter drives the real SDK and host tools without a network request.
const preview: NyxIDService = {
  async turn({ requestId, input, conversationId = "pages-preview" }) {
    if (input.type === "user") {
      if (!Object.hasOwn(prompts, input.text)) throw new Error(copy.demo.unknown);
      const prompt = prompts[input.text as keyof typeof prompts];
      return { type: "call", conversationId, callId: requestId, ...prompt };
    }

    const { result } = input;
    if (!result.ok) return { type: "answer", conversationId, text: result.message };
    const { filter, visibleRows } = result.value as ReturnType<typeof tickets.state>;
    return { type: "answer", conversationId, text: copy.demo.answer(copy.tickets.states[filter as keyof typeof copy.tickets.states], visibleRows) };
  },
};

const host = new AssistantHost(preview, tickets.state);
host.language = copy.lang;
tickets.registerTools(host, z);
host.subscribe((event) => {
  if (event.type !== "tool_result") return;
  resultState.textContent = event.result.ok ? copy.demo.success : copy.demo.denied;
  resultState.dataset.status = event.result.ok ? "ok" : "error";
  result.textContent = `${event.name} → ${JSON.stringify(event.result)}`;
});

for (const button of actions) {
  button.addEventListener("click", async () => {
    for (const action of actions) action.disabled = true;
    try {
      summary.textContent = await host.send(button.dataset.prompt!);
    } catch (error) {
      resultState.textContent = copy.demo.failed;
      resultState.dataset.status = "error";
      result.textContent = "";
      summary.textContent = error instanceof Error ? error.message : copy.demo.unavailable;
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
      button.textContent = copy.demo.copied;
    } catch {
      const range = document.createRange();
      range.selectNodeContents(source);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      button.textContent = copy.demo.selected;
    }
  });
  button.addEventListener("blur", () => { button.textContent = copy.page.copy; });
}
