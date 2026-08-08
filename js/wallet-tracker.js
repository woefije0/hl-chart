/* wallet-tracker.js
   하이퍼리퀴드 특화 기능: 지갑 주소 하나를 "추적"하면 그 계정의 실제 포지션을 불러와서
   - 사이드 패널에 코인별 포지션 목록(방향/사이즈/진입가/청산가/PnL/레버리지)을 보여주고
   - 지금 보고 있는 코인에 그 지갑의 포지션이 있으면 진입가/청산가를 차트 위에 가격선으로 겹쳐 그린다.

   데이터 출처: POST /info { type: 'clearinghouseState', user: '0x...' } (공개 REST, 인증 불필요).
   포지션 변경을 실시간으로 밀어주는 공개 구독이 없어서(특정 유저의 포지션 갱신을 웹소켓으로
   받으려면 로그인한 본인 계정이어야 함), 패널이 열려있는 동안 REST를 짧은 간격으로 폴링한다. */

const WALLET_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const WALLET_FILLS_LIMIT = 50; // userFills는 최대 2000건을 돌려주는데, 패널 목록엔 최근 것만 보이면 충분

const walletToggleBtn = $('walletToggleBtn');
const walletPanel = $('walletPanel');
const walletAddressInput = $('walletAddressInput');
const walletTrackBtn = $('walletTrackBtn');
const walletStatusEl = $('walletStatus');
const walletTabsEl = $('walletTabs');
const walletTabPositionsBtn = $('walletTabPositions');
const walletTabHistoryBtn = $('walletTabHistory');
const walletColHeader = $('walletColHeader');
const walletHistoryColHeader = $('walletHistoryColHeader');
const walletEmptyMsg = $('walletEmptyMsg');
const walletPositionsEl = $('walletPositions');
const walletSummaryEl = $('walletSummary');

