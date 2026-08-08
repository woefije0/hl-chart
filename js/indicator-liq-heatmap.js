/* indicator-liq-heatmap.js
   청산 히트맵 — 모델링된 추정치 오버레이.

   하이퍼리퀴드 공개 API는 특정 유저 주소를 미리 알아야만 청산 이벤트를 구독할 수 있어서
   (whale-tracker.js 주석 참고), 시장 전체의 실제 청산가 분포는 얻을 방법이 없다. 그래서 이
   지표는 실제 데이터(자산별 maxLeverage, 현재 OI/markPx, 과거 캔들 거래량)로 최대한 근거 있게
   추정한 뒤, 최종 결과의 총량을 실제 OI(USD)에 정확히 맞춰 스케일링한다 — "분포는 추정, 총량은
   실측"이라는 절충으로 순수 가정형 모델보다 신뢰도를 높인 것이며, 개별 트레이더의 실제 진입가/
   레버리지 선택 자체는 여전히 추정이다.

   렌더링은 lightweight-charts v4에 캔버스 프리미티브 API가 없어서, drawings.js와 같은 방식
   (자체 <canvas> + priceToCoordinate 매 프레임 재계산)을 따른다. 새 rAF 루프를 만들지 않고
   drawings.js의 startOverlayLoop()에 한 줄만 얹는다.
*/

// ---------- 모델 상수 ----------
const LIQ_HEATMAP_ENTRY_BINS = 300;   // 진입가 히스토그램 (거래량-가격 프로파일)
const LIQ_HEATMAP_OUTPUT_BINS = 400;  // 출력(청산가) 히스토그램
const LIQ_HEATMAP_OUTPUT_RANGE = [0.3, 3.0]; // markPx 대비 [최소, 최대] — 최저 레버리지 티어의 청산가까지 여유있게 담는 범위
const LIQ_HEATMAP_RESCALE_THRESHOLD = 0.005; // OI(USD) 변화가 이 미만이면 리스케일 스킵
const LIQ_HEATMAP_CLOCK_INTERVAL = '15m'; // 전체 재계산을 언제 다시 돌릴지 정하는 clock용 캔들 구독(모델 자체 lookback interval과는 무관)

// 레버리지 비율(0~1, 코인의 maxLeverage 대비 상대 위치)에 대한 가중치 곡선.
// 실제 트레이더의 레버리지 선택 분포는 공개돼 있지 않다 — 중간 레버리지(비율 0.35 부근)에
// 피크를 두고 양 극단(초저배율/최대배율)으로 갈수록 줄어드는 형태로 "합리적인 추정"을 둔다.
// 모델 전체에서 순수 가정에 의존하는 부분은 사실상 이 곡선 하나뿐이라 여기 한 곳에 모아둔다.
function leverageRatioWeight(ratio){
  const peak = 0.35, spread = 0.28;
  return Math.exp(-Math.pow(ratio - peak, 2) / (2 * spread * spread));
}

// ---------- REST: 전용 lookback 히스토리 ----------
// state.currentBars(현재 보고 있는 인터벌)와 무관하게, 항상 설정된 interval(기본 1h)로 별도
// 조회한다 — 그래야 사용자가 15m/4h 등으로 화면 인터벌을 바꿔도 매번 다시 계산하지 않는다.
// fetchHistory 한 번은 최대 500개까지만 주므로(candles.js), lookback이 그보다 길면
// fetchLowerTf1mRange와 같은 방식으로 과거 방향으로 페이지네이션한다.
async function fetchLiqHeatmapHistory(coin, lookbackDays, interval){
  const nowMs = Date.now();
  const targetStartMs = nowMs - lookbackDays * 86400000;
  const MAX_REQUESTS = 6;
  let endMs = nowMs;
  const seen = new Set();
  let collected = [];
  for(let i = 0; i < MAX_REQUESTS; i++){
    let page;
    try{ page = await fetchHistory(coin, interval, endMs); }
    catch(e){ break; }
    if(!Array.isArray(page) || !page.length) break;
    const chunk = page.map(toChartCandle).filter(c => !seen.has(c.time));
    if(!chunk.length) break;
    chunk.forEach(c => seen.add(c.time));
    collected = collected.concat(chunk);
    const earliest = chunk.reduce((m, c) => Math.min(m, c.time), Infinity);
    if(earliest * 1000 <= targetStartMs) break;
    endMs = earliest * 1000;
  }
  collected.sort((a, b) => a.time - b.time);
  return collected.filter(c => c.time * 1000 >= targetStartMs);
}

