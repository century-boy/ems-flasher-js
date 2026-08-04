/**
 * Finding the cart on the desktop.
 *
 * `node-usb` ships an implementation of the WebUSB API on top of libusb, so
 * the CLI hands the core exactly the same `USBDevice` the browser would.
 */

import { WebUSB } from "usb";

import { CartNotFoundError, EMS_USB_FILTER, EmsCart } from "@ems-flasher-js/core";
import type { CartOptions } from "@ems-flasher-js/core";

/** libusb's errno for "you do not have permission to open this device". */
const LIBUSB_ERROR_ACCESS = "LIBUSB_ERROR_ACCESS";

/**
 * Find the cart and claim it.
 *
 * @throws {CartNotFoundError} when no cart is plugged in, or the OS refuses
 *   to hand it over
 */
export async function openCart(options: CartOptions = {}): Promise<EmsCart> {
  // In Node there is no chooser dialog: requestDevice() returns the first
  // device matching the filter, so we must opt into seeing every device.
  const usb = new WebUSB({ allowAllDevices: true });

  let device;
  try {
    device = await usb.requestDevice({ filters: [{ ...EMS_USB_FILTER }] });
  } catch (cause) {
    throw new CartNotFoundError(
      "could not find the cart. Is it plugged in?",
      { cause },
    );
  }

  try {
    return await EmsCart.open(device, options);
  } catch (cause) {
    throw new CartNotFoundError(describeClaimFailure(cause), { cause });
  }
}

/** Turn a claim failure into advice the user can act on. */
function describeClaimFailure(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);

  if (message.includes(LIBUSB_ERROR_ACCESS) || message.includes("access denied")) {
    return (
      `${message}\n` +
      "Run as root, or install a udev rule for 4670:9394 (see --help)."
    );
  }

  return message;
}
