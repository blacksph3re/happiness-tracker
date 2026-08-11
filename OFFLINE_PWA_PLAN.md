# Offline-first tracking — implementation plan

Turning the SPA into something installable that captures answers with no connection, and
reconciles when one returns.

## 1. Verdict: a PWA, without reservation

The earlier draft hedged because a LAN-only `http://` origin cannot host a service
worker. A public domain with TLS terminated at nginx removes that constraint entirely:
secure context, installable on both platforms, no native wrapper needed. Capacitor stays
available as a later packaging step — every piece below is reused unchanged if you ever
want it — but nothing here requires it.

The remaining risk is not the app. It is that **the extra authentication layer sits
between the service worker and the API**, and one of the three candidates cannot be
satisfied from a service worker at all.

## 2. The proxy auth layer, judged against offline use

A service worker makes requests with no window attached. Nothing that needs a UI prompt
to authenticate can work there. That single fact orders the candidates.

| Candidate | Works from a service worker? | Verdict |
| --- | --- | --- |
| **Client certificate (mTLS)** | Yes — TLS is negotiated by the network stack below `fetch()`, so background requests carry it automatically | **Recommended.** Strongest, and invisible to the app code |
| **Forward-auth with a session cookie** (Authelia, oauth2-proxy, nginx `auth_request`) | Yes — cookies are attached to service-worker fetches on same-origin requests | Good alternative; easier to revoke and renew than certs |
| **HTTP Basic Auth** | **Unreliable** | **Advise against** — see below |

**Why Basic Auth is the wrong choice here specifically.** A 401 with `WWW-Authenticate`
is answered by a browser dialog, and a service worker has no window in which to show one.
Whether cached credentials get replayed on a background fetch is browser-dependent and
undocumented. The failure mode is the bad kind: the queue stops draining, no dialog
appears, nothing is logged, and the user finds out weeks later. It is the simplest to
configure in nginx and the most likely to quietly lose data.

**What mTLS costs you**, so it is chosen with eyes open:

- Provisioning is per device: an iOS configuration profile, an Android credential install.
- **Certificates expire.** When one does, every request fails at the TLS handshake — which
  the app cannot distinguish from being offline. Plan the renewal, and give the client a
  way to tell the two apart (§4.6).
- The install itself is behind the wall: manifest, icons and the service worker script are
  all fetched from the protected origin, so the first install must happen on a device that
  already has the cert. That is fine, just not skippable.

Worth stating once: the app already authenticates users with Argon2 and JWTs. The proxy
layer is defence-in-depth for exposing FastAPI to the internet, not a replacement for it —
so this is two credential systems to keep alive, and the plan below assumes that is
deliberate.

## 3. Configuration: the domain never enters the repo

Mostly already true, and worth keeping that way.

**The frontend needs no domain at all.** Every call it makes is origin-relative
(`fetch('/api/...')`) and the SPA is served by the same process that serves the API. The
manifest uses relative `start_url` and `scope`. There is nothing to configure and nothing
to hardcode — a build artefact works on any hostname it is served from.

The backend gains two settings, in the same `Settings` class as the rest:

| Variable | Purpose |
| --- | --- |
| `ALLOWED_HOSTS` | Comma-separated hostnames for `TrustedHostMiddleware`. Currently the API answers to any `Host` header, which is worth closing once it faces the internet. Default `*` keeps dev unchanged. |
| `TRUST_PROXY_HEADERS` | Whether to honour `X-Forwarded-Proto`/`-For` from nginx, so the app sees the real scheme and client IP. Off by default; only correct behind a proxy you control. |

nginx configuration lives in deployment, not in this repository — but the README should
document the pieces the app actually depends on: `proxy_set_header X-Forwarded-Proto
$scheme`, `Cache-Control: no-cache` on the service worker script so a bad one is not
pinned forever, and no response buffering that would break the `.xlsx` download.

## 4. What gets built

### 4.1 Install and shell

- `vite-plugin-pwa` with `registerType: 'prompt'`. An auto-updating worker that swaps
  mid-session is wrong for an app you are typing answers into.
- Manifest: icons (192/512 plus maskable), `display: standalone`, `theme_color` and
  `background_color` both `#191627`, relative `start_url`.
- **Precache the whole bundle, ECharts included** — about 1.4 MB raw, 430 kB over the
  wire. Since the stats page must work offline, the charting library is not optional
  weight; it is part of the offline product. Still worth code-splitting the stats route so
  the *first* paint is quick, but both chunks get precached either way.

### 4.2 Local database

