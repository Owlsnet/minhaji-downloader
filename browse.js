/* ==================== BROWSE LIBRARY TAB ====================
   Strategy ported from minhajipy/minhaji_lib.py (proven engine):
   - ONE call to Book/GetAll returns the ENTIRE library with per-book
     metadata — no server-side descriptor ANDing, no term filtering.
   - Books are parsed client-side: grades/subjects come from each book's
     own `metadatas`, streams (ADV/GEN/ASP) from grade labels / stream
     groups, teacher's guides from persona metadata or title.
   - PDF: {BLOB}/{relativePath}/{stem}/encrypted/{stem}.pdf?{sas}
     (path segments MUST be URL-encoded — Arabic paths 403 otherwise).
   - Downloads reuse the existing Direct pipeline via START_DIRECT. */

const browseAuth    = document.getElementById('browseAuth');
const gradeSelect   = document.getElementById('gradeSelect');
const streamSelect  = document.getElementById('streamSelect');
const subjectSelect = document.getElementById('subjectSelect');
const typeSelect    = document.getElementById('typeSelect');
const loadBooksBtn  = document.getElementById('loadBooksBtn');
const refreshCatBtn = document.getElementById('refreshCatBtn');
const bookGrid      = document.getElementById('bookGrid');

const API_BASE  = 'https://apis.uepuae.ae/api';
const BLOB_BASE = 'https://aze7greadersa01.blob.core.windows.net/books';
const ABP_TENANT = '6002';
const CACHE_KEY = 'minhaji_catalog_cache_v1';
const CACHE_TTL = 6 * 3600 * 1000;   // 6 hours

let booksCache      = [];            // parsed book objects (full library)
let booksCacheView  = [];            // current filtered view
let browseAuthInfo  = null;          // { authTokens: [], sasToken, diag, tabId }
let browseWorkingToken = null;
let browseSasToken  = null;          // normalized, starts with '?'
let browseInitDone  = false;
let bgState         = { isActive: false };

const sleep = ms => new Promise(r => setTimeout(r, ms));

// popup.js doesn't expose its logger — route logs through the background
function pushLog(text, level = 'info') {
  try { chrome.runtime.sendMessage({ type: 'PAGE_EVENT', evt: 'log', text, level }).catch(() => {}); } catch (_) {}
}

// Keep a live mirror of the background job state so browse buttons can disable
const browsePort = chrome.runtime.connect({ name: 'popup' });
browsePort.onMessage.addListener(msg => {
  if (msg.type !== 'SYNC') return;
  bgState = msg.state;
  if (loadBooksBtn) loadBooksBtn.disabled = !!bgState.isActive;
  bookGrid?.querySelectorAll('button').forEach(b => { b.disabled = !!bgState.isActive; });
});

/* ---- Auth: sweep every storage key for JWTs + window.abp.auth ---- */
function grabMinhajiTokens() {
  const tokens = [];
  const seen = new Set();
  const keysFound = [];
  let abpPresent = false;
  const add = (t, src) => {
    if (!t) return;
    t = String(t).trim().replace(/^"|"$/g, '');
    if (!/^ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(t)) return;
    if (seen.has(t)) return;
    seen.add(t); tokens.push(t); keysFound.push(src);
  };
  try {
    abpPresent = !!window.abp;
    add(window.abp?.auth?.getToken?.(), 'abp.auth');
  } catch (_) {}
  const scanStore = (store, label, prefOnly) => {
    try {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (prefOnly && !/^(enc_auth_token|access_token|\.AUTH_TOKEN|token|id_token|auth_token)$/i.test(k || '')) continue;
        let v = null; try { v = store.getItem(k); } catch (_) { continue; }
        if (!v) continue;
        const s = String(v).trim();
        if (/^ey[A-Za-z0-9_-]{8,}\./.test(s)) { add(s, `${label}:${k}`); continue; }
        const m = s.match(/"(?:accessToken|access_token|idToken|id_token|authToken|auth_token|token)":"(ey[A-Za-z0-9_.-]{30,})"/);
        if (m) add(m[1], `${label}:${k} (nested)`);
      }
    } catch (_) {}
  };
  scanStore(localStorage, 'ls', true);
  scanStore(sessionStorage, 'ss', true);
  scanStore(localStorage, 'ls', false);
  scanStore(sessionStorage, 'ss', false);
  let lsLen = -1; try { lsLen = localStorage.length; } catch (_) {}
  return { authTokens: tokens, diag: { abpPresent, lsLen, keysFound: keysFound.slice(0, 8) } };
}

