/* mini-panels.js
   Multi-chart layout (1 / 2 / 4) and the mini chart panels. */

// ---------- 멀티차트(미니 패널) ----------
// "1 / 2 / 4" 레이아웃 스위치. 메인 차트(모든 지표/상단바 포함)는 항상 첫 번째 칸에 그대로 남고,
// 2 또는 4를 고르면 나머지 칸에 단순화된 미니 차트(페어/인터벌 선택 가능, 캔들+거래량만 표시)가 추가됨.
// 미니 차트는 초단위(tick)/합성(agg) 인터벌은 지원하지 않고 하이퍼리퀴드 API가 그대로 주는
// native 인터벌만 사용해서 로직을 가볍게 유지함.
const NATIVE_INTERVALS = Object.keys(INTERVAL_META).filter(iv => INTERVAL_META[iv].kind === 'native');
const MINI_DEFAULT_CANDIDATES = [['ETH'], ['SOL'], ['HYPE']];

const mainGrid = document.getElementById('mainGrid');
let miniPanels = [];

async function createMiniPanel(containerEl, defaultCandidates){
  containerEl.innerHTML = `
    <div class="mini-header">
      <div class="mini-select">
        <button class="mini-btn mini-pair-btn" type="button">…</button>
        <div class="dropdown mini-dropdown"><div class="dropdown-search"><input type="text" class="mini-pair-search" autocomplete="off"></div><div class="dropdown-list mini-pair-list"></div></div>
      </div>
      <div class="mini-select">
        <button class="mini-btn mini-interval-btn" type="button">15m</button>
        <div class="dropdown mini-dropdown" style="width:140px"><div class="dropdown-list mini-interval-list"></div></div>
      </div>
      <span class="mini-price">—</span>
    </div>
    <div class="mini-chart"></div>
  `;

  const pairBtn = containerEl.querySelector('.mini-pair-btn');
  const pairDropdown = containerEl.querySelector('.mini-select:nth-child(1) .dropdown');
  const pairSearch = containerEl.querySelector('.mini-pair-search');
  const pairList = containerEl.querySelector('.mini-pair-list');
  const intervalBtn = containerEl.querySelector('.mini-interval-btn');
  const intervalDropdown = containerEl.querySelector('.mini-select:nth-child(2) .dropdown');
  const intervalList = containerEl.querySelector('.mini-interval-list');
  const priceEl = containerEl.querySelector('.mini-price');
  const chartEl = containerEl.querySelector('.mini-chart');

  const mstate = { coin: null, label: '', interval: '15m', chart: null, candleSeries: null, volumeSeries: null, ws: null, bars: [] };

  function renderPairList(query){
    pairList.innerHTML = '';
    const q = (query || '').trim().toUpperCase();
    const pool = state.allPairs || [];
    const results = q ? pool.filter(p => p.label.toUpperCase().includes(q) || p.coin.toUpperCase().includes(q)) : pool;

    const groups = [
      { title: 'PERPETUAL', items: results.filter(p => p.type === 'PERP' && !p.isHip3) },
      { title: 'HIP-3', items: results.filter(p => p.type === 'PERP' && p.isHip3) },
      { title: 'SPOT', items: results.filter(p => p.type === 'SPOT') },
    ].filter(g => g.items.length > 0);

    if(!groups.length){
      const empty = document.createElement('div');
      empty.className = 'dropdown-empty';
      empty.textContent = t('noMatchingPairs');
      pairList.appendChild(empty);
      return;
    }
    groups.forEach(g => {
      const header = document.createElement('div');
      header.className = 'dropdown-header';
      header.textContent = `${g.title} (${g.items.length})`;
      pairList.appendChild(header);
      g.items.forEach(p => {
        pairList.appendChild(makeDropdownRow({
          active: mstate.coin === p.coin,
          label: p.label,
          badge: { className: p.isHip3 ? 'HIP3' : p.type, text: p.isHip3 ? 'HIP-3' : p.type },
          onClick: () => { selectMiniPair(p); pairCtrl.close(); },
        }));
      });
    });
  }
  const pairCtrl = createDropdown(pairBtn, pairDropdown, () => { pairSearch.value = ''; renderPairList(''); });
  pairSearch.addEventListener('input', () => renderPairList(pairSearch.value));
  pairSearch.addEventListener('click', e => e.stopPropagation());

  function renderIntervalList(){
    intervalList.innerHTML = '';
    NATIVE_INTERVALS.forEach(iv => {
      intervalList.appendChild(makeDropdownRow({
        active: mstate.interval === iv,
        label: iv,
        onClick: () => { selectMiniInterval(iv); intervalCtrl.close(); },
      }));
    });
  }
  const intervalCtrl = createDropdown(intervalBtn, intervalDropdown, renderIntervalList);

  await window.__chartLibReady;
  if(window.__chartLibFailed || typeof LightweightCharts === 'undefined') return { destroy(){ containerEl.remove(); } };

  mstate.chart = LightweightCharts.createChart(chartEl, {
    layout: { background: { color: '#0a0d12' }, textColor: '#6b7686', fontFamily: "'JetBrains Mono', monospace", fontSize: 10 },
    grid: { vertLines: { color: '#151a22' }, horzLines: { color: '#151a22' } },
    rightPriceScale: { borderColor: '#212833', autoScale: true },
    timeScale: { borderColor: '#212833', timeVisible: true, secondsVisible: false },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
  });
  mstate.candleSeries = mstate.chart.addCandlestickSeries({
    upColor: '#4fd1c5', downColor: '#ef6f6f', borderVisible: false,
    wickUpColor: '#4fd1c5', wickDownColor: '#ef6f6f',
    priceScaleId: 'right',
    priceFormat: { type: 'custom', formatter: (price) => formatPrice(price) },
  });
  mstate.chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.1, bottom: 0.25 } });
  mstate.volumeSeries = mstate.chart.addHistogramSeries({
    priceFormat: { type: 'volume' }, priceScaleId: 'left',
    priceLineVisible: false,
    lastValueVisible: false,
  });
  mstate.chart.priceScale('left').applyOptions({ visible: false, scaleMargins: { top: 0.82, bottom: 0 } });

  const ro = new ResizeObserver(entries => {
    const { width, height } = entries[0].contentRect;
    mstate.chart.resize(width, height);
  });
  ro.observe(chartEl);

  async function loadMiniHistory(){
    if(!mstate.coin) return;
    try{
      const raw = await fetchHistory(mstate.coin, mstate.interval);
      let bars = raw.map(toChartCandle);
      const deduped = [];
      for(const b of bars){
        if(deduped.length && deduped[deduped.length - 1].time === b.time) deduped[deduped.length - 1] = b;
        else deduped.push(b);
      }
      bars = deduped.filter(b =>
        Number.isFinite(b.open) && Number.isFinite(b.high) && Number.isFinite(b.low) && Number.isFinite(b.close) &&
        b.open > 0 && b.high > 0 && b.low > 0 && b.close > 0 && b.high >= b.low
      );
      mstate.bars = bars;
      mstate.candleSeries.setData(bars);
      mstate.volumeSeries.setData(bars.map(volPoint));
      if(bars.length){
        mstate.chart.timeScale().fitContent();
        priceEl.textContent = formatPrice(bars[bars.length - 1].close);
      }
    }catch(err){
      console.error('[mini panel]', err);
      priceEl.textContent = '—';
    }
  }

  function connectMiniWs(){
    if(mstate.ws){ try{ mstate.ws.close(); }catch(e){} mstate.ws = null; }
    if(!mstate.coin) return;
    const coin = mstate.coin, interval = mstate.interval;
    const ws = new WebSocket('wss://api.hyperliquid.xyz/ws');
    mstate.ws = ws;
    ws.onopen = () => {
      if(mstate.ws !== ws) return;
      ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'candle', coin, interval } }));
    };
    ws.onmessage = (ev) => {
      if(mstate.ws !== ws) return;
      let msg; try{ msg = JSON.parse(ev.data); }catch(e){ return; }
      if(msg.channel !== 'candle' || !msg.data) return;
      const c = toChartCandle(msg.data);
      if(!Number.isFinite(c.open) || !Number.isFinite(c.close) || c.open <= 0 || c.close <= 0) return;
      const bars = mstate.bars;
      if(bars.length && bars[bars.length - 1].time === c.time) bars[bars.length - 1] = c;
      else bars.push(c);
      mstate.candleSeries.update(c);
      mstate.volumeSeries.update(volPoint(c));
      priceEl.textContent = formatPrice(c.close);
    };
    ws.onclose = () => {
      if(mstate.ws === ws) setTimeout(() => { if(mstate.ws === ws) connectMiniWs(); }, 3000);
    };
  }

  async function selectMiniPair(p){
    mstate.coin = p.coin; mstate.label = p.label;
    pairBtn.textContent = p.label;
    pairBtn.title = p.label;
    await loadMiniHistory();
    connectMiniWs();
  }
  async function selectMiniInterval(iv){
    mstate.interval = iv;
    intervalBtn.textContent = iv;
    await loadMiniHistory();
    connectMiniWs();
  }

  pairBtn.textContent = t('miniSelectPair');
  intervalBtn.textContent = mstate.interval;

  // 기본 페어 자동 선택 (전체 페어 목록이 이미 로드돼 있으면 즉시, 아니면 로드를 기다림)
  (async () => {
    if(!state.allPairsLoaded){
      let tries = 0;
      while(!state.allPairsLoaded && tries < 50){ await new Promise(r => setTimeout(r, 200)); tries++; }
    }
    for(const candidates of defaultCandidates){
      const match = findByCandidates(candidates);
      if(match){ await selectMiniPair(match); break; }
    }
  })();

  return {
    destroy(){
      if(mstate.ws){ try{ mstate.ws.close(); }catch(e){} mstate.ws = null; }
      ro.disconnect();
      mstate.chart.remove();
      containerEl.remove();
    },
  };
}

