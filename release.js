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
//                              since, compat_path, partition_by?, partition_value?}
//                              — one per table, or one per partition; plus
//                              catalog-level layout ("compat"|"canonical") and writer.
//
// `since` on an object is the first release that shipped those exact bytes, so
// "since === this version" is the per-table (per-partition) changelog.
//
// A partitioned table may also publish a single-file "twin" (obs does): it is
// the object WITHOUT partition_by on a table whose other objects have one.
// It is a duplicate of the partitions, so it is never a partition: sinceStats()
// and tableBytes() leave it out ("1 of 2 partitions changed" stays 1 of 2) and
// twinInfo() / summarizeTwin() report it on its own.
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

// the objects that ARE the table: every partition when any object carries
// partition_by (the rest are twins), else all of them (single-object table)
export function partitionObjects(t) {
  const objs  = tableObjects(t);
  const parts = objs.filter(o => o.partition_by != null);
  return parts.length ? parts : objs;
}

// the single-file twin of a partitioned table — the object without
// partition_by beside objects that have one; null otherwise (a lone object on
// a non-partitioned table is the table, not a twin)
export function twinInfo(t) {
  const objs = tableObjects(t);
  if (!objs.some(o => o.partition_by != null)) return null;
  return objs.find(o => o.partition_by == null) || null;
}

export function fmtBytes(n) {
  if (!n) return "—";
  const u = ["B","KB","MB","GB","TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 ? 0 : 1)} ${u[i]}`;
}

// "+ single-file copy (1.9 KB, since v2026.09.01)" for a table with a twin,
// else null
export function summarizeTwin(t) {
  const tw = twinInfo(t);
  if (!tw) return null;
  const bits = [];
  if (typeof tw.bytes === "number") bits.push(fmtBytes(tw.bytes));
  if (tw.since) bits.push(`since ${tw.since}`);
  return `+ single-file copy${bits.length ? ` (${bits.join(", ")})` : ""}`;
}

// table-level `bytes` when the writer stamps it, else the sum over the
// partition objects (a twin is a duplicate, not more table); null for a legacy
// entry (nothing to show)
export function tableBytes(t) {
  if (!t) return null;
  if (typeof t.bytes === "number") return t.bytes;
  const sized = partitionObjects(t).filter(o => typeof o.bytes === "number");
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

// per-table change summary for `version` (normally the catalog's own), over
// the partition objects only (a twin is reported by summarizeTwin):
//   {n_objects, n_changed, since_max, changed: [labels], partitioned}
// or null when no object carries `since` (legacy catalog)
export function sinceStats(t, version) {
  const objs  = partitionObjects(t);
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

// --- keys: relationships.json + integrity.json (calcofi4db ≥ 4.7.0) -----------------
//
// relationships.json declares each table's primary key (a string, or an array for
// a composite key) and the foreign keys between released tables. integrity.json,
// written by the release from 2026-09-08, MEASURES them: primary_keys[] with
// n_rows / n_distinct / n_dup / n_null and foreign_keys[] with n_rows / n_null /
// n_orphan, each with status ok | fail | skipped. keysFor() joins the two for one
// table so the Tables tab can say "PK obs_id · unique, measured" and "→ sample
// (0 orphans)" — and, for a release without integrity.json, "declared" only.

function pkColumns(pk) {
  if (pk == null) return [];
  return Array.isArray(pk) ? pk.map(String) : [String(pk)];
}

// the measured row for one PK / FK, or null when integrity.json is absent
function pkMeasure(integrity, table) {
  const rows = (integrity && Array.isArray(integrity.primary_keys)) ? integrity.primary_keys : [];
  return rows.find(r => r.table === table) || null;
}
function fkMeasure(integrity, fk) {
  const rows = (integrity && Array.isArray(integrity.foreign_keys)) ? integrity.foreign_keys : [];
  return rows.find(r => r.table === fk.table && r.column === fk.column &&
                        r.ref_table === fk.ref_table && r.ref_column === fk.ref_column) || null;
}

// {pk: {columns, measure}, out: [{column, ref_table, ref_column, measure}], in: [...]}
export function keysFor(table, relationships, integrity) {
  const rels = relationships || {};
  const pk   = pkColumns((rels.primary_keys || {})[table]);
  const fks  = Array.isArray(rels.foreign_keys) ? rels.foreign_keys : [];
  const out  = fks.filter(f => f.table === table).map(f => ({ ...f, measure: fkMeasure(integrity, f) }));
  const inn  = fks.filter(f => f.ref_table === table && f.table !== table)
                  .map(f => ({ ...f, measure: fkMeasure(integrity, f) }));
  return { pk: { columns: pk, measure: pk.length ? pkMeasure(integrity, table) : null }, out, in: inn };
}

// one short phrase per measured row, for a chip title
export function pkPhrase(m) {
  if (!m) return "declared, not yet measured";
  if (m.status === "skipped") return "declared; not measured in this release";
  if (m.status === "ok") return `unique and non-NULL, measured on ${Number(m.n_rows).toLocaleString()} rows`;
  return `${Number(m.n_dup || 0).toLocaleString()} duplicate, ${Number(m.n_null || 0).toLocaleString()} NULL`;
}
export function fkPhrase(m) {
  if (!m) return "declared, not yet measured";
  if (m.status === "skipped") return "declared; not measured in this release";
  const nulls = Number(m.n_null || 0);
  const base  = m.status === "ok" ? "0 orphans" : `${Number(m.n_orphan || 0).toLocaleString()} orphans`;
  return nulls ? `${base}; ${nulls.toLocaleString()} NULL (a nullable edge)` : base;
}

// the column's role in one table, for the Columns tab: "PK", "PK (2 of 2)", "FK → sample.sample_key", ""
export function columnRole(table, column, relationships) {
  const k = keysFor(table, relationships, null);
  const parts = [];
  const i = k.pk.columns.indexOf(column);
  if (i >= 0) parts.push(k.pk.columns.length > 1 ? `PK ${i + 1}/${k.pk.columns.length}` : "PK");
  for (const f of k.out) if (f.column === column) parts.push(`FK → ${f.ref_table}.${f.ref_column}`);
  return parts.join(" · ");
}
