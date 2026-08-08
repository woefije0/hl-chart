/* indicators-ui.js
   Indicator on/off dropdown, chart legends and their settings panels. */

// 참고: 지표 on/off는 일부러 저장하지 않는다(state.js 상단 주석 — 복원 과정에서 범례/패널/
// 확대범위가 어긋나는 버그가 반복됐음). 그런데 아래 토글들이 전부 persistPrefs()를 부르고
// 있어서, 지표를 켜고 끌 때마다 저장 대상도 아닌 값 때문에 prefs 전체를 JSON으로 직렬화해
// localStorage에 다시 쓰고 있었다 — 하는 일이 아무것도 없는 호출이라 전부 걷어냈다.
function setEmaBandOn(on){
  state.emaBandOn = on;
  if(on){
    refreshEmaBandFull();
  }else{
    removeEmaBandSeries();
  }
  renderEmaLegend();
  renderIndicatorsList();
}
function setBBOn(on){
  state.bbOn = on;
  if(on){
    refreshBBFull();
  }else{
    removeBBSeries();
  }
  renderBBLegend();
  renderIndicatorsList();
}
function setVwapOn(on){
  state.vwapOn = on;
  if(on){
    refreshVwapFull();
  }else{
    removeVwapSeries();
  }
  renderVwapLegend();
  renderIndicatorsList();
}
function setMaRibbonOn(on){
  state.maRibbonOn = on;
  if(on){
    refreshMaRibbonFull();
  }else{
    removeMaRibbonSeries();
  }
  renderMaRibbonLegend();
  renderIndicatorsList();
}
function setRsiOn(on){
  state.rsiOn = on;
  if(on){
    rsiPaneEl.style.display = 'block';
    refreshRsiFull(); // 내부에서 필요하면 createRsiChart() 호출
    requestAnimationFrame(() => {
      if(state.rsiChart) state.rsiChart.resize(rsiChartEl.clientWidth, rsiChartEl.clientHeight);
    });
  }else{
    rsiPaneEl.style.display = 'none';
    destroyRsiChart();
  }
  renderRsiLegend();
  renderIndicatorsList();
}
function setMacdOn(on){
  state.macdOn = on;
  if(on){
    macdPaneEl.style.display = 'block';
    refreshMacdFull(); // 내부에서 필요하면 createMacdChart() 호출
    requestAnimationFrame(() => {
      if(state.macdChart) state.macdChart.resize(macdChartEl.clientWidth, macdChartEl.clientHeight);
    });
  }else{
    macdPaneEl.style.display = 'none';
    destroyMacdChart();
  }
  renderMacdLegend();
  renderIndicatorsList();
}

// ---------- 지표(Indicators) 드롭다운 ----------
// 새 지표를 추가하려면 이 배열에 { id, labelKey, isOn, toggle } 형태로 추가하면 된다.
const INDICATORS = [
  {
    id: 'emaBand',
    labelKey: 'emaBandLabel',
    isOn: () => state.emaBandOn,
    toggle: () => setEmaBandOn(!state.emaBandOn),
  },
  {
    id: 'bb',
    labelKey: 'bbLabel',
    isOn: () => state.bbOn,
    toggle: () => setBBOn(!state.bbOn),
  },
  {
    id: 'vwap',
    labelKey: 'vwapLabel',
    isOn: () => state.vwapOn,
    toggle: () => setVwapOn(!state.vwapOn),
  },
  {
    id: 'maRibbon',
    labelKey: 'maRibbonLabel',
    isOn: () => state.maRibbonOn,
    toggle: () => setMaRibbonOn(!state.maRibbonOn),
  },
  {
    id: 'rsi',
    labelKey: 'rsiLabel',
    isOn: () => state.rsiOn,
    toggle: () => setRsiOn(!state.rsiOn),
  },
  {
    id: 'macd',
    labelKey: 'macdLabel',
    isOn: () => state.macdOn,
    toggle: () => setMacdOn(!state.macdOn),
  },
  // 청산 히트맵은 여기(지표 드롭다운)가 아니라 상단 두 번째 줄의 전용 토글 버튼
  // (liqHeatmapToggleBtn, indicator-liq-heatmap.js)으로 켜고 끈다 — whale/wallet/funding처럼
  // 이 앱 특화 기능으로 취급하는 게 더 맞다고 판단해서 옮김. 범례 칩(설정/끄기)은 그대로 유지.
];

