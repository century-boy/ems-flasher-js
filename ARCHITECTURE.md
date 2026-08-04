# Architecture and hardware notes

What we know about the _GB USB smart card 64M_, how we know it, and how this
flasher is built on top of it.

The cart is closed hardware with no datasheet. Everything below is either
**measured** on a real cart, **inherited** from the reverse engineering done
for the C flasher, or **inferred** from behaviour — and each claim says which.
The last section lists what is still unknown, so nobody has to re-derive it.

- **measured** — observed directly on a cart during this port, on macOS 15
- **inherited** — from the C flasher by Mike Ryan, David Wendt JR. and Jamie
  Bainbridge, or from its multirom fork
- **inferred** — deduced from behaviour, consistent with everything seen, but
  not confirmed against the silicon

---

## 1. The cartridge

### 1.1 USB identity

Full descriptor dump from a real cart (**measured**):

| Field | Value | Note |
| --- | --- | --- |
| `idVendor` / `idProduct` | `0x4670` / `0x9394` | the only reliable way to spot the cart |
| `bcdUSB` | `0x0100` | declares USB 1.0 |
| `bcdDevice` | `0x0288` | firmware revision 2.88 |
| `bDeviceClass` | `0x00` | no class at device level |
| `bMaxPacketSize0` | 64 | control endpoint |
| `iManufacturer` / `iProduct` / `iSerialNumber` | `0` / `0` / `0` | **no string descriptors at all** |
| `bNumConfigurations` | 1 | configuration value `1` |
| `bmAttributes` / `bMaxPower` | `0xA0` / 100 mA | bus powered, remote wakeup |
| Link speed | full speed, 12 Mbit/s | not high speed |

One interface, class `0x00/0x00/0x00`, three bulk endpoints:

| Endpoint | Direction | Type | Max packet | Used by the protocol |
| --- | --- | --- | --- | --- |
| `0x02` | OUT | bulk | 64 | yes — commands and write payloads |
| `0x81` | IN | bulk | 64 | yes — read payloads |
| `0x83` | IN | bulk | 64 | **no — never used** |

Two consequences follow from `bInterfaceClass = 0x00`:

- **WebUSB works.** Chrome refuses `claimInterface()` on protected classes
  (HID, mass storage, audio, smart card, video, wireless). Class 0 is not one
  of them, which is what makes the browser version of this flasher possible at
  all.
- **Windows needs help.** A class-0 interface matches no in-box driver, so
  Windows leaves it unbound and neither libusb nor WebUSB can reach it until
  WinUSB is installed for it (Zadig). macOS and Linux bind nothing to it and
  it works out of the box — on macOS the interface was claimed with no kernel
  driver to detach (**measured**).

The absence of string descriptors is why the cart shows up unnamed in system
tools; there is nothing to display but numbers.

### 1.2 Memory map

| Region | Size | Addressing |
| --- | --- | --- |
| ROM bank 1 | 4 MiB (32 Mbit) | `0x000000`–`0x3FFFFF` |
| ROM bank 2 | 4 MiB (32 Mbit) | `0x400000`–`0x7FFFFF` |
| SRAM | 128 KiB | `0x00000`–`0x1FFFF`, its own address space |

The console sees **one ROM bank at a time**; you switch by power cycling it
quickly. Over USB both banks are simply addressable, one after the other, in a
flat 8 MiB space (**inherited**, consistent with every read done here).

The SRAM is **one chip shared by both banks** (**inherited**, corroborated by
community documentation). It is not banked, so a bank number has no meaning
for saves. The C flasher nevertheless applied `bank × 4 MiB` as a base for
SRAM writes too, which addresses far outside a 128 KiB chip; this port ignores
the bank for SRAM and says so.

### 1.3 The wire protocol

Every operation is a 9-byte command on the bulk OUT endpoint (**inherited**,
verified byte for byte here):

```
 0        1                    5                    9
 +--------+--------------------+--------------------+
 | opcode | address (BE u32)   | length (BE u32)    |
 +--------+--------------------+--------------------+
```

| Opcode | Meaning |
| --- | --- |
| `0xFF` | read ROM |
| `0x57` | write ROM |
| `0x6D` | read SRAM |
| `0x4D` | write SRAM |

