import { describe, expect, it } from "vitest";
import {
  boundedRedactedText,
  redactSensitiveText,
  safeErrorMessage,
} from "../src/redaction.js";

describe("durable text redaction", () => {
  it("removes credential-shaped values and URL userinfo", () => {
    const input = [
      "token: abcdefghijklmnopqrstuvwxyz",
      "Authorization: Bearer bearer-secret-value",
      "Authorization: Basic dXNlcjpzZWNyZXQ=",
      "github_pat_1234567890abcdefghijklmnopqrstuvwxyz",
      "AKIA1234567890ABCDEF",
      "AWS_SECRET_ACCESS_KEY=aws-secret-access-value",
      'SERVICE_CREDENTIALS_JSON="credential-json-value"',
      "https://user:password@github.com/owner/repo.git",
      "-----BEGIN PRIVATE KEY-----",
      "private-key-material",
      "-----END PRIVATE KEY-----",
    ].join("\n");

    const result = redactSensitiveText(input);

    expect(result).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(result).not.toContain("bearer-secret-value");
    expect(result).not.toContain("dXNlcjpzZWNyZXQ=");
    expect(result).not.toContain("github_pat_");
    expect(result).not.toContain("AKIA1234567890ABCDEF");
    expect(result).not.toContain("aws-secret-access-value");
    expect(result).not.toContain("credential-json-value");
    expect(result).not.toContain("private-key-material");
    expect(result).not.toContain("user:password");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts before tail truncation so a cut-off label cannot expose its value", () => {
    const secret = "S".repeat(50);
    const input = `token: ${secret}${"x".repeat(7_950)}`;

    const result = boundedRedactedText(input, 8_000);

    expect(result).not.toContain(secret);
  });

  it("normalizes process errors through the same bounded redaction", () => {
    const error = Object.assign(new Error("command failed"), {
      stderr: "api_key=super-secret-value",
    });

    expect(safeErrorMessage(error)).not.toContain("super-secret-value");
  });
});
