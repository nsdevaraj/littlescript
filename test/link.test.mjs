// The link step's naming rules, without running asc.
//
// What can go wrong here is silent: a rename that misses turns a widget's
// `<mx:RunScript name="gauge_bump"/>` into a call on an export nobody
// provides, which the engine answers with its fallback -- nothing happens and
// nothing says why.

import { test } from "node:test";
import assert from "node:assert/strict";
import { exportsOf, linkEntry, linkModulePath, namespaced, SLUGS } from "../src/link.mjs";

test("a namespace goes in front of the name, never the protocol slug", () => {
  // `__la_ext_action_gauge_bump` is what the compiler's <mx:Import as="gauge">
  // rewrote the scene's reference to. Prefixing the slug instead would
  // produce `__la_ext_gauge_action_bump`, which is a name of no protocol at
  // all -- and the engine would take its fallback rather than report it.
  assert.equal(
    namespaced("__la_ext_action_bump", "gauge"),
    "__la_ext_action_gauge_bump",
  );
  assert.equal(
    namespaced("__la_ext_convert_toF", "kit"),
    "__la_ext_convert_kit_toF",
  );
});

test("every protocol the engine defines can be namespaced", () => {
  // SLUGS mirrors ExtensionKind::slug in la-script. A protocol missing here
  // would have its exports dropped from the linked module entirely.
  for (const slug of SLUGS) {
    assert.equal(
      namespaced(`__la_ext_${slug}_x`, "ns"),
      `__la_ext_${slug}_ns_x`,
      slug,
    );
  }
});

test("the scene's own script is not renamed", () => {
  // It has no <mx:Import as=>, so its names are already what the scene calls.
  assert.equal(namespaced("__la_ext_action_bump", ""), "__la_ext_action_bump");
});

test("a non-extension export is not mistaken for one", () => {
  assert.equal(namespaced("helper", "gauge"), null);
  assert.equal(namespaced("__la_something_else", "gauge"), null);
});

test("export names are read out of the source, indentation and all", () => {
  const src = [
    "export function __la_ext_action_bump(root: u32): void {}",
    "  export function indented(): void {}",
    "function notExported(): void {}",
    "// export function commentedOut(): void {}",
  ].join("\n");
  const found = exportsOf(src);
  assert.deepEqual(found, ["__la_ext_action_bump", "indented"]);
  assert.ok(!found.includes("notExported"));
});

const unit = (module, namespace, ...exports) => ({
  module,
  namespace,
  source: exports.map((e) => `export function ${e}(): void {}`).join("\n"),
});

test("link module paths keep drive-qualified and UNC source paths absolute", () => {
  for (const [path, expected] of [
    ["../source/unit0", "../source/unit0"],
    ["unit0", "./unit0"],
    ["/source/unit0", "/source/unit0"],
    ["D:/source/unit0", "D:/source/unit0"],
    ["//server/share/source/unit0", "//server/share/source/unit0"],
  ]) {
    assert.equal(linkModulePath(path), expected, path);
  }
  const entry = linkEntry([
    unit(linkModulePath("./source0/unit0"), "meter", "__la_ext_action_up"),
  ]);
  assert.match(entry, /from "\.\/source0\/unit0";/);
});

test("two vendors may both ship a bump", () => {
  // The whole point. Without the rename the second re-export would shadow the
  // first and pressing either widget would run one vendor's code.
  const entry = linkEntry([
    unit("./u0", "acme", "__la_ext_action_bump"),
    unit("./u1", "globex", "__la_ext_action_bump"),
  ]);
  assert.match(
    entry,
    /export \{ __la_ext_action_bump as __la_ext_action_acme_bump \} from "\.\/u0";/,
  );
  assert.match(
    entry,
    /export \{ __la_ext_action_bump as __la_ext_action_globex_bump \} from "\.\/u1";/,
  );
});

test("a real collision is refused rather than silently shadowed", () => {
  // Same namespace twice is an authoring mistake the linker can see; letting
  // asc pick a winner would make which widget responds depend on link order.
  assert.throws(
    () =>
      linkEntry([
        unit("./u0", "kit", "__la_ext_action_bump"),
        unit("./u1", "kit", "__la_ext_action_bump"),
      ]),
    /both export __la_ext_action_kit_bump/,
  );
});

test("entry points every unit may define are merged, not overwritten", () => {
  // Two packages both with a main() is ordinary. Re-exporting would keep the
  // last one and silently drop the other's setup.
  const entry = linkEntry([
    unit("./u0", "a", "main", "onFrame"),
    unit("./u1", "b", "main"),
  ]);
  assert.match(entry, /export function main\(\): void \{\n  u0_main\(\);\n  u1_main\(\);\n\}/);
  assert.match(entry, /export function onFrame\(\): void \{\n  u0_onFrame\(\);\n\}/);
  // …and each is imported under a distinct local name.
  assert.match(entry, /import \{ main as u0_main \} from "\.\/u0";/);
  assert.match(entry, /import \{ main as u1_main \} from "\.\/u1";/);
});

