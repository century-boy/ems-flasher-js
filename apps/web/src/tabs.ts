/**
 * The tab strip.
 *
 * Follows the ARIA authoring practice for tabs: one tab in the focus order,
 * arrow keys move between them, and the panels are hidden rather than merely
 * scrolled past — which is the point, since the page exists to be short.
 */

import { byId, setVisible } from "./dom.js";

/** A tab and the panel it reveals. */
interface Tab {
  button: HTMLButtonElement;
  panel: HTMLElement;
}

export class Tabs {
  readonly #tabs: Tab[];

  /**
   * @param ids tab element ids, in the order they appear; each tab's
   *   `aria-controls` names its panel
   */
  constructor(ids: readonly string[]) {
    this.#tabs = ids.map((id) => {
      const button = byId<HTMLButtonElement>(id);
      const panelId = button.getAttribute("aria-controls");

      if (panelId === null) {
        throw new Error(`tab #${id} has no aria-controls`);
      }

      return { button, panel: byId(panelId) };
    });

    for (const [index, tab] of this.#tabs.entries()) {
      tab.button.addEventListener("click", () => this.select(index));
      tab.button.addEventListener("keydown", (event) => this.#onKeyDown(event, index));
    }
  }

  /** Show one tab's panel and hide the others. */
  select(index: number): void {
    this.#tabs.forEach((tab, position) => {
      const selected = position === index;

      tab.button.setAttribute("aria-selected", String(selected));
      // Only the selected tab stays in the focus order; arrows do the rest.
      tab.button.tabIndex = selected ? 0 : -1;
      setVisible(tab.panel, selected);
    });
  }

  /** Bring a tab to the front and move focus to it, e.g. after an error. */
  focus(index: number): void {
    this.select(index);
    this.#tabs[index]?.button.focus();
  }

  #onKeyDown(event: KeyboardEvent, index: number): void {
    const last = this.#tabs.length - 1;

    const target = {
      ArrowLeft: index === 0 ? last : index - 1,
      ArrowRight: index === last ? 0 : index + 1,
      Home: 0,
      End: last,
    }[event.key];

    if (target === undefined) {
      return;
    }

    event.preventDefault();
    this.focus(target);
  }
}
