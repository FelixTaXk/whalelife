/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
const component = "(?:0|[1-9]\\d*)";
const stable = [component, component, component].join("\\.");
export const stableVersion = new RegExp("^" + stable + "$");
const range = new RegExp("^(=|>=)?(" + stable + ")(?: +(<|<=)(" + stable + "))?$");

export function compareVersions(left: string, right: string) {
  const a = stableVersion.test(left), b = stableVersion.test(right);
  if (!a || !b) return Number(a) - Number(b);
  const parts = left.split("."), other = right.split(".");
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] !== other[i]) return parts[i].length - other[i].length || (parts[i] < other[i] ? -1 : 1);
  }
  return 0;
}

// A bare version is the oldest verified host. An explicitly bounded range can restrict newer hosts.
export function parseHostRange(value: unknown) {
  if (typeof value !== "string" || value.length > 256 || value.trim() !== value) return;
  const match = range.exec(value);
  if (!match) return;
  const [, operator, minimum, bound, upper] = match;
  if (upper) {
    const order = compareVersions(minimum, upper);
    if (operator !== ">=" || order > 0 || (order === 0 && bound === "<")) return;
  }
  return { minimum, maximum: operator === "=" ? minimum : upper, inclusive: operator === "=" || bound === "<=" };
}

export function compatibleHostFloor(requirement: unknown, host: string): string | undefined {
  const limits = parseHostRange(requirement);
  if (!limits || !stableVersion.test(host) || compareVersions(host, limits.minimum) < 0) return;
  if (limits.maximum) {
    const order = compareVersions(host, limits.maximum);
    if (order > 0 || (order === 0 && !limits.inclusive)) return;
  }
  return limits.minimum;
}
