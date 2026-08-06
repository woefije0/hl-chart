/* chart-init.js
   Main lightweight-charts instance setup. */

// ---------- chart setup (라이브러리 로드를 기다린 후 초기화) ----------
const chartEl = $('chart');
const chartWrapEl = $('chartWrap');

// 메인/RSI/MACD/Pine/미니 차트가 전부 똑같은 색·폰트 뭉치를 각자 복사해서 갖고 있었다.
const CHART_THEME = {
  layout: { background: { color: '#0a0d12' }, textColor: '#6b7686', fontFamily: "'JetBrains Mono', monospace", fontSize: 11 },
  grid: { vertLines: { color: '#151a22' }, horzLines: { color: '#151a22' } },
};
// 하단 전용 패널(RSI/MACD/Pine)은 옵션이 완전히 동일했다(각 25줄 x 3벌). 하나로 합친다.
// LightweightCharts 전역을 참조하므로 상수가 아니라 "호출 시점에 만드는" 함수여야 한다.
function panelChartOptions(){
  return {
    ...CHART_THEME,
    rightPriceScale: { borderColor: '#212833', visible: true, autoScale: true, mode: LightweightCharts.PriceScaleMode.Normal },
    leftPriceScale: { visible: false },
    timeScale: { borderColor: '#212833', timeVisible: true, secondsVisible: true, tickMarkFormatter: localTickMarkFormatter },
    localization: { timeFormatter: localTimeFormatter },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    handleScroll: { vertTouchDrag: true, mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true },
    // 가격축도 메인 차트처럼 드래그로 확대/축소 가능. (드래그 시 lightweight-charts가 해당
    //  price scale의 autoScale을 자동으로 꺼주므로, 각 패널의 autoscaleInfoProvider 고정 범위는
    //  "처음 켰을 때의 기본값"으로만 동작하고 사용자가 조정한 뒤에는 그 값을 유지한다.)
    handleScale: { axisPressedMouseMove: { time: true, price: true }, mouseWheel: true, pinch: true },
  };
}

