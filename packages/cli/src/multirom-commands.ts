/**
 * The multi-game commands: list what is on a bank, add a game, remove one.
 *
 * See `multirom.ts` in the core for how the layout works; here we only turn it
 * into console output.
 */

import { open, stat } from "node:fs/promises";

import {
  formatBytes,
  formatDuration,
  planAdd,
  readCart,
  removeRom,
  scanBank,
  writeCart,
  type BankUsage,
  type EmsCart,
  type RomEntry,
  type TransferProgress,
} from "@ems-flasher-js/core";

import type { Options } from "./options.js";
import { ProgressBar } from "./progress-bar.js";

/**
 * Scan a bank for games.
 *
 * This reads 128 headers, a second or two, so say what is happening — but on
 * stderr, so `--list | grep` still sees only the listing.
 */
async function scan(cart: EmsCart, options: Options): Promise<BankUsage> {
  process.stderr.write(`Scanning bank ${options.bank}…`);

  const usage = await scanBank(cart, options.bank);

  process.stderr.write("\r\u001b[2K"); // erase the notice, leaving stdout clean

  return usage;
}

/** List the games the cart menu will show for this bank. */
export async function runList(cart: EmsCart, options: Options): Promise<void> {
  const usage = await scan(cart, options);

  if (usage.roms.length === 0) {
    console.log(`Bank ${options.bank} holds no ROM the menu would list.`);
    return;
  }

  console.log(`Bank ${options.bank}:`);

  for (const rom of usage.roms) {
    const title = rom.header.title || "(blank)";
    const flags = rom.header.checksumValid ? "" : "  [bad header checksum]";

    console.log(
      `  ${String(rom.index).padStart(2)}  ${title.padEnd(16)} ` +
        `${formatBytes(rom.size).padStart(9)}  @ 0x${rom.offset.toString(16).padStart(6, "0")}` +
        flags,
    );
  }

  console.log(
    `\n${usage.roms.length} ROM(s), ${formatBytes(usage.used)} used, ` +
      `${formatBytes(usage.free)} free.`,
  );
}

/** Add a game to a bank without disturbing what is already there. */
export async function runAdd(cart: EmsCart, options: Options): Promise<void> {
  const file = options.file as string;
  const { size: fileSize } = await stat(file);

  const handle = await open(file, "r");
  const rom = new Uint8Array(fileSize);

  try {
    await handle.read(rom, 0, fileSize, 0);
  } finally {
    await handle.close();
  }

  const usage = await scan(cart, options);

  // Fails here, before anything is written, if the ROM cannot be placed.
  const { offset, size } = planAdd(usage, rom);

  console.log(
    `Adding ${file} (${formatBytes(rom.length)}) to bank ${options.bank} ` +
      `at 0x${offset.toString(16)}, next to ${usage.roms.length} existing ROM(s).`,
  );

  const bar = new ProgressBar(`Writing bank ${options.bank}`, showProgress(options));
  let last: TransferProgress | undefined;

  try {
    const result = await writeCart(cart, rom, {
      space: "rom",
      bank: options.bank,
      blockSize: options.blockSize,
      startOffset: offset,
      onProgress: (progress) => {
        last = progress;
        bar.update(progress);
      },
    });

    if (last) {
      bar.finish(last);
    }

    console.log(
      `Added ${formatBytes(result.bytes)} in ${formatDuration(result.seconds)}. ` +
        `The ROM declares ${formatBytes(size)}, so the next game starts after that.`,
    );
  } catch (error) {
    bar.abandon();
    throw error;
  }
}

/** Remove a game from the menu by blanking its header. */
export async function runDelete(cart: EmsCart, options: Options): Promise<void> {
  const usage = await scan(cart, options);
  const entry = pickRom(usage, options);

  await removeRom(cart, entry, options.blockSize);

  console.log(
    `Removed "${entry.header.title || "(blank)"}" from the menu, ` +
      `freeing ${formatBytes(entry.size)}.`,
  );
}

function showProgress(options: Options): boolean {
  return options.progress && ProgressBar.isSupported();
}

/**
 * Save one game out of a multi-game bank to a file.
 *
 * Reads exactly the bytes that game occupies, so the dump is a working ROM
 * rather than a slice of the whole bank.
 */
export async function runExtract(cart: EmsCart, options: Options): Promise<void> {
  const usage = await scan(cart, options);
  const entry = pickRom(usage, options);

  const file = options.file ?? suggestFileName(entry);
  const handle = await open(file, "w");

  const bar = new ProgressBar(
    `Extracting ${entry.header.title || "ROM"}`,
    showProgress(options),
  );
  let last: TransferProgress | undefined;

  try {
    const result = await readCart(cart, {
      bank: options.bank,
      startOffset: entry.offset,
      size: entry.size,
      blockSize: options.blockSize,
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
      `Extracted ${formatBytes(result.bytes)} into ${file} ` +
        `in ${formatDuration(result.seconds)}`,
    );
  } catch (error) {
    bar.abandon();
    throw error;
  } finally {
    await handle.close();
  }
}

/** The ROM the user asked for, or a clear error naming the valid range. */
function pickRom(usage: BankUsage, options: Options): RomEntry {
  const index = options.romIndex as number;
  const entry = usage.roms[index];

  if (!entry) {
    const available = usage.roms.length === 0 ? "none" : `0..${usage.roms.length - 1}`;
    throw new Error(
      `no ROM with index ${index} on bank ${options.bank} (available: ${available})`,
    );
  }

  return entry;
}

/** Turn "TRIP WORLD" into "trip-world.gb", for when no file name was given. */
function suggestFileName(entry: RomEntry): string {
  const slug = (entry.header.title || "rom")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  const extension = entry.header.hardware.startsWith("CGB") ? "gbc" : "gb";

  return `${slug || "rom"}.${extension}`;
}
