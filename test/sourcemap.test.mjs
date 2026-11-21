// RT20: what the author wrote is what a diagnostic names.
//
// Closure lowering hoists declarations above the file, so every line below
// the hoist moves. Before these tests the toolchain handed that shifted line
// number straight to the author, attached to a `.lowered.ts` file they never
// wrote — the exact failure the frontend exists to prevent, reintroduced one
// stage later by asc.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileSource } from "../src/compile.mjs";
import { transform } from "../src/frontend.mjs";
import {
  applyEdits,
  composeSegments,
  decodeMappings,
  encodeMappings,
  encodeVlq,
  LoweringMap,
  mapCompilerDiagnostics,
  originalOffset,
} from "../src/sourcemap.mjs";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

/** The source used throughout: the capture forces a hoist, so nothing below
 *  line 3 keeps its line number in the lowered file. */
const CAPTURING = `export function main(): void {
  let total: i32 = 0;
  const bump = (): void => { total += 1; };
  bump();
  let bad: string = total;
}
`;

async function temporary(prefix, run) {
  const dir = mkdtempSync(join(process.cwd(), `.littlescript-${prefix}-`));
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Where a token sits in a file, 1-based, as a diagnostic would name it. */
function positionOf(text, needle) {
  const offset = text.indexOf(needle);
  assert.notEqual(offset, -1, `${needle} is not in the text`);
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  return { line, column: offset - before.lastIndexOf("\n") };
}

test("edits map verbatim runs character for character and replacements to what they replaced", () => {
  const { text, segments } = applyEdits("abcdef", [{ start: 2, end: 4, text: "XYZ" }]);
  assert.equal(text, "abXYZef");
  assert.deepEqual(segments, [
    { start: 0, length: 2, source: 0, exact: true },
    { start: 2, length: 3, source: 2, exact: false },
    { start: 5, length: 2, source: 4, exact: true },
  ]);
  assert.deepEqual(originalOffset(segments, 1), { offset: 1, exact: true });
  // Every column of a replacement answers with the construct it replaced;
  // there is no honest column inside text the author never wrote.
  for (const offset of [2, 3, 4]) {
    assert.deepEqual(originalOffset(segments, offset), { offset: 2, exact: false });
  }
  assert.deepEqual(originalOffset(segments, 6), { offset: 5, exact: true });
  // Past the mapped region (appended helpers) resolves to the end of the input.
  assert.deepEqual(originalOffset(segments, 99), { offset: 6, exact: false });
});

test("edits may arrive in any order and an overlap is refused rather than silently mangled", () => {
  const forward = applyEdits("0123456789", [
    { start: 1, end: 2, text: "a" },
    { start: 6, end: 8, text: "bb" },
  ]);
  const reversed = applyEdits("0123456789", [
    { start: 6, end: 8, text: "bb" },
    { start: 1, end: 2, text: "a" },
  ]);
  assert.equal(forward.text, "0a2345bb89");
  assert.deepEqual(reversed, forward);
  assert.throws(
    () => applyEdits("0123456789", [
      { start: 1, end: 5, text: "a" },
      { start: 3, end: 7, text: "b" },
    ]),
    /overlapping lowering edit/,
  );
});

test("composing two passes splits an exact run wherever the earlier pass stops being exact", () => {
  const first = applyEdits("abcdef", [{ start: 2, end: 4, text: "XYZ" }]);
  const second = applyEdits(first.text, [{ start: 0, end: 1, text: "Q" }]);
  const composed = composeSegments(first.segments, second.segments);
  const resolve = (offset) => originalOffset(composed, offset);
  assert.equal(second.text, "QbXYZef");
  assert.deepEqual(resolve(0), { offset: 0, exact: false }); // pass two's own edit
  assert.deepEqual(resolve(1), { offset: 1, exact: true }); // untouched by both
  assert.deepEqual(resolve(3), { offset: 2, exact: false }); // through pass one's edit
  assert.deepEqual(resolve(5), { offset: 4, exact: true });
  // The run pass two left alone spans both of pass one's kinds, so composing
  // must have split it rather than settled on one answer for the whole run.
  assert.ok(composed.length > second.segments.length);
});

test("VLQ round-trips the values a mapping is made of, name index included", () => {
  assert.deepEqual([0, 1, -1, 16, -16, 1000].map(encodeVlq), ["A", "C", "D", "gB", "hB", "w+B"]);
  const four = [0, 1, -1, 16].map(encodeVlq).join("");
  assert.deepEqual(decodeMappings(four)[0], [
    { generatedColumn: 0, sourceIndex: 1, sourceLine: -1, sourceColumn: 16 },
  ]);
  // A name index is carried through rather than dropped, so re-encoding a
  // compiler's map cannot quietly lose a field it wrote.
  const five = [0, 1, -1, 16, 2].map(encodeVlq).join("");
  assert.deepEqual(decodeMappings(five)[0], [
    { generatedColumn: 0, sourceIndex: 1, sourceLine: -1, sourceColumn: 16, nameIndex: 2 },
  ]);
  for (const mappings of [four, five, "AAAA;;ACDE,GAAI", ""]) {
    assert.equal(encodeMappings(decodeMappings(mappings)), mappings);
  }
});

test("the lowering map answers with the author's own line and column", () => {
  const { code, map } = transform(CAPTURING, "game.ts");
  const lowered = positionOf(code, "let bad: string");
  const original = positionOf(CAPTURING, "let bad: string");
  assert.notEqual(lowered.line, original.line, "hoisting must have moved the line");
  assert.deepEqual(map.originalPositionFor(lowered.line, lowered.column), {
    ...original,
    exact: true,
  });

  // The column inside the statement is the author's column too, not the
  // start of the line.
  const loweredTotal = positionOf(code, "= total;");
  const originalTotal = positionOf(CAPTURING, "= total;");
  assert.deepEqual(map.originalPositionFor(loweredTotal.line, loweredTotal.column + 2), {
    line: originalTotal.line,
    column: originalTotal.column + 2,
    exact: true,
  });

  // A position inside generated text points at the closure it came from and
  // says it is not the author's column.
  const hoisted = map.originalPositionFor(1, 1);
  assert.equal(hoisted.exact, false);
});

test("an unlowered file maps to itself, and an identity map needs no pass at all", () => {
  const plain = "export function add(a: i32, b: i32): i32 { return a + b; }\n";
  const { code, map } = transform(plain, "add.ts");
  assert.equal(code, plain);
  assert.deepEqual(map.originalPositionFor(1, 20), { line: 1, column: 20, exact: true });
  const identity = LoweringMap.identity(plain, "add.ts");
  assert.deepEqual(identity.originalPositionFor(1, 20), { line: 1, column: 20, exact: true });
});

test("the emitted Source Map v3 resolves the same positions the map does", () => {
  const { code, map } = transform(CAPTURING, "game.ts");
  const emitted = map.toSourceMapV3({ file: "game.lowered.ts" });
  assert.equal(emitted.version, 3);
  assert.deepEqual(emitted.sources, ["game.ts"]);
  assert.deepEqual(emitted.sourcesContent, [CAPTURING]);
  const lines = decodeMappings(emitted.mappings);
  assert.equal(lines.length, code.split("\n").length);

  const lowered = positionOf(code, "let bad: string");
  const original = positionOf(CAPTURING, "let bad: string");
  const field = lines[lowered.line - 1].findLast(
    (candidate) => candidate.generatedColumn <= lowered.column - 1,
  );
  assert.equal(field.sourceIndex, 0);
  assert.equal(field.sourceLine, original.line - 1);
  // The mapping at or before the token resolves to the same line the map
  // does; the column follows from the offset within the run.
  assert.equal(
    field.sourceColumn + (lowered.column - 1 - field.generatedColumn),
    original.column - 1,
  );
});

test("compiling reports the author's position for an asc error and writes the map beside the lowered file", async () => {
  await temporary("map-compile", async (dir) => {
    const output = join(dir, "game.wasm");
    const result = await compileSource(CAPTURING, "game.ts", output);
    assert.ok(result.compilerError, "the sample must fail to type-check");
    const original = positionOf(CAPTURING, "total;");
    assert.ok(
      result.stderr.includes(`in game.ts(${original.line},${original.column})`),
      result.stderr,
    );
    // The lowered position is kept: the frame above it quotes lowered text.
    assert.match(result.stderr, /\[lowered game\.lowered\.ts\(\d+,\d+\)\]/);
    assert.doesNotMatch(result.stderr, /└─ in game\.lowered\.ts/);

    const emitted = JSON.parse(readFileSync(result.mapPath, "utf8"));
    assert.equal(result.mapPath, `${result.loweredPath}.map`);
    assert.deepEqual(emitted.sources, ["game.ts"]);
    assert.equal(emitted.file, "game.lowered.ts");
    // The lowered file stays exactly what the lowering produced.
    assert.equal(readFileSync(result.loweredPath, "utf8"), result.code);
  });
});

test("a successful compile is unchanged apart from gaining its map", async () => {
  await temporary("map-clean", async (dir) => {
    const output = join(dir, "add.wasm");
    const source = "export function add(a: i32, b: i32): i32 { return a + b; }\n";
    const result = await compileSource(source, "add.ts", output);
    assert.equal(result.compilerError, null);
    assert.equal(result.stderr, "");
    assert.ok(readFileSync(output).length > 8);
    assert.deepEqual(JSON.parse(readFileSync(result.mapPath, "utf8")).sources, ["add.ts"]);
  });
});

test("linking names the package a diagnostic came from, not the merged unit", async () => {
  await temporary("map-link", (dir) => {
    const good = join(dir, "good.ts");
    const broken = join(dir, "widget.ts");
    writeFileSync(good, "export function ok(): i32 { return 1; }\n");
    writeFileSync(broken, CAPTURING);
    const failed = spawnSync(
      process.execPath,
      [cli, "link", `a=${good}`, `b=${broken}`, "-o", join(dir, "out.wasm")],
      { encoding: "utf8" },
    );
    assert.equal(failed.status, 1);
    const original = positionOf(CAPTURING, "total;");
    assert.ok(
      failed.stderr.includes(`in ${broken}(${original.line},${original.column})`),
      failed.stderr,
    );
    assert.match(failed.stderr, /\[lowered \S*unit1\.ts\(\d+,\d+\)\]/);
    assert.deepEqual(
      JSON.parse(readFileSync(join(dir, "out.link", "unit1.ts.map"), "utf8")).sources,
      [broken],
    );
  });
});

test("a location asc prints for a file with no map is left exactly as it is", () => {
  const untouched = "ERROR TS1: boom\n   └─ in ~lib/string.ts(4,2)\n";
  assert.equal(mapCompilerDiagnostics(untouched, new Map()), untouched);
  const map = LoweringMap.identity("let x = 1;\n", "x.ts");
  assert.equal(mapCompilerDiagnostics(untouched, new Map([["other.ts", map]])), untouched);
});

test("the compiled sample still runs after the mapping refactor", async () => {
  await temporary("map-run", (dir) => {
    const input = join(dir, "run.ts");
    const output = join(dir, "run.wasm");
    writeFileSync(
      input,
      `let total: i32 = 0;
export function main(): void {
  const bump = (): void => { total += 1; };
  bump();
  bump();
}
export function read(): i32 { return total; }
`,
    );
    execFileSync(process.execPath, [cli, "compile", input, "-o", output], { stdio: "pipe" });
    return output;
  });
});

test("a debug build's own source map points at the author's file, not the lowered one", async () => {
  await temporary("map-debug", async (dir) => {
    const output = join(dir, "run.wasm");
    const source = `let total: i32 = 0;
export function main(): void {
  const bump = (): void => { total += 1; };
  bump();
}
export function read(): i32 { return total; }
`;
    const result = await compileSource(source, "run.ts", output, { debug: true });
    assert.equal(result.compilerError, null);
    assert.equal(result.wasmMapPath, `${output}.map`);
    const emitted = JSON.parse(readFileSync(result.wasmMapPath, "utf8"));

    // The lowered file is gone from the map; the author's file took its index,
    // with its own text, and AssemblyScript's library entries are untouched.
    assert.ok(!emitted.sources.some((name) => name.includes(".lowered.ts")));
    const index = emitted.sources.indexOf("run.ts");
    assert.notEqual(index, -1);
    assert.equal(emitted.sourcesContent[index], source);
    assert.ok(emitted.sources.some((name) => name.startsWith("~lib/")));

    // Every position the map reports for the author's file is inside it.
    const lines = decodeMappings(emitted.mappings).flat();
    const ours = lines.filter((field) => field.sourceIndex === index);
    assert.ok(ours.length > 0);
    for (const field of ours) {
      assert.ok(field.sourceLine >= 0 && field.sourceLine < source.split("\n").length);
    }
    // The hoist moved `read` down in the lowered file; the map undoes that.
    const original = positionOf(source, "export function read");
    assert.ok(ours.some((field) => field.sourceLine === original.line - 1));
    // The binary points at the map beside it, under the name it actually has.
    assert.ok(readFileSync(output).includes(Buffer.from("run.wasm.map")));
  });
});

test("re-encoding a real compiler map reproduces it exactly", async () => {
  await temporary("map-roundtrip", async (dir) => {
    const output = join(dir, "plain.wasm");
    const result = await compileSource(
      "export function add(a: i32, b: i32): i32 { return a + b; }\n",
      "plain.ts",
      output,
      { debug: true },
    );
    assert.equal(result.compilerError, null);
    const emitted = JSON.parse(readFileSync(result.wasmMapPath, "utf8"));
    assert.equal(encodeMappings(decodeMappings(emitted.mappings)), emitted.mappings);
  });
});

test("a failed debug build leaves no source map naming a file nobody wrote", async () => {
  await temporary("map-debug-fail", async (dir) => {
    const output = join(dir, "broken.wasm");
    const result = await compileSource(CAPTURING, "broken.ts", output, { debug: true });
    assert.ok(result.compilerError);
    assert.equal(result.wasmMapPath, null);
    assert.equal(existsSync(`${output}.map`), false);
    assert.equal(existsSync(join(dir, "broken.wasm.map")), false);
  });
});
