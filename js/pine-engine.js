/* pine-engine.js
   PineScript(TradingView) v5 "지표(indicator)" 스크립트의 실용적 서브셋 렌더링 엔진.
   렉서 -> 파서(AST) -> 봉(bar) 단위로 스크립트를 처음부터 다시 실행하는 인터프리터, 순서로 구성된다.

   ── 지원 범위 ──
   지원: 변수 선언(var/varip 포함), if/else, for(카운팅/for..in), while, switch, break/continue,
        사용자 정의 함수(단일식/블록), 배열(array 전체 + myArr.push() 같은 메서드 문법),
        튜플([a,b] = ...), 흔한 ta·math·color·input 내장 함수, plot()/hline().
   미지원(만나면 즉시 에러로 중단): request 계열(외부 데이터 조회), strategy 계열(전략/백테스트),
        library/export/import(외부 라이브러리), matrix·map·table, line.new/label.new/box.new
        같은 그리기 객체, 함수 내부에 선언된 var(함수는 매 bar 새로 실행되는 걸로 단순화했기 때문에
        내부 상태를 bar 간에 들고 다닐 수 없음), 지역(함수 내부) 변수의 과거값 참조 x[1].

   ── 실행 모델 ──
   Pine은 "스크립트 전체가 매 bar마다 처음부터 다시 실행된다"는 게 핵심 모델이다. 그래서 여기서도
   똑같이: bars.length번 만큼 인터프리터가 AST 전체를 매번 다시 훑는다. var로 선언한 변수만
   이전 bar의 값을 그대로 들고 오고(persist), 일반 '=' 변수는 매 bar 새로 계산된다. */

// ============================================================
// 1. 렉서 (Lexer) — 들여쓰기가 문법인 언어라서 Python 토크나이저와 비슷한 구조로 만든다.
// ============================================================
function pineMsg(kr, en){
  try{ if(typeof state !== 'undefined' && state && state.lang === 'en') return en; }catch(e){}
  return kr;
}

class PineLexError extends Error {
  constructor(msg, line){ super(msg); this.line = line; this.pineLex = true; }
}

const PINE_KEYWORDS = new Set([
  'var','varip','if','else','for','while','to','by','in','switch',
  'break','continue','and','or','not','true','false','na',
]);

