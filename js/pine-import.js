/* pine-import.js
   PineScript 엔진(pine-engine/interpreter/builtins.js)을 실제 차트 UI에 연결하는 부분.
   스크립트를 실행해서 나온 plot()/hline() 결과를:
   - overlay=true 인 스크립트는 메인 캔들 차트 위에 라인으로 겹쳐 그리고
   - 그 외에는 RSI/MACD 패널과 같은 방식의 전용 하단 패널을 새로 만들어서 그린다. */

const pineToggleBtn = $('pineToggleBtn');
const pinePanel = $('pinePanel');
const pineSourceInput = $('pineSourceInput');
const pineNameInput = $('pineNameInput');
const pineVersionSelect = $('pineVersionSelect');
const pineVersionAutoOption = $('pineVersionAutoOption');
const pineRunBtn = $('pineRunBtn');
const pineClearBtn = $('pineClearBtn');
const pineErrorBox = $('pineErrorBox');
const pineScriptsListEl = $('pineScriptsList');
const pineCustomPanesEl = $('pineCustomPanes');

let pineEditingId = null; // 지금 텍스트영역에 있는 내용이 기존 저장된 스크립트를 편집 중인 것이면 그 id

function genPineId(){ return 'pine_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function persistPineScripts(){
  store.set('pine_scripts', state.pineScripts.map(s => ({ id: s.id, name: s.name, source: s.source, enabled: s.enabled, hidden: !!s.hidden, inputOverrides: s.inputOverrides || {}, plotOverrides: s.plotOverrides || {}, pineVersion: s.pineVersion || null, pineVersionMode: s.pineVersionMode || 'auto' })));
}

// ---------- 버전 선택 (표시/저장 용도 — 실제 파싱은 버전과 무관하게 항상 permissive) ----------
// 실제 TradingView처럼 //@version=N 이 있으면 그걸 쓰고, 없는 옛날 스크립트는 사용자가 직접 골라서
// 표시해둘 수 있게 한다. 인터프리터 동작 자체는 어떤 버전을 골라도 바뀌지 않는다(pine-interpreter.js가
// 이미 구/신 문법을 이름 충돌 없이 동시에 지원하기 때문).
function detectPineVersionTag(source){
  const m = String(source || '').match(/\/\/\s*@version\s*=\s*(\d+)/);
  return m ? m[1] : null;
}
function refreshPineVersionAutoOption(){
  const detected = detectPineVersionTag(pineSourceInput.value);
  pineVersionAutoOption.textContent = detected ? t('pineVersionAutoDetected', detected) : t('pineVersionAutoUnknown');
}
pineSourceInput.addEventListener('input', refreshPineVersionAutoOption);
refreshPineVersionAutoOption();

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

pineClearBtn.addEventListener('click', () => {
  pineSourceInput.value = '';
  pineNameInput.value = '';
  pineVersionSelect.value = 'auto';
  refreshPineVersionAutoOption();
  pineEditingId = null; // 다음 '실행 & 저장'은 기존 스크립트를 덮어쓰지 않고 새 스크립트로 만든다
  clearPineError();
  pineSourceInput.focus();
});

pineRunBtn.addEventListener('click', async () => {
  const source = pineSourceInput.value;
  if(!source.trim()) return;
  const name = pineNameInput.value.trim() || t('pineUntitled');
  const versionMode = pineVersionSelect.value;
  const pineVersion = versionMode === 'auto' ? detectPineVersionTag(source) : versionMode;
  const bars = state.currentBars || [];
  clearPineError();
  let result;
  try{ result = await runPineScript(source, bars, pineEditingId ? (findPineScript(pineEditingId) || {}).inputOverrides || {} : {}); }
  catch(err){ showPineError(err); return; }

  let script;
  if(pineEditingId && findPineScript(pineEditingId)){
    script = findPineScript(pineEditingId);
    script.name = name; script.source = source; script.enabled = true;
  } else {
    script = { id: genPineId(), name, source, enabled: true, hidden: false, inputOverrides: {}, plotOverrides: {} };
    state.pineScripts.push(script);
    pineEditingId = script.id;
  }
  script.pineVersion = pineVersion;
  script.pineVersionMode = versionMode;
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
// plot 시리즈를 전부 지우고 현재 결과/오버라이드 기준으로 다시 만든다.
// 스타일 오버라이드 변경(applyPlotStyleOverrides)과 새 봉 소프트 갱신(softUpdatePineScript)이
// 완전히 같은 15줄을 각자 갖고 있어서 하나로 합쳤다. 만들어진 점 마커 목록을 돌려준다.
function rebuildPinePlotSeries(script, active, plots){
  const bars = state.currentBars || [];
  const chartObj = active.pane ? active.pane.chart : state.chart;
  const linesArr = (active.pane ? active.pane.plotLines : active.overlayLines) || [];
  const overrides = script.plotOverrides || {};
  const newLinesArr = [];
  plots.forEach(p => {
    linesArr.filter(l => l._pineKey === p.key).forEach(l => { try{ chartObj.removeSeries(l); }catch(e){} });
    newLinesArr.push(...createPlotSeries(chartObj, p, overrides[p.key] || {}, bars, script.hidden));
  });
  if(active.pane) active.pane.plotLines = newLinesArr; else active.overlayLines = newLinesArr;
  return newLinesArr.reduce((acc, l) => l._pineCrossMarkers ? acc.concat(l._pineCrossMarkers) : acc, []);
}
function applyPlotStyleOverrides(script){
  const active = state.pineActive.get(script.id);
  if(!active || !active.lastResult) return;
  const bars = state.currentBars || [];
  const crossMarkers = rebuildPinePlotSeries(script, active, active.lastResult.plots);
  if(active.pane){
    if(crossMarkers.length) getPaneAnchor(active.pane, bars); // hline() 없이도 점 마커 좌표 변환용 anchor 보장
    active.pane.crossMarkers = crossMarkers; active.pane.renderCrossMarkers();
  }
  else { active.drawObjects = Object.assign({}, active.drawObjects, { crossMarkers }); pineDrawRevision++; }
  renderPineTables(script, active, active.lastResult.tables); // 눈 아이콘(숨김) 상태를 표에도 반영
  syncPineBarColors();                                        // 봉 색도 같이 (숨기면 원래 색으로)
  updatePineLegendHiddenState(script);
}
// 눈 아이콘 = 순수 화면 표시/숨김(계산은 계속 진행, 라벨도 그대로 남음) — 다른 내장 지표들과 동일한 방식.
// 완전히 멈추고 싶으면(계산도 중단) 사이드패널 목록의 켜기/끄기를 쓰면 된다.
function updatePineLegendHiddenState(script){
  const active = state.pineActive.get(script.id);
  if(!active) return;
  const itemEl = active.legendEl || (active.pane && active.pane.legendItem);
  if(itemEl){
    itemEl.classList.toggle('hidden', !!script.hidden);
    if(itemEl._eyeBtn) itemEl._eyeBtn.classList.toggle('active', !script.hidden);
  }
  pineDrawRevision++; // overlay line/box/label 그리기 객체 표시 여부가 바뀌었을 수 있으니 다시 그리게 한다
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
      // bcolor/scolor 처럼 조건에 따라 색이 여러 개로 갈리는 플롯(histogram/cross)은, 실제로 쓰인
      // 색 종류별로 스와치를 따로 보여줘서 각각 편집 가능하게 한다 — TradingView의 "칼라 0/1/2..."와 같은 방식.
      const branchSrc = (p.style === 'histogram' || p.style === 'cross') ? (p.branchKeys || p.colors || []) : [];
      const uniqueKeys = [...new Set(branchSrc.filter(Boolean))];
      if(uniqueKeys.length > 1){
        const swWrap = document.createElement('span'); swWrap.style.cssText = 'display:flex; gap:3px; flex-wrap:wrap; justify-content:flex-end;';
        uniqueKeys.forEach((bkey, idx) => {
          // 이 분기가 실제로 낸 색(대표값) — 겹치는 색이어도 분기별로 따로 편집 가능
          const repIdx = branchSrc.indexOf(bkey);
          const repColor = (p.colors && p.colors[repIdx]) || p.color;
          const colorInput = document.createElement('input'); colorInput.type = 'color'; colorInput.className = 'legend-color-dot';
          colorInput.title = 'Color ' + idx;
          const cm = ov.colorMap || {};
          colorInput.value = pineColorToHex(cm[bkey] !== undefined ? cm[bkey] : repColor);
          colorInput.addEventListener('input', () => {
            const prevOv = script.plotOverrides[p.key] || {};
            const newColorMap = Object.assign({}, prevOv.colorMap, { [bkey]: colorInput.value });
            script.plotOverrides[p.key] = Object.assign({}, prevOv, { colorMap: newColorMap });
            persistPineScripts(); applyPlotStyleOverrides(script);
          });
          swWrap.appendChild(colorInput);
        });
        row.appendChild(swWrap);
      } else {
        const colorInput = document.createElement('input'); colorInput.type = 'color'; colorInput.className = 'legend-color-dot';
        colorInput.value = pineColorToHex(ov.color || p.color);
        colorInput.addEventListener('input', () => {
          script.plotOverrides[p.key] = Object.assign({}, script.plotOverrides[p.key], { color: colorInput.value });
          persistPineScripts(); applyPlotStyleOverrides(script);
        });
        row.appendChild(colorInput);
      }
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

async function rerunWithOverride(script, inputId, value){
  script.inputOverrides = script.inputOverrides || {};
  script.inputOverrides[inputId] = value;
  persistPineScripts();
  if(!script.enabled) return;
  const bars = state.currentBars || [];
  clearPineError();
  let result;
  try{ result = await runPineScript(script.source, bars, script.inputOverrides); }
  catch(err){ showPineError(err); deactivatePineScript(script.id); renderPineScriptsList(); return; }
  activatePineScript(script, result);
}

async function togglePineScriptEnabled(s){
  s.enabled = !s.enabled;
  persistPineScripts();
  if(s.enabled){
    const bars = state.currentBars || [];
    try{ const result = await runPineScript(s.source, bars, s.inputOverrides || {}); s.lastError = null; activatePineScript(s, result); }
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
    if(s.pineVersion){
      const badge = document.createElement('span');
      badge.className = 'pine-script-version-badge';
      badge.textContent = 'v' + s.pineVersion;
      row.appendChild(badge);
    }
    const name = document.createElement('span');
    name.className = 'pine-script-name';
    name.textContent = s.name + (s.lastError ? ' ⚠' : '');
    name.title = s.lastError ? s.lastError : t('pineEditHint');
    name.addEventListener('click', () => openPineScriptInEditor(s));
    row.appendChild(name);

    const onOffBtn = document.createElement('button');
    onOffBtn.className = 'pine-script-icon' + (s.enabled ? ' active' : '');
    onOffBtn.title = t('pineOnOff');
    onOffBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v10"/><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/></svg>';
    onOffBtn.addEventListener('click', () => togglePineScriptEnabled(s));
    row.appendChild(onOffBtn);

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
  eyeBtn.className = 'legend-icon' + (s.hidden ? '' : ' active');
  eyeBtn.title = t('legendToggleVisible');
  eyeBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
  eyeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    s.hidden = !s.hidden;
    persistPineScripts();
    applyPlotStyleOverrides(s);
  });
  const gearBtn = document.createElement('button');
  gearBtn.className = 'legend-icon';
  gearBtn.title = t('legendSettings');
  gearBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
  gearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const active = state.pineActive.get(s.id);
    if(active && active.settingsPanel) toggleLegendSettings(active.settingsPanel);
  });
  const codeBtn = document.createElement('button');
  codeBtn.className = 'legend-icon';
  codeBtn.title = t('pineViewCode');
  codeBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1"/><path d="M16 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1"/></svg>';
  codeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openPineScriptInEditor(s);
  });
  const onOffBtn = document.createElement('button');
  onOffBtn.className = 'legend-icon' + (s.enabled ? ' active' : '');
  onOffBtn.title = t('pineOnOff');
  onOffBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v10"/><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/></svg>';
  onOffBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePineScriptEnabled(s); });
  icons.appendChild(eyeBtn); icons.appendChild(codeBtn); icons.appendChild(gearBtn); icons.appendChild(onOffBtn);
  icons._eyeBtn = eyeBtn;
  icons._onOffBtn = onOffBtn;
  return icons;
}
// 라벨의 {} 아이콘 — 이 지표를 어떤 코드로 가져왔는지 Import Pine Script 창에 다시 띄워준다.
function openPineScriptInEditor(s){
  pineEditingId = s.id;
  pineSourceInput.value = s.source;
  pineNameInput.value = s.name;
  pineVersionSelect.value = s.pineVersionMode || 'auto';
  refreshPineVersionAutoOption();
  clearPineError();
  if(!state.pineOpen) togglePinePanel();
  pineSourceInput.scrollTop = 0;
  pineSourceInput.focus();
  pineSourceInput.setSelectionRange(0, 0);
}
function createChartLegendItem(s){
  const item = document.createElement('div');
  item.className = 'legend-item' + (s.hidden ? ' hidden' : '');
  const nameEl = document.createElement('span');
  nameEl.className = 'legend-name';
  nameEl.textContent = s.name;
  item.appendChild(nameEl);
  const icons = createLegendIcons(s);
  item.appendChild(icons);
  item._eyeBtn = icons._eyeBtn;
  return item;
}

