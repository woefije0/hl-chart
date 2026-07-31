/* indicators-overlay.js
   Overlay indicators on the main chart: EMA Band, Bollinger Bands, MA Ribbon. */

// ---------- EMA Band 지표 (Pine: EMA Band with Average Line) ----------
// EMA(20~240, 10 간격, 총 23개) 중 최댓값/최솟값을 밴드로, 그 중앙값과 23개 평균을 라인으로 표시.
// lightweight-charts는 두 라인 사이를 채우는 기능이 없어서 4개의 라인(상단/하단/평균/평균2)만 그린다.
const EMA_BAND_LENGTHS = [20,30,40,50,60,70,80,90,100,110,120,130,140,150,160,170,180,190,200,210,220,230,240];
function emaAlpha(len){ return 2 / (len + 1); }

// 전체 봉을 처음부터 다시 계산한다. anchor는 "마지막 봉 직전까지의 EMA 상태"로,
// 실시간 갱신 시 형성 중인 마지막 봉만 다시 계산하기 위한 기준점으로 쓰인다.
function computeEmaBandFull(bars){
  const current = {};
  let anchorBeforeLast = {};
  const points = [];
  bars.forEach((b) => {
    anchorBeforeLast = { ...current };
    EMA_BAND_LENGTHS.forEach(len => {
      const a = emaAlpha(len);
      current[len] = (current[len] == null) ? b.close : a * b.close + (1 - a) * current[len];
    });
    const vals = EMA_BAND_LENGTHS.map(len => current[len]);
    const max = Math.max(...vals);
    const min = Math.min(...vals);
    points.push({
      time: b.time,
      max, min,
      avg: (max + min) / 2,
      avg2: vals.reduce((s, v) => s + v, 0) / vals.length,
    });
  });
  return {
    points,
    anchor: anchorBeforeLast,
    current: { ...current },
    lastTime: bars.length ? bars[bars.length - 1].time : null,
  };
}

function createEmaBandSeries(){
  if(!state.chart || state.emaSeries) return;
  const lineOpt = (color, visible) => ({
    color, lineWidth: 2, priceScaleId: 'right',
    lastValueVisible: true,   // 가격축(오른쪽)에 현재 값 라벨 표시
    priceLineVisible: false,  // 차트 전체를 가로지르는 점선은 4개나 겹치면 지저분해서 끔
    crosshairMarkerVisible: false,
    visible,
  });
  const vis = key => !state.emaBandHidden && state.emaBandLineVisible[key];
  state.emaSeries = {
    max: state.chart.addLineSeries(lineOpt(state.emaBandColors.max, vis('max'))),
    min: state.chart.addLineSeries(lineOpt(state.emaBandColors.min, vis('min'))),
    avg: state.chart.addLineSeries(lineOpt(state.emaBandColors.avg, vis('avg'))),
    avg2: state.chart.addLineSeries(lineOpt(state.emaBandColors.avg2, vis('avg2'))),
  };
}
// 눈 아이콘/개별 라인 체크박스 상태를 실제 시리즈에 반영
function applyEmaVisibility(){
  if(!state.emaSeries) return;
  ['max','min','avg','avg2'].forEach(key => {
    state.emaSeries[key].applyOptions({ visible: !state.emaBandHidden && state.emaBandLineVisible[key] });
  });
}
function removeEmaBandSeries(){
  if(!state.chart || !state.emaSeries) return;
  Object.values(state.emaSeries).forEach(s => state.chart.removeSeries(s));
  state.emaSeries = null;
  state.emaCalc = null;
}

// 페어/인터벌 전환, 과거 데이터 추가 로딩 등 state.currentBars 전체가 바뀔 때 호출
function refreshEmaBandFull(){
  if(!state.emaBandOn) return;
  if(!state.emaSeries) createEmaBandSeries();
  const bars = state.currentBars;
  if(!bars.length){
    Object.values(state.emaSeries).forEach(s => s.setData([]));
    state.emaCalc = null;
    return;
  }
  const result = computeEmaBandFull(bars);
  state.emaSeries.max.setData(result.points.map(p => ({ time: p.time, value: p.max })));
  state.emaSeries.min.setData(result.points.map(p => ({ time: p.time, value: p.min })));
  state.emaSeries.avg.setData(result.points.map(p => ({ time: p.time, value: p.avg })));
  state.emaSeries.avg2.setData(result.points.map(p => ({ time: p.time, value: p.avg2 })));
  state.emaCalc = { anchor: result.anchor, current: result.current, lastTime: result.lastTime };
}

