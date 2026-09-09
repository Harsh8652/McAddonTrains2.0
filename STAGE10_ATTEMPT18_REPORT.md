# STAGE 10 — ATTEMPT18 (second audit fix-forward) — DELIVERED

**Package:** `TRAINS_Phase1_Stage10_ATTEMPT18.mcaddon`
**SHA256:** `691732e9d9e646ef8fb821d03b2d7abb346768faab8b59c6fe176ba5fb66914b`
**Size:** 7,446,204 bytes · **ZIP entries:** 3,144 (integrity OK) · **main.js:** 871,479 bytes / 18,353 lines (`node --check` OK)
**Manifests:** both packs `[1,1,9]` — header **and** cross-dependency versions (BP→RP `[1,1,9]`, RP→BP `[1,1,9]`, UUIDs unchanged; verified from the binary)
**Base:** byte-verified Stage10 ATTEMPT15 (= Stage9 ATTEMPT5 c8cb356b + one additive traffic hunk)
**Tests:** **146/146 PASS** (three independent runs) — `node dev/stage10_attempt18_tests.mjs`, run against the **actual packaged** `.mcaddon` (stack extracted verbatim from the ZIP; mocks only `@minecraft/server` world/system)

Fix-only follow-up to the second independent audit rejection of ATTEMPT17. No Stage7/8/9 rebuild, no
TrafficManager rewrite. Both blockers addressed; all ATTEMPT16/17 mechanics preserved.

---

## 1) Fixed — occupancy resolver has ZERO shard iteration

**Rejected:** `_resolveOccupancyRecord` still fell back to `for (const [sk, sShard] of sectionManager.shards)`
when the SectionLocationIndex lookup failed.

**Fix (verified in the packaged binary):** the fallback loop and every reference to `sectionManager` were
removed from the resolver. It now resolves **only**:
`SectionLocationIndex.getLocation(sectionId, world)` → `{ dimId, rootPos }` → the exact rootPos-derived
occupancy shard key (`getShardKey(dimId, rootPos)` — identical to the key used by `setOccupied/setEmpty/
setUnknown`) → a single `shards.get(key).records.get(sectionId)`. If the location cannot be resolved it
returns `null` (safe-fail). No `for`-loop exists anywhere in `_resolveOccupancyRecord`,
`getOccupancyState`, or `getOccupant`.

**Proofs:** M181 (index forced to throw: **0** `sectionManager.shards` iteration touches, results `null`),
M182 (index returns null: **0** iteration touches across both occupancy- and section-shard maps with
32 decoy shards armed; healthy index then resolves the occupant directly).

## 2) Fixed — owner null is NOT automatically "authoritative free"

**Rejected:** `getOwner` reads only in-memory `knownSectionToTrain`; a `null` could hide a live persisted
reservation, and the helper dropped `rec.reservedSections` tracking on it ("forgetting").

**New read-only Stage7 API** `reservationManager.getOwnershipState(sectionId, world)`:
- `{state:'OWNED', owner}` — a reservation record resolves (in-memory owner index, or the record in the
  resolved shard),
- `{state:'FREE'}` — only when the **exact deterministic reservation shard answered authoritatively**
  with no record for this section,
- `{state:'UNKNOWN'}` — shard unloaded / unresolvable / probe failure / never persisted / no world.

Resolution path: `getShardIndicesForSectionId` (existing fnv1a/djb2 double-hash, 16×4) → in-memory
`shards.get(primary_sub)` hit, **else** direct `ReservationShard.tryLoad(world, primary, sub)` of that single
persisted shard. **No shard-Map iteration, no shard creation, no caching, no mutation of reservation
state** (M184 asserts the DP set and cache are untouched by the call). A null/absent owner from the
in-memory map alone is never interpreted as FREE anywhere.

