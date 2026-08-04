/** Turning cart data into DOM. Pure functions: no state, no side effects. */

import { formatBytes } from "@ems-flasher-js/core";
import type { BankUsage, RomEntry } from "@ems-flasher-js/core";

/**
 * The list of games the cart menu will show for a bank.
 *
 * `onRemove` is wired to each row; the caller decides whether to confirm.
 */
export function renderGameList(
  usage: BankUsage,
  actions: {
    onExtract: (rom: RomEntry) => void;
    onRemove: (rom: RomEntry) => void;
  },
): HTMLElement {
  const list = element("ul", "games");

  if (usage.roms.length === 0) {
    list.append(
      element(
        "li",
        "games__empty",
        "No ROM here that the menu would list. Write a menu ROM to the bank first.",
      ),
    );
    return list;
  }

  for (const rom of usage.roms) {
    const row = element("li", "game");

    const index = element("span", "game__index", String(rom.index));
    const title = element("span", "game__title", rom.header.title || "(blank)");
    const meta = element(
      "span",
      "game__meta",
      `${formatBytes(rom.size)} @ 0x${rom.offset.toString(16).padStart(6, "0")}`,
    );

    const save = button("Save", "button button--small", () => actions.onExtract(rom));
    save.title = `Download ${rom.header.title || "this ROM"} as a .gb file`;

    const remove = button("Remove", "button button--danger button--small", () =>
      actions.onRemove(rom),
    );
    remove.title = "Stop the cart menu listing this game";

    const controls = element("span", "game__actions");
    controls.append(save, remove);

    row.append(index, title, meta, controls);
    list.append(row);
  }

  return list;
}

/** One line summarising how full a bank is. */
export function describeUsage(usage: BankUsage): string {
  return (
    `${usage.roms.length} ROM${usage.roms.length === 1 ? "" : "s"} · ` +
    `${formatBytes(usage.used)} used · ${formatBytes(usage.free)} free`
  );
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = label;
  node.addEventListener("click", onClick);
  return node;
}

function element(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;

  if (text !== undefined) {
    node.textContent = text;
  }

  return node;
}
