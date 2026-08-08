/* drawings.js
   Drawing tools (pen, trend line, h-line, fib, rect, image, text). */

// ---------- 그리기 도구 (트렌드라인/수평선/피보나치/사각형/텍스트) ----------
// lightweight-charts엔 드로잉 툴이 없어서, 볼륨캔들1과 같은 방식으로 별도 <canvas> 오버레이에
// 직접 그린다. 도형의 좌표는 항상 (time, price) 도메인으로 저장해두고, 매 프레임 현재 차트의
// timeToCoordinate/priceToCoordinate로 픽셀 좌표를 다시 계산해서 그리기 때문에, 스크롤/줌을 해도
// 도형이 캔들과 함께 올바른 자리에 따라다닌다.
const drawOverlayCanvas = document.getElementById('drawOverlay');
const drawOverlayCtx = drawOverlayCanvas.getContext('2d');
// 팝업 요소들도 여기서 먼저 선언해둔다 — 아래 drawOverlayLoop가 즉시 실행(IIFE)되면서
// updateDrawOptionsPopup()을 바로 호출하는데, 그 함수가 이 const들을 참조하기 때문에
// (아래쪽, 나중에 선언하면 TDZ 에러가 나서 스크립트 전체가 거기서 멈춰버린다 — 실제로 겪은 버그)
const drawOptionsPopup = document.getElementById('drawOptionsPopup');
const drawOptColorInput = document.getElementById('drawOptColor');
const drawOptDashBtn = document.getElementById('drawOptDash');
function getSelectedDrawing(){
  return state.drawings.find(d => d.id === state.drawSelectedId) || null;
}

