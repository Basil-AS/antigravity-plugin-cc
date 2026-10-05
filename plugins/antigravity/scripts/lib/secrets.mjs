import path from "node:path";

export const REDACTED_FILE_CONTENT = "[REDACTED SECRET FILE CONTENT]";
export const REDACTED_LINE_TOKEN = "[REDACTED SECRET]";

const SENSITIVE_FILENAME_PATTERNS = [
  /^\.env(\..+)?$/i,
  /\.env$/i,
  /\.(pem|key|pkcs12|p12|pfx|crt|der|kdbx)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\..+)?$/i,
  /\b(credentials|secrets|token|passwords?)\.(json|yaml|yml|toml|ini|xml)$/i
];

const SECRET_PATTERNS = [
  // Private key blocks
  { regex: () => /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi, full: true },
  // GitHub tokens
  { regex: () => /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}\b/g },
  { regex: () => /\bgithub_pat_[A-Za-z0-9_]{82}\b/g },
  // AWS Access Keys
  { regex: () => /\bAKIA[0-9A-Z]{16}\b/g },
  // Slack Tokens
  { regex: () => /\bxox[baprs]-[A-Za-z0-9_-]{10,}\b/g },
  // OpenAI & Google AI / Cloud tokens
  { regex: () => /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { regex: () => /\bAIza[0-9A-Za-z-_]{35}\b/g },
  // Generic token assignments
  {
    regex: () => /(?:api[_-]?key|auth[_-]?token|bearer[_-]?token|private[_-]?key|client[_-]?secret|password)\s*[:=]\s*["']?([A-Za-z0-9_\-.~+/=]{16,})["']?/gi,
    capture: 1
  }
];

export function isSecretFilePath(filePath) {
  if (!filePath) return false;
  const basename = path.basename(filePath);
  const normalized = filePath.replace(/\\/g, "/");

  for (const pattern of SENSITIVE_FILENAME_PATTERNS) {
    if (pattern.test(basename) || pattern.test(normalized)) {
      return true;
    }
  }
  return false;
}

export function redactSecretContent(content, filePath = "") {
  if (!content || typeof content !== "string") return "";

  if (filePath && isSecretFilePath(filePath)) {
    return REDACTED_FILE_CONTENT;
  }

  let sanitized = content;
  for (const item of SECRET_PATTERNS) {
    const rx = item.regex();
    if (item.capture) {
      sanitized = sanitized.replace(rx, (match, captured) => {
        return captured ? match.replace(captured, REDACTED_LINE_TOKEN) : match;
      });
    } else if (item.full) {
      sanitized = sanitized.replace(rx, REDACTED_FILE_CONTENT);
    } else {
      sanitized = sanitized.replace(rx, REDACTED_LINE_TOKEN);
    }
  }

  return sanitized;
}

export function sanitizeDiffText(diffText) {
  return redactSecretContent(diffText);
}
