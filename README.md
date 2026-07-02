# Konpo Notes

Figma-style comments you embed in any WIP site with **one script tag**. No login — people
add a name, click an element, and leave a note. Built for vibe-coded prototypes and design
review. A little commenting tool by [Konpo Studio](https://konpo.studio).

**Live:** https://kp-comments.vercel.app · **Demo:** https://kp-comments.vercel.app/demo.html

```html
<script src="https://kp-comments.vercel.app/embed.js"
        data-project="my-site"
        defer></script>
```

That's the whole integration. Works in plain HTML, Next.js (drop it in your layout), and
Figma-Make exports. Everyone on the same `data-project` shares the same threads.

---

## What it does

| Tool | What it is |
|------|------------|
| **Pin a comment** | Press `C` (or click the 💬 tool), click any element, type, submit. A numbered pin anchors to that element and follows it on scroll/resize. |
| **Threads & replies** | Click a pin to open the thread — reply, and resolve/reopen when done. |
| **Stamps** | The stamp tool drops emoji stickers (👍 🔥 ⭐ ✅ `+1` …) anywhere on the page — pick one, then click to place it, repeatably. Stamps anchor to the page and persist like comments; click a stamp to delete it. |
| **Comments panel** | The ☰ icon opens a side panel listing every open comment; click a row to scroll to it and open its thread. Follows the Open/All filter. |
| **Copy for Claude** | On any open thread, copies the feedback as a structured prompt — visible text + tag/classes + CSS selector + page route + a ready `rg` command — so a connected Claude Code finds the exact element fast and applies the edit. |
| **Identity avatars** | Each name gets a generated [boring-avatars](https://github.com/boringdesigners/boring-avatars) "beam" face in Konpo purples (same person → same avatar). Ported to vanilla JS — no React dependency. |
| **Animated logo** | The Konpo dot-mark plays as a looping Lottie animation in the dock and panel header (graceful fallback to a static mark if blocked). |
| **Show / hide the bar** | The bar is either shown or fully hidden — no in-between. It's **hidden by default** (just a small peek tab) so pins stay out of the way while you iterate and refresh. Press `K`, click the peek tab, or click the bar's logo/`«` to toggle; the choice is remembered across reloads. |
| **Jump between comments** | Open the ☰ list and click any comment to jump to it (across pages). Or, while the bar is shown, use the `←`/`→` arrow keys to step through open comments — no separate mode. |
| **Filter** | Open / All — see just open comments or everything including resolved. |

**Shortcuts:** `K` show / hide the bar · `C` comment · `←`/`→` jump between comments · `Esc` cancel · `⌘/Ctrl+Enter` submit.

### Config

| attribute       | default                | what it does |
|-----------------|------------------------|--------------|
| `data-project`  | the page's hostname    | namespace for comments. Same value = shared thread. Use a new one per site/branch. |
| `data-accent`   | `250` (Konpo purple)   | accent hue 0–360. `14` coral · `25` amber · `210` blue. |
| `data-endpoint` | origin of `embed.js`   | where the API lives. Only set if you serve the script from a CDN separate from the backend. |
| `data-position` | `bottom`               | dock placement: `bottom` (centered) or `bottom-right`. |
| `data-open`     | (off)                  | start with the bar shown instead of hidden. First-visit default only — a visitor's later show/hide choice persists. |

Config can also be set via `window.KonpoNotes = { project, accent, … }` before the script loads.

### Restoring context — precise comments across screens (SPAs, tabs, modals)

Clicking a comment doesn't just show the note — it **reconstructs the screen the note was
made on**: navigate to its route, reopen the tab/panel/modal it lives in, wait for the target
element to become visible, scroll to it, re-anchor the pin, and flash a highlight. And a pin
only ever shows when its target is **actually visible on the current view** — a comment placed
on your dashboard won't float over your login screen; it appears when you're on that screen.

There are three levels, in order of effort — most prototypes only need level 2.

**1 · Zero setup — just the embed script.** The widget captures a stable selector automatically
(preferring `id`, `data-testid`, `data-cy`, … then a rooted structural path) and auto-reopens
the common cases on click:

- **Webflow Tabs** — re-activates the tab pane the comment lives in
- **Webflow Dropdowns** — reopens the dropdown
- **Native `<details>`** — opens the collapsed section(s) around the element

**2 · Two data attributes — for any custom app or prototype (recommended).** If your app shows
different screens by toggling views (a router, a login gate, tabs, panels, modals), tell the
widget how to reach each one with two attributes — **no JavaScript**:

- `data-konpo-screen="name"` on each screen / view / tab / panel **container**
- `data-konpo-goto="name"` on the **control** that opens it (a nav item, tab button, "Sign in" …)

The widget records which screens a comment is nested in and, on reveal, **replays the navigation
outer → inner** (clicks each `data-konpo-goto`, waiting for each to appear) before scrolling to
the exact element. Nest them freely — e.g. a comment inside *App → Settings tab*:

```html
<button data-konpo-goto="app">Sign in</button>
<div data-konpo-screen="app">
  <button data-konpo-goto="settings">Settings</button>
  <section data-konpo-screen="settings"> … the commented element lives here … </section>
</div>
```

Prefer one function over attributes? Expose `window.konpoGoTo("name")` and the widget calls that
instead of clicking. It's fully backward-compatible: add nothing and off-screen pins simply hide
until you're on their screen.

**3 · Full hooks — for anything the above can't express** (state that isn't reachable by clicking
a control). All optional; set them on `window.KonpoNotes` before the script loads:

```js
window.KonpoNotes = {
  project: "case-eps",

  // Save your app's open state when a comment is placed (el = clicked element).
  captureState: (el) => ({ modal: store.openModalId, tab: store.activeTab }),

  // Reopen it before the pin is revealed. May be async — return a Promise and the
  // widget awaits it, then polls up to 4s for the element to become visible.
  // Page/route navigation is automatic — this is only for state not in the URL.
  restoreState: async (ui /*, thread */) => {
    if (ui.tab) store.setTab(ui.tab);
    if (ui.modal) await store.openModal(ui.modal);
  },

  // Optional: a stable id for the current screen/view, stored with the comment.
  screenId: () => store.currentCaseId ? "case-detail" : "case-list",
};
```

`window.__konpoNotes.reveal(threadId)` triggers the same restore flow programmatically.
Prefer stable `id`/`data-*` attributes on important elements if you want pins to survive
big layout refactors — but it's an enhancement, never required.

### Wiring it into a prototype with Claude Code

Point Claude Code at your prototype's repo and paste this — it adds the script **and** the
screen-tracking so comments locate precisely across views:

> Integrate Konpo comments into this app.
> 1. Add `<script src="https://kp-comments.vercel.app/embed.js" data-project="<PROJECT>" defer></script>` right before `</body>` (Next.js: render it in the root layout).
> 2. For precise cross-screen comments, add `data-konpo-screen="<name>"` to **every** top-level screen / view / route / tab / panel / modal container, and `data-konpo-goto="<name>"` to the control (nav item, tab, "Sign in" button, …) that navigates to each one — use the **same name** on both, and nest them where views nest. If screens are switched by a single function instead, expose it globally as `window.konpoGoTo(name)`.
> Don't add any other Konpo code — the widget handles capture, storage, and restore.

Replace `<PROJECT>` with a unique namespace (your repo name works). That's the whole
integration: the widget captures which screen each comment was placed on and auto-navigates
back to it on click.

Field mapping vs. the classic schema: `elementSelector` → `selector`, `xPercent`/`yPercent`
→ `relX`/`relY` (0–1 fractions), `routeOrView` → `path` + `url`, plus new `scrollX`/`scrollY`,
`screenId`, and `uiState`.

---

## How it works

- **Anchoring** — on click it stores a robust, body-rooted CSS selector + the relative (x, y)
  inside the element. On render it re-resolves the selector and positions the pin **only when
  the target is genuinely visible on the current view** — not found, CSS-hidden, or covered by
  an overlay/another screen ⇒ the pin hides (it stays in the list and reappears when its view is
  shown), instead of floating at a stale position over an unrelated screen.
- **Sync** — the widget polls `GET /api/comments?project=…` every 5s while the tab is visible.
  Writes are optimistic (the pin appears instantly) and reconcile with the server response.
- **Storage** — **Vercel Blob**: one JSON file per project (`konpo/v3/<project>.json`). Reads hit
  the public CDN URL (cheap); writes use the Blob RW token. Falls back to an in-memory store
  when Blob isn't configured (works locally / before linking, but not durable).
- **Isolation** — the entire UI renders in a Shadow DOM, so it can't clash with (or be restyled
  by) the host page. Light/dark follows the host's color scheme.
