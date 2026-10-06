import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import { formatAge } from "@/git/pull-request-panel/data";
import { formatCompactTimeAgo, formatTimeAgo } from "@/utils/time";

// Reproduction for https://github.com/getpaseo/paseo/issues/6238: relative times stay English
// when the app runs in another language.
describe("relative times in French", () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  const sixHoursAgo = now - 6 * 60 * 60_000;

  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("translates the PR panel's own just-now key", async () => {
    await i18n.changeLanguage("fr");
    expect(i18n.t("workspace.git.pr.time.justNow")).not.toBe("just now");
  });

  it("words the PR panel activity age in French", async () => {
    await i18n.changeLanguage("fr");
    expect(formatAge(sixHoursAgo, now)).not.toBe("6h ago");
    expect(formatAge(now - 20_000, now)).not.toBe("just now");
  });

  it("words the shared relative time in French", async () => {
    await i18n.changeLanguage("fr");
    expect(formatTimeAgo(new Date(sixHoursAgo), new Date(now))).not.toBe("6h ago");
    expect(formatCompactTimeAgo(new Date(now - 20_000), new Date(now))).not.toBe("now");
  });
});
