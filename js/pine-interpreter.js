/* pine-interpreter.js
   pine-engine.js가 만든 AST를 실제로 실행하는 부분. 봉(bar) 배열을 받아서 매 bar마다
   스크립트 전체를 처음부터 다시 실행하고(Pine의 실제 실행 모델), plot()/hline() 으로
   등록된 시리즈를 모아서 돌려준다. */

class PineRuntimeError extends Error {
  constructor(msg, line){ super(msg); this.line = line; this.pineRuntime = true; }
}
class PineBreakSignal {}
class PineContinueSignal {}

class PineArray {
  constructor(items, kind){ this.items = items || []; this.kind = kind || 'float'; }
}
class PineLine {
  constructor(o){ Object.assign(this, { x1: null, y1: null, x2: null, y2: null, color: '#787b86', width: 1, style: 'solid', extend: 'none', deleted: false }, o); }
}
class PineBox {
  constructor(o){ Object.assign(this, { x1: null, y1: null, x2: null, y2: null, bgcolor: 'rgba(120,123,134,0.2)', bordercolor: '#787b86', text: '', textcolor: '#ffffff', extend: 'none', deleted: false }, o); }
}
class PineLabel {
  constructor(o){ Object.assign(this, { x: null, y: null, text: '', color: 'rgba(30,34,42,0.9)', textcolor: '#ffffff', style: 'label_down', size: 'normal', deleted: false }, o); }
}
function isPineRefObject(v){ return v instanceof PineArray || v instanceof PineLine || v instanceof PineBox || v instanceof PineLabel; }
// 함수 내부에서 var로 선언한 변수는 "누가 이 함수를 호출했는지"(callPath)별로 진짜 전역 슬롯에
// 상태를 저장해두고, 그 함수의 스코프 프레임에는 이 마커만 넣어서 실제 값을 우회 참조하게 한다.
// (ta.ema 같은 내장 함수가 콜사이트별로 상태를 갖는 것과 같은 방식)
class PineFnPersistentRef { constructor(key){ this.key = key; } }

function pineNum(v){ return v == null ? NaN : Number(v); }
function pineTruthy(v){
  if(v === true) return true;
  if(v === false || v === null || v === undefined) return false;
  if(typeof v === 'number') return v !== 0 && !isNaN(v);
  if(typeof v === 'string') return v.length > 0;
  return !!v;
}
function pineEquals(a, b){
  if(a === null && b === null) return true;
  if(a === null || b === null) return false;
  return a === b;
}
function pineFmt(v){
  if(v === null || v === undefined) return 'na';
  if(typeof v === 'number') return (Math.round(v * 100000) / 100000).toString();
  return String(v);
}

