/* ============================================================
   state.js — folders, read/unread, selection, persistence.
   ============================================================ */

const Store = {
  KEY_FOLDERS: "msoutlookit.folders",
  KEY_READ: "msoutlookit.read",
  KEY_ACTIVE: "msoutlookit.active",
  KEY_FRESH: "msoutlookit.freshness",
  KEY_SORT: "msoutlookit.sort",
  defaultFolders: ["programming", "technology", "news", "askreddit", "science"],

  folders: [],
  readPosts: new Set(), // post ids marked read
  activeFolder: 0,
  sortMode: "newest",

  load() {
    let folders = null;
    try {
      const raw = localStorage.getItem(this.KEY_FOLDERS);
      if (raw) folders = JSON.parse(raw);
    } catch (e) {}
    this.folders = Array.isArray(folders) && folders.length ? folders : this.defaultFolders.slice();

    try {
      const raw = localStorage.getItem(this.KEY_READ);
      if (raw) JSON.parse(raw).forEach((id) => this.readPosts.add(id));
    } catch (e) {}

    const a = parseInt(localStorage.getItem(this.KEY_ACTIVE), 10);
    this.activeFolder = Number.isFinite(a) && a >= 0 && a < this.folders.length ? a : 0;

    const f = parseInt(localStorage.getItem(this.KEY_FRESH), 10);
    if (Number.isFinite(f) && f > 0) Freshness.hours = f;

    const s = localStorage.getItem(this.KEY_SORT);
    if (s && ["newest", "comments", "score", "oldest"].includes(s)) this.sortMode = s;

    // safety: read set can't grow forever
    if (this.readPosts.size > 4000) this.readPosts = new Set(Array.from(this.readPosts).slice(-2000));
  },

  persistFolders() {
    try { localStorage.setItem(this.KEY_FOLDERS, JSON.stringify(this.folders)); } catch (e) {}
    try { localStorage.setItem(this.KEY_ACTIVE, String(this.activeFolder)); } catch (e) {}
  },

  persistRead() {
    try { localStorage.setItem(this.KEY_READ, JSON.stringify(Array.from(this.readPosts))); } catch (e) {}
  },

  persistFreshness() {
    try { localStorage.setItem(this.KEY_FRESH, String(Freshness.hours)); } catch (e) {}
  },

  persistSort() {
    try { localStorage.setItem(this.KEY_SORT, this.sortMode); } catch (e) {}
  },

  currentFolder() { return this.folders[this.activeFolder]; },

  addFolder(name) {
    name = String(name || "").trim().replace(/^\/?r\//i, "").replace(/\/+$/, "");
    if (!name || !/^[A-Za-z0-9_]{2,21}$/.test(name)) return { ok: false, reason: "Not a valid subreddit name." };
    if (this.folders.some((f) => f.toLowerCase() === name.toLowerCase()))
      return { ok: false, reason: "r/" + name + " is already in your folders." };
    this.folders.push(name);
    this.persistFolders();
    return { ok: true, name };
  },

  removeFolder(name) {
    const i = this.folders.indexOf(name);
    if (i < 0) return;
    this.folders.splice(i, 1);
    if (this.activeFolder >= this.folders.length) this.activeFolder = Math.max(0, this.folders.length - 1);
    this.persistFolders();
  },

  isRead(id) { return this.readPosts.has(id); },
  markRead(id) {
    if (!this.readPosts.has(id)) { this.readPosts.add(id); this.persistRead(); }
  },
  markAllRead(ids) {
    ids.forEach((id) => this.readPosts.add(id));
    this.persistRead();
  },
};
