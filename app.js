// CalCOFI Schema — client-side schema browser
//
// Fetches per-release sidecars from GCS (metadata.json, erd.mmd,
// relationships.json, catalog.json, RELEASE_NOTES.md), populates the
// version dropdown from versions.json + latest.txt, and renders five
// tabs: ERD (Mermaid + svg-pan-zoom), Tables, Columns, Datasets,
// Measurement types. Vanilla ES module — no framework, no DuckDB-WASM.
//
// State is intentionally global on `window.SchemaApp` so the browser
// devtools can poke at it. The pure catalog.json / versions.json helpers
// (since summaries, bytes, hash prefix, picker labels, retired/consolidated
// flags) live in release.js, which has no DOM so `node --test` can cover them.

import {
  summarizeSince, sinceStats, summarizeTwin, twinInfo, tableBytes, shortHash,
  fmtBytes, catalogTotals, versionEntry, isConsolidated, retiredInfo,
  retiredDate, pickerLabel,
} from "./release.js";

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

// GCS base from Jekyll config → injected via inline script tag below
const GCS = window.SCHEMA_GCS_BASE
         || "https://storage.googleapis.com/calcofi-db/ducklake/releases";

const State = window.SchemaApp = {
  versions:        [],     // [{version, release_date, ...}, ...]
  latestVersion:   null,   // resolved from latest.txt
  activeVersion:   null,
  activeTab:       "erd",
  byVersion:       new Map(), // version → {metadata, erd, relationships, catalog, notes}
  filters:         new Set(), // active "provider_dataset" tag filters (OR across)
  datasetColor:    {},        // provider_dataset → hex (from metadata.erd_legend)
  _apply:          {},        // tab → fn re-applying text+tag filters for that tab
  showSupplemental: false,    // supplemental tables hidden from ERD/Tables/Columns
};

// Supplemental tables (obs_ctd_full ~212M scans, obs_mets_full ~20M) are hosted
// and downloadable, but they are an opt-in deep dive rather than part of "the
// schema": left in, they dominate the ERD and every row count. Sourced from
// catalog.json rather than a hardcoded list, so a newly-declared one is hidden
// without editing this file.
function supplementalTables(blobs) {
  const c = blobs && blobs.catalog;
  if (!c || !Array.isArray(c.tables)) return new Set();
  return new Set(c.tables.filter(t => t.supplemental).map(t => t.name));
}
function isHiddenTable(name, blobs) {
  return !State.showSupplemental && supplementalTables(blobs).has(name);
}

// ─── utility ────────────────────────────────────────────────────────────

function setStatus(msg, cls = "muted") {
  const el = $("#status");
  el.textContent = msg;
  el.className = `status ${cls}`;
}

