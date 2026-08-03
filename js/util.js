/* util.js
   Formatters, REST helper, DOM cache, dropdown factory, status/banner helpers. */

// ---------- DOM 캐시 ----------
// getElementById는 렌더 루프/실시간 틱마다 반복 호출되면 낭비라서 한 번 찾은 요소를 캐싱한다.
const _domCache = new Map();
function $(id){
  let el = _domCache.get(id);
  if(el === undefined){
    el = document.getElementById(id);
    _domCache.set(id, el);
  }
  return el;
}

// ---------- localStorage 안전 래퍼 ----------
// 사파리 프라이빗 모드/파일 프로토콜 등에서 localStorage 접근 자체가 예외를 던질 수 있어서 전부 감싼다.
const store = {
  get(key, fallback){
    try{
      const raw = localStorage.getItem('hlchart_' + key);
      return raw == null ? fallback : JSON.parse(raw);
    }catch(e){ return fallback; }
  },
  set(key, value){
    try{ localStorage.setItem('hlchart_' + key, JSON.stringify(value)); }catch(e){}
  },
};

// ---------- 프레임 단위 작업 합치기 ----------
// 실시간 틱은 초당 여러 번 들어올 수 있는데 지표 전체 재계산/재렌더를 매 틱마다 하면 낭비다.
// 같은 key로 여러 번 예약해도 다음 애니메이션 프레임에 딱 한 번만 실행되게 모아준다.
const _pendingFrameJobs = new Map();
let _frameFlushQueued = false;
function scheduleFrame(key, fn){
  _pendingFrameJobs.set(key, fn);
  if(_frameFlushQueued) return;
  _frameFlushQueued = true;
  requestAnimationFrame(() => {
    _frameFlushQueued = false;
    const jobs = [..._pendingFrameJobs.values()];
    _pendingFrameJobs.clear();
    jobs.forEach(job => { try{ job(); }catch(err){ console.error('[HL Chart] scheduleFrame', err); } });
  });
}

// ---------- 유효숫자 5자리 가격 포맷터 ----------
function formatPrice(value) {
  if (value == null || isNaN(value)) return '—';
  const str = value.toPrecision(5);
  if (!str.includes('e')) return str;
  // 지수 표기(e)를 일반 소수 표기로 변환
  const [mantissa, expStr] = str.split('e');
  const exp = parseInt(expStr, 10);
  const digits = mantissa.replace('.', '');
  const dotPos = mantissa.indexOf('.');
  const mantissaIntLen = dotPos === -1 ? mantissa.length : dotPos;
  const newDotPos = mantissaIntLen + exp;
  if (newDotPos <= 0) {
    return '0.' + '0'.repeat(-newDotPos) + digits;
  } else if (newDotPos >= digits.length) {
    return digits + '0'.repeat(newDotPos - digits.length);
  } else {
    return digits.slice(0, newDotPos) + '.' + digits.slice(newDotPos);
  }
}

// ---------- 큰 수 축약 포맷터 (1234567 -> 1.23M) ----------
// 예전엔 formatBigNumber / formatVolumeAxis 두 함수가 소수 자릿수만 다른 채로 거의 통째로
// 복사돼 있었다. 자릿수를 인자로 받는 하나로 합치고, 기존 두 이름은 얇은 래퍼로 남겨둔다.
const NUMBER_SUFFIXES = ['', 'K', 'M', 'B', 'T', 'q', 'Q', 's', 'S', 'O', 'N', 'D'];
function formatCompact(n, decimals, emptyValue){
  if(!Number.isFinite(n)) return emptyValue;
  const sign = n < 0 ? '-' : '';
  let abs = Math.abs(n);
  let i = 0;
  while(abs >= 1000 && i < NUMBER_SUFFIXES.length - 1){
    abs /= 1000;
    i++;
  }
  return sign + abs.toFixed(decimals) + NUMBER_SUFFIXES[i];
}
function formatBigNumber(n){ return formatCompact(n, 2, '—'); }
// 왼쪽 거래량 축 전용: 소수점을 없애 라벨을 짧게 만들어 축 두께를 줄인다
// (기본 'volume' 포맷터는 소수점 3자리까지 표시해서 축이 필요 이상으로 두꺼워짐)
function formatVolumeAxis(n){ return formatCompact(n, 0, ''); }
function sleep(ms){ return new Promise(resolve => setTimeout(resolve, ms)); }

