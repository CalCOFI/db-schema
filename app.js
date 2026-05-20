// CalCOFI Schema — client-side schema browser
//
// Fetches per-release sidecars from GCS (metadata.json, erd.mmd,
// relationships.json, catalog.json, RELEASE_NOTES.md), populates the
// version dropdown from versions.json + latest.txt, and renders five
// tabs: ERD (Mermaid + svg-pan-zoom), Tables, Columns, Datasets,
// Measurement types. Vanilla ES module — no framework, no DuckDB-WASM.
//
// State is intentionally global on `window.SchemaApp` so the browser
// devtools can poke at it.

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
};

// ─── utility ────────────────────────────────────────────────────────────

function setStatus(msg, cls = "muted") {
  const el = $("#status");
  el.textContent = msg;
  el.className = `status ${cls}`;
}

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}
async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

function fmtBytes(n) {
  if (!n) return "—";
  const u = ["B","KB","MB","GB","TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 ? 0 : 1)} ${u[i]}`;
}
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
  sel.innerHTML = State.versions
    .map(v => {
      const isLatest = v.version === State.latestVersion;
      const dateBit  = v.release_date ? ` · ${v.release_date}` : "";
      const star     = isLatest ? "★ " : "";
      return `<option value="${escHtml(v.version)}">${star}${escHtml(v.version)}${escHtml(dateBit)}</option>`;
    })
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
  if (State.byVersion.has(version)) return State.byVersion.get(version);
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
  $("#rm-version").textContent = version;
  $("#rm-date").textContent    = (meta && meta.release_date) || (catalog && catalog.release_date) || "—";
  $("#rm-tables").textContent  = (catalog && Array.isArray(catalog.tables)) ? catalog.tables.length : "—";
  $("#rm-rows").textContent    = fmtInt(catalog && catalog.total_rows);
  $("#rm-size").textContent    = fmtBytes(catalog && catalog.total_size);
  $("#release-meta-panel").hidden = false;

  // modal body — populated here so opening the dialog is just .showModal()
  $("#notes-modal-version").textContent = version;
  const body = $("#notes-modal-body");
  if (blobs.notes) {
    body.innerHTML = mdToHtml(blobs.notes);
  } else {
    body.innerHTML = `<em class="muted">No RELEASE_NOTES.md found for ${escHtml(version)}.</em>`;
  }
}

// ─── header / tab wiring ────────────────────────────────────────────────

