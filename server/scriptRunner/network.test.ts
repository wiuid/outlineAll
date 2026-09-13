import { http, HttpResponse } from "msw";
import type { LookupAddress } from "node:dns";
import { TableScriptLimits } from "@shared/types/tableScript";
import { server } from "@server/test/msw";
import {
  forwardScriptHttpRequest,
  resolveScriptHttpTarget,
  scriptHttpOptions,
  type ScriptHttpRequest,
} from "./network";

const resolve = vi.hoisted(() => vi.fn<() => Promise<LookupAddress[]>>());
vi.mock("node:dns/promises", () => ({ lookup: resolve }));

const request: ScriptHttpRequest = {
  type: "http",
  id: 1,
  url: "https://example.com/data?q=1",
  method: "POST",
  headers: [
    ["Authorization", "Bearer authored-in-python"],
    ["Content-Type", "application/json"],
  ],
  body: Buffer.from('{"text":"测试"}').toString("base64"),
  timeoutMs: 1000,
};

beforeEach(() => {
  resolve.mockReset().mockResolvedValue([{ address: "1.1.1.1", family: 4 }]);
  server.use(http.all("*", () => HttpResponse.error()));
});

it.each([
  "http://127.0.0.1",
  "http://2130706433",
  "http://0x7f000001",
  "http://10.0.0.1",
  "http://172.16.0.1",
  "http://192.168.0.1",
  "http://169.254.169.254",
  "http://0.0.0.0",
  "http://100.64.0.1",
  "http://[::1]",
  "http://[fe80::1]",
  "http://[::ffff:127.0.0.1]",
  "http://[2002:7f00:1::]",
  "http://[fc00::1]",
  "file:///etc/passwd",
  "ftp://example.com",
  "https://example.com:8443",
  "https://user:secret@example.com",
])("rejects unsafe destination %s", async (url) => {
  await expect(resolveScriptHttpTarget(url)).rejects.toThrow();
});

it("rejects mixed public/private DNS and every re-resolved redirect destination", async () => {
  resolve.mockResolvedValueOnce([
    { address: "1.1.1.1", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ]);
  await expect(resolveScriptHttpTarget(request.url)).rejects.toThrow(
    "Private and reserved"
  );
  await expect(resolveScriptHttpTarget(request.url)).resolves.toMatchObject({
    address: "1.1.1.1",
  });
  resolve.mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
  await expect(resolveScriptHttpTarget(request.url)).rejects.toThrow(
    "Private and reserved"
  );
});

it("pins the validated address and retains TLS hostname and certificate checks", async () => {
  const target = await resolveScriptHttpTarget(request.url);
  const options = scriptHttpOptions(
    target,
    {
      ...request,
      headers: [
        ...request.headers,
        ["Host", "127.0.0.1"],
        ["Proxy-Authorization", "secret"],
        ["Transfer-Encoding", "chunked"],
        ["Content-Length", "999"],
      ],
    },
    new AbortController().signal
  );
  expect(options).toMatchObject({
    hostname: "1.1.1.1",
    servername: "example.com",
    rejectUnauthorized: true,
    path: "/data?q=1",
    agent: false,
    headers: {
      host: "example.com",
      connection: "close",
      authorization: "Bearer authored-in-python",
    },
  });
  expect(options.headers).not.toHaveProperty("proxy-authorization");
  expect(options.headers).not.toHaveProperty("transfer-encoding");
  expect(options.headers).toHaveProperty(
    "content-length",
    String(Buffer.from(request.body, "base64").length)
  );
  expect(resolve).toHaveBeenCalledTimes(1);
});

it("rejects CRLF headers and invalid or oversized request bodies", async () => {
  const target = await resolveScriptHttpTarget(request.url);
  expect(() =>
    scriptHttpOptions(
      target,
      { ...request, headers: [["X-Header", "safe\r\nHost: private"]] },
      new AbortController().signal
    )
  ).toThrow("Invalid request headers");
  for (const body of [
    "invalid!",
    Buffer.alloc(TableScriptLimits.httpBodyBytes + 1).toString("base64"),
  ]) {
    await expect(
      forwardScriptHttpRequest(
        { ...request, body },
        new AbortController().signal
      )
    ).rejects.toThrow("Invalid or oversized");
  }
});

it("returns a redirect untouched, leaving the next checked request to requests", async () => {
  let calls = 0;
  server.use(
    http.post("https://*/data", () => {
      calls++;
      return new HttpResponse(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/secret" },
      });
    })
  );
  const result = await forwardScriptHttpRequest(
    request,
    new AbortController().signal
  );
  expect(result.status).toBe(302);
  expect(result.headers).toContainEqual([
    "location",
    "http://127.0.0.1/secret",
  ]);
  expect(calls).toBe(1);
});

it("bounds the raw response before returning it to the Python process", async () => {
  server.use(
    http.post(
      "https://*/data",
      () =>
        new HttpResponse("x".repeat(TableScriptLimits.httpResponseBytes + 1))
    )
  );
  await expect(
    forwardScriptHttpRequest(request, new AbortController().signal)
  ).rejects.toThrow("Response exceeds");
});

it("does not retry failed connections and cancels even a pending DNS lookup", async () => {
  let calls = 0;
  server.use(
    http.post("https://*/data", () => {
      calls++;
      return HttpResponse.error();
    })
  );
  await expect(
    forwardScriptHttpRequest(request, new AbortController().signal)
  ).rejects.toThrow("HTTP connection failed");
  expect(calls).toBe(1);
  resolve.mockImplementationOnce(() => new Promise(() => {}));
  const controller = new AbortController();
  const pending = forwardScriptHttpRequest(request, controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow("Request timed out");
});
