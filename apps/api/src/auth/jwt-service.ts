import jwt from "jsonwebtoken";
import { AuthenticationError } from "../errors/app-error";

const JWT_ISSUER = "selfheal-api";
const JWT_AUDIENCE = "selfheal-web";

export class JwtService {
  public constructor(
    private readonly secret: string,
    private readonly ttlHours: number
  ) {}

  public sign(userId: string): string {
    return jwt.sign({}, this.secret, {
      algorithm: "HS256",
      subject: userId,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      expiresIn: this.ttlHours * 60 * 60
    });
  }

  public verify(token: string): { userId: string } {
    try {
      const payload = jwt.verify(token, this.secret, {
        algorithms: ["HS256"],
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE
      });

      if (typeof payload === "string" || typeof payload.sub !== "string" || payload.sub.length === 0) {
        throw new AuthenticationError("Invalid authentication token");
      }

      return { userId: payload.sub };
    } catch (error) {
      if (error instanceof AuthenticationError) {
        throw error;
      }

      throw new AuthenticationError("Invalid or expired authentication token");
    }
  }
}
