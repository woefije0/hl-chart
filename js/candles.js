/* candles.js
   Candle fetching, aggregation and the top price bar. */


// ---------- REST: native 캔들 history ----------
// endTimeMs를 넘기면 그 시점 "이전" 최대 500개 캔들을 가져옴 (뒤로 스크롤할 때 과거 데이터 추가 로딩용)
//
// 주의: "인터벌 x 500개"만큼의 기간을 그대로 요청하면 3d/1w/1M 같은 긴 인터벌에서는
// 요청 기간이 수년~수십 년(예: 1M x 500 ≈ 41년)까지 늘어난다. Hyperliquid 자체가
// 2023년에 나왔고, HIP-3 페어는 대부분 그보다 훨씬 최근에 상장되었기 때문에 실제
// 존재하는 데이터보다 훨씬 긴 기간을 요청하게 되고, 이때 API가 정상 배열이 아닌
// 응답(에러 객체 등)을 주면 뒤에서 .map()이 그대로 터져서 차트가 안 뜨는 것처럼 보인다.
// -> 실패하면 요청 기간을 자동으로 좁혀 재시도하고, 그래도 안 되면 실제 에러 내용을
//    그대로 던져서 화면에 보이도록 한다(원인 진단용).
async function fetchHistory(coin, interval, endTimeMs, spanInterval){
  const end = endTimeMs || Date.now();
  // 합성 인터벌(예: 2m)은 서버에 base 인터벌(1m)로 요청하지만, "500개치 기간"은 base가 아니라
  // 목표 인터벌(2m) 기준으로 잡아야 한다. base 기준으로만 계산하면 절반의 기간만 요청하게 되어
  // (1m x 500 = 500분 -> 2m 봉 250개) 다른 인터벌보다 봉이 절반만 채워지고, 그 결과 같은 화면
  // 너비에 절반만 채워지니 봉 하나하나가 다른 인터벌보다 2배 두꺼워 보이는 문제가 있었다.
  const minutes = MINUTES[spanInterval || interval];
  if(!Number.isFinite(minutes)) throw new Error('unknown interval: ' + (spanInterval || interval));
  const fullSpanMs = minutes * 60000 * 500;
  let spanMs = fullSpanMs;
  let lastErr = null;
  const MIN_SPAN_MS = 60000 * 60 * 24; // 최소 하루치까지만 좁힘

  for(let attempt = 0; attempt < 8; attempt++){
    const start = end - spanMs;
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'candleSnapshot',
        req: { coin, interval, startTime: start, endTime: end },
      }),
    });

    if(res.ok){
      let data;
      try{
        data = await res.json();
      }catch(parseErr){
        lastErr = new Error('candleSnapshot response parse failed: ' + parseErr.message);
        if(spanMs <= MIN_SPAN_MS) throw lastErr;
        spanMs = Math.floor(spanMs / 4);
        continue;
      }
      if(Array.isArray(data)) return data;
      // 배열이 아닌 응답(에러 객체 등) -> 기간을 좁혀서 재시도, 그래도 안 되면 그대로 노출
      lastErr = new Error('candleSnapshot invalid response: ' + JSON.stringify(data).slice(0, 200));
      if(spanMs <= MIN_SPAN_MS) throw lastErr;
      spanMs = Math.floor(spanMs / 4);
      continue;
    }

    // 429(rate limit)는 "요청 기간이 이상해서" 나는 에러가 아니라 "너무 자주 요청해서" 나는
    // 에러라서, 기존처럼 spanMs를 좁혀서 곧바로 재시도하는 건 원인 해결에 전혀 도움이 안 되고,
    // 오히려 딜레이 없이 8번을 순식간에 재시도하면서 서버를 더 두드리기만 했다. 뒤로 스크롤해서
    // 과거 데이터를 이어 불러올 때(loadMoreHistory) 특히 짧은 시간에 여러 번 걸릴 수 있어서
    // 실제로 걸리기 쉬운 경로다. -> 429일 때는 기간은 그대로 두고, Retry-After 헤더(있으면 그
    // 값을, 없으면 지수 백오프)만큼 기다렸다가 같은 요청을 재시도한다.
    if(res.status === 429){
      const retryAfterHeader = Number(res.headers.get('Retry-After'));
      const waitMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
        ? retryAfterHeader * 1000
        : Math.min(8000, 500 * Math.pow(2, attempt)); // 0.5s, 1s, 2s, 4s, 8s(cap)
      lastErr = new Error('candleSnapshot 429 rate limited');
      await sleep(waitMs);
      continue; // spanMs는 그대로, 같은 요청을 재시도
    }

    // 그 외 HTTP 에러 -> 본문까지 확보해서 실제 원인을 남기고, 기간을 좁혀 재시도
    let bodyText = '';
    try{ bodyText = await res.text(); }catch(e){}
    lastErr = new Error('candleSnapshot ' + res.status + (bodyText ? (' — ' + bodyText.slice(0, 200)) : ''));
    if(spanMs <= MIN_SPAN_MS) throw lastErr;
    spanMs = Math.floor(spanMs / 4);
  }
  throw lastErr || new Error('candleSnapshot unknown error');
}
function toChartCandle(c){
  return {
    time: Math.floor(c.t / 1000),
    open: parseFloat(c.o),
    high: parseFloat(c.h),
    low: parseFloat(c.l),
    close: parseFloat(c.c),
    volume: parseFloat(c.v || 0),
  };
}
function volPoint(bar){
  return {
    time: bar.time,
    value: bar.volume || 0,
    color: bar.close >= bar.open ? 'rgba(79,209,197,0.5)' : 'rgba(239,111,111,0.5)',
  };
}

