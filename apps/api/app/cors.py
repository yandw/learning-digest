"""CORS for /v1: the browser extension's service worker calls the API from
a chrome-extension:// origin, so fetch needs the API's CORS cooperation —
host_permissions stay untouched. Port of lib/cors.js as pure ASGI
middleware so headers land before routing and error responses stay
readable from the extension.

Round-1 rules:
- any origin is echoed back in Access-Control-Allow-Origin (a dev setup
  serves the Web app and the unpacked extension from arbitrary local
  origins; there is no cookie auth to protect — credentials are Bearer
  headers the caller already holds)
- preflights (OPTIONS) are answered directly with 204 and the allowed
  headers the clients actually send (Authorization, Content-Type)
- the middleware only owns /v1 paths; every other path is left untouched"""

from __future__ import annotations

ALLOWED_HEADERS = "Authorization, Content-Type"
ALLOWED_METHODS = "GET, POST, PUT, DELETE, OPTIONS"
MAX_AGE_SECONDS = 600


def is_api_path(path: str) -> bool:
    """True for the paths CORS owns: exactly `/v1` or anything below it."""
    pathname = (path or "/").split("?")[0]
    return pathname == "/v1" or pathname.startswith("/v1/")


class V1CorsMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not is_api_path(scope.get("path", "/")):
            await self.app(scope, receive, send)
            return

        origin = None
        for key, value in scope.get("headers") or []:
            if key == b"origin":
                origin = value.decode("latin-1")
                break
        cors_headers = [
            (b"access-control-allow-origin", (origin if isinstance(origin, str) else "*").encode("latin-1")),
            (b"vary", b"Origin"),
            (b"access-control-allow-headers", ALLOWED_HEADERS.encode("latin-1")),
            (b"access-control-allow-methods", ALLOWED_METHODS.encode("latin-1")),
        ]

        if scope["method"] == "OPTIONS":
            # A preflight is answered here and never reaches the router.
            await send({
                "type": "http.response.start",
                "status": 204,
                "headers": cors_headers + [
                    (b"access-control-max-age", str(MAX_AGE_SECONDS).encode("latin-1")),
                ],
            })
            await send({"type": "http.response.body", "body": b""})
            return

        async def send_with_cors(message):
            if message["type"] == "http.response.start":
                message = {
                    **message,
                    "headers": list(message.get("headers") or []) + cors_headers,
                }
            await send(message)

        await self.app(scope, receive, send_with_cors)
