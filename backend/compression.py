"""Gzip for finished JSON / text responses.

Only a response sent in one piece gets compressed. Anything streamed (run
progress events, chat streams, file downloads) goes out untouched, so live
updates still arrive the moment they are sent. The browser unzips the body
before the page sees it, so the data itself never changes.
"""
import gzip

import anyio

# Types worth compressing. Images, zips, Excel files etc. are already compressed.
_COMPRESSIBLE = ("application/json", "text/", "application/javascript", "application/xml", "image/svg+xml")
# Big bodies are compressed off the event loop so other requests keep moving.
_THREAD_MIN = 256 * 1024


def _compressible(content_type: str) -> bool:
    ct = content_type.split(";", 1)[0].strip().lower()
    if ct == "text/event-stream":
        return False
    return any(ct == t or (t.endswith("/") and ct.startswith(t)) for t in _COMPRESSIBLE)


def _accepts_gzip(scope) -> bool:
    for name, value in scope.get("headers") or ():
        if name == b"accept-encoding":
            return b"gzip" in value.lower()
    return False


class GZipJSONMiddleware:
    def __init__(self, app, minimum_size: int = 1024, compresslevel: int = 6):
        self.app = app
        self.minimum_size = minimum_size
        self.compresslevel = compresslevel

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not _accepts_gzip(scope):
            return await self.app(scope, receive, send)

        start = None      # held back until we know whether to compress
        passthrough = False

        async def wrapped_send(message):
            nonlocal start, passthrough
            kind = message["type"]

            if kind == "http.response.start":
                start = message
                return

            if passthrough or start is None or kind != "http.response.body":
                if start is not None:
                    await send(start)
                    start = None
                return await send(message)

            # First body message decides.
            first, start = start, None
            body = message.get("body", b"")
            headers = [(k.lower(), v) for k, v in first.get("headers", [])]
            hmap = dict(headers)
            skip = (
                message.get("more_body", False)                      # streamed
                or first.get("status") in (204, 206, 304)
                or b"content-encoding" in hmap
                or b"attachment" in hmap.get(b"content-disposition", b"").lower()  # downloads keep their real size
                or len(body) < self.minimum_size
                or not _compressible(hmap.get(b"content-type", b"").decode("latin-1"))
            )
            if skip:
                passthrough = True
                await send(first)
                return await send(message)

            if len(body) >= _THREAD_MIN:
                packed = await anyio.to_thread.run_sync(gzip.compress, body, self.compresslevel)
            else:
                packed = gzip.compress(body, self.compresslevel)

            out = [(k, v) for k, v in headers if k not in (b"content-length", b"vary")]
            vary = hmap.get(b"vary")
            if vary and b"accept-encoding" not in vary.lower():
                out.append((b"vary", vary + b", Accept-Encoding"))
            else:
                out.append((b"vary", vary or b"Accept-Encoding"))
            out.append((b"content-encoding", b"gzip"))
            out.append((b"content-length", str(len(packed)).encode()))
            passthrough = True
            await send({**first, "headers": out})
            await send({**message, "body": packed, "more_body": False})

        await self.app(scope, receive, wrapped_send)
