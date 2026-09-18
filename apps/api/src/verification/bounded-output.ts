import { EvidenceSanitizer } from "../evidence/evidence-sanitizer";

export class BoundedVerificationOutput {
  private content = "";

  public constructor(
    private readonly maxBytes: number,
    private readonly sanitizer = new EvidenceSanitizer()
  ) {}

  public append(value: string): void {
    if (Buffer.byteLength(this.content, "utf8") >= this.maxBytes) return;
    const safe = this.sanitizer.sanitizeText(value);
    const remaining = this.maxBytes - Buffer.byteLength(this.content, "utf8");
    this.content += truncateUtf8(safe, remaining);
  }

  public value(): string {
    return this.content;
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/u, "");
}
