// LittleScript frontend (Epic 1.5, v0).
//
// Three jobs:
//
//  1. Subset diagnostics — LS-coded errors with fix-its for TS features
//     outside LittleScript ("TS-syntax, AS-semantics"), caught *before*
//     asc so users get LittleA-branded messages, not AS internals.
//  2. Closure lowering — AssemblyScript cannot compile closures over
//     locals (AS100). We lower them to the module-state pattern the
//     spike proved out (03b): captured locals hoist to module scope,
//     the closure body hoists to a top-level function.
//  3. Short-circuit lowering for syntax AssemblyScript's parser does not
//     accept at all: nullish coalescing (`a ?? b`), optional chaining
//     (`a?.b`, `a?.[i]`, `a?.()`) and logical assignment (`x ||= y`), each
//     lowered to a conditional AS does accept. Left untouched, every one of
//     these reached `asc` and came back as a bare `TS1109: Expression
//     expected.` with no LittleA code, no fix-it and no original source
//     position — the exact failure mode this frontend exists to prevent.
//
//     Every lowering evaluates its receiver EXACTLY ONCE. Where that cannot
//     be arranged, the form is reported rather than lowered: a receiver
//     evaluated twice is a silently wrong program, which is worse than a
//     refusal that names the line.
//
// v0 lowering contract (enforced with diagnostics, never silent):
//  - closures created inside loops are rejected (LS2002) — one shared
//    context slot cannot represent per-iteration captures;
//  - captured variables reassigned after the closure is created are
//    rejected (LS2003) — the hoisted slot is a snapshot.
//  - captures are limited to the host's single-shot main entry (LS2006).
//    Reentrant factories need per-instance environments, not shared slots.

import ts from "typescript";
import { applyEdits, composeSegments, LoweringMap } from "./sourcemap.mjs";

export const CODES = {
  LS1001: "`any` is not part of LittleScript",
  LS1002: "`eval` is not part of LittleScript",
  LS1003: "dynamic `import()` is not part of LittleScript",
  LS1004: "the `Function` constructor is not part of LittleScript",
  LS1005: "`delete` is not part of LittleScript",
  LS1006: "logical assignment to a property or element must stand alone as a statement in LittleScript",
  LS1007: "destructuring is not part of LittleScript",
  LS1008: "short-circuit syntax needs a receiver that can be evaluated twice safely",
  LS1009: "optional chaining needs a `??` fallback in LittleScript",
  LS2001: "closure over locals lowered to module state",
  LS2002: "closures created inside loops cannot be lowered",
  LS2003: "captured variable is reassigned after the closure is created",
  LS2004: "captured variable is declared after the closure is created",
  LS2005: "nested closures cannot be lowered",
  LS2006: "captured closures require single-shot main; independently created capture environments are unsupported",
};

