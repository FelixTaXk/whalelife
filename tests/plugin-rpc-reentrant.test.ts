/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import { setImmediate as tick } from "node:timers/promises";
import { PluginRPC } from "../core/plugin-rpc.ts";

type Packet = Record<string, any>;
type Outcome = { state: "resolved"; value: any } | { state: "rejected"; error: any } | { state: "pending" };
const scalar = (value: unknown): Packet => ({ kind: "scalar", value });
const promise = (id = "host:result"): Packet => ({ kind: "promise", side: "host", id });
const reply = (id: string, value: Packet, ok = true): Packet => ({ type: "reply", id, sync: true, ok, value });
const settled = (id: string, value: Packet, ok = true): Packet => ({ type: "settled", id, ok, value });
const callbackRequest = (target = "callback"): Packet => ({
  type: "request", id: `host:call:${target}`, operation: "apply", target,
  args: { kind: "array", entries: [], length: 0 },
});

function fixture(t: TestContext, timeout = 1000, closeOnFault = false) {
  const { port1, port2 } = new MessageChannel();
  const sent: Packet[] = [], faults: Error[] = [];
  let peer: PluginRPC | undefined;
  t.after(() => { peer?.close(); port1.close(); port2.close(); });
  // RPC deadlines are intentionally unref'ed; keep only these owned ports live
  // until the timeout assertions and their registered cleanup have completed.
  port1.ref(); port2.ref();
  peer = new PluginRPC({
    side: "plugin", port: port2, wake: new Int32Array(new SharedArrayBuffer(4)), timeout,
    transport: { send(packet) { sent.push(packet); } },
    onFault(error) { faults.push(error); if (closeOnFault) peer?.close(error); },
  });
  // Inspect only this owned transport instance; no host, plugin process or model is started.
  const rpc = peer as any;
  const post = (packet: Packet) => port1.postMessage(packet);
  const drain = () => { for (let next; (next = receiveMessageOnPort(port2));) peer!.receive(next.message); };
  return { peer, rpc, sent, faults, post, drain, nested: undefined as unknown };
}
type Fixture = ReturnType<typeof fixture>;

function round(f: Fixture, value: Packet, settlements: Packet[] = [], reentrant = true, ok = true) {
  const outerId = `plugin:sync:${f.rpc.sequence + 1}`;
  const nestedId = `plugin:sync:${f.rpc.sequence + 2}`;
  if (reentrant) {
    f.peer.bind("callback", () => {
      f.nested = f.rpc.sync("get", "host:nested", { key: "value" });
      return f.nested;
    });
    f.post(callbackRequest());
  }
  // FIFO is preserved: the outer reply always precedes its settlements.
  f.post(reply(outerId, value, ok));
  for (const packet of settlements) f.post(packet);
  if (reentrant) f.post(reply(nestedId, scalar(7)));
  return f.rpc.sync("get", "host:outer", { key: "value" });
}

async function outcome(value: any): Promise<Outcome> {
  // Every queued packet is consumed synchronously before this check. A turn of
  // the event loop bounds a regression failure without waiting for an RPC timeout.
  return Promise.race([
    Promise.resolve(value).then<Outcome, Outcome>(
      value => ({ state: "resolved", value }), error => ({ state: "rejected", error }),
    ),
    tick().then<Outcome>(() => ({ state: "pending" })),
  ]);
}
function assertNoWaiting(f: Fixture) {
  assert.equal(f.rpc.pending.size, 0);
  assert.equal(f.rpc.syncResults.size, 0);
}

test("FIFO success survives a nested synchronous callback as well as an ordinary synchronous return", async t => {
  for (const reentrant of [false, true]) {
    const f = fixture(t);
    const result = round(f, promise(), [settled("host:result", scalar("expected"))], reentrant);
    f.drain();
    assert.deepEqual(await outcome(result), { state: "resolved", value: "expected" });
    if (reentrant) assert.equal(f.nested, 7);
    assert.ok(f.sent.some(packet => packet.type === "promise-ack" && packet.id === "host:result"));
    assertNoWaiting(f);
    assert.equal(f.rpc.remotes.size, 0);
    assert.deepEqual(f.faults, []);
  }
});