// ---------- 모델 계산 (비싼 단계 — 페어/설정 변경 시에만) ----------
function addToLiqBins(bins, outMin, outBinW, px, mass){
  if(!Number.isFinite(px) || px <= 0 || !mass) return;
  const idx = Math.floor((px - outMin) / outBinW);
  if(idx < 0 || idx >= bins.length) return;
  bins[idx].mass += mass;
}

function computeLiqHeatmapRaw(bars, maxLeverage){
  if(!bars || !bars.length || !Number.isFinite(maxLeverage) || maxLeverage < 1) return null;

  const nowSec = bars[bars.length - 1].time;
  const halfLifeDays = state.liqHeatmapSettings.halfLifeDays;
  let minPx = Infinity, maxPx = -Infinity;
  const weighted = bars.map(b => {
    const hlc3 = (b.high + b.low + b.close) / 3;
    const ageDays = Math.max(0, (nowSec - b.time) / 86400);
    const decay = Math.exp(-Math.LN2 * ageDays / halfLifeDays);
    const notional = (b.volume || 0) * hlc3 * decay; // 달러 환산은 그대로 hlc3 기준
    if(b.low < minPx) minPx = b.low;
    if(b.high > maxPx) maxPx = b.high;
    return { low: b.low, high: b.high, notional };
  });
  if(!Number.isFinite(minPx) || !Number.isFinite(maxPx) || maxPx <= minPx) return null;

  // 1) 진입가 프록시 = 거래량-가격 프로파일. 봉 하나를 hlc3 한 점으로 뭉개지 않고,
  //    그 봉의 high~low 범위에 겹치는 만큼 비례 분배한다(틱 데이터 없이 만드는 volume profile의
  //    표준적인 근사 방식) — 그래야 롱 꼬리를 가진 봉의 거래량이 종가 근처 한 bin에만 쏠리지 않는다.
  const entryBinW = (maxPx - minPx) / LIQ_HEATMAP_ENTRY_BINS;
  const entryMass = new Array(LIQ_HEATMAP_ENTRY_BINS).fill(0);
  weighted.forEach(({ low, high, notional }) => {
    if(!notional) return;
    if(!(high > low)){
      const idx = Math.max(0, Math.min(LIQ_HEATMAP_ENTRY_BINS - 1, Math.floor((low - minPx) / entryBinW)));
      entryMass[idx] += notional;
      return;
    }
    const loIdx = Math.max(0, Math.floor((low - minPx) / entryBinW));
    const hiIdx = Math.min(LIQ_HEATMAP_ENTRY_BINS - 1, Math.floor((high - minPx) / entryBinW));
    const barRange = high - low;
    for(let idx = loIdx; idx <= hiIdx; idx++){
      const binLo = minPx + idx * entryBinW;
      const binHi = binLo + entryBinW;
      const overlap = Math.min(high, binHi) - Math.max(low, binLo);
      if(overlap <= 0) continue;
      entryMass[idx] += notional * (overlap / barRange);
    }
  });

  // 2) 레버리지 티어 — maxLeverage 대비 상대 비율로 생성(코인마다 최대 레버리지가 크게 다름:
  //    BTC 40x, ETH 25x, 그 외 다수 10~20x). 반올림 후 같은 정수로 겹치는 티어는 가중치를 합산한다.
  const ratios = state.liqHeatmapSettings.leverageTierRatios;
  const tierMap = new Map(); // leverage(정수) -> 가중치 합
  ratios.forEach(r => {
    const lev = Math.max(1, Math.round(r * maxLeverage));
    tierMap.set(lev, (tierMap.get(lev) || 0) + leverageRatioWeight(r));
  });
  const tierWeightSum = [...tierMap.values()].reduce((s, w) => s + w, 0) || 1;
  const mmr = 1 / (2 * maxLeverage); // 유지증거금율 근사치 — 실제 구간별 마진테이블 대신 HL의 대략적 관례를 사용 (정확도 한계)

  // 3) 출력(청산가) 범위 — 최저 레버리지 티어의 청산가까지 담을 수 있게 markPx 기준으로 넉넉히 잡는다
  const markPx = state.assetCtx && Number.isFinite(state.assetCtx.markPx) ? state.assetCtx.markPx : (minPx + maxPx) / 2;
  const outMin = markPx * LIQ_HEATMAP_OUTPUT_RANGE[0];
  const outMax = markPx * LIQ_HEATMAP_OUTPUT_RANGE[1];
  const outBinW = (outMax - outMin) / LIQ_HEATMAP_OUTPUT_BINS;
  const longBins = Array.from({ length: LIQ_HEATMAP_OUTPUT_BINS }, (_, i) => ({ loPx: outMin + i * outBinW, hiPx: outMin + (i + 1) * outBinW, mass: 0 }));
  const shortBins = Array.from({ length: LIQ_HEATMAP_OUTPUT_BINS }, (_, i) => ({ loPx: outMin + i * outBinW, hiPx: outMin + (i + 1) * outBinW, mass: 0 }));

  // 4) 진입가 bin x 레버리지 티어 팬아웃 -> 롱/숏 청산가 각각에 누적 (방향 정보가 없어 50/50 분배 — 단순화 가정)
  //
  // 원래는 봉별 OI 변화량(deltaOI)과 가격 변화의 조합(가격↑OI↑=롱 진입, 가격↓OI↑=숏 진입,
  // 가격↑OI↓=숏 청산, 가격↓OI↓=롱 청산)으로 이 50/50을 깨려 했다. 하이퍼리퀴드 공개 API가
  // 과거 시점별 OI 히스토리를 아예 제공하지 않아서(activeAssetCtx는 현재 스냅샷만, candleSnapshot은
  // OHLCV만) 봉마다 deltaOI를 계산할 방법이 없어 보류함 — API가 지원하면 여기부터 다시 시작.
  //
  // 펀딩비(fundingHistory, 실측 시계열)로 이 50/50을 깨는 방안을 검토했었다 — 업계(Coinglass류)에서
  // 실제로 "펀딩비가 스트레치될수록 그 쪽이 더 크라우디/레버리지가 높아 청산에 취약하다"는 프록시로
  // 씀. "OI가 롱/숏으로 불균형하다"는 뜻은 아니라서(모든 체결은 롱 1 : 숏 1로 항상 대칭) 구조적으로
  // 틀린 얘기는 아니지만, leverageRatioWeight()와 마찬가지로 결국 또 하나의 가정을 얹는 것이고
  // 체감 효과 대비 비용(가정 하나 추가, 정규화/스케일링 파라미터 필요)이 안 맞는다고 판단해서
  // 의도적으로 구현하지 않았다. 나중에 다시 검토할 거면 여기서부터 시작.
  let totalRaw = 0;
  for(let bin = 0; bin < LIQ_HEATMAP_ENTRY_BINS; bin++){
    const mass = entryMass[bin];
    if(!mass) continue;
    const entryPx = minPx + (bin + 0.5) * entryBinW;
    tierMap.forEach((tierWeight, lev) => {
      const w = (tierWeight / tierWeightSum) * mass * 0.5;
      const liqLong = entryPx * (1 - 1 / lev + mmr);
      const liqShort = entryPx * (1 + 1 / lev - mmr);
      addToLiqBins(longBins, outMin, outBinW, liqLong, w);
      addToLiqBins(shortBins, outMin, outBinW, liqShort, w);
      totalRaw += w * 2;
    });
  }

  return { longBins, shortBins, totalRaw };
}

