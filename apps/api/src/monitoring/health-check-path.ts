import { z } from "zod";

const SAFE_HEALTH_CHECK_PATH = /^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?\/?$/;

export const healthCheckPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => SAFE_HEALTH_CHECK_PATH.test(value), {
    message: "Health check path must be an absolute path without a host, query, fragment, or backslash"
  })
  .refine(
    (value) => !value.split("/").some((segment) => segment === "." || segment === ".."),
    "Health check path must not contain dot segments"
  );
