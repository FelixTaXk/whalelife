/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import type { Context } from "../../../../../core/context.ts";
export const id = "extra";
export function apply(ctx: Context) {
  ctx.logger.info("hello/extra 父服务验证", {
    greeting: ctx.get("hello").greet("鲸鲸"),
  });
  ctx.provide("hello-extra", { active: true });
  ctx.effect(() => () => ctx.logger.info("hello/extra 已清理"));
}
