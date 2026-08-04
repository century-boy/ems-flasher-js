/**
 * Several games in one bank.
 *
 * The cart ships with a menu ROM (it identifies itself as `GB16M`) sitting at
 * the start of a bank. That menu does not carry a table of contents: at boot
 * it walks the bank in 32 KiB steps and treats every position holding a valid
 * Game Boy header — recognised by the Nintendo logo at 0x104 — as a game.
 *
 * So putting several games on a bank means nothing more than writing each ROM
 * at a position the mapper can reach:
 *
 * * the menu occupies the first slot, at offset 0;
 * * every ROM must start at an offset that is a multiple of its own size,
 *   because the mapper selects a game by masking address lines;
 * * ROM sizes are powers of two, from 32 KiB up to the whole 4 MiB bank.
 *
 * Deleting a game does not need an erase either: blanking its header makes the
 * menu skip it, and the space becomes available again.
 *
 * This layout was worked out in the C flasher; see
 * https://github.com/Stewmath/ems-flasher.
 */

import { EmsCart } from "./cart.js";
import { EmsError } from "./errors.js";
import type { BankNumber } from "./geometry.js";
import { BANK_SIZE, bankBase } from "./geometry.js";
import { HEADER_READ_SIZE, HeaderOffset, parseHeader, type CartHeader } from "./header.js";

/**
 * The Nintendo logo every Game Boy ROM carries at 0x104. The boot ROM checks
 * it before running a game, and the cart menu uses it to spot one.
 */
export const NINTENDO_LOGO = Uint8Array.from([
  0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b, 0x03, 0x73, 0x00, 0x83,
  0x00, 0x0c, 0x00, 0x0d, 0x00, 0x08, 0x11, 0x1f, 0x88, 0x89, 0x00, 0x0e,
  0xdc, 0xcc, 0x6e, 0xe6, 0xdd, 0xdd, 0xd9, 0x99, 0xbb, 0xbb, 0x67, 0x63,
  0x6e, 0x0e, 0xec, 0xcc, 0xdd, 0xdc, 0x99, 0x9f, 0xbb, 0xb9, 0x33, 0x3e,
]);

/** The step the menu scans with, and the smallest ROM the cart can hold. */
export const SLOT_SIZE = 0x8000; // 32 KiB

/** Number of positions the menu looks at in one bank. */
export const SLOTS_PER_BANK = BANK_SIZE / SLOT_SIZE; // 128

/** A game found in a bank. */
export interface RomEntry {
  /** Index in the scan, i.e. what the menu will show first, second, … */
  index: number;
  /** Offset from the start of the bank. */
  offset: number;
  /** Absolute address on the cart. */
  address: number;
  /** Size claimed by the ROM header, in bytes. */
  size: number;
  /** The decoded header. */
  header: CartHeader;
}

/** How a bank is filled up. */
export interface BankUsage {
  roms: RomEntry[];
  /** Bytes taken by the games found. */
  used: number;
  /** Bytes left in the bank. */
  free: number;
}

/** Sizes the header can declare, indexed by its size code. */
function romSizeFromCode(code: number): number {
  // codes 0x00..0x08 are 32 KiB shifted left by the code
  if (code <= 0x08) {
    return 0x8000 << code;
  }

  // the odd 1.1/1.2/1.5 MiB codes cannot be laid out by a power-of-two mapper
  return 0;
}

/** True when `bytes` starts with the Nintendo logo at the header position. */
function hasNintendoLogo(header: Uint8Array): boolean {
  return NINTENDO_LOGO.every(
    (byte, index) => header[HeaderOffset.Logo + index] === byte,
  );
}

/**
 * Walk a bank and report the games in it.
 *
 * Reads 128 headers, which takes a second or two — the same scan the menu does
 * on the console.
 */
