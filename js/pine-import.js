/* pine-import.js
   PineScript 엔진(pine-engine/interpreter/builtins.js)을 실제 차트 UI에 연결하는 부분.
   스크립트를 실행해서 나온 plot()/hline() 결과를:
   - overlay=true 인 스크립트는 메인 캔들 차트 위에 라인으로 겹쳐 그리고
   - 그 외에는 RSI/MACD 패널과 같은 방식의 전용 하단 패널을 새로 만들어서 그린다. */

const pineToggleBtn = $('pineToggleBtn');
const pinePanel = $('pinePanel');
const pineSourceInput = $('pineSourceInput');
const pineNameInput = $('pineNameInput');
const pineRunBtn = $('pineRunBtn');
const pineErrorBox = $('pineErrorBox');
const pineScriptsListEl = $('pineScriptsList');
const pineCustomPanesEl = $('pineCustomPanes');

let pineEditingId = null; // 지금 텍스트영역에 있는 내용이 기존 저장된 스크립트를 편집 중인 것이면 그 id

function genPineId(){ return 'pine_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function persistPineScripts(){
  store.set('pine_scripts', state.pineScripts.map(s => ({ id: s.id, name: s.name, source: s.source, enabled: s.enabled, inputOverrides: s.inputOverrides || {}, plotOverrides: s.plotOverrides || {} })));
}

// ---------- 패널 토글 ----------
function togglePinePanel(){
  state.pineOpen = !state.pineOpen;
  pinePanel.style.display = state.pineOpen ? 'flex' : 'none';
  pineToggleBtn.classList.toggle('on', state.pineOpen);
  store.set('pine_open', state.pineOpen);
}
pineToggleBtn.addEventListener('click', togglePinePanel);
if(state.pineOpen){ pinePanel.style.display = 'flex'; pineToggleBtn.classList.add('on'); }

// ---------- 실행 + 저장 ----------
function showPineError(err){
  pineErrorBox.style.display = 'block';
  pineErrorBox.textContent = (err.line ? ('Line ' + err.line + ': ') : '') + err.message;
}
function clearPineError(){ pineErrorBox.style.display = 'none'; pineErrorBox.textContent = ''; }

pineRunBtn.addEventListener('click', () => {
  const source = pineSourceInput.value;
  if(!source.trim()) return;
  const name = pineNameInput.value.trim() || t('pineUntitled');
  const bars = state.currentBars || [];
  clearPineError();
  let result;
  try{ result = runPineScript(source, bars, pineEditingId ? (findPineScript(pineEditingId) || {}).inputOverrides || {} : {}); }
  catch(err){ showPineError(err); return; }

  let script;
  if(pineEditingId && findPineScript(pineEditingId)){
    script = findPineScript(pineEditingId);
    script.name = name; script.source = source; script.enabled = true;
  } else {
    script = { id: genPineId(), name, source, enabled: true, inputOverrides: {}, plotOverrides: {} };
    state.pineScripts.push(script);
    pineEditingId = script.id;
  }
  persistPineScripts();
  activatePineScript(script, result);
  renderPineScriptsList();
});

function findPineScript(id){ return state.pineScripts.find(s => s.id === id); }

