/* indicator-funding.js
   Funding rate history — independent side panel (table), not a chart pane.

   처음엔 RSI/MACD처럼 메인 차트와 시간축을 동기화하는 하단 패널로 만들었었는데, 펀딩비는
   1시간마다 정산되는 이벤트 데이터라서 15m/4h/1d 같은 캔들 타임프레임의 바 개수/간격과
   전혀 맞물리지 않는다 — 로지컬 레인지(봉 인덱스) 기준으로 동기화하면 인터벌을 바꿀 때마다
   두 차트가 서로 다른 밀도의 데이터를 갖게 되어 화면이 어긋났다. 그래서 오더북과 똑같이,
   메인 차트와 무관하게 독립적으로 열고 닫는 표 형태의 사이드 패널로 바꿨다.
*/

const fundingToggleBtn = $('fundingToggleBtn');
const fundingPanel = $('fundingPanel');
const fundingSummaryEl = $('fundingSummary');
const fundingEmptyMsgEl = $('fundingEmptyMsg');
const fundingTableBodyEl = $('fundingTableBody');

const FUNDING_LOOKBACK_DAYS = 30; // 기간을 고를 수 있게 했었는데, 서버가 한 번에 돌려주는 개수에
// 상한이 있어서(요청 범위가 넓을수록 최신 쪽이 아니라 과거 쪽 일부만 잘려서 오는 것처럼 보였다 —
// 30일을 선택해도 "어느 정도 과거에서부터" 시작하는 것처럼 보인 원인) 고정 30일로 단순화하고,
// 아래 fetchFundingHistoryPaged()에서 그 상한을 우회해 항상 "지금"까지 채워 넣는다.

// ---------- REST: fundingHistory ----------
async function fetchFundingHistoryOnce(coin, startTime){
  const rows = await info({ type: 'fundingHistory', coin, startTime });
  if(!Array.isArray(rows)) return [];
  return rows
    .map(r => ({ time: Math.floor(r.time / 1000), fundingRate: parseFloat(r.fundingRate) }))
    .filter(r => Number.isFinite(r.time) && Number.isFinite(r.fundingRate))
    .sort((a, b) => a.time - b.time);
}
// 한 번의 요청이 전체 구간을 다 못 돌려줄 수 있어서(서버 쪽 응답 개수 제한으로 추정 — 오래된
// 쪽부터 잘려 온다), 마지막으로 받은 시각을 다음 요청의 startTime으로 삼아 "지금"에 닿을
// 때까지 이어 붙인다. 데이터가 없거나 진전이 없으면 즉시 멈춰서 무한 루프를 막는다.
async function fetchFundingHistoryPaged(coin, startTime){
  const nowMs = Date.now();
  let all = [];
  let cursor = startTime;
  for(let guard = 0; guard < 20; guard++){
    const page = await fetchFundingHistoryOnce(coin, cursor);
    if(!page.length) break;
    all = all.concat(page);
    const lastTime = page[page.length - 1].time;
    if(lastTime * 1000 >= nowMs - 3600000) break; // 최근 1시간 이내까지 왔으면 충분
    const nextCursor = lastTime * 1000 + 1;
    if(nextCursor <= cursor) break; // 진전이 없으면 중단 (방어적)
    cursor = nextCursor;
  }
  return all;
}

