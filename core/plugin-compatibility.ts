/** API versions are independent of the application release and plugin package versions. */
export const PLUGIN_API_VERSION = "1.0.0";
export const SUPPORTED_PLUGIN_API_VERSIONS: readonly string[] = Object.freeze([PLUGIN_API_VERSION]);

export class PluginCompatibilityError extends Error {
  readonly code: "PLUGIN_API_INVALID" | "PLUGIN_API_INCOMPATIBLE";
  constructor(code: PluginCompatibilityError["code"], message: string) {
    super(message);
    this.name = "PluginCompatibilityError";
    this.code = code;
  }
}
type Version = readonly [number, number, number];
function parseVersion(value: string): Version | null {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return null;
  const parts = value.split(".").map(Number);
  return parts.every(Number.isSafeInteger) ? parts as unknown as Version : null;
}
function atLeast(actual: Version, required: Version) {
  for (let index = 0; index < 3; index++) {
    if (actual[index] !== required[index]) return actual[index] > required[index];
  }
  return true;
}

/**
 * Omitted apiVersion means the original v1 contract. Full versions and ^ versions
 * mean minimum compatible version within one major; ~ additionally fixes minor.
 * Only these deliberate forms are accepted; no loosely parsed arbitrary semver.
 */
export function assertPluginCompatibility(
  manifest: unknown,
  supportedVersions: readonly string[] = SUPPORTED_PLUGIN_API_VERSIONS,
): void {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    throw new PluginCompatibilityError("PLUGIN_API_INVALID", "插件 manifest 必须是对象");
  const declared = (manifest as { apiVersion?: unknown }).apiVersion;
  const requirement = declared === undefined ? "1.x" : declared;
  if (typeof requirement !== "string" || requirement.length > 64)
    throw new PluginCompatibilityError("PLUGIN_API_INVALID", "apiVersion 必须是版本字符串，如 1、1.x 或 ^1.0.0");
  const majorOnly = /^(0|[1-9]\d*)(?:\.x)?$/.exec(requirement);
  const kind = requirement[0] === "^" || requirement[0] === "~" ? requirement[0] : "";
  const minimum = majorOnly ? [Number(majorOnly[1]), 0, 0] as const : parseVersion(kind ? requirement.slice(1) : requirement);
  if (!minimum || !minimum.every(Number.isSafeInteger))
    throw new PluginCompatibilityError("PLUGIN_API_INVALID", "apiVersion 格式无效；支持主版本、主版本.x、完整最低版本、^版本或~版本");
  const actual = supportedVersions.map((value) => {
    const version = parseVersion(value);
    if (!version) throw new TypeError("宿主 API 版本配置无效");
    return version;
  });
  if (actual.some((version) => version[0] === minimum[0] &&
      (kind !== "~" || version[1] === minimum[1]) && atLeast(version, minimum))) return;
  throw new PluginCompatibilityError("PLUGIN_API_INCOMPATIBLE",
    `插件要求 API ${requirement}，当前宿主提供 ${supportedVersions.join("、") || "无"}；未加载插件代码`);
}
