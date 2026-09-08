# CalCOFI Schema

Browse the schema of every CalCOFI database release — tables, columns,
ER diagram, datasets and measurement types — at
[**calcofi.io/db-schema**](https://calcofi.io/db-schema/).

The site is a static Jekyll page that consumes the per-release sidecars
uploaded to `gs://calcofi-db/ducklake/releases/{version}/` by
[CalCOFI/workflows](https://github.com/CalCOFI/workflows). A release's parquet
may be removed later by archive thinning; its sidecars never are, so every
version stays browsable here:

| File                  | Tab           | Notes                              |
|-----------------------|---------------|------------------------------------|
| `erd.mmd`             | Diagram       | Mermaid string from `cc_erd()`     |
| `metadata.json`       | Tables, Columns, Datasets, Measurements | descriptions + units + types |
| `relationships.json`  | Tables (keys line), Columns (key column), `erd.mmd` | every released table's primary key and the foreign keys between released tables (from v2026.09.08's successor, ingest-only edges stay in `relationships_all.csv`) |
| `integrity.json`      | Tables (✓ / ✗ on each key chip) | **measured** keys, calcofi4db ≥ 4.7.0: per primary key `n_rows` / `n_distinct` / `n_dup` / `n_null`, per foreign key `n_rows` / `n_null` / `n_orphan`, each `status` ok \| fail \| skipped, `ok` overall. Absent on earlier releases, in which case the chips show the declaration alone |
| `catalog.json`        | release-meta header, Tables | row counts + total size. From v2026.09 also `layout` / `writer` and, per table, `content_hash` + `objects[]` (`path`, `bytes`, `sha256`, `content_hash`, `since`, `compat_path`, `partition_by`/`partition_value`) — rendered as size, "what changed", hash and single-file-twin chips |
| `RELEASE_NOTES.md`    | release-meta header | inline rendered with marked; "all releases ↗" opens `../RELEASES.md` |
| `versions.json` + `latest.txt` (one folder up) | version dropdown | `consolidated` and `retired: {retired_utc, to, reason}` mark the picker and the header |

Switching the version dropdown re-fetches the per-version files and
re-renders the active tab. Default version = whatever `latest.txt` points
at (gated by `test_release.qmd` in the workflows repo).

## Content-addressed releases (v2026.09 and later)

From v2026.09 the parquet is content-addressed: `catalog.json` lists, for each
table, one object (or one per partition) with its `bytes`, `sha256`,
`content_hash` and `since` — the first release that shipped those exact
bytes. `since` is therefore the per-table (per-partition) changelog, and the
Tables tab shows it as:

- **single object** — `changed in this version` or `unchanged since v2026.08.25`
- **partitioned** — `3 of 96 partitions changed in this version` (the tooltip
  names the partitions), else `unchanged since …` (the newest partition's `since`)
- the humanized `bytes` and the first 8 characters of the whole-table
  `content_hash` (full hash + `compat_path`, the legacy per-release path, in
  the tooltip)
- a partitioned table that also publishes a single-file **twin** (`obs` does)
  lists it in `objects[]` as the object *without* `partition_by`. It is a
  duplicate, not a partition — it is left out of the counts and the table
  size and shown on its own chip: `+ single-file copy (1.9 KB, since v2026.09.01)`

Catalogs before v2026.09 (including `v2026.08.25`) have none of these fields
and render exactly as before — the helpers return nothing rather than a
placeholder.

`versions.json` carries two markers per version: `consolidated: true` (parquet
kept indefinitely; a `consolidated` chip in the header, `(consolidated)` in the
picker) and `retired: {retired_utc, to, reason}` for a version whose parquet
archive thinning removed — the picker says `(retired)` and the header shows a
banner naming the nearest kept version (`to`) to read instead, linked so one
click switches to it. The page keeps working for a retired version because it
only ever reads sidecars.

The pure logic behind all of this — `summarizeSince()`, `summarizeTwin()`, `tableBytes()`,
`shortHash()`, `pickerLabel()`, `retiredInfo()` … — is `release.js` (no DOM),
tested against copies of calcofi4r's fixture catalogs:

```bash
node --check app.js release.js
node --test                       # test/release.test.js
```

## Local development

```bash
bundle install
bundle exec jekyll serve --baseurl ""
# → http://localhost:4000
```

The site fetches everything from public GCS, so you can iterate on the
UI against live release data with no auth. `window.SCHEMA_GCS_BASE`
(set from `_config.yml`'s `gcs_releases_base` in the layout) is the one
knob for pointing it at a different bucket or a local mirror.

## Sibling sites

- [`calcofi.io/db-query`](https://github.com/CalCOFI/db-query) — DuckDB-WASM
  query playground (pre-baked + free-form SQL)
- [`calcofi.io/docs`](https://github.com/CalCOFI/docs) — long-form
  documentation
- [`calcofi.io/calcofi4r`](https://github.com/CalCOFI/calcofi4r) — R
  package
