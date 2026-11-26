const issues = [
  { id: "invoice", state: "open" },
  { id: "list", state: "closed" },
  { id: "address", state: "open" },
];

export const chineseTickets = {
  names: { invoice: "核对发票", list: "整理清单", address: "更新地址" },
  states: { all: "全部", open: "待处理", closed: "已关闭" },
  count: count => `${count} 条`,
  readOnly: "此页面为只读模式。",
};

export function mountTickets(copy = chineseTickets) {
  const filter = document.getElementById("filter");
  const rows = document.getElementById("rows");
  const count = document.getElementById("count");
  const readOnly = document.getElementById("readonly");

  function render() {
    rows.replaceChildren();
    for (const item of issues) {
      if (filter.value !== "all" && item.state !== filter.value) continue;
      const row = rows.insertRow();
      row.insertCell().textContent = copy.names[item.id];
      const status = row.insertCell();
      status.dataset.state = item.state;
      status.textContent = copy.states[item.state];
    }
    count.textContent = copy.count(rows.rows.length);
  }

  filter.addEventListener("change", render);
  render();
  const state = () => ({ filter: filter.value, visibleRows: rows.rows.length });

  return {
    state,
    registerTools(host, z) {
      host.registerTool({
        name: "read_filter",
        description: "Read the current filter and displayed row count.",
        parameters: z.object({}),
        execute: () => ({ ok: true, value: state() }),
      });
      host.registerTool({
        name: "set_filter",
        description: "Set the ticket filter and report the displayed row count.",
        parameters: z.object({ filter: z.enum(["all", "open", "closed"]) }),
        execute(input) {
          if (readOnly.checked)
            return { ok: false, code: "read_only", message: copy.readOnly };
          filter.value = input.filter;
          render();
          return { ok: true, value: state() };
        },
      });
    },
  };
}
