# PERFORMANCE + SIGNAL/RAIL BEHAVIOUR — ROOT-CAUSE AUDIT (TRAINS ATTEMPT19 vs IronRoad v0.71.0)

Status: **audit only**. No implementation changed, no ATTEMPT20, no Stage 11, nothing APPROVED.
Method: full hot-path trace of packaged `TRAINS_Phase1_Stage10_ATTEMPT19.mcaddon` scripts/main.js (18,374 lines)
with static per-tick cost accounting (getBlock / getEntities / DP-write / setPermutation counts per loop),
cross-read against IronRoad's packaged modules (`graph.js`, `path.js`, `train.js`, `kinematics.js`, `perf.js`,
`main.js` + signal code). Sandbox has no Bedrock runtime → numbers are code-derived; step P0 below adds
in-game instrumentation to confirm them.

---

## A) Confirmed lag causes (evidence: packaged main.js line numbers)

### A1. Per-block per-tick component storm — the "always-on floor" of lag
- **cross_rail.onTick (L17991)** bound to **378 cross-rail block types** ticking at `[0,0]` = **every tick**:
  `dimension.getEntities({families:pod_trn_stock, maxDistance:1, closest:1})` **plus unconditional
  `world.setDynamicProperty(${id}_cross_rail_locked, …)` every tick per block** — an entity query AND a
  world-DP write per cross-rail per tick, even with no train anywhere (writes `0` when empty).
- **switch onTick (L12581)** — **108 switch types at [0,0]**: `getRedstonePower()` + state read per block per tick
  (cheap body, but JS dispatch × switches × 20 tps forever).
- **marker onTick (L11092/11297/11384, markerCommonTick L→)**: calls `block.above()` and **2×
  unconditional `setPermutation(...)` per tick** (block-update/re-render/neighbor churn), plus another
  `setPermutation` for the diagonal state.
- **turntable onTick (L17883)**: `setPermutation(powered,true)` per tick.
- Ticking census (block JSONs): cross_rails 378@[0,0]; switches 108@[0,0]; train_signals 12@[10,10];
  signal_boxes 12@[10,10]; crossing_signals 12@[10,10]; turnstiles 32@[2,2]; misc 8. **560 ticking component bindings.**

### A2. Signal system — per-N scaling, the heaviest compute per placed signal
- **Every train_signal block every 10 ticks** (`minecraft:tick [10,10]`; `trainSignal.onTick` L17268 →
  `processOneSignalBlock` L16830):
  - `computeSignalAspectForConfig` (L16935): `walkTrackPath` **L16846** where each cell costs
    `getNeighborRails` = **24 getBlock calls** → at defaults (detect 16 → caution 32) a 34-cell walk ≈ **816
    block reads**; then `dimension.getEntities({families:pod_trn_stock, maxDistance:caution+16=48})`;
    then per loco `collectCoupledTrain` (L16907, coupling-chain walk) × per member `entityNearPath`
    (L16887) = O(cars × pathCells) distance math.
  - `signalLocomotivesImpact` (L17000): **two more walkTrackPath** (approach 10 cells ≈ 240 reads; ahead 12
    cells ≈ 288 reads) + **another getEntities** ({signalable, r=impact+16=24}) + per-entity nearPath×2 +
    entity-DP writes (LocomotiveSignalDelayOverride).
  - → **≈1,300+ block reads, 2 entity queries, O(cars×cells) math PER signal PER 10 ticks**; ×12 ticking
    signal types everything multiplied by placed count, plus crossing_signal.onTick (L15152) with another
    getEntities.
- **5-tick "fast re-apply" sweep (L17275-17310)**: for **all 3 dimensions**: full `getEntities({families:
  pod_trn_signalable})` dimension scan, then **per signalable locomotive a 17×17×4 = 1,156-getBlock volume
  scan** to rediscover signals already known to the pack.
- **15-tick schedule action-bar loop (L16010)**: **all 3 dimensions** × `getEntities({families:
  pod_trn_locomotive})` + per-autopilot-loco rider notification.
