import { createServer, type RequestListener, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { HttpHealthChecker } from "./http-health-checker";

describe("HttpHealthChecker", () => {
  it.each([200, 204, 399])("treats HTTP %i as healthy", async (statusCode) => {
    const server = await listen((_request, response) => {
      response.writeHead(statusCode).end();
    });
    try {
      const result = await new HttpHealthChecker().check({
        port: server.port,
        path: "/health",
        timeoutMs: 1_000
      });
      expect(result).toMatchObject({ healthy: true, statusCode });
    } finally {
      await server.close();
    }
  });

  it("counts a redirect as healthy without following it", async () => {
    let redirectTargetRequests = 0;
    const server = await listen((request, response) => {
      if (request.url === "/redirect-target") {
        redirectTargetRequests += 1;
        response.writeHead(200).end();
        return;
      }
      response.writeHead(302, { location: "/redirect-target" }).end();
    });
    try {
      const result = await new HttpHealthChecker().check({
        port: server.port,
        path: "/health",
        timeoutMs: 1_000
      });
      expect(result).toMatchObject({ healthy: true, statusCode: 302 });
      expect(redirectTargetRequests).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("treats an HTTP 500 response as unhealthy", async () => {
    const server = await listen((_request, response) => response.writeHead(500).end());
    try {
      const result = await new HttpHealthChecker().check({
        port: server.port,
        path: "/health",
        timeoutMs: 1_000
      });
      expect(result).toMatchObject({ healthy: false, statusCode: 500 });
    } finally {
      await server.close();
    }
  });

  it("handles a bounded timeout as unhealthy", async () => {
    const server = await listen(() => undefined);
    try {
      const result = await new HttpHealthChecker().check({
        port: server.port,
        path: "/health",
        timeoutMs: 25
      });
      expect(result).toMatchObject({ healthy: false, errorCode: "TIMEOUT" });
    } finally {
      server.server.closeAllConnections();
      await server.close();
    }
  });

  it("handles connection refusal as unhealthy", async () => {
    const server = await listen((_request, response) => response.end());
    const port = server.port;
    await server.close();

    const result = await new HttpHealthChecker().check({ port, path: "/health", timeoutMs: 500 });

    expect(result).toMatchObject({ healthy: false, errorCode: "CONNECTION_REFUSED" });
  });
});

async function listen(listener: RequestListener): Promise<{
  readonly server: Server;
  readonly port: number;
  close(): Promise<void>;
}> {
  const server = createServer(listener);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test server did not bind a TCP port");
  }
  return {
    server,
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    })
  };
}
