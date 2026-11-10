import http from "node:http";

/**
 * Stub upstream API for proxy tests: a real loopback HTTP server that
 * records every request (method, path, headers, raw body) and answers
 * through a scripted `respond` function. No external network is contacted.
 *
 * `respond({ method, path, headers, body })` returns
 * `{ status, headers, body }`; the default script echoes the request as
 * JSON so tests can assert exactly what the proxy forwarded.
 */
export async function startUpstream({ respond } = {}) {
  /** @type {{ method: string, path: string, headers: object, body: string }[]} */
  const requests = [];

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({
      method: req.method,
      path: req.url,
      headers: { ...req.headers },
      body,
    });

    const script =
      respond ||
      ((incoming) => ({
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          echo: {
            method: incoming.method,
            path: incoming.path,
            authorization: incoming.headers.authorization || null,
            contentType: incoming.headers["content-type"] || null,
            body: incoming.body,
          },
        }),
      }));

    const outcome = await script(requests[requests.length - 1]);
    res.writeHead(outcome.status, outcome.headers || {});
    res.end(outcome.body === undefined ? "" : outcome.body);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  function close() {
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return { url: `http://127.0.0.1:${port}`, requests, close };
}