- `getSignalConfig` (L16722) re-reads 6 world DPs per call per signal.

### A3. Legacy per-tick train loop — per-train per-car churn (moveTrain/processTrains L12782, every tick, ALL trains)
- **Chunk-loading churn**: per car per tick, unconditional `stock.triggerEvent(pod_trn:(dis|en)able_chunk_loading)`
  **and** `addTag`/`removeTag` (entity event + tag write storm across the whole consist).
- **Entity DP churn**: per car per tick `get/setDynamicProperty(RollingStockSafeUsageCount)`,
  `setDynamicProperty(RollingStockDerailmentCount, …)`.
- **Lead car forced full lookahead rescan every tick**: `isHeadingAllowed2` (L14036) calls
  `traverseRailCache.call(id, !!node.firstCar, …)` with **forceRefresh=true for the lead car** → a fresh
  `traverseRail` (L13946, up to 12 steps; default lookahead 6 at L9166) **every tick**, each step:
  connection reads + `block.above()` + `doubleAbove` + **`getEntitiesAtRail` (L13932) = one entity query
  per rail cell** → ≈6–12 entity queries + ~30 block reads per train per tick, plus
  `getEntitiesAhead` post-processing.
- Per car every ~10 ticks (cache TTL 10, `ResultCache` L12612 — note it uses `Math.random()` jitter):
  `getEntityRail` (L15058) = up to 3–4 `getBlock` + `checkBlock` connection computation;
  `checkRailConnections` validates 5 directions.
- Side tasks every 10 ticks per car (`processRollingStockEntitySideTasks` → `pullInEntities`,
  `transferFuelForwards`, `handleGroundItems` — radius entity queries for item pickup etc.).

### A4. Unbounded entity lookups in Stage-9 driving path (armed; mostly dormant in-game today)
- `tickDrivingController` **every tick** (L5488, budget 8 autonomous trains) → `calculateTargetSpeed` →
  `getLocomotiveForTrainId`: `getEntities({families:pod_trn_locomotive})` **per dimension, up to 6 dimension
  IDs**, then per-entity `getDynamicProperty(pod_trn_train_identity)` — a full-dimension scan per call, per
  train, per tick. Today in-game there are no autonomous trains (see A6), but this explodes the moment
  autonomy is wired.

### A5. What's fine (trace-verified) — the Stage 5–10 stack is already bounded
- tickGraphDiscovery (5t) / tickGraphPointDiscovery (10t) / tickSectionDiscovery (15t): queue-batched
  (≤8/10 per pass), event-fed by rail place/break; idle when nothing changes.
- Traffic coordinator (10t): ≤8 trains, ≤8 mutations, retry cap 2, horizon 5; occupancy/reservation/nav
  saves budgeted at ≤2 shards per save tick; reservation recovery 100t. No world scans; deterministic
  shard DP reads only (single-shard tryLoad per ATTEMPT16-19 design).

### A6. Important finding: Stage 5–10 is **dormant in-game** in ATTEMPT19
`setAutonomousMode`, `updateOccupancyForTrain`, `navigateTo/startNavigation` have **zero in-game call
sites** (definitions + adapter exports only). Identity/occupancy/reservation/traffic structures stay empty;
loops short-circuit. ⇒ The observed lag is **not** produced by the reservation/traffic architecture — it is
produced by A1–A3 (legacy live systems) + the A4 hazard. This validates the mandate to keep Stage 5–10 and
fix hot paths (and it means future autonomy wiring must fix A4 first and feed occupancy budgeted).

---

## B) IronRoad mechanisms that address each cause (from packaged v0.71.0)

