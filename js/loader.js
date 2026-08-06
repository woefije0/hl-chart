/* loader.js
   Loads lightweight-charts, falling back to a second CDN if the first one is blocked. */

// 보안: 서드파티 CDN에서 받아오는 스크립트는 SRI(Subresource Integrity) 해시로 고정한다.
// 이게 없으면 unpkg/jsdelivr 중 하나만 손상돼도(계정 탈취, 캐시 포이즈닝 등) 임의의 JS가
// 이 앱 안에서 그대로 실행된다 — 지갑 주소/거래 링크를 다루는 화면이라 실제 피해로 이어질 수 있다.
// 두 CDN 모두 같은 npm tarball을 그대로 서빙해서 바이트 단위로 동일하므로 해시 하나로 충분하다.
// (해시를 갱신하려면: curl -sL <url> | openssl dgst -sha384 -binary | openssl base64 -A)
const CHART_LIB_PATH = 'lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js';
const CHART_LIB_SRI = 'sha384-JZigAjwiaZtkUbA44CWkPaT3iBb/mU5pO6QOANp+OqHd4q+1+7MG1kzp2OOP9ZfP';

function loadScript(src){
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.integrity = CHART_LIB_SRI;
    s.crossOrigin = 'anonymous'; // SRI 검증에는 CORS 응답이 필요하다
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}
window.__chartLibReady = loadScript('https://unpkg.com/' + CHART_LIB_PATH)
  .catch(() => loadScript('https://cdn.jsdelivr.net/npm/' + CHART_LIB_PATH))
  .catch(() => { window.__chartLibFailed = true; });
