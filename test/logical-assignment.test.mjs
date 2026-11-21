import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { compileSource } from "../src/compile.mjs";
import { transform } from "../src/frontend.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const errors = (result) => result.diagnostics.filter((d) => d.severity === "error");
const imports = { env: { abort: () => { throw new Error("script aborted"); } } };

function workDirectory(t) {
  const dir = mkdtempSync(join(here, ".logical-assignment-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function compile(t, source) {
  const output = join(workDirectory(t), "sample.wasm");
  const result = await compileSource(source, "sample.ts", output);
  assert.deepEqual(result.errors, []);
  assert.equal(result.compilerError, null, result.stderr);
  const { instance, module } = await WebAssembly.instantiate(readFileSync(output), imports);
  assert.ok(WebAssembly.Module.imports(module).every(
    ({ module, name }) => module === "env" && name === "abort",
  ), "lowering introduces no host capabilities");
  return instance.exports;
}

test("logical assignments lower nested expressions without rewriting surrounding source", () => {
  const source = "// ||= is not an operator in this comment\n" +
    'const text = "a ??= b";\n' +
    "export function choose(a: i32, b: i32): i32 { return (a) ||= b &&= 4; }\n";
  const result = transform(source);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.code, source.replace("(a) ||= b &&= 4", "(a || (a = ((b && (b = (4))))))"));
  assert.equal(transform(result.code).code, result.code, "lowering is idempotent");
});

test("a receiver that cannot be read twice fails at the original target with a fix-it", () => {
  // `getBox().value` and `items[index++]` each do something when read, so
  // the lowering cannot name them twice and reports instead. Refusing is the
  // point: a receiver evaluated twice is a silently wrong program.
  for (const target of ["getBox().value", "items[index++]"]) {
    for (const operator of ["&&=", "||=", "??="]) {
      const result = transform(`function f(): void {\n  ${target} ${operator} 1;\n}`);
      assert.equal(errors(result).length, 1, target);
      assert.deepEqual(
        { ...errors(result)[0], fixit: undefined },
        {
          code: "LS1008",
          message: "short-circuit syntax needs a receiver that can be evaluated twice safely",
          line: 2, col: 3, severity: "error", fixit: undefined,
        },
      );
      assert.match(errors(result)[0].fixit, /read the receiver into a local first/);
    }
  }
});

test("a property or element target used for its value fails, because temporaries need a statement", () => {
  for (const operator of ["&&=", "||=", "??="]) {
    const result = transform(`function f(): i32 {\n  return box.value ${operator} 1;\n}`);
    assert.equal(errors(result).length, 1);
    assert.deepEqual(
      { ...errors(result)[0], fixit: undefined },
      {
        code: "LS1006",
        message:
          "logical assignment to a property or element must stand alone as a statement in LittleScript",
        line: 2, col: 10, severity: "error", fixit: undefined,
      },
    );
    assert.match(errors(result)[0].fixit, /assign it on its own line/);
  }
});

test("a property or element target standing alone lowers to temporaries read once", () => {
  for (const [target, guard] of [
    ["box.value", "__ls_recv.value"],
    ["(box.value)", "__ls_recv.value"],
    ["items[at]", "__ls_recv[__ls_index]"],
  ]) {
    const result = transform(`function f(): void {\n  ${target} ||= 1;\n}`);
    assert.deepEqual(result.diagnostics, [], target);
    // The receiver is named once in a `const`, then only the temporary is
    // used — which is the whole reason this form used to be refused.
    assert.match(result.code, /const __ls_recv = /);
    assert.ok(result.code.includes(`if (!(${guard})) ${guard} = (1);`), result.code);
  }
  const index = transform("function f(): void {\n  items[at] ??= 1;\n}");
  assert.match(index.code, /const __ls_index = at;/);
  assert.ok(index.code.includes("if (__ls_isNull(__ls_recv[__ls_index]))"), index.code);
});

test("logical assignment retains dynamic-code bans and capture-mutation diagnostics", () => {
  for (const operator of ["&&=", "||=", "??="]) {
    const banned = transform(`function f(x: i32): void { x ${operator} eval("1"); }`);
    assert.ok(errors(banned).some((d) => d.code === "LS1002"));
    const captured = transform(`
      declare function register(callback: () => void): void;
      declare function use(value: i32): void;
      export function f(): void {
        let value: i32 = 1;
        register((): void => { use(value); });
        value ${operator} 2;
      }
    `);
    assert.ok(errors(captured).some((d) => d.code === "LS2003"));
  }
});

test("compiled &&= and ||= short-circuit, return operands, and assign exactly once", async (t) => {
  const wasm = await compile(t, `
    let calls: i32 = 0;
    let globalValue: i32 = 0;
    function next(value: i32): i32 { calls++; return value; }
    export function or(value: i32): i32 {
      calls = 0;
      const result = (value ||= next(7));
      return result * 100 + value * 10 + calls;
    }
    export function and(value: i32): i32 {
      calls = 0;
      const result = (value &&= next(7));
      return result * 100 + value * 10 + calls;
    }
    export function nested(a: i32, b: i32): i32 {
      calls = 0;
      const result = ((a) ||= b &&= next(8));
      return result * 1000 + a * 100 + b * 10 + calls;
    }
    function replaceGlobal(): i32 { calls++; globalValue = 99; return 5; }
    export function global(): i32 {
      calls = 0;
      globalValue = 0;
      const result = (globalValue ||= replaceGlobal());
      return result * 100 + globalValue * 10 + calls;
    }
    export function booleans(a: bool, b: bool): bool { a &&= b; a ||= b; return a; }
    export function decimal(value: f64): f64 { return value ||= 2.5; }
  `);
  assert.equal(wasm.or(0), 771);
  assert.equal(wasm.or(3), 330);
  assert.equal(wasm.or(-2), -220);
  assert.equal(wasm.and(0), 0);
  assert.equal(wasm.and(3), 771);
  assert.equal(wasm.nested(0, 0), 0);
  assert.equal(wasm.nested(0, 1), 8881);
  assert.equal(wasm.nested(2, 1), 2210);
  assert.equal(wasm.global(), 551);
  assert.equal(wasm.booleans(1, 0), 0);
  assert.equal(wasm.booleans(0, 1), 1);
  assert.equal(wasm.decimal(0), 2.5);
  assert.equal(wasm.decimal(-1.25), -1.25);
  assert.equal(wasm.decimal(NaN), 2.5);
});

test("compiled ??= distinguishes null from falsy scalar and reference values", async (t) => {
  const wasm = await compile(t, `
    let calls: i32 = 0;
    class Box {
      constructor(public value: i32) {}
    }
    function makeBox(): Box { calls++; return new Box(9); }
    function makeText(): string { calls++; return "default"; }
    function trapNumber(): f64 { unreachable(); return 1; }
    function trapInteger(): i32 { unreachable(); return 1; }
    function trapBool(): bool { unreachable(); return true; }
    export function number(value: f64): f64 { return value ??= trapNumber(); }
    export function integer(value: i32): i32 { return value ??= trapInteger(); }
    export function boolean(value: bool): bool { return value ??= trapBool(); }
    export function reference(present: bool): i32 {
      calls = 0;
      let value: Box | null = present ? new Box(5) : null;
      const result = (value ??= makeBox());
      return (result === value ? 1000 : 0) + result!.value * 10 + calls;
    }
    export function text(mode: i32): i32 {
      calls = 0;
      let value: string | null = mode == 0 ? null : (mode == 1 ? "" : "yes");
      const result = (value ??= makeText());
      return result!.length * 10 + calls;
    }
    export function array(): i32 {
      calls = 0;
      let values: Array<i32> | null = null;
      const result = (values ??= [4, 5]);
      return result![0] + values![1];
    }
    export function nested(): i32 {
      calls = 0;
      let a: Box | null = null;
      let b: Box | null = null;
      const result = (a ??= b ??= makeBox());
      return (result === a && a === b ? 100 : 0) + calls;
    }
    export function logicalText(mode: i32): i32 {
      calls = 0;
      let value: string | null = mode == 0 ? null : (mode == 1 ? "" : "yes");
      value ||= makeText();
      value &&= "done";
      return value!.length * 10 + calls;
    }
  `);
  for (const value of [0, -0, 2.5, -3, NaN, Infinity])
    assert.ok(Object.is(wasm.number(value), value), `preserve ${value}`);
  assert.equal(wasm.integer(0), 0);
  assert.equal(wasm.boolean(0), 0);
  assert.equal(wasm.boolean(1), 1);
  assert.equal(wasm.reference(0), 1091);
  assert.equal(wasm.reference(1), 1050);
  assert.equal(wasm.text(0), 71);
  assert.equal(wasm.text(1), 0, "empty string is not null");
  assert.equal(wasm.text(2), 30);
  assert.equal(wasm.array(), 9);
  assert.equal(wasm.nested(), 101);
  assert.equal(wasm.logicalText(0), 41);
  assert.equal(wasm.logicalText(1), 40, "AS treats non-null references, including empty strings, as truthy");
  assert.equal(wasm.logicalText(2), 40);
});

test("generated null checks cannot collide with user names or shadowed intrinsics", async (t) => {
  const wasm = await compile(t, `
    let __ls_isNull: i32 = 3;
    let __ls_isReference: i32 = 4;
    function isReference<T>(): bool { return true; }
    export function check(__ls_isNull_1: i32, __ls_isReference_1: i32): i32 {
      let value: i32 = 0;
      value ??= 9;
      return value + __ls_isNull + __ls_isReference + __ls_isNull_1 + __ls_isReference_1;
    }
  `);
  assert.equal(wasm.check(1, 2), 10);
});

test("logical assignment executes in loops, branches, and lowered closure bodies", async (t) => {
  const wasm = await compile(t, `
    let callback: () => void = (): void => {};
    let nullishCallback: () => void = (): void => {};
    let result: i32 = 0;
    let calls: i32 = 0;
    function next(): i32 { calls++; return 7; }
    export function main(): void {
      let value: i32 = 0;
      callback = (): void => { value ||= next(); result = value; };
      let optional: string | null = null;
      nullishCallback = (): void => { optional ??= "default"; result = optional!.length; };
    }
    export function fire(): i32 { callback(); return result * 10 + calls; }
    export function fireNullish(): i32 { nullishCallback(); return result * 10 + calls; }
    export function control(): i32 {
      let run: bool = true;
      let sum: i32 = 0;
      for (let i = 0; (run &&= i < 3); i++) {
        if (i == 0) continue;
        else if (i == 1) sum ||= 2;
        else sum += i;
      }
      do {
        sum++;
        switch (sum) {
          case 5: continue;
          default: run ||= true; break;
        }
      } while (sum < 6);
      return run ? sum : 0;
    }
  `);
  wasm.main();
  assert.equal(wasm.fire(), 71);
  assert.equal(wasm.fire(), 71, "captured slot is written only on the first call");
  assert.equal(wasm.fireNullish(), 71, "nullish lowering runs after closure capture renaming");
  assert.equal(wasm.control(), 6);
});

test("invalid targets and types never emit a successful artifact", async (t) => {
  const dir = workDirectory(t);
  const output = join(dir, "sample.wasm");
  const unsupported = await compileSource(
    "class Box { value: i32 = 0; } declare function getBox(): Box;"
      + " export function f(): void { getBox().value ||= 1; }",
    "sample.ts", output,
  );
  assert.equal(unsupported.errors[0].code, "LS1008");
  assert.equal(unsupported.loweredPath, null);
  assert.equal(existsSync(output), false);

  const good = await compileSource("export function f(): i32 { let x = 0; return x ||= 1; }", "sample.ts", output);
  assert.equal(good.compilerError, null, good.stderr);
  const previous = readFileSync(output);
  for (const statement of [
    'let value: i32 = 0; value ||= "wrong";',
    'let value: i32 = 0; value &&= "wrong";',
    'let value: i32 = 0; value ??= "wrong";',
    "const value: i32 = 0; value ||= 2;",
    "missing ||= 2;",
    "let value: i32 = 0; value ||= ;",
  ]) {
    const failed = await compileSource(`export function f(): void { ${statement} }`, "sample.ts", output);
    assert.ok(failed.compilerError || failed.errors.length > 0, statement);
    assert.deepEqual(readFileSync(output), previous);
  }
});

test("shipping CLI check, compile, and link all use logical-assignment lowering", async (t) => {
  const dir = workDirectory(t);
  const input = join(dir, "sample.ts");
  const output = join(dir, "sample.wasm");
  writeFileSync(input, `
    export function __la_ext_convert_default(value: f32): f32 { value ||= 3; return value; }
    export function __la_ext_cond_ready(): i32 { let ready = 0; return ready ||= 1; }
  `);
  execFileSync(process.execPath, [cli, "check", input], { stdio: "pipe" });
  execFileSync(process.execPath, [cli, "compile", input, "-o", output], { stdio: "pipe" });
  let { instance } = await WebAssembly.instantiate(readFileSync(output), imports);
  assert.equal(instance.exports.__la_ext_convert_default(0), 3);
  assert.equal(instance.exports.__la_ext_convert_default(2), 2);
  execFileSync(process.execPath, [cli, "link", `kit=${input}`, "-o", output], { stdio: "pipe" });
  ({ instance } = await WebAssembly.instantiate(readFileSync(output), imports));
  assert.equal(instance.exports.__la_ext_convert_kit_default(0), 3);
  assert.equal(instance.exports.__la_ext_cond_kit_ready(), 1);

  // A property target standing alone now compiles and runs through the
  // shipping CLI, temporaries and all.
  writeFileSync(input, `
    class Box { value: i32 = 0; }
    export function __la_ext_convert_default(value: f32): f32 {
      const box = new Box();
      box.value ||= 3;
      return value + f32(box.value);
    }
  `);
  execFileSync(process.execPath, [cli, "compile", input, "-o", output], { stdio: "pipe" });
  ({ instance } = await WebAssembly.instantiate(readFileSync(output), imports));
  assert.equal(instance.exports.__la_ext_convert_default(1), 4);

  writeFileSync(input, "function f(): void { items[index++] ||= 1; }");
  const rejected = spawnSync(process.execPath, [cli, "check", input], { encoding: "utf8" });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /LS1008/);
  assert.doesNotMatch(rejected.stderr, /\bok\b/);
});