| Cause | IronRoad mechanism (file) |
|---|---|
| A1 block-tick storm | **Zero always-ticking block components.** Rails/crosses/turnouts are passive geometry: connectivity lives in block-state bitmasks; recomputation is **event-driven** (place/break/edit) via `trackCacheBump()`/`roadUnlearn()`/`refreshNeighbours` (main.js L1140-1160, L7895-7930). Turnout state persisted as compact records, not per-tick polling. |
| A2 signal scans | **Signal registry + event-driven aspects.** Signals are records in a Map keyed by block position — `signalAt(x,y,z)` is O(1) (main.js L5308); adoption on chunk-load, never volume scans. Aspects flip **only on train events**: `sigScan(rec)` (L7421) walks only the train's **already-cached** segment list between consecutive odometer values; `sigOccupy`/`sigReleaseId` update display rows only on change. **Directional approach**: `if (sig.face !== undefined && s.entry !== sig.face) continue` — a signal responds only to its facing direction. Section free = tail-clear by consist length on the odometer; safety fallback `SECTION_MAX+len` (L7440-7456). **Home/distant chaining**: `secFarFind` (L5340) walks ahead ≤`SECTION_MAX`=64 cached cells **once on occupy**, not per tick. |
| A3 movement cost | **Cached per-train path + closed-form kinematics** (`train.js`, `kinematics.js`, `path.js`, `graph.js`). Each train keeps a segment array (`segs`) with arc-length odometer; `_extendTo(max(LOOKAHEAD=24, v²/2b+8))` **bounded lookahead** extended incrementally, never re-scanned wholesale; `_replan()` computes per-segment entry tick/speed/target with closed-form constant-accel `crossBlock(v0,vt,len,accel,brake)` (bounded braking-distance math); `settleTo(tick)` **evaluates** future motion instead of step-simulating (PLAN_BUDGET=2048 cap); `locate()` binary search; `carAt(i)` analytic `pointOn/directionOn` per car — **zero getBlock per car per tick**; target speed = min(tier, top)×curveFactor×haul×throttle, **braking-envelope-capped** by `envelopeFor(room,brake)=sqrt(2·b·room)` to stops/end-of-track; replans happen **only on events** (throttle/park/release/stop, `cutAt` on rail edits). Climb load/adhesion = `CLIMB_LOAD`, stall detect by demand>2·effort. |
| A4 entity scans | **Train registry, not queries.** `trains` Map of records; entities adopted once (slow `adopt` beat every 40t) and revived per car only when invalid; per-tick loop consumes the registry. Car entity placement reuses cached refs. |
| A1/A2 geometry | **O(1) rail math from cached state** (`graph.js`): connectivity, junction/wye/diagonal shapes, exits, rises are pure bitmask arithmetic from a cached `mask/code` — no block access; world reads confined to `track.at()` which is memory-first (pass-scoped `trackSeen`, persistent learned `roads` map with compact base64 rows), refilled only after explicit invalidation bumps. |
| scheduling | **Slow-beat scheduler** (main.js L19050): road 200t, ports 20t, adopt 40t, surveyor 4t — staggered heartbeats instead of uniform always-on loops. |
| measurement | **`perf.js` instrumentation** (whole file): `w(name, fn)` self-ms buckets per tick, SLOW ≥25 ms + STALL ≥250 ms console lines, periodic ms/tick + %tick reports, `comp()` to wrap block components, tuning at runtime — exactly goal #13. |

## C) Exact TRAINS files/functions that would need modification

All in `TRAINS Urban Update Add-On/scripts/main.js` (bundled) + block JSONs:
1. **crossRail system**: `crossRail.onTick` (L17991-18015); `minecraft:tick [0,0]` in all 378 `blocks/cross_rails/*.json`.
2. **Signal stack**: `trainSignal.onTick` (L17268), `processOneSignalBlock` (L16830), `computeSignalAspectForConfig`
   (L16935), `signalLocomotivesImpact` (L17000), `walkTrackPath`/`getNeighborRails` (L16846-16884),
   `entityNearPath` (L16887), `collectCoupledTrain` (L16907), `getSignalConfig` (L16722), 5-tick sweep
   (L17275-17310), `crossingSignal.onTick` (L15152); 12 train_signal + 12 signal_box + 12 crossing_signal JSONs.