test("an early rejection preserves its error instead of leaving the returned promise pending", async t => {
  const f = fixture(t);
  const result = round(f, promise(), [settled("host:result", {
    kind: "error", name: "RemoteFailure", message: "expected rejection", code: "EXPECTED",
  }, false)]);
  const observed = await outcome(result);
  assert.equal(observed.state, "rejected");
  if (observed.state !== "rejected") assert.fail("the remote promise must reject");
  assert.equal(observed.error.name, "RemoteFailure");
  assert.equal(observed.error.message, "expected rejection");
  assert.equal(observed.error.code, "EXPECTED");
  assert.equal(f.nested, 7);
  assertNoWaiting(f);
  assert.equal(f.rpc.remotes.size, 0);
});

test("promises inside returned data and arrays retain aliases and nested settlement values", async t => {
  const f = fixture(t);
  const value = { kind: "data", entries: [
    ["label", scalar("snapshot")],
    ["first", promise("host:first")],
    ["items", { kind: "array", length: 2, entries: [
      ["0", promise("host:first")], ["1", promise("host:second")],
    ] }],
  ] };
  const result = round(f, value, [
    settled("host:first", { kind: "data", entries: [["child", promise("host:child")]] }),
    settled("host:second", scalar(2)),
    settled("host:child", scalar(3)),
  ]);
  assert.equal(result.label, "snapshot");
  assert.equal(result.items.length, 2);
  assert.equal(result.first, result.items[0], "one wire promise must remain one local promise within the value");
  const first = await outcome(result.first);
  assert.equal(first.state, "resolved");
  if (first.state !== "resolved") assert.fail("the first promise must resolve");
  assert.deepEqual(await outcome(first.value.child), { state: "resolved", value: 3 });
  assert.deepEqual(await outcome(result.items[1]), { state: "resolved", value: 2 });
  assertNoWaiting(f);
  assert.equal(f.rpc.remotes.size, 0);
});

test("duplicate settlements do not overwrite results or prevent a later publication from settling", async t => {
  const f = fixture(t);
  const first = round(f, promise("host:shared"), [
    settled("host:shared", scalar("first result")),
    settled("host:shared", scalar("duplicate must not replace the result")),
  ]);
  assert.deepEqual(await outcome(first), { state: "resolved", value: "first result" });
  assertNoWaiting(f);
  assert.equal(f.rpc.remotes.size, 0);

  // Repeated wire publication is legal; the sender emits a settlement for each
  // occurrence, including a promise republished while an earlier ACK is in flight.
  const again = round(f, promise("host:shared"), [settled("host:shared", scalar("first result"))], false);
  f.drain();
  assert.deepEqual(await outcome(again), { state: "resolved", value: "first result" });
  assert.deepEqual(await outcome(first), { state: "resolved", value: "first result" });
  assertNoWaiting(f);
  assert.equal(f.rpc.remotes.size, 0);
  assert.deepEqual(f.faults, []);
});

test("a malformed synchronous reply fails its original caller and rolls back only newly registered promises", async t => {
  const f = fixture(t);
  const existing = f.peer.decode(promise("host:shared-before-decode"));
  const invalid = { kind: "data", entries: [
    ["newPromise", promise("host:new-in-bad-value")],
    ["existingPromise", promise("host:shared-before-decode")],
    ["broken", { kind: "unsupported-test-kind" }],
  ] };
  assert.throws(() => round(f, invalid), /Unsupported plugin RPC value/);
  assert.equal(f.nested, 7, "decoding the outer reply must not throw inside the nested caller");
  assert.ok(f.sent.some(packet => packet.type === "reply" && packet.id === "host:call:callback" && packet.ok));
  assert.equal(f.rpc.pending.has("host:new-in-bad-value"), false);
  assert.equal(f.rpc.remotes.has("host:new-in-bad-value"), false);
  assert.equal(f.rpc.pending.has("host:shared-before-decode"), true, "a shared earlier wait must survive rollback");
  assert.equal(f.rpc.syncResults.size, 0);
  f.peer.receive(settled("host:shared-before-decode", scalar("shared survives")));
  assert.deepEqual(await outcome(existing), { state: "resolved", value: "shared survives" });
  assertNoWaiting(f);
  assert.equal(f.rpc.remotes.size, 0);
  assert.deepEqual(f.faults, []);
});