// state.currentBars 전체가 갈아끼워질 때(페어/인터벌 전환, 과거 데이터 추가 로딩, 리플레이
// 되감기) 내장 지표를 전부 다시 계산한다. 네 곳이 같은 여섯 줄을 그대로 복사해 갖고 있어서,
// 지표를 새로 추가할 때 한 곳만 빠뜨리기 쉬웠다. (각 refresh*Full은 지표가 꺼져 있으면 즉시 반환)
function refreshAllIndicators(){
  refreshEmaBandFull();
  refreshBBFull();
  refreshVwapFull();
  refreshMaRibbonFull();
  refreshRsiFull();
  refreshMacdFull();
  refreshLiqHeatmapFull();
}

const indicatorsToggle = document.getElementById('indicatorsToggle');
const indicatorsDropdown = document.getElementById('indicatorsDropdown');
const indicatorsList = document.getElementById('indicatorsList');

function renderIndicatorsList(){
  indicatorsList.innerHTML = '';
  INDICATORS.forEach(ind => {
    const on = ind.isOn();
    indicatorsList.appendChild(makeDropdownRow({
      active: on,
      label: t(ind.labelKey),
      badge: { className: on ? 'ON' : 'OFF', text: on ? 'ON' : 'OFF' },
      onClick: () => ind.toggle(), // 드롭다운은 열어둔 채로 켜고/끌 수 있게 닫지 않음
    }));
  });
}
const indicatorsDropdownCtrl = createDropdown(indicatorsToggle, indicatorsDropdown, renderIndicatorsList);

// ---------- 차트 좌상단 지표 범례 (TradingView 스타일) ----------
// 설정창(⚙)은 화면 정중앙에 모달처럼 뜬다 (RSI처럼 화면 아래쪽 패널의 라벨을 누르면
// 바로 아래에 붙이는 방식으론 화면 밖으로 잘려서 안 보이는 문제가 있었음).
// 여러 개가 동시에 열리면 겹치니, 하나를 열면 나머지는 자동으로 닫는다.
const legendSettingsBackdrop = document.getElementById('legendSettingsBackdrop');
const ALL_LEGEND_SETTINGS = [];
function openLegendSettings(panel){
  ALL_LEGEND_SETTINGS.forEach(p => { if(p !== panel) p.classList.remove('open'); });
  panel.classList.add('open');
  legendSettingsBackdrop.classList.add('open');
}
function closeLegendSettings(panel){
  panel.classList.remove('open');
  if(!ALL_LEGEND_SETTINGS.some(p => p.classList.contains('open'))) legendSettingsBackdrop.classList.remove('open');
}
function toggleLegendSettings(panel){
  panel.classList.contains('open') ? closeLegendSettings(panel) : openLegendSettings(panel);
}
// legend-settings는 position:fixed로 화면 중앙에 띄우는데, 원래 위치인 .chart-legend가
// z-index로 별도 스태킹 컨텍스트를 만들어서 그 안에 있으면 z-index:1000을 줘도 소용없이
// body 바로 아래에 있는 backdrop(z-index:999)에 가려져 버린다. body의 바로 아래 자식으로 옮겨서 해결.
function registerLegendSettings(panel){
  document.body.appendChild(panel);
  ALL_LEGEND_SETTINGS.push(panel);
}
legendSettingsBackdrop.addEventListener('click', () => {
  ALL_LEGEND_SETTINGS.forEach(p => p.classList.remove('open'));
  legendSettingsBackdrop.classList.remove('open');
});

// ---------- 지표 범례 공통 배선 ----------
// 지표 5개(EMA밴드/BB/MA리본/RSI/MACD)가 전부 "눈 아이콘 = 임시 숨김, 톱니 = 설정창 열기,
// 휴지통 = 지표 끄기, 바깥 클릭 = 설정창 닫기"라는 똑같은 동작을 각자 30줄씩 복사해서 갖고
// 있었다(합쳐서 약 150줄 + document click 리스너 5개). 지표마다 실제로 다른 부분만 인자로
// 받는 팩토리 하나로 합쳤다. 새 지표를 추가할 때도 이 함수만 한 번 부르면 된다.
function setupLegend({ item, eye, gear, trash, settings, isOn, isHidden, setHidden, applyVisibility, turnOff }){
  const itemEl = $(item), eyeEl = $(eye), gearEl = $(gear), trashEl = $(trash), settingsEl = $(settings);
  registerLegendSettings(settingsEl);

  function render(){
    itemEl.style.display = isOn() ? 'flex' : 'none';
    itemEl.classList.toggle('hidden', isHidden());
    eyeEl.classList.toggle('active', !isHidden());
    if(!isOn()) closeLegendSettings(settingsEl);
  }
  eyeEl.onclick = (e) => {
    e.stopPropagation();
    setHidden(!isHidden());
    applyVisibility();
    render();
  };
  gearEl.onclick = (e) => { e.stopPropagation(); toggleLegendSettings(settingsEl); };
  trashEl.onclick = (e) => { e.stopPropagation(); closeLegendSettings(settingsEl); turnOff(); };
  onOutsideClick((e) => {
    if(settingsEl.classList.contains('open') && !settingsEl.contains(e.target) && e.target !== gearEl){
      closeLegendSettings(settingsEl);
    }
  });
  return { render };
}

