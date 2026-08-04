/**
 * The on-screen progress meter.
 *
 * It renders the same {@link TransferProgress} snapshots the CLI bar consumes,
 * so both agree on percentage, throughput and ETA.
 */

import { formatBytes, formatDuration, formatRate } from "@ems-flasher-js/core";
import type { TransferProgress } from "@ems-flasher-js/core";

import { setVisible } from "./dom.js";

export class ProgressMeter {
  constructor(
    private readonly panel: HTMLElement,
    private readonly label: HTMLElement,
    private readonly meter: HTMLElement,
    private readonly fill: HTMLElement,
    private readonly text: HTMLElement,
    private readonly stats: HTMLElement,
  ) {}

  /**
   * Show the meter, zeroed, for a named operation.
   *
   * The controls that start a transfer can be a long way up the page — the
   * Save button of the last game in a list, say — so bring the meter into
   * view rather than leaving the user wondering whether anything happened.
   */
  start(label: string): void {
    this.label.textContent = label;
    this.stats.textContent = "starting…";
    this.#paint(0);
    setVisible(this.panel, true);

    this.panel.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "center",
    });
  }

  /** Draw a progress snapshot. */
  update(progress: TransferProgress): void {
    this.#paint(progress.fraction);

    this.stats.textContent =
      `${formatBytes(progress.done)} / ${formatBytes(progress.total)} · ` +
      `${formatRate(progress.bytesPerSecond)} · ` +
      `eta ${formatDuration(progress.etaSeconds)}`;
  }

  /** Leave the meter showing a final message. */
  finish(message: string): void {
    this.#paint(1);
    this.stats.textContent = message;
  }

  /** Hide the meter entirely. */
  hide(): void {
    setVisible(this.panel, false);
  }

  #paint(fraction: number): void {
    const percentage = Math.round(fraction * 100);

    this.fill.style.width = `${fraction * 100}%`;
    this.text.textContent = `${percentage}%`;
    this.meter.setAttribute("aria-valuenow", String(percentage));
  }
}

/** Smooth scrolling makes some people ill; the system setting says so. */
function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
