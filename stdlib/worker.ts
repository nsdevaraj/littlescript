@external("worker", "postMessage")
declare function hostPostMessage(pointer: usize, length: i32): void;

// Root the host's input allocation until worker_message has copied it.
let input = new Uint8Array(0);

export function worker_alloc(length: i32): i32 {
  assert(length >= 0 && length <= 65536, "Worker input must contain 0 to 64 KiB");
  if (input.length < length) input = new Uint8Array(length);
  return <i32>input.dataStart;
}

export function readMessage(pointer: i32, length: i32): Uint8Array {
  assert(length >= 0 && length <= 65536, "Worker input must contain 0 to 64 KiB");
  assert(<u64><u32>pointer + <u64>length <= <u64>memory.size() * 65536,
    "Worker input byte range is outside memory");
  const message = new Uint8Array(length);
  memory.copy(message.dataStart, <usize>pointer, <usize>length);
  return message;
}

export function postMessage(message: Uint8Array): void {
  assert(message.byteLength <= 65536, "Worker messages must not exceed 64 KiB");
  hostPostMessage(message.dataStart, message.byteLength);
}
