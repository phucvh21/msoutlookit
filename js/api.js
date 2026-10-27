/* ============================================================
   api.js — data layer for MSOutlookit.

   Source: Arctic Shift (https://arctic-shift.photon-reddit.com),
   a Reddit archive API hosted on infrastructure that is NOT
   blocked by reddit.com's anti-bot protection. It returns real
   Reddit posts and comments in Reddit's own JSON shape and sends
   `access-control-allow-origin: *`, so the browser can call it
   directly with no proxy and no mock data.

   Trade-off: posts are indexed near-real-time (minutes-hours),
   but comments are indexed later. So the listing is read from a
   rolling window ending `Freshness.hours` ago — fresher window =
   newer posts with thinner threads; older window = fuller threads.
   ============================================================ */

const AS_BASE = "https://arctic-shift.photon-reddit.com/api";

const Freshness = {
  hours: 168,     // window length, in hours (e.g. 168 = "last 7 days")
  lagHours: 48,   // youngest post we read: comments aren't indexed for the last ~2 days
};

/* Only these fields exist in the archive's `fields` filter. Trimming the
   payload makes requests ~10-20x faster (424KB -> 42KB). is_self / permalink /
   domain / thumbnail aren't available, so normalizePost derives them. */
const POST_FIELDS =
  "id,title,author,score,num_comments,url,selftext,created_utc,subreddit,link_flair_text,over_18,post_hint";

/* ---------- low-level fetch with timeout + retry + friendly errors ---------- */
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* In-memory response cache (promise-based, so concurrent identical requests
   share one fetch). Failed requests are evicted so they can be retried. */
const CACHE_TTL = 5 * 60 * 1000;
const _cache = new Map();

function asFetch(path, timeoutMs) {
  const hit = _cache.get(path);
  if (hit && Date.now() - hit.t < CACHE_TTL) return hit.p;
  const p = asFetchRaw(path, timeoutMs);
  _cache.set(path, { t: Date.now(), p });
  p.catch(() => { const c = _cache.get(path); if (c && c.p === p) _cache.delete(path); });
  return p;
}

/* Listing windows are anchored to 5-minute boundaries so repeated loads
   produce identical URLs (and therefore cache hits). */
function snapNow() { return Math.floor(Date.now() / 300000) * 300; }

async function asFetchRaw(path, timeoutMs, isRetry) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 20000);
  let res;
  try {
    res = await fetch(AS_BASE + path, {
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
    });
  } catch (e) {
    throw new ApiError(
      "Could not reach the mail server",
      "The Reddit archive (arctic-shift.photon-reddit.com) did not respond. " +
        "Check your connection, or try again in a moment — the service may be rate-limiting."
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    // 429 (rate limit) and 422 (transient) are worth one retry.
    if ((res.status === 429 || res.status === 422) && !isRetry) {
      await sleep(1200);
      return asFetchRaw(path, timeoutMs, true);
    }
    throw new ApiError(
      "Mail server error",
      "The archive returned HTTP " + res.status + " for this request. " +
        (res.status === 429 ? "This is rate-limiting — wait a few seconds and refresh." : "Try refreshing."),
      res.status
    );
  }
  return res.json();
}

class ApiError extends Error {
  constructor(title, detail, status) {
    super(title);
    this.title = title;
    this.detail = detail;
    this.status = status;
  }
}