// 오버레이 캔버스의 CSS 크기. getBoundingClientRect()는 레이아웃을 강제로 계산시키는(reflow)
// 호출이라 렌더 루프 안에서 매 프레임 부르면 안 된다. ResizeObserver가 바뀔 때만 갱신해두고
// 나머지 코드는 이 값을 읽어 쓴다.
let overlayW = 0, overlayH = 0;
function resizeDrawOverlay(){
  const rect = chartEl.getBoundingClientRect();
  overlayW = rect.width; overlayH = rect.height;
  const dpr = window.devicePixelRatio || 1;
  drawOverlayCanvas.width = Math.max(1, Math.round(rect.width * dpr));
  drawOverlayCanvas.height = Math.max(1, Math.round(rect.height * dpr));
  drawOverlayCanvas.style.width = rect.width + 'px';
  drawOverlayCanvas.style.height = rect.height + 'px';
  drawOverlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
new ResizeObserver(() => { resizeDrawOverlay(); markDrawingsDirty(); }).observe(chartEl);

// 지금은 왼쪽 가격축(거래량용)을 화면에서 숨겨뒀지만(chart-init.js), 혹시라도 나중에 다시
// 켜지는 경우를 대비해 이 보정은 그대로 남겨둔다. lightweight-charts의 timeToCoordinate/
// priceToCoordinate와 클릭 이벤트의 param.point는 전부 "플롯 영역 기준"(왼쪽 가격축 폭만큼 뺀)
// 좌표를 주는데, 우리 캔버스(#drawOverlay)는 #chart 박스 전체를 덮고 있어서(왼쪽 가격축
// 영역까지 포함) 그대로 그리면 왼쪽 가격축 폭만큼 밀려 보인다. 지금처럼 왼쪽 축이 숨겨져
// width()가 0을 반환하는 동안은 이 함수도 항상 0을 돌려주므로 사실상 no-op이다.
function leftScaleOffset(){
  if(!state.chart) return 0;
  try{ return state.chart.priceScale('left').width() || 0; }catch(e){ return 0; }
}
function rightScaleOffset(){
  if(!state.chart) return 0;
  try{ return state.chart.priceScale('right').width() || 0; }catch(e){ return 0; }
}
// resolveTimeForX()의 반대 방향: 아직 캔들이 없는 미래(또는 로드 안 된 과거) 시각이면
// timeToCoordinate()가 null을 주기 때문에(실제 데이터가 있는 시각만 좌표로 바꿔주는 함수라서),
// 마지막/첫 봉의 간격을 이용해 논리 인덱스를 역산하고 logicalToCoordinate()로 좌표를 구한다.
// 그림을 미래 빈 공간에 그려도 "저장은 됐는데 화면엔 안 보이는" 상황이 안 생기게 하기 위함.
function resolveXForTime(time){
  if(!state.chart) return null;
  const ts = state.chart.timeScale();
  const x = ts.timeToCoordinate(time);
  if(x != null) return x;
  const bars = state.currentBars;
  if(!bars.length) return null;
  const lastIdx = bars.length - 1;
  const intervalSec = bars.length >= 2 ? (bars[lastIdx].time - bars[lastIdx - 1].time) : 60;
  let logical;
  if(time > bars[lastIdx].time){
    if(intervalSec <= 0) return null;
    logical = lastIdx + (time - bars[lastIdx].time) / intervalSec;
  } else if(time < bars[0].time){
    if(intervalSec <= 0) return null;
    logical = (time - bars[0].time) / intervalSec;
  } else {
    // 로드된 범위 "안"이지만 어떤 봉의 시각과도 정확히 일치하지 않는 경우 — 예를 들어 line.new에
    // x2 = x1+1(초)처럼 방향만 잡으려고 봉 시각이 아닌 임의의 시각을 쓰는 흔한 Pine 패턴.
    // timeToCoordinate()는 정확히 일치하는 봉만 좌표로 바꿔주고 그 사이(gap)는 무조건 null을
    // 주기 때문에, 그 시각을 감싸는 앞뒤 봉 두 개를 찾아 논리 인덱스를 선형보간한다.
    let lo = 0, hi = lastIdx;
    while(hi - lo > 1){
      const mid = (lo + hi) >> 1;
      if(bars[mid].time <= time) lo = mid; else hi = mid;
    }
    const step = bars[hi].time - bars[lo].time;
    logical = step > 0 ? lo + (time - bars[lo].time) / step : lo;
  }
  // lightweight-charts의 logicalToCoordinate()는 "정수" 논리 인덱스에서만 정확한 좌표를 주고,
  // 소수 인덱스를 그대로 넘기면 0을 돌려주는 라이브러리 자체 한계가 있다(버전 이슈로 보임 —
  // 미래/과거로 늘어난 그림이 항상 캔버스 맨 왼쪽으로 붙어버리는 문제가 여기서도 났었음).
  // 그래서 앞뒤 정수 인덱스 두 개의 좌표를 각각 구해서 우리가 직접 선형보간한다.
  const floorL = Math.floor(logical), frac = logical - floorL;
  if(frac === 0) return ts.logicalToCoordinate(floorL);
  const c0 = ts.logicalToCoordinate(floorL), c1 = ts.logicalToCoordinate(floorL + 1);
  if(c0 == null || c1 == null) return null;
  return c0 + (c1 - c0) * frac;
}
function drawPointToPixel(pt){
  if(!state.chart || !state.candleSeries) return null;
  const x = resolveXForTime(pt.time);
  const y = state.candleSeries.priceToCoordinate(pt.price);
  if(x == null || y == null) return null;
  return { x, y };
}
function drawPointToCanvasPixel(pt){
  const p = drawPointToPixel(pt);
  if(!p) return null;
  return { x: p.x + leftScaleOffset(), y: p.y };
}
const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const TEXT_BASE_FONT_SIZE = 14; // 텍스트 박스 리사이즈의 기준 폰트 크기 (박스 크기 비율만큼 이 크기에서 스케일됨)
function renderDrawings(){
  if(!state.chart || !state.candleSeries) return;
  drawOverlayCtx.clearRect(0, 0, overlayW, overlayH);
  const all = state.drawings.slice();
  if(state.drawDraft){
    const draft = { ...state.drawDraft, points: [...state.drawDraft.points] };
    if(state.drawPreviewPoint && (draft.type === 'trendline' || draft.type === 'fib' || draft.type === 'rect' || draft.type === 'image')){
      draft.points.push(state.drawPreviewPoint);
    }
    all.push(draft);
  }
  all.forEach(d => drawOneShape(d, d.id === state.drawSelectedId));
  if(typeof drawAllPineOverlayObjects === 'function') drawAllPineOverlayObjects();
}
function drawOneShape(d, selected){
  const ctx = drawOverlayCtx;
  const color = d.color || '#f6c309';
  const dash = d.dashed ? [6, 4] : [];
  const pts = d.points.map(drawPointToCanvasPixel);
  if(d.type === 'pen'){
    const valid = pts.filter(Boolean);
    if(valid.length < 2) return;
    ctx.strokeStyle = color; ctx.lineWidth = selected ? 3 : 2;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(valid[0].x, valid[0].y);
    for(let i = 1; i < valid.length; i++) ctx.lineTo(valid[i].x, valid[i].y);
    ctx.stroke();
  } else if(d.type === 'hline'){
    if(!pts[0]) return;
    ctx.strokeStyle = color; ctx.lineWidth = selected ? 3 : 2;
    ctx.setLineDash(dash);
    ctx.beginPath(); ctx.moveTo(0, pts[0].y); ctx.lineTo(overlayW, pts[0].y); ctx.stroke();
  } else if(d.type === 'trendline'){
    if(!pts[0] || !pts[1]) return;
    ctx.strokeStyle = color; ctx.lineWidth = selected ? 3.5 : 2.4;
    ctx.setLineDash(dash);
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(pts[1].x, pts[1].y); ctx.stroke();
  } else if(d.type === 'rect'){
    if(!pts[0] || !pts[1]) return;
    const x = Math.min(pts[0].x, pts[1].x), y = Math.min(pts[0].y, pts[1].y);
    const w = Math.abs(pts[1].x - pts[0].x), h = Math.abs(pts[1].y - pts[0].y);
    ctx.save();
    if(d.rotation){ const cx = x + w/2, cy = y + h/2; ctx.translate(cx, cy); ctx.rotate(d.rotation); ctx.translate(-cx, -cy); }
    ctx.fillStyle = color + '1f';
    ctx.strokeStyle = color; ctx.lineWidth = selected ? 2 : 1.3;
    ctx.setLineDash(dash);
    ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h);
    ctx.restore();
  } else if(d.type === 'image'){
    if(!pts[0] || !pts[1]) return;
    const x = Math.min(pts[0].x, pts[1].x), y = Math.min(pts[0].y, pts[1].y);
    const w = Math.abs(pts[1].x - pts[0].x), h = Math.abs(pts[1].y - pts[0].y);
    if(w < 1 || h < 1) return;
    ctx.save();
    if(d.rotation){ const cx = x + w/2, cy = y + h/2; ctx.translate(cx, cy); ctx.rotate(d.rotation); ctx.translate(-cx, -cy); }
    if(d.imgEl && d.imgEl.complete) ctx.drawImage(d.imgEl, x, y, w, h);
    if(selected){
      ctx.strokeStyle = color; ctx.lineWidth = 2;
      ctx.setLineDash(dash);
      ctx.strokeRect(x, y, w, h);
    }
    ctx.restore();
  } else if(d.type === 'fib'){
    if(!pts[0] || !pts[1] || !d.points[0] || !d.points[1]) return;
    const p0 = d.points[0].price, p1 = d.points[1].price;
    const xL = Math.min(pts[0].x, pts[1].x), xR = Math.max(pts[0].x, pts[1].x);
    ctx.font = '10.5px JetBrains Mono, monospace';
    FIB_LEVELS.forEach(level => {
      const price = p0 + (p1 - p0) * level;
      const y = state.candleSeries.priceToCoordinate(price);
      if(y == null) return;
      ctx.strokeStyle = level === 0 || level === 1 ? '#787B86' : color + 'a6';
      ctx.lineWidth = selected ? 2 : 1;
      ctx.setLineDash(dash);
      ctx.beginPath(); ctx.moveTo(xL, y); ctx.lineTo(xR, y); ctx.stroke();
      ctx.fillStyle = '#9aa3af';
      ctx.fillText(`${(level * 100).toFixed(1)}%  ${formatPrice(price)}`, xR + 4, y + 3);
    });
  } else if(d.type === 'text'){
    if(!pts[0] || !pts[1]) return;
    const x = Math.min(pts[0].x, pts[1].x), y = Math.min(pts[0].y, pts[1].y);
    const w = Math.abs(pts[1].x - pts[0].x), h = Math.abs(pts[1].y - pts[0].y);
    if(w < 4 || h < 4) return;
    const textStr = d.text || '';
    ctx.save();
    if(d.rotation){ const cx = x + w / 2, cy = y + h / 2; ctx.translate(cx, cy); ctx.rotate(d.rotation); ctx.translate(-cx, -cy); }
    if(selected){
      ctx.fillStyle = color + '26';
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
    }
    // 박스 크기에 맞춰 글자 크기도 같이 늘고 줄게: 기준 폰트 크기로 잰 자연스러운 크기(baseW,baseH) 대비
    // 지금 박스 크기의 비율만큼 캔버스 자체를 스케일해서 그 안에 기준 크기로 그린다.
    ctx.font = `${TEXT_BASE_FONT_SIZE}px JetBrains Mono, monospace`;
    const baseW = Math.max(1, ctx.measureText(textStr).width + 12);
    const baseH = TEXT_BASE_FONT_SIZE + 10;
    ctx.translate(x, y);
    ctx.scale(w / baseW, h / baseH);
    ctx.font = `${TEXT_BASE_FONT_SIZE}px JetBrains Mono, monospace`;
    ctx.fillStyle = selected ? color : '#e7e9ee';
    ctx.fillText(textStr, 6, TEXT_BASE_FONT_SIZE + 2);
    ctx.restore();
  }
  ctx.setLineDash([]);
  if(selected){
    if(d.type === 'rect' || d.type === 'image' || d.type === 'text'){
      drawResizeAndRotateHandles(d, color);
    } else if(d.type !== 'pen'){
      ctx.fillStyle = color;
      d.points.forEach(p => {
        const px = drawPointToCanvasPixel(p);
        if(!px) return;
        ctx.beginPath(); ctx.arc(px.x, px.y, 3.5, 0, Math.PI * 2); ctx.fill();
      });
    }
  }
}
// (x,y)를 중심(cx,cy) 기준으로 angle(라디안)만큼 회전시킨 좌표를 반환.
function rotatePoint(x, y, cx, cy, angle){
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const dx = x - cx, dy = y - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}
// rect/image의 캔버스 기준(화면에 실제 그려지는 좌표) 박스 + 중심점을 계산.
function shapeCanvasBox(d){
  const p0 = drawPointToCanvasPixel(d.points[0]);
  const p1 = drawPointToCanvasPixel(d.points[1]);
  if(!p0 || !p1) return null;
  const x = Math.min(p0.x, p1.x), y = Math.min(p0.y, p1.y);
  const w = Math.abs(p1.x - p0.x), h = Math.abs(p1.y - p0.y);
  return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
}
// 회전 적용 전(로컬) 박스 기준 4개 꼭짓점 (0:좌상 1:우상 2:우하 3:좌하)
function localCorners(box){
  return [
    { x: box.x, y: box.y }, { x: box.x + box.w, y: box.y },
    { x: box.x + box.w, y: box.y + box.h }, { x: box.x, y: box.y + box.h },
  ];
}
function rotationHandleLocalPos(box){
  return { x: box.cx, y: box.y - 26 };
}
function drawResizeAndRotateHandles(d, color){
  const box = shapeCanvasBox(d);
  if(!box) return;
  const ctx = drawOverlayCtx;
  const rot = d.rotation || 0;
  const corners = localCorners(box).map(c => rotatePoint(c.x, c.y, box.cx, box.cy, rot));
  const topMid = rotatePoint(box.cx, box.y, box.cx, box.cy, rot);
  const rotHandle = rotatePoint(rotationHandleLocalPos(box).x, rotationHandleLocalPos(box).y, box.cx, box.cy, rot);
  // 회전 핸들과 박스를 잇는 얇은 선
  ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash([]);
  ctx.beginPath(); ctx.moveTo(topMid.x, topMid.y); ctx.lineTo(rotHandle.x, rotHandle.y); ctx.stroke();
  // 리사이즈 핸들 (모서리 4개, 네모)
  ctx.fillStyle = color;
  corners.forEach(c => { ctx.fillRect(c.x - 4, c.y - 4, 8, 8); });
  // 회전 핸들 (동그라미)
  ctx.beginPath(); ctx.arc(rotHandle.x, rotHandle.y, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#0a0d12'; ctx.fill();
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
}
// ---------- 오버레이 렌더 루프 ----------
// 예전엔 이 루프가 조건 없이 매 프레임 renderDrawings() + updateDrawOptionsPopup()을 돌렸다.
// 그림이 하나도 없고 아무것도 안 하고 있어도 초당 60번 getBoundingClientRect()(reflow 유발) +
// clearRect + 팝업 위치 계산이 계속 돌아서, 가만히 놔둔 탭이 계속 CPU를 먹었다(노트북 배터리에 특히).
//
// 그렇다고 "그림이 있을 때만 그리기"로 단순히 바꾸면 안 된다 — 마지막 그림을 지운 다음 프레임에
// 렌더링이 통째로 스킵돼서 이미 그려진 픽셀이 유령처럼 남는 버그가 있었다(원래 주석 참고).
// 그래서 "지울 게 남아있는지"를 따로 기억하고(hasPaintedSomething), 화면 상태가 실제로 바뀐
// 프레임에만 다시 그린다. 바뀐 게 없으면 문자열 비교 한 번으로 끝난다.
let drawingsRevision = 0;
function markDrawingsDirty(){ drawingsRevision++; }
let lastRenderSignature = null;
let hasPaintedSomething = false;

// 차트를 스크롤/줌하면 도형도 같이 움직여야 하는데 lightweight-charts엔 "다시 그려졌다" 이벤트가
// 없다. 그래서 보이는 범위(시간축 + 가격축)를 싸게 요약해서, 그 값이 바뀌었을 때만 다시 그린다.
function viewSignature(){
  const range = state.chart.timeScale().getVisibleLogicalRange();
  const topPrice = state.candleSeries.coordinateToPrice(0);
  const bottomPrice = state.candleSeries.coordinateToPrice(overlayH);
  const draft = state.drawDraft;
  return (range ? range.from + ',' + range.to : '') + '|' +
    topPrice + ',' + bottomPrice + '|' + overlayW + ',' + overlayH + '|' +
    drawingsRevision + '|' + state.drawings.length + '|' + state.drawSelectedId + '|' +
    (draft ? draft.type + ',' + draft.points.length : '') + '|' +
    (state.drawPreviewPoint ? state.drawPreviewPoint.time + ',' + state.drawPreviewPoint.price : '') + '|' +
    (typeof pineDrawRevisionValue === 'function' ? pineDrawRevisionValue() : '');
}

function startOverlayLoop(){
  requestAnimationFrame(startOverlayLoop);
  updateBaselineValue(); // Baseline 유형일 때만 실제로 일하고, 아니면 즉시 반환한다
  updateVolumeAxisLabel(); // 오른쪽 가격축 위 거래량 뱃지 위치/값 갱신
  // Pine table.new() 오버레이가 가격축을 덮지 않도록 축 폭 변화를 따라가게 한다(표가 없으면 즉시 반환)
  if(typeof updatePineTableInsets === 'function') updatePineTableInsets();
  // 청산 히트맵도 같은 프레임 루프에 얹는다 — 아래 nothingToDraw 조기 반환은 도형 캔버스 전용이라
  // 그 앞에서 불러야 히트맵이 도형 유무와 무관하게 항상 갱신된다. 내부적으로 자체 dirty-check를 한다.
  if(typeof updateLiqHeatmapOverlay === 'function') updateLiqHeatmapOverlay();

  const nothingToDraw = !state.drawings.length && !state.drawDraft && !(typeof pineHasActiveDrawings === 'function' && pineHasActiveDrawings());
  if(nothingToDraw && !hasPaintedSomething){
    // 그릴 것도 없고 지울 것도 없다 -> 이 프레임은 통째로 건너뛴다 (여기가 평소의 기본 경로)
    return;
  }
  if(!state.chart || !state.candleSeries) return;

  const sig = viewSignature();
  if(sig === lastRenderSignature) return; // 화면이 그대로면 다시 그릴 이유가 없다
  lastRenderSignature = sig;

  renderDrawings();
  updateDrawOptionsPopup();
  hasPaintedSomething = !nothingToDraw;
}

function setDrawTool(tool){
  state.drawTool = tool;
  state.drawDraft = null;
  state.drawPreviewPoint = null;
  document.querySelectorAll('.draw-tool-btn[data-tool]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === tool);
  });
  drawOverlayCanvas.style.cursor = tool === 'cursor' ? 'default' : 'crosshair';
  // 펜은 클릭이 아니라 드래그로 그리기 때문에, 다른 도구들처럼 클릭을 차트로 그냥 통과시키면
  // (pointer-events:none) 안 되고, 오버레이 캔버스가 직접 마우스 이벤트를 받아야 한다.
  // 그 동안은 차트 자체의 팬(pressedMouseMove) 동작과 겹치지 않도록 오버레이가 이벤트를 가로챈다.
  drawOverlayCanvas.style.pointerEvents = tool === 'pen' ? 'auto' : 'none';
}
function addDrawing(draft){
  const d = { id: state.drawIdCounter++, type: draft.type, points: draft.points, text: draft.text, color: '#f6c309', dashed: false, imgEl: draft.imgEl || null, rotation: 0 };
  state.drawings.push(d);
  state.drawSelectedId = d.id; // 그리자마자 바로 선택된 상태로 만들어서 옵션 팝업이 바로 뜨게 함
}
// 커서 도구일 때 클릭한 화면 좌표 근처에 있는 도형을 찾아 선택한다 (선분과의 거리로 판정).
function distToSegment(px, py, x1, y1, x2, y2){
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}
function trySelectDrawingAt(x, y){
  const HIT = 10; // 예전엔 6px라 너무 빡빡했음 — 클릭이 잘 안 먹힌다는 피드백으로 넉넉하게 늘림
  const LINE_HIT = 14; // 선(추세선/수평선)은 두께가 사실상 0이라 폭 넓은 여유를 따로 준다
  for(let i = state.drawings.length - 1; i >= 0; i--){
    const d = state.drawings[i];
    const pts = d.points.map(drawPointToPixel);
    if(d.type === 'pen'){
      for(let k = 0; k < pts.length - 1; k++){
        if(pts[k] && pts[k + 1] && distToSegment(x, y, pts[k].x, pts[k].y, pts[k + 1].x, pts[k + 1].y) <= LINE_HIT){
          state.drawSelectedId = d.id; return;
        }
      }
    } else if(d.type === 'hline' && pts[0]){
      if(Math.abs(y - pts[0].y) <= LINE_HIT){ state.drawSelectedId = d.id; return; }
    } else if(d.type === 'trendline' && pts[0] && pts[1]){
      if(distToSegment(x, y, pts[0].x, pts[0].y, pts[1].x, pts[1].y) <= LINE_HIT){ state.drawSelectedId = d.id; return; }
    } else if((d.type === 'rect' || d.type === 'image' || d.type === 'text') && pts[0] && pts[1]){
      // 테두리 근처만이 아니라 사각형(이미지·텍스트 박스도 동일) 안쪽 어디를 눌러도 선택되게.
      // 회전된 도형이면, 클릭 좌표를 도형의 중심 기준으로 반대로 회전시켜서(로컬 좌표로 변환)
      // 비회전 사각형 판정과 똑같이 검사한다.
      const rx = Math.min(pts[0].x, pts[1].x), ry = Math.min(pts[0].y, pts[1].y);
      const rw = Math.abs(pts[1].x - pts[0].x), rh = Math.abs(pts[1].y - pts[0].y);
      let tx = x, ty = y;
      if(d.rotation){
        const cx = rx + rw / 2, cy = ry + rh / 2;
        const inv = rotatePoint(x, y, cx, cy, -d.rotation);
        tx = inv.x; ty = inv.y;
      }
      if(tx >= rx - HIT && tx <= rx + rw + HIT && ty >= ry - HIT && ty <= ry + rh + HIT){
        state.drawSelectedId = d.id; return;
      }
    } else if(d.type === 'fib' && pts[0] && pts[1] && d.points[0] && d.points[1]){
      // 정확히 레벨 선 위가 아니어도, 두 앵커 사이의 가격 구간(세로 밴드) 안이면 다 선택되게
      const xL = Math.min(pts[0].x, pts[1].x), xR = Math.max(pts[0].x, pts[1].x);
      const yTop = Math.min(pts[0].y, pts[1].y), yBottom = Math.max(pts[0].y, pts[1].y);
      if(x >= xL - HIT && x <= xR + HIT && y >= yTop - HIT && y <= yBottom + HIT){
        state.drawSelectedId = d.id; return;
      }
    }
  }
  state.drawSelectedId = null;
}
// Shift를 누르고 있으면 이미지 배치할 때 원본 비율을 유지한다.
let shiftPressed = false;
window.addEventListener('keydown', (e) => { if(e.key === 'Shift') shiftPressed = true; });
window.addEventListener('keyup', (e) => { if(e.key === 'Shift') shiftPressed = false; });
window.addEventListener('blur', () => { shiftPressed = false; }); // 다른 창으로 포커스 이동 시 눌린 채로 고정되는 것 방지
// 앵커점(첫 클릭) 기준으로, 지금 좌표를 주어진 가로세로 비율에 맞게 보정한다.
// 두 축 중 더 많이 움직인 쪽을 "기준"으로 삼고 나머지 축을 거기에 맞춰 계산한다.
// 사각형은 aspect=1(정사각형), 이미지는 원본 naturalWidth/naturalHeight 비율로 호출한다.
function constrainToAspect(anchorPt, rawPt, aspect){
  const p0 = drawPointToPixel(anchorPt);
  const p1 = drawPointToPixel(rawPt);
  if(!p0 || !p1 || !state.chart || !state.candleSeries) return rawPt;
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  let newDx = dx, newDy = dy;
  if(Math.abs(dx) / aspect >= Math.abs(dy)){
    newDy = (dy < 0 ? -1 : 1) * Math.abs(dx) / aspect;
  }else{
    newDx = (dx < 0 ? -1 : 1) * Math.abs(dy) * aspect;
  }
  const time = resolveTimeForX(p0.x + newDx);
  const price = state.candleSeries.coordinateToPrice(p0.y + newDy);
  if(time == null || price == null) return rawPt;
  return { time, price };
}
// 도형 타입에 맞는 가로세로 비율을 반환 (없으면 null = 비율 고정 없음)
function aspectForDraft(draft){
  if(draft.type === 'image' && draft.imgEl && draft.imgEl.naturalWidth && draft.imgEl.naturalHeight){
    return draft.imgEl.naturalWidth / draft.imgEl.naturalHeight;
  }
  if(draft.type === 'rect') return 1; // Shift = 정사각형
  return null;
}
function handleDrawCrosshairMove(param){
  if(!state.drawDraft || !param || !param.point || !state.candleSeries) return;
  const time = resolveTimeForX(param.point.x);
  if(time == null) return;
  const price = state.candleSeries.coordinateToPrice(param.point.y);
  if(price == null) return;
  let pt = { time, price };
  if(shiftPressed){
    const aspect = aspectForDraft(state.drawDraft);
    if(aspect != null) pt = constrainToAspect(state.drawDraft.points[0], pt, aspect);
  }
  state.drawPreviewPoint = pt;
}
function handleDrawClick(param){
  if(state.drawTool === 'cursor'){
    if(param && param.point) trySelectDrawingAt(param.point.x, param.point.y);
    else state.drawSelectedId = null;
    return;
  }
  if(!param || !param.point || !state.candleSeries) return;
  const time = resolveTimeForX(param.point.x);
  if(time == null) return;
  const price = state.candleSeries.coordinateToPrice(param.point.y);
  if(price == null) return;
  let pt = { time, price };

  if(state.drawTool === 'hline'){
    addDrawing({ type: 'hline', points: [pt] });
    setDrawTool('cursor');
    return;
  }
  if(state.drawTool === 'text'){
    const text = window.prompt(t('drawToolText') + ':', '');
    if(text){
      // 텍스트도 리사이즈/회전이 되도록 사각형처럼 점 2개(좌상단, 우하단)짜리 박스로 만든다.
      // 초기 크기는 기준 폰트 크기로 잰 자연스러운 글자 크기로 자동 계산한다.
      drawOverlayCtx.font = `${TEXT_BASE_FONT_SIZE}px JetBrains Mono, monospace`;
      const w = drawOverlayCtx.measureText(text).width + 12;
      const h = TEXT_BASE_FONT_SIZE + 10;
      const pxAnchor = drawPointToCanvasPixel(pt);
      const pt2 = pxAnchor ? (canvasXYToDomain(pxAnchor.x + w, pxAnchor.y + h) || pt) : pt;
      addDrawing({ type: 'text', points: [pt, pt2], text });
    }
    setDrawTool('cursor');
    return;
  }
  // 2점짜리 도구: trendline / fib / rect / image
  if(!state.drawDraft){
    state.drawDraft = { type: state.drawTool, points: [pt] };
    if(state.drawTool === 'image') state.drawDraft.imgEl = pendingImageEl;
  }else{
    if(shiftPressed){
      const aspect = aspectForDraft(state.drawDraft);
      if(aspect != null) pt = constrainToAspect(state.drawDraft.points[0], pt, aspect);
    }
    const extra = state.drawDraft.type === 'image' ? { imgEl: state.drawDraft.imgEl } : {};
    addDrawing({ type: state.drawDraft.type, points: [state.drawDraft.points[0], pt], ...extra });
    state.drawDraft = null;
    state.drawPreviewPoint = null;
    setDrawTool('cursor');
  }
}
// ---------- 펜(자유선) 도구 ----------
// 다른 도구들은 클릭 기반(state.chart.subscribeClick)이지만, 펜은 드래그로 그려야 해서
// 오버레이 캔버스에 직접 마우스 이벤트를 건다 (펜 도구일 때만 오버레이가 pointer-events:auto가
// 되도록 setDrawTool에서 이미 처리해둠 — 그래야 이 이벤트들이 캔버스에 도달한다).
function domEventToDomainPoint(e){
  if(!state.chart || !state.candleSeries) return null;
  const rect = chartEl.getBoundingClientRect();
  const canvasX = e.clientX - rect.left;
  const canvasY = e.clientY - rect.top;
  const plotX = canvasX - leftScaleOffset(); // 왼쪽 가격축 폭만큼 빼야 lightweight-charts 좌표계와 맞음
  const time = resolveTimeForX(plotX);
  const price = state.candleSeries.coordinateToPrice(canvasY);
  if(time == null || price == null) return null;
  return { time, price };
}
let penDragging = false;
drawOverlayCanvas.addEventListener('mousedown', (e) => {
  if(state.drawTool !== 'pen') return;
  const pt = domEventToDomainPoint(e);
  if(!pt) return;
  penDragging = true;
  state.drawDraft = { type: 'pen', points: [pt] };
  markDrawingsDirty();
  e.preventDefault();
});
drawOverlayCanvas.addEventListener('mousemove', (e) => {
  if(state.drawTool !== 'pen' || !penDragging || !state.drawDraft) return;
  const pt = domEventToDomainPoint(e);
  if(!pt) return;
  state.drawDraft.points.push(pt);
});
function finishPenStroke(){
  if(!penDragging) return;
  penDragging = false;
  if(state.drawDraft && state.drawDraft.points.length > 1){
    addDrawing({ type: 'pen', points: state.drawDraft.points });
  }
  state.drawDraft = null;
  setDrawTool('cursor');
}
drawOverlayCanvas.addEventListener('mouseup', finishPenStroke);
drawOverlayCanvas.addEventListener('mouseleave', finishPenStroke);

