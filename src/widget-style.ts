export const widgetStyle = `
:host {
  color-scheme: light dark;
  font: inherit;
  line-height: 1.45;
  --_nyx-ink: var(--nyx-text, CanvasText);
  --_nyx-paper: var(--nyx-surface, Canvas);
  --_nyx-accent: var(--nyx-accent, #236456);
  --_nyx-line: var(--nyx-border, color-mix(in srgb, var(--_nyx-ink) 22%, var(--_nyx-paper)));
  --_nyx-muted: var(--nyx-muted, color-mix(in srgb, var(--_nyx-ink) 73%, var(--_nyx-paper)));
  --_nyx-control: var(--nyx-control-surface, color-mix(in srgb, var(--_nyx-accent) 7%, var(--_nyx-paper)));
  --_nyx-label: var(--nyx-control-text, var(--_nyx-ink));
  --_nyx-corner: min(var(--nyx-radius, 12px), 8px);
  position: fixed;
  z-index: var(--nyx-z-index, 1000);
  inset: auto max(16px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) auto;
  color: var(--_nyx-ink);
}
:host([position="left"]) {
  right: auto;
  left: max(16px, env(safe-area-inset-left));
}
:host([layout="anchored"]) {
  position: relative;
  inset: auto;
  display: block;
  width: max-content;
  flex: none;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
button, textarea, a { font: inherit; }
button {
  cursor: pointer;
  color: var(--_nyx-label);
  background: var(--_nyx-control);
  border: 1px solid var(--_nyx-line);
  border-radius: var(--_nyx-corner);
  font-family: var(--nyx-control-font, inherit);
  font-size: .92em;
  line-height: 1.25;
  font-weight: 600;
  white-space: nowrap;
}
button:hover:enabled {
  border-color: var(--_nyx-accent);
  background: color-mix(in srgb, var(--_nyx-accent) 13%, var(--_nyx-paper));
}
button:disabled { opacity: .6; cursor: default; }
button:focus-visible, a:focus-visible {
  outline: 2px solid var(--_nyx-accent);
  outline-offset: 1px;
}
.launch {
  display: inline-flex;
  width: max-content;
  align-items: center;
  gap: .55em;
  min-height: max(36px, 2.45em);
  padding: .4em .95em;
  box-shadow: 0 2px 8px #0002;
}
.bubble {
  display: inline-block;
  flex: none;
  width: 1.15em;
  height: .95em;
  border: 1.5px solid currentColor;
  border-radius: .26em .26em .26em 0;
  color: var(--_nyx-accent);
  background: radial-gradient(circle at 32% 50%, currentColor .07em, transparent .1em),
    radial-gradient(circle at 68% 50%, currentColor .07em, transparent .1em);
}
.panel {
  border: 1px solid var(--_nyx-line);
  border-radius: var(--nyx-radius, 12px);
  background: var(--_nyx-paper);
  box-shadow: 0 8px 28px #0003;
  width: min(24rem, var(--nyx-panel-max-width, calc(100vw - 32px)));
  max-height: var(--nyx-panel-max-height, min(30rem, calc(100dvh - 32px)));
  display: flex;
  flex-direction: column;
  overflow: auto;
  overscroll-behavior: contain;
}
:host([layout="anchored"]) .panel {
  position: absolute;
  inset: auto 0 calc(100% + 6px) auto;
}
:host([layout="anchored"][position="left"]) .panel { left: 0; right: auto; }
.identity, .send-icon { display: none; }
.starters {
  flex: 0 1 auto;
  min-height: 0;
  overflow: auto;
  display: flex;
  gap: 6px;
  padding-inline: 12px;
  overscroll-behavior-x: contain;
}
::slotted(button[slot="prompt"]) {
  flex: none;
  max-width: 100%;
  font: inherit;
  cursor: pointer;
  color: var(--_nyx-ink);
  border: 1px solid var(--_nyx-line);
  border-radius: var(--_nyx-corner);
  background: var(--_nyx-control);
  padding: .35em .65em;
  margin-top: 8px;
}
header {
  flex: none;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: .4em;
  padding: 5px 8px 5px 12px;
  border-bottom: 1px solid var(--_nyx-line);
}
h2 {
  font-family: var(--nyx-control-font, inherit);
  font-size: 1em;
  font-weight: 650;
  margin: 0 auto 0 0;
}
.close, .disconnect {
  color: var(--_nyx-muted);
  background: transparent;
}
.close {
  font: 1.35em/1 system-ui;
  border-color: transparent;
  min-width: 30px;
  min-height: 30px;
  padding: 0;
}
.disconnect { font-size: .85em; padding: .25em .62em; min-height: 26px; }
.chat {
  min-height: 0;
  flex: 0 1 auto;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 0 12px;
}
.chat:empty { display: none; }
p { margin: 0 0 .6em; overflow-wrap: anywhere; white-space: pre-wrap; }
.msg { width: fit-content; max-width: 95%; }
.msg:first-child { margin-block-start: .65em; }
.msg:last-child { margin-bottom: .65em; }
.user {
  background: var(--_nyx-control);
  border: 1px solid var(--_nyx-line);
  border-radius: var(--_nyx-corner);
  padding: .35em .65em;
  margin-inline-start: auto;
}
.controls { flex: none; padding: 8px 10px; }
.chat:not(:empty) ~ .controls { border-top: 1px solid var(--_nyx-line); }
.status { font-size: .9em; color: var(--_nyx-muted); }
.status:empty { display: none; }
form {
  display: flex;
  align-items: flex-end;
  gap: .4em;
  border: 1px solid var(--_nyx-line);
  border-radius: var(--_nyx-corner);
  padding: 3px;
}
form:focus-within { border-color: var(--_nyx-accent); }
textarea {
  flex: 1;
  min-width: 0;
  min-height: 32px;
  max-height: 6em;
  height: 2.25em;
  resize: none;
  border: 0;
  outline: 0;
  padding: .45em .5em;
  color: var(--_nyx-ink);
  background: transparent;
}
@supports (field-sizing: content) {
  textarea:not(:placeholder-shown) { field-sizing: content; height: auto; }
}
textarea::placeholder { color: var(--_nyx-muted); opacity: 1; }
.send, .connect, .resume { min-height: 32px; padding: .3em .85em; }
.send, .connect {
  background: var(--nyx-action-surface, var(--_nyx-accent));
  color: var(--nyx-accent-text, white);
}
.send:hover:enabled, .connect:hover:enabled {
  background: var(--nyx-action-surface, var(--_nyx-accent));
  color: var(--nyx-accent-text, white);
}
.resume { margin-top: .5em; }
/* Console surfaces use the host's mark, typography and live palette. */
:host([appearance="console"]) .launch {
  border-radius: 2px;
  padding-inline: .8em 1em;
  border-color: color-mix(in srgb, var(--_nyx-accent) 41%, var(--_nyx-paper));
  background: linear-gradient(108deg, var(--_nyx-control), var(--_nyx-paper));
  box-shadow: inset 2px 0 var(--_nyx-accent), 0 3px 12px #0003;
}
:host([appearance="console"]) .bubble,
:host([appearance="console"]) .identity {
  display: inline-block;
  width: 1.6em;
  height: 1.6em;
  border: 0;
  background: var(--nyx-mark, radial-gradient(circle, var(--_nyx-accent) 25%, transparent 29%)) center / contain no-repeat;
}
:host([appearance="console"]) .panel {
  border-radius: 2px;
  border-block-start: 2px solid var(--_nyx-accent);
  background: var(--nyx-panel-surface, var(--_nyx-paper));
  backdrop-filter: blur(16px);
  clip-path: polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px);
  width: min(28rem, var(--nyx-panel-max-width, calc(100vw - 32px)));
  box-shadow: inset 0 1px color-mix(in srgb, var(--_nyx-accent) 18%, transparent);
}
:host([appearance="console"]) header {
  padding: 5px 7px 5px 12px;
  background: linear-gradient(90deg, var(--_nyx-control), transparent 85%);
}
:host([appearance="console"]) h2 { display: flex; align-items: center; gap: .55em; font-size: 1.02em; }
:host([appearance="console"]) .disconnect { border-color: transparent; font-weight: 500; }
:host([appearance="console"]) .panel[data-connected] .disconnect::before {
  content: ""; display: inline-block; width: .48em; height: .48em; margin-inline-end: .48em;
  border-radius: 50%; background: var(--nyx-connected, var(--_nyx-accent));
}
:host([appearance="console"]) .msg { width: auto; max-width: none; padding: .3em 0 .3em .75em; border-inline-start: 2px solid var(--_nyx-accent); }
:host([appearance="console"]) .user { margin-inline-start: 0; background: transparent; border: 0; border-radius: 0; border-inline-start: 2px solid var(--_nyx-muted); color: var(--_nyx-muted); }
:host([appearance="console"]) form { border: 0; border-radius: 0; background: transparent; padding: 0; }
:host([appearance="console"]) textarea { padding-inline-start: .25em; }
:host([appearance="console"]) form:focus-within { box-shadow: inset 0 -1px var(--_nyx-accent); }
:host([appearance="console"]) .send { align-self: center; padding: 0; width: 30px; min-height: 30px; border-radius: 50%; }
:host([appearance="console"]) .send-label { display: none; }
:host([appearance="console"]) .send-icon { display: inline; font: 600 1.1rem/1 system-ui; }
:host([appearance="console"]) ::slotted(button[slot="prompt"]) { border: 0; border-inline-start: 2px solid var(--_nyx-line); border-radius: 0; font-size: .89em; }
:host([appearance="console"]) ::slotted(button[slot="prompt"]:hover) { color: var(--_nyx-accent); border-color: var(--_nyx-accent); }
a { color: var(--_nyx-accent); display: inline-block; margin: 0 0 .5em; text-decoration: underline; }
`;
