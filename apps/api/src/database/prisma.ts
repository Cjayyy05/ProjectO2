import { PrismaClient } from "@prisma/client";

export function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    log: [
      { emit: "event", level: "error" },
      { emit: "event", level: "warn" }
    ]
  });
}

