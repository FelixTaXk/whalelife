import assert from "node:assert/strict";
import { test } from "node:test";
import { projectToolProtocolText, TOOL_TEXT_NOTICE } from "../core/tool-protocol-text.ts";

const names = new Set(["hands_write", "read_archive"]);
const marker = "｜｜DSML｜｜";
const block = [
  `<${marker} calls>`,
  `<${marker} invoke name="hands_write">`,
  `<${marker} parameter name="path" string="true">tmp/a.md</${marker} parameter>`,
  `</${marker} invoke>`,
  `</${marker} calls>`,
].join("\n");
const emptyInvoke = `<${marker}invoke name="read_archive"></${marker}invoke>`;
const compact = `<${marker}tool_calls>${emptyInvoke}</${marker}tool_calls>`;
const orphan = [
  `<${marker}invoke name="hands_write">`,
  `<${marker}parameter name="path" string="true">tmp/a.md</${marker}parameter>`,
  `<${marker}parameter name="text" string="true">第一行\n第二行</${marker}parameter>`,
  `</${marker}invoke>`,
].join("\n");
const rootClose = `</${marker}tool_calls>`;
const typoOpen = `<${marker}toolcalls>`;
const typoClose = `</${marker}toolcalls>`;

test("both observed block spellings are replaced in place with adjacent bytes preserved", () => {
  const windows = block.replaceAll("\n", "\r\n");
  const before = "\t正文 <p> 保留</p>\r\n  ", between = "同一行的后文🙂\r", after = "\n\n尾注  ";
  assert.equal(projectToolProtocolText(before + windows + between + compact + after, names),
    before + TOOL_TEXT_NOTICE + between + TOOL_TEXT_NOTICE + after);
});

test("all invokes and each parameter must close with the same delimiter", () => {
  const two = block.replace(`</${marker} invoke>`, `<${marker} parameter name="count" string="false">0</${marker} parameter>
</${marker} invoke>${emptyInvoke}`);
  for (const bars of ["｜", "||", "｜｜", "|"]) {
    assert.equal(projectToolProtocolText(two.replaceAll(marker, bars + "DSML" + bars), names), TOOL_TEXT_NOTICE);
  }
  assert.equal(projectToolProtocolText(two, new Set(["hands_write"])), two);
});

test("unknown, partial or malformed markup survives verbatim", () => {
  const inputs = [
    "", "DSML calls", block.replaceAll("<", "").replaceAll(">", ""), block.slice(0, -1),
    "工具示例 " + compact, "\\" + compact,
    compact.replace(emptyInvoke, ""), compact.replace("read_archive", "other"),
    block.replace(`</${marker} parameter>`, ""), block.replace(`</${marker} invoke>`, ""),
    block.replace(`</${marker} calls>`, `</${marker}tool_calls>`),
    block.replace(' name="hands_write"', ""), block.replace(' name="path"', ""),
    block.replace(' string="true"', ' string="sometimes"'), block.replace("tmp/a.md", "<b>extra</b>"),
    block.replace("path", "path\" stray=\"yes"), block.replace(marker, "｜DSML||"),
    block.replace(`</${marker} parameter>`, "</|DSML| parameter>"),
    block.replace(`</${marker} calls>`, `ordinary text</${marker} calls>`),
    compact.replace("invoke", "invoke_more"), compact.replace("DSML", "dsml"),
  ];
  for (const input of inputs) assert.equal(projectToolProtocolText(input, names), input);
});

test("omitting historical tool definitions still requires a valid tool name and full structure", () => {
  const historical = compact.replace("read_archive", "uninstalled_0");
  assert.equal(projectToolProtocolText(historical), TOOL_TEXT_NOTICE);
  assert.equal(projectToolProtocolText(historical, new Set()), historical);
  for (const bad of ["", "x y", "x.js()", "a".repeat(65)]) {
    const input = historical.replace("uninstalled_0", bad);
    assert.equal(projectToolProtocolText(input), input);
  }
});

test("fences, inline and multiline code, indented code, and quotes remain readable", () => {
  const excerpts = [
    ["````xml", block, "```", compact, "````"].join("\n"),
    ["  ~~~", block, "  ~~~~  "].join("\n"),
    ["引述双反引号 `` 内容", "`", block, "`` 结束"].join("\n"),
    ["参见 `", compact + "`"].join("\n"),
    ["> " + compact, compact].join("\n"), block.split("\n").map(l => "    " + l).join("\n"),
    block.split("\n").map(l => "\t" + l).join("\n"), ["```", block].join("\n"),
    ["- ```xml", "  " + compact, "  ```"].join("\n"),
    ["1. 示例", "   > 引用", "   " + compact].join("\n"),
  ];
  for (const input of excerpts) assert.equal(projectToolProtocolText(input, names), input);
  const closed = excerpts[0] + "\n", unmatched = "普通正文有一个未配对的 `\n";
  assert.equal(projectToolProtocolText(closed + compact, names), closed + TOOL_TEXT_NOTICE);
  assert.equal(projectToolProtocolText(unmatched + compact, names), unmatched + TOOL_TEXT_NOTICE);
});

test("an explicit literal example introduction protects an unfenced sample", () => {
  for (const lead of ["下面给出一个示例：", "语法如下：", "例如，", "For example,", "Example:", "Here is the syntax:"]) {
    const excerpt = lead + "\n\n" + block + "\n\n接下来调用工具。\n";
    assert.equal(projectToolProtocolText(excerpt + compact, names), excerpt + TOOL_TEXT_NOTICE);
  }
});

