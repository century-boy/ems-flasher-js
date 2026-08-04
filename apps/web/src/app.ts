/**
 * The application: wiring the DOM to the cart.
 *
 * Every byte stays on the machine — the page has no backend to send anything
 * to. The browser hands us a `USBDevice`, `@ems-flasher-js/core` does the
 * talking, and the DOM shows what happened.
 */

import {
  AbortedError,
  BANK_SIZE,
  EMS_USB_FILTER,
  EmsCart,
  EmsError,
  FileTooLargeError,
  SRAM_SIZE,
  detectSpace,
  formatBytes,
  formatDuration,
  planAdd,
  readCart,
  removeRom,
  scanBank,
  spaceSize,
  writeCart,
} from "@ems-flasher-js/core";
import type {
  AddressSpace,
  BankNumber,
  BankUsage,
  RomEntry,
} from "@ems-flasher-js/core";

import { byId, downloadBytes, radioValue, setVisible } from "./dom.js";
import { Log } from "./log.js";
import { ProgressMeter } from "./progress-meter.js";
import { Tabs } from "./tabs.js";
import { describeUsage, renderGameList } from "./render.js";

/** The file the user picked, kept in memory until they flash it. */
interface LoadedFile {
  name: string;
  bytes: Uint8Array;
}

export class FlasherApp {
  readonly #log = new Log(byId("log"), byId<HTMLDetailsElement>("log-details"));
  readonly #tabs = new Tabs(["tab-games", "tab-write", "tab-backup"]);
  readonly #meter = new ProgressMeter(
    byId("progress-panel"),
    byId("progress-label"),
    byId("meter"),
    byId("meter-fill"),
    byId("meter-text"),
    byId("progress-stats"),
  );

  readonly #status = byId("status");
  readonly #panels = {
    connect: byId("connect-panel"),
    workspace: byId("workspace"),
    unsupported: byId("unsupported"),
  };

  /** Only meaningful once a cart is connected, so hidden until then. */
  readonly #bankPicker = byId("bank-picker");
  readonly #connectHint = byId("connect-hint");

  readonly #buttons = {
    connect: byId<HTMLButtonElement>("connect"),
    disconnect: byId<HTMLButtonElement>("disconnect"),
    scan: byId<HTMLButtonElement>("scan"),
    write: byId<HTMLButtonElement>("write"),
    add: byId<HTMLButtonElement>("add"),
    dumpRom: byId<HTMLButtonElement>("dump-rom"),
    dumpSram: byId<HTMLButtonElement>("dump-sram"),
    abort: byId<HTMLButtonElement>("abort"),
  };

  #cart: EmsCart | undefined;
  #file: LoadedFile | undefined;
  #transfer: AbortController | undefined;
  /** The last scan of the selected bank, refreshed whenever it changes. */
  #usage: BankUsage | undefined;

  /** Wire everything up and report whether this browser can play at all. */
  start(): void {
    if (!("usb" in navigator)) {
      setVisible(this.#panels.unsupported, true);
      setVisible(this.#panels.connect, false);
      this.#log.error("WebUSB is not available in this browser.");
      return;
    }

    this.#wireConnection();
    this.#wireFilePicking();
    this.#wireTransfers();
    this.#warnBeforeLeavingMidWrite();

    this.#log.info("Ready — connect the cart.");
  }

  // ---------------------------------------------------------------- wiring

  #wireConnection(): void {
    this.#buttons.connect.addEventListener("click", () => {
      void this.#connect();
    });

    this.#buttons.disconnect.addEventListener("click", () => {
      void this.#disconnect();
    });

    // A scan belongs to one bank, so switching banks re-scans right away.
    for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="bank"]')) {
      radio.addEventListener("change", () => {
        this.#clearScan();
        void this.#scanGames();
      });
    }

    // The cart being yanked out mid-session is normal; recover gracefully.
    navigator.usb.addEventListener("disconnect", () => {
      if (this.#cart) {
        this.#log.error("The cart was unplugged.");
        void this.#disconnect();
      }
    });
  }

  #wireFilePicking(): void {
    const input = byId<HTMLInputElement>("file");
    const dropzone = byId("dropzone");

    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file) {
        void this.#loadFile(file);
      }
    });

    // Keyboard users get the same affordance as the click target.
    dropzone.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        input.click();
      }
    });

    dropzone.addEventListener("dragover", (event) => {
      event.preventDefault();
      dropzone.classList.add("is-hover");
    });

    dropzone.addEventListener("dragleave", () => {
      dropzone.classList.remove("is-hover");
    });

    dropzone.addEventListener("drop", (event) => {
      event.preventDefault();
      dropzone.classList.remove("is-hover");

      const file = event.dataTransfer?.files[0];
      if (file) {
        void this.#loadFile(file);
      }
    });
  }

  #wireTransfers(): void {
    this.#buttons.write.addEventListener("click", () => {
      void this.#write();
    });

    this.#buttons.scan.addEventListener("click", () => {
      void this.#scanGames();
    });

    this.#buttons.add.addEventListener("click", () => {
      void this.#addGame();
    });

    this.#buttons.dumpRom.addEventListener("click", () => {
      void this.#dump("rom");
    });

    this.#buttons.dumpSram.addEventListener("click", () => {
      void this.#dump("sram");
    });

    this.#buttons.abort.addEventListener("click", () => {
      this.#transfer?.abort();
      this.#log.info("Stopping…");
    });
  }

  /**
   * Closing the tab mid-write leaves the bank half programmed, so ask first.
   * Browsers only honour this while a transfer is actually running.
   */
  #warnBeforeLeavingMidWrite(): void {
    window.addEventListener("beforeunload", (event) => {
      if (this.#transfer) {
        event.preventDefault();
      }
    });
  }

  // ------------------------------------------------------------ connection

  async #connect(): Promise<void> {
    try {
      this.#setStatus("busy", "Asking…");

      const device = await navigator.usb.requestDevice({
        filters: [{ ...EMS_USB_FILTER }],
      });

      this.#cart = await EmsCart.open(device);

      this.#setStatus("ready", "Cart ready");
      this.#log.success("Connected to the cart.");

      setVisible(this.#buttons.disconnect, true);
      this.#buttons.connect.disabled = true;
      setVisible(this.#bankPicker, true);
      setVisible(this.#connectHint, false);
      setVisible(this.#panels.workspace, true);

      // Show what is on the selected bank without making the user ask.
      await this.#scanGames();
    } catch (error) {
      // A cancelled chooser is a normal user action, not a failure.
      if (error instanceof DOMException && error.name === "NotFoundError") {
        this.#setStatus("idle", "No cart");
        this.#log.info("No cart selected.");
        return;
      }

      this.#setStatus("error", "Failed");
      this.#reportError(error, "Could not connect");
    }
  }

  async #disconnect(): Promise<void> {
    await this.#cart?.close();
    this.#cart = undefined;

    this.#setStatus("idle", "No cart");
    this.#buttons.connect.disabled = false;
    setVisible(this.#buttons.disconnect, false);
    setVisible(this.#bankPicker, false);
    setVisible(this.#connectHint, true);
    setVisible(this.#panels.workspace, false);
    this.#tabs.select(0);
    this.#clearScan();
    this.#meter.hide();

    this.#log.info("Disconnected.");
  }

  // ----------------------------------------------------------------- files

  async #loadFile(file: File): Promise<void> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    this.#file = { name: file.name, bytes };

    const space = detectSpace(file.name);
    const capacity = spaceSize(space);
    const fits = bytes.length <= capacity;

    byId("dropzone").classList.add("is-loaded");
    byId("dropzone-label").innerHTML =
      `<strong>${escapeHtml(file.name)}</strong> · ${formatBytes(bytes.length)} · ` +
      `${space === "sram" ? "save file" : "ROM"}`;

    this.#updateWriteButtons();
    this.#buttons.write.disabled = !fits;

    if (fits) {
      this.#log.info(`Loaded ${file.name} (${formatBytes(bytes.length)}).`);
    } else {
      this.#log.error(
        `${file.name} is ${formatBytes(bytes.length)}, but the target holds ` +
          `only ${formatBytes(capacity)}.`,
      );
    }
  }

  // ------------------------------------------------------------- transfers

  async #write(): Promise<void> {
    const cart = this.#requireCart();
    const file = this.#file;

    if (!file) {
      return;
    }

    const bank = this.#selectedBank();
    const space = this.#selectedWriteSpace(file.name);
    const target = space === "sram" ? "SRAM" : `ROM bank ${bank}`;

    if (space === "sram" && bank !== 1) {
      this.#log.info("SRAM is shared by both banks, so the bank choice is ignored.");
    }

    await this.#runTransfer(`Writing ${target}`, async (signal) => {
      const result = await writeCart(cart, file.bytes, {
        space,
        bank,
        signal,
        onProgress: (progress) => this.#meter.update(progress),
      });

      this.#log.success(
        `Wrote ${formatBytes(result.bytes)} to ${target} in ` +
          `${formatDuration(result.seconds)}.`,
      );
      this.#meter.finish(`Done — ${formatBytes(result.bytes)} written.`);

      // What is on the bank just changed: re-scan and show it.
      if (space === "rom") {
        await this.#scanInto(cart, bank);
        this.#tabs.select(0);
      }
    });
  }

  async #dump(space: AddressSpace): Promise<void> {
    const cart = this.#requireCart();
    const bank = this.#selectedBank();
    const target = space === "sram" ? "SRAM" : `ROM bank ${bank}`;
    const size = space === "sram" ? SRAM_SIZE : BANK_SIZE;

    this.#log.info(`Dumping ${target} (${formatBytes(size)})…`);

    await this.#runTransfer(`Reading ${target}`, async (signal) => {
      const result = await readCart(cart, {
        space,
        bank,
        signal,
        onProgress: (progress) => this.#meter.update(progress),
      });

      if (result.data) {
        const name = space === "sram" ? "cart-save.sav" : `cart-bank${bank}.gb`;
        downloadBytes(name, result.data);
        this.#log.success(
          `Dumped ${formatBytes(result.bytes)} in ${formatDuration(result.seconds)} ` +
            `— saved as ${name}.`,
        );
        this.#meter.finish(`Done — ${formatBytes(result.bytes)} downloaded.`);
      }
    });
  }

  /**
   * Run one cart operation at a time, keeping the UI honest: buttons disabled,
   * meter visible, abort wired, screen kept awake for the long ones.
   */
  async #runTransfer(
    label: string,
    operation: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    if (this.#transfer) {
      this.#log.error("Another transfer is already running.");
      return;
    }

    const controller = new AbortController();
    this.#transfer = controller;
    this.#setBusy(true);
    this.#meter.start(label);
    this.#setStatus("busy", "Working");

    const wakeLock = await requestWakeLock();

    try {
      await operation(controller.signal);
      this.#setStatus("ready", "Cart ready");
    } catch (error) {
      if (error instanceof AbortedError) {
        this.#log.error(error.message);
        this.#meter.finish("Stopped.");
      } else {
        this.#reportError(error, "Transfer failed");
        this.#meter.finish("Failed.");
      }
      this.#setStatus("error", "Failed");
    } finally {
      await wakeLock?.release().catch(() => undefined);
      this.#transfer = undefined;
      this.#setBusy(false);
    }
  }

  // ----------------------------------------------------------- multi-game

  /** Scan the selected bank and show what the cart menu would list. */
  async #scanGames(): Promise<void> {
    const cart = this.#requireCart();
    const bank = this.#selectedBank();

    await this.#runTransfer(`Scanning bank ${bank}`, async () => {
      const usage = await this.#scanInto(cart, bank);
      this.#meter.finish(describeUsage(usage));
    });
  }

  /**
   * Scan a bank, show the result and return it.
   *
   * Callable from inside another transfer, so adding a game can scan first
   * without the user having pressed anything.
   */
  async #scanInto(cart: EmsCart, bank: BankNumber): Promise<BankUsage> {
    const usage = await scanBank(cart, bank, (slot, total) => {
      this.#meter.update({
        done: slot,
        total,
        fraction: slot / total,
        bytesPerSecond: 0,
        elapsedSeconds: 0,
        etaSeconds: undefined,
      });
    });

    this.#showScan(usage);
    this.#log.success(`Bank ${bank}: ${describeUsage(usage)}.`);

    return usage;
  }

  /** Download one game out of a multi-game bank as a working ROM file. */
  async #extractGame(entry: RomEntry): Promise<void> {
    const cart = this.#requireCart();
    const bank = this.#selectedBank();
    const title = entry.header.title || "rom";

    await this.#runTransfer(`Saving ${title}`, async (signal) => {
      const result = await readCart(cart, {
        bank,
        startOffset: entry.offset,
        size: entry.size,
        signal,
        onProgress: (progress) => this.#meter.update(progress),
      });

      if (result.data) {
        downloadBytes(fileNameFor(entry), result.data);
        this.#log.success(
          `Saved ${title} — ${formatBytes(result.bytes)} in ` +
            `${formatDuration(result.seconds)}.`,
        );
        this.#meter.finish(`Saved ${formatBytes(result.bytes)}.`);
      }
    });
  }

  /**
   * Add the loaded ROM to the selected bank, leaving the other games alone.
   *
   * Needs a scan first: where a ROM can go depends on what is already there.
   */
  async #addGame(): Promise<void> {
    const cart = this.#requireCart();
    const file = this.#file;

    if (!file) {
      return;
    }

    const bank = this.#selectedBank();

    await this.#runTransfer(`Adding to bank ${bank}`, async (signal) => {
      // Where a ROM can go depends on what is already there, so make sure we
      // know — scanning ourselves rather than making the user do it first.
      const usage = this.#usage ?? (await this.#scanInto(cart, bank));

      // Throws here, before anything is written, if it cannot be placed.
      const placement = planAdd(usage, file.bytes);

      this.#log.info(
        `Placing ${file.name} at 0x${placement.offset.toString(16)} on bank ${bank}.`,
      );

      const result = await writeCart(cart, file.bytes, {
        space: "rom",
        bank,
        startOffset: placement.offset,
        signal,
        onProgress: (progress) => this.#meter.update(progress),
      });

      this.#log.success(
        `Added ${formatBytes(result.bytes)} in ${formatDuration(result.seconds)}.`,
      );
      this.#meter.finish(`Added ${formatBytes(result.bytes)}.`);

      await this.#refreshScan(cart, bank);
      this.#tabs.select(0);
    });
  }

  /** Drop a game from the menu, after asking: it is not undoable. */
  async #removeGame(entry: RomEntry): Promise<void> {
    const cart = this.#requireCart();
    const bank = this.#selectedBank();
    const title = entry.header.title || "(blank)";

    const confirmed = window.confirm(
      `Remove "${title}" (${formatBytes(entry.size)}) from bank ${bank}?\n\n` +
        "The cart menu will stop listing it and the space becomes reusable.",
    );

    if (!confirmed) {
      return;
    }

    await this.#runTransfer(`Removing from bank ${bank}`, async () => {
      await removeRom(cart, entry);
      this.#log.success(`Removed "${title}", freeing ${formatBytes(entry.size)}.`);
      this.#meter.finish("Removed.");

      await this.#refreshScan(cart, bank);
    });
  }

  /** Re-scan after a change, so the list on screen matches the cart. */
  async #refreshScan(cart: EmsCart, bank: BankNumber): Promise<void> {
    this.#showScan(await scanBank(cart, bank));
  }

  /** Put a scan on screen and remember it for the next --add. */
  #showScan(usage: BankUsage): void {
    this.#usage = usage;

    const container = byId("games");
    container.textContent = "";
    container.append(
      renderGameList(usage, {
        onExtract: (rom) => void this.#extractGame(rom),
        onRemove: (rom) => void this.#removeGame(rom),
      }),
    );

    byId("games-usage").textContent = describeUsage(usage);
    this.#updateWriteButtons();
  }

  /** Forget the scan when it no longer describes the selected bank. */
  #clearScan(): void {
    this.#usage = undefined;

    byId("games").textContent = "";
    byId("games-usage").textContent = "Not scanned yet";
    this.#updateWriteButtons();
  }

  /**
   * Both write actions need a file; adding also needs it to be a ROM, since
   * the cart menu only lists ROMs and a save has nowhere to go in a bank.
   */
  #updateWriteButtons(busy = false): void {
    const file = this.#file;
    const isRom = file !== undefined && detectSpace(file.name) === "rom";

    this.#buttons.write.disabled = busy || !file;
    this.#buttons.add.disabled = busy || !isRom;
    this.#buttons.add.title = isRom
      ? "Place this ROM in the first free slot on the selected bank"
      : "Load a ROM file first — save files cannot be added to a bank";
  }

  // ------------------------------------------------------------- utilities

  #requireCart(): EmsCart {
    if (!this.#cart) {
      throw new Error("no cart connected");
    }
    return this.#cart;
  }

  #selectedBank(): BankNumber {
    return radioValue("bank") === "2" ? 2 : 1;
  }

  /** Honour the Auto/ROM/Save choice, falling back to the file name. */
  #selectedWriteSpace(fileName: string): AddressSpace {
    const choice = radioValue("write-space");

    if (choice === "rom" || choice === "sram") {
      return choice;
    }

    return detectSpace(fileName);
  }

  #setBusy(busy: boolean): void {
    this.#updateWriteButtons(busy);
    this.#buttons.scan.disabled = busy;
    this.#buttons.dumpRom.disabled = busy;
    this.#buttons.dumpSram.disabled = busy;
    this.#buttons.disconnect.disabled = busy;
  }

  #setStatus(kind: "idle" | "busy" | "ready" | "error", text: string): void {
    this.#status.className = `status status--${kind}`;
    this.#status.textContent = text;
  }

  /** Turn an unknown thrown value into a line the user can act on. */
  #reportError(error: unknown, context: string): void {
    if (error instanceof FileTooLargeError) {
      this.#log.error(`${context}: ${error.message}`);
      return;
    }

    if (error instanceof EmsError) {
      this.#log.error(`${context}: ${error.message}`);
      return;
    }

    if (error instanceof DOMException) {
      // WebUSB reports "cannot have it" in a few different flavours; each one
      // has a different fix, so spell it out instead of echoing the raw name.
      if (error.name === "SecurityError") {
        this.#log.error(
          `${context}: the browser refused access to the device. On Windows the ` +
            "cart needs the WinUSB driver (install it with Zadig).",
        );
        return;
      }

      if (error.name === "NetworkError" || error.name === "InvalidStateError") {
        this.#log.error(
          `${context}: the cart is busy. Close anything else talking to it ` +
            "(a running ems-flasher, another tab), unplug it, plug it back in " +
            "and connect again.",
        );
        return;
      }
    }

    this.#log.error(`${context}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** "TRIP WORLD" becomes "trip-world.gb". */
function fileNameFor(entry: RomEntry): string {
  const slug = (entry.header.title || "rom")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  const extension = entry.header.hardware.startsWith("CGB") ? "gbc" : "gb";

  return `${slug || "rom"}.${extension}`;
}

/** Keep the screen awake during a multi-minute flash, where supported. */
async function requestWakeLock(): Promise<WakeLockSentinel | undefined> {
  try {
    return await navigator.wakeLock?.request("screen");
  } catch {
    // Not supported, or denied because the tab is hidden: not worth reporting.
    return undefined;
  }
}

/** Escape a file name before it goes anywhere near innerHTML. */
function escapeHtml(text: string): string {
  const element = document.createElement("span");
  element.textContent = text;
  return element.innerHTML;
}
