/* chart-types.js
   Volume Candle: 거래량이 많을수록 색을 진하게 칠함. */

// 마지막 봉 하나만 실시간으로 다시 칠할 수 있도록, 전체 색칠에 쓴 최대 거래량을 기억해둔다.
// (최대값이 갱신될 때만 전체를 다시 칠하면 되고, 그 외에는 마지막 봉만 갱신하면 된다.)
let volumeColorMax = 1;
function applyVolumeColor(bar, maxVol) {
  const ratio = Math.min(1, (bar.volume || 0) / maxVol);
  const alpha = 0.18 + ratio * 0.82; // 최소 0.18 ~ 최대 1.0
  const isUp = bar.close >= bar.open;
  const color = isUp ? `rgba(79,209,197,${alpha.toFixed(2)})` : `rgba(239,111,111,${alpha.toFixed(2)})`;
  return { ...bar, color, borderColor: color, wickColor: color };
}
function applyVolumeColors(bars) {
  volumeColorMax = bars.reduce((m, b) => Math.max(m, b.volume || 0), 0) || 1;
  return bars.map(b => applyVolumeColor(b, volumeColorMax));
}