Both 32-bit fields are **big endian**, which is worth stating because
everything else about the platform is little endian.

The two directions are shaped differently:

- **Read** — send the 9-byte command, then read `length` bytes from `0x81`.
  Two transfers, one round trip.
- **Write** — send the command with the payload appended in the *same*
  transfer, `9 + length` bytes to `0x02`. One transfer, and **no
  acknowledgement**: the cart reports nothing about whether the flash actually
  took the data.

That silence is the reason this flasher offers `--read` back: the only way to
know a write worked is to read it and compare. We did exactly that — 1 MiB
written to bank 1 and read back byte-identical (**measured**).

### 1.4 Timing

Reading 512 KiB in 4096-byte blocks took **12.3 s**, about **42 KiB/s**
(**measured**). Per block that is ~96 ms.

The interesting part is where the time goes. At 12 Mbit/s, 4096 bytes need
~3.4 ms on the wire; bulk full speed allows at most 19 packets of 64 bytes per
1 ms frame, so ~1.2 MB/s is the ceiling. We are getting a thirtieth of that.
The transfer is therefore **dominated by per-command latency, not bandwidth**
(**inferred**) — the firmware spends most of the time between receiving a
command and having data ready.

Practical consequences:

- A full 4 MiB bank takes roughly 100 s to read. This is the hardware, not the
  software: no language or library choice moves it.
- Reads use 4096-byte blocks because latency is paid per command, so bigger
  blocks amortise it. Writes use 32-byte blocks, matching the stock Windows
  software (**inherited**) — see the open questions.
- Scanning a bank for games means 128 header reads, a couple of seconds.

### 1.5 Failure modes

Two behaviours worth knowing, both **measured**:

- **The cart can wedge.** After an interrupted session it stopped answering:
  the device still enumerated, the interface still claimed, but every transfer
  timed out. Only unplugging and replugging recovered it. This is why the
  flasher has a per-transfer timeout (10 s by default) instead of the C
  flasher's infinite wait — an infinite wait turns a wedged cart into a hung
  process with no diagnosis.
- **`USB reset` makes it disappear.** Issuing a USB-level reset dropped the
  device off the bus entirely (`No such device` on the next call), and it did
  not come back without a physical replug. So: never reset this device to try
  to recover it. Tell the user to replug it.

---

## 2. Several games on one bank

The cart ships with a menu ROM that identifies itself as `GB16M`.

### 2.1 How the menu finds games

The menu carries **no table of contents**. At boot it walks the bank in 32 KiB
steps and treats every position holding a valid Game Boy header — recognised
by the Nintendo logo at `0x104` — as a game (**inherited** from the multirom
fork, confirmed by the layout found on a real cart).

This is a good design for a flasher to target: adding a game is a placement
problem, not a menu-authoring problem. Nothing has to be patched, no index
rewritten.

### 2.2 The alignment rule

A ROM must start at an offset that is **a multiple of its own size**. The
mapper selects a game by masking address lines, so only power-of-two sizes at
power-of-two boundaries can be reached (**inferred** from the mapper's nature,
**confirmed** by what a real cart contains).

Bank 2 of the test cart, read with `--list` (**measured**):

| # | Title | Size | Offset | Offset ÷ size |
| --- | --- | --- | --- | --- |
| 0 | `GB16M` | 32 KiB | `0x000000` | 0 |
| 1 | `SOLARSTRIKER` | 64 KiB | `0x010000` | 1 |
| 2 | `TRIP WORLD` | 256 KiB | `0x040000` | 1 |
| 3 | `BOMBER MAN GB` | 256 KiB | `0x080000` | 2 |
| 4 | `POKEBOM USA` | 1 MiB | `0x100000` | 1 |

Every game sits at an exact multiple of its own size. Note the gaps this
leaves: `0x008000`–`0x00FFFF` (32 KiB), `0x020000`–`0x03FFFF` (128 KiB),
`0x0C0000`–`0x0FFFFF` (256 KiB). They are usable, but only by ROMs small
enough *and* correctly aligned.

