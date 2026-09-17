import type { DiagnosisInput } from "./diagnosis-types";

export interface DiagnosisProvider {
  readonly provider: string;
  readonly model: string;
  analyzeIncident(input: DiagnosisInput): Promise<unknown>;
}
