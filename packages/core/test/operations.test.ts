import { describe, expect, it } from "vitest";

import {
  BANK_SIZE,
  EmsCart,
  FileTooLargeError,
  Opcode,
  OutOfRangeError,
  SRAM_SIZE,
  readBankHeaders,
  readCart,
  writeCart,
  type TransferProgress,
} from "../src/index.js";

import { FakeUsbDevice } from "./fake-device.js";
import { makeHeader } from "./header.test.js";

/** Open a cart backed by the fake firmware. */
async function openFakeCart(): Promise<{ cart: EmsCart; device: FakeUsbDevice }> {
  const device = new FakeUsbDevice();
  const cart = await EmsCart.open(device.asUsbDevice());
  return { cart, device };
}

describe("reading", () => {
  it("dumps a whole ROM bank, block by block", async () => {
    const { cart, device } = await openFakeCart();
    device.fillRomPattern();

    const result = await readCart(cart, { bank: 1, blockSize: 4096 });

    expect(result.bytes).toBe(BANK_SIZE);
    expect(result.data).toEqual(device.rom.subarray(0, BANK_SIZE));
    expect(device.commands).toHaveLength(BANK_SIZE / 4096);
    expect(device.commands[0]).toEqual({ opcode: Opcode.ReadRom, address: 0, length: 4096 });
  });

  it("reads bank 2 from its own base address", async () => {
    const { cart, device } = await openFakeCart();
    device.fillRomPattern();

    const result = await readCart(cart, { bank: 2, blockSize: 4096, size: 8192 });

    expect(device.commands[0]?.address).toBe(BANK_SIZE);
    expect(result.data).toEqual(device.rom.subarray(BANK_SIZE, BANK_SIZE + 8192));
  });

  it("reads SRAM from address 0 whatever bank was asked for", async () => {
    const { cart, device } = await openFakeCart();

    await readCart(cart, { space: "sram", bank: 2, blockSize: 4096 });

    expect(device.commands[0]).toEqual({
      opcode: Opcode.ReadSram,
      address: 0,
      length: 4096,
    });
  });

  it("honours a partial size", async () => {
    const { cart } = await openFakeCart();

    const result = await readCart(cart, { space: "sram", size: 32 * 1024 });

    expect(result.bytes).toBe(32 * 1024);
  });

  it("clamps a size larger than the address space", async () => {
    const { cart } = await openFakeCart();

    const result = await readCart(cart, { space: "sram", size: SRAM_SIZE * 4 });

    expect(result.bytes).toBe(SRAM_SIZE);
  });

  it("ends with a short block when the size is not a round multiple", async () => {
    const { cart, device } = await openFakeCart();

    await readCart(cart, { space: "sram", blockSize: 1000 });

    expect(device.commands.at(-1)?.length).toBe(SRAM_SIZE % 1000);
  });

  it("streams to onChunk instead of buffering when asked", async () => {
    const { cart } = await openFakeCart();
    const offsets: number[] = [];

    const result = await readCart(cart, {
      space: "sram",
      blockSize: 4096,
      onChunk: (_chunk, offset) => {
        offsets.push(offset);
      },
    });

    expect(result.data).toBeUndefined();
    expect(offsets[0]).toBe(0);
    expect(offsets.at(-1)).toBe(SRAM_SIZE - 4096);
  });

  it("reports progress that adds up", async () => {
    const { cart } = await openFakeCart();
    const updates: TransferProgress[] = [];

    await readCart(cart, {
      space: "sram",
      blockSize: 8192,
      onProgress: (progress) => updates.push(progress),
    });

    expect(updates.at(-1)?.done).toBe(SRAM_SIZE);
    expect(updates.at(-1)?.fraction).toBe(1);
    expect(updates.every((update) => update.done <= update.total)).toBe(true);
  });

  it("stops between blocks when the caller aborts", async () => {
    const { cart } = await openFakeCart();
    const controller = new AbortController();

    const promise = readCart(cart, {
      space: "sram",
      blockSize: 4096,
      signal: controller.signal,
      onProgress: (progress) => {
        if (progress.done >= 8192) {
          controller.abort();
        }
      },
    });

    await expect(promise).rejects.toThrow(/aborted/);
  });
});

