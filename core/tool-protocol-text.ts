/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
export const TOOL_TEXT_NOTICE = "［此处是模型写出的工具调用标记，标记本身未执行任何工具。］";
export const TOOL_TEXT_ROOT_PREFIXES = ["<｜｜DSML｜｜", "<｜DSML｜", "<||DSML||", "<|DSML|"] as const;

// Sticky matches start at the cursor. Unknown children or attributes invalidate the entire block.
const tagPattern = /[ \t\r\n]*<(\/?)(｜{1,2}|\|{1,2})DSML\2 ?(tool_calls|toolcalls|calls|invoke|parameter)(?: name="([^\s"<>]+)")?(?: string="(true|false)")?>/y;
function tagAt(text: string, start: number, bars?: string) {
  tagPattern.lastIndex = start;
  const match = tagPattern.exec(text);
  if (!match || (bars && match[2] !== bars)) return;
  const [, slash, delimiter, kind, name, string] = match;
  if ((slash || (kind !== "invoke" && kind !== "parameter")) && (name || string)) return;
  if (kind === "invoke" && string) return;
  return { closing: !!slash, bars: delimiter, kind, name, at: start + match[0].indexOf("<"), end: tagPattern.lastIndex };
}

const nextProtocol = /[ \t\r\n]*<\/?[｜|]+DSML/iy;
const blankLine = /(?:\r\n|\r(?!\n)|\n)[ \t]*(?:\r\n|\r(?!\n)|\n)/;

function blockEnd(text: string, start: number, names: ReadonlySet<string> | undefined, wrappedOnly: boolean) {
  const root = tagAt(text, start);
  if (!root || root.closing || root.kind === "parameter") return;
  if (wrappedOnly && root.kind !== "tool_calls" && root.kind !== "calls") return;
  const bare = root.kind === "invoke";
  let tag = bare ? root : tagAt(text, root.end, root.bars);
  let invokeEnd: number | undefined;
  while (tag && !tag.closing && tag.kind === "invoke") {
    if (!tag.name || !/^[A-Za-z0-9_-]{1,64}$/.test(tag.name) || (names && !names.has(tag.name))) return;
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
    invokeEnd = tag.end;
    tag = tagAt(text, tag.end, root.bars);
    if (bare && tag && blankLine.test(text.slice(invokeEnd, tag.at))) {
      // A blank line ends a standalone run. The next paragraph may be an indented example.
      return invokeEnd;
    }
  }
  if (invokeEnd === undefined) return;
  if (tag?.closing && (tag.kind === (bare ? "tool_calls" : root.kind) ||
      (root.kind === "toolcalls" && tag.kind === "tool_calls"))) return tag.end;
  if (!bare) return;
  // A further DSML child or unmatched terminator makes an unwrapped run ambiguous.
  nextProtocol.lastIndex = invokeEnd;
  if (!nextProtocol.test(text) || (tag && !tag.closing && tag.kind !== "parameter")) return invokeEnd;
}

type Backticks = { at: number; next: number; escaped: boolean };
const exampleLead = /(?:示例|样例|例子|举例|例如|比如|语法)(?:如下|所示)?[：:，,。.]?$|(?:格式|写法)如下[：:，,。.]?$|\b(?:for example|for instance|example|sample|syntax)(?: below| follows)?[：:,.-]?$/i;

// Resolve inline code within each Markdown paragraph. Linking equal-length backtick runs
// avoids rescanning the rest of the answer for every unmatched opening delimiter.
function candidateStarts(text: string, barriers?: number[]) {
  const starts: number[] = [], paragraph: number[] = [], ticks: Backticks[] = [];
  const previous = new Map<number, number>();
  let fence = "", quoted = false, list = false, inParagraph = false, example = false;
  function endParagraph() {
    let index = 0;
    for (let i = 0; i < ticks.length && (barriers || index < paragraph.length); i++) {
      const open = ticks[i];
      if (open.escaped || open.next < 0) continue;
      barriers?.push(open.at, ticks[open.next].at);
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
    const end = start + match[0].length;
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      barriers?.push(start, end);
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length &&
          /^[ \t]*$/.test(line.slice(marker[0].length))) fence = "";
      continue;
    }
    if (/^[ \t]*$/.test(line)) { endParagraph(); quoted = false; continue; }
    if (/^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]/.test(line)) {
      endParagraph(); barriers?.push(start, end); list = true; example = exampleLead.test(line.trimEnd().slice(-100)); continue;
    }
    if (list && /^[ \t]/.test(line)) { barriers?.push(start, end); continue; }
    list = false;
    if (/^ {0,3}>/.test(line)) { endParagraph(); barriers?.push(start, end); quoted = true; continue; }
    if (marker && (marker[1][0] === "~" || !line.slice(marker[0].length).includes("`"))) {
      endParagraph(); barriers?.push(start, end); quoted = false; example = false; fence = marker[1]; continue;
    }
    if (quoted || (!inParagraph && /^(?: {4}| {0,3}\t)/.test(line))) { barriers?.push(start, end); continue; }
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

