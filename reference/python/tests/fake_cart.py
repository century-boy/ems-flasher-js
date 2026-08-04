"""An in-memory stand-in for a real cart, so the CLI can be tested offline."""

from __future__ import annotations

from ems_flasher.ems import (
    BANK_SIZE,
    FROM_ROM,
    NUM_BANKS,
    SRAM_SIZE,
    EmsError,
)


class FakeCart:
    """Implements the EmsDevice read/write API against bytearrays.

    Records every transfer in ``reads`` / ``writes`` as
    ``(space, offset, count)`` tuples so tests can assert on the exact
    addresses that would hit the hardware.
    """

    def __init__(self) -> None:
        self.rom = bytearray(NUM_BANKS * BANK_SIZE)
        self.sram = bytearray(SRAM_SIZE)
        self.reads: list[tuple[int, int, int]] = []
        self.writes: list[tuple[int, int, int]] = []

    def _buffer(self, space: int) -> bytearray:
        return self.rom if space == FROM_ROM else self.sram

    def _check(self, space: int, offset: int, count: int) -> None:
        buf = self._buffer(space)
        if offset < 0 or offset + count > len(buf):
            raise EmsError(f"out of range: 0x{offset:X}+{count}")

    def read(self, space: int, offset: int, count: int) -> bytes:
        self._check(space, offset, count)
        self.reads.append((space, offset, count))
        return bytes(self._buffer(space)[offset : offset + count])

    def write(self, space: int, offset: int, data: bytes) -> int:
        self._check(space, offset, len(data))
        self.writes.append((space, offset, len(data)))
        self._buffer(space)[offset : offset + len(data)] = data
        return len(data)

    def close(self) -> None:
        pass