// 실시간 봉 하나가 들어올 때마다 전체 재계산 없이 anchor 기준으로 마지막 봉만 다시 계산
function updateEmaBandLive(bar){
  if(!state.emaBandOn || !state.emaSeries) return;
  if(!state.emaCalc){
    refreshEmaBandFull();
    return;
  }
  const calc = state.emaCalc;
  if(calc.lastTime == null || bar.time > calc.lastTime){
    calc.anchor = { ...calc.current };
    calc.lastTime = bar.time;
  }
  const current = {};
  EMA_BAND_LENGTHS.forEach(len => {
    const a = emaAlpha(len);
    const anchor = calc.anchor[len];
    current[len] = (anchor == null) ? bar.close : a * bar.close + (1 - a) * anchor;
  });
  calc.current = current;
  const vals = EMA_BAND_LENGTHS.map(len => current[len]);
  const max = Math.max(...vals);
  const min = Math.min(...vals);
  const avg = (max + min) / 2;
  const avg2 = vals.reduce((s, v) => s + v, 0) / vals.length;
  state.emaSeries.max.update({ time: bar.time, value: max });
  state.emaSeries.min.update({ time: bar.time, value: min });
  state.emaSeries.avg.update({ time: bar.time, value: avg });
  state.emaSeries.avg2.update({ time: bar.time, value: avg2 });
}

