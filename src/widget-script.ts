import { NyxAssistantElement } from "./widget.ts";

const script = document.currentScript as HTMLScriptElement | null;
function mount() {
  if (document.querySelector("nyx-assistant")) return;
  const widget = document.createElement("nyx-assistant");
  for (const name of ["lang", "data-voice", "data-nyxid", "data-verification-origin", "data-proxy", "data-services", "data-key-source", "data-storage",
    "data-voice-name", "data-voice-tour", "data-voice-screenshot", "data-voice-screenshot-after", "data-voice-model", "data-instructions", "data-text-instructions", "data-voice-instructions"]) {
    if (script?.hasAttribute(name))
      widget.setAttribute(name, script.getAttribute(name)!);
  }
  if (script?.dataset.position === "left")
    widget.setAttribute("position", "left");
  document.body.append(widget);
}
if (!customElements.get("nyx-assistant")) {
  customElements.define("nyx-assistant", NyxAssistantElement);
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
}
