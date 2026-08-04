"""USB transport for the EMS 64 Mbit USB flash cart.

The cart speaks a tiny bulk-only protocol: every operation is a 9 byte
command (1 byte opcode, 4 byte big endian address, 4 byte big endian
length) sent to the OUT endpoint. Reads are followed by the payload
arriving on the IN endpoint; writes carry the payload in the same
transfer as the command.

Hardware layout
---------------
* Flash ROM: 64 Mbit total, split into two 32 Mbit (4 MiB) banks. Only one
  bank is visible to the Game Boy at a time; you switch by power cycling
  the console quickly. Bank 2 starts at absolute address 0x400000.
* SRAM: a single 128 KiB chip, **shared by both banks**. There is no
  per-bank save area, so SRAM addresses always start at 0.

Every address handed to :meth:`EmsDevice.read` / :meth:`EmsDevice.write` is
absolute; use :func:`bank_base` to turn a bank number into a base address.
"""

from __future__ import annotations

import os
import struct
import sys

import usb.core
import usb.util

# magic numbers!
EMS_VID = 0x4670
EMS_PID = 0x9394

EMS_EP_SEND = 0x02 | usb.util.ENDPOINT_OUT
EMS_EP_RECV = 0x01 | usb.util.ENDPOINT_IN

# protocol opcodes
CMD_READ = 0xFF
CMD_WRITE = 0x57
CMD_READ_SRAM = 0x6D
CMD_WRITE_SRAM = 0x4D

#: address space selectors
FROM_ROM = 1
FROM_SRAM = 2
TO_ROM = FROM_ROM
TO_SRAM = FROM_SRAM

SPACE_NAMES = {FROM_ROM: "ROM", FROM_SRAM: "SRAM"}

#: one bank is 32 megabits
BANK_SIZE = 0x400000
#: the whole cart holds two banks (64 megabits)
NUM_BANKS = 2
#: 128 KiB of SRAM, shared between both banks
SRAM_SIZE = 0x020000

#: usable size of each address space
SPACE_SIZE = {FROM_ROM: BANK_SIZE, FROM_SRAM: SRAM_SIZE}

# libusb treats a timeout of 0 as "wait forever". The C flasher always did
# that, which hangs forever when the cart is wedged; we default to a
# generous per-transfer timeout instead (erasing and programming a flash
# block takes milliseconds, not seconds).
DEFAULT_TIMEOUT_MS = 10_000

# commands are a 1 byte opcode followed by a 4 byte address and a 4 byte
# length, both big endian
_COMMAND = struct.Struct(">BII")
COMMAND_SIZE = _COMMAND.size  # 9

#: set EMS_DEBUG=1 to dump every command buffer sent to the cart
DEBUG = bool(os.environ.get("EMS_DEBUG"))


class EmsError(Exception):
    """Something went wrong finding, claiming or talking to the cart."""


def bank_base(space: int, bank: int) -> int:
    """Return the absolute base address of ``bank`` within ``space``.

    ``bank`` is zero based. ROM banks are 4 MiB apart; SRAM is shared
    between banks, so its base is always 0.
    """
    if space == FROM_SRAM:
        return 0
    return bank * BANK_SIZE


def space_size(space: int) -> int:
    """Return the usable size in bytes of ``space``."""
    return SPACE_SIZE[space]


def _command(cmd: int, addr: int, val: int) -> bytes:
    return _COMMAND.pack(cmd, addr, val)


