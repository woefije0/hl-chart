/* pair-select.js
   Loading more history, switching pair / interval / chart type. */

// ---------- 뒤로 스크롤하면 과거 데이터를 이어서 불러오기 ----------
const chartLoadingOverlayEl = document.getElementById('chartLoadingOverlay');
function showChartLoadingOverlay(){ chartLoadingOverlayEl.style.display = 'flex'; }
function hideChartLoadingOverlay(){ chartLoadingOverlayEl.style.display = 'none'; }

async function loadMoreHistory(){
  if(state.replayMode || state.loadingMore || state.noMoreHistory || !state.coin || !state.currentBars.length) return;
  const meta = INTERVAL_META[state.interval];

  state.loadingMore = true;
  try{
    const earliestMs = state.currentBars[0].time * 1000;
    let olderBars;
    if(meta.kind === 'agg'){
      // 서버 요청은 base(1m)로, 기간 계산은 목표 인터벌(state.interval) 기준으로 — fetchHistory 주석 참고
      const history = await fetchHistory(state.coin, meta.base, earliestMs, state.interval);
      // 최초 로드(selectPair)에서는 fillGaps를 쓰는데 여기서만 빠져 있어서, 과거로 스크롤해
      // 이어붙인 구간만 체결 없는 시간대가 통째로 비어 보였다. 동일하게 맞춘다.
      olderBars = fillGaps(buildAggCandles(history.map(toChartCandle), meta.ms), meta.ms / 1000);
    }else{
      const history = await fetchHistory(state.coin, state.interval, earliestMs);
      olderBars = history.map(toChartCandle);
    }
    olderBars = olderBars.filter(b => b.time < state.currentBars[0].time);

    if(olderBars.length === 0){
      state.noMoreHistory = true;
      return;
    }

    const range = state.chart.timeScale().getVisibleLogicalRange();
    state.currentBars = [...olderBars, ...state.currentBars];
    rebuildBarIndex();
    // toMainSeriesData()로 현재 차트 유형(Heikin Ashi/Volume Candle/Line/Area/Baseline)에 맞는
    // 변환을 거친다 — 예전엔 여기서 원시 OHLC를 그대로 넣어서, 과거 데이터를 이어붙일 때마다
    // (그리고 fitContent() 직후 자동으로) 변환된 표시가 원시 캔들로 되돌아가 보였다.
    const seriesData = toMainSeriesData(state.currentBars);
    state.candleSeries.setData(seriesData);
    state.volumeSeries.setData(state.currentBars.map(volPoint));
    refreshEmaBandFull();
    refreshBBFull();
    refreshVwapFull();
    refreshMaRibbonFull();
    refreshRsiFull();
    refreshMacdFull();
    // 과거 봉이 앞에 붙으면 봉 개수가 늘어난다. Pine 지표도 같이 다시 계산해주지 않으면
    // 패널 차트만 예전 봉 개수를 유지해서, 늘어난 개수만큼 시간축이 통째로 어긋난다.
    if(typeof refreshAllPineScripts === 'function') refreshAllPineScripts();
    if(range){
      state.chart.timeScale().setVisibleLogicalRange({
        from: range.from + olderBars.length,
        to: range.to + olderBars.length,
      });
    }
  }catch(e){
    console.error('loadMoreHistory 실패', e);
  }finally{
    state.loadingMore = false;
  }
}