export async function scanBank(
  cart: EmsCart,
  bank: BankNumber,
  onProgress?: (slot: number, total: number) => void,
): Promise<BankUsage> {
  const base = bankBase("rom", bank);
  const roms: RomEntry[] = [];
  let used = 0;

  for (let slot = 0; slot < SLOTS_PER_BANK; slot++) {
    const offset = slot * SLOT_SIZE;
    const raw = await cart.read("rom", base + offset, HEADER_READ_SIZE);

    onProgress?.(slot + 1, SLOTS_PER_BANK);

    if (!hasNintendoLogo(raw)) {
      continue;
    }

    const size = romSizeFromCode(raw[HeaderOffset.RomSize] ?? 0);
    if (size === 0) {
      continue;
    }

    roms.push({
      index: roms.length,
      offset,
      address: base + offset,
      size,
      header: parseHeader(raw),
    });
    used += size;

    // Skip the slots this ROM occupies: they are its data, not more games.
    slot += size / SLOT_SIZE - 1;
  }

  return { roms, used, free: BANK_SIZE - used };
}

/** Round `offset` up to the next multiple of `alignment`. */
function alignUp(offset: number, alignment: number): number {
  const remainder = offset % alignment;
  return remainder === 0 ? offset : offset + alignment - remainder;
}

/** True for 32 KiB, 64 KiB, … 4 MiB. */
export function isValidRomSize(size: number): boolean {
  return size >= SLOT_SIZE && size <= BANK_SIZE && (size & (size - 1)) === 0;
}

/**
 * Find where a ROM of `size` bytes can go in a bank that already holds `roms`.
 *
 * First fit, honouring the alignment the mapper needs: a 1 MiB ROM can only
 * start at a multiple of 1 MiB.
 *
 * @returns the offset from the start of the bank, or `undefined` if it does
 *   not fit anywhere
 */
export function findSlot(roms: readonly RomEntry[], size: number): number | undefined {
  if (!isValidRomSize(size)) {
    return undefined;
  }

  const occupied = [...roms].sort((left, right) => left.offset - right.offset);
  let candidate = 0;

  for (const rom of occupied) {
    // Does the ROM fit in the gap before this one?
    if (candidate + size <= rom.offset) {
      return candidate;
    }
    candidate = alignUp(rom.offset + rom.size, size);
  }

  return candidate + size <= BANK_SIZE ? candidate : undefined;
}

/** Raised when a ROM cannot be placed in the bank. */
export class NoSpaceError extends EmsError {}

/** Raised for a ROM the menu or the mapper cannot handle. */
export class UnsupportedRomError extends EmsError {}

/**
 * Check a ROM can join a bank, and say where it would go.
 *
 * Split out from the writing so the CLI and the web app can tell the user what
 * will happen before anything is programmed.
 */
export function planAdd(usage: BankUsage, rom: Uint8Array): { offset: number; size: number } {
  if (!hasNintendoLogo(rom)) {
    throw new UnsupportedRomError(
      "this file has no Nintendo logo in its header, so the cart menu would " +
        "not list it. Write it on its own with --write instead.",
    );
  }

  // The menu goes by the header, so a ROM whose header lies about its size
  // would be laid out wrongly and overlap its neighbour.
  const declared = romSizeFromCode(rom[HeaderOffset.RomSize] ?? 0);
  if (declared === 0) {
    throw new UnsupportedRomError(
      "this ROM declares a size the cart cannot lay out (only powers of two " +
        "from 32 KiB to 4 MiB work in a multi-game bank).",
    );
  }

  if (declared < rom.length) {
    throw new UnsupportedRomError(
      `this ROM is ${rom.length} bytes but its header declares ${declared}; ` +
        "the menu would place the next game on top of it.",
    );
  }

  const offset = findSlot(usage.roms, declared);
  if (offset === undefined) {
    throw new NoSpaceError(
      `no room for ${declared} bytes: the bank has ${usage.free} bytes free, ` +
        "but a ROM must start at a multiple of its own size.",
    );
  }

  return { offset, size: declared };
}

/**
 * Stop the menu listing a game, freeing its space.
 *
 * Only the header is blanked: flash cannot be erased byte by byte, and the
 * next ROM written over this space overwrites the leftovers anyway.
 */
export async function removeRom(
  cart: EmsCart,
  entry: RomEntry,
  blockSize = 32,
): Promise<void> {
  const blank = new Uint8Array(blockSize);

  for (let written = 0; written < HEADER_READ_SIZE; written += blockSize) {
    await cart.write("rom", entry.address + written, blank);
  }
}
