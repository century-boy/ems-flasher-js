/**
 * A stand-in for the cart firmware.
 *
 * It implements just enough of `USBDevice` for the core to talk to, and it
 * *decodes* the protocol rather than pattern-matching on it: commands are
 * parsed exactly as the hardware would, so the tests fail if the encoding
 * drifts by a single byte.
 */

import {
  BANK_COUNT,
  BANK_SIZE,
  COMMAND_SIZE,
  Opcode,
  SRAM_SIZE,
} from "../src/index.js";

/** One transfer as the fake firmware understood it. */
export interface RecordedCommand {
  opcode: number;
  address: number;
  length: number;
}

export class FakeUsbDevice implements Partial<USBDevice> {
  readonly rom = new Uint8Array(BANK_SIZE * BANK_COUNT);
  readonly sram = new Uint8Array(SRAM_SIZE);

  /** Every command the firmware received, in order. */
  readonly commands: RecordedCommand[] = [];

  opened = false;
  configuration: USBConfiguration | null = null;
  claimedInterface: number | undefined;

  /** Set to make the next transfer never settle, to exercise the timeout. */
  hang = false;

  /** The read the firmware is about to answer, queued by the read command. */
  #pendingRead: { data: Uint8Array } | undefined;

  async open(): Promise<void> {
    this.opened = true;
  }

  async close(): Promise<void> {
    this.opened = false;
  }

  async selectConfiguration(value: number): Promise<void> {
    this.configuration = { configurationValue: value } as USBConfiguration;
  }

  async claimInterface(interfaceNumber: number): Promise<void> {
    this.claimedInterface = interfaceNumber;
  }

  async releaseInterface(): Promise<void> {
    this.claimedInterface = undefined;
  }

  /** Receive a command (and, for writes, its payload). */
  async transferOut(_endpoint: number, data: BufferSource): Promise<USBOutTransferResult> {
    if (this.hang) {
      return new Promise<USBOutTransferResult>(() => {});
    }

    const bytes = toBytes(data);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    const opcode = view.getUint8(0);
    const address = view.getUint32(1, false);
    const length = view.getUint32(5, false);

    this.commands.push({ opcode, address, length });

    switch (opcode) {
      case Opcode.ReadRom:
        this.#pendingRead = { data: this.rom.slice(address, address + length) };
        break;

      case Opcode.ReadSram:
        this.#pendingRead = { data: this.sram.slice(address, address + length) };
        break;

      case Opcode.WriteRom:
        this.rom.set(bytes.subarray(COMMAND_SIZE, COMMAND_SIZE + length), address);
        break;

      case Opcode.WriteSram:
        this.sram.set(bytes.subarray(COMMAND_SIZE, COMMAND_SIZE + length), address);
        break;

      default:
        throw new Error(`unknown opcode 0x${opcode.toString(16)}`);
    }

    return { status: "ok", bytesWritten: bytes.length };
  }

  /** Answer the read queued by the last read command. */
  async transferIn(_endpoint: number, length: number): Promise<USBInTransferResult> {
    if (this.hang) {
      return new Promise<USBInTransferResult>(() => {});
    }

    if (!this.#pendingRead) {
      throw new Error("read without a preceding read command");
    }

    const { data } = this.#pendingRead;
    this.#pendingRead = undefined;

    return {
      status: "ok",
      data: new DataView(data.buffer, data.byteOffset, Math.min(length, data.length)),
    };
  }

  /** Fill the ROM with a recognisable pattern, for round-trip checks. */
  fillRomPattern(): void {
    for (let index = 0; index < this.rom.length; index++) {
      this.rom[index] = (index * 7) & 0xff;
    }
  }

  /** Write a plausible header at the start of a bank. */
  writeHeader(bank: 1 | 2, header: Uint8Array): void {
    this.rom.set(header, (bank - 1) * BANK_SIZE);
  }

  /** Cast to the interface the core expects. */
  asUsbDevice(): USBDevice {
    return this as unknown as USBDevice;
  }
}

function toBytes(data: BufferSource): Uint8Array {
  return data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