function setAuthStatus(state) {
  if (!browseAuth) return;
  if (state === true) {
    browseAuth.innerHTML = '<b>Session found.</b> The entire library is loaded below — every grade, stream (ADV/GEN/ASP), and Teacher\'s Guide.';
    browseAuth.style.borderColor = 'rgba(16,185,129,0.35)';
  } else if (state === false) {
    browseAuth.innerHTML = '<b>No login detected.</b> Open minhaji.moe.gov.ae in any tab, log in, then press Load Books again.';
    browseAuth.style.borderColor = 'rgba(239,68,68,0.35)';
  }
}

async function findMinhajiTab() {
  const tabs = await chrome.tabs.query({ url: ['https://minhaji.moe.gov.ae/*'] });
  if (!tabs.length) return null;
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs.find(t => t.id === active?.id) || tabs[0];
}

async function getAuth() {
  if (browseAuthInfo && browseAuthInfo.authTokens?.length) return browseAuthInfo;
  browseAuthInfo = null;
  let created = false;
  let tabs = await chrome.tabs.query({ url: ['https://minhaji.moe.gov.ae/*'] });
  if (!tabs.length) {
    pushLog('No Minhaji tab found — opening minhaji.moe.gov.ae (log in if prompted)...', 'warn');
    const tab = await chrome.tabs.create({ url: 'https://minhaji.moe.gov.ae/en/library' });
    created = true;
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      const t = await chrome.tabs.get(tab.id).catch(() => null);
      if (t && t.status === 'complete') break;
    }
    tabs = [tab];
  } else {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabs.sort((a, b) => (b.id === active?.id ? 1 : 0) - (a.id === active?.id ? 1 : 0));
  }
  const rounds = created ? 15 : 3;
  for (let round = 0; round < rounds; round++) {
    for (const tab of tabs) {
      const res = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, func: grabMinhajiTokens, world: 'MAIN'
      }).catch(() => null);
      const info = res?.[0]?.result;
      if (info && info.authTokens && info.authTokens.length) {
        browseAuthInfo = { ...info, tabId: tab.id };
        setAuthStatus(true);
        pushLog(`Auth token found in Minhaji tab (${(info.diag?.keysFound || []).join(', ') || 'unknown source'}).`, 'ok');
        return browseAuthInfo;
      }
    }
    if (!created) break;
    await sleep(1000);
  }
  let diagTxt = 'page not scriptable';
  try {
    const res = await chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, func: grabMinhajiTokens, world: 'MAIN' });
    const d = res?.[0]?.result?.diag;
    if (d) diagTxt = `abp: ${d.abpPresent ? 'yes' : 'no'}, ${d.lsLen} localStorage keys scanned`;
  } catch (_) {}
  pushLog(`No JWT found in any Minhaji tab (${diagTxt}). Log in to minhaji.moe.gov.ae, then press Load Books again.`, 'warn');
  setAuthStatus(false);
  return null;
}

/* ---- HTTP layer (mirrors minhaji_lib.http_json) ---- */
async function apiGet(path, params, token) {
  const url = new URL(`${API_BASE}/${path}`);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== null && v !== undefined && v !== '') url.searchParams.append(k, v);
  }
  const res = await fetch(url.toString(), {
    headers: {
      'Authorization': `Bearer ${token}`,
      'accept': 'text/plain',
      'abp-tenantid': ABP_TENANT
    }
  });
  const json = await res.json().catch(() => null);
  if (!json) throw new Error(`HTTP ${res.status}`);
  if (json.success === false) throw new Error(json.error?.message || 'API error');
  return json;
}

// Try every token candidate until the API accepts one
async function apiTry(path, params, auth) {
  const candidates = [];
  if (browseWorkingToken) candidates.push(browseWorkingToken);
  for (const t of (auth.authTokens || [])) if (!candidates.includes(t)) candidates.push(t);
  if (!candidates.length) throw new Error('No auth token candidates');
  let lastErr = null;
  for (let i = 0; i < candidates.length; i++) {
    try {
      const json = await apiGet(path, params, candidates[i]);
      browseWorkingToken = candidates[i];
      return json;
    } catch (e) {
      lastErr = e;
      const msg = String(e.message || '');
      if (!/login|author|401|403/i.test(msg)) throw e;  // non-auth failure — stop retrying
    }
  }
  browseAuthInfo = null;  // all candidates rejected — force a fresh page scan next time
  throw lastErr || new Error('All auth candidates rejected');
}