// ---------- 캔들/거래량 표시 토글 ----------
// 다른 지표들과 달리 "지표" 목록에는 안 넣는다 — 끄고 켜는 대상이 아니라 항상 존재하는 메인
// 시리즈라서, 범례에도 항상 보이고(다른 지표처럼 켜야만 나타나는 게 아님) 눈 아이콘만 있다
// (설정/삭제 아이콘은 없음 — 지울 수 있는 게 아니므로). 시리즈 자체는 지우지 않고
// applyOptions({visible})만 토글하기 때문에 데이터/스크롤 위치 등 다른 상태에 영향이 없다.
function applyCandlesVisibility(){
  if(state.candleSeries) state.candleSeries.applyOptions({ visible: !state.candlesHidden });
}
function renderCandlesLegend(){
  $('legendCandles').classList.toggle('hidden', state.candlesHidden);
  $('legendCandlesEyeBtn').classList.toggle('active', !state.candlesHidden);
}
$('legendCandlesEyeBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  state.candlesHidden = !state.candlesHidden;
  applyCandlesVisibility();
  renderCandlesLegend();
});
renderCandlesLegend();

function applyVolumeVisibility(){
  if(state.volumeSeries) state.volumeSeries.applyOptions({ visible: !state.volumeHidden });
}
function renderVolumeLegend(){
  $('legendVolume').classList.toggle('hidden', state.volumeHidden);
  $('legendVolumeEyeBtn').classList.toggle('active', !state.volumeHidden);
}
$('legendVolumeEyeBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  state.volumeHidden = !state.volumeHidden;
  applyVolumeVisibility();
  renderVolumeLegend();
  updateVolumeAxisLabel(); // 숨기면 오른쪽 축 위의 거래량 뱃지도 바로 같이 사라지게
});
renderVolumeLegend();

const emaLegend = setupLegend({
  item: 'legendEmaBand', eye: 'legendEyeBtn', gear: 'legendGearBtn',
  trash: 'legendTrashBtn', settings: 'legendSettings',
  isOn: () => state.emaBandOn,
  isHidden: () => state.emaBandHidden,
  setHidden: (v) => { state.emaBandHidden = v; },
  applyVisibility: applyEmaVisibility,
  turnOff: () => setEmaBandOn(false),
});
function renderEmaLegend(){ emaLegend.render(); }

const EMA_LEGEND_LINES = [
  { key: 'max', checkbox: 'emaShowMax', color: 'emaColorMax' },
  { key: 'min', checkbox: 'emaShowMin', color: 'emaColorMin' },
  { key: 'avg', checkbox: 'emaShowAvg', color: 'emaColorAvg' },
  { key: 'avg2', checkbox: 'emaShowAvg2', color: 'emaColorAvg2' },
];
EMA_LEGEND_LINES.forEach(({ key, checkbox, color }) => {
  document.getElementById(checkbox).addEventListener('change', (e) => {
    state.emaBandLineVisible[key] = e.target.checked;
    applyEmaVisibility();
  });
  document.getElementById(color).addEventListener('input', (e) => {
    state.emaBandColors[key] = e.target.value;
    if(state.emaSeries) state.emaSeries[key].applyOptions({ color: e.target.value });
  });
});

// ---------- Bollinger Bands 범례 ----------
const bbLegend = setupLegend({
  item: 'legendBB', eye: 'legendBBEyeBtn', gear: 'legendBBGearBtn',
  trash: 'legendBBTrashBtn', settings: 'legendBBSettings',
  isOn: () => state.bbOn,
  isHidden: () => state.bbHidden,
  setHidden: (v) => { state.bbHidden = v; },
  applyVisibility: applyBBVisibility,
  turnOff: () => setBBOn(false),
});
function renderBBLegend(){ bbLegend.render(); }

