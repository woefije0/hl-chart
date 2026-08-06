/* pine-builtins.js
   ta.* / math.* / array.* / input.* / color.* / str.* 내장 함수 구현 + plot()/hline() 등 최상위 함수.
   그리고 lexer->parser->interpreter를 한 번에 묶어 실행하는 runPineScript() 진입점. */

function getArg(posArgs, namedArgs, idx, name, def){
  if(namedArgs && namedArgs.hasOwnProperty(name)) return namedArgs[name];
  if(posArgs && idx < posArgs.length) return posArgs[idx];
  return def === undefined ? null : def;
}
function getState(it, node){
  const key = it.pathKey ? it.pathKey(node) : node.id;
  let s = it.callState.get(key);
  if(!s){ s = {}; it.callState.set(key, s); }
  return s;
}

// ============================================================
// array.* 메서드 구현부 (array.push(arr,x) 정적 형태 + arr.push(x) 메서드 문법 양쪽에서 재사용)
// ============================================================
const ARRAY_METHOD_BUILTINS = {
  push: (it, arr, p) => { arr.items.push(p[0] === undefined ? null : p[0]); return null; },
  pop: (it, arr, p, n, node) => { if(!arr.items.length) throw new PineRuntimeError(pineMsg('빈 배열에서 pop() 할 수 없습니다', 'Cannot pop() from an empty array'), node ? node.line : 0); return arr.items.pop(); },
  shift: (it, arr, p, n, node) => { if(!arr.items.length) throw new PineRuntimeError(pineMsg('빈 배열에서 shift() 할 수 없습니다', 'Cannot shift() from an empty array'), node ? node.line : 0); return arr.items.shift(); },
  unshift: (it, arr, p) => { arr.items.unshift(p[0] === undefined ? null : p[0]); return null; },
  insert: (it, arr, p) => { arr.items.splice(Math.round(pineNum(p[0])), 0, p[1] === undefined ? null : p[1]); return null; },
  remove: (it, arr, p, n, node) => {
    const idx = Math.round(pineNum(p[0]));
    if(idx < 0 || idx >= arr.items.length) throw new PineRuntimeError(pineMsg('배열 인덱스 범위를 벗어났습니다: ' + idx, 'Array index out of range: ' + idx), node ? node.line : 0);
    return arr.items.splice(idx, 1)[0];
  },
  get: (it, arr, p, n, node) => it.arrayGet(arr, p.length ? p[0] : n.index, node ? node.line : 0),
  set: (it, arr, p, n, node) => {
    const idx = Math.round(pineNum(p[0]));
    if(idx < 0 || idx >= arr.items.length) throw new PineRuntimeError(pineMsg('배열 인덱스 범위를 벗어났습니다: ' + idx, 'Array index out of range: ' + idx), node ? node.line : 0);
    arr.items[idx] = p[1] === undefined ? null : p[1];
    return null;
  },
  size: (it, arr) => arr.items.length,
  clear: (it, arr) => { arr.items.length = 0; return null; },
  includes: (it, arr, p) => arr.items.includes(p[0]),
  indexof: (it, arr, p) => arr.items.indexOf(p[0]),
  lastindexof: (it, arr, p) => arr.items.lastIndexOf(p[0]),
  // 오름차순 정렬된 배열 전용 이진 탐색. 정확히 일치하면 그 인덱스, 아니면 leftmost는 값보다
  // 작은 쪽에서, rightmost는 값보다 작거나 같은 쪽에서 가장 가까운 인덱스로 보정한다(0 미만으로는 안 내려감).
  binary_search: (it, arr, p) => {
    const val = pineNum(p[0]);
    let lo = 0, hi = arr.items.length - 1;
    while(lo <= hi){
      const mid = (lo + hi) >> 1;
      if(arr.items[mid] === val) return mid;
      if(arr.items[mid] < val) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
  },
  binary_search_leftmost: (it, arr, p) => {
    const val = pineNum(p[0]);
    let lo = 0, hi = arr.items.length;
    while(lo < hi){ const mid = (lo + hi) >> 1; if(arr.items[mid] < val) lo = mid + 1; else hi = mid; }
    if(lo < arr.items.length && arr.items[lo] === val) return lo;
    return lo > 0 ? lo - 1 : 0;
  },
  binary_search_rightmost: (it, arr, p) => {
    const val = pineNum(p[0]);
    let lo = 0, hi = arr.items.length;
    while(lo < hi){ const mid = (lo + hi) >> 1; if(arr.items[mid] <= val) lo = mid + 1; else hi = mid; }
    return lo > 0 ? lo - 1 : 0;
  },
  // 실제 Pine의 array.slice(id, index_from, index_to)는 index_to를 "포함하지 않는다"
  // (index_from부터 index_to-1까지) — JS의 Array.slice와 동일한 exclusive-end 규칙.
  slice: (it, arr, p) => new PineArray(arr.items.slice(Math.round(pineNum(p[0])), Math.round(pineNum(p[1]))), arr.kind),
  copy: (it, arr) => new PineArray(arr.items.slice(), arr.kind),
  concat: (it, arr, p) => { const other = p[0]; arr.items = arr.items.concat(other instanceof PineArray ? other.items : []); return arr; },
  join: (it, arr, p) => arr.items.map(pineFmt).join(p.length ? p[0] : ','),
  reverse: (it, arr) => { arr.items.reverse(); return null; },
  sort: (it, arr, p) => { const order = p[0] || 'ascending'; arr.items.sort((a, b) => order === 'descending' ? b - a : a - b); return null; },
  min: (it, arr) => { const v = arr.items.filter(x => x != null); return v.length ? Math.min(...v) : null; },
  max: (it, arr) => { const v = arr.items.filter(x => x != null); return v.length ? Math.max(...v) : null; },
  sum: (it, arr) => arr.items.reduce((a, b) => a + (b || 0), 0),
  avg: (it, arr) => arr.items.length ? arr.items.reduce((a, b) => a + (b || 0), 0) / arr.items.length : null,
  first: (it, arr) => arr.items.length ? arr.items[0] : null,
  last: (it, arr) => arr.items.length ? arr.items[arr.items.length - 1] : null,
  fill: (it, arr, p) => {
    const v = p[0] === undefined ? null : p[0];
    const from = p.length > 1 ? Math.round(pineNum(p[1])) : 0;
    const to = p.length > 2 ? Math.round(pineNum(p[2])) : arr.items.length;
    for(let k = from; k < to; k++) arr.items[k] = v;
    return null;
  },
  variance: (it, arr) => { const v = arr.items.filter(x => x != null); if(!v.length) return null; const m = v.reduce((a, b) => a + b, 0) / v.length; return v.reduce((a, b) => a + (b - m) * (b - m), 0) / v.length; },
  stdev: (it, arr) => { const vv = ARRAY_METHOD_BUILTINS.variance(it, arr); return vv == null ? null : Math.sqrt(vv); },
  median: (it, arr) => { const v = arr.items.filter(x => x != null).slice().sort((a, b) => a - b); if(!v.length) return null; const mid = Math.floor(v.length / 2); return v.length % 2 === 0 ? (v[mid - 1] + v[mid]) / 2 : v[mid]; },
  mode: (it, arr) => {
    const v = arr.items.filter(x => x != null); if(!v.length) return null;
    const counts = new Map(); v.forEach(x => counts.set(x, (counts.get(x) || 0) + 1));
    let best = null, bc = -1;
    for(const [val, c] of counts){ if(c > bc || (c === bc && val < best)){ best = val; bc = c; } }
    return best;
  },
  range: (it, arr) => { const v = arr.items.filter(x => x != null); return v.length ? Math.max(...v) - Math.min(...v) : null; },
  every: (it, arr) => arr.items.every(x => pineTruthy(x)),
  some: (it, arr) => arr.items.some(x => pineTruthy(x)),
  percentrank: (it, arr, p) => {
    const idx = Math.round(pineNum(p[0])); const v = arr.items[idx]; if(v == null || !arr.items.length) return null;
    let count = 0; arr.items.forEach(x => { if(x != null && x <= v) count++; });
    return count / arr.items.length * 100;
  },
  covariance: (it, arr, p) => {
    const other = p[0]; if(!(other instanceof PineArray)) return null;
    const a = arr.items, b = other.items; const len = Math.min(a.length, b.length); if(!len) return null;
    const ma = a.slice(0, len).reduce((x, y) => x + y, 0) / len, mb = b.slice(0, len).reduce((x, y) => x + y, 0) / len;
    let cov = 0; for(let k = 0; k < len; k++) cov += (a[k] - ma) * (b[k] - mb);
    return cov / len;
  },
  standardize: (it, arr) => {
    const v = arr.items.filter(x => x != null); if(!v.length) return new PineArray([], arr.kind);
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / v.length);
    return new PineArray(arr.items.map(x => x == null ? null : (sd === 0 ? 0 : (x - m) / sd)), arr.kind);
  },
};

function wrapArrayFn(method){
  return (it, p, n, node) => {
    const arr = p[0];
    if(!(arr instanceof PineArray)) throw new PineRuntimeError(pineMsg('array.' + method + '()의 첫 인자는 배열이어야 합니다', 'array.' + method + "()'s first argument must be an array"), node ? node.line : 0);
    return ARRAY_METHOD_BUILTINS[method](it, arr, p.slice(1), n, node);
  };
}
function arrayNewFn(kind){
  return (it, p) => {
    const size = p.length ? Math.round(pineNum(p[0])) : 0;
    const initial = p.length > 1 ? p[1] : (kind === 'bool' ? false : (kind === 'string' ? '' : null));
    return new PineArray(new Array(Math.max(0, size)).fill(initial), kind);
  };
}

// ============================================================
// input.* — input() 계열은 첫 실행(bar 0)에서 메타데이터를 수집해서 pine-import.js가
// 자동으로 입력 폼을 그릴 수 있게 하고, UI에서 값이 바뀌면 inputOverrides로 덮어쓴다.
// ============================================================
function findDefvalArgNode(node){
  const named = node.args.find(a => a.named && a.name === 'defval');
  if(named) return named.value;
  const pos = node.args.filter(a => !a.named);
  return pos.length ? pos[0].value : null;
}
function inputFn(kind){
  return (it, p, n, node) => {
    const defval = p.length ? p[0] : (n.hasOwnProperty('defval') ? n.defval : null);
    const title = n.title || (p.length > 1 ? p[1] : null) || pineMsg('입력 ' + node.id, 'Input ' + node.id);
    if(it.curBar === 0){
      const defvalNode = findDefvalArgNode(node);
      const isLiteral = !!defvalNode && ['Number', 'String', 'Bool', 'Na'].includes(defvalNode.type);
      let effKind = kind;
      if(kind === 'generic'){
        effKind = typeof defval === 'boolean' ? 'bool' : (typeof defval === 'string' ? 'string' : 'float');
      }
      // 값이 close/hlc3 같은 계산식(리터럴이 아님)이면 '소스 선택' 용도라 임의 숫자로 편집하게 두면 안 되므로 폼에서 뺀다
      const skip = !isLiteral && (kind === 'generic' || kind === 'source');
      if(!skip){
        const opts = n.options instanceof PineArray ? n.options.items : (Array.isArray(n.options) ? n.options : null);
        it.inputMeta.push({
          id: node.id, kind: effKind, title,
          defval, minval: n.minval != null ? n.minval : null, maxval: n.maxval != null ? n.maxval : null,
          step: n.step != null ? n.step : null, options: opts,
        });
      }
    }
    if(it.inputOverrides.hasOwnProperty(node.id)) return it.inputOverrides[node.id];
    return defval;
  };
}

// ============================================================
// ta.* — 내부 상태가 필요한 함수들은 콜사이트(node.id)별로 callState에 버퍼/이전값을 저장한다.
// ============================================================
function taRollingBuf(it, node){ const s = getState(it, node); if(!s.buf) s.buf = new Array(it.n); return s; }
// Wilder RMA를 여러 값(TR/+DM/-DM/ADX 등)에 대해 독립적으로 돌릴 때 재사용하는 헬퍼.
// key별로 워밍업 합계 버퍼와 이전 값을 콜스테이트(s)에 따로 보관한다 (ta.atr과 같은 패턴을 일반화).
function taRmaAdvance(s, key, len, curBar, value){
  if(!s[key + 'Buf']) s[key + 'Buf'] = [];
  const buf = s[key + 'Buf']; buf[curBar] = value;
  const prevKey = key + 'Prev';
  if(s[prevKey] != null){ const val = (s[prevKey] * (len - 1) + value) / len; s[prevKey] = val; return val; }
  if(curBar + 1 < len) return null;
  let sum = 0;
  for(let k = curBar - len + 1; k <= curBar; k++){ if(buf[k] == null) return null; sum += buf[k]; }
  const seed = sum / len; s[prevKey] = seed; return seed;
}
// ta.ema과 같은 워밍업(첫 호출값을 그대로 시드로 삼는) 방식의 EMA를 key별로 독립적으로 돌릴 때 쓰는 헬퍼.
function taEmaAdvance(s, key, len, value){
  const prevKey = key + 'Prev';
  if(value == null) return s[prevKey] == null ? null : s[prevKey];
  const alpha = 2 / (len + 1);
  if(s[prevKey] == null){ s[prevKey] = value; return value; }
  const val = alpha * value + (1 - alpha) * s[prevKey]; s[prevKey] = val; return val;
}