// ---------- 스타일(라인 표시/색상) + 입력값 설정창 — 다른 지표들처럼 톱니바퀴를 누르면 화면 중앙 모달로 뜬다 ----------
function pineColorToHex(c){
  if(typeof c !== 'string') return '#787b86';
  if(c[0] === '#') return c.slice(0, 7);
  const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if(m) return '#' + [1, 2, 3].map(i => (+m[i]).toString(16).padStart(2, '0')).join('');
  return '#787b86';
}
function applyPlotStyleOverrides(script){
  const active = state.pineActive.get(script.id);
  if(!active) return;
  const overrides = script.plotOverrides || {};
  const allLines = active.overlayLines.concat(active.pane ? active.pane.plotLines : []);
  allLines.forEach(line => {
    const ov = overrides[line._pineKey];
    line.applyOptions({ visible: !(ov && ov.visible === false), color: (ov && ov.color) || line._pineBaseColor });
  });
}
function buildPineSettingsPanel(script, result){
  script.plotOverrides = script.plotOverrides || {};
  const panel = document.createElement('div');
  panel.className = 'legend-settings';
  const title = document.createElement('div');
  title.className = 'legend-settings-title';
  title.textContent = script.name;
  panel.appendChild(title);

  if(result.plots.length){
    const styleLabel = document.createElement('div');
    styleLabel.className = 'legend-settings-title';
    styleLabel.textContent = t('pineStyleSection');
    panel.appendChild(styleLabel);
    result.plots.forEach(p => {
      const ov = script.plotOverrides[p.key] || {};
      const row = document.createElement('div'); row.className = 'legend-settings-row';
      const label = document.createElement('label');
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = ov.visible !== false;
      cb.addEventListener('change', () => {
        script.plotOverrides[p.key] = Object.assign({}, script.plotOverrides[p.key], { visible: cb.checked });
        persistPineScripts(); applyPlotStyleOverrides(script);
      });
      const span = document.createElement('span'); span.textContent = p.title;
      label.appendChild(cb); label.appendChild(span);
      row.appendChild(label);
      const colorInput = document.createElement('input'); colorInput.type = 'color'; colorInput.className = 'legend-color-dot';
      colorInput.value = pineColorToHex(ov.color || p.color);
      colorInput.addEventListener('input', () => {
        script.plotOverrides[p.key] = Object.assign({}, script.plotOverrides[p.key], { color: colorInput.value });
        persistPineScripts(); applyPlotStyleOverrides(script);
      });
      row.appendChild(colorInput);
      panel.appendChild(row);
    });
  }

  const editable = (result.inputs || []).filter(i => ['int', 'float', 'bool', 'string'].includes(i.kind));
  if(result.plots.length && editable.length) panel.appendChild(Object.assign(document.createElement('div'), { className: 'legend-settings-divider' }));
  if(editable.length){
    const inputsLabel = document.createElement('div');
    inputsLabel.className = 'legend-settings-title';
    inputsLabel.textContent = t('pineInputsSection');
    panel.appendChild(inputsLabel);
  }
  editable.forEach(inp => {
    const current = script.inputOverrides.hasOwnProperty(inp.id) ? script.inputOverrides[inp.id] : inp.defval;
    if(inp.kind === 'bool'){
      const row = document.createElement('div'); row.className = 'legend-settings-row';
      const label = document.createElement('label');
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!current;
      cb.addEventListener('change', () => rerunWithOverride(script, inp.id, cb.checked));
      const span = document.createElement('span'); span.textContent = inp.title;
      label.appendChild(cb); label.appendChild(span);
      row.appendChild(label);
      panel.appendChild(row);
      return;
    }
    const row = document.createElement('div'); row.className = 'legend-settings-row field';
    const lab = document.createElement('span'); lab.className = 'field-label'; lab.textContent = inp.title;
    row.appendChild(lab);
    if(inp.kind === 'string' && inp.options && inp.options.length){
      const sel = document.createElement('select'); sel.className = 'legend-select';
      inp.options.forEach(opt => {
        const o = document.createElement('option'); o.value = opt; o.textContent = opt;
        if(opt === current) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('change', () => rerunWithOverride(script, inp.id, sel.value));
      row.appendChild(sel);
    } else if(inp.kind === 'string'){
      const inputEl = document.createElement('input'); inputEl.className = 'legend-number'; inputEl.type = 'text';
      inputEl.value = current == null ? '' : current;
      inputEl.addEventListener('change', () => rerunWithOverride(script, inp.id, inputEl.value));
      row.appendChild(inputEl);
    } else {
      const inputEl = document.createElement('input'); inputEl.className = 'legend-number'; inputEl.type = 'number';
      if(inp.step != null) inputEl.step = inp.step; else if(inp.kind === 'int') inputEl.step = 1; else inputEl.step = 'any';
      if(inp.minval != null) inputEl.min = inp.minval;
      if(inp.maxval != null) inputEl.max = inp.maxval;
      inputEl.value = current == null ? '' : current;
      inputEl.addEventListener('change', () => rerunWithOverride(script, inp.id, inp.kind === 'int' ? Math.round(parseFloat(inputEl.value)) : parseFloat(inputEl.value)));
      row.appendChild(inputEl);
    }
    panel.appendChild(row);
  });
  if(!result.plots.length && !editable.length){
    const empty = document.createElement('div');
    empty.className = 'legend-settings-row';
    empty.style.color = 'var(--text-dim)'; empty.style.fontSize = '11px';
    empty.textContent = t('pineNoInputs');
    panel.appendChild(empty);
  }
  return panel;
}

function rerunWithOverride(script, inputId, value){
  script.inputOverrides = script.inputOverrides || {};
  script.inputOverrides[inputId] = value;
  persistPineScripts();
  if(!script.enabled) return;
  const bars = state.currentBars || [];
  clearPineError();
  let result;
  try{ result = runPineScript(script.source, bars, script.inputOverrides); }
  catch(err){ showPineError(err); deactivatePineScript(script.id); renderPineScriptsList(); return; }
  activatePineScript(script, result);
}

function togglePineScriptEnabled(s){
  s.enabled = !s.enabled;
  persistPineScripts();
  if(s.enabled){
    const bars = state.currentBars || [];
    try{ const result = runPineScript(s.source, bars, s.inputOverrides || {}); s.lastError = null; activatePineScript(s, result); }
    catch(err){ s.lastError = err.message; s.enabled = false; persistPineScripts(); deactivatePineScript(s.id); }
  } else {
    deactivatePineScript(s.id);
  }
  renderPineScriptsList();
}
function deletePineScriptById(id){
  deactivatePineScript(id);
  state.pineScripts = state.pineScripts.filter(x => x.id !== id);
  persistPineScripts();
  if(pineEditingId === id){ pineEditingId = null; pineSourceInput.value = ''; pineNameInput.value = ''; }
  renderPineScriptsList();
}

// ---------- 저장된 스크립트 목록 ----------
function renderPineScriptsList(){
  pineScriptsListEl.innerHTML = '';
  state.pineScripts.forEach(s => {
    const row = document.createElement('div');
    row.className = 'pine-script-row' + (s.lastError ? ' error' : '');
    const name = document.createElement('span');
    name.className = 'pine-script-name';
    name.textContent = s.name + (s.lastError ? ' ⚠' : '');
    name.title = s.lastError ? s.lastError : t('pineEditHint');
    name.addEventListener('click', () => {
      pineEditingId = s.id;
      pineSourceInput.value = s.source;
      pineNameInput.value = s.name;
      clearPineError();
    });
    row.appendChild(name);

    const eyeBtn = document.createElement('button');
    eyeBtn.className = 'pine-script-icon' + (s.enabled ? ' active' : '');
    eyeBtn.title = t('legendToggleVisible');
    eyeBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
    eyeBtn.addEventListener('click', () => togglePineScriptEnabled(s));
    row.appendChild(eyeBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'pine-script-icon';
    delBtn.title = t('legendRemove');
    delBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z"/></svg>';
    delBtn.addEventListener('click', () => deletePineScriptById(s.id));
    row.appendChild(delBtn);

    pineScriptsListEl.appendChild(row);
  });
}

// ---------- 메인 차트 좌상단 범례에 다는 항목 (Candles/Volume과 같은 자리) — overlay 스크립트, 전용 패널 스크립트 둘 다 사용 ----------
function createLegendIcons(s){
  const icons = document.createElement('span');
  icons.className = 'legend-icons';
  const eyeBtn = document.createElement('button');
  eyeBtn.className = 'legend-icon active';
  eyeBtn.title = t('legendToggleVisible');
  eyeBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
  eyeBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePineScriptEnabled(s); });
  const gearBtn = document.createElement('button');
  gearBtn.className = 'legend-icon';
  gearBtn.title = t('legendSettings');
  gearBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
  gearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const active = state.pineActive.get(s.id);
    if(active && active.settingsPanel) toggleLegendSettings(active.settingsPanel);
  });
  const delBtn = document.createElement('button');
  delBtn.className = 'legend-icon';
  delBtn.title = t('legendRemove');
  delBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z"/></svg>';
  delBtn.addEventListener('click', (e) => { e.stopPropagation(); deletePineScriptById(s.id); });
  icons.appendChild(eyeBtn); icons.appendChild(gearBtn); icons.appendChild(delBtn);
  return icons;
}
function createChartLegendItem(s){
  const item = document.createElement('div');
  item.className = 'legend-item';
  const nameEl = document.createElement('span');
  nameEl.className = 'legend-name';
  nameEl.textContent = s.name;
  item.appendChild(nameEl);
  item.appendChild(createLegendIcons(s));
  return item;
}

