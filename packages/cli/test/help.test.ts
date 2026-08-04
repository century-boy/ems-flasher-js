/**
 * Keeps `--help` honest.
 *
 * Help text rots the moment a flag is added and the screen is not, so these
 * tests derive the truth from the parser itself rather than from a list
 * someone has to remember to update.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { HELP } from "../src/help.js";
import { parseOptions, UsageError } from "../src/options.js";

const parserSource = readFileSync(new URL("../src/options.ts", import.meta.url), "utf8");

/** Every flag the parser has a case for. */
const acceptedFlags = [...parserSource.matchAll(/case "(-{1,2}[a-zA-Z-]+)":/g)].map(
  (match) => match[1] as string,
);

/** Every mode the parser can produce. */
const modes = [...(/export type Mode = ([^;]+);/.exec(parserSource)?.[1] ?? "").matchAll(
  /"([a-z]+)"/g,
)].map((match) => match[1] as string);

describe("--help", () => {
  it("documents every flag the parser accepts", () => {
    const undocumented = acceptedFlags.filter((flag) => !HELP.includes(flag));
    expect(undocumented).toEqual([]);
  });

  it("documents --help and --version, which never reach the parser", () => {
    expect(HELP).toContain("--help");
    expect(HELP).toContain("--version");
  });

  it("lists every operating mode in the usage block", () => {
    const usage = HELP.slice(0, HELP.indexOf("the cart:"));
    for (const mode of modes) {
      expect(usage).toContain(`--${mode}`);
    }
  });

  it("mentions no flag the parser would reject", () => {
    const mentioned = new Set(
      [...HELP.matchAll(/(?<![\w-])--[a-z][a-z-]*/g)].map((match) => match[0]),
    );

    for (const flag of mentioned) {
      // A flag is real if the parser has a case for it, or handles it earlier.
      const known = acceptedFlags.includes(flag) || ["--help", "--version"].includes(flag);
      expect(known, `${flag} appears in --help but the parser does not accept it`).toBe(
        true,
      );
    }
  });

  it("shows examples that actually parse", () => {
    // Only the example sections: usage lines carry placeholders and padding.
    const sections = HELP.slice(HELP.indexOf("examples, one game per bank:"));

    const examples = [...sections.matchAll(/^ {2}ems-flasher (.+?)(?: {2,}| *$)/gm)]
      .map((match) => (match[1] as string).trim())
      .filter((example) => !example.includes("--help") && !example.includes("--version"));

    expect(examples.length).toBeGreaterThan(8);

    for (const example of examples) {
      // Placeholders stand in for real arguments the user supplies.
      const argv = example
        .replace(/\[[^\]]*\]/g, "") // drop the optional parts of a usage line
        .split(/\s+/)
        .filter(Boolean)
        .map((token) => (token === "N" ? "1" : token))
        .map((token) => (token === "FILE" ? "game.gb" : token));

      expect(() => parseOptions(argv), `${example} does not parse`).not.toThrow(UsageError);
    }
  });
});
