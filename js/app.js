/* ============================================================
   app.js — rendering + interaction for MSOutlookit.
   ============================================================ */

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

const App = {
  posts: [],          // posts in the current folder (full set)
  view: [],           // posts after search / unread filtering
  loadedIds: new Set(),
  cursor: null,       // pagination cursor (created_utc)
  rangeAfter: null,   // fixed start of the sliding window for the current folder
  hasMore: true,
  loadingList: false,
  currentPost: null,
  reqToken: 0,
  filterText: "",
  filterUnread: false,
};

/* ===================== helpers ===================== */

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function mdToHtml(src) {
  if (!src) return "";
  let text = src.replace(/\r\n/g, "\n");
  const codes = [];
  text = text.replace(/```([\s\S]*?)```/g, (m, p1) => {
    codes.push("<pre>" + escapeHtml(p1.replace(/^\n/, "")) + "</pre>");
    return "\u0000" + (codes.length - 1) + "\u0000";
  });
  let html = escapeHtml(text);
  html = html.replace(/^&gt;\s?(.*)$/gm, "<blockquote>$1</blockquote>");
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  html = html.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  html = html.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>");
  html = html.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\u0000(\d+)\u0000/g, (m, i) => codes[i]);
  html = html
    .split(/\n{2,}/)
    .map((p) => (/^\s*<(pre|blockquote|ul|ol|h)/.test(p) ? p : "<p>" + p.replace(/\n/g, "<br>") + "</p>"))
    .join("");
  return html;
}

function hashColor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  const palette = ["#5a9bd4", "#7fb07f", "#c07fbf", "#c9a24b", "#8a7fd4", "#e08a2c", "#4aa3a3", "#c96b6b", "#6b8fc9", "#8fae5a"];
  return palette[Math.abs(h) % palette.length];
}

function initials(name) {
  if (!name || name === "[deleted]") return "?";
  return name.replace(/[^a-z0-9]/gi, "").slice(0, 2) || "?";
}

function fmtCount(n) {
  n = n || 0;
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "") + "k";
  return String(n);
}

function fmtTime(utc) {
  const d = new Date(utc * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  if (now - d < 6.5 * 864e5) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "numeric", day: "numeric", year: "numeric" });
}

function relAge(utc) {
  const s = Math.max(1, Math.floor(Date.now() / 1000 - utc));
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

function toast(msg, ms) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), ms || 2600);
}

/* ===================== folders ===================== */

function renderFolders() {
  const list = $("#folderList");
  list.innerHTML = "";
  Store.folders.forEach((sub, i) => {
    const div = document.createElement("div");
    div.className = "afolder" + (i === Store.activeFolder ? " active" : "");
    div.dataset.sub = sub;
    div.innerHTML =
      escapeHtml(sub) +
      (App.unreadByFolder[sub] ? '<span class="unread-badge">' + App.unreadByFolder[sub] + "</span>" : "");
    div.dataset.i = i;
    list.appendChild(div);
  });
}

App.unreadByFolder = {};

const WELCOME_HTML =
  '<div class="welcome"><p>Welcome to MSOutlookit 2013!</p>' +
  "<p>Each folder under Inbox is a subreddit, each email is a post, and the reading pane shows its comments.</p>" +
  '<p><i>Want to add subreddits? Click the "New Email" button and follow the instructions!</i></p></div>';

/* ===================== listing ===================== */

async function switchFolder(i) {
  if (i === Store.activeFolder && App.posts.length) return;
  Store.activeFolder = i;
  Store.persistFolders();
  renderFolders();
  await loadFolder();
}

