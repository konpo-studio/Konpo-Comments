// Storage abstraction.
// Durable: Vercel Blob — one JSON file per project (konpo/v3/<project>.json).
//   Reads hit the public CDN URL directly (cheap bandwidth, NOT a counted Blob
//   operation, so 5s polling stays free). Writes use put() with the RW token.
// Fallback: in-memory map (per warm instance, NOT durable) when Blob isn't
//   configured — keeps the API working for local dev / before the store is linked.
//
// Configuration: only BLOB_READ_WRITE_TOKEN is required — it's what Vercel's Blob
// "Connect Store" injects (tick "Add a read-write token env var"). The public CDN
// base used for cheap polling reads is optional: set BLOB_BASE_URL to pin it,
// otherwise we learn the authoritative origin from the first head()/put() response
// (and fall back to a head() lookup on the read path until we've learned it).
//
// Consistency: the CDN read lags a write by ~1s. Writes are whole-file
// read-modify-write, so a second mutation arriving within that window used to
// read the stale file and silently undo the first one (e.g. rapidly resolving
// two comments un-resolved the first). The file now carries a revision stamp
// ({rev, threads}; bare arrays from older writers are read as rev 0) and each
// instance remembers its own last write — reads prefer whichever is newer, so
// an instance can never read backwards past a write it just made. Writes from
// truly concurrent OTHER instances are still last-write-wins; fine for
// trusted preview/review traffic.
import { put, head } from "@vercel/blob";

const TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const BASE = (process.env.BLOB_BASE_URL || "").replace(/\/$/, ""); // optional read optimization
let learnedBase = ""; // authoritative CDN origin, captured from a real head()/put() URL
const durable = !!TOKEN; // durable whenever we can write; the base is only a read shortcut

const rememberBase = (url) => {
  if (url && !learnedBase) { try { learnedBase = new URL(url).origin; } catch (e) {} }
};
const readBase = () => learnedBase || BASE;

