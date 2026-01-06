export async function onRequest(context) {
  const { request, params } = context;

  // Handle CORS preflight (safe even if you only use same-origin)
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  // Only allow GET to Gamma for this simple scanner
  if (request.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: jsonHeaders(),
    });
  }

  // [[path]].js returns an array of segments per Pages routing docs :contentReference[oaicite:8]{index=8}
  const segs = Array.isArray(params.path) ? params.path : [];
  const path = segs.join("/");

  // Tight allowlist to avoid becoming an open proxy
  const allowed = new Set(["markets", "events", "tags", "sports", "health"]);
  const top = (segs[0] || "").toLowerCase();
  if (!allowed.has(top)) {
    return new Response(JSON.stringify({ error: `Blocked path: ${top}` }), {
      status: 403,
      headers: jsonHeaders(),
    });
  }

  const url = new URL(request.url);
  const upstream = new URL(`https://gamma-api.polymarket.com/${path}`);
  upstream.search = url.search; // pass querystring through

  try {
    const upstreamResp = await fetch(upstream.toString(), {
      method: "GET",
      headers: {
        "accept": "application/json",
        // A boring UA helps some edge setups.
        "user-agent": "cf-pages-function/proxy",
      },
    });

    // Pass through body + status; set CORS headers (Cloudflare shows this pattern) :contentReference[oaicite:9]{index=9}
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
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function applyCors(h) {
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type");
}

function jsonHeaders() {
  return {
    ...corsHeaders(),
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  };
}