// ---------- 차트에 실제로 그리기 ----------
// 중요: lightweight-charts의 visible logical range는 "시간"이 아니라 각 차트가 가진 데이터 포인트의
// 순번(index) 기준이다. 그래서 값이 없는 봉(예: SMA 20의 앞 19개 워밍업 구간)을 그냥 빼버리면
// 패널 차트의 0번 포인트가 메인 차트의 19번 봉이 되어버려서, 딱 그만큼 왼쪽으로 밀리고
// 스크롤할 때도 계속 어긋난다. 값이 없는 자리는 whitespace 포인트({time}만 있고 value 없음)로
// 채워서 두 차트의 인덱스를 1:1로 맞춘다.
function barPoints(bars, values, offset){
  const off = offset || 0;
  const shifted = new Array(bars.length).fill(null);
  for(let i = 0; i < bars.length; i++){
    if(values[i] == null || !Number.isFinite(values[i])) continue;
    const t = i + off;
    if(t < 0 || t >= bars.length) continue;
    shifted[t] = values[i];
  }
  return bars.map((b, i) => shifted[i] == null ? { time: b.time } : { time: b.time, value: shifted[i] });
}
// colorMap은 이제 "색상 값"이 아니라 "코드상 어느 분기에서 나왔는지"(branchKey)를 키로 쓴다.
// branchKey가 없는(단순 색상 표현식) 경우엔 색상 값 자체가 곧 키다 (plot() builtin에서 그렇게 채워둠).
function pineRemapColorByBranch(branchKey, fallbackColor, colorMap){
  if(colorMap && branchKey && colorMap[branchKey] !== undefined) return colorMap[branchKey];
  return fallbackColor;
}
function barPointsColored(bars, values, colors, offset, overrideColor, colorMap, branchKeys){
  const off = offset || 0;
  const shiftedV = new Array(bars.length).fill(null);
  const shiftedC = new Array(bars.length).fill(null);
  const shiftedK = new Array(bars.length).fill(null);
  for(let i = 0; i < bars.length; i++){
    if(values[i] == null || !Number.isFinite(values[i])) continue;
    const t = i + off;
    if(t < 0 || t >= bars.length) continue;
    shiftedV[t] = values[i];
    shiftedC[t] = colors ? colors[i] : null;
    shiftedK[t] = branchKeys ? branchKeys[i] : null;
  }
  return bars.map((b, i) => {
    if(shiftedV[i] == null) return { time: b.time };
    const c = overrideColor || pineRemapColorByBranch(shiftedK[i], shiftedC[i], colorMap);
    return c ? { time: b.time, value: shiftedV[i], color: c } : { time: b.time, value: shiftedV[i] };
  });
}
// plot()의 style=histogram/columns 은 line이 아니라 막대그래프로, 그리고 봉마다 색이 달라질 수 있어서
// (예: bcolor = iff(val>0, lime, red) 같은 패턴) 일반 라인 시리즈 대신 히스토그램 시리즈로 그려야 한다.
//
// 중요: lightweight-charts는 "값 없는 구간(whitespace)"을 줘도 선을 끊어주지 않고 그냥 이어버리는
// 라이브러리 자체 한계가 있다(공식 GitHub 이슈로도 보고된 문제 — whitespace로는 gap이 안 생김).
// 그래서 na로 듬성듬성 끊긴 지표(예: 오더블록처럼 특정 봉에서만 값이 찍히는 지표)를 일반 라인
// 시리즈 하나로 그리면 서로 다른 시점의 값들이 전부 지그재그로 이어져버린다.
// 해결책은 공식 이슈에서도 안내하는 대로 "값이 있는 구간(run)마다 완전히 별도의 시리즈로 쪼개기"뿐이다.
function splitLineRuns(bars, values, offset){
  const off = offset || 0;
  const shifted = new Array(bars.length).fill(null);
  for(let i = 0; i < bars.length; i++){
    if(values[i] == null || !Number.isFinite(values[i])) continue;
    const t = i + off;
    if(t < 0 || t >= bars.length) continue;
    shifted[t] = values[i];
  }
  const runs = [];
  let cur = null;
  for(let i = 0; i < bars.length; i++){
    if(shifted[i] != null){
      if(!cur){ cur = []; runs.push(cur); }
      cur.push({ time: bars[i].time, value: shifted[i] });
    } else cur = null;
  }
  return runs;
}
// splitLineRuns와 같은 이유로 값이 있는 구간(run)마다 먼저 쪼갠 뒤, 실제 TradingView가
// `plot(source, color=variable)`에서 하는 것과 동일하게 각 run 안에서도 봉마다 색이 바뀌는
// 지점마다 다시 별도 시리즈로 쪼갠다(예: 이 MA 지표의 `col = ma_up ? lime : red`처럼 방향에 따라
// 초록/빨강이 바뀌는 라인). 그동안은 style=histogram/cross만 봉별 색을 반영하고 일반 line은
// (plot() builtin이 매 봉마다 rec.color를 덮어써서 남는) "마지막 봉의 색 하나"만 전체 라인에
// 칠해져서, 방향과 무관하게 항상 한 가지 색으로만 보이는 버그가 있었다.
//
// color=na 봉 처리: TradingView는 특정 봉에서 color가 na로 평가되면 그 봉으로 "들어오는"
// 선분을 아예 그리지 않는다(핏셀이 안 찍힘) — 값 자체는 na가 아니라도 그렇다. 바로 이 성질을
// 이용해서 `color = change(level) ? na : red` 같은 패턴(LuxAlgo Support/Resistance 등 지지/
// 저항 계단선 스크립트에서 흔함)이 "레벨이 바뀌는 순간의 대각선 연결선"만 딱 숨기고 계단 모양의
// 평평한 구간만 남긴다. 예전 코드는 이걸 반대로(= na 봉을 이전 색으로 이어서 그림) 처리해서
// 서로 다른 레벨의 계단선끼리 대각선으로 이어져 보이는 버그가 있었다 — 이번에 수정.
// na 색 봉은 버퍼에 모아두고, 다음으로 실제 색이 나오는 봉을 만나면 그 버퍼링된 점들과 함께
// "새 세그먼트"로 시작한다(옛 세그먼트에는 절대 붙이지 않음). 그래야 새 레벨의 평평한 선이
// 정확히 값이 바뀐 시점부터 시작하면서도, 이전 레벨 선과는 시각적으로 연결되지 않는다.
// (진짜 같은 색으로 이어지는 일반적인 색 변경의 경우에만 이전 점을 하나 겹쳐서 자연스럽게 잇는다.)
function splitColoredLineRuns(bars, values, colors, offset, overrideColor, colorMap, branchKeys){
  const off = offset || 0;
  const shiftedV = new Array(bars.length).fill(null);
  const shiftedColor = new Array(bars.length).fill(null);
  for(let i = 0; i < bars.length; i++){
    if(values[i] == null || !Number.isFinite(values[i])) continue;
    const t = i + off;
    if(t < 0 || t >= bars.length) continue;
    shiftedV[t] = values[i];
    shiftedColor[t] = overrideColor || pineRemapColorByBranch(branchKeys ? branchKeys[i] : null, colors ? colors[i] : null, colorMap);
  }
  const segments = [];
  let cur = null; // { color, points }
  let forceBreak = false; // na 색 봉을 거쳐왔으면, 다음 실제 색은 무조건 새 세그먼트로 끊어야 한다
  let pending = []; // color=na이지만 값은 있는 봉들 — 다음 실제 색 세그먼트의 시작점으로 넘겨줄 버퍼
  for(let i = 0; i < bars.length; i++){
    if(shiftedV[i] == null){ cur = null; forceBreak = false; pending = []; continue; } // 값 자체가 na면 진짜로 끊는다
    const c = shiftedColor[i];
    if(c == null){
      // color=na — 이 봉으로 들어오는 선분은 안 그려야 한다(TradingView 동작). 옛 세그먼트에
      // 붙이지 말고 일단 버퍼에만 담아둔다.
      pending.push({ time: bars[i].time, value: shiftedV[i] });
      forceBreak = true;
      continue;
    }
    if(!cur || forceBreak || cur.color !== c){
      const seg = { color: c, points: [] };
      // na로 끊긴 게 아니라 그냥 색만 바뀐 정상적인 경우에만 이전 점을 겹쳐서 자연스럽게 잇는다.
      if(cur && !forceBreak) seg.points.push(cur.points[cur.points.length - 1]);
      if(pending.length) seg.points.push(...pending);
      segments.push(seg);
      cur = seg;
      forceBreak = false;
      pending = [];
    }
    cur.points.push({ time: bars[i].time, value: shiftedV[i] });
  }
  return segments;
}
// 항상 배열을 반환한다: histogram은 시리즈 1개, line은 값이 있는 구간(run) 개수만큼.
function createPlotSeries(chartObj, p, ov, bars, scriptHidden){
  const isHist = p.style === 'histogram';
  const baseOpts = {
    priceScaleId: 'right', lastValueVisible: true, priceLineVisible: false,
    visible: ov.visible !== false && !scriptHidden,
  };
  // 메인 차트(overlay 지표)에서는 이 시리즈가 가격축 범위 계산에 끼어들면 안 된다.
  // 안 그러면 지표를 켤 때마다 캔들이 위아래로 살짝 눌린다 — 내장 오버레이 지표들도 같은 처리를 한다.
  // 반대로 전용 패널에서는 지표 자체가 내용물이라 정상적으로 autoscale 되어야 한다.
  if(chartObj === state.chart) baseOpts.autoscaleInfoProvider = () => null;
  if(isHist){
    const series = chartObj.addHistogramSeries(Object.assign({}, baseOpts, { color: ov.color || p.color, base: 0 }));
    series.setData(barPointsColored(bars, p.values, p.colors, p.offset, ov.color, ov.colorMap, p.branchKeys));
    series._pineKey = p.key; series._pineBaseColor = p.color;
    return [series];
  }
  if(p.style === 'area'){
    // 실제 Pine의 style=area는 그려지는 값과 0(기준선) 사이를 색으로 채운다 — 라인 시리즈로
    // 그리면 (특히 transp가 커서 색이 옅을 때) 사실상 안 보이는 얇은 선 하나만 남는다. 0을
    // 기준으로 위/아래를 채워주는 baseline 시리즈를 대신 써서 실제로 "면적"이 보이게 한다.
    const col = ov.color || p.color;
    const lw = Math.max(1, Math.min(4, Math.round(p.linewidth || 1)));
    const series = chartObj.addBaselineSeries(Object.assign({}, baseOpts, {
      baseValue: { type: 'price', price: 0 },
      topLineColor: col, bottomLineColor: col,
      topFillColor1: col, topFillColor2: col,
      bottomFillColor1: col, bottomFillColor2: col,
      lineWidth: lw,
    }));
    series.setData(barPoints(bars, p.values, p.offset));
    series._pineKey = p.key; series._pineBaseColor = p.color;
    return [series];
  }
  if(p.style === 'cross'){
    // style=cross/circles 는 히스토그램처럼 봉마다 색이 다를 수 있는데(예: bcolor 패턴), 그냥
    // 라인으로 그리면 색을 하나만 쓸 수 있다. 값 자체는 안 보이는 라인(정렬/hline 고정용)만 두고,
    // 실제 점은 caller가 캔버스에 직접 그린다 — lightweight-charts의 마커 size 옵션은 사실상
    // 작동하지 않는 라이브러리 자체 버그가 있어서(공식 이슈로 보고됨) 못 쓴다.
    const series = chartObj.addLineSeries(Object.assign({}, baseOpts, { color: 'rgba(0,0,0,0)', lineWidth: 1, crosshairMarkerVisible: false }));
    series.setData(barPoints(bars, p.values, p.offset));
    // linewidth는 style=circles/cross에서 선 두께가 아니라 원의 크기를 뜻한다 — 원래 크기 계산에서
    // 이 값이 통째로 빠져 있어서 항상 반지름 2px짜리 점만 찍혔다. 히스토그램/다른 선에 묻혀 사실상
    // 안 보였던 것도 이 때문이다. linewidth가 클수록 원도 커지도록 반영한다.
    const markerRadius = Math.max(2, Math.min(9, (p.linewidth || 1) * 1.6));
    const markers = [];
    for(let i = 0; i < bars.length; i++){
      const v = p.values[i]; if(v == null || !Number.isFinite(v)) continue;
      const idx = i + (p.offset || 0); if(idx < 0 || idx >= bars.length) continue;
      markers.push({ time: bars[idx].time, value: v, color: ov.color || pineRemapColorByBranch(p.branchKeys && p.branchKeys[i], p.colors[i], ov.colorMap) || p.color, size: markerRadius });
    }
    series._pineKey = p.key; series._pineBaseColor = p.color;
    series._pineCrossMarkers = markers;
    return [series];
  }
  const lineOpts = Object.assign({}, baseOpts, {
    lineWidth: Math.max(1, Math.min(4, Math.round(p.linewidth || 1))), crosshairMarkerVisible: false,
  });
  // 봉마다 색이 바뀌는지(예: 방향에 따라 색이 갈리는 이동평균선) 먼저 확인한다 — 색이 한 가지뿐이면
  // 굳이 봉 단위로 잘게 쪼갤 필요 없이 예전처럼 값이 있는 구간(run)당 시리즈 하나로 충분하다.
  const uniqueColors = new Set();
  if(!ov.color && p.colors){
    for(let i = 0; i < bars.length; i++){
      if(p.values[i] == null || !Number.isFinite(p.values[i])) continue;
      uniqueColors.add(pineRemapColorByBranch(p.branchKeys ? p.branchKeys[i] : null, p.colors[i], ov.colorMap));
      if(uniqueColors.size > 1) break;
    }
  }
  const segments = uniqueColors.size > 1
    ? splitColoredLineRuns(bars, p.values, p.colors, p.offset, ov.color, ov.colorMap, p.branchKeys)
    : splitLineRuns(bars, p.values, p.offset).map(runPts => ({ color: ov.color || p.color, points: runPts }));
  if(!segments.length){
    // 전부 na여도 정렬/hline 고정용으로 최소 하나는 있어야 한다 (whitespace만 채워서 비워둠)
    const series = chartObj.addLineSeries(Object.assign({}, lineOpts, { color: ov.color || p.color }));
    series.setData(barPoints(bars, p.values, p.offset));
    series._pineKey = p.key; series._pineBaseColor = p.color;
    return [series];
  }
  return segments.map((seg, idx) => {
    // 값이 있는 구간마다 시리즈를 쪼갰다고 해서 전부 가격축에 "마지막 값" 라벨을 띄우면 안 된다 —
    // 실제 TradingView처럼 제일 최근(오른쪽) 구간에만 라벨이 떠야 한다.
    const isLast = idx === segments.length - 1;
    const series = chartObj.addLineSeries(Object.assign({}, lineOpts, { color: seg.color, lastValueVisible: lineOpts.lastValueVisible && isLast }));
    series.setData(seg.points);
    series._pineKey = p.key; series._pineBaseColor = p.color;
    return series;
  });
}

