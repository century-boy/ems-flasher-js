# EMS Flasher JS

Read and write the _GB USB smart card 64M_ Game Boy flash cart, from the
command line or from a browser tab.

**[Open the web app](https://ems-flasher.netlify.app)** ·
[Install the CLI](#install) · [Multiple games on one bank](#multiple-games-on-one-bank)

[![npm](https://img.shields.io/npm/v/ems-flasher-js?color=8bac0f&label=npm)](https://www.npmjs.com/package/ems-flasher-js)
[![license](https://img.shields.io/badge/license-MIT-8bac0f)](COPYING)

A TypeScript port of [ems-flasher](http://lacklustre.net/gb/ems/), the C
flasher by Mike Ryan. The protocol, and the reverse engineering behind it, are
the work of Mike Ryan, David Wendt JR. and Jamie Bainbridge; this project
re-implements it and adds a browser front end. See [Credits](#credits).

## What you can do

| Task | Command |
| --- | --- |
| See every game on the cart | `ems-flasher --title` |
| Write a ROM to a bank | `ems-flasher --write --bank 1 game.gb` |
| Dump a bank to a file | `ems-flasher --read --bank 1 backup.gb` |
| Back up your save | `ems-flasher --read --size 32k game.sav` |
| Restore a save | `ems-flasher --write game.sav` |
| List games on a bank | `ems-flasher --list --bank 2` |
| Add a game to a bank | `ems-flasher --add --bank 2 tetris.gb` |
| Remove a game | `ems-flasher --delete 2 --bank 2` |
| Save one game as a ROM | `ems-flasher --extract 1 --bank 2 game.gb` |

All of it also works in the browser, without installing anything.

## Install

```sh
npm install -g ems-flasher-js
```

Needs Node 20+. Inside a clone of this repo, use `npm run ems-flasher -- …`
instead — note the `--` before the flags.

**Linux**: add a udev rule, or run every command as root.

```sh
echo 'SUBSYSTEM=="usb", ATTR{idVendor}=="4670", ATTR{idProduct}=="9394", MODE="0666"' \
  | sudo tee /etc/udev/rules.d/60-ems-flasher.rules
sudo udevadm control --reload-rules && sudo udevadm trigger
```

**Windows**: the cart has no driver of its own, so install WinUSB for it with
[Zadig](https://zadig.akeo.ie/). **macOS** works as is.

## The cart, in one paragraph

64 Mbit of flash ROM as **two independent 4 MiB banks**. The console only sees
one bank at a time; you switch by power cycling it quickly (off and back on
within about a second). Saves live in **one 128 KiB SRAM chip shared by both
banks**, so `--bank` has no meaning for `.sav` files and is ignored, with a
warning.

Transfers run at roughly 42 KiB/s over USB 1.1: a full 4 MiB bank takes a
couple of minutes to read. That is the hardware.

## Writing a single game

```sh
ems-flasher --write lsdj.gb                # bank 1, the default
ems-flasher --write --bank 2 zelda.gbc     # bank 2
```

This replaces whatever was at the start of the bank. A file larger than 4 MiB
is refused before anything is written; pass `--truncate` to write as much as
fits anyway.

Whether a file goes to flash ROM or to save RAM is decided by its name: `.sav`
means SRAM, anything else means ROM. Override with `--rom` or `--save`.

## Saves

```sh
ems-flasher --read --size 32k pokemon.sav  # back up (most games use 8–32 KB)
ems-flasher --read pokemon.sav             # or the whole 128 KiB chip
ems-flasher --write pokemon.sav            # restore
```

Both banks share the save chip, so back up before switching game on a bank.

## Multiple games on one bank

The cart ships with a menu ROM (it reports itself as `GB16M`). It holds no
table of contents: at boot it walks the bank in 32 KiB steps and lists every
position holding a valid Game Boy header. Putting several games on a bank is
therefore just a matter of placing each ROM where the mapper can reach it.

```sh
ems-flasher --write --bank 2 menu.gb     # 1. put the menu at the start
ems-flasher --add --bank 2 tetris.gb     # 2. add games after it
ems-flasher --add --bank 2 lsdj.gb
ems-flasher --list --bank 2              # 3. see what the menu will show
ems-flasher --delete 1 --bank 2          # 4. drop one, freeing its space
ems-flasher --extract 2 --bank 2         # or pull one back out as a ROM file
```

`--extract` reads exactly the bytes that game occupies, so the dump is a
working ROM rather than a slice of the bank. Leave the file name out and it is
taken from the game's title (`TRIP WORLD` becomes `trip-world.gb`).

```
$ ems-flasher --list --bank 2
Bank 2:
   0  GB16M              32.0 KiB  @ 0x000000
   1  TETRIS             32.0 KiB  @ 0x008000
   2  LSDj-v9.4.2         1.0 MiB  @ 0x100000

3 ROM(s), 1.1 MiB used, 2.9 MiB free.
```

Rules worth knowing before you plan a bank:

- **A ROM must start at a multiple of its own size.** The mapper selects a game
  by masking address lines, so a 1 MiB ROM can only sit at 0, 1 MiB, 2 MiB or
  3 MiB. `--add` finds the first spot that works, reusing gaps left by
  `--delete` when a game is small enough to fit in one.
- **Sizes are powers of two**, 32 KiB to 4 MiB. ROMs declaring the odd
  1.1/1.2/1.5 MiB sizes cannot be laid out this way and are refused.
- **Free space is not always usable.** With 1 MiB free but only at a 1 MiB
  boundary, a 2 MiB game will not fit; `--add` says so instead of overwriting
  something.
- **`--delete` does not erase.** It blanks the game's header so the menu skips
  it, which is what frees the slot. The data stays until something is written
  over it.
- **`--write` is not `--add`.** `--write` puts a ROM at the start of the bank,
  which replaces the menu. Use `--add` once a menu is in place.

You need a menu ROM to start: either dump the one already on your cart
(`ems-flasher --read --bank 2 --size 32k menu.gb`) or get one from
[Stewmath/ems-flasher](https://github.com/Stewmath/ems-flasher), which ships
`menu.gb` and `menu.gbc`. This repo does not redistribute it.

## Web app

Same operations, nothing to install: plug in the cart, open
[the page](https://ems-flasher.netlify.app), hit **Connect cart**, drop a
ROM. The flasher runs in the tab over WebUSB, so files never leave your
machine — there is no backend.

Multi-game banks work there too. Connecting scans the selected bank and lists
what the cart menu will show; each row has **Save** to download that game as
its own ROM file and **Remove** to drop it. **Add to bank** places a loaded ROM
in the first free slot, leaving the others alone; **Replace bank** is the
destructive one — it writes at offset 0 and wipes the menu with everything
else.

Chromium browsers only: Chrome, Edge, Opera, and Chrome on Android with an OTG
cable. Firefox and Safari do not implement WebUSB.

## All options

```
-r, --read              dump the cart into FILE
-w, --write             write FILE to the cart, replacing the bank
-t, --title             list every game in both banks
-l, --list              list the games on a bank
-a, --add               add FILE to a bank, keeping what is there
-d, --delete N          remove game N (an index from --list)
-e, --extract N         save game N to FILE, or to a name from its title

-b, --bank {1,2}        which ROM bank to work on (default: 1)
-R, --rom               force flash ROM, whatever the file name says
-S, --save              force save RAM

-n, --size BYTES        how much to read: 0x8000, 32k, 4M
-s, --blocksize BYTES   bytes per USB transfer (default 4096 read, 32 write)
    --timeout SECONDS   per-transfer timeout (default 10, 0 waits forever)
    --truncate          allow an oversized file to be cut short

-v, --verbose           more detail
    --no-progress       hide the progress bar
-V, --version           print the version
-h, --help              this list, with examples
```

`EMS_DEBUG=1` dumps every protocol command to stderr.

## When something goes wrong

| Symptom | Fix |
| --- | --- |
| `could not find the cart` | Check it is plugged in, and that no other program or browser tab is holding it. |
| `Failed to claim USB interface` | Linux: udev rule or root. Windows: install WinUSB with Zadig. |
| `USB read timed out` | The cart stopped answering: unplug it, plug it back in, retry. |
| The game does not boot | Run `--title`: an invalid header checksum means it will not run on real hardware. |
| The menu shows nothing | The bank has no menu ROM at offset 0. Write one with `--write`. |
| `--add` says there is no room, but `--list` shows free space | The free space is not at a boundary the ROM can start on. Try a smaller game, or free an aligned slot. |
| The other bank does not appear | Power cycle the console faster — off and on within about a second. |

## How it works

[ARCHITECTURE.md](ARCHITECTURE.md) documents the cart in detail: the USB
descriptors, the protocol, the measured timings, the multi-game layout and its
alignment rule, plus what is still unknown. The short version:

The cart speaks a 9-byte command protocol: one opcode, a big-endian address, a
big-endian length. Reads get their payload on the IN endpoint; writes carry it
in the same transfer.

```
 0        1                    5                    9
 +--------+--------------------+--------------------+
 | opcode | address (BE u32)   | length (BE u32)    |
 +--------+--------------------+--------------------+
```

`@ems-flasher-js/core` implements that against the WebUSB interface, which
browsers provide natively and which [node-usb](https://github.com/node-usb/node-usb)
implements on the desktop. The CLI and the web app therefore run the same
protocol code.

```
packages/core   protocol, memory map, header decoding, multi-game layout
packages/cli    the ems-flasher command          (node-usb)
apps/web        the web app                      (navigator.usb)
```

Using the core in your own tool:

```ts
import { EmsCart, readCart, scanBank } from "@ems-flasher-js/core";

const cart = await EmsCart.open(device);       // a WebUSB USBDevice
const { roms } = await scanBank(cart, 2);      // what is on bank 2
const dump = await readCart(cart, { bank: 1, onProgress: draw });
await cart.close();
```

## Differences from the C flasher

Its own README warned that writing an oversized file would "continue writing
past the end of the cart and do unknown amounts of damage". This port:

- refuses a file larger than the target before writing anything, unless you
  pass `--truncate`;
- writes trailing partial blocks instead of dropping them;
- bounds-checks every transfer against the memory map;
- ignores `--bank` for the shared SRAM rather than writing to an address that
  does not exist;
- times out instead of hanging forever on a cart that stopped answering;
- reports progress, throughput and ETA.

## Development

```sh
npm install
npm test           # 150 tests, no hardware needed
npm run build      # typecheck and compile core + CLI
npm run dev:web    # web app on localhost
```

Tests drive the flasher against a fake firmware that decodes the protocol the
way the cart does, so a wrong byte in a command fails the tests. Verified on
hardware: a 1 MiB ROM written to bank 1 reads back byte-identical.

## Credits

The protocol was reverse engineered for the C flasher, not here:

| Who | What |
| --- | --- |
| **Mike Ryan** | initial reverse engineering, single bank read and write, SRAM read, ROM title read |
| **David Wendt JR.** | later part of the protocol, multiple bank read and write, SRAM write, full header read, checksum validation |
| **Jamie Bainbridge** | header checksum calculation |

Original project: <http://lacklustre.net/gb/ems/> · maintained fork:
[gheja/ems-flasher](https://github.com/gheja/ems-flasher) · the multi-game
layout follows [Stewmath/ems-flasher](https://github.com/Stewmath/ems-flasher).
Full list in [AUTHORS](AUTHORS).

Hardware: <http://store.kitsch-bent.com/product/usb-64m-smart-card>

## License

MIT, as the original: Copyright © 2011 Mike Ryan. See [COPYING](COPYING).
