import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { compileSource } from "../src/compile.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
let serial = 0;

async function compile(t, source, name = "sprite_user", sourceDirectory = root) {
  const directory = join(root, "tools/littlescript", `.sprite-test-${process.pid}-${++serial}`);
  mkdirSync(directory, { recursive: true });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, `${name}.wasm`);
  const result = await compileSource(source, `${name}.ls.ts`, output, {
    sourceDirectory,
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.compilerError, null, result.stderr);
  return new WebAssembly.Module(readFileSync(output));
}

function abort() {
  throw new Error("LittleScript aborted");
}

test("RT19: typed Sprite facade compiles and resolves node handles by id", async (t) => {
  const module = await compile(t, `
import { Sprite, getSprite, PROP_X, EASE_LINEAR } from "./tools/littlescript/stdlib/sprite";

let targetHandle: u32 = 0;
let movedX: f32 = 0;
let tweenedFrames: i32 = 0;

export function main(): void {
  const box = getSprite("hero");
  targetHandle = box.handle;
  box.setX(120.0);
  box.tween(PROP_X, 300.0, 45, EASE_LINEAR);
}

export function getTargetHandle(): u32 { return targetHandle; }
`);

  let lookupName = "";
  let setXCalls = [];
  let tweenCalls = [];

  const { exports } = new WebAssembly.Instance(module, {
    env: { abort },
    la: {
      getSpriteByName(ptr, len) {
        lookupName = new TextDecoder().decode(new Uint8Array(exports.memory.buffer, ptr, len));
        return 42;
      },
      setX(h, x) {
        setXCalls.push({ h, x });
      },
      setY() {},
      setScale() {},
      setRotation() {},
      setAlpha() {},
      setVisible() {},
      setFill() {},
      setText() {},
      getText() { return 0; },
      tweenTo(h, prop, to, duration, easing) {
        tweenCalls.push({ h, prop, to, duration, easing });
      },
    },
  });

  exports.main();
  assert.equal(lookupName, "hero");
  assert.equal(exports.getTargetHandle(), 42);
  assert.deepEqual(setXCalls, [{ h: 42, x: 120.0 }]);
  assert.deepEqual(tweenCalls, [{ h: 42, prop: 0, to: 300.0, duration: 45, easing: 0 }]);
});

test("RT19: Sprite methods manipulate transform, alpha, fill, and visibility", async (t) => {
  const module = await compile(t, `
import { Sprite } from "./tools/littlescript/stdlib/sprite";

export function testAll(): void {
  const sprite = new Sprite(99);
  sprite.setPosition(10.0, 20.0);
  sprite.setScale(2.0, 3.0);
  sprite.setRotation(45.0);
  sprite.setAlpha(0.75);
  sprite.setVisible(true);
  sprite.setFill(0xFF0000FF);
  sprite.setText("hello");
}
`);

  const recorded = {};

  const { exports } = new WebAssembly.Instance(module, {
    env: { abort },
    la: {
      getSpriteByName() { return 0; },
      setX(h, x) { recorded.x = { h, x }; },
      setY(h, y) { recorded.y = { h, y }; },
      setScale(h, sx, sy) { recorded.scale = { h, sx, sy }; },
      setRotation(h, deg) { recorded.rotation = { h, deg }; },
      setAlpha(h, a) { recorded.alpha = { h, a }; },
      setVisible(h, v) { recorded.visible = { h, v }; },
      setFill(h, rgba) { recorded.fill = { h, rgba: rgba >>> 0 }; },
      setText(h, ptr, len) {
        recorded.text = {
          h,
          val: new TextDecoder().decode(new Uint8Array(exports.memory.buffer, ptr, len)),
        };
      },
      getText() { return 0; },
      tweenTo() {},
    },
  });

  exports.testAll();
  assert.deepEqual(recorded.x, { h: 99, x: 10.0 });
  assert.deepEqual(recorded.y, { h: 99, y: 20.0 });
  assert.deepEqual(recorded.scale, { h: 99, sx: 2.0, sy: 3.0 });
  assert.deepEqual(recorded.rotation, { h: 99, deg: 45.0 });
  assert.deepEqual(recorded.alpha, { h: 99, a: 0.75 });
  assert.deepEqual(recorded.visible, { h: 99, v: 1 });
  assert.deepEqual(recorded.fill, { h: 99, rgba: 0xFF0000FF });
  assert.deepEqual(recorded.text, { h: 99, val: "hello" });
});

test("RT19: standalone helper functions getSpriteHandle and tweenSprite", async (t) => {
  const module = await compile(t, `
import { getSpriteHandle, tweenSprite, PROP_ALPHA, EASE_LINEAR } from "./tools/littlescript/stdlib/sprite";

export function run(): u32 {
  const h = getSpriteHandle("coin");
  tweenSprite(h, PROP_ALPHA, 0.0, 30, EASE_LINEAR);
  return h;
}
`);

  let lookup = "";
  let tween = null;

  const { exports } = new WebAssembly.Instance(module, {
    env: { abort },
    la: {
      getSpriteByName(ptr, len) {
        lookup = new TextDecoder().decode(new Uint8Array(exports.memory.buffer, ptr, len));
        return 777;
      },
      setX() {},
      setY() {},
      setScale() {},
      setRotation() {},
      setAlpha() {},
      setVisible() {},
      setFill() {},
      setText() {},
      getText() { return 0; },
      tweenTo(h, prop, to, duration, easing) {
        tween = { h, prop, to, duration, easing };
      },
    },
  });

  const res = exports.run();
  assert.equal(res, 777);
  assert.equal(lookup, "coin");
  assert.deepEqual(tween, { h: 777, prop: 5, to: 0.0, duration: 30, easing: 0 });
});

test("RT19: NO_SPRITE is the missing sentinel and node handle 0 is valid", async (t) => {
  // CQ83: `la.getSpriteByName` returns u32.MAX_VALUE on a miss, not 0, so
  // `handle != 0` reported a missing sprite as found and the first node as
  // missing. The handle constants must agree with `la_script::NO_SPRITE`.
  const module = await compile(t, `
import { Sprite, NO_SPRITE, getSprite } from "./tools/littlescript/stdlib/sprite";

export function missing(): bool { return getSprite("absent").isValid(); }
export function firstNode(): bool { return new Sprite(0).isValid(); }
export function present(): bool { return new Sprite(7).isValid(); }
export function sentinel(): u32 { return NO_SPRITE; }
`);

  const { exports } = new WebAssembly.Instance(module, {
    env: { abort },
    la: {
      getSpriteByName() { return 0xFFFF_FFFF; },
      setX() {},
      setY() {},
      setScale() {},
      setRotation() {},
      setAlpha() {},
      setVisible() {},
      setFill() {},
      setText() {},
      getText() { return 0; },
      tweenTo() {},
    },
  });

  assert.equal(exports.missing(), 0, "a missing lookup is not valid");
  assert.equal(exports.firstNode(), 1, "node handle 0 is a real node");
  assert.equal(exports.present(), 1);
  assert.equal(exports.sentinel() >>> 0, 0xFFFF_FFFF);
});
