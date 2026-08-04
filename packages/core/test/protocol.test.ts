import { describe, expect, it } from "vitest";

import {
  BANK_COUNT,
  BANK_SIZE,
  COMMAND_SIZE,
  EMS_PRODUCT_ID,
  EMS_VENDOR_ID,
  Opcode,
  SRAM_SIZE,
  bankBase,
  detectSpace,
  encodeCommand,
  encodeWrite,
  isBankNumber,
  spaceSize,
} from "../src/index.js";

describe("command encoding", () => {
  it("packs an opcode and two big endian words into 9 bytes", () => {
    const command = encodeCommand(Opcode.ReadRom, 0x400000, 4096);

    expect(command).toHaveLength(COMMAND_SIZE);
    expect([...command]).toEqual([0xff, 0x00, 0x40, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00]);
  });

  it("keeps the opcodes of the original C flasher", () => {
    expect(Opcode.ReadRom).toBe(0xff);
    expect(Opcode.WriteRom).toBe(0x57);
    expect(Opcode.ReadSram).toBe(0x6d);
    expect(Opcode.WriteSram).toBe(0x4d);
    expect(EMS_VENDOR_ID).toBe(0x4670);
    expect(EMS_PRODUCT_ID).toBe(0x9394);
  });

  it("appends the payload to the header in a single message", () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const message = encodeWrite("rom", 0x10, payload);

    expect(message).toHaveLength(COMMAND_SIZE + payload.length);
    expect(message[0]).toBe(Opcode.WriteRom);
    expect([...message.subarray(COMMAND_SIZE)]).toEqual([1, 2, 3, 4]);
  });

  it("uses the SRAM opcode for saves", () => {
    expect(encodeWrite("sram", 0, new Uint8Array([0]))[0]).toBe(Opcode.WriteSram);
  });
});

describe("memory map", () => {
  it("places ROM banks 4 MiB apart", () => {
    expect(bankBase("rom", 1)).toBe(0);
    expect(bankBase("rom", 2)).toBe(0x400000);
    expect(BANK_SIZE * BANK_COUNT).toBe(0x800000);
  });

  it("never moves the SRAM base, because both banks share the chip", () => {
    expect(bankBase("sram", 1)).toBe(0);
    expect(bankBase("sram", 2)).toBe(0);
  });

  it("reports the usable size of each space", () => {
    expect(spaceSize("rom")).toBe(BANK_SIZE);
    expect(spaceSize("sram")).toBe(SRAM_SIZE);
  });

  it("accepts only the two banks the cart has", () => {
    expect(isBankNumber(1)).toBe(true);
    expect(isBankNumber(2)).toBe(true);
    expect(isBankNumber(0)).toBe(false);
    expect(isBankNumber(3)).toBe(false);
  });
});

describe("space detection", () => {
  it.each([
    ["game.gb", "rom"],
    ["game.gbc", "rom"],
    ["POKEMON.SAV", "sram"],
    ["pokemon.sav", "sram"],
    ["no-extension", "rom"],
  ])("maps %s to %s", (fileName, expected) => {
    expect(detectSpace(fileName)).toBe(expected);
  });
});
