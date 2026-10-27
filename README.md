# MSOutlookit (recreation)

A faithful recreation of [MSOutlookit](https://github.com/pcottle/MSOutlookit) — a
Microsoft Outlook 2013 interface laid over Reddit, so it looks like you're reading
email at work.

This is a faithful recreation of the original's look: the top chrome (ribbon, tab
strip, toolbar icons), the taskbar and the bottom bar are drawn from the **same image
assets** the original MSOutlookit uses, with transparent hotspots for the interactive
buttons. The panes (folders, message list, reading pane) are styled in CSS because
they're dynamic. Code is **dependency-free vanilla JS** and **read-only**.

## Run it

From this folder:

```powershell
node test/server.js
```

Then open <http://localhost:8000/>.

(Any static file server works. A server is recommended over opening `index.html`
directly, so `fetch` runs from a real `http://` origin.)

## How it maps to the original

| Outlook | Reddit |
|---|---|
| Folder (left) | Subreddit |
| Email row (middle) | Post — sender = author, subject = title |
| Reading pane (right) | Post body + comment thread |
| Comment indentation | Nested comment tree, coloured borders (`.d1`–`.d12`) |
| **New Email** | Add a subreddit folder |
| **Delete** | Remove a subreddit folder |
| **Reply All** / **Refresh** | Reload the folder |
| **Forward** | Open the post on reddit.com |
| Up/down arrows | Decorative — open the post on reddit.com |
| Floating email window | Post opened in a draggable/resizable window |
| **Sort by** (Newest / Most comments / Top score / Oldest) | Order the message list |
| **Search Current Mailbox** box | Filter the list by title / author |
| **All / Unread** tabs | Show everything or unread only |
| Collapsible folder sections | Collapse "Favorites" / "Outlook Data File" |
| Taskbar clock | Live system time |

Folders, read/unread state, the freshness setting and the sort order persist in `localStorage`.

**Sorting note:** the archive API can only order by time (`sort_type` is limited to
`created_utc`), so *Most comments* and *Top score* are ranked **client-side**. Collecting
a whole 30-day window is far too slow, so these modes **sample evenly across the window**
(a few slices at different ages, up to ~100 posts each) and rank the result — so a longer
window samples older points and produces a different list. The status bar marks these as
**“(sampled)”**. *Newest*/*Oldest* use the true archive order and load lazily as you
scroll.

Requests use the archive's `fields` filter to trim payloads (~424KB → ~42KB, and from
~20s to ~1s per request). `is_self`, `permalink`, `domain` and `thumbnail` aren't
returned by that filter, so they're derived from the available fields.

## Data source — read this

`reddit.com`'s own API blocks this network (HTTP 403 "Blocked"), so this build reads
from a **Reddit archive API**:

> **Arctic Shift** — <https://arctic-shift.photon-reddit.com>

It serves **real Reddit posts and comments** in Reddit's own JSON shape and sends
`access-control-allow-origin: *`, so the browser fetches it directly — no proxy, no
mock data.

**The trade-off (important):** the archive fills in a post's `num_comments` and its
comment thread about **a day or two after posting** — a post indexed at creation shows
`num_comments: 0` even if it later gets hundreds. So this build shows only posts that
**already have a discussion**, read from a window a few days in the past. The
**"Show posts"** dropdown in the ribbon controls how far back that window starts:

- **Freshest (~2 days)** — youngest posts that still have comments (~88% have threads).
- **Recent (~3 days)** — the default; a good balance.
- **This week (~7 days)** — **100%** of items have full comment threads.
- **This month (~30 days)** — oldest, fully-archived discussions.

Zero-comment posts are filtered out of the list entirely, so every email opens with a
real conversation. This is a hard characteristic of the archive, not a bug.

If you later want truly real-time data with full threads, point `AS_BASE` in
`js/api.js` at a proxy you host on a non-blocked IP (e.g. a Cloudflare Worker) that
fetches `reddit.com` with a proper User-Agent — the rest of the app needs no changes.

### If you see "Could not reach the mail server"

The archive is a free third-party service and may rate-limit (HTTP 429) or briefly go
down. Wait a few seconds and press **Refresh**.

## Files

```
index.html        page skeleton
css/outlook.css   pane styling + image chrome placement
img/              chrome sprites (from the original MSOutlookit project)
js/api.js         Arctic Shift client (getListing / getComments) + the freshness dial
js/state.js       folders, read/unread, localStorage
js/app.js         rendering + interaction (list, reading pane, windows, taskbar)
test/             diagnostics used to validate connectivity + a tiny static server
```

## Notes

- No affiliation with Microsoft or Reddit. "Outlook" is used only descriptively.
- Read-only: no login, no voting, no commenting.
