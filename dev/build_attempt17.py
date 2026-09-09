#!/usr/bin/env python3
"""
Build TRAINS_Phase1_Stage10_ATTEMPT17.mcaddon
=============================================
Fix-forward on the byte-verified Stage10 ATTEMPT15 package (byte-verified
Stage9 ATTEMPT5 c8cb356b + one additive traffic hunk). No architecture rebuild;
only the audit-flagged occupancy-safety + lookup-performance trajectory is
reworked (plus its minimal authoritative event wiring), every other manager and
the ATTEMPT16 traffic mechanics are preserved verbatim.

Edits (each asserted to match exactly once in the ATTEMPT15 source):
  E1   ReservationManager: add read-only getOwner(sectionId)                       (identical to ATTEMPT16)
  E2'  OccupancyManager: add _resolveOccupancyRecord / getOccupancyState / getOccupant
       - bounded direct shard resolution via SectionLocationIndex.getLocation (or
         Section.rootPos), keyed with the same rootPos-derived getShardKey used by
         setOccupied/setEmpty/setUnknown. NO all-shard scan, NO world scan, no mutation.
  E3'  NavigationManager.canEnterRouteSection: occupancy read via getOccupancyState
       (NO occupancy shard scan). Self-held reservation + UNKNOWN/CONFLICT occupancy
       => authoritative stale-held contract {canEnter:false, state:'held', stale:true,
       releaseWhenPossible:true}; next-train occupancy (KNOWN_OCCUPIED by other) still
       blocks; own occupancy remains allowed. Occupancy state is never mutated here.
  E4   Stage9 removeSections wrapper -> invalidateTrafficForSectionId              (identical to ATTEMPT16)
  E5   OccupancyManager.handleTrainDisappearance -> invalidateTrafficForTrainId    (identical to ATTEMPT16)
  E6   Replace ATTEMPT15 traffic block with the ATTEMPT17 block
       (strict KNOWN_EMPTY-only release gate; unknown/unloaded/probe-failed occupancy
        => NEVER release; eval-time loadTrafficOnWorldLoad removed)
  E7   Real worldLoaded handler calls loadTrafficOnWorldLoad(world19) at world load.
Both pack manifests bumped 1.1.6 -> 1.1.8 (header + cross-dependency).

Emits dev/patch_manifest_attempt17.json with the exact inserted line sets so the
test harness can whitelist the cumulative diff without string drift.
"""
import hashlib, json, os, sys, zipfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_MCADDON = os.path.join(
    REPO, os.environ.get("ATTEMPTA_PKG", "TRAINS_Phase1_Stage10_ATTEMPT15.mcaddon"))
OUT_MCADDON = os.path.join(
    REPO, os.environ.get("ATTEMPT_OUT", "TRAINS_Phase1_Stage10_ATTEMPT17.mcaddon"))
TRAFFIC_BLOCK = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                             os.environ.get("ATTEMPT_BLOCK", "traffic_block_attempt17.js"))
MANIFEST_OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "patch_manifest_attempt17.json")
BP_PREFIX = "TRAINS Urban Update Add-On/"
RP_PREFIX = "TRAINS Urban Update Add-On by matiss/"
MAIN_JS = BP_PREFIX + "scripts/main.js"
OLD_VER = [1, 1, 6]
NEW_VER = [1, 1, 8]

def fail(msg):
    print("BUILD FAILED: " + msg)
    sys.exit(1)

def replace_once(text, old, new, label):
    n = text.count(old)
    if n != 1:
        fail(f"{label}: anchor found {n} times (expected 1)")
    return text.replace(old, new, 1)

# ---------------- exact inserted texts (shared with the test harness via JSON) ----------------
E1_ADD = [
    "  // ATTEMPT16: minimal read-only authoritative ownership lookup for traffic arbitration.",
    "  // Reads the existing knownSectionToTrain state only - no duplicated state, no mutation.",
    "  getOwner(sectionId) { if (!sectionId) return null; try { const o = this.knownSectionToTrain.get(sectionId); return o ? o : null; } catch(e) { return null; } }",
]

