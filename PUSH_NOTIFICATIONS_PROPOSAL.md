# Push notifications — step 2 of pomodoro tracking

*Discussion document, written because the MVP's late-on-wake alert is explicitly
a stopgap. Scope is deliberately narrow: **one notification, on time, when the
app is not running.** `[open]` marks a decision I think is yours; `[verify]`
marks something I could not prove on this machine.*

**Read [POMODORO_DISCUSSION.md](POMODORO_DISCUSSION.md) first** — this only makes
sense as the thing that fixes the one limitation step 1 ships with.

---

## Why this exists, and why not sooner

The cheap escape was that iOS keeps a tab executing while it is playing audio, so
a pomodoro with a focus sound could keep its own timer alive and fire its own
alert. That is closed: **"none" is a valid focus sound**, so the quiet case is a
real case, and it is exactly the case that gets nothing. A feature that works
with birdsong and fails in silence is worse than one that is uniformly late,
because you would learn not to trust it.

The order still matters, though. Step 1 first means push is built against a
working feature with real usage behind it, and it means the notification's
content is known before the machinery to deliver it exists.

**This is not sync.** Push cannot carry silent background updates —
`PushManager.subscribe()` requires `userVisibleOnly: true`, and a handler that
does not call `showNotification` gets one shown for it, so a data sync would
announce itself every time. `lib/revalidate.js` keeps its job unchanged. That
was settled; it is restated here only so nobody re-derives it from "we have push
now".

The consequence to keep in view: **there is no second caller.** Everything below
is paid for by one notification per phase boundary.

---

## What iOS actually requires

Checked, because most of the cost is here rather than in the sending.

| | |
| --- | --- |
| Home Screen only | The Push API is available to a web app **added via Share → Add to Home Screen**. An ordinary Safari tab has no `PushManager` at all |
| Since | iOS 16.4, March 2023 |
| Permission | Must be requested from a **user gesture** — a tap on a button, not on page load |
| EU | Was a real threat and is not one now |