// ---------- 데이터 조회 ----------
// clearinghouseState: 무기한(perp) 계좌 - 포지션 + 마진 요약(계좌 총가치/사용 가능 잔고/사용 중인 마진)
// spotClearinghouseState: 스팟 계좌 잔고 (여기선 USDC 현물 잔고만 뽑아서 같이 보여줌)
async function fetchWalletState(address){
  const [perp, spot] = await Promise.all([
    info({ type: 'clearinghouseState', user: address }),
    info({ type: 'spotClearinghouseState', user: address }),
  ]);
  const positions = Array.isArray(perp && perp.assetPositions) ? perp.assetPositions : [];
  const unrealizedPnl = positions.reduce((sum, p) => sum + (parseFloat(p.position && p.position.unrealizedPnl) || 0), 0);
  // 총 포지션 가치: 롱/숏 방향과 무관하게 각 포지션의 현재 노셔널(positionValue, 항상 양수)을 그냥 더한 값.
  // 예: BTC 숏 1개 + ETH 롱 1개면 두 코인의 현재가를 그대로 더한 값이 된다.
  const totalPositionValue = positions.reduce((sum, p) => {
    const pv = p.position && parseFloat(p.position.positionValue);
    return sum + (Number.isFinite(pv) ? Math.abs(pv) : 0);
  }, 0);
  const spotUsdcEntry = Array.isArray(spot && spot.balances) ? spot.balances.find(b => b.coin === 'USDC') : null;
  const spotUsdcNum = spotUsdcEntry ? parseFloat(spotUsdcEntry.total) : NaN;

  // 계좌 총자본(하이퍼리퀴드 앱의 "Portfolio Value"): 공식 문서에 정확한 공식이 없어서 실계정
  // 두 개(마진 대부분을 교차 포지션에 걸어둔 대형 계좌 / 마진은 조금만 쓰고 스팟에 여유자금이
  // 많이 남은 계좌)로 직접 대조해서 맞춰봤다.
  //  - marginSummary.accountValue만 쓰면(예전) 스팟에 여유자금이 많이 남은 계좌에서 총자본을
  //    한참 과소평가한다 — 이번에 지적받은 케이스. 반대로
  //  - spotClearinghouseState의 USDC 잔고만 쓰면 마진을 많이 쓴 계좌에서 잔고가 거의 0으로
  //    나와서, "이미 마진으로 쓴 돈($X)이 계좌 총자본보다 크다"는 말이 안 되는 상황이 나온다
  //    (총자본은 정의상 항상 사용 중인 마진보다 커야 한다).
  // 그래서 둘 중 더 큰 쪽을 쓴다 — 마진사용액보다 작아지는 일이 없다는 게 보장되면서, 스팟에
  // 여유자금이 많이 남아있는 계좌에서도 그 여유자금이 반영된다. 정확한 사내 공식이 아니라
  // 근사치이므로, 이 값이 하이퍼리퀴드 앱 숫자와 조금 어긋날 수 있다는 점을 알아둘 것.
  const perpAccountValue = perp && perp.marginSummary ? parseFloat(perp.marginSummary.accountValue) : NaN;
  const accountValue = Number.isFinite(perpAccountValue) && Number.isFinite(spotUsdcNum)
    ? Math.max(perpAccountValue, spotUsdcNum) : (Number.isFinite(perpAccountValue) ? perpAccountValue : spotUsdcNum);
  const totalNtlPos = perp && perp.marginSummary ? parseFloat(perp.marginSummary.totalNtlPos) : NaN;

  // Unified Account Ratio: 하이퍼리퀴드 문서(account-abstraction-modes)에 나온 공식 그대로
  // — crossMaintenanceMarginUsed(교차 포지션들의 유지증거금) / (총자본 - 격리 마진 사용액).
  // 1.0(100%)에 가까울수록 청산 위험이 크다는 뜻.
  const isolatedMarginUsed = positions.reduce((sum, p) => {
    const pos = p.position;
    return sum + (pos && pos.leverage && pos.leverage.type === 'isolated' ? (parseFloat(pos.marginUsed) || 0) : 0);
  }, 0);
  const crossMaintenanceMarginUsed = perp ? parseFloat(perp.crossMaintenanceMarginUsed) : NaN;
  const availableForCross = accountValue - isolatedMarginUsed;
  let unifiedRatio = NaN;
  if(Number.isFinite(crossMaintenanceMarginUsed) && Number.isFinite(availableForCross)){
    unifiedRatio = availableForCross > 0 ? crossMaintenanceMarginUsed / availableForCross
      : (crossMaintenanceMarginUsed > 0 ? Infinity : 0);
  }

  // Unified Account Leverage: 총 노셔널 포지션 가치 / 총자본.
  const unifiedLeverage = (Number.isFinite(totalNtlPos) && Number.isFinite(accountValue) && accountValue > 0)
    ? totalNtlPos / accountValue : (Number.isFinite(totalNtlPos) && totalNtlPos === 0 ? 0 : NaN);

  const totalMarginUsed = perp && perp.marginSummary ? parseFloat(perp.marginSummary.totalMarginUsed) : NaN;
  // Available(출금 가능): clearinghouseState.withdrawable을 그대로 쓴다. 예전엔 이 필드가 "통합계좌에서
  // 늘 0을 반환한다"고 보고 10% 규칙을 직접 재구현했었는데, 그건 검증에 쓴 계좌가 마침 마진을 전부
  // 격리 포지션에 넣어둬서 실제로 출금 가능액이 0이었던 경우를 "필드가 고장났다"로 잘못 일반화한
  // 것이었다 — 다른 계좌로 다시 확인해보니 이 필드가 정확한 값을 그대로 돌려준다.
  const availableBalance = perp ? parseFloat(perp.withdrawable) : NaN;

  const summary = {
    totalPositionValue,
    accountValue,
    marginUsed: totalMarginUsed,
    withdrawable: availableBalance,
    unrealizedPnl,
    spotUsdc: spotUsdcNum,
    unifiedRatio,
    unifiedLeverage,
    // 디버그용 원본 값 — 하이퍼리퀴드 앱에 뜨는 숫자와 하나씩 대조해보기 위해 그대로 보존
    debugTotalNtlPos: totalNtlPos,
    debugPerpAccountValue: perpAccountValue,
    debugTotalRawUsd: perp && perp.marginSummary ? parseFloat(perp.marginSummary.totalRawUsd) : NaN,
  };
  return { positions, summary };
}

