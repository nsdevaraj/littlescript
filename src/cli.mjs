#!/usr/bin/env node
// littlescript — the LittleScript CLI entry point; the commands are in main.mjs.
//
// Every run is a fresh process, and TypeScript, asc and Binaryen are about
// 20 MB of JavaScript that V8 would otherwise compile from scratch each time.
// Node's compile cache (22.1+) keeps the compiled code on disk. It has to be on
// before those modules load, and a module's static imports load before its
// body runs, so main.mjs is imported only once the cache is on. Without the
// cache -- older Node, or a cache that cannot be enabled -- runs are uncached.
import module from "node:module";

try {
  module.enableCompileCache?.();
} catch {}
await import("./main.mjs");
