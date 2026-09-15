import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createLogger } from "../logging/logger";
import { createErrorHandler } from "./error-handler";

describe("error handling", () => {
  it("does not expose an unexpected error or stack trace in production", async () => {
    const app = express();
    app.get("/explode", () => {
      throw new Error("sensitive implementation detail");
    });
    app.use(createErrorHandler(createLogger("test"), true));

    const response = await request(app).get("/explode").expect(500);
    const serialized = JSON.stringify(response.body);

    expect(response.body).toEqual({
      error: { code: "INTERNAL_SERVER_ERROR", message: "Internal server error" }
    });
    expect(serialized).not.toContain("sensitive implementation detail");
    expect(serialized).not.toContain("error-handler.test");
    expect(response.body.error).not.toHaveProperty("stack");
  });
});