class EmsDevice:
    """An open, claimed EMS cart.

    Use it as a context manager so the USB interface is always released::

        with EmsDevice() as cart:
            header = cart.read(FROM_ROM, 0, 512)

    All transfers are bounds checked against the size of the target
    address space, so a bad offset raises :class:`EmsError` instead of
    reaching the hardware.

    Args:
        timeout_ms: per-transfer timeout in milliseconds; 0 waits forever.
            A wedged cart (unplug it and plug it back in) otherwise hangs
            the process with no way out but a signal.
    """

    def __init__(self, timeout_ms: int = DEFAULT_TIMEOUT_MS) -> None:
        self._dev: usb.core.Device | None = None
        self._claimed = False
        self.timeout_ms = timeout_ms

    # -- lifecycle ---------------------------------------------------

    def open(self) -> None:
        """Find the cart by VID/PID and claim its interface.

        Raises:
            EmsError: no libusb backend, no cart plugged in, or the
                interface could not be claimed (typically a permission
                problem on Linux).
        """
        try:
            dev = usb.core.find(idVendor=EMS_VID, idProduct=EMS_PID)
        except usb.core.NoBackendError as exc:
            raise EmsError(
                "No libusb backend found. Install libusb-1.0 "
                "(brew install libusb / apt install libusb-1.0-0)."
            ) from exc
        except usb.core.USBError as exc:
            raise EmsError(f"Failed to get device list: {exc}") from exc

        if dev is None:
            raise EmsError("Could not find device, is it plugged in?")

        try:
            usb.util.claim_interface(dev, 0)
        except usb.core.USBError as exc:
            msg = f"Failed to claim USB interface: {exc.strerror or exc}"
            if sys.platform.startswith("linux") and exc.errno == 13:  # EACCES
                msg += (
                    "\nTry running as root/sudo or install a udev rule for "
                    f"{EMS_VID:04x}:{EMS_PID:04x} (check the FAQ for more info)."
                )
            raise EmsError(msg) from exc

        self._dev = dev
        self._claimed = True

    def close(self) -> None:
        """Release the interface and free the USB resources."""
        if self._dev is not None:
            if self._claimed:
                usb.util.release_interface(self._dev, 0)
                self._claimed = False
            usb.util.dispose_resources(self._dev)
            self._dev = None

    def __enter__(self) -> EmsDevice:
        self.open()
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    @property
    def _device(self) -> usb.core.Device:
        if self._dev is None:
            raise EmsError("device is not open")
        return self._dev

    # -- transfers ---------------------------------------------------

    def _check_range(self, space: int, offset: int, count: int) -> None:
        if space not in SPACE_SIZE:
            raise EmsError(f"unknown address space {space}")
        if count <= 0:
            raise EmsError(f"transfer size must be > 0, got {count}")
        if offset < 0:
            raise EmsError(f"offset must be >= 0, got {offset}")

        # ROM offsets are absolute across both banks, SRAM is one flat space
        limit = NUM_BANKS * BANK_SIZE if space == FROM_ROM else SRAM_SIZE
        if offset + count > limit:
            raise EmsError(
                f"{SPACE_NAMES[space]} transfer out of range: "
                f"0x{offset:X}+{count} exceeds 0x{limit:X}"
            )

    def _timeout_hint(self, what: str, exc: Exception) -> str:
        return (
            f"USB {what} timed out after {self.timeout_ms} ms ({exc}).\n"
            "The cart is not answering: unplug it, plug it back in and retry. "
            "Use --timeout 0 to wait forever instead."
        )

    def read(self, space: int, offset: int, count: int) -> bytes:
        """Read ``count`` bytes from absolute address ``offset``.

        Args:
            space: :data:`FROM_ROM` or :data:`FROM_SRAM`.
            offset: absolute address on the cart.
            count: number of bytes to read.

        Returns:
            The bytes read (always ``count`` bytes on success).

        Raises:
            EmsError: the range is invalid or the transfer failed.
        """
        self._check_range(space, offset, count)

        cmd = CMD_READ if space == FROM_ROM else CMD_READ_SRAM
        cmd_buf = _command(cmd, offset, count)

        if DEBUG:
            print(" ".join(f"{b:02x}" for b in cmd_buf), file=sys.stderr)

        dev = self._device
        try:
            dev.write(EMS_EP_SEND, cmd_buf, self.timeout_ms)
            buf = dev.read(EMS_EP_RECV, count, self.timeout_ms)
        except usb.core.USBTimeoutError as exc:
            raise EmsError(self._timeout_hint("read", exc)) from exc
        except usb.core.USBError as exc:
            raise EmsError(str(exc)) from exc

        if len(buf) != count:
            raise EmsError(f"short read: expected {count} bytes, got {len(buf)}")

        return bytes(buf)

    def write(self, space: int, offset: int, data: bytes) -> int:
        """Write ``data`` to absolute address ``offset``.

        Args:
            space: :data:`TO_ROM` or :data:`TO_SRAM`.
            offset: absolute address on the cart.
            data: payload to write.

        Returns:
            The number of payload bytes written.

        Raises:
            EmsError: the range is invalid or the transfer failed.
        """
        self._check_range(space, offset, len(data))

        cmd = CMD_WRITE if space == TO_ROM else CMD_WRITE_SRAM
        # command and payload go out in a single bulk transfer
        write_buf = _command(cmd, offset, len(data)) + bytes(data)

        if DEBUG:
            print(
                " ".join(f"{b:02x}" for b in write_buf[:COMMAND_SIZE]),
                file=sys.stderr,
            )

        try:
            transferred = self._device.write(EMS_EP_SEND, write_buf, self.timeout_ms)
        except usb.core.USBTimeoutError as exc:
            raise EmsError(self._timeout_hint("write", exc)) from exc
        except usb.core.USBError as exc:
            raise EmsError(str(exc)) from exc

        written = transferred - COMMAND_SIZE
        if written != len(data):
            raise EmsError(f"short write: expected {len(data)} bytes, sent {written}")

        return written
