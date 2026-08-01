/* state.js
   The single mutable app state object, plus the small preference-persistence layer. */

// 새로고침해도 유지할 사용자 설정. 예전엔 언어와 호가창 on/off만 저장돼서, 즐겨찾기 페어를
// 고르고 인터벌/차트 유형을 맞춰놔도 새로고침하면 전부 초기값으로 돌아갔다.
// 저장된 값은 항상 기본값 위에 덮어쓰는 방식으로 읽어서, 나중에 항목이 추가되거나
// 저장된 데이터가 깨져 있어도 앱이 뜨지 않는 일이 없게 한다.
//
// 지표 on/off는 한때 여기 같이 저장했었는데, 새로고침 시 복원하는 과정에서 범례 라벨/RSI·MACD
// 패널 표시가 어긋나거나 메인 차트 확대 범위가 틀어지는 버그가 반복되고 부팅도 느려져서
// 저장 대상에서 뺐다 — 지표는 항상 꺼진 상태로 시작하고, 필요할 때 다시 켜면 된다.
const SAVED = store.get('prefs', {}) || {};
function persistPrefs(){
  store.set('prefs', {
    favorites: state.favorites,
    intervalFavorites: state.intervalFavorites,
    interval: state.interval,
    chartType: state.chartType,
    trackedWallet: state.trackedWallet,
  });
}