const TA_NS = {
  'ta.sma': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const s = taRollingBuf(it, node); s.buf[it.curBar] = src;
    if(len < 1) return null;
    const start = it.curBar - len + 1; if(start < 0) return null;
    let sum = 0;
    for(let k = start; k <= it.curBar; k++){ if(s.buf[k] == null) return null; sum += s.buf[k]; }
    return sum / len;
  },
  'ta.ema': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const s = getState(it, node);
    if(src == null) return s.prev == null ? null : s.prev;
    const alpha = 2 / (len + 1);
    if(s.prev == null){ s.prev = src; return src; }
    const val = alpha * src + (1 - alpha) * s.prev; s.prev = val; return val;
  },
  'ta.rma': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const s = taRollingBuf(it, node); s.buf[it.curBar] = src;
    if(s.prev != null){ if(src == null) return s.prev; const val = (s.prev * (len - 1) + src) / len; s.prev = val; return val; }
    if(it.curBar + 1 < len) return null;
    let sum = 0;
    for(let k = it.curBar - len + 1; k <= it.curBar; k++){ if(s.buf[k] == null) return null; sum += s.buf[k]; }
    const seed = sum / len; s.prev = seed; return seed;
  },
  'ta.wma': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const s = taRollingBuf(it, node); s.buf[it.curBar] = src;
    if(len < 1) return null; const start = it.curBar - len + 1; if(start < 0) return null;
    let wsum = 0, norm = 0;
    for(let k = start; k <= it.curBar; k++){ if(s.buf[k] == null) return null; const w = k - start + 1; wsum += s.buf[k] * w; norm += w; }
    return wsum / norm;
  },
  'ta.vwma': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const s = getState(it, node); if(!s.buf) s.buf = new Array(it.n);
    s.buf[it.curBar] = { v: src, vol: it.volArr[it.curBar] };
    if(len < 1) return null; const start = it.curBar - len + 1; if(start < 0) return null;
    let num = 0, den = 0;
    for(let k = start; k <= it.curBar; k++){ const e = s.buf[k]; if(!e || e.v == null) return null; num += e.v * e.vol; den += e.vol; }
    return den === 0 ? null : num / den;
  },
  'ta.variance': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const s = taRollingBuf(it, node); s.buf[it.curBar] = src;
    const start = it.curBar - len + 1; if(len < 1 || start < 0) return null;
    let sum = 0;
    for(let k = start; k <= it.curBar; k++){ if(s.buf[k] == null) return null; sum += s.buf[k]; }
    const mean = sum / len; let sq = 0;
    for(let k = start; k <= it.curBar; k++){ const d = s.buf[k] - mean; sq += d * d; }
    return sq / len;
  },
  'ta.stdev': (it, p, n, node) => { const v = TA_NS['ta.variance'](it, p, n, node); return v == null ? null : Math.sqrt(v); },
  'ta.highest': (it, p, n, node) => {
    const twoArg = p.length >= 2 || n.hasOwnProperty('source');
    let arr, len;
    if(twoArg){ const src = getArg(p, n, 0, 'source'); len = Math.round(pineNum(getArg(p, n, 1, 'length'))); const s = taRollingBuf(it, node); s.buf[it.curBar] = src; arr = s.buf; }
    else { len = Math.round(pineNum(getArg(p, n, 0, 'length'))); arr = it.highArr; }
    const start = it.curBar - len + 1; if(len < 1 || start < 0) return null;
    let mx = -Infinity;
    for(let k = start; k <= it.curBar; k++){ if(arr[k] == null) return null; if(arr[k] > mx) mx = arr[k]; }
    return mx;
  },
  'ta.lowest': (it, p, n, node) => {
    const twoArg = p.length >= 2 || n.hasOwnProperty('source');
    let arr, len;
    if(twoArg){ const src = getArg(p, n, 0, 'source'); len = Math.round(pineNum(getArg(p, n, 1, 'length'))); const s = taRollingBuf(it, node); s.buf[it.curBar] = src; arr = s.buf; }
    else { len = Math.round(pineNum(getArg(p, n, 0, 'length'))); arr = it.lowArr; }
    const start = it.curBar - len + 1; if(len < 1 || start < 0) return null;
    let mn = Infinity;
    for(let k = start; k <= it.curBar; k++){ if(arr[k] == null) return null; if(arr[k] < mn) mn = arr[k]; }
    return mn;
  },
  'ta.tr': (it) => {
    const i = it.curBar; const h = it.highArr[i], l = it.lowArr[i], pc = i > 0 ? it.closeArr[i - 1] : null;
    return pc == null ? (h - l) : Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  },
  'ta.atr': (it, p, n, node) => {
    const len = Math.round(pineNum(getArg(p, n, 0, 'length')));
    const tr = TA_NS['ta.tr'](it);
    const s = getState(it, node); if(!s.buf) s.buf = new Array(it.n); s.buf[it.curBar] = tr;
    if(s.prev != null){ const val = (s.prev * (len - 1) + tr) / len; s.prev = val; return val; }
    if(it.curBar + 1 < len) return null;
    let sum = 0;
    for(let k = it.curBar - len + 1; k <= it.curBar; k++){ if(s.buf[k] == null) return null; sum += s.buf[k]; }
    const seed = sum / len; s.prev = seed; return seed;
  },
  'ta.rsi': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const s = getState(it, node);
    if(s.prevSrc == null){ s.prevSrc = src; return null; }
    const change = src - s.prevSrc; s.prevSrc = src;
    const gain = Math.max(change, 0), loss = Math.max(-change, 0);
    if(!s.gbuf){ s.gbuf = new Array(it.n); s.lbuf = new Array(it.n); }
    s.gbuf[it.curBar] = gain; s.lbuf[it.curBar] = loss;
    let up, down;
    if(s.upPrev != null){ up = (s.upPrev * (len - 1) + gain) / len; down = (s.downPrev * (len - 1) + loss) / len; }
    else {
      if(it.curBar - len + 1 < 0) return null;
      let su = 0, sd = 0;
      for(let k = it.curBar - len + 1; k <= it.curBar; k++){ if(s.gbuf[k] == null) return null; su += s.gbuf[k]; sd += s.lbuf[k]; }
      up = su / len; down = sd / len;
    }
    s.upPrev = up; s.downPrev = down;
    if(down === 0) return up === 0 ? 50 : 100;
    return 100 - 100 / (1 + up / down);
  },
  'ta.macd': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source');
    const fast = Math.round(pineNum(getArg(p, n, 1, 'fastlen', 12)));
    const slow = Math.round(pineNum(getArg(p, n, 2, 'slowlen', 26)));
    const sig = Math.round(pineNum(getArg(p, n, 3, 'siglen', 9)));
    const s = getState(it, node);
    if(!s.fastS) s.fastS = {}; if(!s.slowS) s.slowS = {}; if(!s.sigS) s.sigS = {};
    const emaStep = (state, len, v) => {
      const alpha = 2 / (len + 1);
      if(state.v == null){ state.v = v; return v; }
      const val = alpha * v + (1 - alpha) * state.v; state.v = val; return val;
    };
    const fastVal = emaStep(s.fastS, fast, src);
    const slowVal = emaStep(s.slowS, slow, src);
    const macdVal = fastVal - slowVal;
    const signalVal = emaStep(s.sigS, sig, macdVal);
    return [macdVal, signalVal, macdVal - signalVal];
  },
  'ta.change': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length', 1)));
    const s = taRollingBuf(it, node); s.buf[it.curBar] = src;
    const at = it.curBar - len; if(at < 0 || s.buf[at] == null || src == null) return null; return src - s.buf[at];
  },
  'ta.mom': (it, p, n, node) => TA_NS['ta.change'](it, p, n, node),
  'ta.roc': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const s = taRollingBuf(it, node); s.buf[it.curBar] = src;
    const at = it.curBar - len; if(at < 0 || !s.buf[at] || src == null) return null; return (src - s.buf[at]) / s.buf[at] * 100;
  },
  'ta.cum': (it, p, n, node) => { const src = getArg(p, n, 0, 'source'); const s = getState(it, node); s.sum = (s.sum || 0) + (src || 0); return s.sum; },
  'ta.crossover': (it, p, n, node) => {
    const a = getArg(p, n, 0, 'source1'), b = getArg(p, n, 1, 'source2');
    const s = getState(it, node); const pa = s.prevA, pb = s.prevB; s.prevA = a; s.prevB = b;
    if(pa == null || pb == null || a == null || b == null) return false;
    return pa <= pb && a > b;
  },
  'ta.crossunder': (it, p, n, node) => {
    const a = getArg(p, n, 0, 'source1'), b = getArg(p, n, 1, 'source2');
    const s = getState(it, node); const pa = s.prevA, pb = s.prevB; s.prevA = a; s.prevB = b;
    if(pa == null || pb == null || a == null || b == null) return false;
    return pa >= pb && a < b;
  },
  'ta.cross': (it, p, n, node) => {
    const a = getArg(p, n, 0, 'source1'), b = getArg(p, n, 1, 'source2');
    const s = getState(it, node); const pa = s.prevA, pb = s.prevB; s.prevA = a; s.prevB = b;
    if(pa == null || pb == null || a == null || b == null) return false;
    return (pa <= pb && a > b) || (pa >= pb && a < b);
  },
  'ta.barssince': (it, p, n, node) => {
    const cond = pineTruthy(getArg(p, n, 0, 'condition'));
    const s = getState(it, node);
    if(cond){ s.count = 0; return 0; }
    if(s.count == null) return null;
    s.count++; return s.count;
  },
  'ta.valuewhen': (it, p, n, node) => {
    const cond = pineTruthy(getArg(p, n, 0, 'condition')); const src = getArg(p, n, 1, 'source');
    const occ = Math.round(pineNum(getArg(p, n, 2, 'occurrence', 0)));
    const s = getState(it, node); if(!s.hits) s.hits = [];
    if(cond) s.hits.unshift(src);
    return s.hits.length > occ ? s.hits[occ] : null;
  },
  'ta.correlation': (it, p, n, node) => {
    const a = getArg(p, n, 0, 'source1'), b = getArg(p, n, 1, 'source2'); const len = Math.round(pineNum(getArg(p, n, 2, 'length')));
    const s = getState(it, node); if(!s.abuf){ s.abuf = new Array(it.n); s.bbuf = new Array(it.n); }
    s.abuf[it.curBar] = a; s.bbuf[it.curBar] = b;
    const start = it.curBar - len + 1; if(len < 2 || start < 0) return null;
    let sa = 0, sb = 0;
    for(let k = start; k <= it.curBar; k++){ if(s.abuf[k] == null || s.bbuf[k] == null) return null; sa += s.abuf[k]; sb += s.bbuf[k]; }
    const ma = sa / len, mb = sb / len; let cov = 0, va = 0, vb = 0;
    for(let k = start; k <= it.curBar; k++){ const da = s.abuf[k] - ma, db = s.bbuf[k] - mb; cov += da * db; va += da * da; vb += db * db; }
    if(va === 0 || vb === 0) return null; return cov / Math.sqrt(va * vb);
  },
  'ta.vwap': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source', it.hlc3Arr[it.curBar]);
    const anchor = pineTruthy(getArg(p, n, 1, 'anchor', false));
    const mult = getArg(p, n, 2, 'stdev_mult', 1);
    const vol = it.volArr[it.curBar] || 0;
    const s = getState(it, node);
    if(s.sumPV == null || anchor){ s.sumPV = 0; s.sumV = 0; s.sumPV2 = 0; }
    s.sumPV += src * vol; s.sumV += vol; s.sumPV2 += src * src * vol;
    if(s.sumV === 0) return [null, null, null];
    const vwap = s.sumPV / s.sumV;
    const variance = Math.max(0, s.sumPV2 / s.sumV - vwap * vwap);
    const stdev = Math.sqrt(variance);
    return [vwap, vwap + mult * stdev, vwap - mult * stdev];
  },
  'ta.pivothigh': (it, p, n, node) => {
    let src, left, right;
    if(p.length >= 3 || n.hasOwnProperty('source')){
      const srcVal = getArg(p, n, 0, 'source'); left = Math.round(pineNum(getArg(p, n, 1, 'leftbars'))); right = Math.round(pineNum(getArg(p, n, 2, 'rightbars')));
      const s = taRollingBuf(it, node); s.buf[it.curBar] = srcVal; src = s.buf;
    } else {
      left = Math.round(pineNum(getArg(p, n, 0, 'leftbars'))); right = Math.round(pineNum(getArg(p, n, 1, 'rightbars'))); src = it.highArr;
    }
    const center = it.curBar - right;
    if(center < left) return null;
    const centerVal = src[center];
    if(centerVal == null) return null;
    for(let k = center - left; k <= center + right; k++){
      if(k === center) continue;
      if(k < 0 || src[k] == null) return null;
      if(src[k] > centerVal) return null;
    }
    return centerVal;
  },
  'ta.pivotlow': (it, p, n, node) => {
    let src, left, right;
    if(p.length >= 3 || n.hasOwnProperty('source')){
      const srcVal = getArg(p, n, 0, 'source'); left = Math.round(pineNum(getArg(p, n, 1, 'leftbars'))); right = Math.round(pineNum(getArg(p, n, 2, 'rightbars')));
      const s = taRollingBuf(it, node); s.buf[it.curBar] = srcVal; src = s.buf;
    } else {
      left = Math.round(pineNum(getArg(p, n, 0, 'leftbars'))); right = Math.round(pineNum(getArg(p, n, 1, 'rightbars'))); src = it.lowArr;
    }
    const center = it.curBar - right;
    if(center < left) return null;
    const centerVal = src[center];
    if(centerVal == null) return null;
    for(let k = center - left; k <= center + right; k++){
      if(k === center) continue;
      if(k < 0 || src[k] == null) return null;
      if(src[k] < centerVal) return null;
    }
    return centerVal;
  },
  'ta.linreg': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const offset = Math.round(pineNum(getArg(p, n, 2, 'offset', 0)));
    const s = taRollingBuf(it, node); s.buf[it.curBar] = src;
    const start = it.curBar - len + 1;
    if(len < 2 || start < 0) return null;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for(let k = 0; k < len; k++){
      const y = s.buf[start + k];
      if(y == null) return null;
      sumX += k; sumY += y; sumXY += k * y; sumX2 += k * k;
    }
    const denom = len * sumX2 - sumX * sumX;
    if(denom === 0) return null;
    const slope = (len * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / len;
    return intercept + slope * (len - 1 + offset);
  },
  'ta.dev': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const s = taRollingBuf(it, node); s.buf[it.curBar] = src;
    const start = it.curBar - len + 1; if(len < 1 || start < 0) return null;
    let sum = 0;
    for(let k = start; k <= it.curBar; k++){ if(s.buf[k] == null) return null; sum += s.buf[k]; }
    const mean = sum / len; let sad = 0;
    for(let k = start; k <= it.curBar; k++) sad += Math.abs(s.buf[k] - mean);
    return sad / len;
  },
  'ta.alma': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const offset = pineNum(getArg(p, n, 2, 'offset', 0.85)); const sigma = pineNum(getArg(p, n, 3, 'sigma', 6));
    const s = taRollingBuf(it, node); s.buf[it.curBar] = src;
    const start = it.curBar - len + 1; if(len < 1 || start < 0) return null;
    const m = offset * (len - 1); const sg = len / sigma;
    let num = 0, den = 0;
    for(let k = 0; k < len; k++){
      const v = s.buf[start + k]; if(v == null) return null;
      const w = Math.exp(-((k - m) * (k - m)) / (2 * sg * sg));
      num += w * v; den += w;
    }
    return den === 0 ? null : num / den;
  },
  'ta.swma': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source');
    const s = taRollingBuf(it, node); s.buf[it.curBar] = src;
    const start = it.curBar - 3; if(start < 0) return null;
    const w = [1, 2, 2, 1]; let sum = 0;
    for(let k = 0; k < 4; k++){ const v = s.buf[start + k]; if(v == null) return null; sum += v * w[k]; }
    return sum / 6;
  },
  'ta.hma': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const halfLen = Math.max(1, Math.round(len / 2)), sqrtLen = Math.max(1, Math.round(Math.sqrt(len)));
    const s = getState(it, node);
    if(!s.buf) s.buf = new Array(it.n); s.buf[it.curBar] = src;
    function wmaOf(buf, ln, endIdx){
      const start = endIdx - ln + 1; if(ln < 1 || start < 0) return null;
      let wsum = 0, norm = 0;
      for(let k = start; k <= endIdx; k++){ if(buf[k] == null) return null; const w = k - start + 1; wsum += buf[k] * w; norm += w; }
      return wsum / norm;
    }
    const wmaHalf = wmaOf(s.buf, halfLen, it.curBar), wmaFull = wmaOf(s.buf, len, it.curBar);
    if(wmaHalf == null || wmaFull == null) return null;
    if(!s.rawBuf) s.rawBuf = new Array(it.n);
    s.rawBuf[it.curBar] = 2 * wmaHalf - wmaFull;
    return wmaOf(s.rawBuf, sqrtLen, it.curBar);
  },
  'ta.median': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const s = taRollingBuf(it, node); s.buf[it.curBar] = src;
    const start = it.curBar - len + 1; if(len < 1 || start < 0) return null;
    const vals = [];
    for(let k = start; k <= it.curBar; k++){ if(s.buf[k] == null) return null; vals.push(s.buf[k]); }
    vals.sort((a, b) => a - b);
    const mid = Math.floor(len / 2);
    return len % 2 === 0 ? (vals[mid - 1] + vals[mid]) / 2 : vals[mid];
  },
  'ta.mode': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const s = taRollingBuf(it, node); s.buf[it.curBar] = src;
    const start = it.curBar - len + 1; if(len < 1 || start < 0) return null;
    const counts = new Map();
    for(let k = start; k <= it.curBar; k++){ const v = s.buf[k]; if(v == null) return null; counts.set(v, (counts.get(v) || 0) + 1); }
    let best = null, bestCount = -1;
    for(const [v, c] of counts){ if(c > bestCount || (c === bestCount && v < best)){ best = v; bestCount = c; } }
    return best;
  },
  'ta.range': (it, p, n, node) => {
    const hi = TA_NS['ta.highest'](it, p, n, node); const lo = TA_NS['ta.lowest'](it, p, n, node);
    return (hi == null || lo == null) ? null : hi - lo;
  },
  'ta.percentrank': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const s = taRollingBuf(it, node); s.buf[it.curBar] = src;
    if(len < 1 || it.curBar < len || src == null) return null;
    let count = 0, valid = 0;
    for(let k = it.curBar - len; k < it.curBar; k++){ const v = s.buf[k]; if(v == null) continue; valid++; if(v <= src) count++; }
    return valid === 0 ? null : (count / valid) * 100;
  },
  'ta.percentile_linear_interpolation': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const pct = pineNum(getArg(p, n, 2, 'percentage'));
    const s = taRollingBuf(it, node); s.buf[it.curBar] = src;
    const start = it.curBar - len + 1; if(len < 1 || start < 0) return null;
    const vals = [];
    for(let k = start; k <= it.curBar; k++){ if(s.buf[k] == null) return null; vals.push(s.buf[k]); }
    vals.sort((a, b) => a - b);
    let idx = (pct / 100) * len - 0.5;
    if(idx < 0) idx = 0; if(idx > len - 1) idx = len - 1;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    if(lo === hi) return vals[lo];
    return vals[lo] + (idx - lo) * (vals[hi] - vals[lo]);
  },
  'ta.percentile_nearest_rank': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const pct = pineNum(getArg(p, n, 2, 'percentage'));
    const s = taRollingBuf(it, node); s.buf[it.curBar] = src;
    const start = it.curBar - len + 1; if(len < 1 || start < 0) return null;
    const vals = [];
    for(let k = start; k <= it.curBar; k++){ if(s.buf[k] == null) return null; vals.push(s.buf[k]); }
    vals.sort((a, b) => a - b);
    let idx = Math.ceil((pct / 100) * len) - 1;
    if(idx < 0) idx = 0; if(idx >= len) idx = len - 1;
    return vals[idx];
  },
  'ta.falling': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const s = taRollingBuf(it, node); s.buf[it.curBar] = src;
    for(let k = 0; k < len; k++){
      const cur = s.buf[it.curBar - k]; const nxt = (it.curBar - k - 1 < 0) ? null : s.buf[it.curBar - k - 1];
      if(cur == null || nxt == null || cur >= nxt) return false;
    }
    return true;
  },
  'ta.rising': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const s = taRollingBuf(it, node); s.buf[it.curBar] = src;
    for(let k = 0; k < len; k++){
      const cur = s.buf[it.curBar - k]; const nxt = (it.curBar - k - 1 < 0) ? null : s.buf[it.curBar - k - 1];
      if(cur == null || nxt == null || cur <= nxt) return false;
    }
    return true;
  },
  'ta.highestbars': (it, p, n, node) => {
    const twoArg = p.length >= 2 || n.hasOwnProperty('source');
    let arr, len;
    if(twoArg){ const src = getArg(p, n, 0, 'source'); len = Math.round(pineNum(getArg(p, n, 1, 'length'))); const s = taRollingBuf(it, node); s.buf[it.curBar] = src; arr = s.buf; }
    else { len = Math.round(pineNum(getArg(p, n, 0, 'length'))); arr = it.highArr; }
    const start = it.curBar - len + 1; if(len < 1 || start < 0) return null;
    let mx = -Infinity, off = null;
    for(let k = start; k <= it.curBar; k++){ if(arr[k] == null) return null; if(arr[k] >= mx){ mx = arr[k]; off = k - it.curBar; } }
    return off;
  },
  'ta.lowestbars': (it, p, n, node) => {
    const twoArg = p.length >= 2 || n.hasOwnProperty('source');
    let arr, len;
    if(twoArg){ const src = getArg(p, n, 0, 'source'); len = Math.round(pineNum(getArg(p, n, 1, 'length'))); const s = taRollingBuf(it, node); s.buf[it.curBar] = src; arr = s.buf; }
    else { len = Math.round(pineNum(getArg(p, n, 0, 'length'))); arr = it.lowArr; }
    const start = it.curBar - len + 1; if(len < 1 || start < 0) return null;
    let mn = Infinity, off = null;
    for(let k = start; k <= it.curBar; k++){ if(arr[k] == null) return null; if(arr[k] <= mn){ mn = arr[k]; off = k - it.curBar; } }
    return off;
  },
  'ta.stoch': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const hi = getArg(p, n, 1, 'high'); const lo = getArg(p, n, 2, 'low');
    const len = Math.round(pineNum(getArg(p, n, 3, 'length')));
    const s = getState(it, node);
    if(!s.hbuf){ s.hbuf = new Array(it.n); s.lbuf = new Array(it.n); }
    s.hbuf[it.curBar] = hi; s.lbuf[it.curBar] = lo;
    const start = it.curBar - len + 1; if(len < 1 || start < 0) return null;
    let mx = -Infinity, mn = Infinity;
    for(let k = start; k <= it.curBar; k++){ if(s.hbuf[k] == null || s.lbuf[k] == null) return null; if(s.hbuf[k] > mx) mx = s.hbuf[k]; if(s.lbuf[k] < mn) mn = s.lbuf[k]; }
    const range = mx - mn; if(range === 0) return null;
    return 100 * (src - mn) / range;
  },
  'ta.wpr': (it, p, n, node) => {
    const len = Math.round(pineNum(getArg(p, n, 0, 'length')));
    const i = it.curBar; const start = i - len + 1; if(len < 1 || start < 0) return null;
    let mx = -Infinity, mn = Infinity;
    for(let k = start; k <= i; k++){ if(it.highArr[k] > mx) mx = it.highArr[k]; if(it.lowArr[k] < mn) mn = it.lowArr[k]; }
    const range = mx - mn; if(range === 0) return 0;
    return ((mx - it.closeArr[i]) / range) * -100;
  },
  'ta.cci': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const s = taRollingBuf(it, node); s.buf[it.curBar] = src;
    const start = it.curBar - len + 1; if(len < 1 || start < 0) return null;
    let sum = 0;
    for(let k = start; k <= it.curBar; k++){ if(s.buf[k] == null) return null; sum += s.buf[k]; }
    const sma = sum / len; let mad = 0;
    for(let k = start; k <= it.curBar; k++) mad += Math.abs(s.buf[k] - sma);
    mad /= len;
    if(mad === 0) return 0;
    return (src - sma) / (0.015 * mad);
  },
  'ta.cmo': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const s = getState(it, node);
    if(!s.gbuf){ s.gbuf = new Array(it.n); s.lbuf = new Array(it.n); }
    if(s.prevSrc == null){ s.prevSrc = src; return null; }
    const mom = src - s.prevSrc; s.prevSrc = src;
    s.gbuf[it.curBar] = mom >= 0 ? mom : 0; s.lbuf[it.curBar] = mom >= 0 ? 0 : -mom;
    const start = it.curBar - len + 1; if(len < 1 || start < 0) return null;
    let gs = 0, ls = 0;
    for(let k = start; k <= it.curBar; k++){ if(s.gbuf[k] == null) return null; gs += s.gbuf[k]; ls += s.lbuf[k]; }
    const denom = gs + ls;
    return denom === 0 ? 0 : 100 * (gs - ls) / denom;
  },
  'ta.cog': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const s = taRollingBuf(it, node); s.buf[it.curBar] = src;
    const start = it.curBar - len + 1; if(len < 1 || start < 0) return null;
    let sum = 0;
    for(let k = start; k <= it.curBar; k++){ if(s.buf[k] == null) return null; sum += s.buf[k]; }
    if(sum === 0) return null;
    let num = 0;
    for(let i = 0; i < len; i++) num += s.buf[it.curBar - i] * (i + 1);
    return -num / sum;
  },
  'ta.mfi': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const s = getState(it, node);
    if(!s.upBuf){ s.upBuf = new Array(it.n); s.dnBuf = new Array(it.n); }
    const vol = it.volArr[it.curBar];
    if(s.prevSrc == null){ s.prevSrc = src; s.upBuf[it.curBar] = 0; s.dnBuf[it.curBar] = 0; return null; }
    const change = src - s.prevSrc; s.prevSrc = src;
    s.upBuf[it.curBar] = change <= 0 ? 0 : vol * src; s.dnBuf[it.curBar] = change >= 0 ? 0 : vol * src;
    const start = it.curBar - len + 1; if(len < 1 || start < 0) return null;
    let up = 0, dn = 0;
    for(let k = start; k <= it.curBar; k++){ if(s.upBuf[k] == null) return null; up += s.upBuf[k]; dn += s.dnBuf[k]; }
    return dn === 0 ? 100 : 100 - 100 / (1 + up / dn);
  },
  'ta.bb': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const mult = pineNum(getArg(p, n, 2, 'mult', 2));
    const s = taRollingBuf(it, node); s.buf[it.curBar] = src;
    const start = it.curBar - len + 1; if(len < 1 || start < 0) return [null, null, null];
    let sum = 0;
    for(let k = start; k <= it.curBar; k++){ if(s.buf[k] == null) return [null, null, null]; sum += s.buf[k]; }
    const basis = sum / len; let sq = 0;
    for(let k = start; k <= it.curBar; k++){ const d = s.buf[k] - basis; sq += d * d; }
    const dev = Math.sqrt(sq / len);
    return [basis, basis + mult * dev, basis - mult * dev];
  },
  'ta.bbw': (it, p, n, node) => {
    const r = TA_NS['ta.bb'](it, p, n, node);
    if(r[0] == null || r[0] === 0) return null;
    return (r[1] - r[2]) / r[0];
  },
  'ta.kc': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source'); const len = Math.round(pineNum(getArg(p, n, 1, 'length')));
    const mult = pineNum(getArg(p, n, 2, 'mult', 2));
    const useTR = n.hasOwnProperty('useTrueRange') ? pineTruthy(n.useTrueRange) : (p.length > 3 ? pineTruthy(p[3]) : true);
    const s = getState(it, node); const i = it.curBar;
    const span = useTR ? TA_NS['ta.tr'](it) : (it.highArr[i] - it.lowArr[i]);
    const basis = taEmaAdvance(s, 'basis', len, src);
    const rangeEma = taEmaAdvance(s, 'range', len, span);
    if(basis == null || rangeEma == null) return [null, null, null];
    return [basis, basis + rangeEma * mult, basis - rangeEma * mult];
  },
  'ta.kcw': (it, p, n, node) => {
    const r = TA_NS['ta.kc'](it, p, n, node);
    if(r[0] == null || r[0] === 0) return null;
    return (r[1] - r[2]) / r[0];
  },
  'ta.dmi': (it, p, n, node) => {
    const diLen = Math.round(pineNum(getArg(p, n, 0, 'diLength')));
    const adxLen = Math.round(pineNum(getArg(p, n, 1, 'adxSmoothing')));
    const s = getState(it, node); const i = it.curBar;
    if(i === 0) return [null, null, null];
    const high = it.highArr[i], low = it.lowArr[i], pHigh = it.highArr[i - 1], pLow = it.lowArr[i - 1], pClose = it.closeArr[i - 1];
    const tr = Math.max(high - low, Math.abs(high - pClose), Math.abs(low - pClose));
    const up = high - pHigh, down = pLow - low;
    const plusDM = (up > down && up > 0) ? up : 0;
    const minusDM = (down > up && down > 0) ? down : 0;
    const smTR = taRmaAdvance(s, 'tr', diLen, i, tr);
    const smPlus = taRmaAdvance(s, 'plus', diLen, i, plusDM);
    const smMinus = taRmaAdvance(s, 'minus', diLen, i, minusDM);
    if(smTR == null) return [null, null, null];
    const plusDI = smTR === 0 ? 0 : 100 * smPlus / smTR;
    const minusDI = smTR === 0 ? 0 : 100 * smMinus / smTR;
    const sumDI = plusDI + minusDI;
    const dx = sumDI === 0 ? 0 : 100 * Math.abs(plusDI - minusDI) / sumDI;
    const adx = taRmaAdvance(s, 'adx', adxLen, i, dx);
    return [plusDI, minusDI, adx];
  },
  'ta.tsi': (it, p, n, node) => {
    const src = getArg(p, n, 0, 'source');
    const shortLen = Math.round(pineNum(getArg(p, n, 1, 'short_length')));
    const longLen = Math.round(pineNum(getArg(p, n, 2, 'long_length')));
    const s = getState(it, node);
    if(s.prevSrc == null){ s.prevSrc = src; return null; }
    const pc = src - s.prevSrc; s.prevSrc = src;
    const absPc = Math.abs(pc);
    const e1pc = taEmaAdvance(s, 'e1pc', longLen, pc), e1abs = taEmaAdvance(s, 'e1abs', longLen, absPc);
    if(e1pc == null || e1abs == null) return null;
    const e2pc = taEmaAdvance(s, 'e2pc', shortLen, e1pc), e2abs = taEmaAdvance(s, 'e2abs', shortLen, e1abs);
    if(e2pc == null || e2abs == null) return null;
    return e2abs === 0 ? 0 : e2pc / e2abs;
  },
  'ta.sar': (it, p, n, node) => {
    const start = pineNum(getArg(p, n, 0, 'start'));
    const inc = pineNum(getArg(p, n, 1, 'increment'));
    const maxAf = pineNum(getArg(p, n, 2, 'maximum'));
    const s = getState(it, node); const i = it.curBar;
    const high = it.highArr[i], low = it.lowArr[i], close = it.closeArr[i];
    if(s.callIdx == null) s.callIdx = -1;
    s.callIdx++;
    if(s.callIdx === 0) return null;
    const prevHigh = it.highArr[i - 1], prevLow = it.lowArr[i - 1], prevClose = it.closeArr[i - 1];
    const prevHigh2 = i >= 2 ? it.highArr[i - 2] : null, prevLow2 = i >= 2 ? it.lowArr[i - 2] : null;
    let isFirstTrendBar = false;
    if(s.callIdx === 1){
      if(close > prevClose){ s.isBelow = true; s.ep = high; s.result = prevLow; }
      else { s.isBelow = false; s.ep = low; s.result = prevHigh; }
      s.af = start; isFirstTrendBar = true;
    } else {
      s.result = s.result + s.af * (s.ep - s.result);
      if(s.isBelow){
        if(s.result > low){ isFirstTrendBar = true; s.isBelow = false; s.result = Math.max(high, s.ep); s.ep = low; s.af = start; }
      } else {
        if(s.result < high){ isFirstTrendBar = true; s.isBelow = true; s.result = Math.min(low, s.ep); s.ep = high; s.af = start; }
      }
      if(!isFirstTrendBar){
        if(s.isBelow){ if(high > s.ep){ s.ep = high; s.af = Math.min(s.af + inc, maxAf); } }
        else { if(low < s.ep){ s.ep = low; s.af = Math.min(s.af + inc, maxAf); } }
      }
    }
    if(s.isBelow){
      s.result = Math.min(s.result, prevLow);
      if(prevLow2 != null) s.result = Math.min(s.result, prevLow2);
    } else {
      s.result = Math.max(s.result, prevHigh);
      if(prevHigh2 != null) s.result = Math.max(s.result, prevHigh2);
    }
    return s.result;
  },
  'ta.supertrend': (it, p, n, node) => {
    const factor = pineNum(getArg(p, n, 0, 'factor'));
    const atrPeriod = Math.round(pineNum(getArg(p, n, 1, 'atrPeriod')));
    const s = getState(it, node); const i = it.curBar;
    const high = it.highArr[i], low = it.lowArr[i], close = it.closeArr[i];
    const hl2 = (high + low) / 2;
    const prevClose = i > 0 ? it.closeArr[i - 1] : null;
    const tr = prevClose == null ? (high - low) : Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    const atr = taRmaAdvance(s, 'atr', atrPeriod, i, tr);
    if(atr == null) return [null, null];
    let upperBand = hl2 + factor * atr, lowerBand = hl2 - factor * atr;
    if(s.prevLowerBand != null && !(lowerBand > s.prevLowerBand || prevClose < s.prevLowerBand)) lowerBand = s.prevLowerBand;
    if(s.prevUpperBand != null && !(upperBand < s.prevUpperBand || prevClose > s.prevUpperBand)) upperBand = s.prevUpperBand;
    let direction;
    if(s.prevSuperTrend == null) direction = 1;
    else if(s.prevSuperTrend === s.prevUpperBand) direction = close > upperBand ? -1 : 1;
    else direction = close < lowerBand ? 1 : -1;
    const superTrend = direction === -1 ? lowerBand : upperBand;
    s.prevLowerBand = lowerBand; s.prevUpperBand = upperBand; s.prevSuperTrend = superTrend;
    return [superTrend, direction];
  },
  'ta.obv': (it, p, n, node) => {
    const s = getState(it, node); const i = it.curBar;
    if(s.val == null) s.val = 0;
    if(i > 0){ const c0 = it.closeArr[i], c1 = it.closeArr[i - 1]; if(c0 > c1) s.val += it.volArr[i]; else if(c0 < c1) s.val -= it.volArr[i]; }
    return s.val;
  },
  'ta.wad': (it, p, n, node) => {
    const s = getState(it, node); const i = it.curBar;
    if(s.val == null) s.val = 0;
    const close = it.closeArr[i], high = it.highArr[i], low = it.lowArr[i];
    if(i > 0){
      const prevClose = it.closeArr[i - 1];
      const trueHigh = Math.max(high, prevClose), trueLow = Math.min(low, prevClose);
      const mom = close - prevClose;
      if(mom > 0) s.val += close - trueLow; else if(mom < 0) s.val += close - trueHigh;
    }
    return s.val;
  },
  'ta.wvad': (it) => {
    const i = it.curBar; const range = it.highArr[i] - it.lowArr[i];
    return range === 0 ? 0 : ((it.closeArr[i] - it.openArr[i]) / range) * it.volArr[i];
  },
  'ta.pvi': (it, p, n, node) => {
    const s = getState(it, node); const i = it.curBar;
    if(s.val == null) s.val = 1.0;
    if(i > 0){
      const c0 = it.closeArr[i], c1 = it.closeArr[i - 1], v0 = it.volArr[i], v1 = it.volArr[i - 1];
      if(c0 !== 0 && c1 !== 0 && v0 > v1) s.val += ((c0 - c1) / c1) * s.val;
    }
    return s.val;
  },
  'ta.nvi': (it, p, n, node) => {
    const s = getState(it, node); const i = it.curBar;
    if(s.val == null) s.val = 1.0;
    if(i > 0){
      const c0 = it.closeArr[i], c1 = it.closeArr[i - 1], v0 = it.volArr[i], v1 = it.volArr[i - 1];
      if(c0 !== 0 && c1 !== 0 && v0 < v1) s.val += ((c0 - c1) / c1) * s.val;
    }
    return s.val;
  },
  'ta.pvt': (it, p, n, node) => {
    const s = getState(it, node); const i = it.curBar;
    if(s.val == null) s.val = 0;
    if(i > 0){ const c0 = it.closeArr[i], c1 = it.closeArr[i - 1]; if(c1 !== 0) s.val += ((c0 - c1) / c1) * it.volArr[i]; }
    return s.val;
  },
  'ta.iii': (it) => {
    const i = it.curBar; const range = it.highArr[i] - it.lowArr[i]; const denom = range * it.volArr[i];
    return denom === 0 ? 0 : (2 * it.closeArr[i] - it.highArr[i] - it.lowArr[i]) / denom;
  },
  'ta.accdist': (it, p, n, node) => {
    const s = getState(it, node); const i = it.curBar;
    if(s.val == null) s.val = 0;
    const range = it.highArr[i] - it.lowArr[i];
    if(range !== 0) s.val += ((it.closeArr[i] - it.lowArr[i]) - (it.highArr[i] - it.closeArr[i])) / range * it.volArr[i];
    return s.val;
  },
};

