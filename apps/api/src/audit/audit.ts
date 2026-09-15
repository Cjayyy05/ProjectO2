export type AuditOutcome = "SUCCESS" | "FAILURE";

export interface AuditEventInput {
  readonly userId?: string;
  readonly projectId?: string;
  readonly incidentId?: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string;
  readonly outcome: AuditOutcome;
  readonly requestId?: string;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface AuditWriter {
  record(event: AuditEventInput): Promise<void>;
}

export class NoopAuditWriter implements AuditWriter {
  public async record(_event: AuditEventInput): Promise<void> {
    await Promise.resolve();
  }
}

