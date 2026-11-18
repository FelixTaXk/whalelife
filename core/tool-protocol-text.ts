/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
export const TOOL_TEXT_NOTICE = "［此处是模型写出的工具调用标记，标记本身未执行任何工具。］";
export const TOOL_TEXT_ROOT_PREFIXES = ["<｜｜DSML｜｜", "<｜DSML｜", "<||DSML||", "<|DSML|"] as const;

// Sticky matches start at the cursor. Unknown children or attributes invalidate the entire block.
const tagPattern = /[ \t\r\n]*<(\/?)(｜{1,2}|\|{1,2})DSML\2 ?(tool_calls|calls|invoke|parameter)(?: name="([^\s"<>]+)")?(?: string="(true|false)")?>/y;
function tagAt(text: string, start: number, bars?: string) {
  tagPattern.lastIndex = start;
  const match = tagPattern.exec(text);
  if (!match || (bars && match[2] !== bars)) return;
  const [, slash, delimiter, kind, name, string] = match;
  if ((slash || kind === "calls" || kind === "tool_calls") && (name || string)) return;
  if (kind === "invoke" && string) return;
  return { closing: !!slash, bars: delimiter, kind, name, end: tagPattern.lastIndex };
}

function blockEnd(text: string, start: number, names?: ReadonlySet<string>) {
  const root = tagAt(text, start);
  if (!root || root.closing || (root.kind !== "tool_calls" && root.kind !== "calls")) return;
  let tag = tagAt(text, root.end, root.bars);
  let invokes = 0;
  while (tag && !tag.closing && tag.kind === "invoke") {
    if (!tag.name || !/^[A-Za-z0-9_-]{1,64}$/.test(tag.name) || (names && !names.has(tag.name))) return;
    invokes++;
    tag = tagAt(text, tag.end, root.bars);
    while (tag && !tag.closing && tag.kind === "parameter") {
      if (!tag.name) return;
      // Values are opaque text. Never search past another tag for a missing terminator.
      const next = text.indexOf("<", tag.end);
      if (next < 0) return;
      tag = tagAt(text, next, root.bars);
      if (!tag?.closing || tag.kind !== "parameter") return;
      tag = tagAt(text, tag.end, root.bars);
    }
    if (!tag?.closing || tag.kind !== "invoke") return;
    tag = tagAt(text, tag.end, root.bars);
  }
  if (invokes && tag?.closing && tag.kind === root.kind) return tag.end;
}

type Backticks = { at: number; next: number; escaped: boolean };
const exampleLead = /(?:示例|样例|例子|举例|例如|比如|语法)(?:如下|所示)?[：:，,。.]?$|(?:格式|写法)如下[：:，,。.]?$|\b(?:for example|for instance|example|sample|syntax)(?: below| follows)?[：:,.-]?$/i;

// Resolve inline code within each Markdown paragraph. Linking equal-length backtick runs
// avoids rescanning the rest of the answer for every unmatched opening delimiter.
function candidateStarts(text: string) {
  const starts: number[] = [], paragraph: number[] = [], ticks: Backticks[] = [];
  const previous = new Map<number, number>();
  let fence = "", quoted = false, list = false, inParagraph = false, example = false;
  function endParagraph() {
    let index = 0;
    for (let i = 0; i < ticks.length && index < paragraph.length; i++) {
      const open = ticks[i];
      if (open.escaped || open.next < 0) continue;
      while (index < paragraph.length && paragraph[index] < open.at) starts.push(paragraph[index++]);
      while (index < paragraph.length && paragraph[index] < ticks[open.next].at) index++;
      i = open.next;
    }
    while (index < paragraph.length) starts.push(paragraph[index++]);
    paragraph.length = ticks.length = 0;
    previous.clear();
    inParagraph = false;
  }
  for (const match of text.matchAll(/([^\r\n]*)(?:\r\n?|\n|$)/g)) {
    const line = match[1], start = match.index;
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length &&
          /^[ \t]*$/.test(line.slice(marker[0].length))) fence = "";
      continue;
    }
    if (/^[ \t]*$/.test(line)) { endParagraph(); quoted = false; continue; }
    if (/^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]/.test(line)) {
      endParagraph(); list = true; example = exampleLead.test(line.trimEnd().slice(-100)); continue;
    }
    if (list && /^[ \t]/.test(line)) continue; // Includes fences and quotes nested under a list item.
    list = false;
    if (/^ {0,3}>/.test(line)) { endParagraph(); quoted = true; continue; }
    if (marker && (marker[1][0] === "~" || !line.slice(marker[0].length).includes("`"))) {
      endParagraph(); quoted = false; example = false; fence = marker[1]; continue;
    }
    if (quoted) continue; // A Markdown block quote may continue without a second >.
    if (!inParagraph && /^(?: {4}| {0,3}\t)/.test(line)) continue;
    inParagraph = true;
    const prefix = /^ {0,3}(?=<[｜|])/.exec(line);
    if (prefix && !example) paragraph.push(start + prefix[0].length);
    example = exampleLead.test(line.trimEnd().slice(-100));
    for (const run of line.matchAll(/`+/g)) {
      let slash = run.index;
      while (slash > 0 && line[slash - 1] === "\\") slash--;
      const length = run[0].length, last = previous.get(length);
      if (last !== undefined) ticks[last].next = ticks.length;
      previous.set(length, ticks.length);
      ticks.push({ at: start + run.index, next: -1, escaped: (run.index - slash) % 2 === 1 });
    }
  }
  endParagraph();
  return starts;
}

/** Online callers pass the tools offered in this response. Historical review can lack that snapshot. */
export function projectToolProtocolText(text: string, names?: ReadonlySet<string>): string {
  if (names?.size === 0 || !TOOL_TEXT_ROOT_PREFIXES.some(prefix => text.includes(prefix))) return text;
  const parts: string[] = [];
  let copied = 0;
  for (const start of candidateStarts(text)) {
    if (start < copied) continue;
    const end = blockEnd(text, start, names);
    if (end === undefined) continue;
    parts.push(text.slice(copied, start), TOOL_TEXT_NOTICE);
    copied = end;
  }
  return parts.length ? parts.join("") + text.slice(copied) : text;
}
