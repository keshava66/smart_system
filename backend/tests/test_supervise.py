"""scripts/supervise.py: restart on crash, graceful stop, orphan safety, logs, config.

Runs a tiny stand-in ASGI app under the real supervisor and uvicorn, so it
needs no database. Run: python -m pytest tests/test_supervise.py -q
"""

import os
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND / "scripts"))

import supervise  # noqa: E402

pytestmark = pytest.mark.skipif(not sys.platform.startswith("linux"), reason="process control is Linux-only")

STAND_IN_APP = '''
import os
from pathlib import Path

MARKER = Path(os.environ["SHUTDOWN_MARKER"])

if os.environ.get("CRASH_ON_IMPORT"):
    raise RuntimeError("stand-in app failed to import")


async def app(scope, receive, send):
    if scope["type"] == "lifespan":
        while True:
            message = await receive()
            if message["type"] == "lifespan.startup":
                print("stand-in app started", flush=True)
                await send({"type": "lifespan.startup.complete"})
            elif message["type"] == "lifespan.shutdown":
                MARKER.write_text("shutdown hooks ran")
                await send({"type": "lifespan.shutdown.complete"})
                return
    await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"text/plain")]})
    await send({"type": "http.response.body", "body": b"ok"})
'''


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def wait_for(check, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(0.1)
    raise AssertionError("timed out waiting for condition")


def healthy(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as response:
            return response.status == 200
    except OSError:
        return False


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    stat = Path(f"/proc/{pid}/stat")
    return stat.exists() and stat.read_text().split()[2] != "Z"


@pytest.fixture
def stand_in(tmp_path):
    app_dir = tmp_path / "app"
    app_dir.mkdir()
    (app_dir / "standin.py").write_text(STAND_IN_APP)
    port = free_port()
    env = {
        **os.environ,
        "APP": "standin:app",
        "APP_DIR": str(app_dir),
        "PYTHON_BIN": sys.executable,
        "HOST": "127.0.0.1",
        "PORT": str(port),
        "LOG_FILE": str(tmp_path / "logs" / "backend.log"),
        "PID_FILE": str(tmp_path / "run" / "backend.pid"),
        "SHUTDOWN_MARKER": str(tmp_path / "shutdown.txt"),
        "GRACEFUL_TIMEOUT": "5",
        "RESTART_DELAY": "0",
    }
    started = []

    def start(**overrides):
        process = subprocess.Popen(
            [sys.executable, str(BACKEND / "scripts" / "supervise.py")],
            env={**env, **overrides}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        )
        started.append(process)
        return process

    yield {
        "start": start,
        "port": port,
        "log": lambda: Path(env["LOG_FILE"]).read_text() if Path(env["LOG_FILE"]).exists() else "",
        "pid_file": Path(env["PID_FILE"]),
        "child_pid_file": Path(env["PID_FILE"]).with_suffix(".child.pid"),
        "marker": Path(env["SHUTDOWN_MARKER"]),
    }

    for process in started:
        if process.poll() is None:
            process.kill()
            process.wait()


def test_runs_restarts_after_a_crash_and_stops_gracefully(stand_in):
    supervisor = stand_in["start"]()
    wait_for(lambda: healthy(stand_in["port"]))

    assert stand_in["pid_file"].read_text().strip() == str(supervisor.pid)
    first_child = int(stand_in["child_pid_file"].read_text())
    assert "stand-in app started" in stand_in["log"]()

    os.kill(first_child, signal.SIGKILL)
    wait_for(lambda: "exited unexpectedly" in stand_in["log"]())
    wait_for(lambda: healthy(stand_in["port"]))
    second_child = int(stand_in["child_pid_file"].read_text())
    assert second_child != first_child

    supervisor.send_signal(signal.SIGTERM)
    assert supervisor.wait(timeout=30) == 0
    assert stand_in["marker"].read_text() == "shutdown hooks ran"
    assert not alive(second_child)
    assert not stand_in["pid_file"].exists()
    assert not stand_in["child_pid_file"].exists()
    assert "[supervisor] supervisor stopped" in stand_in["log"]()


def test_every_log_line_is_timestamped(stand_in):
    supervisor = stand_in["start"]()
    wait_for(lambda: healthy(stand_in["port"]))
    urllib.request.urlopen(f"http://127.0.0.1:{stand_in['port']}/anything", timeout=2).read()
    supervisor.send_signal(signal.SIGTERM)
    supervisor.wait(timeout=30)

    lines = [line for line in stand_in["log"]().splitlines() if line]
    assert any('"GET /anything HTTP/1.1" 200' in line for line in lines)
    for line in lines:
        assert line[:4].isdigit() and line[4] == "-" and "T" in line[:11], line


def test_uvicorn_dies_with_a_killed_supervisor(stand_in):
    supervisor = stand_in["start"]()
    wait_for(lambda: healthy(stand_in["port"]))
    child = int(stand_in["child_pid_file"].read_text())

    supervisor.kill()
    supervisor.wait()
    wait_for(lambda: not alive(child), timeout=15)
    assert not healthy(stand_in["port"])


def test_gives_up_after_repeated_crashes(stand_in):
    supervisor = stand_in["start"](CRASH_ON_IMPORT="1")
    assert supervisor.wait(timeout=60) == 1
    log = stand_in["log"]()
    assert "stand-in app failed to import" in log
    assert "giving up" in log
    assert not stand_in["pid_file"].exists()


@pytest.mark.parametrize("overrides, message", [
    ({"PORT": "80a"}, "PORT must be a whole number"),
    ({"PORT": "70000"}, "PORT must be a whole number"),
    ({"TLS_CERT": "/x.pem"}, "both TLS_CERT and TLS_KEY"),
    ({"TLS_CERT": "/nope/cert.pem", "TLS_KEY": "/nope/key.pem"}, "is not readable"),
    ({"PYTHON_BIN": "/nope/python"}, "is not an executable"),
])
def test_refuses_bad_settings(stand_in, overrides, message):
    supervisor = stand_in["start"](**overrides)
    output = supervisor.communicate(timeout=10)[0].decode()
    assert supervisor.returncode == 2
    assert message in output


def test_uvicorn_command_matches_the_old_start_script():
    config = supervise.read_config({
        "PYTHON_BIN": sys.executable, "PORT": "8000",
        "TLS_CERT": __file__, "TLS_KEY": __file__, "ACCESS_LOG": "0",
    })
    command = supervise.uvicorn_command(config)
    assert command[1:4] == ["-m", "uvicorn", "app:app"]
    assert command[command.index("--host") + 1] == "0.0.0.0"
    assert command[command.index("--port") + 1] == "8000"
    assert command[command.index("--ssl-certfile") + 1] == __file__
    assert command[command.index("--ssl-keyfile") + 1] == __file__
    assert "--no-access-log" in command
    assert "--workers" not in command
