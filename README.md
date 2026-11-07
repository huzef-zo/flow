# Flow — calm, offline-first tasks

A mobile-first Progressive Web App for people who want a **Things 3 feel** (calm,
minimal, "clean sheet of paper"), **Todoist-grade quick add**, and a
**TickTick-style time-blocking planner** — as plain static files. No build step,
no backend, no account, no lock-in.

- **100% offline**: IndexedDB is the single source of truth; a service worker
  precaches the app shell. Install it and it keeps working on a plane.
- **Natural-language quick add**: `Email Dana tomorrow 9am #Work @email p1` —
  live highlighted chips you can tap to override.
- **Today = a timeline**, not a list: drag tasks onto the day to time-block
  them (15-min snap), drag edges to resize, drag back to unschedule.
  Overlay events from an imported `.ics` calendar.
- **Productivity tools bundled free**: Pomodoro focus timer (logs minutes per
  task), Eisenhower matrix, habit tracker with streaks + heatmap.
- **Sync-ready architecture**: every mutation flows through a durable outbox
  with a hybrid logical clock and field-level last-write-wins. A mock
  "server" (second IndexedDB store) lets you test two devices, offline
  mode and conflicts in one browser. See [SYNC.md](./SYNC.md).

---

## Quick start (any static server)

ES modules and service workers need HTTP(S), so don't open `index.html` via
`file://`. From this folder run any of:

```bash
python3 -m http.server 8080
# or
npx serve .
```

then open <http://localhost:8080>.

> First run shows 3 onboarding cards and seeds a few sample tasks that
> demonstrate the quick-add syntax. Remove them anytime in
> **Settings → Data ownership → Clear sample data**.

## Deploy to GitHub Pages

1. Create a repo and push this folder's contents to the `main` branch
   (the app must live at the **root** of the branch).
2. Repo **Settings → Pages → Source: Deploy from a branch**, branch `main`,
   folder `/ (root)`.
3. Done. The app is fully path-relative (`./…` URLs, relative SW scope), so it
   also works under `username.github.io` **or** a project sub-path such as
   `username.github.io/flow/` — in that case push the files into a `docs/`
   folder or a subfolder and select it in Pages settings.

Any other static host (Netlify, Cloudflare Pages, nginx) works the same:
upload the folder as-is. There is nothing to build.

To ship an update, bump `VERSION` at the top of `sw.js`; old caches are
cleaned up automatically on activation.

## Quick-add cheat sheet