const mem = new Map();
const lastWrite = new Map(); // project -> { rev, threads, at } (this instance's most recent write)
const LAST_WRITE_FRESH_MS = 20000;
const pathFor = (project) => "konpo/v3/" + encodeURIComponent(project) + ".json";
const clone = (v) => JSON.parse(JSON.stringify(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normEtag = (e) => String(e || "").replace(/^W\//, "").replace(/"/g, "");

export const isDurable = () => durable;

// All mutations go through compare-and-swap: head() gives the authoritative
// etag, we fetch content until the CDN serves that exact revision, apply the
// mutation, and put() with ifMatch — a concurrent write anywhere (any
// instance) fails the precondition and we retry against the fresh state.
// This is what makes rapid resolve-resolve-resolve (hunter mode) safe.
async function mutateDoc(project, fn) {
  // fn(threads) -> { threads, result } to commit, or null to abort (e.g. id not found)
  if (!durable) {
    const cur = mem.has(project) ? clone(mem.get(project)) : [];
    const out = fn(cur);
    if (out) mem.set(project, clone(out.threads));
    return out ? out.result : null;
  }
  const path = pathFor(project);
  for (let attempt = 0; attempt < 5; attempt++) {
    let meta = null;
    try { meta = await head(path, { token: TOKEN }); } catch (e) { meta = null; } // 404 -> first write
    if (meta) rememberBase(meta.url); // learn the CDN origin for cheap polling reads
    let threads = [];
    const etag = meta ? normEtag(meta.etag) : null;
    if (meta) {
      let doc = null;
      for (let r = 0; r < 6; r++) {
        try {
          const res = await fetch(meta.url + (meta.url.includes("?") ? "&" : "?") + "t=" + Date.now(), { cache: "no-store" });
          if (res.ok) {
            const respTag = normEtag(res.headers.get("etag"));
            const data = await res.json();
            doc = Array.isArray(data) ? { threads: data } : { threads: Array.isArray(data.threads) ? data.threads : [] };
            if (!respTag || respTag === etag) break; // content matches the etag we'll CAS against
            doc = null;
          }
        } catch (e) {}
        await sleep(150);
      }
      if (!doc) continue; // CDN never caught up — restart the CAS attempt
      threads = doc.threads;
    }
    const out = fn(clone(threads));
    if (!out) return null;
    const rev = Date.now();
    try {
      const putRes = await put(path, JSON.stringify({ rev, threads: out.threads }), {
        access: "public",
        token: TOKEN,
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/json",
        cacheControlMaxAge: 0,
        ...(etag ? { ifMatch: etag } : {}),
      });
      rememberBase(putRes && putRes.url);
      lastWrite.set(project, { rev, threads: clone(out.threads), at: Date.now() });
      return out.result;
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/precondition|if-?match|412|etag|conflict/i.test(msg)) continue; // raced another write -> retry fresh
      throw e;
    }
  }
  throw new Error("could not commit write after retries");
}

async function readArray(project) {
  if (!durable) return mem.has(project) ? clone(mem.get(project)) : [];
  let cdn = { rev: 0, threads: [] }, got = false;
  const take = (data) => {
    if (Array.isArray(data)) cdn = { rev: 0, threads: data }; // legacy bare-array format
    else if (data && typeof data === "object") cdn = { rev: Number(data.rev) || 0, threads: Array.isArray(data.threads) ? data.threads : [] };
    got = true;
  };
  const base = readBase();
  if (base) {
    try {
      const res = await fetch(base + "/" + pathFor(project) + "?t=" + Date.now(), { cache: "no-store" });
      if (res.ok) take(await res.json());
    } catch (e) {}
  }
  // No base configured/learned yet: resolve the authoritative URL via head() (a
  // counted op, but only until the first write teaches us the origin) and read that.
  if (!got && !base) {
    try {
      const meta = await head(pathFor(project), { token: TOKEN });
      rememberBase(meta.url);
      const res = await fetch(meta.url + (meta.url.includes("?") ? "&" : "?") + "t=" + Date.now(), { cache: "no-store" });
      if (res.ok) take(await res.json());
    } catch (e) {} // 404 -> genuinely no file yet
  }
  const mine = lastWrite.get(project);
  if (mine && Date.now() - mine.at < LAST_WRITE_FRESH_MS && mine.rev >= cdn.rev) {
    return clone(mine.threads); // CDN hasn't caught up to our own write yet
  }
  return cdn.threads;
}


export async function listThreads(project) {
  return readArray(project);
}

// Append a brand-new thread (CAS against the latest file).
export async function createThread(project, thread) {
  return mutateDoc(project, (threads) => {
    threads.push(thread);
    return { threads, result: thread };
  });
}

// Mutate one existing thread in place (CAS). Returns the updated thread, or
// null if the id isn't in the latest file.
export async function updateThread(project, id, mutator) {
  return mutateDoc(project, (threads) => {
    const t = threads.find((x) => x.id === id);
    if (!t) return null;
    mutator(t);
    return { threads, result: t };
  });
}

export async function removeThread(project, id) {
  const removed = await mutateDoc(project, (threads) => {
    const next = threads.filter((t) => t.id !== id);
    return { threads: next, result: next.length !== threads.length };
  });
  return !!removed;
}

// Append-only archive — nothing in the API ever deletes from it, so archived
// comments survive resolve/delete on the live list. One JSON array per project.
const archivePath = (project) => "konpo/v3/archive/" + encodeURIComponent(project) + ".json";

// Store a screenshot image (binary) under the project and return its public CDN
// URL. Returns null when Blob isn't configured — the client then previews the
// shot locally for the author instead of persisting it.
export async function saveShot(project, id, buffer, contentType) {
  if (!durable) return null;
  const safeId = (String(id || "shot").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64)) || "shot";
  const ext = contentType === "image/png" ? "png" : "jpg";
  const path = "konpo/v3/shots/" + encodeURIComponent(project) + "/" + safeId + "." + ext;
  const res = await put(path, buffer, {
    access: "public",
    token: TOKEN,
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: contentType || "image/jpeg",
    cacheControlMaxAge: 31536000, // images are immutable per id
  });
  rememberBase(res && res.url);
  return res.url;
}

export async function archiveEvent(project, event) {
  if (!durable) return;
  try {
    let log = [];
    const base = readBase();
    if (base) {
      const res = await fetch(base + "/" + archivePath(project) + "?t=" + Date.now(), { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) log = data;
      }
    }
    log.push(event);
    const put_res = await put(archivePath(project), JSON.stringify(log), {
      access: "public",
      token: TOKEN,
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
      cacheControlMaxAge: 0,
    });
    rememberBase(put_res && put_res.url);
  } catch (e) {
    // archiving must never break the main write path
  }
}
