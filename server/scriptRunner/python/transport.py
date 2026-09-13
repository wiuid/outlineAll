"""Transport for the real requests library inside a networkless sandbox.

The external runner, not this Python code, enforces the network policy. Replacing
this adapter cannot grant a script a network interface or host credentials.
"""

import base64
from email.message import Message
import io
import json
import threading
from types import SimpleNamespace
from urllib.parse import urlsplit

import requests
from requests.adapters import HTTPAdapter
from urllib3.response import HTTPResponse
from urllib3._collections import HTTPHeaderDict


class Channel:
    """Exchange bounded JSON messages with the runner over standard input/output."""

    def __init__(self, reader, writer):
        self._reader = reader
        self._writer = writer
        self._write_lock = threading.Lock()
        self._request_lock = threading.Lock()
        self._sequence = 0

    def send(self, message):
        """Send one complete protocol frame, preserving concurrent print output."""
        with self._write_lock:
            self._writer.write(json.dumps(message, ensure_ascii=True) + "\n")
            self._writer.flush()

    def request(self, payload):
        """Perform one request without retries; serialize access to the reply pipe."""
        with self._request_lock:
            self._sequence += 1
            request_id = self._sequence
            self.send({"type": "http", "id": request_id, **payload})
            line = self._reader.readline(2 * 1024 * 1024)
            if not line.endswith("\n"):
                raise requests.ConnectionError("Execution network channel closed")
            result = json.loads(line)
            if result.get("type") != "http_result" or result.get("id") != request_id:
                raise requests.ConnectionError("Invalid execution network response")
            if result.get("error"):
                error = result["error"]
                if error == "Request timed out":
                    raise requests.Timeout(error)
                raise requests.ConnectionError(error)
            return result["response"]


class RunnerAdapter(HTTPAdapter):
    """Keep requests' preparation, sessions, cookies, redirects and response APIs."""

    def __init__(self, channel):
        super().__init__(max_retries=0)
        self._channel = channel

    def send(self, request, stream=False, timeout=None, verify=True, cert=None, proxies=None):
        """Send a prepared HTTP request through the runner's checked transport."""
        if verify is not True or cert:
            raise requests.RequestException(
                "This runtime uses verified server TLS; custom CA/client certificates are unavailable"
            )
        if proxies:
            raise requests.RequestException("Custom proxies are unavailable in this runtime")
        body = request.body
        if body is None:
            body = b""
        elif isinstance(body, str):
            body = body.encode("utf-8")
        elif not isinstance(body, bytes):
            # requests already prepares JSON, forms and multipart bodies. Keep
            # iterable/file uploads bounded before crossing the process boundary.
            chunks = []
            length = 0
            iterator = _file_chunks(body) if hasattr(body, "read") else iter(body)
            for chunk in iterator:
                chunk = chunk.encode("utf-8") if isinstance(chunk, str) else chunk
                length += len(chunk)
                if length > 256 * 1024:
                    raise requests.RequestException("Request body exceeds 256 KiB")
                chunks.append(chunk)
            body = b"".join(chunks)
        if len(body) > 256 * 1024:
            raise requests.RequestException("Request body exceeds 256 KiB")
        timeouts = timeout if isinstance(timeout, tuple) else (timeout,)
        seconds = [float(value) for value in timeouts if value is not None]
        if any(value <= 0 for value in seconds):
            raise ValueError("Timeout must be greater than zero")
        timeout_ms = min(15000, max(1, int(min(seconds) * 1000))) if seconds else 15000
        parts = urlsplit(request.url)
        url = parts._replace(netloc=parts.netloc.rsplit("@", 1)[-1], fragment="").geturl()
        result = self._channel.request({
            "url": url,
            "method": request.method,
            "headers": list(request.headers.items()),
            "body": base64.b64encode(body).decode("ascii"),
            "timeoutMs": timeout_ms,
        })
        headers = HTTPHeaderDict()
        original_headers = Message()
        for name, value in result["headers"]:
            headers.add(name, value)
            original_headers[name] = value
        raw = HTTPResponse(
            body=io.BytesIO(base64.b64decode(result["body"], validate=True)),
            headers=headers,
            status=result["status"],
            reason=result.get("reason", ""),
            preload_content=False,
            original_response=SimpleNamespace(msg=original_headers, isclosed=lambda: True),
        )
        return self.build_response(request, raw)


def _file_chunks(body):
    while True:
        chunk = body.read(16384)
        if not chunk:
            return
        yield chunk


def install_requests_transport(channel):
    """Install the transport on requests.Session, including requests.get/post."""
    original_init = requests.Session.__init__

    def initialize(session):
        original_init(session)
        session.trust_env = False
        adapter = RunnerAdapter(channel)
        session.mount("http://", adapter)
        session.mount("https://", adapter)

    requests.Session.__init__ = initialize


class Console(io.TextIOBase):
    """Route Python print and traceback output through bounded runner messages."""

    def __init__(self, channel):
        self._channel = channel

    @property
    def encoding(self):
        """Report the console's encoding to standard Python formatters."""
        return "utf-8"

    def write(self, value):
        """Write small frames; the runner applies the authoritative byte limit."""
        for offset in range(0, len(value), 2048):
            self._channel.send({"type": "output", "text": value[offset:offset + 2048]})
        return len(value)

    def flush(self):
        """Every protocol write is already flushed."""

    def writable(self):
        """Allow standard logging handlers to use the console."""
        return True