document.getElementById('bbLength').addEventListener('change', (e) => {
  const v = Math.max(1, Math.round(parseFloat(e.target.value)) || 20);
  state.bbSettings.length = v;
  e.target.value = v;
  refreshBBFull();
});
document.getElementById('bbMaType').addEventListener('change', (e) => {
  state.bbSettings.maType = e.target.value;
  refreshBBFull();
});
document.getElementById('bbSource').addEventListener('change', (e) => {
  state.bbSettings.source = e.target.value;
  refreshBBFull();
});
document.getElementById('bbMult').addEventListener('change', (e) => {
  let v = parseFloat(e.target.value);
  if(!Number.isFinite(v)) v = 2.0;
  v = Math.min(50, Math.max(0.001, v));
  state.bbSettings.mult = v;
  e.target.value = v;
  refreshBBFull();
});

const BB_LEGEND_LINES = [
  { key: 'basis', checkbox: 'bbShowBasis', color: 'bbColorBasis' },
  { key: 'upper', checkbox: 'bbShowUpper', color: 'bbColorUpper' },
  { key: 'lower', checkbox: 'bbShowLower', color: 'bbColorLower' },
];
BB_LEGEND_LINES.forEach(({ key, checkbox, color }) => {
  document.getElementById(checkbox).addEventListener('change', (e) => {
    state.bbLineVisible[key] = e.target.checked;
    applyBBVisibility();
  });
  document.getElementById(color).addEventListener('input', (e) => {
    state.bbColors[key] = e.target.value;
    if(state.bbSeries) state.bbSeries[key].applyOptions({ color: e.target.value });
  });
});

// ---------- VWAP 범례 ----------
const vwapLegend = setupLegend({
  item: 'legendVwap', eye: 'legendVwapEyeBtn', gear: 'legendVwapGearBtn',
  trash: 'legendVwapTrashBtn', settings: 'legendVwapSettings',
  isOn: () => state.vwapOn,
  isHidden: () => state.vwapHidden,
  setHidden: (v) => { state.vwapHidden = v; },
  applyVisibility: applyVwapVisibility,
  turnOff: () => setVwapOn(false),
});
function renderVwapLegend(){ vwapLegend.render(); }

document.getElementById('vwapAnchor').addEventListener('change', (e) => {
  state.vwapSettings.anchor = e.target.value;
  refreshVwapFull();
});
document.getElementById('vwapSource').addEventListener('change', (e) => {
  state.vwapSettings.source = e.target.value;
  refreshVwapFull();
});
document.getElementById('vwapCalcMode').addEventListener('change', (e) => {
  state.vwapSettings.calcMode = e.target.value;
  refreshVwapFull();
});
document.getElementById('vwapShowLine').addEventListener('change', (e) => {
  state.vwapLineVisible.vwap = e.target.checked;
  applyVwapVisibility();
});
document.getElementById('vwapColorLine').addEventListener('input', (e) => {
  state.vwapColors.vwap = e.target.value;
  if(state.vwapSeries) state.vwapSeries.vwap.applyOptions({ color: e.target.value });
});
// 밴드 3개는 구조가 똑같아서(체크박스+배수+색) 컨테이너에 이벤트 위임 하나로 처리
const legendVwapSettingsEl = document.getElementById('legendVwapSettings');
legendVwapSettingsEl.addEventListener('change', (e) => {
  const band = e.target.dataset.band;
  if(!band || !state.vwapSettings.bands[band]) return;
  if(e.target.classList.contains('vwap-band-show')){
    state.vwapSettings.bands[band].show = e.target.checked;
    applyVwapVisibility();
  }else if(e.target.classList.contains('vwap-band-mult')){
    let v = parseFloat(e.target.value);
    if(!Number.isFinite(v) || v < 0) v = state.vwapSettings.bands[band].mult;
    state.vwapSettings.bands[band].mult = v;
    e.target.value = v;
    refreshVwapFull();
  }
});
legendVwapSettingsEl.addEventListener('input', (e) => {
  const band = e.target.dataset.band;
  if(!band || !e.target.classList.contains('vwap-band-color') || !state.vwapSettings.bands[band]) return;
  state.vwapColors['band' + band] = e.target.value;
  applyVwapVisibility();
});

