/* chart-series.js
   Heikin Ashi, baseline sync and main series (re)creation. */

// ---------- 하이킨 아시 ----------
// 하이킨아시 봉은 "직전 하이킨아시 봉"에만 의존하기 때문에, 마지막 확정봉의 하이킨아시 값만
// 들고 있으면 실시간으로 형성 중인 봉을 O(1)로 다시 계산할 수 있다. haCache가 그 역할이다.
// (예전엔 그걸 안 해서 틱마다 전체 시리즈를 다시 만들었다 — updateSeriesWithCandle 주석 참고)
let haCache = null; // { prev: 확정된 직전 HA 봉, formingTime, forming: 형성 중인 HA 봉 }

function heikinAshiStep(bar, prevHA) {
  const close = (bar.open + bar.high + bar.low + bar.close) / 4;
  const open = prevHA ? (prevHA.open + prevHA.close) / 2 : (bar.open + bar.close) / 2;
  return {
    time: bar.time,
    open,
    high: Math.max(bar.high, open, close),
    low: Math.min(bar.low, open, close),
    close,
    volume: bar.volume,
  };
}

function calculateHeikinAshi(bars) {
  const haBars = [];
  let prevHA = null;
  for (const b of bars) {
    const haBar = heikinAshiStep(b, prevHA);
    haBars.push(haBar);
    prevHA = haBar;
  }
  haCache = haBars.length
    ? {
        prev: haBars.length >= 2 ? haBars[haBars.length - 2] : null,
        formingTime: haBars[haBars.length - 1].time,
        forming: haBars[haBars.length - 1],
      }
    : null;
  return haBars;
}

// 라이브 틱 하나에 대한 하이킨아시 봉. 캐시가 없거나 시간이 역행하면 null을 돌려주고,
// 호출한 쪽이 전체 재계산으로 안전하게 폴백한다.
function heikinAshiLive(bar) {
  if (!haCache || bar.time < haCache.formingTime) return null;
  if (bar.time > haCache.formingTime) {
    // 이전에 형성 중이던 봉이 확정됨 -> 기준(prev)으로 승격
    haCache.prev = haCache.forming;
    haCache.formingTime = bar.time;
  }
  haCache.forming = heikinAshiStep(bar, haCache.prev);
  return haCache.forming;
}

// ---------- 현재 차트 유형에 맞춰 원시 봉 배열을 시리즈용 데이터로 변환 ----------
// recreateMainSeries()와 loadMoreHistory() 양쪽에서 공유한다. 예전엔 loadMoreHistory()가
// 과거 데이터를 이어붙인 뒤 원시 OHLC를 그대로 setData해서, Heikin Ashi/Volume Candle2로
// 변환된 표시 데이터를 덮어써버렸다. 차트를 열면 fitContent() 직후 거의 항상
// "왼쪽 20봉 이내" 조건에 걸려 loadMoreHistory가 자동 실행되기 때문에, 타임프레임이나
// 페어를 바꿀 때마다 이 문제가 재현됐다. "화면(데이터셋)이 바뀌는 지점"마다 항상 같은
// 변환 함수를 거치도록 여기 한 곳으로 모아서, 하나만 고치고 다른 하나를 빠뜨리는 사고를 막는다.
function toMainSeriesData(bars){
  const type = state.chartType;
  let displayBars = bars;
  if (type === 'HeikinAshi') displayBars = calculateHeikinAshi(bars);
  else if (type === 'VolumeCandle') displayBars = applyVolumeColors(bars);
  if (type === 'Line' || type === 'Area' || type === 'Baseline') {
    return displayBars.map(b => ({ time: b.time, value: b.close }));
  }
  return displayBars;
}

