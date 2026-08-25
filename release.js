// CalCOFI Schema — pure helpers over the release sidecars.
//
// Everything here reads catalog.json / versions.json shapes and returns plain
// values: no DOM, no fetch, no State. app.js imports these for rendering and
// `node --test test/` exercises them against the fixture catalogs in
// test/fixtures/ (copies of calcofi4r's tests/testthat/fixtures — that repo is
// the source of truth for the shapes).
//
// Two catalog shapes coexist and must both render:
//
//   legacy    (≤ v2026.08.25)  tables[] = {name, rows, partitioned, supplemental}
//   canonical (≥ v2026.09)     + content_hash (whole-table signature), compat_path,
//                              objects[] = {path, bytes, sha256, content_hash,
//                              since, partition_by?, partition_value?} — one per
//                              table, or one per partition; plus catalog-level
//                              layout ("compat"|"canonical") and writer.
//
// `since` on an object is the first release that shipped those exact bytes, so
// "since === this version" is the per-table (per-partition) changelog.
//
// versions.json entries may carry `consolidated: true` (parquet kept
// indefinitely) and `retired: {retired_utc, to, reason}` (parquet removed by
// archive thinning; `to` is the nearest kept version to read instead — the
// sidecars stay, so the schema can still be browsed).
//
// Every helper returns null / [] / "" when a field is absent, so a legacy
// catalog renders exactly as it did before these fields existed.

// CalVer "vYYYY.MM.DD": compare numerically per dot-separated field so an
// unpadded day would still sort after the 9th.
export function cmpVersion(a, b) {
  const pa = String(a || "").replace(/^v/, "").split(".").map(Number);
  const pb = String(b || "").replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

export function tableObjects(t) {
  return (t && Array.isArray(t.objects)) ? t.objects.filter(Boolean) : [];
}

// table-level `bytes` when the writer stamps it, else the sum over objects[];
// null for a legacy entry (nothing to show)
export function tableBytes(t) {
  if (!t) return null;
  if (typeof t.bytes === "number") return t.bytes;
  const sized = tableObjects(t).filter(o => typeof o.bytes === "number");
  return sized.length ? sized.reduce((s, o) => s + o.bytes, 0) : null;
}

export function shortHash(h, n = 8) {
  return h ? String(h).slice(0, n) : "";
}

// "year=2020" for a partition object, else the file name
export function partitionLabel(o) {
  if (!o) return "";
  if (o.partition_by != null && o.partition_value != null) {
    return `${o.partition_by}=${o.partition_value}`;
  }
  return String(o.path || "").split("/").pop() || "";
}

// per-table change summary for `version` (normally the catalog's own):
//   {n_objects, n_changed, since_max, changed: [labels], partitioned}
// or null when no object carries `since` (legacy catalog)
export function sinceStats(t, version) {
  const objs  = tableObjects(t);
  const dated = objs.filter(o => o.since);
  if (!dated.length) return null;
  const changed = dated.filter(o => o.since === version);
  const since_max = dated.map(o => o.since).sort(cmpVersion).pop();
  return {
    n_objects:   objs.length,
    n_changed:   changed.length,
    since_max,
    changed:     changed.map(partitionLabel),
    partitioned: !!(t && t.partitioned) || objs.length > 1,
  };
}

// one line for a table card:
//   single object  → "changed in this version" | "unchanged since v2026.08.25"
//   partitioned    → "3 of 96 partitions changed in this version"
//                  | "unchanged since v2026.08.25" (the newest partition's since)
// null when the catalog has no objects[] (legacy) — render nothing
export function summarizeSince(t, version) {
  const s = sinceStats(t, version);
  if (!s) return null;
  if (s.n_changed === 0) return `unchanged since ${s.since_max}`;
  if (!s.partitioned)    return "changed in this version";
  const noun = s.n_objects === 1 ? "partition" : "partitions";
  return `${s.n_changed} of ${s.n_objects} ${noun} changed in this version`;
}

// header totals: the catalog's own total_rows/total_size when present, else
// summed from tables[] (a canonical catalog may omit the totals)
export function catalogTotals(catalog) {
  const tables = (catalog && Array.isArray(catalog.tables)) ? catalog.tables : [];
  const sum = (vals) => {
    const nums = vals.filter(v => typeof v === "number");
    return nums.length ? nums.reduce((s, v) => s + v, 0) : null;
  };
  return {
    tables: tables.length,
    rows:   (catalog && typeof catalog.total_rows === "number") ? catalog.total_rows : sum(tables.map(t => t.rows)),
    bytes:  (catalog && typeof catalog.total_size === "number") ? catalog.total_size : sum(tables.map(tableBytes)),
  };
}

// ─── versions.json ─────────────────────────────────────────────────────────

export function versionEntry(versions, version) {
  return (versions || []).find(v => v && v.version === version) || null;
}

export function isConsolidated(entry) {
  return !!(entry && entry.consolidated === true);
}

// {retired_utc, to, reason} or null
export function retiredInfo(entry) {
  const r = entry && entry.retired;
  return (r && typeof r === "object") ? r : null;
}

// "2026-10-01" from an ISO timestamp (or whatever prefix the writer used)
export function retiredDate(r) {
  return r && r.retired_utc ? String(r.retired_utc).slice(0, 10) : "";
}

// <option> text for the version picker. version is CalVer (vYYYY.MM.DD) so it
// already encodes the release date; only append the date when it genuinely
// differs (e.g. a same-version re-release on a later day) — otherwise it's
// redundant noise. Retired/consolidated are marked so the state is visible
// before the version is loaded.
export function pickerLabel(entry, latestVersion) {
  const v       = entry.version;
  const verDate = String(v).replace(/^v/, "").replace(/\./g, "-");
  const dateBit = (entry.release_date && entry.release_date !== verDate) ? ` · ${entry.release_date}` : "";
  const star    = v === latestVersion ? "★ " : "";
  const mark    = retiredInfo(entry) ? " (retired)"
                : isConsolidated(entry) ? " (consolidated)"
                : "";
  return `${star}${v}${dateBit}${mark}`;
}
