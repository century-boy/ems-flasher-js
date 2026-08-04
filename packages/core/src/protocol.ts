/**
 * The wire protocol spoken by the EMS cart.
 *
 * None of this was discovered here. The cart is closed and undocumented, and
 * everything below — the opcodes, the endpoints, the command layout — comes
 * from the reverse engineering done by Mike Ryan, David Wendt JR. and Jamie
 * Bainbridge for the C flasher at http://lacklustre.net/gb/ems/. This file is
 * a TypeScript transcription of their work; see AUTHORS at the repository root.
 *
 * Every operation is a 9 byte command sent to the bulk OUT endpoint:
 *
 * ```text
 *  0        1                    5                    9
 *  +--------+--------------------+--------------------+
 *  | opcode | address (BE u32)   | length (BE u32)    |
 *  +--------+--------------------+--------------------+
 * ```
 *
 * A read command is answered with `length` bytes on the bulk IN endpoint.
 * A write command carries its payload straight after the header, in the very
 * same transfer.
 */

import type { Bytes } from "./bytes.js";
import { allocate } from "./bytes.js";
import type { AddressSpace } from "./geometry.js";

/** USB identity of the cart. */
export const EMS_VENDOR_ID = 0x4670;
export const EMS_PRODUCT_ID = 0x9394;

/** The cart exposes a single interface with two bulk endpoints. */
export const EMS_INTERFACE = 0;
export const EMS_CONFIGURATION = 1;

/** Endpoint numbers, without the direction bit that WebUSB does not want. */
export const ENDPOINT_OUT = 2;
export const ENDPOINT_IN = 1;

/** Length of a command header, in bytes. */
export const COMMAND_SIZE = 9;

/** Protocol opcodes, one pair per address space. */
export const Opcode = {
  ReadRom: 0xff,
  WriteRom: 0x57,
  ReadSram: 0x6d,
  WriteSram: 0x4d,
} as const;

export type Opcode = (typeof Opcode)[keyof typeof Opcode];

/** The opcode that reads from a given address space. */
export function readOpcode(space: AddressSpace): Opcode {
  return space === "rom" ? Opcode.ReadRom : Opcode.ReadSram;
}

/** The opcode that writes to a given address space. */
export function writeOpcode(space: AddressSpace): Opcode {
  return space === "rom" ? Opcode.WriteRom : Opcode.WriteSram;
}

/**
 * Build a command header.
 *
 * @param opcode  one of {@link Opcode}
 * @param address absolute address on the cart
 * @param length  number of payload bytes the command refers to
 */
export function encodeCommand(opcode: Opcode, address: number, length: number): Bytes {
  const command = allocate(COMMAND_SIZE);
  const view = new DataView(command.buffer);

  view.setUint8(0, opcode);
  view.setUint32(1, address, false); // big endian
  view.setUint32(5, length, false);

  return command;
}

/**
 * Build a write command with its payload appended, ready for a single
 * bulk transfer.
 */
export function encodeWrite(
  space: AddressSpace,
  address: number,
  payload: Uint8Array,
): Bytes {
  const message = allocate(COMMAND_SIZE + payload.length);

  message.set(encodeCommand(writeOpcode(space), address, payload.length), 0);
  message.set(payload, COMMAND_SIZE);

  return message;
}

/** Render bytes as hex, for the debug log. */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
}
