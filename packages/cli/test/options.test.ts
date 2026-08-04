import { describe, expect, it } from "vitest";

import { parseOptions, UsageError } from "../src/options.js";

describe("mode", () => {
  it.each([
    [["--read", "out.gb"], "read"],
    [["--write", "in.gb"], "write"],
    [["--title"], "title"],
    [["-r", "out.gb"], "read"],
    [["-w", "in.gb"], "write"],
    [["-t"], "title"],
  ])("parses %s", (argv, expected) => {
    expect(parseOptions(argv).mode).toBe(expected);
  });

  it.each([
    [[]],
    [["--read", "--write", "f.gb"]],
    [["--read", "--title"]],
  ])("rejects %s", (argv) => {
    expect(() => parseOptions(argv)).toThrow(UsageError);
  });
});

describe("file argument", () => {
  it("requires a file for read and write", () => {
    expect(() => parseOptions(["--read"])).toThrow(/output file/);
    expect(() => parseOptions(["--write"])).toThrow(/input file/);
  });

  it("refuses a file for title", () => {
    expect(() => parseOptions(["--title", "extra.gb"])).toThrow(/no file/);
  });

  it("refuses a second file", () => {
    expect(() => parseOptions(["--write", "a.gb", "b.gb"])).toThrow(/extra argument/);
  });
});

describe("bank", () => {
  it("defaults to bank 1", () => {
    expect(parseOptions(["--read", "out.gb"]).bank).toBe(1);
  });

  it("accepts the two banks the cart has", () => {
    expect(parseOptions(["--read", "--bank", "2", "out.gb"]).bank).toBe(2);
    expect(parseOptions(["--read", "-b", "1", "out.gb"]).bank).toBe(1);
  });

  it.each(["0", "3", "-1", "two"])("rejects --bank %s", (value) => {
    expect(() => parseOptions(["--read", "--bank", value, "out.gb"])).toThrow(UsageError);
  });
});

describe("address space", () => {
  it("is left to the file name unless forced", () => {
    expect(parseOptions(["--write", "game.sav"]).space).toBeUndefined();
  });

  it("can be forced either way", () => {
    expect(parseOptions(["--write", "--rom", "game.sav"]).space).toBe("rom");
    expect(parseOptions(["--write", "--save", "game.gb"]).space).toBe("sram");
  });

  it("refuses both at once", () => {
    expect(() => parseOptions(["--write", "--rom", "--save", "f.gb"])).toThrow(UsageError);
  });
});

describe("block size", () => {
  it("defaults per direction", () => {
    expect(parseOptions(["--read", "out.gb"]).blockSize).toBe(4096);
    expect(parseOptions(["--write", "in.gb"]).blockSize).toBe(32);
  });

  it("accepts an override", () => {
    expect(parseOptions(["--write", "-s", "512", "in.gb"]).blockSize).toBe(512);
  });

  it.each(["0", "-8", "abc"])("rejects --blocksize %s", (value) => {
    expect(() => parseOptions(["--read", "--blocksize", value, "o.gb"])).toThrow(UsageError);
  });
});

describe("size", () => {
  it("accepts human sizes", () => {
    expect(parseOptions(["--read", "--size", "32k", "o.sav"]).size).toBe(32768);
    expect(parseOptions(["--read", "-n", "0x8000", "o.sav"]).size).toBe(32768);
  });

  it("rejects nonsense", () => {
    expect(() => parseOptions(["--read", "--size", "0", "o.sav"])).toThrow(UsageError);
  });
});

describe("timeout", () => {
  it("defaults to ten seconds", () => {
    expect(parseOptions(["--title"]).timeoutMs).toBe(10_000);
  });

  it("accepts zero, meaning wait forever", () => {
    expect(parseOptions(["--title", "--timeout", "0"]).timeoutMs).toBe(0);
  });

  it("rejects a negative timeout", () => {
    expect(() => parseOptions(["--title", "--timeout", "-1"])).toThrow(UsageError);
  });
});

describe("flags", () => {
  it("reads the remaining switches", () => {
    const options = parseOptions(["--write", "--truncate", "--verbose", "--no-progress", "f.gb"]);

    expect(options.truncate).toBe(true);
    expect(options.verbose).toBe(true);
    expect(options.progress).toBe(false);
  });

  it("rejects unknown options", () => {
    expect(() => parseOptions(["--read", "--wat", "f.gb"])).toThrow(/unknown option/);
  });

  it("rejects a flag with a missing value", () => {
    expect(() => parseOptions(["--read", "--bank"])).toThrow(/needs a value/);
  });
});
