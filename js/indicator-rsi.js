/* indicator-rsi.js
   RSI indicator (separate bottom pane). */

// ---------- RSI 지표 (Pine: Relative Strength Index) ----------
// RSI는 가격 스케일이 아니라 0~100 범위라서 메인 차트 위에 겹칠 수 없다.
// 그래서 EMA밴드/BB와 달리 별도의 lightweight-charts 인스턴스(하단 패널)로 그린다.
function computeRSI(bars, length, source){
  const n = bars.length;
  const src = bars.map(b => bbSourceValue(b, source));
  const gains = new Array(n).fill(null);
  const losses = new Array(n).fill(null);
  for(let i = 1; i < n; i++){
    const change = src[i] - src[i - 1];
    gains[i] = Math.max(change, 0);
    losses[i] = Math.max(-change, 0);
  }
  const alpha = 1 / length;
  const upArr = new Array(n).fill(null);
  const downArr = new Array(n).fill(null);
  let seedUpSum = 0, seedDownSum = 0, seedCount = 0;
  for(let i = 1; i < n; i++){
    if(seedCount < length){
      seedUpSum += gains[i];
      seedDownSum += losses[i];
      seedCount++;
      if(seedCount === length){
        upArr[i] = seedUpSum / length;
        downArr[i] = seedDownSum / length;
      }
    }else{
      upArr[i] = alpha * gains[i] + (1 - alpha) * upArr[i - 1];
      downArr[i] = alpha * losses[i] + (1 - alpha) * downArr[i - 1];
    }
  }
  const rsiArr = new Array(n).fill(null);
  for(let i = 0; i < n; i++){
    if(upArr[i] == null || downArr[i] == null) continue;
    const up = upArr[i], down = downArr[i];
    rsiArr[i] = down === 0 ? 100 : (up === 0 ? 0 : 100 - 100 / (1 + up / down));
  }
  return { rsiArr, upArr, downArr };
}
// RSI 값(또는 그 위에 얹는 스무딩 MA)처럼 "봉 배열"이 아니라 "값 배열"에 대해 이동평균을 계산하는 범용 버전.
// 앞쪽에 null(워밍업 구간)이 있을 수 있어서, length개가 전부 유효한 연속 구간에서만 값을 채운다.
function computeMAFromValues(values, volumes, length, type){
  const n = values.length;
  const out = new Array(n).fill(null);
  if(length < 1) return out;
  if(type === 'EMA' || type === 'SMMA (RMA)'){
    const alpha = type === 'EMA' ? 2 / (length + 1) : 1 / length;
    let seedSum = 0, seedCount = 0;
    for(let i = 0; i < n; i++){
      if(values[i] == null){ seedSum = 0; seedCount = 0; continue; }
      if(seedCount < length){
        seedSum += values[i];
        seedCount++;
        if(seedCount === length) out[i] = seedSum / length;
      }else{
        out[i] = alpha * values[i] + (1 - alpha) * out[i - 1];
      }
    }
  }else if(type === 'WMA'){
    for(let i = 0; i < n; i++){
      if(values[i] == null || i < length - 1) continue;
      let wsum = 0, wtotal = 0, ok = true;
      for(let k = 0; k < length; k++){
        if(values[i - k] == null){ ok = false; break; }
        const w = length - k; wsum += values[i - k] * w; wtotal += w;
      }
      if(ok) out[i] = wsum / wtotal;
    }
  }else if(type === 'VWMA'){
    for(let i = 0; i < n; i++){
      if(values[i] == null || i < length - 1) continue;
      let pv = 0, vsum = 0, ok = true;
      for(let k = 0; k < length; k++){
        if(values[i - k] == null){ ok = false; break; }
        const vol = volumes[i - k] || 0; pv += values[i - k] * vol; vsum += vol;
      }
      if(ok) out[i] = vsum > 0 ? pv / vsum : values[i];
    }
  }else{ // SMA
    for(let i = 0; i < n; i++){
      if(values[i] == null || i < length - 1) continue;
      let sum = 0, ok = true;
      for(let k = 0; k < length; k++){
        if(values[i - k] == null){ ok = false; break; }
        sum += values[i - k];
      }
      if(ok) out[i] = sum / length;
    }
  }
  return out;
}
function computeStdevFromValues(values, length){
  const n = values.length;
  const out = new Array(n).fill(null);
  for(let i = 0; i < n; i++){
    if(values[i] == null || i < length - 1) continue;
    let sum = 0, ok = true;
    for(let k = 0; k < length; k++){
      if(values[i - k] == null){ ok = false; break; }
      sum += values[i - k];
    }
    if(!ok) continue;
    const mean = sum / length;
    let sqSum = 0;
    for(let k = 0; k < length; k++){ const d = values[i - k] - mean; sqSum += d * d; }
    out[i] = Math.sqrt(sqSum / length);
  }
  return out;
}

