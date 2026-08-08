/* pairs.js
   Pair list loading, favourites and the pair/interval dropdowns. */

// ---------- 전체 페어 목록 로드 ----------
async function loadAllPairs(){
  const list = [];

  const nativeMeta = await info({ type: 'meta' });
  nativeMeta.universe.forEach(u => {
    if(u.isDelisted) return;
    list.push({ coin: u.name, label: u.name + '-PERP', type: 'PERP', isHip3: false, maxLeverage: u.maxLeverage });
  });

  // HIP-3 dex들의 메타는 서로 독립적이라 순서가 필요 없다. 예전엔 for 루프 안에서 await로
  // 하나씩 기다려서, dex가 N개면 왕복 N번이 직렬로 쌓여 첫 화면이 뜨는 시간이 그만큼 늘어났다.
  // 전부 동시에 던지고 한 번만 기다린다. 실패한 dex는 조용히 건너뛰는 동작은 그대로.
  try{
    const dexs = await info({ type: 'perpDexs' });
    const dexMetas = await Promise.all(
      (dexs || [])
        .filter(dex => dex && dex.name)
        .map(dex => info({ type: 'meta', dex: dex.name })
          .then(meta => ({ dex, meta }))
          .catch(() => null))
    );
    dexMetas.forEach(entry => {
      if(!entry || !entry.meta || !entry.meta.universe) return;
      const { dex, meta } = entry;
      meta.universe.forEach(u => {
        if(u.isDelisted) return;
        const coin = u.name.startsWith(dex.name + ':') ? u.name : `${dex.name}:${u.name}`;
        const shortName = u.name.includes(':') ? u.name.split(':').pop() : u.name;
        list.push({ coin, label: `${shortName}-PERP (${dex.name})`, type: 'PERP', isHip3: true, maxLeverage: u.maxLeverage });
      });
    });
  }catch(e){ /* perpDexs 자체 실패는 무시 */ }

  try{
    const spotMeta = await info({ type: 'spotMeta' });
    const tokenName = idx => {
      const t = spotMeta.tokens.find(t => t.index === idx);
      return t ? t.name : '?';
    };
    spotMeta.universe.forEach(pair => {
      const base = tokenName(pair.tokens[0]);
      const quote = tokenName(pair.tokens[1]);
      const coin = pair.name === 'PURR/USDC' ? 'PURR/USDC' : `@${pair.index}`;
      list.push({ coin, label: `${base}/${quote}`, type: 'SPOT', isHip3: false });
    });
  }catch(e){ /* spot 실패는 무시 */ }

  return list;
}

function findByCandidates(candidates){
  for(const name of candidates){
    const perp = state.allPairs.find(p => p.type === 'PERP' && (p.coin === name || p.label.startsWith(name + '-PERP')));
    if(perp) return perp;
  }
  for(const name of candidates){
    const spot = state.allPairs.find(p => p.type === 'SPOT' && p.label.startsWith(name + '/'));
    if(spot) return spot;
  }
  return null;
}

// ---------- 페어 즐겨찾기 ----------
// 인터벌만 바꿔도 selectPair()를 타기 때문에 이 함수가 자주 불린다. 예전엔 그때마다 버튼을
// 전부 지웠다 다시 만들어서, 실시간 가격 라벨이 '—'로 깜빡이고 DOM도 불필요하게 흔들렸다.
// 즐겨찾기 목록 자체가 바뀌지 않았으면 활성 표시만 갱신하고 끝낸다.
let lastFavoritesSignature = null;
function renderFavorites(){
  const pairsEl = $('pairs');
  const toggleBtn = $('allpairsToggle');
  const signature = state.favorites.map(f => f.coin).join('|');
  const existing = [...pairsEl.querySelectorAll('.pairbtn')];
  if(signature === lastFavoritesSignature && existing.length === state.favorites.length){
    existing.forEach((btn, i) => btn.classList.toggle('active', state.coin === state.favorites[i].coin));
    return;
  }
  lastFavoritesSignature = signature;
  existing.forEach(b => b.remove());
  state.favoritePriceEls = [];
  state.favorites.forEach(fav => {
    const b = document.createElement('button');
    b.className = 'pairbtn fav-pair' + (state.coin === fav.coin ? ' active' : '');
    b.onclick = () => selectPair(fav);

    const nameEl = document.createElement('span');
    nameEl.className = 'fav-name';
    nameEl.textContent = fav.label.replace('-PERP', '');
    b.appendChild(nameEl);

    const priceEl = document.createElement('span');
    priceEl.className = 'fav-price';
    priceEl.textContent = '—';
    b.appendChild(priceEl);

    state.favoritePriceEls.push({ coin: fav.coin, el: priceEl });
    pairsEl.insertBefore(b, toggleBtn);
  });
  updateFavoritePrices();
}
function isFavorite(coin){
  return state.favorites.some(f => f.coin === coin);
}
function toggleFavorite(pair){
  const idx = state.favorites.findIndex(f => f.coin === pair.coin);
  if(idx >= 0) state.favorites.splice(idx, 1);
  else state.favorites.push({ coin: pair.coin, label: pair.label, type: pair.type });
  renderFavorites();
  syncFavoritePriceSubscriptions();
  persistPrefs();
  renderDropdownList($('searchInput').value);
}

