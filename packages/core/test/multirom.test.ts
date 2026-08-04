import { describe, expect, it } from "vitest";

import {
  BANK_SIZE,
  EmsCart,
  HeaderOffset,
  NINTENDO_LOGO,
  NoSpaceError,
  SLOT_SIZE,
  UnsupportedRomError,
  computeHeaderChecksum,
  findSlot,
  isValidRomSize,
  planAdd,
  removeRom,
  scanBank,
  type RomEntry,
} from "../src/index.js";

import { FakeUsbDevice } from "./fake-device.js";

/** Build a ROM whose header declares `size`, as the cart menu expects. */
function makeRom(title: string, size: number): Uint8Array {
  const rom = new Uint8Array(size);

  rom.set(NINTENDO_LOGO, HeaderOffset.Logo);
  for (let index = 0; index < title.length; index++) {
    rom[HeaderOffset.Title + index] = title.charCodeAt(index);
  }

  // size code: 32 KiB << code
  rom[HeaderOffset.RomSize] = Math.log2(size / 0x8000);
  rom[HeaderOffset.HeaderChecksum] = computeHeaderChecksum(rom);

  return rom;
}

/** Place a ROM in the fake cart's flash, as a previous --add would have. */
function place(device: FakeUsbDevice, bank: 1 | 2, offset: number, rom: Uint8Array): void {
  device.rom.set(rom, (bank - 1) * BANK_SIZE + offset);
}

async function openFakeCart(): Promise<{ cart: EmsCart; device: FakeUsbDevice }> {
  const device = new FakeUsbDevice();
  const cart = await EmsCart.open(device.asUsbDevice());
  return { cart, device };
}

/** A ROM entry as findSlot() wants it, without going through a cart. */
function entry(offset: number, size: number): RomEntry {
  return { index: 0, offset, address: offset, size } as RomEntry;
}

describe("valid sizes", () => {
  it.each([0x8000, 0x10000, 0x100000, BANK_SIZE])("accepts %i", (size) => {
    expect(isValidRomSize(size)).toBe(true);
  });

  it.each([0, 100, 0x4000, 0x18000, BANK_SIZE * 2])("rejects %i", (size) => {
    expect(isValidRomSize(size)).toBe(false);
  });
});

describe("placement", () => {
  it("puts the first ROM at the start of the bank", () => {
    expect(findSlot([], 0x8000)).toBe(0);
  });

  it("puts the next ROM right after a same-sized neighbour", () => {
    expect(findSlot([entry(0, 0x8000)], 0x8000)).toBe(0x8000);
  });

  it("aligns a ROM to a multiple of its own size", () => {
    // a 32 KiB menu followed by a 1 MiB game: the game cannot start at 0x8000
    expect(findSlot([entry(0, SLOT_SIZE)], 0x100000)).toBe(0x100000);
  });

  it("reuses a gap left by a deleted game", () => {
    const roms = [entry(0, SLOT_SIZE), entry(0x100000, 0x100000)];

    // 32 KiB fits in the hole between the menu and the 1 MiB game
    expect(findSlot(roms, SLOT_SIZE)).toBe(SLOT_SIZE);
  });

  it("skips a gap that is too small and goes after the last ROM", () => {
    const roms = [entry(0, SLOT_SIZE), entry(0x100000, 0x100000)];

    expect(findSlot(roms, 0x100000)).toBe(0x200000);
  });

  it("returns undefined when the bank is full", () => {
    expect(findSlot([entry(0, BANK_SIZE)], SLOT_SIZE)).toBeUndefined();
  });

  it("returns undefined when only misaligned space is left", () => {
    // 3 MiB used, 1 MiB free, but a 2 MiB ROM needs a 2 MiB boundary
    const roms = [entry(0, 0x200000), entry(0x200000, 0x100000)];

    expect(findSlot(roms, 0x200000)).toBeUndefined();
  });
});