// "HHMM-HHMM" 또는 "HHMM-HHMM:1234567"(요일 필터, 1=일요일..7=토요일) 세션 문자열 파싱.
function pineParseSessionStr(s){
  if(!s || typeof s !== 'string') return null;
  const parts = s.split(':');
  const m = /^\s*(\d{2})(\d{2})\s*-\s*(\d{2})(\d{2})\s*$/.exec(parts[0]);
  if(!m) return null;
  const startMin = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  const endMin = parseInt(m[3], 10) * 60 + parseInt(m[4], 10);
  const days = (parts[1] || '1234567').split('').map(d => parseInt(d, 10)).filter(d => d >= 1 && d <= 7);
  return { startMin, endMin, days };
}
// 주어진 UTC 유닉스초(seconds)를 특정 타임존의 현지 시각으로 변환. 'GMT+N'/'GMT-N' 형태(고정
// 오프셋, 이 스크립트의 타임존 드롭다운에 있는 옵션들)는 직접 계산하고, 'America/New_York' 같은
// 진짜 IANA 타임존은 Intl.DateTimeFormat에 맡긴다(DST 전환 등은 ICU가 알아서 처리).
function pineLocalTimeParts(unixSeconds, tz){
  const d = new Date(unixSeconds * 1000);
  const mGmt = tz ? /^GMT([+-]\d+)$/.exec(tz) : null;
  if(mGmt){
    const d2 = new Date((unixSeconds + parseInt(mGmt[1], 10) * 3600) * 1000);
    return { hour: d2.getUTCHours(), minute: d2.getUTCMinutes(), weekday: d2.getUTCDay() + 1 };
  }
  if(!tz) return { hour: d.getUTCHours(), minute: d.getUTCMinutes(), weekday: d.getUTCDay() + 1 };
  try{
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit', weekday: 'short' });
    const parts = fmt.formatToParts(d);
    const get = t => (parts.find(p => p.type === t) || {}).value;
    const weekdayMap = { Sun: 1, Mon: 2, Tue: 3, Wed: 4, Thu: 5, Fri: 6, Sat: 7 };
    return { hour: parseInt(get('hour'), 10) % 24, minute: parseInt(get('minute'), 10), weekday: weekdayMap[get('weekday')] || (d.getUTCDay() + 1) };
  }catch(e){
    return { hour: d.getUTCHours(), minute: d.getUTCMinutes(), weekday: d.getUTCDay() + 1 };
  }
}
// pineLocalTimeParts와 같은 방식으로 타임존을 반영하되, str.format_time()에 필요한 연/월/일/초까지 뽑아온다.
function pineLocalDateParts(unixSeconds, tz){
  const d = new Date(unixSeconds * 1000);
  const mGmt = tz ? /^GMT([+-]\d+)$/.exec(tz) : null;
  if(mGmt){
    const d2 = new Date((unixSeconds + parseInt(mGmt[1], 10) * 3600) * 1000);
    return { year: d2.getUTCFullYear(), month: d2.getUTCMonth() + 1, day: d2.getUTCDate(), hour: d2.getUTCHours(), minute: d2.getUTCMinutes(), second: d2.getUTCSeconds(), weekday: d2.getUTCDay() + 1 };
  }
  if(!tz) return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(), weekday: d.getUTCDay() + 1 };
  try{
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
    const parts = fmt.formatToParts(d);
    const get = t => (parts.find(p => p.type === t) || {}).value;
    const weekdayMap = { Sun: 1, Mon: 2, Tue: 3, Wed: 4, Thu: 5, Fri: 6, Sat: 7 };
    return {
      year: parseInt(get('year'), 10), month: parseInt(get('month'), 10), day: parseInt(get('day'), 10),
      hour: parseInt(get('hour'), 10) % 24, minute: parseInt(get('minute'), 10), second: parseInt(get('second'), 10),
      weekday: weekdayMap[get('weekday')] || (d.getUTCDay() + 1),
    };
  }catch(e){
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(), weekday: d.getUTCDay() + 1 };
  }
}
// str.format_time()의 서식 문자열: Java SimpleDateFormat과 같은 토큰 일부(yyyy/yy, MM/M, dd/d, HH/H,
// mm/m, ss/s)만 지원한다 — 킬존류 스크립트들이 실제로 쓰는 건 대부분 이 정도뿐이다. 작은따옴표로
// 감싼 부분은 리터럴 텍스트로 그대로 출력한다("'T'"처럼).
function pineFormatTime(unixSeconds, fmt, tz){
  if(unixSeconds == null) return null;
  const p = pineLocalDateParts(unixSeconds, tz);
  const pad = (n, len) => String(n).padStart(len || 2, '0');
  const f = (fmt == null || fmt === '') ? "yyyy-MM-dd'T'HH:mm:ss" : String(fmt);
  const tokens = [
    ['yyyy', () => pad(p.year, 4)], ['yy', () => pad(p.year % 100)],
    ['MM', () => pad(p.month)], ['M', () => String(p.month)],
    ['dd', () => pad(p.day)], ['d', () => String(p.day)],
    ['HH', () => pad(p.hour)], ['H', () => String(p.hour)],
    ['mm', () => pad(p.minute)], ['m', () => String(p.minute)],
    ['ss', () => pad(p.second)], ['s', () => String(p.second)],
  ];
  let out = '';
  for(let i = 0; i < f.length; i++){
    if(f[i] === "'"){
      let j = i + 1;
      while(j < f.length && f[j] !== "'") j++;
      out += f.slice(i + 1, j);
      i = j;
      continue;
    }
    const rest = f.slice(i);
    let matched = false;
    for(const [tok, fn] of tokens){
      if(rest.startsWith(tok)){ out += fn(); i += tok.length - 1; matched = true; break; }
    }
    if(!matched) out += f[i];
  }
  return out;
}
function pineTfSeconds(tf){
  const s = String(tf || '').toUpperCase().trim();
  const m = s.match(/^(\d*)([SDWM]?)$/);
  if(!m) return 86400;
  const mult = m[1] ? parseInt(m[1], 10) : 1;
  const unit = m[2];
  if(unit === 'S') return mult;
  if(unit === 'D') return mult * 86400;
  if(unit === 'W') return mult * 604800;
  if(unit === 'M') return mult * 2592000; // 대략적인 근사치(30일)
  return mult * 60; // 접미사 없는 숫자만이면 분 단위
}
function pineTfBucket(timeSec, tf){
  const s = String(tf || '').toUpperCase().trim();
  const m = s.match(/^(\d*)([SDWM]?)$/);
  const mult = (m && m[1]) ? parseInt(m[1], 10) : 1;
  const unit = m ? m[2] : '';
  if(unit === 'M'){
    const d = new Date(timeSec * 1000);
    const idx = d.getUTCFullYear() * 12 + d.getUTCMonth();
    return Math.floor(idx / mult);
  }
  if(unit === 'W'){
    const dayIdx = Math.floor(timeSec / 86400);
    const weekIdx = Math.floor((dayIdx + 4) / 7); // 1970-01-01(목요일) 기준 월요일 경계로 보정한 근사치
    return Math.floor(weekIdx / mult);
  }
  const secs = pineTfSeconds(tf);
  return Math.floor(timeSec / secs);
}
const TIMEFRAME_NS = {
  'timeframe.change': (it, p, n, node) => {
    const tf = getArg(p, n, 0, 'timeframe', '');
    const s = getState(it, node);
    const cur = pineTfBucket(it.timeArr[it.curBar], tf);
    const changed = s.prevBucket != null && cur !== s.prevBucket;
    s.prevBucket = cur;
    return it.curBar === 0 ? false : changed;
  },
  'timeframe.in_seconds': (it, p, n) => pineTfSeconds(getArg(p, n, 0, 'timeframe', '')),
};

