// Nullish coalescing and optional chaining (RT19).
//
// AssemblyScript's parser accepts neither `??` nor `?.`. Left alone they
// reached `asc` and came back as a bare `ERROR TS1109: Expression expected.`
// — no LittleA code, no fix-it, no original source position — which is the
// exact failure mode the frontend exists to prevent.
//
// These tests compile the lowered output with the real `asc` and then RUN it,
// comparing against what JavaScript would answer. Matching the emitted text
// would only prove the lowering is the one that was written down; running it
// proves the lowering is right. The two places the lowering could be subtly
// wrong — a zero that is not nullish, and an absent numeric member, which
// AssemblyScript reads as the same bit pattern — are pinned by value.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { compileSource } from "../src/compile.mjs";
import { transform } from "../src/frontend.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const imports = { env: { abort: () => { throw new Error("script aborted"); } } };
const errors = (result) => result.diagnostics.filter((d) => d.severity === "error");

/** Lower, compile with the real `asc`, instantiate, and call `main`. */
async function run(t, body) {
  const dir = mkdtempSync(join(here, ".nullish-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lowered = transform(body, "sample.ts");
  assert.deepEqual(lowered.diagnostics, [], body);
  const output = join(dir, "sample.wasm");
  const compiled = await compileSource(lowered.code, "sample.ts", output);
  assert.equal(compiled.compilerError, null, compiled.stderr);
  const { instance } = await WebAssembly.instantiate(readFileSync(output), imports);
  return instance.exports.main();
}

const POINT = "class P { x: i32 = 5; }\n";
const NESTED = "class Q { y: i32 = 7; }\nclass P { q: Q | null = new Q(); }\n";

test("nullish coalescing answers the first operand that is present", async (t) => {
  assert.equal(
    await run(t, `${POINT}export function main(): i32 {
      const a: P | null = new P(); const b: P = new P(); b.x = 9;
      const c: P = a ?? b; return c.x; }`),
    5,
    "a present reference is kept",
  );
  assert.equal(
    await run(t, `${POINT}export function main(): i32 {
      const a: P | null = null; const b: P = new P(); b.x = 9;
      const c: P = a ?? b; return c.x; }`),
    9,
    "an absent one falls through",
  );
});

test("a zero is not nullish", async (t) => {
  // The trap this lowering is built around: `null` compares equal to numeric
  // zero in AssemblyScript, so a naive `a === null` test would answer 7 here.
  // JavaScript answers 0, because 0 is not nullish.
  assert.equal(await run(t, "export function main(): i32 { const a: i32 = 0; return a ?? 7; }"), 0);
  assert.equal(
    await run(t, "export function main(): f64 { const a: f64 = 0.0; return a ?? 7.0; }"),
    0,
  );
});

test("a chain of fallbacks takes the first present one", async (t) => {
  assert.equal(
    await run(t, `${POINT}export function main(): i32 {
      const a: P | null = null; const b: P | null = null; const c: P = new P(); c.x = 3;
      const r: P = a ?? b ?? c; return r.x; }`),
    3,
  );
  assert.equal(
    await run(t, `${POINT}export function main(): i32 {
      const a: P | null = null; const b: P = new P(); b.x = 2; const c: P = new P(); c.x = 3;
      const r: P = a ?? b ?? c; return r.x; }`),
    2,
    "the middle operand wins when it is present",
  );
});

test("a fallback chain grows linearly rather than nesting itself", () => {
  // Lowering by recursing on the left operand would put the accumulated
  // fallback inside itself once per link, which is exponential in the chain's
  // length. Twenty operands is an odd thing to write, but a compiler that
  // turns it into half a megabyte is worse than one that does not.
  const sizeOf = (n) => {
    const operands = Array.from({ length: n }, (_, i) => `v${i}`).join(" ?? ");
    return transform(
      `export function main(): i32 { const v0: i32 = 0; return ${operands}; }`,
      "growth.ts",
    ).code.length;
  };
  const step = sizeOf(3) - sizeOf(2);
  for (const n of [4, 6, 10, 20]) {
    const growth = sizeOf(n) - sizeOf(n - 1);
    assert.ok(growth <= step * 2, `${n} operands grew by ${growth}, one operand costs ${step}`);
  }
});

test("optional chaining reads through when present and answers the fallback when absent", async (t) => {
  assert.equal(
    await run(t, `${POINT}export function main(): i32 {
      const p: P | null = new P(); return p?.x ?? 42; }`),
    5,
  );
  assert.equal(
    await run(t, `${POINT}export function main(): i32 {
      const p: P | null = null; return p?.x ?? 42; }`),
    42,
    "an absent receiver answers the fallback, not the member's zero",
  );
  assert.equal(
    await run(t, `export function main(): i32 {
      const a: i32[] | null = [3, 4]; return a?.[1] ?? 42; }`),
    4,
  );
  assert.equal(
    await run(t, `export function main(): i32 {
      const a: i32[] | null = null; return a?.[1] ?? 42; }`),
    42,
  );
});

test("every link in a chain is guarded, not just the first", async (t) => {
  assert.equal(await run(t, `${NESTED}export function main(): i32 {
    const p: P | null = new P(); return p?.q?.y ?? 42; }`), 7);
  assert.equal(await run(t, `${NESTED}export function main(): i32 {
    const p: P | null = new P(); p.q = null; return p?.q?.y ?? 42; }`), 42, "inner link absent");
  assert.equal(await run(t, `${NESTED}export function main(): i32 {
    const p: P | null = null; return p?.q?.y ?? 42; }`), 42, "outer link absent");
});

test("an optional chain without a fallback is refused, because nothing can name the absent case", () => {
  // AssemblyScript has no `undefined`, and `null` in a numeric member's place
  // reads as zero — so a bare `p?.x` would answer 0 where JavaScript answers
  // `undefined`. The fallback is required, and the two lower together.
  const result = transform(`${POINT}export function main(): i32 {
  const p: P | null = null; const v: i32 = p?.x; return v; }`);
  assert.equal(errors(result).length, 1);
  assert.equal(errors(result)[0].code, "LS1009");
  assert.equal(
    errors(result)[0].message,
    "optional chaining needs a `??` fallback in LittleScript",
  );
  assert.match(errors(result)[0].fixit, /add the value to use when it is absent/);
});

test("a chain reports once, at the link that owns the fallback", () => {
  const result = transform(`${NESTED}export function main(): void {
  const p: P | null = null; const v: i32 = p?.q?.y; }`);
  assert.equal(errors(result).filter((d) => d.code === "LS1009").length, 1);
});

test("a receiver that does something when read is refused rather than read twice", () => {
  for (const source of [
    "declare function get(): i32[]; function f(): i32 { return get()?.[0] ?? 0; }",
    "declare function get(): i32; function f(): i32 { return get() ?? 0; }",
  ]) {
    const result = transform(source);
    assert.ok(
      errors(result).some((d) => d.code === "LS1008"),
      `${source}: ${JSON.stringify(result.diagnostics)}`,
    );
  }
});

test("the lowering adds no host capabilities and stays idempotent", async (t) => {
  const dir = mkdtempSync(join(here, ".nullish-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = `${POINT}export function main(): i32 {
    const p: P | null = new P(); return p?.x ?? 42; }`;
  const lowered = transform(source, "sample.ts");
  assert.equal(
    transform(lowered.code, "sample.ts").code,
    lowered.code,
    "lowered output contains no `??`/`?.` left to lower",
  );
  const output = join(dir, "sample.wasm");
  const compiled = await compileSource(lowered.code, "sample.ts", output);
  assert.equal(compiled.compilerError, null, compiled.stderr);
  const { module } = await WebAssembly.instantiate(readFileSync(output), imports);
  assert.ok(
    WebAssembly.Module.imports(module).every(
      ({ module: from, name }) => from === "env" && name === "abort",
    ),
    "the null test is a compiled helper, not a host import",
  );
});

test("destructuring is named rather than left to the AssemblyScript parser", () => {
  for (const source of [
    "function f(): i32 { const [a, b] = [1, 2]; return a + b; }",
    "class P { x: i32 = 1; }\nfunction f(p: P): i32 { const { x } = p; return x; }",
  ]) {
    const result = transform(source);
    assert.equal(errors(result).length, 1, source);
    assert.equal(errors(result)[0].code, "LS1007");
    assert.equal(errors(result)[0].message, "destructuring is not part of LittleScript");
    assert.match(errors(result)[0].fixit, /name each binding in its own declaration/);
  }
});

test("the subset bans still apply inside the new syntax", () => {
  const banned = transform("function f(a: i32): i32 { return a ?? eval(\"1\"); }");
  assert.ok(errors(banned).some((d) => d.code === "LS1002"));
  const deleted = transform("class P { x: i32 = 1; }\nfunction f(p: P | null): i32 { return p?.x ?? (delete p) ? 1 : 0; }");
  assert.ok(errors(deleted).some((d) => d.code === "LS1005"));
});

test("a plain suffix of an optional chain is lowered with it", async (t) => {
  // CQ83: `p?.q.y` carries `?.` on the inner link and a plain `.y` outside
  // it. TypeScript still marks `.y` as part of the chain; a lowering that
  // read only `questionDotToken` left the whole expression unlowered and
  // emitted bogus LS1009 for the inner link.
  assert.equal(
    await run(t, `${NESTED}export function main(): i32 {
      const p: P | null = new P(); return p?.q.y ?? 42; }`),
    7,
    "a present chain reads through the plain suffix",
  );
  assert.equal(
    await run(t, `${NESTED}export function main(): i32 {
      const p: P | null = null; return p?.q.y ?? 42; }`),
    42,
    "an absent chain root answers the fallback",
  );
  assert.equal(
    await run(t, `${NESTED}export function main(): i32 {
      const p: P | null = new P(); p.q = null; return p?.q.y ?? 42; }`),
    42,
    "an absent intermediate receiver answers the fallback",
  );

  const lowered = transform(
    `${NESTED}function f(p: P | null): i32 { return p?.q.y ?? 42; }`,
    "suffix.ts",
  );
  assert.deepEqual(lowered.diagnostics, []);
  assert.ok(!lowered.code.includes("?."), "no `?.` may reach asc");
});