/** @returns {{code: string, map: LoweringMap, diagnostics: Array<{code:string, message:string, line:number, col:number, severity:string, fixit?:string}>}} */
export function transform(source, fileName = "input.ts") {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2020, true);
  const diagnostics = [];

  const at = (node) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return { line: line + 1, col: character + 1 };
  };
  const report = (node, code, severity, fixit) => {
    diagnostics.push({ code, message: CODES[code], ...at(node), severity, fixit });
  };

  // ---- pass 1: subset bans ---------------------------------------------
  (function ban(node) {
    switch (node.kind) {
      case ts.SyntaxKind.AnyKeyword:
        report(node, "LS1001", "error", "declare a concrete type (e.g. i32, f32, a class, or a typed interface)");
        break;
      case ts.SyntaxKind.CallExpression: {
        const c = node;
        if (c.expression.kind === ts.SyntaxKind.Identifier && c.expression.text === "eval")
          report(node, "LS1002", "error", "move the logic into compiled code — LittleScript has no runtime evaluator");
        if (c.expression.kind === ts.SyntaxKind.ImportKeyword)
          report(node, "LS1003", "error", "use a static top-level import");
        break;
      }
      case ts.SyntaxKind.NewExpression:
        if (node.expression.kind === ts.SyntaxKind.Identifier && node.expression.text === "Function")
          report(node, "LS1004", "error", "define the function in source instead");
        break;
      case ts.SyntaxKind.DeleteExpression:
        report(node, "LS1005", "error", "use a Map, or set the field to a sentinel value");
        break;
      case ts.SyntaxKind.BinaryExpression:
        // A property/element target lowers to a block of temporaries, which
        // is only available where a statement is: `o.p ||= v;` on its own.
        // Used for its value, there is nowhere to put the temporaries, and
        // re-mentioning the receiver would evaluate it twice.
        if (logicalAssignment(node) && !assignmentVariable(node.left) && !isExpressionStatement(node))
          report(node.left, "LS1006", "error", "assign it on its own line, or read the property into a local first");
        else if (logicalAssignment(node) && !assignmentVariable(node.left) && !sideEffectFree(node.left))
          report(node.left, "LS1008", "error", "read the receiver into a local first, then assign through that");
        if (node.operatorToken?.kind === ts.SyntaxKind.QuestionQuestionToken && !sideEffectFree(node.left))
          report(node.left, "LS1008", "error", "put the left-hand value in a local first, then coalesce that");
        break;
      case ts.SyntaxKind.ArrayBindingPattern:
      case ts.SyntaxKind.ObjectBindingPattern:
        report(node, "LS1007", "error", "name each binding in its own declaration (e.g. `const a = pair[0];`)");
        break;
    }
    // Optional chaining reads its receiver twice — once to test it, once to
    // use it — so a receiver with side effects is reported instead.
    const chainReceiver = optionalChainReceiver(node);
    if (chainReceiver && !sideEffectFree(chainReceiver))
      report(node, "LS1008", "error", "put the receiver in a local first, then chain off that");
    // An absent link has no value LittleScript can name: AssemblyScript has
    // no `undefined`, and `null` in a numeric member's place reads as zero —
    // which would answer 0 where JavaScript answers the fallback. So the
    // fallback is required, and the two lower together into one conditional
    // whose type is the fallback's.
    else if (chainReceiver && isOutermostOptionalLink(node) && !hasNullishFallback(node))
      report(node, "LS1009", "error", "add the value to use when it is absent (e.g. `a?.b ?? 0`)");
    ts.forEachChild(node, ban);
  })(sf);

  // ---- pass 2: closure lowering ------------------------------------------
  // Find arrow/function expressions that capture bindings declared in an
  // enclosing *function* scope (module-scope captures are fine for asc).
  const edits = []; // {start, end, text} — applied back-to-front
  const hoistedDecls = [];
  const hoistedFns = [];
  let closureSeq = 0;

  const enclosingFunction = (node) => {
    for (let n = node.parent; n; n = n.parent) {
      if (ts.isFunctionLike(n)) return n;
    }
    return null; // module scope
  };
  const inLoop = (node) => {
    for (let n = node.parent; n; n = n.parent) {
      if (ts.isIterationStatement(n, false)) return true;
      if (ts.isFunctionLike(n)) return false;
    }
    return false;
  };

  function lowerClosure(fn) {
    const owner = enclosingFunction(fn);
    if (!owner) return; // module-level function expression: asc handles it

    // Collect identifiers inside the closure that resolve to declarations
    // in an enclosing function scope (captured locals).
    const captured = new Map(); // name -> {decl, refs: [idNodes]}
    (function walk(node) {
      if (ts.isIdentifier(node) && !isDeclarationName(node) && !isPropertyName(node)) {
        const decl = resolveLocal(node.text, node, fn);
        if (decl) {
          const entry = captured.get(node.text) ?? { decl, refs: [] };
          entry.refs.push(node);
          captured.set(node.text, entry);
        }
      }
      ts.forEachChild(node, walk);
    })(fn.body);

    if (captured.size === 0) {
      // No captures: hoisting is trivial — asc still rejects the *syntax*
      // of a local function expression, so hoist it anyway.
    }

    if (inLoop(fn)) {
      report(fn, "LS2002", "error", "hoist the handler out of the loop, or key the state by an id");
      return;
    }
    for (const [name, { decl }] of captured) {
      if (isReassignedAfter(decl, fn, owner)) {
        report(fn, "LS2003", "error", `capture a copy: const ${name}Snapshot = ${name}; and use it in the handler`);
        return;
      }
    }

    // Require captures to be initialized by an earlier statement, excluding
    // self-references and later declarations from the supported subset.
    const stmt = enclosingStatement(fn);
    for (const [name, { decl }] of captured) {
      if (decl.getStart(sf) >= stmt.getStart(sf)) {
        report(fn, "LS2004", "error", `declare ${name} before the closure so its snapshot is initialized`);
        return;
      }
    }

    if (captured.size > 0) {
      let mainReferenced = false;
      (function walk(node) {
        if (ts.isIdentifier(node) && node.text === "main" && node !== owner.name) mainReferenced = true;
        ts.forEachChild(node, walk);
      })(sf);
      if (!ts.isFunctionDeclaration(owner) || owner.parent !== sf ||
          owner.name?.text !== "main" || owner.parameters.length !== 0 ||
          !owner.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) || mainReferenced) {
        report(fn, "LS2006", "error",
          "use explicit per-instance state and a noncapturing function; only an unreferenced exported main() may snapshot locals");
        return;
      }
    }

    // Lowering plan.
    const id = closureSeq++;
    const fnName = `__ls_closure_${id}`;
    const renames = new Map(); // old name -> slot name
    for (const name of captured.keys()) renames.set(name, `__ls_cap_${id}_${name}`);

    // 1. Module-scope slots with the declared (or inferred-by-asc) type.
    for (const [name, { decl }] of captured) {
      const typeText = decl.type ? `: ${decl.type.getText(sf)}` : "";
      const init = decl.type ? defaultInit(decl.type.getText(sf)) : "0";
      hoistedDecls.push(`let ${renames.get(name)}${typeText} = ${init};`);
    }

    // 2. Hoisted function: closure body with captured refs renamed.
    const params = fn.parameters.map((p) => p.getText(sf)).join(", ");
    const retType = fn.type ? `: ${fn.type.getText(sf)}` : ": void";
    let body;
    if (ts.isBlock(fn.body)) {
      body = renameWithin(fn.body.getText(sf), fn.body, captured, renames, sf);
    } else {
      const expr = renameWithin(fn.body.getText(sf), fn.body, captured, renames, sf);
      body = `{ return ${expr}; }`;
    }
    hoistedFns.push(`function ${fnName}(${params})${retType} ${body}`);

    // Snapshot at the expression's evaluation point, not before its statement:
    // earlier arguments and conditional guards may change the captured locals.
    const snapshot = [...captured.keys()]
      .map((name) => `${renames.get(name)} = ${name}`)
      .join(", ");
    edits.push({
      start: fn.getStart(sf), end: fn.getEnd(),
      text: snapshot ? `(${snapshot}, ${fnName})` : fnName,
    });

    report(fn, "LS2001", "info", undefined);
  }

  function isDeclarationName(id) {
    const p = id.parent;
    return (
      (ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p)) &&
      p.name === id
    );
  }
  function isPropertyName(id) {
    const p = id.parent;
    return (ts.isPropertyAccessExpression(p) && p.name === id) || (ts.isPropertyAssignment(p) && p.name === id);
  }

  /** Resolve `name` used inside `fn` to a local declaration in an
   *  enclosing function scope; null if it's fn-local or module-scope. */
  function resolveLocal(name, ref, fn) {
    // Declared inside the closure itself (param or local)? Not a capture.
    let found = null;
    (function scan(node) {
      if (found) return;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) found = "inner";
      if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === name) found = "inner";
      ts.forEachChild(node, scan);
    })(fn);
    if (found === "inner") return null;

    // Walk enclosing functions outward looking for the declaration.
    for (let owner = enclosingFunction(fn); owner; owner = enclosingFunction(owner)) {
      let decl = null;
      (function scan(node) {
        if (decl) return;
        if (node !== fn) {
          if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) decl = node;
          if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === name) decl = node;
        }
        if (node === fn) return; // don't descend into the closure
        ts.forEachChild(node, scan);
      })(owner);
      if (decl) return decl;
    }
    return null; // module scope or global — fine for asc
  }

  function isReassignedAfter(decl, fn, owner) {
    const name = ts.isIdentifier(decl.name) ? decl.name.text : null;
    if (!name) return false;
    const targetsName = (n) => ts.isIdentifier(n) && n.text === name;
    let reassigned = false;
    (function scan(node) {
      if (reassigned || node === fn) return;
      const after = node.getStart(sf) > fn.getEnd();
      // `x = …` and every compound assignment (`+=`, `-=`, `<<=`, …):
      // operator kinds run FirstAssignment..LastAssignment.
      if (
        after &&
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        targetsName(node.left)
      ) {
        reassigned = true;
      }
      // `x++`, `++x`, `x--`, `--x`.
      if (
        after &&
        (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken) &&
        targetsName(node.operand)
      ) {
        reassigned = true;
      }
      ts.forEachChild(node, scan);
    })(owner);
    return reassigned;
  }

  function enclosingStatement(node) {
    for (let n = node; n; n = n.parent) {
      if (ts.isStatement(n)) return n;
    }
    return node;
  }

  function renameWithin(text, container, captured, renames, sf) {
    const base = container.getStart(sf);
    const repls = [];
    for (const [name, { refs }] of captured) {
      for (const ref of refs) {
        if (ref.getStart(sf) >= base && ref.getEnd() <= container.getEnd()) {
          repls.push({ start: ref.getStart(sf) - base, end: ref.getEnd() - base, text: renames.get(name) });
        }
      }
    }
    repls.sort((a, b) => b.start - a.start);
    let out = text;
    for (const r of repls) out = out.slice(0, r.start) + r.text + out.slice(r.end);
    return out;
  }

  function defaultInit(typeText) {
    if (/^(i|u)(8|16|32|64)$|^(f32|f64|isize|usize|number)$/.test(typeText)) return "0";
    if (typeText === "bool" || typeText === "boolean") return "false";
    if (typeText === "string") return '""';
    return `changetype<${typeText}>(0)`; // reference types: null-ish slot
  }

  (function findClosures(node) {
    if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && enclosingFunction(node)) {
      const owner = enclosingFunction(node);
      if (ts.isArrowFunction(owner) || ts.isFunctionExpression(owner)) {
        // A closure defined inside another closure: the outer body is
        // hoisted to a top-level function, but asc still can't lower this
        // inner one. Surface a branded error instead of a cryptic AS100.
        report(node, "LS2005", "error", "extract the inner handler to a top-level function");
      } else {
        lowerClosure(node);
      }
      // Keep descending so nested closures are detected, not silently
      // dropped (v0 returned here and let them fail inside asc).
    }
    ts.forEachChild(node, findClosures);
  })(sf);

  // Hoisted code is an insertion like any other, so the map keeps working
  // across the shift it puts on every line below it.
  if (hoistedDecls.length || hoistedFns.length) {
    edits.push({
      start: 0,
      end: 0,
      text:
        `// --- lowered by LittleScript frontend (closure -> module state) ---\n` +
        hoistedDecls.join("\n") +
        "\n\n",
    });
    edits.push({
      start: source.length,
      end: source.length,
      text: "\n\n" + hoistedFns.join("\n\n") + "\n",
    });
  }
  const closures = applyEdits(source, edits);
  // Run after closure lowering so hoisted bodies and renamed captures are
  // transformed too; the subset checks above retain original source locations.
  const short = lowerLogicalAssignments(closures.text, fileName);
  return {
    code: short.code,
    diagnostics,
    map: new LoweringMap({
      source,
      sourceName: fileName,
      generated: short.code,
      segments: composeSegments(closures.segments, short.segments),
    }),
  };
}

