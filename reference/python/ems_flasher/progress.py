"""A small progress bar for the long ROM/SRAM transfers.

Writing 4 MiB in 32 byte blocks takes minutes, so every read/write shows a
live bar on stderr. Output goes to stderr to keep stdout clean for piping,
and it disables itself automatically when stderr is not a terminal.
"""

from __future__ import annotations

import shutil
import sys
import time
from types import TracebackType


def format_size(num_bytes: float) -> str:
    """Format a byte count using binary units, e.g. ``4.0 MiB``."""
    for unit in ("B", "KiB", "MiB", "GiB"):
        if abs(num_bytes) < 1024 or unit == "GiB":
            if unit == "B":
                return f"{int(num_bytes)} {unit}"
            return f"{num_bytes:.1f} {unit}"
        num_bytes /= 1024
    raise AssertionError("unreachable")


def _format_duration(seconds: float) -> str:
    if seconds < 0 or seconds > 359999:  # ~100 hours, treat as unknown
        return "--:--"
    minutes, secs = divmod(int(seconds), 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours:d}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


class Progress:
    """Render a single-line progress bar for a transfer of ``total`` bytes.

    Usable as a context manager::

        with Progress("Reading ROM", total, enabled=True) as bar:
            bar.advance(len(chunk))

    When ``enabled`` is False every method is a no-op, so callers do not
    need to special-case quiet mode.
    """

    #: minimum seconds between redraws, to avoid hammering the terminal
    REDRAW_INTERVAL = 0.1

    def __init__(self, label: str, total: int, enabled: bool = True) -> None:
        self.label = label
        self.total = max(total, 1)
        self.enabled = enabled and sys.stderr.isatty()
        self.done = 0
        self._start = time.monotonic()
        self._last_draw = 0.0
        self._finished = False

    def __enter__(self) -> Progress:
        if self.enabled:
            self._draw(force=True)
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        # on failure leave the partial bar in place, followed by a newline
        self.finish(success=exc_type is None)

    def advance(self, count: int) -> None:
        """Account for ``count`` more bytes transferred and redraw."""
        self.done += count
        if self.enabled:
            self._draw()

    def finish(self, success: bool = True) -> None:
        """Draw the final state and end the line."""
        if not self.enabled or self._finished:
            return
        self._finished = True
        self._draw(force=True, final=success)
        sys.stderr.write("\n")
        sys.stderr.flush()

    # -- rendering ---------------------------------------------------

    def _draw(self, force: bool = False, final: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self._last_draw < self.REDRAW_INTERVAL:
            return
        self._last_draw = now

        elapsed = max(now - self._start, 1e-6)
        fraction = 1.0 if final else min(self.done / self.total, 1.0)
        rate = self.done / elapsed
        eta = (self.total - self.done) / rate if rate > 0 and not final else 0.0

        stats = (
            f"{format_size(self.done)}/{format_size(self.total)} "
            f"{format_size(rate)}/s "
            f"{'in' if final else 'eta'} "
            f"{_format_duration(elapsed if final else eta)}"
        )

        # bar width = terminal minus label, percentage, stats and padding
        columns = shutil.get_terminal_size(fallback=(80, 24)).columns
        width = columns - len(self.label) - len(stats) - 12
        width = max(width, 10)

        filled = int(width * fraction)
        bar = "#" * filled + "-" * (width - filled)

        sys.stderr.write(f"\r{self.label} [{bar}] {fraction * 100:5.1f}% {stats}")
        sys.stderr.flush()
