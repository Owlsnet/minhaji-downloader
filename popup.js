const logPanel    = document.getElementById('logPanel');
const progressFill= document.getElementById('progressFill');
const progressPct = document.getElementById('progressPct');
const progressLbl = document.getElementById('progressLabel');
const statPages   = document.getElementById('statPages');
const statDone    = document.getElementById('statDone');
const statETA     = document.getElementById('statETA');
const statusPill  = document.getElementById('statusPill');
const statusDot   = document.getElementById('statusDot');
const statusText  = document.getElementById('statusText');
const downloadBtn    = document.getElementById('downloadBtn');
const downloadPdfBtn = document.getElementById('downloadPdfBtn');
const clearLogBtn    = document.getElementById('clearLogBtn');
const modeImages  = document.getElementById('modeImages');
const modeDirect  = document.getElementById('modeDirect');
const panelImages = document.getElementById('panelImages');
const panelDirect = document.getElementById('panelDirect');

let activeMode = 'images';

modeImages.addEventListener('click', () => {
  activeMode = 'images';
  modeImages.classList.add('active');
  modeDirect.classList.remove('active');
  panelImages.style.display = '';
  panelDirect.style.display = 'none';
  document.getElementById('labelA').textContent = 'Pages';
  document.getElementById('labelB').textContent = 'Done';
  document.getElementById('labelC').textContent = 'ETA';
  resetUI();
  logPanel.innerHTML = '';
});

modeDirect.addEventListener('click', () => {
  activeMode = 'direct';
  modeDirect.classList.add('active');
  modeImages.classList.remove('active');
  panelDirect.style.display = 'flex';
  panelImages.style.display = 'none';
  document.getElementById('labelA').textContent = 'Size';
  document.getElementById('labelB').textContent = 'Status';
  document.getElementById('labelC').textContent = 'Time';
  resetUI();
  logPanel.innerHTML = '';
});

function pushLog(text, type = 'info') {
  const line = document.createElement('div');
  line.className = `log-line ${type}`;
  const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
  line.textContent = `[${ts}] ${text}`;
  logPanel.appendChild(line);
  logPanel.scrollTop = logPanel.scrollHeight;
}

function setProgress(pct, label) {
  const clamped = Math.max(0, Math.min(100, pct));
  progressFill.style.width = `${clamped}%`;
  progressPct.textContent  = `${clamped}%`;
  if (label) progressLbl.textContent = label;
}

function setStatus(state, text) {
  statusPill.className = `status-pill visible ${state}`;
  statusText.textContent = text;
  statusDot.className = state === 'running' ? 'dot pulse' : 'dot';
}

function resetUI() {
  progressFill.className = 'progress-fill';
  setProgress(0, 'Ready');
  statPages.textContent = '—';
  statDone.textContent  = '0';
  statETA.textContent   = '—';
  statusPill.className  = 'status-pill';
}

clearLogBtn.addEventListener('click', () => { logPanel.innerHTML = ''; });

