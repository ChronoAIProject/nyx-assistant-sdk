export const widgetStyle = `
:host {
  color-scheme: light dark;
  font: inherit;
  line-height: 1.45;
  --_nyx-ink: var(--nyx-text, CanvasText);
  --_nyx-paper: var(--nyx-surface, Canvas);
  --_nyx-accent: var(--nyx-accent, #236456);
  --_nyx-line: color-mix(in srgb, var(--_nyx-ink) 18%, transparent);
  position: fixed;
  z-index: var(--nyx-z-index, 1000);
  inset: auto max(16px, env(safe-area-inset-right))
    max(16px, env(safe-area-inset-bottom)) auto;
  color: var(--_nyx-ink);
}
:host([position="left"]) {
  right: auto;
  left: max(16px, env(safe-area-inset-left));
}
* {
  box-sizing: border-box;
}
[hidden] {
  display: none !important;
}
button,
textarea,
a {
  font: inherit;
}
button {
  cursor: pointer;
  border: 0;
  color: inherit;
  background: transparent;
}
button:disabled {
  cursor: default;
  opacity: 0.55;
}
button:focus-visible,
a:focus-visible,
textarea:focus-visible {
  outline: 2px solid var(--_nyx-accent);
  outline-offset: 2px;
}
.launch,
.send,
.connect {
  background: var(--_nyx-accent);
  color: var(--nyx-accent-text, white);
  font-weight: 600;
}
.launch {
  border-radius: 999px;
  min-height: 46px;
  padding: 0 19px;
  box-shadow: 0 3px 16px #0002;
  display: flex;
  align-items: center;
  gap: 10px;
}
.bubble {
  display: inline-block;
  width: 18px;
  height: 14px;
  border: 1.8px solid currentColor;
  border-radius: 5px 5px 5px 1px;
}
.panel {
  border: 1px solid var(--_nyx-line);
  border-radius: var(--nyx-radius, 18px);
  background: var(--_nyx-paper);
  box-shadow: 0 8px 32px #0002;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  width: min(23rem, calc(100vw - 32px));
  max-height: var(--nyx-panel-max-height, calc(100dvh - 32px));
  height: 30rem;
}
.panel:has(form[hidden]):not(:has(.msg)) {
  height: auto;
}
.chat:empty {
  padding: 0;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 12px 12px 18px;
  border-bottom: 1px solid var(--_nyx-line);
}
h2 {
  font: inherit;
  font-weight: 650;
  margin: 0;
}
.close {
  font: 24px/1 system-ui;
  width: 40px;
  height: 40px;
}
.disconnect {
  margin-inline-start: auto;
  font-size: 0.82em;
  text-decoration: underline;
}
.chat {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 16px;
  overscroll-behavior: contain;
}
p {
  margin: 0 0 10px;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.msg {
  padding: 9px 12px;
  border: 1px solid var(--_nyx-line);
  border-radius: 12px;
  width: fit-content;
  max-width: 94%;
}
.user {
  background: color-mix(in srgb, var(--_nyx-accent) 11%, var(--_nyx-paper));
  margin-inline-start: auto;
}
.controls {
  padding: 12px;
  border-top: 1px solid var(--_nyx-line);
}
.status {
  font-size: 0.88em;
}
.status:empty {
  display: none;
}
form {
  display: flex;
  align-items: flex-end;
  gap: 6px;
}
textarea {
  height: 3.2em;
  resize: vertical;
  min-height: 40px;
  max-height: 6em;
  min-width: 0;
  flex: 1;
  color: var(--_nyx-ink);
  background: var(--_nyx-paper);
  padding: 8px;
  border: 1px solid var(--_nyx-line);
  border-radius: 9px;
}
.send,
.connect,
.resume {
  border-radius: 10px;
  min-height: 40px;
  padding: 0 13px;
}
.resume {
  border: 1px solid var(--_nyx-line);
}
a {
  color: var(--_nyx-accent);
  display: inline-block;
  margin: 0 0 8px;
  text-decoration: underline;
}
`;