function sasLooksValid(sas) {
  if (!sas) return false;
  const m = String(sas).match(/se=([^&]+)/);
  if (!m) return true;
  try { return new Date(decodeURIComponent(m[1])) > new Date(); } catch (_) { return true; }
}

function normalizeSas(sas) {
  sas = String(sas).trim();
  return sas.startsWith('?') ? sas : `?${sas}`;
}

async function ensureSas(auth) {
  if (sasLooksValid(browseSasToken)) return browseSasToken;
  try {
    pushLog('Fetching fresh SAS token...', 'dim');
    const json = await apiTry('services/app/AzureBlob/GetSasToken', {}, auth);
    if (!json.result) throw new Error('No SAS token in response');
    browseSasToken = normalizeSas(json.result);
    return browseSasToken;
  } catch (e) {
    pushLog(`SAS token failed: ${e.message}`, 'error');
    return null;
  }
}

/* ---- Book parsing (port of minhaji_lib._coerce_book) ---- */
function normStream(s) {
  const t = String(s).toUpperCase();
  if (t.includes('ADV')) return 'ADV';
  if (t.includes('ASP')) return 'ASP';
  if (t.includes('APPLIED')) return 'ASP';
  if (t.includes('GEN')) return 'GEN';
  return t;
}

/* ---- fileName targeting: the link tells the truth when metadata is broad ----
   Student editions carry precise names (REVEAL_MATH_G10_ADV,
   InspireScience_G11-12_GEN_Chemistry). Teacher editions use series names
   (Reveal_Integrated_2) that the platform over-tags with every grade.
   Naming grammar:
     G10_ADV / G11-12_GEN / G01        -> grade (+stream) tokens
     Integrated_1|2|3                  -> Reveal integrated pathway: G9/G10/G11, ADV only
     _6-8_                             -> grade ranges (no stream -> inherit metadata)
   When fileName yields targets, they OVERRIDE the metadata grades/streams. */
function fileTargets(fn) {
  const tokens = [];
  const add = (num, stream) => {
    const n = parseInt(num, 10);
    if (!(n >= 1 && n <= 12)) return;
    const s = stream ? normStream(stream) : null;
    if (!tokens.some(t => t.num === n && t.s === s)) tokens.push({ num: n, s });
  };
  let m;
  const streamRes = [
    /G(\d{1,2})-(\d{1,2})[-_ ]?(ADV|GEN|ASP|ADVANCED|GENERAL|APPLIED)\b/gi,  // G11-12_ADV
    /G(\d{1,2})[-_ ]?(ADV|GEN|ASP|ADVANCED|GENERAL|APPLIED)\b/gi,            // G10_ADV
    /Integrated[_ ]?([123])(?![0-9])/gi                                      // series map
  ];
  for (let i = 0; i < streamRes.length; i++) {
    while ((m = streamRes[i].exec(fn))) {
      if (i === 0) { add(m[1], m[3]); add(m[2], m[3]); }
      else if (i === 1) add(m[1], m[2]);
      else add(8 + parseInt(m[1], 10), 'ADV');
    }
  }
  const covered = new Set(tokens.filter(t => t.s).map(t => t.num));
  const plainRe = /(?<![A-Za-z0-9])G(\d{1,2})(?!\d)/gi;                     // G10, G01
  while ((m = plainRe.exec(fn))) {
    const n = parseInt(m[1], 10);
    if (!covered.has(n)) add(n, null);
  }
  const rangeRe = /[_ ](\d{1,2})-(\d{1,2})(?!\d)/g;                         // Phys_6-8, 9-12
  while ((m = rangeRe.exec(fn))) {
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
    if (a <= b && b - a < 12) for (let n = a; n <= b; n++) add(n, null);    // full range
  }
  return tokens;
}