// 구조(오버레이 여부, plot/hline 개수와 순서)가 이전 실행과 똑같으면 DOM은 그대로 두고
// 시리즈 데이터만 갱신한다. 매 새 봉마다 범례 DOM을 통째로 새로 만들면, 그 순간 마우스가
// 톱니바퀴 버튼 쪽으로 가고 있어도 :hover 상태가 끊겨서 버튼이 사라지는 것처럼 보이는 문제가 있었다.
function pineCanSoftUpdate(active, result){
  if(!active) return false;
  const wasOverlay = !active.pane;
  if(wasOverlay !== result.meta.overlay) return false;
  const linesArr = active.pane ? active.pane.plotLines : active.overlayLines;
  if(!linesArr) return false;
  const existingKeys = [...new Set(linesArr.map(l => l._pineKey))];
  const newKeys = result.plots.map(p => p.key);
  if(existingKeys.length !== newKeys.length) return false;
  return newKeys.every(k => existingKeys.includes(k));
}
function softUpdatePineScript(script, active, result){
  const bars = state.currentBars || [];
  const chartObj = active.pane ? active.pane.chart : state.chart;
  if(active.pane) active.pane.suspend.on = true;
  try{
  // 값이 있는 구간(run) 개수가 봉마다 바뀔 수 있어서, plot마다 기존 세그먼트를 지우고 새로 만든다.
  // (범례/설정창 DOM은 안 건드리므로 호버가 끊기는 문제와는 무관하다)
  const crossMarkers = rebuildPinePlotSeries(script, active, result.plots);
  if(!active.pane){
    active.overlayPriceLines.forEach(pl => { try{ state.candleSeries.removePriceLine(pl); }catch(e){} });
    active.overlayPriceLines = [];
    result.hlines.forEach(h => {
      if(h.price == null || !Number.isFinite(h.price)) return;
      const pl = state.candleSeries.createPriceLine({ price: h.price, color: h.color, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: false, title: '' });
      active.overlayPriceLines.push(pl);
    });
    active.drawObjects = { lines: result.lines || [], boxes: result.boxes || [], labels: result.labels || [], shapes: result.shapes || [], crossMarkers };
    pineDrawRevision++;
  } else {
    // hline 가격선은 계속 재사용되는 실제 plot/anchor 시리즈에 붙어 있으므로 직접 추적해서 지운다.
    (active.pane.hlinePriceLines || []).forEach(({ series, priceLine }) => { try{ series.removePriceLine(priceLine); }catch(e){} });
    active.pane.hlinePriceLines = [];
    // crossMarkers(style=cross/circles로 캔버스에 직접 찍는 점)는 renderCrossMarkers 안에서
    // pane.anchorSeries로 좌표 변환을 하는데, 그 anchor는 원래 hline() 가격선을 붙일 때만
    // 만들어졌다. 그래서 hline() 없이 plot(x, style=circles)만 쓰는 스크립트(예: LazyBear
    // WaveTrend의 style=3 레벨선)는 anchor가 끝내 안 생겨서 renderCrossMarkers가 매번 조용히
    // 아무것도 안 그리고 리턴해버렸다 — 점 마커가 통째로 안 보이는 버그. hline 유무와 무관하게
    // 여기서 미리 anchor를 만들어둔다.
    if(crossMarkers.length) getPaneAnchor(active.pane, bars);
    // 빈 더미 시리즈에 가격선을 붙이면 지금 쓰는 lightweight-charts 버전에서 안 뜨는 경우가 있어서
    // (실제 값이 있는 시리즈에는 정상적으로 붙는다), 이미 그려지고 있는 plot 라인이 있으면 그걸 재사용한다.
    result.hlines.forEach(h => {
      if(h.price == null || !Number.isFinite(h.price)) return;
      const anchor = getPaneAnchor(active.pane, bars);
      const pl = anchor.createPriceLine({ price: h.price, color: h.color, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: false, title: '' });
      active.pane.hlinePriceLines.push({ series: anchor, priceLine: pl });
    });
    if(active.pane.syncPriceScaleWidth) active.pane.syncPriceScaleWidth();
    applyPaneShapeMarkers(active.pane, result.shapes || [], bars);
    active.pane.crossMarkers = crossMarkers;
    active.pane.renderCrossMarkers();
    const range = state.chart.timeScale().getVisibleLogicalRange();
    if(range) active.pane.chart.timeScale().setVisibleLogicalRange(range);
  }
  } finally { if(active.pane) active.pane.suspend.on = false; }
  // 표는 봉마다 내용이 바뀌는 게 정상이라(마지막 가격/지표값 요약 등) 매번 다시 그린다.
  renderPineTables(script, active, result.tables);
  active.lastResult = result;
  syncPineBarColors(); // lastResult를 갈아끼운 뒤에 합쳐야 새 봉 색이 반영된다
  script.lastError = null;
}

