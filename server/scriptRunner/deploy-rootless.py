"""Provision only Outline's dedicated rootless Docker daemon on a systemd host.

Run as root with --runsc pointing to the official, checksum-verified ARM64
release below. This does not change /etc/docker or the system docker service.
The runner container is deployed separately after its isolation checks pass.
The pinned upstream release has a known rootless systemd limitation tracked at
https://github.com/google/gvisor/issues/11543. Daemon startup alone is not proof
that Python can run; deploy-manager.py requires a real gVisor execution probe.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import pwd
import shutil
import subprocess
import time


ACCOUNT = "outline-script"
ACCOUNT_HOME = Path("/data/outline-script")
RUNSC_VERSION = "release-20260817.0"
RUNSC_SHA512 = (
    "6394fd161a4af0dc9a2c29f75c3016d05275a55744f124e12023fa7666a9f161c68d6"
    "ce3803ad49205c6a7b5bee0ad2ccf48edff340db344fdafec678c788aa4"
)


def run(arguments, **kwargs):
    """Execute trusted argument tokens without shell expansion."""
    return subprocess.run(arguments, check=True, text=True, **kwargs)


def write_config(path, content, uid=0, gid=0, mode=0o644, update=False):
    """Create a dedicated configuration, refusing to overwrite other settings."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.read_text() != content:
        if not update:
            raise RuntimeError(f"Review {path}, then use --update-config to replace only this account's configuration")
        shutil.copy2(path, path.with_name(f"{path.name}.before-{time.time_ns()}"))
    path.write_text(content)
    path.chmod(mode)
    os.chown(path, uid, gid)


def ensure_subids():
    """Allocate one nonoverlapping subordinate UID/GID range for this account."""
    occupied = []
    assigned = []
    for filename in ("/etc/subuid", "/etc/subgid"):
        entries = [line.split(":") for line in Path(filename).read_text().splitlines() if line]
        ours = [(int(start), int(count)) for name, start, count in entries if name == ACCOUNT]
        assigned.append(ours)
        occupied.extend((int(start), int(start) + int(count)) for _, start, count in entries)
    if any(assigned):
        if assigned[0] != assigned[1] or len(assigned[0]) != 1 or assigned[0][0][1] < 65536:
            raise RuntimeError("Review the dedicated account's existing subordinate ID mappings")
        return
    first = max([100000, *(end for _, end in occupied)])
    last = first + 65535
    run(["usermod", "--add-subuids", f"{first}-{last}", "--add-subgids", f"{first}-{last}", ACCOUNT])


def user_systemctl(uid, arguments):
    """Control only the dedicated account's user service."""
    return run([
        "runuser", "-u", ACCOUNT, "--", "env",
        f"XDG_RUNTIME_DIR=/run/user/{uid}",
        f"DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/{uid}/bus",
        "systemctl", "--user", *arguments,
    ])


