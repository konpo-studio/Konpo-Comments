// Single serverless endpoint for all comment operations.
//   GET    ?project=X            -> { durable, threads: [...] }
//   POST   {project, ...thread}  -> create a thread (a pin + first comment)
//   POST   {project, action:'reply', threadId, author, body} -> add a reply
//   PATCH  {project, id, resolved?, body?} -> resolve / reopen / edit
//   DELETE {project, id}         -> remove a thread
//
// No auth by design — this is a tool for trusted preview/review, not public
// production. CORS is wide open because the embed runs on arbitrary origins.
import { listThreads, createThread, updateThread, removeThread, isDurable, archiveEvent } from "../lib/store.js";

// Easter egg: comments left by visitors on the Konpo Notes landing page are
// archived forever — append-only, untouched by resolve/delete on the live list.
const ARCHIVED_PROJECTS = new Set(["konpo-comments-site"]);

const MAX_LEN = 5000;
const str = (v) => (v == null ? "" : String(v)).slice(0, MAX_LEN);
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
// uiState: a small, host-supplied object describing the screen state a comment
// was made in (open tab/modal/panel). Stored verbatim but JSON-cleaned and
// size-guarded so a client can't stuff arbitrary bulk into the shared file.
const jsonState = (v) => {
  if (v == null || typeof v !== "object" || Array.isArray(v)) return null;
  try {
    const s = JSON.stringify(v);
    if (!s || s.length > 4000) return null;
    return JSON.parse(s);
  } catch {
    return null;
  }
};
const newId = () =>
  Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// Always returns a plain object, or {__bad:true} for malformed JSON bodies.
function readBody(req) {
  if (req.body == null) return {};
  if (typeof req.body === "string") {
    if (req.body.trim() === "") return {};
    try {
      const p = JSON.parse(req.body);
      return p && typeof p === "object" && !Array.isArray(p) ? p : { __bad: true };
    } catch {
      return { __bad: true };
    }
  }
  if (typeof req.body === "object" && !Array.isArray(req.body)) return req.body;
  return { __bad: true };
}

const firstScalar = (v) => (Array.isArray(v) ? v[0] : v);

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const body = readBody(req);
  const project =
    str(firstScalar(req.query.project) || (typeof body.project === "string" ? body.project : "") || "default") ||
    "default";

  try {
    if (req.method === "GET") {
      const threads = await listThreads(project);
      res.status(200).json({ durable: isDurable(), threads });
      return;
    }

    if (req.method === "POST" || req.method === "PATCH" || req.method === "DELETE") {
      if (body.__bad) {
        res.status(400).json({ error: "request body must be a JSON object" });
        return;
      }
    }

    if (req.method === "POST") {
      // Reply to an existing thread (applied atomically against the latest file).
      if (body.action === "reply") {
        const reply = {
          id: newId(),
          author: str(body.author) || "Anonymous",
          body: str(body.body),
          createdAt: Date.now(),
        };
        const thread = await updateThread(project, str(body.threadId), (t) => {
          t.replies = Array.isArray(t.replies) ? t.replies : [];
          t.replies.push(reply);
        });
        if (!thread) {
          res.status(404).json({ error: "thread not found" });
          return;
        }
        if (ARCHIVED_PROJECTS.has(project)) {
          await archiveEvent(project, { type: "reply", threadId: thread.id, reply, at: Date.now() });
        }
        res.status(200).json({ thread });
        return;
      }

      // New thread: a comment (pin + first comment) or a stamp (emoji sticker).
      const isStamp = str(body.kind) === "stamp";
      const thread = {
        id: newId(),
        clientId: str(body.clientId), // echoed back so the client can reconcile its optimistic pin
        project,
        kind: isStamp ? "stamp" : "comment",
        stamp: isStamp ? str(body.stamp).slice(0, 16) : "", // the sticker char (emoji / "+1")
        scale: isStamp ? Math.max(1, Math.min(5, num(body.scale) || 1)) : 1, // hold-to-grow size
        path: str(body.path) || "/",
        url: str(body.url),
        selector: str(body.selector),
        label: str(body.label),
        relX: num(body.relX),
        relY: num(body.relY),
        pageX: num(body.pageX),
        pageY: num(body.pageY),
        scrollX: num(body.scrollX),   // viewport scroll when placed (context restore)
        scrollY: num(body.scrollY),
        screenId: str(body.screenId), // host-supplied stable screen/view id
        uiState: jsonState(body.uiState), // host-supplied UI state (tab/modal/panel)
        meta: jsonState(body.meta), // auto-captured browser / OS / screen facts
        shot: str(body.shot), // screenshot URL (usually empty here; filled by a later PATCH)
        shotW: num(body.shotW),
        shotH: num(body.shotH),
        author: str(body.author) || "Anonymous",
        body: str(body.body),
        resolved: false,
        createdAt: Date.now(),
        replies: [],
      };
      await createThread(project, thread);
      if (ARCHIVED_PROJECTS.has(project)) {
        await archiveEvent(project, { type: "thread", thread, at: Date.now() });
      }
      res.status(201).json({ thread });
      return;
    }

    if (req.method === "PATCH") {
      const thread = await updateThread(project, str(body.id), (t) => {
        if (typeof body.resolved === "boolean") t.resolved = body.resolved;
        if (typeof body.body === "string") t.body = str(body.body);
        if (typeof body.shot === "string") t.shot = str(body.shot); // screenshot uploaded after create
        if (body.shotW != null) t.shotW = num(body.shotW);
        if (body.shotH != null) t.shotH = num(body.shotH);
        if (typeof body.selector === "string" && body.selector) t.selector = str(body.selector); // re-anchor upgrade
        if (typeof body.label === "string") t.label = str(body.label);
      });
      if (!thread) {
        res.status(404).json({ error: "thread not found" });
        return;
      }
      res.status(200).json({ thread });
      return;
    }

    if (req.method === "DELETE") {
      const deleted = await removeThread(project, str(body.id));
      res.status(200).json({ deleted }); // idempotent: deleting an absent thread is not an error
      return;
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE, OPTIONS");
    res.status(405).json({ error: "method not allowed" });
  } catch (err) {
    console.error("konpo-comments error:", err);
    res.status(500).json({ error: "internal error" });
  }
}