// ============================================================
// 내장 시리즈 / 상수
// ============================================================
const BUILTIN_SERIES = {
  close: it => it.closeArr, open: it => it.openArr, high: it => it.highArr, low: it => it.lowArr,
  volume: it => it.volArr, hl2: it => it.hl2Arr, hlc3: it => it.hlc3Arr, ohlc4: it => it.ohlc4Arr,
  hlcc4: it => it.hlcc4Arr, time: it => it.timeArr,
};
const BUILTIN_CONSTS = {
  bar_index: it => it.curBar,
  last_bar_index: it => it.n - 1,
  na: () => null,
  // 예전(v1~v3) Pine은 네임스페이스가 없어서 tr/색상/타입 등이 전부 이렇게 맨 이름으로 쓰였다
  tr: it => TA_NS['ta.tr'](it),
  lime: () => '#00e676', green: () => '#089981', red: () => '#f23645', maroon: () => '#880e4f',
  blue: () => '#2962ff', black: () => '#000000', gray: () => '#787b86', grey: () => '#787b86',
  white: () => '#ffffff', orange: () => '#ff9800', purple: () => '#9c27b0', yellow: () => '#ffeb3b',
  aqua: () => '#00bcd4', fuchsia: () => '#e040fb', silver: () => '#c0c0c0', navy: () => '#01579b',
  olive: () => '#827717', teal: () => '#00897b',
  line: () => 'plot.style_line', histogram: () => 'plot.style_histogram', cross: () => 'plot.style_cross',
  area: () => 'plot.style_area', columns: () => 'plot.style_columns', circles: () => 'plot.style_circles',
  stepline: () => 'plot.style_stepline',
  bool: () => 'bool', integer: () => 'integer', float: () => 'float', resolution: () => 'resolution', session: () => 'session',
  source: () => 'source', symbol: () => 'symbol',
};
const PINE_BUILTIN_CONST_NS = {
  'color.red': '#f23645', 'color.green': '#089981', 'color.blue': '#2962ff', 'color.orange': '#ff9800',
  'color.yellow': '#ffeb3b', 'color.purple': '#9c27b0', 'color.white': '#ffffff', 'color.black': '#000000',
  'color.gray': '#787b86', 'color.grey': '#787b86', 'color.lime': '#00e676', 'color.aqua': '#00bcd4',
  'color.fuchsia': '#e040fb', 'color.maroon': '#880e4f', 'color.navy': '#01579b', 'color.olive': '#827717',
  'color.silver': '#c0c0c0', 'color.teal': '#00897b', 'color.new': null, // color.new는 함수라 여기 안 씀
};
const PINE_SOFT_CONST_NAMESPACES = new Set(['plot','shape','size','location','scale','hline','line','label','barmerge','currency','session','format','xloc','yloc','text','strategy','order','display','extend','adjustment','settle','syminfo','timeframe','ticker','earnings','dividends','splits']);
const PINE_DYNAMIC_CONST_NS = {
  'barstate.islast': it => it.curBar === it.n - 1,
  'barstate.isfirst': it => it.curBar === 0,
  'barstate.ishistory': it => it.curBar !== it.n - 1,
  'barstate.isrealtime': () => false,
  'barstate.isnew': () => true,
  'barstate.isconfirmed': () => true, // 이 앱은 확정된 봉 종가 기준으로만 계산하므로 항상 true로 취급
  'timeframe.isdwm': it => { const d = it.n > 1 ? it.timeArr[1] - it.timeArr[0] : 0; return d >= 86400; },
  'timeframe.isdaily': it => { const d = it.n > 1 ? it.timeArr[1] - it.timeArr[0] : 0; return d >= 86400 && d < 604800; },
  'timeframe.isweekly': it => { const d = it.n > 1 ? it.timeArr[1] - it.timeArr[0] : 0; return d >= 604800 && d < 2592000; },
  'timeframe.ismonthly': it => { const d = it.n > 1 ? it.timeArr[1] - it.timeArr[0] : 0; return d >= 2592000; },
  'timeframe.isintraday': it => { const d = it.n > 1 ? it.timeArr[1] - it.timeArr[0] : 0; return d > 0 && d < 86400; },
  'timeframe.isminutes': it => { const d = it.n > 1 ? it.timeArr[1] - it.timeArr[0] : 0; return d >= 60 && d < 86400; },
  'timeframe.isseconds': it => { const d = it.n > 1 ? it.timeArr[1] - it.timeArr[0] : 0; return d > 0 && d < 60; },
};
const NAMESPACE_ROOTS = new Set(['ta','math','array','input','color','str','request','strategy','matrix','map','table','syminfo','timeframe','ticker','chart','line','label','box','polyline','runtime','log']);

// ============================================================
// PineInterpreter
// ============================================================
class PineInterpreter {
  constructor(ast){
    this.ast = ast;
  }

