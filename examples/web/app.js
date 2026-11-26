import { mountTickets } from "./tickets.js";
import { locales } from "./locales.mjs";

const tickets = mountTickets(locales[document.documentElement.dataset.locale].tickets);
document.addEventListener("nyx-ready", ({ detail: { host, z } }) => {
  tickets.registerTools(host, z);
});