// ---------- 가격축 마지막 값 라인 색상 ----------
// lightweight-charts는 캔들스틱 시리즈의 "마지막 값" 가격선/라벨 색을 기본적으로 그 시리즈의
// upColor/downColor에서 그대로 가져다 쓴다. 그런데 Hollow(양봉을 속이 빈 모양으로 그리려고
// upColor를 transparent로 둠)는 그 값이 실제로 transparent라서, 양봉일 때 가격 라벨 배경이
// 까맣게 되고 실선도 안 보이게 된다.
// -> 매번 봉의 실제 방향에 맞춰 priceLineColor를 명시적으로 지정해서 이 문제를 피한다.
function updateCandlePriceLineColor(bar){
  if (!state.candleSeries || !bar) return;
  const isUp = bar.close >= bar.open;
  state.candleSeries.applyOptions({ priceLineColor: isUp ? '#4fd1c5' : '#ef6f6f' });
}

// 트레이딩뷰의 베이스라인은 "특정 가격"이 아니라 "화면 세로 정중앙"에 고정된다 — 스크롤/줌/세로 드래그로
// 보이는 가격 범위가 바뀌면, 화면 중앙에 있던 가격 자체가 바뀌면서 점선도 그 새 가격으로 다시 그려진다.
// lightweight-charts에는 "화면 중앙에 자동으로 맞추기" 옵션이 없어서, 매 프레임 직접
// (패널 픽셀 높이의 정중앙) -> (그 좌표에 해당하는 가격)을 coordinateToPrice로 계산해서 넣어준다.
// 이렇게 하면 세로 드래그 이동, 가격축 휠 줌처럼 "보이는 시간 범위는 안 바뀌지만 가격 범위는 바뀌는" 경우도
// 전부 자동으로 커버된다 (반대로 시간축 스크롤/줌은 물론이고).
let lastBaselineValue = null;
let baselineCenterLine = null; // Baseline 모드에서 화면 중앙을 표시하는 회색 점선 (createPriceLine 참조)
function updateBaselineValue(){
  if (state.chartType !== 'Baseline' || !state.candleSeries || !state.chart) return;
  const paneHeight = state.chart.paneSize().height;
  if (!paneHeight) return;
  const midPrice = state.candleSeries.coordinateToPrice(paneHeight / 2);
  if (midPrice == null) return;
  if (lastBaselineValue != null && Math.abs(lastBaselineValue - midPrice) < 1e-9) return;
  lastBaselineValue = midPrice;
  state.candleSeries.applyOptions({ baseValue: { type: 'price', price: midPrice } });
  if (baselineCenterLine) baselineCenterLine.applyOptions({ price: midPrice });
}
// 위 이유로 특정 이벤트에만 걸어두면 놓치는 경우가 생겨서(예: 세로 드래그, 가격축 휠 줌)
// 매 프레임 확인이 필요하다. 예전엔 이걸 위해 rAF 루프를 하나 더 돌렸는데(그림 오버레이용까지
// 합쳐 앱에 상시 rAF 루프가 2개였다), drawings.js의 오버레이 루프에서 같이 호출하도록 합쳤다.
// Baseline 유형이 아닐 땐 위 함수 첫 줄에서 바로 반환하므로 비용은 사실상 0이다.