// ---------- lightweight-charts 로컬 타임존 표시 ----------
// 차트 라이브러리는 봉의 시간(초 단위 유닉스 타임스탬프)을 내부적으로 항상 UTC로만 다룬다
// (getUTCHours 등으로 축 라벨을 만듦 — 공식 문서에도 "타임존을 직접 지원하지 않는다"고
// 명시돼 있음). 데이터 자체(state.currentBars의 time)는 계산/중복제거/실시간 매칭에 계속
// UTC로 써야 하므로 절대 건드리지 않고, 축/크로스헤어에 찍히는 "표시 문자열"만 커스텀
// 포맷터로 가로채서 브라우저 로컬 타임존 기준으로 다시 읽어 보여준다.
// (메인 차트 + RSI/MACD 패널, 총 3개의 lightweight-charts 인스턴스가 이 두 함수를 공유한다.)
function localTickMarkFormatter(time, tickMarkType){
  const date = new Date(time * 1000);
  const opts = {};
  switch(tickMarkType){
    case 0: opts.year = 'numeric'; break;          // Year
    case 1: opts.month = 'short'; break;            // Month
    case 2: opts.day = 'numeric'; break;             // DayOfMonth
    case 4: opts.second = '2-digit'; // fallthrough  // TimeWithSeconds
    case 3: opts.hour12 = false; opts.hour = '2-digit'; opts.minute = '2-digit'; break; // Time
  }
  return date.toLocaleString(state.lang === 'kr' ? 'ko-KR' : 'en-US', opts);
}
function localTimeFormatter(time){
  const date = new Date(time * 1000);
  return date.toLocaleString(state.lang === 'kr' ? 'ko-KR' : 'en-US', {
    year: '2-digit', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

// ---------- generic info() ----------
const HL_API_URL = 'https://api.hyperliquid.xyz/info';
const HL_WS_URL = 'wss://api.hyperliquid.xyz/ws';
async function info(body){
  const res = await fetch(HL_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if(!res.ok) throw new Error('info endpoint ' + res.status);
  return res.json();
}

// ---------- 공용 웹소켓 구독 팩토리 ----------
// candle / activeAssetCtx / l2Book 구독이 전부 "소켓 열기 -> subscribe 보내기 -> 채널 필터링 ->
// 끊기면 3초 뒤 재연결" 이라는 똑같은 뼈대를 각자 복사해서 쓰고 있었다(5벌). 하나로 합쳐서,
// 각 구독은 무엇을 구독할지(subscription)와 데이터가 왔을 때 무엇을 할지(onData)만 넘기면 되게 했다.
//
// 반환된 핸들의 close()를 부르면 재연결도 같이 멈춘다. 예전 코드는 "state.xxxWs === ws" 비교로
// 낡은 소켓의 지연 메시지/재연결을 걸러냈는데, 그 비교를 빠뜨리기 쉬운 구조였다(실제로 몇몇
// 경로에서만 방어되어 있었다). 이제는 핸들 자체가 closed 플래그를 들고 있어서 항상 안전하다.
function createSubscription({ subscription, channels, onData, onOpen, onError, retryMs = 3000 }){
  const wantedChannels = Array.isArray(channels) ? channels : [channels];
  const handle = { closed: false, ws: null };
  let retryTimer = null;

  function connect(){
    if(handle.closed) return;
    const ws = new WebSocket(HL_WS_URL);
    handle.ws = ws;
    ws.onopen = () => {
      if(handle.closed || handle.ws !== ws) return;
      ws.send(JSON.stringify({ method: 'subscribe', subscription }));
      if(onOpen) onOpen();
    };
    ws.onmessage = (ev) => {
      if(handle.closed || handle.ws !== ws) return; // 전환 직후 도착한 낡은 메시지 무시
      let msg;
      try{ msg = JSON.parse(ev.data); }catch(e){ return; }
      if(!msg || !wantedChannels.includes(msg.channel) || !msg.data) return;
      onData(msg.data, msg.channel);
    };
    ws.onerror = () => { if(!handle.closed && onError) onError(); };
    ws.onclose = () => {
      if(handle.closed || handle.ws !== ws) return;
      retryTimer = setTimeout(connect, retryMs);
    };
  }

  handle.close = () => {
    handle.closed = true;
    if(retryTimer){ clearTimeout(retryTimer); retryTimer = null; }
    if(handle.ws){ try{ handle.ws.close(); }catch(e){} handle.ws = null; }
  };
  connect();
  return handle;
}
// 이전 구독이 있으면 닫고 새로 여는 흔한 패턴을 한 줄로.
function closeSubscription(handle){
  if(handle) handle.close();
  return null;
}

// ---------- 공용 드롭다운 컨트롤러 ----------
// 페어/인터벌/차트유형 드롭다운이 전부 "토글 버튼 클릭 시 열고 닫기 + 다른 드롭다운은
// 자동으로 닫기 + 바깥을 클릭하면 닫기"라는 동일한 동작을 각자 따로 구현하고 있던 걸
// 하나의 팩토리로 통합. 각 드롭다운은 이 함수를 한 번씩 호출해서 컨트롤러를 만든다.
const allDropdowns = [];
function createDropdown(toggleEl, dropdownEl, onOpen){
  const ctrl = {
    isOpen: () => dropdownEl.classList.contains('open'),
    open(){
      allDropdowns.forEach(d => { if(d !== ctrl) d.close(); });
      dropdownEl.classList.add('open');
      toggleEl.classList.add('open');
      if(onOpen) onOpen();
    },
    close(){
      dropdownEl.classList.remove('open');
      toggleEl.classList.remove('open');
    },
    toggle(){ ctrl.isOpen() ? ctrl.close() : ctrl.open(); },
  };
  ctrl.dropdownEl = dropdownEl;
  ctrl.toggleEl = toggleEl;
  toggleEl.onclick = (e) => { e.stopPropagation(); ctrl.toggle(); };
  allDropdowns.push(ctrl);
  return ctrl;
}

// ---------- 바깥 클릭 감지 (문서 전역 리스너 1개) ----------
// 예전엔 드롭다운용 1개 + 지표 설정창 5개 + 전역 설정창 1개, 총 7개의 document click 리스너가
// 각각 붙어 있었다. 클릭 한 번마다 7개 콜백이 전부 도는 구조라, 등록/해제를 한 곳에서 관리하도록
// 옵저버 목록 하나로 합쳤다.
const _outsideClickHandlers = [];
function onOutsideClick(handler){ _outsideClickHandlers.push(handler); }
document.addEventListener('click', (e) => {
  allDropdowns.forEach(d => {
    if(d.isOpen() && !d.dropdownEl.contains(e.target) && e.target !== d.toggleEl) d.close();
  });
  for(const handler of _outsideClickHandlers) handler(e);
});

// 드롭다운 목록의 행(row) 하나를 만드는 공용 헬퍼.
// (★ 즐겨찾기 토글, 라벨, 타입 배지) 조합이 페어/인터벌/차트유형 드롭다운에서
// 조금씩 다르게 반복되던 걸 옵션으로 표현되게 정리.
function makeDropdownRow({ active, label, badge, star, onClick }){
  const row = document.createElement('div');
  row.className = 'dropdown-row' + (active ? ' active' : '');

  if(star){
    const starBtn = document.createElement('button');
    starBtn.className = 'star' + (star.on ? ' on' : '');
    starBtn.textContent = star.on ? '★' : '☆';
    starBtn.onclick = (e) => { e.stopPropagation(); star.onClick(); };
    row.appendChild(starBtn);
  }

  const labelEl = document.createElement('span');
  labelEl.className = 'rlabel';
  labelEl.textContent = label;
  row.appendChild(labelEl);

  if(badge){
    const badgeEl = document.createElement('span');
    badgeEl.className = 'rtype ' + badge.className;
    badgeEl.textContent = badge.text;
    row.appendChild(badgeEl);
  }

  // 클릭 이벤트가 document까지 버블링되지 않게 막는다.
  // (예: 지표 토글처럼 onClick 안에서 이 행을 다시 그리면 클릭된 요소가 DOM에서 사라지는데,
  //  버블링이 document 리스너까지 가면 "바깥 클릭"으로 오인해서 드롭다운이 꺼져버림)
  row.onclick = (e) => { e.stopPropagation(); onClick(e); };
  return row;
}

// ---------- 하단 패널 높이 드래그 조절 (RSI / MACD 공용) ----------
// 두 패널이 완전히 동일한 40여 줄짜리 드래그 로직을 각자 IIFE로 복사해서 갖고 있었다.
// #rsiChart/#macdChart 둘 다 각자의 ResizeObserver로 크기 변화를 보고 있어서,
// 여기서는 .rsi-pane의 height만 바꿔주면 나머지는 자동으로 따라온다.
function setupPaneResize(handleId, paneEl){
  const handle = $(handleId);
  const chartAreaEl = $('chartArea');
  let dragging = false, startY = 0, startHeight = 0;

  function clampHeight(h){
    const minH = 80;
    const maxH = Math.max(minH, chartAreaEl.clientHeight - 200); // 위쪽 메인 차트 자리를 최소 200px 확보
    return Math.min(maxH, Math.max(minH, h));
  }
  function pointY(e){ return e.touches ? e.touches[0].clientY : e.clientY; }
  function onMove(e){
    if(!dragging) return;
    paneEl.style.height = clampHeight(startHeight - (pointY(e) - startY)) + 'px';
    e.preventDefault();
  }
  function onUp(){
    if(!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    window.removeEventListener('touchmove', onMove);
    window.removeEventListener('touchend', onUp);
  }
  function onDown(e){
    dragging = true;
    startY = pointY(e);
    startHeight = paneEl.getBoundingClientRect().height;
    handle.classList.add('dragging');
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onUp);
    e.preventDefault();
  }
  handle.addEventListener('mousedown', onDown);
  handle.addEventListener('touchstart', onDown, { passive: false });
}

// 오더북/펀딩/월렛/파인스크립트 패널처럼 화면 오른쪽에 붙어있는 패널의 왼쪽 가장자리를
// 끌어서 폭을 조절하는 범용 함수. setupPaneResize(세로)와 같은 패턴, 방향만 가로.
function setupSidePanelWidthResize(handle){
  const paneEl = handle.parentElement;
  let dragging = false, startX = 0, startWidth = 0;

  function clampWidth(w){
    const minW = 220;
    const maxW = Math.min(720, Math.round(window.innerWidth * 0.6));
    return Math.min(maxW, Math.max(minW, w));
  }
  function pointX(e){ return e.touches ? e.touches[0].clientX : e.clientX; }
  function onMove(e){
    if(!dragging) return;
    // 패널이 화면 오른쪽에 붙어있고 손잡이가 왼쪽 가장자리에 있으므로, 마우스를 왼쪽으로
    // 끌수록(startX - 현재X 가 양수) 패널이 넓어진다.
    paneEl.style.width = clampWidth(startWidth + (startX - pointX(e))) + 'px';
    e.preventDefault();
  }
  function onUp(){
    if(!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    window.removeEventListener('touchmove', onMove);
    window.removeEventListener('touchend', onUp);
  }
  function onDown(e){
    dragging = true;
    startX = pointX(e);
    startWidth = paneEl.getBoundingClientRect().width;
    handle.classList.add('dragging');
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onUp);
    e.preventDefault();
  }
  handle.addEventListener('mousedown', onDown);
  handle.addEventListener('touchstart', onDown, { passive: false });
}
document.querySelectorAll('.side-panel-resize-handle').forEach(setupSidePanelWidthResize);

// ---------- status / banner helpers ----------
function setStatus(key, mode, ...args){
  state.statusKey = key;
  state.statusArgs = args;
  $('statusText').textContent = t(key, ...args);
  $('statusDot').className = 'dot' + (mode ? ' ' + mode : '');
}
function showNetBanner(msg){
  const b = $('netBanner');
  if(msg) b.textContent = '⚠ ' + msg;
  b.classList.add('show');
}
