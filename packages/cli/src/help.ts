/** The `--help` screen. Kept in one place so it stays readable and complete. */

export const HELP = `\
ems-flasher — read and write the EMS 64 Mbit USB flash cart for Game Boy

usage:
  ems-flasher --title                          list every game on the cart
  ems-flasher --write [--bank {1,2}] FILE      write a ROM or save to a bank
  ems-flasher --read  [--bank {1,2}] FILE      dump a bank into a file
  ems-flasher --list  [--bank {1,2}]           list the games on one bank
  ems-flasher --add   [--bank {1,2}] FILE      add a game to a bank
  ems-flasher --extract N [--bank {1,2}] [FILE]  save game N as a ROM file
  ems-flasher --delete N  [--bank {1,2}]       remove game N from a bank
  ems-flasher --help                           show this help
  ems-flasher --version                        print the version

the cart:
  64 Mbit of flash ROM split into two independent 32 Mbit (4 MiB) banks, plus
  128 KiB of SRAM for saves. Only one ROM bank is visible to the Game Boy at a
  time; you switch by power cycling the console quickly. The SRAM chip is
  shared by both banks, so --bank does not apply to save files.

operating mode (pick exactly one):
  -t, --title             list every game in both banks and exit
  -r, --read              dump a whole bank into FILE
  -w, --write             write FILE at the start of a bank, replacing it
  -l, --list              list the games the cart menu will show for a bank
  -a, --add               add FILE to a bank, keeping the games already on it
  -e, --extract N         save game N to FILE, or to a name taken from its title
  -d, --delete N          remove game N from a bank

  N is an index as printed by --list and --title.

several games on one bank:
  Write the cart menu to a bank with --write, then --add games to it. The menu
  scans the bank at boot and lists everything it finds, so adding a game means
  placing it after the ones already there — --add works that out for you,
  --extract pulls a single game back out as a working ROM, and --delete frees a
  slot by blanking the game's header.

  A ROM can only start at a multiple of its own size, so sizes must be powers
  of two from 32 KiB to 4 MiB, and a bank may not hold as much as its free
  space suggests. --add says where a game landed, or why it did not fit.

target selection:
  -b, --bank {1,2}        ROM bank to use (default: 1); ignored for SRAM
  -R, --rom               force the flash ROM, whatever the file name says
  -S, --save              force the SRAM, whatever the file name says

  Without these, the space is picked from the file name: .sav means SRAM,
  anything else means ROM.

advanced options:
  -s, --blocksize BYTES   bytes per USB transfer (default: 4096 read, 32 write)
  -n, --size BYTES        how much to read; accepts 0x8000, 32k, 4M
                          (default: the whole space). Ignored when writing
      --timeout SECONDS   per-transfer USB timeout (default: 10, 0 waits forever)
      --truncate          when writing, allow a file larger than the target
                          space to be cut short instead of failing

output:
  -v, --verbose           print more information
      --no-progress       hide the progress bar (hidden automatically when
                          stderr is not a terminal)
  -V, --version           print the version
  -h, --help              show this help

examples, one game per bank:
  ems-flasher --title                         see what is on the cart
  ems-flasher --write lsdj.gb                 write a ROM to bank 1
  ems-flasher --write --bank 2 zelda.gbc      write a ROM to bank 2
  ems-flasher --read --bank 2 backup.gb       dump bank 2 to a file

examples, saves:
  ems-flasher --read --size 32k pokemon.sav   back up a save
  ems-flasher --write pokemon.sav             restore it

examples, several games on bank 2:
  ems-flasher --write --bank 2 menu.gb        put the cart menu in place...
  ems-flasher --add --bank 2 tetris.gb        ...then add games to it
  ems-flasher --list --bank 2                 see what the menu will show
  ems-flasher --extract 1 --bank 2            save game 1 as its own ROM
  ems-flasher --delete 1 --bank 2             drop it, freeing its slot

environment:
  EMS_DEBUG=1             dump every protocol command to stderr

linux permissions:
  install a udev rule so your user can reach the cart without sudo:
    SUBSYSTEM=="usb", ATTR{idVendor}=="4670", ATTR{idProduct}=="9394", MODE="0666"

Prefer clicking to typing? The same flasher runs in the browser over WebUSB,
no install at all: https://ems-flasher.netlify.app
`;
