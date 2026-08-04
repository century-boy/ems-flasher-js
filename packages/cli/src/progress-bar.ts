/**
 * The terminal progress bar.
 *
 * Draws on stderr so stdout stays clean for piping, and disables itself when
 * stderr is not a terminal (CI logs, `| tee`, redirects to a file).
 */

import { formatBytes, formatDuration, formatRate } from "@ems-flasher-js/core";
import type { TransferProgress } from "@ems-flasher-js/core";

/** Do not redraw more often than this, to avoid hammering the terminal. */
const REDRAW_INTERVAL_MS = 100;

/** Fall back to this width when the terminal will not say how wide it is. */
const FALLBACK_COLUMNS = 80;

export class ProgressBar {
  #lastDrawAt = 0;
  #drawn = false;

  constructor(
    private readonly label: string,
    private readonly enabled: boolean,
  ) {}

  /** True when the bar will actually draw anything. */
  static isSupported(stream: NodeJS.WriteStream = process.stderr): boolean {
    return stream.isTTY === true;
  }

  /** Draw the current state, throttled to {@link REDRAW_INTERVAL_MS}. */
  update(progress: TransferProgress): void {
    if (!this.enabled) {
      return;
    }

    const now = Date.now();
    if (this.#drawn && now - this.#lastDrawAt < REDRAW_INTERVAL_MS) {
      return;
    }
    this.#lastDrawAt = now;
    this.#drawn = true;

    this.#draw(progress, false);
  }

  /** Draw the finished state and end the line. */
  finish(progress: TransferProgress): void {
    if (!this.enabled) {
      return;
    }

    this.#draw(progress, true);
    process.stderr.write("\n");
  }

  /** Abandon the bar mid-transfer, leaving the partial line visible. */
  abandon(): void {
    if (this.enabled && this.#drawn) {
      process.stderr.write("\n");
    }
  }

  #draw(progress: TransferProgress, done: boolean): void {
    const stats =
      `${formatBytes(progress.done)}/${formatBytes(progress.total)} ` +
      `${formatRate(progress.bytesPerSecond)} ` +
      `${done ? "in" : "eta"} ` +
      `${formatDuration(done ? progress.elapsedSeconds : progress.etaSeconds)}`;

    const percentage = `${(progress.fraction * 100).toFixed(1).padStart(5)}%`;
    const columns = process.stderr.columns ?? FALLBACK_COLUMNS;
    const width = Math.max(columns - this.label.length - stats.length - 12, 10);

    const filled = Math.round(width * progress.fraction);
    const bar = "#".repeat(filled) + "-".repeat(width - filled);

    process.stderr.write(`\r${this.label} [${bar}] ${percentage} ${stats}`);
  }
}