async function refreshWalletPositions(){
  if(!state.trackedWallet) return;
  // 최초 조회일 때만 "불러오는 중…" 표시 — 이미 값이 있는 상태에서 5초마다 도는 백그라운드
  // 폴링까지 매번 로딩 문구를 띄우면 화면이 계속 깜빡이는 것처럼 보인다.
  const isFirstLoad = state.walletSummary === null;
  if(isFirstLoad){
    state.walletLoading = true;
    renderWalletPanel();
  }
  try{
    const wallet = state.trackedWallet;
    const { positions, summary } = await fetchWalletState(wallet);
    if(state.trackedWallet !== wallet) return; // 조회 중 추적 해제되었거나 다른 주소로 바뀜
    state.walletPositions = positions;
    state.walletSummary = summary;
    state.walletError = null;
  }catch(err){
    console.warn('[HL Chart] 지갑 상태 조회 실패', err);
    state.walletError = 'walletFetchError';
  }finally{
    state.walletLoading = false;
    renderWalletPanel();
    updateWalletPriceLines();
  }
}

// userFills: 최근 체결 내역(시간 내림차순, 최신이 먼저). "포지션이 방금 큰 거래로 청산돼서
// 지금은 비어있다" 같은 경우를 확인할 수 있게, 포지션과 별도 탭으로 보여준다. 체결 이력은
// 포지션만큼 자주 바뀔 필요가 없어서(그리고 한 번에 최대 2000건이라 무거워서) 포지션처럼
// 상시 폴링하지 않고, 히스토리 탭을 열 때 + 새 지갑을 추적할 때만 불러온다.
async function fetchWalletFills(address){
  const fills = await info({ type: 'userFills', user: address });
  return Array.isArray(fills) ? fills.slice(0, WALLET_FILLS_LIMIT) : [];
}

async function refreshWalletFills(){
  if(!state.trackedWallet) return;
  const wallet = state.trackedWallet;
  state.walletFillsLoading = true;
  renderWalletPanel();
  try{
    const fills = await fetchWalletFills(wallet);
    if(state.trackedWallet !== wallet) return; // 조회 중 추적 해제되었거나 다른 주소로 바뀜
    state.walletFills = fills;
    state.walletFillsError = null;
  }catch(err){
    console.warn('[HL Chart] 체결 내역 조회 실패', err);
    state.walletFillsError = 'walletFillsFetchError';
  }finally{
    state.walletFillsLoading = false;
    state.walletFillsLoaded = true;
    renderWalletPanel();
  }
}

function startWalletPolling(){
  stopWalletPolling();
  state.walletPollTimer = setInterval(refreshWalletPositions, 5000);
}
function stopWalletPolling(){
  if(state.walletPollTimer){ clearInterval(state.walletPollTimer); state.walletPollTimer = null; }
}

// ---------- 추적 시작/해제 ----------
async function trackWallet(rawAddress){
  const address = (rawAddress || '').trim();
  if(!WALLET_ADDRESS_RE.test(address)){
    state.walletError = 'walletInvalidAddress';
    renderWalletPanel();
    return;
  }
  state.trackedWallet = address;
  state.walletError = null;
  walletAddressInput.value = address; // untrackWallet()이 입력창을 비우고 나서 바로 이어서 호출되는
                                       // 경우(고래 행 클릭으로 지갑을 갈아탈 때)에도 항상 여기서 다시 채워준다
  state.walletPositions = [];
  state.walletFills = [];
  state.walletFillsLoaded = false;
  state.walletFillsError = null;
  persistPrefs();
  renderWalletPanel();
  await refreshWalletPositions();
  if(state.walletOpen) startWalletPolling();
  if(state.walletTab === 'history') refreshWalletFills(); // 히스토리 탭을 보던 중이면 새 주소로 바로 이어서 불러옴
}

function untrackWallet(){
  state.trackedWallet = null;
  state.walletPositions = [];
  state.walletSummary = null;
  state.walletError = null;
  state.walletFills = [];
  state.walletFillsLoaded = false;
  state.walletFillsError = null;
  stopWalletPolling();
  persistPrefs();
  walletAddressInput.value = '';
  updateWalletPriceLines();
  renderWalletPanel();
}

