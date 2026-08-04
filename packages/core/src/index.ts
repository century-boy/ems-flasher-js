/**
 * `@ems-flasher-js/core` — everything needed to talk to a _GB USB smart card
 * 64M_, with no assumptions about where it runs.
 *
 * A TypeScript port of the C ems-flasher by Mike Ryan
 * (http://lacklustre.net/gb/ems/); the protocol it speaks was reverse
 * engineered by him, David Wendt JR. and Jamie Bainbridge. MIT licensed,
 * Copyright (c) 2011 Mike Ryan.
 *
 * The only thing this package needs from its host is a WebUSB `USBDevice`:
 * the browser hands you one from `navigator.usb.requestDevice()`, and Node
 * gets one from `usb.webusb`. That is why the CLI and the web app share all
 * of the code below.
 *
 * ```ts
 * const device = await navigator.usb.requestDevice({ filters: [EMS_USB_FILTER] });
 * const cart = await EmsCart.open(device);
 *
 * const headers = await readBankHeaders(cart);
 * await writeCart(cart, rom, { bank: 1, onProgress: (p) => draw(p) });
 *
 * await cart.close();
 * ```
 */

export { EmsCart, type CartOptions } from "./cart.js";

export { allocate, type Bytes } from "./bytes.js";

export {
  AbortedError,
  CartNotFoundError,
  CartTimeoutError,
  EmsError,
  FileTooLargeError,
  OutOfRangeError,
} from "./errors.js";

export {
  BANK_COUNT,
  BANK_SIZE,
  SPACE_LABEL,
  SPACE_LIMIT,
  SPACE_SIZE,
  SRAM_SIZE,
  bankBase,
  describeTarget,
  detectSpace,
  isBankNumber,
  spaceSize,
  type AddressSpace,
  type BankNumber,
} from "./geometry.js";

export {
  HEADER_READ_SIZE,
  HeaderOffset,
  computeHeaderChecksum,
  parseHeader,
  readHardwareSupport,
  readRamSize,
  readRomSize,
  readTitle,
  type CartHeader,
} from "./header.js";

export {
  DEFAULT_BLOCK_SIZE,
  readBankHeaders,
  readCart,
  writeCart,
  type BankHeader,
  type ReadOptions,
  type TransferProgress,
  type TransferResult,
  type WriteOptions,
} from "./operations.js";

export {
  NINTENDO_LOGO,
  NoSpaceError,
  SLOTS_PER_BANK,
  SLOT_SIZE,
  UnsupportedRomError,
  findSlot,
  isValidRomSize,
  planAdd,
  removeRom,
  scanBank,
  type BankUsage,
  type RomEntry,
} from "./multirom.js";

export { formatBytes, formatDuration, formatRate, parseSize } from "./format.js";

export {
  COMMAND_SIZE,
  EMS_PRODUCT_ID,
  EMS_VENDOR_ID,
  Opcode,
  encodeCommand,
  encodeWrite,
} from "./protocol.js";

import { EMS_PRODUCT_ID, EMS_VENDOR_ID } from "./protocol.js";

/** Ready-made filter for `navigator.usb.requestDevice()`. */
export const EMS_USB_FILTER = {
  vendorId: EMS_VENDOR_ID,
  productId: EMS_PRODUCT_ID,
} as const;