// ============================================================
// 그리기 객체 (line.new / box.new / label.new) — plot()과 달리 "특정 시간~시간, 가격~가격
// 사이에 도형을 그려라" 방식이라 차트 라이브러리가 기본 지원을 안 한다. 좌표(x1,y1,x2,y2 등)만
// 여기서 계산해서 결과에 담아 돌려주고, 실제 캔버스에 그리는 건 pine-import.js가 한다.
// ============================================================
function pineResolveTime(it, raw){
  if(raw == null) return it.timeArr[it.curBar];
  if(typeof raw === 'object') return pineResolveTime(it, raw.time != null ? raw.time : raw.index);
  if(raw > 1e8) return raw; // 이미 실제 유닉스 타임스탬프(초)로 보이면 그대로 사용
  const idx = Math.round(raw);
  const step = it.n >= 2 ? (it.timeArr[it.n - 1] - it.timeArr[it.n - 2]) : 60;
  if(idx >= 0 && idx < it.n) return it.timeArr[idx];
  if(idx < 0) return it.timeArr[0] + idx * step;
  return it.timeArr[it.n - 1] + (idx - (it.n - 1)) * step;
}
function pineCapPush(arr, obj, cap){ arr.push(obj); while(arr.length > cap) arr.shift(); }
function pineLineStyleFromConst(v){
  if(typeof v !== 'string') return 'solid';
  if(v.includes('dashed')) return 'dashed';
  if(v.includes('dotted')) return 'dotted';
  return 'solid';
}
function pineExtendFromConst(v){
  if(typeof v !== 'string') return 'none';
  if(v.includes('both')) return 'both';
  if(v.includes('right')) return 'right';
  if(v.includes('left')) return 'left';
  return 'none';
}
function pineLabelStyleFromConst(v){
  if(typeof v !== 'string') return 'label_down';
  if(v.includes('up')) return 'label_up';
  return 'label_down';
}
function pinePointOf(p, idx){ return p[idx] && typeof p[idx] === 'object' ? p[idx] : null; }

