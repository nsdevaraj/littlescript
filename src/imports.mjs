// Imported-file lowering (RT19).
//
// The frontend's lowerings and its LS diagnostics used to stop at the file
// handed to `compile`. A plain `import { x } from "./helper"` reached asc as
// the author wrote it, so a nullish chain or a closure over a local inside an
// imported module came back as a bare TS/AS error with no LittleA code and no
// original position — while the identical text in the entry file was lowered
// and diagnosed. The language a scene is written in cannot depend on which
// file the construct happens to sit in.
//
// This walks the static import graph ahead of asc and lowers every authored
// unit, so the compile hook can serve lowered text for all of them. Doing it
// before asc is what keeps the failure semantics identical to the entry's:
// an unsupported form anywhere in the program is a diagnostic, reported
// against the file and line the author wrote, and no output is produced.
//
// WHERE THE WALK STOPS. A bare specifier (`assemblyscript/...`, a package) is
// the host and package boundary, not scene source: the linker owns package
// units (see link.mjs) and the standard library is not LittleScript. Files
// under `node_modules` are skipped for the same reason, and a `.d.ts` is a
// declaration with no body to lower. Resolution failure is left to asc, which
// already reports a missing import with its own position.

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import ts from "typescript";
import { transform } from "./frontend.mjs";

/** Every statically imported specifier in `code`, in source order. */
function staticImports(code) {
  return ts.preProcessFile(code, true, false).importedFiles.map((file) => file.fileName);
}

/**
 * Whether a file is authored LittleScript rather than the host's own source:
 * scene and package units are ours to lower, the standard library and an
 * installed package's internals are not.
 */
export function isAuthoredUnit(path) {
  return !path.includes("node_modules") && !path.endsWith(".d.ts");
}

/**
 * Lower one authored file, tagging each diagnostic with the file it came from.
 *
 * Both callers need this and neither may forget the tag: a diagnostic printed
 * against the entry's path for a line the entry does not have sends the reader
 * to the wrong file.
 */
export function lowerAuthoredFile(path, source) {
  const lowered = transform(source, path);
  return {
    code: lowered.code,
    map: lowered.map,
    source,
    diagnostics: lowered.diagnostics.map((diagnostic) => ({ ...diagnostic, file: path })),
  };
}

/**
 * The file an import specifier names, or `null` when the walk does not own it.
 *
 * Extension-less specifiers are the AssemblyScript convention, so `.ts` and
 * `/index.ts` are tried; a `.js` specifier is tried as `.ts` because that is
 * how ESM-style TypeScript writes a relative import.
 */
function resolveImport(specifier, fromDirectory) {
  if (!specifier.startsWith(".") && !isAbsolute(specifier)) return null;
  const base = isAbsolute(specifier) ? specifier : resolve(fromDirectory, specifier);
  if (!isAuthoredUnit(base)) return null;
  const candidates = base.endsWith(".ts")
    ? [base]
    : base.endsWith(".js")
      ? [`${base.slice(0, -3)}.ts`, base]
      : [`${base}.ts`, `${base}/index.ts`, base];
  for (const candidate of candidates) {
    if (candidate.endsWith(".d.ts")) continue;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Lower every authored unit the entry imports, transitively.
 *
 * `entry` is `{path, code}` for the already-lowered entry unit — the caller
 * lowers it because it owns the output path that unit is written beside.
 * Returns the lowered units keyed by absolute path, plus their diagnostics,
 * each carrying the `file` it was found in. A unit reached twice (a diamond)
 * or a cycle is lowered once: the second visit is the same text, and lowering
 * it again would report its diagnostics twice.
 *
 * @param {{path: string, code: string}} entry
 * @returns {{
 *   units: Map<string, {path: string, source: string, code: string, map: unknown}>,
 *   diagnostics: Array<{file: string} & Record<string, unknown>>,
 * }}
 */
export function lowerImportedUnits(entry) {
  const units = new Map();
  const diagnostics = [];
  const pending = [{ path: entry.path, code: entry.code }];
  const visited = new Set([entry.path]);
  while (pending.length > 0) {
    const unit = pending.shift();
    for (const specifier of staticImports(unit.code)) {
      const path = resolveImport(specifier, dirname(unit.path));
      if (path === null || visited.has(path)) continue;
      visited.add(path);
      let source;
      try {
        source = readFileSync(path, "utf8");
      } catch {
        // Unreadable is asc's to report: it names the specifier and the
        // importing file, which is more than a resolver here could.
        continue;
      }
      const lowered = lowerAuthoredFile(path, source);
      units.set(path, { path, source, code: lowered.code, map: lowered.map });
      diagnostics.push(...lowered.diagnostics);
      pending.push({ path, code: lowered.code });
    }
  }
  return { units, diagnostics };
}
