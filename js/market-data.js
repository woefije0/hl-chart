/* market-data.js
   24h stats / open interest / funding, order book, today candle and the live candle feed. */

// ---------- 상단 바: 24h 거래대금 / OI / 펀딩 (activeAssetCtx 실시간 구독) ----------
function renderAssetCtx(){
  const ctx = state.assetCtx;
  $('statVol').textContent = ctx && Number.isFinite(ctx.dayNtlVlm) ? '$' + formatBigNumber(ctx.dayNtlVlm) : '—';
  const oiWrap = $('statOIWrap');
  const fundWrap = $('statFundingWrap');
  if(!ctx || ctx.isSpot){
    // 스팟은 펀딩/OI 개념이 없음
    oiWrap.style.display = 'none';
    fundWrap.style.display = 'none';
    return;
  }
  oiWrap.style.display = '';
  fundWrap.style.display = '';
  const oiUsd = (Number.isFinite(ctx.openInterest) && Number.isFinite(ctx.markPx)) ? ctx.openInterest * ctx.markPx : NaN;
  $('statOI').textContent = Number.isFinite(oiUsd) ? '$' + formatBigNumber(oiUsd) : '—';
  const fundEl = $('statFunding');
  if(Number.isFinite(ctx.funding)){
    const pct = ctx.funding * 100;
    fundEl.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(4) + '%';
    fundEl.style.color = pct >= 0 ? 'var(--up)' : 'var(--down)';
  }else{
    fundEl.textContent = '—';
    fundEl.style.color = '';
  }
}

function connectAssetCtxWs(coin){
  state.assetCtxWs = closeSubscription(state.assetCtxWs);
  state.assetCtx = null;
  renderAssetCtx();
  state.assetCtxWs = createSubscription({
    subscription: { type: 'activeAssetCtx', coin },
    channels: ['activeAssetCtx', 'activeSpotAssetCtx'],
    onData: (data, channel) => {
      if(!data.ctx) return;
      const ctx = data.ctx;
      state.assetCtx = {
        isSpot: channel === 'activeSpotAssetCtx',
        funding: ctx.funding != null ? parseFloat(ctx.funding) : null,
        openInterest: ctx.openInterest != null ? parseFloat(ctx.openInterest) : null,
        dayNtlVlm: ctx.dayNtlVlm != null ? parseFloat(ctx.dayNtlVlm) : null,
        markPx: ctx.markPx != null ? parseFloat(ctx.markPx) : null,
      };
      renderAssetCtx();
    },
  });
}

// 펀딩 정산은 매시 정각(UTC) — 특정 페어와 무관하게 항상 돌아가는 카운트다운.
// 스팟 페어라 펀딩 줄 자체가 숨겨져 있을 땐 DOM을 건드리지 않고 건너뛴다.
function updateFundingCountdown(){
  const wrap = $('statFundingWrap');
  if(!wrap || wrap.style.display === 'none') return;
  const el = $('fundingCountdown');
  if(!el) return;
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours() + 1, 0, 0, 0));
  const diffMs = Math.max(0, next - now);
  const mm = Math.floor(diffMs / 60000);
  const ss = Math.floor((diffMs % 60000) / 1000);
  el.textContent = String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
}
setInterval(updateFundingCountdown, 1000);
updateFundingCountdown();

// ---------- 오더북(호가창) 패널: l2Book 실시간 구독 ----------
const OB_LEVELS = 12; // 각 사이드(매수/매도)당 표시할 호가 단계 수
const orderbookPanel = $('orderbookPanel');
const orderbookToggleBtn = $('orderbookToggleBtn');
const obAsksEl = $('obAsks');
const obBidsEl = $('obBids');
const obSpreadEl = $('obSpread');
const obSpreadPctEl = $('obSpreadPct');

// 가격 포맷은 formatPrice(유효숫자 5자리)를 그대로 쓰고, 수량은 소수 자릿수를 적당히 줄여서 표시
function formatObSize(v){
  if(!Number.isFinite(v)) return '—';
  if(v >= 1000) return (v / 1000).toFixed(2) + 'K';
  if(v >= 1) return v.toFixed(3);
  if(v === 0) return '0';
  return v.toPrecision(3);
}

