import { TableScriptLimits } from "@shared/types/tableScript";
import { ScriptNetworkError, type ScriptHttpResponse } from "./network";
import { ScriptProtocol } from "./protocol";

const response: ScriptHttpResponse = {
  status: 200,
  reason: "OK",
  headers: [],
  body: "",
};
const request = {
  type: "http",
  id: 1,
  method: "GET",
  url: "https://example.com",
  headers: [],
  body: "",
  timeoutMs: 1000,
};

function setup() {
  const send = vi.fn();
  const fail = vi.fn();
  const forward = vi.fn().mockResolvedValue(response);
  const controller = new AbortController();
  return {
    send,
    fail,
    forward,
    controller,
    protocol: new ScriptProtocol(send, fail, controller.signal, forward),
  };
}

it("accepts fragmented Unicode output and prepared HTTP requests", async () => {
  const { protocol, fail, forward, send } = setup();
  const frame = Buffer.from(
    `${JSON.stringify({ type: "output", text: "测试\n" })}\n${JSON.stringify(request)}\n`
  );
  for (let index = 0; index < frame.length; index += 2) {
    protocol.receive(frame.subarray(index, index + 2));
  }
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(protocol.output).toBe("测试\n");
  expect(forward).toHaveBeenCalledOnce();
  expect(JSON.parse(send.mock.calls[0][0])).toEqual({
    type: "http_result",
    id: 1,
    response,
  });
  expect(fail).not.toHaveBeenCalled();
});

it("rejects malformed framing, truncated data and oversized unterminated frames", () => {
  for (const frame of [
    "not-json\n",
    '{"type":"shell","command":"anything"}\n',
    "x".repeat(512 * 1024 + 1),
  ]) {
    const { protocol, fail, forward } = setup();
    protocol.receive(Buffer.from(frame));
    expect(fail).toHaveBeenCalledOnce();
    expect(forward).not.toHaveBeenCalled();
  }
  const { protocol, fail } = setup();
  protocol.receive(Buffer.from('{"type":'));
  protocol.finish();
  expect(fail).toHaveBeenCalledOnce();
});

it("counts UTF-8 output bytes and refuses more requests after exhaustion", () => {
  const { protocol, fail, forward } = setup();
  for (let index = 0; index < 12; index++) {
    protocol.receive(
      Buffer.from(
        `${JSON.stringify({ type: "output", text: "字".repeat(2000) })}\n`
      )
    );
  }
  protocol.receive(Buffer.from(`${JSON.stringify(request)}\n`));
  expect(Buffer.byteLength(protocol.output)).toBeLessThanOrEqual(
    TableScriptLimits.outputBytes
  );
  expect(fail).toHaveBeenCalledWith("Console output exceeds 64 KiB");
  expect(forward).not.toHaveBeenCalled();
});

it("enforces HTTP count and request IDs outside the untrusted Python adapter", () => {
  const { protocol, fail, forward } = setup();
  for (let id = 1; id <= 21; id++) {
    protocol.receive(Buffer.from(`${JSON.stringify({ ...request, id })}\n`));
  }
  expect(forward).toHaveBeenCalledTimes(20);
  expect(fail).toHaveBeenCalledOnce();
  const other = setup();
  other.protocol.receive(
    Buffer.from(`${JSON.stringify(request)}\n${JSON.stringify(request)}\n`)
  );
  expect(other.forward).toHaveBeenCalledOnce();
  expect(other.fail).toHaveBeenCalledOnce();
});

it("sanitizes infrastructure errors and sends no response after cancellation", async () => {
  const { protocol, send, forward, controller } = setup();
  forward.mockRejectedValueOnce(new Error("host credential details"));
  protocol.receive(Buffer.from(`${JSON.stringify(request)}\n`));
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(send.mock.calls[0][0]).not.toContain("credential");
  expect(send.mock.calls[0][0]).toContain("HTTP request failed");
  forward.mockRejectedValueOnce(
    new ScriptNetworkError(
      "Private and reserved network addresses are unavailable"
    )
  );
  protocol.receive(Buffer.from(`${JSON.stringify({ ...request, id: 2 })}\n`));
  controller.abort();
  await Promise.resolve();
  await Promise.resolve();
  expect(send).toHaveBeenCalledOnce();
});
