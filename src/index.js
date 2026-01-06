const CLOBBED = new Set(["books", "ok"]);
const GAMMA_ALLOWED = new Set(["markets", "events", "tags", "sports", "health"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/clob")) {
      return handleClob(request, url);
    }

    if (url.pathname.startsWith("/api/gamma")) {
      return handleGamma(request, url);
    }

    if (!env?.ASSETS || typeof env.ASSETS.fetch !== "function") {
      return jsonResponse(
        {
          error:
            "Assets binding missing. Ensure wrangler.jsonc sets assets.directory.",
        },
        500,
        ["GET", "HEAD", "OPTIONS"]
      );
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleClob(request, url) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(["GET", "POST", "OPTIONS"]),
    });
  }

  const { path, top } = parsePath(url.pathname, "/api/clob");
  if (!CLOBBED.has(top)) {
    return jsonResponse({ error: `Blocked path: ${top}` }, 403, [
      "GET",
      "POST",
      "OPTIONS",
    ]);
  }

  const method = request.method.toUpperCase();
  if (!(method === "GET" || method === "POST")) {
    return jsonResponse({ error: "Method not allowed" }, 405, [
      "GET",
      "POST",
      "OPTIONS",
    ]);
  }

  let body;
  if (method === "POST") {
    const buf = await request.arrayBuffer();
    const max = 256 * 1024;
    if (buf.byteLength > max) {
      return jsonResponse({ error: "Body too large" }, 413, [
        "GET",
        "POST",
        "OPTIONS",
      ]);
    }
    body = buf;
  }

  const upstream = new URL(`https://clob.polymarket.com/${path}`);
  upstream.search = url.search;

  try {
    const upstreamResp = await fetch(upstream.toString(), {
      method,
      headers: {
        accept: "application/json",
        "content-type": method === "POST" ? "application/json" : undefined,
        "user-agent": "cf-worker/proxy",
      },
      body,
    });

    const respHeaders = new Headers(upstreamResp.headers);
    applyCors(respHeaders, ["GET", "POST", "OPTIONS"]);

    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      headers: respHeaders,
    });
  } catch (error) {
    return jsonResponse({ error: String(error?.message || error) }, 502, [
      "GET",
      "POST",
      "OPTIONS",
    ]);
  }
}

async function handleGamma(request, url) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(["GET", "OPTIONS"]),
    });
  }

  if (request.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405, [
      "GET",
      "OPTIONS",
    ]);
  }

  const { path, top } = parsePath(url.pathname, "/api/gamma");
  if (!GAMMA_ALLOWED.has(top)) {
    return jsonResponse({ error: `Blocked path: ${top}` }, 403, [
      "GET",
      "OPTIONS",
    ]);
  }

  const upstream = new URL(`https://gamma-api.polymarket.com/${path}`);
  upstream.search = url.search;

  try {
    const upstreamResp = await fetch(upstream.toString(), {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": "cf-worker/proxy",
      },
    });

    const respHeaders = new Headers(upstreamResp.headers);
    applyCors(respHeaders, ["GET", "OPTIONS"]);

    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      headers: respHeaders,
    });
  } catch (error) {
    return jsonResponse({ error: String(error?.message || error) }, 502, [
      "GET",
      "OPTIONS",
    ]);
  }
}

function parsePath(pathname, prefix) {
  const trimmed = pathname.replace(prefix, "");
  const parts = trimmed.split("/").filter(Boolean);
  return {
    path: parts.join("/"),
    top: (parts[0] || "").toLowerCase(),
  };
}

function corsHeaders(methods) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": methods.join(","),
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function applyCors(headers, methods) {
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", methods.join(","));
  headers.set("Access-Control-Allow-Headers", "Content-Type");
}

function jsonResponse(data, status, methods) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(methods),
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