// 스프레드 값은 유효숫자 고정 대신 소수점 뒤 불필요한 0만 제거해서 표시 (예: 1, 0.1, 0.05)
function formatSpread(v){
  if(!Number.isFinite(v)) return '—';
  let s = v.toFixed(8); // 부동소수점 오차 제거용으로 충분히 자리수 확보 후
  if(s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '' || s === '-' ? '0' : s;
}

// l2Book은 초당 여러 번 들어오는데, 예전엔 그때마다 24줄짜리 innerHTML 문자열을 새로 만들어
// 통째로 갈아끼웠다(파싱 + DOM 재생성 + GC). 행을 딱 한 번만 만들어 두고 텍스트/막대 너비만
// 갱신하도록 바꿔서, 갱신 한 번의 비용을 문자열 몇 개 대입 수준으로 낮췄다.
function buildObRows(container, cls){
  const rows = [];
  for(let i = 0; i < OB_LEVELS; i++){
    const row = document.createElement('div');
    row.className = 'ob-row ' + cls;
    const bar = document.createElement('div');
    bar.className = 'ob-row-bar ' + cls;
    const px = document.createElement('span');
    px.className = 'ob-px';
    const sz = document.createElement('span');
    sz.className = 'ob-sz';
    const total = document.createElement('span');
    total.className = 'ob-total';
    row.append(bar, px, sz, total);
    container.appendChild(row);
    rows.push({ row, bar, px, sz, total });
  }
  return rows;
}
const obAskRowEls = buildObRows(obAsksEl, 'ask');
const obBidRowEls = buildObRows(obBidsEl, 'bid');

function paintObRows(rowEls, levels, maxCum, reverse){
  // ask는 화면 위쪽이 먼 호가, 아래쪽(중간가와 맞닿는 쪽)이 최우선 호가가 되도록 뒤집어 배치한다.
  // (.ob-asks가 justify-content:flex-end라 남는 행을 숨기면 자연스럽게 아래로 붙는다.)
  const ordered = reverse ? levels.slice().reverse() : levels;
  for(let i = 0; i < rowEls.length; i++){
    const el = rowEls[i];
    const level = ordered[i];
    if(!level){
      el.row.style.display = 'none';
      continue;
    }
    el.row.style.display = '';
    el.bar.style.width = (level.cum / maxCum * 100).toFixed(1) + '%';
    el.px.textContent = formatPrice(level.px);
    el.sz.textContent = formatObSize(level.sz);
    el.total.textContent = formatObSize(level.cum);
  }
}

function clearOrderbookRows(){
  obAskRowEls.forEach(el => { el.row.style.display = 'none'; });
  obBidRowEls.forEach(el => { el.row.style.display = 'none'; });
  obSpreadEl.textContent = '—';
  obSpreadPctEl.textContent = '—';
}

function renderOrderbook(){
  if(!state.orderbookOpen) return;
  const data = state.orderbook;
  if(!data || !data.bids.length || !data.asks.length){
    clearOrderbookRows();
    return;
  }
  const bids = data.bids.slice(0, OB_LEVELS); // best-first (내림차순, index0 = 최고 매수가)
  const asks = data.asks.slice(0, OB_LEVELS); // best-first (오름차순, index0 = 최저 매도가)

  // 각 사이드 안에서 최우선 호가(중간가에 가장 가까운 가격)부터 누적 수량을 계산
  let cum = 0;
  const bidRows = bids.map(l => { cum += l.sz; return { px: l.px, sz: l.sz, cum }; });
  cum = 0;
  const askRows = asks.map(l => { cum += l.sz; return { px: l.px, sz: l.sz, cum }; });
  const maxCum = Math.max(
    bidRows.length ? bidRows[bidRows.length - 1].cum : 0,
    askRows.length ? askRows[askRows.length - 1].cum : 0
  ) || 1;

  paintObRows(obAskRowEls, askRows, maxCum, true);
  paintObRows(obBidRowEls, bidRows, maxCum, false);

  const bestBid = bids[0].px, bestAsk = asks[0].px;
  const mid = (bestBid + bestAsk) / 2;
  const spread = bestAsk - bestBid;
  const spreadPct = mid > 0 ? (spread / mid * 100) : 0;
  obSpreadEl.textContent = formatSpread(spread);
  obSpreadPctEl.textContent = '(' + spreadPct.toFixed(3) + '%)';
}

function connectOrderbookWs(coin){
  state.obWs = closeSubscription(state.obWs);
  state.orderbook = null;
  clearOrderbookRows();
  if(!coin || !state.orderbookOpen) return; // 패널이 닫혀 있으면 구독하지 않음 (불필요한 트래픽 방지)
  state.obWs = createSubscription({
    subscription: { type: 'l2Book', coin },
    channels: 'l2Book',
    onData: (data) => {
      if(!data.levels) return;
      const toLevels = (raw) => (raw || [])
        .map(l => ({ px: parseFloat(l.px), sz: parseFloat(l.sz) }))
        .filter(l => Number.isFinite(l.px) && Number.isFinite(l.sz));
      state.orderbook = { bids: toLevels(data.levels[0]), asks: toLevels(data.levels[1]) };
      // 호가는 초당 여러 번 오지만 사람 눈은 프레임보다 빨리 못 읽는다 -> 프레임당 1회로 합침
      scheduleFrame('orderbook', renderOrderbook);
    },
  });
}

function toggleOrderbookPanel(){
  state.orderbookOpen = !state.orderbookOpen;
  orderbookPanel.style.display = state.orderbookOpen ? 'flex' : 'none';
  orderbookToggleBtn.classList.toggle('on', state.orderbookOpen);
  store.set('ob_open', state.orderbookOpen);
  // 패널이 열리고 닫히면 차트 폭이 바뀌는데, 리사이즈는 #chart의 ResizeObserver가 알아서 처리한다.
  // (예전엔 여기서 fitContent()를 불러서 사용자가 맞춰둔 확대/스크롤 위치가 매번 초기화됐다.)
  if(state.orderbookOpen){
    connectOrderbookWs(state.coin);
  }else{
    state.obWs = closeSubscription(state.obWs);
    state.orderbook = null;
  }
}
orderbookToggleBtn.addEventListener('click', toggleOrderbookPanel);
// 새로고침 전에 열려 있었다면 초기 상태 반영 (실제 구독은 첫 pair 선택 시 selectPair에서 시작됨)
if(state.orderbookOpen){
  orderbookPanel.style.display = 'flex';
  orderbookToggleBtn.classList.add('on');
}

// ---------- 상단 바 "오늘" 통계 전용 (선택된 인터벌과 무관하게 항상 1d 기준) ----------
async function fetchTodayCandle(coin){
  try{
    const history = await fetchHistory(coin, '1d');
    if(!Array.isArray(history) || !history.length) return null;
    return toChartCandle(history[history.length - 1]);
  }catch(err){
    console.warn('[HL Chart] 오늘 통계(1d) 로드 실패', err);
    return null;
  }
}

function connectTodayWs(coin){
  state.todayWs = closeSubscription(state.todayWs);
  state.todayWs = createSubscription({
    subscription: { type: 'candle', coin, interval: '1d' },
    channels: 'candle',
    onData: (data) => {
      state.todayCandle = toChartCandle(data);
      renderTodayIfNotHovering();
    },
  });
}

// ---------- WebSocket 실시간 구독 (native candle / agg 기반 candle) ----------
function connectWsGeneric(coin, interval){
  state.ws = closeSubscription(state.ws);
  setStatus('statusConnecting');
  const meta = INTERVAL_META[interval];
  state.ws = createSubscription({
    subscription: { type: 'candle', coin, interval: meta.kind === 'agg' ? meta.base : interval },
    channels: 'candle',
    onOpen: () => setStatus('statusLive', 'live'),
    onError: () => {
      setStatus('statusConnError', 'err');
      showNetBanner(t('bannerWsBlocked'));
    },
    onData: (data) => {
      if(state.replayMode) return; // 리플레이 중엔 실시간 틱이 currentBars/시리즈를 건드리지 않게 함
      const c = toChartCandle(data);
      if(meta.kind === 'agg'){
        ingestAggCandle(c, meta.ms);
      }else{
        const safeC = normalizeLiveBar(c);
        updateSeriesWithCandle(safeC);
        state.volumeSeries.update(volPoint(safeC));
        state.lastCandle = safeC;
        pushOrUpdateBar(safeC);
        updatePriceBar();
      }
    },
  });
}

// ---------- 실시간 gap filler ----------
// agg 모드에서 한동안 1m 봉이 안 들어오면 화면이 멈춰 보이므로, 주기적으로 현재 버킷이
// 넘어갔는지 확인해서 직전 종가로 이어지는 flat 봉을 채워준다.
function startGapFiller(ms){
  stopGapFiller();
  state.gapTimer = setInterval(() => {
    if(state.replayMode) return;
    if(!state.liveAgg) return;
    const bucketSec = Math.floor(Date.now() / ms) * (ms / 1000);
    if(bucketSec > state.liveAgg.time){
      const flat = { time: bucketSec, open: state.liveAgg.close, high: state.liveAgg.close, low: state.liveAgg.close, close: state.liveAgg.close, volume: 0 };
      state.liveAgg = flat;
      updateSeriesWithCandle(flat);
      state.volumeSeries.update(volPoint(flat));
      state.lastCandle = flat;
      pushOrUpdateBar(flat);
      updatePriceBar();
    }
  }, Math.min(ms, 1000));
}
function stopGapFiller(){
  if(state.gapTimer){ clearInterval(state.gapTimer); state.gapTimer = null; }
}