async function loadFolder() {
  const sub = Store.currentFolder();
  const token = ++App.reqToken;
  App.posts = [];
  App.loadedIds = new Set();
  App.cursor = null;
  App.rangeAfter = null;
  App.hasMore = true;
  App.currentPost = null;

  $("#listTitle").textContent = "Inbox — r/" + sub;
  $("#listBody").innerHTML = '<div class="list-loading"><span class="spinner"></span>Loading r/' + escapeHtml(sub) + "…</div>";
  $("#listStatus").textContent = "Last " + Math.round(Freshness.hours / 24) + " days · discussions only";
  $("#readingPane").innerHTML = WELCOME_HTML;

  const now = Math.floor(Date.now() / 300000) * 300;
  App.rangeAfter = now - Freshness.hours * 3600;
  try {
    if (Store.sortMode !== "newest") {
      // Ranking by comments / score: sample across the whole window so the
      // window length actually changes the result.
      $("#listStatus").textContent = "Ranking by " + sortLabel() + " across the last " + Math.round(Freshness.hours / 24) + " days…";
      const progress = (d, n) => {
        if (token === App.reqToken) $("#listStatus").textContent = "Ranking by " + sortLabel() + "… " + d + "/" + n;
      };
      let posts = await RedditAPI.getSampledListing(sub, Freshness.hours, progress);
      if (token !== App.reqToken) return;
      for (const widen of [720, 2160]) {
        if (posts.length || Freshness.hours >= widen) continue;
        App.rangeAfter = now - widen * 3600;
        posts = await RedditAPI.getSampledListing(sub, widen, progress);
        if (token !== App.reqToken) return;
        if (posts.length) { toast("Widened to the last " + widen / 24 + " days."); break; }
      }
      App.posts = posts;
      App.hasMore = false;
      advanceCursor(posts);
    } else {
      let page = await RedditAPI.getListing(sub, null, null, App.rangeAfter);
      if (token !== App.reqToken) return;
      // If nothing qualifies, widen to a larger (superset) window.
      for (const widen of [720, 2160]) {
        if (page.length || Freshness.hours >= widen) continue;
        App.rangeAfter = now - widen * 3600;
        page = await RedditAPI.getListing(sub, null, null, App.rangeAfter);
        if (token !== App.reqToken) return;
        if (page.length) { toast("Widened to the last " + widen / 24 + " days."); break; }
      }
      App.posts = page;
      App.hasMore = true;
      page.forEach((p) => App.loadedIds.add(p.id));
      advanceCursor(page);
    }

    App.posts = sortPosts(App.posts);
    applyFilter();
    renderList();
    recomputeUnread(sub);
  } catch (e) {
    if (token !== App.reqToken) return;
    $("#listBody").innerHTML = "";
    showListError(e);
  }
}

function showListError(e) {
  const box = document.createElement("div");
  box.className = "error-box";
  box.innerHTML = "<b>" + escapeHtml(e.title || "Mail server unavailable") + "</b>" +
    escapeHtml(e.detail || e.message || String(e));
  $("#listBody").appendChild(box);
  $("#listStatus").textContent = "";
}

function recomputeUnread(sub) {
  const n = App.posts.filter((p) => !Store.isRead(p.id)).length;
  App.unreadByFolder[sub] = n;
  const el = $$("#folderList .afolder").find((d) => d.dataset.sub === sub);
  if (!el) { renderFolders(); return; }
  let badge = $(".unread-badge", el);
  if (!n) { if (badge) badge.remove(); return; }
  if (!badge) { badge = document.createElement("span"); badge.className = "unread-badge"; el.appendChild(badge); }
  badge.textContent = n;
}

/* Keep the visible set in sync with the search box + All/Unread tabs. */
function applyFilter() {
  App.view = App.posts.filter((p) => {
    if (App.filterUnread && Store.isRead(p.id)) return false;
    if (App.filterText) {
      const hay = (p.title + " " + p.author + " " + (p.flair || "")).toLowerCase();
      if (!hay.includes(App.filterText)) return false;
    }
    return true;
  });
}

function renderList() {
  const body = $("#listBody");
  body.innerHTML = "";
  if (!App.view.length) {
    body.innerHTML = App.posts.length
      ? '<div class="list-loading">No items match the current search / filter.</div>'
      : '<div class="list-loading">No discussions found in this window. Try “This week” or “This month” above.</div>';
    updateStatus();
    return;
  }
  const frag = document.createDocumentFragment();
  App.view.forEach((p) => frag.appendChild(renderRow(p)));
  body.appendChild(frag);
  updateStatus();
}

function renderRow(p) {
  const row = document.createElement("div");
  row.className = "anemail" + (Store.isRead(p.id) ? "" : " unread") +
    (App.currentPost && App.currentPost.id === p.id ? " active" : "");
  row.dataset.id = p.id;
  row.tabIndex = 0;

  const preview = p.is_self
    ? p.selftext.replace(/\s+/g, " ").slice(0, 90)
    : (p.domain ? p.domain + " — " : "") + (p.url || "");

  row.innerHTML =
    '<div class="emailtop"><span class="emailname">' + escapeHtml(p.author) + "</span>" +
      '<span class="emaildate">' + escapeHtml(fmtTime(p.created_utc)) + "</span></div>" +
    '<div class="emailtitle">' + escapeHtml(p.title) + "</div>" +
    '<div class="emailbottom"><span class="emailpreview">' + escapeHtml(preview || "link post") + "</span>" +
      '<span class="emailcount">&#9650; ' + fmtCount(p.score) + " &middot; " + fmtCount(p.num_comments) + "</span></div>";

  return row;
}

