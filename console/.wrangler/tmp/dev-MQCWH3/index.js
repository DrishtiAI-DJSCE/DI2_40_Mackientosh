var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// server/routes.js
var DECISIONS = /* @__PURE__ */ new Set([
  "human_confirmed",
  "human_dismissed",
  "needs_better_view"
]);
var nowUtc = /* @__PURE__ */ __name(() => (/* @__PURE__ */ new Date()).toISOString(), "nowUtc");
function slug(name, existing) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "item";
  if (!existing.has(base)) return base;
  for (let i = 2; ; i += 1) {
    const candidate = `${base}-${i}`;
    if (!existing.has(candidate)) return candidate;
  }
}
__name(slug, "slug");
var ok = /* @__PURE__ */ __name((body, status = 200) => ({ status, body }), "ok");
var bad = /* @__PURE__ */ __name((status, message) => ({ status, body: { error: message } }), "bad");
function makeRouter({ store, assets, describe }) {
  async function tree() {
    const [projects, centres, videos, decided] = await Promise.all([
      store.all("SELECT * FROM projects ORDER BY created_utc"),
      store.all("SELECT * FROM centres ORDER BY created_utc"),
      store.all("SELECT * FROM videos ORDER BY created_utc"),
      store.all(
        "SELECT video_id, COUNT(*) AS n FROM current_decision GROUP BY video_id"
      )
    ]);
    const decidedBy = Object.fromEntries(
      decided.map((r) => [r.video_id, Number(r.n)])
    );
    return projects.map((p) => ({
      id: p.id,
      name: p.name,
      centres: centres.filter((c) => c.project_id === p.id).map((c) => ({
        id: c.id,
        name: c.name,
        videos: videos.filter((v) => v.centre_id === c.id).map((v) => ({
          id: v.id,
          name: v.name,
          video: v.media_url,
          bundle: v.bundle_url,
          overlay: v.overlay_url,
          crops: v.crops_url,
          // Derived, never stored: a recording is processed exactly when a
          // run bundle was registered for it.
          processed: Boolean(v.bundle_url),
          decided: decidedBy[v.id] ?? 0
        }))
      }))
    }));
  }
  __name(tree, "tree");
  return /* @__PURE__ */ __name(async function route(method, pathname, body) {
    const seg = pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
    if (!pathname.startsWith("/api/")) return null;
    if (method === "GET" && pathname === "/api/tree") {
      return ok({ projects: await tree() });
    }
    if (method === "GET" && pathname === "/api/health") {
      return ok({
        ok: true,
        store: store.kind,
        vision: Boolean(describe),
        projects: Number(
          (await store.get("SELECT COUNT(*) AS n FROM projects"))?.n ?? 0
        ),
        decisions: Number(
          (await store.get("SELECT COUNT(*) AS n FROM decisions"))?.n ?? 0
        )
      });
    }
    if (method === "GET" && pathname === "/api/assets") {
      return ok(await assets());
    }
    if (method === "POST" && pathname === "/api/projects") {
      const name = String(body?.name ?? "").trim();
      if (!name) return bad(400, "A project needs a name.");
      const taken = new Set(
        (await store.all("SELECT id FROM projects")).map((r) => r.id)
      );
      const id = slug(name, taken);
      await store.run(
        "INSERT INTO projects (id, name, created_utc) VALUES (?, ?, ?)",
        [id, name, nowUtc()]
      );
      return ok({ id, name, projects: await tree() }, 201);
    }
    if (method === "POST" && seg[0] === "projects" && seg[2] === "centres") {
      const project = await store.get("SELECT id FROM projects WHERE id = ?", [
        seg[1]
      ]);
      if (!project) return bad(404, "No such project.");
      const name = String(body?.name ?? "").trim();
      if (!name) return bad(400, "A centre needs a name.");
      const taken = new Set(
        (await store.all("SELECT id FROM centres")).map((r) => r.id)
      );
      const id = slug(`${seg[1]}-${name}`, taken);
      await store.run(
        "INSERT INTO centres (id, project_id, name, created_utc) VALUES (?,?,?,?)",
        [id, seg[1], name, nowUtc()]
      );
      return ok({ id, projects: await tree() }, 201);
    }
    if (method === "POST" && seg[0] === "centres" && seg[2] === "videos") {
      const centre = await store.get("SELECT id FROM centres WHERE id = ?", [
        seg[1]
      ]);
      if (!centre) return bad(404, "No such centre.");
      const name = String(body?.name ?? "").trim();
      if (!name) return bad(400, "A recording needs a name.");
      const taken = new Set(
        (await store.all("SELECT id FROM videos")).map((r) => r.id)
      );
      const id = slug(name, taken);
      const pick = /* @__PURE__ */ __name((k) => {
        const v = body?.[k];
        return typeof v === "string" && v.trim() ? v.trim() : null;
      }, "pick");
      await store.run(
        `INSERT INTO videos
           (id, centre_id, name, media_url, bundle_url, overlay_url, crops_url,
            source_path, created_utc)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          id,
          seg[1],
          name,
          pick("media_url"),
          pick("bundle_url"),
          pick("overlay_url"),
          pick("crops_url"),
          pick("source_path"),
          nowUtc()
        ]
      );
      return ok({ id, projects: await tree() }, 201);
    }
    if (method === "DELETE" && ["projects", "centres", "videos"].includes(seg[0]) && seg[1]) {
      await store.run(`DELETE FROM ${seg[0]} WHERE id = ?`, [seg[1]]);
      return ok({ projects: await tree() });
    }
    if (method === "GET" && seg[0] === "videos" && seg[2] === "decisions") {
      const [rows, total] = await Promise.all([
        store.all("SELECT * FROM current_decision WHERE video_id = ?", [seg[1]]),
        store.get("SELECT COUNT(*) AS n FROM decisions WHERE video_id = ?", [
          seg[1]
        ])
      ]);
      return ok({
        current: Object.fromEntries(rows.map((r) => [r.track_id, r])),
        revisions: Number(total?.n ?? 0)
      });
    }
    if (method === "POST" && seg[0] === "videos" && seg[2] === "decisions") {
      const video = await store.get("SELECT id FROM videos WHERE id = ?", [
        seg[1]
      ]);
      if (!video) return bad(404, "No such recording.");
      const decision = String(body?.decision ?? "");
      if (!DECISIONS.has(decision)) {
        return bad(400, `decision must be one of ${[...DECISIONS].join(", ")}`);
      }
      const trackId = Number(body?.track_id);
      if (!Number.isInteger(trackId)) {
        return bad(400, "track_id must be an integer.");
      }
      const { lastId } = await store.run(
        `INSERT INTO decisions
           (video_id, track_id, decision, machine_state, key_class, key_verdict,
            key_pts_ms, note, reviewer, decided_utc)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          seg[1],
          trackId,
          decision,
          body?.machine_state ?? null,
          body?.key_class ?? null,
          body?.key_verdict ?? null,
          body?.key_pts_ms ?? null,
          body?.note ?? null,
          body?.reviewer ?? "local",
          nowUtc()
        ]
      );
      return ok(
        await store.get("SELECT * FROM decisions WHERE id = ?", [lastId]),
        201
      );
    }
    if (method === "GET" && seg[0] === "videos" && seg[2] === "dismissed") {
      return ok({
        rows: await store.all(
          `SELECT * FROM current_decision
            WHERE video_id = ? AND decision = 'human_dismissed'
            ORDER BY id DESC`,
          [seg[1]]
        )
      });
    }
    if (method === "GET" && pathname === "/api/labels.jsonl") {
      const rows = await store.all("SELECT * FROM decisions ORDER BY id");
      return {
        status: 200,
        text: rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""),
        type: "application/x-ndjson"
      };
    }
    if (method === "POST" && pathname === "/api/vision") {
      if (!describe) return bad(503, "Image description is not configured.");
      return await describe(body ?? {});
    }
    return bad(404, `No API route for ${method} ${pathname}`);
  }, "route");
}
__name(makeRouter, "makeRouter");