/** Whether `node` is the whole of an expression statement. */
function isExpressionStatement(node) {
  return !!node.parent && ts.isExpressionStatement(node.parent);
}

/**
 * Whether evaluating `node` twice is indistinguishable from evaluating it
 * once: no call, no construction, no assignment, no increment.
 *
 * Deliberately syntactic and deliberately conservative. A getter can of
 * course do anything, but LittleScript has no getters, and the alternative —
 * assuming a property read is pure — would be an assumption the compiler
 * cannot check. Anything this returns false for is reported, not lowered.
 */
function sideEffectFree(node) {
  while (node && (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node))) {
    node = node.expression;
  }
  if (!node) return false;
  if (ts.isIdentifier(node) || ts.isLiteralExpression(node)) return true;
  switch (node.kind) {
    case ts.SyntaxKind.ThisKeyword:
    case ts.SyntaxKind.NullKeyword:
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.StringLiteral:
      return true;
  }
  if (ts.isPropertyAccessExpression(node)) return sideEffectFree(node.expression);
  if (ts.isElementAccessExpression(node)) {
    return sideEffectFree(node.expression) && sideEffectFree(node.argumentExpression);
  }
  // `a?.b` reads, and `a ?? b` chooses; neither does anything else, so a
  // chain of them is as safe to re-read as its parts. This is what lets
  // `a ?? b ?? c` and `a?.b ?? c` lower rather than being refused.
  if (ts.isCallExpression(node)) return false;
  if (optionalChainReceiver(node)) {
    return ts.isElementAccessExpression(node)
      ? sideEffectFree(node.expression) && sideEffectFree(node.argumentExpression)
      : sideEffectFree(node.expression);
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
  ) {
    return sideEffectFree(node.left) && sideEffectFree(node.right);
  }
  return false;
}