// ---------- agg(합성 분봉) 빌더 ----------
// 체결이 없던 구간은 빈칸으로 남기지 않고, 직전 종가로 이어진 얇은(flat) 봉으로 채워서
// "접속한 시점부터만 보이는" 것처럼 보이는 문제를 줄인다.
function fillGaps(bars, bucketSec){
  if(bars.length < 2) return bars;
  const filled = [];
  for(let i = 0; i < bars.length; i++){
    filled.push(bars[i]);
    if(i < bars.length - 1){
      let t = bars[i].time + bucketSec;
      while(t < bars[i + 1].time){
        filled.push({ time: t, open: bars[i].close, high: bars[i].close, low: bars[i].close, close: bars[i].close, volume: 0 });
        t += bucketSec;
      }
    }
  }
  return filled;
}

function buildAggCandles(candles1m, ms){
  const bars = [];
  let cur = null;
  candles1m.forEach(c => {
    const bucketSec = Math.floor((c.time * 1000) / ms) * (ms / 1000);
    if(!cur || cur.time !== bucketSec){
      if(cur) bars.push(cur);
      cur = { time: bucketSec, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 };
    }else{
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += (c.volume || 0);
    }
  });
  if(cur) bars.push(cur);
  return bars;
}
// 실시간 WS 캔들의 버킷 시간이 과거 REST 스냅샷의 마지막 봉 시간과 어긋나는 경우가 있다
// (3d처럼 "표준적이지 않은" 간격에서 특히). 시간이 역행하거나 같으면 새 봉을 push하지 않고
// 마지막 봉에 병합해서, series에 넘기는 시간이 항상 오름차순을 유지하도록 만든다.
// (안 그러면 lightweight-charts가 매 틱마다 내부에서 에러를 던진다)
function normalizeLiveBar(c){
  const arr = state.currentBars;
  if(!arr.length) return c;
  const last = arr[arr.length - 1];
  if(c.time > last.time) return c;
  if(c.time === last.time) return c;
  // c.time < last.time: 어긋난 버킷 -> 마지막 봉에 병합
  console.warn('[HL Chart] 라이브 캔들 시간 역행 감지 -> 마지막 봉에 병합', { liveTime: c.time, lastTime: last.time });
  return {
    time: last.time,
    open: last.open,
    high: Math.max(last.high, c.high),
    low: Math.min(last.low, c.low),
    close: c.close,
    volume: c.volume,
  };
}