// 리플레이 바의 시간 라벨과 같은 포맷(연/월/일 시:분, 언어별 로케일)을 그대로 씀.
function formatFundingTime(timeSec){
  try{
    return new Date(timeSec * 1000).toLocaleString(state.lang === 'kr' ? 'ko-KR' : 'en-US', {
      year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  }catch(e){
    return String(timeSec);
  }
}
function formatFundingPct(rate){
  const pct = rate * 100;
  return (pct >= 0 ? '+' : '') + pct.toFixed(4) + '%';
}
// Hyperliquid 펀딩은 1시간마다 정산 -> 연환산은 해당 정산값 x 24 x 365
function formatFundingAnnual(rate){
  const ann = rate * 24 * 365 * 100;
  return (ann >= 0 ? '+' : '') + ann.toFixed(1) + '%';
}

function renderFundingSummary(points){
  if(!points || !points.length){ fundingSummaryEl.textContent = t('fundingNoData'); return; }
  const avg = points.reduce((s, p) => s + p.fundingRate, 0) / points.length;
  fundingSummaryEl.innerHTML =
    `<span>${t('fundingAvgLabel')} <b class="funding-summary-val" style="color:${avg >= 0 ? 'var(--up)' : 'var(--down)'}">${formatFundingPct(avg)}</b></span>` +
    `<span>${t('fundingAnnLabel')} <b class="funding-summary-val" style="color:${avg >= 0 ? 'var(--up)' : 'var(--down)'}">${formatFundingAnnual(avg)}</b></span>` +
    `<span class="funding-summary-count">${points.length}${t('fundingRecordsSuffix')}</span>`;
}

function renderFundingTable(points){
  fundingTableBodyEl.innerHTML = '';
  if(!points || !points.length) return;
  // 최신 정산분이 위로 오게 뒤집어서 표시 (오더북처럼 스크롤 없이도 최근 값부터 보이도록)
  const frag = document.createDocumentFragment();
  for(let i = points.length - 1; i >= 0; i--){
    const p = points[i];
    const row = document.createElement('div');
    row.className = 'funding-row';
    const up = p.fundingRate >= 0;
    row.innerHTML =
      `<span class="funding-time">${formatFundingTime(p.time)}</span>` +
      `<span class="funding-rate ${up ? 'up' : 'down'}">${formatFundingPct(p.fundingRate)}</span>` +
      `<span class="funding-ann ${up ? 'up' : 'down'}">${formatFundingAnnual(p.fundingRate)}</span>`;
    frag.appendChild(row);
  }
  fundingTableBodyEl.appendChild(frag);
}

// 전체 재조회. 심볼이 바뀌거나, 패널이 열려있는 동안 주기적으로 호출된다.
async function refreshFundingPanel(){
  if(!state.fundingOpen) return;
  const isSpot = state.isSpot;
  fundingEmptyMsgEl.style.display = isSpot ? 'flex' : 'none';
  fundingTableBodyEl.style.display = isSpot ? 'none' : 'flex';
  if(isSpot){
    state.fundingRawPoints = null;
    fundingSummaryEl.textContent = '—';
    fundingTableBodyEl.innerHTML = '';
    return; // 스팟은 펀딩 개념이 없음 — REST 호출 자체를 하지 않는다.
  }
  const coin = state.coin;
  if(!coin) return;
  const startTime = Date.now() - FUNDING_LOOKBACK_DAYS * 86400000;
  let pts;
  try{
    pts = await fetchFundingHistoryPaged(coin, startTime);
  }catch(err){
    console.warn('[HL Chart] 펀딩비 히스토리 로드 실패', err);
    fundingSummaryEl.textContent = t('fundingLoadFailed');
    return;
  }
  if(state.coin !== coin || !state.fundingOpen) return; // 그 사이 심볼이 바뀌었거나 패널이 닫힘

  // 같은 시간(time)에 값이 중복되면 마지막 값 유지 (페이지 경계/REST 스냅샷 방어)
  pts.sort((a, b) => a.time - b.time);
  const deduped = [];
  for(const p of pts){
    if(deduped.length && deduped[deduped.length - 1].time === p.time) deduped[deduped.length - 1] = p;
    else deduped.push(p);
  }
  state.fundingRawPoints = deduped;
  renderFundingSummary(deduped);
  renderFundingTable(deduped);
}

// 패널이 열려있는 동안 5분마다 재조회해서 방금 정산된 시간당 값을 반영한다.
// (틱마다 오는 activeAssetCtx의 실시간 funding과 달리 fundingHistory는 REST 스냅샷이라
//  실시간 구독이 없다 — 그렇다고 너무 자주 부르면 낭비라 5분 간격으로 절충.)
function startFundingAutoRefresh(){
  stopFundingAutoRefresh();
  state.fundingRefreshTimer = setInterval(refreshFundingPanel, 5 * 60 * 1000);
}
function stopFundingAutoRefresh(){
  if(state.fundingRefreshTimer){ clearInterval(state.fundingRefreshTimer); state.fundingRefreshTimer = null; }
}

function toggleFundingPanel(){
  state.fundingOpen = !state.fundingOpen;
  fundingPanel.style.display = state.fundingOpen ? 'flex' : 'none';
  fundingToggleBtn.classList.toggle('on', state.fundingOpen);
  store.set('funding_open', state.fundingOpen);
  if(state.fundingOpen){
    refreshFundingPanel();
    startFundingAutoRefresh();
  }else{
    stopFundingAutoRefresh();
  }
}
fundingToggleBtn.addEventListener('click', toggleFundingPanel);
// 새로고침 전에 열려 있었다면 초기 상태 반영 (실제 데이터는 첫 pair 선택 시 selectPair에서 불러옴)
if(state.fundingOpen){
  fundingPanel.style.display = 'flex';
  fundingToggleBtn.classList.add('on');
}
