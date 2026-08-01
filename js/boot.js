/* boot.js
   Application entry point. */

// ---------- 시작 ----------
async function boot(){
  applyLanguage(); // 내부에서 renderIntervalFavorites/renderChartTypeList/renderIndicatorsList까지 처리
  startOverlayLoop();
  setStatus('statusLoadingPairs');
  try{
    state.allPairs = await loadAllPairs();
    state.allPairsLoaded = true;
  }catch(err){
    console.error(err);
    showNetBanner(t('bannerPairsFailed'));
    setStatus('statusPairLoadFailed', 'err');
    return;
  }

  // 저장된 즐겨찾기가 있으면 그대로 쓰고, 처음 방문(또는 전부 지운 상태)일 때만 기본값을 채운다.
  if(state.favoritesRestored){
    // 저장된 항목 중 지금 실제로 존재하는 페어만 남긴다 (상장폐지/이름 변경 대비)
    const known = new Set(state.allPairs.map(p => p.coin));
    state.favorites = state.favorites.filter(f => f && known.has(f.coin));
  }
  if(!state.favorites.length){
    DEFAULT_FAVORITE_CANDIDATES.forEach(f => {
      const match = findByCandidates(f.candidates);
      if(match) state.favorites.push(match);
    });
  }
  renderFavorites();
  syncFavoritePriceSubscriptions();
  renderDropdownList('');

  persistPrefs();
  if(state.favorites.length){
    selectPair(state.favorites[0]);
  }else{
    setStatus('statusNoDefaultFav', 'err');
  }
}

boot();
