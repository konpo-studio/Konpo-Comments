// "Send to Claude" — turn a comment (or all open comments) into a GitHub issue
// that @claude can act on (it opens a PR for review). Dormant until configured:
// set GITHUB_TOKEN (a token/app installation that can open issues) and
// GITHUB_REPO ("owner/name", the repo whose code the comments are about, with
// the Claude GitHub app installed). Until both exist it returns {configured:false}
// and touches nothing.
//
// No auth by design — same trust model as the rest of Notes (preview/review).
// The prompt is rebuilt server-side from the STORED thread, so the client can't
// inject arbitrary issue bodies; it only names which comment to send.
import { listThreads } from "../lib/store.js";

const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPO; // "owner/name"
const configured = !!(TOKEN && REPO);

const str = (v) => (v == null ? "" : String(v));
const firstScalar = (v) => (Array.isArray(v) ? v[0] : v);

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function readBody(req) {
  if (req.body == null) return {};
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body || "{}"); } catch { return {}; }
  }
  return typeof req.body === "object" ? req.body : {};
}

// One WHERE/FEEDBACK block per comment, built from what the store knows.
function threadBlock(t) {
  const L = [];
  L.push("WHERE:");
  if (t.label) L.push("• " + t.label);
  if (t.selector) L.push("• CSS selector: " + t.selector);
  L.push("• Page: " + (t.path || "/") + (t.url ? "  (" + t.url + ")" : ""));
  L.push("");
  L.push("FEEDBACK:");
  L.push((t.author || "Anonymous") + ": " + (t.body || ""));
  (t.replies || []).forEach((r) => L.push("  ↳ " + (r.author || "Anonymous") + ": " + (r.body || "")));
  return L.join("\n");
}

function buildIssue(threads) {
  const n = threads.length;
  const title = n === 1
    ? "[Notes] " + (threads[0].body || "comment").replace(/\s+/g, " ").slice(0, 70)
    : "[Notes] " + n + " design feedback items";
  const L = ["@claude — apply " + (n === 1 ? "this design feedback" : "these " + n + " design feedback items") + " from Notes to the codebase.", ""];
  threads.forEach((t, i) => {
    if (n > 1) L.push("──── ITEM " + (i + 1) + " of " + n + " ────");
    L.push(threadBlock(t));
    L.push("");
  });
  L.push("TASK: For each item, locate the element in the source (grep the visible text/label first, then confirm with the selector/route), apply the change the feedback asks for, keep edits minimal and consistent with the surrounding code, and open a PR for review. Don't touch unrelated code.");
  return { title, body: L.join("\n") };
}

async function createIssue(title, body) {
  const res = await fetch("https://api.github.com/repos/" + REPO + "/issues", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + TOKEN,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title, body, labels: ["notes", "claude"] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("github " + res.status + ": " + (data.message || ""));
  return data.html_url;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.setHeader("Allow", "POST, OPTIONS"); res.status(405).json({ error: "method not allowed" }); return; }

  const body = readBody(req);
  const project = str(firstScalar(req.query.project) || body.project || "default") || "default";

  if (!configured) {
    res.status(200).json({ configured: false, message: "Send-to-Claude isn't set up yet — add GITHUB_TOKEN + GITHUB_REPO and install the Claude GitHub app on that repo." });
    return;
  }

  try {
    const all = await listThreads(project);
    let threads;
    if (body.all) threads = all.filter((t) => !t.resolved);
    else threads = all.filter((t) => t.id === str(body.threadId));
    if (!threads.length) { res.status(404).json({ error: "no matching comments" }); return; }

    const { title, body: issueBody } = buildIssue(threads.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)));
    const url = await createIssue(title, issueBody);
    res.status(200).json({ configured: true, count: threads.length, url });
  } catch (err) {
    console.error("dispatch error:", err);
    res.status(502).json({ error: "couldn't file the issue", detail: String(err.message || err) });
  }
}
