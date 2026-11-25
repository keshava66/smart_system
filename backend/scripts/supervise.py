#!/usr/bin/env python3
"""Keep the SmartHub backend running: one uvicorn process, restarted if it dies.

Started by scripts/backend.sh, which reads backend/.env.server. Standard library only.

One process on purpose: query jobs, download tokens and auth caches live in
process memory, so a second worker would break downloads and job polling (see
the Readme). This supervisor adds what plain `nohup uvicorn` lacks:

  * restarts uvicorn within seconds when it exits unexpectedly, backing off
    and giving up after repeated crashes instead of looping forever
  * stops it gracefully on SIGTERM/SIGINT so the app's shutdown hooks run
  * takes uvicorn down with it if the supervisor itself is killed, so an
    orphan never keeps holding the port
  * timestamps every output line and rotates the log by size

Env: PYTHON_BIN, APP (app:app), HOST (0.0.0.0), PORT (8000), TLS_CERT + TLS_KEY,
     LOG_FILE, LOG_MAX_MB (50), LOG_KEEP (5), PID_FILE, ACCESS_LOG (1),
     GRACEFUL_TIMEOUT (30 s), RESTART_DELAY (2 s)
"""

import collections
import logging
import logging.handlers
import os
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent

MAX_RESTART_DELAY = 30
STABLE_AFTER_SECONDS = 60
CRASH_WINDOW_SECONDS = 300
MAX_CRASHES_IN_WINDOW = 5
PR_SET_PDEATHSIG = 1


class ConfigError(Exception):
    pass


def _integer(env, name, default, low, high):
    raw = env.get(name, "")
    if raw == "":
        return default
    try:
        value = int(raw)
    except ValueError:
        value = None
    if value is None or not low <= value <= high:
        raise ConfigError(f"{name} must be a whole number from {low} to {high}, got {raw!r}")
    return value


def read_config(env):
    cert, key = env.get("TLS_CERT", ""), env.get("TLS_KEY", "")
    if bool(cert) != bool(key):
        raise ConfigError("Set both TLS_CERT and TLS_KEY for HTTPS, or neither for HTTP.")
    for name, path in (("TLS_CERT", cert), ("TLS_KEY", key)):
        if path and not os.access(path, os.R_OK):
            raise ConfigError(f"{name} {path} does not exist or is not readable.")

    app_dir = Path(env.get("APP_DIR") or BACKEND_DIR).resolve()
    if not app_dir.is_dir():
        raise ConfigError(f"APP_DIR {app_dir} is not a directory.")

    python_bin = env.get("PYTHON_BIN") or sys.executable
    if not os.access(python_bin, os.X_OK):
        raise ConfigError(f"PYTHON_BIN {python_bin} is not an executable.")

    log_file = env.get("LOG_FILE") or str(BACKEND_DIR / "logs" / "backend.log")
    pid_file = env.get("PID_FILE", "")
    return {
        "python_bin": python_bin,
        "app": env.get("APP") or "app:app",
        "app_dir": app_dir,
        "host": env.get("HOST") or "0.0.0.0",
        "port": _integer(env, "PORT", 8000, 1, 65535),
        "tls_cert": cert,
        "tls_key": key,
        "access_log": env.get("ACCESS_LOG", "1") != "0",
        "graceful_timeout": _integer(env, "GRACEFUL_TIMEOUT", 30, 1, 3600),
        "restart_delay": _integer(env, "RESTART_DELAY", 2, 0, 300),
        "log_file": Path(log_file).resolve(),
        "log_max_bytes": _integer(env, "LOG_MAX_MB", 50, 1, 10240) * 1024 * 1024,
        "log_keep": _integer(env, "LOG_KEEP", 5, 1, 100),
        "pid_file": Path(pid_file).resolve() if pid_file else None,
    }


def uvicorn_command(config):
    cmd = [
        config["python_bin"], "-m", "uvicorn", config["app"],
        "--host", config["host"],
        "--port", str(config["port"]),
        "--timeout-graceful-shutdown", str(config["graceful_timeout"]),
        "--no-server-header",
    ]
    if config["tls_cert"]:
        cmd += ["--ssl-certfile", config["tls_cert"], "--ssl-keyfile", config["tls_key"]]
    if not config["access_log"]:
        cmd.append("--no-access-log")
    return cmd


def open_log(config):
    config["log_file"].parent.mkdir(parents=True, exist_ok=True)
    handler = logging.handlers.RotatingFileHandler(
        config["log_file"], maxBytes=config["log_max_bytes"],
        backupCount=config["log_keep"], encoding="utf-8",
    )
    handler.setFormatter(logging.Formatter("%(message)s"))
    log = logging.getLogger("smarthub.supervisor")
    log.handlers[:] = [handler]
    log.setLevel(logging.INFO)
    log.propagate = False
    return log


def _stamp():
    return datetime.now().astimezone().isoformat(timespec="milliseconds")