// revalidate sidecars (conditional GET → 304 when unchanged) so a re-uploaded
// release (same URL, new content) is picked up without waiting out the GCS
// max-age=3600 cache. "no-cache" still lets the browser reuse a validated copy.
async function fetchText(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}
async function fetchJson(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

// fmtBytes lives in release.js (the twin chip text needs it there)
function fmtInt(n) {
  if (n == null) return "—";
  return Number(n).toLocaleString();
}
function safeText(s) { return (s == null) ? "" : String(s); }
function escHtml(s) {
  return safeText(s)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
function mdToHtml(s) {
  if (!s) return "";
  try   { return marked.parse(s, { breaks: false }); }
  catch { return escHtml(s); }
}

// ─── tag filtering (shared across tabs) ───────────────────────────────────

// the provider_dataset tags a table belongs to. Prefers the authoritative
// contributions block (multi-dataset for shared tables); falls back to the
// table's own provider/dataset. Returns a (possibly empty) array.
function tableDatasets(name, blobs) {
  const meta = blobs.metadata || {};
  const contrib = (meta.contributions || {})[name];
  if (contrib && Array.isArray(contrib.by_dataset) && contrib.by_dataset.length) {
    return contrib.by_dataset.map(c => c.provider_dataset).filter(Boolean);
  }
  const t = (meta.tables || {})[name];
  if (t && t.provider && t.dataset) return [`${t.provider}_${t.dataset}`];
  return [];
}

// does a node (tagged with data-datasets="a b c") pass the active tag filter?
function passesTags(datasets) {
  if (State.filters.size === 0) return true;
  return (datasets || []).some(d => State.filters.has(d));
}

function tagAttr(datasets) {
  return `data-datasets="${escHtml((datasets || []).join(" "))}"`;
}

// ─── per-table dataset contribution bar ───────────────────────────────────

// a horizontal stacked bar of a table's row-count contributions by dataset,
// colored via the erd_legend (State.datasetColor). Segment WIDTH is the
// normalized row share (always sums to 100%, even when a shared vocabulary is
// over-attributed) while the hover tooltip reports the attributed rows + pct.
// Most impactful on the consolidated obs / sample / obs_freq / sample_measurement
// tables where several datasets genuinely stack.
function contribBar(name, blobs) {
  const c = ((blobs.metadata || {}).contributions || {})[name];
  if (!c || !Array.isArray(c.by_dataset)) return "";
  const by = c.by_dataset.filter(b => (b.rows || 0) > 0);
  if (!by.length) return "";
  const total = by.reduce((s, b) => s + (b.rows || 0), 0) || 1;
  const segs = by.slice().sort((a, b) => b.rows - a.rows).map(b => {
    const w   = Math.max(0.6, (b.rows / total) * 100);   // keep tiny slices visible
    const col = State.datasetColor[b.provider_dataset] || "var(--muted)";
    const pct = (b.pct != null) ? b.pct : Math.round((b.rows / total) * 1000) / 10;
    const tip = `${b.provider_dataset}: ${fmtInt(b.rows)} rows (${pct}%)`;
    return `<span class="contrib-seg" style="width:${w}%;background:${escHtml(col)}"`
         + ` data-dataset="${escHtml(b.provider_dataset)}" title="${escHtml(tip)}"></span>`;
  }).join("");
  const warn = c.over_attributed
    ? `<span class="contrib-warn" title="datasets share this vocabulary; attributed rows exceed the table total">⚠</span>`
    : "";
  const n = by.length;
  const lbl = `${n} dataset${n === 1 ? "" : "s"} · ${fmtInt(c.total_rows != null ? c.total_rows : total)} rows`;
  return `<div class="contrib" data-table="${escHtml(name)}">`
       + `<div class="contrib-bar" role="img" aria-label="dataset row contributions for ${escHtml(name)}">${segs}</div>`
       + `<div class="contrib-cap muted">${lbl}${warn}</div></div>`;
}

// tie the contribution bars into the shared dataset filter: dim the segments
// that don't belong to any active filter (call after each tab's filter apply).
function highlightContrib() {
  const active = State.filters;
  $$(".contrib-bar").forEach(bar => {
    const segs = $$(".contrib-seg", bar);
    if (!active.size) {
      bar.classList.remove("dim-others");
      segs.forEach(s => s.classList.remove("on"));
      return;
    }
    bar.classList.add("dim-others");
    segs.forEach(s => s.classList.toggle("on", active.has(s.dataset.dataset)));
  });
}

// toggle a dataset tag and re-apply the current tab's filter
function toggleFilter(ds) {
  if (State.filters.has(ds)) State.filters.delete(ds);
  else                       State.filters.add(ds);
  applyForCurrentTab();
}

function applyForCurrentTab() {
  updateFilterBarUI();
  const fn = State._apply[State.activeTab];
  if (typeof fn === "function") fn();
}

// ─── global filter bar ────────────────────────────────────────────────────

function renderFilterBar(blobs) {
  const bar  = $("#global-filter-bar");
  const wrap = $("#filter-chips");
  if (!bar || !wrap) return;
  const datasets = Object.keys((blobs.metadata || {}).datasets || {}).sort();
  if (!datasets.length) { bar.hidden = true; return; }
  // drop any active filters not present in this version
  for (const f of [...State.filters]) if (!datasets.includes(f)) State.filters.delete(f);
  wrap.innerHTML = datasets.map(d => {
    const col = State.datasetColor[d];
    const sw  = col ? `<span class="ds-swatch" style="background:${escHtml(col)}"></span>` : "";
    return `<button type="button" class="filter-chip" data-dataset="${escHtml(d)}">${sw}${escHtml(d)}</button>`;
  }).join("");
  bar.hidden = false;

  // supplemental toggle — only shown when this release actually has one
  const supp = supplementalTables(blobs);
  const tw = $("#supp-toggle-wrap");
  if (tw) {
    tw.hidden = supp.size === 0;
    const hint = $("#supp-hint");
    if (hint) hint.textContent = supp.size ? `(${[...supp].sort().join(", ")})` : "";
    const cb = $("#supp-toggle");
    if (cb && !cb.dataset.ccWired) {
      cb.dataset.ccWired = "1";
      cb.checked = State.showSupplemental;
      cb.addEventListener("change", () => {
        State.showSupplemental = cb.checked;
        // every tab's content changes, so bust the render cache for all of them
        State._rendered = {};
        renderActiveTab(true);
      });
    }
  }
  updateFilterBarUI();
}

function updateFilterBarUI() {
  $$("#filter-chips .filter-chip").forEach(b => {
    b.classList.toggle("active", State.filters.has(b.dataset.dataset));
  });
  const clear = $("#filter-clear");
  if (clear) clear.hidden = State.filters.size === 0;
}

// ─── initial load ───────────────────────────────────────────────────────

async function init() {
  setStatus("Loading versions…");

  // versions + latest in parallel
  let versionsJson, latestTxt;
  try {
    [versionsJson, latestTxt] = await Promise.all([
      fetchJson(`${GCS}/versions.json`),
      fetchText(`${GCS}/latest.txt`)
    ]);
  } catch (e) {
    setStatus(`Failed to load versions: ${e.message}`, "error");
    return;
  }

  State.versions      = versionsJson.versions || [];
  State.latestVersion = latestTxt.trim();

  // populate dropdown
  const sel = $("#version-select");
  // label rules (★ latest, date only when it differs from the CalVer,
  // "(retired)" / "(consolidated)" from versions.json) are pickerLabel()
  sel.innerHTML = State.versions
    .map(v => `<option value="${escHtml(v.version)}">${escHtml(pickerLabel(v, State.latestVersion))}</option>`)
    .join("");

  // resolve initial version + tab from URL hash, else fall back to latest
  const fromHash = parseHash();
  State.activeVersion = fromHash.version
                     && State.versions.some(v => v.version === fromHash.version)
                       ? fromHash.version
                       : State.latestVersion;
  State.activeTab     = ["erd","tables","columns","datasets","measurements"]
                          .includes(fromHash.tab) ? fromHash.tab : "erd";
  sel.value = State.activeVersion;

  bindHeader();
  setActiveTabUI(State.activeTab);
  await loadVersion(State.activeVersion);
  renderActiveTab();
  syncHash();
}

function parseHash() {
  const h = (location.hash || "").replace(/^#/, "");
  if (!h) return {};
  const [tab, qs] = h.split("?");
  const params = new URLSearchParams(qs || "");
  return { tab, version: params.get("v") };
}
function syncHash() {
  const qs = State.activeVersion ? `?v=${encodeURIComponent(State.activeVersion)}` : "";
  history.replaceState(null, "", `#${State.activeTab}${qs}`);
}

// ─── per-version fetch ──────────────────────────────────────────────────

async function loadVersion(version) {
  if (State.byVersion.has(version)) {
    // cached blobs still need the header re-painted: switching A → B → A used
    // to leave B's version/date/rows, filter bar — and now B's retired banner —
    // on screen, because only the fetch path ever called renderReleaseMeta()
    const cached = State.byVersion.get(version);
    setStatus(`${version} loaded`, "muted");
    renderReleaseMeta(version, cached);
    return cached;
  }
  setStatus(`Loading ${version}…`);
  const base = `${GCS}/${encodeURIComponent(version)}`;
  // notes + relationships + erd are optional; metadata + catalog are required
  const tasks = {
    metadata:      fetchJson(`${base}/metadata.json`),
    catalog:       fetchJson(`${base}/catalog.json`),
    relationships: fetchJson(`${base}/relationships.json`).catch(() => null),
    erd:           fetchText(`${base}/erd.mmd`).catch(() => null),
    notes:         fetchText(`${base}/RELEASE_NOTES.md`).catch(() => null),
  };
  const out = {};
  for (const k of Object.keys(tasks)) {
    try { out[k] = await tasks[k]; }
    catch (e) {
      if (k === "metadata" || k === "catalog") {
        setStatus(`Required sidecar missing for ${version}: ${e.message}`, "error");
        throw e;
      }
      out[k] = null;
    }
  }
  State.byVersion.set(version, out);
  setStatus(`${version} loaded`, "muted");
  renderReleaseMeta(version, out);
  return out;
}

function renderReleaseMeta(version, blobs) {
  const meta    = blobs.metadata;
  const catalog = blobs.catalog;
  // totals fall back to sums over tables[] (a canonical catalog may omit them)
  const totals  = catalogTotals(catalog);
  $("#rm-version").textContent = version;
  $("#rm-date").textContent    = (meta && meta.release_date) || (catalog && catalog.release_date) || "—";
  $("#rm-tables").textContent  = catalog ? totals.tables : "—";
  $("#rm-rows").textContent    = fmtInt(totals.rows);
  $("#rm-size").textContent    = fmtBytes(totals.bytes);
  renderVersionFlags(version, catalog);
  $("#release-meta-panel").hidden = false;
  // RELEASES.md (one folder up) is the cross-release changelog that every
  // per-version RELEASE_NOTES.md is a section of; honour the GCS base override
  for (const a of $$("a.releases-md-link")) a.href = `${GCS}/RELEASES.md`;

  // modal body — populated here so opening the dialog is just .showModal()
  $("#notes-modal-version").textContent = version;
  const body = $("#notes-modal-body");
  if (blobs.notes) {
    body.innerHTML = mdToHtml(blobs.notes);
  } else {
    body.innerHTML = `<em class="muted">No RELEASE_NOTES.md found for ${escHtml(version)}.</em>`;
  }

  // dataset → color map (defensive: erd_legend is new; old releases lack it)
  State.datasetColor = {};
  for (const e of (meta && meta.erd_legend) || []) {
    if (e && e.provider_dataset) State.datasetColor[e.provider_dataset] = e.color;
  }
  renderFilterBar(blobs);
}

// `consolidated` / `retired` come from versions.json (known before the version
// is loaded); `layout` from catalog.json. A retired version's parquet is gone
// but its sidecars are not, so the page keeps working — the banner says which
// kept version to read instead and links to it in the picker.
function renderVersionFlags(version, catalog) {
  const entry   = versionEntry(State.versions, version);
  const retired = retiredInfo(entry);
  const flags   = [];
  if (isConsolidated(entry)) {
    flags.push(`<span class="rm-flag consolidated" title="Consolidated release: its parquet is kept indefinitely, never removed by archive thinning.">consolidated</span>`);
  }
  if (retired) {
    flags.push(`<span class="rm-flag retired" title="Parquet removed by archive thinning${retiredDate(retired) ? ` on ${escHtml(retiredDate(retired))}` : ""}; sidecars only.">retired</span>`);
  }
  if (catalog && catalog.layout) {
    flags.push(`<span class="rm-flag layout" title="catalog.json layout: ${escHtml(catalog.layout)}. Parquet is content-addressed — each table's objects[] carry bytes, content_hash and the release (since) that first shipped those bytes; the Tables tab shows them.">${escHtml(catalog.layout)}</span>`);
  }
  const fl = $("#rm-flags");
  if (fl) fl.innerHTML = flags.join("");

  const banner = $("#retired-banner");
  if (!banner) return;
  if (!retired) { banner.hidden = true; banner.innerHTML = ""; return; }
  const to     = retired.to ? String(retired.to) : "";
  const known  = to && State.versions.some(v => v.version === to);
  const toHtml = !to   ? `<span class="muted">(no replacement recorded)</span>`
               : known ? `<a href="#${escHtml(State.activeTab)}?v=${encodeURIComponent(to)}" data-goto-version="${escHtml(to)}">${escHtml(to)}</a>`
               :         `<span class="mono">${escHtml(to)}</span>`;
  const when   = retiredDate(retired);
  const reason = retired.reason ? ` <span class="reason">(${escHtml(retired.reason)})</span>` : "";
  banner.innerHTML = `<strong>Data retired${when ? ` ${escHtml(when)}` : ""}</strong> — parquet removed; read ${toHtml}${reason}.`
                   + ` <span class="muted">What is shown here is this version's schema, notes and relationships from its sidecars.</span>`;
  banner.hidden = false;
}

// ─── header / tab wiring ────────────────────────────────────────────────

// switch the active release: the picker's change event, or the retired
// banner's "read vX" link
async function switchVersion(version) {
  if (!version || !State.versions.some(v => v.version === version)) return;
  State.activeVersion = version;
  const sel = $("#version-select");
  if (sel && sel.value !== version) sel.value = version;
  await loadVersion(version);
  // a version switch changes every tab's data; drop ALL per-tab render caches
  // so each tab rebuilds fresh on next view (not just the active one). Without
  // this, a previously-viewed tab keeps the prior version's DOM while the
  // rebuilt filter bar advertises the new version's datasets → filtering by a
  // dataset absent from the stale DOM silently matches nothing.
  State._rendered = {};
  renderActiveTab(true);
  syncHash();
}

function bindHeader() {
  $("#version-select").addEventListener("change", (e) => switchVersion(e.target.value));
  // the banner link switches the picker rather than navigating (nothing listens
  // to hashchange); its href is still a real deep link for copying
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-goto-version]");
    if (!a) return;
    e.preventDefault();
    switchVersion(a.dataset.gotoVersion);
  });
  $$("nav.tab-nav .tab").forEach(btn => {
    btn.addEventListener("click", () => {
      State.activeTab = btn.dataset.tab;
      setActiveTabUI(State.activeTab);
      renderActiveTab();
      syncHash();
    });
  });
  // the toggle itself is wired by brand/v2 theme.js; it announces a change on
  // `cc:theme`, and the ERD re-renders because mermaid bakes colors into the SVG
  document.addEventListener("cc:theme", () => {
    if (State.activeTab === "erd") renderActiveTab(true);
  });
  const notesModal = $("#notes-modal");
  $("#rm-notes-toggle").addEventListener("click", () => {
    if (typeof notesModal.showModal === "function") notesModal.showModal();
    else notesModal.setAttribute("open", "");   // graceful fallback for <dialog>-less browsers
  });
  $("#notes-modal-close").addEventListener("click", () => notesModal.close());
  // click outside the content area closes the modal
  notesModal.addEventListener("click", (e) => {
    if (e.target === notesModal) notesModal.close();
  });
  $("#erd-fit").addEventListener("click", () => {
    if (!State._erdPanZoom) return;
    State._erdPanZoom.fit();
    State._erdPanZoom.center();
  });
  // delegated: any clickable dataset tag (filter bar or in-card chip) toggles
  // the corresponding cross-tab filter
  document.addEventListener("click", (e) => {
    const chip = e.target.closest(".filter-chip[data-dataset]");
    if (chip) { toggleFilter(chip.dataset.dataset); }
  });
  $("#filter-clear").addEventListener("click", () => {
    State.filters.clear();
    applyForCurrentTab();
  });
}

