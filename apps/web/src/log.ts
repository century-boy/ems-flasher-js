/** The on-screen console. Doubles as the app's error reporting. */

export type LogKind = "info" | "success" | "error";

/** Number of lines kept on screen before the oldest ones are dropped. */
const MAX_LINES = 200;

export class Log {
  /**
   * @param element where lines are appended
   * @param container the collapsed panel holding it; opened on the first
   *   error, because an error nobody can see is not reported
   */
  constructor(
    private readonly element: HTMLElement,
    private readonly container?: HTMLDetailsElement,
  ) {}

  info(message: string): void {
    this.#append(message, "info");
  }

  success(message: string): void {
    this.#append(message, "success");
  }

  error(message: string): void {
    this.#append(message, "error");

    if (this.container) {
      this.container.open = true;
    }
  }

  #append(message: string, kind: LogKind): void {
    const line = document.createElement("div");
    line.className = `log__line log__line--${kind}`;
    line.textContent = `${timestamp()} ${message}`;

    this.element.append(line);

    while (this.element.childElementCount > MAX_LINES) {
      this.element.firstElementChild?.remove();
    }

    // Keep the newest line in view.
    this.element.scrollTop = this.element.scrollHeight;
  }
}

function timestamp(): string {
  const now = new Date();
  const parts = [now.getHours(), now.getMinutes(), now.getSeconds()].map((part) =>
    String(part).padStart(2, "0"),
  );

  return `[${parts.join(":")}]`;
}
