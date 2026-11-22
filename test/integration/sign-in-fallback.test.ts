import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { LazyCodexAppServerTransport } from "../../src/app-server.js";
import { CodexEngineAdapter, EngineRegistry } from "../../src/engines.js";
import { EnsembleRuntime } from "../../src/runtime.js";
import { ChainEngine } from "../unit/chain-engine-fakes.js";
import { executablePath } from "./estate-process.js";

test("a real Codex app-server without credentials hands the call to Claude", { timeout: 30_000 }, async (t) => {
  const binary = await executablePath("codex");
  const home = await mkdtemp(path.join(tmpdir(), "ensemble-sign-in-fallback-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  let requests = 0;
  let authorised = false;
  const provider = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/v1/responses") {
      requests += 1;
      authorised ||= request.headers.authorization !== undefined;
    }
    request.resume();
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Missing bearer or basic authentication", code: "invalid_api_key" } }));
  });
  await new Promise<void>((resolve, reject) => provider.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address !== null && typeof address !== "string");

  try {
    await writeFile(path.join(home, "config.toml"), [
      'model = "auth-probe"',
      'model_provider = "refusal"',
      '[model_providers.refusal]',
      'name = "refusal"',
      `base_url = "http://127.0.0.1:${address.port}/v1"`,
      'wire_api = "responses"',
      'requires_openai_auth = false',
      'request_max_retries = 0',
      'stream_max_retries = 0',
      ""
    ].join("\n"));
    const wrapper = path.join(home, "codex");
    await writeFile(wrapper, [
      "#!/bin/sh",
      'exec /usr/bin/env -i PATH="$PATH" HOME="$CODEX_HOME" CODEX_HOME="$CODEX_HOME" "$TEST_CODEX_BINARY" "$@"',
      ""
    ].join("\n"), { mode: 0o700 });

    const transport = new LazyCodexAppServerTransport({
      cwd: home,
      codexBin: wrapper,
      workerEnv: { CODEX_HOME: home, TEST_CODEX_BINARY: binary },
      requestTimeoutMs: 8_000,
      startupHandshakeTimeoutMs: 8_000,
      clientName: "ensemble-auth-probe",
      clientVersion: "0.1"
    });
    const codex = new CodexEngineAdapter({ transport, concurrency: 1 });
    const claude = new ChainEngine("claude", [async () => ({
      text: "Claude answered", deltaText: "", durationMs: 0, firstDeltaMs: 0, items: {}, tokenUsageEvents: []
    })]);
    const runtime = new EnsembleRuntime({ cwd: home, engines: new EngineRegistry([codex, claude]), defaultMaxAttempts: 1 });
    try {
      const answer = await runtime.agent("Reply hello", {
        engine: "codex", model: "auth-probe", timeoutMs: 10_000,
        fallback: [{ engine: "claude", model: "sonnet" }]
      });
      assert.equal(requests, 1);
      assert.equal(authorised, false);
      assert.equal(answer, "Claude answered");
      const attempts = runtime.lastAgentRecord()?.attempts;
      assert.deepEqual(attempts?.map((attempt) => attempt.target.engine), ["codex", "claude"]);
      assert.deepEqual(attempts?.[0]?.classification, { class: "availability", rule: "codex.authentication-failure" });
      assert.equal(attempts?.[0]?.chainDecision, "advanced");
      assert.match(attempts?.[0]?.failure?.message ?? "", /codex login/);
    } finally {
      await runtime.close();
    }
  } finally {
    provider.closeAllConnections();
    await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
  }
});