function sortLabel() {
  return { newest: "Newest", comments: "Most comments", score: "Top score", oldest: "Oldest" }[Store.sortMode] || "Newest";
}

function updateStatus() {
  const shown = App.view.length, total = App.posts.length;
  const count = shown === total ? shown + " item" + (shown === 1 ? "" : "s")
    : shown + " of " + total + " items";
  const sampled = Store.sortMode === "comments" || Store.sortMode === "score" ? " (sampled)" : "";
  $("#listStatus").textContent =
    count +
    "  ·  " + sortLabel() + sampled +
    (App.hasMore ? "  ·  scroll for more" : "  ·  end of folder") +
    "  ·  last " + Math.round(Freshness.hours / 24) + " days · comments only";
}

/* Track the oldest created_utc we've fetched, independent of display order. */
function advanceCursor(list) {
  list.forEach((p) => {
    if (App.cursor == null || p.created_utc < App.cursor) App.cursor = p.created_utc;
  });
}

function sortPosts(arr) {
  const a = arr.slice();
  const mode = Store.sortMode;
  if (mode === "comments") a.sort((x, y) => y.num_comments - x.num_comments || y.created_utc - x.created_utc);
  else if (mode === "score") a.sort((x, y) => y.score - x.score || y.created_utc - x.created_utc);
  else if (mode === "oldest") a.sort((x, y) => x.created_utc - y.created_utc);
  else a.sort((x, y) => y.created_utc - x.created_utc); // newest
  return a;
}

/* Fetch extra pages so a non-time sort has enough to rank. */
async function loadMore() {
  if (App.loadingList || !App.hasMore || !App.posts.length || App.cursor == null) return;
  if (App.rangeAfter != null && App.cursor - 1 <= App.rangeAfter) { App.hasMore = false; updateStatus(); return; }
  App.loadingList = true;
  const sub = Store.currentFolder();
  $("#listStatus").textContent = "Loading more…";
  try {
    const page = await RedditAPI.getListing(sub, App.cursor - 1, null, App.rangeAfter);
    const fresh = page.filter((p) => !App.loadedIds.has(p.id));
    fresh.forEach((p) => App.loadedIds.add(p.id));
    if (!fresh.length) {
      App.hasMore = false;
    } else {
      advanceCursor(fresh);
      App.posts = App.posts.concat(fresh);
      const prev = App.view.length;
      if (Store.sortMode !== "newest") App.posts = sortPosts(App.posts);
      applyFilter();
      if (Store.sortMode === "newest" && prev > 0) {
        // new rows go at the end: append instead of rebuilding the list
        const frag = document.createDocumentFragment();
        App.view.slice(prev).forEach((p) => frag.appendChild(renderRow(p)));
        $("#listBody").appendChild(frag);
        updateStatus();
      } else {
        renderList();
      }
    }
  } catch (e) {
    App.hasMore = false;
    toast("Could not load more items.");
  } finally {
    App.loadingList = false;
    updateStatus();
  }
}

/* ===================== reading pane ===================== */

async function selectPost(p, row) {
  App.currentPost = p;
  Store.markRead(p.id);
  clearCommentHi();
  _hiLast = null;
  recomputeUnread(p.subreddit);
  $$(".anemail").forEach((r) => r.classList.toggle("active", r.dataset.id === p.id));
  if (row) row.classList.remove("unread");

  const pane = $("#readingPane");
  pane.innerHTML = renderReadHeader(p) + '<div class="read-body">' + renderPostBody(p) + "</div>" +
    '<div class="section-head">Conversation (' + fmtCount(p.num_comments) + " comments)</div>" +
    '<div class="comments" id="commentsBox"><div class="read-loading"><span class="spinner"></span>Loading conversation…</div></div>';

  bindReadHeader(p);

  try {
    const tree = await RedditAPI.getComments(p.id, 100);
    if (!App.currentPost || App.currentPost.id !== p.id) return;
    const box = $("#commentsBox");
    if (!box) return;
    if (!tree.length) {
      box.innerHTML = '<div class="c-more">No comments archived for this post yet ' +
        "(the archive indexes comments later than posts). Try a wider freshness window, or pick an older item.</div>";
      return;
    }
    box.innerHTML = tree.map(renderComment).join("");
  } catch (e) {
    const box = $("#commentsBox");
    if (box) box.innerHTML = '<div class="error-box"><b>' + escapeHtml(e.title || "Error") + "</b>" + escapeHtml(e.detail || e.message) + "</div>";
  }
}