function scrapePageAssetInfo() {
  const resourceEntries = performance.getEntriesByType('resource').map(e => e.name);

  let allBlobUrls = resourceEntries.filter(u => u.includes('blob.core.windows.net') || u.includes('/books/'));

  const selectors = ['img', '[style*="background-image"]', 'object', 'embed', 'iframe', 'canvas', 'a'];
  for (const selector of selectors) {
    for (const el of document.querySelectorAll(selector)) {
      let src = el.src || el.getAttribute('data-src') || el.getAttribute('data-lazy') || el.getAttribute('data-url') || el.href;
      if (!src && selector === '[style*="background-image"]') {
        const match = el.getAttribute('style').match(/url\(['"]?(https:\/\/[^'"]+)['"]?\)/);
        if (match) src = match[1];
      }
      if (src && (src.includes('blob.core.windows.net') || src.includes('/books/'))) {
        allBlobUrls.push(src);
      }
    }
  }

  allBlobUrls = [...new Set(allBlobUrls)];

  let foundUrl = allBlobUrls.find(u => /\.(webp|png|jpg|jpeg)(\?|$)/i.test(u) && /(page|slide|img|book|doc)/i.test(u))
              || allBlobUrls.find(u => /\.(webp|png|jpg|jpeg)(\?|$)/i.test(u))
              || allBlobUrls[0];

  let freshSasToken = null;
  let bookMeta = null;

  try {
    const rawSas = localStorage.getItem('sasToken');
    if (rawSas) {
      freshSasToken = rawSas.replace(/^["']|["']$/g, '');
    }
  } catch (_) {}

  try {
    const rawBook = localStorage.getItem('book');
    if (rawBook) {
      bookMeta = JSON.parse(rawBook);
    }
  } catch (_) {}

  const sasTokens = [];
  if (freshSasToken) {
    sasTokens.push(freshSasToken.startsWith('?') ? freshSasToken : '?' + freshSasToken);
  }

  for (const urlStr of allBlobUrls) {
    try {
      const u = new URL(urlStr);
      if (u.search && u.search.includes('sig=')) {
        const token = u.search;
        if (!sasTokens.includes(token)) {
          sasTokens.push(token);
        }
      }
    } catch (_) {}
  }

  let bookName = "Exported_Book";
  let relativePath = "";

  if (bookMeta) {
    if (bookMeta.fileName) bookName = bookMeta.fileName;
    if (bookMeta.relativePath) relativePath = bookMeta.relativePath;
  }

  if (foundUrl) {
    try {
      const parsed = new URL(foundUrl);
      const pathSegments = parsed.pathname.split('/').filter(Boolean);
      // path format: /books/{relativePath}/{bookName}/pages/...
      const booksIdx = pathSegments.indexOf('books');
      if (booksIdx !== -1 && pathSegments.length >= booksIdx + 3) {
        if (!relativePath) relativePath = pathSegments[booksIdx + 1];
        if (bookName === "Exported_Book") bookName = pathSegments[booksIdx + 2];
      } else if (pathSegments.length >= 2) {
        if (bookName === "Exported_Book") {
          let bName = pathSegments[pathSegments.length - 2];
          if (['pages', 'img', 'images', 'slide', 'slides'].includes(bName.toLowerCase())) {
            bName = pathSegments[pathSegments.length - 3] || "Exported_Book";
          }
          bookName = bName;
        }
      }
    } catch (_) {}
  }

  // Strip trailing .pdf from bookName — some pages store it with extension already
  if (bookName.toLowerCase().endsWith('.pdf')) {
    bookName = bookName.slice(0, -4);
  }

  let detectedTotal = 0;
  const candidates = document.querySelectorAll('input, span, div, p, label');
  for (const el of candidates) {
    const txt = el.value || el.textContent || '';
    const m = txt.match(/\/\s*(\d{1,4})/)?.[1] || txt.match(/of\s+(\d{1,4})/i)?.[1];
    if (m) {
      const val = parseInt(m, 10);
      if (val > 1 && val < 5000) {
        detectedTotal = val;
        break;
      }
    }
  }

  return { foundUrl, bookName, relativePath, sasTokens, freshSasToken, detectedTotal };
}

downloadPdfBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  resetUI();
  logPanel.innerHTML = '';
  downloadPdfBtn.disabled = true;
  setStatus('running', 'Locating PDF…');
  pushLog('Extracting active session token…', 'dim');

  try {
    // Step 1: scrape page for book info and SAS tokens
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrapePageAssetInfo,
      world: 'MAIN'
    });

    const info = results?.[0]?.result;
    if (!info) {
      pushLog('Failed to inspect page state. Ensure book page is active.', 'error');
      setStatus('error', 'Page Error');
      downloadPdfBtn.disabled = false;
      return;
    }

    pushLog(`Book: "${info.bookName}"`, 'info');
    if (info.relativePath) pushLog(`Path: ${info.relativePath}/${info.bookName}`, 'dim');
    pushLog(`Tokens available: ${info.sasTokens.length}`, 'dim');

    // Step 2: build candidate URLs (multiple path layouts)
    const baseUrl = 'https://aze7greadersa01.blob.core.windows.net/books';
    const candidateUrls = [];

    const pathVariants = [
      (base, rel, name, sas) => `${base}/${rel}/${name}.pdf${sas}`,
      (base, rel, name, sas) => `${base}/${rel}/${name}/encrypted/${name}.pdf${sas}`,
      (base, rel, name, sas) => `${base}/${rel}/${name}/files/${name}.pdf${sas}`,
      (base, rel, name, sas) => `${base}/${rel}/${name}/${name}.pdf${sas}`,
    ];

    if (info.relativePath && info.bookName) {
      for (const sas of info.sasTokens) {
        for (const variant of pathVariants) {
          const url = variant(baseUrl, info.relativePath, info.bookName, sas);
          if (!candidateUrls.includes(url)) candidateUrls.push(url);
        }
      }
    }

    if (info.foundUrl) {
      try {
        const parsed  = new URL(info.foundUrl);
        const folderIdx = parsed.pathname.search(/\/(pages|slides|slide|img|images)\//i);
        if (folderIdx !== -1) {
          const base = parsed.pathname.substring(0, folderIdx);
          for (const sas of info.sasTokens) {
            for (const sub of ['', '/encrypted', '/files']) {
              const url = `${parsed.origin}${base}${sub}/${info.bookName}.pdf${sas}`;
              if (!candidateUrls.includes(url)) candidateUrls.push(url);
            }
          }
        }
      } catch (_) {}
    }

    if (candidateUrls.length === 0) {
      pushLog('Could not construct PDF URL path.', 'error');
      setStatus('error', 'URL Error');
      downloadPdfBtn.disabled = false;
      return;
    }

    pushLog(`Target: ${info.bookName}.pdf`, 'info');
    setStatus('running', 'Running on page…');
    setProgress(10, 'Injecting pipeline…');
    pushLog('Handing off to page — fetch → decrypt → render → save…', 'dim');

    // Step 3: run the entire pipeline inside the page's MAIN world
    const PDF_PASSWORD = 'Z7#pLw9xT@5uFk1!qRdM&nA2sV$3jYeG';
    const fileName     = `${info.bookName}_unlocked.pdf`;

    const pageResult = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async (urls, password, outFileName) => {

        // ── helpers ──────────────────────────────────────────────────────────
        const loadScript = (src) => new Promise((res, rej) => {
          const s = document.createElement('script');
          s.src = src; s.onload = res; s.onerror = rej;
          document.head.appendChild(s);
        });

        // ── 1. ensure PDF.js is available ────────────────────────────────────
        const PDFJS_VERSION = '3.11.174';
        const PDFJS_CDN     = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}`;

        let pdfjs = window.pdfjsLib || window.PDFJS || null;

        if (!pdfjs) {
          await loadScript(`${PDFJS_CDN}/pdf.min.js`);
          pdfjs = window.pdfjsLib || window.PDFJS;
          if (!pdfjs) return { ok: false, error: 'Failed to load PDF.js from CDN' };
        }

        // Use an inline blob worker — avoids cross-origin worker restrictions
        if (!pdfjs.GlobalWorkerOptions.workerSrc) {
          const workerResp = await fetch(`${PDFJS_CDN}/pdf.worker.min.js`);
          const workerText = await workerResp.text();
          const workerBlob = new Blob([workerText], { type: 'application/javascript' });
          pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(workerBlob);
        }

        // ── 2. ensure jsPDF is available ─────────────────────────────────────
        if (!window.jspdf) {
          await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
          if (!window.jspdf) return { ok: false, error: 'Failed to load jsPDF from CDN' };
        }

        // ── 3. find a working URL ────────────────────────────────────────────
        let bytes = null;
        let foundAt = -1;
        for (let i = 0; i < urls.length; i++) {
          try {
            const r = await fetch(urls[i]);
            if (r.ok) {
              bytes   = new Uint8Array(await r.arrayBuffer());
              foundAt = i;
              break;
            }
          } catch (_) {}
        }

        if (!bytes) return { ok: false, error: 'All candidate URLs returned 404/403' };

        // ── 4. decrypt with PDF.js using the known password ──────────────────
        let pdfDoc;
        try {
          pdfDoc = await pdfjs.getDocument({ data: bytes, password }).promise;
        } catch (e) {
          return { ok: false, error: `PDF.js decryption failed: ${e.message}` };
        }

        const numPages = pdfDoc.numPages;

        // ── 5. render each page → jsPDF ───────────────────────────────────────
        const { jsPDF } = window.jspdf;
        const pdf       = new jsPDF({ orientation: 'portrait', unit: 'px', format: 'a4', compress: true });
        const pdfW      = pdf.internal.pageSize.getWidth();
        const pdfH      = pdf.internal.pageSize.getHeight();
        const SCALE     = 2.0;

        for (let p = 1; p <= numPages; p++) {
          const page   = await pdfDoc.getPage(p);
          const vp     = page.getViewport({ scale: SCALE });
          const canvas = document.createElement('canvas');
          canvas.width = vp.width; canvas.height = vp.height;
          const ctx    = canvas.getContext('2d', { alpha: false });
          await page.render({ canvasContext: ctx, viewport: vp }).promise;

          const img   = canvas.toDataURL('image/jpeg', 0.92);
          const ratio = Math.min(pdfW / vp.width, pdfH / vp.height);
          const w = vp.width * ratio, h = vp.height * ratio;

          if (p > 1) pdf.addPage();
          pdf.addImage(img, 'JPEG', (pdfW - w) / 2, (pdfH - h) / 2, w, h, undefined, 'FAST');
        }

        // ── 6. save ───────────────────────────────────────────────────────────
        pdf.save(outFileName);
        return { ok: true, numPages, urlIndex: foundAt };
      },
      args: [candidateUrls, PDF_PASSWORD, fileName],
      world: 'MAIN'
    });

    const outcome = pageResult?.[0]?.result;

    if (!outcome || !outcome.ok) {
      throw new Error(outcome?.error || 'Page-side pipeline failed with no error message.');
    }

    setProgress(100, 'Complete');
    setStatus('success', 'Complete!');
    statDone.textContent = 'Done';
    pushLog(`Decrypted ${outcome.numPages} pages using URL #${outcome.urlIndex + 1}`, 'ok');
    pushLog(`File "${fileName}" saved successfully.`, 'ok');

  } catch (err) {
    pushLog(`Error: ${err.message}`, 'error');
    setStatus('error', 'Failed');
    setProgress(0, 'Failed');
  } finally {
    downloadPdfBtn.disabled = false;
  }
});




