/**
 * Talking to the cart over USB.
 *
 * {@link EmsCart} is written against the WebUSB `USBDevice` interface, which
 * the browser provides natively and which `node-usb` implements on the
 * desktop. That is what lets the CLI and the web app share every line of
 * protocol code below.
 */

import type { Bytes } from "./bytes.js";
import { viewOf } from "./bytes.js";
import {
  AbortedError,
  CartTimeoutError,
  EmsError,
  OutOfRangeError,
} from "./errors.js";
import type { AddressSpace } from "./geometry.js";
import { SPACE_LABEL, SPACE_LIMIT } from "./geometry.js";
import {
  COMMAND_SIZE,
  EMS_CONFIGURATION,
  EMS_INTERFACE,
  ENDPOINT_IN,
  ENDPOINT_OUT,
  encodeCommand,
  encodeWrite,
  readOpcode,
  toHex,
} from "./protocol.js";

/** Options accepted by {@link EmsCart.open}. */
export interface CartOptions {
  /**
   * Per-transfer timeout in milliseconds. `0` waits forever.
   *
   * WebUSB has no timeout of its own, so we race every transfer against a
   * timer: a wedged cart otherwise hangs the caller with no way out.
   */
  timeoutMs?: number;

  /** Called with every command header sent, for debugging. */
  onDebug?: (line: string) => void;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * An open, claimed cart.
 *
 * Obtain one with {@link EmsCart.open}, and always {@link close} it when you
 * are done so the interface is released back to the system.
 */
export class EmsCart {
  readonly #device: USBDevice;
  readonly #timeoutMs: number;
  readonly #onDebug: ((line: string) => void) | undefined;

  private constructor(device: USBDevice, options: CartOptions) {
    this.#device = device;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#onDebug = options.onDebug;
  }

  /**
   * Open a device previously obtained from `navigator.usb` (browser) or
   * `usb.webusb` (Node), select its configuration and claim its interface.
   */
  static async open(device: USBDevice, options: CartOptions = {}): Promise<EmsCart> {
    const cart = new EmsCart(device, options);
    await cart.#claim();
    return cart;
  }

  async #claim(): Promise<void> {
    try {
      if (!this.#device.opened) {
        await this.#device.open();
      }

      // A freshly plugged cart may have no configuration selected yet.
      if (this.#device.configuration === null) {
        await this.#device.selectConfiguration(EMS_CONFIGURATION);
      }

      await this.#device.claimInterface(EMS_INTERFACE);
    } catch (cause) {
      throw new EmsError(
        `could not claim the cart: ${describeCause(cause)}`,
        { cause },
      );
    }
  }

  /** Release the interface and close the device. Safe to call twice. */
  async close(): Promise<void> {
    try {
      await this.#device.releaseInterface(EMS_INTERFACE);
    } catch {
      // The device may already be gone (unplugged); nothing left to release.
    }

    try {
      await this.#device.close();
    } catch {
      // Same here: closing a vanished device is not an error worth raising.
    }
  }

  /**
   * Read `length` bytes from an absolute address.
   *
   * @throws {OutOfRangeError} if the range falls outside the address space
   * @throws {CartTimeoutError} if the cart does not answer in time
   */
  async read(space: AddressSpace, address: number, length: number): Promise<Bytes> {
    assertRange(space, address, length);

    const command = encodeCommand(readOpcode(space), address, length);
    this.#onDebug?.(toHex(command));

    await this.#transferOut(command, "read command");

    const result = await this.#withTimeout(
      this.#device.transferIn(ENDPOINT_IN, length),
      "read",
    );

    if (result.status !== "ok" || result.data === undefined) {
      throw new EmsError(`read failed at 0x${address.toString(16)}: ${result.status}`);
    }

    const data = viewOf(result.data);

    if (data.length !== length) {
      throw new EmsError(`short read: expected ${length} bytes, got ${data.length}`);
    }

    return data;
  }

  /**
   * Write a payload to an absolute address.
   *
   * @returns the number of payload bytes written
   * @throws {OutOfRangeError} if the range falls outside the address space
   * @throws {CartTimeoutError} if the cart does not answer in time
   */
  async write(space: AddressSpace, address: number, payload: Uint8Array): Promise<number> {
    assertRange(space, address, payload.length);

    const message = encodeWrite(space, address, payload);
    this.#onDebug?.(toHex(message.subarray(0, COMMAND_SIZE)));

    const written = await this.#transferOut(message, "write");

    // The count reported by USB includes the 9 byte command header.
    return Math.max(written - COMMAND_SIZE, 0);
  }

  async #transferOut(data: Bytes, operation: string): Promise<number> {
    const result = await this.#withTimeout(
      this.#device.transferOut(ENDPOINT_OUT, data),
      operation,
    );

    if (result.status !== "ok") {
      throw new EmsError(`${operation} failed: ${result.status}`);
    }

    return result.bytesWritten;
  }

  /**
   * Race a USB transfer against the configured timeout.
   *
   * WebUSB transfers cannot be cancelled, so on timeout the pending promise is
   * simply abandoned — the caller is expected to replug the cart, which is the
   * only thing that actually recovers it.
   */
  async #withTimeout<T>(transfer: Promise<T>, operation: string): Promise<T> {
    if (this.#timeoutMs <= 0) {
      return transfer;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new CartTimeoutError(operation, this.#timeoutMs)),
        this.#timeoutMs,
      );
    });

    try {
      return await Promise.race([transfer, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Fail before a bad address reaches the hardware. */
function assertRange(space: AddressSpace, address: number, length: number): void {
  if (!Number.isInteger(address) || address < 0) {
    throw new OutOfRangeError(`address must be a non-negative integer, got ${address}`);
  }

  if (!Number.isInteger(length) || length <= 0) {
    throw new OutOfRangeError(`transfer size must be a positive integer, got ${length}`);
  }

  const limit = SPACE_LIMIT[space];
  if (address + length > limit) {
    throw new OutOfRangeError(
      `${SPACE_LABEL[space]} transfer out of range: 0x${address.toString(16)}+${length} ` +
        `exceeds 0x${limit.toString(16)}`,
    );
  }
}

/** Turn whatever USB layer threw at us into something printable. */
function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  return String(cause);
}

/** Throw {@link AbortedError} if the caller asked to stop. */
export function throwIfAborted(signal: AbortSignal | undefined, bytesDone: number): void {
  if (signal?.aborted) {
    throw new AbortedError(bytesDone);
  }
}