// ---------- 차트에 실제로 그리기 ----------
function barPoints(bars, values, offset){
  const off = offset || 0;
  const pts = [];
  for(let i = 0; i < bars.length; i++){
    if(values[i] == null || !Number.isFinite(values[i])) continue;
    const targetIdx = i + off;
    if(targetIdx < 0 || targetIdx >= bars.length) continue;
    pts.push({ time: bars[targetIdx].time, value: values[i] });
  }
  return pts;
}

function activatePineScript(script, result){
  const prevActive = state.pineActive.get(script.id);
  const wasSettingsOpen = !!(prevActive && prevActive.settingsPanel && prevActive.settingsPanel.classList.contains('open'));
  deactivatePineScript(script.id); // 항상 지우고 새로 그린다 (증분 업데이트보다 훨씬 단순하고 안전함)
  script.lastError = null;
  const bars = state.currentBars || [];
  const active = { overlayLines: [], overlayPriceLines: [], pane: null, legendEl: null, settingsPanel: null };
  if(result.meta.overlay){
    result.plots.forEach(p => {
      const ov = (script.plotOverrides || {})[p.key] || {};
      const line = state.chart.addLineSeries({
        color: ov.color || p.color, lineWidth: Math.max(1, Math.min(4, Math.round(p.linewidth || 1))),
        priceScaleId: 'right', lastValueVisible: true, priceLineVisible: false, crosshairMarkerVisible: false,
        visible: ov.visible !== false,
        title: script.name + ' · ' + p.title,
      });
      line._pineKey = p.key; line._pineBaseColor = p.color;
      line.setData(barPoints(bars, p.values, p.offset));
      active.overlayLines.push(line);
    });
    result.hlines.forEach(h => {
      if(h.price == null || !Number.isFinite(h.price)) return;
      const pl = state.candleSeries.createPriceLine({ price: h.price, color: h.color, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: script.name + ' · ' + h.title });
      active.overlayPriceLines.push(pl);
    });
    active.legendEl = createChartLegendItem(script);
    $('chartLegend').appendChild(active.legendEl);
    active.drawObjects = { lines: result.lines || [], boxes: result.boxes || [], labels: result.labels || [] };
    pineDrawRevision++;
  } else {
    const pane = createPinePane(script.id, script.name);
    pane.legendItem.appendChild(createLegendIcons(script));
    result.plots.forEach(p => {
      const ov = (script.plotOverrides || {})[p.key] || {};
      const line = pane.chart.addLineSeries({
        color: ov.color || p.color, lineWidth: Math.max(1, Math.min(4, Math.round(p.linewidth || 1))),
        priceScaleId: 'right', lastValueVisible: true, priceLineVisible: false, crosshairMarkerVisible: false,
        visible: ov.visible !== false,
      });
      line._pineKey = p.key; line._pineBaseColor = p.color;
      line.setData(barPoints(bars, p.values, p.offset));
      pane.plotLines.push(line);
    });
    result.hlines.forEach(h => {
      if(h.price == null || !Number.isFinite(h.price)) return;
      const anySeries = pane.chart.addLineSeries({ visible: false });
      pane.helperSeries.push(anySeries);
      anySeries.createPriceLine({ price: h.price, color: h.color, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: h.title });
    });
    const initRange = state.chart.timeScale().getVisibleLogicalRange();
    if(initRange) pane.chart.timeScale().setVisibleLogicalRange(initRange);
    active.pane = pane;
  }
  active.settingsPanel = buildPineSettingsPanel(script, result);
  registerLegendSettings(active.settingsPanel);
  if(wasSettingsOpen) openLegendSettings(active.settingsPanel); // 입력값 바꿔서 다시 실행된 경우 설정창이 닫히지 않게 유지
  state.pineActive.set(script.id, active);
}