test("a synchronous remote failure is thrown by its original call without changing nested success", t => {
  const f = fixture(t);
  assert.throws(() => round(f, {
    kind: "error", name: "ExpectedSyncError", message: "outer call failed", code: "OUTER",
  }, [], true, false), (error: any) => {
    assert.equal(error.name, "ExpectedSyncError");
    assert.equal(error.message, "outer call failed");
    assert.equal(error.code, "OUTER");
    return true;
  });
  assert.equal(f.nested, 7);
  assertNoWaiting(f);
  assert.deepEqual(f.faults, []);
});

test("shutdown during nested waiting clears the already decoded outer promise and ignores late settlements", t => {
  const f = fixture(t);
  let registeredBeforeClose = false;
  f.peer.bind("callback", () => f.rpc.sync("get", "host:nested", { key: "value" }));
  f.peer.bind("shutdown", () => {
    registeredBeforeClose = f.rpc.pending.has("host:blocked");
    f.peer.close(Error("fixture stopped"));
  });
  f.post(callbackRequest());
  f.post(reply("plugin:sync:1", promise("host:blocked")));
  f.post(callbackRequest("shutdown"));
  assert.throws(() => f.rpc.sync("get", "host:outer", { key: "value" }), /fixture stopped/);
  assert.equal(registeredBeforeClose, true);
  assertNoWaiting(f);
  assert.equal(f.rpc.remotes.size, 0);
  assert.equal(f.rpc.objects.size, 0);
  const sentBeforeLateResult = f.sent.length;
  f.peer.receive(settled("host:blocked", scalar("too late")));
  assert.equal(f.sent.length, sentBeforeLateResult);
  assertNoWaiting(f);
});

test("synchronous and promise timeouts release buffered results and waits when their owner cuts the peer", async t => {
  const nested = fixture(t, 20, true);
  nested.peer.bind("callback", () => nested.rpc.sync("get", "host:never-replies", { key: "value" }));
  nested.post(callbackRequest());
  nested.post(reply("plugin:sync:1", promise("host:unsettled-outer")));
  assert.throws(() => nested.rpc.sync("get", "host:outer", { key: "value" }), /插件接口等待超时/);
  assert.equal(nested.faults.length, 1);
  assertNoWaiting(nested);
  assert.equal(nested.rpc.remotes.size, 0);

  const asynchronous = fixture(t, 5, true);
  const pending = round(asynchronous, promise("host:never-settles"), [], false);
  await assert.rejects(pending, /插件调用超时/);
  assert.equal(asynchronous.faults.length, 1);
  assertNoWaiting(asynchronous);
  assert.equal(asynchronous.rpc.remotes.size, 0);
});

test("an abort listener may reenter sync while later promises in that same reply are still being decoded", async t => {
  const f = fixture(t);
  const signalWire = { kind: "signal", side: "host", id: "host:signal", generation: 1, aborted: false };
  const signal: AbortSignal = f.peer.decode(signalWire);
  signal.addEventListener("abort", () => {
    f.nested = f.rpc.sync("get", "host:nested", { key: "value" });
  }, { once: true });
  const value = { kind: "data", entries: [
    ["signal", { ...signalWire, generation: 2, aborted: true,
      reason: { kind: "data", entries: [["details", promise("host:reason-details")]] } }],
    ["later", promise("host:after-signal")],
  ] };
  f.post(reply("plugin:sync:1", value));
  f.post(settled("host:reason-details", scalar("reason resolved")));
  f.post(settled("host:after-signal", scalar("later field resolved")));
  f.post(reply("plugin:sync:2", scalar(7)));
  const result = f.rpc.sync("get", "host:outer", { key: "value" });
  f.drain();
  assert.equal(result.signal, signal);
  assert.equal(signal.aborted, true);
  assert.equal(f.nested, 7);
  assert.deepEqual(await outcome(signal.reason.details), { state: "resolved", value: "reason resolved" });
  assert.deepEqual(await outcome(result.later), { state: "resolved", value: "later field resolved" });
  assertNoWaiting(f);
  assert.equal(f.rpc.remotes.has("host:reason-details"), false);
  assert.equal(f.rpc.remotes.has("host:after-signal"), false);
  assert.deepEqual(f.faults, []);
});
