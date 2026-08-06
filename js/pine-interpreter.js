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
// table.new/table.cell — position + columns*rows 크기의 셀 격자만 데이터로 들고 있고, 실제 HTML
// 렌더링은 pine-import.js 쪽에서 이 객체를 읽어 오버레이 div로 그린다(캔버스 도형이 아니라 표라서
// line/box/label과는 다르게 취급). cells는 "col,row" 문자열을 키로 쓰는 Map.
class PineTable {
  constructor(o){ Object.assign(this, { position: 'top_right', columns: 1, rows: 1, bgcolor: null, bordercolor: null, framecolor: null, cells: new Map(), deleted: false }, o); }
}
// 사용자 정의 타입(type Name ... 으로 선언한 struct 비슷한 것)의 인스턴스. Pine의 UDT는 참조
// 타입이라서(예: arr.get(i)로 꺼낸 값을 고쳐도 배열 안의 원본이 같이 바뀜) 진짜 JS 객체 하나로
// 표현하고, 필드는 Map에 담아둔다 — 이렇게 해두면 var 슬롯/함수 지속 상태 저장 같은 기존
// "참조 객체" 처리 로직(isPineRefObject 체크하는 곳들)을 그대로 재사용할 수 있다.
class PineStruct {
  constructor(typeName, fields){ this.typeName = typeName; this.fields = fields; }
}
function isPineRefObject(v){ return v instanceof PineArray || v instanceof PineLine || v instanceof PineBox || v instanceof PineLabel || v instanceof PineTable || v instanceof PineStruct; }
// 함수 내부에서 var로 선언한 변수는 "누가 이 함수를 호출했는지"(callPath)별로 진짜 전역 슬롯에
// 상태를 저장해두고, 그 함수의 스코프 프레임에는 이 마커만 넣어서 실제 값을 우회 참조하게 한다.
// (ta.ema 같은 내장 함수가 콜사이트별로 상태를 갖는 것과 같은 방식)
class PineFnPersistentRef { constructor(key){ this.key = key; } }

function pineNum(v){ return v == null ? NaN : Number(v); }
// 실제 Pine에서 사칙연산 결과가 유효한 실수가 아니면(0/0, x/0 등) na가 된다 — JS는 그 자리에서
// NaN/Infinity를 그대로 돌려주므로, 여기서 na(=null)로 정규화해서 이후 ta.ema 등 상태 유지
// 함수의 내부 상태에 NaN이 저장되어 영구적으로 오염되는 걸 막는다.
function pineArithOrNa(v){ return Number.isFinite(v) ? v : null; }
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
  hlcc4: it => it.hlcc4Arr, time: it => it.timeArr, time_close: it => it.timeCloseArr,
};
const BUILTIN_CONSTS = {
  bar_index: it => it.curBar,
  last_bar_index: it => it.n - 1,
  last_bar_time: it => it.timeArr[it.n - 1],
  na: () => null,
  // dayofweek(괄호 없는 맨 이름 형태) — 현재 봉의 요일. dayofweek(time)/dayofweek(time, tz) 함수
  // 형태는 pine-builtins.js의 TOP_LEVEL_BUILTINS에 이미 있고, 이건 그 인자 없는 변수 버전.
  dayofweek: it => pineLocalTimeParts(it.timeArr[it.curBar], null).weekday,
  // 예전(v1~v3) Pine은 네임스페이스가 없어서 tr/색상/타입 등이 전부 이렇게 맨 이름으로 쓰였다
  tr: it => TA_NS['ta.tr'](it),
  // period/interval/tickerid도 v1~v3의 맨 이름 전역변수(각각 지금의 timeframe.period,
  // timeframe.period, syminfo.tickerid). 빈 문자열은 pineTfSeconds/buildSecuritySeries가
  // "현재 차트 타임프레임"으로 취급하는 값이라 evalRequestSecurity에 그대로 넘기면 된다.
  // tickerid는 evalRequestSecurity가 심볼 인자를 평가만 하고 버리므로 값 자체는 안 쓰인다.
  period: () => '', interval: () => '', tickerid: () => '',
  lime: () => '#00e676', green: () => '#089981', red: () => '#f23645', maroon: () => '#880e4f',
  blue: () => '#2962ff', black: () => '#000000', gray: () => '#787b86', grey: () => '#787b86',
  white: () => '#ffffff', orange: () => '#ff9800', purple: () => '#9c27b0', yellow: () => '#ffeb3b',
  aqua: () => '#00bcd4', fuchsia: () => '#e040fb', silver: () => '#c0c0c0', navy: () => '#01579b',
  olive: () => '#827717', teal: () => '#00897b',
  line: () => 'plot.style_line', histogram: () => 'plot.style_histogram', cross: () => 'plot.style_cross',
  area: () => 'plot.style_area', columns: () => 'plot.style_columns', circles: () => 'plot.style_circles',
  // hline()의 v1~v3식 linestyle= 인자용 맨 이름(현재 엔진의 hline()은 linestyle 값 자체를 쓰진
  // 않지만, 참조 자체가 "정의되지 않은 이름" 에러로 죽지 않도록 값은 채워둔다).
  solid: () => 'line.style_solid', dashed: () => 'line.style_dashed', dotted: () => 'line.style_dotted',
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
  'math.pi': Math.PI, 'math.e': Math.E, 'math.phi': 1.618033988749895, 'math.rphi': 0.6180339887498949,
  // table.new(position, ...)에 쓰는 위치 상수 — pine-import.js가 이 문자열 그대로 보고 오버레이
  // div를 차트의 어느 모서리/변에 붙일지 정한다.
  'position.top_left': 'top_left', 'position.top_center': 'top_center', 'position.top_right': 'top_right',
  'position.middle_left': 'middle_left', 'position.middle_center': 'middle_center', 'position.middle_right': 'middle_right',
  'position.bottom_left': 'bottom_left', 'position.bottom_center': 'bottom_center', 'position.bottom_right': 'bottom_right',
  // chart.fg_color/bg_color — 이 앱은 항상 다크 테마라 그에 맞는 고정값을 준다.
  'chart.fg_color': '#d1d4dc', 'chart.bg_color': '#131722',
  // dayofweek.* — pineLocalTimeParts()가 돌려주는 weekday 값(일=1~토=7)과 같은 규칙.
  'dayofweek.sunday': 1, 'dayofweek.monday': 2, 'dayofweek.tuesday': 3, 'dayofweek.wednesday': 4,
  'dayofweek.thursday': 5, 'dayofweek.friday': 6, 'dayofweek.saturday': 7,
};
const PINE_SOFT_CONST_NAMESPACES = new Set(['plot','shape','size','location','scale','hline','line','label','barmerge','currency','session','format','xloc','yloc','text','strategy','order','display','extend','adjustment','settle','syminfo','timeframe','ticker','earnings','dividends','splits','alert',
  // input.integer/input.float/input.bool/... — Pine v4식 input()의 type= 인자용 맨 상수.
  // (input.int(...)/input.float(...) 처럼 괄호를 붙여 "호출"하는 v5식 네임스페이스 함수와는 별개 —
  // 그건 Call 경로에서 PINE_BUILTIN_NS를 직접 찾으므로 이 표에 넣어도 서로 안 부딪힌다.)
  'input']);