const DRAWING_NS = {
  'chart.point.new': (it, p, n) => ({ time: getArg(p, n, 0, 'time', null), index: getArg(p, n, 1, 'index', null), price: getArg(p, n, 2, 'price', null) }),
  // table.new(position, columns, rows, bgcolor, border_color, border_width, frame_color, frame_width, force_overlay)
  // 실제 렌더링(HTML 오버레이 div)은 pine-import.js의 renderPineTables()가 이 객체(cells 포함)를 읽어서 한다.
  'table.new': (it, p, n, node) => {
    const obj = new PineTable({
      position: getArg(p, n, 0, 'position', 'top_right'),
      columns: getArg(p, n, 1, 'columns', 1),
      rows: getArg(p, n, 2, 'rows', 1),
      bgcolor: getArg(p, n, 3, 'bgcolor', null),
      bordercolor: getArg(p, n, 4, 'border_color', null),
      framecolor: getArg(p, n, 6, 'frame_color', null),
    });
    // line/box/label과 달리 표는 "쌓이는 것"이 아니라 화면 모서리에 붙는 고정 UI다. var 없이
    // table.new()를 매 bar 다시 부르는 스크립트가 흔한데(500봉이면 500개), 그걸 전부 들고 있으면
    // 똑같은 표가 같은 자리에 겹쳐 그려진다. 같은 호출 지점(call site)의 것은 최신 것으로 교체해서
    // "코드에 적힌 table.new 개수 = 표 개수"가 되게 한다.
    obj._key = it.pathKey(node);
    const idx = it.tables.findIndex(t => t._key === obj._key);
    if(idx > -1) it.tables[idx] = obj; else it.tables.push(obj);
    return obj;
  },
  // 실제 Pine의 line.new 위치 인자 순서: x1,y1,x2,y2,xloc,extend,color,style,width.
  // xloc(4번)은 우리 좌표 처리 방식상 안 써도 되지만(값이 크면 타임스탬프, 작으면 bar_index로
  // 자동 판별), 그 뒤(5~8번)에 오는 extend/color/style/width를 named 없이 그냥 위치로만 주는
  // 스크립트가 흔해서(LuxAlgo류) 이것도 읽어야 스타일이 올바르게 반영된다.
  'line.new': (it, p, n, node) => {
    let x1, y1, x2, y2;
    const pt0 = pinePointOf(p, 0) || (n.first_point !== undefined ? n.first_point : null);
    const pt1 = pinePointOf(p, 1) || (n.second_point !== undefined ? n.second_point : null);
    if(pt0){ x1 = pineResolveTime(it, pt0); y1 = pt0.price; x2 = pineResolveTime(it, pt1); y2 = pt1 ? pt1.price : y1; }
    else {
      x1 = pineResolveTime(it, getArg(p, n, 0, 'x1'));
      y1 = getArg(p, n, 1, 'y1');
      x2 = pineResolveTime(it, getArg(p, n, 2, 'x2'));
      y2 = getArg(p, n, 3, 'y2');
    }
    const extendArg = n.extend !== undefined ? n.extend : (p.length > 5 ? p[5] : undefined);
    const colorArg = n.color !== undefined ? n.color : (p.length > 6 ? p[6] : undefined);
    const styleArg = n.style !== undefined ? n.style : (p.length > 7 ? p[7] : undefined);
    const widthArg = n.width != null ? n.width : (p.length > 8 ? p[8] : undefined);
    const obj = new PineLine({
      x1, y1, x2, y2,
      color: colorArg !== undefined ? colorArg : '#787b86',
      width: widthArg != null ? widthArg : 1,
      style: pineLineStyleFromConst(styleArg),
      extend: pineExtendFromConst(extendArg),
    });
    pineCapPush(it.lines, obj, it.maxLines);
    return obj;
  },
  // 실제 Pine의 box.new 위치 인자 순서: left,top,right,bottom,border_color,border_width,
  // border_style,extend,bgcolor,text,text_size,text_color,... — line.new과 같은 이유로
  // border_color/extend/bgcolor/text/text_color를 named 없이 위치로만 주는 경우도 지원한다.
  'box.new': (it, p, n, node) => {
    let x1, y1, x2, y2, posBase;
    const pt0 = pinePointOf(p, 0) || (n.top_left !== undefined ? n.top_left : null);
    const pt1 = pinePointOf(p, 1) || (n.bottom_right !== undefined ? n.bottom_right : null);
    // point 두 개짜리 형태(top_left, bottom_right)는 좌표에 자리 2개만 쓰고, 좌표 4개짜리
    // 옛 형태(left,top,right,bottom)는 4개를 쓴다 — border_color 이후 인자들의 위치 인덱스가
    // 그만큼(4 vs 2) 밀리므로, 어느 형태인지에 따라 기준 위치(posBase)를 다르게 잡는다.
    if(pt0){ x1 = pineResolveTime(it, pt0); y1 = pt0.price; x2 = pineResolveTime(it, pt1); y2 = pt1 ? pt1.price : y1; posBase = 2; }
    else {
      x1 = pineResolveTime(it, getArg(p, n, 0, 'left'));
      y1 = getArg(p, n, 1, 'top');
      x2 = pineResolveTime(it, getArg(p, n, 2, 'right'));
      y2 = getArg(p, n, 3, 'bottom');
      posBase = 4;
    }
    const borderColorArg = n.border_color !== undefined ? n.border_color : (p.length > posBase ? p[posBase] : undefined);
    const extendArg = n.extend !== undefined ? n.extend : (p.length > posBase + 3 ? p[posBase + 3] : undefined);
    const bgcolorArg = n.bgcolor !== undefined ? n.bgcolor : (p.length > posBase + 4 ? p[posBase + 4] : undefined);
    const textArg = n.text !== undefined ? n.text : (p.length > posBase + 5 ? p[posBase + 5] : undefined);
    const textColorArg = n.text_color !== undefined ? n.text_color : (p.length > posBase + 7 ? p[posBase + 7] : undefined);
    const obj = new PineBox({
      x1, y1, x2, y2,
      bgcolor: bgcolorArg !== undefined ? bgcolorArg : 'rgba(120,123,134,0.2)',
      bordercolor: borderColorArg !== undefined ? borderColorArg : '#787b86',
      text: textArg !== undefined ? textArg : '',
      textcolor: textColorArg !== undefined ? textColorArg : '#ffffff',
      extend: pineExtendFromConst(extendArg),
    });
    pineCapPush(it.boxes, obj, it.maxBoxes);
    return obj;
  },
  'label.new': (it, p, n, node) => {
    let x, y, textPos;
    const pt0 = pinePointOf(p, 0) || (n.point !== undefined ? n.point : null);
    // label.new(point, text, xloc, ...) 처럼 좌표를 chart.point 객체 하나로 줄 때는 text가
    // 1번 자리, label.new(x, y, text, ...) 처럼 좌표를 따로 둘 줄 때는 text가 2번 자리다 —
    // 점 형태를 썼는지에 따라 text를 찾을 위치가 다르다.
    if(pt0){ x = pineResolveTime(it, pt0); y = pt0.price; textPos = 1; }
    else { x = pineResolveTime(it, getArg(p, n, 0, 'x')); y = getArg(p, n, 1, 'y'); textPos = 2; }
    const text = n.text !== undefined ? n.text : (typeof p[textPos] === 'string' ? p[textPos] : '');
    const obj = new PineLabel({
      x, y, text,
      color: n.color !== undefined ? n.color : 'rgba(30,34,42,0.9)',
      textcolor: n.textcolor !== undefined ? n.textcolor : '#ffffff',
      style: pineLabelStyleFromConst(n.style),
      size: n.size !== undefined ? n.size : 'normal',
      tooltip: n.tooltip !== undefined ? n.tooltip : '',
    });
    pineCapPush(it.labels, obj, it.maxLabels);
    return obj;
  },
};

