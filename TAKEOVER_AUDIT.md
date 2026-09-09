# TAKEOVER AUDIT — Worker V2
Project: Create-style train functionality for Minecraft Bedrock (Phase 1, Stages 1–10)
Date: 2026-09-08 · Branch: `arena/01a08219-mcaddontrains2-0`
Method: independent archive extraction, hash verification, full-file diff, direct main.js inspection, Node 22 syntax parse. **No worker reports were trusted (none exist in the repo anyway).**

---

## A. Repository inventory

The repository contains exactly **3 files** (single commit `7011011` "Add files via upload"). No reports, no docs, no earlier attempts, no intermediate stage packages — all "knowledge" about Stages 5–9 known-good labels comes from the brief, so every claim was re-verified against the actual archives.

| Package | Size (bytes) | SHA256 | ZIP integrity |
|---|---|---|---|
| `TRAINS_Phase1_Stage9_ATTEMPT5.mcaddon` | 7,438,353 | `c8cb356b…d8189b8` ✓ **matches expected** | OK (3,144 files tested) |
| `TRAINS_Phase1_Stage10_ATTEMPT15.mcaddon` | 7,441,121 | `359d7fb7…69911c2` ✓ **matches expected** | OK (3,144 files tested) |
| `IronRoad_v0.71.0.mcaddon` (reference only) | 5,602,812 | `d3a9e0a2…a70ad2a0fa` | OK |

**TRAINS package layout (identical in both):**
- Behavior pack `TRAINS Urban Update Add-On` — uuid `ab5cde80-a5b3-48b1-85db-3048b2dbc6ab`, v`[1,1,6]`, engine ≥ 1.21.100, script entry `scripts/main.js`, deps `@minecraft/server 2.1.0`, `@minecraft/server-ui 2.0.0`.
- Resource pack `TRAINS Urban Update Add-On by matiss` — uuid `56ca16b1-f4df-4512-b739-e72d8367d309`, v`[1,1,6]`.
- Content: 8 locomotive entity types (basic/winged steam, front/midcab diesel, tram, subway, handcar, rollercoaster), 13 train-car types, turntable entity, 1,168 block JSONs (rails, switches, train_signals, crossing_signals, signal_boxes, buffer_stops, platforms, cross_rails, trestles, turnstiles, …), 9+ items incl. **schedule item**, guide book, wrench, tickets; 55 recipes; RP with models/textures/icons/sounds; guide-book icons present. **No JSON-UI (`ui/` folder) — all UI is server-side forms.**

**IronRoad (reference):** BP+RP, 10 script modules, 20,588 lines (`main.js` 19,063 + `train/graph/perf/path/cargo/kinematics/fuel/tiers/works`). Used for concepts only; nothing copied.

## B. True cumulative baseline

**`TRAINS_Phase1_Stage9_ATTEMPT5.mcaddon` is the true cumulative known-good baseline.** Its hash independently matches the declared value.

**Stage10 ATTEMPT15 verdict after direct inspection:** the two packages differ in **exactly one file**, `scripts/main.js` (836,909 → 850,444 bytes; 18,035 → 18,140 lines). The diff is a **single insertion hunk: `5441a5442,5546` — 105 lines added, 0 removed, 0 modified.** Stage10 is a strict superset of Stage9 (verified at byte/line level, not from any report). Both `main.js` files parse as valid ES modules (`node --check`, Node v22.22.3).

## C. Hashes / integrity
See table in §A. Both expected SHA256 values reproduced by local `sha256sum`; `unzip -t` reports no errors in all 3 archives; manifest UUIDs/versions identical between Stage9 and Stage10 (same-world upgrade replaces in place). ⚠️ Pack version `[1,1,6]` was **not bumped** for Stage10 — bump to `[1,1,7]` for any next package so Bedrock reliably picks up the update.

## D. Actual bundled main.js inventory

The file is a bundled module: the Phase-1 stage stack (lines 1–5546 in S10) layered on top of the original "TRAINS Urban Update Add-On by matiss" base addon.

**Stage stack (top of file, in order):**

