import { Prisma, type PrismaClient } from "@prisma/client";
import { ConflictError } from "../errors/app-error";
import type { UserRecord, UserRepository } from "./user-repository";

export class PrismaUserRepository implements UserRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async findByEmail(email: string): Promise<UserRecord | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  public async findById(id: string): Promise<UserRecord | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  public async register(email: string, passwordHash: string, requestId?: string): Promise<UserRecord> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const user = await transaction.user.create({ data: { email, passwordHash } });

        await transaction.auditEvent.create({
          data: {
            userId: user.id,
            action: "AUTH_REGISTERED",
            resourceType: "User",
            resourceId: user.id,
            outcome: "SUCCESS",
            ...(requestId === undefined ? {} : { requestId })
          }
        });

        return user;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictError("EMAIL_ALREADY_REGISTERED", "An account with this email already exists");
      }

      throw error;
    }
  }
}
