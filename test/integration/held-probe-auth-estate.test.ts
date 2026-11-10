import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runProcess } from "./estate-process.js";

for (const [file, name] of [
  ["held-worker-probes", "live codex held probe"],
  ["live-agent-records", "live codex archive reader"]
] as const) {
  test(`${file} exits after a real Codex worker receives HTTP 401`, { timeout: 90_000 }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ensemble-held-auth-"));
    const home = path.join(directory, "home");
    const codexHome = path.join(home, ".codex");
    const unit = `ensemble-held-auth-${randomUUID()}.scope`;
    const slice = `ensembleauth${randomUUID().replaceAll("-", "")}.slice`;
    let requests = 0;
    const provider = createServer((request, response) => {
      if (request.method === "POST" && request.url === "/v1/responses") requests += 1;
      request.resume();
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "fabricated probe key rejected", type: "invalid_request_error", code: "invalid_api_key" } }));
    });
    let backstop: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let stop: Promise<unknown> | undefined;
    try {
      await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
      const address = provider.address();
      assert.ok(address !== null && typeof address !== "string");
      await mkdir(codexHome, { recursive: true });
      await writeFile(path.join(codexHome, "config.toml"), [
        'model = "auth-refusal-probe"',
        'model_provider = "refusal"',
        '[model_providers.refusal]',
        'name = "refusal"',
        `base_url = "http://127.0.0.1:${address.port}/v1"`,
        'wire_api = "responses"',
        'requires_openai_auth = false',
        'experimental_bearer_token = "fabricated-probe-key"',
        'request_max_retries = 0',
        'stream_max_retries = 0',
        ""
      ].join("\n"));
      // The private slice owns all descendants, including the placed
      // app-server. A regression must not leave a 420-second poll behind.
      backstop = setTimeout(() => {
        timedOut = true;
        stop = runProcess("systemctl", ["--user", "stop", slice]);
        void stop.catch(() => undefined);
      }, 45_000);
      const result = await runProcess("systemd-run", [
        "--user", "--scope", "--quiet", "--collect", `--unit=${unit}`, `--slice=${slice}`, "--",
        process.execPath, "--test", `--test-name-pattern=${name}`, `dist/test/live/${file}.live.test.js`
      ], {
        NODE_TEST_CONTEXT: undefined,
        HOME: home, CODEX_HOME: codexHome,
        XDG_CONFIG_HOME: path.join(directory, "config"), XDG_DATA_HOME: path.join(directory, "data"),
        ENSEMBLE_LIVE: "1", ENSEMBLE_RUN_RECORD_DIR: path.join(directory, "records"),
        ENSEMBLE_STATUS: "0"
      });
      assert.ok(requests > 0, `the real Codex worker never reached the refusal provider\n${result.stderr}\n${result.stdout}`);
      assert.equal(timedOut, false, `the live test kept waiting after HTTP 401\n${result.stderr}\n${result.stdout}`);
      assert.equal(result.code, 1, `${result.stderr}\n${result.stdout}`);
      assert.match(result.stdout, /settled (?:before it was released|while its probe was held)/);
      assert.match(result.stdout, /401|fabricated probe key rejected/);
      assert.doesNotMatch(result.stdout + result.stderr, /unhandledRejection|unhandled rejection|did not appear within/);
    } finally {
      clearTimeout(backstop);
      await stop;
      await runProcess("systemctl", ["--user", "stop", slice]);
      provider.closeAllConnections();
      await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
}
