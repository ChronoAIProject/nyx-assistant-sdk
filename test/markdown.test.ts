import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("", { url: "https://host.example/view" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document });
const { renderAssistantMarkdown } = await import("../src/markdown.ts");

test("renders GFM structure, code indentation, table cells and the final paragraph", () => {
  const source = ["## 标题", "", "> 引用", "", "3. **开始**", "   - 子项", "", "- [x] ~~已完成~~", "",
    "```js", "  const x = '<tag>';", "```", "", "| A | B |", "|---|---|", "| 甲 | 乙 |", "", "末段"].join("\n");
  const message = renderAssistantMarkdown(source);
  for (const selector of ["h2", "blockquote", "ol[start='3'] strong", "ol ul li", "input:checked:disabled", "del", ".table-scroll table tbody td"]) {
    assert.ok(message.querySelector(selector), selector);
  }
  assert.equal(message.querySelector("pre code")?.textContent, "  const x = '<tag>';\n");
  assert.equal(message.lastElementChild?.textContent, "末段");
});

test("keeps HTML literal, restricts destinations and exposes images as links without loading media", () => {
  const message = renderAssistantMarkdown('<b>literal</b> [未知](custom:123) [文档](/docs) ![示意图](/diagram.png)');
  assert.ok(message.textContent.includes("<b>literal</b>"));
  assert.equal(message.querySelector("b,img"), null);
  assert.equal(message.querySelectorAll("a").length, 2);
  assert.equal(message.querySelector("a")?.href, "https://host.example/docs");
  assert.match(message.querySelector("a")?.rel ?? "", /noopener/);
  const imageLink = message.querySelectorAll("a")[1];
  assert.equal(imageLink.href, "https://host.example/diagram.png");
  assert.equal(imageLink.textContent, "示意图");
});

test("parses bold beside Chinese punctuation and keeps code literal", () => {
  const literal = "请看**「观测指南」**和表格。";
  const msg = renderAssistantMarkdown(literal + "\n\n`" + literal + "`");
  assert.equal(msg.querySelector("strong")?.textContent, "「观测指南」");
  assert.equal(msg.querySelector("code")?.textContent, literal);
});