// ---------- 시간 -> 봉 조회용 인덱스 ----------
// 마우스를 움직일 때마다 subscribeCrosshairMove가 호출되는데, 예전엔 매번
// state.currentBars.find(b => b.time === t)로 전체 배열을 훑었다(봉 5천개면 마우스 이동 1픽셀마다
// 최대 5천번 비교). 시간 -> 봉 Map을 한 번 만들어두고 O(1)로 찾는다.
let barIndex = new Map();
function rebuildBarIndex(){
  barIndex = new Map();
  for(const b of state.currentBars) barIndex.set(b.time, b);
}
function findBarAtTime(time){ return barIndex.get(time) || null; }

// state.currentBars는 "뒤로 스크롤 시 과거 데이터 추가 로딩"의 기준(state.currentBars[0])으로 쓰이는데,
// series.update()로만 갱신하면 이 배열이 최신 라이브 봉을 못 따라가서 나중에 loadMoreHistory가
// setData할 때 방금 들어온 라이브 봉을 지워버리는 문제가 생긴다. 그래서 라이브 갱신마다 같이 반영한다.
function pushOrUpdateBar(bar){
  const arr = state.currentBars;
  if(arr.length && arr[arr.length - 1].time === bar.time) arr[arr.length - 1] = bar;
  else arr.push(bar);
  barIndex.set(bar.time, bar);
  updateEmaBandLive(bar);
  updateBBLive(bar);
  updateVwapLive(bar);
  updateMaRibbonLive(bar);
  updateRsiLive(bar);
  updateMacdLive(bar);
}

// 라이브 틱 하나가 들어왔을 때 메인 시리즈를 갱신한다.
//
// 예전엔 하이킨아시/볼륨캔들일 때 매 틱마다 recreateMainSeries()를 불렀다. 그건 시리즈를
// 통째로 지웠다가 다시 만들고 전체 봉을 setData하는 함수라, 초당 몇 번씩 들어오는 틱마다
// 실행하면 봉 개수에 비례해서 눈에 띄게 버벅였고(그리고 가격축 상태 저장/복원까지 매번 돌았다),
// 캔들이 순간적으로 깜빡이기도 했다. 두 유형 모두 "마지막 봉 하나"만 다시 계산하면 되므로
// 증분 갱신으로 바꿨다.
function updateSeriesWithCandle(c) {
  if (state.chartType === 'HeikinAshi') {
    // 하이킨아시는 직전 하이킨아시 봉의 (open, close)만 있으면 현재 봉을 계산할 수 있다.
    const ha = heikinAshiLive(c);
    if (ha) { state.candleSeries.update(ha); updateCandlePriceLineColor(ha); }
    else recreateMainSeries(); // 캐시가 아직 없으면(유형 전환 직후 등) 한 번만 전체 재계산
  } else if (state.chartType === 'VolumeCandle') {
    // 거래량 대비 진하기: 최대 거래량이 갱신되면 나머지 봉의 색도 같이 바뀌어야 하므로
    // 그때만 전체를 다시 칠하고(프레임당 1회로 합침), 아니면 마지막 봉만 갱신한다.
    if ((c.volume || 0) > volumeColorMax) {
      scheduleFrame('volColors', () => {
        if (state.chartType !== 'VolumeCandle' || !state.candleSeries) return;
        state.candleSeries.setData(applyVolumeColors(state.currentBars));
        updateCandlePriceLineColor(c);
      });
    } else {
      state.candleSeries.update(applyVolumeColor(c, volumeColorMax));
      updateCandlePriceLineColor(c);
    }
  } else if (state.chartType === 'Line' || state.chartType === 'Area' || state.chartType === 'Baseline') {
    state.candleSeries.update({ time: c.time, value: c.close });
  } else {
    state.candleSeries.update(c);
    updateCandlePriceLineColor(c);
  }
}

function ingestAggCandle(c, ms){
  const bucketSec = Math.floor((c.time * 1000) / ms) * (ms / 1000);
  if(!state.liveAgg || state.liveAgg.time !== bucketSec){
    state.liveAgg = { time: bucketSec, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0, _sub: { [c.time]: c.volume || 0 } };
  }else{
    state.liveAgg.high = Math.max(state.liveAgg.high, c.high);
    state.liveAgg.low = Math.min(state.liveAgg.low, c.low);
    state.liveAgg.close = c.close;
    if(!state.liveAgg._sub) state.liveAgg._sub = {};
    state.liveAgg._sub[c.time] = c.volume || 0;
    state.liveAgg.volume = Object.values(state.liveAgg._sub).reduce((a, b) => a + b, 0);
  }
  updateSeriesWithCandle(state.liveAgg);
  state.volumeSeries.update(volPoint(state.liveAgg));
  state.lastCandle = state.liveAgg;
  pushOrUpdateBar(state.liveAgg);
  updatePriceBar();
}