// table.* — line/box/label과 같은 방식으로 "정적 호출(table.cell(t, ...))"과 "메서드 호출(t.cell(...))"
// 양쪽에서 재사용된다. 셀 좌표는 "col,row" 문자열 키를 쓴다.
function pineTableCell(tbl, col, row){
  const key = Math.round(pineNum(col)) + ',' + Math.round(pineNum(row));
  let cell = tbl.cells.get(key);
  if(!cell){
    // cell_set_* 계열은 실제 Pine에서 이미 존재하는 셀을 고치는 함수지만, table.cell()로 만들기
    // 전에 부르는 스크립트도 있어서 없으면 빈 셀을 만들어 둔다(조용히 무시되는 것보다 낫다).
    cell = { text: '', textColor: '#d1d4dc', textSize: 'size.normal', bgcolor: null, tooltip: '', halign: 'center', valign: 'middle' };
    tbl.cells.set(key, cell);
  }
  return cell;
}
const TABLE_METHODS = {
  // table.cell(table_id, column, row, text, width, height, text_color, text_halign, text_valign, text_size, bgcolor, tooltip, text_font_family)
  cell: (it, tbl, p, n) => {
    const cell = pineTableCell(tbl, getArg(p, n, 0, 'column', 0), getArg(p, n, 1, 'row', 0));
    cell.text = getArg(p, n, 2, 'text', '');
    cell.halign = getArg(p, n, 6, 'text_halign', 'center');
    cell.valign = getArg(p, n, 7, 'text_valign', 'middle');
    cell.textColor = getArg(p, n, 5, 'text_color', '#d1d4dc');
    cell.textSize = getArg(p, n, 8, 'text_size', 'size.normal');
    cell.bgcolor = getArg(p, n, 9, 'bgcolor', null);
    cell.tooltip = getArg(p, n, 10, 'tooltip', '');
    return null;
  },
  cell_set_text: (it, tbl, p, n) => { pineTableCell(tbl, p[0], p[1]).text = getArg(p, n, 2, 'text', ''); return null; },
  cell_set_text_color: (it, tbl, p, n) => { pineTableCell(tbl, p[0], p[1]).textColor = getArg(p, n, 2, 'text_color', '#d1d4dc'); return null; },
  cell_set_bgcolor: (it, tbl, p, n) => { pineTableCell(tbl, p[0], p[1]).bgcolor = getArg(p, n, 2, 'bgcolor', null); return null; },
  cell_set_text_size: (it, tbl, p, n) => { pineTableCell(tbl, p[0], p[1]).textSize = getArg(p, n, 2, 'text_size', 'size.normal'); return null; },
  cell_set_text_halign: (it, tbl, p, n) => { pineTableCell(tbl, p[0], p[1]).halign = getArg(p, n, 2, 'text_halign', 'center'); return null; },
  cell_set_text_valign: (it, tbl, p, n) => { pineTableCell(tbl, p[0], p[1]).valign = getArg(p, n, 2, 'text_valign', 'middle'); return null; },
  cell_set_tooltip: (it, tbl, p, n) => { pineTableCell(tbl, p[0], p[1]).tooltip = getArg(p, n, 2, 'tooltip', ''); return null; },
  set_bgcolor: (it, tbl, p, n) => { tbl.bgcolor = getArg(p, n, 0, 'bgcolor', null); return null; },
  set_frame_color: (it, tbl, p, n) => { tbl.framecolor = getArg(p, n, 0, 'frame_color', null); return null; },
  set_border_color: (it, tbl, p, n) => { tbl.bordercolor = getArg(p, n, 0, 'border_color', null); return null; },
  set_position: (it, tbl, p, n) => { tbl.position = getArg(p, n, 0, 'position', 'top_right'); return null; },
  // 실제 Pine 이름은 start_column/start_row/end_column/end_row다. 예전 코드가 column/row/column_end/
  // row_end로 적어둬서 named 인자로 부르면(table.clear(t, start_column=0, ...)) 전부 기본값으로 떨어졌다.
  clear: (it, tbl, p, n) => {
    const fromCol = Math.round(pineNum(getArg(p, n, 0, 'start_column', 0)));
    const fromRow = Math.round(pineNum(getArg(p, n, 1, 'start_row', 0)));
    const toCol = Math.round(pineNum(getArg(p, n, 2, 'end_column', fromCol)));
    const toRow = Math.round(pineNum(getArg(p, n, 3, 'end_row', fromRow)));
    for(let c = fromCol; c <= toCol; c++) for(let r = fromRow; r <= toRow; r++) tbl.cells.delete(c + ',' + r);
    return null;
  },
  delete: (it, tbl) => { tbl.deleted = true; const i = it.tables.indexOf(tbl); if(i > -1) it.tables.splice(i, 1); return null; },
  // 셀 병합은 지원 범위 밖 — 없으면 "지원하지 않는 함수" 에러로 스크립트 전체가 죽으므로 무시하고 진행한다.
  merge_cells: () => null,
};

const LINE_METHODS = {
  set_first_point: (it, l, p) => { const pt = p[0]; if(pt){ l.x1 = pineResolveTime(it, pt); l.y1 = pt.price; } return null; },
  set_second_point: (it, l, p) => { const pt = p[0]; if(pt){ l.x2 = pineResolveTime(it, pt); l.y2 = pt.price; } return null; },
  set_xy1: (it, l, p) => { l.x1 = pineResolveTime(it, p[0]); l.y1 = p[1]; return null; },
  set_xy2: (it, l, p) => { l.x2 = pineResolveTime(it, p[0]); l.y2 = p[1]; return null; },
  set_x1: (it, l, p) => { l.x1 = pineResolveTime(it, p[0]); return null; },
  set_y1: (it, l, p) => { l.y1 = p[0]; return null; },
  set_x2: (it, l, p) => { l.x2 = pineResolveTime(it, p[0]); return null; },
  set_y2: (it, l, p) => { l.y2 = p[0]; return null; },
  set_color: (it, l, p) => { l.color = p[0]; return null; },
  set_width: (it, l, p) => { l.width = p[0]; return null; },
  set_style: (it, l, p) => { l.style = pineLineStyleFromConst(p[0]); return null; },
  set_extend: (it, l, p) => { l.extend = pineExtendFromConst(p[0]); return null; },
  get_x1: (it, l) => l.x1, get_y1: (it, l) => l.y1, get_x2: (it, l) => l.x2, get_y2: (it, l) => l.y2,
  delete: (it, l) => { l.deleted = true; const i = it.lines.indexOf(l); if(i > -1) it.lines.splice(i, 1); return null; },
  copy: (it, l) => { const c = new PineLine(Object.assign({}, l)); pineCapPush(it.lines, c, it.maxLines); return c; },
};
const BOX_METHODS = {
  set_top_left_point: (it, b, p) => { const pt = p[0]; if(pt){ b.x1 = pineResolveTime(it, pt); b.y1 = pt.price; } return null; },
  set_bottom_right_point: (it, b, p) => { const pt = p[0]; if(pt){ b.x2 = pineResolveTime(it, pt); b.y2 = pt.price; } return null; },
  set_lefttop: (it, b, p) => { b.x1 = pineResolveTime(it, p[0]); b.y1 = p[1]; return null; },
  set_rightbottom: (it, b, p) => { b.x2 = pineResolveTime(it, p[0]); b.y2 = p[1]; return null; },
  set_left: (it, b, p) => { b.x1 = pineResolveTime(it, p[0]); return null; },
  set_right: (it, b, p) => { b.x2 = pineResolveTime(it, p[0]); return null; },
  set_top: (it, b, p) => { b.y1 = p[0]; return null; },
  set_bottom: (it, b, p) => { b.y2 = p[0]; return null; },
  set_bgcolor: (it, b, p) => { b.bgcolor = p[0]; return null; },
  set_border_color: (it, b, p) => { b.bordercolor = p[0]; return null; },
  set_text: (it, b, p) => { b.text = p[0]; return null; },
  set_text_color: (it, b, p) => { b.textcolor = p[0]; return null; },
  set_extend: (it, b, p) => { b.extend = pineExtendFromConst(p[0]); return null; },
  // getter들이 통째로 빠져 있었다 — set_top/set_bottom 등 setter만 있고 box.get_top()/
  // box.get_bottom()/box.get_left()/box.get_right()가 없어서, 박스 목록을 순회하며 가격을
  // 읽어 삭제/연장 여부를 판단하는 스크립트(예: 이 Market Structure Break 지표)가
  // "Unsupported function: box.get_bottom()" 에러로 죽었다. box.new(left,top,right,bottom)
  // 순서 그대로 x1=left, y1=top, x2=right, y2=bottom이라 set_top/set_bottom과 동일하게 매핑.
  get_top: (it, b) => b.y1, get_bottom: (it, b) => b.y2, get_left: (it, b) => b.x1, get_right: (it, b) => b.x2,
  delete: (it, b) => { b.deleted = true; const i = it.boxes.indexOf(b); if(i > -1) it.boxes.splice(i, 1); return null; },
};
const LABEL_METHODS = {
  set_xy: (it, l, p) => { l.x = pineResolveTime(it, p[0]); l.y = p[1]; return null; },
  set_x: (it, l, p) => { l.x = pineResolveTime(it, p[0]); return null; },
  set_y: (it, l, p) => { l.y = p[0]; return null; },
  set_point: (it, l, p) => { const pt = p[0]; if(pt){ l.x = pineResolveTime(it, pt); l.y = pt.price; } return null; },
  set_text: (it, l, p) => { l.text = p[0]; return null; },
  set_color: (it, l, p) => { l.color = p[0]; return null; },
  set_textcolor: (it, l, p) => { l.textcolor = p[0]; return null; },
  set_style: (it, l, p) => { l.style = pineLabelStyleFromConst(p[0]); return null; },
  set_size: (it, l, p) => { l.size = p[0]; return null; },
  set_tooltip: (it, l, p) => { l.tooltip = p[0]; return null; },
  get_x: (it, l) => l.x, get_y: (it, l) => l.y,
  delete: (it, l) => { l.deleted = true; const i = it.labels.indexOf(l); if(i > -1) it.labels.splice(i, 1); return null; },
};

// ============================================================
// math.*
// ============================================================
const MATH_NS = {
  'math.abs': (it, p, n) => { const v = getArg(p, n, 0, 'number'); return v == null ? null : Math.abs(v); },
  'math.max': (it, p) => p.some(v => v == null) ? null : Math.max(...p),
  'math.min': (it, p) => p.some(v => v == null) ? null : Math.min(...p),
  'math.pow': (it, p, n) => Math.pow(getArg(p, n, 0, 'base'), getArg(p, n, 1, 'exponent')),
  'math.sqrt': (it, p, n) => { const v = getArg(p, n, 0, 'number'); return v == null ? null : Math.sqrt(v); },
  'math.log': (it, p, n) => { const v = getArg(p, n, 0, 'number'); return v == null ? null : Math.log(v); },
  'math.log10': (it, p, n) => { const v = getArg(p, n, 0, 'number'); return v == null ? null : Math.log10(v); },
  'math.exp': (it, p, n) => { const v = getArg(p, n, 0, 'number'); return v == null ? null : Math.exp(v); },
  'math.sign': (it, p, n) => { const v = getArg(p, n, 0, 'number'); return v == null ? null : Math.sign(v); },
  'math.round': (it, p, n) => {
    const v = getArg(p, n, 0, 'number'); const prec = Math.round(pineNum(getArg(p, n, 1, 'precision', 0)));
    if(v == null) return null; const f = Math.pow(10, prec); return Math.round(v * f) / f;
  },
  // 실제 거래소의 syminfo.mintick(틱 사이즈) 메타데이터가 이 앱엔 없다 — 대신 현재 봉 종가의
  // 자릿수를 기준으로 유효숫자 5자리 정도에 해당하는 근사 틱을 만들어 반올림한다(가격 표시용
  // 반올림이 목적이라 완벽한 틱 사이즈까진 필요 없음).
  'math.round_to_mintick': (it, p, n) => {
    const v = getArg(p, n, 0, 'number');
    if(v == null) return null;
    const ref = Math.abs(it.closeArr[it.curBar]) || Math.abs(v) || 1;
    const tick = Math.pow(10, Math.floor(Math.log10(ref)) - 4);
    return Math.round(v / tick) * tick;
  },
  'math.floor': (it, p, n) => { const v = getArg(p, n, 0, 'number'); return v == null ? null : Math.floor(v); },
  'math.ceil': (it, p, n) => { const v = getArg(p, n, 0, 'number'); return v == null ? null : Math.ceil(v); },
  'math.avg': (it, p) => p.length ? p.reduce((a, b) => a + b, 0) / p.length : null,
  'math.sum': (it, p) => p.reduce((a, b) => a + b, 0),
  'math.random': (it, p, n) => { const mn = getArg(p, n, 0, 'min', 0), mx = getArg(p, n, 1, 'max', 1); return mn + Math.random() * (mx - mn); },
  'math.todegrees': (it, p) => p[0] * 180 / Math.PI,
  'math.toradians': (it, p) => p[0] * Math.PI / 180,
  'math.sin': (it, p, n) => { const v = getArg(p, n, 0, 'angle'); return v == null ? null : Math.sin(v); },
  'math.cos': (it, p, n) => { const v = getArg(p, n, 0, 'angle'); return v == null ? null : Math.cos(v); },
  'math.tan': (it, p, n) => { const v = getArg(p, n, 0, 'angle'); return v == null ? null : Math.tan(v); },
  'math.asin': (it, p, n) => { const v = getArg(p, n, 0, 'angle'); return v == null ? null : Math.asin(v); },
  'math.acos': (it, p, n) => { const v = getArg(p, n, 0, 'angle'); return v == null ? null : Math.acos(v); },
  'math.atan': (it, p, n) => { const v = getArg(p, n, 0, 'angle'); return v == null ? null : Math.atan(v); },
};