// worker/index.js
function d1Store(db) {
  return {
    kind: "d1",
    async all(sql, params = []) {
      return (await db.prepare(sql).bind(...params).all()).results ?? [];
    },
    async get(sql, params = []) {
      return await db.prepare(sql).bind(...params).first();
    },
    async run(sql, params = []) {
      const res = await db.prepare(sql).bind(...params).run();
      return { lastId: res.meta?.last_row_id ?? null };
    }
  };
}
__name(d1Store, "d1Store");
async function r2Assets(bucket) {
  const pick = /* @__PURE__ */ __name(async (prefix, test) => {
    const out = [];
    let cursor;
    do {
      const page = await bucket.list({ prefix, cursor, limit: 1e3 });
      for (const o of page.objects) {
        const name = o.key.slice(prefix.length);
        if (name && test(name)) {
          out.push({ url: `/${o.key}`, name, bytes: o.size });
        }
      }
      cursor = page.truncated ? page.cursor : void 0;
    } while (cursor);
    return out;
  }, "pick");
  const cropDirs = [];
  {
    let cursor;
    do {
      const page = await bucket.list({
        prefix: "crops/",
        delimiter: "/",
        cursor,
        limit: 1e3
      });
      for (const p of page.delimitedPrefixes ?? []) {
        cropDirs.push({
          url: `/${p.replace(/\/$/, "")}`,
          name: p.slice("crops/".length).replace(/\/$/, ""),
          bytes: 0
        });
      }
      cursor = page.truncated ? page.cursor : void 0;
    } while (cursor);
  }
  return {
    media: await pick("media/", (n) => /\.(mp4|webm|mkv)$/i.test(n)),
    bundles: await pick(
      "data/",
      (n) => n.endsWith(".json") && !n.includes(".overlay")
    ),
    overlays: await pick("data/", (n) => n.endsWith(".overlay.json")),
    crops: cropDirs
  };
}
__name(r2Assets, "r2Assets");
var SYSTEM_PROMPT = `You are describing a still frame from exam-hall CCTV for a human reviewer.

Rules you must follow exactly:
- Describe ONLY what is visible in the image. Never infer intent.
- You are NOT deciding whether anyone cheated. That is a human's decision and you must not state or imply a verdict.
- If the object is too small, blurred, or occluded to identify, say so plainly. "Cannot tell" is a correct and useful answer.
- Never invent detail that is not in the pixels. No names, no seat numbers, no time of day.
- Prefer the boring, literal reading. Most objects in an exam hall are keyboards, mice, monitors, water bottles, answer sheets and question papers.

Reply as strict JSON, no markdown fence, exactly:
{"title": "<max 6 words, what is visible>", "description": "<1-2 sentences, literal, max 45 words>", "object_guess": "<one of: phone, paper, keyboard, mouse, monitor, bottle, hand_only, cannot_tell>", "confidence": "<one of: clear, unclear, cannot_tell>"}`;
async function describeImage(key, { image, question }) {
  if (typeof image !== "string" || !image.startsWith("data:image/")) {
    return { status: 400, body: { error: "image must be a data: URL" } };
  }
  const upstream = await fetch("https://api.cerebras.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      // Cerebras sits behind Cloudflare, which 1010s a default agent string.
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
    },
    body: JSON.stringify({
      model: "gemma-4-31b",
      max_tokens: 300,
      temperature: 0.2,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: typeof question === "string" && question.trim() ? question.slice(0, 300) : "Describe what is visible around this person's hands."
            },
            { type: "image_url", image_url: { url: image } }
          ]
        }
      ]
    })
  });
  const text = await upstream.text();
  if (!upstream.ok) {
    return {
      status: upstream.status,
      body: { error: `Cerebras ${upstream.status}`, detail: text.slice(0, 400) }
    };
  }
  const content = JSON.parse(text)?.choices?.[0]?.message?.content ?? "";
  let parsed = null;
  try {
    parsed = JSON.parse(
      content.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()
    );
  } catch {
    parsed = null;
  }
  return {
    status: 200,
    body: { model: "gemma-4-31b", parsed, raw: parsed ? null : content }
  };
}
__name(describeImage, "describeImage");
var CACHE = {
  ".mp4": "public, max-age=31536000, immutable",
  ".jpg": "public, max-age=31536000, immutable",
  ".json": "public, max-age=300"
};
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    if (pathname.startsWith("/api/")) {
      const route = makeRouter({
        store: d1Store(env.DB),
        assets: /* @__PURE__ */ __name(() => r2Assets(env.ASSETS_BUCKET), "assets"),
        describe: env.CEREBRAS_API_KEY ? (payload) => describeImage(env.CEREBRAS_API_KEY, payload) : null
      });
      let body;
      if (request.method === "POST") {
        body = await request.json().catch(() => ({}));
      }
      try {
        const out = await route(request.method, pathname, body);
        if (out?.text !== void 0) {
          return new Response(out.text, {
            status: out.status,
            headers: { "content-type": out.type }
          });
        }
        return Response.json(out.body, { status: out.status });
      } catch (e) {
        return Response.json({ error: String(e?.message ?? e) }, { status: 500 });
      }
    }
    if (/^\/(media|data|crops)\//.test(pathname)) {
      const key = pathname.slice(1);
      const rangeHeader = request.headers.get("range");
      const match = rangeHeader?.match(/^bytes=(\d*)-(\d*)$/);
      const options = {};
      if (match && (match[1] !== "" || match[2] !== "")) {
        if (match[1] === "") {
          options.range = { suffix: Number(match[2]) };
        } else {
          options.range = { offset: Number(match[1]) };
          if (match[2] !== "") {
            options.range.length = Number(match[2]) - Number(match[1]) + 1;
          }
        }
      } else {
        options.onlyIf = request.headers;
      }
      const object = await env.ASSETS_BUCKET.get(key, options);
      if (!object) {
        return new Response("Not found", {
          status: match ? 416 : 404
        });
      }
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      headers.set("accept-ranges", "bytes");
      const ext = pathname.slice(pathname.lastIndexOf("."));
      if (CACHE[ext]) headers.set("cache-control", CACHE[ext]);
      if (!object.body) {
        return new Response(null, { status: 304, headers });
      }
      if (options.range) {
        const offset = object.range?.offset ?? Number(match[1] || 0);
        const length = object.range?.length ?? object.size - offset;
        headers.set(
          "content-range",
          `bytes ${offset}-${offset + length - 1}/${object.size}`
        );
        headers.set("content-length", String(length));
        return new Response(object.body, { status: 206, headers });
      }
      return new Response(object.body, { headers });
    }
    return env.ASSETS.fetch(request);
  }
};

// ../../../Users/Hardeep singh/AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../Users/Hardeep singh/AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-HJ0YWk/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// ../../../Users/Hardeep singh/AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-HJ0YWk/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
