/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import type { Writable } from "node:stream";

type OutputState = { disabled: boolean; blocked: boolean };
// Shared even by independently imported copies; never attach per-Logger handlers.
const key = Symbol.for("whalelife.log-output.v1");
const shared = globalThis as typeof globalThis & { [key]?: WeakMap<Writable, OutputState> };
const outputs = (shared[key] ??= new WeakMap());

function stateFor(stream: Writable): OutputState {
  let state = outputs.get(stream);
  if (!state) {
    state = { disabled: false, blocked: false };
    outputs.set(stream, state);
    const current = state;
    // Stream errors only: real application exceptions retain their lifecycle.
    stream.on("error", () => { current.disabled = true; });
    stream.on("close", () => { current.disabled = true; });
    stream.on("drain", () => { current.blocked = false; });
  }
  return state;
}

export function installLogOutputGuards() {
  stateFor(process.stdout);
  stateFor(process.stderr);
}

/** Best effort only; false means the sink rejected or skipped this line. */
export function writeLogOutput(line: string, destination: "stdout" | "stderr" = "stdout") {
  const stream = process[destination];
  const state = stateFor(stream);
  if (state.disabled || state.blocked || stream.destroyed || !stream.writable) return false;
  try {
    // Respect backpressure instead of growing an unbounded in-memory queue.
    state.blocked = !stream.write(line + "\n", (error) => {
      if (error) state.disabled = true;
    });
    return true;
  } catch {
    state.disabled = true;
    return false;
  }
}
