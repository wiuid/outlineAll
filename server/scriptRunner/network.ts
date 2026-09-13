import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import http from "node:http";
import type { RequestOptions } from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { z } from "zod";
import { TableScriptLimits } from "@shared/types/tableScript";

/** Untrusted prepared requests from Python, validated outside its sandbox. */
export const scriptHttpRequestSchema = z.strictObject({
  type: z.literal("http"),
  id: z.number().int().positive(),
  url: z.string().min(1).max(8192),
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
  headers: z
    .array(z.tuple([z.string().max(128), z.string().max(8192)]))
    .max(64),
  body: z.string().max(Math.ceil(TableScriptLimits.httpBodyBytes / 3) * 4),
  timeoutMs: z.number().int().min(1).max(TableScriptLimits.httpTimeoutMs),
});

/** A single transport attempt; redirects and retries belong to Python code. */
export type ScriptHttpRequest = z.infer<typeof scriptHttpRequestSchema>;

/** An undecoded response, leaving JSON, cookies and compression to requests. */
export interface ScriptHttpResponse {
  status: number;
  reason: string;
  headers: [string, string][];
  body: string;
}

/** A safe, pinned destination that never relies on a second DNS lookup. */
export interface ScriptHttpTarget {
  url: URL;
  address: string;
  family: number;
  hostname: string;
}

/** Only sanitized transport errors may cross back into the script console. */
export class ScriptNetworkError extends Error {}

/**
 * Resolves a public HTTP destination, rejecting every private or special answer.
 *
 * @param value the script's URL.
 * @param resolve the DNS resolver, injectable for deterministic security tests.
 * @returns one validated address to pin for the lifetime of this connection.
 * @throws {ScriptNetworkError} when the destination is unsafe or unavailable.
 */
export async function resolveScriptHttpTarget(
  value: string,
  resolve: (hostname: string) => Promise<LookupAddress[]> = (hostname) =>
    lookup(hostname, { all: true, verbatim: true })
): Promise<ScriptHttpTarget> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ScriptNetworkError("Invalid HTTP URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port
  ) {
    // URL removes an explicit default port. Alternate ports, credentials and
    // non-HTTP schemes are deliberately unavailable in this execution runtime.
    throw new ScriptNetworkError(
      "Only public HTTP/HTTPS URLs on standard ports are available"
    );
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: LookupAddress[];
  try {
    addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await resolve(hostname);
  } catch {
    throw new ScriptNetworkError("Destination could not be resolved");
  }
  if (
    !addresses.length ||
    addresses.some(({ address }) => !isPublicAddress(address))
  ) {
    throw new ScriptNetworkError(
      "Private and reserved network addresses are unavailable"
    );
  }
  return { url, hostname, ...addresses[0] };
}

/**
 * Builds connection options pinned to a validated IP with the original TLS name.
 *
 * @param target the already checked destination.
 * @param input the validated prepared request.
 * @param signal the execution cancellation/deadline signal.
 * @returns transport options that cannot inherit application proxies or secrets.
 * @throws {ScriptNetworkError} for invalid header framing.
 */
export function scriptHttpOptions(
  target: ScriptHttpTarget,
  input: ScriptHttpRequest,
  signal: AbortSignal
): RequestOptions & { servername?: string; rejectUnauthorized: true } {
  const headers: Record<string, string> = Object.create(null);
  let headerBytes = 0;
  for (const [name, value] of input.headers) {
    headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (
      !/^[!#$%&'*+.^_`|~\da-z-]+$/i.test(name) ||
      value.includes("\r") ||
      value.includes("\n") ||
      value.includes("\0") ||
      headerBytes > 16384
    ) {
      throw new ScriptNetworkError("Invalid request headers");
    }
    if (!discardedHeaders.has(name.toLowerCase())) {
      headers[name.toLowerCase()] = value;
    }
  }
  headers.host = target.url.host;
  headers.connection = "close";
  headers["content-length"] = String(Buffer.from(input.body, "base64").length);
  return {
    protocol: target.url.protocol,
    hostname: target.address,
    family: target.family,
    port: target.url.protocol === "https:" ? 443 : 80,
    servername: isIP(target.hostname) ? undefined : target.hostname,
    rejectUnauthorized: true,
    method: input.method,
    path: target.url.pathname + target.url.search,
    headers,
    signal,
    agent: false,
    maxHeaderSize: 16384,
  };
}

/**
 * Executes a bounded HTTP attempt with DNS pinning, verified TLS and no retries.
 *
 * @param input the prepared request from the sandbox.
 * @param signal the enclosing execution cancellation signal.
 * @returns the raw response; requests handles redirects with a new checked call.
 * @throws {ScriptNetworkError} for blocked destinations, deadlines or size limits.
 */
export async function forwardScriptHttpRequest(
  input: ScriptHttpRequest,
  signal: AbortSignal
): Promise<ScriptHttpResponse> {
  const body = Buffer.from(input.body, "base64");
  if (
    body.length > TableScriptLimits.httpBodyBytes ||
    body.toString("base64") !== input.body
  ) {
    throw new ScriptNetworkError("Invalid or oversized request body");
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) {
    controller.abort();
  }
  const timer = setTimeout(abort, input.timeoutMs);
  try {
    return await new Promise<ScriptHttpResponse>((resolve, reject) => {
      const handleAbort = () =>
        reject(new ScriptNetworkError("Request timed out"));
      controller.signal.addEventListener("abort", handleAbort, { once: true });
      if (controller.signal.aborted) {
        handleAbort();
        return;
      }
      void resolveScriptHttpTarget(input.url)
        .then((target) => {
          if (controller.signal.aborted) {
            return;
          }
          const options = scriptHttpOptions(target, input, controller.signal);
          const transport = target.url.protocol === "https:" ? https : http;
          const request = transport.request(options, (response) => {
            const chunks: Buffer[] = [];
            let bytes = 0;
            response.on("data", (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > TableScriptLimits.httpResponseBytes) {
                reject(new ScriptNetworkError("Response exceeds 1 MiB"));
                response.destroy();
                request.destroy();
                return;
              }
              chunks.push(chunk);
            });
            response.on("error", () =>
              reject(new ScriptNetworkError("HTTP response interrupted"))
            );
            response.on("end", () => {
              const headers: [string, string][] = [];
              for (
                let index = 0;
                index < response.rawHeaders.length;
                index += 2
              ) {
                headers.push([
                  response.rawHeaders[index],
                  response.rawHeaders[index + 1],
                ]);
              }
              resolve({
                status: response.statusCode ?? 502,
                reason: response.statusMessage ?? "",
                headers,
                body: Buffer.concat(chunks).toString("base64"),
              });
            });
          });
          request.on("error", () =>
            reject(new ScriptNetworkError("HTTP connection failed"))
          );
          request.end(body);
        })
        .catch(reject);
    });
  } catch (error) {
    if (error instanceof ScriptNetworkError) {
      throw error;
    }
    throw new ScriptNetworkError("HTTP request failed");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    controller.abort();
  }
}

const discardedHeaders = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "upgrade",
  "proxy-authorization",
  "proxy-connection",
  "expect",
  "te",
  "trailer",
]);

function isPublicAddress(address: string): boolean {
  try {
    return isIP(address) !== 0 && ipaddr.parse(address).range() === "unicast";
  } catch {
    return false;
  }
}