| Stage | Classes | Singleton | Persistence namespace | Cadence |
|---|---|---|---|---|
| 1 TrackGraph | `TrackEdge, TrackNode, GraphShard, TrackGraphManager` | `trackGraphManager` | `pod_trn_graph_shard_/meta_`, 32-block shards, 8,000-char cap, budgeted `tickSave` | save @10t |
| 2 Rail→Graph adapter | `GraphDiscoveryQueue` + `buildNodesForRailBlock, linkEdgesForNode, discoverRailBlock, onRailTopologyChanged, rebuildGraphAt` (switch branches, cross-lock groups) | — | via graph | discovery @5t |
| 3 Graph points | `StationGraphPoint, SignalGraphPoint, GraphPointShard, GraphPointManager, GraphPointDiscoveryQueue` | `graphPointManager` | `pod_trn_gpoint_*` | discovery @10t |
| 4 Sections | `Section, SectionShard, SectionManager, SectionDiscoveryQueue`, `buildSectionsForArea` | `sectionManager` | `pod_trn_section_*` | discovery @15t |
| 5 Occupancy+identity core | `OccupancyRecord/Shard/Manager, OccupancyDiscoveryQueue`, states `KNOWN_OCCUPIED/KNOWN_EMPTY/UNKNOWN/CONFLICT`, `updateOccupancyForTrain`, split/merge reconciliation, `handleTrainDisappearance`, deterministic dual-hash IDs (`djb2+fnv1a`, no clocks/random) | `occupancyManager` | `pod_trn_occupancy_*` | discovery @10t |
| 6 Naming | `IdentityRecord/Shard`, `TrainIdentityManager` (custom vs generated display names) | `trainIdentityManager` | `pod_trn_idname_*` | save @10t |
| 7 Reservations | `ReservationRecord/Shard/Manager`, **atomic `reserveSections()` with snapshot+rollback**, `releaseSection(s)`, tick-gated (never fabricates tick), `canTrainEnterSection` | `reservationManager` | `pod_trn_resv_*` | save @10t, recovery @100t |
| 8 Navigation | `SectionLocationIndexShard/Manager` + `NavigationRecord/Shard/Manager`: `setDestination, calculateRoute (bounded), validateRoute, canEnterRouteSection` | `sectionLocationIndexManager`, `navigationManager` | `pod_trn_secidx_*`, `pod_trn_nav_*` | save @10t |
| 9 Driving | `DrivingRecord/Shard/Manager`: `calculateTargetSpeed` (physical-speed ≠ throttle separation, measured speed from movement's `AmountLastTick` ratio, braking-distance with conservative unknown-length handling, honor signal-delay DP, invalidation safe-stop), `tickDrivingController` (sorted IDs + rotating cursor, budget 8/tick, applies via existing `setThrottle` + `pluckCache`) | `drivingManager` | `pod_trn_drive_*` | **@1t**, save @10t |
| 10 Traffic (candidate) | `TrafficRecord, TrafficManager`: sharded records, claim map (≤100 sections × ≤8 trains), priority = `priority − waitingTicks` anti-starvation, coordinator budget 8 @10t, save budget 2 @10t | `trafficManager` | `traffic:{trainId}` | coordinator+save @10t |

**Base addon (preserved, untouched):** `getRailConnections/checkRailConnections/traverseRail/getRailDetails/getRailLength`, `pathing.ts`, `coupling.ts` (`collectCoupledTrain`), `movement.ts` (`calculateVelocity, calculateEntityIncrement, locomotiveProcess, getEffectiveThrottle, setThrottle, moveTrain, processTrains`), station/velocity/chime/horn markers, switches, crossing signals, **train_signal component** (red = `LocomotiveSignalDelayOverride = tick+80` + hard `setThrottle(0)`, reverse-free, occupying-train exemption), **original schedule autopilot** (`LocomotiveScheduleData`, `isScheduleAutopilotActive` locks rider throttle, `advanceSchedule`), turntable, trestles, drills, track-assist, caches, guide-book UI (`ActionFormData`/`ModalFormData`, texture icons), train placer, 1 custom command (`pod_trn:podtrains` guide). Master loop: `trainLoop` @1t (`processTrains` + turntables), `playerLoop` @20t, loco family scan @15t/dim, signal scan @5t/dim, track-assist @3t.

## E. Dependency graph (Stage5 → Stage10)

```
coupling/collectCoupledTrain ─┐
S1 graph ─→ S4 sections ─→ S5 Occupancy (KNOWN_*/UNKNOWN/CONFLICT, dual-hash trainId)
                              ├─→ S6 Identity naming (trainId → display name)
                              ├─→ S7 Reservations (recovery consults S5 knownTrainIds/lastSeenTickMap)
                              │       └─→ S8 Navigation (routes over S1/S4; canEnterRouteSection
                              │              checks S7 knownSectionToTrain + S5 UNKNOWN/CONFLICT) [+ SecLocIndex]
                              │              └─→ S9 Driving (S8 routes, S5 occupancy, S7 via canEnter,
                              │                     base movement setThrottle, base signal-delay DP, braking)
                              │                     └─→ S10 Traffic (S9 knownTrainToDriving+autonomousActive,
                              │                            S8 routeSectionIds, S7 reserveSections/releaseSection,
                              │                            S5 knownTrainToSections, resolveLeadingCurrentSection,
                              │                            getOccupancyTick)
S4.removeSections wrapper → invalidates S5, S7, S8(nav+index), S9   (NOT S10 — gap G-5)
```
S10 never mutates occupancy (rule 16 respected); reservations only via `reservationManager`.

## F. Missing / duplicated / shadowed managers

- **No duplicates, no shadowing, no placeholder managers.** Exactly one legitimate singleton per stage, all with real bodies.
- **Missing wiring (not missing managers):**
  - Nothing anywhere calls `setDestination`, `calculateRoute`, or `setAutonomousMode` from gameplay — the only in-game activation path for Stages 8/9/10 does not exist yet (they are dormant infrastructure; the active in-game automation today remains the *original* schedule autopilot + train_signal hard-stops).
  - S10: `loadTrafficOnWorldLoad`, `invalidateTrafficForSectionId/TrainId`, `releaseSectionsBehind`, `getTrafficState`, `releaseAllForTrain` — defined, **zero runtime callers** (except each other).
  - Only 1 registered custom command (guide); no stage diagnostics/driving/traffic UX.

## G. Defects found in Stage10 ATTEMPT15

(it cannot "regress" Stage9 — pure addition — but has real functional defects)

1. **BLOCKER — reservations are never released in normal operation.** The coordinator reserves ahead but never calls `releaseSectionsBehind` (unused) and never releases on arrival/invalidation; the only release paths are uncalled invalidators or the 400-tick "owner missing" recovery. Consequence: every traversed route section stays RESERVED forever behind a moving train (and at its final stop) → following trains are permanently brake-blocked (`RESERVED_BY_OTHER`), `rec.reservedSections` grows without bound per journey. This alone makes the traffic layer actively harmful beyond first-use, though it always fails *safe* (stopped trains, not collisions).
2. **Two arbitration layers are inert:** `reservationManager.getOwner` and `occupancyManager.getOccupant` **do not exist** in the Stage9 base; S10's guarded calls (`&& reservationManager.getOwner`, `&& occupancyManager.getOccupant`) silently degrade to `null`. Conflict resolution still works via claims + atomic `reserveSections` CONFLICT, and driving-side braking via `canEnterRouteSection` — but the owner-priority comparison and direct occupancy blocking never execute.
3. **Latent interlocking gap (pre-existing, exposed by traffic):** `canEnterRouteSection` blocks UNKNOWN/CONFLICT and foreign *reservations*, but **not** `KNOWN_OCCUPIED`-by-other. In practice sticky reservations paper over this for autonomous trains; manual/schedule-autopilot trains never reserve, so an autonomous train's route through a manually-occupied section relies on the physical signal hard-stops only.
4. **Traffic persistence is write-only + starving:** `tickSave(2)` always re-writes the *first two* map records (no rotating cursor) → >2 trains never persist; `loadAll` is never called; `traffic:` dynamic properties are never deleted when records are removed → slow unbounded DP leak across sessions (violates bounded-persistence spirit; only mitigated by loadAll being uncalled).
5. **Traffic invalidation not wired:** the Stage9 `removeSections` wrapper invalidates occupancy/reservations/navigation/index/driving but not traffic; train disappearance handling likewise doesn't call `invalidateTrafficForTrainId`.
6. **Dead/decorative code:** `_priorityIndex` never populated; `TrafficManager.markDirtyByKey` no-op; `shards` map vestigial; constants (`TRAFFIC_RESERVATION_HORIZON=5`, `MAX_PENDING_SECTIONS=100`, `MAX_CLAIMS_PER_SECTION=8`) duplicated as inline literals; `priority` field has no producer (always 0). Harmless but should be cleaned at the next attempt.
7. ✅ Non-issues verified: no `Date.now()`/`Math.random()` in the S10 block; no tick=0 fabrication; all claim/reserve mutations bounded; defensive `typeof` guards prevent crashes; syntax valid; no occupancy mutations from release helpers (rule 15/16 compliant shape).

## H. Does Stage10 ATTEMPT15 preserve Stage9 ATTEMPT5?

**Yes — perfectly.** Byte-identical for 3,143/3,144 files; `main.js` diff is a single pure insertion; every Stage9 interval, wrapper, safe-fail path, and the base movement/physics/schedule/signal code is untouched. The S10 header comment claiming "layered on REAL Stage9 ATTEMPT5 c8cb356b" is **true** (hash verified independently). Stage10 ATTEMPT15 is therefore a safe *base* to continue from, but **must not be called "Stage 10 complete/approved"** until G-1..5 are fixed and it is validated in-game with ≥2 trains.

## I. Performance concerns

- Driving controller @1t sorts **all** known train IDs every tick (`trainIds.sort()`) even though it processes 8 — O(N log N)/tick on the full known-train set; acceptable today, should become a persisted cursor over a stable index as train counts grow.
- `tickReservationRecovery` @100t scans **all** `knownSectionToTrain` — O(#reservations) every 5 s; needs a rotating cursor on large networks (its evolutionary logic — evict-on-unseen-immediately when `lastSeen` is missing — should also gain a grace period; currently `lastSeen===undefined → isUnknown → evict` at first recovery pass, which is under-conservative, though always safe-fail).
- Base addon pre-existing (do not casually rewrite): per-dimension locomotive entity scans @15t, signal scans @5t, `getEntities({families:…})` inside `trainLoop` @1t. Known lag source candidates; only touch with measured profiling and explicit reason.
- S10 coordinator itself is properly bounded (8 trains/pass @10t, 5-section horizon, ≤8 sections/attempt, caps on claims) — good pattern, keep it.
- `invalidateForBoundaryId` walks driving-records × route × section-shards; invalidation-time only, tolerable.
- When wiring `TrafficManager.loadAll`, note it scans all dynamic properties once at load (one-time, but could be slow on large worlds — prefer a deterministic traffic DP prefix index like other managers' shard enumeration... note `traffic:` already is a prefix, scanning is inherent to prefix enumeration; bounded by total DP count).

## J. Recommended exact next action (NOT Stage 11)

**Fix-forward Stage 10 as "ATTEMPT16" on top of ATTEMPT15** (do not rebase, do not rewrite — the architecture is sound), a minimal, surgical patch set:

1. Add two tiny read-only methods (no behavior change elsewhere): `ReservationManager.getOwner(sectionId)` → `knownSectionToTrain.get(sectionId) || null`; `OccupancyManager.getOccupant(sectionId)` → shard lookup returning `trainId` when `state==="KNOWN_OCCUPIED"`. This activates S10's two inert guards and can later close G-3 in `canEnterRouteSection` (explicitly document that edit as a Stage-9-lineage change when done).
2. In `tickTrafficCoordinator`: after computing `curIdx`, call `releaseSectionsBehind(trainId, curIdx, route, occSet, world, rec)`; add a bounded arrivals release when `curIdx >= route.length-1` or nav/driving state indicates completion (respect rule 15: keep record entries if release reports failure; never evict silently; never touch occupancy).
3. Wire `invalidateTrafficForSectionId/TrainId` into the existing `removeSections` wrapper and into occupancy `handleTrainDisappearance` path (same pattern as the other five managers).
4. Fix traffic persistence: rotating-cursor `tickSave`, delete `traffic:{tid}` DP when a record is removed, and actually call `loadTrafficOnWorldLoad(w)` in the Stage10 startup block next to the two `runInterval`s.
5. Remove/decision the dead code (priority index, no-op markDirty, vestigial shards) or document it as intentional extension points.
6. Bump both pack manifests to `[1,1,7]`, produce `TRAINS_Phase1_Stage10_ATTEMPT16.mcaddon`, and validate **in-game with 2 trains on a shared single-line section** (block, pass, follow-through; release-behind observable via `traffic:`/`pod_trn_resv_*` DPs) before declaring Stage 10 complete.

**Only after that**: plan the Stage-11-adjacent integration question — bridging the *original* schedule autopilot (`LocomotiveScheduleData`) to `setDestination`/`setAutonomousMode` so Stages 8–10 are actually reachable in gameplay — and the signal/dispatch/UI roadmap from there. Stage 11 implementation is explicitly **not** started in this pass.
