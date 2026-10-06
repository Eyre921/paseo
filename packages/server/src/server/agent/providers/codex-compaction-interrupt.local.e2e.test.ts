import { describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createServer, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";

import { AgentManager } from "../agent-manager.js";
import { AgentStorage } from "../agent-storage.js";
import { sendPromptToAgent } from "../agent-prompt.js";
import { CodexAppServerAgentClient } from "./codex-app-server-agent.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";

function isCodexInstalled(): boolean {
  try {
    return (
      execFileSync("which", ["codex"], { encoding: "utf8" }).trim().length > 0
    );
  } catch {
    return false;
  }
}

function sse(events: Array<Record<string, unknown>>): string {
  return events
    .map(
      (event) =>
        `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`
    )
    .join("");
}

function assistantSse(id: string, text: string, totalTokens: number): string {
  return sse([
    { type: "response.created", response: { id } },
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        id: `msg-${id}`,
        content: [{ type: "output_text", text }],
      },
    },
    {
      type: "response.completed",
      response: {
        id,
        usage: {
          input_tokens: totalTokens,
          input_tokens_details: null,
          output_tokens: 0,
          output_tokens_details: null,
          total_tokens: totalTokens,
        },
      },
    },
  ]);
}

function isCompactionRequest(body: string): boolean {
  return body.includes("CONTEXT CHECKPOINT COMPACTION");
}

async function startServer() {
  const requests: Array<{ compaction: boolean; body: string }> = [];
  const heldCompactions: ServerResponse[] = [];
  let index = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (req.method !== "POST" || req.url !== "/v1/responses") {
        res.statusCode = 404;
        res.end();
        return;
      }
      const compaction = isCompactionRequest(body);
      requests.push({ compaction, body });
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      if (compaction) {
        // Hold the summarization open, as a slow real compaction would be.
        heldCompactions.push(res);
        return;
      }
      index += 1;
      // The first turn reports a context far above the auto-compact limit.
      res.end(
        assistantSse(
          `resp-${index}`,
          `reply ${index}`,
          index === 1 ? 50_000 : 100
        )
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    releaseCompactions() {
      for (const res of heldCompactions.splice(0)) {
        res.end(assistantSse("summary", "SUMMARY", 100));
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of heldCompactions.splice(0)) res.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function writeConfig(codexHome: string, serverUrl: string): void {
  writeFileSync(
    path.join(codexHome, "config.toml"),
    `
model = "mock-model"
approval_policy = "on-request"
sandbox_mode = "read-only"
model_provider = "mock_provider"
model_auto_compact_token_limit = 10000

[model_providers.mock_provider]
name = "Mock provider for test"
base_url = "${serverUrl}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
`
  );
}

async function waitFor(
  check: () => boolean,
  label: string,
  timeoutMs = 15_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("Codex compaction and incoming prompts (local e2e)", () => {
  for (const behavior of ["send_agent_prompt default", "steer"] as const) {
    test.runIf(isCodexInstalled())(
      `${behavior}: messages from other agents during auto-compaction do not restart it (#5728)`,
      async () => {
        const cwd = mkdtempSync(path.join(os.tmpdir(), "codex-compact-cwd-"));
        const codexHome = mkdtempSync(
          path.join(os.tmpdir(), "codex-compact-home-")
        );
        const server = await startServer();
        const logger = createTestLogger();
        const storage = new AgentStorage(path.join(cwd, "agents"), logger);
        const manager = new AgentManager({
          clients: { codex: new CodexAppServerAgentClient(logger) },
          registry: storage,
          logger,
        });
        let agentId: string | undefined;
        try {
          writeConfig(codexHome, server.url);
          vi.stubEnv("CODEX_HOME", codexHome);
          const created = await manager.createAgent(
            { provider: "codex", cwd, modeId: "auto", model: "mock-model" },
            undefined,
            { workspaceId: undefined }
          );
          agentId = created.id;
          const id = agentId;
          await manager.runAgent(id, "first turn");

          const send = (text: string) =>
            sendPromptToAgent({
              agentManager: manager,
              agentStorage: storage,
              agentId: id,
              prompt: text,
              ...(behavior === "steer"
                ? { activeTurnBehavior: "steer" as const }
                : {}),
              logger,
            });
          const compactions = () =>
            server.requests.filter((r) => r.compaction).length;

          await send("second turn");
          await waitFor(() => compactions() === 1, "first compaction request");

          // Two more messages arrive from other agents while it compacts.
          await send("update from agent A");
          await new Promise((resolve) => setTimeout(resolve, 1500));
          await send("update from agent B");
          await new Promise((resolve) => setTimeout(resolve, 1500));

          // Each message that replaced the turn aborted the compaction and started another.
          expect(compactions()).toBe(1);
          server.releaseCompactions();
          await waitFor(
            () => manager.getAgent(id)?.lifecycle === "idle",
            "agent idle",
            20_000
          );

          // Every message reaches Codex and the chat, once compaction finishes.
          const delivered = server.requests
            .filter((request) => !request.compaction)
            .map((request) => request.body)
            .join("\n");
          const chat = manager
            .getTimeline(id)
            .flatMap((item) =>
              item.type === "user_message" ? [item.text] : []
            );
          for (const text of [
            "second turn",
            "update from agent A",
            "update from agent B",
          ]) {
            expect(delivered).toContain(text);
            expect(chat).toContain(text);
          }
          expect(compactions()).toBe(1);
        } finally {
          if (agentId && manager.getAgent(agentId))
            await manager.closeAgent(agentId);
          await storage.flush();
          vi.unstubAllEnvs();
          await server.close();
          rmSync(cwd, { recursive: true, force: true });
          rmSync(codexHome, { recursive: true, force: true });
        }
      },
      60_000
    );
  }
});