  precomputeSeries(bars){
    this.closeArr = bars.map(b => b.close);
    this.openArr = bars.map(b => b.open);
    this.highArr = bars.map(b => b.high);
    this.lowArr = bars.map(b => b.low);
    this.volArr = bars.map(b => (b.volume == null ? 0 : b.volume));
    this.hl2Arr = bars.map(b => (b.high + b.low) / 2);
    this.hlc3Arr = bars.map(b => (b.high + b.low + b.close) / 3);
    this.ohlc4Arr = bars.map(b => (b.open + b.high + b.low + b.close) / 4);
    this.hlcc4Arr = bars.map(b => (b.high + b.low + b.close + b.close) / 4);
    this.timeArr = bars.map(b => b.time);
  }

  run(bars, inputOverrides){
    this.n = bars.length;
    this.bars = bars;
    this.env = { globals: new Map() };
    this.scopeStack = [];
    this.callState = new Map();
    this.plots = new Map();
    this.hlines = new Map();
    this.lines = []; this.boxes = []; this.labels = [];
    this.maxLines = 50; this.maxBoxes = 50; this.maxLabels = 50;
    this.meta = { title: 'Custom', overlay: false, shorttitle: '' };
    this.inputMeta = [];
    this.inputOverrides = inputOverrides || {};
    this.userFuncs = new Map();
    this.callPath = []; // 사용자 함수 호출 지점들의 스택 — ta.* 같은 내부 상태 함수가 "누가 호출했는지"별로 상태를 구분하게 해줌
    this.precomputeSeries(bars);
    for(const st of this.ast.body) if(st.type === 'FuncDecl') this.userFuncs.set(st.name, st);
    if(!this.n) return { meta: this.meta, plots: [], hlines: [], inputs: this.inputMeta, lines: [], boxes: [], labels: [] };

    for(let i = 0; i < this.n; i++){
      this.curBar = i;
      if(i > 0){
        for(const slot of this.env.globals.values()){
          if(slot.isVar && slot.kind === 'scalar' && slot.everInited) slot.history[i] = slot.history[i - 1];
        }
      }
      for(const st of this.ast.body){
        if(st.type === 'FuncDecl') continue;
        try{ this.execStatement(st); }
        catch(e){
          if(e instanceof PineBreakSignal || e instanceof PineContinueSignal){
            throw new PineRuntimeError(pineMsg('break/continue는 반복문 안에서만 사용할 수 있습니다', 'break/continue can only be used inside a loop'), st.line);
          }
          throw e;
        }
      }
    }
    return {
      meta: this.meta, plots: [...this.plots.values()], hlines: [...this.hlines.values()], inputs: this.inputMeta,
      lines: this.lines.filter(l => !l.deleted), boxes: this.boxes.filter(b => !b.deleted), labels: this.labels.filter(lb => !lb.deleted),
    };
  }