// ---------- 거래량 라벨 (오른쪽 가격축 위에 뜨는 뱃지) ----------
// 왼쪽 거래량 축을 없앤 뒤(chart-init.js), 대신 이 뱃지 하나로 "현재 보이는 마지막 캔들의
// 거래량 값"을 오른쪽 가격축 위에 표시한다. 거래량 시리즈는 여전히 보이지 않는 left
// 스케일에 붙어있으므로, 그 스케일 기준으로 값 -> y좌표를 구한 다음 뱃지를 그 높이로 옮겨준다.
// (실제 축 눈금을 그리는 게 아니라 딱 하나의 값만 보여주는 라벨이라 매 프레임 갱신해도 가볍다.)
// 가격 라벨과 동일한 규칙: 기본은 가장 최근(마지막) 캔들이고, 차트를 과거로 스크롤해서 그
// 마지막 캔들이 화면 밖으로 나가면 그 대신 화면에 보이는 캔들 중 가장 오른쪽(최신) 캔들을 쓴다.
// 크로스헤어로 특정 캔들을 가리키는 것과는 무관하게 항상 이 규칙만 따른다.
const volumeAxisLabelEl = document.getElementById('volumeAxisLabel');
let lastVolumeLabelKey = null;
function getLastVisibleBar(){
  if (!state.currentBars.length) return null;
  const lastIdx = state.currentBars.length - 1;
  if (!state.chart) return state.currentBars[lastIdx];
  const range = state.chart.timeScale().getVisibleLogicalRange();
  if (!range) return state.currentBars[lastIdx];
  const rightmostVisibleIdx = Math.floor(range.to);
  const idx = Math.max(0, Math.min(lastIdx, rightmostVisibleIdx));
  return state.currentBars[idx];
}
function updateVolumeAxisLabel(){
  if (!volumeAxisLabelEl || !state.chart || !state.volumeSeries) return;
  if (state.volumeHidden) {
    if (lastVolumeLabelKey !== null) { lastVolumeLabelKey = null; volumeAxisLabelEl.style.display = 'none'; }
    return;
  }
  const bar = getLastVisibleBar();
  if (!bar) {
    if (lastVolumeLabelKey !== null) { lastVolumeLabelKey = null; volumeAxisLabelEl.style.display = 'none'; }
    return;
  }
  const vol = bar.volume || 0;
  const y = state.volumeSeries.priceToCoordinate(vol);
  const paneHeight = state.chart.paneSize().height;
  if (y == null || !paneHeight || y < -12 || y > paneHeight + 12) {
    if (lastVolumeLabelKey !== null) { lastVolumeLabelKey = null; volumeAxisLabelEl.style.display = 'none'; }
    return;
  }
  const up = bar.close >= bar.open;
  const isCurrent = bar === state.currentBars[state.currentBars.length - 1];
  const key = vol + '|' + y.toFixed(1) + '|' + up + '|' + isCurrent;
  if (key === lastVolumeLabelKey) return;
  lastVolumeLabelKey = key;
  volumeAxisLabelEl.textContent = formatVolumeAxis(vol);
  volumeAxisLabelEl.style.top = y + 'px';
  volumeAxisLabelEl.classList.toggle('down', !up);
  volumeAxisLabelEl.classList.toggle('current', isCurrent);
  volumeAxisLabelEl.style.display = 'block';
}