// ---------- OI 앵커링 (저렴한 단계 — 매 assetCtx 틱마다) ----------
function rescaleLiqHeatmap(){
  if(!state.liqHeatmapOn || state.isSpot || state.replayMode || !state.liqHeatmapRaw) return;
  const ctx = state.assetCtx;
  if(!ctx || !Number.isFinite(ctx.openInterest) || !Number.isFinite(ctx.markPx)) return;
  const oiUsd = ctx.openInterest * ctx.markPx;
  if(!Number.isFinite(oiUsd) || oiUsd <= 0) return;
  if(state.liqHeatmapLastOiUsd != null){
    const change = Math.abs(oiUsd - state.liqHeatmapLastOiUsd) / state.liqHeatmapLastOiUsd;
    if(change < LIQ_HEATMAP_RESCALE_THRESHOLD) return;
  }
  state.liqHeatmapLastOiUsd = oiUsd;
  const raw = state.liqHeatmapRaw;
  const scale = raw.totalRaw > 0 ? oiUsd / raw.totalRaw : 0;
  state.liqHeatmapScaled = {
    longBins: raw.longBins.map(b => ({ loPx: b.loPx, hiPx: b.hiPx, mass: b.mass * scale })),
    shortBins: raw.shortBins.map(b => ({ loPx: b.loPx, hiPx: b.hiPx, mass: b.mass * scale })),
  };
  liqHeatmapDirty = true;
}

