import type { AuditWriter } from "../audit/audit";
import { AuthenticationError } from "../errors/app-error";
import { hashPassword, verifyPassword } from "./password";
import type { UserRecord, UserRepository } from "./user-repository";

export interface PublicUser {
  readonly id: string;
  readonly email: string;
  readonly createdAt: Date;
}

export class AuthService {
  private readonly dummyPasswordHash: Promise<string>;

  public constructor(
    private readonly users: UserRepository,
    private readonly audit: AuditWriter,
    private readonly passwordHashRounds: number
  ) {
    this.dummyPasswordHash = hashPassword("selfheal-dummy-password", passwordHashRounds);
  }

  public async register(email: string, password: string, requestId?: string): Promise<PublicUser> {
    const normalizedEmail = email.trim().toLowerCase();
    const passwordHash = await hashPassword(password, this.passwordHashRounds);
    const user = await this.users.register(normalizedEmail, passwordHash, requestId);

    return toPublicUser(user);
  }

  public async authenticate(email: string, password: string, requestId?: string): Promise<PublicUser> {
    const normalizedEmail = email.trim().toLowerCase();
    const user = await this.users.findByEmail(normalizedEmail);
    const passwordHash = user?.passwordHash ?? (await this.dummyPasswordHash);
    const passwordMatches = await verifyPassword(password, passwordHash);

    if (user === null || !passwordMatches) {
      await this.audit.record({
        action: "AUTH_LOGIN_FAILED",
        resourceType: "User",
        outcome: "FAILURE",
        ...(requestId === undefined ? {} : { requestId }),
        details: { email: normalizedEmail }
      });
      throw new AuthenticationError("Invalid email or password");
    }

    await this.audit.record({
      userId: user.id,
      action: "AUTH_LOGIN_SUCCEEDED",
      resourceType: "User",
      resourceId: user.id,
      outcome: "SUCCESS",
      ...(requestId === undefined ? {} : { requestId })
    });

    return toPublicUser(user);
  }

  public async getUser(userId: string): Promise<PublicUser> {
    const user = await this.users.findById(userId);

    if (user === null) {
      throw new AuthenticationError();
    }

    return toPublicUser(user);
  }
}

function toPublicUser(user: UserRecord): PublicUser {
  return { id: user.id, email: user.email, createdAt: user.createdAt };
}