// ---------- 포지션/히스토리 탭 전환 ----------
function setWalletTab(tab){
  if(state.walletTab === tab) return;
  state.walletTab = tab;
  renderWalletPanel();
  if(tab === 'history' && state.trackedWallet && !state.walletFillsLoaded) refreshWalletFills();
}
walletTabPositionsBtn.addEventListener('click', () => setWalletTab('positions'));
walletTabHistoryBtn.addEventListener('click', () => setWalletTab('history'));

walletTrackBtn.addEventListener('click', () => {
  if(state.trackedWallet) untrackWallet();
  else trackWallet(walletAddressInput.value);
});
walletAddressInput.addEventListener('keydown', (e) => {
  if(e.key === 'Enter' && !state.trackedWallet) trackWallet(walletAddressInput.value);
});

// ---------- 패널 토글 ----------
function toggleWalletPanel(){
  state.walletOpen = !state.walletOpen;
  walletPanel.style.display = state.walletOpen ? 'flex' : 'none';
  walletToggleBtn.classList.toggle('on', state.walletOpen);
  store.set('wallet_open', state.walletOpen);
  if(state.walletOpen){
    renderWalletPanel();
    if(state.trackedWallet){
      refreshWalletPositions();
      startWalletPolling();
      if(state.walletTab === 'history') refreshWalletFills();
    }
  }else{
    stopWalletPolling();
  }
}
walletToggleBtn.addEventListener('click', toggleWalletPanel);
if(state.walletOpen){
  walletPanel.style.display = 'flex';
  walletToggleBtn.classList.add('on');
}
if(state.trackedWallet) walletAddressInput.value = state.trackedWallet;

// ---------- 렌더링 ----------
function activePositions(){
  return (state.walletPositions || []).filter(p => p && p.position && parseFloat(p.position.szi) !== 0);
}

function renderWalletSummary(){
  const s = state.trackedWallet ? state.walletSummary : null;
  if(!s){
    walletSummaryEl.style.display = 'none';
    walletSummaryEl.innerHTML = '';
    return;
  }
  walletSummaryEl.style.display = 'flex';
  const pnlColor = s.unrealizedPnl >= 0 ? 'var(--up)' : 'var(--down)';
  const usd = (n) => Number.isFinite(n) ? '$' + formatBigNumber(n) : '—';
  const usdSigned = (n) => Number.isFinite(n) ? (n >= 0 ? '+$' : '-$') + formatBigNumber(Math.abs(n)) : '—';
  const pct = (n) => Number.isFinite(n) ? (n * 100).toFixed(1) + '%' : (n === Infinity ? '100%+' : '—');
  const lev = (n) => Number.isFinite(n) ? n.toFixed(2) + 'x' : '—';
  const debugTitle = `notional(totalNtlPos)=${usd(s.debugTotalNtlPos)} / totalBalance(max)=${usd(s.accountValue)} / perpAccountValue=${usd(s.debugPerpAccountValue)} / spotUsdcTotal=${usd(s.spotUsdc)} / totalRawUsd=${usd(s.debugTotalRawUsd)} / marginUsed=${usd(s.marginUsed)} / withdrawable=${usd(s.withdrawable)} / unrealizedPnl=${usdSigned(s.unrealizedPnl)}`;
  const ratioColor = !Number.isFinite(s.unifiedRatio) ? 'var(--text)' : s.unifiedRatio >= 0.8 ? 'var(--down)' : s.unifiedRatio >= 0.5 ? '#f6c309' : 'var(--up)';
  walletSummaryEl.innerHTML =
    `<span>${t('walletTotalPositionValue')} <b class="funding-summary-val">${usd(s.totalPositionValue)}</b></span>` +
    `<span>${t('walletAvailable')} <b class="funding-summary-val">${usd(s.withdrawable)}</b></span>` +
    `<span>${t('walletMarginUsed')} <b class="funding-summary-val">${usd(s.marginUsed)}</b></span>` +
    `<span>${t('walletUnrealizedPnl')} <b class="funding-summary-val" style="color:${pnlColor}">${usdSigned(s.unrealizedPnl)}</b></span>` +
    `<span>${t('walletUnifiedRatio')} <b class="funding-summary-val" style="color:${ratioColor}">${pct(s.unifiedRatio)}</b></span>` +
    `<span title="${debugTitle}">${t('walletUnifiedLeverage')} <b class="funding-summary-val">${lev(s.unifiedLeverage)}</b></span>` +
    (Number.isFinite(s.accountValue) ? `<span title="${debugTitle}">${t('walletSpotBalance')} <b class="funding-summary-val">${usd(s.accountValue)}</b></span>` : '');
}

