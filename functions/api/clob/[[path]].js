export async function onRequest(context) {
  const { request, params } = context;

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  const segs = Array.isArray(params.path) ? params.path : [];
  const path = segs.join("/");

  // Allow only what this scanner needs
  const allowed = new Set(["books", "ok"]);
  const top = (segs[0] || "").toLowerCase();
  if (!allowed.has(top)) {
    return new Response(JSON.stringify({ error: `Blocked path: ${top}` }), {
      status: 403,
      headers: jsonHeaders(),
    });
  }

  const url = new URL(request.url);
  const upstream = new URL(`https://clob.polymarket.com/${path}`);
  upstream.search = url.search;

  const method = request.method.toUpperCase();
  if (!(method === "GET" || method === "POST")) {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: jsonHeaders(),
    });
  }

  // Read body for POST with a size cap for stability
  let body = undefined;
  if (method === "POST") {
    const buf = await request.arrayBuffer();
    const max = 256 * 1024; // 256KB
    if (buf.byteLength > max) {
      return new Response(JSON.stringify({ error: "Body too large" }), {
        status: 413,
        headers: jsonHeaders(),
      });
    }
    body = buf;
  }

  try {
    const upstreamResp = await fetch(upstream.toString(), {
      method,
      headers: {
        "accept": "application/json",
        "content-type": method === "POST" ? "application/json" : undefined,
        "user-agent": "cf-pages-function/proxy",
      },
      body,
    });

    const respHeaders = new Headers(upstreamResp.headers);
    applyCors(respHeaders);

    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      headers: respHeaders,
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), {
      status: 502,
      headers: jsonHeaders(),
    });
  }
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function applyCors(h) {
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type");
}

function jsonHeaders() {
  return {
    ...corsHeaders(),
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  };
}
