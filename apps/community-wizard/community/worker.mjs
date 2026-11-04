const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };
    if (request.method !== "GET")
      return new Response("Setup is in progress", { status: 503, headers });
    if (url.pathname === "/health") {
      try {
        const schema = await env.DB.prepare(
          "SELECT version FROM setup_schema WHERE version = 1",
        ).first();
        if (!schema) throw new Error("Schema not ready");
        return Response.json(
          {
            schema: "pirate.community-setup/1",
            planId: env.PLAN_ID,
            infrastructure: "provisioned",
            firstSong: "not_ready",
          },
          { headers },
        );
      } catch {
        return Response.json(
          { infrastructure: "pending", firstSong: "not_ready" },
          { status: 503, headers },
        );
      }
    }
    if (url.pathname !== "/")
      return new Response("Not found", { status: 404, headers });
    headers["Content-Type"] = "text/html; charset=utf-8";
    headers["Content-Security-Policy"] =
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
    return new Response(
      `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(env.COMMUNITY_NAME)}</title><style>body{margin:0;background:#101914;color:#edf3e9;font:18px/1.6 system-ui;display:grid;min-height:100vh;place-items:center}main{max-width:600px;padding:40px}small{color:#abc89c;letter-spacing:.14em}h1{font-size:48px;line-height:1.15}p{color:#bfcec2}</style><main><small>PIRATE COMMUNITY</small><h1>${escape(env.COMMUNITY_NAME)}</h1><p>Your community’s infrastructure is being set up.</p><p>Song posting will open after creator activation, moderation and publication are connected and verified.</p></main></html>`,
      { headers },
    );
  },
};