IndexedDB via `idb`, one database, five stores:

| Store | Key | Holds |
| --- | --- | --- |
| `meta` | name | cached `/me`, default catalogue id, last sync time, schema version |
| `catalogues` | catalogue id | full `/catalogues/{id}` payloads — questions, options, bounds |
| `answers` | `${day}:${question_id}` | local view of every answer, confirmed or not |
| `variables` | singleton | last `/stats/variables` response, so the stats page can render offline |
| `outbox` | auto-increment | pending answer writes |

Questionnaire, record table and stats all read from IndexedDB and never from the network
directly. A successful fetch refreshes the stores. This inverts today's flow but preserves
the behaviour that matters: answering never waits on a response.

### 4.3 What works offline, and what does not

| Area | Offline |
| --- | --- |
| Answering, any day, past or future | Yes |
| Record table + `.xlsx` export | Table yes. Export is server-rendered, so no — offer it only when online |
| Stats: all four views, window, smoothing, filters | Yes, from cached answers and variables |
| Catalogue editing, user management, profile and password changes | **No.** Online-only, with an explicit "needs a connection" state rather than a queued write |

Keeping edits online-only is what keeps the sync engine honest: the outbox carries answers
and nothing else, so there is exactly one class of conflict to reason about.

### 4.4 Merge strategy: last write by client timestamp

Confirmed as the rule: when the same `(day, question)` is answered more than once, the
answer carrying the latest timestamp wins.

- Every answer gains **`client_updated_at`**, stamped on the device at the moment of the
  tap — not at flush time, or a queued answer would appear newer than it is.
- New column `client_updated_at` on `answers`, plus `server_received_at` for diagnosis.
- On write, the server compares against the stored row and **keeps the newer one**, so a
  three-week-old queued answer replayed on reconnect cannot clobber a value entered
  yesterday on the desktop.
- Equal timestamps: keep the row already stored. Arbitrary, but deterministic, and it
  makes a replayed duplicate a no-op.
- **Clock skew is the known weakness.** A phone with a wrong clock writes wrong ordering,
  and nothing in this design detects that. Mitigations: reject timestamps implausibly far
  in the future, and keep `server_received_at` so the truth is reconstructable. For one
  user with two devices this is the right trade; it is not a general CRDT and should not
  be described as one.

### 4.5 Sync engine

One module owning the lifecycle:

1. **Enqueue** — one IndexedDB transaction writes both the local `answers` row and the
   `outbox` entry, so the UI and the queue can never disagree.
2. **Flush** — replay oldest-first against a new `PUT /api/answers/batch`. One request for
   a fortnight of answers rather than 150, with per-item results so a single rejected row
   cannot wedge the queue behind it.
3. **Triggers** — app start, the `online` event, `visibilitychange` to visible, and
   Background Sync where it exists.
4. **Pull** — after a successful flush, re-fetch answers, catalogues and stats variables.
5. **Report** — a persistent indicator: synced / N pending / offline / **blocked**. The
   last one matters: see below.

### 4.6 Telling "offline" apart from "rejected"

With mTLS, an expired or missing client certificate fails during the TLS handshake. To
`fetch()` that is a `TypeError`, exactly like having no signal. Left alone, a device whose
certificate lapsed would look "offline" forever while silently accumulating a queue.

The distinguishing probe: if `navigator.onLine` is true but every request to the origin
fails at the network layer, the connection is being refused, not absent. Surface that as a
distinct **blocked** state — "the server is refusing this device; your certificate may have
expired" — rather than the reassuring offline badge. Same applies to a forward-auth cookie
that has expired, except there the failure arrives as a 401 from the proxy, which is easy
to detect and should also be reported as blocked rather than treated as a session expiry.

### 4.7 Auth, offline

Today `api.js` answers a 401 by clearing tokens and redirecting to `/login`. With an
outbox that is a data-loss path. Required:

- **The outbox and `answers` store survive logout.** Only tokens are cleared.
- The app opens, and accepts answers, with an expired token or no network. Identity comes
  from cached `/me`; the queue waits.
- A 401 from *the app* (JWT expired) and a 401 from *the proxy* are different events and
  must not share a code path.
- Access 1h / refresh 30d means an unbroken offline stretch past 30 days ends with a dead
  refresh token. The queue must then wait for a manual re-login rather than being
  discarded. Consider a longer `REFRESH_TOKEN_TTL` now that a second auth layer guards the
  door.
- **First run needs a connection** — no offline login, and no catalogue to answer against
  until one has been fetched. Document it rather than engineering around it.

