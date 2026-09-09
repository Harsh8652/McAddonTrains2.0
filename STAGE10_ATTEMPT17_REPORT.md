# STAGE 10 — ATTEMPT17 (audit fix-forward) — DELIVERED

**Package:** `TRAINS_Phase1_Stage10_ATTEMPT17.mcaddon`
**SHA256:** `dfe88f5f1ac791318048d4fa87ff3140c4a03a0166d9ca54a20b93726669df03`
**Size:** 7,445,671 bytes · **ZIP entries:** 3,144 (integrity OK) · **main.js:** 869,382 bytes / 18,336 lines (`node --check` OK)
**Manifests:** both packs bumped to `[1,1,8]` (header + cross-dependency) for clean in-world upgrade
**Base:** byte-verified Stage10 ATTEMPT15 (= Stage9 ATTEMPT5 c8cb356b + one additive traffic hunk)
**Tests:** **109/109 PASS** (three independent runs, identical result) — `node dev/stage10_attempt17_tests.mjs`

This is a **fix-only** follow-up to the audit-rejected ATTEMPT16. No architecture rebuild. Only the two
audit-flagged issues were reworked; every other mechanism is byte-preserved from ATTEMPT15/16.

---

## 1) Fixed — Occupancy safety (audit issue 1)

**Rejected behavior:** `getOccupant()` returned `null` for sections absent from *loaded* occupancy shards,
so ATTEMPT16's release helper could treat UNKNOWN/UNLOADED occupancy as free and release a possibly-occupied
section.

**New authoritative release contract** (packaged `safelyReleaseTrafficReservation`, block line-verified):
- known occupied by this train ⇒ **NEVER release** (occupiedSet fast-path)
- occupancy **unknown / unloaded / probe throws** ⇒ **NEVER release**, tracking retained for retry
- `releaseSection(...)` is called **ONLY** when `occupancyManager.getOccupancyState(sectionId, world)`
  returns an authoritative **`KNOWN_EMPTY`** record read from that section's own occupancy shard
- "absent from loaded shards" is **never** treated as "free" — `getOccupancyState` resolves to a record or
  returns `null`, and `null` never authorizes a release
- tracking-reconciliation (drop tracking WITHOUT any world mutation) still happens only on **authoritative**
  facts: foreign owner or already-free per `reservationManager.getOwner` — never inferred from absence
- occupancy state itself is never mutated by the traffic layer (Stage5 semantics not weakened)

**Authoritative stale-held contract** (`canEnterRouteSection`, via `getOccupancyState` only):
a self-held reservation on a section whose occupancy is `UNKNOWN`/`CONFLICT` now returns
`{ok:true, canEnter:false, owner:<trainId>, state:'held', stale:true, releaseWhenPossible:true,
reason:'stale_ahead_holding_pending_release'}` — a deterministic safe-fail "stale-ahead holding" signal.
Retention/release of that reservation remains purely reservation-managed; the contract evaluator performs
no release and no occupancy write (auto-sync of reservations from occupancy is still never done).
Unreserved trains still get the generic conservative `unknown_or_conflict_safely_blocked`;
`KNOWN_OCCUPIED`-by-other still blocks with `OCCUPIED_BY_OTHER`; own occupancy still passes.

## 2) Fixed — Lookup performance (audit issue 2)

**Rejected behavior:** `getOccupant()` iterated **all loaded occupancy shards** on every call
(per-candidate, per-tick in arbitration) — quadratic in loaded shard count.

**Fix:** `occupancyManager.getOccupant(sectionId, world)` now resolves the **single** authoritative
occupancy shard directly:

1. `sectionLocationIndexManager.getLocation(sectionId, world)` (Stage8 hash-sharded index, bounded) →
   `{ dimId, rootPos }` — or a bounded fallback via the Section's own `rootPos`
2. shard key = `getShardKey(dimId, rootPos)` — the **same rootPos-derived key** used by
   `setOccupied/setEmpty/setUnknown`, so reads land exactly where writes landed
3. one `shards.get(key).records.get(sectionId)` — no iteration, no materialization, no shard
   auto-create/load on the read path

