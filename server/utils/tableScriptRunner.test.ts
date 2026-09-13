import { http, HttpResponse } from "msw";
import type { TableScriptInput } from "./tableScriptRunner";
import { server } from "@server/test/msw";
import environment from "./environment";
import {
  executeTableScript,
  cancelTableScriptExecution,
} from "./tableScriptRunner";

const runnerUrl = "https://runner.example.com";
const token = "test-credential-with-at-least-32-characters";
const input: TableScriptInput = {
  id: "339b4542-902f-44d8-b0c0-636ef8d13a5d",
  source: "print(1)",
  document: {
    id: "c939b6fa-06e2-458f-8218-80bd3b4203cb",
    title: "Sheet",
    revision: 4,
    table: {
      format: "outline-table",
      version: 1,
      columns: [{}],
      rows: [{ cells: [{ value: 1 }] }],
    },
  },
};

beforeEach(() => {
  environment.TABLE_SCRIPT_RUNNER_URL = runnerUrl;
  environment.TABLE_SCRIPT_RUNNER_TOKEN = token;
});
afterEach(() => {
  delete environment.TABLE_SCRIPT_RUNNER_URL;
  delete environment.TABLE_SCRIPT_RUNNER_TOKEN;
});

it("sends one authenticated source and table snapshot and receives bounded output", async () => {
  let requests = 0;
  server.use(
    http.post(`${runnerUrl}/runs/${input.id}`, async ({ request }) => {
      requests++;
      expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
      expect(await request.json()).toEqual(input);
      return HttpResponse.json({ status: "succeeded", output: "1\n" });
    })
  );
  expect(await executeTableScript(input)).toEqual({
    status: "succeeded",
    output: "1\n",
  });
  expect(requests).toBe(1);
});

it.each([503, 500, 429])(
  "never retries an executor HTTP %s failure",
  async (status) => {
    let requests = 0;
    server.use(
      http.post(`${runnerUrl}/runs/${input.id}`, () => {
        requests++;
        return new HttpResponse("private internal details", { status });
      })
    );
    await expect(executeTableScript(input)).rejects.toMatchObject({
      status: 503,
      message: "The isolated Python execution service is not available",
    });
    expect(requests).toBe(1);
  }
);

it("does not forward credentials or data through a redirect", async () => {
  let redirected = 0;
  server.use(
    http.post(`${runnerUrl}/runs/${input.id}`, () =>
      HttpResponse.redirect("https://another.example.com/steal")
    ),
    http.all("https://another.example.com/steal", () => {
      redirected++;
      return new HttpResponse();
    })
  );
  await expect(executeTableScript(input)).rejects.toMatchObject({
    status: 503,
  });
  expect(redirected).toBe(0);
});

it("rejects oversized multibyte output", async () => {
  server.use(
    http.post(`${runnerUrl}/runs/${input.id}`, () =>
      HttpResponse.json({ status: "succeeded", output: "字".repeat(30000) })
    )
  );
  await expect(executeTableScript(input)).rejects.toMatchObject({
    status: 503,
  });
});

it("requires an explicit acknowledgement of termination", async () => {
  let requests = 0;
  server.use(
    http.delete(`${runnerUrl}/runs/${input.id}`, ({ request }) => {
      requests++;
      expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
      return new HttpResponse(null, { status: 204 });
    })
  );
  await cancelTableScriptExecution(input.id);
  expect(requests).toBe(1);
});