const PINE_DYNAMIC_CONST_NS = {
  'barstate.islast': it => it.curBar === it.n - 1,
  'barstate.isfirst': it => it.curBar === 0,
  'barstate.ishistory': it => it.curBar !== it.n - 1,
  'barstate.isrealtime': () => false,
  'barstate.isnew': () => true,
  'barstate.isconfirmed': () => true, // 이 앱은 확정된 봉 종가 기준으로만 계산하므로 항상 true로 취급
  // 이 앱은 실시간 미확정봉을 다루지 않고(isrealtime 항상 false) 항상 확정된 과거 데이터만
  // 계산하므로, "마지막으로 확정된 과거 봉"은 결국 islast와 같다.
  'barstate.islastconfirmedhistory': it => it.curBar === it.n - 1,
  'timeframe.isdwm': it => { const d = it.n > 1 ? it.timeArr[1] - it.timeArr[0] : 0; return d >= 86400; },
  'timeframe.isdaily': it => { const d = it.n > 1 ? it.timeArr[1] - it.timeArr[0] : 0; return d >= 86400 && d < 604800; },
  'timeframe.isweekly': it => { const d = it.n > 1 ? it.timeArr[1] - it.timeArr[0] : 0; return d >= 604800 && d < 2592000; },
  'timeframe.ismonthly': it => { const d = it.n > 1 ? it.timeArr[1] - it.timeArr[0] : 0; return d >= 2592000; },
  'timeframe.isintraday': it => { const d = it.n > 1 ? it.timeArr[1] - it.timeArr[0] : 0; return d > 0 && d < 86400; },
  'timeframe.isminutes': it => { const d = it.n > 1 ? it.timeArr[1] - it.timeArr[0] : 0; return d >= 60 && d < 86400; },
  'timeframe.isseconds': it => { const d = it.n > 1 ? it.timeArr[1] - it.timeArr[0] : 0; return d > 0 && d < 60; },
  'timeframe.period': () => '', // period와 같은 이유로 빈 문자열("현재 차트 타임프레임")로 취급
  // box.all/line.all/label.all — 지금까지 만든(삭제 안 된) 도형들을 배열로 돌려준다.
  // "for bx in box.all \n bx.delete()" 같은 패턴(매 bar마다 직접 그린 것들을 싹 지우고 다시
  // 그리는 흔한 관용구)에 쓰인다. it.lines/it.boxes/it.labels를 그대로 감싸는 게 아니라
  // 새 배열로 필터링해서 주므로, 순회 중에 .delete()로 원본 배열이 줄어들어도 안전하다.
  'box.all': it => new PineArray(it.boxes.filter(b => !b.deleted), 'box'),
  'line.all': it => new PineArray(it.lines.filter(l => !l.deleted), 'line'),
  'label.all': it => new PineArray(it.labels.filter(lb => !lb.deleted), 'label'),
};
// ticker.heikinashi(sym) / heikinashi(sym)는 "다른 심볼"을 부르는 게 아니라 "이 심볼을 하이킨아시로
// 바꿔서 달라"는 표시다. 그래서 값 자체는 이 접두사가 붙은 마커 문자열로 두고, request.security()가
// 그 표시를 보고 OHLC 시계열을 하이킨아시로 바꿔치기한 상태에서 expression을 평가한다.
const PINE_HA_TICKER_PREFIX = 'ticker.heikinashi:';

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
    // time_close: 각 봉이 닫히는 시각. 다음 봉의 시작 시각과 같고, 마지막 봉은 봉 간격으로 추정한다.
    const barStep = bars.length >= 2 ? (bars[bars.length - 1].time - bars[bars.length - 2].time) : 60;
    this.timeCloseArr = bars.map((b, i) => (i + 1 < bars.length ? bars[i + 1].time : b.time + barStep));
  }

  run(bars, inputOverrides){
    this.n = bars.length;
    this.bars = bars;
    this.env = { globals: new Map() };
    this.scopeStack = [];
    this.callState = new Map();
    this.plots = new Map();
    this.hlines = new Map();
    this.shapes = new Map();
    this.barcolors = new Map(); // barcolor() — 콜사이트별 봉 색 배열
    this.lines = []; this.boxes = []; this.labels = []; this.tables = [];
    this.maxLines = 50; this.maxBoxes = 50; this.maxLabels = 50;
    this.meta = { title: 'Custom', overlay: false, shorttitle: '' };
    this.inputMeta = [];
    this.inputOverrides = inputOverrides || {};
    this.userFuncs = new Map(); // 이름 -> FuncDecl. 일반 함수는 Pine 자체가 이름 중복을 막으므로 이름 하나면 충분.
    // method는 다르다 — Pine은 "같은 이름, 다른 타입"의 method를 여러 개 선언하는 걸 오버로딩처럼
    // 정식으로 지원한다(예: method toString(TypeA a)=>.. / method toString(TypeB b)=>..).
    // 그래서 method는 이름 하나에 후보 여러 개를 담아두고, 실제 호출 시점에 리시버의 런타임 타입을
    // 보고 그중 맞는 걸 고른다(resolveMethodOverload).
    this.userMethods = new Map(); // 이름 -> FuncDecl[]
    this.typeDecls = new Map(); // 사용자 정의 타입(type Name) 선언 — 필드 기본값, TypeName.new() 생성에 씀
    this.callPath = []; // 사용자 함수 호출 지점들의 스택 — ta.* 같은 내부 상태 함수가 "누가 호출했는지"별로 상태를 구분하게 해줌
    this.branchKeyByVarName = new Map(); // 변수별로 "마지막에 어느 조건 분기에서 할당됐는지" 기록 (색상 스와치 구분용)
    this.precomputeSeries(bars);
    for(const st of this.ast.body){
      if(st.type === 'FuncDecl'){
        this.userFuncs.set(st.name, st);
        if(st.isMethod){
          if(!this.userMethods.has(st.name)) this.userMethods.set(st.name, []);
          this.userMethods.get(st.name).push(st);
        }
      } else if(st.type === 'TypeDecl') this.typeDecls.set(st.name, st);
    }
    if(!this.n) return { meta: this.meta, plots: [], hlines: [], inputs: this.inputMeta, lines: [], boxes: [], labels: [], shapes: [], tables: [], barcolors: [] };

    for(let i = 0; i < this.n; i++){
      this.curBar = i;
      if(i > 0){
        for(const slot of this.env.globals.values()){
          if(slot.isVar && slot.kind === 'scalar' && slot.everInited) slot.history[i] = slot.history[i - 1];
        }
      }
      for(const st of this.ast.body){
        if(st.type === 'FuncDecl' || st.type === 'TypeDecl') continue;
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
      shapes: [...this.shapes.values()], tables: this.tables.filter(t => !t.deleted),
      barcolors: [...this.barcolors.values()],
    };
  }

  // ---------- 문장 실행 ----------
  execStatement(node){
    switch(node.type){
      case 'VarDecl': return this.execVarDecl(node);
      case 'Reassign': return this.execReassign(node);
      case 'TupleDecl': return this.execTupleDecl(node);
      case 'TupleReassign': return this.execTupleReassign(node);
      case 'FieldReassign': return this.execFieldReassign(node);
      case 'FuncDecl': return null;
      case 'TypeDecl': return null;
      case 'If': return this.execIf(node);
      case 'For': return this.execFor(node);
      case 'ForIn': return this.execForIn(node);
      case 'While': return this.execWhile(node);
      case 'Switch': return this.execSwitch(node);
      case 'Break': throw new PineBreakSignal();
      case 'Continue': throw new PineContinueSignal();
      case 'ExprStmt': return this.evalExpr(node.expr);
      case 'Seq': { let v = null; for(const st of node.stmts) v = this.execStatement(st); return v; }
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
          const r = this.evalColorExpr(node.init); const v = r.value;
          this.branchKeyByVarName.set(node.name, r.key);
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
        const r = this.evalColorExpr(node.init); const v = r.value;
        this.branchKeyByVarName.set(node.name, r.key);
        if(isPineRefObject(v)) slot = { isVar: true, everInited: true, kind: 'object', value: v };
        else { slot = { isVar: true, everInited: true, kind: 'scalar', history: new Array(this.n) }; slot.history[this.curBar] = v; }
        this.env.globals.set(node.name, slot);
      }
      const s = this.env.globals.get(node.name);
      return s.kind === 'object' ? s.value : s.history[this.curBar];
    }
    const r = this.evalColorExpr(node.init); const v = r.value;
    this.branchKeyByVarName.set(node.name, r.key);
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
    const r = this.evalColorExpr(node.value); const v = r.value;
    this.branchKeyByVarName.set(node.name, r.key);
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
  // obj.field := value — 사용자 정의 타입(struct) 인스턴스는 참조라서, 필드를 직접 고치면
  // 그 인스턴스를 가리키는 다른 변수/배열 원소에서도 똑같이 바뀐 값이 보인다.
  execFieldReassign(node){
    const objVal = this.evalExpr(node.target.obj);
    if(!(objVal instanceof PineStruct)) throw new PineRuntimeError(pineMsg('필드 재할당 대상이 사용자 정의 타입 인스턴스가 아닙니다: .' + node.target.prop, 'Field reassignment target is not a user-defined type instance: .' + node.target.prop), node.line);
    if(!objVal.fields.has(node.target.prop)) throw new PineRuntimeError(pineMsg(objVal.typeName + ' 타입에 ' + node.target.prop + ' 필드가 없습니다', objVal.typeName + ' has no field ' + node.target.prop), node.line);
    const v = this.evalExpr(node.value);
    objVal.fields.set(node.target.prop, v);
    return v;
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
        return pineArithOrNa(l + r);
      case '-': if(l == null || r == null) return null; return pineArithOrNa(l - r);
      case '*': if(l == null || r == null) return null; return pineArithOrNa(l * r);
      // 나눗셈/나머지: 실제 Pine은 0으로 나누면(0/0 포함) na를 반환한다 — JS는 그 자리에서
      // NaN/Infinity를 반환하는데, 이게 나중에 ta.ema 같은 상태 유지 함수의 내부 상태(이전 값)에
      // 그대로 저장되면 그 이후 모든 봉이 영원히 NaN으로 오염된다(한 번 na가 아니라 NaN이 저장되면
      // "na(prev)" 검사로는 못 잡아냄). 그래서 결과 자체를 여기서 na로 정규화해 오염을 원천 차단한다.
      // 예: WaveTrend 지표의 `ci = (ap-esa)/(0.015*d)`가 첫 봉에서 d=0이라 0/0이 되는 경우.
      case '/': if(l == null || r == null) return null; return pineArithOrNa(l / r);
      case '%': if(l == null || r == null) return null; return pineArithOrNa(l % r);
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
          // 함수 매개변수/지역 변수(단순 값으로 스코프에 저장됨, var 아님)에 대한 과거값 참조.
          // 실제 Pine에서는 이런 지역 변수도 series를 유지하므로 [n]이 정상 동작한다 — 아래
          // 익명 식(주로 함수 호출 결과)에 대한 과거값 참조와 동일한 방식으로, 이 노드가 매 bar
          // (그리고 콜 경로별로) 평가되는 값을 기록해뒀다가 필요한 만큼 되돌려본다.
          const s = getState(this, node);
          if(!s.hist) s.hist = new Array(this.n);
          s.hist[this.curBar] = val;
          const k = Math.round(pineNum(this.evalExpr(node.index)));
          const at = this.curBar - k;
          return at < 0 ? null : (s.hist[at] === undefined ? null : s.hist[at]);
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
      // bar_index[n] — bar_index는 배열이 아니라 계산값(it.curBar)이라서 BUILTIN_SERIES엔
      // 없지만, "n bar 전의 bar_index 값"은 그 시점의 인덱스 자체이므로 그냥 산수로 구한다.
      if(name === 'bar_index'){
        const k = Math.round(pineNum(this.evalExpr(node.index)));
        const at = this.curBar - k;
        return at < 0 ? null : at;
      }
      throw new PineRuntimeError(pineMsg('정의되지 않은 이름입니다: ' + name, 'Undefined name: ' + name), node.line);
    }
    const objVal = this.evalExpr(node.obj);
    if(objVal instanceof PineArray) return this.arrayGet(objVal, this.evalExpr(node.index), node.line);
    // 변수/배열이 아닌 임의의 식(주로 함수 호출 결과, 예: pivothigh(...)[1])에도 실제 Pine처럼
    // 과거값 참조를 허용한다 — 이 노드가 매 bar 한 번씩 평가되는 값을 콜사이트별로 기록해뒀다가
    // 필요한 만큼 되돌려본다(다른 ta.* 내장 함수들의 콜사이트별 상태 저장과 같은 방식).
    const s = getState(this, node);
    if(!s.hist) s.hist = new Array(this.n);
    s.hist[this.curBar] = objVal;
    const k = Math.round(pineNum(this.evalExpr(node.index)));
    const at = this.curBar - k;
    return at < 0 ? null : (s.hist[at] === undefined ? null : s.hist[at]);
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
    // 사용자 정의 타입(struct) 인스턴스의 필드 접근: id.top, element.breaker 등.
    // staticMemberPath는 "id.top" 같은 문자열을 그냥 구조적으로 만들 뿐이라(런타임 값은 안 봄)
    // 위의 정적 이름 검사에는 안 걸리고, 여기서 실제로 obj를 평가해서 struct인지 확인한다.
    let objVal;
    try{ objVal = this.evalExpr(node.obj); }catch(e){ objVal = undefined; }
    if(objVal instanceof PineStruct){
      if(!objVal.fields.has(node.prop)) throw new PineRuntimeError(pineMsg(objVal.typeName + ' 타입에 ' + node.prop + ' 필드가 없습니다', objVal.typeName + ' has no field ' + node.prop), node.line);
      return objVal.fields.get(node.prop);
    }
    throw new PineRuntimeError(pineMsg('정의되지 않은 이름입니다: ' + (path || '?'), 'Undefined name: ' + (path || '?')), node.line);
  }
  // TypeName.new(...) — 사용자 정의 타입의 새 인스턴스를 만든다. 필드는 선언 순서대로 위치 인자를
  // 매칭하고, 인자가 없거나 이름으로 준 경우엔 필드에 적힌 기본값 식을 그 자리에서 평가해 채운다.
  instantiateStruct(typeName, posArgs, namedArgs, line){
    const decl = this.typeDecls.get(typeName);
    const fields = new Map();
    decl.fields.forEach((f, idx) => {
      let v;
      if(namedArgs.hasOwnProperty(f.name)) v = namedArgs[f.name];
      else if(idx < posArgs.length) v = posArgs[idx];
      else v = f.default ? this.evalExpr(f.default) : null;
      fields.set(f.name, v);
    });
    return new PineStruct(typeName, fields);
  }
  // 런타임 값 하나를 보고 Pine의 타입 이름(사용자 정의 타입이면 그 타입 이름, 아니면 int/float/
  // bool/string/... 같은 내장 타입 단어)으로 매핑한다. method 오버로드를 리시버 타입으로
  // 고를 때 씀. int/float는 런타임에 둘 다 그냥 JS number라 구분 못 하고, color/string도
  // 둘 다 문자열로 저장돼 있어 구분 못 한다 — 그런 경우는 pineTypeWordMatches에서 느슨하게 맞춘다.
  pineRuntimeTypeOf(v){
    if(v instanceof PineStruct) return v.typeName;
    if(v instanceof PineArray) return 'array';
    if(v instanceof PineLine) return 'line';
    if(v instanceof PineBox) return 'box';
    if(v instanceof PineLabel) return 'label';
    if(v instanceof PineTable) return 'table';
    if(typeof v === 'boolean') return 'bool';
    if(typeof v === 'number') return 'float';
    if(typeof v === 'string') return 'string';
    return null;
  }
  pineTypeWordMatches(typeWord, v){
    if(typeWord == null) return false;
    if(typeWord === this.pineRuntimeTypeOf(v)) return true;
    if((typeWord === 'int' || typeWord === 'float') && typeof v === 'number') return true;
    if(typeWord === 'color' && typeof v === 'string') return true; // color도 우리 엔진에선 문자열
    return false;
  }
  // method로 선언된 함수는 이름이 같아도 여러 타입에 걸쳐 여러 개 있을 수 있다(Pine이 정식으로
  // 지원하는 오버로딩). 후보가 여러 개면 리시버(receiverVal)의 실제 런타임 타입과 각 후보의
  // 첫 매개변수 타입(methodOfType)을 맞춰보고 고른다 — 정확히 맞는 게 없으면 느슨하게라도
  // 맞는 걸, 그것도 없으면 그냥 첫 번째 후보로 폴백한다(크래시보다는 최선의 추정이 낫다는 판단).
  resolveMethodOverload(name, receiverVal){
    const candidates = this.userMethods.get(name);
    if(!candidates || !candidates.length) return null;
    if(candidates.length === 1) return candidates[0];
    const exact = candidates.find(c => c.methodOfType === this.pineRuntimeTypeOf(receiverVal));
    if(exact) return exact;
    const loose = candidates.find(c => this.pineTypeWordMatches(c.methodOfType, receiverVal));
    if(loose) return loose;
    return candidates[0];
  }
  // plot()의 color= 인자를 평가할 때, 그냥 값만 보는 게 아니라 "삼항연산자/iff()의 어느 분기를
  // 탔는지"까지 같이 추적한다. 이래야 서로 다른 조건인데 우연히 같은 색을 쓰는 경우에도(예:
  // iff(condA, lime, iff(condB, lime, red))) 설정창에서 따로따로 구분해서 색을 바꿀 수 있다 —
  // 실제 TradingView도 값이 아니라 코드상의 분기 위치를 기준으로 "칼라 0/1/2..."를 나눈다.
  evalColorExpr(node){
    if(node.type === 'Ternary'){
      const cond = pineTruthy(this.evalExpr(node.cond));
      const chosen = cond ? node.then : node.else;
      const sub = this.evalColorExpr(chosen);
      return { value: sub.value, key: node.id + ':' + (cond ? 'T' : 'F') + '|' + sub.key };
    }
    if(node.type === 'Call' && node.callee.type === 'Ident' && node.callee.name === 'iff' && !this.userFuncs.has('iff')){
      const rawArgs = node.args;
      if(rawArgs.length >= 3 && !rawArgs[0].named && !rawArgs[1].named && !rawArgs[2].named){
        const cond = pineTruthy(this.evalExpr(rawArgs[0].value));
        const chosen = cond ? rawArgs[1].value : rawArgs[2].value;
        const sub = this.evalColorExpr(chosen);
        return { value: sub.value, key: node.id + ':' + (cond ? 'T' : 'F') + '|' + sub.key };
      }
    }
    if(node.type === 'Ident'){
      const value = this.evalExpr(node);
      const stored = this.branchKeyByVarName.get(node.name);
      return { value, key: stored !== undefined ? stored : ('leaf$' + node.name) };
    }
    const value = this.evalExpr(node);
    return { value, key: 'leaf' + (node.id != null ? node.id : node.line) };
  }
  evalCall(node){
    if(node.callee.type === 'Ident' && node.callee.name === 'plot' && !this.userFuncs.has('plot')){
      return this.evalPlotCallWithColorTracking(node);
    }
    // request.security()의 expression 인자는 다른 인자들처럼 여기서 즉시 평가하면 안 된다 —
    // 상위 타임프레임 컨텍스트로 나중에 따로(여러 번) 평가해야 해서 AST를 그대로 들고 가야 한다.
    if(node.callee.type === 'Member' && node.callee.prop === 'security' && node.callee.obj.type === 'Ident' && node.callee.obj.name === 'request' && !this.userFuncs.has('security')){
      return this.evalRequestSecurity(node);
    }
    // request.security_lower_tf()도 같은 이유(상위 컨텍스트에서 나중에 평가)로 expression을
    // 즉시 평가하면 안 된다. 필요한 lower-tf 봉 데이터는 runPineScript가 실행 전에 이미
    // this.lowerTfCache에 채워뒀으므로(pinePrefetchLowerTf), 여기서는 동기로 조회만 한다.
    if(node.callee.type === 'Member' && node.callee.prop === 'security_lower_tf' && node.callee.obj.type === 'Ident' && node.callee.obj.name === 'request' && !this.userFuncs.has('security_lower_tf')){
      return this.evalRequestSecurityLowerTf(node);
    }
    // v1~v3 Pine은 request. 네임스페이스가 없어서 security(tickerid, resolution, expression)를
    // 맨 이름으로 그대로 호출했다 — 인자 순서가 request.security와 같으므로 그대로 재사용한다.
    if(node.callee.type === 'Ident' && node.callee.name === 'security' && !this.userFuncs.has('security')){
      return this.evalRequestSecurity(node);
    }
    const posArgs = []; const namedArgs = {};
    for(const a of node.args){
      if(a.named) namedArgs[a.name] = this.evalExpr(a.value);
      else posArgs.push(this.evalExpr(a.value));
    }
    if(node.callee.type === 'Ident'){
      const name = node.callee.name;
      // method는 점(.) 없이 f(x, ...) 형태로도 그대로 호출할 수 있다 — 이때도 오버로드가
      // 있으면 첫 인자(x)의 런타임 타입으로 알맞은 걸 고른다.
      if(this.userMethods.has(name)){
        const fn = this.resolveMethodOverload(name, posArgs.length ? posArgs[0] : undefined);
        if(fn) return this.callUserFunction(fn, posArgs, namedArgs, node.line, node.id);
      }
      if(this.userFuncs.has(name)) return this.callUserFunction(this.userFuncs.get(name), posArgs, namedArgs, node.line, node.id);
      if(TOP_LEVEL_BUILTINS[name]) return TOP_LEVEL_BUILTINS[name](this, posArgs, namedArgs, node);
      throw new PineRuntimeError(pineMsg('정의되지 않은 함수입니다: ' + name, 'Undefined function: ' + name), node.line);
    }
    if(node.callee.type === 'Member'){
      const path = this.staticMemberPath(node.callee);
      if(path && PINE_BUILTIN_NS[path]) return PINE_BUILTIN_NS[path](this, posArgs, namedArgs, node);
      // 사용자 정의 타입 생성자: TypeName.new(...)
      if(node.callee.prop === 'new' && node.callee.obj.type === 'Ident' && this.typeDecls.has(node.callee.obj.name)){
        return this.instantiateStruct(node.callee.obj.name, posArgs, namedArgs, node.line);
      }
      if(path && NAMESPACE_ROOTS.has(path.split('.')[0])){
        throw new PineRuntimeError(pineMsg('지원하지 않는 함수입니다: ' + path + '()', 'Unsupported function: ' + path + '()'), node.line);
      }
      const objVal = this.evalExpr(node.callee.obj);
      const method = node.callee.prop;
      // 사용자 정의 method(점 호출) 디스패치 — 'method' 키워드로 선언된 함수 중 리시버의 실제
      // 런타임 타입에 맞는 걸 고른다(Pine은 같은 이름을 여러 타입에 걸쳐 정의하는 걸 정식으로
      // 지원함). 내장 array/line/box/label 메서드가 이미 있으면 그게 먼저지만, 없으면(예: 스크립트가
      // 배열에 자기만의 method를 얹은 경우) 이쪽으로 넘어온다.
      if(objVal instanceof PineArray){
        const fn = ARRAY_METHOD_BUILTINS[method];
        if(fn) return fn(this, objVal, posArgs, namedArgs, node);
      } else if(objVal instanceof PineLine){
        const fn = LINE_METHODS[method];
        if(fn) return fn(this, objVal, posArgs, namedArgs, node);
      } else if(objVal instanceof PineBox){
        const fn = BOX_METHODS[method];
        if(fn) return fn(this, objVal, posArgs, namedArgs, node);
      } else if(objVal instanceof PineLabel){
        const fn = LABEL_METHODS[method];
        if(fn) return fn(this, objVal, posArgs, namedArgs, node);
      } else if(objVal instanceof PineTable){
        const fn = TABLE_METHODS[method];
        if(fn) return fn(this, objVal, posArgs, namedArgs, node);
      }
      const userFn = this.resolveMethodOverload(method, objVal);
      if(userFn) return this.callUserFunction(userFn, [objVal, ...posArgs], namedArgs, node.line, node.id);
      if(objVal instanceof PineArray) throw new PineRuntimeError(pineMsg('배열에 지원하지 않는 메서드입니다: .' + method + '()', 'Unsupported array method: .' + method + '()'), node.line);
      if(objVal instanceof PineLine) throw new PineRuntimeError(pineMsg('line에 지원하지 않는 메서드입니다: .' + method + '()', 'Unsupported line method: .' + method + '()'), node.line);
      if(objVal instanceof PineBox) throw new PineRuntimeError(pineMsg('box에 지원하지 않는 메서드입니다: .' + method + '()', 'Unsupported box method: .' + method + '()'), node.line);
      if(objVal instanceof PineLabel) throw new PineRuntimeError(pineMsg('label에 지원하지 않는 메서드입니다: .' + method + '()', 'Unsupported label method: .' + method + '()'), node.line);
      if(objVal instanceof PineTable) throw new PineRuntimeError(pineMsg('table에 지원하지 않는 메서드입니다: .' + method + '()', 'Unsupported table method: .' + method + '()'), node.line);
      throw new PineRuntimeError(pineMsg('지원하지 않는 메서드 호출입니다: .' + method + '()', 'Unsupported method call: .' + method + '()'), node.line);
    }
    throw new PineRuntimeError(pineMsg('호출할 수 없는 식입니다', 'This expression cannot be called'), node.line);
  }
  // request.security(symbol, timeframe, expression, gaps, lookahead, ...) — symbol은 항상
  // "지금 이 심볼"로 취급한다(다른 심볼 데이터를 새로 불러오는 건 지원 범위 밖 — 이 앱은
  // 애초에 한 번에 심볼 하나만 로드함). gaps 등 나머지 인자는 평가만 하고 버린다.
  // expression은 절대 즉시 평가하면 안 된다 — 상위 타임프레임 컨텍스트로 콜사이트당 한 번,
  // 전체 봉에 대해 미리 계산해두고(buildSecuritySeries) 그 결과를 매 bar 조회만 한다.
  evalRequestSecurity(node){
    const rawArgs = node.args;
    let timeframeVal = '', exprNode = null, lookaheadVal = null, symbolVal = null, posIdx = 0;
    for(const a of rawArgs){
      if(a.named){
        if(a.name === 'timeframe') timeframeVal = this.evalExpr(a.value);
        else if(a.name === 'expression') exprNode = a.value;
        else if(a.name === 'lookahead') lookaheadVal = this.evalExpr(a.value);
        else if(a.name === 'symbol' || a.name === 'ticker') symbolVal = this.evalExpr(a.value);
        else this.evalExpr(a.value);
      } else {
        if(posIdx === 0) symbolVal = this.evalExpr(a.value);
        else if(posIdx === 1) timeframeVal = this.evalExpr(a.value);
        else if(posIdx === 2) exprNode = a.value;
        else if(posIdx === 4) lookaheadVal = this.evalExpr(a.value);
        else this.evalExpr(a.value);
        posIdx++;
      }
    }
    if(exprNode == null) throw new PineRuntimeError(pineMsg('request.security()에는 expression 인자가 필요합니다', 'request.security() requires an expression argument'), node.line);
    // 심볼이 ticker.heikinashi()로 감싸져 있으면, 아래 평가를 전부 "하이킨아시 봉" 위에서 한다.
    // (UT Bot 계열처럼 `security(heikinashi(tickerid), timeframe.period, close)`로 원본 대신
    //  하이킨아시 종가를 소스로 쓰는 스크립트가 흔하다.)
    if(typeof symbolVal === 'string' && symbolVal.startsWith(PINE_HA_TICKER_PREFIX)){
      const st = getState(this, node);
      if(!st.haContext) st.haContext = this.buildHeikinAshiContext();
      const saved = this.captureSeriesContext();
      Object.assign(this, st.haContext);
      try{ return this.evalSecurityWithCurrentSeries(node, exprNode, timeframeVal, lookaheadVal); }
      finally{ Object.assign(this, saved); }
    }
    return this.evalSecurityWithCurrentSeries(node, exprNode, timeframeVal, lookaheadVal);
  }
  // 원본/하이킨아시 어느 시계열이 깔려 있든 동일하게 동작하는 본체.
  evalSecurityWithCurrentSeries(node, exprNode, timeframeVal, lookaheadVal){
    const tf = String(timeframeVal || '');
    // timeframe이 빈 문자열이면 "현재 차트와 같은 해상도"라는 뜻이라 실제로는 타임프레임을 전혀
    // 바꾸는 게 아니다 — 이 경우 expression을 지금 이 실제 봉(curBar)에서 평소처럼 그냥 바로
    // 평가하면 된다. 아래 buildSecuritySeries(K-바 로컬 윈도우로 재구성) 경로를 타면, close/open
    // 같은 내장 시계열이 아닌 스크립트 자체 변수(예: `out = sma(close,len)`처럼 바깥 스코프에서
    // 미리 계산해둔 값)를 참조할 때 curBar가 로컬 윈도우 안의 고정된 상수 인덱스로 치환돼서
    // 엉뚱한(대개 아직 계산되지 않아 na인) 봉의 값을 읽어버리는 문제가 있다 — 특히 이 호출이
    // 스크립트 실행 첫 봉에서 처음 트리거되면, 아직 실행되지 않은 미래 봉들의 값을 참조하게 되어
    // 전 구간이 na가 되고 아무것도 플롯되지 않는다. 같은 타임프레임일 땐 그 재구성 자체가
    // 불필요하므로 완전히 건너뛰고 지금 바로 평가해서 이 문제를 원천적으로 피한다.
    if(tf === ''){
      const v = this.evalExpr(exprNode);
      return v === undefined ? null : v;
    }
    const lookaheadOn = typeof lookaheadVal === 'string' && lookaheadVal.indexOf('lookahead_on') !== -1;
    const s = getState(this, node);
    if(!s.series) s.series = this.buildSecuritySeries(tf, exprNode, lookaheadOn);
    const v = s.series[this.curBar];
    return v === undefined ? null : v;
  }
  // request.security_lower_tf(symbol, timeframe, expression, ignore_invalid_symbol) — security()와
  // 반대 방향(현재 차트보다 잘게 쪼갠 봉)이라 이미 있는 봉을 합치기만 해선 안 되고, 원래
  // 없는 데이터가 필요하다. 그 데이터는 runPineScript가 스크립트 실행 전에 미리 비동기로
  // 받아서 this.lowerTfCache(timeframe 문자열 -> 집계된 1분봉 배열)에 채워두므로, 여기서는
  // 그 캐시를 동기로 조회만 하면 된다. symbol 인자는 security()와 마찬가지로 항상 "지금 이
  // 심볼"로 취급(평가는 하되 값은 버림).
  evalRequestSecurityLowerTf(node){
    const rawArgs = node.args;
    let timeframeVal = '', exprNode = null, posIdx = 0;
    for(const a of rawArgs){
      if(a.named){
        if(a.name === 'timeframe') timeframeVal = this.evalExpr(a.value);
        else if(a.name === 'expression') exprNode = a.value;
        else if(a.name !== 'symbol' && a.name !== 'ticker') this.evalExpr(a.value);
      } else {
        if(posIdx === 0) this.evalExpr(a.value); // symbol — 평가만 하고 버림
        else if(posIdx === 1) timeframeVal = this.evalExpr(a.value);
        else if(posIdx === 2) exprNode = a.value;
        else this.evalExpr(a.value);
        posIdx++;
      }
    }
    if(exprNode == null) throw new PineRuntimeError(pineMsg('request.security_lower_tf()에는 expression 인자가 필요합니다', 'request.security_lower_tf() requires an expression argument'), node.line);
    const tf = String(timeframeVal || '');
    const s = getState(this, node);
    if(!s.arr) s.arr = this.buildLowerTfArraySeries(tf, exprNode);
    return s.arr[this.curBar] || new PineArray([], 'float');
  }
  // lowerTfCache[tf](시간 오름차순 집계 봉)를 이 메인 봉 배열의 구간([time[i], time_close[i]))별로
  // 나누고, expression은 인트라바 히스토리 전체를 한 번에 순회하며 평가한다(메인 봉 경계마다
  // 새로 초기화하지 않음 — 이렇게 해야 ta.* 같은 상태 유지 함수가 실제 Pine의 lower-tf 실행
  // 모델처럼 인트라바 경계를 넘어 자연스럽게 이어진다). 캐시에 데이터가 없으면(timeframe이
  // 리터럴 문자열이 아니었거나, 프리페치가 실패/스킵됐거나) 모든 봉에 빈 배열을 돌려준다.
  buildLowerTfArraySeries(tf, exprNode){
    const n = this.n;
    const result = new Array(n);
    for(let i = 0; i < n; i++) result[i] = new PineArray([], 'float');
    const cache = this.lowerTfCache && this.lowerTfCache.get(tf);
    if(!cache || !cache.length) return result;
    const mainTime = this.timeArr, mainClose = this.timeCloseArr;
    const buckets = new Array(n);
    for(let i = 0; i < n; i++) buckets[i] = [];
    let bi = 0;
    for(let k = 0; k < cache.length; k++){
      const t = cache[k].time;
      if(t < mainTime[0]) continue;
      while(bi < n - 1 && t >= mainClose[bi]) bi++;
      if(t >= mainTime[bi]) buckets[bi].push(k);
    }
    const save = {
      openArr: this.openArr, highArr: this.highArr, lowArr: this.lowArr, closeArr: this.closeArr,
      volArr: this.volArr, timeArr: this.timeArr, timeCloseArr: this.timeCloseArr,
      hl2Arr: this.hl2Arr, hlc3Arr: this.hlc3Arr, ohlc4Arr: this.ohlc4Arr, hlcc4Arr: this.hlcc4Arr,
      curBar: this.curBar, n: this.n,
    };
    const lo = cache.map(c => c.open), lh = cache.map(c => c.high), ll = cache.map(c => c.low);
    const lc = cache.map(c => c.close), lv = cache.map(c => c.volume || 0), lt = cache.map(c => c.time);
    this.openArr = lo; this.highArr = lh; this.lowArr = ll; this.closeArr = lc;
    this.volArr = lv; this.timeArr = lt; this.timeCloseArr = lt;
    this.hl2Arr = lh.map((h, i) => (h + ll[i]) / 2);
    this.hlc3Arr = lh.map((h, i) => (h + ll[i] + lc[i]) / 3);
    this.ohlc4Arr = lh.map((h, i) => (lo[i] + h + ll[i] + lc[i]) / 4);
    this.hlcc4Arr = this.ohlc4Arr;
    this.n = cache.length;
    const values = new Array(cache.length);
    try{
      for(let k = 0; k < cache.length; k++){ this.curBar = k; values[k] = this.evalExpr(exprNode); }
    } finally {
      Object.assign(this, save);
    }
    for(let i = 0; i < n; i++) result[i] = new PineArray(buckets[i].map(k => values[k]), 'float');
    return result;
  }
  // 메인 차트 봉들을 상위 타임프레임 버킷으로 묶는다 — 우리가 가진 건 현재 차트 해상도의
  // 데이터뿐이라 그보다 더 잘게 쪼개는(하위 타임프레임 요청) 건 못 하고, 같거나 더 굵은
  // 타임프레임만 정확하게 만들 수 있다. 각 메인 봉 시점마다, lookahead_on이면 아직 안 닫힌
  // (형성 중인) 상위 봉을 [0]으로, 기본(off)이면 마지막으로 확정된 상위 봉을 [0]으로 놓고
  // expression을 한 번씩 평가한다 — 실제 request.security의 반복(repaint) 여부와 같은 규칙.
  //
  // 알려진 제약: expression 안에서는 close/open/high/low/volume/time류의 시계열(과 그 [n]
  // 과거값)만 정확하게 지원한다. 바깥 스코프의 일반 변수나 ta.* 상태 함수를 expression 안에서
  // 참조하면 (이 로컬 윈도우 전용으로 curBar를 임시로 바꿔치기하기 때문에) 정확하지 않을 수 있다.
  // 내장 시계열(close/open/high/low/hl2/...)이 어디를 가리키는지 통째로 저장/복원하기 위한 짝.
  // volArr/timeArr은 하이킨아시로 바뀌지 않으므로(거래량과 시각은 원본 그대로) 여기 없다.
  captureSeriesContext(){
    return {
      bars: this.bars, openArr: this.openArr, highArr: this.highArr, lowArr: this.lowArr, closeArr: this.closeArr,
      hl2Arr: this.hl2Arr, hlc3Arr: this.hlc3Arr, ohlc4Arr: this.ohlc4Arr, hlcc4Arr: this.hlcc4Arr,
    };
  }
  // 하이킨아시 봉으로 바꿔 낀 시계열 묶음. 정의 그대로:
  //   haClose = (O+H+L+C)/4, haOpen = 직전 (haOpen+haClose)/2, haHigh/Low = 원본과 ha 값들의 최대/최소.
  // buildSecuritySeries()가 상위 타임프레임 버킷을 만들 때 this.bars를 직접 읽으므로 bars도 같이 만든다.
  buildHeikinAshiContext(){
    const n = this.n;
    const open = new Array(n), high = new Array(n), low = new Array(n), close = new Array(n);
    let prevOpen = null, prevClose = null;
    for(let i = 0; i < n; i++){
      const o = this.openArr[i], h = this.highArr[i], l = this.lowArr[i], c = this.closeArr[i];
      const haClose = (o + h + l + c) / 4;
      const haOpen = prevOpen == null ? (o + c) / 2 : (prevOpen + prevClose) / 2;
      open[i] = haOpen; close[i] = haClose;
      high[i] = Math.max(h, haOpen, haClose);
      low[i] = Math.min(l, haOpen, haClose);
      prevOpen = haOpen; prevClose = haClose;
    }
    return {
      bars: this.bars.map((b, i) => ({ ...b, open: open[i], high: high[i], low: low[i], close: close[i] })),
      openArr: open, highArr: high, lowArr: low, closeArr: close,
      hl2Arr: high.map((h, i) => (h + low[i]) / 2),
      hlc3Arr: high.map((h, i) => (h + low[i] + close[i]) / 3),
      ohlc4Arr: high.map((h, i) => (open[i] + h + low[i] + close[i]) / 4),
      hlcc4Arr: high.map((h, i) => (h + low[i] + close[i] + close[i]) / 4),
    };
  }
  buildSecuritySeries(tf, exprNode, lookaheadOn){
    const n = this.n, bars = this.bars;
    const closedBuckets = [];
    const formingAtBar = new Array(n);
    const bucketOfBar = new Array(n);
    for(let i = 0; i < n; i++){
      const b = bars[i];
      const bId = tf ? pineTfBucket(b.time, tf) : i;
      if(!closedBuckets.length || closedBuckets[closedBuckets.length - 1]._bucketId !== bId){
        closedBuckets.push({ _bucketId: bId, open: b.open, high: b.high, low: b.low, close: b.close, volume: (b.volume || 0), time: b.time });
      } else {
        const cur = closedBuckets[closedBuckets.length - 1];
        cur.high = Math.max(cur.high, b.high);
        cur.low = Math.min(cur.low, b.low);
        cur.close = b.close;
        cur.volume += (b.volume || 0);
      }
      bucketOfBar[i] = closedBuckets.length - 1;
      const c = closedBuckets[closedBuckets.length - 1];
      formingAtBar[i] = { open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, time: c.time };
    }

    const K = 20; // expression의 [n] 히스토리 참조를 위해 넉넉히 잡아두는 로컬 창 크기
    const result = new Array(n).fill(null);
    const save = {
      openArr: this.openArr, highArr: this.highArr, lowArr: this.lowArr, closeArr: this.closeArr,
      volArr: this.volArr, timeArr: this.timeArr, timeCloseArr: this.timeCloseArr,
      hl2Arr: this.hl2Arr, hlc3Arr: this.hlc3Arr, ohlc4Arr: this.ohlc4Arr, hlcc4Arr: this.hlcc4Arr,
      curBar: this.curBar, n: this.n,
    };
    try{
      for(let i = 0; i < n; i++){
        const curBucketIdx = bucketOfBar[i];
        const zeroBucketIdx = lookaheadOn ? curBucketIdx : curBucketIdx - 1;
        const lo = new Array(K).fill(null), lh = new Array(K).fill(null), ll = new Array(K).fill(null);
        const lc = new Array(K).fill(null), lv = new Array(K).fill(null), lt = new Array(K).fill(null);
        for(let k = 0; k < K; k++){
          const bucketIdx = zeroBucketIdx - k;
          if(bucketIdx < 0) continue;
          const src = (lookaheadOn && bucketIdx === curBucketIdx) ? formingAtBar[i] : closedBuckets[bucketIdx];
          if(!src) continue;
          const slot = K - 1 - k;
          lo[slot] = src.open; lh[slot] = src.high; ll[slot] = src.low; lc[slot] = src.close; lv[slot] = src.volume; lt[slot] = src.time;
        }
        this.openArr = lo; this.highArr = lh; this.lowArr = ll; this.closeArr = lc; this.volArr = lv; this.timeArr = lt; this.timeCloseArr = lt;
        this.hl2Arr = lh.map((h, idx) => (h == null || ll[idx] == null) ? null : (h + ll[idx]) / 2);
        this.hlc3Arr = lh.map((h, idx) => (h == null || ll[idx] == null || lc[idx] == null) ? null : (h + ll[idx] + lc[idx]) / 3);
        this.ohlc4Arr = lh.map((h, idx) => (h == null || ll[idx] == null || lc[idx] == null || lo[idx] == null) ? null : (lo[idx] + h + ll[idx] + lc[idx]) / 4);
        this.hlcc4Arr = this.ohlc4Arr;
        this.curBar = K - 1; this.n = K;
        result[i] = this.evalExpr(exprNode);
      }
    } finally {
      Object.assign(this, save);
    }
    return result;
  }
  pathKey(node){
    return (this.callPath.length ? this.callPath.join('.') + '.' : '') + node.id;
  }
  evalPlotCallWithColorTracking(node){
    const posArgs = []; const namedArgs = {};
    let colorBranchKey = null;
    const hasNamedColor = node.args.some(a => a.named && a.name === 'color');
    let posIdx = 0;
    for(const a of node.args){
      if(a.named){
        if(a.name === 'color'){
          const r = this.evalColorExpr(a.value);
          namedArgs.color = r.value; colorBranchKey = r.key;
        } else namedArgs[a.name] = this.evalExpr(a.value);
      } else {
        if(!hasNamedColor && posIdx === 2){
          const r = this.evalColorExpr(a.value);
          posArgs.push(r.value); colorBranchKey = r.key;
        } else {
          posArgs.push(this.evalExpr(a.value));
        }
        posIdx++;
      }
    }
    return TOP_LEVEL_BUILTINS.plot(this, posArgs, namedArgs, node, colorBranchKey);
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