test("the linked module declares the highest ABI any unit needs", () => {
  // A host that cannot serve one unit's imports cannot safely run the module
  // at all, so the module must ask for the most demanding one.
  const entry = linkEntry([
    { module: "./u0", namespace: "a", source: "export function __la_abi_version(): i32 { return 1; }" },
    { module: "./u1", namespace: "b", source: "export function __la_abi_version(): i32 { return 2; }" },
  ]);
  assert.match(entry, /export function __la_abi_version\(\): i32 \{ return 2; \}/);
});

test("ABI41 resize entry points merge in unit order without namespacing", () => {
  const entry = linkEntry([
    { ...unit("./layout", "widget", "onResize"), source: `${unit("./layout", "widget", "onResize").source}
export function __la_abi_version(): i32 { return 41; }` },
    unit("./scene", "", "onResize"),
  ]);
  assert.match(entry, /import \{ onResize as u0_onResize \} from "\.\/layout";/);
  assert.match(entry, /import \{ onResize as u1_onResize \} from "\.\/scene";/);
  assert.match(entry, /export function onResize\(\): void \{\n  u0_onResize\(\);\n  u1_onResize\(\);\n\}/);
  assert.match(entry, /export function __la_abi_version\(\): i32 \{ return 41; \}/);
  assert.ok(!entry.includes("widget_onResize"));
});

test("a module nobody declared an ABI for does not invent one", () => {
  // Declaring v0 would be a lie, and declaring the newest would make an old
  // host refuse a module it could actually run.
  const entry = linkEntry([unit("./u0", "a", "__la_ext_action_bump")]);
  assert.ok(!entry.includes("__la_abi_version"));
});

test("a reserved name no protocol claims is refused, not dropped", () => {
  // Returning null here would drop the export from the linked module and the
  // engine would answer the missing name with its fallback: the widget would
  // author cleanly, validate cleanly, and do nothing. That is precisely the
  // failure this whole step exists to remove, so it has to be loud.
  assert.throws(
    () => namespaced("__la_ext_wobble_x", "gauge"),
    /names no protocol/,
  );
  // …including for the scene's own script, which is not renamed but is just
  // as broken if it names a protocol that does not exist.
  assert.throws(() => namespaced("__la_ext_wobble_x", ""), /names no protocol/);
});

test("the host's fixed entry points are merged, never namespaced", () => {
  // onEvent and __la_dispatch are looked up by literal name by the host.
  // Renaming either into a package's namespace loses a widget's event
  // handling with nothing to show for it.
  const withEvents = {
    module: "./u0",
    namespace: "gauge",
    source: [
      "export function onEvent(kind: i32, target: u32, other: u32): void {}",
      "export function __la_dispatch(callback: u32, target: u32): void {}",
    ].join("\n"),
  };
  const entry = linkEntry([withEvents]);
  assert.ok(!entry.includes("gauge_onEvent"), entry);
  assert.match(
    entry,
    /export function onEvent\(kind: i32, target: u32, other: u32\): void \{\n  u0_onEvent\(kind, target, other\);\n\}/,
  );
  assert.match(
    entry,
    /export function __la_dispatch\(callback: u32, target: u32\): void \{\n  u0___la_dispatch\(callback, target\);\n\}/,
  );
});

test("two packages' event handlers both run", () => {
  const unitWith = (module, ns) => ({
    module,
    namespace: ns,
    source: "export function onEvent(kind: i32, target: u32, other: u32): void {}",
  });
  const entry = linkEntry([unitWith("./u0", "a"), unitWith("./u1", "b")]);
  assert.match(entry, /u0_onEvent\(kind, target, other\);\n  u1_onEvent\(kind, target, other\);/);
});

test("a touch handler is a fixed entry point, not a package export", () => {
  // CQ83: the host delivers pointer input to the literal export `onTouch`.
  // The linker used to treat it as an ordinary package export, rename it
  // into the package's namespace, and silently drop the handler.
  const unit = {
    module: "./u0",
    namespace: "pad",
    source:
      "export function onTouch(id: i32, x: f32, y: f32, pressed: i32): void {}",
  };
  const entry = linkEntry([unit]);
  assert.ok(!entry.includes("pad_onTouch"), entry);
  assert.match(
    entry,
    /export function onTouch\(id: i32, x: f32, y: f32, pressed: i32\): void \{\n  u0_onTouch\(id, x, y, pressed\);\n\}/,
  );
});