function deactivatePineScript(id){
  const active = state.pineActive.get(id);
  if(!active) return;
  active.overlayLines.forEach(l => { try{ state.chart.removeSeries(l); }catch(e){} });
  active.overlayPriceLines.forEach(pl => { try{ state.candleSeries.removePriceLine(pl); }catch(e){} });
  if(active.legendEl && active.legendEl.parentNode) active.legendEl.parentNode.removeChild(active.legendEl);
  if(active.settingsPanel){
    closeLegendSettings(active.settingsPanel);
    const idx = ALL_LEGEND_SETTINGS.indexOf(active.settingsPanel);
    if(idx > -1) ALL_LEGEND_SETTINGS.splice(idx, 1);
    if(active.settingsPanel.parentNode) active.settingsPanel.parentNode.removeChild(active.settingsPanel);
  }
  if(active.pane) destroyPinePane(active.pane);
  state.pineActive.delete(id);
  pineDrawRevision++;
}

// 모든 저장된(활성화된) 스크립트를 새 봉 데이터 기준으로 다시 실행 — 코인/차트유형/기간이 바뀔 때 호출됨
function refreshAllPineScripts(){
  const bars = state.currentBars || [];
  if(!bars.length) return;
  state.pineScripts.forEach(s => {
    if(!s.enabled) return;
    try{ const result = runPineScript(s.source, bars, s.inputOverrides || {}); s.lastError = null; activatePineScript(s, result); }
    catch(err){ s.lastError = err.message; deactivatePineScript(s.id); }
  });
  renderPineScriptsList();
}

