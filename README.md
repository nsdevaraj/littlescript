# @littlea/littlescript — the LittleScript frontend (Epic 1.5, v0)

The thin frontend the Phase 0 findings recommended in front of
AssemblyScript:

1. **Subset diagnostics** — LittleA-branded `LS`-coded errors with
   fix-its for TS features outside LittleScript (`any`, `eval`, dynamic
   `import()`, `Function`, `delete`), caught before asc ever runs.
2. **Closure lowering** — AssemblyScript rejects closures over locals
   (`AS100`); the frontend lowers them to the module-state pattern
   validated by the spike (captured locals hoist to typed module slots,
   the body hoists to a top-level function). Snapshots are evaluated at the
   closure expression, after earlier argument or condition side effects.
   Captures require a single-shot exported `main()`; reentrant factories
   reject with LS2006. Un-lowerable shapes are
   *rejected loudly*: closures in loops (LS2002) and captures reassigned
   after creation (LS2003), each with a fix-it.
3. **Logical assignment lowering** — `&&=`, `||=`, and `??=` on local,
   parameter, or module variables compile to typed short-circuit expressions.
   Nullish assignment preserves zero, `false`, `NaN`, and empty strings.
   Property/index targets fail with LS1006 rather than duplicating receiver,
   getter, or index evaluation. See the [subset guide](../../docs/creators/guides/littlescript.md#logical-assignment)
   for the boundary; this does not enable optional chaining, standalone `??`,
   or dynamic JavaScript.

```bash
npm install
npm test
node src/cli.mjs check   game.ts
node src/cli.mjs compile game.ts -o game.wasm   # lower -> asc -> wasm
node src/cli.mjs compile game.ts -o game.wasm --debug   # + a debuggable map
```

`src/cli.mjs` turns on Node's compile cache (Node 22.1+) before anything else
loads, so later runs skip recompiling TypeScript, asc and Binaryen; the commands
live in `src/main.mjs`, where `check` never loads asc at all. The cache is in
`$NODE_COMPILE_CACHE` when that is set, otherwise in `node-compile-cache` under
the OS temp directory; `NODE_DISABLE_COMPILE_CACHE=1` turns it off.

The end-to-end tests execute supported single-shot captured handlers in WASM,
including argument and conditional-expression evaluation order. The Phase 0
reentrant factory sample rejects with LS2006 instead of sharing capture slots.
Logical-assignment tests also execute emitted WASM, exercise `check`, `compile`,
and namespaced `link`, and cover short-circuit side effects, expression results,
nullable references, helper-name collisions, and rejected targets/types.

The frontend preserves explicit ABI41 `@external("la", "stageWidth")`,
`stageHeight` and `responsiveMode` declarations; it does not maintain a second
host-import registry. Linking merges the optional `onResize(): void` lifecycle
export in unit order, just like `main` and `onFrame`, and retains the highest
declared `__la_abi_version` among the linked units.

## Standard Library: Typed Sprite Facade (RT19)

Scene scripts can import [`stdlib/sprite.ts`](./stdlib/sprite.ts) for a typed,
ergonomic surface over the lower-level `la.*` WASM ABI:

```ts
import { Sprite, getSprite, PROP_X, EASE_LINEAR } from "./stdlib/sprite";

export function main(): void {
  const box = getSprite("hero");
  box.setPosition(100.0, 200.0);
  box.setScale(1.5, 1.5);
  box.tween(PROP_X, 400.0, 60, EASE_LINEAR);
}
```

The facade handles UTF-8 string encoding and wraps the raw numeric handle:

| API | Contract |
|---|---|
| `getSprite(id: string): Sprite` | Resolve an authored element id to a typed `Sprite`. |
| `Sprite.fromId(id: string): Sprite` | Construct a typed `Sprite` from an authored element id. |
| `sprite.isValid(): bool` | Returns `true` if the handle is non-zero. |
| `sprite.setX(x: f32): void`, `sprite.setY(y: f32): void` | Move node along X or Y axis. |
| `sprite.setPosition(x: f32, y: f32): void` | Set both coordinates in one call. |
| `sprite.setScale(sx: f32, sy: f32): void` | Set scale factors. |
| `sprite.setRotation(deg: f32): void` | Set rotation angle in degrees. |
| `sprite.setAlpha(alpha: f32): void` | Set opacity in `0.0..=1.0`. |
| `sprite.setVisible(visible: bool): void` | Toggle node visibility. |
| `sprite.setFill(rgba: u32): void` | Set solid fill as `0xRRGGBBAA`. |
| `sprite.setText(text: string): void` | Replace a text node's content with automatic UTF-8 encoding. |
| `sprite.tween(prop: i32, to: f32, frames: i32, easing?: i32): void` | Animate a property to a target value. |
| `getSpriteHandle(id: string): u32` | Resolve an element id directly to its raw numeric handle. |
| `tweenSprite(handle: u32, prop: i32, to: f32, frames: i32, easing?: i32): void` | Animate a raw numeric handle. |

## ABI46 isolated workers

The parent scene uses [`stdlib/workers.ts`](./stdlib/workers.ts). Import it
relative to your source and declare the ABI in the scene entry:

```ts
export function __la_abi_version(): i32 { return 46; }
```

The helpers marshal strings and `Uint8Array` views through the `la` worker ABI;
no raw pointers are needed in parent code.

| Helper | Result |
|---|---|
| `workerSpawn(name: string): i32` | Start a bundled/host-registered worker by name, not a path or URL. |
| `workerPostMessage(handle: i32, message: Uint8Array): void` | Send a copy of exactly the view's bytes, including its byte offset. |
| `workerPoll(handle: i32): WorkerEvent` | Nonblocking poll: `None = 0`, `Message = 1`, `Failed = 2`, `Stopped = 3`. |
| `workerMessageLength(handle: i32): i32` | Length of the last polled payload. |
| `workerReadMessage(handle: i32): Uint8Array` | Allocate and copy the retained payload into an independently owned array. |
| `workerTerminate(handle: i32): void` | Cancel and release the handle; later uses fail. |

Poll from `onFrame`, not a busy-wait loop. Read a `Message` or `Failed` payload
before the next poll replaces it; a copied array remains valid afterward.
Failure bytes are UTF-8, decoded with
`String.UTF8.decodeUnsafe(bytes.dataStart, bytes.length)`. A stopped or failed
worker still occupies its slot until terminated.

Each scene allows four unreleased handles, at most 64 KiB per message, and
32 queued messages in each direction. The helpers assert on malformed names
(`[A-Za-z][A-Za-z0-9_-]{0,63}`) and oversized
messages. Hosts enforce registration, queue capacity, handle lifetimes and
isolation; these failures are not silently swallowed. Delivery is asynchronous,
so the frame in which a result arrives is **not deterministic**.

### Authoring the worker module

Workers instead import [`stdlib/worker.ts`](./stdlib/worker.ts). This module
introduces only `worker.postMessage` and AssemblyScript's optional `env.abort`
import—never `la`, scene APIs, networking, or nested workers. The worker's
entry file exports the required callback and re-exports the allocator:

```ts
// Paths below are relative to scenes/demos/scripts/.
import { readMessage, postMessage } from "../../../tools/littlescript/stdlib/worker";
export { worker_alloc } from "../../../tools/littlescript/stdlib/worker";

export function worker_message(pointer: i32, length: i32): void {
  const bytes = readMessage(pointer, length);
  postMessage(bytes);
}
```

`worker_alloc(length: i32): i32` supplies reusable, rooted managed storage for
the host's input; do not replace it with a raw offset such as zero, which can
overwrite the AssemblyScript runtime or static data. `readMessage` validates
the byte range and copies it into a managed `Uint8Array`, so saved messages
survive subsequent allocations and callbacks. `postMessage` sends exactly the
provided view. Both input and output allow zero to 64 KiB.
The ordinary compiler exports linear `memory` automatically.
An optional `export function worker_start(): void` can perform startup work;
no callback registration or special frontend mode is required.

Compile a worker separately with `compile`, **not** scene `link`: worker
entry points are not scene lifecycle entry points. Keep the explicit ABI46
declaration in the parent entry even when its helpers are imported.

### Runnable compute example

[`worker-compute.lax`](../../scenes/demos/scenes/worker-compute.lax) attaches
[`worker-compute-main.ls.ts`](../../scenes/demos/scripts/worker-compute-main.ls.ts).
Its isolated [`worker-compute.ls.ts`](../../scenes/demos/scripts/worker-compute.ls.ts)
sums the squares of byte values. The parent sends `1, 2, 3, 4`, receives the
little-endian `u32` value `30`, updates the `worker-result` label to
`Sum of squares = 30`, and releases the worker.

From the repository root:

```sh
mkdir -p target/worker-demo
node tools/littlescript/src/cli.mjs compile scenes/demos/scripts/worker-compute.ls.ts \
  -o target/worker-demo/compute.wasm
cargo run -q -p la-cli -- bundle scenes/demos/scenes/worker-compute.lax \
  --worker compute=target/worker-demo/compute.wasm -o target/worker-demo/compute.lab
```

The bundle compiles the parent through its `<mx:Script>` reference and carries
both modules. Load it through the [script-enabled Player host](../../docs/creators/guides/PLAYER.md);
the result appears after an asynchronous reply, not at a promised frame number.
The focused compiler tests execute both real compiled modules:

```sh
node --test tools/littlescript/test/workers.test.mjs tools/littlescript/test/worker-link.test.mjs
```

## Source maps and debug builds

Lowering moves code: hoisted capture slots push every line below them down, and
a rewritten expression is not the text its author typed. Left alone, that is
exactly the failure this frontend exists to prevent, one stage later — asc
reports `game.lowered.ts(8,21)` for something written on line 5 of `game.ts`.

So the lowering carries a map. Both passes rewrite the file as non-overlapping
text edits, so each piece of the result is either a verbatim run of the input,
which maps character for character, or a replacement, which maps to the start
of the construct it replaced. The two passes compose, and the result is written
beside the lowered file as a Source Map v3 (`game.lowered.ts.map`). The lowered
file itself is left byte for byte as the lowering produced it.

`compile` and `link` both use it. Every `in <file>(line,column)` asc prints is
answered with the author's own position, keeping the lowered one alongside
because the frame above it quotes lowered text:

```
   └─ in game.ts(5,21) [lowered game.lowered.ts(8,21)]
```

`link` keeps one map per unit, so a diagnostic inside a widget package names
that package's file rather than the merged `unit1.ts` asc saw.

`compile --debug` additionally asks asc for debug information and its own
source map, then points that map at the author's file: the lowered entry is
replaced by the original source and its text, every position for it is mapped
back, and AssemblyScript's own `~lib` entries are left where they are so a
breakpoint in the standard library still lands. The result is written to
`<out>.wasm.map`, which is the name the binary's `sourceMappingURL` carries.
A debug build turns optimization off so the positions survive; it is not the
shipping build. If the compile fails, no map is left behind — a map naming a
file nobody wrote is worse than none.

A column inside generated text is reported as the start of the construct the
lowering consumed, not as a column the author wrote; `originalPositionFor`
returns that distinction as `exact`. Runtime stack traces from a released
(non-debug) build are unchanged: they carry no source positions to map.

File compilation uses the authored source's directory as AssemblyScript's base
directory (source-string compilation defaults to the output directory).
Embedded assertion locations therefore use the relative lowered
filename rather than a temporary directory name. Recompiling the same source
with the same output basename in different temporary directories produces
identical WASM without removing assertions; relative imports keep resolving
next to the authored source. Linked units also resolve imports beside their own
source, even when their lowered files live in another output directory. The
compiler supplies those lowered sources virtually rather than writing into
the source directories. Drive-qualified and UNC module paths remain absolute
when a Windows source and the temporary linker directory are on different
volumes. Compiler diagnostics retain the generated files for inspection.

## AssemblyScript version lock & upgrade path

The frontend compiles through **AssemblyScript `asc`**, pinned to the
`0.28.x` line in [`package.json`](./package.json)
(`"assemblyscript": "^0.28.19"`, `"typescript": "^5.6.0"`). The exact
resolved versions are frozen in `package-lock.json`, and CI installs them
with `npm ci` (not `npm install`), so every build — local, CI, and release —
compiles LittleScript with the identical toolchain.

**Why it's locked.** The two behaviours this frontend depends on — closure
lowering to module state and the `--runtime incremental` / WasmGC codegen —
were validated against `asc` 0.28.x in the Phase 0 findings. An `asc`
minor/major bump can change diagnostics, codegen, or the ABI of the emitted
module, which would silently shift the compiled `.wasm` a host loads — and
the engine's whole value proposition is *bit-identical* output (Goal 4).

**Upgrade path** (deliberate, gated — never a passive `^` float):

1. Bump the range in `package.json`, then `npm install` to refresh
   `package-lock.json`.
2. `npm test` — subset diagnostics + closure lowering, through to compiling
   and *running* the lowered WASM.
3. Recompile a bundled module and re-run the determinism gate
   (`crates/la-player/web/determinism-gate.mjs`) and
   `cargo test -p la-script --features wasmtime-host`, so a codegen change
   that alters runtime behaviour fails loudly instead of shipping.
4. Watch for new/renamed `asc` diagnostics and any regression in the
   `LS20xx` closure-lowering rejections; update the frontend to match
   before landing the bump.