def provision(binary, update=False):
    """Install the pinned runtime and start only the isolated account's daemon."""
    if os.geteuid() != 0 or platform.machine() != "aarch64":
        raise RuntimeError("This pinned installer requires root on an ARM64 host")
    if hashlib.sha512(binary.read_bytes()).hexdigest() != RUNSC_SHA512:
        raise RuntimeError("The runsc binary does not match the official release checksum")
    if not Path("/sys/fs/cgroup/cgroup.controllers").exists():
        raise RuntimeError("Rootless resource limits require cgroup v2")
    for command in ("dockerd-rootless.sh", "rootlesskit", "slirp4netns", "fuse-overlayfs", "newuidmap", "newgidmap", "loginctl", "systemctl"):
        if not shutil.which(command):
            raise RuntimeError(f"Missing prerequisite: {command}")
    try:
        account = pwd.getpwnam(ACCOUNT)
    except KeyError:
        if ACCOUNT_HOME.exists():
            raise RuntimeError("The intended dedicated account directory already exists")
        run(["useradd", "--system", "--create-home", "--home-dir", str(ACCOUNT_HOME), "--shell", "/sbin/nologin", ACCOUNT])
        account = pwd.getpwnam(ACCOUNT)
    if account.pw_dir != str(ACCOUNT_HOME) or account.pw_uid == 0:
        raise RuntimeError("The existing account is not the intended isolated service account")
    ACCOUNT_HOME.chmod(0o700)
    ensure_subids()
    runtime = Path("/usr/local/lib/outline-script") / f"runsc-{RUNSC_VERSION}"
    runtime.parent.mkdir(parents=True, exist_ok=True)
    if runtime.exists() and hashlib.sha512(runtime.read_bytes()).hexdigest() != RUNSC_SHA512:
        raise RuntimeError("The installed runtime differs from the pinned release")
    if not runtime.exists():
        shutil.copyfile(binary, runtime)
    runtime.chmod(0o755)
    os.chown(runtime, 0, 0)
    run([str(runtime), "--version"])

    uid, gid = account.pw_uid, account.pw_gid
    for directory in (".config", ".config/docker", ".config/systemd", ".config/systemd/user", "runner-state"):
        path = ACCOUNT_HOME / directory
        path.mkdir(parents=True, exist_ok=True)
        os.chown(path, uid, gid)
        path.chmod(0o770 if directory == "runner-state" else 0o700)

    # Limit the entire isolated account as well as individual Python containers.
    write_config(
        Path(f"/etc/systemd/system/user-{uid}.slice.d/outline-script.conf"),
        "[Slice]\nCPUQuota=200%\nMemoryMax=2G\nMemorySwapMax=0\nTasksMax=1024\nIOWeight=20\n",
        update=update,
    )
    write_config(
        Path(f"/etc/systemd/system/user@{uid}.service.d/outline-script.conf"),
        "[Service]\nDelegate=cpu cpuset io memory pids\n",
        update=update,
    )
    daemon = {
        "data-root": str(ACCOUNT_HOME / "docker"),
        "hosts": [f"unix:///run/user/{uid}/docker.sock"],
        # Namespace GID 0 maps to this account, matching the manager's group.
        "group": "0",
        "exec-opts": ["native.cgroupdriver=systemd"],
        "storage-driver": "fuse-overlayfs",
        "features": {"containerd-snapshotter": False},
        "runtimes": {"runsc": {"path": str(runtime), "runtimeArgs": ["--platform=systrap"]}},
        "log-driver": "local",
        "log-opts": {"max-size": "10m", "max-file": "2"},
    }
    config_path = ACCOUNT_HOME / ".config/docker/daemon.json"
    write_config(config_path, json.dumps(daemon, indent=2) + "\n", uid, gid, 0o600, update=update)
    service = (
        "[Unit]\nDescription=Outline scripts rootless Docker\n"
        "After=network-online.target\nWants=network-online.target\n"
        "StartLimitIntervalSec=60\nStartLimitBurst=3\n\n"
        "[Service]\nEnvironment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n"
        "Environment=DOCKERD_ROOTLESS_ROOTLESSKIT_NET=slirp4netns\n"
        f"ExecStart={shutil.which('dockerd-rootless.sh')} --config-file={config_path}\n"
        "Restart=on-failure\nRestartSec=3\nTimeoutStartSec=90\nTimeoutStopSec=30\n"
        "LimitNOFILE=1048576\nLimitNPROC=infinity\nLimitCORE=0\n"
        "TasksMax=infinity\nDelegate=yes\nKillMode=mixed\n\n"
        "[Install]\nWantedBy=default.target\n"
    )
    write_config(ACCOUNT_HOME / ".config/systemd/user/docker.service", service, uid, gid, 0o600, update=update)
    run(["systemctl", "daemon-reload"])
    run(["loginctl", "enable-linger", ACCOUNT])
    run(["systemctl", "start", f"user@{uid}.service"])
    user_systemctl(uid, ["daemon-reload"])
    user_systemctl(uid, ["reset-failed", "docker.service"])
    user_systemctl(uid, ["enable", "--now", "docker.service"])
    docker = ["docker", f"--host=unix:///run/user/{uid}/docker.sock", "info", "--format", "{{json .SecurityOptions}}"]
    for _ in range(60):
        info = subprocess.run(docker, text=True, capture_output=True)
        if info.returncode == 0 and "name=rootless" in info.stdout:
            break
        time.sleep(0.5)
    else:
        user_systemctl(uid, ["stop", "docker.service"])
        raise RuntimeError("Rootless daemon did not become ready; stopped it for investigation")
    print(json.dumps({"account": ACCOUNT, "uid": uid, "socket": f"unix:///run/user/{uid}/docker.sock", "runsc": str(runtime)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runsc", type=Path)
    parser.add_argument("--update-config", action="store_true")
    parser.add_argument("--stop", action="store_true", help="stop only this account's Docker service")
    arguments = parser.parse_args()
    if arguments.stop:
        user_systemctl(pwd.getpwnam(ACCOUNT).pw_uid, ["stop", "docker.service"])
    elif arguments.runsc:
        provision(arguments.runsc, update=arguments.update_config)
    else:
        parser.error("--runsc or --stop is required")
