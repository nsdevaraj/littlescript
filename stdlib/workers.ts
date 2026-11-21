@external("la", "workerSpawn")
declare function hostSpawn(pointer: usize, length: i32): i32;
@external("la", "workerPostMessage")
declare function hostPostMessage(handle: i32, pointer: usize, length: i32): void;
@external("la", "workerPoll")
declare function hostPoll(handle: i32): i32;
@external("la", "workerMessageLength")
declare function hostMessageLength(handle: i32): i32;
@external("la", "workerReadMessage")
declare function hostReadMessage(handle: i32, pointer: usize, capacity: i32): i32;
@external("la", "workerTerminate")
declare function hostTerminate(handle: i32): void;

export enum WorkerEvent {
  None = 0,
  Message = 1,
  Failed = 2,
  Stopped = 3,
}

export function workerSpawn(name: string): i32 {
  assert(name.length > 0 && name.length <= 64, "Worker names must contain 1 to 64 ASCII characters");
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    const letter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    assert(letter || (i > 0 && ((code >= 48 && code <= 57) || code == 95 || code == 45)),
      "Worker names must match [A-Za-z][A-Za-z0-9_-]{0,63}");
  }
  const bytes = String.UTF8.encode(name);
  return hostSpawn(changetype<usize>(bytes), bytes.byteLength);
}

export function workerPostMessage(handle: i32, message: Uint8Array): void {
  assert(message.byteLength <= 65536, "Worker messages must not exceed 64 KiB");
  hostPostMessage(handle, message.dataStart, message.byteLength);
}

export function workerPoll(handle: i32): WorkerEvent {
  return <WorkerEvent>hostPoll(handle);
}

export function workerMessageLength(handle: i32): i32 {
  return hostMessageLength(handle);
}

export function workerReadMessage(handle: i32): Uint8Array {
  const message = new Uint8Array(hostMessageLength(handle));
  hostReadMessage(handle, message.dataStart, message.byteLength);
  return message;
}

export function workerTerminate(handle: i32): void {
  hostTerminate(handle);
}
