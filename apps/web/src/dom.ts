/** Typed DOM lookups, so the rest of the app never deals with `null`. */

/**
 * Find an element by id, or fail loudly.
 *
 * A missing id means the markup and the code disagree, which is a bug to fix
 * at build time rather than a case to handle at runtime.
 */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);

  if (element === null) {
    throw new Error(`missing element #${id}`);
  }

  return element as T;
}

/** Show or hide an element via the `hidden` attribute. */
export function setVisible(element: HTMLElement, visible: boolean): void {
  element.hidden = !visible;
}

/** Read the value of a radio group, e.g. the bank selector. */
export function radioValue(name: string): string | undefined {
  const checked = document.querySelector<HTMLInputElement>(
    `input[name="${name}"]:checked`,
  );

  return checked?.value;
}

/** Hand the user a file without a server: an object URL and a synthetic click. */
export function downloadBytes(fileName: string, bytes: Uint8Array): void {
  const blob = new Blob([bytes as unknown as BlobPart], {
    type: "application/octet-stream",
  });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();

  // Give the browser a moment to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
