/**
 * The three things a user actually wants to do: dump the cart, write to it,
 * and see what is on it.
 *
 * These helpers own the block loop, the size limits and the progress
 * reporting, so the CLI and the web app only have to supply a destination for
 * the bytes and a way to draw a bar.
 */

import type { Bytes } from "./bytes.js";
import { allocate } from "./bytes.js";
import { EmsCart, throwIfAborted } from "./cart.js";
import { FileTooLargeError } from "./errors.js";
import type { AddressSpace, BankNumber } from "./geometry.js";
import { BANK_COUNT, bankBase, describeTarget, spaceSize } from "./geometry.js";
import { HEADER_READ_SIZE, parseHeader, type CartHeader } from "./header.js";

/** Default bytes per USB transfer, per direction. */
export const DEFAULT_BLOCK_SIZE = {
  /** Reads are round trips, so bigger blocks pay off. */
  read: 4096,
  /** The flash programs 32 bytes at a time; this matches the stock software. */
  write: 32,
} as const;

/** A snapshot of an ongoing transfer, handed to `onProgress`. */
export interface TransferProgress {
  /** Bytes transferred so far. */
  done: number;
  /** Bytes to transfer in total. */
  total: number;
  /** Fraction in the 0..1 range, ready to drive a bar. */
  fraction: number;
  /** Average throughput since the transfer started, in bytes per second. */
  bytesPerSecond: number;
  /** Seconds elapsed since the transfer started. */
  elapsedSeconds: number;
  /** Estimated seconds left, or `undefined` before there is enough data. */
  etaSeconds: number | undefined;
}

/** Options shared by reads and writes. */
interface TransferOptions {
  /** Which memory to touch. Defaults to the ROM. */
  space?: AddressSpace;
  /** Which ROM bank to touch. Ignored for SRAM, which is shared. */
  bank?: BankNumber;
  /** Bytes per USB transfer. */
  blockSize?: number;
  /** Called after every block with the current progress. */
  onProgress?: (progress: TransferProgress) => void;
  /** Abort the transfer between blocks. */
  signal?: AbortSignal;
}

/** Options for {@link readCart}. */
export interface ReadOptions extends TransferOptions {
  /** How many bytes to read. Defaults to the whole address space. */
  size?: number;

  /**
   * Where to start reading inside the space, relative to the bank base.
   *
   * Defaults to 0. Extracting one game out of a multi-game bank uses it to
   * start at that game's offset.
   */
  startOffset?: number;
  /**
   * Called with every block as it arrives, so callers can stream to disk
   * instead of buffering the whole dump.
   */
  onChunk?: (chunk: Uint8Array, offset: number) => void | Promise<void>;
}

/** Options for {@link writeCart}. */
export interface WriteOptions extends TransferOptions {
  /**
   * Allow a payload larger than the target space to be cut short instead of
   * refusing to write it.
   */
  truncate?: boolean;

  /**
   * Where to start writing inside the space, relative to the bank base.
   *
   * Defaults to 0, which is what writing a single ROM wants. Adding a game to
   * a multi-game bank uses it to place the ROM after the ones already there.
   */
  startOffset?: number;
}

/** What a completed transfer reports back. */
export interface TransferResult {
  /** Bytes actually transferred. */
  bytes: number;
  /** The dumped data, unless the caller streamed it away with `onChunk`. */
  data: Bytes | undefined;
  /** How long the transfer took, in seconds. */
  seconds: number;
}

/**
 * Dump the cart into memory, or into `onChunk` if the caller streams it.
 *
 * Reads never exceed the size of the address space, and a size that is not a
 * multiple of the block size simply ends with a shorter final block.
 */