// ---------- 생명주기 ----------
let liqHeatmapFetchToken = 0;
let liqHeatmapClockBarTime = null; // connectLiqHeatmapClock()의 새 봉 감지용 — 직전에 본 15분봉 시작시각
// 모델은 화면에 보이는 캔들 인터벌과 무관하게 항상 자체 lookback(기본 1h)으로 계산한다 —
// 그래서 15m/4h처럼 "차트 인터벌만" 바뀌는 경우(코인/모델 설정은 그대로)는 다시 계산해도
// 결과가 사실상 같다. refreshAllIndicators()는 인터벌 전환/과거 데이터 추가 로딩 때마다도
// 호출되므로, 여기서 (코인+설정) 시그니처가 그대로면 REST 재조회 자체를 건너뛴다.
let liqHeatmapLastFetchSig = null;
async function refreshLiqHeatmapFull(){
  if(!state.liqHeatmapOn || state.isSpot || state.replayMode || !state.coin){
    state.liqHeatmapRaw = null;
    state.liqHeatmapScaled = null;
    liqHeatmapLastFetchSig = null;
    liqHeatmapDirty = true;
    return;
  }
  const coin = state.coin;
  const { lookbackDays, interval, halfLifeDays, leverageTierRatios } = state.liqHeatmapSettings;
  const sig = [coin, lookbackDays, interval, halfLifeDays, leverageTierRatios.join(',')].join('|');
  if(sig === liqHeatmapLastFetchSig && state.liqHeatmapRaw) return; // 코인/설정이 그대로면 스킵 (예: 순수 타임프레임 전환)

  const token = ++liqHeatmapFetchToken;
  const pairInfo = state.allPairs.find(p => p.coin === coin);
  const maxLeverage = pairInfo && Number.isFinite(pairInfo.maxLeverage) ? pairInfo.maxLeverage : null;
  if(!maxLeverage){
    // 이 자산의 maxLeverage를 모르면 청산가 계산 근거가 없다 — 조용히 비활성 상태로 둔다.
    state.liqHeatmapRaw = null;
    state.liqHeatmapScaled = null;
    liqHeatmapLastFetchSig = null;
    liqHeatmapDirty = true;
    return;
  }
  let bars;
  try{
    bars = await fetchLiqHeatmapHistory(coin, lookbackDays, interval);
  }catch(e){
    console.warn('[HL Chart] 청산 히트맵 히스토리 로드 실패', e);
    return;
  }
  if(token !== liqHeatmapFetchToken || state.coin !== coin || !state.liqHeatmapOn) return; // 그 사이 코인이 바뀌었거나 꺼짐

  state.liqHeatmapRaw = computeLiqHeatmapRaw(bars, maxLeverage);
  liqHeatmapLastFetchSig = sig;
  state.liqHeatmapLastOiUsd = null; // 다음 rescale이 임계값과 무관하게 무조건 실행되도록
  if(state.liqHeatmapRaw) rescaleLiqHeatmap();
  liqHeatmapDirty = true;
}