function pineTokenize(source){
  const tokens = [];
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const indentStack = [0];
  let parenDepth = 0; // 괄호/대괄호 안에서는 줄바꿈을 NEWLINE으로 안 치고 이어붙인다 (라인 연속)
  let pendingLine = ''; // 연속되는 물리적 줄을 하나의 논리적 줄로 모으는 버퍼
  let pendingStartLine = 1;

  function tokenizeLogicalLine(text, lineNo, isFirstPhysicalOfLogical){
    let i = 0;
    const n = text.length;
    // 들여쓰기 처리는 논리적 줄의 "첫 물리적 줄"에서만
    if(isFirstPhysicalOfLogical){
      let indent = 0;
      while(i < n && (text[i] === ' ' || text[i] === '\t')){ indent += (text[i] === '\t' ? 4 : 1); i++; }
      if(i >= n || text[i] === '/' && text[i+1] === '/') return; // 빈 줄/주석만 있는 줄은 무시
      if(indent > indentStack[indentStack.length - 1]){
        indentStack.push(indent);
        tokens.push({ type: 'INDENT', value: indent, line: lineNo });
      }
      while(indent < indentStack[indentStack.length - 1]){
        indentStack.pop();
        tokens.push({ type: 'DEDENT', value: indent, line: lineNo });
      }
    }
    while(i < n){
      const c = text[i];
      if(c === ' ' || c === '\t'){ i++; continue; }
      if(c === '/' && text[i+1] === '/'){ break; } // 줄 끝까지 주석
      if(c === '"' || c === "'"){
        const quote = c; let j = i + 1; let s = '';
        while(j < n && text[j] !== quote){
          if(text[j] === '\\' && j + 1 < n){ s += text[j+1]; j += 2; continue; }
          s += text[j]; j++;
        }
        tokens.push({ type: 'STRING', value: s, line: lineNo });
        i = j + 1; continue;
      }
      if(c === '#' && /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?\b/.test(text.slice(i))){
        const m = text.slice(i).match(/^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?/);
        tokens.push({ type: 'STRING', value: m[0], line: lineNo }); // 색상 리터럴은 그냥 "#rrggbb" 문자열 값으로 취급 (color.new 등과 동일하게 다뤄짐)
        i += m[0].length; continue;
      }
      if(/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i+1] || ''))){
        let j = i; let s = '';
        while(j < n && /[0-9.]/.test(text[j])) { s += text[j]; j++; }
        if(text[j] === 'e' || text[j] === 'E'){ s += text[j]; j++; if(text[j]==='+'||text[j]==='-'){ s+=text[j]; j++; } while(j<n && /[0-9]/.test(text[j])){ s+=text[j]; j++; } }
        tokens.push({ type: 'NUMBER', value: parseFloat(s), line: lineNo });
        i = j; continue;
      }
      if(/[A-Za-z_]/.test(c)){
        let j = i; let s = '';
        while(j < n && /[A-Za-z0-9_]/.test(text[j])) { s += text[j]; j++; }
        tokens.push({ type: PINE_KEYWORDS.has(s) ? 'KEYWORD' : 'IDENT', value: s, line: lineNo });
        i = j; continue;
      }
      // 다중 문자 연산자
      const two = text.substr(i, 2);
      if(['=>',':=','==','!=','<=','>=','+=','-=','*=','/=','%='].includes(two)){
        tokens.push({ type: 'OP', value: two, line: lineNo }); i += 2; continue;
      }
      if('()[]{},.:?'.includes(c)){
        if(c === '(' || c === '[' || c === '{') parenDepth++;
        if(c === ')' || c === ']' || c === '}') parenDepth = Math.max(0, parenDepth - 1);
        tokens.push({ type: 'OP', value: c, line: lineNo }); i++; continue;
      }
      if('=<>+-*/%'.includes(c)){ tokens.push({ type: 'OP', value: c, line: lineNo }); i++; continue; }
      throw new PineLexError(pineMsg(`알 수 없는 문자 '${c}'`, `Unknown character '${c}'`), lineNo);
    }
  }

  for(let li = 0; li < lines.length; li++){
    const raw = lines[li];
    const lineNo = li + 1;
    const trimmedEndsInContinuation = parenDepth > 0;
    if(pendingLine === '') pendingStartLine = lineNo;
    if(trimmedEndsInContinuation){
      pendingLine += (pendingLine ? '\n' : '') + raw;
      // 괄호 안이므로 아직 논리적 줄이 안 끝남 - 다음 물리적 줄과 합친다
      // (들여쓰기 판정은 pendingStartLine에서 이미 했으므로, 계속되는 줄은 isFirstPhysicalOfLogical=false로 넘김)
      tokenizeLogicalLine(raw, lineNo, pendingLine.indexOf('\n') === raw.length ? true : (pendingStartLine === lineNo));
      continue;
    }
    if(pendingLine){
      // 방금까지 이어지던 논리적 줄의 마지막 물리적 줄
      tokenizeLogicalLine(raw, lineNo, false);
      pendingLine = '';
    } else {
      tokenizeLogicalLine(raw, lineNo, true);
    }
    if(parenDepth === 0){
      tokens.push({ type: 'NEWLINE', value: '\n', line: lineNo });
    } else {
      pendingLine = raw; // 다음 줄과 이어붙여야 함을 표시
    }
  }
  while(indentStack.length > 1){ indentStack.pop(); tokens.push({ type: 'DEDENT', value: 0, line: lines.length }); }
  tokens.push({ type: 'EOF', value: null, line: lines.length + 1 });
  return tokens;
}

// ============================================================
// 2. 파서 (Parser) — 재귀 하강. AST를 만든다.
// ============================================================
class PineParseError extends Error {
  constructor(msg, line){ super(msg); this.line = line; this.pineParse = true; }
}

const PINE_TYPE_WORDS = new Set(['int','float','bool','string','color','label','line','box','table','array','matrix','map','series','simple','const']);

class PineParser {
  constructor(tokens){
    this.toks = tokens.filter(t => true);
    this.pos = 0;
    this.nodeIdCounter = 1;
  }
  peek(o = 0){ return this.toks[this.pos + o]; }
  at(type, value){
    const t = this.peek();
    if(t.type !== type) return false;
    if(value !== undefined && t.value !== value) return false;
    return true;
  }
  atOp(v){ return this.at('OP', v); }
  atKw(v){ return this.at('KEYWORD', v); }
  next(){ return this.toks[this.pos++]; }
  expectOp(v){
    if(!this.atOp(v)) throw new PineParseError(pineMsg(`'${v}' 가 와야 하는데 '${this.peek().value}' 를 만났습니다`, `Expected '${v}' but found '${this.peek().value}'`), this.peek().line);
    return this.next();
  }
  skipNewlines(){ while(this.at('NEWLINE')) this.next(); }