// ---------- Bollinger Bands 지표 (Pine: Bollinger Bands, BB) ----------
function bbSourceValue(bar, source){
  switch(source){
    case 'open': return bar.open;
    case 'high': return bar.high;
    case 'low': return bar.low;
    case 'hl2': return (bar.high + bar.low) / 2;
    case 'hlc3': return (bar.high + bar.low + bar.close) / 3;
    case 'ohlc4': return (bar.open + bar.high + bar.low + bar.close) / 4;
    default: return bar.close;
  }
}
// bars 전체에 대해 이동평균 배열을 계산 (SMA/EMA/SMMA(RMA)/WMA/VWMA)
// length-1번째 인덱스 이전은 계산할 표본이 부족하므로 null
function computeMASeries(bars, length, type, source){
  const n = bars.length;
  const src = bars.map(b => bbSourceValue(b, source));
  const out = new Array(n).fill(null);
  if(length < 1) return out;
  if(type === 'EMA' || type === 'SMMA (RMA)'){
    const alpha = type === 'EMA' ? 2 / (length + 1) : 1 / length;
    let seedSum = 0;
    for(let i = 0; i < n; i++){
      if(i < length - 1){
        seedSum += src[i];
      }else if(i === length - 1){
        seedSum += src[i];
        out[i] = seedSum / length;
      }else{
        out[i] = alpha * src[i] + (1 - alpha) * out[i - 1];
      }
    }
  }else if(type === 'WMA'){
    for(let i = length - 1; i < n; i++){
      let wsum = 0, wtotal = 0;
      for(let k = 0; k < length; k++){ const w = length - k; wsum += src[i - k] * w; wtotal += w; }
      out[i] = wsum / wtotal;
    }
  }else if(type === 'VWMA'){
    for(let i = length - 1; i < n; i++){
      let pv = 0, vsum = 0;
      for(let k = 0; k < length; k++){ const b = bars[i - k]; const vol = b.volume || 0; pv += src[i - k] * vol; vsum += vol; }
      out[i] = vsum > 0 ? pv / vsum : src[i];
    }
  }else{ // SMA (기본값)
    let sum = 0;
    for(let i = 0; i < n; i++){
      sum += src[i];
      if(i >= length) sum -= src[i - length];
      if(i >= length - 1) out[i] = sum / length;
    }
  }
  return out;
}
// ---------- 증분 갱신용: "인덱스 i 한 곳"만 계산하는 버전 ----------
// 위의 compute*Series()는 봉 전체를 훑는 함수라, 실시간 틱마다 부르면 봉 개수에 비례해서
// 느려진다(게다가 결과를 series.setData()로 통째로 다시 넣어야 해서 그쪽이 더 비쌌다).
// 마지막(형성 중인) 봉 하나만 다시 계산할 때는 아래 두 함수를 쓴다.
//
//   values : 소스 값 배열 (앞쪽에 워밍업 구간 null이 있을 수 있음)
//   out    : 지금까지 계산된 이동평균 배열 — EMA/SMMA가 out[i-1]을 필요로 한다
// 계산에 필요한 값이 아직 없으면 null을 돌려주고, 호출한 쪽이 전체 재계산으로 폴백한다.
// (compute*Series()와 완전히 같은 값이 나오는지는 tools/verify-indicators.js 로 검증한다.)
function maValueAt(values, volumes, out, i, length, type){
  if(length < 1 || i < 0 || i < length - 1) return null;
  if(values[i] == null) return null;
  if(type === 'EMA' || type === 'SMMA (RMA)'){
    const prev = out[i - 1];
    if(prev == null) return null; // 시드 구간은 전체 재계산에 맡긴다
    const alpha = type === 'EMA' ? 2 / (length + 1) : 1 / length;
    return alpha * values[i] + (1 - alpha) * prev;
  }
  if(type === 'WMA'){
    let wsum = 0, wtotal = 0;
    for(let k = 0; k < length; k++){
      const v = values[i - k];
      if(v == null) return null;
      const w = length - k;
      wsum += v * w; wtotal += w;
    }
    return wsum / wtotal;
  }
  if(type === 'VWMA'){
    let pv = 0, vsum = 0;
    for(let k = 0; k < length; k++){
      const v = values[i - k];
      if(v == null) return null;
      const vol = (volumes && volumes[i - k]) || 0;
      pv += v * vol; vsum += vol;
    }
    return vsum > 0 ? pv / vsum : values[i];
  }
  let sum = 0; // SMA
  for(let k = 0; k < length; k++){
    const v = values[i - k];
    if(v == null) return null;
    sum += v;
  }
  return sum / length;
}
function stdevValueAt(values, i, length){
  if(i < 0 || i < length - 1) return null;
  let sum = 0;
  for(let k = 0; k < length; k++){
    const v = values[i - k];
    if(v == null) return null;
    sum += v;
  }
  const mean = sum / length;
  let sqSum = 0;
  for(let k = 0; k < length; k++){ const d = values[i - k] - mean; sqSum += d * d; }
  return Math.sqrt(sqSum / length);
}

