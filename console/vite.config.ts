import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Server-side proxy for Cerebras inference.
 *
 * The API key is read from the environment and never reaches the browser.
 * Calling Cerebras directly from client code would ship the credential to
 * every viewer, and a key in a bundle is a key that has to be rotated.
 *
 * The prompt is fixed here too, for the same reason the reason-code vocabulary
 * is closed: a caption written by a model that was free to say anything can
 * assert things the pipeline never measured. This one is instructed to
 * describe only what is visible and to refuse to judge.
 */
const SYSTEM_PROMPT = `You are describing a still frame from exam-hall CCTV for a human reviewer.

Rules you must follow exactly:
- Describe ONLY what is visible in the image. Never infer intent.
- You are NOT deciding whether anyone cheated. That is a human's decision and you must not state or imply a verdict.
- If the object is too small, blurred, or occluded to identify, say so plainly. "Cannot tell" is a correct and useful answer.
- Never invent detail that is not in the pixels. No names, no seat numbers, no time of day.
- Prefer the boring, literal reading. Most objects in an exam hall are keyboards, mice, monitors, water bottles, answer sheets and question papers.

Reply as strict JSON, no markdown fence, exactly:
{"title": "<max 6 words, what is visible>", "description": "<1-2 sentences, literal, max 45 words>", "object_guess": "<one of: phone, paper, keyboard, mouse, monitor, bottle, hand_only, cannot_tell>", "confidence": "<one of: clear, unclear, cannot_tell>"}`;

function cerebrasProxy(): Plugin {
  return {
    name: "cerebras-proxy",
    configureServer(server) {
      server.middlewares.use("/api/vision", async (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: "POST only" }));
          return;
        }

        const key = process.env.CEREBRAS_API_KEY;
        if (!key) {
          res.statusCode = 503;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              error:
                "CEREBRAS_API_KEY is not set on the dev server. Export it and restart.",
            }),
          );
          return;
        }

        try {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const { image, question } = JSON.parse(
            Buffer.concat(chunks).toString("utf8"),
          );
          if (typeof image !== "string" || !image.startsWith("data:image/")) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "image must be a data: URL" }));
            return;
          }

          const upstream = await fetch(
            "https://api.cerebras.ai/v1/chat/completions",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${key}`,
                "Content-Type": "application/json",
                // Cerebras sits behind Cloudflare, which 1010s a default
                // Node/undici user agent.
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
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
                        text:
                          typeof question === "string" && question.trim()
                            ? question.slice(0, 300)
                            : "Describe what is visible around this person's hands.",
                      },
                      { type: "image_url", image_url: { url: image } },
                    ],
                  },
                ],
              }),
            },
          );

          const text = await upstream.text();
          if (!upstream.ok) {
            res.statusCode = upstream.status;
            res.setHeader("content-type", "application/json");
            res.end(
              JSON.stringify({
                error: `Cerebras ${upstream.status}`,
                detail: text.slice(0, 400),
              }),
            );
            return;
          }

          const payload = JSON.parse(text);
          const content: string =
            payload?.choices?.[0]?.message?.content ?? "";

          // The model is told to return bare JSON, but a fence still shows up
          // occasionally. Strip it, and if the result still will not parse,
          // hand back the raw text rather than pretending it was structured.
          let parsed: unknown = null;
          const cleaned = content
            .replace(/^```(?:json)?/i, "")
            .replace(/```$/, "")
            .trim();
          try {
            parsed = JSON.parse(cleaned);
          } catch {
            parsed = null;
          }

          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              model: "gemma-4-31b",
              parsed,
              raw: parsed ? null : content,
              usage: payload?.usage ?? null,
            }),
          );
        } catch (e) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: String(e) }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), cerebrasProxy()],
  server: { port: 5178, strictPort: true },
  build: { outDir: "dist", sourcemap: true },
});
