// littlescript — the LittleScript CLI (Epic 1.5 v0). cli.mjs is the entry
// point: it turns on Node's compile cache, then imports this module.
//
//   littlescript check <file.ts>              subset diagnostics only
//   littlescript compile <file.ts> -o out.wasm [--debug]  lower + asc compile
//   littlescript link <ns>=<file.ts> ... -o out.wasm   several units, one module
//
// `compile` runs the frontend transform, writes the lowered source next
// to the output, and invokes asc programmatically (the warm-daemon code
// path from the Phase 0 rebuild benchmark).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { transform } from "./frontend.mjs";
import { lowerAuthoredFile, isAuthoredUnit, lowerImportedUnits } from "./imports.mjs";
import { linkEntry, linkModulePath } from "./link.mjs";
import { mapCompilerDiagnostics } from "./sourcemap.mjs";

// asc is loaded only by the commands that run it. With the Binaryen optimizer
// it brings, it is most of a cold start, and `check` never compiles.
async function compileSource(...args) {
  return (await import("./compile.mjs")).compileSource(...args);
}

function printDiagnostics(file, diagnostics) {
  for (const d of diagnostics) {
    const tag = d.severity === "error" ? "error" : d.severity;
    // A diagnostic found in an imported unit names that unit: printing the
    // entry's path for a line the entry does not have sends the reader to the
    // wrong file.
    console.error(`${d.file ?? file}:${d.line}:${d.col} ${tag} ${d.code}: ${d.message}`);
    if (d.fixit) console.error(`  fix-it: ${d.fixit}`);
  }
}

const [cmd, input, ...rest] = process.argv.slice(2);
if (!cmd || !input || !["check", "compile", "link"].includes(cmd)) {
  console.error(
    "usage: littlescript check <file.ts> | littlescript compile <file.ts> -o <out.wasm> [--debug]\n" +
    "       littlescript link <ns>=<file.ts> [<ns>=<file.ts> ...] -o <out.wasm>",
  );
  process.exit(2);
}