E2_ADD = [
    "  // ATTEMPT17: bounded deterministic occupancy lookup. Resolves the section's authoritative occupancy",
    "  // shard DIRECTLY via the Stage8 SectionLocationIndex.getLocation (or the Section's rootPos), keyed with",
    "  // the same rootPos-derived getShardKey used by setOccupied/setEmpty/setUnknown. NEVER iterates loaded",
    "  // occupancy shards, never mutates, never auto-creates/loads shards for reads.",
    '  _resolveOccupancyRecord(sectionId, world) { if (!sectionId) return null; try { let dimId = null; let rootPos = null; try { if (typeof sectionLocationIndexManager !== "undefined" && sectionLocationIndexManager && sectionLocationIndexManager.getLocation) { const loc = sectionLocationIndexManager.getLocation(sectionId, world || null); if (loc) { if (loc.dimId) dimId = loc.dimId; if (loc.rootPos) rootPos = loc.rootPos; } } } catch (lerr) {} if ((!dimId || !rootPos) && typeof sectionManager !== "undefined" && sectionManager && sectionManager.shards) { for (const [sk, sShard] of sectionManager.shards) { if (sShard && sShard.sections && sShard.sections.has(sectionId)) { const sec = sShard.sections.get(sectionId); if (sec) { if (!dimId && sec.dimId) dimId = sec.dimId; if (!rootPos && sec.rootPos) rootPos = sec.rootPos; } break; } } } if (!dimId || !rootPos) return null; const shard = this.shards.get(this.getShardKey(dimId, rootPos)); if (!shard || !shard.records) return null; return shard.records.get(sectionId) || null; } catch (e) { return null; } }',
    "  // ATTEMPT17 safety contract: authoritative occupancy state for a section, or null when it cannot be",
    "  // established (unknown / unloaded / probe failed). Absent is NEVER free: only an authoritative",
    "  // KNOWN_EMPTY record proves a section is not occupied. Returns { state, trainId, trainIds } when known.",
    "  getOccupancyState(sectionId, world) { try { const rec = this._resolveOccupancyRecord(sectionId, world); if (!rec || !rec.state) return null; return { state: rec.state, trainId: rec.trainId || null, trainIds: (rec.trainIds && rec.trainIds.slice) ? rec.trainIds.slice() : [] }; } catch (e) { return null; } }",
    "  // ATTEMPT16: read-only occupant accessor (semantics unchanged). ATTEMPT17: direct shard resolve (no scan).",
    '  getOccupant(sectionId, world) { try { const rec = this._resolveOccupancyRecord(sectionId, world); if (rec && rec.state === "KNOWN_OCCUPIED") { if (rec.trainId) return rec.trainId; if (rec.trainIds && rec.trainIds.length) return rec.trainIds[0]; } return null; } catch (e) { return null; } }',
]

# NavigationManager.canEnterRouteSection occupancy check, ATTEMPT17 form (E3'). Two physical lines.
E3_NAV_HEAD = "      try { if (typeof occupancyManager !== \"undefined\" && occupancyManager.getOccupancyState) { const occInfo = occupancyManager.getOccupancyState(sectionId, world); if (occInfo && occInfo.state && (occInfo.state === 'UNKNOWN' || occInfo.state === 'CONFLICT')) { let __owner8 = null; try { if (typeof reservationManager !== \"undefined\" && reservationManager.getOwner) { __owner8 = reservationManager.getOwner(sectionId); } } catch(e9) {} if (__owner8 && __owner8 === trainId) { return {ok:true, canEnter:false, owner: trainId, state:'held', stale:true, releaseWhenPossible:true, reason:'stale_ahead_holding_pending_release'}; } return {ok:true, canEnter:false, state: occInfo.state, owner: (__owner8 || null), reason:'unknown_or_conflict_safely_blocked'}; } // ATTEMPT16 G-fix (ATTEMPT17 form): another train's KNOWN_OCCUPIED section blocks entry; own occupancy remains allowed. ATTEMPT17: direct shard resolution (no all-shard scan); self-held reservation + UNKNOWN/CONFLICT occupancy = authoritative stale-held contract (safe-fail, release-managed, never auto-synced)."
E3_NAV_TAIL = "if (occInfo && occInfo.state === 'KNOWN_OCCUPIED') { const occIds = []; try { if (occInfo.trainId) occIds.push(occInfo.trainId); if (occInfo.trainIds && occInfo.trainIds.length) { for (const oid of occInfo.trainIds) { if (oid && occIds.indexOf(oid) === -1) occIds.push(oid); } } } catch(e2) {} let __sameTrain = false; for (let __i = 0; __i < occIds.length; __i++) { if (occIds[__i] === trainId) { __sameTrain = true; break; } } if (!__sameTrain && occIds.length > 0) { return {ok:true, canEnter:false, state:'OCCUPIED_BY_OTHER', owner: occIds[0], reason:'occupied_by_other_train'}; } } } } catch(e) {}"

