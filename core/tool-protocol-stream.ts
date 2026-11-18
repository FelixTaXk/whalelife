/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { projectToolProtocolText, TOOL_TEXT_ROOT_PREFIXES } from "./tool-protocol-text.ts";

// A request for literal output can legitimately produce a bare protocol example.
export function requestsProtocolExample(input: string) {
  if (!/DSML|工具调用|工具协议|tool[ _-]?calls?/iu.test(input)) return false;
  return input.split(/[。！？!?\n]/u).some(sentence =>
    /DSML|工具调用|工具协议|tool[ _-]?calls?/iu.test(sentence) &&
    /示例|样例|举例|演示|原样|逐字|语法|格式|example|verbatim|syntax|literal/iu.test(sentence) &&
    !/(?:不要|别再?|不用|禁止|do not|don't)\s*(?:再|给我)?\s*(?:输出|发|展示|给|贴|show|print)/iu.test(sentence));
}

/** Only delay a possible marker and what follows it. The structured tool list
 * can arrive in the last SSE frame, so classify once the provider has finished. */
export class ToolProtocolStream {
  private partial = "";
  private held?: string[];
  private sent = 0;
  private send: (text: string) => void;

  constructor(send: (text: string) => void) { this.send = send; }

  push = (chunk: string) => {
    if (this.held) { this.held.push(chunk); return; }
    const data = this.partial + chunk;
    this.partial = "";
    let start = data.length;
    for (const prefix of TOOL_TEXT_ROOT_PREFIXES) {
      const pos = data.indexOf(prefix);
      if (pos !== -1) start = Math.min(start, pos);
    }
    if (start < data.length) {
      this.held = [data.slice(start)];
    } else {
      const last = data.lastIndexOf("<");
      if (last >= 0 && TOOL_TEXT_ROOT_PREFIXES.some(p => p.startsWith(data.slice(last)))) {
        start = last;
        this.partial = data.slice(last);
      }
    }
    if (start) {
      this.sent += start;
      this.send(data.slice(0, start));
    }
  };

  finish(text: string, names: ReadonlySet<string>) {
    const projected = projectToolProtocolText(text, names);
    const pending = this.held?.join("") ?? this.partial;
    this.held = undefined;
    this.partial = "";
    if (pending) {
      const tail = text.slice(this.sent) === pending ? projected.slice(this.sent) : pending;
      if (tail) this.send(tail);
    }
    return projected;
  }

  flushUnclassified() {
    const pending = this.held?.join("") ?? this.partial;
    this.held = undefined;
    this.partial = "";
    if (pending) this.send(pending);
  }

  interrupted() {
    // With a truncated SSE response there is no final tool-call metadata.
    // Only a short undecided prefix (e.g. a trailing '<') is safe to flush.
    if (!this.held) this.flushUnclassified();
  }
}