  parseProgram(){
    const body = [];
    this.skipNewlines();
    while(!this.at('EOF')){
      body.push(this.parseStatement());
      this.skipNewlines();
    }
    return { type: 'Program', body };
  }

  // 블록: NEWLINE INDENT 문장들 DEDENT
  parseBlock(){
    this.skipNewlines();
    if(!this.at('INDENT')) throw new PineParseError(pineMsg('들여쓰기된 블록이 와야 합니다', 'An indented block is required here'), this.peek().line);
    this.next();
    const body = [];
    this.skipNewlines();
    while(!this.at('DEDENT') && !this.at('EOF')){
      body.push(this.parseStatement());
      this.skipNewlines();
    }
    if(this.at('DEDENT')) this.next();
    return body;
  }

  looksLikeTypeAnnotation(){
    // "int len = ..." / "array<float> a = ..." / "series float x = ..." 같은 타입 접두사 감지
    let o = 0;
    if(this.peek(o).type === 'IDENT' && PINE_TYPE_WORDS.has(this.peek(o).value)){
      o++;
      if(this.peek(o).type === 'OP' && this.peek(o).value === '<'){
        // 제네릭 <...> 건너뛰기
        let depth = 1; o++;
        while(depth > 0 && this.peek(o).type !== 'EOF'){
          if(this.peek(o).type === 'OP' && this.peek(o).value === '<') depth++;
          if(this.peek(o).type === 'OP' && this.peek(o).value === '>') depth--;
          o++;
        }
      }
      if(this.peek(o).type === 'OP' && this.peek(o).value === '[' && this.peek(o+1).type === 'OP' && this.peek(o+1).value === ']') o += 2;
      // 그 다음 IDENT '=' 이면 확실히 타입 선언
      if(this.peek(o).type === 'IDENT' && this.peek(o+1).type === 'OP' && (this.peek(o+1).value === '=' || this.peek(o+1).value === ',')){
        return o; // 소비해야 할 토큰 개수
      }
    }
    return 0;
  }

  looksLikeTupleAssignment(){
    let depth = 0, o = 0;
    do {
      const t = this.peek(o);
      if(t.type === 'EOF') return false;
      if(t.type === 'OP' && t.value === '[') depth++;
      if(t.type === 'OP' && t.value === ']') depth--;
      o++;
    } while(depth > 0);
    const after = this.peek(o);
    return after.type === 'OP' && (after.value === '=' || after.value === ':=');
  }
  parseStatement(){
    const line = this.peek().line;
    if(this.at('IDENT', 'type') && this.peek(1).type === 'IDENT' && this.peek(2).type === 'NEWLINE'){
      throw new PineParseError(pineMsg(
        '사용자 정의 타입(type/구조체)은 지원하지 않습니다: type ' + this.peek(1).value,
        'User-defined types (struct-like "type" declarations) are not supported: type ' + this.peek(1).value
      ), line);
    }
    if(this.atKw('var') || this.atKw('varip')){
      const isVar = true; this.next();
      // var 뒤에도 타입 접두사가 올 수 있음 (var float x = na)
      const skip = this.looksLikeTypeAnnotation();
      for(let k = 0; k < skip; k++) this.next();
      return this.finishVarDecl(isVar, line);
    }
    const typeSkip = this.looksLikeTypeAnnotation();
    if(typeSkip){
      for(let k = 0; k < typeSkip; k++) this.next();
      return this.finishVarDecl(false, line);
    }
    if(this.atOp('[') && this.looksLikeTupleAssignment()) return this.parseTupleStatement(line);
    if(this.atKw('if')) return this.parseIf();
    if(this.atKw('for')) return this.parseForOrForIn();
    if(this.atKw('while')) return this.parseWhile();
    if(this.atKw('switch')) return this.parseSwitch();
    if(this.at('IDENT') && this.peek().value === 'break' ){ /* handled via keyword list normally */ }
    if(this.atKw('break')){ this.next(); return { type: 'Break', line }; }
    if(this.atKw('continue')){ this.next(); return { type: 'Continue', line }; }

    const expr = this.parseExprList();
    if(this.atOp('=>')){
      this.next();
      return this.finishFuncDecl(expr, line);
    }
    if(this.atOp('=')){
      this.next();
      if(expr.type !== 'Ident') throw new PineParseError(pineMsg('할당 대상은 단순 변수명이어야 합니다', 'Assignment target must be a simple variable name'), line);
      const init = this.parseExprList();
      return { type: 'VarDecl', isVar: false, name: expr.name, init, line };
    }
    if(this.atOp(':=') || ['+=','-=','*=','/=','%='].includes(this.peek().value)){
      const opTok = this.next();
      if(expr.type !== 'Ident') throw new PineParseError(pineMsg('재할당 대상은 단순 변수명이어야 합니다', 'Reassignment target must be a simple variable name'), line);
      let value = this.parseExprList();
      if(opTok.value !== ':='){
        const binOp = opTok.value[0];
        value = { type: 'Binary', op: binOp, left: { type: 'Ident', name: expr.name, line }, right: value, line };
      }
      return { type: 'Reassign', name: expr.name, value, line };
    }
    return { type: 'ExprStmt', expr, line };
  }