## 5. Platform reality

| Capability | Android / Chrome | iOS / Safari |
| --- | --- | --- |
| Install to home screen | Prompted | Manual: Share → Add to Home Screen |
| Offline launch | Yes | Yes |
| **Background Sync** | Yes | **No** |
| Client certificates | Installed via Settings, selection prompted | Configuration profile; prompt behaviour in standalone mode is worth testing early |
| Storage eviction | Rare; `persist()` usually granted | Possible under pressure |

On iOS, "sync when a connection returns" means "sync next time you open the app". Build
sync-on-open as the primary path and Background Sync as enhancement, or Android will work
while the iPhone quietly accumulates.

## 6. Risks

- **iOS storage eviction.** Answers live only on the device until they sync. Call
  `navigator.storage.persist()`, and provide a local export so a long trip is recoverable.
- **A service worker is sticky.** Ship a broken one and clients keep it. Keep the update
  prompt and test the upgrade path, not only the install.
- **Certificate expiry looks like bad signal.** Addressed by §4.6; without it this is the
  most likely silent failure in the whole design.
- **Silent queue growth** is worse than a loud error. The indicator is not decoration.

## 7. Build order

| Phase | Contents |
| --- | --- |
| 0 | Deployment: VM, nginx, TLS, chosen auth layer. `ALLOWED_HOSTS` + proxy-header settings. Verify the API is reachable only through the proxy |
| 1 | Manifest, icons, service worker, precache. Verify install on both phones **through the auth layer** |
| 2 | IndexedDB stores; questionnaire, record and stats read local-first |
| 3 | Outbox, flush, triggers, sync indicator, blocked-state detection |
| 4 | Backend: `client_updated_at`, `server_received_at`, batch endpoint, last-write-wins rule |
| 5 | Auth hardening: queue survives 401 and logout; proxy 401 handled separately |
| 6 | `persist()`, local export, Background Sync on Android |

## 8. Test plan

Offline behaviour passes by hand and breaks in the field, so most of this belongs in
Playwright with `context.setOffline(true)`.

- Install, go offline, cold-launch → questionnaire renders from cache.
- Answer a full day offline → visible after reload, still offline.
- Stats offline → all four views render from cached answers and variables.
- Reconnect → outbox drains, server matches, indicator returns to synced.
- Force a mid-flush failure → no duplicates, no losses, retry completes.
- **Merge rule**: replay a queued answer older than the stored one → server keeps the
  newer. Replay a newer one → server takes it. Replay an identical one → no-op.
- Two devices answer the same `(day, question)` while both offline; both reconnect → the
  later timestamp survives regardless of arrival order.
- Access token expires while offline → reconnect refreshes and flushes; the user is never
  bounced to login holding pending data.
- Log out with a non-empty outbox → queue intact after logging back in.
- Certificate/proxy rejection while `navigator.onLine` is true → **blocked**, not offline.
- Service worker update mid-day → no data loss, prompt shown.
- Backend: batch idempotency, per-item errors, staleness rule, implausible future
  timestamps rejected.

## 9. Questions

Assumptions in brackets; each is cheap now and expensive later.

1. **Which auth layer** — mTLS, cookie forward-auth, or Basic Auth anyway? If Basic, are
   you willing to accept that background sync may not work and that answering may need the
   app in the foreground? [assumed: mTLS]
2. **Certificate lifetime and renewal**, if mTLS — how long, and how do devices get a new
   one? This decides how loud the blocked state has to be. [assumed: 1 year, manual]
3. **How many devices** answer questions? Two offline devices editing the same day is the
   only case where the merge rule does real work. [assumed: one phone, one desktop]
4. **Longest expected offline stretch?** Past 30 days collides with the refresh token.
   [assumed: up to ~3 weeks, so `REFRESH_TOKEN_TTL` is raised to 90d]
5. **Is losing unsynced data acceptable** if a phone is wiped, or do you want an export
   that works offline? [assumed: offline export wanted]
6. **The `.xlsx` export is server-rendered** — leave it online-only, or add a client-side
   CSV for offline use? [assumed: online-only, with the button disabled offline]
7. **Should the record table let you answer a day offline** the way it does online, or is
   the questionnaire enough? [assumed: yes, it is the same write path]
8. **Daily reminder notifications** — wanted? Separate feature, but shares the service
   worker, so it is cheaper to plan now than to bolt on. [assumed: not now]
9. **iOS install**: manual Share → Add to Home Screen acceptable, or do you want an in-app
   walkthrough? [assumed: a short prompt]
