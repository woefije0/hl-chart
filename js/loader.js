/* loader.js
   Loads lightweight-charts, falling back to a second CDN if the first one is blocked. */

function loadScript(src){
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}
window.__chartLibReady = loadScript('https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js')
  .catch(() => loadScript('https://cdn.jsdelivr.net/npm/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js'))
  .catch(() => { window.__chartLibFailed = true; });
