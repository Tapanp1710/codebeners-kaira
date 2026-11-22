"""Pure-ASGI middleware: correlation IDs, access logging and request-size limits."""

from __future__ import annotations

import logging
import re
import time
import uuid

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.logging import request_id_var
from app.schemas.common import error_response

logger = logging.getLogger("kaira.access")
# A client-supplied X-Request-ID is accepted only if short and character-safe, so it can be
# echoed into logs and headers. Otherwise a fresh uuid4 hex is generated.
_SAFE_ID = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


class RequestContextMiddleware:
    """Assigns X-Request-ID (accepting a safe client-supplied one) and logs each request."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        # dict() keeps the last value when a header repeats. latin-1 decoding maps bytes 1:1.
        incoming = dict(scope.get("headers") or []).get(b"x-request-id", b"").decode("latin-1")
        request_id = incoming if _SAFE_ID.match(incoming) else uuid.uuid4().hex
        # Set before the app runs so every log line in this request has the ID. Reset in finally.
        token = request_id_var.set(request_id)
        start = time.perf_counter()
        status_holder = {"status": 500}

        # Adds X-Request-ID to the response start message and records the status for logging.
        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                status_holder["status"] = message["status"]
                headers = list(message.get("headers") or [])
                headers.append((b"x-request-id", request_id.encode("latin-1")))
                message["headers"] = headers
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            # In finally, so requests that raise still produce an access entry. status stays 500 if
            # no response was started.
            logger.info(
                "request",
                extra={
                    "method": scope.get("method"),
                    "path": scope.get("path"),
                    "status": status_holder["status"],
                    "duration_ms": round((time.perf_counter() - start) * 1000, 1),
                },
            )
            request_id_var.reset(token)


class BodySizeLimitMiddleware:
    """Rejects requests whose body exceeds the configured limit (413).

    Audio upload routes get a larger limit; both Content-Length and streamed bodies
    are checked."""

    def __init__(self, app: ASGIApp, default_limit: int, upload_limit: int) -> None:
        self.app = app
        self.default_limit = default_limit
        self.upload_limit = upload_limit

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path: str = scope.get("path", "")
        # Exact suffix match. The 64_000-byte margin over the audio cap is hard-coded.
        limit = self.upload_limit + 64_000 if path.endswith("/voice/transcribe") else self.default_limit
        headers = dict(scope.get("headers") or [])
        # Fast reject from the declared length. A non-numeric header is ignored here, and the
        # streamed check below still applies.
        declared = headers.get(b"content-length")
        if declared is not None:
            try:
                if int(declared) > limit:
                    await self._reject(scope, receive, send, limit)
                    return
            except ValueError:
                pass

        # Buffer the body (bounded by the limit) so chunked uploads are also enforced.
        chunks: list[bytes] = []
        received = 0
        more = True
        # Memory use is bounded by the limit, not by what the client sends.
        while more:
            message = await receive()
            # Client disconnected mid-upload: return without sending a response.
            if message["type"] == "http.disconnect":
                return
            body = message.get("body", b"")
            received += len(body)
            if received > limit:
                await self._reject(scope, receive, send, limit)
                return
            chunks.append(body)
            more = message.get("more_body", False)

        # The buffered body is replayed to the downstream app so FastAPI can read it normally.
        # Later receive() calls go to the original channel.
        replayed = False

        async def replay_receive() -> Message:
            nonlocal replayed
            if not replayed:
                replayed = True
                return {"type": "http.request", "body": b"".join(chunks), "more_body": False}
            return await receive()

        await self.app(scope, replay_receive, send)

    async def _reject(self, scope: Scope, receive: Receive, send: Send, limit: int) -> None:
        response = error_response(
            "PAYLOAD_TOO_LARGE", "The request body is too large.", 413, {"limit_bytes": limit}
        )
        await response(scope, receive, send)
