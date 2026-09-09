#!/usr/bin/env python3
"""
Build TRAINS_Phase1_Stage10_ATTEMPT16.mcaddon
=============================================
Fix-forward on the VERIFIED Stage10 ATTEMPT15 package (which is byte-verified
Stage9 ATTEMPT5 c8cb356b + one additive 105-line traffic hunk).

Edits (each asserted to match exactly once):
  E1  ReservationManager: add read-only getOwner(sectionId)          (Stage7 lineage)
  E2  OccupancyManager:   add read-only getOccupant(sectionId)       (Stage5 lineage)
  E3  NavigationManager.canEnterRouteSection: block KNOWN_OCCUPIED-by-other (Stage8 lineage)
  E4  Stage9 removeSections wrapper: wire invalidateTrafficForSectionId (integration hook)
  E5  OccupancyManager.handleTrainDisappearance: wire invalidateTrafficForTrainId (integration hook)
  E6  Replace ATTEMPT15 traffic block (5442..5546) with ATTEMPT16 traffic block
Both pack manifests are bumped 1.1.6 -> 1.1.7 (header + cross-dependency version)
so Bedrock cleanly upgrades the previously installed pack.

Everything else is byte-identical to ATTEMPT15/Stage9 ATTEMPT5.
"""
import hashlib, io, json, os, shutil, sys, zipfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_MCADDON = os.path.join(REPO, "TRAINS_Phase1_Stage10_ATTEMPT15.mcaddon")
OUT_MCADDON = os.path.join(REPO, "TRAINS_Phase1_Stage10_ATTEMPT16.mcaddon")
TRAFFIC_BLOCK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "traffic_block_attempt16.js")
BP_PREFIX = "TRAINS Urban Update Add-On/"
RP_PREFIX = "TRAINS Urban Update Add-On by matiss/"
MAIN_JS = BP_PREFIX + "scripts/main.js"

def fail(msg):
    print("BUILD FAILED: " + msg)
    sys.exit(1)

def replace_once(text, old, new, label):
    n = text.count(old)
    if n != 1:
        fail(f"{label}: anchor found {n} times (expected 1)")
    return text.replace(old, new, 1)