/**
 * Whether this optional link is the end of its chain — the one that owns the
 * `??` fallback. `a?.b?.c` reports once, at `?.c`, rather than at every link.
 */
function isOutermostOptionalLink(node) {
  let child = node;
  let parent = node.parent;
  while (parent && ts.isParenthesizedExpression(parent)) {
    child = parent;
    parent = parent.parent;
  }
  return !(parent && optionalChainReceiver(parent) === child);
}

/**
 * The receiver an optional link tests, or `null` when `node` is not one.
 *
 * Every suffix of a chain is marked `OptionalChain` by TypeScript, not just
 * the one carrying the `?.`: in `a?.b.c` the outer `.c` has no
 * `questionDotToken` but is still a suffix of the same chain and must be
 * lowered with it. Reading `questionDotToken` alone missed it and sent
 * `a?.b.c` to `asc` as unlowered `?.` syntax (CQ83).
 */
function optionalChainReceiver(node) {
  if (
    (ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node) ||
      ts.isCallExpression(node)) &&
    ts.isOptionalChain(node)
  ) {
    return node.expression;
  }
  return null;
}

function logicalAssignment(node) {
  if (!ts.isBinaryExpression(node)) return null;
  switch (node.operatorToken.kind) {
    case ts.SyntaxKind.AmpersandAmpersandEqualsToken: return "&&";
    case ts.SyntaxKind.BarBarEqualsToken: return "||";
    case ts.SyntaxKind.QuestionQuestionEqualsToken: return "??";
    default: return null;
  }
}