E4_ADD = "try{if(typeof invalidateTrafficForSectionId!==\"undefined\"&&invalidateTrafficForSectionId){invalidateTrafficForSectionId(id,world);}}catch(e){}"

E5_ADD = [
    "    // ATTEMPT16: notify traffic layer of disappearance (guarded hook; occupancy state untouched here).",
    "    // Traffic safely releases tracked reservations and only drops its record when all releases are confirmed.",
    "    try { if (typeof invalidateTrafficForTrainId !== 'undefined' && invalidateTrafficForTrainId) { invalidateTrafficForTrainId(trainId, world || null); } } catch(e) {}",
]

E7_ADD = [
    "  // ATTEMPT17: traffic records load at world load (authoritative re-read after restart), not at script eval.",
    "  try { if (typeof loadTrafficOnWorldLoad !== \"undefined\" && loadTrafficOnWorldLoad) { loadTrafficOnWorldLoad(world19); } } catch (e) {}",
]

def main():
    with zipfile.ZipFile(SRC_MCADDON, "r") as z:
        names = z.namelist()
        data = {name: z.read(name) for name in names}
    print(f"source ({os.path.basename(SRC_MCADDON)}) entries: {len(names)}")

    main_js = data[MAIN_JS].decode("utf-8")
    with open(TRAFFIC_BLOCK, "r", encoding="utf-8") as f:
        traffic_block = f.read()
    if "ATTEMPT17" not in traffic_block.split("\n", 1)[0]:
        fail("traffic block is not the ATTEMPT17 block")

    # ---------------- E1: ReservationManager.getOwner ----------------
    e1_anchor = "  getReservationsForTrain(trainId, world) { if (!trainId) return []; try { const set = this.knownTrainToSections.get(trainId); if (!set) return []; const out = []; for (const sid of set) { const shard = this.getOrCreateShard(sid, world); const rec = shard.records.get(sid); if (rec) out.push(rec); } return out; } catch(e) { return []; } }\n"
    e1_insert = e1_anchor + "\n".join(E1_ADD) + "\n"
    main_js = replace_once(main_js, e1_anchor, e1_insert, "E1 getOwner")

    # ---------------- E2': OccupancyManager direct-resolve occupancy APIs ----------------
    e2_anchor = "  findSectionsForRailPos(dimId, railPos, world) {\n    const sectionIds=[];"
    e2_insert = "\n".join(E2_ADD) + "\n" + e2_anchor
    main_js = replace_once(main_js, e2_anchor, e2_insert, "E2' occupancy direct-resolve APIs")

    # ---------------- E3': canEnterRouteSection direct occupancy contract ----------------
    e3_old = "      try { if (typeof occupancyManager !== 'undefined' && occupancyManager.shards) { for (const [k, shard] of occupancyManager.shards) { if (shard.records && shard.records.has(sectionId)) { const occ = shard.records.get(sectionId); if (occ) { if (occ.state === 'UNKNOWN' || occ.state === 'CONFLICT') { return {ok:true, canEnter:false, state: occ.state, reason:'unknown_or_conflict_safely_blocked'}; } } break; } } } } catch(e) {}"
    e3_new = E3_NAV_HEAD + "\n" + E3_NAV_TAIL
    main_js = replace_once(main_js, e3_old, e3_new, "E3' canEnter occupancy contract")

    # ---------------- E4: removeSections wrapper -> traffic invalidation ----------------
    e4_old = "drivingManager.invalidateForSectionId(id,world);\n}"
    e4_new = ("drivingManager.invalidateForSectionId(id,world);\n" + E4_ADD + "\n}")
    main_js = replace_once(main_js, e4_old, e4_new, "E4 wrapper traffic section invalidation")

    # ---------------- E5: handleTrainDisappearance -> traffic invalidation ----------------
    e5_old = "    this.lastTrainMembers.delete(trainId);\n    this.lastTrainPositions.delete(trainId);\n    return affected;"
    e5_new = ("\n".join(E5_ADD) + "\n"
              "    this.lastTrainMembers.delete(trainId);\n    this.lastTrainPositions.delete(trainId);\n    return affected;")
    main_js = replace_once(main_js, e5_old, e5_new, "E5 disappearance traffic hook")

    # ---------------- E6: replace ATTEMPT15 traffic block with ATTEMPT17 ----------------
    start_marker = "// Stage10 ATTEMPT15 layered on REAL Stage9 ATTEMPT5 c8cb356b - traffic fixes"
    end_marker = "// scripts/events/world.ts"
    si = main_js.find(start_marker)
    ei = main_js.find(end_marker)
    if si == -1 or ei == -1 or ei <= si:
        fail("E6: traffic block markers not found/inverted")
    main_js = main_js[:si] + traffic_block + main_js[ei:]

    # ---------------- E7: world-load traffic wiring (real worldLoaded handler) ----------------
    e7_old = ("function worldLoaded(_e) {\n"
              "  system26.runTimeout(() => {\n"
              "    WorldLoaded = true;\n"
              "  }, TicksPerSecond9 * 3);")
    e7_new = e7_old + "\n" + "\n".join(E7_ADD)
    main_js = replace_once(main_js, e7_old, e7_new, "E7 world-load traffic wiring")

    # ---------------- post-edit sanity: new surfaces present exactly once ----------------
    for label, needle in (
        ("getOccupancyState", "  getOccupancyState(sectionId, world) {"),
        ("_resolveOccupancyRecord", "  _resolveOccupancyRecord(sectionId, world) {"),
        ("getOccupant", "  getOccupant(sectionId, world) {"),
        ("getOwner", "  getOwner(sectionId) {"),
        ("stale contract", "stale_ahead_holding_pending_release"),
        ("E7 wiring", "loadTrafficOnWorldLoad(world19);"),
        ("ATTEMPT17 block", "// Stage10 ATTEMPT17 layered on REAL Stage9 ATTEMPT5 c8cb356b - traffic fixes"),
    ):
        if main_js.count(needle) != 1:
            fail(f"post-check {label}: found {main_js.count(needle)} occurrences, expected 1")
    # the old all-shard-scan occupancy nav line and ATTEMPT15 block must be gone
    if "reason:'unknown_or_conflict_safely_blocked'}; } break;" in main_js:
        fail("post-check: old shard-scanning nav occupancy line still present")
    if "// Stage10 ATTEMPT15 layered" in main_js:
        fail("post-check: ATTEMPT15 traffic block still present")

    data[MAIN_JS] = main_js.encode("utf-8")

    # ---------------- manifest version bumps -> [1,1,8] ----------------
    for prefix, other_uuid in ((BP_PREFIX, "56ca16b1-f4df-4512-b739-e72d8367d309"),
                               (RP_PREFIX, "ab5cde80-a5b3-48b1-85db-3048b2dbc6ab")):
        mname = prefix + "manifest.json"
        man = json.loads(data[mname].decode("utf-8"))
        assert man["header"]["version"] == OLD_VER, mname
        man["header"]["version"] = NEW_VER
        for dep in man.get("dependencies", []):
            if dep.get("uuid") == other_uuid:
                assert dep["version"] == OLD_VER, mname
                dep["version"] = NEW_VER
        data[mname] = json.dumps(man, separators=(",", ":")).encode("utf-8")

    # ---------------- write package ----------------
    if os.path.exists(OUT_MCADDON):
        os.remove(OUT_MCADDON)
    with zipfile.ZipFile(OUT_MCADDON, "w", zipfile.ZIP_DEFLATED) as z:
        for name in names:  # preserve original entry order
            z.writestr(name, data[name])

    # ---------------- emit patch manifest for the test harness ----------------
    with open(MANIFEST_OUT, "w", encoding="utf-8") as f:
        json.dump({
            "attempt": "17",
            "base": os.path.basename(SRC_MCADDON),
            "out": os.path.basename(OUT_MCADDON),
            "version": NEW_VER,
            "e1Add": E1_ADD, "e2Add": E2_ADD,
            "e3NavHead": E3_NAV_HEAD, "e3NavTail": E3_NAV_TAIL,
            "e3Old": e3_old,
            "e4Add": E4_ADD, "e5Add": E5_ADD, "e7Add": E7_ADD,
            "trafficStartMarker": "// Stage10 ATTEMPT17 layered on REAL Stage9 ATTEMPT5 c8cb356b - traffic fixes",
        }, f, indent=1)

    with open(OUT_MCADDON, "rb") as f:
        sha = hashlib.sha256(f.read()).hexdigest()
    size = os.path.getsize(OUT_MCADDON)
    lines = main_js.count("\n") + 1
    print(f"OK: wrote {OUT_MCADDON}")
    print(f"  SHA256: {sha}")
    print(f"  bytes:  {size}")
    print(f"  entries: {len(names)}")
    print(f"  main.js: {len(data[MAIN_JS])} bytes, {lines} lines")

if __name__ == "__main__":
    main()