// `link` builds ONE module out of several packages' sources. A bundle carries
// a single script module, so a scene using two widget packages -- plus its own
// script -- has to end up with one; and each package's extension exports are
// renamed into the namespace the scene gave it, so two vendors both shipping a
// `bump` do not collide. An empty namespace (`=scene.ts`) means "no prefix",
// which is the scene's own script.
if (cmd === "link") {
  const args = [input, ...rest];
  const oIdx = args.indexOf("-o");
  if (oIdx < 0 || !args[oIdx + 1]) {
    console.error("link requires -o <out.wasm>");
    process.exit(2);
  }
  const outFile = args[oIdx + 1];
  const units = args.slice(0, oIdx).map((spec) => {
    const eq = spec.indexOf("=");
    if (eq < 0) {
      console.error(`link unit ${spec} must be <namespace>=<file.ts> (namespace may be empty)`);
      process.exit(2);
    }
    return { namespace: spec.slice(0, eq), file: spec.slice(eq + 1) };
  });
  if (units.length === 0) {
    console.error("link needs at least one <ns>=<file.ts>");
    process.exit(2);
  }

  const workDir = outFile.replace(/\.wasm$/, "") + ".link";
  mkdirSync(workDir, { recursive: true });

  // A unit's own imports are lowered on demand, in the same pass that serves
  // them to asc: the linker's units are not the only files an author writes.
  // The map is also the cycle guard, since asc asks for a file once.
  const importedFiles = new Map();
  const importedDiagnostics = [];
  const authoredSource = (path) => {
    const cached = importedFiles.get(path);
    if (cached) return cached.code;
    const text = readFileSync(path, "utf8");
    const unit = lowerAuthoredFile(path, text);
    importedFiles.set(path, unit);
    importedDiagnostics.push(...unit.diagnostics);
    return unit.code;
  };

  // Lower each unit on its own -- the frontend's diagnostics and closure
  // lowering are per file -- then let the entry re-export across them.
  const lowered = [];
  const maps = new Map();
  const virtualSources = new Map();
  const virtualRoots = new Map();
  for (const [i, unit] of units.entries()) {
    const src = readFileSync(unit.file, "utf8");
    const out = transform(src, unit.file);
    printDiagnostics(unit.file, out.diagnostics);
    const errs = out.diagnostics.filter((d) => d.severity === "error");
    if (errs.length > 0) {
      console.error(`${errs.length} error(s) in ${unit.file}`);
      process.exit(1);
    }
    const name = `unit${i}`;
    const sourcePath = resolve(unit.file);
    const sourceRoot = parse(sourcePath).root;
    const virtualRoot = resolve(workDir, `source${i}`);
    const relativeSourceDir = relative(sourceRoot, dirname(sourcePath));
    const virtualDir = resolve(virtualRoot, relativeSourceDir);
    mkdirSync(virtualDir, { recursive: true });
    const virtualPath = resolve(virtualDir, `${name}.ts`);
    writeFileSync(virtualPath, out.code);
    writeFileSync(
      join(workDir, `${name}.ts.map`),
      JSON.stringify(out.map.toSourceMapV3({ file: `${name}.ts` })),
    );
    // Mirror each source-root-relative tree under the linker directory. The
    // compiler callback maps those virtual paths back to authored sources.
    virtualSources.set(virtualPath, out.code);
    virtualRoots.set(virtualRoot, sourceRoot);
    maps.set(basename(virtualPath), out.map);
    const modulePath = relative(resolve(workDir), virtualPath).replace(/\\/g, "/").replace(/\.ts$/, "");
    lowered.push({
      ...unit, module: linkModulePath(modulePath), source: src,
    });
  }

  const entry = join(workDir, "entry.ts");
  writeFileSync(entry, linkEntry(lowered));
  const { default: asc } = await import("assemblyscript/asc");
  const { error, stderr } = await asc.main([
    entry, "--outFile", outFile, "--optimizeLevel", "3", "--runtime", "incremental",
  ], {
    readFile(filename, directory) {
      const path = resolve(directory, filename);
      if (virtualSources.has(path)) return virtualSources.get(path);
      for (const [virtualRoot, sourceRoot] of virtualRoots) {
        const sourceRelative = relative(virtualRoot, path);
        if (
          sourceRelative !== ".." &&
          !sourceRelative.startsWith(`..${sep}`) &&
          !isAbsolute(sourceRelative)
        ) {
          const sourcePath = resolve(sourceRoot, sourceRelative);
          try {
            return isAuthoredUnit(sourcePath) ? authoredSource(sourcePath) : readFileSync(sourcePath, "utf8");
          } catch (error) {
            if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
            throw error;
          }
        }
      }
      try {
        return readFileSync(path, "utf8");
      } catch (error) {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
        throw error;
      }
    },
  });
  // A unit's imported helper is a unit too, so its diagnostics are the
  // program's: printed once, and an error there refuses the link.
  printDiagnostics(input, importedDiagnostics);
  const importedErrors = importedDiagnostics.filter((d) => d.severity === "error");
  if (importedErrors.length > 0) {
    console.error(`${importedErrors.length} error(s)`);
    process.exit(1);
  }
  if (error) {
    console.error(mapCompilerDiagnostics(stderr.toString(), maps));
    console.error(`asc failed linking ${units.length} unit(s); generated entry left at ${entry}`);
    process.exit(1);
  }
  console.error(`linked ${units.length} unit(s) -> ${outFile}`);
  process.exit(0);
}

const source = readFileSync(input, "utf8");
const outputIndex = rest.indexOf("-o");
const compileOutput = outputIndex >= 0 ? rest[outputIndex + 1] : null;
if (cmd === "compile" && !compileOutput) {
  console.error("compile requires -o <out.wasm>");
  process.exit(2);
}
const debug = rest.includes("--debug");
// `check` answers for the program, not one file of it: an unsupported form in
// an imported unit is the same refusal the entry file would have got.
const checked =
  cmd === "compile"
    ? await compileSource(source, input, compileOutput, {
        sourceDirectory: dirname(resolve(input)),
        debug,
      })
    : (() => {
        const entry = transform(source, input);
        const imported = lowerImportedUnits({ path: resolve(input), code: source });
        return { ...entry, diagnostics: [...entry.diagnostics, ...imported.diagnostics] };
      })();
const { diagnostics } = checked;
printDiagnostics(input, diagnostics);
const errors = diagnostics.filter((d) => d.severity === "error");
if (errors.length > 0) {
  console.error(`${errors.length} error(s)`);
  process.exit(1);
}

if (cmd === "check") {
  console.error("ok");
  process.exit(0);
}

const outFile = compileOutput;
const loweredPath = outFile.replace(/\.wasm$/, "") + ".lowered.ts";
if (checked.compilerError) {
  console.error(checked.stderr);
  console.error(`asc failed on lowered output (${basename(loweredPath)}) — frontend bug, please report`);
  process.exit(1);
}
console.error(`compiled ${input} -> ${outFile}`);
if (checked.wasmMapPath) console.error(`debug source map -> ${checked.wasmMapPath}`);