downloadBtn.addEventListener('click', async () => {
  const pageCountInput = document.getElementById('pageCount').value;
  const userPages = pageCountInput ? parseInt(pageCountInput, 10) : null;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  resetUI();
  logPanel.innerHTML = '';
  downloadBtn.disabled = true;
  setStatus('running', 'Initializing…');
  pushLog('Scanning page environment…', 'dim');

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrapePageAssetInfo,
      world: 'MAIN'
    });

    const info = results?.[0]?.result;
    if (!info || !info.foundUrl) {
      pushLog('No book page asset detected. View a page first.', 'error');
      setStatus('error', 'Asset Not Found');
      downloadBtn.disabled = false;
      return;
    }

    const parsed = new URL(info.foundUrl);
    const pathname = parsed.pathname;
    const sasToken = info.freshSasToken ? (info.freshSasToken.startsWith('?') ? info.freshSasToken : '?' + info.freshSasToken) : parsed.search;

    const extMatch = pathname.match(/\.([a-zA-Z0-9]+)(\?|$)/);
    const ext = extMatch ? extMatch[1] : 'webp';

    const pageNumMatch = pathname.match(/(.*?)(\d+)(\.[a-zA-Z0-9]+)$/);
    if (!pageNumMatch) {
      pushLog('Could not parse page numbering format from URL path.', 'error');
      setStatus('error', 'Parse Error');
      downloadBtn.disabled = false;
      return;
    }

    const sampleNumStr = pageNumMatch[2];
    const paddingSize = sampleNumStr.length;
    const basePath = pageNumMatch[1];
    const baseUrl = `${parsed.origin}${basePath}`;

    const defaultGuess = info.detectedTotal || (parseInt(sampleNumStr, 10) > 1 ? sampleNumStr : '100');
    const totalPages = userPages || info.detectedTotal || parseInt(
      prompt(`[Minhaji Downloader] Detected book: "${info.bookName}"\nEnter total page count:`, defaultGuess), 10
    );

    if (!totalPages || isNaN(totalPages)) {
      pushLog('Operation cancelled.', 'warn');
      setStatus('error', 'Cancelled');
      downloadBtn.disabled = false;
      return;
    }

    statPages.textContent = totalPages;
    pushLog(`Book: "${info.bookName}" — ${totalPages} pages`, 'info');
    pushLog('Beginning page downloads…', 'dim');
    setStatus('running', 'Downloading pages…');

    const pageMap = new Map();
    const concurrency = 32;
    let completedCount = 0;
    const startTime = Date.now();

    const fetchWithTimeout = async (url, timeout = 8000) => {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(id);
        return response;
      } catch (err) {
        clearTimeout(id);
        throw err;
      }
    };

    for (let i = 1; i <= totalPages; i += concurrency) {
      const chunkPromises = [];
      for (let j = i; j < i + concurrency && j <= totalPages; j++) {
        const paddedNum = String(j).padStart(paddingSize, '0');
        const targetUrl = `${baseUrl}${paddedNum}.${ext}${sasToken}`;

        chunkPromises.push(
          fetchWithTimeout(targetUrl).then(async res => {
            if (res.ok) {
              const blob = await res.blob();
              pageMap.set(j, blob);
              completedCount++;

              const elapsed = (Date.now() - startTime) / 1000;
              const rate = completedCount / elapsed;
              const remaining = isNaN(rate) || rate === 0 ? 0 : Math.round((totalPages - completedCount) / rate);
              const dlPct = Math.round((completedCount / totalPages) * 50);

              setProgress(dlPct, `Downloading ${completedCount}/${totalPages}`);
              statDone.textContent = completedCount;
              statETA.textContent = `${remaining}s`;
              pushLog(`Downloaded page ${completedCount}/${totalPages} (ETA: ${remaining}s)`, 'info');
            }
          }).catch(() => {
            pushLog(`Page ${j} failed — skipping`, 'warn');
          })
        );
      }
      await Promise.all(chunkPromises);
    }

    pushLog('All downloads done — compiling PDF…', 'info');
    setStatus('running', 'Compiling PDF…');

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'px', format: 'a4', compress: true });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();

    const compileStart = Date.now();
    const batchSize = 128;

    for (let i = 1; i <= totalPages; i += batchSize) {
      const batchPromises = [];
      const limit = Math.min(i + batchSize, totalPages + 1);

      for (let j = i; j < limit; j++) {
        const blob = pageMap.get(j);
        if (!blob) continue;

        batchPromises.push((async (pageIndex, pageBlob) => {
          const bitmap = await createImageBitmap(pageBlob);
          const bWidth = bitmap.width;
          const bHeight = bitmap.height;

          const canvas = document.createElement('canvas');
          canvas.width = bWidth;
          canvas.height = bHeight;
          const ctx = canvas.getContext('2d', { alpha: false });
          ctx.drawImage(bitmap, 0, 0);
          const dataUri = canvas.toDataURL('image/jpeg', 0.82);
          bitmap.close();

          const ratio = Math.min(pageWidth / bWidth, pageHeight / bHeight);
          const w = bWidth * ratio;
          const h = bHeight * ratio;
          return {
            index: pageIndex,
            data: dataUri,
            width: w, height: h,
            x: (pageWidth - w) / 2,
            y: (pageHeight - h) / 2
          };
        })(j, blob));
      }

      const results = await Promise.all(batchPromises);
      results.sort((a, b) => a.index - b.index);

      for (const item of results) {
        if (item.index > 1) pdf.addPage();
        pdf.addImage(item.data, 'JPEG', item.x, item.y, item.width, item.height, undefined, 'FAST');
      }

      const compiledSoFar = Math.min(i + batchSize - 1, totalPages);
      const compileElapsed = (Date.now() - compileStart) / 1000;
      const compileRate = compiledSoFar / compileElapsed;
      const compileRemaining = isNaN(compileRate) || compileRate === 0 ? 0 : Math.round((totalPages - compiledSoFar) / compileRate);
      const compilePct = Math.round(50 + (compiledSoFar / totalPages) * 50);

      setProgress(compilePct, `Compiling ${compiledSoFar}/${totalPages}`);
      pushLog(`Compiled ${compiledSoFar}/${totalPages} pages`, 'info');
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    const fileName = `${info.bookName}.pdf`;
    pdf.save(fileName);

    setProgress(100, 'Complete');
    setStatus('success', 'Complete!');
    pushLog(`"${fileName}" saved in ${totalTime}s`, 'ok');

  } catch (err) {
    pushLog(`Error: ${err.message}`, 'error');
    setStatus('error', 'Failed');
  } finally {
    downloadBtn.disabled = false;
  }
});
