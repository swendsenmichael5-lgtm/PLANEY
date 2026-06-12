# PLANEY ✈️🩴🔪

A first-person, **pixelated**, multiplayer social deduction game set on a packed
passenger jet. Everyone on board is wearing sandals. One player — **the Evil** —
has a knife hidden in theirs, and wants to reach the cockpit. Everyone else has
to figure out who it is before that happens.

**No install, no server.** The game is a static page with peer-to-peer WebRTC
multiplayer (Trystero): one player creates a flight, gets a 4-letter code and a
share link, and friends join straight from their browsers. The flight creator's
browser acts as the game authority.

▶ **Play now (no download):**
https://rawcdn.githack.com/swendsenmichael5-lgtm/PLANEY/674dc262773b6b0d2bf9aebca30b3eb8c70455ca/public/index.html

(That link pins to a specific commit — after pushing changes, regenerate it by
swapping in the new commit SHA. Alternative mirror:
`https://cdn.statically.io/gh/swendsenmichael5-lgtm/PLANEY/<SHA>/public/index.html`.)
You can also serve `public/` from any static host, or locally:
`npm install && npm start` → http://localhost:3000

## How a round works

- A wide-body twin-aisle jet (3-4-3, 22 rows) with open cross-walkways and
  galleys, full of NPC passengers — some of whom randomly get up, stretch
  their legs, and sit back down, so anyone walking the aisle looks ordinary.
  Four flight attendants push drink carts along both aisles offering peanuts
  and Coke. Generated cabin ambience plays throughout: pressurized hum,
  murmured conversations, ice clinking in cups, seatbelt chimes.
- The **Evil** must reach the cockpit door, **hold E / A for ~9s** to pick the
  lock, step inside, and press **Q / RB** to pull the knife. Evil wins.
- The **crew** wins by finding the knife: inspect a standing player's sandals
  (**F / X**, takes 2.5s) — or by surviving until the plane lands (8 min).

## The restraint mechanic

- Press **R / B** next to a standing player to tackle them and zip-tie them
  with seatbelt extenders. They're pinned to the floor for **15 seconds** —
  and restrained players **can't pull their feet away**, so they can be
  inspected at leisure. Restrain + inspect is the crew's power play.
- After any restrain attempt you have a **30-second cooldown**.
- **Every tackle causes a cabin-wide COMMOTION (12s):** if you grabbed the
  wrong person, the Evil's window is open — the lock picks **2.5× faster**
  and the door rattle and knife clinks are drowned out by the shouting.
  Tackle carelessly and you may hand the Evil the cockpit.

## Why it's hard to be the Evil

| Pressure | Mechanic |
|---|---|
| The walk is exposed | One long aisle, cockpit at the far end — everyone sees who loiters at the door |
| The lock is slow & loud | ~9s of picking, the handle rattles for the whole cabin, progress decays when you stop |
| Hurrying is risky | Sprinting can make the hidden knife *clink*, announced by row |
| Innocents can clear themselves | **G / Y** shows clean sandals — the Evil showing theirs loses instantly |
| Refusal is a tell | Pulling feet away from an inspection is broadcast to everyone |
| Restraints | Get tackled near the door and you're a sitting duck for an inspection |
| Carts block the aisles | The attendants and their carts are solid and jam the aisles |
| The clock | Landing = crew win, so pure hiding loses |

…and why it's still fair: one inspection per player (a wrong one stuns you for
8s of public apologizing), seated feet can't be inspected, restrains cost a
cooldown and gift the Evil a commotion, and lockpick progress persists across
casual "trips to the bathroom".

## Controls

| Keyboard / mouse | Xbox controller | Action |
|---|---|---|
| WASD + mouse | Left stick / Right stick | Move / look |
| Shift | LT or click left stick | Hurry (risky with a knife in your sandal) |
| E | A | Sit / stand · hold at cockpit door to pick the lock |
| F | X | Inspect nearest standing player's sandals |
| R | B | Restrain (tackle + zip-tie) |
| G | Y | Show everyone your sandals |
| Q | RB | Pull the knife (cockpit only, Evil only) |
| Enter | — | Cabin chat |
| — | Start | Take off (host, in lobby) |

## Stack

Three.js first-person client rendered at ¼ resolution with nearest-neighbor
upscaling for the pixel look (`public/game.js`), host-authoritative game logic
running in the room creator's browser (`public/logic.js`), Trystero
(nostr-signaled WebRTC) for serverless multiplayer (`public/vendor/`).
All dependencies are vendored — no CDNs, no build step, works from any static file host.