function renderReadHeader(p) {
  return (
    '<div class="read-header">' +
      '<div class="read-subject">' + escapeHtml(p.title) + "</div>" +
      '<div class="read-from"><span class="who">' + escapeHtml(p.author) + "</span>" +
        ' <span class="dimtxt">to r/' + escapeHtml(p.subreddit) + "</span></div>" +
      '<div class="read-metachips">' +
        '<span class="chip">&#9650; ' + fmtCount(p.score) + " points</span>" +
        '<span class="chip">' + escapeHtml(relAge(p.created_utc)) + "</span>" +
        (p.flair ? '<span class="chip">' + escapeHtml(p.flair) + "</span>" : "") +
        (p.over_18 ? '<span class="chip" style="background:#fdecec;border-color:#e6b9b9;color:#8a2c2c;">NSFW</span>' : "") +
      "</div>" +
      '<div class="read-actions">' +
        '<button class="linkbtn" data-a="open">Open on reddit.com</button>' +
        '<button class="linkbtn" data-a="window">Open in a window</button>' +
      "</div>" +
    "</div>"
  );
}

function bindReadHeader(p) {
  $$("#readingPane .read-actions .linkbtn").forEach((b) => {
    b.addEventListener("click", () => {
      if (b.dataset.a === "open") window.open(p.permalink, "_blank", "noopener");
      else openPostWindow(p);
    });
  });
}

function renderPostBody(p) {
  let html = "";
  if (p.is_self && p.selftext.trim()) {
    html += mdToHtml(p.selftext);
  } else if (p.is_self) {
    html += '<p class="dim">(This is a text post with no body.)</p>';
  } else {
    html += '<a class="post-link-card" href="' + escapeHtml(p.url) + '" target="_blank" rel="noopener">' +
      (p.thumbnail ? '<img class="thumb" loading="lazy" src="' + escapeHtml(p.thumbnail) + '" onerror="this.style.display=\'none\'">' : "") +
      "<span><b>" + escapeHtml(p.domain || "link") + "</b><br><span class='dim'>" + escapeHtml(p.url) + "</span></span></a>";
  }
  return html;
}

function renderComment(c) {
  const depth = Math.min(c.depth, 12) + 1;
  const cls = c.depth > 0 ? " d" + Math.min(c.depth, 12) : "";
  return (
    '<div class="comment' + cls + '" data-depth="' + c.depth + '" style="margin-left:' + Math.min(c.depth, 8) * 14 + 'px">' +
      '<div class="c-author">' + escapeHtml(c.author) +
        (c.is_submitter ? ' <span class="c-op">OP</span>' : "") +
        (c.distinguished ? ' <span class="c-op">' + escapeHtml(c.distinguished) + "</span>" : "") +
        '<span class="c-score">&#9650; ' + fmtCount(c.score) + "</span>" +
        (c.replies ? '<span class="c-score">&#128172; ' + fmtCount(c.replies) + (c.replies === 1 ? " reply" : " replies") + "</span>" : "") +
        '<span class="c-time">' + escapeHtml(relAge(c.created_utc)) + "</span>" +
      "</div>" +
      '<div class="c-body">' + mdToHtml(c.body) + "</div>" +
    "</div>"
  );
}

/* ---- hover highlight: hovering a comment lights up its replies (like the original) ---- */
let _hiEls = [];
let _hiLast = null;

function clearCommentHi() {
  _hiEls.forEach((el) => el.classList.remove("hi-reply", "hi-self"));
  _hiEls = [];
}

function highlightThread(el) {
  // Walk back to the top-level comment (depth 0) that starts this thread.
  // Move back only while the CURRENT node is a reply (depth > 0), so a
  // top-level comment stays put and we never step into the previous thread.
  let root = el;
  while (
    (+root.dataset.depth || 0) > 0 &&
    root.previousElementSibling &&
    root.previousElementSibling.classList.contains("comment")
  ) {
    root = root.previousElementSibling;
  }
  // Highlight the whole thread: the root + every descendant, until the next top-level comment.
  _hiEls = [];
  let n = root;
  while (n && n.classList.contains("comment")) {
    if (n !== root && (+n.dataset.depth || 0) === 0) break;
    n.classList.add(n === el ? "hi-self" : "hi-reply");
    _hiEls.push(n);
    n = n.nextElementSibling;
  }
}

