import type {
  ClaimedVerificationCandidate,
  VerificationExecutionResult
} from "./verification-types";

export interface VerificationRepository {
  claimNext(leaseMs: number): Promise<ClaimedVerificationCandidate | null>;
  markRunning(candidate: ClaimedVerificationCandidate): Promise<boolean>;
  renewClaim(candidate: ClaimedVerificationCandidate): Promise<boolean>;
  complete(
    candidate: ClaimedVerificationCandidate,
    result: VerificationExecutionResult,
    resultTtlMs: number
  ): Promise<boolean>;
}