// ---------- 동적 전용 패널 (RSI/MACD 패널과 같은 구조를 매 스크립트마다 새로 만든다) ----------
function createPinePane(id, title){
  const domId = 'pinePane_' + id;
  const wrap = document.createElement('div');
  wrap.className = 'rsi-pane pine-pane';
  wrap.id = domId;
  const handleId = domId + '_handle';
  wrap.innerHTML =
    `<div class="rsi-resize-handle" id="${handleId}"></div>` +
    `<div class="pine-pane-chart"></div>` +
    `<div class="chart-legend pine-pane-legend"><div class="legend-item"><span class="legend-name"></span></div></div>`;
  wrap.querySelector('.legend-name').textContent = title;
  pineCustomPanesEl.appendChild(wrap);
  const chartEl = wrap.querySelector('.pine-pane-chart');
  setupPaneResize(handleId, wrap);

  const chart = LightweightCharts.createChart(chartEl, {
    layout: { background: { color: '#0a0d12' }, textColor: '#6b7686', fontFamily: "'JetBrains Mono', monospace", fontSize: 11 },
    grid: { vertLines: { color: '#151a22' }, horzLines: { color: '#151a22' } },
    rightPriceScale: { borderColor: '#212833', visible: true, autoScale: true },
    leftPriceScale: { visible: false },
    timeScale: { borderColor: '#212833', timeVisible: true, secondsVisible: true, tickMarkFormatter: localTickMarkFormatter },
    localization: { timeFormatter: localTimeFormatter },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    handleScroll: { vertTouchDrag: true, mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true },
    handleScale: { axisPressedMouseMove: { time: true, price: true }, mouseWheel: true, pinch: true },
  });
  let syncGuard = false;
  function followMain(range){ if(syncGuard || !range) return; syncGuard = true; chart.timeScale().setVisibleLogicalRange(range); syncGuard = false; }
  function mainFollow(range){ if(syncGuard || !range || !state.chart) return; syncGuard = true; state.chart.timeScale().setVisibleLogicalRange(range); syncGuard = false; }
  state.chart.timeScale().subscribeVisibleLogicalRangeChange(followMain);
  chart.timeScale().subscribeVisibleLogicalRangeChange(mainFollow);
  const resizeObs = new ResizeObserver(entries => {
    const { width, height } = entries[0].contentRect;
    chart.resize(width, height);
  });
  resizeObs.observe(chartEl);
  return { id, wrap, chart, chartEl, followMain, resizeObs, helperSeries: [], plotLines: [], legendItem: wrap.querySelector('.legend-item') };
}
function destroyPinePane(pane){
  try{ state.chart.timeScale().unsubscribeVisibleLogicalRangeChange(pane.followMain); }catch(e){}
  try{ pane.resizeObs.disconnect(); }catch(e){}
  try{ pane.chart.remove(); }catch(e){}
  if(pane.wrap && pane.wrap.parentNode) pane.wrap.parentNode.removeChild(pane.wrap);
}

