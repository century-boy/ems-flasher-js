/**
 * Command line parsing.
 *
 * Hand-rolled rather than pulled from npm: the flag set is small, it has to
 * stay byte-compatible with the original C flasher, and every dependency here
 * is one the user has to install before they can flash a cart.
 */

import { DEFAULT_BLOCK_SIZE, isBankNumber, parseSize } from "@ems-flasher-js/core";
import type { AddressSpace, BankNumber } from "@ems-flasher-js/core";

/** What the user asked the flasher to do. */
export type Mode = "read" | "write" | "title" | "list" | "add" | "delete" | "extract";

/** A fully validated command line. */
export interface Options {
  mode: Mode;
  /** File to write to the cart, or to dump the cart into. */
  file: string | undefined;
  /** ROM bank to work on. Ignored for SRAM, which both banks share. */
  bank: BankNumber;
  /** Forced address space, or `undefined` to guess it from the file name. */
  space: AddressSpace | undefined;
  /** Bytes per USB transfer. */
  blockSize: number;
  /** How many bytes to read; `undefined` means the whole space. */
  size: number | undefined;
  /** Per-transfer USB timeout in milliseconds; 0 waits forever. */
  timeoutMs: number;
  /** Allow an oversized file to be cut short instead of refusing it. */
  truncate: boolean;
  /** Print extra detail. */
  verbose: boolean;
  /** Draw the progress bar (also needs stderr to be a TTY). */
  progress: boolean;
  /** Which ROM --delete or --extract works on; an index from --list. */
  romIndex: number | undefined;
}

/** Raised for anything the user can fix by retyping the command. */
export class UsageError extends Error {}

/** Flags that take a value, mapped to how that value is parsed. */
const DEFAULT_TIMEOUT_SECONDS = 10;

/**
 * Parse `argv` (without `node` and the script path) into {@link Options}.
 *
 * @throws {UsageError} on anything the user should fix
 */
export function parseOptions(argv: readonly string[]): Options {
  let mode: Mode | undefined;
  let file: string | undefined;
  let bank: BankNumber = 1;
  let space: AddressSpace | undefined;
  let blockSize: number | undefined;
  let size: number | undefined;
  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  let truncate = false;
  let verbose = false;
  let progress = true;
  let romIndex: number | undefined;

  /** Consume the value that follows a flag, e.g. `--bank 2`. */
  const valueFor = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("-")) {
      throw new UsageError(`${flag} needs a value`);
    }
    return value;
  };

  const setMode = (next: Mode): void => {
    if (mode !== undefined && mode !== next) {
      throw new UsageError(
      "supply exactly one of --read, --write, --title, --list, --add or --delete",
    );
    }
    mode = next;
  };

  const setSpace = (next: AddressSpace): void => {
    if (space !== undefined && space !== next) {
      throw new UsageError("supply at most one of --rom or --save");
    }
    space = next;
  };

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] as string;

    switch (argument) {
      case "-r":
      case "--read":
        setMode("read");
        break;

      case "-w":
      case "--write":
        setMode("write");
        break;

      case "-t":
      case "--title":
        setMode("title");
        break;

      case "-l":
      case "--list":
        setMode("list");
        break;

      case "-a":
      case "--add":
        setMode("add");
        break;

      case "-d":
      case "--delete":
        setMode("delete");
        romIndex = parseIndex(valueFor(argument, index++), "--delete");
        break;

      case "-e":
      case "--extract":
        setMode("extract");
        romIndex = parseIndex(valueFor(argument, index++), "--extract");
        break;

      case "-b":
      case "--bank": {
        const value = Number(valueFor(argument, index++));
        if (!isBankNumber(value)) {
          throw new UsageError("the cart has two banks: --bank 1 or --bank 2");
        }
        bank = value;
        break;
      }

      case "-R":
      case "--rom":
        setSpace("rom");
        break;

      case "-S":
      case "--save":
        setSpace("sram");
        break;

      case "-s":
      case "--blocksize":
        blockSize = parsePositive(valueFor(argument, index++), "--blocksize");
        break;

      case "-n":
      case "--size":
        size = parseSizeOrFail(valueFor(argument, index++));
        break;

      case "--timeout":
        timeoutSeconds = parseTimeout(valueFor(argument, index++));
        break;

      case "--truncate":
        truncate = true;
        break;

      case "-v":
      case "--verbose":
        verbose = true;
        break;

      case "--no-progress":
        progress = false;
        break;

      default:
        if (argument.startsWith("-")) {
          throw new UsageError(`unknown option ${argument}`);
        }
        if (file !== undefined) {
          throw new UsageError(`unexpected extra argument ${argument}`);
        }
        file = argument;
    }
  }

  if (mode === undefined) {
    throw new UsageError(
      "supply exactly one of --read, --write, --title, --list, --add or --delete",
    );
  }

  // Which modes take a file, and which refuse one
  const wantsFile = mode === "read" || mode === "write" || mode === "add";
  // --extract may take a file name, or derive one from the game's title
  const optionalFile = mode === "extract";

  if (!wantsFile && !optionalFile && file !== undefined) {
    throw new UsageError(`--${mode} takes no file argument`);
  }

  if (wantsFile && file === undefined) {
    throw new UsageError(
      `provide the ${mode === "read" ? "output" : "input"} file name`,
    );
  }

  return {
    mode,
    file,
    bank,
    space,
    blockSize: blockSize ?? (mode === "read" ? DEFAULT_BLOCK_SIZE.read : DEFAULT_BLOCK_SIZE.write),
    romIndex,
    size,
    timeoutMs: Math.round(timeoutSeconds * 1000),
    truncate,
    verbose,
    progress,
  };
}

function parsePositive(text: string, flag: string): number {
  const value = text.startsWith("0x") ? Number.parseInt(text, 16) : Number(text);

  if (!Number.isInteger(value) || value <= 0) {
    throw new UsageError(`${flag} must be a positive integer, got ${text}`);
  }

  return value;
}

function parseSizeOrFail(text: string): number {
  try {
    return parseSize(text);
  } catch (cause) {
    throw new UsageError(cause instanceof Error ? cause.message : String(cause));
  }
}

function parseIndex(text: string, flag: string): number {
  const value = Number(text);

  if (!Number.isInteger(value) || value < 0) {
    throw new UsageError(`${flag} takes a ROM index from --list, got ${text}`);
  }

  return value;
}

function parseTimeout(text: string): number {
  const value = Number(text);

  if (!Number.isFinite(value) || value < 0) {
    throw new UsageError(`--timeout must be zero or more seconds, got ${text}`);
  }

  return value;
}