**`safelyReleaseTrafficReservation` decision matrix (per tracked section, exactly as specified):**
| Ownership | Occupancy | Action |
|---|---|---|
| occupiedSet hit (self-occupied) | – | NEVER release |
| OWNED by another train | – | remove our stale tracking **only** (no release call, no world mutation) |
| FREE (authoritative) | – | remove our stale tracking **only** |
| OWNED by this train | KNOWN_EMPTY (authoritative) | exactly one `releaseSection`; success ⇒ drop tracking, failure ⇒ retain |
| OWNED by this train | occupied / UNKNOWN / CONFLICT / unknown | NEVER release; retain |
| **UNKNOWN** | any | NEVER release and **never forget** — tracking retained for retry |

Raw `getOwner` remains available read-only (M155) but is no longer consulted by the release helper.

## Preserved unchanged (re-verified by suite)

Stage5/6/7/8/9 code and semantics · ATTEMPT16/17 traffic mechanics (atomic `reserveSections`,
release-behind, destination completion, bounded retry queue ≤2/pass, persistence + rotating save cursor
+ DP cleanup, horizon 5, ≤8 mutations/tick incl. reserve+release clamp `[8,8,8,8,8,0]` with 20/20 completion
and 0 leaks, deterministic `(effectivePriority, trainId)` arbitration, bounded pendingClaims 100×8, no
`Date.now`/`Math.random` in decision paths, no GUI, no Stage11) · ATTEMPT17 occupancy safety contract
(KNOWN_EMPTY-only release; absent-from-loaded-shards never free) · direct occupancy shard resolution ·
stale-held `canEnterRouteSection` contract · world-load traffic wiring. Package diff vs ATTEMPT15 and vs
ATTEMPT17: only `main.js` + both `manifest.json`; 3,141 of 3,144 entries byte-identical.

## Edit map (single-match anchored, ATTEMPT15 source)

E1 `ReservationManager.getOwner` · **E8 `ReservationManager.getOwnershipState` (new)** ·
E2″ `OccupancyManager` `_resolveOccupancyRecord` (index-only) / `getOccupancyState` / `getOccupant` ·
E3′ `canEnterRouteSection` stale-held contract (unchanged from ATTEMPT17) · E4 section-removal hook ·
E5 disappearance hook · E6 ATTEMPT18 traffic block (tri-state gate) · E7 world-load traffic wiring ·
manifests → `[1,1,9]`.

## Tests — 146/146 PASS (M150–M180 regression + M181–M192)

- **M181** index failure ⇒ 0 `sectionManager.shards` iterations, null (static + runtime proxy)
- **M182** zero occupancy/section shard-map iteration even when index lookup fails (dual proxies, 32 decoys)
- **M183** UNKNOWN distinct from FREE (unloaded/never-persisted ⇒ UNKNOWN; resolved-empty ⇒ FREE; OWNED; no-world ⇒ UNKNOWN)
- **M184** persisted/unloaded reservation with `getOwner` null ⇒ **retained, not forgotten**; read API mutated nothing
- **M185** UNKNOWN ownership + occupied/unknown occupancy ⇒ zero releases
- **M186** authoritative FREE ⇒ stale tracking reconciled, no release call
- **M187** authoritative foreign owner ⇒ stale tracking reconciled, reservation untouched
- **M188** OWNED-self + KNOWN_EMPTY ⇒ exactly one release, shard now FREE
- **M189** release failure ⇒ tracking retained; releases cleanly after recovery
- **M190** active reservation never untracked under ambiguous owner-null (live shard record rescues `getOwner` gap)
- **M191** Stage7/8/9 cumulative defs + singletons + ATTEMPT18 APIs live on packaged singletons
- **M192** ZIP integrity, 3,144 entries, `node --check`, package name, header versions `[1,1,9]`,
  **cross-pack dependency versions both `[1,1,9]`**, UUIDs unchanged, no residual earlier-attempt blocks, SHA/size

`RESULT: 146 passed, 0 failed` (three separate runs, identical).

## STOP boundary

Stage10 is **not approved**. ATTEMPT18 is a fix-forward candidate for re-audit only.
No Stage11 work has begun.