// 예전엔 벽시계 기준 setInterval(15분)로 전체 재계산을 돌렸는데, 그러면 토글을 켠 시점에 따라
// 갱신 타이밍이 임의로 어긋나고(:03에 켰으면 :18, :33...) 새 봉 마감과도 안 맞았다. 15분봉
// 캔들 구독을 순수 clock 용도로 붙여서, 실제로 새 봉이 시작되는 순간(직전 봉의 t가 바뀌는 순간)에
// 맞춰 재계산하도록 바꿨다 — 렌더링에 쓰는 데이터가 아니라 "언제 다시 계산할지" 신호로만 쓴다.
function connectLiqHeatmapClock(coin){
  disconnectLiqHeatmapClock();
  if(!coin) return;
  liqHeatmapClockBarTime = null;
  state.liqHeatmapClockWs = createSubscription({
    subscription: { type: 'candle', coin, interval: LIQ_HEATMAP_CLOCK_INTERVAL },
    channels: 'candle',
    onData: (data) => {
      const barTime = Math.floor(data.t / 1000);
      if(liqHeatmapClockBarTime !== null && barTime !== liqHeatmapClockBarTime) refreshLiqHeatmapFull();
      liqHeatmapClockBarTime = barTime;
    },
  });
}
function disconnectLiqHeatmapClock(){
  state.liqHeatmapClockWs = closeSubscription(state.liqHeatmapClockWs);
  liqHeatmapClockBarTime = null;
}

// ---------- 캔버스 ----------
let liqHeatmapCanvasW = 0, liqHeatmapCanvasH = 0;
let liqHeatmapResizeObserverAttached = false;
let liqHeatmapDirty = true;
let liqHeatmapLastViewSig = null;

function resizeLiqHeatmapCanvas(){
  if(!state.liqHeatmapCanvas) return;
  const { canvas, ctx } = state.liqHeatmapCanvas;
  const rect = chartEl.getBoundingClientRect();
  liqHeatmapCanvasW = rect.width; liqHeatmapCanvasH = rect.height;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  canvas.style.width = rect.width + 'px';
  canvas.style.height = rect.height + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function createLiqHeatmapCanvas(){
  if(!state.liqHeatmapCanvas){
    const canvas = document.getElementById('liqHeatmapOverlay');
    state.liqHeatmapCanvas = { canvas, ctx: canvas.getContext('2d') };
  }
  resizeLiqHeatmapCanvas();
  if(!liqHeatmapResizeObserverAttached){
    liqHeatmapResizeObserverAttached = true;
    new ResizeObserver(() => { resizeLiqHeatmapCanvas(); liqHeatmapDirty = true; }).observe(chartEl);
  }
  liqHeatmapDirty = true;
}
function removeLiqHeatmapCanvas(){
  if(!state.liqHeatmapCanvas) return;
  state.liqHeatmapCanvas.ctx.clearRect(0, 0, liqHeatmapCanvasW, liqHeatmapCanvasH);
}

// ---------- 렌더 ----------
// 이름 주의: pine-builtins.js도 전역 hexToRgb()를 정의하는데(배열 [r,g,b] 반환, 이 파일보다
// 나중에 로드됨) 같은 이름을 썼다가 그쪽이 이걸 덮어써서 a.r/a.g/a.b가 전부 undefined가 되고
// "rgb(NaN,NaN,NaN)"이 브라우저에서 검정으로 렌더링되는 버그가 실제로 발생했다 — 접두사로 분리.
function liqHeatmapHexToRgb(hex){
  const h = hex.replace('#', '');
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}
function liqHeatmapInterpolateRgb(t){
  const stops = state.liqHeatmapSettings.gradient;
  t = Math.max(0, Math.min(1, t));
  const seg = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(seg));
  const localT = seg - i;
  const a = liqHeatmapHexToRgb(stops[i]), b = liqHeatmapHexToRgb(stops[i + 1]);
  return {
    r: Math.round(a.r + (b.r - a.r) * localT),
    g: Math.round(a.g + (b.g - a.g) * localT),
    b: Math.round(a.b + (b.b - a.b) * localT),
  };
}
function liqHeatmapGradientColor(t){
  const { r, g, b } = liqHeatmapInterpolateRgb(t);
  return `rgb(${r},${g},${b})`;
}
function liqHeatmapRgba(t, alpha){
  const { r, g, b } = liqHeatmapInterpolateRgb(t);
  return `rgba(${r},${g},${b},${alpha})`;
}