// ---------- Pine 그리기 객체(line.new/box.new/label.new) 렌더링 ----------
// lightweight-charts엔 "임의의 시간~시간, 가격~가격 사이에 도형을 그려라" 같은 기능이 없어서,
// 이 앱에 이미 있는 사용자 드로잉 도구용 캔버스 오버레이(drawings.js의 #drawOverlay)에 얹어서 그린다.
// overlay=true 인 스크립트만 지원한다 (전용 패널 스크립트는 좌표계가 달라 범위 밖).
let pineDrawRevision = 0;
function pineDrawRevisionValue(){ return pineDrawRevision; }
function pineHasActiveDrawings(){
  for(const active of state.pineActive.values()){
    if(active.drawObjects && (active.drawObjects.lines.length || active.drawObjects.boxes.length || active.drawObjects.labels.length)) return true;
  }
  return false;
}
function drawAllPineOverlayObjects(){
  if(!state.chart || !state.candleSeries) return;
  state.pineActive.forEach(active => {
    if(!active.drawObjects) return;
    drawPineLines(active.drawObjects.lines);
    drawPineBoxes(active.drawObjects.boxes);
    drawPineLabels(active.drawObjects.labels);
  });
}
function pineExtendPoints(p1, p2, extend){
  if(!extend || extend === 'none') return [p1, p2];
  const leftEdge = leftScaleOffset();
  const rightEdge = overlayW - rightScaleOffset();
  let a = p1, b = p2;
  const swapped = a.x > b.x;
  if(swapped){ const t = a; a = b; b = t; }
  const dx = b.x - a.x;
  if(extend === 'right' || extend === 'both'){
    b = Math.abs(dx) > 0.001 ? { x: rightEdge, y: a.y + ((rightEdge - a.x) / dx) * (b.y - a.y) } : { x: rightEdge, y: b.y };
  }
  if(extend === 'left' || extend === 'both'){
    a = Math.abs(dx) > 0.001 ? { x: leftEdge, y: a.y + ((leftEdge - a.x) / dx) * (b.y - a.y) } : { x: leftEdge, y: a.y };
  }
  return swapped ? [b, a] : [a, b];
}
function drawPineLines(lines){
  const ctx = drawOverlayCtx;
  lines.forEach(l => {
    if(l.deleted) return;
    let p1 = drawPointToCanvasPixel({ time: l.x1, price: l.y1 });
    let p2 = drawPointToCanvasPixel({ time: l.x2, price: l.y2 });
    if(!p1 || !p2) return;
    [p1, p2] = pineExtendPoints(p1, p2, l.extend);
    ctx.save();
    ctx.strokeStyle = l.color || '#787b86';
    ctx.lineWidth = l.width || 1;
    ctx.setLineDash(l.style === 'dashed' ? [6, 4] : l.style === 'dotted' ? [1.5, 3] : []);
    ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
    ctx.restore();
  });
}
function drawPineBoxes(boxes){
  const ctx = drawOverlayCtx;
  const leftEdge = leftScaleOffset();
  const rightEdge = overlayW - rightScaleOffset();
  boxes.forEach(b => {
    if(b.deleted) return;
    let p1 = drawPointToCanvasPixel({ time: b.x1, price: b.y1 });
    let p2 = drawPointToCanvasPixel({ time: b.x2, price: b.y2 });
    if(!p1 || !p2) return;
    if(b.extend === 'right' || b.extend === 'both'){ if(p2.x >= p1.x) p2 = { x: rightEdge, y: p2.y }; else p1 = { x: rightEdge, y: p1.y }; }
    if(b.extend === 'left' || b.extend === 'both'){ if(p1.x <= p2.x) p1 = { x: leftEdge, y: p1.y }; else p2 = { x: leftEdge, y: p2.y }; }
    const x = Math.min(p1.x, p2.x), y = Math.min(p1.y, p2.y), w = Math.abs(p2.x - p1.x), h = Math.abs(p2.y - p1.y);
    ctx.save();
    if(b.bgcolor){ ctx.fillStyle = b.bgcolor; ctx.fillRect(x, y, w, h); }
    if(b.bordercolor){ ctx.strokeStyle = b.bordercolor; ctx.lineWidth = 1; ctx.strokeRect(x, y, w, h); }
    if(b.text){ ctx.font = '10px JetBrains Mono, monospace'; ctx.fillStyle = b.textcolor || '#ffffff'; ctx.fillText(b.text, x + 4, y + 12); }
    ctx.restore();
  });
}
function drawPineLabels(labels){
  const ctx = drawOverlayCtx;
  labels.forEach(lb => {
    if(lb.deleted) return;
    const p = drawPointToCanvasPixel({ time: lb.x, price: lb.y });
    if(!p) return;
    ctx.save();
    ctx.font = '10px JetBrains Mono, monospace';
    const text = String(lb.text || '');
    const tw = ctx.measureText(text).width;
    const padX = 5, boxW = tw + padX * 2, boxH = 15;
    const bx = p.x - boxW / 2;
    const by = lb.style === 'label_up' ? p.y + 6 : p.y - boxH - 6;
    ctx.fillStyle = lb.color || 'rgba(30,34,42,0.9)';
    ctx.fillRect(bx, by, boxW, boxH);
    ctx.fillStyle = lb.textcolor || '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, bx + padX, by + boxH / 2);
    ctx.restore();
  });
}

// ---------- 시작 시 저장된 스크립트 복원 ----------
renderPineScriptsList();
