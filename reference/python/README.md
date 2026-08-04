# Python reference implementation

A port of the C [ems-flasher](http://lacklustre.net/gb/ems/) by Mike Ryan,
whose protocol work — with David Wendt JR. and Jamie Bainbridge — everything
here rests on. See [AUTHORS](../../AUTHORS).

This is the implementation the JavaScript port was validated against. It is
kept in the repo as a second opinion on the protocol: when the TypeScript core
and this agree on the bytes, the bytes are right.

It is fully working and hardware-verified — a 1 MiB ROM written to bank 1 and
read back compares byte-identical — but the maintained flasher is the
JavaScript one at the root of this repo.

```sh
uv sync
uv run ems-flasher --title
uv run ems-flasher --write --bank 1 lsdj.gb
uv run pytest            # 60 tests, no hardware needed
```

Requires Python 3.12+, [uv](https://docs.astral.sh/uv/) and libusb 1.0.
