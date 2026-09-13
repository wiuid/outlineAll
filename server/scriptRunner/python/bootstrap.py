"""Start one script inside the disposable gVisor sandbox, never on Outline's host."""

import io
import json
import os
import sys
import traceback

# -I ignores user paths and environment variables; only the immutable runtime
# directory is added to make its SDK available.
sys.path.insert(0, os.path.dirname(__file__))
import outline
from transport import Channel, Console, install_requests_transport


def main():
    """Load one snapshot, install standard requests transport, then execute once."""
    reader, writer = sys.stdin, sys.stdout
    line = reader.readline(8 * 1024 * 1024)
    if not line.endswith("\n"):
        return 1
    payload = json.loads(line)
    outline.workbook = outline.Workbook(payload["document"])
    channel = Channel(reader, writer)
    install_requests_transport(channel)
    sys.stdin = io.StringIO("")
    sys.stdout = sys.stderr = Console(channel)
    try:
        exec(compile(payload["source"], "script.py", "exec"), {"__name__": "__main__"})
        return 0
    except SystemExit as error:
        if error.code is None or error.code == 0:
            return 0
        print(error, file=sys.stderr)
        return 1
    except BaseException:
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    code = main()
    # A script cannot keep the sandbox alive by leaving non-daemon threads.
    os._exit(code)