function liqHeatmapViewSignature(){
  if(!state.chart || !state.candleSeries) return null;
  const range = state.chart.timeScale().getVisibleLogicalRange();
  const top = state.candleSeries.coordinateToPrice(0);
  const bottom = state.candleSeries.coordinateToPrice(liqHeatmapCanvasH);
  return (range ? range.from.toFixed(2) + ',' + range.to.toFixed(2) : '-') + '|' + top + '|' + bottom;
}

// 레버리지 팬아웃이 넓게 퍼지는 가우시안이라, 청산가 히스토그램 자체가 낮은 강도의 긴 꼬리를
// 전체 모델 범위(markPx의 0.3~3배)에 걸쳐 깔고 있다. 1) 일정 강도 미만은 아예 그리지 않고
// 2) 알파에 지수 커브를 줘서 뜨거운 구간만 뚜렷하게 튀도록 한다.
const LIQ_HEATMAP_MIN_INTENSITY = 0.04;
const LIQ_HEATMAP_ALPHA_GAMMA = 1.2; // 낮을수록 중간 강도 구간도 더 선명하게(덜 흐리게) 나온다

// 한쪽(롱 또는 숏) bin 배열을 인접 bin끼리 색이 뚝뚝 끊기지 않도록 세로 방향 캔버스 그라데이션
// 하나로 그린다 — bin 경계마다 색상이 사실상 거의 같은데 fillRect로 각각 따로 그리면 육안으로도
// 구간 경계가 블록처럼 보였다. mass가 0인 bin도 스킵하지 않고 alpha 0 stop으로 넣어야
// 화면에 없는 구간 사이를 이어붙일 때 엉뚱하게 그라데이션이 번져 보이는 걸 막을 수 있다.
function drawLiqHeatmapSide(ctx, bins, canvasW, canvasH, series, maxVisibleMass, opacity){
  const stops = [];
  for(let i = 0; i < bins.length; i++){
    const bin = bins[i];
    const y1 = series.priceToCoordinate(bin.hiPx);
    const y2 = series.priceToCoordinate(bin.loPx);
    if(y1 == null || y2 == null) continue;
    const top = Math.min(y1, y2), bottom = Math.max(y1, y2);
    if(bottom < 0 || top > canvasH) continue;
    stops.push({ top, bottom, mass: bin.mass });
  }
  if(!stops.length) return;
  stops.sort((a, b) => a.top - b.top); // bin 인덱스 오름차순 = 가격 오름차순이지만 픽셀 y는 반대 방향이라 재정렬 필요
  const minY = stops[0].top, maxY = stops[stops.length - 1].bottom;
  if(!(maxY > minY)) return;
  const gradient = ctx.createLinearGradient(0, minY, 0, maxY);
  stops.forEach(({ top, bottom, mass }) => {
    const intensity = mass / maxVisibleMass;
    const alpha = intensity < LIQ_HEATMAP_MIN_INTENSITY ? 0 : Math.pow(intensity, LIQ_HEATMAP_ALPHA_GAMMA) * opacity;
    const offset = Math.max(0, Math.min(1, ((top + bottom) / 2 - minY) / (maxY - minY)));
    gradient.addColorStop(offset, liqHeatmapRgba(intensity, alpha));
  });
  ctx.fillStyle = gradient;
  ctx.fillRect(0, minY, canvasW, maxY - minY);
}

