/* wallet-tracker.js
   하이퍼리퀴드 특화 기능: 지갑 주소 하나를 "추적"하면 그 계정의 실제 포지션을 불러와서
   - 사이드 패널에 코인별 포지션 목록(방향/사이즈/진입가/청산가/PnL/레버리지)을 보여주고
   - 지금 보고 있는 코인에 그 지갑의 포지션이 있으면 진입가/청산가를 차트 위에 가격선으로 겹쳐 그린다.

   데이터 출처: POST /info { type: 'clearinghouseState', user: '0x...' } (공개 REST, 인증 불필요).
   포지션은 틱 단위로 안 바뀌므로 웹소켓 대신 패널이 열려있는 동안만 20초 간격 폴링한다. */

const WALLET_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const walletToggleBtn = $('walletToggleBtn');
const walletPanel = $('walletPanel');
const walletAddressInput = $('walletAddressInput');
const walletTrackBtn = $('walletTrackBtn');
const walletStatusEl = $('walletStatus');
const walletColHeader = $('walletColHeader');
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
  const spotUsdc = Array.isArray(spot && spot.balances)
    ? (spot.balances.find(b => b.coin === 'USDC') || {}).total
    : undefined;
  const spotUsdcNum = spotUsdc != null ? parseFloat(spotUsdc) : NaN;

  // Unified Account Ratio: 하이퍼리퀴드 문서(account-abstraction-modes)에 나온 공식.
  // crossMaintenanceMarginUsed(교차마진 포지션들이 요구하는 유지증거금) / (스팟 담보 - 격리마진 사용액).
  // 1.0(100%)에 가까울수록 청산 위험이 크다는 뜻. 원래 공식은 모든 HIP-3 DEX를 합산하지만,
  // 여기선 우리가 조회하는 기본(native) 퍼프 DEX + USDC 담보 기준으로만 계산한다.
  const isolatedMarginUsed = positions.reduce((sum, p) => {
    const pos = p.position;
    return sum + (pos && pos.leverage && pos.leverage.type === 'isolated' ? (parseFloat(pos.marginUsed) || 0) : 0);
  }, 0);
  const crossMaintenanceMarginUsed = perp ? parseFloat(perp.crossMaintenanceMarginUsed) : NaN;
  const availableForCross = spotUsdcNum - isolatedMarginUsed;
  let unifiedRatio = NaN;
  if(Number.isFinite(crossMaintenanceMarginUsed) && Number.isFinite(availableForCross)){
    unifiedRatio = availableForCross > 0 ? crossMaintenanceMarginUsed / availableForCross
      : (crossMaintenanceMarginUsed > 0 ? Infinity : 0);
  }

  // Unified Account Leverage: 실계정으로 역산 검증한 결과, 분모는 marginSummary.accountValue(perp쪽, 평가손익 포함)가
  // 아니라 "Total Balance"(spotClearinghouseState의 USDC 잔고 — 통합계좌라서 이게 곧 하이퍼리퀴드가 앱에 표시하는
  // Total Balance와 정확히 일치함) 그 자체였다. totalNtlPos / Total Balance = 실제 값과 일치.
  const crossSummary = perp && perp.crossMarginSummary;
  const totalNtlPos = crossSummary ? parseFloat(crossSummary.totalNtlPos) : NaN;
  const crossAccountValue = crossSummary ? parseFloat(crossSummary.accountValue) : NaN;
  const leverageBase = Number.isFinite(spotUsdcNum) && spotUsdcNum > 0 ? spotUsdcNum : crossAccountValue; // 스팟 조회 실패 시에만 대체
  const unifiedLeverage = (Number.isFinite(totalNtlPos) && Number.isFinite(leverageBase) && leverageBase > 0)
    ? totalNtlPos / leverageBase : (Number.isFinite(totalNtlPos) && totalNtlPos === 0 ? 0 : NaN);

  // Available(출금 가능): clearinghouseState.withdrawable은 이 통합계좌에서 늘 0을 반환해서(마찬가지로
  // "not meaningful" 필드) 쓸 수 없었다. 대신 문서의 인출 규칙 — "인출 후 남는 마진이 전체 notional
  // 포지션 가치의 최소 10% 이상이어야 한다" — 을 그대로 적용: Total Balance에서 (실제 사용 마진, 명목가치의
  // 10%) 중 더 큰 쪽을 뺀다. 실계정으로 검증해서 $1 미만 오차로 맞아떨어지는 걸 확인함.
  const totalMarginUsed = perp && perp.marginSummary ? parseFloat(perp.marginSummary.totalMarginUsed) : NaN;
  const tenPctFloor = Number.isFinite(totalNtlPos) ? 0.1 * totalNtlPos : NaN;
  const requiredMargin = Number.isFinite(totalMarginUsed) && Number.isFinite(tenPctFloor) ? Math.max(totalMarginUsed, tenPctFloor) : NaN;
  const availableBalance = Number.isFinite(spotUsdcNum) && Number.isFinite(requiredMargin)
    ? Math.max(spotUsdcNum - requiredMargin, 0)
    : (perp ? parseFloat(perp.withdrawable) : NaN); // 스팟/포지션 정보가 없으면 원래 필드로 대체

  const summary = {
    accountValue: perp && perp.marginSummary ? parseFloat(perp.marginSummary.accountValue) : NaN,
    marginUsed: totalMarginUsed,
    withdrawable: availableBalance,
    unrealizedPnl,
    spotUsdc: spotUsdcNum,
    unifiedRatio,
    unifiedLeverage,
    // 디버그용 원본 값 — 하이퍼리퀴드 앱에 뜨는 숫자와 하나씩 대조해보기 위해 그대로 보존
    debugTotalNtlPos: totalNtlPos,
    debugCrossAccountValue: crossAccountValue,
    debugMarginAccountValue: perp && perp.marginSummary ? parseFloat(perp.marginSummary.accountValue) : NaN,
    debugTotalRawUsd: crossSummary ? parseFloat(crossSummary.totalRawUsd) : NaN,
    debugTenPctFloor: tenPctFloor,
    debugRawWithdrawable: perp ? parseFloat(perp.withdrawable) : NaN,
  };
  return { positions, summary };
}