function parseBook(raw) {
  const meta = Array.isArray(raw.metadatas) ? raw.metadatas : [];
  const grades = [], baseGrades = [], subjects = [], streams = [], personas = [];
  const gradeStreamMap = {};   // base grade -> Set(metadata streams), for fileName merge
  // Stream suffixes live inside the grade labels themselves:
  // "Grade 12 ADV" -> base "Grade 12" + stream "ADV"
  const STREAM_TAIL = /\s*\b(ADVANCED|GENERAL|APPLIED|ADV|GEN|ASP)\b\s*$/i;
  for (const m of meta) {
    const grp = String(m.metadataGroupTitleEn || '').trim();
    const lbl = String(m.titleEn || m.titleAr || m.id || '').trim();
    if (!lbl) continue;
    const g = grp.toLowerCase();
    if (g === 'grades') {
      grades.push(lbl);                       // full label, for display
      const tail = lbl.match(STREAM_TAIL);
      // base grade ALWAYS populated ("Grade 12 ADV" -> "Grade 12", "KG1" -> "KG1")
      const base = tail ? lbl.replace(STREAM_TAIL, '').trim() : lbl;
      if (base && !baseGrades.includes(base)) baseGrades.push(base);
      if (tail) {
        const s = normStream(tail[1]);
        if (!streams.includes(s)) streams.push(s);
        (gradeStreamMap[base] ||= new Set()).add(s);
      }
    }
    else if (g === 'subjects') subjects.push(lbl);
    if (/stream/.test(g)) { const s = normStream(lbl); if (!streams.includes(s)) streams.push(s); }
    if (/personas?/.test(g)) personas.push(lbl);
  }
  // Personas = roles the platform serves this book to. Most textbooks carry
  // BOTH Student+Teacher personas; a genuine teacher's guide is Teacher-ONLY
  // (verified against catalog data: 434 Student+Teacher, 230 Teacher-only).
  const isStudent = personas.some(p => /student/i.test(p));
  const isTeacherGuide = personas.some(p => /teacher/i.test(p)) && !isStudent;
  const fn = String(raw.fileName || '');
  const stem = fn.replace(/\.pdf$/i, '');
  const title = (raw.titleEn && raw.titleEn !== stem) ? raw.titleEn : (stem || '?');

  // Merge: fileName targets override broad metadata when present.
  // Grades named without a stream inherit that grade's metadata streams.
  let fBase = baseGrades.slice(), fStreams = streams.slice();
  const tokens = fileTargets(fn);
  if (tokens.length) {
    fBase = [...new Set(tokens.map(t => 'Grade ' + t.num))];
    const sts = [];
    for (const t of tokens) {
      if (t.s) sts.push(t.s);
      else {
        const ms = gradeStreamMap['Grade ' + t.num];
        if (ms && ms.size) sts.push(...ms);
      }
    }
    fStreams = [...new Set(sts)];
    if (!fStreams.length) fStreams = streams.slice();
  }

  return {
    id: String(raw.id || ''), title, fileName: fn, stem,
    relativePath: String(raw.relativePath || ''),
    grades, baseGrades: fBase, subjects, streams: fStreams, isStudent, isTeacherGuide,
    pages: parseInt(raw.numberOfPages, 10) || 0,
    lang: raw.language || '?'
  };
}

// Natural grade sort: KG first, then Grade 1..12, tracks alphabetical (LO's grade_sort_key)
function gradeSortCmp(a, b) {
  const key = name => {
    const n = String(name).toLowerCase();
    if (n.startsWith('kg')) { const m = n.match(/(\d+)/); return [0, m ? +m[1] : 0, name]; }
    if (n.startsWith('grade')) {
      const m = n.match(/(\d+)/);
      const rest = m ? n.slice(m.index + m[0].length).trim() : n;
      return [1, m ? +m[1] : 0, rest];
    }
    return [2, 0, name];
  };
  const ka = key(a), kb = key(b);
  return ka[0] - kb[0] || ka[1] - kb[1] || String(ka[2]).localeCompare(String(kb[2]));
}

function fillSelect(select, values, placeholder) {
  select.innerHTML = '';
  const ph = document.createElement('option');
  ph.value = '';
  ph.textContent = placeholder;
  select.appendChild(ph);
  for (const v of values) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    select.appendChild(opt);
  }
}

