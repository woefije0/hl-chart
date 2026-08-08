/* chart-types.js
   Volume Candle: 거래량이 많을수록 색을 진하게 칠함. */

// 마지막 봉 하나만 실시간으로 다시 칠할 수 있도록, 전체 색칠에 쓴 최대 거래량을 기억해둔다.
// (최대값이 갱신될 때만 전체를 다시 칠하면 되고, 그 외에는 마지막 봉만 갱신하면 된다.)
let volumeColorMax = 1;
// Pine barcolor()가 이 봉을 칠하라고 지정했으면 그 색을 "기준 색(hue)"으로만 쓰고, 없으면
// 평소처럼 상승/하락 기본 색을 쓴다. 진하기(알파)는 barcolor의 투명도를 무시하고 항상 거래량
// 비율로 새로 계산한다 — 그대로 barcolor 색을 불투명하게 덮어써버리면 Volume Candle의 존재
// 이유인 "거래량이 많을수록 진하게"가 barcolor를 쓰는 스크립트를 켜는 순간 사라져버린다.
function volumeCandleBaseRgb(bar){
  const pineColor = typeof pineBarColorAt === 'function' ? pineBarColorAt(bar.time) : null;
  if(pineColor) return pineColorComponents(pineColor); // pine-builtins.js — hex/rgba 문자열 모두 파싱해 [r,g,b,_]
  return bar.close >= bar.open ? [79, 209, 197] : [239, 111, 111];
}
function applyVolumeColor(bar, maxVol) {
  const ratio = Math.min(1, (bar.volume || 0) / maxVol);
  const alpha = 0.18 + ratio * 0.82; // 최소 0.18 ~ 최대 1.0
  const [r, g, b] = volumeCandleBaseRgb(bar);
  const color = `rgba(${r},${g},${b},${alpha.toFixed(2)})`;
  return { ...bar, color, borderColor: color, wickColor: color };
}
function applyVolumeColors(bars) {
  volumeColorMax = bars.reduce((m, b) => Math.max(m, b.volume || 0), 0) || 1;
  return bars.map(b => applyVolumeColor(b, volumeColorMax));
}

