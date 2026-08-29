let state = {
  isActive: false, mode: 'images', logs: [],
  progressPct: 0, progressLabel: 'Ready',
  statPages: '—', statDone: 0, statETA: '—',
  statusState: '', statusText: 'Idle'
};
let ports = [];
chrome.runtime.onConnect.addListener(p => {
  if(p.name === 'popup') {
    ports.push(p);
    p.postMessage({ type: 'SYNC', state });
    p.onDisconnect.addListener(() => ports = ports.filter(x => x !== p));
  }
});
function updateState(obj) {
  Object.assign(state, obj);
  ports.forEach(p => p.postMessage({ type: 'SYNC', state }));
}
function pushLog(text, type='info') {
  const item = { text, type, ts: new Date().toLocaleTimeString('en-GB', { hour12: false }) };
  state.logs.push(item);
  ports.forEach(p => p.postMessage({ type: 'LOG', item }));
}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if(msg.type === 'PAGE_EVENT') {
    if(msg.evt === 'log') pushLog(msg.text, msg.level);
    if(msg.evt === 'progress') updateState({ progressPct: msg.pct, progressLabel: msg.label });
    if(msg.evt === 'stats') updateState({ statPages: msg.pages, statDone: msg.done, statETA: msg.eta });
    if(msg.evt === 'status') updateState({ statusState: msg.state, statusText: msg.text });
    if(msg.evt === 'done' || msg.evt === 'error') updateState({ isActive: false });
  }
  if(msg.type === 'START_DIRECT') startDirect(msg.tabId, msg.info, msg.downloadName);
  if(msg.type === 'START_IMAGES') startImages(msg.tabId, msg.info, msg.totalPages);
  if(msg.type === 'CLEAR_LOGS') { state.logs = []; updateState({ logs: [] }); }
  if(msg.type === 'RESET_STATE') {
    if (state.lastTabId) {
      chrome.scripting.executeScript({
        target: { tabId: state.lastTabId },
        func: () => {
          window.postMessage({ type: 'ABORT_DOWNLOAD' }, '*');
          performance.clearResourceTimings();
        }
      }).catch(()=>{});
    }
    state.isActive = false;
    state.progressPct = 0;
    state.progressLabel = 'Ready';
    state.statPages = '—';
    state.statDone = 0;
    state.statETA = '—';
    state.statusState = '';
    state.statusText = 'Idle';
    updateState({});
    pushLog('State forcefully reset by user.', 'warn');
  }
});

