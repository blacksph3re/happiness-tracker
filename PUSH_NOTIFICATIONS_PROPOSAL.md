# Push notifications — step 2 of pomodoro tracking

*Third draft, and now a record rather than a plan: **phases one to three are
built.** What follows is why, kept because the reasoning is not obvious from the
code. `[verify]` marks something I could not prove on this machine.*

**What exists**

| | |
| --- | --- |
| Subscription lifecycle | Built. Enrol, re-enrol on launch, forget — and purge on sign-out or an account switch |
| Sending | Built. `pywebpush`, VAPID signing, `410`/`404` pruning, tested against a local push service |
| The scheduler | Built, and **smaller than this document proposed** — see below |
| The real device | **Not done.** The one thing no test here can stand in for |

**The scheduler is not what §1 describes.** That section calls for a
`scheduled_pushes` table and a task polling it, which is the right shape when
the thing being announced is arbitrary. It is not: a pomodoro already records
when it started and how long its focus runs, so *when to send* is derivable and
only *whether it was sent* has to be written down. That is
`pomodoros.notified_at` — one nullable column, which doubles as the claim.
The section is left as written because the reasoning about background execution
still holds; only the storage turned out to be unnecessary.

**Settled so far**

| | |
| --- | --- |
| Grace period | **One minute.** A notification whose moment passed more than that ago is dropped rather than sent |
| Scheduler | **In the web process**, one worker, guarded by a claim |
| VAPID subject | A `mailto:`, **from an environment variable** — which also keeps it out of the repository, as the domain is |

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

**One minute of grace.** A phase boundary that passed more than sixty seconds
ago is dropped, not sent: the app's own late-on-wake notice covers that case
already and says the honest thing, while a push arriving ten minutes late says
"your pomodoro is over" about something you finished, made tea after, and
started another one since.

**In the web process**, one worker, with the claim doing the work. A few lines
in the lifespan, sharing the connection pool, matching how small this deployment
actually is. The claim is what keeps the multi-worker case merely wasteful
rather than wrong, so the decision is reversible if the deployment ever grows.

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

Rotating VAPID keys **invalidates every existing subscription** — every device
has to be re-enrolled, silently, because nothing tells them. Like `JWT_SECRET`
rotation signing everyone out, that consequence has to be written down before
somebody rotates and finds out.

**Where** was my question and it was a poor one, because it reads as a storage
question and it is not. The key lives in the environment beside the other two,
never in the database: a secret in the database is one a database backup
carries, and `happiness-dump` already holds password hashes and encrypted TOTP
secrets without also holding the keys that unlock them.

What I am proposing is a **line in `CLAUDE.md`'s Secrets row**, which is where
the other two rotations are described and the only place anyone looks before
touching one. The table there would gain a third entry saying that rotating
VAPID re-enrols every device.

The sharp edge: a VAPID claim set needs a `sub` that is **either a `mailto:`
address or a full HTTPS URL** ([py-vapid](https://pypi.org/project/py-vapid/)) —
and the HTTPS URL would be the deployment's domain, which **must never be in the
repository**. The `mailto:` form sidesteps that rule instead of adding a second
thing to keep out of git, and it comes from an environment variable, so the
address is not in the repository either. It is contact information for the push
service, not an identifier, so any mailbox does.

### 4. A service worker we have to own, and one that may be a release old

Currently `vite-plugin-pwa` runs in its default `generateSW` mode: there is no
service worker file in this repo, Workbox writes it. **A `push` handler cannot be
added to a generated worker.** That means switching to `strategies:
'injectManifest'` and owning `src/sw.js` — precache manifest injection, the
`navigateFallback` behaviour and the `navigateFallbackDenylist` for `/api/`, all
of which are currently free and would become ours to maintain.

Not hard. But it is a config line that quietly transfers a file's worth of
Workbox behaviour onto us, and it is invisible in a diff that looks like "add
push".

**And it interacts with `registerType: 'prompt'` in a way that is easy to miss.**
This was question 5, and it deserves the explanation rather than the question.

The app prompts rather than updating itself, because a worker that swapped
mid-session would reload a page holding answers that have not reached the
server. So after a deploy the new worker downloads, then **waits**, while the old
one keeps serving — until somebody presses *Reload to update*, which on a phone
they may not do for days.

A push is delivered to whichever worker is **active**. That is the old one. So:

- **The handler that receives a push can be any release still installed
  anywhere**, not the one that was deployed with the sender. The server is new;
  the code reading its payload is old.
- If a later release changes the payload's shape, the old handler does not
  understand it — and `userVisibleOnly` means the browser will not let it stay
  silent. It substitutes its own generic *"This site has been updated in the
  background"*, which is worse than nothing: it is a notification the app did
  not write, about something that did not happen.
- If the click-through URL changes, the old handler opens the old route.

None of that needs machinery, but it does need a rule, and the rule is cheap if
it is adopted before the first payload rather than after the third:

> **The push payload is append-only.** Title, body and a path. New fields may be
> added and old ones must keep working; nothing is renamed or removed. The
> handler ignores what it does not recognise, and falls back to a generic title
> of *its own* rather than letting the browser invent one.

Worth stating in the same breath: a notification's click can be the thing that
finally applies the update, since the tab it opens is a fresh load. That is a
nice property to have and a poor one to rely on.

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

## What is left

Nothing is open. Two things want a yes rather than an answer:

1. **The rotation note goes in `CLAUDE.md`'s Secrets row** — a third entry
   saying that rotating VAPID re-enrols every device, beside the two that
   already say what they cost. The key itself stays in the environment; the
   database never holds it. -- fine for me.
2. **The push payload is append-only**, per the rule above, because the handler
   receiving a push may be a release behind the server that sent it. -- sounds reasonable, though a breaking change is also fine as I currently personally know the entire userbase.

And the one thing to check on the phone before any of this is built: **is the
app installed to the Home Screen?** Push does not exist in a Safari tab, so that
install is the feature's precondition, not a nicety — and it is a five-second
check that decides whether the rest is worth writing. -- yes it is on the home screen.
