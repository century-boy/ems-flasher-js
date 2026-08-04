#!/usr/bin/env node
/**
 * `ems-flasher` — entry point.
 *
 * Parses the command line, opens the cart, runs the requested command and
 * makes sure the USB interface is released whatever happens.
 */

import { EmsError } from "@ems-flasher-js/core";

import { runRead, runTitle, runWrite } from "./commands.js";
import { runAdd, runDelete, runExtract, runList } from "./multirom-commands.js";
import { HELP } from "./help.js";
import { parseOptions, UsageError } from "./options.js";
import { openCart } from "./device.js";
import { VERSION } from "./version.js";

const PROGRAM = "ems-flasher";

/** Exit codes: 0 success, 1 failure, 2 bad command line. */
const EXIT = { success: 0, failure: 1, usage: 2 } as const;

async function main(argv: readonly string[]): Promise<number> {
  // Help and version short-circuit everything else, including cart detection.
  if (argv.some((argument) => argument === "-h" || argument === "--help")) {
    process.stdout.write(HELP);
    return EXIT.success;
  }

  if (argv.some((argument) => argument === "-V" || argument === "--version")) {
    console.log(`${PROGRAM} ${VERSION}`);
    return EXIT.success;
  }

  let options;
  try {
    options = parseOptions(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${PROGRAM}: error: ${error.message}`);
      console.error(`Try '${PROGRAM} --help' for the full option list.`);
      return EXIT.usage;
    }
    throw error;
  }

  if (options.verbose) {
    console.log("Looking for the EMS cart...");
  }

  const cart = await openCart({
    timeoutMs: options.timeoutMs,
    ...(process.env["EMS_DEBUG"]
      ? { onDebug: (line: string) => console.error(`> ${line}`) }
      : {}),
  });

  if (options.verbose) {
    console.log("Claimed the EMS cart");
  }

  try {
    const context = { cart, options };

    switch (options.mode) {
      case "read":
        await runRead(context);
        break;
      case "write":
        await runWrite(context);
        break;
      case "title":
        await runTitle(context);
        break;
      case "list":
        await runList(cart, options);
        break;
      case "add":
        await runAdd(cart, options);
        break;
      case "delete":
        await runDelete(cart, options);
        break;
      case "extract":
        await runExtract(cart, options);
        break;
    }
  } finally {
    await cart.close();
  }

  return EXIT.success;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  // Expected failures get a clean one-line message; anything else keeps its
  // stack trace, because it is a bug worth reporting.
  if (error instanceof EmsError) {
    console.error(`${PROGRAM}: error: ${error.message}`);
  } else if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    console.error(`${PROGRAM}: error: ${error.message}`);
  } else {
    console.error(error);
  }

  process.exitCode = EXIT.failure;
}