function startDirect(tabId, info, downloadName) {
  state.lastTabId = tabId;
  updateState({ isActive: true, progressPct: 10, progressLabel: 'Injecting pipeline...', statPages: '—', statDone: 0, statETA: '—', statusState: 'running', statusText: 'Locating PDF…' });
  pushLog('Starting Direct PDF pipeline in background...', 'dim');
  pushLog(`Book: "${info.bookName}"`, 'info');
  const candidateUrls = [];
  const baseUrl = 'https://aze7greadersa01.blob.core.windows.net/books';
  const pathVariants = [
    (base, rel, name, sas) => `${base}/${rel}/${name}.pdf${sas}`,
    (base, rel, name, sas) => `${base}/${rel}/${name}/encrypted/${name}.pdf${sas}`,
    (base, rel, name, sas) => `${base}/${rel}/${name}/files/${name}.pdf${sas}`,
    (base, rel, name, sas) => `${base}/${rel}/${name}/${name}.pdf${sas}`
  ];
  if (info.relativePath && info.bookName) {
    for (const sas of info.sasTokens) {
      for (const variant of pathVariants) {
        candidateUrls.push(variant(baseUrl, info.relativePath, info.bookName, sas));
      }
    }
  }
  if (info.foundUrl) {
    try {
      const parsed = new URL(info.foundUrl);
      const folderIdx = parsed.pathname.search(/\/(pages|slides|slide|img|images)\//i);
      if (folderIdx !== -1) {
        const base = parsed.pathname.substring(0, folderIdx);
        for (const sas of info.sasTokens) {
          for (const sub of ['', '/encrypted', '/files']) {
            candidateUrls.push(`${parsed.origin}${base}${sub}/${info.bookName}.pdf${sas}`);
          }
        }
      }
    } catch (_) {}
  }
  if (info.pdfUrl) candidateUrls.unshift(info.pdfUrl);   // exact pre-built URL wins first
  const uniqueUrls = [...new Set(candidateUrls)];
  if (uniqueUrls.length === 0) {
    pushLog('Could not construct PDF URL path.', 'error');
    updateState({ statusState: 'error', statusText: 'URL Error', isActive: false });
    return;
  }
  const outFileName = downloadName || `${info.bookName}_unlocked.pdf`;
  chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    args: [uniqueUrls, 'Z7#pLw9xT@5uFk1!qRdM&nA2sV$3jYeG', outFileName],
    func: async (urls, password, outFileName) => {
      let aborted = false;
      const abortHandler = (e) => { if (e.data && e.data.type === 'ABORT_DOWNLOAD') aborted = true; };
      window.addEventListener('message', abortHandler);
      const checkAbort = () => { if (aborted) throw new Error('Aborted by user reset.'); };

      const send = (evt, data) => window.postMessage({ type: 'PAGE_EVENT', evt, ...data }, '*');
      const log = (text, level='info') => send('log', { text, level });
      const setStatus = (state, text) => send('status', { state, text });
      const setProgress = (pct, label) => send('progress', { pct, label });
      try {
        const loadScript = src => new Promise((r, e) => { let s = document.createElement('script'); s.src = src; s.onload = r; s.onerror = e; document.head.appendChild(s); });
        let pdfjs = window.pdfjsLib || window.PDFJS || null;
        if (!pdfjs) {
          await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
          pdfjs = window.pdfjsLib || window.PDFJS;
        }
        if (!pdfjs.GlobalWorkerOptions.workerSrc) {
          const r = await fetch('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js');
          const b = new Blob([await r.text()], { type: 'application/javascript' });
          pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(b);
        }
        if (!window.jspdf) await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
        let bytes = null;
        for (let i = 0; i < urls.length; i++) {
          try {
            const r = await fetch(urls[i]);
            if (r.ok) { bytes = new Uint8Array(await r.arrayBuffer()); break; }
          } catch (_) {}
        }
        if (!bytes) throw new Error('All candidate URLs returned 404/403');
        log('Decrypting PDF...', 'dim');
        const pdfDoc = await pdfjs.getDocument({ data: bytes, password }).promise;
        const numPages = pdfDoc.numPages;
        send('stats', { pages: numPages, done: 0, eta: '—' });
        const { jsPDF } = window.jspdf;
        let pdf = null;
        const startTime = Date.now();
        for (let p = 1; p <= numPages; p++) {
          checkAbort();
          const page = await pdfDoc.getPage(p);
          const vp = page.getViewport({ scale: 2.0 });
          const canvas = document.createElement('canvas');
          canvas.width = vp.width; canvas.height = vp.height;
          const ctx = canvas.getContext('2d', { alpha: false });
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
          const img = canvas.toDataURL('image/jpeg', 0.92);
          if (!pdf) {
            pdf = new jsPDF({ orientation: vp.width > vp.height ? 'landscape' : 'portrait', unit: 'px', format: [vp.width, vp.height], compress: true });
            pdf.addImage(img, 'JPEG', 0, 0, vp.width, vp.height, undefined, 'FAST');
          } else {
            pdf.addPage([vp.width, vp.height], vp.width > vp.height ? 'landscape' : 'portrait');
            pdf.addImage(img, 'JPEG', 0, 0, vp.width, vp.height, undefined, 'FAST');
          }
          const rate = p / ((Date.now() - startTime) / 1000);
          const remaining = isNaN(rate) || rate === 0 ? 0 : Math.round((numPages - p) / rate);
          setProgress(Math.round((p / numPages) * 100), `Rendering ${p}/${numPages}`);
          send('stats', { pages: numPages, done: p, eta: `${remaining}s` });
        }
        pdf.save(outFileName);
        log(`Saved ${outFileName} successfully.`, 'ok');
        setStatus('success', 'Complete!');
        send('stats', { pages: numPages, done: numPages, eta: 'Done' });
        send('done', {});
      } catch(e) { log(`Error: ${e.message}`, 'error'); setStatus('error', 'Failed'); send('error', {}); }
    }
  });
}

