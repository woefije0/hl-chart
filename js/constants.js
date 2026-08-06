/* constants.js
   Interval definitions and app-wide default values. */

// ---------- 인터벌 정의 ----------
// native  : Hyperliquid candle API가 그대로 지원
// agg     : 더 작은 native 캔들(base)을 클라이언트에서 합쳐서 만듦 (예: 2m = 1m x2)
const INTERVAL_META = {
  '1m':  { kind: 'native' },
  '2m':  { kind: 'agg', base: '1m', ms: 120000 },
  '3m':  { kind: 'native' },
  '5m':  { kind: 'native' },
  '15m': { kind: 'native' },
  '30m': { kind: 'native' },
  '1h':  { kind: 'native' },
  '2h':  { kind: 'native' },
  '4h':  { kind: 'native' },
  '8h':  { kind: 'native' },
  '12h': { kind: 'native' },
  '1d':  { kind: 'native' },
  '1w':  { kind: 'native' },
  '1M':  { kind: 'native' },
};
const INTERVAL_GROUPS = [
  { titleKey: 'intervalGroupMinutes', items: ['1m', '2m', '3m', '5m', '15m', '30m'] },
  { titleKey: 'intervalGroupHours', items: ['1h', '2h', '4h', '8h', '12h'] },
  { titleKey: 'intervalGroupDays', items: ['1d', '1w', '1M'] },
];
// 인터벌 1개가 몇 분인지. fetchHistory가 "인터벌 x 500개" 기간을 계산할 때 쓴다.
// (예전엔 '2m'이 빠져 있어서, 합성 인터벌을 native처럼 직접 요청하는 코드가 하나라도
//  생기면 MINUTES['2m']가 undefined -> NaN 기간이 되어 조용히 실패했을 것이다.)
const MINUTES = {
  '1m': 1, '2m': 2, '3m': 3, '5m': 5, '15m': 15, '30m': 30,
  '1h': 60, '2h': 120, '4h': 240, '8h': 480, '12h': 720,
  '1d': 1440, '1w': 10080, '1M': 43200,
};

// 즐겨찾기 기본값: 후보 이름들 중 실제로 존재하는 걸 자동으로 찾음
// (GOLD 자산은 시점에 따라 GOLD / XAU / XAUT / PAXG 등으로 표기가 바뀔 수 있어 여러 후보를 둠)
const DEFAULT_FAVORITE_CANDIDATES = [
  { label: 'BTC/USDC', candidates: ['BTC'] },
  { label: 'GOLD/USDC', candidates: ['GOLD', 'XAU', 'XAUT', 'PAXG'] },
  { label: 'HYPE/USDC', candidates: ['HYPE'] },
];
const DEFAULT_INTERVAL_FAVORITES = ['15m', '1h', '4h', '1d'];