// ============================================================
// color.* / str.*
// ============================================================
function hexToRgb(hex){
  if(typeof hex !== 'string' || hex[0] !== '#') return [120, 123, 134];
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}
// color.r()/g()/b()/t() 성분 추출용 — 우리 색은 "#rrggbb" 아니면 color.new/color.rgb가 만든
// "rgba(r,g,b,a)" 문자열 둘 중 하나라서, 둘 다 파싱해서 [r,g,b,transp(0~100)]로 통일해준다.
function pineColorComponents(c){
  if(typeof c !== 'string') return [120, 123, 134, 0];
  if(c[0] === '#'){ const [r, g, b] = hexToRgb(c); return [r, g, b, 0]; }
  const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if(m){
    const a = m[4] !== undefined ? parseFloat(m[4]) : 1;
    return [+m[1], +m[2], +m[3], Math.round((1 - a) * 100)];
  }
  return [120, 123, 134, 0];
}
// plot()/hline()/plotshape()/plotchar()의 transp= 인자(0~100, v3/v4 시절 color.new() 대신 쓰던
// 방식) — color.new()처럼 알파로 변환한다. transp가 없으면 색을 그대로 둔다.
function pineApplyTransp(color, transp){
  if(transp == null) return color;
  const [r, g, b] = pineColorComponents(color);
  const alpha = Math.max(0, Math.min(1, (100 - transp) / 100));
  return `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
}
const COLOR_NS = {
  'color.new': (it, p, n) => {
    const col = getArg(p, n, 0, 'color'); const transp = getArg(p, n, 1, 'transp', 0);
    const alpha = Math.max(0, Math.min(1, (100 - transp) / 100));
    const [r, g, b] = hexToRgb(col);
    return `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
  },
  'color.rgb': (it, p) => {
    const r = p[0] || 0, g = p[1] || 0, b = p[2] || 0;
    const a = p.length > 3 ? Math.max(0, Math.min(1, (100 - p[3]) / 100)) : 1;
    return `rgba(${r},${g},${b},${a})`;
  },
  'color.from_gradient': (it, p) => {
    const [value, minv, maxv, c1, c2] = p;
    const t = maxv === minv ? 0 : Math.max(0, Math.min(1, (value - minv) / (maxv - minv)));
    if(typeof c1 === 'string' && c1[0] === '#' && typeof c2 === 'string' && c2[0] === '#'){
      const [r1, g1, b1] = hexToRgb(c1), [r2, g2, b2] = hexToRgb(c2);
      return `rgb(${Math.round(r1 + (r2 - r1) * t)},${Math.round(g1 + (g2 - g1) * t)},${Math.round(b1 + (b2 - b1) * t)})`;
    }
    return c2;
  },
  'color.r': (it, p) => pineColorComponents(p[0])[0],
  'color.g': (it, p) => pineColorComponents(p[0])[1],
  'color.b': (it, p) => pineColorComponents(p[0])[2],
  'color.t': (it, p) => pineColorComponents(p[0])[3],
};
const STR_NS = {
  'str.tostring': (it, p) => pineFmt(p[0]),
  'str.length': (it, p) => String(p[0] == null ? '' : p[0]).length,
  'str.contains': (it, p) => String(p[0]).includes(String(p[1])),
  'str.tonumber': (it, p) => { const v = parseFloat(p[0]); return isNaN(v) ? null : v; },
  'str.upper': (it, p) => String(p[0]).toUpperCase(),
  'str.lower': (it, p) => String(p[0]).toLowerCase(),
  // {0},{1},... 자리표시자만 지원하는 단순화 버전(Java MessageFormat 같은 숫자/날짜 서식 지정자는 무시)
  'str.format': (it, p) => {
    const fmt = String(p[0] == null ? '' : p[0]);
    const args = p.slice(1);
    return fmt.replace(/\{(\d+)(?:[^}]*)?\}/g, (m, idx) => { const v = args[+idx]; return v === undefined ? m : pineFmt(v); });
  },
  'str.replace': (it, p) => String(p[0]).replace(String(p[1]), String(p[2] == null ? '' : p[2])),
  'str.replace_all': (it, p) => String(p[0]).split(String(p[1])).join(String(p[2] == null ? '' : p[2])),
  'str.split': (it, p) => new PineArray(String(p[0]).split(String(p[1] == null ? '' : p[1])), 'string'),
  'str.trim': (it, p) => String(p[0]).trim(),
  'str.startswith': (it, p) => String(p[0]).startsWith(String(p[1])),
  'str.endswith': (it, p) => String(p[0]).endsWith(String(p[1])),
  'str.repeat': (it, p) => String(p[0]).repeat(Math.max(0, Math.round(pineNum(p[1])))),
  'str.pos': (it, p) => { const idx = String(p[0]).indexOf(String(p[1])); return idx < 0 ? null : idx; },
  'str.substring': (it, p) => {
    const s = String(p[0] == null ? '' : p[0]);
    const from = Math.max(0, Math.round(pineNum(p[1] == null ? 0 : p[1])));
    const to = p[2] == null ? s.length : Math.round(pineNum(p[2]));
    return s.substring(from, to);
  },
  'str.format_time': (it, p) => pineFormatTime(p[0], p[1], p[2]),
};

// ============================================================
// 최상위(네임스페이스 없이 바로 쓰는) 함수들
// ============================================================
// v1~v3 Pine은 style=3 처럼 스타일도 그냥 숫자 상수로 썼다(지금의 plot.style_* 문자열 상수가
// 생기기 전). 예전 순서 그대로: 0=line, 1=stepline, 2=histogram, 3=cross, 4=area, 5=columns,
// 6=circles. 이 매핑이 없으면 문자열이 아닌 값은 전부 무조건 'line'으로 떨어져서, 예를 들어
// LazyBear WaveTrend의 `style=3`(점선처럼 보여야 할 cross)이 실선으로 그려지는 버그가 생긴다.
const PINE_NUMERIC_PLOT_STYLES = { 0: 'line', 1: 'line', 2: 'histogram', 3: 'cross', 4: 'area', 5: 'histogram', 6: 'cross' };
function pinePlotStyleFromConst(v){
  if(typeof v === 'number' && Number.isFinite(v)) return PINE_NUMERIC_PLOT_STYLES[Math.round(v)] || 'line';
  if(typeof v !== 'string') return 'line';
  if(v.includes('histogram') || v.includes('columns')) return 'histogram';
  if(v.includes('circles') || v.includes('cross')) return 'cross';
  if(v.includes('area')) return 'area';
  return 'line';
}
function pineShapeStyleFromConst(v){
  if(typeof v !== 'string') return 'circle';
  if(v.includes('triangleup')) return 'triangleup';
  if(v.includes('triangledown')) return 'triangledown';
  if(v.includes('xcross')) return 'xcross';
  if(v.includes('cross')) return 'cross';
  if(v.includes('arrowup')) return 'arrowup';
  if(v.includes('arrowdown')) return 'arrowdown';
  if(v.includes('labelup')) return 'labelup';
  if(v.includes('labeldown')) return 'labeldown';
  if(v.includes('square')) return 'square';
  if(v.includes('diamond')) return 'diamond';
  if(v.includes('flag')) return 'flag';
  return 'circle';
}
function pineLocationFromConst(v){
  if(typeof v !== 'string') return 'abovebar';
  if(v.includes('belowbar')) return 'belowbar';
  if(v.includes('absolute')) return 'absolute';
  if(v.includes('top')) return 'top';
  if(v.includes('bottom')) return 'bottom';
  return 'abovebar';
}
const TOP_LEVEL_BUILTINS = {
  // time(timeframe, session, timezone) — session/timezone 안이면 이 봉의 시각을, 아니면 na를 돌려준다.
  // (timeframe 인자는 "이 앱은 이미 봉 데이터 자체가 그 타임프레임"이라 사실상 무시 — ""(현재 차트
  // 타임프레임)와 동일하게 취급. 킬존/세션 관련 스크립트 전반의 핵심 함수라 여기 없으면 그런
  // 스크립트가 통째로 안 돌아간다.)
  time: (it, p, n) => {
    const sessStr = getArg(p, n, 1, 'session', null);
    const tz = getArg(p, n, 2, 'timezone', null);
    const t = it.timeArr[it.curBar];
    if(!sessStr) return t; // 세션 지정이 없으면 항상 "세션 안"
    const sess = pineParseSessionStr(sessStr);
    if(!sess) return null;
    const lp = pineLocalTimeParts(t, tz);
    if(sess.days.length < 7 && !sess.days.includes(lp.weekday)) return null;
    const minOfDay = lp.hour * 60 + lp.minute;
    const inSession = sess.startMin <= sess.endMin
      ? (minOfDay >= sess.startMin && minOfDay < sess.endMin)
      : (minOfDay >= sess.startMin || minOfDay < sess.endMin); // 자정을 넘어가는 세션(예: "2000-0000")
    return inSession ? t : null;
  },
  dayofweek: (it, p, n) => {
    const t = getArg(p, n, 0, 'time', it.timeArr[it.curBar]);
    const tz = getArg(p, n, 1, 'timezone', null);
    if(t == null) return null;
    return pineLocalTimeParts(t, tz).weekday;
  },
  plot: (it, p, n, node, colorBranchKey) => {
    const value = getArg(p, n, 0, 'series');
    const title = getArg(p, n, 1, 'title', 'Plot' + node.id);
    const color = pineApplyTransp(getArg(p, n, 2, 'color', '#2962ff'), n.transp);
    const linewidth = getArg(p, n, 3, 'linewidth', 1);
    const style = pinePlotStyleFromConst(getArg(p, n, 4, 'style'));
    const offset = Math.round(pineNum(n.offset != null ? n.offset : 0)) || 0;
    const key = it.pathKey(node);
    let rec = it.plots.get(key);
    if(!rec){ rec = { key, title, color, linewidth, offset, style, values: new Array(it.n), colors: new Array(it.n), branchKeys: new Array(it.n) }; it.plots.set(key, rec); }
    rec.title = title; rec.color = color; rec.linewidth = linewidth; rec.offset = offset; rec.style = style;
    rec.values[it.curBar] = (n.display === 'display.none') ? null : value;
    rec.colors[it.curBar] = color;
    rec.branchKeys[it.curBar] = colorBranchKey || color; // 분기 추적이 안 되는 단순 색상 표현식은 값 자체를 키로 사용
    return null;
  },
  hline: (it, p, n, node) => {
    const price = getArg(p, n, 0, 'price');
    const title = getArg(p, n, 1, 'title', 'H' + node.id);
    const color = pineApplyTransp(getArg(p, n, 2, 'color', '#787b86'), n.transp);
    const key = it.pathKey(node);
    let rec = it.hlines.get(key);
    if(!rec){ rec = { title, color, price }; it.hlines.set(key, rec); }
    rec.price = price; rec.color = color; rec.title = title;
    return null;
  },
  indicator: (it, p, n) => {
    if(it.curBar === 0){
      it.meta.title = getArg(p, n, 0, 'title', it.meta.title);
      it.meta.shorttitle = n.shorttitle || it.meta.title;
      it.meta.overlay = n.overlay === true || n.overlay === 'true';
      if(n.max_lines_count != null) it.maxLines = Math.max(1, Math.min(500, Math.round(n.max_lines_count)));
      if(n.max_boxes_count != null) it.maxBoxes = Math.max(1, Math.min(500, Math.round(n.max_boxes_count)));
      if(n.max_labels_count != null) it.maxLabels = Math.max(1, Math.min(500, Math.round(n.max_labels_count)));
    }
    return null;
  },
  study: (it, p, n) => TOP_LEVEL_BUILTINS.indicator(it, p, n),
  strategy: () => { throw new PineRuntimeError(pineMsg('strategy() 스크립트(전략/백테스트)는 지원하지 않습니다 — 지표(indicator)만 가져올 수 있습니다', 'strategy() scripts (strategy/backtest) are not supported — only indicator scripts can be imported'), 0); },
  library: () => { throw new PineRuntimeError(pineMsg('library 스크립트(외부 라이브러리)는 지원하지 않습니다', 'library scripts (external libraries) are not supported'), 0); },
  nz: (it, p, n) => { const v = getArg(p, n, 0, 'source'); const rep = getArg(p, n, 1, 'replacement', 0); return v == null ? rep : v; },
  iff: (it, p, n) => pineTruthy(getArg(p, n, 0, 'condition')) ? getArg(p, n, 1, 'then') : getArg(p, n, 2, 'else'),
  na: (it, p, n) => { const v = getArg(p, n, 0, 'value'); return v == null; },
  fixnan: (it, p, n, node) => { const v = getArg(p, n, 0, 'source'); const s = getState(it, node); if(v != null) s.last = v; return s.last == null ? null : s.last; },
  fill: () => null, bgcolor: () => null,
  // barcolor(color, offset, editable, show_last, title, display)
  // plot()처럼 새 시리즈를 얹는 게 아니라 "메인 캔들 시리즈의 각 봉 색"을 바꾸는 함수라서,
  // 여기서는 봉별 색 배열만 모아두고 실제 반영은 pine-import.js가 캔들 데이터에 직접 한다.
  // color가 na인 봉은 "기본 색 그대로 두라"는 뜻이므로 null로 남긴다(덮어쓰지 않음).
  barcolor: (it, p, n, node) => {
    const raw = getArg(p, n, 0, 'color');
    const color = (typeof raw === 'string' && raw) ? pineApplyTransp(raw, n.transp) : null;
    const offset = Math.round(pineNum(getArg(p, n, 1, 'offset', 0))) || 0;
    const key = it.pathKey(node);
    let rec = it.barcolors.get(key);
    if(!rec){ rec = { key, offset, values: new Array(it.n) }; it.barcolors.set(key, rec); }
    rec.offset = offset;
    rec.values[it.curBar] = color;
    return null;
  },
  // plotshape(series, title, style, location, color, offset, text, textcolor, editable, size, show_last, display, format, force_overlay)
  // 이 인자들은 named로도(예: style=shape.labelup) positional로도(예: 'Upper Break', shape.labelup, ...)
  // 올 수 있는데, style/location/color/text/textcolor/offset을 named 값(n.*)만 보고 읽었던 탓에
  // positional로 넘긴 스크립트에서는 전부 기본값(circle/abovebar/파랑, text 없음)으로 떨어져
  // "박스 없이 텍스트만" 같은 증상이 났다 — plot()처럼 getArg(p, n, idx, name)으로 통일한다.
  plotshape: (it, p, n, node) => {
    const value = getArg(p, n, 0, 'series');
    const title = getArg(p, n, 1, 'title', 'Shape' + node.id);
    const style = pineShapeStyleFromConst(getArg(p, n, 2, 'style'));
    const location = pineLocationFromConst(getArg(p, n, 3, 'location'));
    const color = pineApplyTransp(getArg(p, n, 4, 'color', '#2962ff'), n.transp);
    const offset = Math.round(pineNum(getArg(p, n, 5, 'offset', 0))) || 0;
    const text = getArg(p, n, 6, 'text', '');
    const textcolor = getArg(p, n, 7, 'textcolor', '#ffffff');
    const key = it.pathKey(node);
    let rec = it.shapes.get(key);
    if(!rec){ rec = { key, title, style, location, color, textcolor, text, offset, values: new Array(it.n) }; it.shapes.set(key, rec); }
    rec.title = title; rec.style = style; rec.location = location; rec.color = color; rec.textcolor = textcolor; rec.text = text; rec.offset = offset;
    rec.values[it.curBar] = (getArg(p, n, 11, 'display') === 'display.none') ? null : value;
    return null;
  },
  // plotchar(series, title, char, location, color, offset, text, textcolor, editable, size, show_last, display, force_overlay)
  plotchar: (it, p, n, node) => {
    const value = getArg(p, n, 0, 'series');
    const title = getArg(p, n, 1, 'title', 'Char' + node.id);
    const char = getArg(p, n, 2, 'char', '•');
    const location = pineLocationFromConst(getArg(p, n, 3, 'location'));
    const color = pineApplyTransp(getArg(p, n, 4, 'color', '#2962ff'), n.transp);
    const offset = Math.round(pineNum(getArg(p, n, 5, 'offset', 0))) || 0;
    const textcolor = getArg(p, n, 7, 'textcolor', '#ffffff');
    const key = it.pathKey(node);
    let rec = it.shapes.get(key);
    if(!rec){ rec = { key, title, style: 'char', char, location, color, textcolor, text: char, offset, values: new Array(it.n) }; it.shapes.set(key, rec); }
    rec.title = title; rec.char = char; rec.text = char; rec.location = location; rec.color = color; rec.textcolor = textcolor; rec.offset = offset;
    rec.values[it.curBar] = (getArg(p, n, 11, 'display') === 'display.none') ? null : value;
    return null;
  },
  // heikinashi(tickerid) — v1~v4의 맨 이름 형태(v5는 ticker.heikinashi). 심볼을 실제로 바꾸는 게
  // 아니라 "하이킨아시로 환산해서 달라"는 표시라, 마커 문자열만 돌려주고 해석은 request.security()가 한다.
  heikinashi: (it, p) => PINE_HA_TICKER_PREFIX + (p[0] == null ? '' : p[0]),
  plotcandle: () => null, plotbar: () => null, plotarrow: () => null,
  alertcondition: () => null, alert: () => null,
  input: inputFn('generic'),
  timestamp: (it, p) => { const [y, mo, d, h = 0, mi = 0, se = 0] = p; return Math.floor(Date.UTC(y, (mo || 1) - 1, d || 1, h, mi, se) / 1000); },
  int: (it, p) => Math.trunc(pineNum(p[0])),
  float: (it, p) => pineNum(p[0]),
  bool: (it, p) => pineTruthy(p[0]),
  string: (it, p) => pineFmt(p[0]),
  // color(na) — 값을 안 바꾸고 그냥 "이건 color 타입이다"라고 표시만 하는 타입 캐스트.
  // "color = color(na)" 처럼 na를 color 자리에 넣을 때 흔히 쓰인다.
  color: (it, p) => (p[0] === undefined ? null : p[0]),
};