function startImages(tabId, info, totalPages) {
  state.lastTabId = tabId;
  updateState({ isActive: true, progressPct: 0, progressLabel: 'Initializing...', statPages: totalPages, statDone: 0, statETA: '—', statusState: 'running', statusText: 'Downloading pages…' });
  pushLog('Starting Images to PDF pipeline in background...', 'dim');
  pushLog(`Book: "${info.bookName}" — ${totalPages} pages`, 'info');
  chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    args: [info, totalPages],
    func: async (info, totalPages) => {
      let aborted = false;
      const abortHandler = (e) => { if (e.data && e.data.type === 'ABORT_DOWNLOAD') aborted = true; };
      window.addEventListener('message', abortHandler);
      const checkAbort = () => { if (aborted) throw new Error('Aborted by user reset.'); };

      const send = (evt, data) => window.postMessage({ type: 'PAGE_EVENT', evt, ...data }, '*');
      const log = (text, level='info') => send('log', { text, level });
      const setStatus = (state, text) => send('status', { state, text });
      const setProgress = (pct, label) => send('progress', { pct, label });
      try {
        const loadScript = src => new Promise((r, e) => { let s = document.createElement('script'); s.src = src; s.onload = r; s.onerror = e; document.head.appendChild(s); });
        if (!window.jspdf) await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
        const parsed = new URL(info.foundUrl);
        const sasToken = info.freshSasToken ? (info.freshSasToken.startsWith('?') ? info.freshSasToken : '?' + info.freshSasToken) : parsed.search;
        const extMatch = parsed.pathname.match(/\.([a-zA-Z0-9]+)(\?|$)/);
        const ext = extMatch ? extMatch[1] : 'webp';
        const pageNumMatch = parsed.pathname.match(/(.*?)(\d+)(\.[a-zA-Z0-9]+)$/);
        if (!pageNumMatch) throw new Error('Parse Error');
        const paddingSize = pageNumMatch[2].length;
        const baseUrl = `${parsed.origin}${pageNumMatch[1]}`;
        const pageMap = new Map();
        let completedCount = 0;
        const startTime = Date.now();
        const fetchWithTimeout = async (url, timeout = 8000) => {
          const controller = new AbortController();
          const id = setTimeout(() => controller.abort(), timeout);
          try { const res = await fetch(url, { signal: controller.signal }); clearTimeout(id); return res; } catch (err) { clearTimeout(id); throw err; }
        };
        for (let i = 1; i <= totalPages; i += 32) {
          checkAbort();
          const chunkPromises = [];
          for (let j = i; j < i + 32 && j <= totalPages; j++) {
            const url = `${baseUrl}${String(j).padStart(paddingSize, '0')}.${ext}${sasToken}`;
            chunkPromises.push(fetchWithTimeout(url).then(async res => {
              if (res.ok) {
                pageMap.set(j, await res.blob());
                completedCount++;
                const rate = completedCount / ((Date.now() - startTime) / 1000);
                const remaining = isNaN(rate) || rate === 0 ? 0 : Math.round((totalPages - completedCount) / rate);
                setProgress(Math.round((completedCount / totalPages) * 50), `Downloading ${completedCount}/${totalPages}`);
                send('stats', { pages: totalPages, done: completedCount, eta: `${remaining}s` });
              }
            }).catch(() => log(`Page ${j} failed`, 'warn')));
          }
          await Promise.all(chunkPromises);
        }
        log('Compiling PDF...', 'info');
        setStatus('running', 'Compiling PDF…');
        const { jsPDF } = window.jspdf;
        let pdf = null;
        for (let i = 1; i <= totalPages; i += 128) {
          checkAbort();
          const batchPromises = [];
          for (let j = i; j < Math.min(i + 128, totalPages + 1); j++) {
            const blob = pageMap.get(j);
            if (!blob) continue;
            batchPromises.push((async (idx, blb) => {
              const bmp = await createImageBitmap(blb);
              const w = bmp.width, h = bmp.height;
              const c = document.createElement('canvas'); c.width = w; c.height = h;
              const ctx = c.getContext('2d', { alpha: false });
              ctx.drawImage(bmp, 0, 0);
              const data = c.toDataURL('image/jpeg', 0.82);
              bmp.close();
              return { idx, data, w, h };
            })(j, blob));
          }
          const results = await Promise.all(batchPromises);
          results.sort((a, b) => a.idx - b.idx);
          for (const item of results) {
            if (!pdf) {
              pdf = new jsPDF({ orientation: item.w > item.h ? 'landscape' : 'portrait', unit: 'px', format: [item.w, item.h], compress: true });
              pdf.addImage(item.data, 'JPEG', 0, 0, item.w, item.h, undefined, 'FAST');
            } else {
              pdf.addPage([item.w, item.h], item.w > item.h ? 'landscape' : 'portrait');
              pdf.addImage(item.data, 'JPEG', 0, 0, item.w, item.h, undefined, 'FAST');
            }
          }
          const doneSoFar = Math.min(i + 128 - 1, totalPages);
          setProgress(50 + Math.round((doneSoFar / totalPages) * 50), `Compiling ${doneSoFar}/${totalPages}`);
        }
        pdf.save(`${info.bookName}.pdf`);
        log(`Saved successfully.`, 'ok');
        setStatus('success', 'Complete!');
        send('stats', { pages: totalPages, done: totalPages, eta: 'Done' });
        send('done', {});
      } catch (e) { log(`Error: ${e.message}`, 'error'); setStatus('error', 'Failed'); send('error', {}); }
    }
  });
}
