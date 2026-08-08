/* app-settings.js
   Language buttons, global settings modal and chart background. */

// ---------- 언어 전환 버튼 ----------
const langBtnEn = document.getElementById('langBtnEn');
const langBtnKr = document.getElementById('langBtnKr');
langBtnEn.addEventListener('click', () => setLanguage('en'));
langBtnKr.addEventListener('click', () => setLanguage('kr'));

// ---------- 전역 설정(⚙) 버튼: 화면 정중앙에 뜨는 설정창. 언어 말고도 앞으로 설정이 늘어날 예정이라
// 지표 라벨 설정창과 같은 재사용 가능한 중앙 모달 시스템(registerLegendSettings 등)을 그대로 쓴다.
const appSettingsBtn = document.getElementById('appSettingsBtn');
const appSettingsPanel = document.getElementById('appSettingsPanel');
registerLegendSettings(appSettingsPanel);
appSettingsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleLegendSettings(appSettingsPanel);
});
onOutsideClick((e) => {
  if(appSettingsPanel.classList.contains('open') && !appSettingsPanel.contains(e.target) && !appSettingsBtn.contains(e.target)){
    closeLegendSettings(appSettingsPanel);
  }
});

// ---------- 차트 배경(단색/이미지) ----------
// 메인 차트 자체의 배경은 lightweight-charts가 캔버스에 직접 그려서, 뒤에 CSS 배경을 깔아도
// 안 보인다. 그래서 커스텀 배경을 쓸 때는 lightweight-charts 쪽 배경을 투명하게 만들고,
// 그 뒤에 있는 .chart-wrap의 CSS 배경(색 또는 이미지)이 비쳐 보이게 하는 방식으로 구현한다.
const DEFAULT_CHART_BG = '#0a0d12';
// 배경 이미지는 사용자가 고른 로컬 파일을 FileReader로 읽은 data URL이다. 이걸 CSS url()에
// 문자열로 그대로 이어붙이면, 값 안에 따옴표/괄호가 섞였을 때 url()을 빠져나가 다른 CSS 선언을
// 주입할 수 있다. data: 스킴인지 먼저 확인하고, 남은 위험 문자는 인코딩해서 넣는다.
function cssUrlValue(dataUrl){
  if(typeof dataUrl !== 'string' || !/^data:image\//i.test(dataUrl)) return 'none';
  return `url("${dataUrl.replace(/["\\\n\r]/g, encodeURIComponent)}")`;
}
function applyChartBackground(){
  const bg = state.chartBackground;
  if(bg.mode === 'image' && bg.imageDataUrl){
    chartWrapEl.style.backgroundImage = cssUrlValue(bg.imageDataUrl);
    chartWrapEl.style.backgroundSize = 'cover';
    chartWrapEl.style.backgroundPosition = 'center';
    chartWrapEl.style.backgroundColor = '';
    if(state.chart) state.chart.applyOptions({ layout: { background: { color: 'transparent' } } });
  }else if(bg.mode === 'color'){
    chartWrapEl.style.backgroundImage = 'none';
    chartWrapEl.style.backgroundColor = bg.color;
    if(state.chart) state.chart.applyOptions({ layout: { background: { color: 'transparent' } } });
  }else{
    // 청산 히트맵이 켜져 있으면 캔들 뒤에 깔린 #liqHeatmapOverlay 캔버스가 보여야 하므로,
    // 커스텀 배경(색/이미지)일 때와 같은 트릭으로 차트 자체 배경을 투명하게 만들고, 대신
    // chartWrapEl의 CSS 배경색을 기본색으로 채워서 히트맵이 꺼져 있을 때와 시각적으로 동일하게 유지한다.
    chartWrapEl.style.backgroundImage = 'none';
    chartWrapEl.style.backgroundColor = state.liqHeatmapOn ? DEFAULT_CHART_BG : '';
    if(state.chart) state.chart.applyOptions({ layout: { background: {
      color: state.liqHeatmapOn ? 'transparent' : DEFAULT_CHART_BG
    } } });
  }
}
const bgColorInput = document.getElementById('bgColorInput');
bgColorInput.addEventListener('input', (e) => {
  state.chartBackground.mode = 'color';
  state.chartBackground.color = e.target.value;
  applyChartBackground();
});
const bgImageFileInput = document.getElementById('bgImageFileInput');
document.getElementById('bgImageBtn').addEventListener('click', () => bgImageFileInput.click());
bgImageFileInput.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  bgImageFileInput.value = ''; // 같은 파일 다시 골라도 change가 또 발생하게 초기화
  if(!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    state.chartBackground.mode = 'image';
    state.chartBackground.imageDataUrl = reader.result;
    applyChartBackground();
  };
  reader.readAsDataURL(file);
});
document.getElementById('bgResetBtn').addEventListener('click', () => {
  state.chartBackground = { mode: 'default', color: DEFAULT_CHART_BG, imageDataUrl: null };
  bgColorInput.value = DEFAULT_CHART_BG;
  applyChartBackground();
});
