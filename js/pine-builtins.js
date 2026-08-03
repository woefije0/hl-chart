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
  slice: (it, arr, p) => new PineArray(arr.items.slice(Math.round(pineNum(p[0])), Math.round(pineNum(p[1])) + 1), arr.kind),
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
};

function pineTfSeconds(tf){
  const s = String(tf || '').toUpperCase().trim();
  if(s === '') return 60; // 빈 문자열은 차트 자체 기간을 의미하지만 근사치로 1분 취급
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
  'line.new': (it, p, n, node) => {
    let x1, y1, x2, y2;
    const pt0 = pinePointOf(p, 0), pt1 = pinePointOf(p, 1);
    if(pt0){ x1 = pineResolveTime(it, pt0); y1 = pt0.price; x2 = pineResolveTime(it, pt1); y2 = pt1 ? pt1.price : y1; }
    else { x1 = pineResolveTime(it, p[0]); y1 = p[1]; x2 = pineResolveTime(it, p[2]); y2 = p[3]; }
    const obj = new PineLine({
      x1, y1, x2, y2,
      color: n.color !== undefined ? n.color : '#787b86',
      width: n.width != null ? n.width : 1,
      style: pineLineStyleFromConst(n.style),
      extend: pineExtendFromConst(n.extend),
    });
    pineCapPush(it.lines, obj, it.maxLines);
    return obj;
  },
  'box.new': (it, p, n, node) => {
    let x1, y1, x2, y2;
    const pt0 = pinePointOf(p, 0), pt1 = pinePointOf(p, 1);
    if(pt0){ x1 = pineResolveTime(it, pt0); y1 = pt0.price; x2 = pineResolveTime(it, pt1); y2 = pt1 ? pt1.price : y1; }
    else { x1 = pineResolveTime(it, p[0]); y1 = p[1]; x2 = pineResolveTime(it, p[2]); y2 = p[3]; }
    const obj = new PineBox({
      x1, y1, x2, y2,
      bgcolor: n.bgcolor !== undefined ? n.bgcolor : 'rgba(120,123,134,0.2)',
      bordercolor: n.border_color !== undefined ? n.border_color : '#787b86',
      text: n.text !== undefined ? n.text : '',
      textcolor: n.text_color !== undefined ? n.text_color : '#ffffff',
      extend: pineExtendFromConst(n.extend),
    });
    pineCapPush(it.boxes, obj, it.maxBoxes);
    return obj;
  },
  'label.new': (it, p, n, node) => {
    let x, y;
    const pt0 = pinePointOf(p, 0);
    if(pt0){ x = pineResolveTime(it, pt0); y = pt0.price; }
    else { x = pineResolveTime(it, p[0]); y = p[1]; }
    const text = n.text !== undefined ? n.text : (typeof p[2] === 'string' ? p[2] : '');
    const obj = new PineLabel({
      x, y, text,
      color: n.color !== undefined ? n.color : 'rgba(30,34,42,0.9)',
      textcolor: n.textcolor !== undefined ? n.textcolor : '#ffffff',
      style: pineLabelStyleFromConst(n.style),
      size: n.size !== undefined ? n.size : 'normal',
    });
    pineCapPush(it.labels, obj, it.maxLabels);
    return obj;
  },
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
  delete: (it, b) => { b.deleted = true; const i = it.boxes.indexOf(b); if(i > -1) it.boxes.splice(i, 1); return null; },
};
const LABEL_METHODS = {
  set_xy: (it, l, p) => { l.x = pineResolveTime(it, p[0]); l.y = p[1]; return null; },
  set_point: (it, l, p) => { const pt = p[0]; if(pt){ l.x = pineResolveTime(it, pt); l.y = pt.price; } return null; },
  set_text: (it, l, p) => { l.text = p[0]; return null; },
  set_color: (it, l, p) => { l.color = p[0]; return null; },
  set_textcolor: (it, l, p) => { l.textcolor = p[0]; return null; },
  set_style: (it, l, p) => { l.style = pineLabelStyleFromConst(p[0]); return null; },
  set_size: (it, l, p) => { l.size = p[0]; return null; },
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
  'math.floor': (it, p, n) => { const v = getArg(p, n, 0, 'number'); return v == null ? null : Math.floor(v); },
  'math.ceil': (it, p, n) => { const v = getArg(p, n, 0, 'number'); return v == null ? null : Math.ceil(v); },
  'math.avg': (it, p) => p.length ? p.reduce((a, b) => a + b, 0) / p.length : null,
  'math.sum': (it, p) => p.reduce((a, b) => a + b, 0),
  'math.random': (it, p, n) => { const mn = getArg(p, n, 0, 'min', 0), mx = getArg(p, n, 1, 'max', 1); return mn + Math.random() * (mx - mn); },
  'math.todegrees': (it, p) => p[0] * 180 / Math.PI,
  'math.toradians': (it, p) => p[0] * Math.PI / 180,
};

// ============================================================
// color.* / str.*
// ============================================================
function hexToRgb(hex){
  if(typeof hex !== 'string' || hex[0] !== '#') return [120, 123, 134];
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
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
};
const STR_NS = {
  'str.tostring': (it, p) => pineFmt(p[0]),
  'str.length': (it, p) => String(p[0] == null ? '' : p[0]).length,
  'str.contains': (it, p) => String(p[0]).includes(String(p[1])),
  'str.tonumber': (it, p) => { const v = parseFloat(p[0]); return isNaN(v) ? null : v; },
  'str.upper': (it, p) => String(p[0]).toUpperCase(),
  'str.lower': (it, p) => String(p[0]).toLowerCase(),
};