// ---------- MA Ribbon 범례 ----------
const maRibbonLegend = setupLegend({
  item: 'legendMaRibbon', eye: 'legendMaRibbonEyeBtn', gear: 'legendMaRibbonGearBtn',
  trash: 'legendMaRibbonTrashBtn', settings: 'legendMaRibbonSettings',
  isOn: () => state.maRibbonOn,
  isHidden: () => state.maRibbonHidden,
  setHidden: (v) => { state.maRibbonHidden = v; },
  applyVisibility: applyMaRibbonVisibility,
  turnOff: () => setMaRibbonOn(false),
});
function renderMaRibbonLegend(){ maRibbonLegend.render(); }

// 라인 개수가 늘었다 줄었다 하므로 고정 id로 addEventListener를 걸 수 없다.
// 컨테이너에 innerHTML로 통째로 다시 그리고, 이벤트는 컨테이너에 한 번만(위임) 건다.
const maRibbonLinesContainer = document.getElementById('maRibbonLinesContainer');
const MA_RIBBON_TYPE_OPTIONS = ['SMA', 'EMA', 'SMMA (RMA)', 'WMA', 'VWMA'];
const MA_RIBBON_SOURCE_OPTIONS = ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4'];
function renderMaRibbonSettingsPanel(){
  const ids = maRibbonLineIds();
  maRibbonLinesContainer.innerHTML = ids.map((id, idx) => {
    const cfg = state.maRibbonSettings[id];
    const typeOpts = MA_RIBBON_TYPE_OPTIONS.map(o => `<option value="${o}"${cfg.type === o ? ' selected' : ''}>${o}</option>`).join('');
    const srcOpts = MA_RIBBON_SOURCE_OPTIONS.map(o => `<option value="${o}"${cfg.source === o ? ' selected' : ''}>${o}</option>`).join('');
    return `
      ${idx > 0 ? '<div class="legend-settings-divider"></div>' : ''}
      <div class="legend-settings-row">
        <div class="ma-ribbon-line-head">
          <label><input type="checkbox" data-role="show" data-id="${id}"${cfg.show ? ' checked' : ''}><span>MA #${id}</span></label>
          <input type="color" class="legend-color-dot" data-role="color" data-id="${id}" value="${cfg.color}">
          <button type="button" class="ma-ribbon-remove-btn" data-role="remove" data-id="${id}" title="${t('legendRemove')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z"/></svg>
          </button>
        </div>
      </div>
      <div class="legend-settings-row field">
        <span class="field-label">${t('maRibbonType')}</span>
        <select class="legend-select" data-role="type" data-id="${id}">${typeOpts}</select>
      </div>
      <div class="legend-settings-row field">
        <span class="field-label">${t('maRibbonSource')}</span>
        <select class="legend-select" data-role="source" data-id="${id}">${srcOpts}</select>
      </div>
      <div class="legend-settings-row field">
        <span class="field-label">${t('maRibbonLength')}</span>
        <input type="number" class="legend-number" data-role="length" data-id="${id}" min="1" step="1" value="${cfg.length}">
      </div>
    `;
  }).join('');
}
maRibbonLinesContainer.addEventListener('change', (e) => {
  const el = e.target;
  const { role, id } = el.dataset;
  const cfg = role && id ? state.maRibbonSettings[id] : null;
  if(!cfg) return;
  if(role === 'show'){
    cfg.show = el.checked;
    applyMaRibbonVisibility();
  }else if(role === 'type'){
    cfg.type = el.value;
    refreshMaRibbonFull();
  }else if(role === 'source'){
    cfg.source = el.value;
    refreshMaRibbonFull();
  }else if(role === 'length'){
    const v = Math.max(1, Math.round(parseFloat(el.value)) || cfg.length);
    cfg.length = v;
    el.value = v;
    refreshMaRibbonFull();
  }
});
maRibbonLinesContainer.addEventListener('input', (e) => {
  const el = e.target;
  const { role, id } = el.dataset;
  if(role !== 'color' || !id) return;
  const cfg = state.maRibbonSettings[id];
  if(!cfg) return;
  cfg.color = el.value;
  if(state.maRibbonSeries && state.maRibbonSeries[id]) state.maRibbonSeries[id].applyOptions({ color: el.value });
});
maRibbonLinesContainer.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-role="remove"]');
  if(!btn) return;
  e.stopPropagation();
  removeMaRibbonLine(btn.dataset.id);
});
document.getElementById('maRibbonAddLineBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  addMaRibbonLine();
});
renderMaRibbonSettingsPanel(); // 기본 4개 라인으로 초기 렌더