const rsiChartEl = document.getElementById('rsiChart');
const rsiPaneEl = document.getElementById('rsiPane');
let rsiSyncGuard = false;
function rsiFollowMain(range){
  if(rsiSyncGuard || !range || !state.rsiChart) return;
  rsiSyncGuard = true;
  state.rsiChart.timeScale().setVisibleLogicalRange(range);
  rsiSyncGuard = false;
}
function mainFollowRsi(range){
  if(rsiSyncGuard || !range || !state.chart) return;
  rsiSyncGuard = true;
  state.chart.timeScale().setVisibleLogicalRange(range);
  rsiSyncGuard = false;
}
new ResizeObserver(entries => {
  if(!state.rsiChart) return;
  const { width, height } = entries[0].contentRect;
  state.rsiChart.resize(width, height);
}).observe(rsiChartEl);

// 패널 높이 드래그 조절 (MACD 패널과 공용 — util.js의 setupPaneResize)
setupPaneResize('rsiResizeHandle', rsiPaneEl);

function createRsiChart(){
  if(state.rsiChart) return;
  state.rsiChart = LightweightCharts.createChart(rsiChartEl, {
    layout: {
      background: { color: '#0a0d12' },
      textColor: '#6b7686',
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
    },
    grid: { vertLines: { color: '#151a22' }, horzLines: { color: '#151a22' } },
    rightPriceScale: { borderColor: '#212833', visible: true, autoScale: true, mode: LightweightCharts.PriceScaleMode.Normal },
    leftPriceScale: { visible: false },
    timeScale: { borderColor: '#212833', timeVisible: true, secondsVisible: true },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    handleScroll: { vertTouchDrag: true, mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true },
    // 가격축(price)도 메인 차트처럼 드래그로 확대/축소할 수 있게 true로 바꿈.
    // (드래그 시 lightweight-charts가 내부적으로 해당 price scale의 autoScale을 자동으로 꺼주기 때문에,
    //  아래 autoscaleInfoProvider의 0~100 고정은 "처음 켰을 때의 기본 범위"로만 동작하고, 사용자가
    //  축을 직접 조정한 뒤에는 그 값을 그대로 유지한다. 축 더블클릭하면 다시 0~100 기본값으로 리셋된다.)
    handleScale: { axisPressedMouseMove: { time: true, price: true }, mouseWheel: true, pinch: true },
  });
  // RSI를 처음 켰을 때의 기본 범위는 0~100 (오토스케일 켜진 상태일 때만 이 함수가 참고됨)
  state.rsiChart.priceScale('right').applyOptions({ scaleMargins: { top: 0.1, bottom: 0.1 } });
  const lineOpt = (color, visible) => ({
    color, lineWidth: 2, priceScaleId: 'right',
    lastValueVisible: true, priceLineVisible: false, crosshairMarkerVisible: false, visible,
  });
  state.rsiSeries = {
    rsi: state.rsiChart.addLineSeries(lineOpt(state.rsiColors.rsi, !state.rsiHidden && state.rsiLineVisible.rsi)),
  };
  // 0~100 고정 범위: lightweight-charts v4는 setAutoscaleInfoProvider()라는 메서드가 없고
  // applyOptions({ autoscaleInfoProvider })로만 지정 가능 (이전 코드는 존재하지 않는 메서드를 호출해서
  // 매번 예외를 던졌고, 그 예외 때문에 createRsiChart() 뒤에 있던 legend/dropdown 갱신 코드가
  // 통째로 실행되지 않았던 게 "드롭다운이 ON으로 안 바뀜"/"라벨이 사라짐" 버그의 진짜 원인이었다.
  state.rsiSeries.rsi.applyOptions({ autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) });
  state.rsiBands = null;
  applyRsiBands();
  updateRsiExtraSeries();
  state.chart.timeScale().subscribeVisibleLogicalRangeChange(rsiFollowMain);
  state.rsiChart.timeScale().subscribeVisibleLogicalRangeChange(mainFollowRsi);
  // 메인 차트의 보이는 범위를 그대로 넘겨받아 처음부터 정렬된 상태로 시작
  const initRange = state.chart.timeScale().getVisibleLogicalRange();
  if(initRange) state.rsiChart.timeScale().setVisibleLogicalRange(initRange);
}
function destroyRsiChart(){
  if(!state.rsiChart) return;
  if(state.chart) state.chart.timeScale().unsubscribeVisibleLogicalRangeChange(rsiFollowMain);
  state.rsiChart.timeScale().unsubscribeVisibleLogicalRangeChange(mainFollowRsi);
  state.rsiChart.remove();
  state.rsiChart = null;
  state.rsiSeries = null;
  state.rsiBands = null;
}
// 상단/중간/하단 밴드(기본 70/50/30) 라인들을 설정(on/off, 값)에 맞게 만들거나 지우거나 값만 갱신한다.
// 라벨 설정창에서 체크박스/숫자 입력을 바꿀 때, 그리고 createRsiChart()에서 처음 만들 때 호출된다.
// 세 밴드 모두 축 라벨은 표시하지 않는다(RSI 값 자체의 축 라벨만 보이면 충분하고, 이제 축을 자유롭게
// 드래그해서 조정할 수 있어서 고정된 70/30 숫자가 축에 같이 떠 있으면 오히려 헷갈린다).
function applyRsiBands(){
  if(!state.rsiSeries || !state.rsiSeries.rsi) return;
  if(!state.rsiBands) state.rsiBands = { upper: null, middle: null, lower: null };
  const bands = state.rsiBands;
  const s = state.rsiBandSettings;
  const rsiLine = state.rsiSeries.rsi;
  const specs = [
    { key: 'upper', on: s.upperOn, price: s.upperValue, style: LightweightCharts.LineStyle.Dashed },
    { key: 'middle', on: s.middleOn, price: s.middleValue, style: LightweightCharts.LineStyle.Dotted },
    { key: 'lower', on: s.lowerOn, price: s.lowerValue, style: LightweightCharts.LineStyle.Dashed },
  ];
  specs.forEach(({ key, on, price, style }) => {
    if(on){
      if(bands[key]){
        bands[key].applyOptions({ price, lineStyle: style });
      }else{
        bands[key] = rsiLine.createPriceLine({
          price, color: '#787B86', lineWidth: 1, lineStyle: style, axisLabelVisible: false, title: '',
        });
      }
    }else if(bands[key]){
      rsiLine.removePriceLine(bands[key]);
      bands[key] = null;
    }
  });
}
// 스무딩 MA 타입에 따라 MA/BB 라인 시리즈를 동적으로 만들거나 없앤다
function updateRsiExtraSeries(){
  if(!state.rsiChart || !state.rsiSeries) return;
  const { maType } = state.rsiSettings;
  const wantMA = maType !== 'None';
  const wantBB = maType === 'SMA + Bollinger Bands';
  const rsiAutoscale = () => ({ priceRange: { minValue: 0, maxValue: 100 } });
  if(wantMA && !state.rsiSeries.ma){
    state.rsiSeries.ma = state.rsiChart.addLineSeries({
      color: state.rsiColors.ma, lineWidth: 2, priceScaleId: 'right',
      lastValueVisible: true, priceLineVisible: false, crosshairMarkerVisible: false,
      visible: !state.rsiHidden && state.rsiLineVisible.ma,
    });
    state.rsiSeries.ma.applyOptions({ autoscaleInfoProvider: rsiAutoscale });
  }else if(!wantMA && state.rsiSeries.ma){
    state.rsiChart.removeSeries(state.rsiSeries.ma);
    delete state.rsiSeries.ma;
  }
  if(wantBB && !state.rsiSeries.bbUpper){
    const bbOpt = (color) => ({
      color, lineWidth: 1, priceScaleId: 'right',
      lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
      visible: !state.rsiHidden && state.rsiLineVisible.ma,
    });
    state.rsiSeries.bbUpper = state.rsiChart.addLineSeries(bbOpt(state.rsiColors.bbUpper));
    state.rsiSeries.bbLower = state.rsiChart.addLineSeries(bbOpt(state.rsiColors.bbLower));
    state.rsiSeries.bbUpper.applyOptions({ autoscaleInfoProvider: rsiAutoscale });
    state.rsiSeries.bbLower.applyOptions({ autoscaleInfoProvider: rsiAutoscale });
  }else if(!wantBB && state.rsiSeries.bbUpper){
    state.rsiChart.removeSeries(state.rsiSeries.bbUpper);
    state.rsiChart.removeSeries(state.rsiSeries.bbLower);
    delete state.rsiSeries.bbUpper;
    delete state.rsiSeries.bbLower;
  }
}
function refreshRsiFull(){
  if(!state.rsiOn) return;
  if(!state.rsiChart) createRsiChart();
  updateRsiExtraSeries();
  const bars = state.currentBars;
  if(!bars.length){
    state.rsiSeries.rsi.setData([]);
    if(state.rsiSeries.ma) state.rsiSeries.ma.setData([]);
    if(state.rsiSeries.bbUpper){ state.rsiSeries.bbUpper.setData([]); state.rsiSeries.bbLower.setData([]); }
    state.rsiCalc = null;
    return;
  }
  const { length, source, maType, maLength, bbMult } = state.rsiSettings;
  const { rsiArr, upArr, downArr } = computeRSI(bars, length, source);
  const rsiPts = [];
  for(let i = 0; i < bars.length; i++){ if(rsiArr[i] != null) rsiPts.push({ time: bars[i].time, value: rsiArr[i] }); }
  state.rsiSeries.rsi.setData(rsiPts);

  let maArr = null;
  if(maType !== 'None'){
    const volumes = bars.map(b => b.volume || 0);
    const maBaseType = maType === 'SMA + Bollinger Bands' ? 'SMA' : maType;
    maArr = computeMAFromValues(rsiArr, volumes, maLength, maBaseType);
    const maPts = [];
    for(let i = 0; i < bars.length; i++){ if(maArr[i] != null) maPts.push({ time: bars[i].time, value: maArr[i] }); }
    if(state.rsiSeries.ma) state.rsiSeries.ma.setData(maPts);

    if(maType === 'SMA + Bollinger Bands' && state.rsiSeries.bbUpper){
      const stdevArr = computeStdevFromValues(rsiArr, maLength);
      const upperPts = [], lowerPts = [];
      for(let i = 0; i < bars.length; i++){
        if(maArr[i] == null || stdevArr[i] == null) continue;
        const dev = bbMult * stdevArr[i];
        upperPts.push({ time: bars[i].time, value: maArr[i] + dev });
        lowerPts.push({ time: bars[i].time, value: maArr[i] - dev });
      }
      state.rsiSeries.bbUpper.setData(upperPts);
      state.rsiSeries.bbLower.setData(lowerPts);
    }
  }
  seedRsiCalc(bars, rsiArr, upArr, downArr, maArr);
}
// refreshRsiFull()은 매번 bars 전체를 O(n)으로 재계산하고 나서 chart.setData()로 전체를
// 다시 그리는데, setData()는 series 내부 인덱스를 통째로 재구성하기 때문에 update() 한 번보다
// 수십~수백 배 느리다(실측: bars 5천개 기준 setData 系열 호출들이 refreshRsiFull() 전체 시간의
// 70% 이상을 차지). 라이브 틱마다 이걸 반복하면 봉 수가 많아질수록 눈에 띄게 느려진다.
// 그래서 EMA밴드처럼 "마지막 확정 봉 기준 anchor"를 캐싱해두고, 진행 중인 봉 하나만 O(1)~O(maLength)로
// 다시 계산해서 series.update()로만 반영한다. 설정이 바뀌거나 데이터가 새로 로드될 때만 refreshRsiFull()로
// 전체를 다시 계산하고, 그 결과의 꼬리 부분으로 아래 캐시를 다시 채운다(seed).
function seedRsiCalc(bars, rsiArr, upArr, downArr, maArr){
  const n = bars.length;
  if(n < 1){ state.rsiCalc = null; return; }
  const { source, maLength } = state.rsiSettings;
  const src = (i) => bbSourceValue(bars[i], source);
  const calc = {
    srcAnchor: n >= 2 ? src(n - 2) : null,
    upAnchor: n >= 2 ? upArr[n - 2] : null,
    downAnchor: n >= 2 ? downArr[n - 2] : null,
    maAnchor: (n >= 2 && maArr) ? maArr[n - 2] : null,
    formingTime: bars[n - 1].time,
    formingSrc: src(n - 1),
    formingUp: upArr[n - 1],
    formingDown: downArr[n - 1],
    formingRsi: rsiArr[n - 1],
    formingMa: maArr ? maArr[n - 1] : null,
    formingVol: bars[n - 1].volume || 0,
    rsiWindow: [],   // 가장 최근 확정봉부터 과거 순, 최대 (maLength-1)개 (SMA/WMA/VWMA/stdev용)
    volWindow: [],
  };
  const winLen = Math.max(0, maLength - 1);
  for(let k = 0; k < winLen; k++){
    const idx = n - 2 - k;
    if(idx < 0 || rsiArr[idx] == null) break; // 워밍업 구간이면 창을 못 채운 채로 둔다 (증분 갱신은 자동으로 폴백)
    calc.rsiWindow.push(rsiArr[idx]);
    calc.volWindow.push(bars[idx].volume || 0);
  }
  state.rsiCalc = calc;
}
// 라이브 틱 하나가 들어올 때마다 전체 재계산 없이 anchor 기준으로 마지막(진행 중인) 봉만 다시 계산.
// 캐시가 없거나 아직 워밍업 구간이면 안전하게 refreshRsiFull()로 폴백한다.
function updateRsiIncremental(bar){
  if(!state.rsiOn || !state.rsiSeries) return;
  const calc = state.rsiCalc;
  if(!calc || calc.upAnchor == null || calc.downAnchor == null){
    refreshRsiFull();
    return;
  }
  if(bar.time < calc.formingTime){
    // 시간이 역행하는 봉은 정상 흐름이 아니므로 안전하게 전체 재계산으로 폴백
    refreshRsiFull();
    return;
  }
  const { length, source, maType, maLength, bbMult } = state.rsiSettings;
  if(bar.time > calc.formingTime){
    // 이전에 진행 중이던 봉이 이제 확정됨 -> anchor로 승격
    calc.srcAnchor = calc.formingSrc;
    calc.upAnchor = calc.formingUp;
    calc.downAnchor = calc.formingDown;
    calc.maAnchor = calc.formingMa;
    if(calc.formingRsi != null){
      const maxWin = Math.max(0, maLength - 1);
      calc.rsiWindow.unshift(calc.formingRsi);
      calc.volWindow.unshift(calc.formingVol || 0);
      if(calc.rsiWindow.length > maxWin) calc.rsiWindow.length = maxWin;
      if(calc.volWindow.length > maxWin) calc.volWindow.length = maxWin;
    }
  }
  calc.formingTime = bar.time;

  const src = bbSourceValue(bar, source);
  const alpha = 1 / length;
  const change = src - calc.srcAnchor;
  const gain = Math.max(change, 0), loss = Math.max(-change, 0);
  const up = alpha * gain + (1 - alpha) * calc.upAnchor;
  const down = alpha * loss + (1 - alpha) * calc.downAnchor;
  const rsi = down === 0 ? 100 : (up === 0 ? 0 : 100 - 100 / (1 + up / down));
  calc.formingSrc = src;
  calc.formingUp = up;
  calc.formingDown = down;
  calc.formingRsi = rsi;
  calc.formingVol = bar.volume || 0;
  state.rsiSeries.rsi.update({ time: bar.time, value: rsi });

  if(maType === 'None'){ calc.formingMa = null; return; }
  const maBaseType = maType === 'SMA + Bollinger Bands' ? 'SMA' : maType;
  const winReady = calc.rsiWindow.length >= maLength - 1;
  let maVal = null;
  if(maBaseType === 'EMA' || maBaseType === 'SMMA (RMA)'){
    if(calc.maAnchor == null){ refreshRsiFull(); return; }
    const a = maBaseType === 'EMA' ? 2 / (maLength + 1) : 1 / maLength;
    maVal = a * rsi + (1 - a) * calc.maAnchor;
  }else if(winReady && maBaseType === 'SMA'){
    let sum = rsi;
    for(let k = 0; k < maLength - 1; k++) sum += calc.rsiWindow[k];
    maVal = sum / maLength;
  }else if(winReady && maBaseType === 'WMA'){
    let wsum = rsi * maLength, wtotal = maLength;
    for(let k = 0; k < maLength - 1; k++){ const w = maLength - 1 - k; wsum += calc.rsiWindow[k] * w; wtotal += w; }
    maVal = wsum / wtotal;
  }else if(winReady && maBaseType === 'VWMA'){
    const curVol = bar.volume || 0;
    let pv = rsi * curVol, vsum = curVol;
    for(let k = 0; k < maLength - 1; k++){ pv += calc.rsiWindow[k] * calc.volWindow[k]; vsum += calc.volWindow[k]; }
    maVal = vsum > 0 ? pv / vsum : rsi;
  }
  calc.formingMa = maVal;
  if(maVal == null){
    // 창이 아직 안 찼으면 (막 켰거나 maLength를 늘린 직후) 한 번은 전체 재계산으로 정확히 채운다
    refreshRsiFull();
    return;
  }
  if(state.rsiSeries.ma) state.rsiSeries.ma.update({ time: bar.time, value: maVal });

  if(maType === 'SMA + Bollinger Bands' && state.rsiSeries.bbUpper){
    let sq = (rsi - maVal) * (rsi - maVal);
    for(let k = 0; k < maLength - 1; k++){ const d = calc.rsiWindow[k] - maVal; sq += d * d; }
    const stdev = Math.sqrt(sq / maLength);
    const dev = bbMult * stdev;
    state.rsiSeries.bbUpper.update({ time: bar.time, value: maVal + dev });
    state.rsiSeries.bbLower.update({ time: bar.time, value: maVal - dev });
  }
}
function updateRsiLive(bar){
  if(!state.rsiOn) return;
  if(bar) updateRsiIncremental(bar);
  else refreshRsiFull();
}
function applyRsiVisibility(){
  if(!state.rsiSeries) return;
  state.rsiSeries.rsi.applyOptions({ visible: !state.rsiHidden && state.rsiLineVisible.rsi });
  if(state.rsiSeries.ma) state.rsiSeries.ma.applyOptions({ visible: !state.rsiHidden && state.rsiLineVisible.ma });
  if(state.rsiSeries.bbUpper){
    state.rsiSeries.bbUpper.applyOptions({ visible: !state.rsiHidden && state.rsiLineVisible.ma });
    state.rsiSeries.bbLower.applyOptions({ visible: !state.rsiHidden && state.rsiLineVisible.ma });
  }
}