/* ---------- normalisation ---------- */
function normalizePost(p) {
  const url = p.url || "";
  const isSelf =
    p.is_self !== undefined
      ? !!p.is_self
      : !!((p.selftext && p.selftext.trim()) || /\/comments\//.test(url));

  let domain = p.domain || "";
  if (!domain && url && !isSelf) {
    try { domain = new URL(url).hostname.replace(/^www\./, ""); } catch (e) {}
  }

  return {
    id: p.id,
    name: p.name || "t3_" + p.id,
    subreddit: p.subreddit,
    title: p.title || "(no title)",
    author: p.author || "[deleted]",
    score: typeof p.score === "number" ? p.score : 0,
    num_comments: p.num_comments || 0,
    is_self: isSelf,
    url: url,
    selftext: p.selftext || "",
    domain: domain,
    permalink: p.permalink
      ? "https://www.reddit.com" + p.permalink
      : "https://www.reddit.com/r/" + (p.subreddit || "") + "/comments/" + p.id + "/",
    thumbnail: normalizeThumb(p.thumbnail),
    flair: p.link_flair_text || "",
    over_18: !!p.over_18,
    created_utc: p.created_utc || 0,
  };
}

function normalizeThumb(t) {
  if (!t || t === "self" || t === "default" || t === "nsfw" || t === "spoiler" || /^https?:/.test(t) === false) {
    if (t && /^https?:/.test(t)) return t;
    return "";
  }
  return t;
}

function normalizeComment(c) {
  return {
    id: c.id,
    name: c.name || "t1_" + c.id,
    parent_id: c.parent_id || "",
    link_id: c.link_id || "",
    author: c.author || "[deleted]",
    body: c.body || "",
    score: typeof c.score === "number" ? c.score : 0,
    created_utc: c.created_utc || 0,
    is_submitter: !!c.is_submitter,
    distinguished: c.distinguished || null,
  };
}

/* Build a depth-first ordered comment tree from a flat list. */
function buildCommentTree(comments, postId) {
  const byId = {};
  const order = [];
  comments.forEach((c) => {
    if (!c.id || byId[c.id]) return; // de-dupe
    byId[c.id] = Object.assign({ children: [] }, c);
    order.push(c);
  });
  const roots = [];
  order.forEach((c) => {
    const node = byId[c.id];
    if (String(c.parent_id).startsWith("t1_")) {
      const parent = byId[c.parent_id.slice(3)];
      if (parent) parent.children.push(node);
      else roots.push(node);
    } else {
      roots.push(node);
    }
  });
  // The original MSOutlookit applies no ranking of its own: it shows Reddit's
  // default ("best") order. The archive returns a flat list, so approximate that
  // by ordering siblings by score, oldest first on ties.
  const countReplies = (n) => {
    n.replies = 0;
    n.children.forEach((c) => { countReplies(c); n.replies += 1 + c.replies; });
  };
  roots.forEach(countReplies);
  const sortRec = (arr) => {
    arr.sort((a, b) => b.score - a.score || a.created_utc - b.created_utc);
    arr.forEach((n) => sortRec(n.children));
  };
  sortRec(roots);

  const flat = [];
  (function walk(arr, depth) {
    arr.forEach((n) => {
      flat.push(Object.assign({}, n, { depth }));
      walk(n.children, depth + 1);
    });
  })(roots, 0);
  return flat;
}

/* Recursively flatten the /comments/tree payload ({kind,data} items whose
   `data` may itself carry nested `replies`) into a flat comment list. */
function flattenCommentNodes(items) {
  const out = [];
  const visit = (list) => {
    if (!Array.isArray(list)) return;
    list.forEach((it) => {
      const d = it && it.data ? it.data : it;
      if (d && d.id && d.body !== undefined) out.push(d);
      if (d && Array.isArray(d.replies)) visit(d.replies);
      else if (d && d.replies && d.replies.data && Array.isArray(d.replies.data.children)) visit(d.replies.data.children);
    });
  };
  visit(items);
  return out;
}

/* ---------- public API ---------- */
const RedditAPI = {
  clearCache() { _cache.clear(); },

  /* Posts for a subreddit inside a true sliding window.
     - `before`  : created_utc pagination cursor (null = first page)
     - hoursOverride : window length in hours (for auto-widening)
     - afterOverride : fixed window start (kept constant while paginating)
     The window is [now - hours, now - lagHours], so a longer window is a strict
     superset of a shorter one (Last 30 days contains everything in Last 7 days). */
  async getListing(subreddit, before, hoursOverride, afterOverride, limit) {
    const hours = hoursOverride || Freshness.hours;
    const now = snapNow();
    const after = afterOverride != null ? afterOverride : now - hours * 3600;
    const beforeTs = before != null ? before : now - Freshness.lagHours * 3600;
    if (beforeTs <= after) return [];
    const path =
      "/posts/search?subreddit=" +
      encodeURIComponent(subreddit) +
      "&limit=" + (limit || 25) +
      "&sort=desc&after=" + after +
      "&before=" + beforeTs +
      "&fields=" + encodeURIComponent(POST_FIELDS);
    const json = await asFetch(path);
    const raw = json.data || [];
    RedditAPI.lastRawCount = raw.length;
    return raw
      .map(normalizePost)
      .filter((p) => p.title && p.title !== "(no title)")
      // Only keep posts that actually have a discussion. The archive reports
      // num_comments = 0 for very recent posts (record snapshotted before the
      // comments were indexed), so this also drops the "0 comment" rows.
      .filter((p) => p.num_comments > 0);
  },

  /* The archive can only sort by created_utc (and returns at most 100 posts
     per request, newest first), so ranking by comments/score happens
     client-side over a sample. To keep results consistent between windows the
     sample is built from a fixed grid anchored to UTC midnight, and which grid
     cells are read depends only on how old the day is, never on the window
     length:
       - newest 7 days : every day
       - days 7-30     : every 2nd day
       - older         : every 6th day
     so "Last 7 days" is always a subset of "Last 30 days", which is a subset
     of "Last 90 days". Busy subreddits (100 posts fill less than a day) get
     each day cut into 6-hour slices so more of the day is covered. Each cell is
     a separate cached request. */
  async getSampledListing(subreddit, hoursOverride, onProgress) {
    const hours = hoursOverride || Freshness.hours;
    const DAY = 86400;
    const now = Math.floor(Date.now() / 1000);
    const end = Math.floor((now - Freshness.lagHours * 3600) / DAY) * DAY;
    const days = Math.ceil(hours / 24);

    // Probe the newest day: if 100 posts already fill it, the sub is busy.
    let busy = false;
    try {
      await RedditAPI.getListing(subreddit, end, hours, end - DAY, 100);
      busy = RedditAPI.lastRawCount >= 100;
    } catch (e) { /* the real fetches below will surface the error */ }
    const slices = busy ? 4 : 1;
    const step = DAY / slices;

    const cells = [];
    for (let i = 0; i < days; i++) {
      if (i >= 30 ? i % 6 : i >= 7 ? i % 2 : 0) continue;
      const dayEnd = end - i * DAY;
      for (let k = 0; k < slices; k++) cells.push([dayEnd - (k + 1) * step, dayEnd - k * step]);
    }

    // modest concurrency so we don't trip the archive's rate limit
    const results = new Array(cells.length);
    let next = 0, done = 0, failed = 0, lastErr = null;
    async function worker() {
      while (next < cells.length) {
        const idx = next++;
        try {
          results[idx] = await RedditAPI.getListing(subreddit, cells[idx][1], hours, cells[idx][0], 100);
        } catch (e) {
          failed++; lastErr = e;
          results[idx] = [];
        }
        done++;
        if (onProgress) onProgress(done, cells.length);
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (cells.length && failed === cells.length) throw lastErr;

    const seen = new Set();
    const out = [];
    results.forEach((list) =>
      (list || []).forEach((p) => {
        if (!seen.has(p.id)) { seen.add(p.id); out.push(p); }
      })
    );
    return out;
  },

  /* Comment tree for a post id. /comments/tree caps the *total* comments it
     returns (default 50), which often leaves only ~20 top-level comments. So
     ask for a larger budget up front (200 usually yields 100+ top-level
     comments in one request), and if the thread has more than that and we
     still have fewer than `minTop` top-level comments, retry with a bigger one.
     Falls back to /comments/search if the tree comes back empty. */
  async getComments(postId, minTop) {
    minTop = minTop || 100;
    let flat = [];
    const topOf = (list) => list.filter((c) => String(c.parent_id).startsWith("t3_")).length;
    for (const limit of [200, 600]) {
      try {
        const json = await asFetch(
          "/comments/tree?link_id=t3_" + encodeURIComponent(postId) + "&limit=" + limit, 90000
        );
        flat = flattenCommentNodes(json.data || []);
      } catch (e) {
        if (e.status && e.status !== 422) throw e; // 422 = treat as empty
        break;
      }
      if (topOf(flat) >= minTop || flat.length < limit) break; // enough, or the thread is exhausted
    }
    if (!flat.length) {
      const json = await asFetch(
        "/comments/search?link_id=t3_" + encodeURIComponent(postId) + "&limit=100&sort=desc"
      );
      flat = json.data || [];
    }
    return buildCommentTree(flat.map(normalizeComment), postId);
  },
};
