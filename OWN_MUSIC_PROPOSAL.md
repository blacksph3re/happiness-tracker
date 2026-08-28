# Your own music as a focus sound

*First draft. Nothing built. `[assumed: X]` marks a silent default made visible;
answer them inline and I will fold them in and re-issue this before writing
code.*

**The feature is easy. Two things about it are not, and neither is the upload.**
One is that music cannot go through the code path the existing sounds use — it
would allocate the better part of a gigabyte. The other is deciding whether the
bytes ever leave the device, which is a question about backups and phones rather
than about audio.

| | |
| --- | --- |
| Feasible | Yes, and with no new dependency on either side |
| Plays through | An `<audio>` element — **not** `AudioBuffer`, see §1 |
| Where the bytes live | Three options, §2. I recommend the browser |
| Transcoding | **No.** Whatever the browser decodes, and a clear refusal otherwise |
| Works offline | Yes, and for free if the bytes never leave the device |

---

## 1. Music cannot use the path the noise uses, and the reason is arithmetic

`playAmbience` generates twelve seconds of mono noise, hands it to
`decodeAudioData`'s cousin `createBuffer`, and loops it. That works because
twelve seconds of one channel is about two megabytes of `Float32Array`.

An `AudioBuffer` holds **raw PCM**, not the compressed file. At 48 kHz, stereo,
four bytes a sample:

```
48 000 × 2 × 4 = 384 KB per second  ≈  23 MB per minute
```

| | file on disk | decoded in memory |
| --- | --- | --- |
| A 5-minute track | ~5 MB | **~115 MB** |
| A 40-minute album | ~40 MB | **~920 MB** |

`decodeAudioData` decodes the whole thing before the first sample plays. On a
phone that is a tab the browser kills, and on a laptop it is a visible stall at
the exact moment the person pressed Start.

So music plays through an **`<audio>` element**, which streams and decodes
incrementally, routed through a `MediaElementAudioSourceNode` if it needs to
share a gain node with anything else. That is a genuinely different mechanism
from `playAmbience`, not a fourth entry in `AMBIENCES`, and pretending otherwise
would put a landmine behind a dropdown.

The synthesised sounds stay exactly as they are. Nothing in `sounds.js` changes.

---

## 2. Where the bytes live

Three real options. They differ in what breaks, not in how hard they are.

### (a) The browser, and nowhere else — *recommended*

`ImportSessions.svelte` already sets the precedent: it opens a file picker,
reads the file with `.text()`, and **never uploads anything**. Music would do
the same with `.arrayBuffer()` and a new IndexedDB store beside `snapshot`,
`outbox`, `meta` and `verdicts` in `lib/local.js`.

What it buys, all of it for free:

- **Offline is not a feature, it is the default.** The file is already here.
- The server gains nothing to store, serve, cap, or scan.
- Nothing lands in `happiness-dump`, which copies a database holding password
  hashes and encrypted TOTP secrets. A nightly rotation carrying somebody's
  record collection is a bad trade twice over.
- No `client_max_body_size` on nginx, no upload progress UI, no resumption, no
  40 MB pushed over a phone connection.

What it costs: **the music is per-device.** Choose a track on the laptop and the
phone does not have it. And IndexedDB is evictable — `askToPersist()` is already
called in `local.js`, and this would be the first time it had a real reason to
be.

### (b) The server, as a database BLOB

Ownership comes free — the row belongs to somebody like every other row, and
another account's track answers 404 without anyone writing a check. And the
dump covers it automatically.

That last one is also why not: every nightly dump would carry every megabyte of
audio, rotated, forever.

### (c) The server, on the `/data` volume

`Dockerfile` already declares `VOLUME /data` and puts the database in it, so
files in `/data/music/` survive a redeploy, and serving them is cheap.

**And they would silently escape `happiness-dump`,** which copies the database.
A backup that looks complete and is not is worse than one that is obviously
partial. If we go this way, the dump has to change in the same commit — not the
next one.

> `[assumed: (a), the browser only.]` If the music must follow you between
> devices, say so and it becomes (c) plus a change to the dump plus an nginx
> body-size bump plus an upload UI — perhaps a fortnight rather than a couple of
> days. That is a real want, not an unreasonable one; it is just a different
> feature.

---

## 3. A second account on the same browser must not hear the first one's music