function activatePineScript(script, result){
  const prevActive = state.pineActive.get(script.id);
  if(pineCanSoftUpdate(prevActive, result)){
    softUpdatePineScript(script, prevActive, result);
    return;
  }
  const wasSettingsOpen = !!(prevActive && prevActive.settingsPanel && prevActive.settingsPanel.classList.contains('open'));
  deactivatePineScript(script.id); // 구조가 바뀐 경우에만 통째로 다시 그린다
  script.lastError = null;
  const bars = state.currentBars || [];
  const active = { overlayLines: [], overlayPriceLines: [], tableEls: [], pane: null, legendEl: null, settingsPanel: null, lastResult: result };
  if(result.meta.overlay){
    result.plots.forEach(p => {
      const ov = (script.plotOverrides || {})[p.key] || {};
      active.overlayLines.push(...createPlotSeries(state.chart, p, ov, bars, script.hidden));
    });
    result.hlines.forEach(h => {
      if(h.price == null || !Number.isFinite(h.price)) return;
      const pl = state.candleSeries.createPriceLine({ price: h.price, color: h.color, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: false, title: '' });
      active.overlayPriceLines.push(pl);
    });
    active.legendEl = createChartLegendItem(script);
    $('chartLegend').appendChild(active.legendEl);
    const crossMarkers = active.overlayLines.reduce((acc, l) => l._pineCrossMarkers ? acc.concat(l._pineCrossMarkers) : acc, []);
    active.drawObjects = { lines: result.lines || [], boxes: result.boxes || [], labels: result.labels || [], shapes: result.shapes || [], crossMarkers };
    pineDrawRevision++;
  } else {
    const pane = createPinePane(script.id, script.name);
    pane.suspend.on = true; // 최초 데이터 주입 동안에도 패널이 메인 차트를 끌고 가지 않게 막는다
    const icons = createLegendIcons(script);
    pane.legendItem.appendChild(icons);
    pane.legendItem._eyeBtn = icons._eyeBtn;
    pane.legendItem.classList.toggle('hidden', !!script.hidden);
    result.plots.forEach(p => {
      const ov = (script.plotOverrides || {})[p.key] || {};
      pane.plotLines.push(...createPlotSeries(pane.chart, p, ov, bars, script.hidden));
    });
    result.hlines.forEach(h => {
      if(h.price == null || !Number.isFinite(h.price)) return;
      const anchor = getPaneAnchor(pane, bars);
      const pl = anchor.createPriceLine({ price: h.price, color: h.color, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: false, title: '' });
      pane.hlinePriceLines.push({ series: anchor, priceLine: pl });
    });
    pane.syncPriceScaleWidth();
    applyPaneShapeMarkers(pane, result.shapes || [], bars);
    pane.crossMarkers = pane.plotLines.reduce((acc, l) => l._pineCrossMarkers ? acc.concat(l._pineCrossMarkers) : acc, []);
    // hline() 없이 plot(x, style=circles/cross)만 쓰는 스크립트도 점 마커가 뜨도록, anchor가
    // 아직 없으면(위 hline 루프가 한 번도 안 돌았으면) 여기서 미리 만들어둔다.
    if(pane.crossMarkers.length) getPaneAnchor(pane, bars);
    pane.renderCrossMarkers();
    const initRange = state.chart.timeScale().getVisibleLogicalRange();
    if(initRange) pane.chart.timeScale().setVisibleLogicalRange(initRange);
    pane.suspend.on = false;
    active.pane = pane;
  }
  renderPineTables(script, active, result.tables); // table.new/table.cell (overlay·패널 공통)
  // syncPineBarColors()가 state.pineActive에서 lastResult를 읽으므로 등록이 먼저여야 한다.
  state.pineActive.set(script.id, active);
  syncPineBarColors(); // barcolor()
  active.settingsPanel = buildPineSettingsPanel(script, result);
  registerLegendSettings(active.settingsPanel);
  if(wasSettingsOpen) openLegendSettings(active.settingsPanel); // 입력값 바꿔서 다시 실행된 경우 설정창이 닫히지 않게 유지
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
  clearPineTables(active);
  if(active.pane) destroyPinePane(active.pane);
  pruneEmptyPineTableZones();
  state.pineActive.delete(id);
  syncPineBarColors(); // 이 스크립트가 칠해둔 봉 색을 되돌린다
  pineDrawRevision++;
}

