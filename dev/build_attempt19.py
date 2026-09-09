#!/usr/bin/env python3
"""
Build TRAINS_Phase1_Stage10_ATTEMPT19.mcaddon
=============================================
Smallest surgical fix-forward on the packaged ATTEMPT18 (691732e9): closes the
one consistency edge the forensic ownership-lifecycle audit disclosed.

Edit (asserted to match exactly once in the ATTEMPT18 source):
  E9  ReservationManager.releaseSection: in-memory owner map miss no longer answers
      blind {ok:true, state:'already_free'}. It now resolves ownership authoritatively:
        - deterministic 16x4 double-hash index -> in-memory shard hit, else direct
          ReservationShard.tryLoad of that ONE persisted shard (never iterate shard Maps);
        - adopted loaded shards are rebuilt into the in-memory owner indexes exactly like
          loadAll/getOrCreateShard (standard load semantics, no reservation-state semantics change);
        - resolved shard holds NO record  => {ok:true, state:'already_free'} (authoritatively free);
        - record owned by another train   => {ok:false, reason:'NOT_OWNER', owner}  (NO mutation);
        - record owned by trainId         => delete record, update both in-memory indexes,
          mark dirty + tickSave(1) => {ok:true, state:'RELEASED'} (persisted release);
        - unresolvable / probe failure    => {ok:false, reason:'ownership_unknown', state:'UNKNOWN'}
          (NEVER already_free).
      Normal in-memory-owner path and every other ATTEMPT18 mechanism are byte-preserved.
Both pack manifests bumped 1.1.9 -> 1.1.10 (header + cross-dependency).

Emits dev/patch_manifest_attempt19.json: e9Old/e9Add + the cumulative ATTEMPT18 insert set
(loaded from dev/patch_manifest_attempt18.json) for prefix whitelisting in the test harness.
"""
import hashlib, json, os, sys, zipfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEV = os.path.dirname(os.path.abspath(__file__))
SRC_MCADDON = os.path.join(REPO, os.environ.get("ATTEMPTA_PKG", "TRAINS_Phase1_Stage10_ATTEMPT18.mcaddon"))
OUT_MCADDON = os.path.join(REPO, os.environ.get("ATTEMPT_OUT", "TRAINS_Phase1_Stage10_ATTEMPT19.mcaddon"))
MANIFEST_OUT = os.path.join(DEV, "patch_manifest_attempt19.json")
PRIOR_MANIFEST = os.path.join(DEV, "patch_manifest_attempt18.json")
BP_PREFIX = "TRAINS Urban Update Add-On/"
RP_PREFIX = "TRAINS Urban Update Add-On by matiss/"
MAIN_JS = BP_PREFIX + "scripts/main.js"
OLD_VER = [1, 1, 9]
NEW_VER = [1, 1, 10]

def fail(msg):
    print("BUILD FAILED: " + msg)
    sys.exit(1)

def replace_once(text, old, new, label):
    n = text.count(old)
    if n != 1:
        fail(f"{label}: anchor found {n} times (expected 1)")
    return text.replace(old, new, 1)

E9_OLD = "      if (!existingOwner) { return {ok:true, state:'already_free'}; }"

E9_ADD = [
    "      if (!existingOwner) { // ATTEMPT19: in-memory owner map miss => authoritative ownership resolution (no blind already_free)",
    "        let ix19 = null; try { ix19 = this.getShardIndicesForSectionId(sectionId); } catch (eix) { ix19 = null; }",
    "        if (!ix19) { return {ok:false, reason:'ownership_unknown', state:'UNKNOWN'}; }",
    "        let authShard = null; try { authShard = this.shards.get(this.getShardKey(ix19.primary, ix19.sub)) || null; } catch (e0) { authShard = null; }",
    "        if (!authShard) {",
    "          if (!world) { return {ok:false, reason:'ownership_unknown', state:'UNKNOWN'}; }",
    "          try { authShard = ReservationShard.tryLoad(world, ix19.primary, ix19.sub); } catch (e1) { return {ok:false, reason:'ownership_unknown', state:'UNKNOWN'}; }",
    "          if (!authShard) { return {ok:false, reason:'ownership_unknown', state:'UNKNOWN'}; }",
    "          // adopt the authoritative persisted shard (identical rebuild semantics to loadAll/getOrCreateShard; DP untouched)",
    "          try { this.shards.set(this.getShardKey(ix19.primary, ix19.sub), authShard); for (const [rsid, rrec] of authShard.records) { this.knownSectionToTrain.set(rsid, rrec.trainId); let rset = this.knownTrainToSections.get(rrec.trainId); if (!rset) { rset = new Set(); this.knownTrainToSections.set(rrec.trainId, rset); } rset.add(rsid); } } catch (e2) {}",
    "        }",
    "        const authRec = (authShard && authShard.records) ? authShard.records.get(sectionId) : null;",
    "        if (!authRec || !authRec.trainId) { return {ok:true, state:'already_free'}; } // authoritative: the exact resolved shard proves free",
    "        if (authRec.trainId !== trainId) { return {ok:false, reason:'NOT_OWNER', owner: authRec.trainId}; } // foreign persisted owner: NO mutation",
    "        // self-owned persisted record: release exactly like the normal path (record, indexes, dirty, persisted flush)",
    "        authShard.records.delete(sectionId);",
    "        this.knownSectionToTrain.delete(sectionId);",
    "        const aset = this.knownTrainToSections.get(trainId);",
    "        if (aset) { aset.delete(sectionId); if (aset.size===0) this.knownTrainToSections.delete(trainId); }",
    "        this.markDirtyByKey(this.getShardKey(authShard.shardIndex, authShard.subIndex));",
    "        try { if (world) this.tickSave(world, 1); } catch(e) {}",
    "        return {ok:true, state:'RELEASED'};",
    "      }",
]