`hydrate()` already compares the snapshot's owner against the token holder and,
when they differ, clears the snapshot **and** purges the push subscription —
because a push endpoint belongs to a *browser*, so a second account on one phone
would otherwise get the first account's notifications.

An uploaded track is exactly the same class of thing and the same trap. It has
to be cleared by the same code, at the same moment, before any loader runs — and
it needs its own test, because the existing one asserts about projects and would
pass with a music store leaking beside it.

This is the part I would build first and most carefully. Everything else in this
document is a convenience; this one is somebody else's music playing on a device
they handed back.

---

## 4. The bug this would ship with, if built carelessly

The focus sound pulsed last week because an `$effect` read `bar?.phase`, and
`bar` is a fresh object each tick — six noise buffers in five seconds.

With an `<audio>` element the same mistake restarts the **track** every second:
the first second of a song, over and over, which is the same defect and a great
deal more annoying. So playback hangs off a value that holds still, exactly as
`wantedAmbience` does now, and the test **counts `play()` calls** rather than
watching the screen. `e2e/ambience.spec.js` is already the shape to copy.

---

## 5. Shape

**Store** — a new IndexedDB object store, `tracks`, keyed by a generated id:

```
{ id, name, type, bytes: Blob, addedAt }
```

A `Blob`, not an `ArrayBuffer`: it is what `URL.createObjectURL` wants and what
the browser can keep out of memory until asked.

**Preferences** — `focus.ambience` is a string today, so an uploaded track is
`file:<id>`. Anything not matching a synthesised id is looked up in `tracks`.

**A missing track says so.** Cleared storage, a different device, an eviction:
the app never invents data, so the card reports that the chosen track is not on
this device and falls back to silence. It does not quietly play brown noise
instead.

**Formats** — no transcoding. There is no ffmpeg in a distroless image and
adding one to play a file the browser can already decode is the wrong trade.
`canPlayType` at pick time, and a plain refusal naming the format for anything
else. In practice MP3, AAC/M4A, OGG, WAV and FLAC are all fine everywhere that
matters.

**Where the code goes** — Focus zone: `lib/pomodoro/tracks.js` for the store and
`lib/pomodoro/player.js` for the element. The picker belongs beside the existing
focus settings, which live in `Settings.svelte` — a shared route that already
imports `AMBIENCES` and `playChime` from `lib/pomodoro/`. Worth naming rather
than quietly extending, but it is the established position.

---

## 6. Tests I intend

**Unit**

- the id scheme: `file:<id>` resolves to a track, a synthesised id does not go
  near the store
- a chosen track that is not in the store resolves to silence *and* a reason,
  never to a different sound
- a rejected format is named in the refusal

**e2e** — a tiny generated WAV is enough, and it can be built in the test rather
than committed as a fixture

- a picked file appears in the list and survives a reload
- selecting it and starting a pomodoro calls `play()` **exactly once**, and
  still exactly once several ticks of the clock later
- the focus boundary pauses it exactly once, and the next block resumes it
- with the network offline throughout: the whole of the above still works, which
  is the point of keeping the bytes here
- **signing in as somebody else leaves no track behind** — held requests, as
  `local-store.spec.js` does, so nothing can paint over the leak
- deleting a track that is currently selected falls back to silence and says so

---

## 7. Open questions

1. `[assumed: the browser only — per-device music, no upload.]` The one that
   changes the size of this most.
2. `[assumed: one track, looped.]` A playlist, shuffle, or a queue is a
   different and much larger feature. Looping a three-minute track for
   twenty-five minutes is repetitive by construction — is that actually what you
   want, or is "play it once and then silence" closer?
3. `[assumed: a volume slider, no normalisation.]` The synthesised sounds are
   deliberately RMS-matched to each other; a file is whatever loudness it is.
   Measuring it properly means decoding the whole thing, which is §1 again.
4. `[assumed: the break pauses the music, as it stops the noise.]` Same question
   the Spotify draft raised and you did not get to answer: the sound stops for
   the break because concentrating is what it belongs to. Music may be the
   opposite.
5. **A size cap, and where it is enforced.** `[assumed: 50 MB a file.]` In the
   browser there is no hard need for one, but a person dropping a 700 MB WAV in
   should be told, not left watching a spinner.
6. Should a track be usable as the **chime** as well? The machinery is the same
   and the answer is probably no — a chime is a fifth of a second and a file is
   a different kind of thing — but it is cheap to allow and awkward to add later.
