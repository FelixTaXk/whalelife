/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
export type Permission = "off" | "ask" | "full";
export function decision(
  mode: Permission,
  danger: string,
  override?: Permission,
) {
  const effective = mode === "off" ? "off" : (override ?? mode);
  return effective === "full" || (effective === "ask" && danger === "safe")
    ? "allow"
    : effective === "off"
      ? "deny"
      : "ask";
}
export const approval = {
  async request() {
    return {
      approved: false,
      reason: "M0 尚未提供审批流，请在配置中授权后重启",
    };
  },
};
