/* Matt Training Log — PWA (Phase 1)
 *
 * A thin client over the training repo. It does NO progression math: it reads the
 * prescription the PC engine emits (docs/today.json) and writes back a LOG block
 * in exactly the grammar engine/parse_log.py accepts (inbox/session-<n>-<date>.md).
 * The PC still runs log_session.py / analyze.py.
 *
 * Transport: GitHub Contents API with a fine-grained, single-repo token kept in
 * localStorage on this device only.
 */

const LS = {
  cfg: "mtl.cfg",
  today: "mtl.today",       // last good today.json (offline fallback)
  draft: "mtl.draft.",      // + session number
  submitted: "mtl.submitted",  // JSON array of session numbers submitted from this device
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// HTML-escape every dynamic value before it goes into innerHTML or an attribute.
// today.json is engine-authored, but it arrives over the network into a page that
// holds a GitHub PAT in localStorage — an injected <script>/onerror could exfiltrate
// it. FORM values are user-typed. Escaping both closes that XSS→token-theft chain.
const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = s => String(s ?? "").replace(/[&<>"']/g, ch => ESC_MAP[ch]);

// ---------------------------------------------------------------- config ----
function loadCfg() {
  try { return JSON.parse(localStorage.getItem(LS.cfg)) || {}; }
  catch { return {}; }
}
function saveCfg(c) { localStorage.setItem(LS.cfg, JSON.stringify(c)); }

function cfgComplete(c) { return c.token && c.owner && c.repo; }

// ------------------------------------------------------------- GitHub API ----
function apiBase(c) {
  return `https://api.github.com/repos/${c.owner}/${c.repo}/contents`;
}
function ghHeaders(c, accept) {
  return { Authorization: `Bearer ${c.token}`, Accept: accept,
           "X-GitHub-Api-Version": "2022-11-28" };
}

async function ghGetRaw(c, path) {
  const url = `${apiBase(c)}/${path}?ref=${encodeURIComponent(c.branch || "master")}`;
  const r = await fetch(url, { headers: ghHeaders(c, "application/vnd.github.raw+json") });
  if (r.status === 404) throw new Error(`Not found: ${path}`);
  if (r.status === 401) throw new Error("Bad token (401)");
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  return r.text();
}

async function ghGetSha(c, path) {
  const url = `${apiBase(c)}/${path}?ref=${encodeURIComponent(c.branch || "master")}`;
  const r = await fetch(url, { headers: ghHeaders(c, "application/vnd.github+json") });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  return (await r.json()).sha;
}

function toBase64(str) {
  // UTF-8 safe base64 encode. TextEncoder yields the UTF-8 bytes directly,
  // replacing the deprecated unescape(encodeURIComponent(...)) idiom.
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function ghPutFile(c, path, text, message) {
  const sha = await ghGetSha(c, path);          // overwrite if a resubmit
  const url = `${apiBase(c)}/${path}`;
  const body = { message, content: toBase64(text), branch: c.branch || "master" };
  if (sha) body.sha = sha;
  const r = await fetch(url, {
    method: "PUT", headers: ghHeaders(c, "application/vnd.github+json"),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Write failed: GitHub ${r.status}`);
  return r.json();
}

// ------------------------------------------------------------- app state ----
let DATA = null;     // parsed today.json
let GYM = null;      // chosen gym for the session
let FORM = {};       // per-lift form state keyed by lift index

// ----------------------------------------------------------- data loading ----
async function fetchToday() {
  const c = loadCfg();
  const status = $("#todayStatus");
  if (!cfgComplete(c)) {
    if (await loadLocalSample(status)) return;   // bundled today.json, if present
    status.textContent = "Add your GitHub token in Settings to load today's plan.";
    showCachedToday();
    return;
  }
  status.textContent = "Loading…"; status.className = "status";
  try {
    const text = await ghGetRaw(c, c.dataPath || "docs/today.json");
    DATA = JSON.parse(text);
    localStorage.setItem(LS.today, text);
    status.textContent = ""; status.className = "status";
    renderToday(); renderLog();
  } catch (e) {
    status.textContent = `${e.message}. Showing last saved plan.`;
    status.className = "status err";
    showCachedToday();
  }
}

async function loadLocalSample(status) {
  // Demo/offline fallback: load a today.json bundled next to the app (handy for
  // testing the UI without a token). No-ops in production if the file isn't there.
  try {
    const r = await fetch("today.json", { cache: "no-store" });
    if (!r.ok) return false;
    const text = await r.text();
    DATA = JSON.parse(text);
    localStorage.setItem(LS.today, text);
    status.textContent = "Demo data (bundled today.json) — add a token in Settings to go live.";
    status.className = "status";
    renderToday(); renderLog();
    return true;
  } catch { return false; }
}

function showCachedToday() {
  const cached = localStorage.getItem(LS.today);
  if (cached) { DATA = JSON.parse(cached); renderToday(); renderLog(); }
  else { $("#todayBody").innerHTML = "<p class='hint'>No plan loaded yet.</p>"; }
}

// --------------------------------------------------------- Today (view) ----
function refTable(title, rows) {
  if (!rows || !rows.length) return "";
  const body = rows.map(r => {
    const note = r.note ? `<span class="note-warn">${esc(r.note)}</span>` : "";
    return `<tr><td>${esc(r.lift)}</td><td>${esc(r.gym)}</td><td>${esc(r.prescribed)}</td>`
         + `<td>${esc(r.last)}</td><td>${esc(r.range)}</td><td>${note}</td></tr>`;
  }).join("");
  return `<div class="card"><h3>${esc(title)}</h3><table>
    <thead><tr><th>Lift</th><th>Gym</th><th>Prescribed</th><th>Last</th><th>Range</th><th>Note</th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

function renderToday() {
  if (!DATA) return;
  const other = DATA.day === "A" ? "B" : "A";
  $("#appTitle").textContent = `S${DATA.session} · Day ${DATA.day}`;
  let html = `<div class="card"><h3>Next workout — S${esc(DATA.session)}, Day ${esc(DATA.day)}</h3>`;
  html += `<p class="hint">Tap <b>Log</b> to record this session.</p></div>`;
  html += refTable(`Day ${DATA.day} — next (S${DATA.session})`, DATA.reference["day" + DATA.day]);
  html += refTable(`Day ${other} — following (S${DATA.session + 1})`, DATA.reference["day" + other]);
  if (DATA.lastSessionFooter)
    html += `<p class="footer-line">Last session: ${esc(DATA.lastSessionFooter)}</p>`;
  $("#todayBody").innerHTML = html;
}

// ----------------------------------------------------------- Log (form) ----
function variantFor(lift, gym) {
  if (!lift.perGym) return lift.variants.both;
  return lift.variants[gym] || lift.variants.home || lift.variants.work
      || Object.values(lift.variants)[0];
}
function defaultReps(reps) { return String(reps || "").split("-")[0]; }

function initFormState() {
  FORM = {};
  DATA.lifts.forEach((lift, i) => {
    const v = variantFor(lift, GYM);
    FORM[i] = {
      skip: false, perSet: false,
      weight: v.loadToken,
      sets: v.sets || "",
      reps: defaultReps(v.reps),
      perSetReps: Array(v.sets || 0).fill(defaultReps(v.reps)).join("/"),
      rpe: "",
    };
  });
}

function renderLog() {
  if (!DATA) { $("#logForm").innerHTML = "<p class='hint'>Load a plan first (Today tab).</p>"; return; }
  if (GYM === null) GYM = (DATA.gyms && DATA.gyms[0]) || "work";
  if (!Object.keys(FORM).length) restoreOrInit();

  const today = new Date();
  const iso = FORM._date || `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,"0")}-${String(today.getDate()).padStart(2,"0")}`;
  FORM._date = iso;

  let h = "";
  if (alreadySubmitted(DATA.session))
    h += `<div class="card dup-warn">⚠ S${esc(DATA.session)} was already submitted from this phone. `
       + `If the PC hasn't processed it yet, this plan is stale — submitting again duplicates the session `
       + `(the PC will refuse it). Pull &amp; log on the PC first, then reload here.</div>`;

  h += `<div class="gympick">` +
    (DATA.gyms || ["home","work"]).map(g =>
      `<button type="button" class="gymbtn ${g===GYM?"sel":""}" data-gym="${esc(g)}">${esc(g)}</button>`
    ).join("") + `</div>`;

  h += `<label>Date<input id="f_date" type="date" value="${esc(iso)}"></label>`;

  DATA.lifts.forEach((lift, i) => {
    const st = FORM[i];
    const v = variantFor(lift, GYM);
    const pres = `${esc(v.loadToken)} · ${esc(v.sets)}×${esc(v.reps)}`;
    const top = (v.range && v.range[1] != null) ? `top ${esc(v.range[1])}` : "";
    const note = v.note ? `<span class="note-warn">${esc(v.note)}</span>` : "";
    const fieldsCls = st.perSet ? "fields perset" : "fields";
    const repFields = st.perSet
      ? `<label>reps (per set)<input data-i="${i}" data-k="perSetReps" type="text" inputmode="numeric" value="${esc(st.perSetReps)}" placeholder="7/7/6"></label>`
      : `<label>sets<input data-i="${i}" data-k="sets" type="number" inputmode="numeric" value="${esc(st.sets)}"></label>
         <label>reps<input data-i="${i}" data-k="reps" type="text" inputmode="numeric" value="${esc(st.reps)}"></label>`;
    h += `<div class="lift ${st.skip?"skipped":""}" data-lift="${i}">
      <div class="top"><span class="name">${esc(lift.label)}</span>
        <span class="presbox"><span class="pres">${pres} ${note}</span>${top ? `<span class="toprange">${top}</span>` : ""}</span></div>
      <div class="last">last: ${esc(v.last || "—")}</div>
      <div class="${fieldsCls}">
        <label>load<input data-i="${i}" data-k="weight" type="text" value="${esc(st.weight)}" ${st.skip?"disabled":""}></label>
        ${repFields}
        <label>RPE<input data-i="${i}" data-k="rpe" type="number" inputmode="decimal" step="0.5" value="${esc(st.rpe)}" placeholder="–" ${st.skip?"disabled":""}></label>
      </div>
      <div class="liftctl">
        <label><input type="checkbox" data-i="${i}" data-k="perSet" ${st.perSet?"checked":""}> per-set reps</label>
        <label><input type="checkbox" data-i="${i}" data-k="skip" ${st.skip?"checked":""}> skip</label>
      </div>
    </div>`;
  });

  // session metadata, generated from the engine-supplied field list
  h += `<div class="card"><h3>Session</h3><div class="meta-grid">`;
  for (const f of DATA.metadataFields) {
    const full = f.type === "text" ? "full" : "";
    const val = (FORM._meta && FORM._meta[f.key]) || "";
    const unit = f.unit ? ` (${esc(f.unit)})` : "";
    h += `<label class="${full}">${esc(f.label)}${unit}`
       + `<input data-meta="${esc(f.key)}" type="${f.type==="number"?"number":"text"}" `
       + `inputmode="${f.type==="number"?"decimal":"text"}" value="${esc(val)}"></label>`;
  }
  h += `</div></div>`;

  h += `<div id="preview"></div>
    <div class="actions">
      <button type="button" id="btnDraft" class="ghost">Save draft</button>
      <button type="button" id="btnSubmit">Submit to PC</button>
    </div>`;

  $("#logForm").innerHTML = h;
  wireLog();
  updatePreview();
}

function restoreOrInit() {
  const saved = DATA && JSON.parse(localStorage.getItem(LS.draft + DATA.session) || "null");
  if (saved && saved.gym) { GYM = saved.gym; FORM = saved.form; }
  else initFormState();
}

function wireLog() {
  $$(".gymbtn").forEach(b => b.onclick = () => {
    GYM = b.dataset.gym;
    // re-prefill loads for the new gym, keep typed reps/rpe where present
    DATA.lifts.forEach((lift, i) => {
      const v = variantFor(lift, GYM);
      if (!FORM[i]._touchedWeight) FORM[i].weight = v.loadToken;
      if (!FORM[i]._touchedSets) { FORM[i].sets = v.sets; FORM[i].reps = defaultReps(v.reps); }
    });
    renderLog();
  });

  $$("#logForm input[data-k]").forEach(inp => {
    const i = inp.dataset.i, k = inp.dataset.k;
    const handler = () => {
      if (inp.type === "checkbox") { FORM[i][k] = inp.checked; renderLog(); return; }
      FORM[i][k] = inp.value;
      if (k === "weight") FORM[i]._touchedWeight = true;
      if (k === "sets" || k === "reps") FORM[i]._touchedSets = true;
      updatePreview();
    };
    inp.addEventListener(inp.type === "checkbox" ? "change" : "input", handler);
  });

  $$("#logForm input[data-meta]").forEach(inp => {
    inp.addEventListener("input", () => {
      FORM._meta = FORM._meta || {};
      FORM._meta[inp.dataset.meta] = inp.value;
      updatePreview();
    });
  });

  $("#f_date").addEventListener("input", e => { FORM._date = e.target.value; updatePreview(); });
  $("#btnDraft").onclick = saveDraft;
  $("#btnSubmit").onclick = submit;
}

// --------------------------------------------------- LOG block assembly ----
function liftLine(lift, st) {
  if (st.skip) return `${lift.label}: skipped`;
  const w = (st.weight || "").trim();
  const scheme = st.perSet ? (st.perSetReps || "").trim()
                           : `${(st.sets+"").trim()}x${(st.reps+"").trim()}`;
  let line = `${lift.label}: ${w} x ${scheme}`;
  const rpe = (st.rpe + "").trim();
  if (rpe !== "") line += ` @ RPE ${rpe}`;
  return line;
}

function buildLogText() {
  const lines = [`=== LOG: Session ${DATA.session} (${DATA.day}, ${GYM}, ${FORM._date}) ===`];
  DATA.lifts.forEach((lift, i) => lines.push(liftLine(lift, FORM[i])));
  const meta = FORM._meta || {};
  for (const f of DATA.metadataFields) {
    const v = (meta[f.key] || "").trim();
    lines.push(`${f.label}: ${v}${f.unit ? " " + f.unit : ""}`);
  }
  return lines.join("\n") + "\n";
}

function updatePreview() { const p = $("#preview"); if (p) p.textContent = buildLogText(); }

// --------------------------------------------------- duplicate-submit guard ----
// Record which session numbers were already submitted from this device. If the
// PC hasn't yet processed a submission, today.json still shows that session, so
// the phone would build a second inbox file for it — the engine's P1-1 guard
// aborts on the duplicate, but warning here catches it before the round-trip.
function submittedSessions() {
  try { return JSON.parse(localStorage.getItem(LS.submitted)) || []; }
  catch { return []; }
}
function recordSubmission(session) {
  const list = submittedSessions();
  if (!list.includes(session)) {
    list.push(session);
    localStorage.setItem(LS.submitted, JSON.stringify(list.slice(-20)));  // cap growth
  }
}
function alreadySubmitted(session) { return submittedSessions().includes(session); }

// ----------------------------------------------------------- draft/submit ----
function saveDraft() {
  if (!DATA) return;
  localStorage.setItem(LS.draft + DATA.session, JSON.stringify({ gym: GYM, form: FORM }));
  setLogStatus("Draft saved on this device.", "ok");
}

function setLogStatus(msg, cls) { const s = $("#logStatus"); s.textContent = msg; s.className = "status " + (cls||""); }

async function submit() {
  const c = loadCfg();
  if (!cfgComplete(c)) { setLogStatus("Add your GitHub token in Settings first.", "err"); return; }
  // light client-side check mirroring log_session's required metadata
  const meta = FORM._meta || {};
  const missing = ["sleep","soreness"].filter(k => !(meta[k] && meta[k].trim()));
  if (!FORM._date) missing.push("date");
  if (missing.length) { setLogStatus("Missing: " + missing.join(", "), "err"); return; }

  saveDraft();
  const text = buildLogText();
  const path = `${c.inbox || "inbox"}/session-${DATA.session}-${FORM._date}.md`;
  setLogStatus("Submitting…", "");
  $("#btnSubmit").disabled = true;
  try {
    await ghPutFile(c, path, text, `phone log S${DATA.session}`);
    localStorage.removeItem(LS.draft + DATA.session);
    recordSubmission(DATA.session);
    setLogStatus(`Submitted → ${path}. On the PC: git pull, then log_session.py --log ${path}`, "ok");
    renderLog();   // surfaces the duplicate-submit banner if this plan is still shown
  } catch (e) {
    setLogStatus(`${e.message}. Draft kept — try again when online.`, "err");
  } finally {
    $("#btnSubmit").disabled = false;
  }
}

// ------------------------------------------------------------- settings ----
function loadSettingsForm() {
  const c = loadCfg();
  $("#cfgToken").value = c.token || "";
  $("#cfgOwner").value = c.owner || "";
  $("#cfgRepo").value = c.repo || "";
  $("#cfgBranch").value = c.branch || "master";
  $("#cfgDataPath").value = c.dataPath || "docs/today.json";
  $("#cfgInbox").value = c.inbox || "inbox";
}

async function saveSettings() {
  const c = {
    token: $("#cfgToken").value.trim(),
    owner: $("#cfgOwner").value.trim(),
    repo: $("#cfgRepo").value.trim(),
    branch: $("#cfgBranch").value.trim() || "master",
    dataPath: $("#cfgDataPath").value.trim() || "docs/today.json",
    inbox: $("#cfgInbox").value.trim() || "inbox",
  };
  saveCfg(c);
  const s = $("#cfgStatus");
  if (!cfgComplete(c)) { s.textContent = "Token, owner and repo are required."; s.className = "status err"; return; }
  s.textContent = "Testing…"; s.className = "status";
  try {
    const text = await ghGetRaw(c, c.dataPath);
    JSON.parse(text);
    localStorage.setItem(LS.today, text);
    s.textContent = "Connected — plan loaded."; s.className = "status ok";
    DATA = JSON.parse(text); FORM = {}; GYM = null; renderToday(); renderLog();
  } catch (e) {
    s.textContent = `Saved, but couldn't load plan: ${e.message}`; s.className = "status err";
  }
}

function clearToken() {
  const c = loadCfg(); delete c.token; saveCfg(c);
  $("#cfgToken").value = "";
  $("#cfgStatus").textContent = "Token cleared."; $("#cfgStatus").className = "status";
}

// --------------------------------------------------------------- routing ----
function showView(name) {
  $$(".view").forEach(v => v.classList.toggle("active", v.id === "view-" + name));
  $$("nav button").forEach(b => b.classList.toggle("active", b.dataset.view === name));
  if (name === "settings") loadSettingsForm();
  if (name === "log") renderLog();
}

function init() {
  $$("nav button").forEach(b => b.onclick = () => showView(b.dataset.view));
  $("#cfgSave").onclick = saveSettings;
  $("#cfgClear").onclick = clearToken;
  showCachedToday();
  fetchToday();
  if ("serviceWorker" in navigator)
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
}

document.addEventListener("DOMContentLoaded", init);
