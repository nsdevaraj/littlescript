import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { compileSource } from "../src/compile.mjs";

test("compileSource runs the shipping frontend and emits WASM", async () => {
  const dir = mkdtempSync(join(process.cwd(), ".littlescript-compile-test-"));
  const output = join(dir, "sample.wasm");
  try {
    const result = await compileSource(
      "export function add(a: i32, b: i32): i32 { return a + b; }\n",
      "sample.ts",
      output,
    );
    assert.equal(result.errors.length, 0);
    assert.equal(result.compilerError, null);
    assert.ok(readFileSync(output).length > 8);
    assert.ok(existsSync(result.loweredPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ABI41 viewport declarations and onResize survive the shipping frontend", async () => {
  const dir = mkdtempSync(join(process.cwd(), ".littlescript-viewport-test-"));
  try {
    const output = join(dir, "viewport.wasm");
    const result = await compileSource(`
@external("la", "stageWidth") declare function stageWidth(): f32;
@external("la", "stageHeight") declare function stageHeight(): f32;
@external("la", "responsiveMode") declare function responsiveMode(): i32;
let width: f32 = 0, height: f32 = 0, mode: i32 = 0;
export function __la_abi_version(): i32 { return 41; }
export function onResize(): void { width = stageWidth(); height = stageHeight(); mode = responsiveMode(); }
export function getWidth(): f32 { return width; }
export function getHeight(): f32 { return height; }
export function getMode(): i32 { return mode; }
`, "viewport.ts", output);
    assert.deepEqual(result.errors, []);
    assert.equal(result.compilerError, null, result.stderr);
    const module = new WebAssembly.Module(readFileSync(output));
    assert.deepEqual(WebAssembly.Module.imports(module).filter((entry) => entry.module === "la").map((entry) => entry.name).sort(),
      ["responsiveMode", "stageHeight", "stageWidth"]);
    let stage = [1440, 900, 2];
    const { exports } = new WebAssembly.Instance(module, {
      la: { stageWidth: () => stage[0], stageHeight: () => stage[1], responsiveMode: () => stage[2] },
      env: { abort() { throw new Error("Unexpected script abort"); } },
    });
    assert.equal(exports.__la_abi_version(), 41);
    for (stage of [[1440, 900, 2], [768, 1100, 1], [393, 1100, 0]]) {
      exports.onResize();
      assert.deepEqual([exports.getWidth(), exports.getHeight(), exports.getMode()], stage);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assertion source locations do not depend on temporary output directories", async () => {
  const first = mkdtempSync(join(process.cwd(), ".littlescript-stable-a-"));
  const second = mkdtempSync(join(process.cwd(), ".littlescript-stable-b-"));
  const source = "export function check(value: i32): i32 { assert(value > 0); return value; }\n";
  try {
    const outputs = [];
    for (const dir of [first, second]) {
      const output = join(dir, "module.wasm");
      const result = await compileSource(source, "scene.ts", output);
      assert.equal(result.compilerError, null, result.stderr);
      outputs.push(readFileSync(output));
    }
    assert.deepEqual(outputs[0], outputs[1]);
    const instance = new WebAssembly.Instance(new WebAssembly.Module(outputs[0]), {
      env: { abort() { throw new Error("assertion preserved"); } },
    });
    assert.equal(instance.exports.check(3), 3);
    assert.throws(() => instance.exports.check(0), /assertion preserved/);
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test("compileSource refuses frontend errors without emitting output", async () => {
  const dir = mkdtempSync(join(process.cwd(), ".littlescript-compile-error-test-"));
  const output = join(dir, "sample.wasm");
  try {
    const result = await compileSource("export const value: any = 1;\n", "sample.ts", output);
    assert.ok(result.errors.length > 0);
    assert.equal(result.loweredPath, null);
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("relative output paths and imports keep their existing resolution directory", async () => {
  const dir = mkdtempSync(join(process.cwd(), ".littlescript-relative-test-"));
  try {
    writeFileSync(join(dir, "helper.ts"), "export function value(): i32 { return 17; }\n");
    const output = relative(process.cwd(), join(dir, "module.wasm"));
    const result = await compileSource(
      'import { value } from "./helper"; export function answer(): i32 { return value(); }\n',
      "scene.ts",
      output,
    );
    assert.equal(result.errors.length, 0);
    assert.equal(result.compilerError, null, result.stderr);
    const instance = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(output)));
    assert.equal(instance.exports.answer(), 17);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file compilation resolves sibling and nested imports beside the source, not the output", async () => {
  const dir = mkdtempSync(join(process.cwd(), ".littlescript-source-imports-"));
  try {
    const sourceDirectory = join(dir, "source");
    const outputDirectory = join(dir, "output");
    mkdirSync(sourceDirectory);
    mkdirSync(outputDirectory);
    writeFileSync(join(sourceDirectory, "notes.ts"), "export const first: i32 = 76;\n");
    writeFileSync(join(sourceDirectory, "catalog.ts"),
      'import { first } from "./notes"; export function note(): i32 { return first; }\n');
    const source = 'import { note } from "./catalog"; export function answer(): i32 { return note(); }\n';
    const input = join(sourceDirectory, "piano.ts");
    const output = join(outputDirectory, "piano.wasm");
    writeFileSync(input, source);
    const result = await compileSource(source, input, output, { sourceDirectory });
    assert.equal(result.compilerError, null, result.stderr);
    assert.ok(existsSync(join(outputDirectory, "piano.lowered.ts")));
    assert.equal(existsSync(join(sourceDirectory, "piano.lowered.ts")), false);
    const instance = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(output)));
    assert.equal(instance.exports.answer(), 76);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compileSource preserves the last good artifact on backend failure", async () => {
  const dir = mkdtempSync(join(process.cwd(), ".littlescript-compile-backend-error-test-"));
  const output = join(dir, "sample.wasm");
  try {
    const good = await compileSource(
      "export function value(): i32 { return 1; }\n",
      "sample.ts",
      output,
    );
    assert.equal(good.compilerError, null);
    const previous = readFileSync(output);

    const failed = await compileSource(
      'export function value(): i32 { return "wrong"; }\n',
      "sample.ts",
      output,
    );
    assert.ok(failed.compilerError);
    assert.deepEqual(readFileSync(output), previous);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reader(1), reader(2) cannot silently compile to the observed 22", async () => {
  const dir = mkdtempSync(join(process.cwd(), ".littlescript-capture-test-"));
  const output = join(dir, "readers.wasm");
  try {
    const result = await compileSource(`
type Reader = () => i32;
function reader(value: i32): Reader { return (): i32 => value; }
export function result(): i32 {
  const first = reader(1);
  const second = reader(2);
  return first() * 10 + second();
}
`, "readers.ts", output);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].code, "LS2006");
    assert.match(result.errors[0].message, /independently created capture environments/);
    assert.ok(result.errors[0].line > 0 && result.errors[0].col > 0);
    assert.equal(result.loweredPath, null);
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const { name, setup, expected, argument } of [
  {
    name: "an earlier argument assignment",
    setup: "register(value = 2, (): i32 => value);",
    expected: 2,
    argument: 2,
  },
  {
    name: "an earlier argument increment",
    setup: "register(value++, (): i32 => value);",
    expected: 2,
    argument: 1,
  },
  {
    name: "the selected true conditional branch",
    setup: "register(0, (value = 3) > 0 ? (): i32 => value : (): i32 => -1);",
    expected: 3,
    argument: 0,
  },
  {
    name: "the selected false conditional branch",
    setup: "register(0, (value = 4) < 0 ? (): i32 => -1 : (): i32 => value);",
    expected: 4,
    argument: 0,
  },
  {
    name: "a preceding comma expression",
    setup: "register(0, (value = 5, (): i32 => value));",
    expected: 5,
    argument: 0,
  },
]) {
  test(`capture snapshots preserve ${name} in executed WASM`, async (t) => {
    const dir = mkdtempSync(join(process.cwd(), ".littlescript-capture-order-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const output = join(dir, "capture-order.wasm");
    const result = await compileSource(`
type Reader = () => i32;
const handlers: Reader[] = [];
let first: i32 = 0;
function register(value: i32, reader: Reader): void {
  first = value;
  handlers.push(reader);
}
export function main(): void {
  let value: i32 = 1;
  ${setup}
}
export function read(): i32 { return handlers[0](); }
export function firstArgument(): i32 { return first; }
`, "capture-order.ts", output);
    assert.deepEqual(result.errors, []);
    assert.equal(result.compilerError, null, result.stderr);
    const { instance } = await WebAssembly.instantiate(readFileSync(output), {
      env: { abort() { throw new Error("Unexpected script abort"); } },
    });
    instance.exports.main();
    assert.equal(instance.exports.firstArgument(), argument);
    assert.equal(instance.exports.read(), expected);
  });
}
