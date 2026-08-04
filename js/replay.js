/* replay.js
   Bar Replay mode: click a candle to rewind the chart to that point, then step
   forward one bar at a time (manually or auto-play) as if watching it happen live.

   설계 개요
   - state.replayFullBars: 리플레이 시작 시점에 이미 로드돼 있던 전체 봉 배열의 스냅샷.
     재생은 이 배열 안에서만 앞으로/뒤로 움직인다 (새로 fetch하지 않음 — "미래를 몰래 보는"
     일이 없도록 원래 로드된 범위 안으로 제한).
   - state.replayIndex: 지금까지 "공개된" 마지막 봉의 인덱스 (replayFullBars 기준).
   - state.currentBars는 리플레이 중엔 replayFullBars[0..replayIndex] 슬라이스로 유지된다.
     그래야 지표 계산(refreshXFull/updateXLive)이나 hover 등 기존 코드가 항상 읽는
     state.currentBars가 "그 시점까지만 보이는 데이터"로 자연스럽게 맞아떨어진다.
   - 한 봉 앞으로 갈 땐 실시간 틱 처리와 완전히 같은 함수(updateSeriesWithCandle,
     volumeSeries.update, pushOrUpdateBar)를 재사용한다 — 캔들 유형 변환(하이킨아시/
     볼륨캔들 등)과 지표 증분 갱신 로직을 새로 만들 필요가 없다.
   - 뒤로 갈 땐 증분 갱신을 "되돌릴" 안전한 방법이 없어서(EMA/RSI 등은 누적 계산 캐시를
     쓰기 때문), slice + recreateMainSeries() + refreshXFull()로 그 시점 전체를 다시 계산한다.
     자주 누르는 동작이 아니라서 비용은 무시할 만하다.
*/

const replayToggleBtn = $('replayToggleBtn');
const replayBar = $('replayBar');
const replayHint = $('replayHint');
const replayControls = $('replayControls');
const replayStepBackBtn = $('replayStepBackBtn');
const replayPlayBtn = $('replayPlayBtn');
const replayPlayIcon = $('replayPlayIcon');
const replayStepFwdBtn = $('replayStepFwdBtn');
const replaySpeedSelect = $('replaySpeedSelect');
const replayTimeLabel = $('replayTimeLabel');
const replayExitBtn = $('replayExitBtn');

const REPLAY_PLAY_SVG = '<path d="M7 5l13 7-13 7z"/>';
const REPLAY_PAUSE_SVG = '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>';

