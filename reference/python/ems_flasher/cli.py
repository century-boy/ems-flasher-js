"""Command line interface for the EMS flasher.

Handles argument parsing, the ROM/SRAM size limits and the three
operating modes: dumping the cart to a file, writing a file to the cart
and printing the header of both banks.
"""

from __future__ import annotations

import argparse
import os
import sys
from typing import BinaryIO, NoReturn

from . import VERSION
from .ems import (
    BANK_SIZE,
    DEFAULT_TIMEOUT_MS,
    FROM_ROM,
    FROM_SRAM,
    NUM_BANKS,
    SPACE_NAMES,
    SRAM_SIZE,
    TO_ROM,
    EmsDevice,
    EmsError,
    bank_base,
    space_size,
)
from .progress import Progress, format_size

PROG = "ems-flasher"

# default blocksizes: reads are fast, writes program the flash a block at a time
BLOCKSIZE_READ = 4096
BLOCKSIZE_WRITE = 32

# offsets to parts of the cart header (see https://gbdev.io/pandocs/)
HEADER_LOGO = 0x104
HEADER_TITLE = 0x134
HEADER_CGBFLAG = 0x143
HEADER_SGBFLAG = 0x146
HEADER_ROMSIZE = 0x148
HEADER_RAMSIZE = 0x149
HEADER_REGION = 0x14A
HEADER_OLDLICENSEE = 0x14B
HEADER_ROMVER = 0x14C
HEADER_CHKSUM = 0x14D

HEADER_LEN = 512

#: RAM size codes from the cart header
RAM_SIZES = {0x00: "none", 0x01: "2 KB", 0x02: "8 KB", 0x03: "32 KB", 0x04: "128 KB", 0x05: "64 KB"}

DESCRIPTION = """\
Read and write the EMS 64 Mbit USB flash cart for Game Boy.

The cart holds 64 Mbit of flash ROM, split into two independent 32 Mbit
(4 MiB) banks, plus 128 KiB of SRAM for saves. Only one ROM bank is visible
to the Game Boy at a time; you switch bank by power cycling the console
quickly. The SRAM chip is shared by both banks, so --bank does not apply to
save files.
"""

EPILOG = """\
address spaces:
  ROM     4 MiB per bank, selected with --bank (default: bank 1)
  SRAM    128 KiB, shared by both banks, used for .sav files

  The space is picked from the file name (.sav means SRAM, anything else
  means ROM) unless you force it with --rom or --save.

examples:
  ems-flasher --write --bank 1 tetris.gb      write a ROM to bank 1
  ems-flasher --write --bank 2 zelda.gbc      write a ROM to bank 2
  ems-flasher --read --bank 2 backup.gb       dump bank 2 to a file
  ems-flasher --read --size 32k pokemon.sav   dump the first 32 KB of SRAM
  ems-flasher --write pokemon.sav             restore a save into SRAM
  ems-flasher --title                         show the header of both banks

environment:
  EMS_DEBUG=1     dump every protocol command to stderr

Written by Mike Ryan <mikeryan@lacklustre.net> and others.
See the web site for more info: http://lacklustre.net/gb/ems/
"""


class Options:
    """Resolved command line options."""

    def __init__(self) -> None:
        self.verbose: bool = False
        self.blocksize: int = 0
        self.mode: str = ""
        self.file: str | None = None
        self.bank: int = 0  # zero based
        self.space: int = 0  # FROM_ROM / FROM_SRAM, 0 = autodetect
        self.size: int | None = None
        self.truncate: bool = False
        self.progress: bool = True
        self.timeout_ms: int = DEFAULT_TIMEOUT_MS


def die(message: str) -> NoReturn:
    """Print an error to stderr and exit with status 1."""
    print(f"{PROG}: error: {message}", file=sys.stderr)
    raise SystemExit(1)


def parse_size(text: str) -> int:
    """Parse a byte count, accepting ``k``/``m`` suffixes and ``0x`` hex.

    >>> parse_size("32k"), parse_size("0x8000"), parse_size("4M")
    (32768, 32768, 4194304)
    """
    value = text.strip().lower().rstrip("ib")
    multiplier = 1
    if value.endswith("k"):
        multiplier, value = 1024, value[:-1]
    elif value.endswith("m"):
        multiplier, value = 1024 * 1024, value[:-1]

    try:
        number = int(value, 0)
    except ValueError:
        raise argparse.ArgumentTypeError(f"invalid size: {text!r}") from None

    if number <= 0:
        raise argparse.ArgumentTypeError(f"size must be > 0, got {text!r}")

    return number * multiplier


