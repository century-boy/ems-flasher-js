"""Protocol-level tests: command encoding, bank bases, bounds checking."""

import pytest

from ems_flasher import ems


def test_command_encoding():
    # 1 byte opcode, 4 byte big endian address, 4 byte big endian length
    assert ems._command(ems.CMD_READ, 0x400000, 4096) == bytes(
        [0xFF, 0x00, 0x40, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00]
    )
    assert ems.COMMAND_SIZE == 9


def test_command_opcodes_match_the_c_flasher():
    assert (ems.CMD_READ, ems.CMD_WRITE) == (0xFF, 0x57)
    assert (ems.CMD_READ_SRAM, ems.CMD_WRITE_SRAM) == (0x6D, 0x4D)
    assert (ems.EMS_VID, ems.EMS_PID) == (0x4670, 0x9394)
    assert (ems.EMS_EP_SEND, ems.EMS_EP_RECV) == (0x02, 0x81)


def test_rom_banks_are_four_mib_apart():
    assert ems.bank_base(ems.FROM_ROM, 0) == 0
    assert ems.bank_base(ems.FROM_ROM, 1) == 0x400000
    assert ems.BANK_SIZE * ems.NUM_BANKS == 0x800000  # 64 Mbit


def test_sram_is_shared_between_banks():
    # the SRAM chip is not banked, so the base never moves
    assert ems.bank_base(ems.FROM_SRAM, 0) == 0
    assert ems.bank_base(ems.FROM_SRAM, 1) == 0


def test_space_sizes():
    assert ems.space_size(ems.FROM_ROM) == 0x400000
    assert ems.space_size(ems.FROM_SRAM) == 0x020000


@pytest.mark.parametrize(
    "space, offset, count",
    [
        (ems.FROM_ROM, 0x800000, 1),  # past the last bank
        (ems.FROM_ROM, 0x7FFFFF, 2),  # straddles the end
        (ems.FROM_SRAM, 0x20000, 1),  # past the SRAM chip
        (ems.FROM_ROM, -1, 16),  # negative offset
        (ems.FROM_ROM, 0, 0),  # empty transfer
    ],
)
def test_out_of_range_transfers_are_rejected(space, offset, count):
    dev = ems.EmsDevice()
    with pytest.raises(ems.EmsError):
        dev._check_range(space, offset, count)


def test_in_range_transfers_are_accepted():
    dev = ems.EmsDevice()
    dev._check_range(ems.FROM_ROM, 0x7FF000, 0x1000)  # last ROM block
    dev._check_range(ems.FROM_SRAM, 0x1F000, 0x1000)  # last SRAM block


def test_transfers_need_an_open_device():
    dev = ems.EmsDevice()
    with pytest.raises(ems.EmsError, match="not open"):
        dev.read(ems.FROM_ROM, 0, 512)