let state = {
  lang: store.get('lang', 'en'),
  statusKey: 'statusWaiting', // 상단 상태 문구의 i18n 키 (언어 전환 시 이 키로 다시 번역)
  statusArgs: [],
  interval: INTERVAL_META[SAVED.interval] ? SAVED.interval : '15m',
  coin: null,
  label: null,
  isSpot: false,
  ws: null,
  todayWs: null,          // 상단 바의 "오늘" 통계 전용 1d 구독 (선택된 인터벌과 무관하게 항상 정확한 오늘자 O/H/L/C 유지)
  todayCandle: null,      // { time, open, high, low, close } - 오늘(UTC) 일봉
  hoverCandle: null,      // 사용자가 차트에서 마우스 오버 중인 캔들(있으면 상단 바가 이 값을 대신 보여줌)
  assetCtxWs: null,       // 24h 거래대금/OI/펀딩 전용 activeAssetCtx 구독
  assetCtx: null,         // { isSpot, funding, openInterest, dayNtlVlm, markPx }
  candleSeries: null,
  candlesHidden: false,  // 범례 눈 아이콘으로 캔들(메인 시리즈) 임시 숨김
  volumeHidden: false,   // 범례 눈 아이콘으로 거래량 히스토그램 임시 숨김
  chart: null,
  lastCandle: null,
  liveAgg: null,         // agg 인터벌에서 현재 형성 중인 봉
  gapTimer: null,        // 체결이 뜸할 때 flat 봉으로 이어붙이는 타이머
  currentBars: [],       // 현재 차트에 로드된 전체 캔들 (뒤로 스크롤 시 앞에 이어붙임)
  loadingMore: false,
  noMoreHistory: false,
  allPairs: [],          // { coin, label, type: 'PERP'|'SPOT', isHip3 }
  allPairsLoaded: false,
  favorites: Array.isArray(SAVED.favorites) ? SAVED.favorites : [],  // { coin, label, type }
  favoritesRestored: Array.isArray(SAVED.favorites) && SAVED.favorites.length > 0,
  intervalFavorites: Array.isArray(SAVED.intervalFavorites) && SAVED.intervalFavorites.length
    ? SAVED.intervalFavorites.filter(iv => INTERVAL_META[iv])
    : [...DEFAULT_INTERVAL_FAVORITES],
  dropdownTab: 'ALL',
  // 예전에 저장된 'VolumeCandle1'(삭제됨)/'VolumeCandle2'(VolumeCandle로 개명됨)/'HighLow'(삭제됨)
  // 값이 남아있어도 존재하지 않는 차트 유형으로 부팅되지 않도록 이전 값을 새 id로 옮겨준다.
  chartType: SAVED.chartType === 'VolumeCandle1' ? 'Candlestick'
    : SAVED.chartType === 'VolumeCandle2' ? 'VolumeCandle'
    : SAVED.chartType === 'HighLow' ? 'Candlestick'
    : (SAVED.chartType || 'Candlestick'),
  emaBandOn: false,     // EMA 밴드 지표 on/off (새로고침해도 저장 안 함 — 위 주석 참고)
  emaBandHidden: false, // 범례 눈 아이콘으로 임시로 숨김 (설정은 유지)
  emaBandLineVisible: { max: true, min: true, avg: true, avg2: true }, // 개별 라인 표시 여부
  emaBandColors: { max: '#00BFFF', min: '#FF4500', avg: '#26a641', avg2: '#32CD32' },
  bbOn: false,           // Bollinger Bands 지표 on/off (새로고침해도 저장 안 함)
  bbHidden: false,       // 범례 눈 아이콘으로 임시 숨김
  bbSettings: { length: 20, maType: 'SMA', source: 'close', mult: 2.0 },
  bbLineVisible: { basis: true, upper: true, lower: true },
  bbColors: { basis: '#2962FF', upper: '#F23645', lower: '#089981' },
  bbSeries: null,
  vwapOn: false,        // VWAP 지표 on/off (새로고침해도 저장 안 함)
  vwapHidden: false,      // 범례 눈 아이콘으로 임시 숨김
  // TradingView 공식 VWAP과 동일한 구조: anchor(세션 리셋 주기) + source + 밴드 계산 모드(표준편차/퍼센트)
  // + 밴드 3개(각각 표시여부/배수). Earnings/Dividends/Splits/Decade/Century anchor는 외부 실적/배당
  // 데이터가 필요해서(request.earnings 등) 이 앱엔 없는 데이터라 제외 — 봉 시간만으로 계산 가능한
  // Session/Week/Month/Quarter/Year만 지원한다.
  vwapSettings: {
    anchor: 'session', // 'session' | 'week' | 'month' | 'quarter' | 'year'
    source: 'hlc3',
    calcMode: 'stdev', // 'stdev' | 'percent' — percent일 땐 배수가 "곱하기 %" 의미가 됨
    bands: {
      1: { show: true,  mult: 1.0 },
      2: { show: false, mult: 2.0 },
      3: { show: false, mult: 3.0 },
    },
  },
  vwapLineVisible: { vwap: true },
  vwapColors: { vwap: '#2962FF', band1: '#26a641', band2: '#6b8e23', band3: '#008080' },
  vwapSeries: null,       // { vwap, band1: {upper,lower}, band2: {...}, band3: {...} }
  vwapCalc: null,        // 누적합(cumPV/cumVol/cumPV2) 캐시 — updateVwapLive가 마지막 봉만 증분 갱신할 때 씀
  maRibbonOn: false,      // MA Ribbon 지표 on/off (새로고침해도 저장 안 함)
  maRibbonHidden: false,  // 범례 눈 아이콘으로 임시 숨김
  // Pine 스크립트의 MA #1~#4 입력값과 동일한 기본값. 키는 각 라인의 고유 id(문자열)이고,
  // "+ Add Line"으로 라인을 더 추가하면 maRibbonNextId를 이용해 새 id를 계속 발급한다.
  maRibbonSettings: {
    1: { show: true, type: 'SMA', source: 'close', length: 20,  color: '#f6c309' },
    2: { show: true, type: 'SMA', source: 'close', length: 50,  color: '#fb9800' },
    3: { show: true, type: 'SMA', source: 'close', length: 100, color: '#fb6500' },
    4: { show: true, type: 'SMA', source: 'close', length: 200, color: '#f60c0c' },
  },
  maRibbonNextId: 5,
  maRibbonSeries: null,   // { [id]: series } 라인 시리즈들
  rsiOn: false,          // RSI 지표 on/off (하단 별도 패널, 새로고침해도 저장 안 함)
  rsiHidden: false,      // 범례 눈 아이콘으로 임시 숨김
  rsiSettings: { length: 14, source: 'close', maType: 'SMA', maLength: 14, bbMult: 2.0 },
  rsiLineVisible: { rsi: true, ma: true },
  rsiColors: { rsi: '#7E57C2', ma: '#FFEB3B', bbUpper: '#26a641', bbLower: '#26a641' },
  rsiChart: null,
  rsiSeries: null,       // { rsi, ma?, bbUpper?, bbLower? } - ma/bb는 스무딩 타입에 따라 동적으로 생성/제거
  rsiCalc: null,         // 라이브 틱마다 전체 재계산(setData) 대신 증분 갱신(update)하기 위한 캐시 상태
  rsiBandSettings: { upperOn: true, upperValue: 70, middleOn: true, middleValue: 50, lowerOn: true, lowerValue: 30 },
  rsiBands: null,        // { upper, middle, lower } - 생성된 IPriceLine 참조 (꺼져있으면 null)
  macdOn: false,          // MACD 지표 on/off (하단 별도 패널, 새로고침해도 저장 안 함)
  macdHidden: false,      // 범례 눈 아이콘으로 임시 숨김
  macdSettings: { source: 'close', fastLen: 12, slowLen: 26, sigLen: 9, oscType: 'EMA', sigType: 'EMA' },
  macdLineVisible: { macd: true, signal: true, hist: true },
  macdColors: { macd: '#2962FF', signal: '#ff6d00' },
  macdChart: null,
  macdSeries: null,       // { macd, signal, hist }
  // 펀딩비는 1시간마다 정산되는 이벤트 데이터라 캔들 타임프레임(15m/4h/1d 등)의 x축과 맞물리지 않는다.
  // 그래서 RSI/MACD처럼 메인 차트와 동기화되는 하단 패널이 아니라, 오더북과 같은 독립 사이드 패널(표)로 둔다.
  fundingOpen: store.get('funding_open', false) === true,
  fundingRawPoints: null,   // 마지막으로 불러온 { time, fundingRate } 배열 (평균/연환산 계산용)
  fundingRefreshTimer: null, // 패널이 열려있는 동안 방금 정산된 값을 반영하기 위한 주기적 REST 재조회 타이머
  drawTool: 'cursor',     // 현재 선택된 그리기 도구
  drawings: [],           // { id, type, points:[{time,price},...], text? }
  drawDraft: null,        // 점을 찍는 중인 임시 그리기 (완성되면 drawings로 이동)
  drawPreviewPoint: null, // 2점짜리 도구를 그리는 동안 마우스를 따라다니는 미리보기 좌표
  drawSelectedId: null,
  drawIdCounter: 1,
  chartBackground: { mode: 'default', color: '#0a0d12', imageDataUrl: null },
  emaSeries: null,      // { max, min, avg, avg2 } 라인 시리즈들
  emaCalc: null,        // 실시간 갱신용 { anchor, current, lastTime }
  favoritePrices: {},    // { coin: 최근 1분봉 종가 } — 메인 차트와 동일하게 candle 구독의 종가를 사용
  favoritePriceWs: {},   // { coin: WebSocket } 즐겨찾기별 1m candle 구독
  favoritePriceEls: [],  // 즐겨찾기 버튼의 가격 라벨 엘리먼트 참조 [{coin, el}]
  orderbookOpen: store.get('ob_open', false) === true,
  orderbook: null,       // { bids:[{px,sz}...], asks:[{px,sz}...] } - best-first 정렬
  obWs: null,            // l2Book 구독 전용 웹소켓
  // ---------- 지갑 추적 (하이퍼리퀴드 특화: 주소 하나의 실제 포지션을 차트에 겹쳐 보여줌) ----------
  walletOpen: store.get('wallet_open', false) === true,
  trackedWallet: typeof SAVED.trackedWallet === 'string' ? SAVED.trackedWallet : null,
  walletPositions: [],    // 마지막으로 불러온 clearinghouseState.assetPositions (coin별 포지션 목록)
  walletLoading: false,
  walletError: null,      // 주소 형식 오류 / 조회 실패 시 i18n 키
  walletPollTimer: null,  // 패널이 열려있는 동안 주기적으로 포지션을 다시 불러오는 타이머
  walletSummary: null,    // { accountValue, withdrawable, marginUsed, unrealizedPnl, spotUsdc } — 계좌 잔고 요약
  walletPriceLines: { entry: null, liq: null }, // 현재 보고 있는 코인에 겹쳐 그린 진입가/청산가 라인 (createPriceLine 참조)
  // ---------- PineScript 지표 가져오기 ----------
  pineOpen: store.get('pine_open', false) === true,
  pineScripts: (() => { try{ const v = store.get('pine_scripts', []); return Array.isArray(v) ? v : []; }catch(e){ return []; } })(), // [{id,name,source,enabled,inputOverrides}]
  pineActive: new Map(), // scriptId -> 런타임 리소스(오버레이 라인들 또는 전용 패널) — 새로고침해도 유지 안 함
  // ---------- 리플레이 모드 ----------
  replayPicking: false,  // 시작 캔들을 클릭으로 고르는 중 (아직 재생 시작 전)
  replayMode: false,     // 리플레이 세션이 켜져 있음 (재생 중이든 일시정지든 true) — 켜져있는 동안
                          // 실시간 WS 틱은 currentBars/시리즈를 건드리지 않는다 (candles.js/market-data.js 가드)
  replayPlaying: false,  // 자동 재생 중인지
  replayFullBars: null,  // 리플레이 시작 시점의 전체 봉 배열 스냅샷 (state.currentBars는 이 배열의 앞부분 슬라이스가 됨)
  replayIndex: -1,       // state.replayFullBars 기준으로 "지금까지 공개된 마지막 봉"의 인덱스
  replaySpeedMs: 700,    // 자동 재생 시 한 봉당 대기 시간(ms) — 리플레이 바의 속도 셀렉트가 이 값을 바꿈
  replayTimer: null,     // setInterval id
};