function mkCell(cls, text){
  const s = document.createElement('span');
  if(cls) s.className = cls;
  s.textContent = text;
  return s;
}

function renderPositionRows(){
  const positions = activePositions();
  const frag = document.createDocumentFragment();
  positions.forEach(entry => {
    const pos = entry.position;
    const szi = parseFloat(pos.szi);
    const isLong = szi > 0;
    const entryPx = parseFloat(pos.entryPx);
    const liqPx = pos.liquidationPx != null ? parseFloat(pos.liquidationPx) : NaN;
    const pnl = parseFloat(pos.unrealizedPnl);
    const lev = pos.leverage && pos.leverage.value;

    const row = document.createElement('div');
    row.className = 'wallet-row' + (pos.coin === state.coin ? ' current' : '');
    row.title = t('walletRowGoto');

    row.appendChild(mkCell('wallet-coin', pos.coin));
    row.appendChild(mkCell('wallet-side ' + (isLong ? 'long' : 'short'), isLong ? t('walletLong') : t('walletShort')));
    row.appendChild(mkCell('', Number.isFinite(szi) ? formatPrice(Math.abs(szi)) : '—'));
    row.appendChild(mkCell('', Number.isFinite(entryPx) ? formatPrice(entryPx) : '—'));
    row.appendChild(mkCell('wallet-liq', Number.isFinite(liqPx) && liqPx > 0 ? formatPrice(liqPx) : '—'));
    row.appendChild(mkCell(Number.isFinite(pnl) && pnl >= 0 ? 'wallet-pnl-pos' : 'wallet-pnl-neg',
      Number.isFinite(pnl) ? (pnl >= 0 ? '+' : '') + pnl.toFixed(2) : '—'));
    row.appendChild(mkCell('', lev ? lev + 'x' : '—'));

    row.addEventListener('click', () => {
      const pair = (state.allPairs || []).find(p => p.coin === pos.coin && p.type === 'PERP');
      if(pair) selectPair(pair);
    });
    frag.appendChild(row);
  });
  return frag;
}

// dir은 하이퍼리퀴드가 그대로 내려주는 "Open Long"/"Close Short" 같은 설명 문구라
// 굳이 다시 옮기지 않고 그대로 쓴다(하이퍼리퀴드 공식 앱과 동일한 용어).
function renderHistoryRows(){
  const frag = document.createDocumentFragment();
  state.walletFills.forEach(fill => {
    const px = parseFloat(fill.px);
    const sz = parseFloat(fill.sz);
    const pnl = parseFloat(fill.closedPnl);
    const isBuy = fill.side === 'B';

    const row = document.createElement('div');
    row.className = 'wallet-row' + (fill.coin === state.coin ? ' current' : '');
    row.title = new Date(fill.time).toLocaleString();

    row.appendChild(mkCell('wallet-coin', fill.coin));
    row.appendChild(mkCell('wallet-side ' + (isBuy ? 'long' : 'short'), fill.dir || (isBuy ? t('walletLong') : t('walletShort'))));
    row.appendChild(mkCell('', Number.isFinite(sz) ? formatPrice(sz) : '—'));
    row.appendChild(mkCell('', Number.isFinite(px) ? formatPrice(px) : '—'));
    row.appendChild(mkCell(pnl > 0 ? 'wallet-pnl-pos' : pnl < 0 ? 'wallet-pnl-neg' : '',
      pnl ? (pnl >= 0 ? '+' : '') + pnl.toFixed(2) : '—'));

    row.addEventListener('click', () => {
      const pair = (state.allPairs || []).find(p => p.coin === fill.coin && p.type === 'PERP');
      if(pair) selectPair(pair);
    });
    frag.appendChild(row);
  });
  return frag;
}

