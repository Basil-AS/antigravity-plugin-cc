import test from "node:test";
import assert from "node:assert/strict";

import {
  isSecretFilePath,
  redactSecretContent,
  sanitizeDiffText,
  REDACTED_FILE_CONTENT,
  REDACTED_LINE_TOKEN
} from "../plugins/antigravity/scripts/lib/secrets.mjs";

test("isSecretFilePath identifies sensitive file names and extensions", () => {
  assert.equal(isSecretFilePath(".env"), true);
  assert.equal(isSecretFilePath(".env.local"), true);
  assert.equal(isSecretFilePath("config/prod.env"), true);
  assert.equal(isSecretFilePath("certs/server.pem"), true);
  assert.equal(isSecretFilePath("keys/private.key"), true);
  assert.equal(isSecretFilePath("id_rsa"), true);
  assert.equal(isSecretFilePath("id_ed25519"), true);
  assert.equal(isSecretFilePath("credentials.json"), true);
  assert.equal(isSecretFilePath("secrets.yaml"), true);

  assert.equal(isSecretFilePath("src/index.mjs"), false);
  assert.equal(isSecretFilePath("README.md"), false);
  assert.equal(isSecretFilePath("package.json"), false);
});

test("redactSecretContent redacts full file for sensitive paths", () => {
  const content = "DATABASE_URL=postgres://user:pass@localhost:5432/db";
  const redacted = redactSecretContent(content, ".env.production");
  assert.equal(redacted, REDACTED_FILE_CONTENT);
});

test("redactSecretContent and sanitizeDiffText mask in-content tokens", () => {
  const textWithGhToken = "const token = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';";
  const sanitized = sanitizeDiffText(textWithGhToken);
  assert.ok(!sanitized.includes("ghp_ABCDEF"));
  assert.ok(sanitized.includes(REDACTED_LINE_TOKEN));

  const textWithAws = "AWS_KEY = 'AKIA1234567890ABCDEF';";
  const sanitizedAws = sanitizeDiffText(textWithAws);
  assert.ok(!sanitizedAws.includes("AKIA1234567890ABCDEF"));

  const textWithPrivateKey = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----";
  const sanitizedKey = sanitizeDiffText(textWithPrivateKey);
  assert.ok(sanitizedKey.includes(REDACTED_FILE_CONTENT));
});
