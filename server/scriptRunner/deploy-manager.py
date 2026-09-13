"""Deploy the trusted manager only to Outline's dedicated rootless Docker.

Build Python with python/Dockerfile and the manager with build.mjs + Dockerfile,
then pass their immutable local image IDs. Credentials are generated locally and
never printed. This helper does not configure or restart an Outline instance.
"""

import argparse
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import subprocess
import time
import uuid
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ACCOUNT = "outline-script"
ACCOUNT_HOME = Path("/data/outline-script")
DIRECTORY = Path(__file__).resolve().parent


def docker(arguments, account, **kwargs):
    """Address only the dedicated account's local socket."""
    return subprocess.run(
        ["docker", f"--host=unix:///run/user/{account.pw_uid}/docker.sock", *arguments],
        check=True, text=True, **kwargs,
    )


def deploy(manager, python):
    """Start the pinned manager after verifying rootless isolation and mounts."""
    for identifier in (manager, python):
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", identifier):
            raise RuntimeError("Only pinned local sha256 image IDs are allowed")
    account = pwd.getpwnam(ACCOUNT)
    if account.pw_uid == 0 or account.pw_dir != str(ACCOUNT_HOME):
        raise RuntimeError("The dedicated rootless account is not configured")
    info = json.loads(docker(["info", "--format", "{{json .}}"], account, capture_output=True).stdout)
    if (
        "name=rootless" not in info["SecurityOptions"]
        or info["DockerRootDir"] != str(ACCOUNT_HOME / "docker")
        or info["CgroupVersion"] != "2"
        or info["CgroupDriver"] != "systemd"
        or "runsc" not in info["Runtimes"]
    ):
        raise RuntimeError("Refusing a daemon without dedicated rootless gVisor isolation")
    for identifier in (manager, python):
        image = docker(["image", "inspect", identifier, "--format", "{{.Id}}"], account, capture_output=True).stdout.strip()
        if image != identifier:
            raise RuntimeError("The pinned image is unavailable on this rootless daemon")

    token_path = ACCOUNT_HOME / "runner-token"
    if not token_path.exists():
        descriptor = os.open(token_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o640)
        with os.fdopen(descriptor, "w") as stream:
            stream.write(secrets.token_hex(32))
    token = token_path.read_text().strip()
    if not re.fullmatch(r"[0-9a-f]{64}", token):
        raise RuntimeError("The existing runner credential is invalid")
    token_path.chmod(0o640)
    os.chown(token_path, 0, account.pw_gid)
    state = ACCOUNT_HOME / "runner-state"
    state.mkdir(exist_ok=True)
    state.chmod(0o770)
    os.chown(state, account.pw_uid, account.pw_gid)
    values = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "RUNNER_MANAGER_IMAGE_ID": manager,
        "RUNNER_PYTHON_IMAGE_ID": python,
        "RUNNER_DOCKER_SOCKET": f"/run/user/{account.pw_uid}/docker.sock",
        "RUNNER_STATE_PATH": str(state),
        "RUNNER_TOKEN_PATH": str(token_path),
    }
    compose = ["compose", "--env-file", "/dev/null", "--file", str(DIRECTORY / "compose.yml")]
    docker([*compose, "up", "--detach", "--pull", "never"], account, env=values)
    ready = False
    for _ in range(60):
        request = Request("http://127.0.0.1:3035/health", headers={"Authorization": f"Bearer {token}"})
        try:
            urlopen(request, timeout=1).close()
        except HTTPError as error:
            # The authenticated server deliberately has no public health API.
            ready = error.code == 404
        except (URLError, TimeoutError, ConnectionError):
            pass
        if ready:
            break
        time.sleep(0.5)
    if ready:
        # Docker can advertise runsc even when its rootless cgroup setup is
        # unusable. Execute one fixed, network-free sample before declaring ready.
        identifier = str(uuid.uuid4())
        sample = {
            "id": identifier,
            "source": "print('OUTLINE_RUNNER_READY')\n",
            "document": {
                "id": identifier,
                "title": "Execution readiness probe",
                "revision": 1,
                "table": {
                    "format": "outline-table",
                    "version": 1,
                    "columns": [{}],
                    "rows": [{"cells": [{"value": 0}]}],
                },
            },
        }
        request = Request(
            f"http://127.0.0.1:3035/runs/{identifier}",
            data=json.dumps(sample).encode(),
            method="POST",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        )
        try:
            with urlopen(request, timeout=20) as response:
                result = json.loads(response.read(4096))
            ready = result == {"status": "succeeded", "output": "OUTLINE_RUNNER_READY\n"}
        except (HTTPError, URLError, TimeoutError, ConnectionError, ValueError):
            ready = False
    if not ready:
        docker([*compose, "stop"], account, env=values)
        raise RuntimeError("Runner did not pass actual gVisor execution preflight; stopped it for investigation")
    metadata = {
        "managerImageId": manager,
        "pythonImageId": python,
        "socket": values["RUNNER_DOCKER_SOCKET"],
        "url": "http://127.0.0.1:3035",
    }
    (ACCOUNT_HOME / "deployment.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print("Rootless gVisor manager ready on loopback port 3035; no Outline instance changed.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manager-image-id", required=True)
    parser.add_argument("--python-image-id", required=True)
    arguments = parser.parse_args()
    deploy(arguments.manager_image_id, arguments.python_image_id)
