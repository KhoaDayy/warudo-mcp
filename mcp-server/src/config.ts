import { isIP } from "node:net";

export interface Config {
  /** Optional local bridge endpoint. */
  wsUrl: string;
  /** Warudo's built-in control-plane endpoint. */
  apiWsUrl: string;
}

/** Validate before logging or opening the endpoint; credentials never enter error text. */
export function validateWsUrl(value: string, name = "WebSocket URL"): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid ws:// or wss:// URL.`);
  }
  if (!value.trim() || value !== value.trim() || !["ws:", "wss:"].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error(`${name} must be a valid ws:// or wss:// URL.`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${name} must not contain credentials, query parameters, or fragments.`);
  }
  return parsed.href;
}

function endpoint(env: NodeJS.ProcessEnv, prefix: string, defaultHost: string, defaultPort: number): string {
  const name = `${prefix}_URL`;
  if (env[name] !== undefined) return validateWsUrl(env[name]!, name);
  const host = env[`${prefix}_HOST`] ?? defaultHost;
  const rawPort = env[`${prefix}_PORT`] ?? String(defaultPort);
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
    throw new Error(`${prefix}_PORT must be an integer between 1 and 65535.`);
  }
  // Accept a plain hostname or IPv4/IPv6 literal, never a partial URL.
  const bareHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const ipv6 = isIP(bareHost) === 6;
  if (!ipv6 && !/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host)) {
    throw new Error(`${prefix}_HOST must be a hostname or IP address.`);
  }
  return validateWsUrl(`ws://${ipv6 ? `[${bareHost}]` : host}:${Number(rawPort)}/`, name);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    wsUrl: endpoint(env, "WARUDO_WS", "localhost", 5678),
    apiWsUrl: endpoint(env, "WARUDO_API_WS", "::1", 19053),
  };
}