function formatReplayTime(bar){
  if(!bar) return '—';
  try{
    return new Date(bar.time * 1000).toLocaleString(state.lang === 'kr' ? 'ko-KR' : 'en-US', {
      year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  }catch(e){
    return String(bar.time);
  }
}

function updateReplayTimeLabel(){
  const bar = state.replayFullBars && state.replayIndex >= 0 ? state.replayFullBars[state.replayIndex] : null;
  const atEnd = state.replayFullBars && state.replayIndex >= state.replayFullBars.length - 1;
  replayTimeLabel.textContent = formatReplayTime(bar) + (atEnd ? ' · ' + t('replayEnd').split(' ')[0] : '');
  replayTimeLabel.title = atEnd ? t('replayEnd') : '';
}

function updatePlayButtonUI(){
  replayPlayIcon.innerHTML = state.replayPlaying ? REPLAY_PAUSE_SVG : REPLAY_PLAY_SVG;
  replayPlayBtn.classList.toggle('playing', state.replayPlaying);
  replayPlayBtn.title = state.replayPlaying ? t('replayPause') : t('replayPlay');
}

// 리플레이 중엔 실시간 "오늘" 표시(renderTodayIfNotHovering, candles.js에서 가드됨) 대신
// 이 함수가 상단 큰 가격/등락 + 선택된 캔들 O/H/L/C 자리를 채운다.
function renderReplayIfNotHovering(){
  if(!state.replayMode) return;
  const bar = state.currentBars.length ? state.currentBars[state.currentBars.length - 1] : null;
  if(!bar) return;
  const lastPriceEl = $('lastPrice');
  const chgBox = $('chgBox');
  if(lastPriceEl) lastPriceEl.textContent = formatPrice(bar.close);
  updateDocumentTitle();
  if(chgBox){
    const pct = bar.open ? ((bar.close - bar.open) / bar.open) * 100 : NaN;
    if(Number.isFinite(pct)){
      chgBox.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
      chgBox.className = 'chg ' + (pct >= 0 ? 'up' : 'down');
    }else{
      chgBox.textContent = '—';
      chgBox.className = 'chg';
    }
  }
  if(state.hoverCandle) return; // 사용자가 다른 봉에 마우스를 올려 살펴보는 중이면 그 표시를 유지
  renderCandleStats(bar, t('replayLabel'));
}

// ---------- 시작점 고르기 ----------
function showReplayBar(){ replayBar.style.display = 'flex'; }
function hideReplayBar(){ replayBar.style.display = 'none'; }

function enterReplayPicking(){
  if(!state.coin || !state.currentBars.length) return;
  state.replayPicking = true;
  setDrawTool('cursor'); // 그리기 도구가 켜져 있으면 클릭이 도형 그리기로 새어나가므로 커서로 강제 전환
  replayToggleBtn.classList.add('on');
  replayHint.style.display = 'inline';
  replayControls.style.display = 'none';
  showReplayBar();
}

function cancelReplayPicking(){
  state.replayPicking = false;
  replayToggleBtn.classList.remove('on');
  hideReplayBar();
}

// chart-init.js의 subscribeClick(handleReplayPickClick)에서 호출됨.
// state.hoverCandle은 이미 등록된 crosshair-move 핸들러가 매 프레임 최신 상태로 유지한다.
function handleReplayPickClick(){
  if(!state.replayPicking) return;
  if(!state.hoverCandle) return; // 봉이 없는 빈 영역 클릭은 무시
  startReplayFromBar(state.hoverCandle);
}

function startReplayFromBar(bar){
  const idx = state.currentBars.findIndex(b => b.time === bar.time);
  if(idx < 0) return;

  state.replayPicking = false;
  state.replayMode = true;
  state.replayPlaying = false;
  state.replayFullBars = state.currentBars.slice(); // 지금까지 로드된 전체 봉 스냅샷
  state.replayIndex = idx;
  state.currentBars = state.replayFullBars.slice(0, idx + 1);
  state.hoverCandle = null;

  rebuildBarIndex();
  recreateMainSeries();
  refreshEmaBandFull();
  refreshBBFull();
  refreshVwapFull();
  refreshMaRibbonFull();
  refreshRsiFull();
  refreshMacdFull();
  state.lastCandle = state.currentBars[state.currentBars.length - 1];
  state.chart.timeScale().fitContent();

  replayToggleBtn.classList.add('on');
  replayHint.style.display = 'none';
  replayControls.style.display = 'flex';
  showReplayBar();
  updatePlayButtonUI();
  updateReplayTimeLabel();
  renderReplayIfNotHovering();
}

// ---------- 재생 ----------
// 실시간 WS 틱 처리(market-data.js)와 완전히 같은 3줄 조합을 재사용한다.
function replayStepForward(){
  if(!state.replayMode || !state.replayFullBars) return false;
  if(state.replayIndex >= state.replayFullBars.length - 1) return false;
  state.replayIndex++;
  const bar = state.replayFullBars[state.replayIndex];
  updateSeriesWithCandle(bar);
  state.volumeSeries.update(volPoint(bar));
  pushOrUpdateBar(bar); // state.currentBars에 push + barIndex 갱신 + 지표 증분 업데이트
  state.lastCandle = bar;
  updateReplayTimeLabel();
  renderReplayIfNotHovering();
  return true;
}

// 뒤로는 증분 갱신을 되돌릴 수 없어서 슬라이스 + 전체 재계산으로 처리 (자주 누르는 동작이
// 아니라서 비용 무시 가능 — recreateMainSeries()는 캔들 종류 전환 시에도 매번 쓰는 함수다).
function replayStepBackward(){
  if(!state.replayMode || !state.replayFullBars || state.replayIndex <= 0) return;
  pauseReplayPlayback();
  state.replayIndex--;
  state.currentBars = state.replayFullBars.slice(0, state.replayIndex + 1);
  rebuildBarIndex();
  recreateMainSeries();
  refreshEmaBandFull();
  refreshBBFull();
  refreshVwapFull();
  refreshMaRibbonFull();
  refreshRsiFull();
  refreshMacdFull();
  state.lastCandle = state.currentBars[state.currentBars.length - 1];
  updateReplayTimeLabel();
  renderReplayIfNotHovering();
}

function startReplayPlayback(){
  if(!state.replayMode || state.replayPlaying) return;
  if(state.replayIndex >= state.replayFullBars.length - 1) return; // 이미 끝까지 다 봄
  state.replayPlaying = true;
  updatePlayButtonUI();
  state.replayTimer = setInterval(() => {
    const advanced = replayStepForward();
    if(!advanced) pauseReplayPlayback();
  }, state.replaySpeedMs);
}
function pauseReplayPlayback(){
  if(state.replayTimer){ clearInterval(state.replayTimer); state.replayTimer = null; }
  if(state.replayPlaying){ state.replayPlaying = false; updatePlayButtonUI(); }
}
function toggleReplayPlayback(){
  if(state.replayPlaying) pauseReplayPlayback();
  else startReplayPlayback();
}

// ---------- 종료: 실시간 데이터로 복귀 ----------
// selectPair()를 coin/interval 그대로 다시 호출해서 currentBars를 REST로 새로 받고
// WS 구독도 다시 연다 — 리플레이 중 무시됐던 실시간 틱들을 일일이 재생하는 대신,
// "지금" 시점 데이터를 통째로 새로 불러오는 쪽이 훨씬 간단하고 확실하다.
// state만 정리하고 currentBars는 건드리지 않는 버전. exitReplay()가 재로딩 직전에 쓰고,
// pair-select.js도 (다른 페어/인터벌로 바꿔서 리플레이 중이던 슬라이스 자체가 무의미해질 때)
// 방어적으로 이 함수만 불러서 리플레이 상태만 끈다 — selectPair()를 다시 부르면 무한 재귀가
// 되므로 거기선 이 가벼운 버전만 쓴다.
function stopReplaySession(){
  pauseReplayPlayback();
  state.replayMode = false;
  state.replayPicking = false;
  state.replayFullBars = null;
  state.replayIndex = -1;
  replayToggleBtn.classList.remove('on');
  hideReplayBar();
}

async function exitReplay(){
  stopReplaySession();
  if(state.coin){
    await selectPair({ coin: state.coin, label: state.label, type: state.isSpot ? 'SPOT' : 'PERP' });
  }
}

function toggleReplay(){
  if(state.replayMode) exitReplay();
  else if(state.replayPicking) cancelReplayPicking();
  else enterReplayPicking();
}

replayToggleBtn.addEventListener('click', toggleReplay);
replayExitBtn.addEventListener('click', exitReplay);
replayPlayBtn.addEventListener('click', toggleReplayPlayback);
replayStepFwdBtn.addEventListener('click', () => { pauseReplayPlayback(); replayStepForward(); });
replayStepBackBtn.addEventListener('click', replayStepBackward);
replaySpeedSelect.addEventListener('change', () => {
  state.replaySpeedMs = Number(replaySpeedSelect.value) || 700;
  if(state.replayPlaying){ pauseReplayPlayback(); startReplayPlayback(); }
});

// ---------- 키보드 단축키 (리플레이 모드 중에만 동작) ----------
// ←/→: 한 봉 뒤로/앞으로, ↑/↓: 재생 속도 셀렉트 옵션 한 칸 위/아래로, Space: 자동재생 on/off.
// 속도 변경은 실제 select의 selectedIndex를 바꾸고 change 이벤트를 그대로 발생시켜서
// (state.replaySpeedMs 갱신 + 재생 중이면 재시작) 기존 로직을 그대로 재사용한다.
function changeReplaySpeedStep(delta){
  const idx = replaySpeedSelect.selectedIndex;
  const newIdx = Math.min(replaySpeedSelect.options.length - 1, Math.max(0, idx + delta));
  if(newIdx === idx) return;
  replaySpeedSelect.selectedIndex = newIdx;
  replaySpeedSelect.dispatchEvent(new Event('change'));
}

window.addEventListener('keydown', (e) => {
  if(!state.replayMode) return;
  const tag = document.activeElement ? document.activeElement.tagName : '';
  if(tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return; // 입력 중엔 단축키 무시 (drawings.js와 동일한 가드)
  switch(e.key){
    case 'ArrowLeft':
      e.preventDefault();
      replayStepBackward(); // 내부에서 자동재생 중이면 알아서 멈춘다
      break;
    case 'ArrowRight':
      e.preventDefault();
      pauseReplayPlayback();
      replayStepForward();
      break;
    case 'ArrowUp':
      e.preventDefault();
      changeReplaySpeedStep(1); // 옵션 목록에서 더 빠른 쪽으로 한 칸 (0.5x→1x→2x→4x)
      break;
    case 'ArrowDown':
      e.preventDefault();
      changeReplaySpeedStep(-1); // 더 느린 쪽으로 한 칸
      break;
    case ' ':
    case 'Spacebar':
      e.preventDefault(); // 스페이스의 기본 동작(페이지 스크롤)을 막는다
      toggleReplayPlayback();
      break;
  }
});