def _die_with_parent():
    # Runs in the child just before exec: if the supervisor dies, the kernel
    # sends uvicorn SIGTERM, so it never lingers holding the port.
    import ctypes
    libc = ctypes.CDLL(None, use_errno=True)
    libc.prctl(PR_SET_PDEATHSIG, signal.SIGTERM)


class Supervisor:
    def __init__(self, config):
        self.config = config
        self.log = open_log(config)
        self.stopping = threading.Event()
        self.child = None
        self.child_pid_file = (
            config["pid_file"].with_suffix(".child.pid") if config["pid_file"] else None
        )

    def note(self, message):
        self.log.info(f"{_stamp()} [supervisor] {message}")

    def pump(self, stream):
        for raw in iter(stream.readline, b""):
            line = raw.decode("utf-8", errors="replace").rstrip()
            if line:
                self.log.info(f"{_stamp()} {line}")
        stream.close()

    def spawn(self):
        env = {**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8"}
        child = subprocess.Popen(
            uvicorn_command(self.config),
            cwd=self.config["app_dir"],
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            # Own session: a Ctrl+C in the terminal reaches only the supervisor,
            # which forwards one SIGTERM (a second signal makes uvicorn skip
            # its graceful shutdown).
            start_new_session=True,
            preexec_fn=_die_with_parent if sys.platform.startswith("linux") else None,
        )
        if self.child_pid_file:
            self.child_pid_file.write_text(f"{child.pid}\n")
        return child

    def request_stop(self, signum, _frame):
        if self.stopping.is_set():
            return
        self.stopping.set()
        self.note(f"{signal.Signals(signum).name} received, stopping the backend gracefully")
        child = self.child
        if child and child.poll() is None:
            child.send_signal(signal.SIGTERM)
            # Shutdown hooks close database pools and mark running jobs; allow
            # for them on top of uvicorn's own graceful window.
            timer = threading.Timer(self.config["graceful_timeout"] + 30, self._force_kill, args=(child,))
            timer.daemon = True
            timer.start()

    def _force_kill(self, child):
        if child.poll() is None:
            self.note(f"backend pid {child.pid} did not stop in time, killing it")
            child.kill()

    def write_pid(self):
        pid_file = self.config["pid_file"]
        if pid_file:
            pid_file.parent.mkdir(parents=True, exist_ok=True)
            pid_file.write_text(f"{os.getpid()}\n")

    def remove_pids(self):
        pid_file = self.config["pid_file"]
        if pid_file and pid_file.exists() and pid_file.read_text().strip() == str(os.getpid()):
            pid_file.unlink()
        if self.child_pid_file and self.child_pid_file.exists():
            self.child_pid_file.unlink()

    def run(self):
        signal.signal(signal.SIGTERM, self.request_stop)
        signal.signal(signal.SIGINT, self.request_stop)
        self.write_pid()
        scheme = "https" if self.config["tls_cert"] else "http"
        self.note(
            f"supervisor pid {os.getpid()} starting {self.config['app']} on "
            f"{scheme}://{self.config['host']}:{self.config['port']}"
        )

        crashes = collections.deque()
        delay = self.config["restart_delay"]
        exit_code = 0
        try:
            while not self.stopping.is_set():
                started = time.monotonic()
                self.child = self.spawn()
                self.note(f"backend started, pid {self.child.pid}")
                reader = threading.Thread(target=self.pump, args=(self.child.stdout,), daemon=True)
                reader.start()
                code = self.child.wait()
                reader.join(timeout=5)

                if self.stopping.is_set():
                    self.note(f"backend stopped (exit code {code})")
                    break

                ran = time.monotonic() - started
                now = time.monotonic()
                if ran >= STABLE_AFTER_SECONDS:
                    crashes.clear()
                    delay = self.config["restart_delay"]
                crashes.append(now)
                while crashes and now - crashes[0] > CRASH_WINDOW_SECONDS:
                    crashes.popleft()

                if len(crashes) > MAX_CRASHES_IN_WINDOW:
                    self.note(
                        f"backend exited {len(crashes)} times within {CRASH_WINDOW_SECONDS // 60} minutes, "
                        "giving up. Fix the error above, then run scripts/backend.sh start"
                    )
                    exit_code = 1
                    break

                self.note(f"backend exited unexpectedly (exit code {code}) after {ran:.0f}s, restarting in {delay}s")
                self.stopping.wait(delay)
                delay = min(max(delay, 1) * 2, MAX_RESTART_DELAY)
        finally:
            self.remove_pids()
            self.note("supervisor stopped")
            for handler in self.log.handlers:
                handler.flush()
        return exit_code


def main():
    try:
        config = read_config(os.environ)
    except ConfigError as error:
        print(f"Cannot start: {error}", file=sys.stderr)
        return 2
    return Supervisor(config).run()


if __name__ == "__main__":
    sys.exit(main())