// 상단 큰 가격 + 그 옆 %는 항상 "현재가 / 오늘 등락률" — 캔들에 마우스를 올려도 바뀌지 않는다
function renderTopPrice(){
  if(!state.todayCandle) return;
  $('lastPrice').textContent = formatPrice(state.todayCandle.close);
  const pct = state.todayCandle.open ? ((state.todayCandle.close - state.todayCandle.open) / state.todayCandle.open) * 100 : NaN;
  const chgBox = $('chgBox');
  if(Number.isFinite(pct)){
    chgBox.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
    chgBox.className = 'chg ' + (pct >= 0 ? 'up' : 'down');
  }else{
    chgBox.textContent = '—';
    chgBox.className = 'chg';
  }
}

// O/H/L/C 블록 — 마우스를 올린 캔들이 있으면 그 캔들, 없으면 "오늘" 캔들. 종가(C) 옆 %는
// 그 캔들 자체의 등락률((종가-시가)/시가)이며, 위쪽 상단 %(항상 오늘 기준)와는 별개다.
function renderCandleStats(candle, label){
  $('statO').textContent = formatPrice(candle.open);
  $('statH').textContent = formatPrice(candle.high);
  $('statL').textContent = formatPrice(candle.low);
  $('statC').textContent = formatPrice(candle.close);
  $('statLabel').textContent = label || '';
  const pct = candle.open ? ((candle.close - candle.open) / candle.open) * 100 : NaN;
  const pctEl = $('statCPct');
  if(Number.isFinite(pct)){
    pctEl.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
    pctEl.style.color = pct >= 0 ? 'var(--up)' : 'var(--down)';
  }else{
    pctEl.textContent = '—';
    pctEl.style.color = '';
  }
  touchLastUpdate();
}

// 오늘 캔들이 갱신될 때마다 호출: 상단 가격/%는 항상 갱신하고,
// O/H/L/C 블록은 지금 다른 캔들에 마우스를 올려서 보고 있지 않을 때만 "오늘"로 갱신한다.
function renderTodayIfNotHovering(){
  if(state.replayMode) return; // 리플레이 중엔 replay.js의 renderReplayIfNotHovering()이 이 자리를 대신 채운다
  if(!state.todayCandle) return;
  renderTopPrice();
  if(state.hoverCandle) return;
  renderCandleStats(state.todayCandle, t('today'));
}

// "업데이트 HH:MM:SS" 표시. 실시간 틱마다 불리는 자리라, 초가 실제로 바뀌었을 때만 DOM을
// 건드리고 Intl 객체(toLocaleTimeString이 내부적으로 매번 새로 만든다)도 한 번만 만들어 재사용한다.
let _lastUpdateSecond = -1;
let _timeFormatter = null;
let _timeFormatterLang = null;
function touchLastUpdate(){
  const now = Date.now();
  const sec = Math.floor(now / 1000);
  if(sec === _lastUpdateSecond) return;
  _lastUpdateSecond = sec;
  if(_timeFormatterLang !== state.lang){
    _timeFormatterLang = state.lang;
    _timeFormatter = new Intl.DateTimeFormat(state.lang === 'kr' ? 'ko-KR' : 'en-US', {
      hour: 'numeric', minute: '2-digit', second: '2-digit',
    });
  }
  $('lastUpdate').textContent = t('updated') + _timeFormatter.format(now);
}

// 메인 차트 실시간 틱마다 호출됨(상단 바의 "오늘" 통계 자체는 선택된 인터벌과 무관하게
// 정확하도록 별도의 1d 구독(state.todayWs)이 전담한다). 여기서는 업데이트 시각만 갱신.
function updatePriceBar(){
  touchLastUpdate();
}
