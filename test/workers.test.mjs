import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { compileSource } from "../src/compile.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
let serial = 0;

async function compile(t, source, name = "parent", sourceDirectory = root) {
  const directory = join(root, "tools/littlescript", `.worker-test-${process.pid}-${++serial}`);
  mkdirSync(directory);
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

test("ABI46 parent helpers send the UTF-8 name and only the selected byte view", async (t) => {
  const module = await compile(t, `
import { workerSpawn, workerPostMessage } from "./tools/littlescript/stdlib/workers";
export function __la_abi_version(): i32 { return 46; }
export function main(): i32 {
  const worker = workerSpawn("Compute_2-echo");
  const bytes = new Uint8Array(5);
  bytes[0] = 99; bytes[1] = 0; bytes[2] = 128; bytes[3] = 255; bytes[4] = 99;
  workerPostMessage(worker, bytes.subarray(1, 4));
  return worker;
}
`);
  assert.deepEqual(
    WebAssembly.Module.imports(module).filter(({ module }) => module === "la").map(({ name }) => name).sort(),
    ["workerPostMessage", "workerSpawn"],
  );
  let name;
  let sent;
  const { exports } = new WebAssembly.Instance(module, {
    env: { abort },
    la: {
      workerSpawn(pointer, length) {
        name = new TextDecoder().decode(new Uint8Array(exports.memory.buffer, pointer, length));
        return 41;
      },
      workerPostMessage(handle, pointer, length) {
        sent = { handle, bytes: [...new Uint8Array(exports.memory.buffer, pointer, length)] };
      },
    },
  });
  assert.equal(exports.__la_abi_version(), 46);
  assert.equal(exports.main(), 41);
  assert.equal(name, "Compute_2-echo");
  assert.deepEqual(sent, { handle: 41, bytes: [0, 128, 255] });
});

test("parent helpers poll without waiting, copy payloads, and release the handle", async (t) => {
  const module = await compile(t, `
import {
  WorkerEvent, workerPoll, workerMessageLength, workerReadMessage, workerTerminate,
} from "./tools/littlescript/stdlib/workers";
let payload = new Uint8Array(0);
let first = new Uint8Array(0);
export function receive(): i32 {
  const event = workerPoll(41);
  if (event == WorkerEvent.Message || event == WorkerEvent.Failed) {
    const length = workerMessageLength(41);
    payload = workerReadMessage(41);
    assert(payload.length == length);
    if (event == WorkerEvent.Message && first.length == 0) first = payload;
  } else {
    assert(event == WorkerEvent.None || event == WorkerEvent.Stopped);
    assert(workerMessageLength(41) == 0);
  }
  return event;
}
export function payloadLength(): i32 { return payload.length; }
export function payloadByte(index: i32): u8 { return payload[index]; }
export function firstByte(index: i32): u8 { return first[index]; }
export function stop(): void { workerTerminate(41); }
`);
  assert.deepEqual(
    WebAssembly.Module.imports(module).filter(({ module }) => module === "la").map(({ name }) => name).sort(),
    ["workerMessageLength", "workerPoll", "workerReadMessage", "workerTerminate"],
  );
  const failure = new TextEncoder().encode("compute failed: café ☕");
  const events = [
    [0, new Uint8Array()],
    [1, Uint8Array.of(0, 128, 255)],
    [1, new Uint8Array()],
    [2, failure],
    [3, new Uint8Array()],
  ];
  let retained = new Uint8Array();
  let released = false;
  const checkHandle = (handle) => {
    assert.equal(handle, 41);
    assert.equal(released, false, "released handle");
  };
  const { exports } = new WebAssembly.Instance(module, {
    env: { abort },
    la: {
      workerPoll(handle) {
        checkHandle(handle);
        const event = events.shift();
        retained = event[1];
        return event[0];
      },
      workerMessageLength(handle) {
        checkHandle(handle);
        return retained.length;
      },
      workerReadMessage(handle, pointer, capacity) {
        checkHandle(handle);
        assert.ok(capacity >= retained.length, "undersized destination");
        new Uint8Array(exports.memory.buffer, pointer, retained.length).set(retained);
        return retained.length;
      },
      workerTerminate(handle) {
        checkHandle(handle);
        released = true;
      },
    },
  });
  const payload = () => Uint8Array.from(
    { length: exports.payloadLength() }, (_, index) => exports.payloadByte(index),
  );
  assert.equal(exports.receive(), 0);
  assert.equal(exports.receive(), 1);
  assert.deepEqual(payload(), Uint8Array.of(0, 128, 255));
  assert.equal(exports.receive(), 1);
  assert.deepEqual(payload(), new Uint8Array());
  assert.equal(exports.receive(), 2);
  assert.equal(new TextDecoder().decode(payload()), "compute failed: café ☕");
  assert.equal(exports.firstByte(1), 128, "earlier copied payload survives later polls");
  assert.equal(exports.receive(), 3);
  exports.stop();
  assert.equal(released, true);
  assert.throws(() => exports.receive(), /released handle/);
});

test("parent helpers reject invalid names and oversized messages before entering the host", async (t) => {
  const valid = ["A", "Compute_2-echo", "a".repeat(64)];
  const invalid = ["", "9compute", "a b", "café", "a/b", "a\0b", "a".repeat(65)];
  const module = await compile(t, `
import { workerSpawn, workerPostMessage } from "./tools/littlescript/stdlib/workers";
const names: string[] = ${JSON.stringify([...valid, ...invalid])};
export function spawn(index: i32): i32 { return workerSpawn(names[index]); }
export function send(length: i32): void { workerPostMessage(41, new Uint8Array(length)); }
`);
  const names = [];
  const sizes = [];
  const { exports } = new WebAssembly.Instance(module, {
    env: { abort },
    la: {
      workerSpawn(pointer, length) {
        names.push(new TextDecoder().decode(new Uint8Array(exports.memory.buffer, pointer, length)));
        return 41;
      },
      workerPostMessage(handle, _pointer, length) {
        assert.equal(handle, 41);
        sizes.push(length);
      },
    },
  });
  for (let index = 0; index < valid.length; index++) assert.equal(exports.spawn(index), 41);
  for (let index = valid.length; index < valid.length + invalid.length; index++) {
    assert.throws(() => exports.spawn(index), /LittleScript aborted/, JSON.stringify(invalid[index - valid.length]));
  }
  assert.deepEqual(names, valid);
  exports.send(0);
  exports.send(65536);
  assert.throws(() => exports.send(65537), /LittleScript aborted/);
  assert.deepEqual(sizes, [0, 65536]);
});

test("isolated workers round-trip bytes through a managed allocator and retain independent copies", async (t) => {
  const module = await compile(t, `
import { readMessage, postMessage } from "./tools/littlescript/stdlib/worker";
export { worker_alloc } from "./tools/littlescript/stdlib/worker";
let previous = new Uint8Array(0);
export function worker_message(pointer: i32, length: i32): void {
  const current = readMessage(pointer, length);
  postMessage(previous);
  previous = current;
  postMessage(current);
  const text = Uint8Array.wrap(String.UTF8.encode("allocator safe ✓"));
  postMessage(text);
}
export function churn(): i32 {
  let sum = 0;
  for (let i = 0; i < 100; i++) {
    const bytes = new Uint8Array(2048);
    bytes[0] = <u8>i;
    sum += bytes[0];
  }
  return sum;
}
`, "worker");
  assert.ok(WebAssembly.Module.imports(module).every(({ module, name }) =>
    (module === "worker" && name === "postMessage") || (module === "env" && name === "abort")));
  assert.ok(WebAssembly.Module.imports(module).some(({ module, name }) =>
    module === "worker" && name === "postMessage"));
  for (const name of ["memory", "worker_alloc", "worker_message"]) {
    assert.ok(WebAssembly.Module.exports(module).some((entry) => entry.name === name));
  }
  const replies = [];
  const { exports } = new WebAssembly.Instance(module, {
    env: { abort },
    worker: {
      postMessage(pointer, length) {
        replies.push(new Uint8Array(exports.memory.buffer, pointer, length).slice());
      },
    },
  });
  const largest = new Uint8Array(65536).fill(7);
  largest[0] = 0;
  largest[65535] = 255;
  let previous = new Uint8Array();
  for (const message of [Uint8Array.of(0, 128, 255), largest, Uint8Array.of(42), new Uint8Array()]) {
    const pointer = exports.worker_alloc(message.length);
    assert.ok(pointer > 0, "host receives managed storage, not raw offset zero");
    new Uint8Array(exports.memory.buffer, pointer, message.length).set(message);
    assert.equal(exports.churn(), 4950, "managed allocations must not invalidate the host input");
    exports.worker_message(pointer, message.length);
    assert.deepEqual(replies.splice(0), [
      previous, message, new TextEncoder().encode("allocator safe ✓"),
    ]);
    previous = message;
  }
});

test("worker helpers reject invalid allocations and byte ranges and enforce the send limit", async (t) => {
  const module = await compile(t, `
import { readMessage, postMessage } from "./tools/littlescript/stdlib/worker";
export { worker_alloc } from "./tools/littlescript/stdlib/worker";
export function worker_message(pointer: i32, length: i32): void {
  postMessage(readMessage(pointer, length));
}
export function send(length: i32): void { postMessage(new Uint8Array(length)); }
export function sendView(): void {
  const bytes = new Uint8Array(5);
  bytes[0] = 99; bytes[1] = 0; bytes[2] = 128; bytes[3] = 255; bytes[4] = 99;
  postMessage(bytes.subarray(1, 4));
}
`, "worker-limits");
  const replies = [];
  const { exports } = new WebAssembly.Instance(module, {
    env: { abort },
    worker: {
      postMessage(pointer, length) {
        replies.push(new Uint8Array(exports.memory.buffer, pointer, length).slice());
      },
    },
  });
  for (const length of [-1, 65537]) {
    assert.throws(() => exports.worker_alloc(length), /LittleScript aborted/);
    assert.throws(() => exports.worker_message(0, length), /LittleScript aborted/);
  }
  for (const [pointer, length] of [[-1, 1], [2147483647, 1], [exports.memory.buffer.byteLength - 1, 2]]) {
    assert.throws(() => exports.worker_message(pointer, length), /LittleScript aborted/);
  }
  assert.throws(() => exports.send(65537), /LittleScript aborted/);
  assert.deepEqual(replies, []);
  exports.send(0);
  exports.send(65536);
  exports.sendView();
  assert.deepEqual(replies.map((bytes) => bytes.length), [0, 65536, 3]);
  assert.deepEqual(replies[2], Uint8Array.of(0, 128, 255));
});

test("the authored compute demo waits for its worker and displays the real sum of squares", async (t) => {
  const scripts = join(root, "scenes/demos/scripts");
  const workerModule = await compile(t, readFileSync(join(scripts, "worker-compute.ls.ts"), "utf8"),
    "worker-compute", scripts);
  const parentModule = await compile(t, readFileSync(join(scripts, "worker-compute-main.ls.ts"), "utf8"),
    "worker-compute-main", scripts);
  const outbound = [];
  const replies = [];
  const worker = new WebAssembly.Instance(workerModule, {
    env: { abort },
    worker: {
      postMessage(pointer, length) {
        replies.push(new Uint8Array(worker.memory.buffer, pointer, length).slice());
      },
    },
  }).exports;
  const texts = [];
  let retained = new Uint8Array();
  let released = false;
  const checkHandle = (handle) => {
    assert.equal(handle, 41);
    assert.equal(released, false, "released handle");
  };
  const parent = new WebAssembly.Instance(parentModule, {
    env: { abort },
    la: {
      getSpriteByName(pointer, length) {
        assert.equal(new TextDecoder().decode(new Uint8Array(parent.memory.buffer, pointer, length)), "worker-result");
        return 7;
      },
      setText(handle, pointer, length) {
        assert.equal(handle, 7);
        texts.push(new TextDecoder().decode(new Uint8Array(parent.memory.buffer, pointer, length)));
      },
      workerSpawn(pointer, length) {
        assert.equal(new TextDecoder().decode(new Uint8Array(parent.memory.buffer, pointer, length)), "compute");
        return 41;
      },
      workerPostMessage(handle, pointer, length) {
        checkHandle(handle);
        outbound.push(new Uint8Array(parent.memory.buffer, pointer, length).slice());
      },
      workerPoll(handle) {
        checkHandle(handle);
        const message = replies.shift();
        retained = message ?? new Uint8Array();
        return message ? 1 : 0;
      },
      workerMessageLength(handle) {
        checkHandle(handle);
        return retained.length;
      },
      workerReadMessage(handle, pointer, capacity) {
        checkHandle(handle);
        assert.ok(capacity >= retained.length);
        new Uint8Array(parent.memory.buffer, pointer, retained.length).set(retained);
        return retained.length;
      },
      workerTerminate(handle) {
        checkHandle(handle);
        released = true;
      },
    },
  }).exports;
  assert.equal(parent.__la_abi_version(), 46);
  parent.main();
  assert.deepEqual(outbound, [Uint8Array.of(1, 2, 3, 4)]);
  parent.onFrame();
  assert.equal(released, false, "no busy-wait or premature termination");
  assert.deepEqual(texts, ["Computing…"]);
  const message = outbound.shift();
  const pointer = worker.worker_alloc(message.length);
  new Uint8Array(worker.memory.buffer, pointer, message.length).set(message);
  worker.worker_message(pointer, message.length);
  assert.deepEqual(replies, [Uint8Array.of(30, 0, 0, 0)]);
  parent.onFrame();
  assert.equal(texts.at(-1), "Sum of squares = 30");
  assert.equal(released, true);
  parent.onFrame();
});