async function refreshWalletPositions(){
  if(!state.trackedWallet) return;
  state.walletLoading = true;
  renderWalletPanel();
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

function startWalletPolling(){
  stopWalletPolling();
  state.walletPollTimer = setInterval(refreshWalletPositions, 20000);
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
  state.walletPositions = [];
  persistPrefs();
  renderWalletPanel();
  await refreshWalletPositions();
  if(state.walletOpen) startWalletPolling();
}

function untrackWallet(){
  state.trackedWallet = null;
  state.walletPositions = [];
  state.walletSummary = null;
  state.walletError = null;
  stopWalletPolling();
  persistPrefs();
  walletAddressInput.value = '';
  updateWalletPriceLines();
  renderWalletPanel();
}

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
    if(state.trackedWallet){ refreshWalletPositions(); startWalletPolling(); }
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
  const debugTitle = `notional(totalNtlPos)=${usd(s.debugTotalNtlPos)} / crossAccountValue=${usd(s.debugCrossAccountValue)} / marginSummary.accountValue=${usd(s.debugMarginAccountValue)} / totalRawUsd=${usd(s.debugTotalRawUsd)} / totalBalance=${usd(s.spotUsdc)} / marginUsed=${usd(s.marginUsed)} / 10%floor=${usd(s.debugTenPctFloor)} / rawWithdrawable=${usd(s.debugRawWithdrawable)} / unrealizedPnl=${usdSigned(s.unrealizedPnl)}`;
  const ratioColor = !Number.isFinite(s.unifiedRatio) ? 'var(--text)' : s.unifiedRatio >= 0.8 ? 'var(--down)' : s.unifiedRatio >= 0.5 ? '#f6c309' : 'var(--up)';
  walletSummaryEl.innerHTML =
    `<span>${t('walletAccountValue')} <b class="funding-summary-val">${usd(s.accountValue)}</b></span>` +
    `<span>${t('walletAvailable')} <b class="funding-summary-val">${usd(s.withdrawable)}</b></span>` +
    `<span>${t('walletMarginUsed')} <b class="funding-summary-val">${usd(s.marginUsed)}</b></span>` +
    `<span>${t('walletUnrealizedPnl')} <b class="funding-summary-val" style="color:${pnlColor}">${usdSigned(s.unrealizedPnl)}</b></span>` +
    `<span>${t('walletUnifiedRatio')} <b class="funding-summary-val" style="color:${ratioColor}">${pct(s.unifiedRatio)}</b></span>` +
    `<span title="${debugTitle}">${t('walletUnifiedLeverage')} <b class="funding-summary-val">${lev(s.unifiedLeverage)}</b></span>` +
    (Number.isFinite(s.spotUsdc) ? `<span title="${debugTitle}">${t('walletSpotBalance')} <b class="funding-summary-val">${usd(s.spotUsdc)}</b></span>` : '');
}

