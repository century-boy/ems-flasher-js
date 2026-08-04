/**
 * The three commands, each turning validated options into cart traffic and
 * console output.
 */

import { open, stat } from "node:fs/promises";

import {
  HEADER_READ_SIZE,
  bankBase,
  describeTarget,
  detectSpace,
  formatBytes,
  formatDuration,
  parseHeader,
  readCart,
  scanBank,
  spaceSize,
  writeCart,
  type AddressSpace,
  type BankNumber,
  type EmsCart,
  type RomEntry,
  type TransferProgress,
} from "@ems-flasher-js/core";

import type { Options } from "./options.js";
import { ProgressBar } from "./progress-bar.js";

/** Everything a command needs: an open cart and what the user asked for. */
export interface CommandContext {
  cart: EmsCart;
  options: Options;
}

/** Dump the cart into a file, streaming block by block. */
export async function runRead({ cart, options }: CommandContext): Promise<void> {
  const file = options.file as string;
  const space = resolveSpace(options, file);
  const capacity = spaceSize(space);
  const target = describeTarget(space, options.bank);

  if (options.size !== undefined && options.size > capacity) {
    warn(`${target} holds only ${formatBytes(capacity)}, reading that much`);
  }

  const handle = await open(file, "w");
  const bar = new ProgressBar(`Reading ${target}`, showProgress(options));
  let last: TransferProgress | undefined;

  try {
    const result = await readCart(cart, {
      space,
      bank: options.bank,
      blockSize: options.blockSize,
      ...(options.size !== undefined ? { size: options.size } : {}),
      onChunk: async (chunk) => {
        await handle.write(chunk);
      },
      onProgress: (progress) => {
        last = progress;
        bar.update(progress);
      },
    });

    if (last) {
      bar.finish(last);
    }

    console.log(
      `Wrote ${formatBytes(result.bytes)} into ${file} ` +
        `in ${formatDuration(result.seconds)}`,
    );
  } catch (error) {
    bar.abandon();
    throw error;
  } finally {
    await handle.close();
  }
}

/** Write a file to the cart. */
export async function runWrite({ cart, options }: CommandContext): Promise<void> {
  const file = options.file as string;
  const space = resolveSpace(options, file);
  const target = describeTarget(space, options.bank);

  const { size: fileSize } = await stat(file);
  const capacity = spaceSize(space);

  if (fileSize > capacity && options.truncate) {
    warn(`truncating ${file} from ${formatBytes(fileSize)} to ${formatBytes(capacity)}`);
  }

  const handle = await open(file, "r");
  const payload = new Uint8Array(fileSize);

  try {
    await handle.read(payload, 0, fileSize, 0);
  } finally {
    await handle.close();
  }

  if (options.verbose) {
    console.log(`Writing ${file} (${formatBytes(fileSize)}) to ${target}`);
  }

  const bar = new ProgressBar(`Writing ${target}`, showProgress(options));
  let last: TransferProgress | undefined;

  try {
    const result = await writeCart(cart, payload, {
      space,
      bank: options.bank,
      blockSize: options.blockSize,
      truncate: options.truncate,
      onProgress: (progress) => {
        last = progress;
        bar.update(progress);
      },
    });

    if (last) {
      bar.finish(last);
    }

    console.log(
      `Wrote ${formatBytes(result.bytes)} from ${file} to ${target} ` +
        `in ${formatDuration(result.seconds)}`,
    );
  } catch (error) {
    bar.abandon();
    throw error;
  }
}

/**
 * Show everything on the cart: every game in every bank, not just the header
 * at the start of each one.
 *
 * A bank can hold several games behind the cart menu, so listing only offset 0
 * hides most of what is there. This scans both banks, which costs a couple of
 * seconds and is worth it.
 */
export async function runTitle({ cart, options }: CommandContext): Promise<void> {
  for (const bank of [1, 2] as const) {
    process.stderr.write(`Scanning bank ${bank}…`);
    const usage = await scanBank(cart, bank);
    process.stderr.write("\r\u001b[2K");

    console.log(`Bank ${bank}:`);

    if (usage.roms.length === 0) {
      await describeEmptyBank(cart, bank);
      continue;
    }

    for (const rom of usage.roms) {
      printRom(rom, options.verbose);
    }

    if (usage.roms.length > 1 || options.verbose) {
      console.log(
        `  ${usage.roms.length} ROM(s), ${formatBytes(usage.used)} used, ` +
          `${formatBytes(usage.free)} free`,
      );
    }
  }
}

/** One line per game, plus the details when the user asked for them. */
function printRom(rom: RomEntry, verbose: boolean): void {
  const title = rom.header.title || "(blank)";
  const where = `0x${rom.offset.toString(16).padStart(6, "0")}`;

  console.log(
    `  ${String(rom.index).padStart(2)}  ${title.padEnd(16)} ` +
      `${formatBytes(rom.size).padStart(9)}  @ ${where}  ${rom.header.hardware}`,
  );

  if (verbose) {
    console.log(`        ROM ${rom.header.romSize} · save ${rom.header.ramSize} · ` +
      `version ${rom.header.version} · ${rom.header.region}`);
  }

  if (!rom.header.checksumValid) {
    console.log(
      `        header checksum INVALID (found 0x${hex(rom.header.checksum)}, ` +
        `expected 0x${hex(rom.header.computedChecksum)}): will not boot`,
    );
  } else if (verbose) {
    console.log("        header checksum OK");
  }

  for (const warning of rom.header.warnings) {
    console.log(`        ${warning}`);
  }
}

/**
 * Say something useful about a bank the menu would find empty.
 *
 * There may still be data at offset 0 — a ROM with a damaged logo, or a
 * half-written flash — so report the raw header rather than just "nothing".
 */
async function describeEmptyBank(cart: EmsCart, bank: BankNumber): Promise<void> {
  const raw = await cart.read("rom", bankBase("rom", bank), HEADER_READ_SIZE);
  const header = parseHeader(raw);

  if (header.title) {
    console.log(
      `  no ROM the cart menu would list, but there is a header at 0x000000: ` +
        `${header.title} (${header.romSize})`,
    );
  } else {
    console.log("  empty");
  }
}

function hex(value: number): string {
  return value.toString(16).padStart(2, "0").toUpperCase();
}

/**
 * Decide which memory to touch: what the user forced, else what the file name
 * suggests. Warns when a bank was requested for the shared SRAM.
 */
function resolveSpace(options: Options, file: string): AddressSpace {
  const space = options.space ?? detectSpace(file);

  if (space === "sram" && options.bank !== 1) {
    warn(`SRAM is shared by both banks, ignoring --bank ${options.bank}`);
  }

  return space;
}

/** The bar needs both the user's consent and a real terminal. */
function showProgress(options: Options): boolean {
  return options.progress && ProgressBar.isSupported();
}

function warn(message: string): void {
  console.error(`ems-flasher: warning: ${message}`);
}