3. **Movement loop**: `moveTrain`/`processTrains` (L12782+), `processRollingStockEntity` (L13224; chunk-loading
   event/tag churn + DP writes), `isHeadingAllowed2` (L14036) + forced `traverseRail` (L13946) +
   `getEntitiesAtRail` (L13932) + `getEntitiesAhead`, `getEntityRail` (L15058), `ResultCache` (L12612;
   `Math.random()` jitter), side-task `pullInEntities` radius queries, `DefaultLookaheadAmount` (L9166).
4. **Stage-9 driving**: `getLocomotiveForTrainId` (full-dim scans), `calculateTargetSpeed` per-call entity
   queries; keep the budgeted controller loop itself.
5. **Switches**: onTick watcher (L12581) → redstone event component; 108 switch JSONs [0,0].
6. **New modules (ports, not copies)**: perf instrumentation (from IronRoad `perf.js` ideas), cached-lookahead
   + kinematics (from `train.js`/`kinematics.js`/`path.js` principles) adapted to Stage-2 graph/Stage-4 sections.

**Not to be modified**: Stage5-10 managers (identity, occupancy, sections, reservations, navigation, driving
records, traffic coordinator) — they stay the architecture; only their *feed/wiring* gets budgeted.

## D) Proposed bounded architecture (phases; each measured via P0)

- **P0 — instrumentation first (no behavior change).** Port IronRoad `perf.js` pattern: wrap every interval
  + block-component handler in `w(name,fn)` buckets; SLOW ≥25 ms/STALL ≥250 ms console lines; periodic
  ms/t + %tick report + `/perf`-style chat command. **Confirms A1–A4 in-game with real numbers before any fix.**
- **P1 — kill the block-tick storm (data + small code, biggest floor win).**
  cross_rail: remove `[0,0]` ticking; lock state computed **event-driven** — set when the movement loop sees a
  stock entity on the block, cleared on exit (armed-window fallback: check entities only while a train was seen
  last tick); DP writes change-only. switches: replace tick polling with redstone-update event component (or
  ≥5t change-only poll as a stopgap). markers/turntable: setPermutation change-only (read state first).