  // ---------- 문장 실행 ----------
  execStatement(node){
    switch(node.type){
      case 'VarDecl': return this.execVarDecl(node);
      case 'Reassign': return this.execReassign(node);
      case 'TupleDecl': return this.execTupleDecl(node);
      case 'TupleReassign': return this.execTupleReassign(node);
      case 'FuncDecl': return null;
      case 'If': return this.execIf(node);
      case 'For': return this.execFor(node);
      case 'ForIn': return this.execForIn(node);
      case 'While': return this.execWhile(node);
      case 'Switch': return this.execSwitch(node);
      case 'Break': throw new PineBreakSignal();
      case 'Continue': throw new PineContinueSignal();
      case 'ExprStmt': return this.evalExpr(node.expr);
      default: throw new PineRuntimeError(pineMsg('지원하지 않는 문장입니다: ' + node.type, 'Unsupported statement: ' + node.type), node.line);
    }
  }
  execBlock(stmts){
    let v = null;
    for(const st of stmts) v = this.execStatement(st);
    return v;
  }
  execVarDecl(node){
    if(node.isVar){
      if(this.scopeStack.some(f => f.isFunctionCall)){
        const key = 'fn$' + this.callPath.join('.') + '$' + node.name;
        let slot = this.env.globals.get(key);
        if(!slot || !slot.everInited){
          const v = this.evalExpr(node.init);
          if(isPineRefObject(v)) slot = { isVar: true, everInited: true, kind: 'object', value: v };
          else { slot = { isVar: true, everInited: true, kind: 'scalar', history: new Array(this.n) }; slot.history[this.curBar] = v; }
          this.env.globals.set(key, slot);
        }
        this.scopeStack[this.scopeStack.length - 1].vars.set(node.name, new PineFnPersistentRef(key));
        const s = this.env.globals.get(key);
        return s.kind === 'object' ? s.value : s.history[this.curBar];
      }
      let slot = this.env.globals.get(node.name);
      if(!slot || !slot.everInited){
        const v = this.evalExpr(node.init);
        if(isPineRefObject(v)) slot = { isVar: true, everInited: true, kind: 'object', value: v };
        else { slot = { isVar: true, everInited: true, kind: 'scalar', history: new Array(this.n) }; slot.history[this.curBar] = v; }
        this.env.globals.set(node.name, slot);
      }
      const s = this.env.globals.get(node.name);
      return s.kind === 'object' ? s.value : s.history[this.curBar];
    }
    const v = this.evalExpr(node.init);
    this.assignPlain(node.name, v);
    return v;
  }
  assignPlain(name, v){
    if(this.scopeStack.length > 0){ this.scopeStack[this.scopeStack.length - 1].vars.set(name, v); return; }
    if(isPineRefObject(v)){ this.env.globals.set(name, { isVar: false, everInited: true, kind: 'object', value: v }); return; }
    let slot = this.env.globals.get(name);
    if(!slot || slot.kind !== 'scalar'){ slot = { isVar: false, everInited: true, kind: 'scalar', history: new Array(this.n) }; this.env.globals.set(name, slot); }
    slot.history[this.curBar] = v;
  }
  execReassign(node){
    const v = this.evalExpr(node.value);
    for(let i = this.scopeStack.length - 1; i >= 0; i--){
      if(this.scopeStack[i].vars.has(node.name)){
        const cur = this.scopeStack[i].vars.get(node.name);
        if(cur instanceof PineFnPersistentRef){
          const slot = this.env.globals.get(cur.key);
          if(slot.kind === 'object') slot.value = v; else slot.history[this.curBar] = v;
          return v;
        }
        this.scopeStack[i].vars.set(node.name, v); return v;
      }
    }
    const slot = this.env.globals.get(node.name);
    if(!slot) throw new PineRuntimeError(pineMsg("정의되지 않은 변수에 ':=' 사용: " + node.name, "Used ':=' on an undefined variable: " + node.name), node.line);
    if(slot.kind === 'object'){ slot.value = v; return v; }
    slot.history[this.curBar] = v; return v;
  }
  execTupleDecl(node){
    const raw = this.evalExpr(node.value);
    const vals = Array.isArray(raw) ? raw : [raw];
    node.names.forEach((name, k) => this.assignPlain(name, vals[k] === undefined ? null : vals[k]));
    return null;
  }
  execTupleReassign(node){
    const raw = this.evalExpr(node.value);
    const vals = Array.isArray(raw) ? raw : [raw];
    node.names.forEach((name, k) => {
      const v = vals[k] === undefined ? null : vals[k];
      for(let i = this.scopeStack.length - 1; i >= 0; i--){
        if(this.scopeStack[i].vars.has(name)){ this.scopeStack[i].vars.set(name, v); return; }
      }
      const slot = this.env.globals.get(name);
      if(!slot) throw new PineRuntimeError(pineMsg("정의되지 않은 변수에 ':=' 사용: " + name, "Used ':=' on an undefined variable: " + name), node.line);
      if(slot.kind === 'object') slot.value = v; else slot.history[this.curBar] = v;
    });
    return null;
  }
  execIf(node){
    this.scopeStack.push({ isFunctionCall: false, vars: new Map() });
    try{
      if(pineTruthy(this.evalExpr(node.cond))) return this.execBlock(node.then);
      if(node.elseBody) return this.execBlock(node.elseBody);
      return null;
    } finally { this.scopeStack.pop(); }
  }
  execFor(node){
    const from = pineNum(this.evalExpr(node.from));
    const to = pineNum(this.evalExpr(node.to));
    const step = node.step ? pineNum(this.evalExpr(node.step)) : (to >= from ? 1 : -1);
    let result = null;
    if(step === 0) throw new PineRuntimeError(pineMsg('for 문의 by 값은 0이 될 수 없습니다', "The 'by' step in a for statement cannot be 0"), node.line);
    for(let v = from; (step > 0 ? v <= to : v >= to); v += step){
      this.scopeStack.push({ isFunctionCall: false, vars: new Map([[node.varName, v]]) });
      try{ result = this.execBlock(node.body); }
      catch(e){
        if(e instanceof PineContinueSignal) continue;
        if(e instanceof PineBreakSignal) break;
        throw e;
      } finally { this.scopeStack.pop(); }
    }
    return result;
  }
  execForIn(node){
    const iterable = this.evalExpr(node.iterable);
    const arr = iterable instanceof PineArray ? iterable.items : (Array.isArray(iterable) ? iterable : []);
    let result = null;
    for(let idx = 0; idx < arr.length; idx++){
      const vars = new Map([[node.varName, arr[idx]]]);
      if(node.idxName) vars.set(node.idxName, idx);
      this.scopeStack.push({ isFunctionCall: false, vars });
      try{ result = this.execBlock(node.body); }
      catch(e){
        if(e instanceof PineContinueSignal) continue;
        if(e instanceof PineBreakSignal) break;
        throw e;
      } finally { this.scopeStack.pop(); }
    }
    return result;
  }
  execWhile(node){
    let result = null, guard = 0;
    while(pineTruthy(this.evalExpr(node.cond))){
      if(++guard > 200000) throw new PineRuntimeError(pineMsg('while 루프가 너무 오래 반복됩니다(무한루프로 판단해 중단)', 'while loop ran too long (stopped — likely an infinite loop)'), node.line);
      this.scopeStack.push({ isFunctionCall: false, vars: new Map() });
      try{ result = this.execBlock(node.body); }
      catch(e){
        if(e instanceof PineContinueSignal) continue;
        if(e instanceof PineBreakSignal) break;
        throw e;
      } finally { this.scopeStack.pop(); }
    }
    return result;
  }
  execSwitch(node){
    const subj = node.subject ? this.evalExpr(node.subject) : null;
    for(const c of node.cases){
      const val = this.evalExpr(c.val);
      const matches = node.subject ? pineEquals(subj, val) : pineTruthy(val);
      if(matches){
        this.scopeStack.push({ isFunctionCall: false, vars: new Map() });
        try{ return this.execBlock(c.body); } finally { this.scopeStack.pop(); }
      }
    }
    if(node.def){
      this.scopeStack.push({ isFunctionCall: false, vars: new Map() });
      try{ return this.execBlock(node.def); } finally { this.scopeStack.pop(); }
    }
    return null;
  }

