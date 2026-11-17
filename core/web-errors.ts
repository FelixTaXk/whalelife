/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */

/** Internal cancellation reason, created only after observing a client disconnect. */
export class WebClientDisconnectedError extends Error {
  constructor() {
    super("页面请求已断开");
    this.name = "WebClientDisconnectedError";
  }
}
