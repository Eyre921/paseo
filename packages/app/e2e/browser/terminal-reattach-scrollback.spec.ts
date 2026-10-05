import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { TerminalE2EHarness } from "../support/helpers/terminal-dsl";
import { waitForTerminalContent } from "../support/helpers/terminal-perf";

interface ScrollbackProbe {
  bufferLines: number;
  oldestSeqLine: string;
}

interface InspectableTerminal {
  buffer: {
    active: {
      length: number;
      getLine(index: number): { translateToString(trimRight: boolean): string } | undefined;
    };
  };
}

async function readScrollback(page: Page): Promise<ScrollbackProbe> {
  return page.evaluate(() => {
    const terminal = (window as Window & { __paseoTerminal?: InspectableTerminal }).__paseoTerminal;
    if (!terminal) {
      return { bufferLines: 0, oldestSeqLine: "" };
    }
    const buffer = terminal.buffer.active;
    for (let index = 0; index < buffer.length; index++) {
      const text = buffer.getLine(index)?.translateToString(true).trim() ?? "";
      if (/^\d+$/.test(text)) {
        return { bufferLines: buffer.length, oldestSeqLine: text };
      }
    }
    return { bufferLines: buffer.length, oldestSeqLine: "" };
  });
}

async function readScrollbackAfterSeq(page: Page): Promise<ScrollbackProbe> {
  await waitForTerminalContent(page, (text) => text.includes("\n3000"), 30_000);
  return readScrollback(page);
}

// Repro for https://github.com/getpaseo/paseo/issues/6137: a reload re-attaches the
// terminal from a daemon restore, which keeps far fewer lines than the live buffer held.
test("a re-attached terminal keeps its scrollback after a reload", async ({ page }) => {
  const harness = await TerminalE2EHarness.create({ tempPrefix: "terminal-reattach-" });
  try {
    const terminal = await harness.createTerminal({ name: "seq" });
    await harness.openTerminal(page, { terminalId: terminal.id });
    await harness.setupPrompt(page);
    await harness.terminalSurface(page).pressSequentially("seq 1 3000\n", { delay: 0 });
    const beforeReload = await readScrollbackAfterSeq(page);
    expect(beforeReload.oldestSeqLine).toBe("1");

    await page.reload();
    await harness.openTerminal(page, { terminalId: terminal.id });
    const afterReload = await readScrollbackAfterSeq(page);

    expect(afterReload, JSON.stringify({ beforeReload, afterReload })).toEqual(beforeReload);
  } finally {
    await harness.cleanup();
  }
});