// ---------- RSI 범례 ----------
const rsiBBMultRow = $('rsiBBMultRow');
const rsiLegend = setupLegend({
  item: 'legendRSI', eye: 'legendRSIEyeBtn', gear: 'legendRSIGearBtn',
  trash: 'legendRSITrashBtn', settings: 'legendRSISettings',
  isOn: () => state.rsiOn,
  isHidden: () => state.rsiHidden,
  setHidden: (v) => { state.rsiHidden = v; },
  applyVisibility: applyRsiVisibility,
  turnOff: () => setRsiOn(false),
});
function renderRsiLegend(){ rsiLegend.render(); }

document.getElementById('rsiLength').addEventListener('change', (e) => {
  const v = Math.max(1, Math.round(parseFloat(e.target.value)) || 14);
  state.rsiSettings.length = v;
  e.target.value = v;
  refreshRsiFull();
});
document.getElementById('rsiSource').addEventListener('change', (e) => {
  state.rsiSettings.source = e.target.value;
  refreshRsiFull();
});
document.getElementById('rsiShowLine').addEventListener('change', (e) => {
  state.rsiLineVisible.rsi = e.target.checked;
  applyRsiVisibility();
});
document.getElementById('rsiColorLine').addEventListener('input', (e) => {
  state.rsiColors.rsi = e.target.value;
  if(state.rsiSeries) state.rsiSeries.rsi.applyOptions({ color: e.target.value });
});
document.getElementById('rsiMaType').addEventListener('change', (e) => {
  state.rsiSettings.maType = e.target.value;
  rsiBBMultRow.style.display = e.target.value === 'SMA + Bollinger Bands' ? 'flex' : 'none';
  refreshRsiFull();
});
document.getElementById('rsiMaLength').addEventListener('change', (e) => {
  const v = Math.max(1, Math.round(parseFloat(e.target.value)) || 14);
  state.rsiSettings.maLength = v;
  e.target.value = v;
  refreshRsiFull();
});
document.getElementById('rsiBBMult').addEventListener('change', (e) => {
  let v = parseFloat(e.target.value);
  if(!Number.isFinite(v)) v = 2.0;
  v = Math.min(50, Math.max(0.001, v));
  state.rsiSettings.bbMult = v;
  e.target.value = v;
  refreshRsiFull();
});
document.getElementById('rsiShowMa').addEventListener('change', (e) => {
  state.rsiLineVisible.ma = e.target.checked;
  applyRsiVisibility();
});
document.getElementById('rsiColorMa').addEventListener('input', (e) => {
  state.rsiColors.ma = e.target.value;
  if(state.rsiSeries && state.rsiSeries.ma) state.rsiSeries.ma.applyOptions({ color: e.target.value });
});
document.getElementById('rsiUpperOn').addEventListener('change', (e) => {
  state.rsiBandSettings.upperOn = e.target.checked;
  applyRsiBands();
});
document.getElementById('rsiUpperValue').addEventListener('change', (e) => {
  const v = parseFloat(e.target.value);
  if(Number.isFinite(v)) state.rsiBandSettings.upperValue = v;
  applyRsiBands();
});
document.getElementById('rsiMiddleOn').addEventListener('change', (e) => {
  state.rsiBandSettings.middleOn = e.target.checked;
  applyRsiBands();
});
document.getElementById('rsiMiddleValue').addEventListener('change', (e) => {
  const v = parseFloat(e.target.value);
  if(Number.isFinite(v)) state.rsiBandSettings.middleValue = v;
  applyRsiBands();
});
document.getElementById('rsiLowerOn').addEventListener('change', (e) => {
  state.rsiBandSettings.lowerOn = e.target.checked;
  applyRsiBands();
});
document.getElementById('rsiLowerValue').addEventListener('change', (e) => {
  const v = parseFloat(e.target.value);
  if(Number.isFinite(v)) state.rsiBandSettings.lowerValue = v;
  applyRsiBands();
});