  // 콤마로 이어진 식 목록(튜플 반환용): a, b, c
  parseExprList(){
    const first = this.parseTernary();
    if(this.atOp(',')){
      const items = [first];
      while(this.atOp(',')){ this.next(); items.push(this.parseTernary()); }
      return { type: 'ExprList', items, line: first.line };
    }
    return first;
  }

  parseTupleStatement(line){
    this.expectOp('[');
    const names = [];
    while(!this.atOp(']')){
      const t = this.next();
      if(t.type !== 'IDENT') throw new PineParseError(pineMsg('튜플 요소는 변수명이어야 합니다', 'Tuple elements must be variable names'), line);
      names.push(t.value);
      if(this.atOp(',')) this.next();
    }
    this.expectOp(']');
    const isAssign = this.atOp('=');
    const isReassign = this.atOp(':=');
    if(!isAssign && !isReassign) throw new PineParseError(pineMsg("튜플 뒤에는 '=' 또는 ':=' 가 와야 합니다", "Tuple must be followed by '=' or ':='"), line);
    this.next();
    const value = this.parseExprList();
    return { type: isAssign ? 'TupleDecl' : 'TupleReassign', names, value, line };
  }

  finishVarDecl(isVar, line){
    const t = this.next();
    if(t.type !== 'IDENT') throw new PineParseError(pineMsg('변수명이 와야 합니다', 'A variable name is required'), line);
    const name = t.value;
    if(!this.atOp('=')){
      // 초기값 없는 선언 (예: `float x`) - na로 초기화
      return { type: 'VarDecl', isVar, name, init: { type: 'Na', line }, line };
    }
    this.next();
    const init = this.parseExprList();
    return { type: 'VarDecl', isVar, name, init, line };
  }

  // 함수 선언으로 변환: callExpr는 Call(callee=Ident, args=[Ident 또는 named(Ident=default)])
  finishFuncDecl(callExpr, line){
    if(callExpr.type !== 'Call' || callExpr.callee.type !== 'Ident'){
      throw new PineParseError(pineMsg("'=>' 앞에는 'funcName(params)' 형태가 와야 합니다", "'=>' must be preceded by 'funcName(params)'"), line);
    }
    const params = [];
    for(const a of callExpr.args){
      if(a.named){ params.push({ name: a.name, default: a.value }); }
      else if(a.value.type === 'Ident'){ params.push({ name: a.value.name, default: null }); }
      else throw new PineParseError(pineMsg('함수 매개변수는 변수명이어야 합니다', 'Function parameters must be variable names'), line);
    }
    let body;
    if(this.at('NEWLINE')){
      body = this.parseBlock();
    } else {
      body = [{ type: 'ExprStmt', expr: this.parseExprList(), line }];
    }
    return { type: 'FuncDecl', name: callExpr.callee.name, params, body, line };
  }

  parseIf(){
    const line = this.peek().line; this.next(); // 'if'
    const cond = this.parseExprList();
    const then = this.at('NEWLINE') ? this.parseBlock() : [{ type: 'ExprStmt', expr: this.parseExprList(), line }];
    let elseBody = null;
    // else / else if 는 같은 들여쓰기 레벨에 있어야 하므로, 블록을 소비한 다음 바로 다음 토큰을 본다
    this.skipNewlinesIfNoDedentAhead();
    if(this.atKw('else')){
      this.next();
      if(this.atKw('if')){
        elseBody = [this.parseIf()];
      } else {
        elseBody = this.at('NEWLINE') ? this.parseBlock() : [{ type: 'ExprStmt', expr: this.parseExprList(), line }];
      }
    }
    return { type: 'If', cond, then, elseBody, line };
  }
  // else가 다음 줄에 오는 경우를 위해, 블록이 끝난 직후 NEWLINE들을 살짝 미리보기
  skipNewlinesIfNoDedentAhead(){
    let o = 0;
    while(this.peek(o).type === 'NEWLINE') o++;
    if(this.peek(o).type === 'KEYWORD' && this.peek(o).value === 'else'){
      while(this.at('NEWLINE')) this.next();
    }
  }

