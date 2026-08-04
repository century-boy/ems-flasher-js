"""CLI tests: option parsing, size limits, read/write loops, header decoding."""

import pytest

from ems_flasher import cli
from ems_flasher.ems import BANK_SIZE, FROM_ROM, FROM_SRAM, SRAM_SIZE

from .fake_cart import FakeCart


def options(**kwargs):
    opts = cli.Options()
    opts.progress = False
    for key, value in kwargs.items():
        setattr(opts, key, value)
    return opts


def make_header(title=b"TETRIS", cgb=0x00, sgb=0x00, licensee=0x00, romsize=1):
    header = bytearray(512)
    header[cli.HEADER_TITLE : cli.HEADER_TITLE + len(title)] = title
    header[cli.HEADER_CGBFLAG] = cgb
    header[cli.HEADER_SGBFLAG] = sgb
    header[cli.HEADER_OLDLICENSEE] = licensee
    header[cli.HEADER_ROMSIZE] = romsize
    header[cli.HEADER_CHKSUM] = cli.rom_checksum_header(bytes(header))
    return bytes(header)


# -- option parsing --------------------------------------------------


def test_bank_defaults_to_one_and_is_zero_based_internally():
    assert cli.get_options(["--read", "out.gb"]).bank == 0
    assert cli.get_options(["--read", "--bank", "2", "out.gb"]).bank == 1


@pytest.mark.parametrize(
    "argv",
    [
        [],  # no mode
        ["--read", "--write", "f.gb"],  # two modes
        ["--read"],  # missing file
        ["--write"],
        ["--title", "extra.gb"],  # title takes no file
        ["--read", "--bank", "3", "f.gb"],  # only two banks
        ["--read", "--blocksize", "0", "f.gb"],
        ["--read", "--size", "0", "f.gb"],
        ["--write", "--rom", "--save", "f.gb"],  # conflicting spaces
    ],
)
def test_invalid_option_combinations_exit_with_an_error(argv):
    with pytest.raises(SystemExit) as excinfo:
        cli.get_options(argv)
    assert excinfo.value.code != 0


def test_default_blocksizes_match_the_mode():
    assert cli.get_options(["--read", "f.gb"]).blocksize == cli.BLOCKSIZE_READ
    assert cli.get_options(["--write", "f.gb"]).blocksize == cli.BLOCKSIZE_WRITE
    assert cli.get_options(["--read", "-s", "1024", "f.gb"]).blocksize == 1024


@pytest.mark.parametrize(
    "text, expected",
    [("32k", 32768), ("0x8000", 32768), ("4M", 4 * 1024 * 1024), ("512", 512),
     ("128KiB", 131072)],
)
def test_parse_size_accepts_suffixes_and_hex(text, expected):
    assert cli.parse_size(text) == expected


# -- space and bank resolution ---------------------------------------


@pytest.mark.parametrize(
    "name, expected",
    [("game.gb", FROM_ROM), ("game.gbc", FROM_ROM), ("pokemon.sav", FROM_SRAM),
     ("POKEMON.SAV", FROM_SRAM), ("x", FROM_ROM)],
)
def test_space_is_detected_from_the_file_name(name, expected):
    assert cli.detect_space(name) == expected


def test_explicit_space_flags_win_over_the_file_name():
    assert cli.resolve_space(options(file="game.sav", space=FROM_ROM)) == FROM_ROM
    assert cli.resolve_space(options(file="game.gb", space=FROM_SRAM)) == FROM_SRAM


def test_bank_two_moves_the_rom_base_but_not_sram(capsys):
    assert cli.resolve_base(FROM_ROM, options(bank=1)) == BANK_SIZE
    assert cli.resolve_base(FROM_SRAM, options(bank=1)) == 0
    assert "shared by both banks" in capsys.readouterr().err


# -- reading ---------------------------------------------------------