def main():
    with zipfile.ZipFile(SRC_MCADDON, "r") as z:
        names = z.namelist()
        data = {name: z.read(name) for name in names}
    print(f"source entries: {len(names)}")

    main_js = data[MAIN_JS].decode("utf-8")
    with open(TRAFFIC_BLOCK, "r", encoding="utf-8") as f:
        traffic_block = f.read()

    # ---------------- E1: ReservationManager.getOwner ----------------
    e1_anchor = "  getReservationsForTrain(trainId, world) { if (!trainId) return []; try { const set = this.knownTrainToSections.get(trainId); if (!set) return []; const out = []; for (const sid of set) { const shard = this.getOrCreateShard(sid, world); const rec = shard.records.get(sid); if (rec) out.push(rec); } return out; } catch(e) { return []; } }\n"
    e1_insert = e1_anchor + (
        "  // ATTEMPT16: minimal read-only authoritative ownership lookup for traffic arbitration.\n"
        "  // Reads the existing knownSectionToTrain state only - no duplicated state, no mutation.\n"
        "  getOwner(sectionId) { if (!sectionId) return null; try { const o = this.knownSectionToTrain.get(sectionId); return o ? o : null; } catch(e) { return null; } }\n"
    )
    main_js = replace_once(main_js, e1_anchor, e1_insert, "E1 getOwner")

    # ---------------- E2: OccupancyManager.getOccupant ----------------
    e2_anchor = "  findSectionsForRailPos(dimId, railPos, world) {\n    const sectionIds=[];"
    e2_insert = (
        "  // ATTEMPT16: minimal read-only authoritative occupancy lookup for traffic arbitration and the\n"
        "  // route-entry contract. Scans loaded shards only; returns occupant trainId when state is\n"
        "  // KNOWN_OCCUPIED, else null. No duplicated state, no mutation, no shard loading.\n"
        "  getOccupant(sectionId) { if (!sectionId) return null; try { for (const [k, shard] of this.shards) { if (shard.records && shard.records.has(sectionId)) { const rec = shard.records.get(sectionId); if (rec && rec.state === \"KNOWN_OCCUPIED\") { if (rec.trainId) return rec.trainId; if (rec.trainIds && rec.trainIds.length) return rec.trainIds[0]; return null; } return null; } } } catch(e) {} return null; }\n"
        + e2_anchor
    )
    main_js = replace_once(main_js, e2_anchor, e2_insert, "E2 getOccupant")

    # ---------------- E3: canEnterRouteSection KNOWN_OCCUPIED-by-other contract ----------------
    e3_old = "      try { if (typeof occupancyManager !== 'undefined' && occupancyManager.shards) { for (const [k, shard] of occupancyManager.shards) { if (shard.records && shard.records.has(sectionId)) { const occ = shard.records.get(sectionId); if (occ) { if (occ.state === 'UNKNOWN' || occ.state === 'CONFLICT') { return {ok:true, canEnter:false, state: occ.state, reason:'unknown_or_conflict_safely_blocked'}; } } break; } } } } catch(e) {}"
    e3_new = (
        "      try { if (typeof occupancyManager !== 'undefined' && occupancyManager.shards) { for (const [k, shard] of occupancyManager.shards) { if (shard.records && shard.records.has(sectionId)) { const occ = shard.records.get(sectionId); if (occ) { if (occ.state === 'UNKNOWN' || occ.state === 'CONFLICT') { return {ok:true, canEnter:false, state: occ.state, reason:'unknown_or_conflict_safely_blocked'}; } "
        "// ATTEMPT16 G-fix: another train's KNOWN_OCCUPIED section blocks entry; own occupancy remains allowed.\n"
        "if (occ.state === 'KNOWN_OCCUPIED') { const occIds = []; try { if (occ.trainId) occIds.push(occ.trainId); if (occ.trainIds && occ.trainIds.length) { for (const oid of occ.trainIds) { if (oid && occIds.indexOf(oid) === -1) occIds.push(oid); } } } catch(e2) {} if (occIds.length > 0 && occIds.indexOf(trainId) === -1) { return {ok:true, canEnter:false, state:'OCCUPIED_BY_OTHER', owner: occIds[0], reason:'occupied_by_other_train'}; } } } break; } } } } catch(e) {}"
    )
    main_js = replace_once(main_js, e3_old, e3_new, "E3 canEnter KNOWN_OCCUPIED")

    # ---------------- E4: removeSections wrapper -> traffic invalidation ----------------
    e4_old = "drivingManager.invalidateForSectionId(id,world);\n}"
    e4_new = (
        "drivingManager.invalidateForSectionId(id,world);\n"
        "try{if(typeof invalidateTrafficForSectionId!==\"undefined\"&&invalidateTrafficForSectionId){invalidateTrafficForSectionId(id,world);}}catch(e){}\n"
        "}"
    )
    main_js = replace_once(main_js, e4_old, e4_new, "E4 wrapper traffic section invalidation")

    # ---------------- E5: handleTrainDisappearance -> traffic invalidation ----------------
    e5_old = "    this.lastTrainMembers.delete(trainId);\n    this.lastTrainPositions.delete(trainId);\n    return affected;"
    e5_new = (
        "    // ATTEMPT16: notify traffic layer of disappearance (guarded hook; occupancy state untouched here).\n"
        "    // Traffic safely releases tracked reservations and only drops its record when all releases are confirmed.\n"
        "    try { if (typeof invalidateTrafficForTrainId !== 'undefined' && invalidateTrafficForTrainId) { invalidateTrafficForTrainId(trainId, world || null); } } catch(e) {}\n"
        "    this.lastTrainMembers.delete(trainId);\n    this.lastTrainPositions.delete(trainId);\n    return affected;"
    )
    main_js = replace_once(main_js, e5_old, e5_new, "E5 disappearance traffic hook")

    # ---------------- E6: replace ATTEMPT15 traffic block with ATTEMPT16 ----------------
    start_marker = "// Stage10 ATTEMPT15 layered on REAL Stage9 ATTEMPT5 c8cb356b - traffic fixes"
    end_marker = "// scripts/events/world.ts"
    si = main_js.find(start_marker)
    ei = main_js.find(end_marker)
    if si == -1 or ei == -1 or ei <= si:
        fail("E6: traffic block markers not found/inverted")
    main_js = main_js[:si] + traffic_block + main_js[ei:]

    data[MAIN_JS] = main_js.encode("utf-8")

    # ---------------- manifest version bumps 1.1.6 -> 1.1.7 ----------------
    for prefix, other_uuid in ((BP_PREFIX, "56ca16b1-f4df-4512-b739-e72d8367d309"),
                               (RP_PREFIX, "ab5cde80-a5b3-48b1-85db-3048b2dbc6ab")):
        mname = prefix + "manifest.json"
        man = json.loads(data[mname].decode("utf-8"))
        assert man["header"]["version"] == [1, 1, 6], mname
        man["header"]["version"] = [1, 1, 7]
        for dep in man.get("dependencies", []):
            if dep.get("uuid") == other_uuid:
                assert dep["version"] == [1, 1, 6], mname
                dep["version"] = [1, 1, 7]
        data[mname] = json.dumps(man, separators=(",", ":")).encode("utf-8")

    # ---------------- write package ----------------
    if os.path.exists(OUT_MCADDON):
        os.remove(OUT_MCADDON)
    with zipfile.ZipFile(OUT_MCADDON, "w", zipfile.ZIP_DEFLATED) as z:
        for name in names:  # preserve original entry order
            z.writestr(name, data[name])

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
