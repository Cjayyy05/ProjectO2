import { describe, expect, it } from "vitest";
import { collectBoundedLogChunks } from "../evidence/bounded-evidence";
import { EvidenceSanitizer } from "../evidence/evidence-sanitizer";
import { createDockerEvidenceSource } from "./dockerode-evidence-source";

const dockerTestsEnabled = process.env.RUN_DOCKER_INTEGRATION_TESTS === "true";
const describeDocker = dockerTestsEnabled ? describe : describe.skip;

describeDocker("Docker evidence integration", () => {
  it("collects safe inspect metadata and bounded sanitized real Docker logs", async () => {
    const container = process.env.TEST_DOCKER_EVIDENCE_CONTAINER;
    if (container === undefined) throw new Error("Docker evidence fixture name is required");
    const fixtureSecret = process.env.TEST_DOCKER_EVIDENCE_SECRET;
    if (fixtureSecret === undefined) throw new Error("Docker evidence fixture secret is required");
    const source = createDockerEvidenceSource(2_000);

    const snapshot = await source.inspectEvidence(container);
    const logs = await collectBoundedLogChunks(
      source.streamRecentLogs(container, 501),
      { maxBytes: 256 * 1_024, maxLines: 500 },
      new EvidenceSanitizer()
    );

    expect(snapshot.environmentNames).toEqual(expect.arrayContaining(["NODE_ENV", "PASSWORD"]));
    expect(snapshot.allowlistedEnvironment).toEqual({ NODE_ENV: "production" });
    expect(JSON.stringify(snapshot)).not.toContain(fixtureSecret);
    expect(logs.content).toContain("fixture-start");
    expect(logs.content).not.toContain(fixtureSecret);
    expect(logs.content).not.toContain("sk-proj-abcdefghijklmnopqrstuv");
    expect(logs.byteCount).toBeLessThanOrEqual(256 * 1_024);
    expect(logs.lineCount).toBeLessThanOrEqual(500);
  });
});