// ---------- 선택된 사각형/이미지/피보나치의 꼭짓점을 드래그해서 크기 조절 + 회전 ----------
// 클릭 기반(subscribeClick)이 아니라 드래그가 필요해서, #chart에 직접(캡처 단계) mousedown을
// 걸어 lightweight-charts 자체의 팬(화면 이동) 로직보다 먼저 가로챈다. 핸들 위가 아니면 그냥
// 아무것도 안 하고 흘려보내서 평소 팬/줌은 그대로 동작한다.
let activeShapeDrag = null; // { type:'resize'|'rotate'|'move', drawingId, cornerIdx?, pointIndex?, lastX?, lastY? }
function eventToCanvasXY(e){
  const rect = chartEl.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}
// lightweight-charts의 coordinateToTime()은 "아직 캔들이 없는 미래(또는 로드 안 된 과거) 빈 공간"에서는
// null을 준다 (실제 데이터가 있는 자리에만 시간을 매핑해주기 때문) — 그래서 그 구간엔 아무것도 못
// 그리는 버그가 있었다. coordinateToLogical()은 그런 빈 공간에서도 계속 연속적인 "논리 인덱스"를
// 주기 때문에, 마지막(또는 첫) 봉의 간격을 이용해서 그 인덱스에 해당하는 시간을 직접 계산해준다.
function resolveTimeForX(plotX){
  if(!state.chart) return null;
  const time = state.chart.timeScale().coordinateToTime(plotX);
  if(time != null) return time;
  const logical = state.chart.timeScale().coordinateToLogical(plotX);
  if(logical == null) return null;
  const bars = state.currentBars;
  if(!bars.length) return null;
  const lastIdx = bars.length - 1;
  const idx = Math.round(logical);
  if(idx >= 0 && idx <= lastIdx) return bars[idx].time;
  const intervalSec = bars.length >= 2 ? (bars[lastIdx].time - bars[lastIdx - 1].time) : 60;
  if(intervalSec <= 0) return null;
  if(idx > lastIdx) return bars[lastIdx].time + (idx - lastIdx) * intervalSec;
  return bars[0].time + idx * intervalSec; // idx가 음수라 자동으로 과거 방향으로 뺀 값이 됨
}
function canvasXYToDomain(x, y){
  if(!state.chart || !state.candleSeries) return null;
  const time = resolveTimeForX(x - leftScaleOffset());
  const price = state.candleSeries.coordinateToPrice(y);
  if(time == null || price == null) return null;
  return { time, price };
}
// 선택된 도형의 "몸통"(핸들이 아닌 부분)을 클릭했는지 판정 — 이동(드래그) 시작 여부를 정할 때 쓴다.
// trySelectDrawingAt의 타입별 판정 로직과 동일하되, 좌표계만 캔버스 기준(왼쪽 가격축 폭 포함)으로 맞췄다.
function isPointOnDrawingBody(d, x, y){
  const HIT = 10, LINE_HIT = 14;
  const pts = d.points.map(drawPointToCanvasPixel);
  if(d.type === 'pen'){
    for(let k = 0; k < pts.length - 1; k++){
      if(pts[k] && pts[k + 1] && distToSegment(x, y, pts[k].x, pts[k].y, pts[k + 1].x, pts[k + 1].y) <= LINE_HIT) return true;
    }
    return false;
  }
  if(d.type === 'hline') return !!pts[0] && Math.abs(y - pts[0].y) <= LINE_HIT;
  if(d.type === 'trendline') return !!(pts[0] && pts[1] && distToSegment(x, y, pts[0].x, pts[0].y, pts[1].x, pts[1].y) <= LINE_HIT);
  if(d.type === 'rect' || d.type === 'image' || d.type === 'text'){
    if(!pts[0] || !pts[1]) return false;
    const rx = Math.min(pts[0].x, pts[1].x), ry = Math.min(pts[0].y, pts[1].y);
    const rw = Math.abs(pts[1].x - pts[0].x), rh = Math.abs(pts[1].y - pts[0].y);
    let tx = x, ty = y;
    if(d.rotation){ const cx = rx + rw / 2, cy = ry + rh / 2; const inv = rotatePoint(x, y, cx, cy, -d.rotation); tx = inv.x; ty = inv.y; }
    return tx >= rx - HIT && tx <= rx + rw + HIT && ty >= ry - HIT && ty <= ry + rh + HIT;
  }
  if(d.type === 'fib'){
    if(!pts[0] || !pts[1]) return false;
    const xL = Math.min(pts[0].x, pts[1].x), xR = Math.max(pts[0].x, pts[1].x);
    const yTop = Math.min(pts[0].y, pts[1].y), yBottom = Math.max(pts[0].y, pts[1].y);
    return x >= xL - HIT && x <= xR + HIT && y >= yTop - HIT && y <= yBottom + HIT;
  }
  return false;
}
chartEl.addEventListener('mousedown', (e) => {
  if(state.drawTool !== 'cursor' || state.drawSelectedId == null) return;
  const d = state.drawings.find(x => x.id === state.drawSelectedId);
  if(!d) return;
  const { x: mx, y: my } = eventToCanvasXY(e);
  const HANDLE_HIT = 10;

  // 끝점을 직접 잡아서 모양을 바꾸는 도구: 추세선(2점) / 피보나치(2점)
  if(d.type === 'trendline' || d.type === 'fib'){
    const pts = d.points.map(drawPointToCanvasPixel);
    for(let i = 0; i < pts.length; i++){
      if(pts[i] && Math.hypot(mx - pts[i].x, my - pts[i].y) <= HANDLE_HIT){
        activeShapeDrag = { type: 'resize', drawingId: d.id, pointIndex: i };
        e.preventDefault(); e.stopPropagation();
        return;
      }
    }
  } else if(d.type === 'rect' || d.type === 'image' || d.type === 'text'){
    const box = shapeCanvasBox(d);
    if(box){
      const rot = d.rotation || 0;
      const corners = localCorners(box).map(c => rotatePoint(c.x, c.y, box.cx, box.cy, rot));
      for(let i = 0; i < corners.length; i++){
        if(Math.hypot(mx - corners[i].x, my - corners[i].y) <= HANDLE_HIT){
          activeShapeDrag = { type: 'resize', drawingId: d.id, cornerIdx: i };
          e.preventDefault(); e.stopPropagation();
          return;
        }
      }
      const rotHandleLocal = rotationHandleLocalPos(box);
      const rotHandle = rotatePoint(rotHandleLocal.x, rotHandleLocal.y, box.cx, box.cy, rot);
      if(Math.hypot(mx - rotHandle.x, my - rotHandle.y) <= HANDLE_HIT){
        activeShapeDrag = { type: 'rotate', drawingId: d.id };
        e.preventDefault(); e.stopPropagation();
        return;
      }
    }
  }
  // 핸들이 아니면, 도형 몸통을 잡은 건지 확인해서 전체 이동(드래그)을 시작한다.
  if(isPointOnDrawingBody(d, mx, my)){
    // 매 프레임 델타를 누적하면(이전 위치 대비 계속 더하기) 시간축 스냅 오차가 쌓여서 밀릴 수 있어서,
    // 드래그 시작 시점의 원본 점들을 기억해뒀다가 "시작점 대비 총 이동량"을 매번 새로 계산해 적용한다.
    activeShapeDrag = { type: 'move', drawingId: d.id, startX: mx, startY: my, originalPoints: d.points.map(p => ({ ...p })) };
    e.preventDefault(); e.stopPropagation();
  }
}, true);
document.addEventListener('mousemove', (e) => {
  if(!activeShapeDrag) return;
  const d = state.drawings.find(x => x.id === activeShapeDrag.drawingId);
  if(!d){ activeShapeDrag = null; return; }
  const { x: mx, y: my } = eventToCanvasXY(e);
  markDrawingsDirty(); // 점 좌표/회전각만 바뀌므로 명시적으로 알려줘야 한다

  if(activeShapeDrag.type === 'move'){
    const dxPx = mx - activeShapeDrag.startX, dyPx = my - activeShapeDrag.startY;
    d.points = activeShapeDrag.originalPoints.map(p => {
      const px = drawPointToCanvasPixel(p);
      if(!px) return p;
      return canvasXYToDomain(px.x + dxPx, px.y + dyPx) || p;
    });
    e.preventDefault();
    return;
  }
  if(activeShapeDrag.type === 'rotate'){
    const box = shapeCanvasBox(d);
    if(!box) return;
    // 핸들이 박스 "위쪽"에 있을 때를 회전각 0으로 두고, 마우스-중심 각도에서 -90도(위쪽 기준) 보정
    d.rotation = Math.atan2(my - box.cy, mx - box.cx) + Math.PI / 2;
    e.preventDefault();
    return;
  }
  if(d.type === 'trendline' || d.type === 'fib'){
    const pt = canvasXYToDomain(mx, my);
    if(!pt) return;
    d.points[activeShapeDrag.pointIndex] = pt;
    e.preventDefault();
    return;
  }
  // rect/image 코너 리사이즈: 드래그 중인 코너의 "로컬(비회전)" 위치를 구해서, 반대쪽(고정) 코너와
  // 짝지어 새 대각선 두 점으로 다시 정의한다.
  const box = shapeCanvasBox(d);
  if(!box) return;
  const rot = d.rotation || 0;
  const local = rotatePoint(mx, my, box.cx, box.cy, -rot);
  const corners = localCorners(box);
  const anchor = corners[(activeShapeDrag.cornerIdx + 2) % 4];
  let newLocal = local;
  if(shiftPressed){
    const aspect = d.type === 'image' && d.imgEl && d.imgEl.naturalWidth ? d.imgEl.naturalWidth / d.imgEl.naturalHeight : 1;
    const dx = local.x - anchor.x, dy = local.y - anchor.y;
    let ndx = dx, ndy = dy;
    if(Math.abs(dx) / aspect >= Math.abs(dy)) ndy = (dy < 0 ? -1 : 1) * Math.abs(dx) / aspect;
    else ndx = (dx < 0 ? -1 : 1) * Math.abs(dy) * aspect;
    newLocal = { x: anchor.x + ndx, y: anchor.y + ndy };
  }
  const anchorPt = canvasXYToDomain(anchor.x, anchor.y);
  const newPt = canvasXYToDomain(newLocal.x, newLocal.y);
  if(!anchorPt || !newPt) return;
  d.points = [anchorPt, newPt];
  e.preventDefault();
});
document.addEventListener('mouseup', () => { activeShapeDrag = null; });