// 모든 저장된(활성화된) 스크립트를 새 봉 데이터 기준으로 다시 실행 — 코인/차트유형/기간이 바뀔 때 호출됨.
// runPineScript가 request.security_lower_tf() 프리페치 때문에 비동기라, 호출부(라이브 틱/과거
// 로딩 등)는 이 함수를 await 없이 fire-and-forget으로 부른다 — 완료되면 여기서 직접 화면을 갱신한다.
async function refreshAllPineScripts(){
  const bars = state.currentBars || [];
  if(!bars.length) return;
  for(const s of state.pineScripts){
    if(!s.enabled) continue;
    try{ const result = await runPineScript(s.source, bars, s.inputOverrides || {}); s.lastError = null; activatePineScript(s, result); }
    catch(err){ s.lastError = err.message; deactivatePineScript(s.id); }
  }
  renderPineScriptsList();
}

// ---------- 동적 전용 패널 (RSI/MACD 패널과 같은 구조를 매 스크립트마다 새로 만든다) ----------
// 스크롤/줌 동기화 가드는 패널마다 따로 두면 안 된다. 패널이 2개 이상일 때 A가 메인을 바꾸고
// 메인이 다시 B를 바꾸는 식으로 튕겨다니면서 스크롤이 제멋대로 밀려나갈 수 있어서, 모든 Pine
// 패널이 하나의 가드를 공유하게 한다.
let pineSyncGuard = false;
// pane.plotLines[0](패널에 가장 먼저 추가된 시리즈)은 스크립트에 따라 아주 짧은 색상 세그먼트
// 하나일 수도 있어서(예: 봉마다 색이 바뀌는 라인 — 방향이 바뀔 때마다 별도 시리즈로 쪼개진다),
// 가격<->좌표 변환이나 setMarkers()의 "기준점(anchor)"으로 쓰기엔 불안정하다. 항상 전체 봉 구간을
// 커버하는 전용 투명 헬퍼 시리즈를 패널마다 하나 만들어 재사용한다. autoscaleInfoProvider로
// 자동 스케일 계산에서는 제외해서, 이 더미 값이 실제 지표들의 가격 범위(눈에 보이는 스케일)에
// 영향을 주지 않게 막는다. 값 자체는 좌표 변환에만 쓰이므로 무의미해도 되지만, 완전히 빈 채로
// 두면(setData 호출 없이) 일부 lightweight-charts 버전에서 price line/marker가 안 뜨는 경우가
// 있어서 항상 실제 데이터(종가)를 채워 넣는다.
function getPaneAnchor(pane, bars){
  if(pane.anchorSeries){
    pane.anchorSeries.setData(bars.map(b => ({ time: b.time, value: b.close })));
    return pane.anchorSeries;
  }
  const s = pane.chart.addLineSeries({
    color: 'rgba(0,0,0,0)', lineWidth: 1, visible: true, lastValueVisible: false, priceLineVisible: false,
    crosshairMarkerVisible: false, priceScaleId: 'right', autoscaleInfoProvider: () => null,
  });
  s.setData(bars.map(b => ({ time: b.time, value: b.close })));
  pane.anchorSeries = s;
  return s;
}
function createPinePane(id, title){
  const domId = 'pinePane_' + id;
  const wrap = document.createElement('div');
  wrap.className = 'rsi-pane pine-pane';
  wrap.id = domId;
  const handleId = domId + '_handle';
  wrap.innerHTML =
    `<div class="rsi-resize-handle" id="${handleId}"></div>` +
    `<div class="pine-pane-chart"></div>` +
    `<canvas class="pine-pane-markers"></canvas>` +
    `<div class="chart-legend pine-pane-legend"><div class="legend-item"><span class="legend-name"></span></div></div>`;
  wrap.querySelector('.legend-name').textContent = title;
  pineCustomPanesEl.appendChild(wrap);
  const chartEl = wrap.querySelector('.pine-pane-chart');
  const markerCanvas = wrap.querySelector('.pine-pane-markers');
  const markerCtx = markerCanvas.getContext('2d');
  const resizeHandleEl = wrap.querySelector('.rsi-resize-handle');
  setupPaneResize(resizeHandleEl, wrap);

  const chart = LightweightCharts.createChart(chartEl, panelChartOptions()); // RSI/MACD 패널과 공용 (chart-init.js)
  { const r = chartEl.getBoundingClientRect(); if(r.width && r.height) chart.resize(r.width, r.height); }
  // 두 차트의 "플롯 영역" 폭이 같아야 봉 위치가 픽셀 단위로 정확히 겹친다. 가격축은 표시되는
  // 숫자 자릿수에 따라 폭이 자동으로 정해지므로(메인은 62976.0, 패널은 0.5 처럼), 둘 중 더 넓은
  // 쪽에 양쪽을 함께 맞춰준다.
  function syncPriceScaleWidth(){
    if(!state.chart) return;
    try{
      const mainScale = state.chart.priceScale('right');
      const paneScale = chart.priceScale('right');
      const w = Math.max(mainScale.width() || 0, paneScale.width() || 0);
      if(!w) return;
      if((mainScale.options().minimumWidth || 0) !== w) mainScale.applyOptions({ minimumWidth: w });
      if((paneScale.options().minimumWidth || 0) !== w) paneScale.applyOptions({ minimumWidth: w });
    }catch(e){}
  }
  // style=cross/circles 마커를 lightweight-charts의 setMarkers()로 그리면 size 옵션이
  // 사실상 안 먹는 라이브러리 자체 버그가 있어서(공식 GitHub 이슈로도 보고됨), 패널 전용 캔버스에
  // 직접 원을 그린다 — 픽셀 크기를 완전히 우리가 정할 수 있다.
  const pane = {};
  pane.crossMarkers = [];
  pane.plotLines = [];
  pane.renderCrossMarkers = function(){
    if(!markerCanvas.width && !markerCanvas.height) return;
    markerCtx.clearRect(0, 0, markerCanvas.width, markerCanvas.height);
    if(!pane.crossMarkers.length || !pane.anchorSeries) return;
    const anchor = pane.anchorSeries;
    const ts = chart.timeScale();
    pane.crossMarkers.forEach(m => {
      const x = ts.timeToCoordinate(m.time);
      if(x == null) return;
      let y;
      try{ y = anchor.priceToCoordinate(m.value); }catch(e){ y = null; }
      if(y == null) return;
      markerCtx.beginPath();
      markerCtx.arc(x, y, m.size || 2, 0, Math.PI * 2);
      markerCtx.fillStyle = m.color || '#787b86';
      markerCtx.fill();
    });
  };
  function resizeMarkerCanvas(){
    const r = chartEl.getBoundingClientRect();
    markerCanvas.width = r.width; markerCanvas.height = r.height;
    pane.renderCrossMarkers();
  }
  function followMain(range){ if(pineSyncGuard || !range) return; pineSyncGuard = true; chart.timeScale().setVisibleLogicalRange(range); syncPriceScaleWidth(); pane.renderCrossMarkers(); pineSyncGuard = false; }
  // setData()로 데이터를 새로 넣는 동안 패널 차트는 잠깐 자기 마음대로 스크롤된다. 그 순간의
  // 엉뚱한 범위가 "패널 -> 메인" 동기화를 타고 메인 차트에 덮어씌워지면 차트 전체가 끌려다니면서
  // 시간축이 어긋난다. 우리가 직접 데이터를 넣는 동안에는 역방향 동기화를 꺼둔다.
  const suspend = { on: false };
  function mainFollow(range){ if(pineSyncGuard || suspend.on || !range || !state.chart) return; pineSyncGuard = true; state.chart.timeScale().setVisibleLogicalRange(range); pineSyncGuard = false; pane.renderCrossMarkers(); }
  state.chart.timeScale().subscribeVisibleLogicalRangeChange(followMain);
  chart.timeScale().subscribeVisibleLogicalRangeChange(mainFollow);
  syncPriceScaleWidth();
  const resizeObs = new ResizeObserver(entries => {
    const { width, height } = entries[0].contentRect;
    chart.resize(width, height);
    syncPriceScaleWidth();
    resizeMarkerCanvas();
  });
  resizeObs.observe(chartEl);
  resizeMarkerCanvas();
  // 줌/스크롤 직후엔 timeToCoordinate()가 아직 이전 프레임 기준값을 돌려줄 때가 있어서,
  // 이벤트에 맞춰 한 번만 그리면 위치가 살짝 밀리거나 늦게 반영되는 것처럼 보인다.
  // 그래서 매 프레임 계속 다시 그려서(rAF 루프) 항상 최신 좌표에 맞도록 한다.
  let crossLoopId = null;
  function crossLoopTick(){
    pane.renderCrossMarkers();
    crossLoopId = requestAnimationFrame(crossLoopTick);
  }
  crossLoopId = requestAnimationFrame(crossLoopTick);
  pane.stopCrossLoop = function(){ if(crossLoopId != null) cancelAnimationFrame(crossLoopId); crossLoopId = null; };
  Object.assign(pane, { id, wrap, chart, chartEl, followMain, resizeObs, plotLines: [], hlinePriceLines: [], legendItem: wrap.querySelector('.legend-item'), syncPriceScaleWidth, suspend });
  return pane;
}
function destroyPinePane(pane){
  if(pane.stopCrossLoop) try{ pane.stopCrossLoop(); }catch(e){}
  try{ state.chart.timeScale().unsubscribeVisibleLogicalRangeChange(pane.followMain); }catch(e){}
  try{ pane.resizeObs.disconnect(); }catch(e){}
  try{ pane.chart.remove(); }catch(e){}
  if(pane.wrap && pane.wrap.parentNode) pane.wrap.parentNode.removeChild(pane.wrap);
  // 남아 있는 Pine 패널이 없으면 메인 차트에 강제로 넓혀둔 가격축 폭을 원래대로 되돌린다
  const stillHasPane = [...state.pineActive.values()].some(a => a.pane && a.pane !== pane);
  if(!stillHasPane){
    try{ state.chart.priceScale('right').applyOptions({ minimumWidth: 0 }); }catch(e){}
  }
}