  // ---------- 식 평가 ----------
  evalExpr(node){
    switch(node.type){
      case 'Number': return node.value;
      case 'String': return node.value;
      case 'Bool': return node.value;
      case 'Na': return null;
      case 'Ident': return this.evalIdent(node);
      case 'Binary': return this.evalBinary(node);
      case 'Unary': return this.evalUnary(node);
      case 'Ternary': return pineTruthy(this.evalExpr(node.cond)) ? this.evalExpr(node.then) : this.evalExpr(node.else);
      case 'Call': return this.evalCall(node);
      case 'Member': return this.evalMember(node);
      case 'Index': return this.evalIndex(node);
      case 'If': return this.execIf(node);
      case 'Switch': return this.execSwitch(node);
      case 'ExprList': return node.items.map(it => this.evalExpr(it));
      case 'ArrayLiteral': return node.items.map(it => this.evalExpr(it));
      default: throw new PineRuntimeError(pineMsg('지원하지 않는 식입니다: ' + node.type, 'Unsupported expression: ' + node.type), node.line);
    }
  }
  evalIdent(node){
    for(let i = this.scopeStack.length - 1; i >= 0; i--){
      if(this.scopeStack[i].vars.has(node.name)){
        const v = this.scopeStack[i].vars.get(node.name);
        if(v instanceof PineFnPersistentRef){
          const slot = this.env.globals.get(v.key);
          return slot.kind === 'object' ? slot.value : (slot.history[this.curBar] === undefined ? null : slot.history[this.curBar]);
        }
        return v;
      }
    }
    const slot = this.env.globals.get(node.name);
    if(slot){
      if(slot.kind === 'object') return slot.value;
      const v = slot.history[this.curBar];
      return v === undefined ? null : v;
    }
    if(BUILTIN_SERIES[node.name]) return BUILTIN_SERIES[node.name](this)[this.curBar];
    if(BUILTIN_CONSTS.hasOwnProperty(node.name)) return BUILTIN_CONSTS[node.name](this);
    if(this.userFuncs.has(node.name)) throw new PineRuntimeError(pineMsg(node.name + '는 함수입니다. 괄호를 붙여 호출해야 합니다', node.name + ' is a function — call it with parentheses'), node.line);
    throw new PineRuntimeError(pineMsg('정의되지 않은 이름입니다: ' + node.name, 'Undefined name: ' + node.name), node.line);
  }
  evalBinary(node){
    if(node.op === 'and'){ const l = this.evalExpr(node.left); if(!pineTruthy(l)) return false; return pineTruthy(this.evalExpr(node.right)); }
    if(node.op === 'or'){ const l = this.evalExpr(node.left); if(pineTruthy(l)) return true; return pineTruthy(this.evalExpr(node.right)); }
    const l = this.evalExpr(node.left), r = this.evalExpr(node.right);
    switch(node.op){
      case '+':
        if(typeof l === 'string' || typeof r === 'string') return (l == null ? 'na' : l) + '' + (r == null ? 'na' : r);
        if(l == null || r == null) return null;
        return l + r;
      case '-': if(l == null || r == null) return null; return l - r;
      case '*': if(l == null || r == null) return null; return l * r;
      case '/': if(l == null || r == null) return null; return l / r;
      case '%': if(l == null || r == null) return null; return l % r;
      case '==': return pineEquals(l, r);
      case '!=': return !pineEquals(l, r);
      case '<': if(l == null || r == null) return false; return l < r;
      case '>': if(l == null || r == null) return false; return l > r;
      case '<=': if(l == null || r == null) return false; return l <= r;
      case '>=': if(l == null || r == null) return false; return l >= r;
      default: throw new PineRuntimeError(pineMsg('알 수 없는 연산자 ' + node.op, 'Unknown operator ' + node.op), node.line);
    }
  }
  evalUnary(node){
    const v = this.evalExpr(node.arg);
    if(node.op === 'not') return !pineTruthy(v);
    if(node.op === '-') return v == null ? null : -v;
    return v;
  }
  arrayGet(arr, idxVal, line){
    const idx = Math.round(pineNum(idxVal));
    if(!(arr instanceof PineArray)) throw new PineRuntimeError(pineMsg('배열이 아닌 값에 인덱싱을 시도했습니다', 'Tried to index a non-array value'), line);
    if(idx < 0 || idx >= arr.items.length) throw new PineRuntimeError(pineMsg('배열 인덱스 범위를 벗어났습니다(size=' + arr.items.length + ', index=' + idx + ')', 'Array index out of range (size=' + arr.items.length + ', index=' + idx + ')'), line);
    return arr.items[idx];
  }
  evalIndex(node){
    if(node.obj.type === 'Ident'){
      const name = node.obj.name;
      for(let i = this.scopeStack.length - 1; i >= 0; i--){
        if(this.scopeStack[i].vars.has(name)){
          const val = this.scopeStack[i].vars.get(name);
          if(val instanceof PineArray) return this.arrayGet(val, this.evalExpr(node.index), node.line);
          if(val instanceof PineFnPersistentRef){
            const slot = this.env.globals.get(val.key);
            if(slot.kind === 'object'){
              if(slot.value instanceof PineArray) return this.arrayGet(slot.value, this.evalExpr(node.index), node.line);
              throw new PineRuntimeError(pineMsg(name + ' 값에는 []를 사용할 수 없습니다', name + ' cannot be used with []'), node.line);
            }
            const k = Math.round(pineNum(this.evalExpr(node.index)));
            const at = this.curBar - k;
            return at < 0 ? null : (slot.history[at] === undefined ? null : slot.history[at]);
          }
          throw new PineRuntimeError(pineMsg('함수 내부의 지역 변수는 과거값 참조([n])를 지원하지 않습니다: ' + name, 'Local variables inside functions do not support history reference ([n]): ' + name), node.line);
        }
      }
      const slot = this.env.globals.get(name);
      if(slot){
        if(slot.kind === 'object'){
          if(slot.value instanceof PineArray) return this.arrayGet(slot.value, this.evalExpr(node.index), node.line);
          throw new PineRuntimeError(pineMsg(name + ' 값에는 []를 사용할 수 없습니다', name + ' cannot be used with []'), node.line);
        }
        const k = Math.round(pineNum(this.evalExpr(node.index)));
        const at = this.curBar - k;
        return at < 0 ? null : (slot.history[at] === undefined ? null : slot.history[at]);
      }
      if(BUILTIN_SERIES[name]){
        const k = Math.round(pineNum(this.evalExpr(node.index)));
        const at = this.curBar - k;
        return at < 0 ? null : BUILTIN_SERIES[name](this)[at];
      }
      throw new PineRuntimeError(pineMsg('정의되지 않은 이름입니다: ' + name, 'Undefined name: ' + name), node.line);
    }
    const objVal = this.evalExpr(node.obj);
    if(objVal instanceof PineArray) return this.arrayGet(objVal, this.evalExpr(node.index), node.line);
    throw new PineRuntimeError(pineMsg('이 식에는 [n] 과거값 참조를 사용할 수 없습니다(변수명 또는 배열만 가능)', '[n] history reference is not allowed on this expression (only variable names or arrays)'), node.line);
  }
  staticMemberPath(node){
    if(node.type === 'Ident') return node.name;
    if(node.type === 'Member'){ const base = this.staticMemberPath(node.obj); return base ? base + '.' + node.prop : null; }
    return null;
  }
  evalMember(node){
    const path = this.staticMemberPath(node);
    if(path && PINE_DYNAMIC_CONST_NS.hasOwnProperty(path)) return PINE_DYNAMIC_CONST_NS[path](this);
    if(path && PINE_BUILTIN_CONST_NS.hasOwnProperty(path) && PINE_BUILTIN_CONST_NS[path] !== null) return PINE_BUILTIN_CONST_NS[path];
    if(path){
      const root = path.split('.')[0];
      if(PINE_SOFT_CONST_NAMESPACES.has(root)) return path; // 장식용 상수 — 내부적으로 비교 안 하므로 자기 이름을 값으로 사용
    }
    throw new PineRuntimeError(pineMsg('정의되지 않은 이름입니다: ' + (path || '?'), 'Undefined name: ' + (path || '?')), node.line);
  }
  evalCall(node){
    const posArgs = []; const namedArgs = {};
    for(const a of node.args){
      if(a.named) namedArgs[a.name] = this.evalExpr(a.value);
      else posArgs.push(this.evalExpr(a.value));
    }
    if(node.callee.type === 'Ident'){
      const name = node.callee.name;
      if(this.userFuncs.has(name)) return this.callUserFunction(this.userFuncs.get(name), posArgs, namedArgs, node.line, node.id);
      if(TOP_LEVEL_BUILTINS[name]) return TOP_LEVEL_BUILTINS[name](this, posArgs, namedArgs, node);
      throw new PineRuntimeError(pineMsg('정의되지 않은 함수입니다: ' + name, 'Undefined function: ' + name), node.line);
    }
    if(node.callee.type === 'Member'){
      const path = this.staticMemberPath(node.callee);
      if(path && PINE_BUILTIN_NS[path]) return PINE_BUILTIN_NS[path](this, posArgs, namedArgs, node);
      if(path && NAMESPACE_ROOTS.has(path.split('.')[0])){
        throw new PineRuntimeError(pineMsg('지원하지 않는 함수입니다: ' + path + '()', 'Unsupported function: ' + path + '()'), node.line);
      }
      const objVal = this.evalExpr(node.callee.obj);
      const method = node.callee.prop;
      if(objVal instanceof PineArray){
        const fn = ARRAY_METHOD_BUILTINS[method];
        if(!fn) throw new PineRuntimeError(pineMsg('배열에 지원하지 않는 메서드입니다: .' + method + '()', 'Unsupported array method: .' + method + '()'), node.line);
        return fn(this, objVal, posArgs, namedArgs, node);
      }
      if(objVal instanceof PineLine){
        const fn = LINE_METHODS[method];
        if(!fn) throw new PineRuntimeError(pineMsg('line에 지원하지 않는 메서드입니다: .' + method + '()', 'Unsupported line method: .' + method + '()'), node.line);
        return fn(this, objVal, posArgs, namedArgs, node);
      }
      if(objVal instanceof PineBox){
        const fn = BOX_METHODS[method];
        if(!fn) throw new PineRuntimeError(pineMsg('box에 지원하지 않는 메서드입니다: .' + method + '()', 'Unsupported box method: .' + method + '()'), node.line);
        return fn(this, objVal, posArgs, namedArgs, node);
      }
      if(objVal instanceof PineLabel){
        const fn = LABEL_METHODS[method];
        if(!fn) throw new PineRuntimeError(pineMsg('label에 지원하지 않는 메서드입니다: .' + method + '()', 'Unsupported label method: .' + method + '()'), node.line);
        return fn(this, objVal, posArgs, namedArgs, node);
      }
      throw new PineRuntimeError(pineMsg('지원하지 않는 메서드 호출입니다: .' + method + '()', 'Unsupported method call: .' + method + '()'), node.line);
    }
    throw new PineRuntimeError(pineMsg('호출할 수 없는 식입니다', 'This expression cannot be called'), node.line);
  }
  pathKey(node){
    return (this.callPath.length ? this.callPath.join('.') + '.' : '') + node.id;
  }
  callUserFunction(funcNode, posArgs, namedArgs, line, callId){
    if(this.scopeStack.filter(f => f.isFunctionCall).length > 60) throw new PineRuntimeError(pineMsg('함수 호출이 너무 깊습니다(재귀는 지원하지 않습니다)', 'Function call nesting too deep (recursion is not supported)'), line);
    const vars = new Map();
    funcNode.params.forEach((p, idx) => {
      let v;
      if(namedArgs.hasOwnProperty(p.name)) v = namedArgs[p.name];
      else if(idx < posArgs.length) v = posArgs[idx];
      else if(p.default) v = this.evalExpr(p.default);
      else v = null;
      vars.set(p.name, v);
    });
    this.scopeStack.push({ isFunctionCall: true, vars });
    this.callPath.push(callId);
    try{ return this.execBlock(funcNode.body); }
    finally{ this.scopeStack.pop(); this.callPath.pop(); }
  }
}