/* ---- Full-library fetch: ONE goldmine endpoint, then client-side everything ---- */
async function fetchAllBooks(auth) {
  let items = [], skip = 0;
  while (true) {
    const j = await apiTry('services/app/Book/GetAll',
      { skipCount: skip, maxResultCount: 10000 }, auth);
    const page = (j.result && j.result.items) || [];
    items = items.concat(page);
    pushLog(`Book/GetAll: ${items.length} raw entries so far...`, 'dim');
    if (page.length < 10000 || items.length >= 20000) break;
    skip += 10000;
  }
  return items.map(parseBook).filter(b => b.stem && b.relativePath);
}

async function cacheGet(key) {
  try {
    if (!chrome.storage || !chrome.storage.local) return null;
    const stored = await chrome.storage.local.get(key).catch(() => ({}));
    return (stored && stored[key]) || null;
  } catch (_) { return null; }
}

async function cacheSet(key, value) {
  try {
    if (!chrome.storage || !chrome.storage.local) return;
    await chrome.storage.local.set({ [key]: value }).catch(() => {});
  } catch (_) {}
}

async function loadCatalog(auth, force) {
  if (!force) {
    const c = await cacheGet(CACHE_KEY);
    if (c && c.books && c.books.length && Date.now() - c.ts < CACHE_TTL) {
      pushLog(`Catalog cache hit — ${c.books.length} books (${Math.round((Date.now() - c.ts) / 60000)}m old). Press Refresh to re-pull.`, 'dim');
      return c.books;
    }
  }
  pushLog('Pulling the ENTIRE library via Book/GetAll...', 'dim');
  const books = await fetchAllBooks(auth);
  if (books.length) await cacheSet(CACHE_KEY, { ts: Date.now(), books });
  return books;
}

function fillFilterSelects() {
  const uniq = fn => [...new Set(booksCache.flatMap(fn))];
  // Three independent axes, parsed from each book's own labels:
  //   Grade  = base grade ("Grade 12")   — no stream suffix
  //   Stream = ADV / GEN / ASP           — extracted from grade suffixes
  //   Type   = Student persona vs Teacher-only persona
  // A book tagged "Grade 10 General / Grade 10 ADV" correctly matches
  // Grade 10 + GEN and Grade 10 + ADV; "Grade 3" simply has no stream.
  const gradeOpts = uniq(b => b.baseGrades).sort(gradeSortCmp);
  const streamSet = uniq(b => b.streams);
  const orderedStreams = ['ADV', 'GEN', 'ASP'].filter(s => streamSet.includes(s))
    .concat(streamSet.filter(s => !['ADV', 'GEN', 'ASP'].includes(s)).sort());
  const subjects = uniq(b => b.subjects).sort((a, b) => a.localeCompare(b));
  fillSelect(gradeSelect, gradeOpts, 'All grades');
  fillSelect(streamSelect, orderedStreams, 'All streams');
  fillSelect(subjectSelect, subjects, 'All subjects');
}

async function initBrowse() {
  if (browseInitDone) return;
  browseInitDone = true;
  const auth = await getAuth();
  if (!auth) { browseInitDone = false; return; }
  try {
    booksCache = await loadCatalog(auth, false);
    if (!booksCache.length) booksCache = await loadCatalog(auth, true);
    browseSasToken = await ensureSas(auth);
    fillFilterSelects();
    pushLog(`Catalog ready — ${booksCache.length} books. Pick filters and press Load Books.`, 'ok');
  } catch (e) {
    browseInitDone = false;
    pushLog(`Browse init failed: ${e.message}`, 'error');
  }
}

/* ---- Listing: pure client-side filtering over the full library ---- */
function renderBooks(list) {
  bookGrid.innerHTML = '';
  if (!list.length) {
    bookGrid.innerHTML = '<div class="book-empty">No books match this selection.</div>';
    return;
  }
  for (const book of list) {
    const card = document.createElement('div');
    card.className = 'book-card';
    const img = document.createElement('img');
    img.className = 'book-cover';
    img.loading = 'lazy';
    img.src = `${BLOB_BASE}/${book.relativePath.split('/').map(encodeURIComponent).join('/')}/${encodeURIComponent(book.stem)}/pages/${encodeURIComponent(book.stem)}_page_001.webp${browseSasToken || ''}`;
    img.onerror = () => { img.style.visibility = 'hidden'; };
    const info = document.createElement('div');
    info.className = 'book-info';
    const t = document.createElement('div');
    t.className = 'book-title';
    t.textContent = book.title;
    t.title = book.title;
    const meta = document.createElement('div');
    meta.className = 'book-meta';
    const bits = [];
    if (book.baseGrades.length) bits.push(book.baseGrades.join('/'));
    if (book.streams.length) bits.push(book.streams.join('/'));
    if (book.isTeacherGuide) bits.push('Teacher only');
    bits.push(`${book.pages || '?'}p`);
    meta.textContent = bits.join(' · ');
    info.appendChild(t); info.appendChild(meta);
    const btn = document.createElement('button');
    btn.className = 'btn book-dl';
    btn.textContent = 'Download';
    btn.disabled = !!bgState.isActive;
    btn.addEventListener('click', () => downloadCatalogBook(book));
    card.appendChild(img); card.appendChild(info); card.appendChild(btn);
    bookGrid.appendChild(card);
  }
}

