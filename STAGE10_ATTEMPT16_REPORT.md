# STAGE 10 ATTEMPT16 — BUILD & VERIFICATION REPORT
Date: 2026-09-08 · Worker V2 · Branch `arena/01a08219-mcaddontrains2-0`
**Status: BUILT + ALL 73 TESTS PASS. NOT approved. Stage 10 remains open pending in-game validation. No Stage 11 work begun.**

---

## 1. Package facts (independently computed from the shipped file)

| Property | Value |
|---|---|
| Package | `TRAINS_Phase1_Stage10_ATTEMPT16.mcaddon` |
| **SHA256** | **`0fb89ec4b51588e9e919148b547fea62911cc52b10a66d390e31da18942e6b4a`** |
| **Byte size** | **7,444,334** |
| **ZIP entries / integrity** | **3,144 entries; `unzip -t` → "No errors detected"** |
| **main.js size / lines** | **864,721 bytes / 18,304 lines** (parse-checked: `node --check` OK) |
| Base | Stage10 ATTEMPT15 (= verified Stage9 ATTEMPT5 `c8cb356b` + one additive hunk) |
| Manifests | BP + RP version bumped `[1,1,6]` → `[1,1,7]` (header + cross-dependency), UUIDs unchanged, API deps `@minecraft/server 2.1.0` / `@minecraft/server-ui 2.0.0` unchanged, min engine 1.21.100 |
| File identity | 3,141 of 3,144 entries are **byte-identical** to ATTEMPT15; the only changed entries are `scripts/main.js` and the two `manifest.json` files |

## 2. Exact files & sections changed (vs ATTEMPT15 — complete hunk map, verified by diff set-containment)

Only `TRAINS Urban Update Add-On/scripts/main.js` changed. Six documented edits:

| Edit | Location (final file) | Change |
|---|---|---|
| **E1** | line ~3861 (`ReservationManager`) | +3 lines: read-only `getOwner(sectionId)` — authoritative `knownSectionToTrain` read, no duplicated state, no mutation |
| **E2** | line ~2490 (`OccupancyManager`) | +4 lines: read-only `getOccupant(sectionId)` — returns occupant trainId iff authoritative record is `KNOWN_OCCUPIED`; loaded shards only; no state loading/mutation |
| **E3** | line ~4281 (`NavigationManager.canEnterRouteSection`) | 1→2 lines: blocks `KNOWN_OCCUPIED`-by-other (`OCCUPIED_BY_OTHER` state + owner), own occupancy remains allowed; UNKNOWN/CONFLICT/missing handling unchanged; no reservation mutation from NavigationManager |
| **E4** | line ~5435 (Stage9 `removeSectionsForBoundary` wrapper) | +1 line: guarded `invalidateTrafficForSectionId(id, world)` hook, same pattern as the other five managers |
| **E5** | line ~2750 (`OccupancyManager.handleTrainDisappearance`) | +3 lines: guarded `invalidateTrafficForTrainId(trainId, world)` hook; occupancy semantics untouched |
| **E6** | lines ~5443–5708 | ATTEMPT15 traffic block (105 lines) → ATTEMPT16 traffic block (263 lines) |

Everything else in main.js — **all of Stage 1–9 and the entire base addon (movement physics, coupling, locomotiveProcess & its autonomous suppression wrapper, schedule autopilot, train signals, markers, guide UI, main loop) — is byte-identical to ATTEMPT15/Stage9 ATTEMPT5** (asserted by test M169 with zero collateral lines).

## 3. What was fixed inside the traffic block (E6)

