import { describe, expect, it } from "vitest";

import {
  HeaderOffset,
  computeHeaderChecksum,
  parseHeader,
  readHardwareSupport,
  readRomSize,
  readTitle,
} from "../src/index.js";

/** Build a header with a valid checksum, so tests only vary what they mean to. */
export function makeHeader(
  fields: {
    title?: string;
    cgb?: number;
    sgb?: number;
    licensee?: number;
    romSize?: number;
    ramSize?: number;
  } = {},
): Uint8Array {
  const header = new Uint8Array(512);
  const title = fields.title ?? "TETRIS";

  for (let index = 0; index < title.length; index++) {
    header[HeaderOffset.Title + index] = title.charCodeAt(index);
  }

  header[HeaderOffset.CgbFlag] = fields.cgb ?? 0x00;
  header[HeaderOffset.SgbFlag] = fields.sgb ?? 0x00;
  header[HeaderOffset.OldLicensee] = fields.licensee ?? 0x00;
  header[HeaderOffset.RomSize] = fields.romSize ?? 0x01;
  header[HeaderOffset.RamSize] = fields.ramSize ?? 0x00;
  header[HeaderOffset.HeaderChecksum] = computeHeaderChecksum(header);

  return header;
}

describe("checksum", () => {
  it("matches the algorithm the boot ROM uses", () => {
    const header = makeHeader({ title: "POKEMON RED" });
    expect(computeHeaderChecksum(header)).toBe(header[HeaderOffset.HeaderChecksum]);
  });

  it("flags a corrupted header", () => {
    const header = makeHeader();
    header[HeaderOffset.HeaderChecksum] ^= 0xff;

    const parsed = parseHeader(header);

    expect(parsed.checksumValid).toBe(false);
    expect(parsed.warnings.join(" ")).toContain("not boot");
  });
});

describe("title", () => {
  it("drops NUL padding", () => {
    expect(readTitle(makeHeader({ title: "TETRIS" }))).toBe("TETRIS");
  });

  it("replaces unprintable bytes with a dot", () => {
    const header = makeHeader({ title: "AB" });
    header[HeaderOffset.Title + 1] = 0x01;

    expect(readTitle(header)).toBe("A.");
  });

  it("does not show the CGB flag, which shares the title field", () => {
    // 0x143 is the last title byte on DMG carts and the CGB flag on colour ones
    expect(readTitle(makeHeader({ title: "LSDj-v9.4.2", cgb: 0x80 }))).toBe("LSDj-v9.4.2");
    expect(readTitle(makeHeader({ title: "POKEMON YELLOW!", cgb: 0x80 }))).toBe(
      "POKEMON YELLOW!",
    );
  });
});

describe("hardware support", () => {
  it.each([
    [0x00, 0x00, "DMG"],
    [0x00, 0x03, "DMG, SGB enhanced"],
    [0x80, 0x00, "CGB enhanced, DMG compatible"],
    [0x80, 0x03, "CGB enhanced, DMG compatible, SGB enhanced"],
    [0xc0, 0x00, "CGB only"],
    [0xc0, 0x03, "CGB only, SGB enhanced"],
  ])("reads CGB 0x%s / SGB 0x%s as %s", (cgb, sgb, expected) => {
    expect(readHardwareSupport(makeHeader({ cgb, sgb }))).toBe(expected);
  });
});

describe("sizes", () => {
  it.each([
    [0x00, "32 KB"],
    [0x05, "1024 KB"],
    [0x52, "1152 KB"],
  ])("decodes ROM size code 0x%s as %s", (code, expected) => {
    expect(readRomSize(makeHeader({ romSize: code }))).toBe(expected);
  });

  it("says so when the code is not one it knows", () => {
    expect(readRomSize(makeHeader({ romSize: 0x99 }))).toContain("unknown");
  });
});

describe("warnings", () => {
  it("catches SGB features that cannot work without licensee 33h", () => {
    const parsed = parseHeader(makeHeader({ sgb: 0x03, licensee: 0x00 }));
    expect(parsed.warnings.join(" ")).toContain("Old Licensee");
  });

  it("stays quiet on a healthy header", () => {
    expect(parseHeader(makeHeader({ sgb: 0x03, licensee: 0x33 })).warnings).toEqual([]);
  });
});
