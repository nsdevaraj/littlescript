// Imported-file lowering (RT19).
//
// The frontend's lowerings and its LS diagnostics used to apply to the file
// handed to `compile` and to nothing it imported: `import { pick } from
// "./shape"` reached asc as the author wrote it, so the same construct failed
// in one file and compiled in another. These tests compile a multi-file
// program with the real `asc`, RUN it, and compare against what the language
// says the answer is — matching emitted text would only prove the lowering is
// the one written down.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { compileSource } from "../src/compile.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const cli = join(root, "tools/littlescript/src/cli.mjs");
const imports = { env: { abort: () => { throw new Error("script aborted"); } } };

function workspace(t) {
  const dir = mkdtempSync(join(here, ".imports-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Write `units` into a fresh directory and compile `entry` from there. */
async function compileUnits(t, units, entry, { debug = false } = {}) {
  const dir = workspace(t);
  for (const [name, text] of Object.entries(units)) writeFileSync(join(dir, name), text);
  const input = join(dir, entry.name);
  writeFileSync(input, entry.text);
  const output = join(dir, entry.name.replace(/\.ts$/, ".wasm"));
  const result = await compileSource(entry.text, input, output, {
    sourceDirectory: dir,
    debug,
  });
  return { dir, input, output, result };
}

const SHAPE = `class Box { x: i32 = 0; constructor(v: i32) { this.x = v; } }
export function pick(present: bool, value: i32): i32 {
  const boxed: Box | null = present ? new Box(value) : null;
  const fallback: Box = new Box(7);
  const chosen: Box = boxed ?? fallback;
  return chosen.x;
}
`;

test("nullish lowering applies inside an imported unit", async (t) => {
  const { dir, output, result } = await compileUnits(
    t,
    { "shape.ts": SHAPE },
    {
      name: "scene.ts",
      text: 'import { pick } from "./shape";\nexport function main(): i32 { return pick(false, 9); }\nexport function kept(v: i32): i32 { return pick(true, v); }\n',
    },
  );
  assert.deepEqual(result.errors, [], result.stderr);
  assert.equal(result.compilerError, null, result.stderr);
  const { instance } = await WebAssembly.instantiate(readFileSync(output), imports);
  assert.equal(instance.exports.main(), 7, "an absent reference falls through to the fallback");
  assert.equal(instance.exports.kept(9), 9, "a present one is kept");
  assert.equal(
    existsSync(join(dir, "shape.lowered.ts")),
    false,
    "lowering is in memory; it must not litter the author's source tree",
  );
});

test("a form the frontend refuses is refused in an imported unit too", async (t) => {
  // The closure-lowering contract is single-shot `main`, so a closure over a
  // local in any other function is an LS2006 refusal — and it has to be the
  // SAME refusal when that function lives in an imported unit, not an asc
  // error about syntax the author never wrote.
  const { output, result } = await compileUnits(
    t,
    {
      "counter.ts": `type Callback = (other: i32) => void;
const handlers: Callback[] = [];
export function on(cb: Callback): void { handlers.push(cb); }
let score: i32 = 0;
export function install(coin: i32): void {
  on((other: i32): void => { if (other == coin) score += 1; });
}
export function getScore(): i32 { return score; }
`,
    },
    {
      name: "scene.ts",
      text: 'import { getScore, install } from "./counter";\nexport function main(): i32 { install(42); return getScore(); }\n',
    },
  );
  const errors = result.errors.filter((diagnostic) => diagnostic.severity === "error");
  assert.equal(errors.length, 1, result.stderr);
  assert.equal(errors[0].code, "LS2006");
  assert.ok(
    errors[0].file.endsWith("counter.ts"),
    `the diagnostic must name the imported unit, not the entry (got ${errors[0].file})`,
  );
  assert.ok(errors[0].fixit, "and still carry its fix-it");
  assert.equal(result.loweredPath, null);
  assert.equal(existsSync(output), false);
});

test("an unsupported form in an imported unit refuses the program at its own line", async (t) => {
  const { output, result } = await compileUnits(
    t,
    { "broken.ts": "export const value: i32 = 1;\nexport const bad: any = 2;\n" },
    { name: "scene.ts", text: 'import { value } from "./broken";\nexport function main(): i32 { return value; }\n' },
  );
  const errors = result.errors.filter((diagnostic) => diagnostic.severity === "error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "LS1001");
  assert.equal(errors[0].line, 2);
  assert.ok(errors[0].file.endsWith("broken.ts"));
  assert.equal(result.loweredPath, null, "a refused program writes no lowered unit");
  assert.equal(existsSync(output), false, "and emits no artifact");
});

test("a unit reached through two importers is lowered once", async (t) => {
  const { output, result } = await compileUnits(
    t,
    {
      "shared.ts": "export const base: i32 = 40;\n",
      "left.ts": 'import { base } from "./shared";\nexport function left(): i32 { return base + 1; }\n',
      "right.ts": 'import { base } from "./shared";\nexport function right(): i32 { return base + 2; }\n',
    },
    {
      name: "scene.ts",
      text: 'import { left } from "./left";\nimport { right } from "./right";\nexport function main(): i32 { return left() + right(); }\n',
    },
  );
  assert.deepEqual(result.errors, [], result.stderr);
  assert.equal(result.compilerError, null, result.stderr);
  const { instance } = await WebAssembly.instantiate(readFileSync(output), imports);
  assert.equal(instance.exports.main(), 83);
});

test("a nested import is lowered as well as a direct one", async (t) => {
  const { output, result } = await compileUnits(
    t,
    {
      "deep.ts": `class Box { x: i32 = 0; constructor(v: i32) { this.x = v; } }
export function deep(present: bool): i32 {
  const boxed: Box | null = present ? new Box(5) : null;
  return (boxed ?? new Box(6)).x;
}
`,
      "middle.ts": 'import { deep } from "./deep";\nexport function middle(): i32 { return deep(false); }\n',
    },
    { name: "scene.ts", text: 'import { middle } from "./middle";\nexport function main(): i32 { return middle(); }\n' },
  );
  assert.deepEqual(result.errors, [], result.stderr);
  const { instance } = await WebAssembly.instantiate(readFileSync(output), imports);
  assert.equal(instance.exports.main(), 6);
});

test("a debug build points the imported unit's map at the file the author wrote", async (t) => {
  const { dir, output, result } = await compileUnits(
    t,
    { "shape.ts": SHAPE },
    {
      name: "scene.ts",
      text: 'import { pick } from "./shape";\nexport function main(): i32 { return pick(true, 3); }\n',
    },
    { debug: true },
  );
  assert.equal(result.compilerError, null, result.stderr);
  const map = JSON.parse(readFileSync(`${output}.map`, "utf8"));
  const index = map.sources.findIndex((name) => name.endsWith("shape.ts"));
  assert.ok(index >= 0, `the imported unit must appear in the map (sources: ${map.sources})`);
  assert.equal(
    map.sources[index],
    join(dir, "shape.ts"),
    "the map names the authored file, not a lowered copy",
  );
  assert.ok(
    map.sourcesContent[index].includes("?? fallback"),
    "and carries the authored text, so a debugger can show it",
  );
});

test("a linked unit's imported helper is lowered too", async (t) => {
  // The linker lowers the units it is given; a helper one of them imports is
  // written by the same author and must mean the same thing.
  const dir = workspace(t);
  writeFileSync(
    join(dir, "shape.ts"),
    `class Box { x: i32 = 0; constructor(v: i32) { this.x = v; } }
export function pick(present: bool, value: i32): i32 {
  const boxed: Box | null = present ? new Box(value) : null;
  return (boxed ?? new Box(7)).x;
}
`,
  );
  const unit = join(dir, "unit.ts");
  // A linker re-exports a unit's extension exports (and the shared entry
  // points), not every function it happens to define, so the value is read
  // back through the one protocol name the module does surface.
  writeFileSync(
    unit,
    'import { pick } from "./shape";\nexport function __la_ext_action_pick(): i32 { return pick(false, 9); }\n',
  );
  const output = join(dir, "linked.wasm");
  const result = spawnSync(
    process.execPath,
    [cli, "link", `=${unit}`, "-o", output],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const { instance } = await WebAssembly.instantiate(readFileSync(output), imports);
  assert.equal(instance.exports.__la_ext_action_pick(), 7);
});

test("a linked unit's imported helper is refused at its own line", async (t) => {
  const dir = workspace(t);
  writeFileSync(join(dir, "broken.ts"), "export const value: i32 = 1;\nexport const bad: any = 2;\n");
  const unit = join(dir, "unit.ts");
  writeFileSync(unit, 'import { value } from "./broken";\nexport function main(): i32 { return value; }\n');
  const output = join(dir, "linked.wasm");
  const result = spawnSync(
    process.execPath,
    [cli, "link", `=${unit}`, "-o", output],
    { cwd: root, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0, "an unsupported form in a helper must fail the link");
  assert.match(result.stderr, /broken\.ts:2:\d+ error LS1001/);
  assert.equal(existsSync(output), false, "and produce no module");
});