| You type | You get |
| --- | --- |
| `today`, `tonight`, `tomorrow`, `tmr` | scheduled that day (tonight = today 8pm) |
| `next friday`, `next week`, `next month`, `this weekend` | next occurrence |
| `in 3 days`, `in 2 weeks`, `in 5 hours`, `3 weeks from now` | relative dates |
| `jun 12`, `15 jun 2027`, `12/06`, `5/17/2027` | calendar dates (M/D by default; past dates roll to next year) |
| `at 5pm`, `17:30`, `at 5`, `at noon`, `in the morning` | times (`at 5` = 5 PM, 7–11 default to AM) |
| `from 2pm to 3pm`, `2pm-3:30pm` | start time **and** duration |
| `for 45m`, `for 1h30m`, `for 2 hours` | duration |
| `p1`–`p4` or `!!!` / `!!` / `!` | priority |
| `#Project` | project (created if missing) |
| `@label` | label (created if missing) |
| `&Area` | area (task goes to that area's first project, created if needed) |
| `every day`, `every other day`, `every weekday`, `every weekend` | recurrence |
| `every 2 weeks`, `every 3 months`, `every friday`, `every monday and wednesday` | recurrence |
| `every 3rd wednesday`, `every month on the 15th` | nth-day recurrence |
| `after 2 days from completion` | recurrence that restarts from the day you finish |
| `someday` | parks the task in Someday |

Conventions: a weekday means the next occurrence **including today**;
`next friday` means Friday of next week (week starts per your setting);
a time without a date means today. Disable any chip in the quick-add sheet
to override the parse — the words stay out of the title either way.

Self-check: open [`js/parser.test.html`](./js/parser.test.html) (85 cases,
same suite runs via `node js/parser.test.js`).

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Q` | Quick add |
| `Ctrl/Cmd + K` or `/` | Search & command palette |
| `1`–`4` | Today · Inbox · Upcoming · Browse |
| `X` | Complete focused task row |
| `Esc` | Close sheet / menu / selection |
| `?` | Shortcut help |

## Features

- **Capture**: quick add with live parse preview + removable chips, voice
  input (Web Speech API where available), `Q` shortcut, FAB.
- **Organize**: Areas → Projects → Tasks → Subtasks (3 levels), labels,
  saved smart lists (filters like "P1 and due this week"), Someday,
  start dates (hidden until start), due dates + reminders.
- **Views**: Inbox, Today (timeline planner), Upcoming (14 days + Later),
  Anytime, Someday, Logbook (completed, with undo).
- **Timeline planner**: drag-to-time-block with 15-min snap, drag to move,
  edge-handles to resize, drag out to unschedule, overlapping blocks get
  lanes, now-line, progress ring + planned-vs-available time, evening
  "Plan tomorrow" prompt (optional), `.ics` import/export with events
  rendered distinctly.
- **Tasks**: markdown notes (bold/italic/lists/links/**interactive
  checkboxes**), subtasks, priority, labels, project, start/due dates,
  recurrence editor, reminders. Swipe right = complete, swipe left =
  schedule menu, long-press = multi-select with bulk complete/delete/
  date/priority/move. Undo toast for every destructive action.
- **Tools**: Pomodoro (25/5 default, configurable, logs focus minutes per
  task, sound + vibration + notification), Eisenhower matrix (drag between
  quadrants re-prioritizes), habit tracker (daily/weekly, streaks, heatmap).
- **Search**: instant command palette over tasks, notes, projects, labels
  and app commands.
- **Settings**: theme (system/light/dark) + 6 AA-contrast accents,
  week start, 12/24h, default reminder time, storage persistence request,
  full JSON export/import, CSV export, `.ics` export/import, clear sample
  data, erase all.
- **Notifications**: reminders via the Notifications API + service worker
  while the app is open or backgrounded recently, with in-app banners as
  fallback — and an honest note in Settings about mobile-web limits.

## Architecture overview

```
index.html ─┬─ css/  base · components · views
            ├─ js/main.js   boot · shell · router (lazy views) · quick add
            │        │        · reminders · onboarding · shortcuts
            │        ├─ js/parser.js   natural-language quick add (pure)
            │        ├─ js/ui.js       DOM kit: sheets, toasts, rows,
            │        │                 swipe, virtual scroller, selection
            │        └─ js/views/*     today · list (inbox/anytime/…) ·
            │                          upcoming · browse · detail · matrix ·
            │                          habits · focus · settings · palette
            ├─ js/store.js  block store: registry + in-memory cache + CRUD
            │               + outbox writes + queries + recurrence + seed
            ├─ js/db.js     IndexedDB wrapper (blocks · outbox · meta · server)
            ├─ js/sync.js   HLC clock · field-level LWW merge · sync engine
            │               · MockAdapter (pretend server in a 2nd store)
            ├─ js/ics.js    iCalendar import/export
            └─ sw.js        precache app shell + runtime SWR caching
```

**Data model** — everything is a *block*:
`{ id (UUIDv7), type, parentId, order (fractional index), workspaceId, props,
fieldHlcs, createdAt, updatedAt, deletedAt (tombstone), version, deviceId }`.
New entity types only need a `registerType()` definition (defaults + schema +
describe renderer); the store, sync, export and dev tools pick them up
automatically. Ordering uses fractional indexing, so reordering writes one
record, not the whole list. Dates are stored as local wall-clock strings
(`2026-11-08`, minutes-from-midnight), which keeps them stable across
timezone changes and DST transitions.

**Offline-first** — reads are synchronous from the in-memory cache (smooth
with 1,000+ tasks; long lists window-render above ~200 rows); every write
mutates the cache immediately (optimistic UI) and commits to IndexedDB **in
the same transaction as an outbox operation record**. The sync engine pushes
the outbox with exponential backoff + jitter, pulls changes since a cursor,
and merges field-by-field with a hybrid logical clock. See
[SYNC.md](./SYNC.md) for the protocol and how to plug in Supabase/Firebase/
your own backend later.

**Testing** — `js/parser.test.html` (or `node js/parser.test.js`) runs 85
parser cases; the Developer panel in Settings can generate 1,000 tasks,
force offline/online, inject conflicts, and watch the outbox live.

## Performance & accessibility notes

Designed to hit Lighthouse **PWA 100 / Performance ≥90 / Accessibility ≥95**
on a mid-range Android profile (run your own audit to confirm on your
hardware): no frameworks, no web fonts (system stack), deferred ES modules,
GPU-only animations (transform/opacity), windowed long lists, and
`prefers-reduced-motion` disables all non-essential motion. Accessibility:
semantic landmarks, ARIA roles/labels on every control, visible focus rings,
44px touch targets, WCAG-AA contrast in both themes for text and the six
accent presets.

## Known limitations (honest list)

- **Background reminders are best-effort.** Mobile browsers suspend web
  apps; reminders fire reliably while the app is open (or recently used)
  and queue otherwise. iOS additionally requires the PWA to be installed
  (home screen) for notification permission at all. The Settings screen
  says this out loud.
- **`.ics` import ignores `TZID`** (times treated as local/floating), and
  expands only DAILY/WEEKLY/MONTHLY/YEARLY rules with INTERVAL/COUNT/UNTIL/
  BYDAY. Exotic rules import their first occurrence.
- No attachments, no sub-projects deeper than Area → Project, no real-time
  collaboration. Deleted data lives as tombstones until the (future) server
  GCs them.
- `prompt()`-based name inputs in a couple of admin spots (new project/area)
  keep the code small; proper sheets are on the roadmap.
- Keyboard alternatives exist for every drag gesture, but list *reordering*
  is manual-order only via fractional keys (no list drag yet).

## Roadmap

- Attachments (blobs in IndexedDB), widget/quick-tile via shortcut deep links
- Real sync backend (the adapter contract in SYNC.md is ready), CRDT notes
- List drag-reorder, multi-day timeline planning view, calendar subscription
  (ICS URLs), natural-language editing of existing tasks

## License

MIT — do what you like. Flow's name and design are yours to fork.