  parseForOrForIn(){
    const line = this.peek().line; this.next(); // 'for'
    const nameTok = this.next();
    if(nameTok.type !== 'IDENT') throw new PineParseError(pineMsg('for 변수명이 필요합니다', 'A for-loop variable name is required'), line);
    let idxName = null;
    if(this.atOp(',')){
      this.next();
      const idxTok = this.next();
      if(idxTok.type !== 'IDENT') throw new PineParseError(pineMsg('for 인덱스 변수명이 필요합니다', 'A for-loop index variable name is required'), line);
      idxName = idxTok.value;
    }
    if(this.atKw('in')){
      this.next();
      const iterable = this.parseTernary();
      const body = this.parseBlock();
      return { type: 'ForIn', varName: nameTok.value, idxName, iterable, body, line };
    }
    this.expectOp('=');
    const from = this.parseTernary();
    if(!this.atKw('to')) throw new PineParseError(pineMsg("for 문에는 'to' 가 필요합니다", "'to' is required in a for statement"), line);
    this.next();
    const to = this.parseTernary();
    let step = null;
    if(this.atKw('by')){ this.next(); step = this.parseTernary(); }
    const body = this.parseBlock();
    return { type: 'For', varName: nameTok.value, from, to, step, body, line };
  }

  parseWhile(){
    const line = this.peek().line; this.next();
    const cond = this.parseExprList();
    const body = this.parseBlock();
    return { type: 'While', cond, body, line };
  }

  parseSwitch(){
    const line = this.peek().line; this.next(); // 'switch' (IDENT, 예약어 아님)
    let subject = null;
    if(!this.at('NEWLINE')) subject = this.parseExprList();
    this.skipNewlines();
    if(!this.at('INDENT')) throw new PineParseError(pineMsg('switch 블록이 필요합니다', 'A switch block is required'), line);
    this.next();
    const cases = []; let def = null;
    while(!this.at('DEDENT') && !this.at('EOF')){
      this.skipNewlines();
      if(this.at('DEDENT') || this.at('EOF')) break;
      if(this.atOp('=>')){
        this.next();
        def = this.at('NEWLINE') ? this.parseBlock() : [{ type: 'ExprStmt', expr: this.parseExprList(), line }];
      } else {
        const val = this.parseExprList();
        this.expectOp('=>');
        const body = this.at('NEWLINE') ? this.parseBlock() : [{ type: 'ExprStmt', expr: this.parseExprList(), line }];
        cases.push({ val, body });
      }
      this.skipNewlines();
    }
    if(this.at('DEDENT')) this.next();
    return { type: 'Switch', subject, cases, def, line };
  }