test("orphan invokes and the observed toolcalls spelling preserve surrounding prose in place", () => {
  const variants = [
    emptyInvoke, orphan, orphan + "\n" + rootClose,
    [typoOpen, orphan, emptyInvoke, rootClose].join("\n"),
    [typoOpen, orphan, emptyInvoke, typoClose].join("\n"),
  ];
  const before = "回复开头🙂\r\n  ";
  for (const variant of variants) {
    for (const after of ["同一行继续\t\r\n\r\n尾注  ", "\r\n\t保留缩进的尾注  "]) {
      const input = before + variant.replaceAll("\n", "\r\n") + after;
      assert.equal(projectToolProtocolText(input, names), before + TOOL_TEXT_NOTICE + after);
    }
  }
});

test("orphan and misspelled-root calls use offered names online and valid names in historical previews", () => {
  for (const variant of [orphan, orphan + "\n" + rootClose, [typoOpen, orphan, rootClose].join("\n")]) {
    const historical = variant.replace("hands_write", "old_tool-2");
    assert.equal(projectToolProtocolText(historical), TOOL_TEXT_NOTICE);
    assert.equal(projectToolProtocolText(historical, names), historical);
    assert.equal(projectToolProtocolText(variant, new Set()), variant);
    for (const invalid of ["", "bad/name", "x".repeat(65)]) {
      const input = variant.replace("hands_write", invalid);
      assert.equal(projectToolProtocolText(input), input);
    }
  }
});

test("unsupported endings, incomplete invokes and rejected outer blocks survive as a whole", () => {
  const callsClose = `</${marker}calls>`;
  const unknown = orphan.replace("hands_write", "other");
  const malformed = orphan.replace(`</${marker}parameter>`, `</${marker}param>`);
  const rejected = [
    orphan + "\n" + callsClose, orphan + "\n" + typoClose,
    orphan + "\n" + rootClose.replaceAll(marker, "|DSML|"),
    malformed, orphan.replace(`</${marker}invoke>`, ""),
    orphan.replace(' name="hands_write"', ' name="hands_write" extra="yes"'),
    [typoOpen, emptyInvoke, unknown, rootClose].join("\n"),
    [typoOpen, malformed, emptyInvoke, rootClose].join("\n"),
    [typoOpen, emptyInvoke, callsClose].join("\n"),
    [`<${marker}tool_calls>`, emptyInvoke, typoClose].join("\n"),
    [`<${marker}tool_call>`, emptyInvoke, rootClose].join("\n"),
    [typoOpen, emptyInvoke].join("\n"),
    [typoOpen, emptyInvoke, rootClose.replaceAll(marker, "|DSML|")].join("\n"),
  ];
  const tail = "\r\n\r\n正常正文继续。\r\n";
  for (const text of rejected) {
    assert.equal(projectToolProtocolText(text + tail + compact, names), text + tail + TOOL_TEXT_NOTICE);
  }
});

test("new variants remain literal inside Markdown code and quotation contexts", () => {
  for (const variant of [orphan, orphan + "\n" + rootClose, [typoOpen, emptyInvoke, rootClose].join("\n")]) {
    const excerpts = [
      ["```xml", variant, "```"].join("\n"),
      ["~~~", variant, "~~~"].join("\n"),
      ["<pre><code>", variant, "</code></pre>"].join("\n"),
      ["语法写作 ``", variant, "``。"].join("\n"),
      "> 引用中的下一行\n" + variant,
      variant.split("\n").map(line => "    " + line).join("\n"),
      ["- ```xml", ...variant.split("\n").map(line => "  " + line), "  ```"].join("\n"),
      "正文提及 " + variant,
    ];
    for (const excerpt of excerpts) {
      const prefix = excerpt + "\n\n结束引述。\n";
      assert.equal(projectToolProtocolText(prefix + variant, names), prefix + TOOL_TEXT_NOTICE);
    }
  }
  for (const code of [emptyInvoke, rootClose]) {
    const suffix = "\n\n    " + code;
    assert.equal(projectToolProtocolText(orphan + suffix, names), TOOL_TEXT_NOTICE + suffix);
  }
  const fencedOpening = ["```xml", `<${marker}tool_calls>`, "```", "继续处理。", ""].join("\n");
  assert.equal(projectToolProtocolText(fencedOpening + orphan + "\n" + rootClose, names),
    fencedOpening + TOOL_TEXT_NOTICE);
});

test("all invokes in an explicitly introduced unfenced example remain literal", () => {
  for (const example of [
    [emptyInvoke, emptyInvoke].join("\n"),
    [orphan, emptyInvoke, rootClose].join("\n"),
    [typoOpen, orphan, emptyInvoke, rootClose].join("\n"),
  ]) {
    const prefix = "For example,\n\n" + example + "\n\n接下来调用工具。\n";
    assert.equal(projectToolProtocolText(prefix + orphan, names), prefix + TOOL_TEXT_NOTICE);
  }
});

test("malformed repeated roots, unterminated parameters and long fence runs keep later prose", () => {
  const unfinished = block.slice(0, block.indexOf("tmp/a.md")) + "x".repeat(128) + "\n";
  const text = unfinished.repeat(5000) + "`".repeat(20000) + "\u2028x\n";
  assert.equal(projectToolProtocolText(text, names), text);
  const broken = `<${marker}calls>\n`.repeat(10000);
  assert.equal(projectToolProtocolText(broken + compact, names), broken + TOOL_TEXT_NOTICE);
});