function setActiveTabUI(tab) {
  $$("nav.tab-nav .tab").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  $$(".tab-panel").forEach(p => p.hidden = p.dataset.tab !== tab);
}

// `forceRefresh=true` busts the per-tab "already rendered" cache (used when
// switching version or theme)
function renderActiveTab(forceRefresh = false) {
  const blobs = State.byVersion.get(State.activeVersion);
  if (!blobs) return;
  const t = State.activeTab;
  if (forceRefresh) {
    State._rendered = State._rendered || {};
    delete State._rendered[t];
  }
  State._rendered = State._rendered || {};
  if (!State._rendered[t]) {
    State._rendered[t] = true;
    switch (t) {
      case "erd":          renderErd(blobs);          break;
      case "tables":       renderTables(blobs);       break;
      case "columns":      renderColumns(blobs);      break;
      case "datasets":     renderDatasets(blobs);     break;
      case "measurements": renderMeasurements(blobs); break;
    }
  }
  // re-apply active tag filters for the now-active tab (filters may have
  // changed while a different tab was showing)
  const apply = State._apply[t];
  if (typeof apply === "function") apply();
}

// ─── ERD ────────────────────────────────────────────────────────────────

function renderErdLegend(blobs) {
  const el = $("#erd-legend");
  if (!el) return;
  const legend = (blobs.metadata || {}).erd_legend || [];
  if (!legend.length) { el.innerHTML = ""; return; }
  el.innerHTML = legend.map(e =>
    `<span class="erd-legend-item">
       <span class="ds-swatch" style="background:${escHtml(e.color)}"></span>${escHtml(e.provider_dataset)}
     </span>`).join("");
}