/* ===================== floating windows ===================== */

let zTop = 90;

function openWindow(title, bodyHtml, opts) {
  opts = opts || {};
  const layer = $("#windowLayer");
  const win = document.createElement("div");
  win.className = "emailwindow focused";
  const w = opts.width || 620, h = opts.height || 460;
  const offset = layer.children.length * 24;
  win.style.width = w + "px";
  win.style.height = h + "px";
  win.style.left = Math.max(20, Math.min(window.innerWidth - w - 20, 120 + offset)) + "px";
  win.style.top = Math.max(20, Math.min(window.innerHeight - h - 20, 90 + offset)) + "px";
  win.style.zIndex = ++zTop;

  win.innerHTML =
    '<div class="ew-title">' +
      '<span class="ew-name">' + escapeHtml(title) + "</span>" +
      '<button class="ew-btn ew-min" title="Minimize">&#8211;</button>' +
      '<button class="ew-btn ew-close" title="Close">&#10005;</button>' +
    "</div>" +
    '<div class="ew-body"></div>' +
    '<div class="ew-resize"></div>';
  layer.appendChild(win);

  const body = $(".ew-body", win);
  if (typeof bodyHtml === "string") body.innerHTML = bodyHtml;
  else body.appendChild(bodyHtml);

  makeDraggable(win, $(".ew-title", win));
  makeResizable(win, $(".ew-resize", win));
  win.addEventListener("mousedown", () => { win.style.zIndex = ++zTop; focusWindow(win); });

  $(".ew-close", win).addEventListener("click", () => closeWindow(win));

  const handle = { el: win, title: title };
  const taskBar = $("#taskItems");
  if (taskBar) {
    const chip = document.createElement("div");
    chip.className = "task-chip active";
    chip.innerHTML = '<span class="t-ico">&#9993;</span><span>' + escapeHtml(title) + "</span>";
    chip.addEventListener("click", () => {
      if (win.style.display === "none") { win.style.display = "flex"; focusWindow(win); }
      else if (win.classList.contains("minimized")) { win.classList.remove("minimized"); focusWindow(win); }
      else { win.style.display = "none"; win.classList.add("minimized"); chip.classList.remove("active"); }
    });
    taskBar.appendChild(chip);
    handle.chip = chip;

    $(".ew-min", win).addEventListener("click", () => {
      win.style.display = "none";
      win.classList.add("minimized");
      chip.classList.remove("active");
    });
  } else {
    // no taskbar to restore from — drop the minimize button
    const mb = $(".ew-min", win);
    if (mb) mb.remove();
  }

  handle.close = () => closeWindow(win);
  windows.push(handle);
  focusWindow(win);
  return handle;
}

const windows = [];

function focusWindow(win) {
  windows.forEach((h) => {
    h.el.classList.toggle("focused", h.el === win);
    if (h.chip) h.chip.classList.toggle("active", h.el === win && h.el.style.display !== "none");
  });
}

function closeWindow(win) {
  const i = windows.findIndex((h) => h.el === win);
  if (i >= 0) { if (windows[i].chip) windows[i].chip.remove(); windows.splice(i, 1); }
  win.remove();
}

/* One mousemove/mouseup pair for all windows, active only while dragging. */
let _gesture = null;
document.addEventListener("mousemove", (e) => {
  if (!_gesture) return;
  const g = _gesture;
  if (g.kind === "drag") {
    g.win.style.left = Math.max(0, g.ox + e.clientX - g.sx) + "px";
    g.win.style.top = Math.max(0, g.oy + e.clientY - g.sy) + "px";
  } else {
    g.win.style.width = Math.max(320, g.sw + e.clientX - g.sx) + "px";
    g.win.style.height = Math.max(200, g.sh + e.clientY - g.sy) + "px";
  }
});
document.addEventListener("mouseup", () => (_gesture = null));

function makeDraggable(win, handle) {
  handle.addEventListener("mousedown", (e) => {
    if (e.target.closest(".ew-btn")) return;
    _gesture = { kind: "drag", win, sx: e.clientX, sy: e.clientY, ox: win.offsetLeft, oy: win.offsetTop };
    e.preventDefault();
  });
}