// ---------- MACD 범례 ----------
const macdLegend = setupLegend({
  item: 'legendMACD', eye: 'legendMACDEyeBtn', gear: 'legendMACDGearBtn',
  trash: 'legendMACDTrashBtn', settings: 'legendMACDSettings',
  isOn: () => state.macdOn,
  isHidden: () => state.macdHidden,
  setHidden: (v) => { state.macdHidden = v; },
  applyVisibility: applyMacdVisibility,
  turnOff: () => setMacdOn(false),
});
function renderMacdLegend(){ macdLegend.render(); }

document.getElementById('macdSource').addEventListener('change', (e) => {
  state.macdSettings.source = e.target.value;
  refreshMacdFull();
});
document.getElementById('macdFastLen').addEventListener('change', (e) => {
  const v = Math.max(1, Math.round(parseFloat(e.target.value)) || 12);
  state.macdSettings.fastLen = v;
  e.target.value = v;
  refreshMacdFull();
});
document.getElementById('macdSlowLen').addEventListener('change', (e) => {
  const v = Math.max(1, Math.round(parseFloat(e.target.value)) || 26);
  state.macdSettings.slowLen = v;
  e.target.value = v;
  refreshMacdFull();
});
document.getElementById('macdSigLen').addEventListener('change', (e) => {
  const v = Math.max(1, Math.round(parseFloat(e.target.value)) || 9);
  state.macdSettings.sigLen = v;
  e.target.value = v;
  refreshMacdFull();
});
document.getElementById('macdOscType').addEventListener('change', (e) => {
  state.macdSettings.oscType = e.target.value;
  refreshMacdFull();
});
document.getElementById('macdSigType').addEventListener('change', (e) => {
  state.macdSettings.sigType = e.target.value;
  refreshMacdFull();
});
document.getElementById('macdShowMacd').addEventListener('change', (e) => {
  state.macdLineVisible.macd = e.target.checked;
  applyMacdVisibility();
});
document.getElementById('macdColorMacd').addEventListener('input', (e) => {
  state.macdColors.macd = e.target.value;
  if(state.macdSeries) state.macdSeries.macd.applyOptions({ color: e.target.value });
});
document.getElementById('macdShowSignal').addEventListener('change', (e) => {
  state.macdLineVisible.signal = e.target.checked;
  applyMacdVisibility();
});
document.getElementById('macdColorSignal').addEventListener('input', (e) => {
  state.macdColors.signal = e.target.value;
  if(state.macdSeries) state.macdSeries.signal.applyOptions({ color: e.target.value });
});
document.getElementById('macdShowHist').addEventListener('change', (e) => {
  state.macdLineVisible.hist = e.target.checked;
  applyMacdVisibility();
});

// ---------- 청산 히트맵 범례 ----------
const liqHeatmapLegend = setupLegend({
  item: 'legendLiqHeatmap', eye: 'legendLiqHeatmapEyeBtn', gear: 'legendLiqHeatmapGearBtn',
  trash: 'legendLiqHeatmapTrashBtn', settings: 'legendLiqHeatmapSettings',
  isOn: () => state.liqHeatmapOn,
  isHidden: () => state.liqHeatmapHidden,
  setHidden: (v) => { state.liqHeatmapHidden = v; },
  applyVisibility: applyLiqHeatmapVisibility,
  turnOff: () => setLiqHeatmapOn(false),
});
function renderLiqHeatmapLegend(){ liqHeatmapLegend.render(); }

document.getElementById('liqHeatmapLookback').addEventListener('change', (e) => {
  let v = Math.round(parseFloat(e.target.value));
  if(!Number.isFinite(v)) v = state.liqHeatmapSettings.lookbackDays;
  v = Math.min(60, Math.max(3, v));
  state.liqHeatmapSettings.lookbackDays = v;
  e.target.value = v;
  refreshLiqHeatmapFull();
});
document.getElementById('liqHeatmapHalfLife').addEventListener('change', (e) => {
  let v = Math.round(parseFloat(e.target.value));
  if(!Number.isFinite(v)) v = state.liqHeatmapSettings.halfLifeDays;
  v = Math.min(30, Math.max(1, v));
  state.liqHeatmapSettings.halfLifeDays = v;
  e.target.value = v;
  refreshLiqHeatmapFull();
});
document.getElementById('liqHeatmapOpacity').addEventListener('input', (e) => {
  let v = parseFloat(e.target.value);
  if(!Number.isFinite(v)) v = state.liqHeatmapSettings.opacity;
  state.liqHeatmapSettings.opacity = Math.min(1, Math.max(0.1, v));
  applyLiqHeatmapVisibility();
});