  // ---- 식(expression) 파서 체인 ----
  parseTernary(){
    const cond = this.parseOr();
    if(this.atOp('?')){
      this.next();
      const a = this.parseTernary();
      this.expectOp(':');
      const b = this.parseTernary();
      return { type: 'Ternary', cond, then: a, else: b, line: cond.line };
    }
    return cond;
  }
  parseOr(){
    let l = this.parseAnd();
    while(this.atKw('or')){ this.next(); const r = this.parseAnd(); l = { type: 'Binary', op: 'or', left: l, right: r, line: l.line }; }
    return l;
  }
  parseAnd(){
    let l = this.parseNot();
    while(this.atKw('and')){ this.next(); const r = this.parseNot(); l = { type: 'Binary', op: 'and', left: l, right: r, line: l.line }; }
    return l;
  }
  parseNot(){
    if(this.atKw('not')){ const line = this.peek().line; this.next(); return { type: 'Unary', op: 'not', arg: this.parseNot(), line }; }
    return this.parseCompare();
  }
  parseCompare(){
    let l = this.parseAdd();
    while(['==','!=','<','>','<=','>='].includes(this.peek().value) && this.peek().type === 'OP'){
      const op = this.next().value; const r = this.parseAdd();
      l = { type: 'Binary', op, left: l, right: r, line: l.line };
    }
    return l;
  }
  parseAdd(){
    let l = this.parseMul();
    while((this.atOp('+') || this.atOp('-'))){
      const op = this.next().value; const r = this.parseMul();
      l = { type: 'Binary', op, left: l, right: r, line: l.line };
    }
    return l;
  }
  parseMul(){
    let l = this.parseUnary();
    while(this.atOp('*') || this.atOp('/') || this.atOp('%')){
      const op = this.next().value; const r = this.parseUnary();
      l = { type: 'Binary', op, left: l, right: r, line: l.line };
    }
    return l;
  }
  parseUnary(){
    if(this.atOp('-') || this.atOp('+')){
      const op = this.next().value; const arg = this.parseUnary();
      return { type: 'Unary', op, arg, line: arg.line };
    }
    return this.parsePostfix();
  }
  parsePostfix(){
    let node = this.parsePrimary();
    for(;;){
      if(this.atOp('.')){
        this.next();
        const t = this.next();
        if(t.type !== 'IDENT') throw new PineParseError(pineMsg('. 뒤에는 이름이 와야 합니다', "A name must follow '.'"), t.line);
        node = { type: 'Member', obj: node, prop: t.value, line: node.line };
      } else if(this.atOp('(')){
        node = { type: 'Call', callee: node, args: this.parseArgs(), line: node.line, id: this.nodeIdCounter++ };
      } else if(this.atOp('[')){
        this.next();
        const idx = this.parseTernary();
        this.expectOp(']');
        node = { type: 'Index', obj: node, index: idx, line: node.line };
      } else break;
    }
    return node;
  }
  parseArgs(){
    this.expectOp('(');
    const args = [];
    this.skipNewlines();
    while(!this.atOp(')')){
      this.skipNewlines();
      // named arg: IDENT '=' Expr  (단, IDENT '==' 같은 비교 연산은 제외해야 하므로 다음 토큰이 '=' 하나인지 확인)
      if(this.at('IDENT') && this.peek(1).type === 'OP' && this.peek(1).value === '='){
        const nameTok = this.next(); this.next();
        const value = this.parseTernary();
        args.push({ named: true, name: nameTok.value, value });
      } else {
        args.push({ named: false, value: this.parseTernary() });
      }
      this.skipNewlines();
      if(this.atOp(',')){ this.next(); this.skipNewlines(); }
    }
    this.expectOp(')');
    return args;
  }
  parsePrimary(){
    const t = this.peek();
    if(t.type === 'NUMBER'){ this.next(); return { type: 'Number', value: t.value, line: t.line }; }
    if(t.type === 'STRING'){ this.next(); return { type: 'String', value: t.value, line: t.line }; }
    if(t.type === 'KEYWORD' && t.value === 'true'){ this.next(); return { type: 'Bool', value: true, line: t.line }; }
    if(t.type === 'KEYWORD' && t.value === 'false'){ this.next(); return { type: 'Bool', value: false, line: t.line }; }
    if(t.type === 'KEYWORD' && t.value === 'na'){
      if(this.peek(1).type === 'OP' && this.peek(1).value === '('){ this.next(); return { type: 'Ident', name: 'na', line: t.line }; }
      this.next(); return { type: 'Na', line: t.line };
    }
    if(t.type === 'KEYWORD' && t.value === 'if'){ return this.parseIf(); }
    if(t.type === 'KEYWORD' && t.value === 'switch'){ return this.parseSwitch(); }
    if(t.type === 'IDENT'){ this.next(); return { type: 'Ident', name: t.value, line: t.line }; }
    if(t.type === 'OP' && t.value === '('){
      this.next();
      this.skipNewlines();
      const e = this.parseExprList();
      this.skipNewlines();
      this.expectOp(')');
      return e;
    }
    if(t.type === 'OP' && t.value === '['){
      this.next();
      this.skipNewlines();
      const items = [];
      while(!this.atOp(']')){
        items.push(this.parseTernary());
        this.skipNewlines();
        if(this.atOp(',')){ this.next(); this.skipNewlines(); }
      }
      this.expectOp(']');
      return { type: 'ArrayLiteral', items, line: t.line };
    }
    throw new PineParseError(pineMsg(`예상치 못한 토큰 '${t.value === null ? t.type : t.value}'`, `Unexpected token '${t.value === null ? t.type : t.value}'`), t.line);
  }
}

function pineParse(source){
  const tokens = pineTokenize(source);
  const parser = new PineParser(tokens);
  return parser.parseProgram();
}