// ---------- Pine barcolor() — 메인 캔들을 다시 칠하기 ----------
// plot()/plotshape()처럼 뭔가를 "위에 얹는" 게 아니라 메인 캔들 시리즈의 각 봉 색 자체를 바꾸는
// 함수라, 오버레이 캔버스가 아니라 캔들 데이터에 직접 반영해야 한다. 봉 배열은 과거 데이터를
// 앞에 이어붙이면 인덱스가 통째로 밀리므로, 인덱스가 아니라 (시간 -> 색) 맵으로 들고 있는다.
//
// overlay 여부와 무관하게 항상 메인 차트에 적용된다 — 실제 Pine도 별도 패널 지표에서 부른
// barcolor()가 메인 차트 봉을 칠한다(패널에는 칠할 봉이 없으므로).
let pineBarColors = new Map();
function pineBarColorAt(time){ return pineBarColors.get(time) || null; }
// 캔들 계열 시리즈 데이터에 색을 덮어쓴다. Line/Area/Baseline은 봉이라는 개념이 없어서
// 호출하는 쪽(toMainSeriesData)이 아예 이 단계를 건너뛴다.
function applyPineBarColors(bars){
  if(!pineBarColors.size) return bars;
  return bars.map(b => {
    const c = pineBarColors.get(b.time);
    return c ? { ...b, color: c, borderColor: c, wickColor: c } : b;
  });
}
// 활성화된 스크립트들의 barcolor 결과를 하나로 합친다. 실제로 색이 바뀐 경우에만 다시 그린다 —
// 스크립트가 여러 개면 activate가 연달아 불리는데 그때마다 setData를 다시 하면 낭비다.
function syncPineBarColors(){
  const bars = state.currentBars || [];
  const next = new Map();
  state.pineScripts.forEach(s => {
    if(s.hidden || !s.enabled) return;
    const active = state.pineActive.get(s.id);
    if(!active || !active.lastResult) return;
    (active.lastResult.barcolors || []).forEach(rec => {
      for(let i = 0; i < bars.length; i++){
        const c = rec.values[i];
        if(!c) continue; // na인 봉은 기본 색 유지
        const idx = i + (rec.offset || 0);
        if(idx < 0 || idx >= bars.length) continue;
        next.set(bars[idx].time, c); // 같은 봉에 여러 barcolor()가 걸리면 나중 것이 이긴다(실제 Pine과 동일)
      }
    });
  });
  let changed = next.size !== pineBarColors.size;
  if(!changed){
    for(const [time, color] of next){ if(pineBarColors.get(time) !== color){ changed = true; break; } }
  }
  pineBarColors = next;
  if(changed) repaintMainSeries(); // chart-series.js — setData만 다시 하는 가벼운 버전
}

// ---------- Pine table.new / table.cell 렌더링 ----------
// line/box/label과 달리 표는 "봉 좌표에 붙는 도형"이 아니라 차트 모서리에 고정되는 UI라서,
// 드로잉 캔버스에 그리지 않고 HTML 오버레이 div로 그린다(글꼴/정렬/툴팁이 자연스럽고, 텍스트가
// 캔버스보다 훨씬 선명하다). 9개 위치(position.*)마다 "구역(zone)" div를 하나씩 만들어 두고,
// 같은 자리에 표가 여러 개면 세로로 쌓는다.
const PINE_TABLE_FONT_SIZES = { tiny: 8, small: 9, normal: 11, large: 14, huge: 18 };
function pineTableFontSize(v){
  if(typeof v === 'string'){
    for(const key in PINE_TABLE_FONT_SIZES){ if(v.includes(key)) return PINE_TABLE_FONT_SIZES[key]; }
  }
  return PINE_TABLE_FONT_SIZES.normal; // size.auto 포함 — 기본 크기로 처리
}
// text.align_left / 'left' 처럼 상수든 맨 문자열이든 같은 값으로 해석된다.
// 셀은 flex 컨테이너라 가로 정렬은 justify-content로 잡아야 한다(text-align은 여러 줄 텍스트용으로 같이 지정).
function pineTableHalign(v){
  if(typeof v === 'string'){
    if(v.includes('left')) return { justify: 'flex-start', text: 'left' };
    if(v.includes('right')) return { justify: 'flex-end', text: 'right' };
  }
  return { justify: 'center', text: 'center' };
}
function pineTableValign(v){
  if(typeof v === 'string'){
    if(v.includes('top')) return 'flex-start';
    if(v.includes('bottom')) return 'flex-end';
  }
  return 'center';
}
function pineTablePosition(v){
  const s = typeof v === 'string' ? v : 'top_right';
  return {
    vert: s.includes('bottom') ? 'bottom' : s.includes('middle') ? 'middle' : 'top',
    horz: s.includes('left') ? 'left' : s.includes('center') ? 'center' : 'right',
  };
}
// 구역 div는 필요할 때만 만들고(9개를 미리 다 만들지 않음) 호스트별로 재사용한다.
function getPineTableZone(hostEl, vert, horz){
  const sel = `.pine-table-zone[data-v="${vert}"][data-h="${horz}"]`;
  let zone = hostEl.querySelector(':scope > ' + sel);
  if(!zone){
    zone = document.createElement('div');
    zone.className = 'pine-table-zone';
    zone.dataset.v = vert;
    zone.dataset.h = horz;
    hostEl.appendChild(zone);
  }
  return zone;
}
// 표 하나를 DOM으로 만든다. 색/글자는 전부 DOM 속성(textContent, style.*)으로만 넣는다 —
// 스크립트가 준 문자열을 innerHTML로 조립하면 그대로 마크업 주입 경로가 되기 때문.
function buildPineTableEl(tbl){
  // 선언한 크기(columns x rows) 중 "실제로 채워진 범위"까지만 그린다. 10행짜리로 선언해놓고
  // 3행만 채우는 스크립트가 흔한데, 선언대로 다 그리면 빈 행이 그만큼 여백으로 남는다.
  let maxCol = -1, maxRow = -1;
  tbl.cells.forEach((_, key) => {
    const [c, r] = key.split(',').map(Number);
    if(Number.isFinite(c) && c > maxCol) maxCol = c;
    if(Number.isFinite(r) && r > maxRow) maxRow = r;
  });
  if(maxCol < 0 || maxRow < 0) return null; // 셀이 하나도 없으면 빈 상자를 띄우지 않는다
  const cols = Math.min(Math.max(1, Math.round(pineNum(tbl.columns)) || 1), maxCol + 1);
  const rows = Math.min(Math.max(1, Math.round(pineNum(tbl.rows)) || 1), maxRow + 1);

  const el = document.createElement('div');
  el.className = 'pine-table';
  el.style.gridTemplateColumns = `repeat(${cols}, auto)`;
  if(tbl.bgcolor) el.style.background = tbl.bgcolor;
  const frame = tbl.framecolor || tbl.bordercolor;
  if(frame) el.style.border = '1px solid ' + frame;

  for(let r = 0; r < rows; r++){
    for(let c = 0; c < cols; c++){
      const cellEl = document.createElement('div');
      cellEl.className = 'pine-table-cell';
      const cell = tbl.cells.get(c + ',' + r);
      if(cell){
        cellEl.textContent = cell.text == null ? '' : String(cell.text);
        cellEl.style.color = cell.textColor || '#d1d4dc';
        cellEl.style.fontSize = pineTableFontSize(cell.textSize) + 'px';
        const halign = pineTableHalign(cell.halign);
        cellEl.style.justifyContent = halign.justify;
        cellEl.style.textAlign = halign.text;
        cellEl.style.alignItems = pineTableValign(cell.valign);
        if(cell.bgcolor) cellEl.style.background = cell.bgcolor;
        if(cell.tooltip) cellEl.title = String(cell.tooltip);
      }
      el.appendChild(cellEl);
    }
  }
  return el;
}
// 이 스크립트가 만들어둔 표 DOM만 골라 지운다(다른 스크립트의 표는 그대로 둔다).
function clearPineTables(active){
  (active.tableEls || []).forEach(el => { if(el.parentNode) el.parentNode.removeChild(el); });
  active.tableEls = [];
}
function renderPineTables(script, active, tables){
  clearPineTables(active);
  // 눈 아이콘으로 숨긴 스크립트는 표도 같이 숨긴다(계산은 계속 돌아간다 — 다른 지표와 동일한 규칙)
  if(script.hidden || !tables || !tables.length) return;
  // overlay 스크립트는 메인 차트 위에, 전용 패널 스크립트는 그 패널 위에 붙인다.
  const hostEl = active.pane ? active.pane.wrap : chartWrapEl;
  tables.forEach(tbl => {
    if(tbl.deleted) return;
    const el = buildPineTableEl(tbl);
    if(!el) return;
    const { vert, horz } = pineTablePosition(tbl.position);
    getPineTableZone(hostEl, vert, horz).appendChild(el);
    active.tableEls.push(el);
  });
  updatePineTableInsets();
}
// 표가 오른쪽/왼쪽 가격축 위로 걸치지 않게, 축 폭만큼 안쪽으로 밀어준다. 가격축 폭은 표시되는
// 숫자 자릿수에 따라(그리고 Pine 패널이 열리면 minimumWidth 동기화 때문에) 수시로 바뀌므로,
// drawings.js의 오버레이 루프에서 매 프레임 확인한다 — 표가 하나도 없으면 즉시 반환한다.
function updatePineTableInsets(){
  const zones = document.querySelectorAll('.pine-table-zone');
  if(!zones.length) return;
  zones.forEach(zone => {
    // 메인 차트 구역인지 Pine 패널 구역인지에 따라 참조할 차트가 다르다
    const paneWrap = zone.parentElement && zone.parentElement.classList.contains('pine-pane') ? zone.parentElement : null;
    let right = 0, left = 0;
    if(paneWrap){
      const pane = [...state.pineActive.values()].map(a => a.pane).find(p => p && p.wrap === paneWrap);
      if(pane){ try{ right = pane.chart.priceScale('right').width() || 0; }catch(e){} }
    }else{
      right = rightScaleOffset(); // drawings.js
      left = leftScaleOffset();
    }
    if(zone.dataset.h === 'right') zone.style.right = (right + 8) + 'px';
    else if(zone.dataset.h === 'left') zone.style.left = (left + 8) + 'px';
  });
}
// 패널이 통째로 사라질 때 그 안의 구역 div도 같이 없어지므로 따로 정리할 필요가 없지만,
// 메인 차트 쪽 구역은 남으므로 비어 있으면 치운다.
function pruneEmptyPineTableZones(){
  document.querySelectorAll('.pine-table-zone').forEach(zone => {
    if(!zone.children.length && zone.parentNode) zone.parentNode.removeChild(zone);
  });
}