// The ERD ships from the release with every table in it, supplemental included.
// Filtering here rather than at release time means the toggle can put them back
// without re-cutting a release. Mermaid ER syntax is line-oriented: an entity
// block opens with `NAME {`, and relationships are a single line naming two
// entities, so both are removable with a line filter.
function erdSource(blobs) {
  const hide = State.showSupplemental ? new Set() : supplementalTables(blobs);
  if (!hide.size) return blobs.erd;
  const out = [];
  let skipDepth = 0;
  for (const line of blobs.erd.split("\n")) {
    if (skipDepth > 0) {                      // inside a hidden entity's block
      if (/^\s*\}/.test(line)) skipDepth--;
      continue;
    }
    const open = line.match(/^\s*([A-Za-z_][\w-]*)\s*\{\s*$/);
    if (open && hide.has(open[1])) { skipDepth++; continue; }
    // `class a,b,c styleName` — a styling directive listing every entity. Left
    // naming a removed one, mermaid has a dangling reference, so prune the list
    // rather than the line (and drop the line only if nothing is left).
    const cls = line.match(/^(\s*class\s+)([\w,\s-]+?)(\s+\S+)\s*$/);
    if (cls) {
      const kept = cls[2].split(",").map(x => x.trim()).filter(x => x && !hide.has(x));
      if (!kept.length) continue;
      out.push(`${cls[1]}${kept.join(",")}${cls[3]}`);
      continue;
    }
    // relationship line: drop it if it names a hidden entity as a whole token
    if (/\|\||\}o|\|\{|o\{|\.\./.test(line) &&
        [...hide].some(h => new RegExp(`(^|[^\\w-])${h}([^\\w-]|$)`).test(line))) continue;
    out.push(line);
  }
  return out.join("\n");
}

async function renderErd(blobs) {
  renderErdLegend(blobs);
  const wrap = $("#erd-svg-wrap");
  wrap.innerHTML = "";
  if (!blobs.erd) {
    wrap.innerHTML = `<div class="muted" style="padding:1rem">erd.mmd not found for this release.</div>`;
    return;
  }
  const theme = (window.ccTheme ? ccTheme.get() : document.documentElement.dataset.theme) === "light" ? "default" : "dark";
  mermaid.initialize({ startOnLoad: false, theme, securityLevel: "loose" });
  let svg;
  try {
    const { svg: rendered } = await mermaid.render(`erd-${Date.now()}`, erdSource(blobs));
    svg = rendered;
  } catch (e) {
    wrap.innerHTML = `<div class="error" style="padding:1rem;color:var(--error)">Mermaid render failed: ${escHtml(e.message)}</div>`;
    return;
  }
  wrap.innerHTML = svg;
  // svg-pan-zoom needs an actual SVG node, not a string
  const svgEl = wrap.querySelector("svg");
  if (svgEl && window.svgPanZoom) {
    svgEl.setAttribute("width", "100%");
    svgEl.setAttribute("height", "100%");
    if (State._erdPanZoom) { try { State._erdPanZoom.destroy(); } catch {} }
    State._erdPanZoom = svgPanZoom(svgEl, {
      panEnabled:    true,
      zoomEnabled:   true,
      controlIconsEnabled: false,
      fit:           true,
      center:        true,
      minZoom:       0.2,
      maxZoom:       8,
      zoomScaleSensitivity: 0.3,
    });
  }
  // make entities clickable (→ table columns) and wire dataset-filter highlight
  decorateErdEntities(blobs);
  State._apply.erd = () => applyErdHighlight(blobs);
  applyErdHighlight(blobs);
}

// entity group ids look like "entity-<table>-<index>"; table names use
// underscores (no hyphens), so strip the prefix and trailing -<index>
function erdEntityName(id) {
  return id.replace(/^entity-/, "").replace(/-\d+$/, "");
}

// make each ER entity clickable: jump to its table's columns
function decorateErdEntities(blobs) {
  $$("#erd-svg-wrap g[id^='entity-']").forEach(g => {
    if (g.dataset.ccWired) return;
    g.dataset.ccWired = "1";
    g.classList.add("erd-entity");
    const name = erdEntityName(g.id);
    // tooltip: table name + dataset(s) on their own line (the pastel stroke
    // colors are hard to tell apart) + the click hint
    const ds = tableDatasets(name, blobs);
    const dsLabel = ds.length ? ds.join(", ") : "—";
    const ttl = document.createElementNS("http://www.w3.org/2000/svg", "title");
    ttl.textContent = `${name}\ndataset: ${dsLabel}`;
    g.appendChild(ttl);
    // NO click-to-navigate. svg-pan-zoom pans on drag and the mouseup still
    // lands on whichever entity is under the cursor, so panning the diagram
    // repeatedly threw the reader onto some unrelated table's columns. The
    // Tables tab has its own jump-to dropdown; that is where navigation lives.
  });
}

// highlight entities (+ their edges) for the active dataset filter; dim the rest
function applyErdHighlight(blobs) {
  if (!$("#erd-svg-wrap svg")) return;
  const active = State.filters.size > 0;
  const dimmed = new Set();
  $$("#erd-svg-wrap g[id^='entity-']").forEach(g => {
    const ds = tableDatasets(erdEntityName(g.id), blobs);
    const match = !active || ds.some(d => State.filters.has(d));
    g.style.opacity = match ? "1" : "0.1";
    g.style.transition = "opacity 0.15s";
    if (!match) dimmed.add(g.id);
  });
  // relationship edge ids embed both entity ids: id_entity-<a>-N_entity-<b>-N_..
  $$("#erd-svg-wrap path[id^='id_entity-']").forEach(p => {
    const touches = [...dimmed].some(eid => p.id.includes(eid));
    p.style.opacity = (active && touches) ? "0.05" : "";
  });
  // FK column labels: dim all when filtering (precise edge mapping not needed)
  $$("#erd-svg-wrap .edgeLabel, #erd-svg-wrap .edgeLabels").forEach(el => {
    el.style.opacity = active ? "0.12" : "";
  });
}

// expand a table's card and scroll to it (the Tables tab jump-to dropdown)
function scrollToTableCard(name) {
  State.activeTab = "tables";
  setActiveTabUI("tables");
  renderActiveTab();
  requestAnimationFrame(() => {
    const sel = `#tables-list .card[data-table-name="${(window.CSS && CSS.escape) ? CSS.escape(name) : name}"]`;
    const card = document.querySelector(sel);
    if (card) {
      const d = card.querySelector("details");
      if (d) d.open = true;
      card.scrollIntoView({ behavior: "smooth", block: "start" });
      card.classList.add("card-flash");
      setTimeout(() => card.classList.remove("card-flash"), 1500);
    }
  });
  syncHash();
}

// ─── Tables ─────────────────────────────────────────────────────────────

// catalog.json tables[] by name (empty for a missing catalog)
function catalogByName(catalog) {
  const m = new Map();
  for (const t of (catalog && Array.isArray(catalog.tables)) ? catalog.tables : []) {
    if (t && t.name) m.set(t.name, t);
  }
  return m;
}

// content-addressed chips (v2026.09+ catalogs): parquet size, what changed in
// this version, the whole-table content_hash prefix (full hash + compat_path in
// the tooltip) and, for a partitioned table that also ships a single-file
// twin, that copy on its own chip. Each comes back empty for a legacy entry,
// so older releases render exactly as before.
function catalogChips(ct, version) {
  if (!ct) return "";
  const out   = [];
  const bytes = tableBytes(ct);
  if (bytes != null) out.push(`<span class="chip" title="parquet bytes for this table">${fmtBytes(bytes)}</span>`);
  const since = summarizeSince(ct, version);
  if (since) {
    const s   = sinceStats(ct, version);
    const cap = 30;
    const tip = (s.n_changed && s.partitioned)
      ? `changed in ${version}: ${s.changed.slice(0, cap).join(", ")}${s.changed.length > cap ? ` … +${s.changed.length - cap} more` : ""}`
      : s.n_changed ? `these bytes were first shipped by ${version}`
                    : `these bytes were first shipped by ${s.since_max}; ${version} re-uses them`;
    out.push(`<span class="chip chip-since${s.n_changed ? " changed" : ""}" title="${escHtml(tip)}">${escHtml(since)}</span>`);
  }
  const hash = shortHash(ct.content_hash);
  if (hash) {
    const compat = ct.compat_path || ((ct.objects || []).find(o => o && o.compat_path) || {}).compat_path;
    const tip = `content_hash ${ct.content_hash} — whole-table signature; equal across releases when the bytes are`
              + (compat ? `\ncompat_path: ${compat}` : "");
    out.push(`<span class="chip chip-hash" title="${escHtml(tip)}">${escHtml(hash)}</span>`);
  }
  const twin = summarizeTwin(ct);
  if (twin) {
    const tw  = twinInfo(ct);
    const tip = [`single-file copy of the partitioned table`,
                 tw.content_hash ? `content_hash ${tw.content_hash}` : "",
                 tw.path         ? `path: ${tw.path}` : "",
                 tw.compat_path  ? `compat_path: ${tw.compat_path}` : ""].filter(Boolean).join("\n");
    out.push(`<span class="chip chip-twin" title="${escHtml(tip)}">${escHtml(twin)}</span>`);
  }
  return out.join("");
}

// `deprecated`/`replaced_by`/`removed_in` on a catalog.json table entry
// (WS-H1, calcofi4db ≥ 3.31.0: `obs` while `obs_bio`+`obs_env` ship it too).
// Empty for older catalogs and for a table that isn't deprecated.
function deprecatedChip(ct) {
  if (!ct || !ct.deprecated) return "";
  const by  = Array.isArray(ct.replaced_by) ? ct.replaced_by.join(", ") : (ct.replaced_by || "");
  const tip = `Deprecated${by ? ` — replaced by ${by}` : ""}${ct.removed_in ? `. Objects dropped in release ${ct.removed_in}.` : ""}`;
  return `<span class="chip chip-deprecated" title="${escHtml(tip)}">deprecated${by ? ` → ${escHtml(by)}` : ""}</span>`;
}

function renderTables(blobs) {
  const meta = blobs.metadata;
  const catalog = blobs.catalog;
  const list = $("#tables-list");
  let tables = Object.entries(meta.tables || {});
  // supplemental tables are excluded from the core view entirely — not merely
  // chipped — unless the global toggle asks for them
  tables = tables.filter(([name]) => !isHiddenTable(name, blobs));
  // sort: by name (provider+dataset chip handles grouping visually)
  tables.sort((a, b) => a[0].localeCompare(b[0]));

  const catByTable  = catalogByName(catalog);
  const suppByTable = supplementalTables(blobs);

  // build a per-table column index from metadata.columns ("table.column" key)
  const colsByTable = new Map();
  for (const [key, entry] of Object.entries(meta.columns || {})) {
    const dot = key.indexOf(".");
    if (dot < 0) continue;
    const tbl = key.slice(0, dot);
    const col = key.slice(dot + 1);
    if (!colsByTable.has(tbl)) colsByTable.set(tbl, []);
    colsByTable.get(tbl).push({ column: col, ...entry });
  }

  const knownDatasets = new Set(Object.keys(meta.datasets || {}));
  list.innerHTML = tables.map(([name, t]) => {
    const cols = colsByTable.get(name) || [];
    const ct   = catByTable.get(name);
    const rows = ct ? ct.rows : null;
    const ds   = tableDatasets(name, blobs);
    // one chip per dataset this table belongs to (shared tables get several);
    // clickable only for registered datasets so it ties into the filter bar
    const dsChips = ds.length
      ? ds.map(d => knownDatasets.has(d)
          ? `<button type="button" class="chip filter-chip" data-dataset="${escHtml(d)}">${escHtml(d)}</button>`
          : `<span class="chip">${escHtml(d)}</span>`).join("")
      : [t.provider, t.dataset].filter(Boolean).map(x => `<span class="chip">${escHtml(x)}</span>`).join("");
    return `
      <article class="card" data-table-name="${escHtml(name)}" ${tagAttr(ds)}>
        <h3>
          <span>${escHtml(name)}</span>
          ${t.name_long ? `<span class="name-long">${escHtml(t.name_long)}</span>` : ""}
        </h3>
        <div class="card-meta">
          ${dsChips}
          ${rows != null ? `<span class="chip">${fmtInt(rows)} rows</span>` : ""}
          <span class="chip">${cols.length} cols</span>
          ${catalogChips(ct, State.activeVersion)}
          ${suppByTable.has(name) ? `<span class="chip chip-supp" title="Supplemental table: hosted + downloadable and tagged to this release, but excluded from the ERD and hidden by cc_get_db() unless supplemental=TRUE.">supplemental</span>` : ""}
          ${deprecatedChip(ct)}
        </div>
        ${contribBar(name, blobs)}
        <div class="desc">${mdToHtml(t.description_md)}</div>
        <details>
          <summary class="col-toggle">columns ▾</summary>
          <div class="col-list">
            ${cols.map(c => `
              <div class="col-row">
                <span class="col-name">${escHtml(c.column)}</span>
                <span class="col-type">${escHtml(c.data_type || "")}</span>
                <span class="col-units">${c.units ? escHtml(c.units) : ""}</span>
                <span class="col-desc">${mdToHtml(c.description_md || "")}</span>
              </div>
            `).join("")}
          </div>
        </details>
      </article>
    `;
  }).join("");

  // JUMP-TO dropdown, not a search box. Substring search over card text matched
  // every table that merely *mentioned* another in its description — `obs` and
  // `sample` name each other, every core table names dataset_key — so typing a
  // table name returned most of the schema. A <select> of the actual names
  // cannot do that.
  const jump = $("#tables-jump");
  if (jump) {
    jump.innerHTML = `<option value="">jump to a table…</option>` +
      tables.map(([name]) => `<option value="${escHtml(name)}">${escHtml(name)}</option>`).join("");
    jump.onchange = () => { if (jump.value) scrollToTableCard(jump.value); };
  }

  // tag filter only (registered so the filter bar + tab switches re-apply it)
  const apply = () => {
    let visible = 0;
    $$("#tables-list .card").forEach(card => {
      const ds   = (card.dataset.datasets || "").split(" ").filter(Boolean);
      const show = passesTags(ds);
      card.style.display = show ? "" : "none";
      if (show) visible++;
    });
    $("#tables-count").textContent = `${visible} / ${tables.length} tables`;
    highlightContrib();
  };
  State._apply.tables = apply;
  apply();
}

// ─── Columns (flat sortable table) ──────────────────────────────────────

function renderColumns(blobs) {
  const meta = blobs.metadata;
  const dsCache = new Map();
  const dsFor = (tbl) => {
    if (!dsCache.has(tbl)) dsCache.set(tbl, tableDatasets(tbl, blobs));
    return dsCache.get(tbl);
  };
  const all = Object.entries(meta.columns || {}).filter(([key]) => {
    const dot = key.indexOf(".");
    return dot > 0 && !isHiddenTable(key.slice(0, dot), blobs);
  }).map(([key, c]) => {
    const dot = key.indexOf(".");
    const table = key.slice(0, dot);
    return {
      table,
      column:      key.slice(dot + 1),
      data_type:   c.data_type || "",
      units:       c.units || "",
      name_long:   c.name_long || "",
      description: c.description_md || "",
      datasets:    dsFor(table),
    };
  });
  all.sort((a, b) => a.table.localeCompare(b.table) || a.column.localeCompare(b.column));

  const wrap = $("#columns-tablewrap");
  wrap.innerHTML = `
    <table class="data" id="columns-table">
      <thead>
        <tr>
          <th data-key="table"     aria-sort="ascending">table</th>
          <th data-key="column">column</th>
          <th data-key="data_type">type</th>
          <th data-key="units">units</th>
          <th data-key="description">description</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
  `;
  const tbody = wrap.querySelector("tbody");

  function paint(rows) {
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td class="mono">${escHtml(r.table)}</td>
        <td class="mono">${escHtml(r.column)}${r.name_long ? `<br><span class="muted" style="font-size:0.78rem">${escHtml(r.name_long)}</span>` : ""}</td>
        <td class="mono">${escHtml(r.data_type)}</td>
        <td class="units">${escHtml(r.units)}</td>
        <td>${mdToHtml(r.description)}</td>
      </tr>
    `).join("");
    $("#columns-count").textContent = `${rows.length} / ${all.length} columns`;
  }

  let current = all.slice();
  let filterQ = "";
  let sortKey = "table";
  let sortDir = 1;
  function apply() {
    let rows = all.filter(r => passesTags(r.datasets) && (
      !filterQ ||
      (r.table + " " + r.column + " " + r.units + " " + r.data_type +
       " " + r.name_long + " " + r.description).toLowerCase().includes(filterQ)));
    rows.sort((a, b) => {
      const av = (a[sortKey] || "").toString();
      const bv = (b[sortKey] || "").toString();
      return sortDir * av.localeCompare(bv);
    });
    current = rows;
    paint(rows);
  }
  State._apply.columns = apply;

  $("#columns-filter").oninput = (e) => { filterQ = e.target.value.toLowerCase().trim(); apply(); };
  wrap.querySelectorAll("thead th").forEach(th => {
    th.addEventListener("click", () => {
      const k = th.dataset.key;
      if (sortKey === k) { sortDir = -sortDir; }
      else               { sortKey = k; sortDir = 1; }
      wrap.querySelectorAll("thead th").forEach(x => x.removeAttribute("aria-sort"));
      th.setAttribute("aria-sort", sortDir === 1 ? "ascending" : "descending");
      apply();
    });
  });
  apply();
}

// ─── Datasets ───────────────────────────────────────────────────────────

// SPDX-registered ids among metadata/license.csv's active vocabulary — these
// resolve to a real spdx.org page. `custom` links to the dataset's own
// license_url instead; `US-PD` and `unknown` render as plain chips.
const SPDX_LICENSE_IDS = new Set(["CC-BY-4.0", "CC0-1.0", "CC-BY-NC-4.0", "CC-BY-SA-4.0"]);

function licenseChip(d) {
  if (!d.license) return "";
  const label = escHtml(d.license);
  if (d.license_url) return `<a class="chip" href="${escHtml(d.license_url)}" target="_blank" rel="noopener" title="license terms">${label}</a>`;
  if (SPDX_LICENSE_IDS.has(d.license)) {
    return `<a class="chip" href="https://spdx.org/licenses/${escHtml(d.license)}.html" target="_blank" rel="noopener" title="SPDX license definition">${label}</a>`;
  }
  return `<span class="chip">${label}</span>`;
}

// "How to cite this release" — from catalog.json's `citation` (WS-A0,
// calcofi4db ≥ 3.30.0). Absent on any catalog cut before 2026-09-03, so this
// renders nothing rather than an empty box — no error, no placeholder.
function renderReleaseCitation(blobs) {
  const el = $("#release-citation");
  if (!el) return;
  const catalog = blobs.catalog;
  if (!catalog || !catalog.citation) { el.innerHTML = ""; return; }
  const doiLine = catalog.doi
    ? `<div class="muted mono" style="margin-top:0.3rem">DOI: <a href="https://doi.org/${escHtml(catalog.doi)}" target="_blank" rel="noopener">${escHtml(catalog.doi)}</a></div>`
    : catalog.concept_doi
    ? `<div class="muted mono" style="margin-top:0.3rem">All-versions DOI: <a href="https://doi.org/${escHtml(catalog.concept_doi)}" target="_blank" rel="noopener">${escHtml(catalog.concept_doi)}</a></div>`
    : "";
  el.innerHTML = `
    <article class="card" id="release-citation-card">
      <h3><span>How to cite this release</span></h3>
      <div class="desc">${mdToHtml(catalog.citation)}</div>
      ${doiLine}
    </article>
  `;
}

function renderDatasets(blobs) {
  const meta = blobs.metadata;
  const list = $("#datasets-list");
  renderReleaseCitation(blobs);
  const datasets = Object.entries(meta.datasets || {});
  datasets.sort((a, b) => a[0].localeCompare(b[0]));

  // invert contributions → dataset → [{table, rows, pct, workflow}] and note
  // which tables are shared across >1 dataset (so we show % only when meaningful)
  const contribByDs = {};
  const tableShared = {};
  for (const [tbl, c] of Object.entries(meta.contributions || {})) {
    const by = c.by_dataset || [];
    tableShared[tbl] = by.length > 1;
    for (const bd of by) {
      (contribByDs[bd.provider_dataset] ||= []).push(
        { table: tbl, rows: bd.rows, pct: bd.pct, workflow: bd.workflow });
    }
  }

  const catByTable = catalogByName(blobs.catalog);
  const datasetTablesHtml = (key, d) => {
    const items  = contribByDs[key] || [];
    const byName = new Map(items.map(it => [it.table, it]));
    const names  = [...new Set([...byName.keys(), ...((d.tables) || [])])].sort();
    if (!names.length) return "";
    const li = names.map(tbl => {
      const it   = byName.get(tbl);
      const rows = it && it.rows != null ? ` — ${fmtInt(it.rows)} rows` : "";
      const pct  = (it && tableShared[tbl]) ? ` <span class="muted">(${it.pct}%)</span>` : "";
      // per-table "what changed" from a content-addressed catalog; empty for legacy
      const since = summarizeSince(catByTable.get(tbl), State.activeVersion);
      const sn   = since ? ` <span class="muted since">· ${escHtml(since)}</span>` : "";
      const wf   = (it && it.workflow && it.workflow !== "NA")
        ? ` <a class="ds-wf" href="${escHtml(it.workflow)}" target="_blank" title="ingest workflow">↗</a>` : "";
      // for tables this dataset shares with others, show the full composition bar
      const bar  = tableShared[tbl] ? contribBar(tbl, blobs) : "";
      return `<li><span class="mono">${escHtml(tbl)}</span>${rows}${pct}${sn}${wf}${bar}</li>`;
    }).join("");
    return `<details class="ds-tables"><summary>${names.length} tables ▾</summary><ul>${li}</ul></details>`;
  };

  list.innerHTML = datasets.map(([key, d]) => {
    const links = [];
    if (d.link_calcofi_org) links.push(`<a href="${escHtml(d.link_calcofi_org)}" target="_blank">calcofi.org</a>`);
    if (d.link_data_source) links.push(`<a href="${escHtml(d.link_data_source)}" target="_blank">data source</a>`);
    if (d.workflow_url)     links.push(`<a href="${escHtml(d.workflow_url)}" target="_blank">workflow ↗</a>`);
    if (d.doi)              links.push(`<a href="https://doi.org/${escHtml(d.doi)}" target="_blank">DOI: ${escHtml(d.doi)}</a>`);
    if (d.contact)          links.push(`<a href="${escHtml(d.contact)}" target="_blank">contact</a>`);
    // built from the key, never a hard-coded per-dataset list (plan 2026-09-05 D-4)
    links.push(`<a href="https://calcofi.io/datasets/${escHtml(key)}/" target="_blank">dataset page ↗</a>`);
    const col = State.datasetColor[key];
    const sw  = col ? `<span class="ds-swatch" style="background:${escHtml(col)}"></span>` : "";
    return `
      <article class="card" data-dskey="${escHtml(key)}" ${tagAttr([key])}>
        <h3>
          <span>${sw}${escHtml(d.provider || "")} / ${escHtml(d.dataset || "")}</span>
          ${d.dataset_name ? `<span class="name-long">${escHtml(d.dataset_name)}</span>` : ""}
        </h3>
        <div class="card-meta">
          <button type="button" class="chip filter-chip" data-dataset="${escHtml(key)}">filter ▸ ${escHtml(key)}</button>
          ${d.coverage_temporal ? `<span class="chip">${escHtml(d.coverage_temporal)}</span>` : ""}
          ${d.coverage_spatial  ? `<span class="chip">${escHtml(d.coverage_spatial)}</span>`  : ""}
          ${licenseChip(d)}
        </div>
        <div class="desc">${mdToHtml(d.description || "")}</div>
        ${datasetTablesHtml(key, d)}
        ${d.citation_main ? `<div class="desc"><strong>Cite:</strong> ${mdToHtml(d.citation_main)}</div>` : ""}
        ${d.acknowledgement ? `<div class="desc"><strong>Acknowledgement:</strong> ${mdToHtml(d.acknowledgement)}</div>` : ""}
        ${d.pi_names ? `<div class="desc muted"><strong>PI:</strong> ${escHtml(d.pi_names)}</div>` : ""}
        ${links.length ? `<div class="links">${links.join("")}</div>` : ""}
      </article>
    `;
  }).join("");

  // tag filter for dataset cards (a card shows if its own key is selected)
  State._apply.datasets = () => {
    $$("#datasets-list .card").forEach(card => {
      const ds = (card.dataset.datasets || "").split(" ").filter(Boolean);
      card.style.display = passesTags(ds) ? "" : "none";
    });
    highlightContrib();
  };
  State._apply.datasets();
}

// ─── Measurement types ──────────────────────────────────────────────────

function renderMeasurements(blobs) {
  const meta = blobs.metadata;
  const knownDatasets = new Set(Object.keys(meta.datasets || {}));
  const all = Object.entries(meta.measurement_types || {}).map(([k, v]) => ({
    measurement_type: k,
    description:      v.description || "",
    units:            v.units || "",
    is_canonical:     !!v.is_canonical,
    // datasets may arrive as a JSON array or — when jsonlite auto_unbox collapses
    // a length-1 vector — a bare string; normalize both to an array so the
    // dataset filter (and the datasets column) work
    datasets:         Array.isArray(v.datasets) ? v.datasets
                       : (v.datasets ? [v.datasets] : []),
  }));
  all.sort((a, b) => a.measurement_type.localeCompare(b.measurement_type));

  const wrap = $("#meas-tablewrap");
  wrap.innerHTML = `
    <table class="data" id="meas-table">
      <thead>
        <tr>
          <th data-key="measurement_type" aria-sort="ascending">measurement_type</th>
          <th data-key="units">units</th>
          <th data-key="is_canonical">canonical</th>
          <th data-key="datasets">datasets</th>
          <th data-key="description">description</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
  `;
  const tbody = wrap.querySelector("tbody");
  let filterQ = "";
  let canonicalOnly = false;
  let sortKey = "measurement_type";
  let sortDir = 1;

  function apply() {
    let rows = all.filter(r => passesTags(r.datasets));
    if (canonicalOnly) rows = rows.filter(r => r.is_canonical);
    if (filterQ) rows = rows.filter(r =>
      (r.measurement_type + " " + r.units + " " + r.description).toLowerCase().includes(filterQ));
    rows.sort((a, b) => {
      const av = (a[sortKey] ?? "").toString();
      const bv = (b[sortKey] ?? "").toString();
      return sortDir * av.localeCompare(bv);
    });
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td class="mono">${escHtml(r.measurement_type)}</td>
        <td class="units">${escHtml(r.units)}</td>
        <td>${r.is_canonical ? `<span class="badge canonical">canonical</span>` : `<span class="badge">variant</span>`}</td>
        <td class="meas-datasets">${r.datasets.length
          ? r.datasets.map(d => {
              const col = State.datasetColor[d];
              const sw  = col ? `<span class="ds-swatch" style="background:${escHtml(col)}"></span>` : "";
              return knownDatasets.has(d)
                ? `<button type="button" class="chip filter-chip" data-dataset="${escHtml(d)}">${sw}${escHtml(d)}</button>`
                : `<span class="chip">${sw}${escHtml(d)}</span>`;
            }).join(" ")
          : `<span class="muted">—</span>`}</td>
        <td>${escHtml(r.description)}</td>
      </tr>
    `).join("");
    $("#meas-count").textContent = `${rows.length} / ${all.length} types`;
  }
  State._apply.measurements = apply;

  $("#meas-filter").oninput = (e)         => { filterQ = e.target.value.toLowerCase().trim(); apply(); };
  $("#meas-canonical-only").onchange = (e) => { canonicalOnly = e.target.checked; apply(); };
  wrap.querySelectorAll("thead th").forEach(th => {
    th.addEventListener("click", () => {
      const k = th.dataset.key;
      if (sortKey === k) { sortDir = -sortDir; }
      else               { sortKey = k; sortDir = 1; }
      wrap.querySelectorAll("thead th").forEach(x => x.removeAttribute("aria-sort"));
      th.setAttribute("aria-sort", sortDir === 1 ? "ascending" : "descending");
      apply();
    });
  });
  apply();
}

// ─── kick off ───────────────────────────────────────────────────────────

init();
