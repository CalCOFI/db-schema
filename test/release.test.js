// node --test test/
//
// Exercises release.js against both catalog shapes. The fixtures are copies of
// calcofi4r/tests/testthat/fixtures/catalog_{canonical,legacy}.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  cmpVersion, summarizeSince, sinceStats, tableBytes, shortHash, partitionLabel,
  catalogTotals, versionEntry, isConsolidated, retiredInfo, retiredDate, pickerLabel,
} from "../release.js";

const here = dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(join(here, "fixtures", f), "utf8"));
const canonical = load("catalog_canonical.json");
const legacy    = load("catalog_legacy.json");
const tbl = (c, name) => c.tables.find(t => t.name === name);

test("summarizeSince: canonical catalog at its own version", () => {
  const v = canonical.version;
  assert.equal(v, "v2026.09.01");
  assert.equal(summarizeSince(tbl(canonical, "cruise"), v),       "unchanged since v2026.08.25");
  assert.equal(summarizeSince(tbl(canonical, "obs"), v),          "1 of 2 partitions changed in this version");
  assert.equal(summarizeSince(tbl(canonical, "obs_ctd_full"), v), "unchanged since v2026.07.17");
});

test("summarizeSince: single object shipped by this version", () => {
  assert.equal(summarizeSince(tbl(canonical, "cruise"), "v2026.08.25"), "changed in this version");
});

test("summarizeSince: one-partition table uses the singular", () => {
  const t = { name: "x", partitioned: true, objects: [{ since: "v2026.09.01", partition_by: "year", partition_value: "2019" }] };
  assert.equal(summarizeSince(t, "v2026.09.01"), "1 of 1 partition changed in this version");
});

test("summarizeSince: legacy catalog renders nothing", () => {
  for (const t of legacy.tables) {
    assert.equal(summarizeSince(t, legacy.version), null);
    assert.equal(sinceStats(t, legacy.version), null);
    assert.equal(tableBytes(t), null);
  }
  assert.equal(summarizeSince(null, "v2026.08.14"), null);
  assert.equal(summarizeSince({ name: "x", objects: [] }, "v2026.08.14"), null);
});

test("sinceStats: names the changed partitions", () => {
  const s = sinceStats(tbl(canonical, "obs"), "v2026.09.01");
  assert.deepEqual(s, {
    n_objects: 2, n_changed: 1, since_max: "v2026.09.01", changed: ["year=2020"], partitioned: true,
  });
  // objects without `since` count toward the total but never as changed
  const mixed = { objects: [{ since: "v2026.09.01" }, { path: "a/b/data_1.parquet" }] };
  assert.deepEqual(sinceStats(mixed, "v2026.09.01").n_objects, 2);
  assert.equal(summarizeSince(mixed, "v2026.09.01"), "1 of 2 partitions changed in this version");
});

test("tableBytes: table-level bytes wins, else the sum over objects", () => {
  assert.equal(tableBytes(tbl(canonical, "cruise")), 40960);
  assert.equal(tableBytes(tbl(canonical, "obs")), 2000);
  assert.equal(tableBytes({ bytes: 7, objects: [{ bytes: 1 }] }), 7);
  assert.equal(tableBytes(null), null);
});

test("shortHash + partitionLabel", () => {
  assert.equal(shortHash(tbl(canonical, "cruise").content_hash), "a1b2c3d4");
  assert.equal(shortHash(undefined), "");
  assert.equal(partitionLabel(tbl(canonical, "obs").objects[0]), "year=2019");
  assert.equal(partitionLabel(tbl(canonical, "cruise").objects[0]), "cruise.parquet");
});

test("catalogTotals: explicit totals, else summed; bytes null for legacy", () => {
  assert.deepEqual(catalogTotals(canonical), { tables: 3, rows: 219000700, bytes: 43960 });
  assert.deepEqual(catalogTotals(legacy),    { tables: 3, rows: 219000700, bytes: null });
  assert.deepEqual(catalogTotals({ total_rows: 5, total_size: 9, tables: [{ rows: 1 }] }), { tables: 1, rows: 5, bytes: 9 });
  assert.deepEqual(catalogTotals(null), { tables: 0, rows: null, bytes: null });
});

test("cmpVersion orders CalVer numerically", () => {
  const vs = ["v2026.08.10", "v2026.07.17", "v2026.08.9", "v2026.09.01", "v2026.08.25"];
  assert.deepEqual(vs.slice().sort(cmpVersion),
    ["v2026.07.17", "v2026.08.9", "v2026.08.10", "v2026.08.25", "v2026.09.01"]);
});

test("versions.json flags degrade to false/null when absent", () => {
  const versions = [
    { version: "v2026.09.01", release_date: "2026-09-01", consolidated: false },
    { version: "v2026.08.25", release_date: "2026-08-25", consolidated: true },
    { version: "v2026.08.10", release_date: "2026-08-11" },
    { version: "v2026.07.17", release_date: "2026-07-17",
      retired: { retired_utc: "2026-10-01T03:00:00Z", to: "v2026.08.25", reason: "archive thinning" } },
  ];
  assert.equal(versionEntry(versions, "nope"), null);
  assert.equal(isConsolidated(versionEntry(versions, "v2026.08.10")), false);
  assert.equal(isConsolidated(versionEntry(versions, "v2026.08.25")), true);
  assert.equal(retiredInfo(versionEntry(versions, "v2026.08.25")), null);
  const r = retiredInfo(versionEntry(versions, "v2026.07.17"));
  assert.equal(r.to, "v2026.08.25");
  assert.equal(retiredDate(r), "2026-10-01");
  assert.equal(retiredDate(null), "");

  assert.equal(pickerLabel(versions[0], "v2026.09.01"), "★ v2026.09.01");
  assert.equal(pickerLabel(versions[1], "v2026.09.01"), "v2026.08.25 (consolidated)");
  assert.equal(pickerLabel(versions[2], "v2026.09.01"), "v2026.08.10 · 2026-08-11");
  assert.equal(pickerLabel(versions[3], "v2026.09.01"), "v2026.07.17 (retired)");
});
