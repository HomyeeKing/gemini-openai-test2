/**
 * Cloudflare Worker proxy to BigModel GLM Coding PaaS v4
 *
 * - Proxies ALL incoming requests to: https://open.bigmodel.cn/api/coding/paas/v4
 * - Preserves method / path / query / body as much as possible
 * - Optionally injects Authorization header from env.GLM_API_KEY
 * - Basic CORS support for browser clients
 *
 * Env:
 * - GLM_API_KEY: (optional) if request has no Authorization, set "Authorization: Bearer <GLM_API_KEY>"
 * - GLM_BASE_URL: (optional) override default base URL
 * - CORS_ALLOW_ORIGIN: (optional) default "*"
 */

const DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";

function joinUrl(baseUrl, incomingUrl) {
  const base = new URL(baseUrl);
  const inUrl = new URL(incomingUrl);

  // Join paths safely: base pathname + incoming pathname
  const basePath = base.pathname.endsWith("/") ? base.pathname.slice(0, -1) : base.pathname;
  const inPath = inUrl.pathname.startsWith("/") ? inUrl.pathname : `/${inUrl.pathname}`;
  base.pathname = `${basePath}${inPath}`;

  // Preserve query string
  base.search = inUrl.search;
  return base.toString();
}

function withCors(resp, req, env) {
  const allowOrigin = env?.CORS_ALLOW_ORIGIN ?? "*";

  // If caller is a browser and allowOrigin is "*", keep it "*".
  // If allowOrigin is a specific origin, reflect it (or set it as configured).
  const acao = allowOrigin === "*" ? "*" : allowOrigin;

  const headers = new Headers(resp.headers);
  headers.set("Access-Control-Allow-Origin", acao);
  headers.set("Vary", "Origin");
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Access-Control-Expose-Headers", "*");

  // For preflight responses we add allow-methods/headers as well.
  if (req.method === "OPTIONS") {
    const reqMethod = req.headers.get("Access-Control-Request-Method") || "GET,POST,PUT,PATCH,DELETE,OPTIONS";
    const reqHeaders = req.headers.get("Access-Control-Request-Headers") || "Authorization,Content-Type";
    headers.set("Access-Control-Allow-Methods", reqMethod);
    headers.set("Access-Control-Allow-Headers", reqHeaders);
    headers.set("Access-Control-Max-Age", "86400");
  }

  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
}

function makePreflightResponse(req, env) {
  // Only treat as CORS preflight when headers indicate it.
  const hasCorsHeaders = req.headers.has("Origin") && req.headers.has("Access-Control-Request-Method");
  if (!hasCorsHeaders) return null;

  const resp = new Response(null, { status: 204 });
  return withCors(resp, req, env);
}

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      const preflight = makePreflightResponse(request, env);
      if (preflight) return preflight;
      // Non-CORS OPTIONS: still proxy through.
    }

    const baseUrl = env?.GLM_BASE_URL || DEFAULT_BASE_URL;
    const targetUrl = joinUrl(baseUrl, request.url);

    const headers = new Headers(request.headers);

    // Ensure we don't forward forbidden / incorrect hop-by-hop headers.
    headers.delete("host");
    headers.delete("content-length");
    headers.delete("connection");
    headers.delete("keep-alive");
    headers.delete("proxy-authenticate");
    headers.delete("proxy-authorization");
    headers.delete("te");
    headers.delete("trailers");
    headers.delete("transfer-encoding");
    headers.delete("upgrade");

    // If user didn't provide Authorization, inject from env (if present).
    if (!headers.has("authorization") && env?.GLM_API_KEY) {
      headers.set("authorization", `Bearer ${env.GLM_API_KEY}`);
    }

    // Preserve streaming where possible; don't auto-decompress issues via accept-encoding.
    // Cloudflare will handle encoding negotiation; removing reduces edge-cases.
    headers.delete("accept-encoding");

    let bodyForFetch = undefined;

    // 对于非 GET/HEAD 请求，先读取 body 到内存，以便打印日志并复用
    if (!["GET", "HEAD"].includes(request.method) && request.body) {
      try {
        // 读取整个请求体为 ArrayBuffer
        // 这会消耗原始流，但我们可以用这个 buffer 创建新的 Response/Request，或者直接传给 fetch
        const buffer = await request.arrayBuffer();
        bodyForFetch = buffer;

        // 尝试解析并打印日志
        try {
          const text = new TextDecoder().decode(buffer);
          // 仅当看起来像 JSON 时才尝试解析
          if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
             const json = JSON.parse(text);
             console.log('request.body content', json);
          } else {
             // 简略打印非 JSON 内容的前 200 字符
             console.log('request.body (raw)', text.slice(0, 200));
          }
        } catch (e) {
          console.log('Failed to parse/log request body:', e.message);
        }
      } catch (e) {
        console.error('Error reading request body:', e);
      }
    }

    const init = {
      method: request.method,
      headers,
      redirect: "manual",
      body: bodyForFetch,
    };
    // Note: We can't use request.signal after reading the body as the stream is disturbed
    // If abort semantics are needed, a more complex solution would be required

    let upstreamResp;
    try {
      upstreamResp = await fetch(targetUrl, init);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
			console.log('fetch error', msg)
      const resp = new Response(JSON.stringify({ error: "Upstream fetch failed", message: msg }), {
        status: 502,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
      return withCors(resp, request, env);
    }

    // Return upstream response (optionally with CORS)
    return withCors(upstreamResp, request, env);
  },
};