function setLayout(n){
  [1, 2, 4].forEach(v => document.getElementById('layoutBtn' + v).classList.toggle('active', v === n));
  mainGrid.classList.remove('layout-1', 'layout-2', 'layout-4');
  mainGrid.classList.add('layout-' + n);

  const needed = n - 1;
  while(miniPanels.length > needed){
    miniPanels.pop().destroy();
  }
  while(miniPanels.length < needed){
    const idx = miniPanels.length;
    const el = document.createElement('div');
    el.className = 'mini-panel';
    mainGrid.appendChild(el);
    const candidates = MINI_DEFAULT_CANDIDATES[idx % MINI_DEFAULT_CANDIDATES.length];
    // createMiniPanel is async; push a placeholder immediately so the count/order stays correct
    const placeholder = { destroy(){ el.remove(); } };
    miniPanels.push(placeholder);
    createMiniPanel(el, [candidates]).then(ctrl => {
      const i = miniPanels.indexOf(placeholder);
      if(i !== -1) miniPanels[i] = ctrl;
      else ctrl.destroy(); // 이미 레이아웃이 바뀌어 이 패널이 필요 없어진 경우
    });
  }
}
[1, 2, 4].forEach(n => {
  document.getElementById('layoutBtn' + n).addEventListener('click', () => setLayout(n));
});