document.querySelectorAll('.draw-tool-btn[data-tool]').forEach(btn => {
  btn.addEventListener('click', () => {
    // 사용자가 직접 도구를 바꿀 때만 이전 선택/팝업을 치운다. setDrawTool 자체에서 지우면
    // "그리자마자 자동 선택"(addDrawing 내부에서 완성 직후 setDrawTool('cursor')를 부르는
    // 흐름)까지 같이 지워져서 방금 그린 도형이 바로 선택 해제되는 문제가 생긴다.
    // 팝업을 안 치우면, 이전 선택의 옵션 팝업(삭제 버튼 등)이 화면에 남아있다가 새로 그리려는
    // 클릭을 가로채서 엉뚱한 버튼이 눌리는 버그가 있었다(실제로 겪음 — 삭제 버튼이 눌려서
    // 그려둔 도형이 전부 사라짐).
    state.drawSelectedId = null;
    setDrawTool(btn.dataset.tool);
  });
});
document.getElementById('drawToolTrash').addEventListener('click', () => {
  state.drawings = [];
  state.drawDraft = null;
  state.drawSelectedId = null;
  const rect = chartEl.getBoundingClientRect();
  drawOverlayCtx.clearRect(0, 0, rect.width, rect.height);
});
// ---------- 이미지 도구 ----------
// 서버 업로드 없이 완전히 로컬에서 처리한다: <input type="file">로 고른 파일을 FileReader로
// data URL로 읽어서 Image 객체로 미리 로드해두고, 그 다음부터는 사각형 도구와 똑같이
// 두 번 클릭(대각선 모서리)으로 크기를 정해서 배치한다.
const drawImageFileInput = document.getElementById('drawImageFileInput');
let pendingImageEl = null;
document.getElementById('drawToolImage').addEventListener('click', () => {
  drawImageFileInput.click();
});
drawImageFileInput.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  drawImageFileInput.value = ''; // 같은 파일을 다시 골라도 change가 또 발생하게 초기화
  if(!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      pendingImageEl = img;
      state.drawSelectedId = null;
      setDrawTool('image');
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
});
window.addEventListener('keydown', (e) => {
  const tag = document.activeElement ? document.activeElement.tagName : '';
  if(tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if((e.key === 'Delete' || e.key === 'Backspace') && state.drawSelectedId != null){
    state.drawings = state.drawings.filter(d => d.id !== state.drawSelectedId);
    state.drawSelectedId = null;
  } else if(e.key === 'Escape'){
    if(state.drawDraft){ state.drawDraft = null; state.drawPreviewPoint = null; setDrawTool('cursor'); }
    state.drawSelectedId = null;
  }
});

// ---------- 선택한 그림 위에 뜨는 옵션 팝업 (색상/점선/삭제) ----------
// 도형을 클릭해서 선택하면(state.drawSelectedId) 그 도형 근처에 이 팝업이 뜬다.
// 매 프레임(drawOverlayLoop) 다시 위치를 계산해서 스크롤/줌해도 도형을 따라다닌다.
// (drawOptionsPopup 등의 선언은 drawOverlayLoop보다 먼저 나와야 해서 위쪽으로 옮겨뒀다)
function updateDrawOptionsPopup(){
  const d = getSelectedDrawing();
  if(!d){
    drawOptionsPopup.style.display = 'none';
    return;
  }
  let anchor, extraGap;
  if(d.type === 'rect' || d.type === 'image' || d.type === 'text'){
    // 이 도형들은 회전 핸들(박스 위쪽에서 더 떨어진 동그라미)까지 있어서, 단순히 모서리 점들만
    // 기준으로 삼으면(회전된 경우 특히) 팝업이 회전 핸들을 가릴 수 있다. 실제로 화면에 그려지는
    // 핸들(모서리 4개 + 회전 핸들)을 전부 계산해서 그중 가장 위쪽 지점을 기준으로 띄운다.
    const box = shapeCanvasBox(d);
    if(!box){ drawOptionsPopup.style.display = 'none'; return; }
    const rot = d.rotation || 0;
    const handlePts = localCorners(box).concat([rotationHandleLocalPos(box)])
      .map(c => rotatePoint(c.x, c.y, box.cx, box.cy, rot));
    anchor = handlePts.reduce((a, b) => (b.y < a.y ? b : a));
    extraGap = 46; // 팝업 자신의 높이(~36px) + 여유(~10px)만큼은 있어야 회전 핸들과 안 겹친다
  }else{
    const pxs = d.points.map(drawPointToCanvasPixel).filter(Boolean);
    if(!pxs.length){ drawOptionsPopup.style.display = 'none'; return; }
    // 도형의 여러 점 중 가장 위쪽(y가 작은) 점 근처, 살짝 위로 띄워서 배치.
    anchor = pxs.reduce((a, b) => (b.y < a.y ? b : a));
    extraGap = 42;
  }
  const wrapRect = chartEl.getBoundingClientRect();
  let left = Math.min(Math.max(anchor.x - 10, 4), wrapRect.width - 100);
  let top = Math.max(anchor.y - extraGap, 4);
  drawOptionsPopup.style.left = left + 'px';
  drawOptionsPopup.style.top = top + 'px';
  drawOptionsPopup.style.display = 'flex';
  if(document.activeElement !== drawOptColorInput) drawOptColorInput.value = d.color || '#f6c309';
  drawOptDashBtn.classList.toggle('active', !!d.dashed);
}
drawOptColorInput.addEventListener('input', (e) => {
  const d = getSelectedDrawing();
  if(d){ d.color = e.target.value; markDrawingsDirty(); }
});
drawOptDashBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const d = getSelectedDrawing();
  if(d){ d.dashed = !d.dashed; markDrawingsDirty(); }
});
document.getElementById('drawOptDelete').addEventListener('click', (e) => {
  e.stopPropagation();
  if(state.drawSelectedId == null) return;
  state.drawings = state.drawings.filter(d => d.id !== state.drawSelectedId);
  state.drawSelectedId = null;
});
// 팝업 자체를 클릭했을 때 차트로 클릭이 새어나가 선택이 풀리지 않도록 막는다
drawOptionsPopup.addEventListener('mousedown', (e) => e.stopPropagation());