function recreateMainSeries() {
  if (!state.chart) return;

  // 버그 수정: right 가격축을 쓰는 시리즈가 이것 하나뿐이라, removeSeries()로 제거하는 순간
  // lightweight-charts가 해당 가격축을 기본값으로 리셋해버림 (autoScale, scaleMargins 등).
  // 그 결과 사용자가 드래그로 꺼둔 수동 스케일/이동 위치가 캔들 종류 변경 시마다 초기화됨.
  // -> 제거 전에 현재 가격축/타임축 상태를 저장했다가, 새 시리즈 생성 후 그대로 복원한다.
  const prevRightOpts = state.chart.priceScale('right').options();
  const prevLeftOpts = state.chart.priceScale('left').options();
  const prevLogicalRange = state.chart.timeScale().getVisibleLogicalRange();

  // 기존 시리즈 제거
  if (state.candleSeries) {
    state.chart.removeSeries(state.candleSeries); // 붙어있던 baselineCenterLine 가격선도 같이 제거됨
    state.candleSeries = null;
  }
  baselineCenterLine = null;
  lastBaselineValue = null;
  
  const type = state.chartType;
  const commonOptions = {
    priceScaleId: 'right',
    priceFormat: {
      type: 'custom',
      formatter: (price) => formatPrice(price),
    },
  };

  if (type === 'Candlestick' || type === 'Hollow' || type === 'HeikinAshi' || type === 'VolumeCandle') {
    const isHollow = type === 'Hollow';
    state.candleSeries = state.chart.addCandlestickSeries({
      ...commonOptions,
      upColor: isHollow ? 'transparent' : '#4fd1c5',
      downColor: '#ef6f6f',
      wickUpColor: '#4fd1c5',
      wickDownColor: '#ef6f6f',
      borderUpColor: '#4fd1c5',
      borderDownColor: '#ef6f6f',
      priceLineColor: '#4fd1c5', // 아래에서 데이터를 채운 뒤 실제 방향에 맞춰 다시 지정됨
    });
  } else if (type === 'Bar') {
    state.candleSeries = state.chart.addBarSeries({
      ...commonOptions,
      upColor: '#4fd1c5',
      downColor: '#ef6f6f',
    });
  } else if (type === 'Line') {
    state.candleSeries = state.chart.addLineSeries({
      ...commonOptions,
      color: '#4fd1c5',
      lineWidth: 2,
    });
  } else if (type === 'Baseline') {
    // 초기값은 대충 잡아둬도 된다 — 아래 baselineSyncLoop(rAF)가 다음 프레임에 바로
    // "화면 정중앙에 해당하는 가격"으로 정확히 고쳐준다.
    const lastClose = state.currentBars.length ? state.currentBars[state.currentBars.length - 1].close : 0;
    state.candleSeries = state.chart.addBaselineSeries({
      ...commonOptions,
      baseValue: { type: 'price', price: lastClose },
      topLineColor: '#4fd1c5',
      topFillColor1: 'rgba(79, 209, 197, 0.28)',
      topFillColor2: 'rgba(79, 209, 197, 0.05)',
      bottomLineColor: '#ef6f6f',
      bottomFillColor1: 'rgba(239, 111, 111, 0.05)',
      bottomFillColor2: 'rgba(239, 111, 111, 0.28)',
      lineWidth: 2,
    });
    // baseValue 자체는 색이 위/아래로 갈리는 기준값일 뿐 화면에 선으로 그려주진 않아서
    // (lightweight-charts의 baseLineVisible 옵션은 이거와 무관 — percentage/indexedTo100 스케일 전용),
    // 트레이딩뷰처럼 "여기가 기준"임을 보여주는 회색 점선을 별도 가격선으로 직접 추가한다.
    baselineCenterLine = state.candleSeries.createPriceLine({
      price: lastClose, color: '#787B86', lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: false, title: '',
    });
  } else if (type === 'Area') {
    state.candleSeries = state.chart.addAreaSeries({
      ...commonOptions,
      topColor: 'rgba(79, 209, 197, 0.4)',
      bottomColor: 'rgba(79, 209, 197, 0.0)',
      lineColor: '#4fd1c5',
      lineWidth: 2,
    });
  }

  // 데이터 재설정 (변환 규칙은 toMainSeriesData 참고 — loadMoreHistory와 공유)
  const seriesData = toMainSeriesData(state.currentBars);
  state.candleSeries.setData(seriesData);
  if (type !== 'Line' && type !== 'Area' && type !== 'Baseline') {
    updateCandlePriceLineColor(seriesData[seriesData.length - 1]);
  }
  
  // 볼륨 시리즈 색상 동기화를 위해 볼륨도 다시 그림 (옵션)
  state.volumeSeries.setData(state.currentBars.map(volPoint));
  applyCandlesVisibility(); // 캔들을 눈 아이콘으로 숨겨둔 상태였다면, 새로 만든 시리즈에도 그대로 이어서 적용

  // 저장해둔 가격축(autoScale, scaleMargins)과 타임축 스크롤 위치를 복원해서
  // 캔들 종류를 바꿔도 사용자가 조절해둔 뷰가 유지되게 한다.
  [['right', prevRightOpts], ['left', prevLeftOpts]].forEach(([scaleId, prev]) => {
    state.chart.priceScale(scaleId).applyOptions({
      autoScale: prev.autoScale,
      scaleMargins: prev.scaleMargins,
    });
  });
  if (prevLogicalRange) {
    state.chart.timeScale().setVisibleLogicalRange(prevLogicalRange);
  }
}
