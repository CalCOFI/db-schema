# CalCOFI Schema

Browse the schema of every CalCOFI database release — tables, columns,
ER diagram, datasets and measurement types — at
[**calcofi.io/schema**](https://calcofi.io/schema/).

The site is a static Jekyll page that consumes the per-release sidecars
uploaded to `gs://calcofi-db/ducklake/releases/{version}/` by
[CalCOFI/workflows](https://github.com/CalCOFI/workflows):

| File                  | Tab           | Notes                              |
|-----------------------|---------------|------------------------------------|
| `erd.mmd`             | Diagram       | Mermaid string from `cc_erd()`     |
| `metadata.json`       | Tables, Columns, Datasets, Measurements | descriptions + units + types |
| `relationships.json`  | (driver of `erd.mmd`) |                            |
| `catalog.json`        | release-meta header | row counts + total size      |
| `RELEASE_NOTES.md`    | release-meta header | inline rendered with marked |
| `versions.json` + `latest.txt` (one folder up) | version dropdown |               |

Switching the version dropdown re-fetches the per-version files and
re-renders the active tab. Default version = whatever `latest.txt` points
at (gated by `test_release.qmd` in the workflows repo).

## Local development

```bash
bundle install
bundle exec jekyll serve --baseurl ""
# → http://localhost:4000
```

The site fetches everything from public GCS, so you can iterate on the
UI against live release data with no auth.

## Sibling sites

- [`calcofi.io/query`](https://github.com/CalCOFI/query) — DuckDB-WASM
  query playground (pre-baked + free-form SQL)
- [`calcofi.io/docs`](https://github.com/CalCOFI/docs) — long-form
  documentation
- [`calcofi.io/calcofi4r`](https://github.com/CalCOFI/calcofi4r) — R
  package