// 표준편차 (Pine ta.stdev 기본값과 동일하게 모집단 표준편차: N으로 나눔, source의 산술평균 기준)
function computeStdevSeries(bars, length, source){
  const n = bars.length;
  const src = bars.map(b => bbSourceValue(b, source));
  const out = new Array(n).fill(null);
  for(let i = length - 1; i < n; i++){
    let sum = 0;
    for(let k = 0; k < length; k++) sum += src[i - k];
    const mean = sum / length;
    let sqSum = 0;
    for(let k = 0; k < length; k++){ const d = src[i - k] - mean; sqSum += d * d; }
    out[i] = Math.sqrt(sqSum / length);
  }
  return out;
}
function createBBSeries(){
  if(!state.chart || state.bbSeries) return;
  const lineOpt = (color, visible) => ({
    color, lineWidth: 2, priceScaleId: 'right',
    lastValueVisible: true, priceLineVisible: false, crosshairMarkerVisible: false, visible,
    autoscaleInfoProvider: () => null,
  });
  const vis = key => !state.bbHidden && state.bbLineVisible[key];
  state.bbSeries = {
    basis: state.chart.addLineSeries(lineOpt(state.bbColors.basis, vis('basis'))),
    upper: state.chart.addLineSeries(lineOpt(state.bbColors.upper, vis('upper'))),
    lower: state.chart.addLineSeries(lineOpt(state.bbColors.lower, vis('lower'))),
  };
}
function removeBBSeries(){
  if(!state.chart || !state.bbSeries) return;
  Object.values(state.bbSeries).forEach(s => state.chart.removeSeries(s));
  state.bbSeries = null;
}
function applyBBVisibility(){
  if(!state.bbSeries) return;
  ['basis', 'upper', 'lower'].forEach(key => {
    state.bbSeries[key].applyOptions({ visible: !state.bbHidden && state.bbLineVisible[key] });
  });
}
// 설정이 바뀌거나 데이터가 새로 로드될 때만 전체 재계산. 계산 결과 배열은 그대로 캐시에 남겨서
// 실시간 틱에서는 마지막 봉 한 칸만 다시 계산할 수 있게 한다(updateBBLive 참고).
function refreshBBFull(){
  if(!state.bbOn) return;
  if(!state.bbSeries) createBBSeries();
  const bars = state.currentBars;
  if(!bars.length){
    Object.values(state.bbSeries).forEach(s => s.setData([]));
    state.bbCalc = null;
    return;
  }
  const { length, maType, source, mult } = state.bbSettings;
  const srcArr = bars.map(b => bbSourceValue(b, source));
  const volArr = bars.map(b => b.volume || 0);
  const basisArr = computeMASeries(bars, length, maType, source);
  const stdevArr = computeStdevSeries(bars, length, source);
  const basisPts = [], upperPts = [], lowerPts = [];
  for(let i = 0; i < bars.length; i++){
    if(basisArr[i] == null || stdevArr[i] == null) continue;
    const dev = mult * stdevArr[i];
    basisPts.push({ time: bars[i].time, value: basisArr[i] });
    upperPts.push({ time: bars[i].time, value: basisArr[i] + dev });
    lowerPts.push({ time: bars[i].time, value: basisArr[i] - dev });
  }
  state.bbSeries.basis.setData(basisPts);
  state.bbSeries.upper.setData(upperPts);
  state.bbSeries.lower.setData(lowerPts);
  state.bbCalc = { srcArr, volArr, basisArr, stdevArr, formingTime: bars[bars.length - 1].time };
}
// 실시간 틱: 마지막(형성 중인) 봉 한 칸만 다시 계산해서 series.update()로 반영한다.
// 예전엔 틱마다 refreshBBFull()을 불러서 전체 재계산 + setData 3번을 반복했다.
function updateBBLive(bar){
  if(!state.bbOn || !state.bbSeries) return;
  const calc = state.bbCalc;
  const bars = state.currentBars;
  if(!calc || !bar || bar.time < calc.formingTime){ refreshBBFull(); return; }

  if(bar.time > calc.formingTime){
    // 새 봉 시작: 배열 끝에 한 칸 늘린다 (직전 값들은 그대로 확정값이 된다)
    calc.srcArr.push(null); calc.volArr.push(0);
    calc.basisArr.push(null); calc.stdevArr.push(null);
    calc.formingTime = bar.time;
  }
  const i = bars.length - 1;
  if(calc.basisArr.length !== bars.length){ refreshBBFull(); return; } // 배열이 어긋나면 안전하게 폴백

  const { length, maType, source, mult } = state.bbSettings;
  calc.srcArr[i] = bbSourceValue(bar, source);
  calc.volArr[i] = bar.volume || 0;
  const basis = maValueAt(calc.srcArr, calc.volArr, calc.basisArr, i, length, maType);
  const stdev = stdevValueAt(calc.srcArr, i, length);
  if(basis == null || stdev == null){ refreshBBFull(); return; }
  calc.basisArr[i] = basis;
  calc.stdevArr[i] = stdev;

  const dev = mult * stdev;
  state.bbSeries.basis.update({ time: bar.time, value: basis });
  state.bbSeries.upper.update({ time: bar.time, value: basis + dev });
  state.bbSeries.lower.update({ time: bar.time, value: basis - dev });
}