The same resolver backs the new `getOccupancyState`, and `canEnterRouteSection`'s occupancy check no
longer touches `occupancyManager.shards` at all.

**Runtime proof (M176):** with the occupancy shard map wrapped in an iteration-counting Proxy plus
32 decoy shards, `getOccupant` + `canEnterRouteSection` + one full coordinator pass caused **0**
map iterator/values/entries/forEach touches, while still releasing the KNOWN_EMPTY section, retaining the
UNKNOWN one, returning the direct occupant, and emitting the stale-held contract.

## Preserved unchanged (verified)

- Stage9 ATTEMPT5 base, Stage7/8/9 managers/singletons (exactly one class+instance each)
- ATTEMPT16 traffic architecture: atomic `reserveSections`, safe release helper, release-behind,
  destination completion, bounded retry queue (≤2/pass), persistence with save cursor + DP cleanup,
  5-section horizon, ≤8 traffic mutations/tick (reserve+release counted together, M166/M166b re-verified
  `[8,8,8,8,8,0]`, 20/20 completion, 0 leaks), bounded claims (≤100×8),
  deterministic `(effectivePriority, trainId)` arbitration, no `Date.now`/`Math.random` in decision paths,
  no movement rewrite, no GUI, no Stage11
- Package diff vs ATTEMPT15 and vs ATTEMPT16: **only** `main.js` + the two `manifest.json` files;
  3,141 of 3,144 entries byte-identical

## Edit map (each anchor asserted to match exactly once in the ATTEMPT15 source)

| Edit | Location | Content |
|---|---|---|
| E1 | `ReservationManager` | read-only `getOwner(sectionId)` (identical to ATTEMPT16) |
| E2′ | `OccupancyManager` | `_resolveOccupancyRecord` (direct Stage8-index → rootPos key), `getOccupancyState`, rewritten `getOccupant` |
| E3′ | `NavigationManager.canEnterRouteSection` | occupancy read via `getOccupancyState` only; stale-held contract for self-held UNKNOWN/CONFLICT; KNOWN_OCCUPIED-by-other still blocks |
| E4 | `removeSectionsForBoundary` wrapper | `invalidateTrafficForSectionId` hook (identical to ATTEMPT16) |
| E5 | `OccupancyManager.handleTrainDisappearance` | `invalidateTrafficForTrainId` hook (identical to ATTEMPT16) |
| E6 | traffic block | strict KNOWN_EMPTY-only release gate; eval-time `loadTrafficOnWorldLoad` removed |
| E7 | real `worldLoaded` handler (events/world.ts) | `loadTrafficOnWorldLoad(world19)` at world load (authoritative restart read) |

## Tests (`dev/stage10_attempt17_tests.mjs`)

- **M150–M171** — full ATTEMPT16 regression suite reseated on the new contract (release-expecting setups
  seed authoritative `KNOWN_EMPTY` where a release is expected, mirroring real Stage5 behavior — absence
  of an occupancy record no longer authorizes releases). Runs against the **real packaged code** extracted
  verbatim; mocks only `@minecraft/server` world/system.
- **M172** unloaded/unresolvable occupancy is never treated as free (helper retains, 0 releases)
- **M173** occupancy probe exception ⇒ never released; releases after probe recovery
- **M174** KNOWN_OCCUPIED (self) never released even without an occupiedSet hint (gate itself blocks)
- **M175** authoritative KNOWN_EMPTY + self owner ⇒ released exactly once
- **M176** static (no shard iteration/materialization/auto-create in resolver, `getOccupancyState`,
  `getOccupant`, helper, or `canEnterRouteSection`) + runtime Proxy proof (0 iteration touches)
- **M177** retry works after unknown occupancy later becomes authoritatively KNOWN_EMPTY
- **M178** destination completion never releases occupied sections
- **M179** Stage7/8/9 manager defs + ATTEMPT17 APIs present on the real singletons
- **M180** ZIP integrity, entry count, `node --check`, manifests `[1,1,8]`, no ATTEMPT15 residue, SHA/size

`109 passed, 0 failed` (verified in three separate runs).

## STOP boundary

Stage10 is **not approved**. ATTEMPT17 is a fix-forward candidate for re-audit only.
No Stage11 work has begun.
