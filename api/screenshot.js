// Screenshot upload endpoint.
//   POST { project, id, img }  where img is a base64 PNG/JPEG data URL
//     -> { url }               public Blob CDN URL for the stored image
//     -> { url: null, durable:false }  when Blob isn't configured (client previews locally)
//
// Kept separate from /api/comments so a large image body never rides along with
// the small JSON comment writes. No auth by design — matches the comments API.
import { saveShot, isDurable } from "../lib/store.js";

const DATA_URL = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/;
const MAX_BYTES = 6 * 1024 * 1024; // guard against oversized uploads

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function readBody(req) {
  if (req.body == null) return {};
  if (typeof req.body === "string") {
    try { const p = JSON.parse(req.body); return p && typeof p === "object" ? p : {}; }
    catch { return {}; }
  }
  if (typeof req.body === "object") return req.body;
  return {};
}

const str = (v, n) => (v == null ? "" : String(v)).slice(0, n);

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  try {
    // Blob not linked yet: succeed quietly so the client falls back to a local
    // preview instead of surfacing an error for a still-optional feature.
    if (!isDurable()) { res.status(200).json({ url: null, durable: false }); return; }

    const body = readBody(req);
    const project = str(body.project, 200) || "default";
    const id = str(body.id, 64) || "shot";
    const m = DATA_URL.exec(typeof body.img === "string" ? body.img : "");
    if (!m) { res.status(400).json({ error: "img must be a base64 png/jpeg data URL" }); return; }

    const buffer = Buffer.from(m[2], "base64");
    if (!buffer.length) { res.status(400).json({ error: "empty image" }); return; }
    if (buffer.length > MAX_BYTES) { res.status(413).json({ error: "screenshot too large" }); return; }

    const url = await saveShot(project, id, buffer, m[1]);
    res.status(200).json({ url });
  } catch (err) {
    console.error("konpo-screenshot error:", err);
    res.status(500).json({ error: "internal error" });
  }
}
