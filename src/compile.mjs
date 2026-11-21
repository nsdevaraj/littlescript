import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import asc from "assemblyscript/asc";
import { transform } from "./frontend.mjs";
import { lowerImportedUnits } from "./imports.mjs";
import { mapCompilerDiagnostics, remapGeneratedSourceMap } from "./sourcemap.mjs";

let compilationSerial = 0;

/**
 * `debug` asks asc for debug information and its own source map, and then
 * points that map at the author's file instead of the lowered one — the map a
 * browser or a native debugger reads to place a breakpoint. It is not the
 * shipping build: optimization is off so the positions survive.
 */
export async function compileSource(
  source,
  input,
  outFile,
  { sourceDirectory = dirname(resolve(outFile)), debug = false } = {},
) {
  const transformed = transform(source, input);
  const loweredPath = outFile.replace(/\.wasm$/, "") + ".lowered.ts";
  const mapPath = `${loweredPath}.map`;
  const baseDirectory = resolve(sourceDirectory);
  const virtualEntry = resolve(baseDirectory, basename(loweredPath));
  // Every authored unit the entry imports is lowered too, before asc runs:
  // the same constructs have to compile and be diagnosed the same way
  // wherever they sit, and a program with an unsupported form in an imported
  // file must fail the way the entry file does — with an LS code, a fix-it
  // and the author's position — rather than as an asc syntax error.
  const imported = lowerImportedUnits({ path: virtualEntry, code: transformed.code });
  const diagnostics = [...transformed.diagnostics, ...imported.diagnostics];
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) {
    return {
      ...transformed,
      diagnostics,
      errors,
      loweredPath: null,
      mapPath: null,
      wasmMapPath: null,
      compilerError: null,
      stderr: "",
    };
  }
  // Keyed the two ways asc names a file back to us: the absolute path, and
  // the bare name it prints under `--baseDir`.
  const loweringMaps = new Map([
    [basename(loweredPath), transformed.map],
    ...imported.units.values().flatMap((unit) => [
      [unit.path, unit.map],
      [basename(unit.path), unit.map],
    ]),
  ]);

  const temporaryOutput = `${outFile}.tmp-${process.pid}-${++compilationSerial}`;
  writeFileSync(loweredPath, transformed.code);
  // Written beside the lowered file rather than referenced from inside it:
  // the lowered text is what asc compiles, and it stays byte-for-byte what
  // the lowering produced.
  writeFileSync(mapPath, JSON.stringify(transformed.map.toSourceMapV3({ file: basename(loweredPath) })));
  // asc resolves the `--sourceMap` argument against its base directory and
  // embeds it verbatim as the binary's sourceMappingURL, so it has to be the
  // map's name beside the output, not a path from anywhere else.
  const wasmMapName = `${basename(outFile)}.map`;
  const wasmMapPath = debug ? `${outFile}.map` : null;
  const ascMapPath = resolve(baseDirectory, wasmMapName);
  let compilerError;
  let stderr;
  try {
    ({ error: compilerError, stderr } = await asc.main([
      basename(loweredPath),
      "--baseDir",
      baseDirectory,
      "--outFile",
      resolve(temporaryOutput),
      "--optimizeLevel",
      debug ? "0" : "3",
      "--runtime",
      "incremental",
      ...(debug ? ["--debug", "--sourceMap", wasmMapName] : []),
    ], {
      // Resolve imports beside the source without writing generated files there.
      readFile(filename, directory) {
        const path = resolve(directory, filename);
        if (path === virtualEntry) return transformed.code;
        const unit = imported.units.get(path);
        if (unit) return unit.code;
        try {
          return readFileSync(path, "utf8");
        } catch (error) {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
          throw error;
        }
      },
    }));
    if (!compilerError) {
      renameSync(temporaryOutput, outFile);
      if (debug && existsSync(ascMapPath)) {
        // Each lowered unit's map points its own slice of the emitted map
        // back at the file the author wrote; a unit asc did not mention is
        // simply not there, and remapping it is a no-op.
        let emitted = JSON.parse(readFileSync(ascMapPath, "utf8"));
        for (const unit of imported.units.values()) {
          emitted = remapGeneratedSourceMap(emitted, unit.path, unit.map);
          emitted = remapGeneratedSourceMap(emitted, basename(unit.path), unit.map);
        }
        emitted = remapGeneratedSourceMap(emitted, basename(loweredPath), transformed.map);
        writeFileSync(wasmMapPath, JSON.stringify(emitted));
      }
    }
  } finally {
    rmSync(temporaryOutput, { force: true });
    // Nothing asc wrote survives as-is: either it was rewritten to the
    // author's file beside the binary, or the build failed and no map at all
    // is better than one naming a file nobody wrote.
    if (debug && (compilerError || resolve(ascMapPath) !== resolve(wasmMapPath))) {
      rmSync(ascMapPath, { force: true });
    }
  }
  return {
    ...transformed,
    diagnostics,
    errors,
    loweredPath,
    mapPath,
    wasmMapPath: debug && !compilerError ? wasmMapPath : null,
    compilerError,
    // asc reports the lowered files, which the author never wrote. Every
    // location it prints is answered with theirs.
    stderr: mapCompilerDiagnostics(stderr?.toString() ?? "", loweringMaps),
  };
}