1. **Reservation release (blocker #1):** coordinator now invokes `releaseSectionsBehind` during forward operation and releases on destination/completion (final route section or route gone/IDLE). **Every** release path (coordinator, completion, invalidation, retry) goes through the single helper `safelyReleaseTrafficReservation(trainId, sids, world, rec, occupiedSet)` with the required semantics: occupied ⇒ never release · release success / authoritative foreign-owner / authoritative free ⇒ drop tracking · failed/unknown ⇒ **retain for retry** · never mutates occupancy.
2. **Authoritative occupancy for releases:** releases use `_occupiedSetFor(tid)`, read-only over Stage5's real coverage structure (`lastTrainPositions`: Map<trainId, Map<sectionId, railPos>>, plus `knownTrainToSections` if such a map ever exists), each candidate confirmed by `getOccupant(sid)===tid`; probe failure ⇒ treated as occupied (conservative). (Audit-confirmed fact: `occupancyManager.knownTrainToSections` does not exist in the Stage9 baseline; all Stage8/9 reads of it were guarded fallbacks. ATTEMPT16 does not add that map — it reads the authoritative structures instead.)
3. **Persistence (blocker #3):** versioned records (`v:1`), deterministic **rotating save cursor** over a sorted key cache (advances after each successful save, rebuilt only on membership change — M158 proves all 5 test records persist across passes), `traffic:{tid}` DP deleted when a record is definitively deleted (M159), `loadAll` actually called at world load (M157 restart round-trip incl. claim rebuild).
4. **Invalidation (blocker #4):** wired into the existing `removeSectionsForBoundary` wrapper (M160 end-to-end) and `handleTrainDisappearance` (M161); records are deleted **only** after all releases are confirmed; anything uncertain → retained on a bounded `_releaseRetryQueue` (≤2 retries/pass, M161b proves retention → retry → cleanup).
5. **canEnterRouteSection safety contract (blocker #5):** E3 + regression tests M162 (other train's `KNOWN_OCCUPIED` → blocked) and M163 (own occupancy/own reservation still allowed; CONFLICT/missing still blocked; free section not over-blocked). Verified against actual Stage5 states (`KNOWN_OCCUPIED/KNOWN_EMPTY/UNKNOWN/CONFLICT`) and Stage8 route semantics. No movement rewrite.
6. **First-seen priority (blocker #7):** arbitration is pure in `(effectivePriority, trainId)`; batch sorted before processing; `effectivePriorityFor` of a record-less train is pure `0`; stale claims of non-autonomous trains cleaned via per-train `claimedSections` index (no global scans). M164/M165 prove identical outcomes under cursor variation, reversed insertion order, and record pre-existence.
7. **Two latent ATTEMPT15 arg-order bugs found by direct inspection and fixed** (both were silently degrading ATTEMPT15):
   - coordinator called `resolveLeadingCurrentSection(trainId, route, world)` — actual signature is `(trainId, world, route, occupiedSet)`;
   - coordinator called `reservationManager.reserveSections(trainId, toRes, world)` — actual signature is `(sectionIds, trainId, world)` (this one made **every** ATTEMPT15 reservation attempt fail with `invalid_args`).
8. **Architecture preservation (blocker #6):** Stage7 atomic `reserveSections` untouched; Stage8 route semantics untouched; Stage9 physical-speed/braking controller untouched; 5-section horizon, ≤8 sections/attempt, pendingClaims 100×8, deterministic arbitration, whole-coupled-train identity, manual driving, schedules/autopilot — all preserved. Mutation budget: reserve+release calls counted together, **max 8/pass**, enforced by clamp (`break`) — M166b proves `[8,8,8,8,8,0]` under deliberate 40-call pressure with full 20/20 completion and 0 leaks. Own-reservation confirmations no longer spend mutation calls (alreadyOwned skip).
9. Dead ATTEMPT15 scaffolding removed: no-op `_priorityIndex`/`getOrUpdatePriorityIndex`, unused shard map + no-op `markDirtyByKey`, `fnv1aHashTraffic` `%1000` pseudo-priority fallback (replaced by the pure record/0 default).

## 4. Test results — M150…M171, all against the packaged final main.js

**73 assertions / 0 failures** (`node dev/stage10_tests.mjs`). The harness extracts the exact Stage1–10 stack verbatim from the shipped `.mcaddon` and executes it under mocked `@minecraft/server` world/system — no test doubles for the code under test.

- M150 release-behind moving train ✓ · M151 destination completion ✓ · M152 occupied never released ✓ · M153 failed release retained ✓ · M154 unknown ownership retained ✓
- M155 getOwner authoritative ✓ · M156 getOccupant authoritative ✓
- M157 persistence loads after restart ✓ · M158 cursor advances ✓ · M159 DP cleaned ✓
- M160 section topology invalidation (real wrapper chain) ✓ · M161 disappearance invalidation ✓ · M161b uncertain→retain→retry→cleanup ✓
- M162 other KNOWN_OCCUPIED blocked ✓ · M163 own occupancy/reservation allowed, CONFLICT/missing blocked, free unblocked ✓
- M164 first-seen contender arbitrated ✓ · M165 cursor/insertion/pre-existence independence ✓
- M166 budget preserved (12 passes) ✓ · M166b clamp under pressure + bounded convergence ✓ · M167 no unbounded per-tick scans (static + runtime) ✓
- M168 no Date.now/Math.random in identity/reservation/driving/traffic decision paths ✓ (remaining Stage1–5 baseline uses are informational shard save stamps and safe-direction `lastSeen` fallbacks — documented, can only under-trigger eviction, never wrongfully evict)
- M169 Stage 5–9 cumulative implementations preserved (symbol set + zero-collateral diff vs both ATTEMPT15 and Stage9 ATTEMPT5) ✓
- M170 ZIP integrity + entry count 3,144 + JS syntax/brace parse ✓ · M171 exactly one class + one instance per manager, single `trafficManager` singleton ✓

## 5. Reproducibility

- Build: `python3 dev/build_attempt16.py` (deterministic patch set over ATTEMPT15 with unique-anchor assertions; repacks all 3,144 entries in original order)
- Tests: `node dev/stage10_tests.mjs`
- Dev sources: `dev/build_attempt16.py`, `dev/traffic_block_attempt16.js` (verbatim inserted block), `dev/stage10_tests.mjs` — **not** part of the package.

## 6. Explicit confirmations

- Stage 5 (occupancy + deterministic dual-hash identity), Stage 6 (naming), Stage 7 (atomic reservations), Stage 8 (navigation + section-location index), Stage 9 (physical-speed/braking driving controller + wrappers) implementations are **present and byte-identical** to the verified baseline except the five documented minimal hooks (E1, E2, E3, E4, E5), each of which is guarded and additive.
- No `Date.now()`/`Math.random()` introduced anywhere in ATTEMPT16; no tick=0 fabrication.
- No Stage 11 work begun. **Stage 10 ATTEMPT16 is NOT marked approved** — next gate is in-game validation with ≥2 trains on a shared single-line section.

## 7. Known limitations (unchanged, for the record)

- Stages 8–10 are still dormant infrastructure in gameplay: nothing yet calls `setDestination`/`setAutonomousMode` in-game (the original schedule autopilot remains the live automation). This is the Stage-11-adjacent integration question noted in the takeover audit; intentionally not addressed here.
- `canEnterRouteSection`/driving interlocking now blocks other trains' `KNOWN_OCCUPIED` sections; manual/schedule-autopilot trains still rely on the original signal hard-stops (by design — manual driving must stay intact).