def positive_int(text: str) -> int:
    """Parse a strictly positive integer, for --blocksize."""
    try:
        value = int(text, 0)
    except ValueError:
        raise argparse.ArgumentTypeError(f"invalid number: {text!r}") from None
    if value <= 0:
        raise argparse.ArgumentTypeError(f"must be > 0, got {text!r}")
    return value


def build_parser() -> argparse.ArgumentParser:
    """Build the argument parser, including the long help text."""
    parser = argparse.ArgumentParser(
        prog=PROG,
        description=DESCRIPTION,
        epilog=EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    mode = parser.add_argument_group("operating mode (pick exactly one)")
    modes = mode.add_mutually_exclusive_group()
    modes.add_argument(
        "-r", "--read", action="store_const", const="read", dest="mode",
        help="dump the cart into FILE",
    )
    modes.add_argument(
        "-w", "--write", action="store_const", const="write", dest="mode",
        help="write FILE to the cart",
    )
    modes.add_argument(
        "-t", "--title", action="store_const", const="title", dest="mode",
        help="print the ROM header of both banks and exit",
    )

    target = parser.add_argument_group("target selection")
    target.add_argument(
        "-b", "--bank", type=int, choices=range(1, NUM_BANKS + 1), default=1,
        metavar="{1,2}",
        help="ROM bank to use (default: 1); ignored for SRAM, which is shared",
    )
    space = target.add_mutually_exclusive_group()
    space.add_argument(
        "-R", "--rom", action="store_const", const=FROM_ROM, dest="space",
        help="force the flash ROM, whatever the file name says",
    )
    space.add_argument(
        "-S", "--save", action="store_const", const=FROM_SRAM, dest="space",
        help="force the SRAM, whatever the file name says",
    )

    advanced = parser.add_argument_group("advanced options")
    advanced.add_argument(
        "-s", "--blocksize", type=positive_int, metavar="BYTES",
        help=f"bytes per USB transfer (default: {BLOCKSIZE_READ} read, "
             f"{BLOCKSIZE_WRITE} write)",
    )
    advanced.add_argument(
        "-n", "--size", type=parse_size, metavar="BYTES",
        help="how much to read; accepts 0x8000, 32k, 4M (default: the whole "
             "address space). Ignored when writing",
    )
    advanced.add_argument(
        "--timeout", type=float, default=DEFAULT_TIMEOUT_MS / 1000, metavar="SECONDS",
        help=f"per-transfer USB timeout (default: {DEFAULT_TIMEOUT_MS / 1000:g}s, "
             "0 waits forever)",
    )
    advanced.add_argument(
        "--truncate", action="store_true",
        help="when writing, allow a file larger than the target space to be "
             "cut short instead of failing",
    )

    output = parser.add_argument_group("output")
    output.add_argument(
        "-v", "--verbose", action="store_true", help="print more information",
    )
    output.add_argument(
        "--no-progress", action="store_false", dest="progress",
        help="hide the progress bar (it is hidden automatically when stderr "
             "is not a terminal)",
    )
    output.add_argument(
        "-V", "--version", action="version", version=f"EMS-flasher {VERSION}",
    )

    parser.add_argument(
        "file", nargs="?", metavar="FILE",
        help="ROM (.gb/.gbc) or save (.sav) file to read into or write from",
    )

    return parser


def get_options(argv: list[str]) -> Options:
    """Parse ``argv`` into an :class:`Options`, validating the combination."""
    parser = build_parser()
    ns = parser.parse_args(argv)

    if ns.mode is None:
        parser.error("you must supply exactly one of --read, --write or --title")

    opts = Options()
    opts.mode = ns.mode
    opts.verbose = ns.verbose
    opts.progress = ns.progress
    opts.bank = ns.bank - 1
    opts.space = ns.space or 0
    opts.size = ns.size
    opts.truncate = ns.truncate

    if ns.timeout < 0:
        parser.error("--timeout must be >= 0")
    opts.timeout_ms = int(ns.timeout * 1000)

    if ns.mode == "title":
        if ns.file is not None:
            parser.error("--title takes no file argument")
        return opts

    if ns.file is None:
        kind = "output" if ns.mode == "read" else "input"
        parser.error(f"you must provide an {kind} file name")
    opts.file = ns.file

    opts.blocksize = ns.blocksize or (
        BLOCKSIZE_READ if ns.mode == "read" else BLOCKSIZE_WRITE
    )

    return opts


def detect_space(filename: str) -> int:
    """A file ending in ``.sav`` means SRAM, anything else means flash ROM."""
    return FROM_SRAM if filename.lower().endswith(".sav") else FROM_ROM


def resolve_space(opts: Options) -> int:
    """Return the address space to use, honouring --rom/--save."""
    if opts.space:
        return opts.space
    if opts.file is not None:
        return detect_space(opts.file)
    return FROM_ROM


def resolve_base(space: int, opts: Options) -> int:
    """Return the base address, warning when --bank cannot apply."""
    if space == FROM_SRAM and opts.bank != 0:
        print(
            f"{PROG}: warning: SRAM is shared by both banks, ignoring "
            f"--bank {opts.bank + 1}",
            file=sys.stderr,
        )
    return bank_base(space, opts.bank)


def describe_target(space: int, opts: Options) -> str:
    """Human readable description of what we are about to touch."""
    if space == FROM_SRAM:
        return "SRAM"
    return f"ROM bank {opts.bank + 1}"


# -- modes -----------------------------------------------------------


def do_read(dev: EmsDevice, opts: Options, space: int, base: int) -> None:
    """Dump the cart into ``opts.file``."""
    limit = space_size(space)
    total = min(opts.size, limit) if opts.size else limit
    if opts.size and opts.size > limit:
        print(
            f"{PROG}: warning: {describe_target(space, opts)} holds only "
            f"{format_size(limit)}, reading that much",
            file=sys.stderr,
        )

    blocksize = opts.blocksize
    offset = 0

    if opts.verbose:
        print(
            f"Saving {describe_target(space, opts)} "
            f"({format_size(total)} from 0x{base:X}) into {opts.file}"
        )

    try:
        save_file: BinaryIO = open(opts.file, "wb")
    except OSError as exc:
        die(f"can't open {opts.file} for writing: {exc.strerror}")

    label = f"Reading {describe_target(space, opts)}"
    try:
        with save_file, Progress(label, total, opts.progress) as bar:
            while offset < total:
                # the last block is short when the size is not a multiple
                count = min(blocksize, total - offset)
                try:
                    buf = dev.read(space, base + offset, count)
                except EmsError as exc:
                    bar.finish(success=False)
                    die(f"can't read {count} bytes at offset 0x{offset:X}: {exc}")

                try:
                    save_file.write(buf)
                except OSError as exc:
                    bar.finish(success=False)
                    die(
                        f"can't write {count} bytes into {opts.file} at offset "
                        f"0x{offset:X}: {exc.strerror}"
                    )

                offset += count
                bar.advance(count)
    except KeyboardInterrupt:
        die(f"interrupted after {format_size(offset)}, {opts.file} is incomplete")

    print(f"Wrote {format_size(offset)} into {opts.file}")


def do_write(dev: EmsDevice, opts: Options, space: int, base: int) -> None:
    """Write ``opts.file`` to the cart, checking it fits first."""
    limit = space_size(space)

    try:
        file_size = os.path.getsize(opts.file)
    except OSError as exc:
        die(f"can't open {SPACE_NAMES[space]} file {opts.file}: {exc.strerror}")

    if file_size == 0:
        die(f"{opts.file} is empty, nothing to write")

    if file_size > limit:
        if not opts.truncate:
            die(
                f"{opts.file} is {format_size(file_size)} but "
                f"{describe_target(space, opts)} holds only {format_size(limit)}. "
                f"Use --truncate to write the first {format_size(limit)} anyway"
            )
        print(
            f"{PROG}: warning: truncating {opts.file} from "
            f"{format_size(file_size)} to {format_size(limit)}",
            file=sys.stderr,
        )

    total = min(file_size, limit)
    blocksize = opts.blocksize
    offset = 0

    if opts.verbose:
        print(
            f"Writing {opts.file} ({format_size(total)}) to "
            f"{describe_target(space, opts)} at 0x{base:X}"
        )

    try:
        write_file: BinaryIO = open(opts.file, "rb")
    except OSError as exc:
        die(f"can't open {SPACE_NAMES[space]} file {opts.file}: {exc.strerror}")

    label = f"Writing {describe_target(space, opts)}"
    try:
        with write_file, Progress(label, total, opts.progress) as bar:
            while offset < total:
                # a trailing partial block is written as-is, not dropped
                buf = write_file.read(min(blocksize, total - offset))
                if not buf:
                    break

                try:
                    dev.write(space, base + offset, buf)
                except EmsError as exc:
                    bar.finish(success=False)
                    die(f"can't write {len(buf)} bytes at offset 0x{offset:X}: {exc}")

                offset += len(buf)
                bar.advance(len(buf))
    except KeyboardInterrupt:
        die(
            f"interrupted after {format_size(offset)}, "
            f"{describe_target(space, opts)} is in an inconsistent state"
        )

    print(f"Wrote {format_size(offset)} from {opts.file} to {describe_target(space, opts)}")


def rom_checksum_header(rom: bytes) -> int:
    """Compute the Game Boy header checksum over 0x134..0x14C."""
    checksum = 0
    for address in range(HEADER_TITLE, HEADER_CHKSUM):
        checksum = (checksum - rom[address] - 1) & 0xFF
    return checksum


def rom_title(header: bytes) -> str:
    """Extract the cart title, dropping padding and unprintable bytes.

    The title field is 16 bytes, but on CGB carts the last one holds the
    CGB flag instead, so it must not be shown as text. The rest is NUL
    padded.
    """
    raw = header[HEADER_TITLE : HEADER_TITLE + 16]
    if header[HEADER_CGBFLAG] in (0x80, 0xC0):
        raw = raw[:15]
    raw = raw.split(b"\0")[0]
    text = raw.decode("ascii", errors="replace").rstrip()
    return "".join(c if c.isprintable() else "." for c in text)


def hardware_support(header: bytes) -> str:
    """Describe DMG/CGB/SGB support from the header flags."""
    cgb = header[HEADER_CGBFLAG]
    sgb = header[HEADER_SGBFLAG] == 0x03

    if cgb == 0xC0:
        base = "CGB only"
    elif cgb & 0x80:
        base = "CGB enhanced, DMG compatible"
    else:
        base = "DMG"

    return f"{base}, SGB enhanced" if sgb else base


def rom_size(header: bytes) -> str:
    """Describe the ROM size code from the header."""
    code = header[HEADER_ROMSIZE]
    if code <= 8:
        return f"{32 << code} KB"
    return {0x52: "1152 KB", 0x53: "1280 KB", 0x54: "1536 KB"}.get(
        code, f"unknown (code 0x{code:02X})"
    )


def print_header(header: bytes, verbose: bool) -> None:
    """Print one bank's header, with the usual sanity warnings."""
    print(f"  Title:            {rom_title(header)}")
    print(f"  Hardware support: {hardware_support(header)}")

    if verbose:
        print(f"  ROM size:         {rom_size(header)}")
        ram_code = header[HEADER_RAMSIZE]
        print(
            f"  RAM size:         "
            f"{RAM_SIZES.get(ram_code, f'unknown (code 0x{ram_code:02X})')}"
        )
        print(f"  Version:          {header[HEADER_ROMVER]}")
        print(
            f"  Region:           "
            f"{'Japan' if header[HEADER_REGION] == 0 else 'non-Japan'}"
        )

    # verify the cartridge header checksum while we're at it
    calculated = rom_checksum_header(header)
    if calculated != header[HEADER_CHKSUM]:
        print(
            f"  Header checksum:  INVALID (found 0x{header[HEADER_CHKSUM]:02X}, "
            f"expected 0x{calculated:02X})"
        )
        print("                    This game will NOT boot on real hardware.")
    elif verbose:
        print("  Header checksum:  OK")

    if header[HEADER_SGBFLAG] == 0x03 and header[HEADER_OLDLICENSEE] != 0x33:
        print(
            "  Warning:          SGB functions are enabled but the Old Licensee "
            "field is not 33h,\n"
            "                    so SGB functions will not work on real hardware."
        )


def do_title(dev: EmsDevice, opts: Options) -> None:
    """Print the header of both ROM banks."""
    for bank in range(NUM_BANKS):
        offset = bank * BANK_SIZE
        try:
            header = dev.read(FROM_ROM, offset, HEADER_LEN)
        except EmsError as exc:
            die(f"couldn't read the ROM header of bank {bank + 1}: {exc}")

        print(f"Bank {bank + 1}:")
        print_header(header, opts.verbose)


def main(argv: list[str] | None = None) -> int:
    """Entry point. Returns the process exit status."""
    opts = get_options(sys.argv[1:] if argv is None else argv)

    if opts.verbose:
        print("Looking for the EMS cart...")

    dev = EmsDevice(timeout_ms=opts.timeout_ms)
    try:
        dev.open()
    except EmsError as exc:
        print(f"{PROG}: error: {exc}", file=sys.stderr)
        return 1

    try:
        if opts.verbose:
            print("Claimed the EMS cart")

        if opts.mode == "title":
            do_title(dev, opts)
        else:
            space = resolve_space(opts)
            base = resolve_base(space, opts)
            if opts.mode == "read":
                do_read(dev, opts, space, base)
            else:
                do_write(dev, opts, space, base)
    finally:
        dev.close()

    return 0


if __name__ == "__main__":
    sys.exit(main())
