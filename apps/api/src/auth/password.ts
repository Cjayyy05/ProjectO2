import { compare, hash } from "bcryptjs";

export async function hashPassword(password: string, rounds: number): Promise<string> {
  return hash(password, rounds);
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return compare(password, passwordHash);
}