Hence a counter-intuitive rule the UI has to explain: **free space is not
always usable space**. A bank with 1 MiB free only at a 1 MiB boundary cannot
take a 2 MiB game.

### 2.3 Placement and deletion

`--add` does first fit with alignment: walk the games in offset order, and for
each gap check whether the new ROM fits at the next correctly aligned offset.
The size used is the one **declared in the ROM header**, not the file length,
because that is what the menu and the mapper go by. A file whose header
understates its size is refused, since the next game would be placed on top of
it.

`--delete` **blanks the header** rather than erasing the ROM. Flash cannot be
erased byte by byte, only in blocks, and the menu decides purely by what it
finds at each 32 KiB boundary: zero the first 512 bytes and the game is gone
from the list and its space is reusable (**inherited**, verified against the
fake firmware). The data itself lingers until something is written over it —
worth knowing if the cart leaves your hands.

### 2.4 Extracting a game

Because a game occupies a known offset and a known size, one can be read back
out on its own. `--extract` reads exactly those bytes, producing a working
ROM: verified by pulling `SOLARSTRIKER` off bank 2 as a 64 KiB file with a
valid Nintendo logo, correct title and a passing header checksum
(**measured**).

---

## 3. The Game Boy header

The fields this flasher reads, at their standard offsets (see
[Pandocs](https://gbdev.io/pandocs/)):

| Offset | Field | Why we care |
| --- | --- | --- |
| `0x104` | Nintendo logo, 48 bytes | how the menu — and we — recognise a ROM |
| `0x134` | title, 16 bytes | what to show the user |
| `0x143` | CGB flag | `0x80` enhanced, `0xC0` CGB only |
| `0x146` | SGB flag | `0x03` means SGB features |
| `0x148` | ROM size code | `32 KiB << code`; decides placement |
| `0x149` | RAM size code | reported for information |
| `0x14B` | old licensee | must be `0x33` for SGB features to work |
| `0x14D` | header checksum | the boot ROM refuses the game if wrong |

Two traps worth recording:

- **The title field is 16 bytes, but only 15 on colour carts** — byte `0x143`
  is the CGB flag, not text. Decoding all 16 puts a stray character at the end
  of every CGB game's name. This port trims it when the flag is `0x80` or
  `0xC0`.
- **The checksum covers `0x134`–`0x14C`** and is computed as
  `checksum = checksum - byte - 1` per byte, 8-bit wrapping. A ROM whose
  checksum does not match will not boot on real hardware, which makes it a
  useful integrity check on a fresh dump.

---

## 4. Software architecture

### 4.1 One protocol implementation, two runtimes

The core is written against the **WebUSB `USBDevice` interface**. Browsers
implement it natively, and [node-usb](https://github.com/node-usb/node-usb)
implements it on the desktop over libusb. So the CLI and the web app run the
same protocol code, rather than two copies that drift apart.

```
                    ┌─────────────────────────┐
                    │  @ems-flasher-js/core   │
                    │  protocol · memory map  │
                    │  headers · placement    │
                    └────────────┬────────────┘
                       USBDevice │ interface
                 ┌───────────────┴───────────────┐
        node-usb │                               │ navigator.usb
    ┌────────────┴───────────┐       ┌───────────┴────────────┐
    │  packages/cli          │       │  apps/web              │
    │  ems-flasher on npm    │       │  Vite app on Netlify   │
    └────────────────────────┘       └────────────────────────┘
```

| Module | Responsibility |
| --- | --- |
| `core/protocol.ts` | opcodes, endpoints, command encoding |
| `core/cart.ts` | open, claim, bounded transfers, timeouts |
| `core/geometry.ts` | banks, sizes, bank bases, address spaces |
| `core/header.ts` | Game Boy header decoding and checksum |
| `core/multirom.ts` | scanning, placement, deletion |
| `core/operations.ts` | block loops, size limits, progress |
| `core/format.ts` | byte, rate and duration formatting |

### 4.2 Decisions worth explaining

**Bounds checks live in the core, not the callers.** Every transfer is
validated against the memory map before it reaches USB. The C flasher's own
README warned that an oversized file would "continue writing past the end of
the cart and do unknown amounts of damage"; making that impossible at the
lowest level means no front end can reintroduce it.

**Timeouts are implemented by racing.** WebUSB has no timeout parameter, so
every transfer races a timer. A timed-out transfer is abandoned rather than
cancelled — WebUSB cannot cancel one — which is acceptable because the only
real recovery is a replug anyway.

**Placement is separate from writing.** `planAdd()` decides where a ROM goes
and throws if it cannot, without touching the cart. Both front ends can
therefore explain what will happen — or why it will not — before a single byte
is programmed.

**Progress arithmetic is shared.** Throughput and ETA are computed in the core
and handed to whichever front end is drawing, so the terminal bar and the
on-screen meter cannot disagree.

**Reads can stream.** `readCart()` takes an `onChunk` callback, letting the
CLI write to disk block by block instead of holding a 4 MiB dump in memory.
The web app skips it and takes the buffer, because it needs one to hand the
browser a download.

**`Bytes` is `Uint8Array<ArrayBuffer>`.** Since TypeScript 5.7 that type is
generic over its backing buffer, and WebUSB rejects `SharedArrayBuffer`-backed
views. Naming the constraint once keeps casts out of the call sites.

### 4.3 Testing without hardware

The test suite drives everything against a **fake firmware** that *decodes*
the protocol the way the cart does: it parses the 9-byte command, dispatches
on the opcode, and reads or writes its own byte arrays. It does not
pattern-match on expected calls, so a single wrong byte in an encoded command
fails the tests.

That covers placement arithmetic, bank bases, size limits, header decoding,
timeouts and abort handling — 155 tests, no cart required. What it cannot
cover is whether the real firmware agrees, which is why the claims in this
document are labelled.

---

## 5. Platform notes

| Platform | CLI | Web app | What is needed |
| --- | --- | --- | --- |
| macOS | works | works | nothing; no kernel driver claims the interface |
| Linux | works | works | udev rule for `4670:9394`, or root |
| Windows | works | works | WinUSB bound to the device (Zadig) |
| Android | — | works | Chrome and an OTG cable |
| iOS | — | never | no WebUSB, and no plans for it |

```sh
echo 'SUBSYSTEM=="usb", ATTR{idVendor}=="4670", ATTR{idProduct}=="9394", MODE="0666"' \
  | sudo tee /etc/udev/rules.d/60-ems-flasher.rules
```

---

## 6. Open questions

Things we deliberately did not test, or could not:

- **What is endpoint `0x83` for?** The cart exposes a third bulk IN endpoint
  that the known protocol never touches. It may carry status, a second data
  channel, or nothing at all. Probing it is harmless to try (reads only) but
  was out of scope here.
- **Do writes accept blocks larger than 32 bytes?** The 32-byte block size is
  inherited from the stock Windows software. If the firmware tolerates 512 or
  4096, flashing would get dramatically faster — most of all in the browser,
  where per-transfer overhead is higher. Testing means writing to a cart, so it
  needs a cart whose contents are expendable.
- **Is there an erase command?** None is known. Deletion works by blanking
  headers, which suggests the flasher never needed one, but a block-erase
  opcode may well exist.
- **How does the menu handle multiple saves?** Community reports describe menu
  revisions (1.0.4 versus 1.0.8) differing in save management. We have not
  examined the menu ROM itself.
- **What exactly does the mapper mask?** The alignment rule fits address-line
  masking and matches every cart layout seen, but no register-level
  description was found.
- **Is the write path exact for odd sizes?** Trailing partial blocks are
  written rather than dropped, which is strictly better than the C flasher, but
  whether the flash programs a sub-32-byte tail cleanly has only been verified
  through a full-file read-back, not at block granularity.

---

## 7. References

- Original flasher and protocol: <http://lacklustre.net/gb/ems/> — Mike Ryan,
  with David Wendt JR. and Jamie Bainbridge (see [AUTHORS](AUTHORS))
- Maintained fork: <https://github.com/gheja/ems-flasher>
- Multi-game layout: <https://github.com/Stewmath/ems-flasher>
- Game Boy header format: <https://gbdev.io/pandocs/>
- node-usb: <https://github.com/node-usb/node-usb>
- WebUSB specification: <https://wicg.github.io/webusb/>