function makeResizable(win, grip) {
  grip.addEventListener("mousedown", (e) => {
    _gesture = { kind: "resize", win, sx: e.clientX, sy: e.clientY, sw: win.offsetWidth, sh: win.offsetHeight };
    e.preventDefault(); e.stopPropagation();
  });
}

function openPostWindow(p) {
  const container = document.createElement("div");
  const head = document.createElement("div");
  head.innerHTML =
    '<div style="font-size:16px;font-weight:600;color:#17263e;margin-bottom:6px;">' + escapeHtml(p.title) + "</div>" +
    '<div class="dim" style="font-size:12px;margin-bottom:10px;">r/' + escapeHtml(p.subreddit) + " · " + escapeHtml(p.author) + " · " + escapeHtml(relAge(p.created_utc)) + "</div>" +
    renderPostBody(p) +
    '<hr style="border:none;border-top:1px solid #e6eaf0;margin:14px 0;">';
  container.appendChild(head);

  const holder = document.createElement("div");
  holder.innerHTML = '<div class="read-loading"><span class="spinner"></span>Loading conversation…</div>';
  container.appendChild(holder);

  openWindow(p.title, container, { width: 680, height: 520 });

  RedditAPI.getComments(p.id, 100)
    .then((tree) => {
      holder.innerHTML = tree.length
        ? '<div class="section-head" style="margin:0 0 4px;">Conversation</div>' + tree.map(renderComment).join("")
        : '<div class="c-more">No comments archived for this post yet.</div>';
    })
    .catch((e) => (holder.innerHTML = '<div class="error-box"><b>' + escapeHtml(e.title || "Error") + "</b>" + escapeHtml(e.detail || e.message) + "</div>"));
}

/* ===================== compose ("New Email") ===================== */

function openCompose() {
  const form = document.createElement("div");
  form.className = "ew-compose";
  form.innerHTML =
    '<label>To (subreddit)</label>' +
    '<input id="composeSub" placeholder="e.g. programming  (or paste an r/... name)" />' +
    '<label>Subject</label>' +
    '<input value="Add this subreddit as a folder" />' +
    '<label>Message</label>' +
    '<textarea>Enter a subreddit name above and press Send. It becomes a new folder on the left, just like the original MSOutlookit.</textarea>' +
    '<div style="display:flex;gap:8px;margin-top:6px;">' +
      '<button class="linkbtn" id="composeSend">&#9654; Send</button>' +
      '<button class="linkbtn" id="composeCancel">Cancel</button>' +
    "</div>";
  const h = openWindow("New Message", form, { width: 480, height: 380 });
  setTimeout(() => { const i = $("#composeSub"); if (i) i.focus(); }, 30);

  const send = () => {
    const val = $("#composeSub").value;
    const res = Store.addFolder(val);
    if (!res.ok) { toast(res.reason, 3000); return; }
    h.close();
    toast("Added folder r/" + res.name);
    Store.activeFolder = Store.folders.indexOf(res.name);
    Store.persistFolders();
    renderFolders();
    loadFolder();
  };
  $("#composeSend").addEventListener("click", send);
  $("#composeCancel").addEventListener("click", () => h.close());
  $("#composeSub").addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
}

/* ===================== taskbar clock ===================== */

function tickClock() {
  const d = new Date();
  const t = $("#clockTime"), dt = $("#clockDate");
  const ts = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (t && t.textContent !== ts) {
    t.textContent = ts;
    if (dt) dt.textContent = d.toLocaleDateString([], { month: "numeric", day: "numeric", year: "numeric" });
  }
}

/* ===================== wiring ===================== */

