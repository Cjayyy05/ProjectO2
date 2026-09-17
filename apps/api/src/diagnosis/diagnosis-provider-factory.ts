import type { AppConfig } from "../config/environment";
import type { DiagnosisProvider } from "./diagnosis-provider";
import { MockDiagnosisProvider } from "./mock-diagnosis-provider";

export function createDiagnosisProvider(
  provider: AppConfig["diagnosis"]["provider"]
): DiagnosisProvider {
  switch (provider) {
    case "mock":
      return new MockDiagnosisProvider();
  }
}
