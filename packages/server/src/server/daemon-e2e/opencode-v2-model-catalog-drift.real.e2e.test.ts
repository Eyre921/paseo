import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { expect, test } from "vitest";

import { OpenCodeV2AgentClient } from "../agent/providers/opencode/v2/agent.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

// Reproduction for #6006. Needs an OpenCode 2.x binary in OPENCODE_V2_BIN.
const OPENCODE_V2_BIN = process.env.OPENCODE_V2_BIN;

const PROVIDER = "paseo-catalog-drift";
const KEPT_MODEL = "kept-model";
const RETIRED_MODEL = "retired-model";

function catalog(modelIds: string[]) {
  return {
    [PROVIDER]: {
      id: PROVIDER,
      env: ["PASEO_CATALOG_DRIFT_KEY"],
      npm: "@ai-sdk/openai-compatible",
      api: "http://127.0.0.1:9/v1",
      name: "Catalog drift",
      models: Object.fromEntries(
        modelIds.map((id) => [
          id,
          {
            id,
            name: id,
            attachment: false,
            reasoning: false,
            tool_call: true,
            temperature: true,
            release_date: "2025-06-17",
            last_updated: "2025-06-17",
            modalities: { input: ["text"], output: ["text"] },
            open_weights: false,
            limit: { context: 128_000, output: 8_000 },
            cost: { input: 0, output: 0 },
          },
        ]),
      ),
    },
  };
}

test.runIf(OPENCODE_V2_BIN)(
  "a model OpenCode dropped from its catalog stays in the picker and fails to apply",
  async () => {
    const logger = pino({ level: "silent" });
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "opencode-v2-catalog-drift-")));
    const modelsPath = path.join(root, "models.json");
    const cwd = path.join(root, "work");
    mkdirSync(cwd);
    writeFileSync(modelsPath, JSON.stringify(catalog([KEPT_MODEL, RETIRED_MODEL])));
    const provider = new OpenCodeV2AgentClient({
      logger,
      settings: {
        command: { mode: "replace", argv: [OPENCODE_V2_BIN!] },
        env: {
          OPENCODE_MODELS_PATH: modelsPath,
          OPENCODE_DISABLE_MODELS_FETCH: "1",
          OPENCODE_DISABLE_AUTO_UPDATE: "1",
          PASEO_CATALOG_DRIFT_KEY: "test",
          XDG_CONFIG_HOME: path.join(root, "config"),
          XDG_DATA_HOME: path.join(root, "data"),
          XDG_CACHE_HOME: path.join(root, "cache"),
        },
      },
    });
    const daemon = await createTestPaseoDaemon({ agentClients: { opencode: provider }, logger });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    try {
      await client.connect();
      await client.fetchAgents({ subscribe: {} });

      const before = await client.listProviderModels("opencode", { cwd });
      expect(before.models?.map((entry) => entry.id)).toContain(`${PROVIDER}/${RETIRED_MODEL}`);

      // OpenCode's catalog drops the model while Paseo sits idle.
      writeFileSync(modelsPath, JSON.stringify(catalog([KEPT_MODEL])));

      const agent = await client.createAgent({
        provider: "opencode",
        cwd,
        title: "catalog drift",
        model: `${PROVIDER}/${KEPT_MODEL}`,
        modeId: "build",
      });

      const listed = await client.listProviderModels("opencode", { cwd });
      const offered = listed.models?.map((entry) => entry.id) ?? [];
      let switchError: string | null = null;
      if (offered.includes(`${PROVIDER}/${RETIRED_MODEL}`)) {
        try {
          await client.setAgentModel(agent.id, `${PROVIDER}/${RETIRED_MODEL}`);
        } catch (error) {
          switchError = error instanceof Error ? error.message : String(error);
        }
      }
      // Every model the picker offers must be one OpenCode accepts.
      expect({ offered, switchError }).toEqual({
        offered: [`${PROVIDER}/${KEPT_MODEL}`],
        switchError: null,
      });
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  },
  180_000,
);