def test_read_dumps_a_whole_rom_bank(tmp_path):
    cart = FakeCart()
    cart.rom[:] = bytes(range(256)) * (len(cart.rom) // 256)
    out = tmp_path / "dump.gb"

    opts = options(mode="read", blocksize=4096, bank=1, file=str(out))
    cli.do_read(cart, opts, FROM_ROM, BANK_SIZE)

    assert out.read_bytes() == bytes(cart.rom[BANK_SIZE:])
    assert cart.reads[0] == (FROM_ROM, BANK_SIZE, 4096)
    assert cart.reads[-1] == (FROM_ROM, 2 * BANK_SIZE - 4096, 4096)
    assert len(cart.reads) == BANK_SIZE // 4096


def test_read_dumps_the_whole_sram(tmp_path):
    cart = FakeCart()
    out = tmp_path / "dump.sav"

    cli.do_read(cart, options(mode="read", blocksize=4096, file=str(out)),
                FROM_SRAM, 0)

    assert out.stat().st_size == SRAM_SIZE


def test_read_honours_the_size_option(tmp_path):
    cart = FakeCart()
    out = tmp_path / "part.sav"

    opts = options(mode="read", blocksize=4096, file=str(out), size=32 * 1024)
    cli.do_read(cart, opts, FROM_SRAM, 0)

    assert out.stat().st_size == 32 * 1024
    assert sum(r[2] for r in cart.reads) == 32 * 1024


def test_read_clamps_a_size_larger_than_the_space(tmp_path, capsys):
    cart = FakeCart()
    out = tmp_path / "big.sav"

    opts = options(mode="read", blocksize=4096, file=str(out), size=SRAM_SIZE * 2)
    cli.do_read(cart, opts, FROM_SRAM, 0)

    assert out.stat().st_size == SRAM_SIZE
    assert "holds only" in capsys.readouterr().err


def test_read_handles_a_blocksize_that_does_not_divide_evenly(tmp_path):
    cart = FakeCart()
    out = tmp_path / "odd.sav"

    # 1000 does not divide 128 KiB: the last block must be short, not dropped
    opts = options(mode="read", blocksize=1000, file=str(out))
    cli.do_read(cart, opts, FROM_SRAM, 0)

    assert out.stat().st_size == SRAM_SIZE
    assert cart.reads[-1][2] == SRAM_SIZE % 1000


# -- writing ---------------------------------------------------------


def test_write_sends_the_file_to_bank_one(tmp_path):
    cart = FakeCart()
    payload = bytes((i * 7) & 0xFF for i in range(32 * 100))
    src = tmp_path / "rom.gb"
    src.write_bytes(payload)

    cli.do_write(cart, options(mode="write", blocksize=32, file=str(src)),
                 FROM_ROM, 0)

    assert bytes(cart.rom[: len(payload)]) == payload
    assert cart.writes[0] == (FROM_ROM, 0, 32)
    assert len(cart.writes) == 100


def test_write_sends_the_file_to_bank_two(tmp_path):
    cart = FakeCart()
    payload = b"\xAA" * 4096
    src = tmp_path / "rom.gb"
    src.write_bytes(payload)

    opts = options(mode="write", blocksize=1024, bank=1, file=str(src))
    cli.do_write(cart, opts, FROM_ROM, BANK_SIZE)

    assert cart.writes[0] == (FROM_ROM, BANK_SIZE, 1024)
    assert bytes(cart.rom[BANK_SIZE : BANK_SIZE + len(payload)]) == payload
    assert bytes(cart.rom[:BANK_SIZE]) == bytes(BANK_SIZE)  # bank 1 untouched


def test_write_keeps_the_trailing_partial_block(tmp_path):
    cart = FakeCart()
    # 100 bytes with a 32 byte blocksize: the C flasher dropped the last 4
    payload = bytes(range(100))
    src = tmp_path / "rom.gb"
    src.write_bytes(payload)

    cli.do_write(cart, options(mode="write", blocksize=32, file=str(src)),
                 FROM_ROM, 0)

    assert bytes(cart.rom[:100]) == payload
    assert cart.writes[-1] == (FROM_ROM, 96, 4)


def test_write_refuses_a_file_larger_than_the_space(tmp_path):
    cart = FakeCart()
    src = tmp_path / "big.sav"
    src.write_bytes(b"\xAB" * (SRAM_SIZE + 1))

    with pytest.raises(SystemExit) as excinfo:
        cli.do_write(cart, options(mode="write", blocksize=4096, file=str(src)),
                     FROM_SRAM, 0)

    assert excinfo.value.code == 1
    assert cart.writes == []  # nothing touched the cart


def test_write_truncates_when_asked(tmp_path, capsys):
    cart = FakeCart()
    src = tmp_path / "big.sav"
    src.write_bytes(b"\xAB" * (SRAM_SIZE + 5000))

    opts = options(mode="write", blocksize=4096, file=str(src), truncate=True)
    cli.do_write(cart, opts, FROM_SRAM, 0)

    assert sum(w[2] for w in cart.writes) == SRAM_SIZE
    assert "truncating" in capsys.readouterr().err


def test_write_rejects_an_empty_file(tmp_path):
    cart = FakeCart()
    src = tmp_path / "empty.gb"
    src.write_bytes(b"")

    with pytest.raises(SystemExit):
        cli.do_write(cart, options(mode="write", blocksize=32, file=str(src)),
                     FROM_ROM, 0)


def test_write_reports_a_missing_file(tmp_path):
    with pytest.raises(SystemExit):
        cli.do_write(FakeCart(),
                     options(mode="write", blocksize=32, file=str(tmp_path / "nope.gb")),
                     FROM_ROM, 0)


# -- header decoding -------------------------------------------------


def test_checksum_matches_the_pandocs_algorithm():
    header = make_header(title=b"POKEMON RED")
    assert cli.rom_checksum_header(header) == header[cli.HEADER_CHKSUM]


def test_title_strips_padding_and_unprintable_bytes():
    assert cli.rom_title(make_header(title=b"TETRIS\x00\x00")) == "TETRIS"
    assert cli.rom_title(make_header(title=b"A\x01B")) == "A.B"


def test_title_ignores_the_cgb_flag_that_shares_the_title_field():
    # a 15 char title on a CGB cart: byte 0x143 is the flag, not text
    header = bytearray(make_header(title=b"LSDj-v9.4.2", cgb=0x80))
    assert cli.rom_title(bytes(header)) == "LSDj-v9.4.2"

    # and a full 15 char title is not cut short
    header[cli.HEADER_TITLE : cli.HEADER_TITLE + 15] = b"POKEMON YELLOW!"
    assert cli.rom_title(bytes(header)) == "POKEMON YELLOW!"


@pytest.mark.parametrize(
    "cgb, sgb, expected",
    [
        (0x00, 0x00, "DMG"),
        (0x00, 0x03, "DMG, SGB enhanced"),
        (0x80, 0x00, "CGB enhanced, DMG compatible"),
        (0x80, 0x03, "CGB enhanced, DMG compatible, SGB enhanced"),
        (0xC0, 0x00, "CGB only"),
        (0xC0, 0x03, "CGB only, SGB enhanced"),
    ],
)
def test_hardware_support_covers_every_flag_combination(cgb, sgb, expected):
    assert hardware_support_of(cgb, sgb) == expected


def hardware_support_of(cgb, sgb):
    return cli.hardware_support(make_header(cgb=cgb, sgb=sgb))


def test_rom_size_codes():
    assert cli.rom_size(make_header(romsize=0)) == "32 KB"
    assert cli.rom_size(make_header(romsize=5)) == "1024 KB"
    assert cli.rom_size(make_header(romsize=0x52)) == "1152 KB"
    assert "unknown" in cli.rom_size(make_header(romsize=0x99))


def test_title_mode_reads_both_bank_headers(capsys):
    cart = FakeCart()
    for bank, name in enumerate((b"BANK ONE", b"BANK TWO")):
        header = make_header(title=name, cgb=0x80)
        cart.rom[bank * BANK_SIZE : bank * BANK_SIZE + 512] = header

    cli.do_title(cart, options(mode="title", verbose=True))

    out = capsys.readouterr().out
    assert cart.reads == [(FROM_ROM, 0, 512), (FROM_ROM, BANK_SIZE, 512)]
    assert "Bank 1:" in out and "BANK ONE" in out
    assert "Bank 2:" in out and "BANK TWO" in out
    assert "Header checksum:  OK" in out


def test_title_mode_flags_a_bad_checksum(capsys):
    cart = FakeCart()
    header = bytearray(make_header())
    header[cli.HEADER_CHKSUM] ^= 0xFF
    cart.rom[:512] = header

    cli.do_title(cart, options(mode="title"))

    assert "INVALID" in capsys.readouterr().out


def test_title_mode_warns_about_a_broken_sgb_licensee(capsys):
    cart = FakeCart()
    cart.rom[:512] = make_header(sgb=0x03, licensee=0x00)

    cli.do_title(cart, options(mode="title"))

    assert "Old Licensee" in capsys.readouterr().out