- **Offline resilience** — threads are cached in `localStorage`, so a flaky network still lets
  you read and place comments.

## API

```
GET    /api/comments?project=X            -> { durable, threads: [...] }
POST   /api/comments  {project, selector, relX, relY, pageX, pageY, scrollX, scrollY, screenId, uiState, label, author, body, path, url, clientId}
POST   /api/comments  {project, action:"reply", threadId, author, body}
PATCH  /api/comments  {project, id, resolved?, body?}
DELETE /api/comments  {project, id}
```

`scrollX`/`scrollY`, `screenId`, and `uiState` (a small JSON object, size-guarded) are
stored so a comment's exact screen state can be reconstructed on click — see
[Restoring context](#restoring-context-spas-modals-tabs).

CORS is wide open (`*`) and there's no auth — by design. This is a tool for trusted
preview/review, not a public production system.

---

## Deploy your own

```bash
npx vercel --prod
```

Then connect storage so comments persist across cold starts:

```bash
vercel blob create-store konpo-comments --access public
# auto-links BLOB_READ_WRITE_TOKEN — the only variable the code needs.
# In the dashboard "Connect Store" dialog, tick "Add a read-write token env var".
npx vercel --prod                          # redeploy so the function picks up the token
```

`BLOB_READ_WRITE_TOKEN` is all that's required. `BLOB_BASE_URL` is optional — the
store's public CDN origin is learned automatically from the first write; set it only
to pin that origin for the cheapest polling reads.

`GET /api/comments` returns `{ "durable": true }` once Blob is wired up. Make sure
**Deployment Protection / Vercel Authentication is OFF** for the project, or the embed will
be blocked (401/403) on the sites you embed it into.

## Files

| file              | role |
|-------------------|------|
| `embed.js`        | the entire widget — self-contained, no build step |
| `api/comments.js` | serverless CRUD endpoint |
| `lib/store.js`    | Vercel Blob storage adapter (in-memory fallback) |
| `konpo-lottie.json` + `lottie_light.min.js` | animated logo + its player |
| `index.html`      | landing page (dogfoods the widget) |
| `demo.html`       | sample WIP page to try commenting on |

## Changelog

- **1.1** — The big one. **Durable storage** on Vercel Blob: comments and their resolve/delete state now persist across sessions and devices, shared per project. **Automatic screenshots** on every comment — a thumbnail you can click to expand — plus the captured browser, OS, and screen resolution. Also **emoji stickers**, a **comments side-panel** with click-to-jump, **context-restoring navigation** that reopens Webflow tabs/dropdowns and modals when you open a comment, and one-click **Send to Claude Code**.
- **1.0** — Initial release. One script tag, no login: pin a comment to any element, reply, and resolve — all in a self-contained Shadow-DOM widget that stays out of the way.

## Credits

- Avatars: [boring-avatars](https://github.com/boringdesigners/boring-avatars) (MIT), "beam" algorithm ported to vanilla JS.
- Logo animation: Lottie via [lottie-web](https://github.com/airbnb/lottie-web).
- A little commenting tool by [Konpo Studio](https://konpo.studio).