// ---------- VWAP (Pine: Volume Weighted Average Price 참고) ----------
// anchor(세션 리셋 주기)가 바뀔 때마다 누적합(가격*거래량 합 / 거래량 합)을 0부터 다시 쌓는다.
// TradingView 원본의 Earnings/Dividends/Splits/Decade/Century anchor는 실적·배당 발표일 같은
// 외부 데이터가 있어야 하는데 이 앱엔 그런 데이터 소스가 없어서 제외했고, 봉의 시간 하나만으로
// 계산 가능한 Session/Week/Month/Quarter/Year만 지원한다.
function vwapPeriodKey(timeSec, anchor){
  const d = new Date(timeSec * 1000);
  switch(anchor){
    // 1970-01-01(목요일) 기준 7일 단위 — 거래소마다 다른 "주의 시작 요일"과는 안 맞을 수 있지만,
    // "7일에 한 번 리셋된다"는 목적 자체는 그대로 만족한다.
    case 'week': return Math.floor(timeSec / 604800);
    case 'month': return d.getUTCFullYear() * 12 + d.getUTCMonth();
    case 'quarter': return d.getUTCFullYear() * 4 + Math.floor(d.getUTCMonth() / 3);
    case 'year': return d.getUTCFullYear();
    default: return Math.floor(timeSec / 86400); // session: UTC 자정 기준 일별 리셋
  }
}
// bars 전체에 대해 누적합 배열을 처음부터 계산. Pine의 ta.vwap과 동일하게, 밴드 폭의 기준값은
// "vwap으로부터의 거래량가중 표준편차"(모집단 표준편차, cumPV2 기반)를 쓴다.
function computeVwapArrays(bars, settings){
  const { anchor, source } = settings;
  const n = bars.length;
  const cumPV = new Array(n).fill(0);
  const cumVol = new Array(n).fill(0);
  const cumPV2 = new Array(n).fill(0);
  const periodKey = new Array(n).fill(0);
  const vwapArr = new Array(n).fill(null);
  const stdevArr = new Array(n).fill(null);
  for(let i = 0; i < n; i++){
    const key = vwapPeriodKey(bars[i].time, anchor);
    const price = bbSourceValue(bars[i], source);
    const vol = bars[i].volume || 0;
    const newPeriod = i === 0 || key !== periodKey[i - 1];
    const prevPV = newPeriod ? 0 : cumPV[i - 1];
    const prevVol = newPeriod ? 0 : cumVol[i - 1];
    const prevPV2 = newPeriod ? 0 : cumPV2[i - 1];
    cumPV[i] = prevPV + price * vol;
    cumVol[i] = prevVol + vol;
    cumPV2[i] = prevPV2 + price * price * vol;
    periodKey[i] = key;
    vwapArr[i] = cumVol[i] > 0 ? cumPV[i] / cumVol[i] : price; // 그 기간의 첫 봉이 거래량 0이면 그냥 소스값
    const variance = cumVol[i] > 0 ? Math.max(0, cumPV2[i] / cumVol[i] - vwapArr[i] * vwapArr[i]) : 0;
    stdevArr[i] = Math.sqrt(variance);
  }
  return { cumPV, cumVol, cumPV2, periodKey, vwapArr, stdevArr };
}
function createVwapSeries(){
  if(!state.chart || state.vwapSeries) return;
  const lineOpt = (color, visible, width) => ({
    color, lineWidth: width, priceScaleId: 'right',
    lastValueVisible: width > 1, priceLineVisible: false, crosshairMarkerVisible: false, visible,
    autoscaleInfoProvider: () => null,
  });
  const bandVisible = (n) => !state.vwapHidden && state.vwapSettings.bands[n].show;
  state.vwapSeries = {
    vwap: state.chart.addLineSeries(lineOpt(state.vwapColors.vwap, !state.vwapHidden && state.vwapLineVisible.vwap, 2)),
    band1: {
      upper: state.chart.addLineSeries(lineOpt(state.vwapColors.band1, bandVisible(1), 1)),
      lower: state.chart.addLineSeries(lineOpt(state.vwapColors.band1, bandVisible(1), 1)),
    },
    band2: {
      upper: state.chart.addLineSeries(lineOpt(state.vwapColors.band2, bandVisible(2), 1)),
      lower: state.chart.addLineSeries(lineOpt(state.vwapColors.band2, bandVisible(2), 1)),
    },
    band3: {
      upper: state.chart.addLineSeries(lineOpt(state.vwapColors.band3, bandVisible(3), 1)),
      lower: state.chart.addLineSeries(lineOpt(state.vwapColors.band3, bandVisible(3), 1)),
    },
  };
}
function removeVwapSeries(){
  if(!state.chart || !state.vwapSeries) return;
  state.chart.removeSeries(state.vwapSeries.vwap);
  [1, 2, 3].forEach(n => {
    state.chart.removeSeries(state.vwapSeries['band' + n].upper);
    state.chart.removeSeries(state.vwapSeries['band' + n].lower);
  });
  state.vwapSeries = null;
  state.vwapCalc = null;
}
function applyVwapVisibility(){
  if(!state.vwapSeries) return;
  state.vwapSeries.vwap.applyOptions({ visible: !state.vwapHidden && state.vwapLineVisible.vwap, color: state.vwapColors.vwap });
  [1, 2, 3].forEach(n => {
    const vis = !state.vwapHidden && state.vwapSettings.bands[n].show;
    const color = state.vwapColors['band' + n];
    state.vwapSeries['band' + n].upper.applyOptions({ visible: vis, color });
    state.vwapSeries['band' + n].lower.applyOptions({ visible: vis, color });
  });
}
function refreshVwapFull(){
  if(!state.vwapOn) return;
  if(!state.vwapSeries) createVwapSeries();
  const bars = state.currentBars;
  if(!bars.length){
    state.vwapSeries.vwap.setData([]);
    [1, 2, 3].forEach(n => { state.vwapSeries['band' + n].upper.setData([]); state.vwapSeries['band' + n].lower.setData([]); });
    state.vwapCalc = null;
    return;
  }
  const settings = state.vwapSettings;
  const calc = computeVwapArrays(bars, settings);
  const vwapPts = [];
  const bandPts = { 1: { upper: [], lower: [] }, 2: { upper: [], lower: [] }, 3: { upper: [], lower: [] } };
  for(let i = 0; i < bars.length; i++){
    const time = bars[i].time;
    const vwap = calc.vwapArr[i];
    vwapPts.push({ time, value: vwap });
    // Pine과 동일: "Standard Deviation" 모드는 그 시점까지의 거래량가중 표준편차, "Percentage" 모드는
    // vwap의 1%를 기준 단위로 삼아 배수를 곱한다 (bandMult=1이면 ±1%).
    const basis = settings.calcMode === 'percent' ? vwap * 0.01 : calc.stdevArr[i];
    [1, 2, 3].forEach(n => {
      const mult = settings.bands[n].mult;
      bandPts[n].upper.push({ time, value: vwap + basis * mult });
      bandPts[n].lower.push({ time, value: vwap - basis * mult });
    });
  }
  state.vwapSeries.vwap.setData(vwapPts);
  [1, 2, 3].forEach(n => {
    state.vwapSeries['band' + n].upper.setData(bandPts[n].upper);
    state.vwapSeries['band' + n].lower.setData(bandPts[n].lower);
  });
  state.vwapCalc = { ...calc, formingTime: bars[bars.length - 1].time };
}
// 실시간 틱: 마지막(형성 중인) 봉의 누적합만 다시 계산한다. i-1까지의 누적값은 이미 확정된
// 과거이므로 안 건드리고, i번째만 "이전 누적 + 이번 봉의 기여분"으로 다시 채운다 — BB의
// updateBBLive와 같은 "배열 끝 한 칸만 갱신" 패턴이라, 리플레이로 한 봉씩 재생할 때도 그
// 시점까지의 데이터만으로 계산된 값이 나온다(미래 봉을 미리 들여다보지 않음).
function updateVwapLive(bar){
  if(!state.vwapOn || !state.vwapSeries) return;
  const calc = state.vwapCalc;
  const bars = state.currentBars;
  if(!calc || !bar || bar.time < calc.formingTime){ refreshVwapFull(); return; }

  if(bar.time > calc.formingTime){
    calc.cumPV.push(0); calc.cumVol.push(0); calc.cumPV2.push(0); calc.periodKey.push(0);
    calc.vwapArr.push(null); calc.stdevArr.push(null);
    calc.formingTime = bar.time;
  }
  const i = bars.length - 1;
  if(calc.vwapArr.length !== bars.length){ refreshVwapFull(); return; } // 배열이 어긋나면 안전하게 폴백

  const settings = state.vwapSettings;
  const key = vwapPeriodKey(bar.time, settings.anchor);
  const price = bbSourceValue(bar, settings.source);
  const vol = bar.volume || 0;
  const newPeriod = i === 0 || key !== calc.periodKey[i - 1];
  const prevPV = newPeriod ? 0 : calc.cumPV[i - 1];
  const prevVol = newPeriod ? 0 : calc.cumVol[i - 1];
  const prevPV2 = newPeriod ? 0 : calc.cumPV2[i - 1];
  calc.cumPV[i] = prevPV + price * vol;
  calc.cumVol[i] = prevVol + vol;
  calc.cumPV2[i] = prevPV2 + price * price * vol;
  calc.periodKey[i] = key;
  const vwap = calc.cumVol[i] > 0 ? calc.cumPV[i] / calc.cumVol[i] : price;
  const variance = calc.cumVol[i] > 0 ? Math.max(0, calc.cumPV2[i] / calc.cumVol[i] - vwap * vwap) : 0;
  const stdev = Math.sqrt(variance);
  calc.vwapArr[i] = vwap;
  calc.stdevArr[i] = stdev;

  state.vwapSeries.vwap.update({ time: bar.time, value: vwap });
  const basis = settings.calcMode === 'percent' ? vwap * 0.01 : stdev;
  [1, 2, 3].forEach(n => {
    const mult = settings.bands[n].mult;
    state.vwapSeries['band' + n].upper.update({ time: bar.time, value: vwap + basis * mult });
    state.vwapSeries['band' + n].lower.update({ time: bar.time, value: vwap - basis * mult });
  });
}