function renderWalletPanel(){
  walletAddressInput.disabled = !!state.trackedWallet;
  walletTrackBtn.textContent = state.trackedWallet ? t('walletUntrackBtn') : t('walletTrackBtn');
  walletTrackBtn.classList.toggle('wallet-untrack', !!state.trackedWallet);
  renderWalletSummary();

  if(state.walletLoading){
    walletStatusEl.style.display = 'flex';
    walletStatusEl.textContent = t('walletLoading');
  }else if(state.walletError){
    walletStatusEl.style.display = 'flex';
    walletStatusEl.textContent = t(state.walletError);
  }else{
    walletStatusEl.style.display = 'none';
  }

  walletPositionsEl.innerHTML = '';
  const positions = state.trackedWallet ? activePositions() : [];
  const showEmpty = !state.walletLoading && (!state.trackedWallet || (state.trackedWallet && !positions.length && !state.walletError));
  walletEmptyMsg.style.display = showEmpty ? 'flex' : 'none';
  walletEmptyMsg.textContent = state.trackedWallet ? t('walletNoPositions') : t('walletNotTracking');
  walletColHeader.style.display = positions.length ? 'flex' : 'none';
  if(!positions.length) return;

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

    const mk = (cls, text) => {
      const s = document.createElement('span');
      if(cls) s.className = cls;
      s.textContent = text;
      return s;
    };
    row.appendChild(mk('wallet-coin', pos.coin));
    row.appendChild(mk('wallet-side ' + (isLong ? 'long' : 'short'), isLong ? t('walletLong') : t('walletShort')));
    row.appendChild(mk('', Number.isFinite(szi) ? formatPrice(Math.abs(szi)) : '—'));
    row.appendChild(mk('', Number.isFinite(entryPx) ? formatPrice(entryPx) : '—'));
    row.appendChild(mk('wallet-liq', Number.isFinite(liqPx) && liqPx > 0 ? formatPrice(liqPx) : '—'));
    row.appendChild(mk(Number.isFinite(pnl) && pnl >= 0 ? 'wallet-pnl-pos' : 'wallet-pnl-neg',
      Number.isFinite(pnl) ? (pnl >= 0 ? '+' : '') + pnl.toFixed(2) : '—'));
    row.appendChild(mk('', lev ? lev + 'x' : '—'));

    row.addEventListener('click', () => {
      const pair = (state.allPairs || []).find(p => p.coin === pos.coin && p.type === 'PERP');
      if(pair) selectPair(pair);
    });
    frag.appendChild(row);
  });
  walletPositionsEl.appendChild(frag);
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
