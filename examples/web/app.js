import { mountTickets } from "./tickets.js";

const tickets = mountTickets();
document.addEventListener("nyx-ready", ({ detail: { host, z } }) => {
  tickets.registerTools(host, z);
});