// ---------- MA Ribbon 지표 (Pine: Moving Average Ribbon) ----------
// 서로 독립적인 이동평균선들을 메인 차트 위에 겹쳐 그린다 (overlay=true). 기본은 4개(Pine 원본과 동일)지만
// 설정창의 "+ Add Line"으로 원하는 만큼 라인을 더 추가하거나, 각 라인의 휴지통 아이콘으로 개별 삭제할 수 있다.
// 라인마다 종류(SMA/EMA/SMMA/WMA/VWMA)/소스/길이/색상/표시여부를 개별로 가진다.
function maRibbonLineIds(){
  // 숫자 id 기준으로 정렬해서 항상 같은 순서로 표시 (라인을 추가/삭제해도 순서가 안 흔들리게)
  return Object.keys(state.maRibbonSettings).sort((a, b) => Number(a) - Number(b));
}
// 시리즈가 없는 라인(새로 추가된 라인 포함)만 만들어서 채워넣는다. 이미 있는 시리즈는 건드리지 않는다.
function ensureMaRibbonSeries(){
  if(!state.chart) return;
  if(!state.maRibbonSeries) state.maRibbonSeries = {};
  maRibbonLineIds().forEach(id => {
    if(state.maRibbonSeries[id]) return;
    const cfg = state.maRibbonSettings[id];
    state.maRibbonSeries[id] = state.chart.addLineSeries({
      color: cfg.color, lineWidth: 2, priceScaleId: 'right',
      lastValueVisible: true, priceLineVisible: false, crosshairMarkerVisible: false,
      visible: !state.maRibbonHidden && cfg.show,
      autoscaleInfoProvider: () => null,
    });
  });
}
function removeMaRibbonSeries(){
  if(!state.chart || !state.maRibbonSeries) return;
  Object.values(state.maRibbonSeries).forEach(s => state.chart.removeSeries(s));
  state.maRibbonSeries = null;
}
// 라인 하나만 콕 집어 지운다 (시리즈 + 설정 둘 다). 마지막 남은 라인이어도 지울 수 있다.
function removeMaRibbonLine(id){
  if(state.maRibbonSeries && state.maRibbonSeries[id]){
    state.chart.removeSeries(state.maRibbonSeries[id]);
    delete state.maRibbonSeries[id];
  }
  delete state.maRibbonSettings[id];
  renderMaRibbonSettingsPanel();
}
// 팔레트를 순환하면서 새 라인에 매번 다른 기본 색을 준다 (다 같은 색으로 겹쳐 보이지 않도록)
const MA_RIBBON_PALETTE = ['#4fd1c5', '#63b3ed', '#b794f4', '#f687b3', '#68d391', '#fbd38d', '#fc8181', '#81e6d9'];
function addMaRibbonLine(){
  const id = String(state.maRibbonNextId++);
  const color = MA_RIBBON_PALETTE[(Number(id) - 5) % MA_RIBBON_PALETTE.length];
  state.maRibbonSettings[id] = { show: true, type: 'SMA', source: 'close', length: 20, color };
  renderMaRibbonSettingsPanel();
  if(state.maRibbonOn){
    ensureMaRibbonSeries();
    refreshMaRibbonFull();
  }
}
function applyMaRibbonVisibility(){
  if(!state.maRibbonSeries) return;
  maRibbonLineIds().forEach(id => {
    if(!state.maRibbonSeries[id]) return;
    state.maRibbonSeries[id].applyOptions({ visible: !state.maRibbonHidden && state.maRibbonSettings[id].show });
  });
}
// BB와 같은 방식: 전체 재계산 결과를 라인별로 캐시해두고, 실시간 틱에서는 마지막 칸만 갱신한다.
function refreshMaRibbonFull(){
  if(!state.maRibbonOn) return;
  ensureMaRibbonSeries();
  const bars = state.currentBars;
  const calc = {};
  maRibbonLineIds().forEach(id => {
    const series = state.maRibbonSeries[id];
    if(!series) return;
    if(!bars.length){ series.setData([]); return; }
    const cfg = state.maRibbonSettings[id];
    const arr = computeMASeries(bars, cfg.length, cfg.type, cfg.source);
    const pts = [];
    for(let i = 0; i < bars.length; i++){ if(arr[i] != null) pts.push({ time: bars[i].time, value: arr[i] }); }
    series.setData(pts);
    calc[id] = { srcArr: bars.map(b => bbSourceValue(b, cfg.source)), volArr: bars.map(b => b.volume || 0), maArr: arr };
  });
  state.maRibbonCalc = bars.length ? { lines: calc, formingTime: bars[bars.length - 1].time } : null;
}
function updateMaRibbonLive(bar){
  if(!state.maRibbonOn || !state.maRibbonSeries) return;
  const calc = state.maRibbonCalc;
  const bars = state.currentBars;
  if(!calc || !bar || bar.time < calc.formingTime){ refreshMaRibbonFull(); return; }

  const ids = maRibbonLineIds();
  // 라인이 추가/삭제됐으면 캐시가 맞지 않으니 전체 재계산
  if(ids.some(id => !calc.lines[id])){ refreshMaRibbonFull(); return; }

  if(bar.time > calc.formingTime){
    ids.forEach(id => {
      const line = calc.lines[id];
      line.srcArr.push(null); line.volArr.push(0); line.maArr.push(null);
    });
    calc.formingTime = bar.time;
  }
  const i = bars.length - 1;

  for(const id of ids){
    const line = calc.lines[id];
    if(line.maArr.length !== bars.length){ refreshMaRibbonFull(); return; }
    const cfg = state.maRibbonSettings[id];
    line.srcArr[i] = bbSourceValue(bar, cfg.source);
    line.volArr[i] = bar.volume || 0;
    const value = maValueAt(line.srcArr, line.volArr, line.maArr, i, cfg.length, cfg.type);
    if(value == null){ refreshMaRibbonFull(); return; }
    line.maArr[i] = value;
    state.maRibbonSeries[id].update({ time: bar.time, value });
  }
}