function bindChrome() {
  const on = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); };
  on("#btnNewEmail", "click", openCompose);
  const refresh = () => { RedditAPI.clearCache(); loadFolder(); };
  on("#btnReply", "click", refresh);
  on("#btnRefresh", "click", refresh);
  on("#btnDelete", "click", () => {
    const sub = Store.currentFolder();
    if (!confirm("Delete the folder r/" + sub + "?")) return;
    Store.removeFolder(sub);
    renderFolders();
    loadFolder();
  });
  on("#btnForward", "click", () => {
    if (App.currentPost) window.open(App.currentPost.permalink, "_blank", "noopener");
    else toast("Open an email first, then Forward opens it on reddit.com.");
  });
  on("#btnMarkRead", "click", () => {
    Store.markAllRead(App.posts.map((p) => p.id));
    applyFilter();
    renderList();
    recomputeUnread(Store.currentFolder());
  });
  on("#startBtn", "click", () => toast("Start menu is decorative in this build."));

  const sel = $("#freshSelect");
  sel.value = String(Freshness.hours);
  sel.addEventListener("change", () => {
    Freshness.hours = parseInt(sel.value, 10) || 168;
    Store.persistFreshness();
    toast("Showing the last " + Math.round(Freshness.hours / 24) + " days");
    loadFolder();
  });

  const sortSel = $("#sortSelect");
  sortSel.value = Store.sortMode;
  sortSel.addEventListener("change", () => {
    Store.sortMode = sortSel.value;
    Store.persistSort();
    loadFolder();
  });

  const lb = $("#listBody");
  lb.addEventListener("scroll", () => {
    if (lb.scrollTop + lb.clientHeight >= lb.scrollHeight - 240) loadMore();
  }, { passive: true });

  // one delegated click handler for all rows / folders
  lb.addEventListener("click", (ev) => {
    const row = ev.target.closest(".anemail");
    if (!row) return;
    const p = App.posts.find((x) => x.id === row.dataset.id);
    if (!p) return;
    selectPost(p, row);
  });
  // keyboard: arrows / j,k move through the list, Enter opens
  lb.addEventListener("keydown", (ev) => {
    const row = ev.target.closest(".anemail");
    if (!row) return;
    let next = null;
    if (ev.key === "ArrowDown" || ev.key === "j") next = row.nextElementSibling;
    else if (ev.key === "ArrowUp" || ev.key === "k") next = row.previousElementSibling;
    else if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); row.click(); return; }
    else return;
    ev.preventDefault();
    if (next && next.classList.contains("anemail")) { next.focus(); next.click(); }
  });
  document.addEventListener("keydown", (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "e") { ev.preventDefault(); const s = $("#mailSearch"); s.focus(); s.select(); }
    else if (ev.key === "Escape" && document.activeElement === $("#mailSearch")) {
      const s = $("#mailSearch");
      if (s.value) { s.value = ""; s.dispatchEvent(new Event("input")); } else s.blur();
    }
  });
  $("#folderList").addEventListener("click", (ev) => {
    const f = ev.target.closest(".afolder");
    if (f && f.dataset.i !== undefined) switchFolder(+f.dataset.i);
  });

  // 2013 chrome controls
  let searchTimer;
  $("#mailSearch").addEventListener("input", (e) => {
    const v = e.target.value.trim().toLowerCase();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      App.filterText = v;
      applyFilter();
      renderList();
    }, 150);
  });
  $("#filterAll").addEventListener("click", () => setUnreadFilter(false));
  $("#filterUnread").addEventListener("click", () => setUnreadFilter(true));

  $(".fp-collapse").addEventListener("click", () => $(".workspace").classList.toggle("fp-min"));
  $$(".fp-head").forEach((h) =>
    h.addEventListener("click", () => h.parentElement.classList.toggle("collapsed"))
  );

  // comment hover highlight: only listen where comments live
  const onHover = (e) => {
    const c = e.target && e.target.closest ? e.target.closest(".comment") : null;
    if (c === _hiLast) return;
    clearCommentHi();
    _hiLast = c;
    if (c) highlightThread(c);
  };
  $("#readingPane").addEventListener("mouseover", onHover);
  $("#windowLayer").addEventListener("mouseover", onHover);

  window.addEventListener("resize", () => {
    windows.forEach((h) => {
      h.el.style.left = Math.min(h.el.offsetLeft, Math.max(0, window.innerWidth - h.el.offsetWidth - 10)) + "px";
      h.el.style.top = Math.min(h.el.offsetTop, Math.max(0, window.innerHeight - h.el.offsetHeight - 10)) + "px";
    });
  });
}

function setUnreadFilter(on) {
  App.filterUnread = on;
  $("#filterAll").classList.toggle("active", !on);
  $("#filterUnread").classList.toggle("active", on);
  applyFilter();
  renderList();
}

function init() {
  Store.load();
  $("#listTitle").textContent = "Inbox";
  renderFolders();
  bindChrome();
  tickClock();
  setInterval(tickClock, 15000);
  loadFolder();
}

document.addEventListener("DOMContentLoaded", init);
