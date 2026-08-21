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
const resetBtn       = document.getElementById('resetBtn');
const modeImages  = document.getElementById('modeImages');
const modeDirect  = document.getElementById('modeDirect');
const panelImages = document.getElementById('panelImages');
const panelDirect = document.getElementById('panelDirect');

let activeMode = localStorage.getItem('minhaji_mode') || 'images';

function setMode(mode, clearLogs = true) {
  activeMode = mode;
  localStorage.setItem('minhaji_mode', mode);
  if (mode === 'images') {
    modeImages.classList.add('active');
    modeDirect.classList.remove('active');
    panelImages.style.display = '';
    panelDirect.style.display = 'none';
    document.getElementById('labelA').textContent = 'Pages';
    document.getElementById('labelB').textContent = 'Done';
    document.getElementById('labelC').textContent = 'ETA';
  } else {
    modeDirect.classList.add('active');
    modeImages.classList.remove('active');
    panelDirect.style.display = 'flex';
    panelImages.style.display = 'none';
    document.getElementById('labelA').textContent = 'Size';
    document.getElementById('labelB').textContent = 'Status';
    document.getElementById('labelC').textContent = 'Time';
  }
  if (clearLogs) {
    logPanel.innerHTML = '';
    chrome.runtime.sendMessage({ type: 'CLEAR_LOGS' });
  }
}

modeImages.addEventListener('click', () => setMode('images', true));
modeDirect.addEventListener('click', () => setMode('direct', true));

setMode(activeMode, false);

let port = chrome.runtime.connect({ name: 'popup' });
port.onMessage.addListener(msg => {
  if (msg.type === 'SYNC') syncState(msg.state);
  if (msg.type === 'LOG') pushLogUI(msg.item);
});

function syncState(s) {
  downloadBtn.disabled = s.isActive;
  downloadPdfBtn.disabled = s.isActive;
  progressFill.style.width = `${Math.max(0, Math.min(100, s.progressPct))}%`;
  progressPct.textContent = `${Math.max(0, Math.min(100, s.progressPct))}%`;
  progressLbl.textContent = s.progressLabel;
  statPages.textContent = s.statPages;
  statDone.textContent = s.statDone;
  statETA.textContent = s.statETA;
  statusPill.className = s.statusState ? `status-pill visible ${s.statusState}` : 'status-pill';
  statusText.textContent = s.statusText;
  statusDot.className = s.statusState === 'running' ? 'dot pulse' : 'dot';
  logPanel.innerHTML = '';
  s.logs.forEach(pushLogUI);
}

function pushLogUI(item) {
  const line = document.createElement('div');
  line.className = `log-line ${item.type}`;
  line.textContent = `[${item.ts}] ${item.text}`;
  logPanel.appendChild(line);
  logPanel.scrollTop = logPanel.scrollHeight;
}

function resetUI() {
  /* handled by state sync now */
}

clearLogBtn.addEventListener('click', () => { 
  const lines = logPanel.querySelectorAll('.log-line');
  lines.forEach(line => {
    line.style.transition = 'all 0.18s ease';
    line.style.opacity = '0';
    line.style.transform = 'translateY(2px)';
  });
  setTimeout(() => {
    logPanel.innerHTML = ''; 
    chrome.runtime.sendMessage({ type: 'CLEAR_LOGS' }); 
  }, 180);
});

resetBtn.addEventListener('click', () => { chrome.runtime.sendMessage({ type: 'RESET_STATE' }); });

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

  allBlobUrls = [...new Set(allBlobUrls)].reverse(); // Get latest first

  let foundUrl = allBlobUrls.find(u => /\.(webp|png|jpg|jpeg)(\?|$)/i.test(u) && /(page|slide|img|book|doc)/i.test(u))
              || allBlobUrls.find(u => /\.(webp|png|jpg|jpeg)(\?|$)/i.test(u))
              || allBlobUrls[0];
              
  // Now that we have the info, optionally clear timings to prevent future collisions, though reversing mostly solves it.
  performance.clearResourceTimings();

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
  const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scrapePageAssetInfo, world: 'MAIN' });
  const info = results?.[0]?.result;
  if (!info) return alert('Failed to inspect page state. Ensure book page is active.');
  chrome.runtime.sendMessage({ type: 'START_DIRECT', tabId: tab.id, info });
});

downloadBtn.addEventListener('click', async () => {
  const pageCountInput = document.getElementById('pageCount').value;
  const userPages = pageCountInput ? parseInt(pageCountInput, 10) : null;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scrapePageAssetInfo, world: 'MAIN' });
  const info = results?.[0]?.result;
  if (!info || !info.foundUrl) return alert('No book page asset detected. View a page first.');

  const parsed = new URL(info.foundUrl);
  const sampleNumStr = parsed.pathname.match(/(.*?)(\d+)(\.[a-zA-Z0-9]+)$/)?.[2] || '100';
  const defaultGuess = info.detectedTotal || (parseInt(sampleNumStr, 10) > 1 ? sampleNumStr : '100');
  let totalPages = userPages || info.detectedTotal;
  
  if (!totalPages) {
    const pRes = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (bName, guess) => prompt(`[Minhaji Downloader] Detected book: "${bName}"\nEnter total page count:`, guess),
      args: [info.bookName, defaultGuess]
    });
    totalPages = parseInt(pRes?.[0]?.result, 10);
  }
  
  if (!totalPages || isNaN(totalPages)) return;
  chrome.runtime.sendMessage({ type: 'START_IMAGES', tabId: tab.id, info, totalPages });
});