- **P2 — bounded, directional, event-driven signals on Stage-2 graph + Stage-4 sections** (replaces A2 compute,
  keeps user-facing config semantics):
  - Signal registry by position (placed/broken/chunk-load adoption events — **no volume sweeps**; delete the
    5-tick 1,156-getBlock scan outright).
  - Per signal, **precompute once** (and cache with a topology-version stamp): approach path + guarded path as
    rail-position lists over our Stage-2 TrackGraph (bounded ≤ (detect,caution) cells, ~dozens, walked only on
    config/topology change events — IronRoad secFarFind pattern).
  - **Directional approach**: derive the signal's guarded direction from its attached rail at registration
    (like `sig.face`); a train affects the aspect only approaching from that direction; occupancy of the
    guarded direction's section drives red; wrong-direction traffic is ignored.
  - **Aspects event-driven**: recompute on Stage-5 occupancy transitions of the guarded section and Stage-7
    reservation changes for it (`invalidateTrafficForSectionId` hook already exists), plus a slow
    revalidation heartbeat (e.g., 20t) as backstop; `setPermutation`/aspect row writes on change only.
    Occupancy UNKNOWN ⇒ red (Create-style fail-safe preserved — constraint #11). Distance/impact of manual
    (lever) signals unchanged. Distant/home chaining cached ≤64 cells, re-walked on change events only.
  - Wire the missing minimal occupancy feed: per train per tick (or per K ticks with position-change guard),
    budgeted `updateOccupancyForTrain` using rail position already known to the movement loop — this is the
    dormant-stack activation and must be landed fail-safe-first and measured.
- **P3 — bounded lookahead + physical driving (IronRoad kinematics, adapted; manual drive preserved).**
  Autonomous/driving trains: cached path extension `max(24, v²/2b+8)` over Stage-2 graph/Stage-4 sections;
  closed-form accel/brake (`crossBlock`-equivalent), target speed = min(track limit, vehicle cap,
  curve factor) **then envelope-capped by braking distance to next blocked/stop section** (blocked =
  occupied/unknown/foreign-reserved → target 0 at envelope; Create-style fail-safe); replan on traffic/
  occupancy/reservation/route events + slow cadence only. Manual driving keeps legacy path with:
  chunk-loading event/tag application change-only; per-car DP writes change-only; lead-car lookahead
  **cached with K-tick revalidation** (K≈5) instead of forced refresh every tick, invalidated instantly on
  switch-throw/topology edits (revoke pattern exists in the code); obstacle entity query only on the lead
  block + resolvable section occupancy.
- **P4 — entity registry.** trainId → locomotive entity cached ref (validated by `isValid`, invalidated on
  remove/despawn events); slow `adopt` beat for strays (IronRoad 40t pattern); dimension scans only in dims
  that contain registered trains. Kills A4 and trims A2's residual queries.
- **Scheduling**: staggered slow beats (4/20/40/200t with offsets) instead of stacked uniform intervals;
  every tick function documented with its worst-case op budget.

## E) Expected performance improvement and risks

**Expected (to be confirmed by P0 measurements in-game):**
- Signal compute: ~1,300 block reads + 2 entity queries per signal/10t → **~0 steady-state** (O(path) only on
  topology/config change events; heartbeat revalidation amortized).
- 5-tick sweep: 1,156 getBlock × signalables × 3 dims → **0** (deleted).
- Cross rails: C entity queries + C world-DP writes/tick → **0** (event-driven).
- Movement: per-train/tick ≈6–12 entity queries + ~30 block reads + tag/event/DP churn → per-car O(1) cached
  math, change-only writes; lead-car lookahead cached with K-tick revalidation.
- Driving/autopilot: full-dim scans per train/tick → cached refs O(1).
- Net effect: per-tick JS time should fall by the full A1+A2 floor (typically the dominant term once several
  signals/crossings are placed) to a small, size-bounded residue. Exact ms figures must come from P0
  before/after captures; no honest number can be given without them.

**Risks & mitigations:**
1. **Manual-drive reaction latency**: cached lookahead + K-tick revalidation reacts ≤K ticks slower to manual
   switch throws/obstacles → invalidate instantly on throw/topology events; braking envelope covers the K-tick
   window (envelopeFor semantics); keep K small, speed-dependent.
2. **Signal semantics parity**: current aspects are proximity+path based; section/occupancy-driven aspects must
   not miss unregistered stock → bounded entity fallback restricted to the precomputed approach path when
   occupancy is UNKNOWN; default red on any doubt (fail-safe, #11).
3. **Cross-rail safety timing**: event-driven lock must still block wrong-side entry → armed-window entity check
   (only while a train was recently present) + change-only DP.
4. **Chunk-loading behavior**: tag/event churn removal must not stop chunk-loading — apply (dis|en)able_event
   + tag **only on state change** (read first).
5. **Dormant-stack activation**: feeding occupancy for the first time activates traffic arbitration in-game —
   land behind instrumentation, fail-safe-first (unknown ⇒ stop), with rollback point; do not bundle with P1.
6. **Block-JSON data edits (378+108+36 files)**: mechanical de-risking — verify pack loads, no log errors;
   keep non-rail tickers (turnstiles etc.) untouched.
7. **IronRoad differences**: port algorithms only (kinematics, cached bounded lookahead, event-driven aspects,
   perf instrumentation, slow beats) — not its bitmask data model or reservation system (constraints #7/#8).
8. **ResultCache `Math.random()` jitter**: legacy nondeterminism — replace with fixed TTL during P3 touch-up
   (also aligns with our no-`Math.random` rule in guarded code paths).

---

### Immediate recommendation
Land **P0 instrumentation only** first (small, safe, reversible), run in-game, and attach the captured perf
report to confirm A1–A4 ranking before touching behavior. Then P1 (pure win, lowest risk), then P2/P3/P4 in
order. No package will be built and nothing marked approved until you direct each step.