const PINE_BUILTIN_NS = Object.assign({}, TA_NS, MATH_NS, COLOR_NS, STR_NS, TIMEFRAME_NS, DRAWING_NS);
// v3/v4 시절엔 ta./math. 네임스페이스가 없어서 sma()/stdev()/abs()/round() 등이 전부 맨 이름으로 쓰였다 —
// 이미 TOP_LEVEL_BUILTINS에 같은 이름이 없는 경우에만 자동으로 별칭을 만들어준다.
Object.keys(TA_NS).forEach(k => { const bare = k.slice(3); if(!TOP_LEVEL_BUILTINS[bare]) TOP_LEVEL_BUILTINS[bare] = TA_NS[k]; });
Object.keys(MATH_NS).forEach(k => { const bare = k.slice(5); if(!TOP_LEVEL_BUILTINS[bare]) TOP_LEVEL_BUILTINS[bare] = MATH_NS[k]; });
// 예전(v3/v4) Pine은 네임스페이스가 없어서 tostring() 처럼 맨 이름으로 썼다
Object.keys(STR_NS).forEach(k => { const bare = k.slice(4); if(!TOP_LEVEL_BUILTINS[bare]) TOP_LEVEL_BUILTINS[bare] = STR_NS[k]; });
// 실제 Pine에서 line.delete(na) 처럼 아직 na인 객체에 메서드를 호출해도 그냥 무시된다.
// (var line x = na 로 선언해두고 첫 봉부터 delete를 부르는 패턴이 매우 흔하다)
Object.keys(LINE_METHODS).forEach(m => { PINE_BUILTIN_NS['line.' + m] = (it, p, n, node) => (p[0] == null ? null : LINE_METHODS[m](it, p[0], p.slice(1), n, node)); });
Object.keys(BOX_METHODS).forEach(m => { PINE_BUILTIN_NS['box.' + m] = (it, p, n, node) => (p[0] == null ? null : BOX_METHODS[m](it, p[0], p.slice(1), n, node)); });
Object.keys(LABEL_METHODS).forEach(m => { PINE_BUILTIN_NS['label.' + m] = (it, p, n, node) => (p[0] == null ? null : LABEL_METHODS[m](it, p[0], p.slice(1), n, node)); });
// table.*도 같은 방식. 'new'는 TABLE_METHODS에 없으므로 위 DRAWING_NS의 table.new가 그대로 살아있다.
// 첫 인자를 named(table_id=)로 주는 경우도 있어서 p[0]이 비면 n.table_id를 본다.
Object.keys(TABLE_METHODS).forEach(m => {
  PINE_BUILTIN_NS['table.' + m] = (it, p, n, node) => {
    const tbl = p.length ? p[0] : (n.table_id !== undefined ? n.table_id : null);
    if(!(tbl instanceof PineTable)) return null; // na이거나 표가 아니면 실제 Pine처럼 조용히 무시
    return TABLE_METHODS[m](it, tbl, p.length ? p.slice(1) : [], n, node);
  };
});
PINE_BUILTIN_NS['runtime.error'] = () => null; // 데이터 품질 경고용 — 차트 계산에는 영향 없으므로 무시하고 진행
PINE_BUILTIN_NS['ticker.heikinashi'] = TOP_LEVEL_BUILTINS.heikinashi; // v5 네임스페이스 형태
// ticker.new/modify 등 나머지 ticker.*는 심볼을 실제로 바꾸는 기능이라 지원 범위 밖 — 원래 심볼을
// 그대로 쓰도록 첫 인자를 돌려준다(에러로 스크립트 전체가 죽는 것보다 낫다).
['new', 'modify', 'inherit', 'standard'].forEach(k => { PINE_BUILTIN_NS['ticker.' + k] = (it, p) => (p[0] == null ? '' : p[0]); });
['int', 'float', 'bool', 'string', 'source', 'timeframe', 'session', 'symbol', 'price', 'color'].forEach(k => { PINE_BUILTIN_NS['input.' + k] = inputFn(k); });
PINE_BUILTIN_NS['input.text_area'] = inputFn('string'); // 여러 줄 텍스트 입력 — 값 자체는 그냥 문자열이라 input.string과 동일하게 처리
['float', 'int', 'bool', 'string', 'color', 'line', 'label', 'box', 'table'].forEach(k => { PINE_BUILTIN_NS['array.new_' + k] = arrayNewFn(k); PINE_BUILTIN_NS['array.new<' + k + '>'] = arrayNewFn(k); });
PINE_BUILTIN_NS['array.new'] = arrayNewFn('float');
PINE_BUILTIN_NS['array.from'] = (it, p) => new PineArray(p.slice(), 'float');
Object.keys(ARRAY_METHOD_BUILTINS).forEach(m => { PINE_BUILTIN_NS['array.' + m] = wrapArrayFn(m); });

// ============================================================
// request.security_lower_tf() 프리페치
// ============================================================
// AST 어디에 있든(중첩 함수/조건문/루프 안이라도) 모든 Call 노드를 찾는다. 노드 필드 이름을
// 일일이 알 필요 없이 line/id를 뺀 모든 객체·배열 프로퍼티를 재귀적으로 훑는 범용 워커라서,
// 파서에 새 문법이 추가돼도 그대로 동작한다.
function pineCollectCallNodes(node, out){
  if(node == null || typeof node !== 'object') return;
  if(Array.isArray(node)){ for(const item of node) pineCollectCallNodes(item, out); return; }
  if(node.type === 'Call') out.push(node);
  for(const key in node){
    if(key === 'line' || key === 'id') continue;
    const v = node[key];
    if(v && typeof v === 'object') pineCollectCallNodes(v, out);
  }
}
// 스크립트를 실행하기 전에, request.security_lower_tf(...)가 쓰는 timeframe(리터럴 문자열인
// 것만 — 동적으로 계산되는 timeframe은 지원 범위 밖이라 실행 시점에 빈 배열로 처리됨)을 전부
// 모아서 1분봉을 딱 한 번만 받아오고, 필요한 timeframe별로 합쳐서 Map으로 돌려준다.
// (인터프리터 본체(run())는 완전히 동기라서, 네트워크가 필요한 이 부분만 미리 비동기로 끝내둔다.)
async function pinePrefetchLowerTf(ast, bars){
  const cache = new Map();
  if(!bars || !bars.length) return cache;
  const calls = [];
  pineCollectCallNodes(ast, calls);
  const timeframes = new Set();
  for(const node of calls){
    const callee = node.callee;
    if(!callee || callee.type !== 'Member' || callee.prop !== 'security_lower_tf') continue;
    if(!callee.obj || callee.obj.type !== 'Ident' || callee.obj.name !== 'request') continue;
    let tfNode = null, posIdx = 0;
    for(const a of node.args){
      if(a.named){ if(a.name === 'timeframe') tfNode = a.value; }
      else { if(posIdx === 1) tfNode = a.value; posIdx++; }
    }
    if(tfNode && tfNode.type === 'String' && tfNode.value) timeframes.add(tfNode.value);
  }
  if(!timeframes.size) return cache;
  const coin = (typeof state !== 'undefined' && state.coin) ? state.coin : null;
  if(!coin) return cache;
  const fromSec = bars[0].time;
  const lastBar = bars[bars.length - 1];
  const mainBarStep = bars.length >= 2 ? (lastBar.time - bars[bars.length - 2].time) : 60;
  const toSec = lastBar.time + mainBarStep;
  let raw1m = [];
  try{ raw1m = await fetchLowerTf1mRange(coin, fromSec, toSec, 20000); }
  catch(e){ console.warn('[Pine] lower-tf 데이터 로드 실패:', e); }
  for(const tf of timeframes){
    const secs = pineTfSeconds(tf);
    cache.set(tf, secs <= 60 ? raw1m : buildAggCandles(raw1m, secs * 1000));
  }
  return cache;
}

// ============================================================
// 진입점
// ============================================================
async function runPineScript(source, bars, inputOverrides){
  let ast;
  try{ ast = pineParse(source); }
  catch(e){ throw { pineError: true, line: e.line || null, message: e.message || String(e) }; }
  const lowerTfCache = await pinePrefetchLowerTf(ast, bars);
  const interp = new PineInterpreter(ast);
  interp.lowerTfCache = lowerTfCache;
  try{ return interp.run(bars, inputOverrides || {}); }
  catch(e){
    if(e && e.pineRuntime) throw { pineError: true, line: e.line || null, message: e.message };
    throw { pineError: true, line: null, message: '내부 오류: ' + (e && e.message ? e.message : String(e)) };
  }
}
