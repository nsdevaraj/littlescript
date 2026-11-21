// LittleScript Standard Library — Typed Sprite Facade (RT19)
// Provides ergonomic typed handles and helpers wrapping the raw LittleA `la.*` WASM ABI.

@external("la", "getSpriteByName")
declare function la_getSpriteByName(ptr: usize, len: i32): u32;

@external("la", "setX")
declare function la_setX(h: u32, x: f32): void;

@external("la", "setY")
declare function la_setY(h: u32, y: f32): void;

@external("la", "setScale")
declare function la_setScale(h: u32, sx: f32, sy: f32): void;

@external("la", "setRotation")
declare function la_setRotation(h: u32, deg: f32): void;

@external("la", "setAlpha")
declare function la_setAlpha(h: u32, alpha: f32): void;

@external("la", "setVisible")
declare function la_setVisible(h: u32, visible: i32): void;

@external("la", "setFill")
declare function la_setFill(h: u32, rgba: u32): void;

@external("la", "setText")
declare function la_setText(h: u32, ptr: usize, len: i32): void;

@external("la", "getText")
declare function la_getText(h: u32, ptr: usize, capacity: i32): i32;

@external("la", "tweenTo")
declare function la_tweenTo(h: u32, prop: i32, to: f32, durationFrames: i32, easing: i32): void;

/**
 * Handle `la.getSpriteByName` returns when no node has the id. It is
 * `u32.MAX_VALUE`, not `0`: node handle `0` is a valid node, so testing
 * `handle != 0` both reports a missing sprite as found and a real node 0 as
 * missing. Matches `la_script::NO_SPRITE` and the Web Player's sentinel.
 */
export const NO_SPRITE: u32 = u32.MAX_VALUE;

// tweenTo property indices (0=x, 1=y, 2=scaleX, 3=scaleY, 4=rotation, 5=alpha)
export const PROP_X: i32 = 0;
export const PROP_Y: i32 = 1;
export const PROP_SCALE_X: i32 = 2;
export const PROP_SCALE_Y: i32 = 3;
export const PROP_ROTATION: i32 = 4;
export const PROP_ALPHA: i32 = 5;

// Easing indices
export const EASE_LINEAR: i32 = 0;

/**
 * Typed handle representing a node in the scene tree.
 * Wraps an underlying numeric node handle (`u32`) with type-safe methods.
 */
export class Sprite {
  readonly handle: u32;

  constructor(handle: u32) {
    this.handle = handle;
  }

  /**
   * Resolve a node by its authored `id` attribute.
   */
  static fromId(id: string): Sprite {
    const buf = String.UTF8.encode(id);
    const handle = la_getSpriteByName(changetype<usize>(buf), buf.byteLength);
    return new Sprite(handle);
  }

  /**
   * Check whether this handle points to a real node (node `0` included).
   */
  isValid(): bool {
    return this.handle != NO_SPRITE;
  }

  /**
   * Set X coordinate in pixels.
   */
  setX(x: f32): void {
    la_setX(this.handle, x);
  }

  /**
   * Set Y coordinate in pixels.
   */
  setY(y: f32): void {
    la_setY(this.handle, y);
  }

  /**
   * Set (X, Y) coordinates in pixels.
   */
  setPosition(x: f32, y: f32): void {
    la_setX(this.handle, x);
    la_setY(this.handle, y);
  }

  /**
   * Set horizontal and vertical scale.
   */
  setScale(sx: f32, sy: f32): void {
    la_setScale(this.handle, sx, sy);
  }

  /**
   * Set rotation in degrees.
   */
  setRotation(deg: f32): void {
    la_setRotation(this.handle, deg);
  }

  /**
   * Set opacity (0.0 = transparent, 1.0 = fully opaque).
   */
  setAlpha(alpha: f32): void {
    la_setAlpha(this.handle, alpha);
  }

  /**
   * Set visibility flag.
   */
  setVisible(visible: bool): void {
    la_setVisible(this.handle, visible ? 1 : 0);
  }

  /**
   * Set solid color fill as `0xRRGGBBAA`.
   */
  setFill(rgba: u32): void {
    la_setFill(this.handle, rgba);
  }

  /**
   * Set text content of a text/label node.
   */
  setText(text: string): void {
    const buf = String.UTF8.encode(text);
    la_setText(this.handle, changetype<usize>(buf), buf.byteLength);
  }

  /**
   * Animate a property to a target value over a duration in frames.
   */
  tween(property: i32, to: f32, durationFrames: i32, easing: i32 = EASE_LINEAR): void {
    la_tweenTo(this.handle, property, to, durationFrames, easing);
  }
}

/**
 * Resolve a scene node by authored `id` to a typed `Sprite` instance.
 */
export function getSprite(id: string): Sprite {
  return Sprite.fromId(id);
}

/**
 * Resolve a scene node by authored `id` to its raw numeric handle.
 */
export function getSpriteHandle(id: string): u32 {
  const buf = String.UTF8.encode(id);
  return la_getSpriteByName(changetype<usize>(buf), buf.byteLength);
}

/**
 * Animate a numeric handle's property directly.
 */
export function tweenSprite(
  handle: u32,
  property: i32,
  to: f32,
  durationFrames: i32,
  easing: i32 = EASE_LINEAR,
): void {
  la_tweenTo(handle, property, to, durationFrames, easing);
}
