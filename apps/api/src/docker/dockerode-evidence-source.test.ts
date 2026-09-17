import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractPublishedHostPorts,
  extractSafeEnvironment,
  readUntilIdle
} from "./dockerode-evidence-source";

afterEach(() => vi.useRealTimers());

describe("Docker evidence environment filtering", () => {
  it("keeps names, discards secret values, and permits only validated allowlisted values", () => {
    const result = extractSafeEnvironment([
      "NODE_ENV=production",
      "APP_ENV=staging",
      "PASSWORD=never-persist-this",
      "API_KEY=also-never-persist-this",
      "FEATURE_FLAG=true",
      "INVALID-NAME=value",
      "APPLICATION_MODE=value with spaces"
    ]);

    expect(result.names).toEqual([
      "API_KEY",
      "APPLICATION_MODE",
      "APP_ENV",
      "FEATURE_FLAG",
      "NODE_ENV",
      "PASSWORD"
    ]);
    expect(result.allowlistedValues).toEqual({ NODE_ENV: "production", APP_ENV: "staging" });
    expect(JSON.stringify(result)).not.toContain("never-persist-this");
    expect(JSON.stringify(result)).not.toContain("also-never-persist-this");
    expect(result.allowlistedValues).not.toHaveProperty("FEATURE_FLAG");
  });

  it("bounds environment names and published ports", () => {
    const environment = extractSafeEnvironment(
      Array.from({ length: 300 }, (_value, index) => `VARIABLE_${index}=discarded-${index}`)
    );
    const ports = extractPublishedHostPorts({
      "8080/tcp": Array.from({ length: 300 }, (_value, index) => ({
        HostPort: String(10_000 + index)
      }))
    });

    expect(environment.names).toHaveLength(256);
    expect(environment.allowlistedValues).toEqual({});
    expect(JSON.stringify(environment)).not.toContain("discarded-");
    expect(ports).toHaveLength(256);
  });

  it("clears per-chunk idle timers when a stream completes", async () => {
    vi.useFakeTimers();
    const received: string[] = [];

    for await (const chunk of readUntilIdle(
      Readable.from([Buffer.from("first"), Buffer.from("second")]),
      500,
      2_000
    )) {
      received.push(Buffer.from(chunk).toString("utf8"));
    }

    expect(received.join("")).toBe("firstsecond");
    expect(vi.getTimerCount()).toBe(0);
  });
});
