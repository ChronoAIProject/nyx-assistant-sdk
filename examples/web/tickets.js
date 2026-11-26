const issues = [
  { name: "核对发票", state: "open" },
  { name: "整理清单", state: "closed" },
  { name: "更新地址", state: "open" },
];

export function mountTickets() {
  const filter = document.getElementById("filter");
  const rows = document.getElementById("rows");
  const count = document.getElementById("count");
  const readOnly = document.getElementById("readonly");

  function render() {
    rows.replaceChildren();
    for (const item of issues) {
      if (filter.value !== "all" && item.state !== filter.value) continue;
      const row = rows.insertRow();
      row.insertCell().textContent = item.name;
      const status = row.insertCell();
      status.dataset.state = item.state;
      status.textContent = item.state === "open" ? "待处理" : "已关闭";
    }
    count.textContent = `${rows.rows.length} 条`;
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
            return { ok: false, code: "read_only", message: "此页面为只读模式。" };
          filter.value = input.filter;
          render();
          return { ok: true, value: state() };
        },
      });
    },
  };
}