function assignmentVariable(node) {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return ts.isIdentifier(node) ? node : null;
}

/**
 * Whether this optional link is the left-hand side of a `??`, so the two can
 * lower together. Parentheses in between are transparent.
 */
function hasNullishFallback(node) {
  let child = node;
  let parent = node.parent;
  while (parent && ts.isParenthesizedExpression(parent)) {
    child = parent;
    parent = parent.parent;
  }
  if (!parent || !ts.isBinaryExpression(parent)) return false;
  return (
    parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && parent.left === child
  );
}

/**
 * A `??` chain's operands, left to right. `a ?? b ?? c` parses as
 * `(a ?? b) ?? c`, and answering the first non-nullish operand is the same
 * either way, so the chain is flattened and lowered once.
 */
function nullishOperands(node) {
  const operands = [];
  (function walk(current) {
    const inner = withoutParens(current);
    if (
      ts.isBinaryExpression(inner) &&
      inner.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
      walk(inner.left);
      operands.push(inner.right);
      return;
    }
    operands.push(current);
  })(node);
  return operands;
}

/** The optional receivers along a chain, outermost first. */
function optionalChainLinks(node) {
  const links = [];
  for (let current = node; ; ) {
    const receiver = optionalChainReceiver(current);
    if (!receiver) break;
    links.push(receiver);
    current = receiver;
  }
  return links;
}

/**
 * Whether the lowering pass rewrites this node itself (rather than only its
 * children). One predicate so the renderer and the child walk cannot
 * disagree about what gets replaced.
 */
function rewritable(node) {
  if (logicalAssignment(node)) return true;
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
  ) {
    return true;
  }
  // A bare optional chain is reported (LS1009), not rewritten: it lowers
  // only together with the `??` that supplies its absent case, and that
  // `??` is the node the renderer rewrites.
  return false;
}

