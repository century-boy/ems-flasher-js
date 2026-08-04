/**
 * The byte buffer type used throughout the library.
 *
 * Since TypeScript 5.7 `Uint8Array` is generic over its backing buffer, and
 * WebUSB only accepts views backed by a plain `ArrayBuffer` — never a
 * `SharedArrayBuffer`. Naming that constraint once keeps every signature in
 * the library honest and the call sites free of casts.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

/** Allocate `length` zeroed bytes. */
export function allocate(length: number): Bytes {
  return new Uint8Array(length);
}

/**
 * View a WebUSB `DataView` as bytes, without copying.
 *
 * WebUSB always hands back plain `ArrayBuffer`s, so the assertion is safe and
 * confined to this one function.
 */
export function viewOf(data: DataView): Bytes {
  return new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
}
