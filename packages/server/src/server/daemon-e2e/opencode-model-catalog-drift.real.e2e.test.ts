import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";

import { OpenCodeAgentClient } from "../agent/providers/opencode-agent.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import {
  canRunRealProvider,
  getRealProviderRuntimeSettings,
} from "./real-provider-test-config.js";

const PROVIDER = "paseo-catalog-drift";
const KEPT_MODEL = "kept-model";
const RETIRED_MODEL = "retired-model";

function model(id: string, name: string) {
  return {
    id,
    name,
    family: "gemini-flash",
    attachment: true,
    reasoning: false,
    tool_call: true,
    temperature: true,
    release_date: "2025-06-17",
    last_updated: "2025-06-17",
    modalities: { input: ["text"], output: ["text"] },
    open_weights: false,
    limit: { context: 1_048_576, output: 65_535 },
    cost: { input: 0.1, output: 0.4 },
  };
}

function catalog(modelIds: string[]) {
  return {
    [PROVIDER]: {
      id: PROVIDER,
      env: ["PASEO_CATALOG_DRIFT_KEY"],
      npm: "@ai-sdk/openai-compatible",
      api: "http://127.0.0.1:9/v1",
      name: "Catalog drift",
      doc: "http://127.0.0.1:9",
      models: Object.fromEntries(modelIds.map((id) => [id, model(id, id)])),
    },
  };
}

// Stands in for models.dev, the catalog OpenCode refreshes on its own schedule.
async function startCatalogSource() {
  let body = JSON.stringify(catalog([KEPT_MODEL, RETIRED_MODEL]));
  let fetches = 0;
  const server: Server = createServer((request, response) => {
    if (request.url !== "/api.json") {
      response.writeHead(404).end();
      return;
    }
    fetches += 1;
    response.writeHead(200, { "content-type": "application/json" }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    fetches: () => fetches,
    retire: (id: string) => {
      body = JSON.stringify(
        catalog([KEPT_MODEL, RETIRED_MODEL].filter((entry) => entry !== id))
      );
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("daemon E2E (real opencode) - model catalog drift", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await canRunRealProvider("opencode");
  });

  beforeEach((context) => {
    if (!canRun) context.skip();
  });

  test("models listed for OpenCode follow OpenCode's catalog after it changes", async () => {
    const logger = pino({ level: "silent" });
    const source = await startCatalogSource();
    const settings = getRealProviderRuntimeSettings("opencode");
    const cacheHome = settings.env!.XDG_CACHE_HOME!;
    const provider = new OpenCodeAgentClient(logger, {
      ...settings,
      env: {
        ...settings.env,
        OPENCODE_MODELS_URL: source.url,
        PASEO_CATALOG_DRIFT_KEY: "test",
      },
    });
    const daemon = await createTestPaseoDaemon({
      agentClients: { opencode: provider },
      logger,
    });
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
    });
    const cwd = realpathSync(
      mkdtempSync(path.join(tmpdir(), "daemon-real-opencode-catalog-"))
    );

    try {
      await client.connect();
      await client.fetchAgents({ subscribe: {} });

      const before = await client.listProviderModels("opencode");
      expect(before.models.map((entry) => entry.id)).toContain(
        `${PROVIDER}/${RETIRED_MODEL}`
      );

      // The catalog drops a model and OpenCode's cached copy is renewed, as when
      // any other OpenCode process refreshes it while Paseo sits idle. The next
      // OpenCode server Paseo starts loads that catalog.
      source.retire(RETIRED_MODEL);
      const cacheDir = path.join(cacheHome, "opencode");
      for (const file of readdirSync(cacheDir).filter((name) =>
        name.startsWith("models-")
      ))
        rmSync(path.join(cacheDir, file), { force: true });

      const fetchesBefore = source.fetches();
      const agent = await client.createAgent({
        provider: "opencode",
        cwd,
        title: "catalog drift",
        model: `${PROVIDER}/${KEPT_MODEL}`,
        modeId: "build",
      });
      expect(source.fetches()).toBeGreaterThan(fetchesBefore);

      let switchError: unknown = null;
      try {
        await client.setAgentModel(agent.id, `${PROVIDER}/${RETIRED_MODEL}`);
      } catch (error) {
        switchError = error;
      }

      const after = await client.listProviderModels("opencode");
      const listed = after.models.map((entry) => entry.id);
      // Every model offered in the picker must be one OpenCode accepts.
      expect({
        listed: listed.includes(`${PROVIDER}/${RETIRED_MODEL}`),
        switchError,
      }).toEqual({
        listed: false,
        switchError: expect.anything(),
      });
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close().catch(() => undefined);
      await source.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 180_000);
});