/** Strip parentheses. */
function withoutParens(node) {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

/**
 * An access path with every `?.` written as `!.` — the branch taken once the
 * guards above it have established the receiver is present.
 */
function plainAccess(node, render, sf) {
  node = withoutParens(node);
  const receiver = optionalChainReceiver(node);
  if (!receiver) return render(node);
  const base = `${plainAccess(receiver, render, sf)}!`;
  if (ts.isCallExpression(node)) {
    return `${base}(${node.arguments.map((argument) => render(argument)).join(", ")})`;
  }
  if (ts.isElementAccessExpression(node)) {
    return `${base}[${render(node.argumentExpression)}]`;
  }
  return `${base}.${node.name.getText(sf)}`;
}

function lowerLogicalAssignments(source, fileName) {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2020, true);
  const names = new Set();
  (function collect(node) {
    if (ts.isIdentifier(node)) names.add(node.text);
    ts.forEachChild(node, collect);
  })(sf);
  const fresh = (base) => {
    let name = base;
    for (let i = 1; names.has(name); i++) name = `${base}_${i}`;
    names.add(name);
    return name;
  };
  let nullCheck;
  const needsNullCheck = () => (nullCheck ??= fresh("__ls_isNull"));
  function render(node) {
    const op = logicalAssignment(node);
    const target = op && assignmentVariable(node.left);
    if (target) {
      const name = target.getText(sf);
      const right = render(node.right);
      if (op === "??") {
        return `(${needsNullCheck()}(${name}) ? (${name} = (${right})) : ${name})`;
      }
      return `(${name} ${op} (${name} = (${right})))`;
    }
    // A property or element target, standing alone as a statement: the
    // receiver (and the index, if any) go into temporaries so each is
    // evaluated exactly once, which is what a bare re-mention would break.
    if (op && isExpressionStatement(node) && sideEffectFree(node.left)) {
      const place = withoutParens(node.left);
      const receiver = render(place.expression);
      const temp = fresh("__ls_recv");
      let read;
      let decls = `const ${temp} = ${receiver};`;
      if (ts.isElementAccessExpression(place)) {
        const index = fresh("__ls_index");
        decls += ` const ${index} = ${render(place.argumentExpression)};`;
        read = `${temp}[${index}]`;
      } else {
        read = `${temp}.${place.name.getText(sf)}`;
      }
      const right = render(node.right);
      const guard =
        op === "??"
          ? `${needsNullCheck()}(${read})`
          : op === "||"
            ? `!(${read})`
            : `(${read})`;
      return `{ ${decls} if (${guard}) ${read} = (${right}); }`;
    }
    // `a ?? b`, `a ?? b ?? c`, `a?.b ?? c`: AssemblyScript's parser accepts
    // none of it. The whole chain lowers in ONE pass, right to left, so each
    // operand is written twice and the accumulated fallback once — building
    // it by recursing on `node.left` instead would nest the fallback inside
    // itself and grow the output exponentially in the chain's length.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
      sideEffectFree(node.left)
    ) {
      const operands = nullishOperands(node);
      let expr = render(operands[operands.length - 1]);
      for (let i = operands.length - 2; i >= 0; i -= 1) {
        const operand = withoutParens(operands[i]);
        // `a?.b ?? f` becomes a guard per optional link, each answering the
        // fallback, with the plain access at the bottom. Lowering the chain
        // on its own would have to name the absent case, and `null` in a
        // numeric member's place reads as zero in AssemblyScript — which
        // would answer 0 where JavaScript answers `f`.
        const links = optionalChainLinks(operand);
        if (links.length) {
          let access = plainAccess(operand, render, sf);
          for (const receiver of links) {
            access = `(${needsNullCheck()}(${plainAccess(receiver, render, sf)}) ? (${expr}) : ${access})`;
          }
          expr = access;
          continue;
        }
        // The non-null assertion is what keeps the conditional's type the
        // same as the operand's: the null test is a call, so nothing narrows
        // on it.
        const text = render(operand);
        expr = `(${needsNullCheck()}(${text}) ? (${expr}) : (${text})!)`;
      }
      return expr;
    }
    const base = node === sf ? 0 : node.getStart(sf);
    const text = node === sf ? source : node.getText(sf);
    const edits = [];
    function visit(child) {
      if (rewritable(child)) {
        edits.push({ start: child.getStart(sf) - base, end: child.getEnd() - base, text: render(child) });
        return;
      }
      ts.forEachChild(child, visit);
    }
    ts.forEachChild(node, visit);
    const applied = applyEdits(text, edits);
    // Only the whole-file pass is mapped: an inner render is already baked
    // into the replacement text its caller splices in, and that text maps to
    // the construct it replaced rather than to positions inside itself.
    if (node === sf) fileSegments = applied.segments;
    return applied.text;
  }
  let fileSegments = [];
  let code = render(sf);
  if (nullCheck) {
    const referenceCheck = fresh("__ls_isReference");
    // `null` compares equal to numeric zero in AS. Test the static type first,
    // and import the intrinsic explicitly so user declarations cannot shadow it.
    const helper =
      `\nimport { isReference as ${referenceCheck} } from "~lib/builtins";\n` +
      `function ${nullCheck}<T>(value: T): bool { return ${referenceCheck}<T>() && value === null; }\n`;
    const appended = applyEdits(code, [{ start: code.length, end: code.length, text: helper }]);
    fileSegments = composeSegments(fileSegments, appended.segments);
    code = appended.text;
  }
  return { code, segments: fileSegments };
}