// ============================================================
// 최상위(네임스페이스 없이 바로 쓰는) 함수들
// ============================================================
function pinePlotStyleFromConst(v){
  if(typeof v !== 'string') return 'line';
  if(v.includes('histogram') || v.includes('columns')) return 'histogram';
  return 'line';
}
const TOP_LEVEL_BUILTINS = {
  plot: (it, p, n, node) => {
    const value = getArg(p, n, 0, 'series');
    const title = getArg(p, n, 1, 'title', 'Plot' + node.id);
    const color = getArg(p, n, 2, 'color', '#2962ff');
    const linewidth = getArg(p, n, 3, 'linewidth', 1);
    const style = pinePlotStyleFromConst(getArg(p, n, 4, 'style'));
    const offset = Math.round(pineNum(n.offset != null ? n.offset : 0)) || 0;
    const key = it.pathKey(node);
    let rec = it.plots.get(key);
    if(!rec){ rec = { key, title, color, linewidth, offset, style, values: new Array(it.n), colors: new Array(it.n) }; it.plots.set(key, rec); }
    rec.title = title; rec.color = color; rec.linewidth = linewidth; rec.offset = offset; rec.style = style;
    rec.values[it.curBar] = (n.display === 'display.none') ? null : value;
    rec.colors[it.curBar] = color;
    return null;
  },
  hline: (it, p, n, node) => {
    const price = getArg(p, n, 0, 'price');
    const title = getArg(p, n, 1, 'title', 'H' + node.id);
    const color = getArg(p, n, 2, 'color', '#787b86');
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
  fill: () => null, bgcolor: () => null, barcolor: () => null,
  plotshape: () => null, plotchar: () => null, plotcandle: () => null, plotbar: () => null, plotarrow: () => null,
  alertcondition: () => null, alert: () => null,
  input: inputFn('generic'),
  timestamp: (it, p) => { const [y, mo, d, h = 0, mi = 0, se = 0] = p; return Math.floor(Date.UTC(y, (mo || 1) - 1, d || 1, h, mi, se) / 1000); },
  int: (it, p) => Math.trunc(pineNum(p[0])),
  float: (it, p) => pineNum(p[0]),
  bool: (it, p) => pineTruthy(p[0]),
  string: (it, p) => pineFmt(p[0]),
};

const PINE_BUILTIN_NS = Object.assign({}, TA_NS, MATH_NS, COLOR_NS, STR_NS, TIMEFRAME_NS, DRAWING_NS);
// v3/v4 시절엔 ta./math. 네임스페이스가 없어서 sma()/stdev()/abs()/round() 등이 전부 맨 이름으로 쓰였다 —
// 이미 TOP_LEVEL_BUILTINS에 같은 이름이 없는 경우에만 자동으로 별칭을 만들어준다.
Object.keys(TA_NS).forEach(k => { const bare = k.slice(3); if(!TOP_LEVEL_BUILTINS[bare]) TOP_LEVEL_BUILTINS[bare] = TA_NS[k]; });
Object.keys(MATH_NS).forEach(k => { const bare = k.slice(5); if(!TOP_LEVEL_BUILTINS[bare]) TOP_LEVEL_BUILTINS[bare] = MATH_NS[k]; });
Object.keys(LINE_METHODS).forEach(m => { PINE_BUILTIN_NS['line.' + m] = (it, p, n, node) => LINE_METHODS[m](it, p[0], p.slice(1), n, node); });
Object.keys(BOX_METHODS).forEach(m => { PINE_BUILTIN_NS['box.' + m] = (it, p, n, node) => BOX_METHODS[m](it, p[0], p.slice(1), n, node); });
Object.keys(LABEL_METHODS).forEach(m => { PINE_BUILTIN_NS['label.' + m] = (it, p, n, node) => LABEL_METHODS[m](it, p[0], p.slice(1), n, node); });
PINE_BUILTIN_NS['runtime.error'] = () => null; // 데이터 품질 경고용 — 차트 계산에는 영향 없으므로 무시하고 진행
['int', 'float', 'bool', 'string', 'source', 'timeframe', 'session', 'symbol', 'price', 'color'].forEach(k => { PINE_BUILTIN_NS['input.' + k] = inputFn(k); });
['float', 'int', 'bool', 'string', 'color', 'line', 'label', 'box'].forEach(k => { PINE_BUILTIN_NS['array.new_' + k] = arrayNewFn(k); PINE_BUILTIN_NS['array.new<' + k + '>'] = arrayNewFn(k); });
PINE_BUILTIN_NS['array.new'] = arrayNewFn('float');
PINE_BUILTIN_NS['array.from'] = (it, p) => new PineArray(p.slice(), 'float');
Object.keys(ARRAY_METHOD_BUILTINS).forEach(m => { PINE_BUILTIN_NS['array.' + m] = wrapArrayFn(m); });

// ============================================================
// 진입점
// ============================================================
function runPineScript(source, bars, inputOverrides){
  let ast;
  try{ ast = pineParse(source); }
  catch(e){ throw { pineError: true, line: e.line || null, message: e.message || String(e) }; }
  const interp = new PineInterpreter(ast);
  try{ return interp.run(bars, inputOverrides || {}); }
  catch(e){
    if(e && e.pineRuntime) throw { pineError: true, line: e.line || null, message: e.message };
    throw { pineError: true, line: null, message: '내부 오류: ' + (e && e.message ? e.message : String(e)) };
  }
}