// 즐겨찾기 바로가기 버튼에 표시할 실시간 가격.
// mid가격(allMids) 대신, 메인 차트가 가격을 가져오는 것과 완전히 동일한 방식
// (candle 구독의 종가, connectTodayWs와 같은 패턴)을 그대로 재사용한다.
// - 차트에 보이는 마지막 체결가와 항상 일치한다.
// - coin 문자열을 그대로 구독에 쓰기 때문에 HIP-3 페어("dexname:SYMBOL")도 메인 차트와 동일하게 동작한다.
function updateFavoritePrices(){
  (state.favoritePriceEls || []).forEach(({ coin, el }) => {
    const px = state.favoritePrices[coin];
    el.textContent = px != null ? formatPrice(px) : '—';
  });
}

// 예전엔 여기서 소켓 열기/구독 보내기/채널 필터링/3초 뒤 재연결을 통째로 손으로 구현했었다
// (util.js의 createSubscription과 똑같은 코드의 6번째 사본). 게다가 재연결 타이머를 아무도
// 붙잡고 있지 않아서, 소켓이 끊긴 뒤 3초 안에 즐겨찾기를 해제하면 그 타이머가 그대로 살아남아
// 아무도 안 보는 좀비 구독이 다시 열렸다. createSubscription의 핸들은 close()가 재연결까지
// 같이 멈추므로 그 구멍이 사라진다.
function connectFavoritePriceWs(coin){
  if(state.favoritePriceWs[coin]) return; // 이미 구독 중

  const handle = createSubscription({
    subscription: { type: 'candle', coin, interval: '1m' },
    channels: 'candle',
    onData: (data) => {
      state.favoritePrices[coin] = toChartCandle(data).close;
      updateFavoritePrices();
    },
  });
  state.favoritePriceWs[coin] = handle;

  // 웹소켓 첫 틱이 오기 전 공백을 없애기 위해 REST로 최근 1분봉을 먼저 채워둔다.
  fetchHistory(coin, '1m').then(history => {
    if(!Array.isArray(history) || !history.length) return;
    if(state.favoritePriceWs[coin] !== handle) return; // 그 사이 즐겨찾기 해제됨
    state.favoritePrices[coin] = toChartCandle(history[history.length - 1]).close;
    updateFavoritePrices();
  }).catch(() => {});
}
function disconnectFavoritePriceWs(coin){
  const handle = state.favoritePriceWs[coin];
  if(handle){
    delete state.favoritePriceWs[coin];
    closeSubscription(handle);
  }
}
// 즐겨찾기 목록이 바뀔 때마다, 더 이상 필요없는 구독은 끊고 새로 추가된 코인만 구독한다.
function syncFavoritePriceSubscriptions(){
  const favCoins = new Set(state.favorites.map(f => f.coin));
  Object.keys(state.favoritePriceWs).forEach(coin => {
    if(!favCoins.has(coin)) disconnectFavoritePriceWs(coin);
  });
  favCoins.forEach(coin => connectFavoritePriceWs(coin));
}

// ---------- 페어 드롭다운 ----------
const dropdownEl = $('dropdown');
const dropdownListEl = $('dropdownList');
const toggleBtn = $('allpairsToggle');
const searchInput = $('searchInput');

const pairsDropdown = createDropdown(toggleBtn, dropdownEl, () => {
  searchInput.value = '';
  renderDropdownList('');
  setTimeout(() => searchInput.focus(), 0);
});
function closeDropdown(){ pairsDropdown.close(); }
searchInput.addEventListener('input', (e) => renderDropdownList(e.target.value));


