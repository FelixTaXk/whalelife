/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
(() => {
  // The public file:// page loads this as a classic script. The console imports the same module.
  const scope = typeof window === "undefined" ? globalThis : window;
  const pluginId = value =>
    typeof value === "string" && /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)*$/.test(value);
  const validVersion = value => typeof value === "string" && /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(value);

  function releaseVersion(entry) {
    if (validVersion(entry?.version)) return entry.version;
    if (!Array.isArray(entry?.verifiedReleases)) return null;
    // Older published community catalogs carry the reviewed package records directly.
    let latest = null;
    for (const release of entry.verifiedReleases) {
      if (!validVersion(release?.version) || release.recognitionOnly || !Number.isSafeInteger(release.sizeBytes) || release.sizeBytes <= 0 ||
        !/^[a-f0-9]{64}$/.test(release.sha256) || !publicLink(release.assetUrl)?.href.startsWith(entry.repository + "/releases/download/")) continue;
      if (!latest || release.version.localeCompare(latest, "en", { numeric:true }) > 0) latest = release.version;
    }
    return latest;
  }

  scope.whaleLifeCatalogVersion = (entry, bundled) => releaseVersion(entry) || releaseVersion(bundled?.find(item =>
    item.id === entry.id && item.repository === entry.repository && item.name === entry.name));

  function publicLink(value) {
    if (typeof value !== "string" || !/^https:\/\//i.test(value) || /[\s\\\u0000-\u001f\u007f]/u.test(value)) return null;
    try {
      const url = new URL(value);
      if (url.username || url.password || !url.hostname) return null;
      return url;
    } catch {
      return null;
    }
  }

  function validEntry(entry) {
    if (!entry || !pluginId(entry.id)) return false;
    if (entry.version !== undefined && !validVersion(entry.version)) return false;
    for (const field of ["name", "author", "description"]) {
      if (typeof entry[field] !== "string" || !entry[field].trim()) return false;
    }
    const repo = publicLink(entry.repository);
    if (repo?.origin !== "https://github.com" || repo.search || repo.hash ||
      !/^\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/?$/.test(repo.pathname)) return false;
    if (!publicLink(entry.installation) || !publicLink(entry.feedback)) return false;
    return Array.isArray(entry.dependencies) && entry.dependencies.length <= 128 &&
      entry.dependencies.every(id => pluginId(id) && id !== entry.id) &&
      new Set(entry.dependencies).size === entry.dependencies.length;
  }

  function validListingDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + "T00:00:00Z");
    return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
  }

  scope.isWhaleLifeCatalog = value => {
    if (!value || !Array.isArray(value.official) || !Array.isArray(value.community)) return false;
    const seen = new Set();
    for (const entries of [value.official, value.community]) {
      for (const entry of entries) {
        if (!validEntry(entry) || seen.has(entry.id)) return false;
        if (entries === value.community && (!Number.isSafeInteger(entry.stars) || entry.stars < 0 ||
          !validListingDate(entry.collected))) return false;
        seen.add(entry.id);
      }
    }
    return true;
  };
})();
