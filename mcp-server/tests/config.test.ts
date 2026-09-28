import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, validateWsUrl } from "../src/config.js";
import { discoverApiToken, validateApiToken } from "../src/token.js";

const TOKEN = "0123456789ABCDEF0123456789ABCDEF";

test("config preserves local defaults and accepts IPv6 literals", () => {
  assert.deepEqual(loadConfig({}), { wsUrl: "ws://localhost:5678/", apiWsUrl: "ws://[::1]:19053/" });
  assert.equal(loadConfig({ WARUDO_WS_HOST: "::1" }).wsUrl, "ws://[::1]:5678/");
  assert.equal(loadConfig({ WARUDO_WS_HOST: "[::1]" }).wsUrl, "ws://[::1]:5678/");
  assert.equal(loadConfig({ WARUDO_API_WS_URL: "wss://example.com/warudo" }).apiWsUrl, "wss://example.com/warudo");
});

test("config rejects invalid port/host/URL input before opening sockets", () => {
  for (const port of ["0", "65536", "NaN", "-1", "12.5", "12x", ""]) {
    assert.throws(() => loadConfig({ WARUDO_WS_PORT: port }), /integer/);
  }
  for (const host of ["", "localhost/path", "user@localhost", "localhost:80", "bad host"]) {
    assert.throws(() => loadConfig({ WARUDO_WS_HOST: host }), /hostname/);
  }
  for (const url of ["http://localhost/", "ws://", " ws://localhost/", "ws://localhost/#fragment", "ws://localhost/?token=secret"]) {
    assert.throws(() => validateWsUrl(url));
  }
});

test("URL and token validation errors never echo secrets", () => {
  const secret = "very-secret-value";
  for (const url of [`ws://${secret}:password@localhost/`, `invalid:${secret}`]) {
    assert.throws(() => validateWsUrl(url), (error: Error) => !error.message.includes(secret));
  }
  assert.throws(() => validateApiToken(secret), (error: Error) => !error.message.includes(secret));
  assert.equal(validateApiToken(` ${TOKEN.toLowerCase()} `), TOKEN);
  for (const invalid of ["", TOKEN + "0", TOKEN.slice(1), "z".repeat(32), `${TOKEN}\r\nextra`]) {
    assert.throws(() => validateApiToken(invalid));
  }
});

test("explicit env tokens are validated and invalid overrides never silently fall back", async () => {
  const previous = process.env.WARUDO_API_TOKEN;
  try {
    process.env.WARUDO_API_TOKEN = TOKEN.toLowerCase();
    assert.equal(await discoverApiToken(), TOKEN);
    process.env.WARUDO_API_TOKEN = "secret-invalid-token";
    await assert.rejects(discoverApiToken(), (error: Error) => error.message.includes("32-character") && !error.message.includes("secret-invalid"));
  } finally {
    if (previous === undefined) delete process.env.WARUDO_API_TOKEN;
    else process.env.WARUDO_API_TOKEN = previous;
  }
});
