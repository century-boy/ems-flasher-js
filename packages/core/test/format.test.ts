import { describe, expect, it } from "vitest";

import { formatBytes, formatDuration, formatRate, parseSize } from "../src/index.js";

describe("parseSize", () => {
  it.each([
    ["4096", 4096],
    ["0x8000", 32768],
    ["32k", 32768],
    ["4M", 4 * 1024 * 1024],
    ["128KiB", 131072],
  ])("parses %s", (text, expected) => {
    expect(parseSize(text)).toBe(expected);
  });

  it.each(["", "0", "-5", "12x", "kk", "1.5M"])("rejects %s", (text) => {
    expect(() => parseSize(text)).toThrow(RangeError);
  });
});

describe("formatBytes", () => {
  it.each([
    [512, "512 B"],
    [1024, "1.0 KiB"],
    [131072, "128.0 KiB"],
    [4 * 1024 * 1024, "4.0 MiB"],
  ])("formats %i as %s", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  it("formats a rate with a unit per second", () => {
    expect(formatRate(43008)).toBe("42.0 KiB/s");
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "00:00"],
    [59, "00:59"],
    [95, "01:35"],
    [3725, "1:02:05"],
  ])("formats %i seconds as %s", (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });

  it("shows placeholders when there is nothing to estimate yet", () => {
    expect(formatDuration(undefined)).toBe("--:--");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("--:--");
  });
});
