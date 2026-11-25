"""Small pool of open Snowflake connections.

Logging in to Snowflake (key-pair auth) costs a round trip or two on every new
connection. The IT Checks page makes two calls each time it opens, so keeping a
few logged-in connections around saves that wait.

Rules:
  * A connection idle longer than max_idle, or older than max_age, is closed
    instead of reused, so we never hand out an expired session.
  * If the code using a connection raises a Snowflake error, that connection is
    thrown away, not returned, in case the session is broken.
  * At most max_idle_conns sit idle; extra ones are closed on release.
"""
import logging
import threading
import time
from contextlib import contextmanager

logger = logging.getLogger(__name__)


class SnowflakePool:
    def __init__(self, connect, max_idle_conns=4, max_idle=600, max_age=3000, clock=time.monotonic):
        self._connect = connect
        self._max_idle_conns = max_idle_conns
        self._max_idle = max_idle
        self._max_age = max_age
        self._clock = clock
        self._lock = threading.Lock()
        self._idle = []   # [(conn, created_at, released_at)], newest last
        self._closed = False
        self._doomed = set()  # ids of connections that must not go back in the pool

    def _usable(self, conn, created, released, now):
        if now - released > self._max_idle or now - created > self._max_age:
            return False
        try:
            return not conn.is_closed()
        except Exception:
            return False

    @staticmethod
    def _close(conn):
        try:
            conn.close()
        except Exception as e:  # already gone, nothing to do
            logger.debug("Snowflake close failed: %s", e)

    def _acquire(self):
        now = self._clock()
        stale = []
        picked = None
        with self._lock:
            while self._idle:
                conn, created, released = self._idle.pop()
                if self._usable(conn, created, released, now):
                    picked = (conn, created)
                    break
                stale.append(conn)
        for c in stale:
            self._close(c)
        if picked:
            return picked
        return self._connect(), self._clock()

    def discard(self, conn):
        """Close this connection when it's released instead of reusing it
        (e.g. a query on it timed out and may still be running)."""
        with self._lock:
            self._doomed.add(id(conn))

    def _release(self, conn, created, broken):
        with self._lock:
            if id(conn) in self._doomed:
                self._doomed.discard(id(conn))
                broken = True
        if broken:
            self._close(conn)
            return
        with self._lock:
            if not self._closed and len(self._idle) < self._max_idle_conns:
                self._idle.append((conn, created, self._clock()))
                return
        self._close(conn)

    @contextmanager
    def connection(self):
        conn, created = self._acquire()
        broken = False
        try:
            yield conn
        except BaseException as e:
            # HTTPException etc. are normal results; only driver errors mean the session may be bad.
            broken = _is_driver_error(e)
            raise
        finally:
            self._release(conn, created, broken)

    def close_all(self):
        with self._lock:
            self._closed = True
            idle, self._idle = self._idle, []
        for conn, _, _ in idle:
            self._close(conn)


def _is_driver_error(e):
    try:
        from snowflake.connector.errors import Error as SnowflakeError
    except ImportError:  # pragma: no cover
        return True
    return isinstance(e, (SnowflakeError, OSError)) or not isinstance(e, Exception)
