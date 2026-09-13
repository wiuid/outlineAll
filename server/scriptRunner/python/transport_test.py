"""Use the installed requests package with a deterministic, offline transport."""

import base64
import gzip
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

import requests
from transport import Channel, install_requests_transport


def reply(request_id, body=b'{"ok":true}', status=200, headers=None):
    return json.dumps({
        "type": "http_result", "id": request_id,
        "response": {
            "status": status, "reason": "Test",
            "headers": headers or [["Content-Type", "application/json; charset=utf-8"]],
            "body": base64.b64encode(body).decode(),
        },
    }) + "\n"


class RequestsTest(unittest.TestCase):
    def setUp(self):
        self.original_init = requests.Session.__init__
        self.reader = io.StringIO(reply(1) + reply(2))
        self.writer = io.StringIO()
        install_requests_transport(Channel(self.reader, self.writer))

    def tearDown(self):
        requests.Session.__init__ = self.original_init

    def frames(self):
        return [json.loads(line) for line in self.writer.getvalue().splitlines()]

    def test_json_params_auth_and_normal_response(self):
        response = requests.post(
            "https://example.com/api", params={"page": 1},
            json={"text": "销售日报"}, headers={"X-Template": "custom"},
            auth=("name", "secret"), timeout=3,
        )
        response.raise_for_status()
        self.assertEqual(response.json(), {"ok": True})
        frame = self.frames()[0]
        self.assertEqual(frame["url"], "https://example.com/api?page=1")
        self.assertEqual(frame["timeoutMs"], 3000)
        self.assertEqual(json.loads(base64.b64decode(frame["body"])), {"text": "销售日报"})
        self.assertEqual(dict(frame["headers"])["X-Template"], "custom")
        self.assertIn("Authorization", dict(frame["headers"]))

    def test_form_and_streamed_upload_preparation(self):
        requests.post("https://example.com", data={"a": "one", "b": "two"})
        requests.put("https://example.com", data=iter([b"hello", b" world"]))
        self.assertEqual(base64.b64decode(self.frames()[0]["body"]), b"a=one&b=two")
        self.assertEqual(base64.b64decode(self.frames()[1]["body"]), b"hello world")

    def test_redirects_and_cookies_use_a_new_checked_request(self):
        self.reader = io.StringIO(reply(1, b"", 302, [
            ["Location", "https://example.com/done"], ["Set-Cookie", "session=value; Path=/"],
        ]) + reply(2))
        requests.Session.__init__ = self.original_init
        install_requests_transport(Channel(self.reader, self.writer))
        with requests.Session() as session:
            response = session.get("https://example.com/start")
        self.assertEqual(len(response.history), 1)
        self.assertEqual(self.frames()[1]["url"], "https://example.com/done")
        self.assertEqual(dict(self.frames()[1]["headers"])["Cookie"], "session=value")

    def test_stream_json_and_compression_remain_requests_features(self):
        self.reader = io.StringIO(reply(1, gzip.compress(b'{"value":42}'), headers=[
            ["Content-Type", "application/json"], ["Content-Encoding", "gzip"],
        ]))
        requests.Session.__init__ = self.original_init
        install_requests_transport(Channel(self.reader, self.writer))
        with requests.get("https://example.com", stream=True) as response:
            self.assertEqual(json.loads(b"".join(response.iter_content(4))), {"value": 42})

    def test_network_error_is_not_retried(self):
        self.reader = io.StringIO(json.dumps({"type": "http_result", "id": 1, "error": "Request timed out"}) + "\n")
        requests.Session.__init__ = self.original_init
        install_requests_transport(Channel(self.reader, self.writer))
        with self.assertRaises(requests.Timeout):
            requests.get("https://example.com")
        self.assertEqual(len(self.frames()), 1)

    def test_unsafe_overrides_and_large_uploads_do_not_cross_channel(self):
        for kwargs in [{"verify": False}, {"proxies": {"https": "http://localhost"}}, {"data": b"x" * (256 * 1024 + 1)}]:
            with self.subTest(kwargs=list(kwargs)), self.assertRaises(requests.RequestException):
                requests.post("https://example.com", **kwargs)
        self.assertEqual(self.frames(), [])


class BootstrapTest(unittest.TestCase):
    def test_read_print_and_requests_through_actual_python_process(self):
        # Only this fixed, authored fixture is executed by the unit test. Running
        # user code still requires DockerScriptSandbox's mandatory runsc check.
        payload = {
            "source": "from outline import workbook\nimport requests\nprint(workbook.sheet().range('A1').values)\nr = requests.post('https://example.com/api', json={'text': '测试'}, timeout=5)\nprint(r.json()['ok'])\n",
            "document": {"id": "fixture", "title": "Fixture", "revision": 1, "table": {
                "version": 1, "columns": [{}], "rows": [{"cells": [{"value": 42}]}],
            }},
        }
        process = subprocess.run(
            [sys.executable, "-I", "-u", str(Path(__file__).with_name("bootstrap.py"))],
            input=json.dumps(payload) + "\n" + reply(1), text=True, capture_output=True,
            timeout=10, env={"PATH": os.environ.get("PATH", "")},
        )
        self.assertEqual(process.returncode, 0, process.stderr)
        frames = [json.loads(line) for line in process.stdout.splitlines()]
        output = "".join(frame["text"] for frame in frames if frame["type"] == "output")
        self.assertEqual(output, "[[42]]\nTrue\n")
        self.assertEqual(sum(frame["type"] == "http" for frame in frames), 1)

    def test_python_failure_has_traceback_and_nonzero_status(self):
        payload = {"source": "raise ValueError('example error')", "document": {
            "id": "fixture", "title": "Fixture", "revision": 1,
            "table": {"version": 1, "columns": [{}], "rows": [{"cells": [{"value": 0}]}]},
        }}
        process = subprocess.run(
            [sys.executable, "-I", "-u", str(Path(__file__).with_name("bootstrap.py"))],
            input=json.dumps(payload) + "\n", text=True, capture_output=True, timeout=10,
        )
        self.assertEqual(process.returncode, 1)
        output = "".join(json.loads(line)["text"] for line in process.stdout.splitlines())
        self.assertIn("ValueError: example error", output)
        self.assertIn('File "script.py", line 1', output)
