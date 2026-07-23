export function redactSensitiveText(value: string): string {
  return value
    .replace(
      /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(
      /\b(https?):\/\/[^/\s:@]+:[^@\s/]+@/gi,
      "$1://[REDACTED]@",
    )
    .replace(
      /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
      "[REDACTED]",
    )
    .replace(
      /\b(?:sk|gh[opusr])[-_][A-Za-z0-9_-]{12,}\b/gi,
      "[REDACTED]",
    )
    .replace(
      /\bAKIA[A-Z0-9]{16}\b/g,
      "[REDACTED]",
    )
    .replace(
      /(\bAuthorization\s*:\s*(?:Bearer|Basic)\s+)\S+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(\b[A-Z][A-Z0-9_]*(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|CREDENTIALS?|AUTH)[A-Z0-9_]*\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s\r\n]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /((?:api[_ -]?key|token|password|secret)\s*[:=]\s*)\S+/gi,
      "$1[REDACTED]",
    );
}

export function boundedRedactedText(value: string, limit = 8_000): string {
  const redacted = redactSensitiveText(value);
  return redacted.length <= limit ? redacted : redacted.slice(-limit);
}

export function safeErrorMessage(error: unknown, limit = 8_000): string {
  if (!(error instanceof Error)) {
    return boundedRedactedText(String(error), limit);
  }
  const processError = error as Error & { stdout?: string; stderr?: string };
  return boundedRedactedText([
    processError.message,
    processError.stdout,
    processError.stderr,
  ].filter(Boolean).join("\n"), limit);
}