// ---------- pair 선택 ----------
async function selectPair(pair){
  if(state.replayMode || state.replayPicking) stopReplaySession(); // 페어를 바꾸면 리플레이 슬라이스는 의미가 없어짐
  const coinChanged = state.coin !== pair.coin;
  state.coin = pair.coin;
  state.label = pair.label;
  state.isSpot = pair.type === 'SPOT';
  state.liveAgg = null;
  state.currentBars = [];
  state.loadingMore = false;
  state.noMoreHistory = false;
  state.hoverCandle = null;
  renderFavorites();
  $('coinLabel').textContent = pair.coin + ' (' + pair.type + ')';

  if(coinChanged){
    state.todayCandle = null;
    fetchTodayCandle(pair.coin).then(c => {
      if(state.coin !== pair.coin) return; // 그 사이 다른 페어로 전환됨
      state.todayCandle = c;
      renderTodayIfNotHovering();
    });
    connectTodayWs(pair.coin);
    connectAssetCtxWs(pair.coin, pair.type === 'SPOT');
    connectOrderbookWs(pair.coin); // 패널이 닫혀 있으면 내부에서 구독을 건너뜀
    // 펀딩비 히스토리는 캔들 인터벌과 무관하게 코인 단위 데이터라서, 인터벌만 바뀔 땐 다시 부르지 않는다.
    refreshFundingPanel();
  }

  showChartLoadingOverlay();
  try{
    if(!state.chart){
      const ok = await initChart();
      if(!ok) return;
    }
    // 예전엔 여기서 recreateMainSeries()를 한 번 부르고, 데이터를 받은 뒤 아래에서 또 불렀다.
    // 첫 호출은 방금 비운 state.currentBars(빈 배열)를 setData하는 것뿐이라 순수한 낭비였고,
    // 페어를 바꿀 때마다 시리즈를 두 번 만들었다 지우는 셈이었다.

    const meta = INTERVAL_META[state.interval];
    stopGapFiller();
    setStatus('statusLoadingHistory');
    try{
    let bars;
    if(meta.kind === 'agg'){
      // 서버 요청은 base(1m)로, 기간 계산은 목표 인터벌(state.interval) 기준으로 — fetchHistory 주석 참고
      const history = await fetchHistory(pair.coin, meta.base, undefined, state.interval);
      bars = fillGaps(buildAggCandles(history.map(toChartCandle), meta.ms), meta.ms / 1000);
    }else{
      const history = await fetchHistory(pair.coin, state.interval);
      bars = history.map(toChartCandle);
    }

    // 방어적 처리: 시간 오름차순 정렬 + 중복 타임스탬프 제거(마지막 값 유지)
    // lightweight-charts는 시간이 항상 오름차순/고유해야 하는데, REST 스냅샷도 예외가 아닐 수 있다.
    bars.sort((a, b) => a.time - b.time);
    const deduped = [];
    for(const b of bars){
      if(deduped.length && deduped[deduped.length - 1].time === b.time) deduped[deduped.length - 1] = b;
      else deduped.push(b);
    }
    bars = deduped;

    // 디버그: 값이 이상한(NaN, 0 이하, high<low 등) 캔들이 섞여 있으면 걸러내고 개수를 남긴다
    const rawLen = bars.length;
    bars = bars.filter(b =>
      Number.isFinite(b.open) && Number.isFinite(b.high) &&
      Number.isFinite(b.low) && Number.isFinite(b.close) &&
      b.open > 0 && b.high > 0 && b.low > 0 && b.close > 0 &&
      b.high >= b.low
    );
    if(bars.length !== rawLen){
      console.warn(`[HL Chart] 이상 캔들 ${rawLen - bars.length}개 제거됨 (원래 ${rawLen}개 -> ${bars.length}개)`);
    }

    state.currentBars = bars;
    rebuildBarIndex();
    recreateMainSeries();
    refreshEmaBandFull();
    refreshBBFull();
    refreshVwapFull();
    refreshMaRibbonFull();
    refreshRsiFull();
    refreshMacdFull();
    state.noMoreHistory = false;
    if(bars.length){
      state.lastCandle = bars[bars.length - 1];
      state.liveAgg = meta.kind !== 'native' ? { ...state.lastCandle } : null;
      updatePriceBar();
      renderTodayIfNotHovering();
      
      // 가격축(Y축) 수동 조정 상태 초기화: 새 페어로 넘어갈 때 다시 오토스케일로 맞춤
      state.chart.priceScale('right').applyOptions({ autoScale: true });
      state.chart.priceScale('left').applyOptions({ autoScale: true });
      state.chart.timeScale().fitContent();
      // MACD는 RSI(항상 0~100)와 달리 값의 크기 자체가 자산 가격 규모에 좌우돼서(BTC vs HYPE처럼),
      // 이전 페어에서 수동으로 조정했거나 맞춰졌던 축 범위를 그대로 두면 새 페어에서 그냥 평평한
      // 직선처럼 눌려 보인다. 페어를 바꿀 때마다 오토스케일로 리셋해서 항상 새 데이터에 맞게 그린다.
      if(state.macdChart) state.macdChart.priceScale('right').applyOptions({ autoScale: true });
    }

    connectWsGeneric(pair.coin, state.interval);
    if(meta.kind !== 'native') startGapFiller(meta.ms);
    }catch(err){
      console.error(err);
      setStatus('statusError', 'err', err.message);
      if(err instanceof TypeError && /fetch/i.test(err.message)){
        showNetBanner(t('bannerApiBlocked'));
      }
    }
  }finally{
    hideChartLoadingOverlay();
  }
}

function selectInterval(iv){
  state.interval = iv;
  intervalToggleLabel.textContent = iv;
  renderIntervalFavorites();
  persistPrefs();
  if(state.coin) selectPair({ coin: state.coin, label: state.label, type: state.isSpot ? 'SPOT' : 'PERP' });
}

// ---------- 차트 유형 선택 ----------
const CHART_TYPES = [
  { id: 'Candlestick', i18nKey: 'chartCandlestick' },
  { id: 'Hollow', i18nKey: 'chartHollow' },
  { id: 'VolumeCandle', i18nKey: 'chartVolumeCandle' },
  { id: 'Bar', i18nKey: 'chartBar' },
  { id: 'Line', i18nKey: 'chartLine' },
  { id: 'Baseline', i18nKey: 'chartBaseline' },
  { id: 'Area', i18nKey: 'chartArea' },
  { id: 'HeikinAshi', i18nKey: 'chartHeikinAshi' },
];

const chartTypeToggle = $('chartTypeToggle');
const chartTypeLabel = $('chartTypeLabel');
const chartTypeDropdown = $('chartTypeDropdown');
const chartTypeList = $('chartTypeList');

function renderChartTypeList() {
  chartTypeList.innerHTML = '';
  CHART_TYPES.forEach(ct => {
    chartTypeList.appendChild(makeDropdownRow({
      active: ct.id === state.chartType,
      label: t(ct.i18nKey),
      onClick: () => { selectChartType(ct.id); closeChartTypeDropdown(); },
    }));
  });
}
const chartTypeDropdownCtrl = createDropdown(chartTypeToggle, chartTypeDropdown, renderChartTypeList);
function closeChartTypeDropdown(){ chartTypeDropdownCtrl.close(); }


function selectChartType(type) {
  state.chartType = type;
  const ct = CHART_TYPES.find(x => x.id === type);
  chartTypeLabel.textContent = ct ? t(ct.i18nKey) : t('chartCandlestick');
  persistPrefs();
  
  if (state.chart && state.currentBars.length) {
    recreateMainSeries();
  }
}
