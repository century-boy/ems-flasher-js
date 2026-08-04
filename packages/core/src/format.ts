/** Formatting helpers shared by the CLI and the web app, so both speak alike. */

const UNITS = ["B", "KiB", "MiB", "GiB"] as const;

/** Format a byte count in binary units, e.g. `4.0 MiB`. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }

  return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${UNITS[unit]}`;
}

/** Format a throughput, e.g. `42.0 KiB/s`. */
export function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** Format a duration as `mm:ss`, or `h:mm:ss` past an hour. */
export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return "--:--";
  }

  const whole = Math.round(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;

  const paddedSeconds = String(secs).padStart(2, "0");

  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${paddedSeconds}`
    : `${String(minutes).padStart(2, "0")}:${paddedSeconds}`;
}

/**
 * Parse a size written the way humans write it: `4096`, `0x8000`, `32k`, `4M`.
 *
 * @throws {RangeError} when the text is not a positive size
 */
export function parseSize(text: string): number {
  const cleaned = text.trim().toLowerCase().replace(/ib$/, "");
  const match = /^(0x[0-9a-f]+|\d+)([km])?$/.exec(cleaned);

  if (!match) {
    throw new RangeError(`invalid size: ${text}`);
  }

  const [, digits, suffix] = match;
  const value = Number(digits);
  const multiplier = suffix === "k" ? 1024 : suffix === "m" ? 1024 * 1024 : 1;
  const size = value * multiplier;

  if (!Number.isFinite(size) || size <= 0) {
    throw new RangeError(`size must be greater than zero: ${text}`);
  }

  return size;
}