loadBooksBtn.addEventListener('click', () => {
  if (bgState.isActive) return;
  if (!booksCache.length) { initBrowse(); return; }
  const g = gradeSelect.value, s = streamSelect.value, sub = subjectSelect.value;
  const teacher = typeSelect.value === 'teacher';
  const list = booksCache.filter(b => {
    if (g && !b.baseGrades.some(x => x.toLowerCase() === g.toLowerCase())) return false;
    if (s && !b.streams.some(x => x.toUpperCase() === s.toUpperCase())) return false;
    if (sub && !b.subjects.some(x => x.toLowerCase() === sub.toLowerCase())) return false;
    if (teacher) { if (!b.isTeacherGuide) return false; }   // teacher-only editions
    else if (!b.isStudent) return false;                    // student mode: served to Student role
    return true;
  });
  list.sort((a, b) =>
    gradeSortCmp(a.grades[0] || '~', b.grades[0] || '~') ||
    (a.subjects[0] || '').localeCompare(b.subjects[0] || '') ||
    a.title.localeCompare(b.title));
  booksCacheView = list;
  renderBooks(list);
  pushLog(`${list.length} book(s) match your filters.`, list.length ? 'ok' : 'warn');
});

refreshCatBtn.addEventListener('click', async () => {
  if (bgState.isActive) return;
  const auth = await getAuth();
  if (!auth) { alert('Login required: open minhaji.moe.gov.ae in any tab, log in, then try again.'); return; }
  refreshCatBtn.disabled = true;
  try {
    booksCache = await loadCatalog(auth, true);
    browseSasToken = await ensureSas(auth);
    fillFilterSelects();
    pushLog(`Catalog refreshed — ${booksCache.length} books.`, 'ok');
  } catch (e) {
    pushLog(`Refresh failed: ${e.message}`, 'error');
  } finally {
    refreshCatBtn.disabled = false;
  }
});

/* ---- Download: pre-built, URL-encoded encrypted-PDF link -> existing pipeline ---- */
async function downloadCatalogBook(book) {
  if (bgState.isActive) return;
  const auth = await getAuth();
  if (!auth) { alert('Login required: open minhaji.moe.gov.ae in any tab, log in, then try again.'); return; }
  const sas = await ensureSas(auth);
  if (!sas) return;
  // Path segments MUST be url-encoded — raw Arabic/accents 403 against blob storage
  const rel = book.relativePath.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  const stem = encodeURIComponent(book.stem);
  const pdfUrl = `${BLOB_BASE}/${rel}/${stem}/encrypted/${stem}.pdf${sas}`;
  // Output name = original file stem + _unlocked (e.g. InspireScience_G10_ADV_Physics_unlocked.pdf)
  const safeStem = String(book.stem).replace(/[\\/:*?"<>|]/g, '_');
  const outName = `${safeStem}_unlocked.pdf`;
  let tab = await chrome.tabs.get(auth.tabId).catch(() => null);
  if (!tab) tab = await findMinhajiTab();
  if (!tab) { setAuthStatus(false); browseAuthInfo = null; alert('No Minhaji tab available. Open minhaji.moe.gov.ae and try again.'); return; }
  pushLog(`Downloading: ${safeStem}`, 'info');
  chrome.runtime.sendMessage({
    type: 'START_DIRECT', tabId: tab.id, downloadName: outName,
    info: { bookName: book.stem, relativePath: book.relativePath, sasTokens: [sas], pdfUrl }
  });
}