// Classify boundaries even for malformed tags and Markdown-protected starts. Only the
// strict parser above can accept a block. An inner invoke of a rejected block must
// never be retried as if its outer opener had been missing.
function independentStarts(text: string, candidates: number[], barriers: number[]) {
  type Opening = { start: number; close: number; continuation: boolean };
  const openings: Opening[] = [];
  const roots: Opening[] = [], invokes: Opening[] = [], parameters: Opening[] = [], unknown: Opening[] = [];
  const looseTag = /<(\/?)(?:[｜|]+DSML[｜|]*[ \t]*([\w-]*)[^<>\r\n]*>?|(pre|code)\b[^<>]*>)/gi;
  let previousEnd = 0, afterRootClose = true, barrier = 0, html = "";
  for (const match of text.matchAll(looseTag)) {
    while (barrier < barriers.length && match.index >= barriers[barrier + 1]) {
      roots.length = invokes.length = parameters.length = unknown.length = 0;
      afterRootClose = true;
      barrier += 2;
    }
    if (barrier < barriers.length && match.index >= barriers[barrier]) continue;
    if (match[3]) {
      const kind = match[3].toLowerCase();
      if (!html && !match[1]) html = kind;
      else if (html === kind && match[1]) html = "";
      continue;
    }
    if (html) continue;
    const kind = match[2].toLowerCase();
    const stack = kind === "invoke" ? invokes : kind === "parameter" ? parameters :
      kind === "tool_calls" || kind === "toolcalls" || kind === "calls" ? roots : unknown;
    if (match[1]) {
      const open = stack.pop() ?? (stack === roots ? unknown.pop() : undefined);
      if (open) {
        open.close = match.index;
        if (stack === roots) {
          for (const children of [invokes, parameters, unknown]) {
            while (children.length && children[children.length - 1].start > open.start) children.pop();
          }
        }
      }
    } else {
      const gap = text.slice(previousEnd, match.index);
      const inside = roots.length || invokes.length || parameters.length || unknown.length;
      const continuation = stack === invokes && !/[^ \t\r\n]/.test(gap) &&
        (!!inside || (!afterRootClose && !blankLine.test(gap)));
      const open = { start: match.index, close: 0, continuation };
      openings.push(open);
      stack.push(open);
    }
    afterRootClose = !!match[1] && stack === roots;
    previousEnd = match.index + match[0].length;
  }
  let candidate = 0, enclosedUntil = 0;
  const independent: number[] = [];
  for (const open of openings) {
    while (candidate < candidates.length && candidates[candidate] < open.start) candidate++;
    if (candidates[candidate] === open.start && open.start >= enclosedUntil && !open.continuation) {
      independent.push(open.start);
    }
    enclosedUntil = Math.max(enclosedUntil, open.close);
  }
  return independent;
}

function project(text: string, names: ReadonlySet<string> | undefined, wrappedOnly: boolean): string {
  if (names?.size === 0 || !TOOL_TEXT_ROOT_PREFIXES.some(prefix => text.includes(prefix))) return text;
  const parts: string[] = [];
  let copied = 0;
  const barriers = wrappedOnly ? undefined : [];
  const candidates = candidateStarts(text, barriers);
  if (!candidates.length) return text;
  for (const start of barriers ? independentStarts(text, candidates, barriers) : candidates) {
    if (start < copied) continue;
    const end = blockEnd(text, start, names, wrappedOnly);
    if (end === undefined) continue;
    parts.push(text.slice(copied, start), TOOL_TEXT_NOTICE);
    copied = end;
  }
  return parts.length ? parts.join("") + text.slice(copied) : text;
}

/** Online callers pass the tools offered in this response. Historical review can lack that snapshot. */
export function projectToolProtocolText(text: string, names?: ReadonlySet<string>): string {
  return project(text, names, false);
}

/** Reproduce the exact projection approved by historical wrapper-only confirmations. */
export function projectWrappedToolProtocolText(text: string): string {
  return project(text, undefined, true);
}
