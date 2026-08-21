// Relays events from the MAIN world page script to the background service worker
window.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'PAGE_EVENT') {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
        chrome.runtime.sendMessage(e.data);
      }
    } catch (_) {}
  }
});
