import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = join(root, "tools/littlescript/src/cli.mjs");

test("linked scenes retain ABI46 and resolve worker helpers beside their authored source", (t) => {
  const directory = join(root, "tools/littlescript", `.worker-link-test-${process.pid}`);
  mkdirSync(directory);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const legacy = join(directory, "legacy.ts");
  writeFileSync(legacy, "export function __la_abi_version(): i32 { return 41; }\n");
  const output = join(directory, "linked.wasm");
  const result = spawnSync(process.execPath, [
    cli, "link", `=${join(root, "scenes/demos/scripts/worker-compute-main.ls.ts")}`,
    `widget=${legacy}`, "-o", output,
  ], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const module = new WebAssembly.Module(readFileSync(output));
  let sent;
  const { exports } = new WebAssembly.Instance(module, {
    env: { abort() { throw new Error("Unexpected script abort"); } },
    la: {
      getSpriteByName() { return 7; },
      setText() {},
      workerSpawn(pointer, length) {
        assert.equal(new TextDecoder().decode(new Uint8Array(exports.memory.buffer, pointer, length)), "compute");
        return 41;
      },
      workerPostMessage(handle, pointer, length) {
        sent = { handle, bytes: [...new Uint8Array(exports.memory.buffer, pointer, length)] };
      },
      workerPoll() { return 0; },
      workerMessageLength() { return 0; },
      workerReadMessage() { return 0; },
      workerTerminate() {},
    },
  });
  assert.equal(exports.__la_abi_version(), 46);
  exports.main();
  assert.deepEqual(sent, { handle: 41, bytes: [1, 2, 3, 4] });
});