function bindHeader() {
  $("#version-select").addEventListener("change", async (e) => {
    State.activeVersion = e.target.value;
    await loadVersion(State.activeVersion);
    renderActiveTab(true);
    syncHash();
  });
  $$("nav.tab-nav .tab").forEach(btn => {
    btn.addEventListener("click", () => {
      State.activeTab = btn.dataset.tab;
      setActiveTabUI(State.activeTab);
      renderActiveTab();
      syncHash();
    });
  });
  $("#theme-toggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("theme", next);
    // re-render ERD on theme change because mermaid bakes colors into the SVG
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
  if (State._rendered[t]) return;
  State._rendered[t] = true;
  switch (t) {
    case "erd":          renderErd(blobs);          break;
    case "tables":       renderTables(blobs);       break;
    case "columns":      renderColumns(blobs);      break;
    case "datasets":     renderDatasets(blobs);     break;
    case "measurements": renderMeasurements(blobs); break;
  }
}

// ─── ERD ────────────────────────────────────────────────────────────────

async function renderErd(blobs) {
  const wrap = $("#erd-svg-wrap");
  wrap.innerHTML = "";
  if (!blobs.erd) {
    wrap.innerHTML = `<div class="muted" style="padding:1rem">erd.mmd not found for this release.</div>`;
    return;
  }
  const theme = document.documentElement.dataset.theme === "light" ? "default" : "dark";
  mermaid.initialize({ startOnLoad: false, theme, securityLevel: "loose" });
  let svg;
  try {
    const { svg: rendered } = await mermaid.render(`erd-${Date.now()}`, blobs.erd);
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
}

// ─── Tables ─────────────────────────────────────────────────────────────

function renderTables(blobs) {
  const meta = blobs.metadata;
  const catalog = blobs.catalog;
  const list = $("#tables-list");
  const tables = Object.entries(meta.tables || {});
  // sort: by name (provider+dataset chip handles grouping visually)
  tables.sort((a, b) => a[0].localeCompare(b[0]));

  const rowsByTable = new Map();
  if (catalog && Array.isArray(catalog.tables)) {
    for (const t of catalog.tables) rowsByTable.set(t.name, t.rows);
  }

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

  list.innerHTML = tables.map(([name, t]) => {
    const cols = colsByTable.get(name) || [];
    const rows = rowsByTable.get(name);
    return `
      <article class="card" data-table-name="${escHtml(name)}">
        <h3>
          <span>${escHtml(name)}</span>
          ${t.name_long ? `<span class="name-long">${escHtml(t.name_long)}</span>` : ""}
        </h3>
        <div class="card-meta">
          ${t.provider ? `<span class="chip">${escHtml(t.provider)}</span>` : ""}
          ${t.dataset  ? `<span class="chip">${escHtml(t.dataset)}</span>`  : ""}
          ${rows != null ? `<span class="chip">${fmtInt(rows)} rows</span>` : ""}
          <span class="chip">${cols.length} cols</span>
        </div>
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

  $("#tables-count").textContent = `${tables.length} tables`;

  // filter input
  $("#tables-filter").oninput = (e) => {
    const q = e.target.value.toLowerCase().trim();
    let visible = 0;
    $$("#tables-list .card").forEach(card => {
      const text = card.textContent.toLowerCase();
      const show = !q || text.includes(q);
      card.style.display = show ? "" : "none";
      if (show) visible++;
    });
    $("#tables-count").textContent = `${visible} / ${tables.length} tables`;
  };
}

// ─── Columns (flat sortable table) ──────────────────────────────────────

function renderColumns(blobs) {
  const meta = blobs.metadata;
  const all = Object.entries(meta.columns || {}).map(([key, c]) => {
    const dot = key.indexOf(".");
    return {
      table:       key.slice(0, dot),
      column:      key.slice(dot + 1),
      data_type:   c.data_type || "",
      units:       c.units || "",
      name_long:   c.name_long || "",
      description: c.description_md || "",
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
    let rows = filterQ
      ? all.filter(r =>
          (r.table + " " + r.column + " " + r.units + " " + r.data_type +
           " " + r.name_long + " " + r.description).toLowerCase().includes(filterQ))
      : all.slice();
    rows.sort((a, b) => {
      const av = (a[sortKey] || "").toString();
      const bv = (b[sortKey] || "").toString();
      return sortDir * av.localeCompare(bv);
    });
    current = rows;
    paint(rows);
  }

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

function renderDatasets(blobs) {
  const meta = blobs.metadata;
  const list = $("#datasets-list");
  const datasets = Object.entries(meta.datasets || {});
  datasets.sort((a, b) => a[0].localeCompare(b[0]));
  list.innerHTML = datasets.map(([key, d]) => {
    const links = [];
    if (d.link_calcofi_org) links.push(`<a href="${escHtml(d.link_calcofi_org)}" target="_blank">calcofi.org</a>`);
    if (d.link_data_source) links.push(`<a href="${escHtml(d.link_data_source)}" target="_blank">data source</a>`);
    return `
      <article class="card">
        <h3>
          <span>${escHtml(d.provider || "")} / ${escHtml(d.dataset || "")}</span>
          ${d.dataset_name ? `<span class="name-long">${escHtml(d.dataset_name)}</span>` : ""}
        </h3>
        <div class="card-meta">
          ${d.coverage_temporal ? `<span class="chip">${escHtml(d.coverage_temporal)}</span>` : ""}
          ${d.coverage_spatial  ? `<span class="chip">${escHtml(d.coverage_spatial)}</span>`  : ""}
          ${d.license           ? `<span class="chip">${escHtml(d.license)}</span>`           : ""}
        </div>
        <div class="desc">${mdToHtml(d.description || "")}</div>
        ${d.citation_main ? `<div class="desc"><strong>Cite:</strong> ${mdToHtml(d.citation_main)}</div>` : ""}
        ${d.pi_names ? `<div class="desc muted"><strong>PI:</strong> ${escHtml(d.pi_names)}</div>` : ""}
        ${links.length ? `<div class="links">${links.join("")}</div>` : ""}
      </article>
    `;
  }).join("");
}

// ─── Measurement types ──────────────────────────────────────────────────

function renderMeasurements(blobs) {
  const meta = blobs.metadata;
  const all = Object.entries(meta.measurement_types || {}).map(([k, v]) => ({
    measurement_type: k,
    description:      v.description || "",
    units:            v.units || "",
    is_canonical:     !!v.is_canonical,
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
    let rows = all.slice();
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
        <td>${escHtml(r.description)}</td>
      </tr>
    `).join("");
    $("#meas-count").textContent = `${rows.length} / ${all.length} types`;
  }

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