function drawLiqHeatmap(){
  const { ctx } = state.liqHeatmapCanvas;
  ctx.clearRect(0, 0, liqHeatmapCanvasW, liqHeatmapCanvasH);
  if(state.liqHeatmapHidden) return;
  const data = state.liqHeatmapScaled;
  if(!data) return;
  const series = state.candleSeries;

  // 강도 정규화 기준(maxMass)은 전체 모델 범위가 아니라 "지금 화면에 보이는" bin들 중
  // 최댓값으로 잡는다. 모델이 커버하는 전체 범위(0.3~3x)의 극단(꼬리) 쪽에 있는 이론상 최댓값
  // bin은 대부분 화면 밖(줌 아웃하지 않는 한 안 보이는 가격대)에 있어서, 그걸 기준으로 정규화하면
  // 실제로 화면에 보이는 구간은 항상 흐릿하게만 보인다 — 히트맵이 "안 보인다"는 문제의 실제 원인.
  let maxVisibleMass = 0;
  [data.longBins, data.shortBins].forEach(bins => {
    bins.forEach(bin => {
      if(!bin.mass) return;
      const y1 = series.priceToCoordinate(bin.hiPx);
      const y2 = series.priceToCoordinate(bin.loPx);
      if(y1 == null || y2 == null) return;
      const top = Math.min(y1, y2), bottom = Math.max(y1, y2);
      if(bottom < 0 || top > liqHeatmapCanvasH) return;
      if(bin.mass > maxVisibleMass) maxVisibleMass = bin.mass;
    });
  });
  if(!maxVisibleMass) return;

  const opacity = state.liqHeatmapSettings.opacity;
  drawLiqHeatmapSide(ctx, data.longBins, liqHeatmapCanvasW, liqHeatmapCanvasH, series, maxVisibleMass, opacity);
  drawLiqHeatmapSide(ctx, data.shortBins, liqHeatmapCanvasW, liqHeatmapCanvasH, series, maxVisibleMass, opacity);
}

// drawings.js의 startOverlayLoop()에서 매 프레임 호출된다. 자체적으로 dirty-check해서
// 화면(팬/줌)이 그대로이고 데이터도 안 바뀌었으면 다시 그리지 않는다.
function updateLiqHeatmapOverlay(){
  if(!state.liqHeatmapOn) return;
  if(!state.liqHeatmapCanvas) createLiqHeatmapCanvas();
  if(!state.chart || !state.candleSeries) return;
  const sig = liqHeatmapViewSignature();
  if(!liqHeatmapDirty && sig === liqHeatmapLastViewSig) return;
  liqHeatmapLastViewSig = sig;
  liqHeatmapDirty = false;
  drawLiqHeatmap();
}

function applyLiqHeatmapVisibility(){
  liqHeatmapDirty = true;
}

function setLiqHeatmapOn(on){
  state.liqHeatmapOn = on;
  if(on){
    createLiqHeatmapCanvas();
    refreshLiqHeatmapFull();
    connectLiqHeatmapClock(state.coin);
  }else{
    disconnectLiqHeatmapClock();
    state.liqHeatmapRaw = null;
    state.liqHeatmapScaled = null;
    state.liqHeatmapLastOiUsd = null;
    removeLiqHeatmapCanvas();
  }
  applyChartBackground(); // 캔들 뒤에 히트맵이 비치도록 차트 배경 투명 처리를 켜고/끈다 (app-settings.js)
  liqHeatmapToggleBtn.classList.toggle('on', on);
  renderLiqHeatmapLegend();
  renderIndicatorsList();
}

// 지표 드롭다운이 아니라 whale/wallet/funding과 같은 상단 두 번째 줄 전용 버튼으로 켜고 끈다.
const liqHeatmapToggleBtn = $('liqHeatmapToggleBtn');
liqHeatmapToggleBtn.addEventListener('click', () => setLiqHeatmapOn(!state.liqHeatmapOn));
