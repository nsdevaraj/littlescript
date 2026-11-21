// LittleScript frontend tests: subset diagnostics + closure lowering,
// through to running the lowered WASM (the audit's failing sample).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import asc from "assemblyscript/asc";
import { transform } from "../src/frontend.mjs";

const codes = (r) => r.diagnostics.map((d) => d.code);
const errors = (r) => r.diagnostics.filter((d) => d.severity === "error");

test("bans any, eval, dynamic import, Function, delete — with fix-its", () => {
  const r = transform(`
    export function f(x: any): void {}
    export function g(): void { eval("1"); }
    export function h(): void { import("./mod"); }
    export function i(): void { new Function("x"); }
  `);
  assert.deepEqual(
    codes(r).sort(),
    ["LS1001", "LS1002", "LS1003", "LS1004"],
  );
  assert.ok(r.diagnostics.every((d) => d.severity === "error" && d.fixit));
  assert.ok(r.diagnostics.every((d) => d.line > 0 && d.col > 0));
});

test("bans the delete operator with LS1005 + fix-it", () => {
  const r = transform(`
class Box { x: i32 = 0; }
export function f(b: Box): void { delete b.x; }
`);
  assert.ok(codes(r).includes("LS1005"), "delete must be rejected");
  const d = r.diagnostics.find((x) => x.code === "LS1005");
  assert.equal(d.severity, "error");
  assert.match(d.fixit, /Map|sentinel/);
});

test("clean subset code produces no diagnostics and is unchanged", () => {
  const src = `let total: i32 = 0;\nexport function add(v: i32): void { total += v; }\n`;
  const r = transform(src);
  assert.equal(r.diagnostics.length, 0);
  assert.equal(r.code, src);
});

test("single-shot main closure over a local lowers to module state", () => {
  const r = transform(`
type Callback = (other: u32) => void;
const handlers: Callback[] = [];
export function on(cb: Callback): void { handlers.push(cb); }
let score: i32 = 0;
export function main(): void {
  const coin: u32 = 42;
  on((other: u32): void => {
    if (other == coin) score += 1;
  });
}
export function getScore(): i32 { return score; }
`);
  assert.deepEqual(codes(r), ["LS2001"]);
  assert.equal(errors(r).length, 0);
  // Captured local hoisted; module-scope `score` NOT captured.
  assert.match(r.code, /let __ls_cap_0_coin/);
  assert.ok(!r.code.includes("__ls_cap_0_score"), "module globals are not captures");
  assert.match(r.code, /function __ls_closure_0\(other: u32\): void/);
  assert.match(r.code, /on\(\(__ls_cap_0_coin = coin, __ls_closure_0\)\)/);
});

test("closure in a loop is rejected with LS2002", () => {
  const r = transform(`
export function bad(): void {
  for (let i = 0; i < 3; i++) {
    const j: i32 = i;
    register((): void => { use(j); });
  }
}
declare function register(cb: () => void): void;
declare function use(v: i32): void;
`);
  assert.ok(codes(r).includes("LS2002"));
});

test("capture reassigned after creation is rejected with LS2003", () => {
  const r = transform(`
export function bad(): void {
  let target: u32 = 1;
  register((): void => { use(target); });
  target = 2;
}
declare function register(cb: () => void): void;
declare function use(v: u32): void;
`);
  assert.ok(codes(r).includes("LS2003"));
  assert.match(errors(r)[0].fixit, /Snapshot/);
});

test("capture mutated by compound assignment or ++ after creation is LS2003", () => {
  const plus = transform(`
export function bad(): void {
  let n: i32 = 0;
  register((): void => { use(n); });
  n += 5;
}
declare function register(cb: () => void): void;
declare function use(v: i32): void;
`);
  assert.ok(codes(plus).includes("LS2003"), "+= is a reassignment");

  const inc = transform(`
export function bad(): void {
  let n: i32 = 0;
  register((): void => { use(n); });
  n++;
}
declare function register(cb: () => void): void;
declare function use(v: i32): void;
`);
  assert.ok(codes(inc).includes("LS2003"), "++ is a reassignment");
});

test("capture declared after the closure is rejected with LS2004", () => {
  const r = transform(`
export function bad(): void {
  register((): void => { use(later); });
  let later: i32 = 5;
}
declare function register(cb: () => void): void;
declare function use(v: i32): void;
`);
  assert.ok(codes(r).includes("LS2004"));
});

test("nested closures are rejected with LS2005 instead of failing in asc", () => {
  const r = transform(`
export function bad(): void {
  let a: i32 = 1;
  register((): void => {
    register((): void => { use(a); });
  });
}
declare function register(cb: () => void): void;
declare function use(v: i32): void;
`);
  assert.ok(codes(r).includes("LS2005"));
});

test("reentrant audit sample is rejected instead of sharing its capture slot", () => {
  const source = readFileSync(
    new URL("../../../spikes/littlescript-toolchain/assembly/03_closures.ts", import.meta.url), "utf8");
  assert.ok(codes(transform(source)).includes("LS2006"));
});

test("aliases, recursive setup and callback registration factories cannot reuse capture slots", () => {
  for (const source of [
    `export function main(): void { const n: i32 = 1; register((): i32 => n); }
     const again = main;`,
    `export function main(): void { const n: i32 = 1; register((): i32 => n); main(); }`,
    `export function wire(n: i32): void { register((): i32 => n); }`,
  ]) {
    const result = transform(source);
    assert.ok(codes(result).includes("LS2006"));
    assert.match(errors(result).find((d) => d.code === "LS2006").fixit, /per-instance state/);
  }
});

test("end-to-end: supported single-shot captured game handler compiles and runs", async () => {
  const source = readFileSync(
    new URL("../../../crates/la-script/fixtures/game.ls.ts", import.meta.url),
    "utf8",
  );
  const { code, diagnostics } = transform(source, "03_closures.ts");
  assert.equal(errors({ diagnostics }).length, 0, JSON.stringify(diagnostics));

  const dir = mkdtempSync(join(process.cwd(), ".ls-"));
  try {
  const lowered = join(dir, "lowered.ts");
  const wasm = join(dir, "out.wasm");
  writeFileSync(lowered, code);
  const { error, stderr } = await asc.main([
    lowered, "--outFile", wasm, "--optimizeLevel", "0", "--runtime", "incremental",
  ]);
  assert.equal(error, null, stderr?.toString());

  // Run it: wire a handler capturing coin=42, fire events, check score.
  const { instance } = await WebAssembly.instantiate(readFileSync(wasm), {
    env: { abort: () => { throw new Error("abort"); } },
    la: { getSpriteByName: () => 1, getX: () => 0, setX() {} },
  });
  const { main, onEvent, getScore } = instance.exports;
  main();
  onEvent(2, 1, 2);
  onEvent(1, 1, 2);
  onEvent(1, 1, 2);
  assert.equal(getScore(), 20, "single-shot captured handler retains its meaning");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