// 하단 패널 차트와 메인 차트의 가로 스크롤/줌을 서로 물려준다.
// RSI/MACD가 완전히 같은 가드 플래그 + 양방향 핸들러 + 구독/해지 코드를 각자 복사해서
// 갖고 있던 걸 하나로 합쳤다. getPaneChart()는 패널 차트가 아직 없을 수도 있어서 함수로 받는다.
function linkPaneTimeScale(getPaneChart){
  let guard = false; // 양쪽이 서로를 끝없이 되받아치지 않게 막는다
  function paneFollowsMain(range){
    const pane = getPaneChart();
    if(guard || !range || !pane) return;
    guard = true; pane.timeScale().setVisibleLogicalRange(range); guard = false;
  }
  function mainFollowsPane(range){
    if(guard || !range || !state.chart) return;
    guard = true; state.chart.timeScale().setVisibleLogicalRange(range); guard = false;
  }
  return {
    attach(){
      const pane = getPaneChart();
      state.chart.timeScale().subscribeVisibleLogicalRangeChange(paneFollowsMain);
      pane.timeScale().subscribeVisibleLogicalRangeChange(mainFollowsPane);
      // 메인 차트의 보이는 범위를 그대로 넘겨받아 처음부터 정렬된 상태로 시작
      const initRange = state.chart.timeScale().getVisibleLogicalRange();
      if(initRange) pane.timeScale().setVisibleLogicalRange(initRange);
    },
    detach(){
      const pane = getPaneChart();
      if(state.chart) state.chart.timeScale().unsubscribeVisibleLogicalRangeChange(paneFollowsMain);
      if(pane) pane.timeScale().unsubscribeVisibleLogicalRangeChange(mainFollowsPane);
    },
  };
}
async function initChart(){
  await window.__chartLibReady;
  if(window.__chartLibFailed || typeof LightweightCharts === 'undefined'){
    showNetBanner(t('bannerLibFailed'));
    setStatus('statusLibFailed', 'err');
    return false;
  }
  state.chart = LightweightCharts.createChart(chartEl, {
    ...CHART_THEME,
    rightPriceScale: {
      borderColor: '#212833', 
      visible: true,
      autoScale: true,
      mode: LightweightCharts.PriceScaleMode.Normal,
    },
    leftPriceScale: { 
      borderColor: '#212833', 
      // 거래량 시리즈가 이 축(left)에 붙어있긴 하지만, 축 자체는 더 이상 화면에 그리지 않는다.
      // 대신 현재 거래량 값은 #volumeAxisLabel이 오른쪽 가격축 위에 뱃지로 떠서 보여준다
      // (updateVolumeAxisLabel(), chart-series.js). left 스케일을 숨겨도 거래량 시리즈의
      // priceToCoordinate() 계산이나 scaleMargins 기반 위치 자체는 그대로 유효하다.
      visible: false,
      autoScale: true,
    },
    timeScale: { 
      borderColor: '#212833', 
      timeVisible: true, 
      secondsVisible: true,
      shiftVisibleRangeOnNewBar: true,
      tickMarkFormatter: localTickMarkFormatter,
    },
    localization: { timeFormatter: localTimeFormatter },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    handleScroll: {
      vertTouchDrag: true,
      mouseWheel: true,
      pressedMouseMove: true,
      horzTouchDrag: true,
    },
    handleScale: {
      axisPressedMouseMove: {
        time: true,
        price: true,
      },
      mouseWheel: true,
      pinch: true,
    },
  });
  applyChartBackground(); // 이전에 설정해둔 배경색/배경이미지가 있으면 새로 만든 차트에도 바로 적용
  state.candleSeries = state.chart.addCandlestickSeries({
    upColor: '#4fd1c5',
    downColor: '#ef6f6f',
    borderVisible: false,
    wickUpColor: '#4fd1c5',
    wickDownColor: '#ef6f6f',
    priceScaleId: 'right',
    priceFormat: {
      type: 'custom',
      formatter: (price) => formatPrice(price),
    },
  });
  state.chart.priceScale('right').applyOptions({
    scaleMargins: { top: 0.08, bottom: 0.28 }, // 아래쪽을 거래량 자리로 비워둠
  });

  // 버그 수정: 캔들 종류를 바꿀 때마다 recreateMainSeries()가 right 가격축의 시리즈를
  // 지웠다가 새로 만드는데, 그 순간 right 축에 붙은 시리즈가 0개가 되면
  // lightweight-charts가 내부적으로 autoScale을 강제로 true로 되돌리고 가격 범위 캐시를
  // 지워버림 -> 사용자가 드래그로 조절해둔 가격축 위치/줌이 초기화되는 원인이었음.
  // -> right 축에 항상 붙어있는 보이지 않는 더미 시리즈를 하나 유지해서, 시리즈 개수가
  //    절대 0이 되지 않게 막는다. (autoscale 계산에서도 invisible 시리즈는 제외되므로
  //    이 더미 시리즈가 자동 스케일 범위에 영향을 주지도 않는다.)
  state.priceScaleKeepAlive = state.chart.addLineSeries({
    priceScaleId: 'right',
    visible: false,
    lastValueVisible: false,
    priceLineVisible: false,
    crosshairMarkerVisible: false,
    // 중요: 이 더미 시리즈가 가격축의 "포맷 기준 시리즈"(dataSources[0])가 될 수도 있으므로
    // 메인 시리즈와 동일한 커스텀 포맷터(formatPrice, 유효숫자 5자리)를 지정해야
    // 캔들 종류를 바꿨을 때 가격축 소수점 자릿수가 기본값(2자리)으로 튀지 않는다.
    priceFormat: {
      type: 'custom',
      formatter: (price) => formatPrice(price),
    },
  });
  state.volumeSeries = state.chart.addHistogramSeries({
    // minMove가 크면(예: 1) 봉당 거래량이 전부 1 미만인 자산(예: BTC처럼 코인 단위 거래량이
    // 소수인 경우)에서 눈금 후보가 전부 0으로 스냅되어 라벨이 사실상 "0" 한 줄만 남고 사라진다.
    // 표시 자체는 formatVolumeAxis가 정수/K/M 단위로 반올림해서 보여주므로, 내부 스냅 단위는
    // 아주 작게 둬도 안전하다.
    priceFormat: { type: 'custom', minMove: 0.00000001, formatter: formatVolumeAxis },
    priceScaleId: 'left',
    priceLineVisible: false,
    lastValueVisible: false,
  });
  state.chart.priceScale('left').applyOptions({
    scaleMargins: { top: 0.82, bottom: 0 },
  });
  applyCandlesVisibility();
  applyVolumeVisibility();
  new ResizeObserver(entries => {
    const { width, height } = entries[0].contentRect;
    state.chart.resize(width, height);
  }).observe(chartEl);

  // 상하 이동 문제 해결: 드래그 시 오토스케일 자동 해제.
  // applyOptions()는 차트 다시 그리기를 유발하는 호출이라, 예전처럼 드래그 중 mousemove마다
  // (초당 수십~수백 번) 부르면 낭비다. 드래그 한 번당 딱 한 번만 끈다.
  let isMouseDown = false;
  let autoScaleDisabledForDrag = false;
  chartEl.addEventListener('mousedown', () => { isMouseDown = true; });
  window.addEventListener('mouseup', () => { isMouseDown = false; autoScaleDisabledForDrag = false; });
  chartEl.addEventListener('mousemove', (e) => {
    if (isMouseDown && e.movementY !== 0 && !autoScaleDisabledForDrag) {
      autoScaleDisabledForDrag = true;
      state.chart.priceScale('right').applyOptions({ autoScale: false });
      state.chart.priceScale('left').applyOptions({ autoScale: false });
    }
  });
  state.chart.timeScale().subscribeVisibleLogicalRangeChange(range => {
    if(range && range.from < 20) loadMoreHistory();
  });
  // 위 구독은 "보이는 범위가 실제로 바뀔 때"만 발동한다. 그런데 예전 로딩 실패는(예: API가
  // 순간적으로 429를 준 경우) 그 순간의 실패로 끝이었고, 사용자가 스크롤을 멈춘 채 가만히
  // 있으면(범위가 더 이상 안 바뀌니) 다시 시도할 기회가 영영 없었다 — "뒤로 스크롤해도 과거
  // 데이터가 더 이상 안 불러와진다"는 문제의 실제 원인 중 하나. loadMoreHistory() 자체는
  // state.loadingMore/noMoreHistory 가드가 있어 자주 불러도 안전하므로, 몇 초에 한 번씩
  // "지금도 왼쪽 끝 근처인지" 다시 확인해서 실패했던 로딩을 스스로 재시도하게 한다.
  setInterval(() => {
    if(!state.chart) return;
    const range = state.chart.timeScale().getVisibleLogicalRange();
    if(range && range.from < 20) loadMoreHistory();
  }, 2500);

  // 캔들에 마우스를 올리면 그 캔들의 O/H/L/C·%를 상단 바에 표시, 벗어나면 "오늘"로 복귀
  state.chart.subscribeCrosshairMove(param => {
    if(!param || !param.time){
      if(state.hoverCandle){
        state.hoverCandle = null;
        renderTodayIfNotHovering();
      }
      return;
    }
    const bar = findBarAtTime(param.time); // 예전엔 매 마우스 이동마다 전체 배열을 훑었다
    if(!bar) return;
    state.hoverCandle = bar;
    renderCandleStats(bar, t('selectedCandle'));
  });
  state.chart.subscribeCrosshairMove(handleDrawCrosshairMove);
  state.chart.subscribeClick(handleDrawClick);
  state.chart.subscribeClick(handleReplayPickClick);
  return true;
}
