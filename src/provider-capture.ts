import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * One HTTP request an engine CLI sent to its model provider, as the
 * capture provider recorded it.
 *
 * Credential-bearing headers are dropped at capture, so a recorded request
 * never holds a secret even when the engine sends the operator's own
 * credentials. The body is kept whole for the reader to judge; it still
 * carries the operator's context (instructions, paths, environment), so a
 * caller keeps captured requests in memory and persists only what its
 * reader derives from them.
 */
export interface CapturedProviderRequest {
  method: string;
  path: string;
  headers: Readonly<Record<string, string>>;
  /** The request body parsed as JSON, or the raw text when it is not JSON. */
  body: unknown;
}

/**
 * A loopback HTTP server standing in for an engine's model provider. It
 * records every request and answers each with a terminal 400, so a turn
 * stops at the provider boundary before any model is called and nothing is
 * billed.
 *
 * What an engine sent here is what it would have shown a real model — the
 * tool definitions and the context it assembled — so a capture witnesses
 * the engine's own boundary, not the configuration the harness handed it
 * nor a worker's account of itself.
 */
export interface CaptureProvider {
  /** Scheme, host and port, with no path: the form `ANTHROPIC_BASE_URL` takes. */
  readonly origin: string;
  /** The provider root ending `/v1`: the form an OpenAI-style provider entry takes. */
  readonly baseUrl: string;
  /** Every request received so far, in arrival order. */
  requests(): readonly CapturedProviderRequest[];
  close(): Promise<void>;
}

const CREDENTIAL_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "x-api-key", "api-key"]);

/** Listens on an ephemeral port of 127.0.0.1 only; nothing off the machine can reach it. */
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
        // A non-JSON body is kept as text; the reader decides whether that is a failure.
      }
      captured.push({ method: request.method ?? "", path: request.url ?? "", headers, body });
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: "capture provider: intentional stop" }
      }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    baseUrl: `${origin}/v1`,
    requests: () => captured,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      })
  };
}
