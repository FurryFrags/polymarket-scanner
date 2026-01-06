const CLOBBED = new Set(["books", "ok"]);
const GAMMA_ALLOWED = new Set(["markets", "events", "tags", "sports", "health"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (isApiRoute(url.pathname, "/api/clob")) {
      return handleClob(request, url);
    }

    if (isApiRoute(url.pathname, "/api/gamma")) {
      return handleGamma(request, url);
    }

    if (url.pathname === "/api/trade/execute") {
      return handleTradeExecute(request, env);
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

async function handleTradeExecute(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(["POST", "OPTIONS"]),
    });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, [
      "POST",
      "OPTIONS",
    ]);
  }

  const payload = await readJson(request, 64 * 1024);
  if (!payload.ok) {
    return jsonResponse({ error: payload.error }, 400, ["POST", "OPTIONS"]);
  }

  const {
    marketId,
    tokenId,
    side,
    size,
    price,
    slippage,
    paper,
    clientOrderId,
    timeInForce,
  } = normalizeTradePayload(payload.value);

  const errors = validateTradePayload({
    marketId,
    tokenId,
    side,
    size,
    price,
    slippage,
  });

  if (errors.length > 0) {
    return jsonResponse({ error: "Invalid payload", details: errors }, 422, [
      "POST",
      "OPTIONS",
    ]);
  }

  const limitPrice = applySlippage(price, side, slippage);

  const order = {
    market_id: marketId,
    token_id: tokenId,
    side: side.toUpperCase(),
    size: formatNumber(size, 6),
    price: formatNumber(limitPrice, 6),
    time_in_force: (timeInForce || "GTC").toUpperCase(),
  };

  if (clientOrderId) {
    order.client_order_id = clientOrderId;
  }

  const signerKey = env?.POLYMARKET_PRIVATE_KEY;
  if (!signerKey) {
    return jsonResponse(
      {
        error:
          "POLYMARKET_PRIVATE_KEY missing. Store secrets via `wrangler secret put`.",
      },
      500,
      ["POST", "OPTIONS"]
    );
  }

  const signature = await signOrder(order, signerKey);
  const orderPayload = {
    ...order,
    signature,
  };

  if (paper) {
    return jsonResponse(
      {
        status: "paper",
        order: orderPayload,
        message: "Paper mode enabled. No live order submitted.",
      },
      200,
      ["POST", "OPTIONS"]
    );
  }

  const apiKey = env?.POLYMARKET_API_KEY;
  const apiSecret = env?.POLYMARKET_API_SECRET;
  const apiPassphrase = env?.POLYMARKET_API_PASSPHRASE;

  if (!apiKey || !apiSecret || !apiPassphrase) {
    return jsonResponse(
      {
        error:
          "Missing API credentials. Set POLYMARKET_API_KEY, POLYMARKET_API_SECRET, POLYMARKET_API_PASSPHRASE via `wrangler secret put`.",
      },
      500,
      ["POST", "OPTIONS"]
    );
  }

  const body = JSON.stringify(orderPayload);
  const upstream = "https://clob.polymarket.com/orders";
  const timestamp = new Date().toISOString();
  const authSignature = await signRequest(
    `${timestamp}POST/orders${body}`,
    apiSecret
  );

  try {
    const upstreamResp = await fetch(upstream, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "cf-worker/trade-execute",
        "POLYMARKET-API-KEY": apiKey,
        "POLYMARKET-API-PASSPHRASE": apiPassphrase,
        "POLYMARKET-API-TIMESTAMP": timestamp,
        "POLYMARKET-API-SIGNATURE": authSignature,
      },
      body,
    });

    const respText = await upstreamResp.text();
    let respData;
    try {
      respData = JSON.parse(respText);
    } catch {
      respData = respText;
    }

    return jsonResponse(
      {
        status: upstreamResp.ok ? "submitted" : "rejected",
        httpStatus: upstreamResp.status,
        response: respData,
      },
      upstreamResp.ok ? 200 : 502,
      ["POST", "OPTIONS"]
    );
  } catch (error) {
    return jsonResponse(
      { error: String(error?.message || error) },
      502,
      ["POST", "OPTIONS"]
    );
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

function isApiRoute(pathname, base) {
  return pathname === base || pathname.startsWith(`${base}/`);
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

async function readJson(request, maxBytes) {
  try {
    const buf = await request.arrayBuffer();
    if (buf.byteLength > maxBytes) {
      return { ok: false, error: "Body too large" };
    }
    const text = new TextDecoder().decode(buf);
    if (!text.trim()) {
      return { ok: false, error: "Empty body" };
    }
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

function normalizeTradePayload(payload) {
  return {
    marketId: payload?.marketId ? String(payload.marketId) : "",
    tokenId: payload?.tokenId ? String(payload.tokenId) : "",
    side: payload?.side ? String(payload.side).toLowerCase() : "",
    size: Number(payload?.size),
    price: Number(payload?.price),
    slippage: Number(payload?.slippage ?? 0),
    paper: Boolean(payload?.paper),
    clientOrderId: payload?.clientOrderId
      ? String(payload.clientOrderId)
      : "",
    timeInForce: payload?.timeInForce ? String(payload.timeInForce) : "GTC",
  };
}

function validateTradePayload({ marketId, tokenId, side, size, price, slippage }) {
  const errors = [];
  if (!marketId) errors.push("marketId is required");
  if (!tokenId) errors.push("tokenId is required");
  if (!["buy", "sell"].includes(side)) errors.push("side must be buy or sell");
  if (!Number.isFinite(size) || size <= 0) errors.push("size must be > 0");
  if (!Number.isFinite(price) || price <= 0 || price >= 1) {
    errors.push("price must be between 0 and 1");
  }
  if (!Number.isFinite(slippage) || slippage < 0 || slippage > 0.2) {
    errors.push("slippage must be between 0 and 0.2");
  }
  return errors;
}

function applySlippage(price, side, slippage) {
  const factor = side === "buy" ? 1 + slippage : 1 - slippage;
  const adjusted = price * factor;
  return Math.min(0.9999, Math.max(0.0001, adjusted));
}

function formatNumber(value, decimals) {
  return Number(value).toFixed(decimals);
}

async function signOrder(order, privateKey) {
  const payload = stableStringify(order);
  return hmacHex(privateKey, payload);
}

async function signRequest(message, secret) {
  return hmacHex(secret, message);
}

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function stableStringify(obj) {
  const keys = Object.keys(obj).sort();
  const stable = {};
  for (const key of keys) {
    stable[key] = obj[key];
  }
  return JSON.stringify(stable);
}
