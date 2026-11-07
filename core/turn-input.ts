/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
export type TurnMessage = { messageId: string; text: string; receivedAt: string; timezone: string };
export type TurnAppendResult = { status: "accepted" | "duplicate" | "closed" | "full" | "cancelled"; messageId: string };
type Entry = { message: TurnMessage; saved: boolean; commit?: Promise<void> };

/** One process-local turn. Persisted receipts are evidence, never a replay queue. */
export class TurnInput {
  private seen = new Map<string, Entry>();
  private pending: Entry[] = [];
  private commits = new Set<Promise<void>>();
  private characters = 0;
  private closed = false;
  private signal: AbortSignal;

  constructor(initial: TurnMessage, signal: AbortSignal) {
    this.validate(initial);
    this.signal = signal;
    const message = { ...initial };
    this.seen.set(message.messageId, { message, saved: true });
    this.characters = message.text.length;
  }

  private validate(message: TurnMessage) {
    if (!message || typeof message.messageId !== "string" || !message.messageId.trim())
      throw Error("消息ID不能为空");
    if (typeof message.text !== "string" || !message.text.trim() || message.text.length > 16000)
      throw Error("请输入 1–16000 字");
  }

  async append(message: TurnMessage, persist: () => Promise<void>): Promise<TurnAppendResult> {
    this.validate(message);
    const snapshot = { ...message }, messageId = snapshot.messageId;
    if (this.signal.aborted) return { status: "cancelled", messageId };
    const previous = this.seen.get(messageId);
    if (previous) {
      if (previous.message.text !== snapshot.text) throw Error("同一消息ID对应了不同正文");
      // A duplicate cannot acknowledge an original write that later fails.
      await previous.commit;
      return { status: "duplicate", messageId };
    }
    if (this.closed) return { status: "closed", messageId };
    if (this.seen.size >= 128 || this.characters + snapshot.text.length > 128000)
      return { status: "full", messageId };

    // Reserve synchronously, before the persistence callback can yield or fail.
    const entry: Entry = { message: snapshot, saved: false };
    this.seen.set(messageId, entry);
    this.pending.push(entry);
    this.characters += snapshot.text.length;
    const commit = Promise.resolve().then(persist).then(() => { entry.saved = true; }).catch(error => {
      this.seen.delete(messageId);
      this.pending = this.pending.filter(item => item !== entry);
      this.characters -= snapshot.text.length;
      throw error;
    }).finally(() => { this.commits.delete(commit); });
    entry.commit = commit;
    this.commits.add(commit);
    await commit;
    return { status: "accepted", messageId };
  }

  async take(): Promise<TurnMessage[]> {
    this.signal.throwIfAborted();
    while (this.commits.size) {
      // Cancellation must release a consumer even if a storage operation is stuck.
      await new Promise<void>((resolve, reject) => {
        const abort = () => { this.signal.removeEventListener("abort", abort); reject(this.signal.reason); };
        this.signal.addEventListener("abort", abort, { once: true });
        Promise.allSettled([...this.commits]).then(() => {
          this.signal.removeEventListener("abort", abort);
          resolve();
        });
        if (this.signal.aborted) abort();
      });
      this.signal.throwIfAborted();
    }
    const rows = this.pending.filter(entry => entry.saved).map(entry => ({ ...entry.message }));
    this.pending = [];
    return rows;
  }

  hasPending() { return this.pending.length > 0 || this.commits.size > 0; }

  /** No await between this check and the caller committing its final reply. */
  tryFinish() {
    if (this.hasPending()) return false;
    this.closed = true;
    return true;
  }

  closeInput() { this.closed = true; }
}
