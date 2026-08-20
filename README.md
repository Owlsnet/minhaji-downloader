# Minhaji PDF Downloader

> A Chrome extension for downloading full, unlocked PDFs from the [Minhaji Digital Library](https://minhaji.moe.gov.ae) — UAE Ministry of Education's student reading platform.

---

## Features

| Mode | What it does |
|---|---|
| **Images → PDF** | Scrapes individual page images from the viewer, downloads them at high concurrency (32 parallel), and compiles them into a clean PDF |
| **Direct PDF** | Locates and fetches the encrypted source PDF file, decrypts it using the known key via PDF.js, renders each page at 2x resolution, and saves an unlocked copy |

- Auto-detects book name, SAS token, and page count from the active tab
- 32-page concurrent download with real-time ETA
- Full AES/RC4 PDF decryption via PDF.js (not a bypass — uses the actual key)
- Live log panel with timestamped entries, progress bar, and status pill in the popup
- Tries multiple Azure Blob Storage path layouts automatically (direct, `/encrypted/`, `/files/`, etc.)
- Self-healing: injects PDF.js and jsPDF from CDN if not already on the page

---

## File Structure

```
minhaji-downloader/
├── manifest.json        # Chrome MV3 extension manifest
├── popup.html           # Extension popup UI
├── popup.js             # All logic: scraping, download, decrypt, compile
├── injector.js          # Content script stub (document_start)
├── jspdf.umd.min.js     # Bundled jsPDF (used by Images → PDF mode)
├── pdf-lib.min.js       # Bundled pdf-lib (fallback DRM strip)
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

---

## Installation

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer Mode** (toggle in top right)
4. Click **Load unpacked** and select the `minhaji-downloader/` folder
5. The extension icon will appear in your toolbar

---

## How to Use

### Mode 1 — Images → PDF

Best for books where the viewer loads pages as images (webp/png/jpg).

1. Open any book in the Minhaji viewer
2. Navigate to at least **page 1** so the image URL is in memory
3. Click the extension icon
4. Optionally enter the total page count (auto-detected if the viewer shows it)
5. Hit **Download** — pages download at 32 concurrent, then compile to PDF

### Mode 2 — Direct PDF

Best for books served as encrypted PDFs from Azure Blob Storage.

1. Open any book in the viewer — just having it load is enough
2. Click the extension icon
3. Switch to the **Direct PDF** tab
4. Hit **Download & Decrypt PDF**
5. The extension locates the source PDF, decrypts it, renders it, and saves an unlocked copy

> **Note:** The extension must be active on the Minhaji tab. If it says "Asset not detected", scroll through a few pages first.

---

## Technical Deep-Dive

### How scraping works

`scrapePageAssetInfo()` runs in the page's `MAIN` world and:
- Scans `performance.getEntriesByType('resource')` for Azure Blob URLs
- Scans DOM elements for `src`, `data-src`, `data-lazy`, background-image CSS
- Reads `localStorage.sasToken` and `localStorage.book` for fresh auth tokens
- Extracts the book name from the URL path hierarchy (`/books/{relativePath}/{bookName}/pages/...`)
- Strips trailing `.pdf` from book names (some pages store them with extension)
- Auto-detects total page count from DOM text patterns (`/ 101`, `of 101`)

### How the Direct PDF pipeline works

Everything runs inside a single `chrome.scripting.executeScript` call in the page's MAIN world — no byte transfers between contexts:

```
Popup clicks
  → scrapePageAssetInfo() extracts tokens + book metadata
  → Builds candidate URLs (4 path variants × N tokens)
  → Injects runDirectDownload() into page MAIN world
      → Fetches PDF using SAS-token URL (page has auth context)
      → Loads PDF.js from CDN if not present
      → Creates inline blob worker URL (bypasses cross-origin worker restrictions)
      → pdfjsLib.getDocument({ data, password }) — real AES/RC4 decryption
      → Renders each page to canvas at 2x DPI
      → Compiles via jsPDF
      → pdf.save() triggers browser download
  → Returns { ok, numPages, urlIndex } to popup for logging
```

### Why this approach?

- **No byte marshalling**: passing 18MB+ of binary through `executeScript` args is unreliable. The page fetches the PDF itself.
- **Real decryption**: pdf-lib has no password decryption implementation. PDF.js does — it's the same engine that powers Firefox's built-in PDF viewer.
- **Blob worker**: Chrome extensions can't set cross-origin worker URLs. Loading the worker script and re-creating it as a `blob:` URL sidesteps this entirely.

---

## Credits

| Person | Role |
|---|---|
| **[@arccxp](https://github.com/arccxp)** | Reverse engineering — blob storage path analysis, SAS token extraction, PDF encryption key research |
| **[@owls](https://github.com/owls)** | UI/UX design, page scraping logic, download pipeline, PDF compilation |

---

## Disclaimer

This tool is intended for **personal, educational use only** — to access books you are already authorized to read through the Minhaji platform. Do not redistribute downloaded content. The authors take no responsibility for misuse.

---

Made with ai lol