describe("scanning a bank", () => {
  it("finds nothing in a blank bank", async () => {
    const { cart } = await openFakeCart();

    const usage = await scanBank(cart, 1);

    expect(usage.roms).toEqual([]);
    expect(usage.free).toBe(BANK_SIZE);
  });

  it("lists the games in the order the menu will show them", async () => {
    const { cart, device } = await openFakeCart();
    place(device, 1, 0, makeRom("MENU", SLOT_SIZE));
    place(device, 1, SLOT_SIZE, makeRom("TETRIS", SLOT_SIZE));
    place(device, 1, 0x100000, makeRom("LSDJ", 0x100000));

    const usage = await scanBank(cart, 1);

    expect(usage.roms.map((rom) => rom.header.title)).toEqual(["MENU", "TETRIS", "LSDJ"]);
    expect(usage.roms.map((rom) => rom.offset)).toEqual([0, SLOT_SIZE, 0x100000]);
    expect(usage.used).toBe(SLOT_SIZE * 2 + 0x100000);
  });

  it("does not mistake a game's own data for another game", async () => {
    const { cart, device } = await openFakeCart();

    // a 1 MiB ROM that happens to contain a logo 32 KiB in
    const rom = makeRom("BIG", 0x100000);
    rom.set(NINTENDO_LOGO, SLOT_SIZE + HeaderOffset.Logo);
    place(device, 1, 0, rom);

    const usage = await scanBank(cart, 1);

    expect(usage.roms).toHaveLength(1);
    expect(usage.roms[0]?.header.title).toBe("BIG");
  });

  it("scans bank 2 at its own base address", async () => {
    const { cart, device } = await openFakeCart();
    place(device, 2, 0, makeRom("ON BANK 2", SLOT_SIZE));

    expect((await scanBank(cart, 1)).roms).toHaveLength(0);
    expect((await scanBank(cart, 2)).roms[0]?.address).toBe(BANK_SIZE);
  });

  it("reports progress slot by slot", async () => {
    const { cart } = await openFakeCart();
    const seen: number[] = [];

    await scanBank(cart, 1, (slot) => seen.push(slot));

    expect(seen[0]).toBe(1);
    expect(seen.at(-1)).toBe(BANK_SIZE / SLOT_SIZE);
  });
});

describe("planning an addition", () => {
  const emptyBank = { roms: [], used: 0, free: BANK_SIZE };

  it("places a game in an empty bank", () => {
    expect(planAdd(emptyBank, makeRom("GAME", SLOT_SIZE))).toEqual({
      offset: 0,
      size: SLOT_SIZE,
    });
  });

  it("refuses a file with no Nintendo logo, which the menu would not list", () => {
    expect(() => planAdd(emptyBank, new Uint8Array(SLOT_SIZE))).toThrow(UnsupportedRomError);
  });

  it("refuses a ROM whose header understates its size", () => {
    const rom = makeRom("LIAR", SLOT_SIZE * 4);
    rom[HeaderOffset.RomSize] = 0; // claims 32 KiB while being 128 KiB

    expect(() => planAdd(emptyBank, rom)).toThrow(/place the next game on top/);
  });

  it("refuses a size the mapper cannot lay out", () => {
    const rom = makeRom("ODD", SLOT_SIZE);
    rom[HeaderOffset.RomSize] = 0x52; // the 1.1 MiB oddity

    expect(() => planAdd(emptyBank, rom)).toThrow(UnsupportedRomError);
  });

  it("reports there is no room rather than overwriting a game", () => {
    const full = {
      roms: [entry(0, BANK_SIZE)],
      used: BANK_SIZE,
      free: 0,
    };

    expect(() => planAdd(full, makeRom("LATE", SLOT_SIZE))).toThrow(NoSpaceError);
  });
});

describe("deleting", () => {
  it("blanks the header so the menu skips the game, and frees its space", async () => {
    const { cart, device } = await openFakeCart();
    place(device, 1, 0, makeRom("MENU", SLOT_SIZE));
    place(device, 1, SLOT_SIZE, makeRom("DOOMED", SLOT_SIZE));

    const before = await scanBank(cart, 1);
    const doomed = before.roms[1] as RomEntry;

    await removeRom(cart, doomed);

    const after = await scanBank(cart, 1);
    expect(after.roms.map((rom) => rom.header.title)).toEqual(["MENU"]);
    expect(after.free).toBe(BANK_SIZE - SLOT_SIZE);
  });
});
