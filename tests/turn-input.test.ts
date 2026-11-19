import { test } from "node:test";
import assert from "node:assert/strict";
import { TurnInput, type TurnMessage } from "../core/turn-input.ts";

const message = (messageId: string, text = messageId): TurnMessage => ({
  messageId, text, receivedAt: "2026-11-08T01:02:03.000Z", timezone: "Asia/Shanghai",
});
const deferred = () => {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test("initial message is deduplicated without becoming pending, and finishing seals synchronously", async () => {
  const input = new TurnInput(message("initial"), new AbortController().signal);
  assert.deepEqual(await input.take(), []);
  assert.equal(input.hasPending(), false);
  let writes = 0;
  assert.deepEqual(await input.append(message("initial"), async () => { writes++; }), { status: "duplicate", messageId: "initial" });
  await assert.rejects(input.append(message("initial", "changed"), async () => { writes++; }), /不同正文/);
  assert.equal(input.tryFinish(), true);
  assert.deepEqual(await input.append(message("late"), async () => { writes++; }), { status: "closed", messageId: "late" });
  assert.equal(writes, 0);
});

test("reservations block finalization and take retains arrival order across out-of-order persistence", async () => {
  const input = new TurnInput(message("initial"), new AbortController().signal);
  const first = deferred(), second = deferred();
  const a = input.append(message("first"), () => first.promise);
  const b = input.append(message("second"), () => second.promise);
  assert.equal(input.hasPending(), true);
  assert.equal(input.tryFinish(), false);
  let taken = false;
  const taking = input.take().then(rows => { taken = true; return rows; });
  second.resolve();
  await b;
  assert.equal(taken, false);
  first.resolve();
  assert.deepEqual(await a, { status: "accepted", messageId: "first" });
  assert.deepEqual((await taking).map(row => row.messageId), ["first", "second"]);
  assert.equal(input.tryFinish(), true);
});

test("duplicate in-flight submissions wait for the single durable receipt", async () => {
  const input = new TurnInput(message("initial"), new AbortController().signal), save = deferred();
  let writes = 0, duplicated = false;
  const first = input.append(message("one"), () => { writes++; return save.promise; });
  const duplicate = input.append(message("one"), async () => { writes++; }).then(result => { duplicated = true; return result; });
  await Promise.resolve();
  assert.equal(writes, 1);
  assert.equal(duplicated, false);
  save.resolve();
  assert.equal((await first).status, "accepted");
  assert.equal((await duplicate).status, "duplicate");
  assert.deepEqual(await input.take(), [message("one")]);
});

test("failed persistence releases reservations and does not poison taking or explicit retries", async () => {
  const input = new TurnInput(message("initial"), new AbortController().signal), save = deferred();
  const first = input.append(message("one"), () => save.promise);
  const duplicate = input.append(message("one"), async () => {});
  const failed = Promise.all([assert.rejects(first, /synthetic save failure/), assert.rejects(duplicate, /synthetic save failure/)]);
  const taking = input.take();
  save.reject(Error("synthetic save failure"));
  await failed;
  assert.deepEqual(await taking, []);
  assert.equal(input.hasPending(), false);
  assert.equal((await input.append(message("one", "corrected after failed save"), async () => {})).status, "accepted");
  assert.deepEqual(await input.take(), [message("one", "corrected after failed save")]);
});

test("closing rejects new messages but drains already reserved messages", async () => {
  const input = new TurnInput(message("initial"), new AbortController().signal), save = deferred();
  const appending = input.append(message("one"), () => save.promise);
  input.closeInput();
  assert.equal(input.tryFinish(), false);
  assert.equal((await input.append(message("two"), async () => assert.fail("closed input persisted"))).status, "closed");
  save.resolve();
  assert.equal((await appending).status, "accepted");
  assert.deepEqual(await input.take(), [message("one")]);
  assert.equal(input.tryFinish(), true);
});

test("cancellation rejects new input and releases a consumer waiting on persistence", async () => {
  const controller = new AbortController(), input = new TurnInput(message("initial"), controller.signal), save = deferred();
  const appending = input.append(message("one"), () => save.promise);
  const taking = assert.rejects(input.take(), /synthetic cancellation/);
  controller.abort(Error("synthetic cancellation"));
  await taking;
  assert.equal((await input.append(message("two"), async () => assert.fail("cancelled input persisted"))).status, "cancelled");
  save.resolve();
  assert.equal((await appending).status, "accepted");
});

test("message and character limits include initial and consumed messages", async () => {
  const input = new TurnInput(message("initial"), new AbortController().signal);
  for (let i = 0; i < 127; i++) {
    assert.equal((await input.append(message(String(i)), async () => {})).status, "accepted");
    await input.take();
  }
  assert.equal((await input.append(message("overflow"), async () => assert.fail("full input persisted"))).status, "full");
  assert.equal((await input.append(message("126"), async () => assert.fail("duplicate persisted"))).status, "duplicate");
  const characters = new TurnInput(message("initial", "字".repeat(16000)), new AbortController().signal);
  for (let i = 0; i < 7; i++) assert.equal((await characters.append(message(String(i), "字".repeat(16000)), async () => {})).status, "accepted");
  await characters.take();
  assert.equal((await characters.append(message("overflow", "字"), async () => assert.fail("full input persisted"))).status, "full");
  await assert.rejects(characters.append(message("long", "字".repeat(16001)), async () => {}), /16000/);
});

test("input snapshots cannot be mutated after acceptance or consumption", async () => {
  const first = message("initial"), input = new TurnInput(first, new AbortController().signal);
  first.text = "mutated initial";
  const next = { ...message("next"), senderProfile: { nickname: "original" } }, saving = input.append(next, async () => {});
  next.text = "mutated pending";
  next.senderProfile.nickname = "updated elsewhere";
  await saving;
  const rows = await input.take();
  assert.equal(rows[0].text, "next");
  assert.deepEqual(rows[0].senderProfile, { nickname: "original" });
  rows[0].text = "mutated consumed";
  assert.equal((await input.append(message("initial"), async () => {})).status, "duplicate");
  assert.equal((await input.append(message("next"), async () => {})).status, "duplicate");
});