def main():
    with zipfile.ZipFile(SRC_MCADDON, "r") as z:
        names = z.namelist()
        data = {name: z.read(name) for name in names}
    if os.path.basename(SRC_MCADDON) != "TRAINS_Phase1_Stage10_ATTEMPT18.mcaddon":
        fail("source must be the packaged ATTEMPT18")
    print(f"source ({os.path.basename(SRC_MCADDON)}) entries: {len(names)}")

    main_js = data[MAIN_JS].decode("utf-8")

    # ---------------- E9: hardened releaseSection (single edit) ----------------
    main_js = replace_once(main_js, E9_OLD, "\n".join(E9_ADD), "E9 releaseSection authoritative-miss")

    # ---------------- post-edit sanity ----------------
    if main_js.count(E9_OLD) != 0:
        fail("post-check: old blind already_free line still present")
    if main_js.count("reason:'ownership_unknown'") != 4:
        fail(f"post-check: ownership_unknown returns found {main_js.count(chr(34)+'ownership_unknown'+chr(34))}, expected 4")
    ri = main_js.index("  releaseSection(sectionId, trainId, world) {")
    # balanced-brace body extraction
    d = 0; j = main_js.index("{", ri); body = None
    for k in range(j, len(main_js)):
        c = main_js[k]
        if c == "{": d += 1
        elif c == "}":
            d -= 1
            if d == 0:
                body = main_js[ri:k+1]; break
    if not body or "getShardIndicesForSectionId" not in body or "of this.shards)" in body or "getOwnershipState(" in body:
        fail("post-check: hardened releaseSection body invalid (must resolve deterministic shard, must not iterate this.shards, must not call the read-only API - no duplicated logic coupling)")
    # ATTEMPT18 surfaces must all still be present exactly once
    for label, needle in (
        ("getOwnershipState", "  getOwnershipState(sectionId, world) {"),
        ("_resolveOccupancyRecord", "  _resolveOccupancyRecord(sectionId, world) {"),
        ("getOccupancyState", "  getOccupancyState(sectionId, world) {"),
        ("getOccupant", "  getOccupant(sectionId, world) {"),
        ("getOwner", "  getOwner(sectionId) {"),
        ("stale contract", "stale_ahead_holding_pending_release"),
        ("E7 wiring", "loadTrafficOnWorldLoad(world19);"),
        ("ATTEMPT18 block", "// Stage10 ATTEMPT18 layered on REAL Stage9 ATTEMPT5 c8cb356b - traffic fixes"),
    ):
        if main_js.count(needle) != 1:
            fail(f"post-check {label}: found {main_js.count(needle)} occurrences, expected 1")

    data[MAIN_JS] = main_js.encode("utf-8")

    # ---------------- manifest version bumps 1.1.9 -> 1.1.10 ----------------
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

    # ---------------- emit patch manifest ----------------
    prior = json.loads(open(PRIOR_MANIFEST, "r", encoding="utf-8").read()) if os.path.exists(PRIOR_MANIFEST) else {}
    with open(MANIFEST_OUT, "w", encoding="utf-8") as f:
        json.dump({
            "attempt": "19",
            "base": os.path.basename(SRC_MCADDON),
            "out": os.path.basename(OUT_MCADDON),
            "version": NEW_VER,
            "e9Old": E9_OLD,
            "e9Add": E9_ADD,
            "prior18": prior,
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
