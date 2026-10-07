import { afterEach, describe, expect, it } from "vitest";

const { getPrebuildConfigAsync } = require("@expo/prebuild-config");
const { compileModsAsync } = require("@expo/config-plugins/build/plugins/mod-compiler.js");

interface ManifestEntry {
  $: Record<string, string>;
}

async function resolveAndroidManifest() {
  const { exp } = await getPrebuildConfigAsync(__dirname, { platforms: ["android"] });
  await compileModsAsync(exp, {
    projectRoot: __dirname,
    introspect: true,
    platforms: ["android"],
    assertMissingModProviders: false,
  });
  return exp._internal.modResults.android.manifest.manifest;
}

describe("Android app config", () => {
  afterEach(() => {
    delete process.env.PASEO_FDROID_BUILD;
  });

  it.each([
    ["Google Play", undefined],
    ["F-Droid", "1"],
  ])(
    "%s build installs on devices without a camera",
    async (_build, fdroidFlag) => {
      if (fdroidFlag) {
        process.env.PASEO_FDROID_BUILD = fdroidFlag;
      }
      const manifest = await resolveAndroidManifest();
      const permissions = (manifest["uses-permission"] ?? []).map(
        (entry: ManifestEntry) => entry.$["android:name"],
      );
      const features = (manifest["uses-feature"] ?? []).map((entry: ManifestEntry) => entry.$);

      expect(permissions).toContain("android.permission.CAMERA");
      expect(features).toEqual(
        expect.arrayContaining([
          { "android:name": "android.hardware.camera", "android:required": "false" },
          { "android:name": "android.hardware.camera.autofocus", "android:required": "false" },
        ]),
      );
    },
    30_000,
  );
});