That last was worth chasing down. Apple announced in early 2024 that iOS 17.4
would reduce Home Screen web apps to bookmarks in the EU for DMA reasons, which
would have removed push and offline together. After developer and regulatory
pressure Apple reversed it before 17.4 shipped, and Home Screen web apps —
including push — [continue to work in the EU](https://9to5mac.com/2024/03/01/apple-home-screen-web-apps-ios-17-eu/).
So: no blocker, but it is a capability Apple has once tried to withdraw, which is
an argument for the feature degrading to the late notification rather than
depending on push.

`[verify]` The home-screen requirement means **the install is now load-bearing**,
not a nicety. Worth confirming on your phone that the app is installed that way
before any of this is built, since a Safari tab will never prompt.

---

## The four costs

### 1. A scheduler, in an application that has none

The one that is easy to miss, and the largest. `main.py`'s lifespan runs
`bootstrap` and yields; **nothing in this codebase ever runs on its own.** Firing
an alert 25 minutes from now means introducing background execution:

- a `scheduled_pushes` table — because an in-memory timer dies with the container, and the container restarts on every deploy, which is also every migration;
- an asyncio task polling it on a short tick;
- claim-then-send, so a restart mid-send does not deliver twice;
- and a decision about what a *missed* window means: if the container was down for ten minutes, does a pomodoro that ended eight minutes ago still get its alert, or is it dropped as stale?

`[open]` **How late is too late to still send?** A 60-second grace is defensible
and so is dropping anything past its moment. This is small, but it is the kind of
thing that is unpleasant to decide after the fact.

`[open]` **Does the scheduler run in the same process as the web server?** In one
process it is a few lines in the lifespan and shares the connection pool; the
cost is that it is duplicated if the app is ever run with more than one worker,
which today it is not. A separate process is correct and doubles the deployment.
I lean **one process, one worker, guarded by a claim** — matching how small this
deployment actually is, with the claim making the multi-worker case merely
wasteful rather than wrong.

### 2. A subscription table, and Safari making it hard to prune

**`push_subscriptions`** — `user_id`, `endpoint` (unique), `p256dh`, `auth`, a
label for which device, `created_at`. Owned like everything else, so another
account's subscription answers 404.

The spec says a `410 Gone` from the push service means the subscription is dead
and the row should be deleted rather than retried. That works for Chrome. **On
Apple's service it is unreliable**: `web.push.apple.com` has been reported to
answer `201 Created` for a subscription that has already been replaced, where a
`410` was expected, so dead endpoints accumulate looking healthy
([Pushpad](https://pushpad.xyz/blog/web-push-error-410-the-push-subscription-has-expired-or-the-user-has-unsubscribed)).

So the cleanup cannot be status-driven alone. The cheap mitigation is to let the
client **re-register on every launch** and upsert on `endpoint`, plus prune rows
untouched for some months. For a single-user tool with a handful of devices this
is a small table that never really grows — but it should be built knowing the
tidy version does not work, rather than discovering it as a bug.

`[verify]` Worth confirming against current Safari rather than trusting a report;
it is the kind of thing Apple fixes quietly.

### 3. A secret, with a constraint that touches a standing rule

VAPID keys, joining `JWT_SECRET` and `TOTP_ENCRYPTION_KEY` — **no default, the
server crashes without it**, per the settled rule. The public half also has to
reach the client, which is a new kind of thing to plumb: it can be baked at build
time or served from an endpoint, and serving it is better, because otherwise
rotating the key means rebuilding the frontend.

`[open]` Rotating VAPID keys **invalidates every existing subscription**. Like
`JWT_SECRET` rotation signing everyone out, this should be written down where the
other two are described, so it is known before it is done rather than after.

The sharp edge: a VAPID claim set needs a `sub` that is **either a `mailto:`
address or a full HTTPS URL** ([py-vapid](https://pypi.org/project/py-vapid/)) —
and the HTTPS URL would be the deployment's domain, which **must never be in the
repository**. Use the `mailto:` form. It sidesteps the rule entirely instead of
adding a second thing that has to stay out of git.

`[open]` Which address. Any mailbox works; it is contact information for the push
service, not an identifier.

### 4. A service worker we have to own

Currently `vite-plugin-pwa` runs in its default `generateSW` mode: there is no
service worker file in this repo, Workbox writes it. **A `push` handler cannot be
added to a generated worker.** That means switching to `strategies:
'injectManifest'` and owning `src/sw.js` — precache manifest injection, the
`navigateFallback` behaviour and the `navigateFallbackDenylist` for `/api/`, all
of which are currently free and would become ours to maintain.

Not hard. But it is a config line that quietly transfers a file's worth of
Workbox behaviour onto us, and it is invisible in a diff that looks like "add
push".

It also interacts with `registerType: 'prompt'`. The comment in `vite.config.js`
is explicit that a worker must not swap itself mid-session because the app holds
a queue — so the new worker needs to keep that property, and a push arriving for
a worker version the user has not accepted yet is a case to think about once.

---

## Testing it, without an official push service

Answerable, which was the original question.

**That the server sends correctly.** A subscription's `endpoint` is just a URL.
Point it at a local mock and `pywebpush` performs VAPID signing and payload
encryption against that exactly as it would against Apple — so the mock can
assert the headers, decrypt the body, and return `410` on demand to exercise the
cleanup path. No external dependency, runs in the normal pytest suite.

**That the browser handles it correctly.** `[verify]` Chrome DevTools Protocol
exposes `ServiceWorker.deliverPushMessage`, and Playwright can open a CDP session
against a Chromium context — so the `push` handler, the notification and the
click-through are testable in the existing e2e suite without any push service at
all.

**That the scheduler fires.** Ordinary backend tests with an injected clock; the
interesting cases are the restart-mid-send double-fire and the stale window, both
of which are unit-testable and neither of which needs a browser.

**iOS Safari is not covered by any of that.** No CDP, no emulator worth trusting.
That is a real device, by hand, once — and it is the platform the whole feature
exists for, which is worth being blunt about: the automated tests will tell you
the machinery is correct, not that the notification arrived.

---

## What I would build, in order

| | |
| --- | --- |
| **1** | The subscription lifecycle alone: `injectManifest`, permission from a gesture, subscribe, upsert, delete. No sending. Verifiable end-to-end and useful to have settled on its own |
| **2** | Sending, against the local mock, with the `410` path covered |
| **3** | The scheduler, with the claim and the staleness rule |
| **4** | The real device, by hand |

If step 4 disappoints, step 1's late notification is still there and nothing has
to be unwound — which is the property worth designing for, given that this is a
capability Apple has already tried to take away once.

---

## Open questions, collected

1. **How late is too late to still send** a notification whose moment passed
   while the server was down?
2. **Scheduler in the web process or its own?** I lean the same process, one
   worker, guarded by a claim.
3. **Which `mailto:` address** for the VAPID subject.
4. **Where does rotation get written down?** VAPID rotation drops every
   subscription, and the other two secrets have their consequences documented.
5. **Does a push arriving for an unaccepted worker version need handling,** given
   `registerType: 'prompt'` exists precisely so workers do not swap mid-session?

And the one to check on the phone before any of it: **is the app installed to the
Home Screen?** Push does not exist in a Safari tab, so that install is the
feature's precondition, not a nicety.
