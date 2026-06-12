# PLANEY ✈️🩴🔪

A first-person multiplayer social deduction game set on a packed passenger jet.
Everyone on board is wearing sandals. One player — **the Evil** — has a knife
hidden in theirs, and wants to reach the cockpit. Everyone else has to figure
out who it is before that happens.

## Run it

```bash
npm install
npm start
# open http://localhost:3000 in several browser tabs / machines
```

The first player to board is the host and presses **Take off**. One player is
secretly assigned the Evil role each round.

## How a round works

- The plane has 18 rows of seats full of NPC passengers, plus two flight
  attendants (Brenda and Doug) pushing drink carts up and down the aisle,
  offering peanuts and Coke. Players start seated in their assigned seats.
- The **Evil** must walk the full length of the aisle, stand at the cockpit
  door and **hold E for ~9 seconds** to pick the lock, then step inside and
  press **Q** to pull the knife from their sandal. That's the Evil win.
- The **crew** wins by finding the knife: walk up to a *standing* player and
  press **F** to inspect their sandals (takes 2.5s, you can't move). If you
  find the knife, crew wins instantly.
- If the 8-minute flight timer runs out, the plane lands and the **crew wins**.

## Why it's hard to be the Evil

| Pressure on the Evil | Mechanic |
|---|---|
| The walk is exposed | The cockpit is at the far end of a single aisle — anyone looking forward sees who's loitering at the door |
| The lock is slow & loud | 9 seconds of picking, the door handle visibly rattles and thuds every second, and progress decays if you stop |
| Hurrying is risky | Sprinting randomly makes the hidden knife *clink* — everyone is told which row the sound came from |
| Innocents can clear themselves | Press **G** to voluntarily show clean sandals (the Evil can never do this — it reveals the knife and loses instantly) |
| Refusal is a tell | Pulling your feet away from an inspection cancels it and is announced to everyone |
| Carts block the aisle | The attendants' drink carts physically block the aisle, forcing awkward waits in plain view |
| The clock | The Evil *must* act before landing; pure hiding loses |

## Why it's still fair for the Evil

- Inspections cost: each player gets **one** inspection, and a wrong guess
  stuns you for 8 seconds while you apologize, broadcast to the whole cabin.
- Seated players can't be inspected — feet tucked under the seat — so the
  Evil can sit and blend in between moves.
- Lockpick progress only partially decays, so the Evil can chip away at the
  lock across several casual "trips to the bathroom".
- Everyone looks the same: sandals on every passenger, NPC decoys everywhere.

## Controls

| Key | Action |
|---|---|
| WASD + mouse | Move / look (click to lock pointer) |
| Shift | Hurry (risky if you have a knife in your sandal) |
| E | Sit / stand · hold at cockpit door to try the lock |
| F | Inspect nearest standing player's sandals |
| G | Show everyone your sandals |
| Q | Pull the knife (cockpit only, Evil only) |
| Enter | Cabin chat — accuse, deflect, lie |

## Stack

Node.js + Express + Socket.IO server (`server/index.js`) with an
authoritative game loop; Three.js first-person client (`public/game.js`).
No build step.