export async function readCart(cart: EmsCart, options: ReadOptions = {}): Promise<TransferResult> {
  const space = options.space ?? "rom";
  const bank = options.bank ?? 1;
  const blockSize = options.blockSize ?? DEFAULT_BLOCK_SIZE.read;
  const start = options.startOffset ?? 0;
  const base = bankBase(space, bank) + start;
  const available = spaceSize(space) - start;
  const total = Math.min(options.size ?? available, available);

  const collected: Bytes[] = [];
  const progress = new ProgressTracker(total, options.onProgress);

  let done = 0;
  while (done < total) {
    throwIfAborted(options.signal, done);

    // The final block is short whenever the size is not a round multiple.
    const count = Math.min(blockSize, total - done);
    const chunk = await cart.read(space, base + done, count);

    if (options.onChunk) {
      await options.onChunk(chunk, done);
    } else {
      collected.push(chunk);
    }

    done += count;
    progress.report(done);
  }

  return {
    bytes: done,
    data: options.onChunk ? undefined : concat(collected, done),
    seconds: progress.elapsedSeconds(),
  };
}

/**
 * Write a payload to the cart.
 *
 * Refuses payloads that do not fit unless `truncate` is set, and writes any
 * trailing partial block instead of dropping it.
 */
export async function writeCart(
  cart: EmsCart,
  payload: Uint8Array,
  options: WriteOptions = {},
): Promise<TransferResult> {
  const space = options.space ?? "rom";
  const bank = options.bank ?? 1;
  const blockSize = options.blockSize ?? DEFAULT_BLOCK_SIZE.write;
  const start = options.startOffset ?? 0;
  const base = bankBase(space, bank) + start;
  const capacity = spaceSize(space) - start;

  if (payload.length === 0) {
    throw new FileTooLargeError(0, capacity, describeTarget(space, bank));
  }

  if (payload.length > capacity && !options.truncate) {
    throw new FileTooLargeError(payload.length, capacity, describeTarget(space, bank));
  }

  const total = Math.min(payload.length, capacity);
  const progress = new ProgressTracker(total, options.onProgress);

  let done = 0;
  while (done < total) {
    throwIfAborted(options.signal, done);

    const count = Math.min(blockSize, total - done);
    await cart.write(space, base + done, payload.subarray(done, done + count));

    done += count;
    progress.report(done);
  }

  return { bytes: done, data: undefined, seconds: progress.elapsedSeconds() };
}

/** A bank and the header found at the start of it. */
export interface BankHeader {
  bank: BankNumber;
  header: CartHeader;
}

/** Read the ROM header of every bank on the cart. */
export async function readBankHeaders(cart: EmsCart): Promise<BankHeader[]> {
  const headers: BankHeader[] = [];

  for (let bank = 1; bank <= BANK_COUNT; bank++) {
    const bankNumber = bank as BankNumber;
    const raw = await cart.read("rom", bankBase("rom", bankNumber), HEADER_READ_SIZE);
    headers.push({ bank: bankNumber, header: parseHeader(raw) });
  }

  return headers;
}

/**
 * Turns byte counts into progress snapshots.
 *
 * Kept in the core so the CLI bar and the web bar agree on throughput and ETA
 * rather than each inventing their own arithmetic.
 */
class ProgressTracker {
  readonly #startedAt = now();

  constructor(
    private readonly total: number,
    private readonly onProgress: ((progress: TransferProgress) => void) | undefined,
  ) {}

  report(done: number): void {
    if (!this.onProgress) {
      return;
    }

    const elapsedSeconds = this.elapsedSeconds();
    const bytesPerSecond = elapsedSeconds > 0 ? done / elapsedSeconds : 0;
    const remaining = this.total - done;

    this.onProgress({
      done,
      total: this.total,
      fraction: this.total > 0 ? done / this.total : 1,
      bytesPerSecond,
      elapsedSeconds,
      etaSeconds: bytesPerSecond > 0 ? remaining / bytesPerSecond : undefined,
    });
  }

  elapsedSeconds(): number {
    return (now() - this.#startedAt) / 1000;
  }
}

/** `performance.now()` everywhere it exists, `Date.now()` as a fallback. */
function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** Join the collected blocks into the single buffer the caller expects. */
function concat(chunks: Bytes[], totalLength: number): Bytes {
  const result = allocate(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}
