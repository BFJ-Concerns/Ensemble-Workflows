import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * One HTTP request an engine CLI sent to its model provider, as the
 * capture provider recorded it.
 *
 * Credential-bearing headers are dropped at capture, so a recorded request
 * never holds a secret even when an engine is configured to send one. The
 * body is kept whole for the oracle to read; it still carries the worker's
 * prompt, paths and environment context, so a test keeps captured requests
 * in memory and persists only the summary its oracle derives from them.
 */
export interface CapturedProviderRequest {
  method: string;
  path: string;
  headers: Readonly<Record<string, string>>;
  /** The request body parsed as JSON, or the raw text when it is not JSON. */
  body: unknown;
}

/**
 * A loopback HTTP server that stands in for an engine's model provider.
 * It records every request and answers each with a terminal 400, so a
 * worker's turn stops at the provider boundary before any model is called
 * and without any account credentials.
 *
 * What the engine sent here is what it would have shown a real model —
 * the tool schemas and the context it assembled — which makes the capture
 * a witness of the engine's own boundary rather than of the configuration
 * the harness handed it or of a worker's account of itself.
 */
export interface CaptureProvider {
  /** The provider root an engine's configuration points at, ending `/v1`. */
  readonly baseUrl: string;
  /** Every request received so far, in arrival order. */
  requests(): readonly CapturedProviderRequest[];
  close(): Promise<void>;
}

const CREDENTIAL_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "x-api-key", "api-key"]);

export async function startCaptureProvider(): Promise<CaptureProvider> {
  const captured: CapturedProviderRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined && !CREDENTIAL_HEADERS.has(name)) {
          headers[name] = Array.isArray(value) ? value.join(", ") : value;
        }
      }
      const text = Buffer.concat(chunks).toString("utf8");
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // A non-JSON body is kept as text; the oracle decides whether that is a failure.
      }
      captured.push({ method: request.method ?? "", path: request.url ?? "", headers, body });
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "capture provider: intentional stop", type: "invalid_request_error" } }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests: () => captured,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      })
  };
}
