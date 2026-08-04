# ems-flasher-js

Flash the _GB USB smart card 64M_ Game Boy cart from your terminal.

**A TypeScript port of [ems-flasher](http://lacklustre.net/gb/ems/) by Mike
Ryan.** The protocol, and the reverse engineering behind it, are the work of
Mike Ryan, David Wendt JR. and Jamie Bainbridge on the original C flasher,
maintained in [gheja's fork](https://github.com/gheja/ems-flasher). This package
re-implements it in TypeScript.

```sh
npm install -g ems-flasher-js
```

```sh
ems-flasher --title                        # what is on the cart?
ems-flasher --write lsdj.gb                # flash a ROM to bank 1
ems-flasher --write --bank 2 zelda.gbc     # ...and another to bank 2
ems-flasher --read --bank 2 backup.gb      # dump a bank
ems-flasher --read --size 32k pokemon.sav  # back up a save
ems-flasher --help                         # every flag, with examples
```

The cart holds 64 Mbit of flash ROM in two independent 4 MiB banks, plus
128 KiB of SRAM shared by both banks. This tool reads and writes all of it,
refuses files that do not fit, shows progress with throughput and ETA, and
times out instead of hanging when the cart stops answering.

Needs Node 20+ and libusb (bundled prebuilds cover macOS, Windows and Linux).
On Linux, add a udev rule for `4670:9394` or run as root.

Prefer clicking? The same flasher runs in the browser, no install at all:
<https://ems-flasher.netlify.app>

Part of [EMS Flasher JS](https://github.com/century-boy/ems-flasher-js).
MIT licensed, as the original flasher was: Copyright © 2011 Mike Ryan.
