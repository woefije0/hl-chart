/* pine-engine.js
   PineScript(TradingView) v5 "지표(indicator)" 스크립트의 실용적 서브셋 렌더링 엔진.
   렉서 -> 파서(AST) -> 봉(bar) 단위로 스크립트를 처음부터 다시 실행하는 인터프리터, 순서로 구성된다.

   지원 범위와 알려진 제약(request.security 한계, method 오버로딩 한계 등)은 계속 늘어나서 여기
   주석으로는 관리가 안 돼 프로젝트 루트의 PINE_ENGINE.md로 옮겼다 — 최신 내용은 그쪽 참고.
   (사용자 정의 함수 내부의 var도 bar 간 상태가 유지되고, line.new/box.new/label.new 같은 그리기
   객체나 request.security()도 이제 지원한다 — 예전엔 여기 미지원으로 적혀 있었지만 바뀌었다.)

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
  // 줄 끝이 이 연산자들 중 하나면 그 줄은 아직 식이 안 끝난 것 — 뒤에 피연산자가 반드시 와야 한다.
  // 예: 여러 줄에 걸친 삼항연산자 체인(`a ? b : c ?\n  d : e ?\n  f : g`)처럼 다음 줄이 ':'로
  // 시작하지 않고 통째로 새 비교식으로 시작하는 경우, 기존의 "다음 줄이 ':'로 시작하면 이어붙인다"
  // 처리만으로는 못 잡는다. 여기 연산자들은 Pine 문법상 뒤에 반드시 피연산자가 와야 하므로, 다음
  // 줄이 현재 문장보다 더 들여써져 있기만 하면 안전하게(블록 시작과 헷갈릴 일 없이) 이어붙일 수 있다.
  const CONTINUATION_TRAILING_OPS = new Set(['?',':',',','+','-','*','/','%','==','!=','<=','>=','<','>','=',':=','+=','-=','*=','/=','%=']);
  const CONTINUATION_TRAILING_KEYWORDS = new Set(['and','or','not']);
  function lastMeaningfulToken(){
    for(let k = tokens.length - 1; k >= 0; k--){
      if(tokens[k].type === 'NEWLINE' || tokens[k].type === 'INDENT' || tokens[k].type === 'DEDENT') continue;
      return tokens[k];
    }
    return null;
  }
  function endsWithContinuationOp(){
    const t = lastMeaningfulToken();
    if(!t) return false;
    if(t.type === 'OP') return CONTINUATION_TRAILING_OPS.has(t.value);
    if(t.type === 'KEYWORD') return CONTINUATION_TRAILING_KEYWORDS.has(t.value);
    return false;
  }
  function leadingIndentOf(line){
    let ind = 0, k = 0;
    while(k < line.length && (line[k] === ' ' || line[k] === '\t')){ ind += (line[k] === '\t' ? 4 : 1); k++; }
    return ind;
  }

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
      // 괄호 없이도 삼항연산자가 다음 줄로 이어지는 경우 — 예:
      //   os := high[len] > upper ? 0
      //     : low[len] < lower ? 1 : os
      // 들여쓰기 깊이만으로는 if/for 같은 블록 시작과 구별이 안 되므로, 두 가지 안전한 신호로만
      // 좁혀서 감지한다: (1) 다음 줄이 문장의 맨 앞에는 절대 올 수 없는 ':'로 시작하거나,
      // (2) 지금 줄이 반드시 피연산자를 필요로 하는 연산자로 끝나는 경우(다음 줄이 이 문장보다
      // 더 들여써져 있을 때만 — 그래야 새 블록의 시작과 안 헷갈린다).
      const stmtIndent = leadingIndentOf(raw);
      let nextIdx = li + 1;
      for(;;){
        if(nextIdx >= lines.length) break;
        const startsWithColon = /^[ \t]*:/.test(lines[nextIdx]);
        const trailingOpContinuation = endsWithContinuationOp() && leadingIndentOf(lines[nextIdx]) > stmtIndent && lines[nextIdx].trim() !== '' && !/^[ \t]*\/\//.test(lines[nextIdx]);
        if(!startsWithColon && !trailingOpContinuation) break;
        li = nextIdx;
        tokenizeLogicalLine(lines[li], li + 1, false);
        nextIdx = li + 1;
      }
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
    this.toks = tokens; // (예전엔 filter(t => true)로 통째로 복사했다 — 아무것도 안 거르는 사본이라 낭비)
    this.pos = 0;
    this.nodeIdCounter = 1;
    // 'type Name' 선언들을 미리 한 번 훑어서 이름만 모아둔다 — 본 파싱(재귀 하강, 위→아래 한 번)
    // 중에 "swing top = ..." 같은 줄을 만났을 때, 'swing'이 사용자 정의 타입 이름이라는 걸
    // 그 자리에서 바로 알아야 타입 접두사로 인식하고 건너뛸 수 있기 때문.
    this.userTypeNames = new Set();
    for(let i = 0; i < this.toks.length - 2; i++){
      if(this.toks[i].type === 'IDENT' && this.toks[i].value === 'type' && this.toks[i + 1].type === 'IDENT' && this.toks[i + 2].type === 'NEWLINE'){
        this.userTypeNames.add(this.toks[i + 1].value);
      }
    }
  }
  isTypeWord(name){ return PINE_TYPE_WORDS.has(name) || this.userTypeNames.has(name); }
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
    // (내장 타입 이름뿐 아니라 스크립트가 'type' 으로 선언한 사용자 정의 타입 이름도 포함)
    let o = 0;
    if(this.peek(o).type === 'IDENT' && this.isTypeWord(this.peek(o).value)){
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
      return this.parseTypeDecl();
    }
    // 'method'는 예약어가 아니라 문맥으로만 판단하는 소프트 키워드(switch와 같은 방식) —
    // 실제 파싱은 일반 함수 선언과 동일하고, 나중에 점(.) 호출로도 쓸 수 있다는 표시만 다르다.
    if(this.at('IDENT', 'method') && this.peek(1).type === 'IDENT'){
      this.next();
      const mExpr = this.parseExprList();
      if(!this.atOp('=>')) throw new PineParseError(pineMsg("'method' 뒤에는 함수 정의가 와야 합니다", "'method' must be followed by a function definition"), line);
      this.next();
      return this.finishFuncDecl(mExpr, line, true);
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
      const init = this.parseAssignInit();
      const stmt = { type: 'VarDecl', isVar: false, name: expr.name, init, line };
      return this.chainCommaStatements(stmt, line);
    }
    if(this.atOp(':=') || ['+=','-=','*=','/=','%='].includes(this.peek().value)){
      const opTok = this.next();
      // obj.field := value — 사용자 정의 타입(struct) 인스턴스의 필드를 직접 재할당하는 흔한 패턴
      if(expr.type === 'Member'){
        let value = this.parseExprList();
        if(opTok.value !== ':='){
          const binOp = opTok.value[0];
          value = { type: 'Binary', op: binOp, left: expr, right: value, line };
        }
        return { type: 'FieldReassign', target: expr, value, line };
      }
      if(expr.type !== 'Ident') throw new PineParseError(pineMsg("재할당 대상은 단순 변수명이거나 필드 접근(obj.field)이어야 합니다", "Reassignment target must be a simple variable name or a field access (obj.field)"), line);
      let value = this.parseExprList();
      if(opTok.value !== ':='){
        const binOp = opTok.value[0];
        value = { type: 'Binary', op: binOp, left: { type: 'Ident', name: expr.name, line }, right: value, line };
      }
      return { type: 'Reassign', name: expr.name, value, line };
    }
    return { type: 'ExprStmt', expr, line };
  }

  // type Name \n INDENT (타입어 필드명 [= 기본값])* DEDENT — struct와 비슷한 사용자 정의 타입 선언.
  // 필드 줄은 항상 "타입 필드명 [= 기본값]" 형태라서(Pine은 struct 필드에 타입 표기가 필수),
  // 맨 앞의 타입 부분(제네릭 <..>, 배열 [] 접미사 포함)은 값 자체는 안 쓰고 그냥 건너뛴다.
  parseTypeDecl(){
    const line = this.peek().line;
    this.next(); // 'type'
    const nameTok = this.next();
    if(nameTok.type !== 'IDENT') throw new PineParseError(pineMsg('타입 이름이 와야 합니다', 'A type name is required'), line);
    this.skipNewlines();
    if(!this.at('INDENT')) throw new PineParseError(pineMsg('타입 필드 블록이 필요합니다', 'An indented field block is required'), line);
    this.next();
    const fields = [];
    this.skipNewlines();
    while(!this.at('DEDENT') && !this.at('EOF')){
      const fLine = this.peek().line;
      // 필드 줄은 항상 타입 표기로 시작한다(생략 불가) — "array<float> samples"처럼 타입 이름
      // 바로 뒤에 필드명이 아니라 제네릭 <...>가 먼저 올 수도 있어서, 다음 토큰이 IDENT인지
      // 미리 확인하지 않고 무조건 맨 앞 IDENT를 타입으로 보고 건너뛴다.
      if(this.at('IDENT')){
        this.next(); // 필드의 타입 이름
        if(this.atOp('<')){
          let depth = 1; this.next();
          while(depth > 0 && !this.at('EOF')){
            if(this.atOp('<')) depth++;
            if(this.atOp('>')) depth--;
            this.next();
          }
        }
        if(this.atOp('[') && this.peek(1).type === 'OP' && this.peek(1).value === ']'){ this.next(); this.next(); }
      }
      const fnameTok = this.next();
      if(fnameTok.type !== 'IDENT') throw new PineParseError(pineMsg('필드 이름이 와야 합니다', 'A field name is required'), fLine);
      let def = null;
      if(this.atOp('=')){ this.next(); def = this.parseExprList(); }
      fields.push({ name: fnameTok.value, default: def, line: fLine });
      this.skipNewlines();
    }
    if(this.at('DEDENT')) this.next();
    return { type: 'TypeDecl', name: nameTok.value, fields, line };
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

  // 대입문(`x = ...`)의 우변 전용 파서. parseExprList와 거의 같지만, 콤마 뒤가 새 문장의 시작처럼
  // 보이면(예: `IDENT = ...`, `var IDENT = ...`) 그 콤마를 튜플 목록의 일부로 먹어버리지 않고 그대로
  // 남겨둔다 — Pine v1~v3 스크립트에는 `a = expr1, b = expr2`처럼 한 줄에 콤마로 여러 대입문을 잇는
  // 관용구가 흔한데, 스칼라 변수 하나에 튜플을 대입하는 건애초에 말이 안 되므로 이 경우 콤마는 항상
  // "다음 문장 시작"으로 해석하는 게 맞다. 진짜 튜플 반환(예: 함수 마지막 줄의 bare `a, b`)은 그
  // 자리에서 직접 parseExprList를 쓰므로 여기선 영향 없다.
  parseAssignInit(){
    const first = this.parseTernary();
    if(this.atOp(',') && this.commaStartsNewStatement()) return first;
    if(this.atOp(',')){
      const items = [first];
      while(this.atOp(',') && !this.commaStartsNewStatement()){ this.next(); items.push(this.parseTernary()); }
      return items.length > 1 ? { type: 'ExprList', items, line: first.line } : items[0];
    }
    return first;
  }
  // 호출 시점에 현재 토큰이 ',' 라고 가정한다. 콤마 다음이 새 문장의 시작 모양(단순 대입,
  // var/varip 선언, 타입 접두사 선언)이면 true.
  commaStartsNewStatement(){
    const n1 = this.peek(1), n2 = this.peek(2);
    if(n1.type === 'IDENT' && (n1.value === 'var' || n1.value === 'varip')) return true;
    if(n1.type === 'IDENT' && n2.type === 'OP' && n2.value === '=') return true;
    return false;
  }
  // 문장 파싱 후 현재 토큰이 "새 문장을 잇는 콤마"이면 계속 이어 파싱해서 하나로 묶어 반환한다.
  // 콤마가 아니거나(보통의 한 줄 한 문장) 다음 문장 모양이 아니면(진짜 튜플 표현식 등) 원래
  // 문장을 그대로 반환한다 — 그런 경우는 각자의 파서(parseExprList 등)가 이미 처리했을 것.
  chainCommaStatements(firstStmt, line){
    if(!(this.atOp(',') && this.commaStartsNewStatement())) return firstStmt;
    const stmts = [firstStmt];
    while(this.atOp(',') && this.commaStartsNewStatement()){
      this.next();
      stmts.push(this.parseStatement());
    }
    return { type: 'Seq', stmts, line };
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
    const init = this.parseAssignInit();
    const stmt = { type: 'VarDecl', isVar, name, init, line };
    return this.chainCommaStatements(stmt, line);
  }

  // 함수 선언으로 변환: callExpr는 Call(callee=Ident, args=[Ident 또는 named(Ident=default)])
  // isMethod가 true면 'method' 접두사로 선언된 함수 — 첫 매개변수의 타입 표기를 기억해뒀다가
  // (methodOfType) 나중에 obj.funcName(...) 점(dot) 호출로도 실행할 수 있게 한다.
  finishFuncDecl(callExpr, line, isMethod){
    if(callExpr.type !== 'Call' || callExpr.callee.type !== 'Ident'){
      throw new PineParseError(pineMsg("'=>' 앞에는 'funcName(params)' 형태가 와야 합니다", "'=>' must be preceded by 'funcName(params)'"), line);
    }
    const params = [];
    // Pine은 매개변수에 타입을 붙일 수 있다: ma(float source, int length, simple string maType) =>
    // 파서는 'float'와 'source'를 각각 별개 인자로 읽으므로, 뒤에 이름이 더 따라오는 타입 단어는
    // 매개변수가 아니라 '타입 수식어'로 보고 건너뛴다(내장 타입 이름뿐 아니라 사용자 정의 타입도).
    const rawArgs = callExpr.args;
    let methodOfType = null;
    for(let i = 0; i < rawArgs.length; i++){
      const a = rawArgs[i];
      if(!a.named && a.value.type === 'Ident' && this.isTypeWord(a.value.name) && i + 1 < rawArgs.length){
        if(isMethod && params.length === 0 && methodOfType === null) methodOfType = a.value.name;
        // 다음 인자는 무조건 매개변수 이름이다 — 곧바로 여기서 소비해야 한다. 그냥 continue로
        // 다음 반복에 맡기면, 매개변수 이름이 타입 단어와 우연히 같을 때(예: 사용자 타입 kz를 받는
        // 'kz kz' 매개변수) 그 이름 토큰이 또 다른 타입 수식어로 오인되어 건너뛰어지고, 뒤따르는
        // 모든 매개변수가 한 칸씩 밀려버린다.
        i++;
        const nameArg = rawArgs[i];
        if(nameArg.named){ params.push({ name: nameArg.name, default: nameArg.value }); }
        else if(nameArg.value.type === 'Ident'){ params.push({ name: nameArg.value.name, default: null }); }
        else throw new PineParseError(pineMsg('함수 매개변수는 변수명이어야 합니다', 'Function parameters must be variable names'), line);
        continue;
      }
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
    return { type: 'FuncDecl', name: callExpr.callee.name, params, body, line, isMethod: !!isMethod, methodOfType };
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
    let varName, idxName = null;
    if(this.atOp('[')){
      // for [index, element] in array — 실제 Pine의 인덱스+값 동시 순회 문법(카운팅 for는
      // 절대 '['로 시작하지 않으므로 여기서 구분해도 안전하다). 대괄호 안은 인덱스가 먼저다.
      this.next();
      const idxTok = this.next();
      if(idxTok.type !== 'IDENT') throw new PineParseError(pineMsg('for 인덱스 변수명이 필요합니다', 'A for-loop index variable name is required'), line);
      idxName = idxTok.value;
      this.expectOp(',');
      const valTok = this.next();
      if(valTok.type !== 'IDENT') throw new PineParseError(pineMsg('for 변수명이 필요합니다', 'A for-loop variable name is required'), line);
      varName = valTok.value;
      this.expectOp(']');
    } else {
      const nameTok = this.next();
      if(nameTok.type !== 'IDENT') throw new PineParseError(pineMsg('for 변수명이 필요합니다', 'A for-loop variable name is required'), line);
      varName = nameTok.value;
      if(this.atOp(',')){
        this.next();
        const idxTok = this.next();
        if(idxTok.type !== 'IDENT') throw new PineParseError(pineMsg('for 인덱스 변수명이 필요합니다', 'A for-loop index variable name is required'), line);
        idxName = idxTok.value;
      }
    }
    if(this.atKw('in')){
      this.next();
      const iterable = this.parseTernary();
      const body = this.parseBlock();
      return { type: 'ForIn', varName, idxName, iterable, body, line };
    }
    if(idxName != null) throw new PineParseError(pineMsg("'in'이 와야 합니다", "'in' is required here"), line);
    const nameTok = { value: varName };
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
      return { type: 'Ternary', cond, then: a, else: b, line: cond.line, id: this.nodeIdCounter++ };
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
        // array.new<Type>(...) / matrix.new<Type>(...) / map.new<K,V>(...) 처럼 함수 이름 뒤에
        // 제네릭 타입 인자를 <...>로 붙이는 문법 — 동적 타입이라 타입 인자 자체는 버리고 뒤따르는
        // (...) 호출 인자만 이어서 파싱한다. '<'가 진짜 "보다 작다" 비교식일 수도 있어서, '.new'
        // 뒤에 오고 실제로 짝이 맞는 '>' 바로 뒤에 '('가 있을 때만 소비한다(오탐 방지).
        if(t.value === 'new' && this.atOp('<') && this.looksLikeGenericArgs()){
          this.skipGenericArgs();
        }
      } else if(this.atOp('(')){
        node = { type: 'Call', callee: node, args: this.parseArgs(), line: node.line, id: this.nodeIdCounter++ };
      } else if(this.atOp('[')){
        // 'line[] arr' 같은 배열 타입 표기(v6 타입 붙은 함수 매개변수/구조체 필드에서 자주 나옴) —
        // 실제 인덱싱(x[1], x[i])은 대괄호 안에 항상 식이 있으므로 대괄호가 비어있으면(바로 ']')
        // 절대 인덱싱이 아니라 타입 접미사다. 이 자리는 함수를 "일단 평범한 호출식"으로 파싱한 뒤
        // '=>'를 보고 나서야 함수 선언인 걸 알아채는 구조라, finishFuncDecl의 isTypeWord 스킵 로직이
        // 타입 이름(예: line)을 그대로 볼 수 있게 대괄호만 소비하고 노드는 그대로 둔다.
        if(this.peek(1).type === 'OP' && this.peek(1).value === ']'){
          this.next(); this.next();
          continue;
        }
        this.next();
        const idx = this.parseTernary();
        this.expectOp(']');
        node = { type: 'Index', obj: node, index: idx, line: node.line, id: this.nodeIdCounter++ };
      } else break;
    }
    return node;
  }
  looksLikeGenericArgs(){
    let depth = 0, o = 0;
    do{
      const t = this.peek(o);
      if(t.type === 'EOF' || t.type === 'NEWLINE') return false;
      if(t.type === 'OP' && t.value === '<') depth++;
      else if(t.type === 'OP' && t.value === '>') depth--;
      o++;
    } while(depth > 0);
    return this.peek(o).type === 'OP' && this.peek(o).value === '(';
  }
  skipGenericArgs(){
    let depth = 0;
    do{
      const t = this.next();
      if(t.type === 'OP' && t.value === '<') depth++;
      else if(t.type === 'OP' && t.value === '>') depth--;
    } while(depth > 0);
  }
  // 'array<lvl> levels' 같은 제네릭 타입이 붙은 함수 매개변수 감지. 이 자리는 아직 함수 선언인지
  // 그냥 호출인지 모르는 채로 "일단 인자 목록"으로 파싱하는 중이라, 손 안 대면 '<' '>' 가 그냥
  // 비교 연산자로 읽혀서 'array < lvl > levels' 같은 엉뚱한 식이 되어버린다(그러다 finishFuncDecl에서
  // "매개변수는 변수명이어야 합니다" 에러). 단일 단어 타입(예: 'float source')은 이미 finishFuncDecl
  // 쪽에서 스킵 처리가 되므로, 여기서는 제네릭(<...>)이 붙은 경우만 좁혀서 처리한다.
  looksLikeGenericTypedArg(){
    let o = 0;
    if(this.peek(o).type !== 'IDENT' || !this.isTypeWord(this.peek(o).value)) return 0;
    if(!(this.peek(o+1).type === 'OP' && this.peek(o+1).value === '<')) return 0;
    o++;
    let depth = 1; o++;
    while(depth > 0 && this.peek(o).type !== 'EOF' && this.peek(o).type !== 'NEWLINE'){
      if(this.peek(o).type === 'OP' && this.peek(o).value === '<') depth++;
      if(this.peek(o).type === 'OP' && this.peek(o).value === '>') depth--;
      o++;
    }
    if(this.peek(o).type === 'IDENT'){
      const after = this.peek(o + 1);
      if(after.type === 'OP' && (after.value === ',' || after.value === ')')) return o;
    }
    return 0;
  }
  parseArgs(){
    this.expectOp('(');
    const args = [];
    this.skipNewlines();
    while(!this.atOp(')')){
      this.skipNewlines();
      const genericSkip = this.looksLikeGenericTypedArg();
      if(genericSkip){
        for(let k = 0; k < genericSkip; k++) this.next();
        const nameTok = this.next();
        args.push({ named: false, value: { type: 'Ident', name: nameTok.value, line: nameTok.line } });
      } else if(this.at('IDENT') && this.peek(1).type === 'OP' && this.peek(1).value === '='){
        // named arg: IDENT '=' Expr  (단, IDENT '==' 같은 비교 연산은 제외해야 하므로 다음 토큰이 '=' 하나인지 확인)
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