function renderWalletPanel(){
  walletAddressInput.disabled = !!state.trackedWallet;
  walletTrackBtn.textContent = state.trackedWallet ? t('walletUntrackBtn') : t('walletTrackBtn');
  walletTrackBtn.classList.toggle('wallet-untrack', !!state.trackedWallet);
  renderWalletSummary();

  walletTabsEl.style.display = state.trackedWallet ? 'flex' : 'none';
  walletTabPositionsBtn.classList.toggle('active', state.walletTab === 'positions');
  walletTabHistoryBtn.classList.toggle('active', state.walletTab === 'history');

  const onHistoryTab = state.walletTab === 'history';
  const loading = onHistoryTab ? state.walletFillsLoading : state.walletLoading;
  const error = onHistoryTab ? state.walletFillsError : state.walletError;
  if(loading){
    walletStatusEl.style.display = 'flex';
    walletStatusEl.textContent = t(onHistoryTab ? 'walletFillsLoading' : 'walletLoading');
  }else if(error){
    walletStatusEl.style.display = 'flex';
    walletStatusEl.textContent = t(error);
  }else{
    walletStatusEl.style.display = 'none';
  }

  walletPositionsEl.innerHTML = '';
  const list = state.trackedWallet ? (onHistoryTab ? state.walletFills : activePositions()) : [];
  const showEmpty = !loading && (!state.trackedWallet || (!list.length && !error));
  walletEmptyMsg.style.display = showEmpty ? 'flex' : 'none';
  walletEmptyMsg.textContent = !state.trackedWallet ? t('walletNotTracking') : t(onHistoryTab ? 'walletNoFills' : 'walletNoPositions');
  walletColHeader.style.display = (!onHistoryTab && list.length) ? 'flex' : 'none';
  walletHistoryColHeader.style.display = (onHistoryTab && list.length) ? 'flex' : 'none';
  if(!list.length) return;

  walletPositionsEl.appendChild(onHistoryTab ? renderHistoryRows() : renderPositionRows());
}

// ---------- 메인 차트에 진입가/청산가 가격선 겹쳐 그리기 ----------
// selectPair(코인 전환)와 recreateMainSeries(캔들 유형/차트 재생성) 양쪽에서 다 호출된다.
// removeSeries()가 이전 시리즈에 붙어있던 가격선도 같이 지워버리므로, 매번 참조를 지우고
// 다시 만드는 방식이 가장 단순하고 안전하다.
function updateWalletPriceLines(){
  const lines = state.walletPriceLines;
  if(lines.entry){ try{ state.candleSeries && state.candleSeries.removePriceLine(lines.entry); }catch(e){} lines.entry = null; }
  if(lines.liq){ try{ state.candleSeries && state.candleSeries.removePriceLine(lines.liq); }catch(e){} lines.liq = null; }
  if(!state.candleSeries || !state.trackedWallet || !state.coin) return;

  const match = activePositions().find(p => p.position.coin === state.coin);
  if(!match) return;
  const pos = match.position;
  const isLong = parseFloat(pos.szi) > 0;
  const entryPx = parseFloat(pos.entryPx);
  const liqPx = pos.liquidationPx != null ? parseFloat(pos.liquidationPx) : NaN;

  if(Number.isFinite(entryPx)){
    lines.entry = state.candleSeries.createPriceLine({
      price: entryPx,
      color: isLong ? '#4fd1c5' : '#ef6f6f',
      lineWidth: 2,
      lineStyle: LightweightCharts.LineStyle.Solid,
      axisLabelVisible: true,
      title: t('walletEntryLineLabel'),
    });
  }
  if(Number.isFinite(liqPx) && liqPx > 0){
    lines.liq = state.candleSeries.createPriceLine({
      price: liqPx,
      color: '#ff3b30',
      lineWidth: 2,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      axisLabelVisible: true,
      title: t('walletLiqLineLabel'),
    });
  }
}
