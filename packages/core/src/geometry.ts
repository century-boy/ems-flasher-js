/**
 * The shape of the cart: how much memory there is and where it lives.
 *
 * The _GB USB smart card 64M_ holds 64 Mbit of flash ROM split into two
 * independent 32 Mbit (4 MiB) banks. Only one bank is visible to the Game Boy
 * at a time — you switch between them by power cycling the console quickly.
 *
 * On top of that there is a single 128 KiB SRAM chip for save files, and that
 * chip is **shared by both banks**. Selecting a bank therefore has no meaning
 * for saves, which is why {@link bankBase} always returns 0 for SRAM.
 */

/** Which of the two address spaces on the cart a transfer targets. */
export type AddressSpace = "rom" | "sram";

/** One ROM bank: 32 Mbit. */
export const BANK_SIZE = 0x400_000;

/** The cart holds two ROM banks, for 64 Mbit in total. */
export const BANK_COUNT = 2;

/** The whole SRAM chip, shared by both banks. */
export const SRAM_SIZE = 0x020_000;

/** Usable size of each address space, in bytes. */
export const SPACE_SIZE: Record<AddressSpace, number> = {
  rom: BANK_SIZE,
  sram: SRAM_SIZE,
};

/** Highest address the hardware will accept, per space. */
export const SPACE_LIMIT: Record<AddressSpace, number> = {
  rom: BANK_SIZE * BANK_COUNT,
  sram: SRAM_SIZE,
};

/** Human readable name, for messages shown to the user. */
export const SPACE_LABEL: Record<AddressSpace, string> = {
  rom: "ROM",
  sram: "SRAM",
};

/** A bank number as the user types it: 1 or 2, not zero based. */
export type BankNumber = 1 | 2;

/** Type guard for user supplied bank numbers. */
export function isBankNumber(value: number): value is BankNumber {
  return value === 1 || value === 2;
}

/**
 * Absolute base address of a bank within an address space.
 *
 * ROM banks are {@link BANK_SIZE} apart; SRAM is not banked at all, so its
 * base never moves.
 */
export function bankBase(space: AddressSpace, bank: BankNumber): number {
  return space === "sram" ? 0 : (bank - 1) * BANK_SIZE;
}

/** Usable size of an address space, in bytes. */
export function spaceSize(space: AddressSpace): number {
  return SPACE_SIZE[space];
}

/**
 * Pick the address space a file belongs to.
 *
 * A `.sav` file is a save and goes to SRAM; anything else is a ROM.
 */
export function detectSpace(fileName: string): AddressSpace {
  return fileName.toLowerCase().endsWith(".sav") ? "sram" : "rom";
}

/** Describe a target the way a user thinks about it: "ROM bank 2", "SRAM". */
export function describeTarget(space: AddressSpace, bank: BankNumber): string {
  return space === "sram" ? "SRAM" : `ROM bank ${bank}`;
}