const dropdownTabsEl = $('dropdownTabs');
dropdownTabsEl.querySelectorAll('.tab').forEach(btn => {
  btn.onclick = () => {
    state.dropdownTab = btn.dataset.tab;
    [...dropdownTabsEl.querySelectorAll('.tab')].forEach(b => b.classList.toggle('active', b === btn));
    renderDropdownList(searchInput.value);
  };
});

function makePairRow(p){
  return makeDropdownRow({
    label: p.label,
    badge: { className: p.isHip3 ? 'HIP3' : p.type, text: p.isHip3 ? 'HIP-3' : p.type },
    star: { on: isFavorite(p.coin), onClick: () => toggleFavorite(p) },
    onClick: () => { selectPair(p); closeDropdown(); },
  });
}

function renderDropdownList(query){
  const q = query.trim().toUpperCase();
  if(!state.allPairsLoaded){
    dropdownListEl.innerHTML = `<div class="dropdown-empty">${t('loadingAllPairs')}</div>`;
    return;
  }
  let results = state.allPairs;
  if(q){
    results = results.filter(p => p.label.toUpperCase().includes(q) || p.coin.toUpperCase().includes(q));
  }

  const allGroups = [
    { key: 'FAV', title: t('tabFav'), items: results.filter(p => isFavorite(p.coin)) },
    { key: 'PERP', title: 'PERPETUAL', items: results.filter(p => p.type === 'PERP' && !p.isHip3).slice(0, 150) },
    { key: 'HIP3', title: 'HIP-3', items: results.filter(p => p.type === 'PERP' && p.isHip3).slice(0, 150) },
    { key: 'SPOT', title: 'SPOT', items: results.filter(p => p.type === 'SPOT').slice(0, 150) },
  ];

  const tab = state.dropdownTab || 'ALL';
  const groups = (tab === 'ALL' ? allGroups : allGroups.filter(g => g.key === tab)).filter(g => g.items.length > 0);

  if(groups.length === 0){
    dropdownListEl.innerHTML = `<div class="dropdown-empty">${t('noMatchingPairs')}</div>`;
    return;
  }

  dropdownListEl.innerHTML = '';
  groups.forEach(g => {
    const header = document.createElement('div');
    header.className = 'dropdown-header';
    header.textContent = `${g.title} (${g.items.length})`;
    dropdownListEl.appendChild(header);
    g.items.forEach(p => dropdownListEl.appendChild(makePairRow(p)));
  });
}

// ---------- 인터벌 즐겨찾기 + 드롭다운 ----------
const intervalToggle = $('intervalToggle');
const intervalToggleLabel = $('intervalToggleLabel');
const intervalDropdown = $('intervalDropdown');
const intervalDropdownList = $('intervalDropdownList');
const intervalFavRow = $('intervalFavRow');

function isIntervalFavorite(iv){ return state.intervalFavorites.includes(iv); }
function toggleIntervalFavorite(iv){
  const idx = state.intervalFavorites.indexOf(iv);
  if(idx >= 0) state.intervalFavorites.splice(idx, 1);
  else state.intervalFavorites.push(iv);
  renderIntervalFavorites();
  renderIntervalDropdown();
  persistPrefs();
}
function renderIntervalFavorites(){
  [...intervalFavRow.querySelectorAll('.pairbtn')].forEach(b => b.remove());
  state.intervalFavorites.forEach(iv => {
    const b = document.createElement('button');
    b.className = 'pairbtn' + (state.interval === iv ? ' active' : '');
    b.textContent = iv;
    b.onclick = () => selectInterval(iv);
    intervalFavRow.insertBefore(b, intervalToggle);
  });
}
function renderIntervalDropdown(){
  intervalDropdownList.innerHTML = '';
  INTERVAL_GROUPS.forEach(g => {
    const header = document.createElement('div');
    header.className = 'dropdown-header';
    header.textContent = t(g.titleKey);
    intervalDropdownList.appendChild(header);
    g.items.forEach(iv => {
      intervalDropdownList.appendChild(makeDropdownRow({
        active: iv === state.interval,
        label: iv,
        star: { on: isIntervalFavorite(iv), onClick: () => toggleIntervalFavorite(iv) },
        onClick: () => { selectInterval(iv); closeIntervalDropdown(); },
      }));
    });
  });
}
const intervalDropdownCtrl = createDropdown(intervalToggle, intervalDropdown, renderIntervalDropdown);
function closeIntervalDropdown(){ intervalDropdownCtrl.close(); }
