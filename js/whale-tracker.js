/* whale-tracker.js
   하이퍼리퀴드 특화 기능: 공개 trades 구독을 실시간으로 지켜보다가, 체결 노셔널(가격×수량)이
   사용자가 설정한 기준(USD) 이상인 체결만 사이드 패널에 쌓아 보여준다.

   청산 이벤트는 특정 유저 주소를 미리 알아야만 구독 가능해서(userEvents) 시장 전체를
   실시간으로 훑을 방법이 없다 — 대신 공개 trades 채널(주소를 몰라도 구독 가능)에서
   대형 체결을 걸러내는 방식으로 "누가 지금 크게 거래하는지"를 잡아낸다.
   행을 클릭하면 그 주소를 wallet-tracker 패널로 넘겨 실제 포지션/청산가까지 이어서 볼 수 있다. */

const WHALE_MAX_ROWS = 100;

const whaleToggleBtn = $('whaleToggleBtn');
const whalePanel = $('whalePanel');
const whaleThresholdInput = $('whaleThresholdInput');
const whaleThresholdApplyBtn = $('whaleThresholdApplyBtn');
const whaleThresholdCurrentEl = $('whaleThresholdCurrent');
const whaleEmptyMsg = $('whaleEmptyMsg');
const whaleRowsEl = $('whaleRows');

function connectWhaleWs(coin){
  state.whaleWs = closeSubscription(state.whaleWs);
  if(!coin || !state.whaleOpen) return; // 패널이 닫혀 있으면 구독하지 않음 (불필요한 트래픽 방지)
  state.whaleWs = createSubscription({
    subscription: { type: 'trades', coin },
    channels: 'trades',
    onData: (data) => {
      if(!Array.isArray(data)) return;
      let changed = false;
      for(const tr of data){
        const px = parseFloat(tr.px);
        const sz = parseFloat(tr.sz);
        if(!Number.isFinite(px) || !Number.isFinite(sz)) continue;
        const notional = px * sz;
        if(notional < state.whaleThreshold) continue;
        const isBuy = tr.side === 'B';
        // users는 항상 [buyer, seller] 순서 — 체결을 일으킨 쪽(테이커)의 주소만 보여준다.
        const addr = Array.isArray(tr.users) ? (isBuy ? tr.users[0] : tr.users[1]) : null;
        state.whaleTrades.unshift({ time: tr.time, isBuy, px, sz, notional, addr });
        changed = true;
      }
      if(!changed) return;
      if(state.whaleTrades.length > WHALE_MAX_ROWS) state.whaleTrades.length = WHALE_MAX_ROWS;
      scheduleFrame('whale', renderWhalePanel);
    },
  });
}

function toggleWhalePanel(){
  state.whaleOpen = !state.whaleOpen;
  whalePanel.style.display = state.whaleOpen ? 'flex' : 'none';
  whaleToggleBtn.classList.toggle('on', state.whaleOpen);
  store.set('whale_open', state.whaleOpen);
  if(state.whaleOpen){
    connectWhaleWs(state.coin);
  }else{
    state.whaleWs = closeSubscription(state.whaleWs);
  }
}
whaleToggleBtn.addEventListener('click', toggleWhalePanel);
if(state.whaleOpen){
  whalePanel.style.display = 'flex';
  whaleToggleBtn.classList.add('on');
}

// "Apply" 버튼(또는 입력창에서 Enter)을 눌러야만 기준이 바뀐다 — 입력 중에 매 타이핑마다
// 조용히 바뀌면 사용자가 실제로 반영됐는지 확인할 방법이 없어서, 확정 동작과 화면에 남는
// "현재 기준" 표시를 분리했다.
function renderWhaleThresholdCurrent(){
  whaleThresholdCurrentEl.textContent = t('whaleCurrentThreshold', formatBigNumber(state.whaleThreshold));
}
function applyWhaleThreshold(){
  const v = parseFloat(whaleThresholdInput.value);
  state.whaleThreshold = Number.isFinite(v) && v > 0 ? v : 0;
  whaleThresholdInput.value = state.whaleThreshold;
  store.set('whale_threshold', state.whaleThreshold);
  renderWhaleThresholdCurrent();
  // 눈에 띄는 확인 표시 — 짧게 강조색으로 깜빡이고 원래 색으로 돌아옴
  whaleThresholdCurrentEl.classList.remove('flash');
  void whaleThresholdCurrentEl.offsetWidth; // 리플로우를 강제해서 같은 값이 연속 적용돼도 애니메이션이 다시 재생되게 함
  whaleThresholdCurrentEl.classList.add('flash');
  setTimeout(() => whaleThresholdCurrentEl.classList.remove('flash'), 700);
}
whaleThresholdInput.value = state.whaleThreshold;
renderWhaleThresholdCurrent();
whaleThresholdApplyBtn.addEventListener('click', applyWhaleThreshold);
whaleThresholdInput.addEventListener('keydown', (e) => {
  if(e.key === 'Enter') applyWhaleThreshold();
});

// ---------- 렌더링 ----------
function shortenAddr(addr){
  return addr ? addr.slice(0, 6) + '…' + addr.slice(-4) : '—';
}

function renderWhalePanel(){
  const trades = state.whaleTrades;
  whaleEmptyMsg.style.display = trades.length ? 'none' : 'flex';
  whaleRowsEl.innerHTML = '';
  if(!trades.length) return;

  const frag = document.createDocumentFragment();
  trades.forEach(tr => {
    const row = document.createElement('div');
    row.className = 'wallet-row whale-row';
    row.title = tr.addr ? t('walletTrackBtn') + ' → ' + tr.addr : '';

    const mk = (cls, text) => {
      const s = document.createElement('span');
      if(cls) s.className = cls;
      s.textContent = text;
      return s;
    };
    row.appendChild(mk('', new Date(tr.time).toLocaleTimeString([], { hour12: false })));
    row.appendChild(mk('wallet-side ' + (tr.isBuy ? 'long' : 'short'), tr.isBuy ? t('walletLong') : t('walletShort')));
    row.appendChild(mk('', formatPrice(tr.px)));
    row.appendChild(mk('', '$' + formatBigNumber(tr.notional)));
    row.appendChild(mk('whale-addr', shortenAddr(tr.addr)));

    if(tr.addr){
      row.addEventListener('click', () => {
        if(!state.walletOpen) toggleWalletPanel();
        if(state.trackedWallet) untrackWallet();
        trackWallet(tr.addr); // 입력창 채우기는 trackWallet()이 알아서 함
      });
    }
    frag.appendChild(row);
  });
  whaleRowsEl.appendChild(frag);
}
renderWhalePanel();
