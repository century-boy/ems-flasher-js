/**
 * Decoding the Game Boy cartridge header.
 *
 * Every ROM carries a 0x50 byte header at 0x100 describing its title, which
 * console features it uses and how big it is, plus a checksum the boot ROM
 * verifies before it will run the game. See https://gbdev.io/pandocs/ for the
 * gory details.
 */

/** How many bytes to read off the cart to get a full header. */
export const HEADER_READ_SIZE = 512;

/** Byte offsets of the fields we care about. */
export const HeaderOffset = {
  Logo: 0x104,
  Title: 0x134,
  CgbFlag: 0x143,
  SgbFlag: 0x146,
  CartridgeType: 0x147,
  RomSize: 0x148,
  RamSize: 0x149,
  Region: 0x14a,
  OldLicensee: 0x14b,
  RomVersion: 0x14c,
  HeaderChecksum: 0x14d,
} as const;

/** The title field is 16 bytes, minus the CGB flag on colour carts. */
const TITLE_LENGTH = 16;

/** Value of the SGB flag when Super Game Boy features are enabled. */
const SGB_ENABLED = 0x03;

/** The Old Licensee code SGB games must carry for their features to work. */
const SGB_REQUIRED_LICENSEE = 0x33;

/** CGB flag values that mean the last title byte is a flag, not text. */
const CGB_ENHANCED = 0x80;
const CGB_ONLY = 0xc0;

/** Everything we can tell the user about one bank. */
export interface CartHeader {
  /** Printable title, padding and flag bytes removed. */
  title: string;
  /** Which consoles the ROM supports, e.g. "CGB enhanced, DMG compatible". */
  hardware: string;
  /** ROM size declared in the header, e.g. "1024 KB". */
  romSize: string;
  /** Save RAM size declared in the header, e.g. "32 KB". */
  ramSize: string;
  /** Revision number of the ROM. */
  version: number;
  /** Region declared in the header. */
  region: "Japan" | "non-Japan";
  /** Checksum stored in the header. */
  checksum: number;
  /** Checksum recomputed from the header bytes. */
  computedChecksum: number;
  /** True when the two match, i.e. the ROM will boot on real hardware. */
  checksumValid: boolean;
  /** Non-fatal problems worth telling the user about. */
  warnings: string[];
}

/** ROM size codes 0x00..0x08 are 32 KB shifted left by the code. */
const ODD_ROM_SIZES: Record<number, string> = {
  0x52: "1152 KB",
  0x53: "1280 KB",
  0x54: "1536 KB",
};

const RAM_SIZES: Record<number, string> = {
  0x00: "none",
  0x01: "2 KB",
  0x02: "8 KB",
  0x03: "32 KB",
  0x04: "128 KB",
  0x05: "64 KB",
};

/**
 * Recompute the header checksum.
 *
 * The boot ROM sums bytes 0x134..0x14C as `checksum = checksum - byte - 1`
 * and refuses to start the game unless the result matches byte 0x14D.
 */
export function computeHeaderChecksum(header: Uint8Array): number {
  let checksum = 0;

  for (let address = HeaderOffset.Title; address < HeaderOffset.HeaderChecksum; address++) {
    checksum = (checksum - (header[address] ?? 0) - 1) & 0xff;
  }

  return checksum;
}

/**
 * Extract the cart title.
 *
 * On colour carts the last byte of the title field holds the CGB flag rather
 * than text, so it must be dropped before decoding — otherwise every CGB game
 * shows a stray character at the end of its name.
 */
export function readTitle(header: Uint8Array): string {
  const cgbFlag = header[HeaderOffset.CgbFlag] ?? 0;
  const isColour = cgbFlag === CGB_ENHANCED || cgbFlag === CGB_ONLY;
  const end = HeaderOffset.Title + (isColour ? TITLE_LENGTH - 1 : TITLE_LENGTH);

  const bytes = header.subarray(HeaderOffset.Title, end);
  const nulPosition = bytes.indexOf(0);
  const text = bytes.subarray(0, nulPosition === -1 ? bytes.length : nulPosition);

  // Replace anything unprintable with a dot rather than hiding it.
  return Array.from(text, (byte) =>
    byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : ".",
  )
    .join("")
    .trimEnd();
}

/** Describe which consoles the ROM supports. */
export function readHardwareSupport(header: Uint8Array): string {
  const cgbFlag = header[HeaderOffset.CgbFlag] ?? 0;
  const sgb = header[HeaderOffset.SgbFlag] === SGB_ENABLED;

  let support: string;
  if (cgbFlag === CGB_ONLY) {
    support = "CGB only";
  } else if ((cgbFlag & CGB_ENHANCED) !== 0) {
    support = "CGB enhanced, DMG compatible";
  } else {
    support = "DMG";
  }

  return sgb ? `${support}, SGB enhanced` : support;
}

/** Describe the ROM size code. */
export function readRomSize(header: Uint8Array): string {
  const code = header[HeaderOffset.RomSize] ?? 0;

  if (code <= 0x08) {
    return `${32 << code} KB`;
  }

  return ODD_ROM_SIZES[code] ?? `unknown (code 0x${code.toString(16).padStart(2, "0")})`;
}

/** Describe the save RAM size code. */
export function readRamSize(header: Uint8Array): string {
  const code = header[HeaderOffset.RamSize] ?? 0;
  return RAM_SIZES[code] ?? `unknown (code 0x${code.toString(16).padStart(2, "0")})`;
}

/** Decode a header read off the cart into something worth showing a user. */
export function parseHeader(header: Uint8Array): CartHeader {
  const checksum = header[HeaderOffset.HeaderChecksum] ?? 0;
  const computedChecksum = computeHeaderChecksum(header);
  const warnings: string[] = [];

  if (checksum !== computedChecksum) {
    warnings.push(
      "Header checksum is invalid: this game will not boot on real hardware.",
    );
  }

  if (
    header[HeaderOffset.SgbFlag] === SGB_ENABLED &&
    header[HeaderOffset.OldLicensee] !== SGB_REQUIRED_LICENSEE
  ) {
    warnings.push(
      "SGB features are enabled but the Old Licensee field is not 33h, " +
        "so they will not work on real hardware.",
    );
  }

  return {
    title: readTitle(header),
    hardware: readHardwareSupport(header),
    romSize: readRomSize(header),
    ramSize: readRamSize(header),
    version: header[HeaderOffset.RomVersion] ?? 0,
    region: header[HeaderOffset.Region] === 0 ? "Japan" : "non-Japan",
    checksum,
    computedChecksum,
    checksumValid: checksum === computedChecksum,
    warnings,
  };
}
