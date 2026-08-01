/* indicator-macd.js
   MACD indicator (separate bottom pane). */

// ---------- MACD 지표 (Pine: Moving Average Convergence Divergence) ----------
// RSI처럼 0~100 같은 고정 범위가 없어서(위아래로 얼마든지 움직일 수 있음), 오토스케일을 그냥 켜둔다.
// BB와 마찬가지로 봉 수가 많지 않으면 매번 전체 재계산해도 충분히 빠르다(라이브 갱신도 동일 패턴).
const macdChartEl = document.getElementById('macdChart');
const macdPaneEl = document.getElementById('macdPane');
let macdSyncGuard = false;
function macdFollowMain(range){
  if(macdSyncGuard || !range || !state.macdChart) return;
  macdSyncGuard = true;
  state.macdChart.timeScale().setVisibleLogicalRange(range);
  macdSyncGuard = false;
}
function mainFollowMacd(range){
  if(macdSyncGuard || !range || !state.chart) return;
  macdSyncGuard = true;
  state.chart.timeScale().setVisibleLogicalRange(range);
  macdSyncGuard = false;
}
new ResizeObserver(entries => {
  if(!state.macdChart) return;
  const { width, height } = entries[0].contentRect;
  state.macdChart.resize(width, height);
}).observe(macdChartEl);

// 패널 높이 드래그 조절 (RSI 패널과 공용 — util.js의 setupPaneResize)
setupPaneResize('macdResizeHandle', macdPaneEl);