// ---------- Pine 그리기 객체(line.new/box.new/label.new) 렌더링 ----------
// lightweight-charts엔 "임의의 시간~시간, 가격~가격 사이에 도형을 그려라" 같은 기능이 없어서,
// 이 앱에 이미 있는 사용자 드로잉 도구용 캔버스 오버레이(drawings.js의 #drawOverlay)에 얹어서 그린다.
// overlay=true 인 스크립트만 지원한다 (전용 패널 스크립트는 좌표계가 달라 범위 밖).
let pineDrawRevision = 0;
function pineDrawRevisionValue(){ return pineDrawRevision; }
function pineHasActiveDrawings(){
  for(const s of state.pineScripts){
    if(s.hidden) continue;
    const active = state.pineActive.get(s.id);
    if(active && active.drawObjects && (active.drawObjects.lines.length || active.drawObjects.boxes.length || active.drawObjects.labels.length || (active.drawObjects.shapes && active.drawObjects.shapes.length) || (active.drawObjects.crossMarkers && active.drawObjects.crossMarkers.length))) return true;
  }
  return false;
}
function drawAllPineOverlayObjects(){
  if(!state.chart || !state.candleSeries) return;
  state.pineScripts.forEach(s => {
    if(s.hidden) return;
    const active = state.pineActive.get(s.id);
    if(!active || !active.drawObjects) return;
    drawPineLines(active.drawObjects.lines);
    drawPineBoxes(active.drawObjects.boxes);
    drawPineLabels(active.drawObjects.labels);
    if(active.drawObjects.shapes && active.drawObjects.shapes.length) drawPineShapes(active.drawObjects.shapes, state.currentBars || []);
    if(active.drawObjects.crossMarkers && active.drawObjects.crossMarkers.length) drawPineCrossMarkers(active.drawObjects.crossMarkers);
  });
}
// style=cross/circles 마커 — 메인 차트는 이미 있는 드로잉 오버레이 캔버스에 작은 원을 직접 찍는다
// (lightweight-charts의 setMarkers size 옵션은 사실상 작동하지 않아서 못 쓴다)
function drawPineCrossMarkers(markers){
  const ctx = drawOverlayCtx;
  markers.forEach(m => {
    const p = drawPointToCanvasPixel({ time: m.time, price: m.value });
    if(!p) return;
    ctx.beginPath();
    ctx.arc(p.x, p.y, m.size || 2, 0, Math.PI * 2);
    ctx.fillStyle = m.color || '#787b86';
    ctx.fill();
  });
}
function pineExtendPoints(p1, p2, extend){
  if(!extend || extend === 'none') return [p1, p2];
  const leftEdge = leftScaleOffset();
  const rightEdge = overlayW - rightScaleOffset();
  // 중요: Pine의 extend.left/right는 "화면상 왼쪽/오른쪽"이 아니라 "point1을 늘리느냐(left) /
  // point2를 늘리느냐(right)"의 개념이다. point1이 point2보다 시간상 더 나중일 수도 있어서
  // (예: x1=bar_index, x2=bar_index-1처럼 순서를 거꾸로 주는 스크립트도 흔함), 실제로 어느 쪽
  // 화면 가장자리로 늘어날지는 두 점의 상대 위치에 따라 달라진다 — 무조건 왼쪽/오른쪽이 아니다.
  function rayTo(from, dirDx, dirDy){
    if(Math.abs(dirDx) < 0.001) return { x: from.x, y: from.y };
    const targetX = dirDx > 0 ? rightEdge : leftEdge;
    const t = (targetX - from.x) / dirDx;
    return { x: targetX, y: from.y + t * dirDy };
  }
  let a = p1, b = p2;
  if(extend === 'left' || extend === 'both') a = rayTo(p1, p1.x - p2.x, p1.y - p2.y);
  if(extend === 'right' || extend === 'both') b = rayTo(p2, p2.x - p1.x, p2.y - p1.y);
  return [a, b];
}
function drawPineLines(lines){
  const ctx = drawOverlayCtx;
  const leftEdge = leftScaleOffset();
  const rightEdge = overlayW - rightScaleOffset();
  ctx.save();
  // 캔버스(#drawOverlay)가 차트 플롯 영역뿐 아니라 가격축 폭까지 덮고 있어서, 그냥 두면 미래/과거로
  // 투영된 좌표(예: last_bar_time + N*(time-time[1]))가 캔버스 자체의 가장자리보다 안쪽이라 아무렇지
  // 않게 가격축 위에 그려진다. clip으로 그리기 가능 영역을 [leftEdge, rightEdge]로 실제로 제한해서,
  // 그 경계를 넘어가는 부분은 좌표를 억지로 누르지 않고 실제 TradingView처럼 그냥 안 보이게 한다.
  ctx.beginPath();
  ctx.rect(leftEdge, 0, Math.max(0, rightEdge - leftEdge), overlayH);
  ctx.clip();
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
  ctx.restore();
}
function drawPineBoxes(boxes){
  const ctx = drawOverlayCtx;
  const leftEdge = leftScaleOffset();
  const rightEdge = overlayW - rightScaleOffset();
  ctx.save();
  ctx.beginPath();
  ctx.rect(leftEdge, 0, Math.max(0, rightEdge - leftEdge), overlayH);
  ctx.clip();
  boxes.forEach(b => {
    if(b.deleted) return;
    let p1 = drawPointToCanvasPixel({ time: b.x1, price: b.y1 });
    let p2 = drawPointToCanvasPixel({ time: b.x2, price: b.y2 });
    if(!p1 || !p2) return;
    // line과 동일한 이유로: extend.left는 무조건 p1을, extend.right는 무조건 p2를 늘린다
    // (어느 화면 가장자리로 갈지는 두 점의 상대 위치에 따라 정해짐 — 화면상 왼쪽/오른쪽 고정 아님)
    const p1GoesRight = (p1.x - p2.x) >= 0, p2GoesRight = (p2.x - p1.x) >= 0;
    if(b.extend === 'left' || b.extend === 'both'){ p1 = { x: p1GoesRight ? rightEdge : leftEdge, y: p1.y }; }
    if(b.extend === 'right' || b.extend === 'both'){ p2 = { x: p2GoesRight ? rightEdge : leftEdge, y: p2.y }; }
    const x = Math.min(p1.x, p2.x), y = Math.min(p1.y, p2.y), w = Math.abs(p2.x - p1.x), h = Math.abs(p2.y - p1.y);
    ctx.save();
    if(b.bgcolor){ ctx.fillStyle = b.bgcolor; ctx.fillRect(x, y, w, h); }
    if(b.bordercolor){ ctx.strokeStyle = b.bordercolor; ctx.lineWidth = 1; ctx.strokeRect(x, y, w, h); }
    if(b.text){ ctx.font = '10px JetBrains Mono, monospace'; ctx.fillStyle = b.textcolor || '#ffffff'; ctx.fillText(b.text, x + 4, y + 12); }
    ctx.restore();
  });
  ctx.restore();
}
function drawPineLabels(labels){
  const ctx = drawOverlayCtx;
  const leftEdge = leftScaleOffset();
  const rightEdge = overlayW - rightScaleOffset();
  ctx.save();
  // line/box와 동일한 이유 — clip으로 그리기 영역을 가격축 앞까지로 실제 제한해서, 라벨이 그 경계를
  // 넘어가면(가격축을 벽처럼 붙잡고 쌓이는 게 아니라) 실제 TradingView처럼 자연스럽게 안 보이게 한다.
  ctx.beginPath();
  ctx.rect(leftEdge, 0, Math.max(0, rightEdge - leftEdge), overlayH);
  ctx.clip();
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
    // label.new(..., color=na, ...)는 "배경 없음"을 뜻한다(실제 Pine에서도 텍스트만 보이는
    // 라벨을 만들 때 흔히 씀) — lb.color가 정확히 null이면 배경 사각형 자체를 그리지 않는다.
    // color를 아예 안 준 경우엔 label.new에서 이미 기본 회색을 채워주므로 여기선 구분할 필요 없음.
    if(lb.color){ ctx.fillStyle = lb.color; ctx.fillRect(bx, by, boxW, boxH); }
    ctx.fillStyle = lb.textcolor || '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, bx + padX, by + boxH / 2);
    ctx.restore();
  });
  ctx.restore();
}
// plotshape()/plotchar() — 값이 "찍힌" 봉마다 화면에 작은 도형/글자를 그린다.
// overlay 스크립트는 캔버스에 직접, location=absolute면 그 값 자체를 가격으로 쓰고
// 아니면 그 봉의 고가/저가 위아래에 여백을 두고 그린다.
function pineShapeTriggered(v){ return v === true || (typeof v === 'number' && Number.isFinite(v)); }
function drawShapeMarker(ctx, p, sh){
  ctx.save();
  ctx.fillStyle = sh.color || '#2962ff';
  ctx.strokeStyle = sh.color || '#2962ff';
  const sz = 5;
  switch(sh.style){
    case 'triangleup': ctx.beginPath(); ctx.moveTo(p.x, p.y - sz); ctx.lineTo(p.x - sz, p.y + sz); ctx.lineTo(p.x + sz, p.y + sz); ctx.closePath(); ctx.fill(); break;
    case 'triangledown': ctx.beginPath(); ctx.moveTo(p.x, p.y + sz); ctx.lineTo(p.x - sz, p.y - sz); ctx.lineTo(p.x + sz, p.y - sz); ctx.closePath(); ctx.fill(); break;
    case 'square': ctx.fillRect(p.x - sz, p.y - sz, sz * 2, sz * 2); break;
    case 'diamond': ctx.beginPath(); ctx.moveTo(p.x, p.y - sz); ctx.lineTo(p.x + sz, p.y); ctx.lineTo(p.x, p.y + sz); ctx.lineTo(p.x - sz, p.y); ctx.closePath(); ctx.fill(); break;
    case 'xcross': ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(p.x - sz, p.y - sz); ctx.lineTo(p.x + sz, p.y + sz); ctx.moveTo(p.x + sz, p.y - sz); ctx.lineTo(p.x - sz, p.y + sz); ctx.stroke(); break;
    case 'cross': ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(p.x - sz, p.y); ctx.lineTo(p.x + sz, p.y); ctx.moveTo(p.x, p.y - sz); ctx.lineTo(p.x, p.y + sz); ctx.stroke(); break;
    case 'arrowup': ctx.beginPath(); ctx.moveTo(p.x, p.y - sz); ctx.lineTo(p.x - sz * 0.7, p.y); ctx.lineTo(p.x + sz * 0.7, p.y); ctx.closePath(); ctx.fill(); ctx.fillRect(p.x - 1.5, p.y, 3, sz); break;
    case 'arrowdown': ctx.beginPath(); ctx.moveTo(p.x, p.y + sz); ctx.lineTo(p.x - sz * 0.7, p.y); ctx.lineTo(p.x + sz * 0.7, p.y); ctx.closePath(); ctx.fill(); ctx.fillRect(p.x - 1.5, p.y - sz, 3, sz); break;
    case 'labelup': case 'labeldown': {
      ctx.font = '9px JetBrains Mono, monospace';
      const text = sh.text || '';
      const tw = ctx.measureText(text).width;
      const padX = 4, boxW = tw + padX * 2, boxH = 13;
      const bx = p.x - boxW / 2;
      const by = sh.style === 'labelup' ? p.y : p.y - boxH;
      ctx.fillStyle = sh.color || 'rgba(30,34,42,0.9)';
      ctx.fillRect(bx, by, boxW, boxH);
      ctx.fillStyle = sh.textcolor || '#ffffff';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, bx + padX, by + boxH / 2);
      ctx.restore();
      return; // labelup/down은 텍스트를 박스 안에 이미 그렸으니 아래 공용 텍스트 처리를 또 하지 않는다
    }
    case 'char': {
      if(!sh.char || sh.char === ' ') { ctx.restore(); return; } // 공백 문자는 실제 Pine에서도 데이터 창 전용 트릭이라 안 그림
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(sh.char, p.x, p.y);
      ctx.textAlign = 'start';
      ctx.restore();
      return;
    }
    default: ctx.beginPath(); ctx.arc(p.x, p.y, sz * 0.6, 0, Math.PI * 2); ctx.fill();
  }
  // triangleup/down, square, diamond, cross류 도형들은 옆에 text= 로 준 라벨을 따로 그려줘야
  // 실제 plotshape()처럼 도형+글자가 같이 보인다 (지금까지는 도형만 그리고 글자를 빼먹고 있었음)
  if(sh.text){
    ctx.font = '9px JetBrains Mono, monospace';
    ctx.fillStyle = sh.textcolor || sh.color || '#ffffff';
    const below = sh.location === 'belowbar' || sh.style === 'triangledown';
    ctx.textAlign = 'center';
    ctx.textBaseline = below ? 'top' : 'bottom';
    ctx.fillText(sh.text, p.x, below ? p.y + sz + 2 : p.y - sz - 2);
    ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
  }
  ctx.restore();
}
function drawPineShapes(shapes, bars){
  const ctx = drawOverlayCtx;
  const leftEdge = leftScaleOffset();
  const rightEdge = overlayW - rightScaleOffset();
  ctx.save();
  // line/box/label과 동일한 이유 — 오버레이 캔버스가 가격축 폭까지 덮고 있어서, clip 없이 그리면
  // 플롯 영역 경계에 걸친 도형(라벨 박스처럼 실제 픽셀 너비가 있는 것들)이 가격축 위까지 그려진다.
  ctx.beginPath();
  ctx.rect(leftEdge, 0, Math.max(0, rightEdge - leftEdge), overlayH);
  ctx.clip();
  shapes.forEach(sh => {
    for(let i = 0; i < bars.length; i++){
      const v = sh.values[i];
      if(!pineShapeTriggered(v)) continue;
      const idx = i + (sh.offset || 0);
      if(idx < 0 || idx >= bars.length) continue;
      const bar = bars[idx];
      const pad = Math.max(0.0001, (bar.high - bar.low) * 0.2);
      let price;
      if(sh.location === 'absolute' && typeof v === 'number') price = v;
      else if(sh.location === 'belowbar') price = bar.low - pad;
      else price = bar.high + pad;
      const p = drawPointToCanvasPixel({ time: bar.time, price });
      if(!p) continue;
      drawShapeMarker(ctx, p, sh);
    }
  });
  ctx.restore();
}
// 별도 패널 스크립트는 캔버스가 없으니 lightweight-charts 자체 마커 기능(setMarkers)을 쓴다 —
// 그 패널의 plot 라인 중 하나에 마커를 붙이면 가격축과 무관하게 시간축 위치에 자동으로 붙는다.
function pineMarkerShapeFor(style){
  if(style === 'triangleup' || style === 'arrowup' || style === 'labelup') return 'arrowUp';
  if(style === 'triangledown' || style === 'arrowdown' || style === 'labeldown') return 'arrowDown';
  if(style === 'square') return 'square';
  return 'circle';
}
function applyPaneShapeMarkers(pane, shapes, bars){
  const anchor = getPaneAnchor(pane, bars);
  const markers = [];
  shapes.forEach(sh => {
    for(let i = 0; i < bars.length; i++){
      const v = sh.values[i];
      if(!pineShapeTriggered(v)) continue;
      const idx = i + (sh.offset || 0);
      if(idx < 0 || idx >= bars.length) continue;
      if(sh.style === 'char' && (!sh.char || sh.char === ' ')) continue;
      const isDown = sh.location === 'belowbar' || sh.style === 'triangledown' || sh.style === 'arrowdown' || sh.style === 'labeldown';
      markers.push({
        time: bars[idx].time, position: isDown ? 'belowBar' : 'aboveBar',
        color: sh.color || '#2962ff', shape: pineMarkerShapeFor(sh.style),
        text: sh.text || sh.char || undefined,
      });
    }
  });
  markers.sort((a, b) => a.time - b.time);
  try{ anchor.setMarkers(markers); }catch(e){}
}

// ---------- 시작 시 저장된 스크립트 복원 ----------
renderPineScriptsList();