describe("writing", () => {
  it("writes a ROM to bank 1 and reads back identical bytes", async () => {
    const { cart, device } = await openFakeCart();
    const rom = Uint8Array.from({ length: 32 * 100 }, (_value, index) => (index * 7) & 0xff);

    const result = await writeCart(cart, rom, { bank: 1, blockSize: 32 });

    expect(result.bytes).toBe(rom.length);
    expect(device.rom.subarray(0, rom.length)).toEqual(rom);

    const readBack = await readCart(cart, { bank: 1, size: rom.length, blockSize: 4096 });
    expect(readBack.data).toEqual(rom);
  });

  it("writes to bank 2 without touching bank 1", async () => {
    const { cart, device } = await openFakeCart();
    const rom = new Uint8Array(4096).fill(0xaa);

    await writeCart(cart, rom, { bank: 2, blockSize: 1024 });

    expect(device.commands[0]?.address).toBe(BANK_SIZE);
    expect(device.rom.subarray(BANK_SIZE, BANK_SIZE + rom.length)).toEqual(rom);
    expect(device.rom.subarray(0, BANK_SIZE).every((byte) => byte === 0)).toBe(true);
  });

  it("writes the trailing partial block instead of dropping it", async () => {
    const { cart, device } = await openFakeCart();
    // 100 bytes with a 32 byte block size: the C flasher lost the last 4
    const rom = Uint8Array.from({ length: 100 }, (_value, index) => index);

    await writeCart(cart, rom, { blockSize: 32 });

    expect(device.commands.at(-1)).toEqual({
      opcode: Opcode.WriteRom,
      address: 96,
      length: 4,
    });
    expect(device.rom.subarray(0, 100)).toEqual(rom);
  });

  it("refuses a file that does not fit, before touching the cart", async () => {
    const { cart, device } = await openFakeCart();
    const tooBig = new Uint8Array(SRAM_SIZE + 1);

    await expect(writeCart(cart, tooBig, { space: "sram" })).rejects.toBeInstanceOf(
      FileTooLargeError,
    );
    expect(device.commands).toHaveLength(0);
  });

  it("cuts an oversized file short when truncation is allowed", async () => {
    const { cart } = await openFakeCart();
    const tooBig = new Uint8Array(SRAM_SIZE + 5000).fill(0xab);

    const result = await writeCart(cart, tooBig, {
      space: "sram",
      blockSize: 4096,
      truncate: true,
    });

    expect(result.bytes).toBe(SRAM_SIZE);
  });

  it("rejects an empty payload", async () => {
    const { cart } = await openFakeCart();

    await expect(writeCart(cart, new Uint8Array(0))).rejects.toBeInstanceOf(
      FileTooLargeError,
    );
  });

  it("uses the SRAM opcode for saves", async () => {
    const { cart, device } = await openFakeCart();

    await writeCart(cart, new Uint8Array(64).fill(1), { space: "sram", blockSize: 32 });

    expect(device.commands.every((command) => command.opcode === Opcode.WriteSram)).toBe(true);
  });
});

describe("bounds checking", () => {
  it("rejects an address past the end of the cart", async () => {
    const { cart } = await openFakeCart();

    await expect(cart.read("rom", BANK_SIZE * 2, 1)).rejects.toBeInstanceOf(OutOfRangeError);
    await expect(cart.read("sram", SRAM_SIZE, 1)).rejects.toBeInstanceOf(OutOfRangeError);
  });

  it("rejects a transfer that straddles the end", async () => {
    const { cart } = await openFakeCart();

    await expect(cart.read("sram", SRAM_SIZE - 1, 2)).rejects.toBeInstanceOf(OutOfRangeError);
  });

  it("rejects nonsensical lengths", async () => {
    const { cart } = await openFakeCart();

    await expect(cart.read("rom", 0, 0)).rejects.toBeInstanceOf(OutOfRangeError);
    await expect(cart.read("rom", -1, 16)).rejects.toBeInstanceOf(OutOfRangeError);
  });
});

describe("timeouts", () => {
  it("gives up instead of hanging forever on a wedged cart", async () => {
    const device = new FakeUsbDevice();
    const cart = await EmsCart.open(device.asUsbDevice(), { timeoutMs: 20 });
    device.hang = true;

    await expect(cart.read("rom", 0, 512)).rejects.toThrow(/timed out/);
  });
});

describe("headers", () => {
  it("reads the header of both banks", async () => {
    const { cart, device } = await openFakeCart();
    device.writeHeader(1, makeHeader({ title: "BANK ONE", cgb: 0x80 }));
    device.writeHeader(2, makeHeader({ title: "BANK TWO" }));

    const headers = await readBankHeaders(cart);

    expect(headers.map((entry) => entry.bank)).toEqual([1, 2]);
    expect(headers[0]?.header.title).toBe("BANK ONE");
    expect(headers[1]?.header.title).toBe("BANK TWO");
    expect(device.commands.map((command) => command.address)).toEqual([0, BANK_SIZE]);
  });
});