function createMacdChart(){
  if(state.macdChart) return;
  state.macdChart = LightweightCharts.createChart(macdChartEl, {
    layout: {
      background: { color: '#0a0d12' },
      textColor: '#6b7686',
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
    },
    grid: { vertLines: { color: '#151a22' }, horzLines: { color: '#151a22' } },
    rightPriceScale: { borderColor: '#212833', visible: true, autoScale: true, mode: LightweightCharts.PriceScaleMode.Normal },
    leftPriceScale: { visible: false },
    timeScale: { borderColor: '#212833', timeVisible: true, secondsVisible: true, tickMarkFormatter: localTickMarkFormatter },
    localization: { timeFormatter: localTimeFormatter },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    handleScroll: { vertTouchDrag: true, mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true },
    handleScale: { axisPressedMouseMove: { time: true, price: true }, mouseWheel: true, pinch: true },
  });
  state.macdChart.priceScale('right').applyOptions({ scaleMargins: { top: 0.15, bottom: 0.15 } });
  state.macdSeries = {
    hist: state.macdChart.addHistogramSeries({
      priceScaleId: 'right', priceLineVisible: false, lastValueVisible: false,
      visible: !state.macdHidden && state.macdLineVisible.hist,
    }),
    macd: state.macdChart.addLineSeries({
      color: state.macdColors.macd, lineWidth: 2, priceScaleId: 'right',
      lastValueVisible: true, priceLineVisible: false, crosshairMarkerVisible: false,
      visible: !state.macdHidden && state.macdLineVisible.macd,
    }),
    signal: state.macdChart.addLineSeries({
      color: state.macdColors.signal, lineWidth: 2, priceScaleId: 'right',
      lastValueVisible: true, priceLineVisible: false, crosshairMarkerVisible: false,
      visible: !state.macdHidden && state.macdLineVisible.signal,
    }),
  };
  // Pine의 hline(0, "Zero", #787b8680)에 해당하는 0 기준선
  state.macdSeries.macd.createPriceLine({
    price: 0, color: 'rgba(120,123,134,0.5)', lineWidth: 1,
    lineStyle: LightweightCharts.LineStyle.Solid, axisLabelVisible: false, title: '',
  });
  state.chart.timeScale().subscribeVisibleLogicalRangeChange(macdFollowMain);
  state.macdChart.timeScale().subscribeVisibleLogicalRangeChange(mainFollowMacd);
  const initRange = state.chart.timeScale().getVisibleLogicalRange();
  if(initRange) state.macdChart.timeScale().setVisibleLogicalRange(initRange);
}
function destroyMacdChart(){
  if(!state.macdChart) return;
  if(state.chart) state.chart.timeScale().unsubscribeVisibleLogicalRangeChange(macdFollowMain);
  state.macdChart.timeScale().unsubscribeVisibleLogicalRangeChange(mainFollowMacd);
  state.macdChart.remove();
  state.macdChart = null;
  state.macdSeries = null;
}
function applyMacdVisibility(){
  if(!state.macdSeries) return;
  state.macdSeries.macd.applyOptions({ visible: !state.macdHidden && state.macdLineVisible.macd });
  state.macdSeries.signal.applyOptions({ visible: !state.macdHidden && state.macdLineVisible.signal });
  state.macdSeries.hist.applyOptions({ visible: !state.macdHidden && state.macdLineVisible.hist });
}
// bars 전체로 MACD/Signal/Histogram 배열을 계산. fast/slow MA는 이미 있는 computeMASeries(바 기반)를,
// 시그널선(=macd 값 자체의 이동평균)은 computeMAFromValues(값 배열 기반)를 그대로 재사용한다.
function computeMACD(bars, source, fastLen, slowLen, sigLen, oscType, sigType){
  const n = bars.length;
  const fastArr = computeMASeries(bars, fastLen, oscType, source);
  const slowArr = computeMASeries(bars, slowLen, oscType, source);
  const macdArr = new Array(n).fill(null);
  for(let i = 0; i < n; i++){
    if(fastArr[i] != null && slowArr[i] != null) macdArr[i] = fastArr[i] - slowArr[i];
  }
  const volumes = bars.map(b => b.volume || 0); // sigType은 EMA/SMA만 쓰지만 함수 시그니처상 필요
  const signalArr = computeMAFromValues(macdArr, volumes, sigLen, sigType);
  const histArr = new Array(n).fill(null);
  for(let i = 0; i < n; i++){
    if(macdArr[i] != null && signalArr[i] != null) histArr[i] = macdArr[i] - signalArr[i];
  }
  return { macdArr, signalArr, histArr };
}
// 히스토그램 막대 색: 0 이상이면서 커지는 중 = 진한 청록, 0 이상이면서 줄어드는 중 = 연한 청록,
// 0 미만이면서 커지는 중(0에 가까워짐) = 연한 빨강, 0 미만이면서 더 줄어드는 중 = 진한 빨강.
function macdHistColor(hist, prevHist){
  const rising = prevHist == null ? true : hist > prevHist;
  if(hist >= 0) return rising ? '#26a69a' : '#b2dfdb';
  return rising ? '#ffcdd2' : '#ff5252';
}
// 전체 재계산. 중간 배열(fast/slow/macd/signal/hist)을 캐시에 남겨서 실시간 틱에서는
// 마지막 한 칸만 다시 계산할 수 있게 한다(updateMacdLive 참고).
function refreshMacdFull(){
  if(!state.macdOn) return;
  if(!state.macdChart) createMacdChart();
  const bars = state.currentBars;
  if(!bars.length){
    state.macdSeries.macd.setData([]);
    state.macdSeries.signal.setData([]);
    state.macdSeries.hist.setData([]);
    state.macdCalc = null;
    return;
  }
  const { source, fastLen, slowLen, sigLen, oscType, sigType } = state.macdSettings;
  const fastArr = computeMASeries(bars, fastLen, oscType, source);
  const slowArr = computeMASeries(bars, slowLen, oscType, source);
  const macdArr = new Array(bars.length).fill(null);
  for(let i = 0; i < bars.length; i++){
    if(fastArr[i] != null && slowArr[i] != null) macdArr[i] = fastArr[i] - slowArr[i];
  }
  const volArr = bars.map(b => b.volume || 0);
  const signalArr = computeMAFromValues(macdArr, volArr, sigLen, sigType);
  const histArr = new Array(bars.length).fill(null);
  for(let i = 0; i < bars.length; i++){
    if(macdArr[i] != null && signalArr[i] != null) histArr[i] = macdArr[i] - signalArr[i];
  }

  const macdPts = [], signalPts = [], histPts = [];
  let prevHist = null;
  for(let i = 0; i < bars.length; i++){
    if(macdArr[i] != null) macdPts.push({ time: bars[i].time, value: macdArr[i] });
    if(signalArr[i] != null) signalPts.push({ time: bars[i].time, value: signalArr[i] });
    if(histArr[i] != null){
      histPts.push({ time: bars[i].time, value: histArr[i], color: macdHistColor(histArr[i], prevHist) });
      prevHist = histArr[i];
    }
  }
  state.macdSeries.macd.setData(macdPts);
  state.macdSeries.signal.setData(signalPts);
  state.macdSeries.hist.setData(histPts);
  state.macdCalc = {
    srcArr: bars.map(b => bbSourceValue(b, source)),
    volArr, fastArr, slowArr, macdArr, signalArr, histArr,
    formingTime: bars[bars.length - 1].time,
  };
}
// 실시간 틱: 마지막(형성 중인) 봉 한 칸만 계산해서 세 시리즈를 update()로 갱신.
function updateMacdLive(bar){
  if(!state.macdOn || !state.macdSeries) return;
  const calc = state.macdCalc;
  const bars = state.currentBars;
  if(!calc || !bar || bar.time < calc.formingTime){ refreshMacdFull(); return; }

  if(bar.time > calc.formingTime){
    ['srcArr', 'fastArr', 'slowArr', 'macdArr', 'signalArr', 'histArr'].forEach(k => calc[k].push(null));
    calc.volArr.push(0);
    calc.formingTime = bar.time;
  }
  const i = bars.length - 1;
  if(calc.macdArr.length !== bars.length){ refreshMacdFull(); return; }

  const { source, fastLen, slowLen, sigLen, oscType, sigType } = state.macdSettings;
  calc.srcArr[i] = bbSourceValue(bar, source);
  calc.volArr[i] = bar.volume || 0;
  const fast = maValueAt(calc.srcArr, calc.volArr, calc.fastArr, i, fastLen, oscType);
  const slow = maValueAt(calc.srcArr, calc.volArr, calc.slowArr, i, slowLen, oscType);
  if(fast == null || slow == null){ refreshMacdFull(); return; }
  calc.fastArr[i] = fast;
  calc.slowArr[i] = slow;
  const macd = fast - slow;
  calc.macdArr[i] = macd;

  const signal = maValueAt(calc.macdArr, calc.volArr, calc.signalArr, i, sigLen, sigType);
  state.macdSeries.macd.update({ time: bar.time, value: macd });
  if(signal == null){
    // 시그널 워밍업 구간이면 정확도를 위해 한 번은 전체 재계산에 맡긴다
    refreshMacdFull();
    return;
  }
  calc.signalArr[i] = signal;
  const hist = macd - signal;
  calc.histArr[i] = hist;
  state.macdSeries.signal.update({ time: bar.time, value: signal });
  state.macdSeries.hist.update({ time: bar.time, value: hist, color: macdHistColor(hist, calc.histArr[i - 1]) });
}
