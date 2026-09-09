// Stage10 ATTEMPT18 test harness (M150-M192)
// Runs the REAL stage-stack code extracted verbatim from the packaged final main.js,
// under mocked @minecraft/server world/system. No test doubles for the code under test.
// Usage: node dev/stage10_attempt17_tests.mjs   (ATTEMPT_PKG env var overrides package name)
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const REPO = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const PKG_CURRENT = path.join(REPO, process.env.ATTEMPT_PKG || "TRAINS_Phase1_Stage10_ATTEMPT18.mcaddon");
const PKG_BASE = path.join(REPO, "TRAINS_Phase1_Stage10_ATTEMPT15.mcaddon");
const PKG9 = path.join(REPO, "TRAINS_Phase1_Stage9_ATTEMPT5.mcaddon");
const BLOCK_FILE = path.join(REPO, "dev", "traffic_block_attempt18.js");
const PATCH_FILE = path.join(REPO, "dev", "patch_manifest_attempt18.json");
const MAIN_IN_ZIP = "TRAINS Urban Update Add-On/scripts/main.js";

const S_CURRENT = execSync(`unzip -p "${PKG_CURRENT}" "${MAIN_IN_ZIP}"`).toString("utf-8");
const S_BASE = execSync(`unzip -p "${PKG_BASE}" "${MAIN_IN_ZIP}"`).toString("utf-8");
const S9 = execSync(`unzip -p "${PKG9}" "${MAIN_IN_ZIP}"`).toString("utf-8");
const BLOCK_CURRENT = fs.readFileSync(BLOCK_FILE, "utf-8");
const PATCH = JSON.parse(fs.readFileSync(PATCH_FILE, "utf-8"));

// ---------- stage-stack extraction (verbatim slice from the REAL packaged main.js) ----------
const STACK_START = "// scripts/track_graph/model.ts";
const STACK_END = "// scripts/events/world.ts";
function extractStack(src) {
  const a = src.indexOf(STACK_START), b = src.indexOf(STACK_END);
  if (a < 0 || b < 0 || b <= a) throw new Error("stack markers not found");
  return src.slice(a, b);
}
const STACK_CURRENT = extractStack(S_CURRENT);
const STACK_BASE = extractStack(S_BASE);
const STACK9 = extractStack(S9);

// ---------- mocked Bedrock runtime ----------
function makeSystem() {
  return {
    currentTick: 1000, _intervals: [], _nextId: 1,
    runInterval(cb, p) { const id = this._nextId++; this._intervals.push({ id, cb, p }); return id; },
    clearRun(id) { this._intervals = this._intervals.filter(i => i.id !== id); },
    runJob(g) { try { const gen = typeof g === "function" ? g() : g; let r = gen.next(), guard = 0; while (!r.done && guard++ < 200000) r = gen.next(); } catch (e) {} return 1; },
    runTimeout() { return 0; },
  };
}
function makeWorld() {
  const dp = new Map();
  return {
    _dp: dp,
    getDynamicProperty(k) { return dp.get(k); },
    setDynamicProperty(k, v) { if (v === undefined) dp.delete(k); else dp.set(k, v); },
    getDynamicPropertyIds() { return Array.from(dp.keys()); },
    getDynamicProperties() { return Array.from(dp.keys()); },
    getDynamicPropertyTotalByteCount() { let t = 0; for (const v of dp.values()) t += String(v).length; return t; },
    getDimension(id) { return { id, getEntities() { return []; }, getBlock() { return undefined; } }; },
    getPlayers() { return []; },
  };
}

const PRELUDE = `
const __tk = globalThis.__T18__;
const world8=__tk.world, world5=__tk.world, world19=__tk.world;
const system9=__tk.system, system14=__tk.system, system15=__tk.system, system25=__tk.system, system=__tk.system;
`;
const EXPORTS = `
export { trackGraphManager, graphPointManager, sectionManager, occupancyManager, trainIdentityManager,
 reservationManager, sectionLocationIndexManager, navigationManager, drivingManager, trafficManager,
 TrafficRecord, OccupancyRecord, ReservationRecord, NavigationRecord, DrivingRecord, Section, SectionShard, OccupancyShard,
 ReservationShard, NavigationShard, DrivingShard, SectionIndexRecord, SectionLocationIndexShard,
 safelyReleaseTrafficReservation, tickTrafficCoordinator, tickTrafficSave, loadTrafficOnWorldLoad,
 invalidateTrafficForSectionId, invalidateTrafficForTrainId, getTrafficState, getOccupancyTick,
 makeTrainIdFromMembers, makeSplitTrainId, reserveSection, reserveSections, releaseSection,
 canEnterRouteSection, setAutonomousMode, getDrivingState, getNavigationState, resolveLeadingCurrentSection };
`;

let importCounter = 0;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "t18h-"));
const wrappedPath = path.join(tmpDir, "stage_stack_wrapped18.mjs");
fs.writeFileSync(wrappedPath, PRELUDE + STACK_CURRENT + EXPORTS, "utf-8");
async function freshModule(world, system) {
  globalThis.__T18__ = { world: world || makeWorld(), system: system || makeSystem() };
  const mod = await import(pathToFileURL(wrappedPath).href + "?case=" + (++importCounter));
  // ATTEMPT17: traffic records load at world load (E7 wiring); harness replays the world-load moment.
  try { mod.loadTrafficOnWorldLoad(globalThis.__T18__.world); } catch (e) {}
  return { E: mod, world: globalThis.__T18__.world, system: globalThis.__T18__.system };
}

// ---------- seed helpers (structural, using the real classes/managers) ----------
const DIM = "minecraft:overworld";
const ROOT = { x: 8, y: 64, z: 8 };
function seedSections(E, dimId, ids, boundary = "B1") {
  const key = "pod_trn_section_shard_" + dimId.replace(/[^a-z0-9_]/gi, "_").slice(0, 24) + "_0_0";
  let shard = E.sectionManager.shards.get(key);
  if (!shard) { shard = new E.SectionShard(dimId, 0, 0); E.sectionManager.shards.set(key, shard); }
  for (const id of ids) {
    const sec = new E.Section(id, dimId, boundary, "B2", "EAST", [], [], 64, [], [], ROOT);
    sec.state = "KNOWN"; shard.sections.set(id, sec);
    // Stage8 authoritative location index entry (hash-sharded lookup path used by ATTEMPT17 occupancy resolve)
    E.sectionLocationIndexManager.knownSectionToLocation.set(id, { sectionId: id, dimId, shardX: 0, shardZ: 0, rootPos: ROOT });
  }
  return shard;
}
function occShard(E, dimId) {
  const key = "pod_trn_occupancy_shard_" + dimId.replace(/[^a-z0-9_]/gi, "_").slice(0, 24) + "_0_0";
  let shard = E.occupancyManager.shards.get(key);
  if (!shard) { shard = new E.OccupancyShard(dimId, 0, 0); E.occupancyManager.shards.set(key, shard); }
  return shard;
}
function setOccupancy(E, dimId, sid, state, trainId) {
  const shard = occShard(E, dimId);
  shard.records.set(sid, new E.OccupancyRecord(sid, dimId, state, trainId || null, [], 1000, null));
  // keep Stage5's authoritative coverage structure (lastTrainPositions: Map<trainId, Map<sectionId, railPos>>) coherent
  for (const [t, m] of E.occupancyManager.lastTrainPositions) { try { if (m && m.delete) m.delete(sid); } catch (e) {} }
  if (state === "KNOWN_OCCUPIED" && trainId) {
    let m = E.occupancyManager.lastTrainPositions.get(trainId);
    if (!m) { m = new Map(); E.occupancyManager.lastTrainPositions.set(trainId, m); }
    m.set(sid, { x: 8, y: 64, z: 8 });
  }
}
function seedNavRoute(E, tid, route) {
  const shard = E.navigationManager.getOrCreateShard(tid, null);
  const rec = new E.NavigationRecord(tid, null, route[route.length - 1], "section", route.slice(), 1, "ROUTED", 1000, 1000);
  shard.records.set(tid, rec);
  return rec;
}
function seedAutonomous(E, tid) { return E.setAutonomousMode(tid, true, null); }

// ---------- tiny test framework ----------
let pass = 0, failN = 0; const failures = [];
function ok(cond, id, msg) { if (cond) { pass++; console.log(`  PASS ${id} ${msg}`); } else { failN++; failures.push(`${id}: ${msg}`); console.log(`  FAIL ${id} ${msg}`); } }
function section(t) { console.log(`\n== ${t}`); }
function bodyOf(src, anchor) {
  const i = src.indexOf(anchor); if (i < 0) throw new Error("anchor missing " + anchor);
  let d = 0, j = src.indexOf("{", i);
  for (let k = j; k < src.length; k++) { const c = src[k]; if (c === "{") d++; else if (c === "}") { d--; if (d === 0) return src.slice(i, k + 1); } }
  throw new Error("unbalanced " + anchor);
}

// ================================================================ M150-M156: releases + read APIs
section("M150 reservation releases behind moving train");
{
  const { E, world } = await freshModule();
  const T = "TRN_A";
  seedSections(E, DIM, ["S0", "S1", "S2", "S3", "S4", "S5", "S6"]);
  seedNavRoute(E, T, ["S0", "S1", "S2", "S3", "S4", "S5", "S6"]);
  seedAutonomous(E, T);
  setOccupancy(E, DIM, "S0", "KNOWN_OCCUPIED", T);
  let r = E.tickTrafficCoordinator(world, 8);
  ok(E.reservationManager.getOwner("S1") === T && E.reservationManager.getOwner("S5") === T, "M150-setup", "forward sections reserved");
  // train advances: now occupies only S2; vacated sections are positively KNOWN_EMPTY (Stage5 authoritative)
  setOccupancy(E, DIM, "S0", "KNOWN_EMPTY", null); setOccupancy(E, DIM, "S1", "KNOWN_EMPTY", null); setOccupancy(E, DIM, "S2", "KNOWN_OCCUPIED", T);
  r = E.tickTrafficCoordinator(world, 8);
  const rec = E.trafficManager.records.get(T);
  ok(E.reservationManager.getOwner("S1") === null, "M150", "behind section S1 released (positively known free)");
  ok(E.reservationManager.getOwner("S2") === T, "M150", "occupied section S2 NOT released");
  ok(E.reservationManager.getOwner("S3") === T && E.reservationManager.getOwner("S5") === T, "M150", "ahead reservations retained");
  ok(E.reservationManager.getOwner("S6") === T, "M150", "horizon extended to S6");
  ok(rec && rec.reservedSections.indexOf("S1") === -1, "M150", "traffic tracking dropped for S1");
}

section("M151 destination completion releases + stale-ahead holding contract");
{
  const { E, world } = await freshModule();
  const T = "TRN_B";
  seedSections(E, DIM, ["D0", "D1", "D2"]);
  seedNavRoute(E, T, ["D0", "D1", "D2"]);
  seedAutonomous(E, T);
  setOccupancy(E, DIM, "D0", "KNOWN_OCCUPIED", T);
  E.tickTrafficCoordinator(world, 8);
  ok(E.reservationManager.getOwner("D1") === T, "M151-setup", "reserved ahead while en route");
  // arrive: occupies final section only; vacated section is positively KNOWN_EMPTY
  setOccupancy(E, DIM, "D0", "KNOWN_EMPTY", null); setOccupancy(E, DIM, "D1", "KNOWN_EMPTY", null); setOccupancy(E, DIM, "D2", "KNOWN_OCCUPIED", T);
  E.tickTrafficCoordinator(world, 8);
  ok(E.reservationManager.getOwner("D1") === null, "M151", "vacated sections released at destination (positively known free)");
  ok(E.reservationManager.getOwner("D2") === T, "M151", "occupied destination section retained");
  const rec = E.trafficManager.records.get(T);
  ok(rec && rec.reservedSections.indexOf("D2") !== -1 && rec.claimedSections.length === 0, "M151", "claims cleared; occupied tracking retained for safe release retry");
  // ATTEMPT17 stale-held contract: self-held reservation whose occupancy became UNKNOWN is reported as
  // authoritative stale-held (safe-fail), retention is purely reservation-managed, never auto-synced.
  setOccupancy(E, DIM, "D0", "UNKNOWN", null);
  E.reserveSections(["D0"], T, world); // previously-issued reservation now sitting on UNKNOWN occupancy
  const c = E.canEnterRouteSection("D0", T, world);
  ok(c && c.canEnter === false && c.state === "held" && c.stale === true && c.releaseWhenPossible === true && c.owner === T, "M151-stale", `authoritative stale-ahead holding contract (${JSON.stringify(c)})`);
  ok(E.reservationManager.getOwner("D0") === T, "M151-stale", "stale retention is reservation-managed (no auto-sync / implicit release from occupancy)");
  const st = E.occupancyManager.getOccupancyState("D0", world);
  ok(st && st.state === "UNKNOWN", "M151-stale", "contract evaluation is read-only (occupancy state untouched)");
}

section("M152 occupied section never released");
{
  const { E, world } = await freshModule();
  E.reserveSections(["XO"], "TRN_X", world);
  setOccupancy(E, DIM, "XO", "KNOWN_OCCUPIED", "TRN_X");
  const rec = new E.TrafficRecord("TRN_X"); rec.reservedSections = ["XO"];
  const rel = E.safelyReleaseTrafficReservation("TRN_X", ["XO"], world, rec, new Set(["XO"]));
  ok(rel === 0, "M152", "helper released 0");
  ok(E.reservationManager.getOwner("XO") === "TRN_X", "M152", "reservation intact");
  ok(rec.reservedSections.indexOf("XO") !== -1, "M152", "tracking retained");
}

section("M153 failed release remains tracked");
{
  const { E, world } = await freshModule();
  seedSections(E, DIM, ["FY"]);
  E.reserveSections(["FY"], "TRN_F", world);
  setOccupancy(E, DIM, "FY", "KNOWN_EMPTY", null);
  const rec = new E.TrafficRecord("TRN_F"); rec.reservedSections = ["FY"];
  const orig = E.reservationManager.releaseSection;
  E.reservationManager.releaseSection = () => ({ ok: false, reason: "forced_fail" });
  const rel = E.safelyReleaseTrafficReservation("TRN_F", ["FY"], world, rec, new Set());
  E.reservationManager.releaseSection = orig;
  ok(rel === 0 && rec.reservedSections.indexOf("FY") !== -1, "M153", "retained after forced release failure");
  ok(E.reservationManager.getOwner("FY") === "TRN_F", "M153", "still owner after failure");
}

section("M154 unknown ownership (probe failure) remains tracked");
{
  const { E, world } = await freshModule();
  seedSections(E, DIM, ["FU"]);
  E.reserveSections(["FU"], "TRN_U", world);
  setOccupancy(E, DIM, "FU", "KNOWN_EMPTY", null);
  const rec = new E.TrafficRecord("TRN_U"); rec.reservedSections = ["FU"];
  const origO = E.reservationManager.getOwnershipState, origR = E.reservationManager.releaseSection;
  let releaseCalls = 0;
  E.reservationManager.getOwnershipState = () => { throw new Error("ownership_probe_failed"); };
  E.reservationManager.releaseSection = (...a) => { releaseCalls++; throw new Error("must_not_be_called_when_unknown"); };
  const rel = E.safelyReleaseTrafficReservation("TRN_U", ["FU"], world, rec, new Set());
  E.reservationManager.getOwnershipState = origO; E.reservationManager.releaseSection = origR;
  ok(rel === 0 && releaseCalls === 0 && rec.reservedSections.indexOf("FU") !== -1, "M154", "ownership probe failure => UNKNOWN => retained, release never attempted");
  const st = E.reservationManager.getOwnershipState("FU", world);
  ok(st && st.state === "OWNED" && st.owner === "TRN_U" && E.reservationManager.getOwner("FU") === "TRN_U", "M154", "reservation intact after probe recovery");
}

section("M155 getOwner returns authoritative Stage7 ownership");
{
  const { E, world } = await freshModule();
  E.reserveSections(["ZO"], "TRN_Z", world);
  ok(E.reservationManager.getOwner("ZO") === "TRN_Z", "M155", "getOwner === reservation owner");
  ok(E.reservationManager.getOwner("ZO") === E.reservationManager.knownSectionToTrain.get("ZO"), "M155", "identical to authoritative knownSectionToTrain (no duplicate state)");
  E.releaseSection("ZO", "TRN_Z", world);
  ok(E.reservationManager.getOwner("ZO") === null, "M155", "null after release");
  ok(E.reservationManager.getOwner("MISSING") === null, "M155", "null for unknown section");
}

section("M156 getOccupant / getOccupancyState return authoritative Stage5 occupancy");
{
  const { E, world } = await freshModule();
  seedSections(E, DIM, ["OQ", "OU"]);
  setOccupancy(E, DIM, "OQ", "KNOWN_OCCUPIED", "TRN_Q");
  setOccupancy(E, DIM, "OU", "UNKNOWN", null);
  ok(E.occupancyManager.getOccupant("OQ") === "TRN_Q", "M156", "KNOWN_OCCUPIED -> occupant");
  ok(E.occupancyManager.getOccupant("OU") === null, "M156", "UNKNOWN -> null");
  ok(E.occupancyManager.getOccupant("ABSENT") === null, "M156", "missing -> null");
  ok(E.occupancyManager.getOccupant("OQ") === "TRN_Q" && E.occupancyManager.lastTrainPositions.get("TRN_Q").has("OQ"), "M156", "read-only, authoritative");
  const st = E.occupancyManager.getOccupancyState("OQ", world);
  ok(st && st.state === "KNOWN_OCCUPIED" && st.trainId === "TRN_Q" && Array.isArray(st.trainIds), "M156-state", "getOccupancyState returns authoritative { state, trainId, trainIds }");
  const stU = E.occupancyManager.getOccupancyState("OU", world);
  ok(stU && stU.state === "UNKNOWN" && stU.trainId === null, "M156-state", "UNKNOWN state passed through (not 'free')");
  ok(E.occupancyManager.getOccupancyState("ABSENT", world) === null, "M156-state", "absent/unresolvable => null (never 'free')");
}

// ================================================================ M157-M159: persistence
section("M157 traffic persistence loads after restart");
{
  const world = makeWorld(); let system = makeSystem();
  let r = await freshModule(world, system);
  const T = "TRN_P";
  const rec = new r.E.TrafficRecord(T); rec.reservedSections = ["P1", "P2"]; rec.claimedSections = ["P3"]; rec.waitingTicks = 4; rec.priority = 2;
  r.E.trafficManager.records.set(T, rec);
  r.E.tickTrafficSave(world);
  ok(world.getDynamicProperty("traffic:" + T) !== undefined, "M157-setup", "DP written");
  // simulate restart: same world, fresh module (fresh managers); traffic loads at world load (E7 wiring)
  system = makeSystem();
  r = await freshModule(world, system);
  const rec2 = r.E.trafficManager.records.get(T);
  ok(!!rec2, "M157", "record loaded at world load");
  ok(rec2 && JSON.stringify(rec2.reservedSections) === JSON.stringify(["P1", "P2"]) && rec2.waitingTicks === 4 && rec2.priority === 2, "M157", "fields round-tripped");
  ok(rec2 && rec2.version === 1, "M157", "version field present");
  ok(r.E.trafficManager.getClaimsForSection("P3").some(c => c.trainId === T), "M157", "claims rebuilt from persisted state");
}

section("M158 save cursor advances (no first-record starvation)");
{
  const { E, world } = await freshModule();
  for (let i = 0; i < 5; i++) E.trafficManager.records.set("CUR_" + i, new E.TrafficRecord("CUR_" + i));
  const seenPerCall = []; const seenAll = new Set();
  for (let call = 0; call < 3; call++) {
    const before = new Set(world.getDynamicPropertyIds());
    E.tickTrafficSave(world);
    const wrote = world.getDynamicPropertyIds().filter(k => k.startsWith("traffic:") && !before.has(k));
    seenPerCall.push(wrote.slice().sort().join(",")); for (const k of wrote) seenAll.add(k);
  }
  ok(seenAll.size === 5, "M158", `all 5 records persisted across passes (got ${seenAll.size})`);
  ok(seenPerCall[1] !== seenPerCall[0], "M158", "cursor advanced between calls");
}

section("M159 removed traffic DP is cleaned on definitive delete");
{
  const { E, world } = await freshModule();
  const T = "TRN_GONE";
  seedSections(E, DIM, ["GD"]);
  E.reserveSections(["GD"], T, world);
  setOccupancy(E, DIM, "GD", "KNOWN_EMPTY", null);
  const rec = new E.TrafficRecord(T); rec.reservedSections = ["GD"];
  E.trafficManager.records.set(T, rec);
  E.trafficManager.tickSave(world, 10);
  ok(world.getDynamicProperty("traffic:" + T) !== undefined, "M159-setup", "DP prewritten");
  E.invalidateTrafficForTrainId(T, world);
  ok(!E.trafficManager.records.has(T), "M159", "record deleted when releases confirmed");
  ok(world.getDynamicProperty("traffic:" + T) === undefined, "M159", "traffic DP removed");
  ok(E.reservationManager.getOwner("GD") === null, "M159", "reservation released (positively known free)");
}

// ================================================================ M160-M161: invalidation wiring
section("M160 traffic invalidates on section topology change (real wrapper chain)");
{
  const { E, world } = await freshModule();
  const T = "TRN_T";
  seedSections(E, DIM, ["TS0"], "BND1");
  E.reserveSections(["TS0"], T, world);
  const rec = new E.TrafficRecord(T); rec.reservedSections = ["TS0"]; rec.claimedSections = ["TS0"];
  E.trafficManager.records.set(T, rec);
  E.trafficManager.upsertClaim("TS0", T, 0, rec);
  E.sectionManager.removeSectionsForBoundary(DIM, "BND1", world, { x: 8, y: 0, z: 8 });
  ok(E.trafficManager.getClaimsForSection("TS0").length === 0, "M160", "claims purged for removed section");
  ok(rec.reservedSections.indexOf("TS0") === -1, "M160", "traffic tracking dropped (authoritative free after Stage7 removal)");
  ok(E.reservationManager.getOwner("TS0") === null, "M160", "reservation removed by Stage7 chain");
}

section("M161 traffic invalidates on train disappearance (real Stage5 hook)");
{
  const { E, world } = await freshModule();
  const T = "TRN_D";
  seedSections(E, DIM, ["HA", "HB"]);
  setOccupancy(E, DIM, "HA", "KNOWN_OCCUPIED", T);
  setOccupancy(E, DIM, "HB", "KNOWN_EMPTY", null); // forward reservation section the train positively vacated
  E.reserveSections(["HB"], T, world);
  const rec = new E.TrafficRecord(T); rec.reservedSections = ["HB"]; E.trafficManager.records.set(T, rec);
  E.occupancyManager.handleTrainDisappearance(T, DIM, world);
  ok(E.reservationManager.getOwner("HB") === null, "M161", "disappeared train's reservations safely released (positively known free)");
  ok(!E.trafficManager.records.has(T), "M161", "record deleted after confirmed releases");
}

section("M161b uncertain release retains record for retry");
{
  const { E, world } = await freshModule();
  const T = "TRN_R";
  seedSections(E, DIM, ["RU"]);
  E.reserveSections(["RU"], T, world);
  setOccupancy(E, DIM, "RU", "KNOWN_EMPTY", null);
  const rec = new E.TrafficRecord(T); rec.reservedSections = ["RU"]; E.trafficManager.records.set(T, rec);
  const orig = E.reservationManager.releaseSection;
  E.reservationManager.releaseSection = () => ({ ok: false, reason: "forced" });
  E.occupancyManager.handleTrainDisappearance(T, DIM, world);
  ok(E.trafficManager.records.has(T), "M161b", "record retained when release failed");
  ok(E.trafficManager._releaseRetryQueue.indexOf(T) !== -1, "M161b", "queued for bounded retry");
  E.reservationManager.releaseSection = orig;
  E.tickTrafficCoordinator(world, 8); // retry path
  ok(E.reservationManager.getOwner("RU") === null, "M161b", "retry released after recovery");
  ok(!E.trafficManager.records.has(T), "M161b", "record deleted once confirmed");
}

// ================================================================ M162-M163: Stage9 safety contract
section("M162 canEnterRouteSection blocks other train's KNOWN_OCCUPIED");
{
  const { E, world } = await freshModule();
  seedSections(E, DIM, ["BK"]);
  setOccupancy(E, DIM, "BK", "KNOWN_OCCUPIED", "TRN_OTHER");
  const r = E.canEnterRouteSection("BK", "TRN_ME", world);
  ok(r && r.canEnter === false && r.state === "OCCUPIED_BY_OTHER", "M162", `blocked with OCCUPIED_BY_OTHER (got ${JSON.stringify(r)})`);
  ok(r.owner === "TRN_OTHER", "M162", "reports occupant");
}

section("M163 own occupancy / own reservation remain valid; unknown/conflict still blocked");
{
  const { E, world } = await freshModule();
  seedSections(E, DIM, ["OW", "CF", "MS"]);
  setOccupancy(E, DIM, "OW", "KNOWN_OCCUPIED", "TRN_ME");
  let r = E.canEnterRouteSection("OW", "TRN_ME", world);
  ok(r && r.canEnter === true, "M163", "own KNOWN_OCCUPIED allowed");
  E.reserveSections(["OW"], "TRN_ME", world);
  r = E.canEnterRouteSection("OW", "TRN_ME", world);
  ok(r && r.canEnter === true, "M163", "own reservation + own occupancy allowed");
  r = E.canEnterRouteSection("OW", "TRN_ME2", world);
  ok(r && r.canEnter === false, "M163", "other train blocked (occupancy) even with occupancy state KNOWN");
  setOccupancy(E, DIM, "CF", "CONFLICT", null);
  r = E.canEnterRouteSection("CF", "TRN_ME", world);
  ok(r && r.canEnter === false && (r.state === "CONFLICT"), "M163", "CONFLICT (unreserved) still blocked generically");
  r = E.canEnterRouteSection("MS_NOT_SEEDED", "TRN_ME", world);
  ok(r && r.canEnter === false && r.state === "MISSING_SECTION", "M163", "missing section still blocked");
  seedSections(E, DIM, ["FF"]); setOccupancy(E, DIM, "FF", "KNOWN_EMPTY", null);
  r = E.canEnterRouteSection("FF", "TRN_ME", world);
  ok(r && r.canEnter === true && r.state === "FREE_OR_OWN_RESERVATION", "M163", "free section still enterable (no over-blocking)");
}

// ================================================================ M164-M165: first-seen priority / order independence
section("M164 first-seen contender is not missed by arbitration");
{
  const { E, world } = await freshModule();
  seedSections(E, DIM, ["HA2", "HB2", "SM"]);
  seedNavRoute(E, "TRN_A", ["HA2", "SM"]);
  seedNavRoute(E, "TRN_B", ["HB2", "SM"]);
  seedAutonomous(E, "TRN_A"); seedAutonomous(E, "TRN_B");
  setOccupancy(E, DIM, "HA2", "KNOWN_OCCUPIED", "TRN_A");
  setOccupancy(E, DIM, "HB2", "KNOWN_OCCUPIED", "TRN_B");
  E.tickTrafficCoordinator(world, 8);
  ok(E.trafficManager.records.has("TRN_A"), "M164", "first-seen train received TrafficRecord within one pass");
  ok(E.reservationManager.getOwner("SM") === "TRN_A", "M164", "deterministic tie-break gives SM to TRN_A (equal priority, lexicographic)");
}

section("M165 priority arbitration independent of cursor/insertion order/record existence");
{
  const outcomes = [];
  for (let variant = 0; variant < 4; variant++) {
    const { E, world } = await freshModule();
    seedSections(E, DIM, ["PA", "PB", "SH"]);
    const order = variant % 2 === 0 ? ["TRN_A", "TRN_B"] : ["TRN_B", "TRN_A"];
    for (const t of order) { seedNavRoute(E, t, [t === "TRN_A" ? "PA" : "PB", "SH"]); seedAutonomous(E, t); }
    if (variant >= 2) { const rec = new E.TrafficRecord("TRN_ZZ"); E.trafficManager.records.set("TRN_ZZ", rec); } // pre-existing unrelated record
    setOccupancy(E, DIM, "PA", "KNOWN_OCCUPIED", "TRN_A");
    setOccupancy(E, DIM, "PB", "KNOWN_OCCUPIED", "TRN_B");
    E.tickTrafficCoordinator(world, 8);
    outcomes.push(E.reservationManager.getOwner("SH"));
  }
  ok(outcomes.every(o => o === "TRN_A"), "M165", `same winner under all orderings (got ${outcomes.join(",")})`);
  const { E } = await freshModule();
  ok(E.trafficManager.effectivePriorityFor("NEVER_SEEN") === 0, "M165", "record-less contender evaluates purely (0)");
}

// ================================================================ M166-M167: bounded mutations / no unbounded scans
section("M166 max 8 actual traffic mutations per tick preserved");
{
  const { E, world } = await freshModule();
  const N = 20;
  const ids = [];
  for (let i = 0; i < N; i++) { const t = "BULK_" + String(i).padStart(2, "0"); ids.push(t); seedSections(E, DIM, ["H" + i]); seedNavRoute(E, t, ["H" + i, "M0", "M1", "M2"]); seedAutonomous(E, t); setOccupancy(E, DIM, "H" + i, "KNOWN_OCCUPIED", t); }
  seedSections(E, DIM, ["M0", "M1", "M2"]);
  let reserveCalls = 0, releaseCalls = 0;
  const oRes = E.reservationManager.reserveSections, oRel = E.reservationManager.releaseSection;
  E.reservationManager.reserveSections = (...a) => { reserveCalls++; return oRes.apply(E.reservationManager, a); };
  E.reservationManager.releaseSection = (...a) => { releaseCalls++; return oRel.apply(E.reservationManager, a); };
  let maxCalls = 0, maxMut = 0;
  for (let pass = 0; pass < 12; pass++) {
    reserveCalls = 0; releaseCalls = 0;
    const r = E.tickTrafficCoordinator(world, 8);
    const calls = reserveCalls + releaseCalls;
    maxCalls = Math.max(maxCalls, calls); maxMut = Math.max(maxMut, r.mutations || 0);
    if (calls > 8) { ok(false, "M166", `pass ${pass}: ${calls} mutation calls > 8`); break; }
    if (r.mutations > 8) { ok(false, "M166", `pass ${pass}: reported ${r.mutations} mutations > 8`); break; }
    if (pass === 11) { ok(true, "M166", `12 passes, max reserve+release calls/pass = ${maxCalls}, max reported mutations/pass = ${maxMut}, both <= 8`); }
  }
  E.reservationManager.reserveSections = oRes; E.reservationManager.releaseSection = oRel;
}

section("M166b mutation budget clamp under simultaneous release+reserve pressure");
{
  const { E, world } = await freshModule();
  const N = 20;
  for (let i = 0; i < N; i++) {
    const t = "PRV_" + String(i).padStart(2, "0");
    seedSections(E, DIM, ["B_" + i, "P0_" + i, "P1_" + i]);
    seedNavRoute(E, t, ["B_" + i, "P0_" + i, "P1_" + i]);
    seedAutonomous(E, t);
    setOccupancy(E, DIM, "P0_" + i, "KNOWN_OCCUPIED", t);
    setOccupancy(E, DIM, "B_" + i, "KNOWN_EMPTY", null); // positively vacated (held reservation is stale)
    E.reserveSections(["B_" + i], t, world); // tracked stale behind-reservation
    const rec = new E.TrafficRecord(t); rec.reservedSections = ["B_" + i];
    E.trafficManager.records.set(t, rec);
  }
  let reserveCalls = 0, releaseCalls = 0;
  const oRes = E.reservationManager.reserveSections, oRel = E.reservationManager.releaseSection;
  E.reservationManager.reserveSections = (...a) => { reserveCalls++; return oRes.apply(E.reservationManager, a); };
  E.reservationManager.releaseSection = (...a) => { releaseCalls++; return oRel.apply(E.reservationManager, a); };
  const callsPerPass = []; let maxC = 0, maxM = 0;
  for (let pass = 0; pass < 6; pass++) {
    reserveCalls = 0; releaseCalls = 0;
    const r = E.tickTrafficCoordinator(world, 8);
    const calls = reserveCalls + releaseCalls;
    callsPerPass.push(calls); maxC = Math.max(maxC, calls); maxM = Math.max(maxM, r.mutations || 0);
  }
  E.reservationManager.reserveSections = oRes; E.reservationManager.releaseSection = oRel;
  ok(maxC <= 8 && maxM <= 8, "M166b", `budget clamped under pressure (calls/pass=[${callsPerPass.join(",")}], max reported=${maxM})`);
  const reserved = [];
  for (let i = 0; i < N; i++) if (E.reservationManager.getOwner("P1_" + i) === "PRV_" + String(i).padStart(2, "0")) reserved.push(i);
  ok(reserved.length === N, "M166b", `work still progresses to completion within bounded passes (${reserved.length}/${N} ahead sections reserved)`);
  const behindKept = [];
  for (let i = 0; i < N; i++) if (E.reservationManager.getOwner("B_" + i) !== null) behindKept.push(i);
  ok(behindKept.length === 0, "M166b", `all behind-reservations eventually released (${behindKept.length} leaked)`);
}

section("M167 no unbounded per-tick traffic scan");
{
  const coord = bodyOf(STACK_CURRENT, "tickTrafficCoordinator(world,budget=TRAFFIC_MAX_TRAINS_PER_TICK){");
  const banned = [/knownTrainToSections\.keys\(\)/, /Array\.from\(this\.records/, /for\s*\(\s*const \[\s*\w+\s*,\s*\w+\s*\] of this\.records\)/, /getEntities\(/, /world\.getDynamicPropertyIds\(\)/];
  ok(!banned.some(rx => rx.test(coord)), "M167", "coordinator body contains no full scans (iterator+budget only)");
  const { E, world } = await freshModule();
  for (let i = 0; i < 30; i++) { const t = "SCN_" + i; seedSections(E, DIM, ["Q" + i]); seedNavRoute(E, t, ["Q" + i, "R0", "R1"]); seedAutonomous(E, t); setOccupancy(E, DIM, "Q" + i, "KNOWN_OCCUPIED", t); }
  seedSections(E, DIM, ["R0", "R1"]);
  const r = E.tickTrafficCoordinator(world, 8);
  ok(r.processed <= 8 && r.mutations <= 8, "M167", `bounded work per pass (processed=${r.processed}, mutations=${r.mutations})`);
}

// ================================================================ M168: no Date.now/Math.random in Stage5-10 timing/identity/priority
section("M168 no Date.now/Math.random in Stage5-10 timing/identity/priority");
{
  const regionStart = "// ===== PHASE 1 STAGE 5 FIXED";
  const region = S_CURRENT.slice(S_CURRENT.indexOf(regionStart), S_CURRENT.indexOf(STACK_END));
  // Whitelisted baseline (Stage1-5, known-good, unchanged) patterns:
  //  - `lt:Date.now()` shard save stamps (informational metadata only)
  //  - `lastUpdateTick=Date.now()` shard save stamps (informational; never consumed by decisions)
  //  - `... currentTick : Date.now()` lastSeen fallbacks (mixed-time comparisons can only UNDER-trigger eviction = safe direction)
  //  - `new OccupancyRecord(..., Date.now(), ...)` setUnknown staleness stamp (tickRecovery compares tickSpace - wallClock
  //    => hugely negative => can only under-trigger recovery eviction, never wrongfully evict; safe direction; Stage5 baseline)
  const wl = [
    /^\s*\/\//, /^\s*\*/, /lt:\s*Date\.now\(\)/, /lastUpdateTick\s*=\s*Date\.now\(\)/,
    /currentTick\s*:\s*Date\.now\(\)/, /new OccupancyRecord\([^)]*Date\.now\(\)/,
  ];
  const bad = [];
  region.split("\n").forEach((line, i) => {
    if (!/Date\.now|Math\.random/.test(line)) return;
    if (wl.some(rx => rx.test(line))) return;
    bad.push(`line~${i}: ${line.trim().slice(0, 120)}`);
  });
  ok(bad.length === 0, "M168-region", `all Stage5-10 Date.now uses are informational shard save stamps or safe-direction lastSeen fallbacks (${bad.length} violations) ${bad.slice(0, 3).join(" | ")}`);
  const strictAnchors = [
    "function makeTrainIdFromMembers(members) {", "function makeSplitTrainId(oldId, members) {",
    "function getOrCreateTrainId(members, world) {", "  reserveSection(sectionId, trainId, world) {",
    "  reserveSections(sectionIds, trainId, world) {", "  releaseSection(sectionId, trainId, world) {",
    "  releaseAllForTrain(trainId, world) {", "tickDrivingController(world,budget){",
    "tickTrafficCoordinator(world,budget=TRAFFIC_MAX_TRAINS_PER_TICK){",
  ];
  let strictBad = [];
  for (const a of strictAnchors) {
    const stripped = bodyOf(STACK_CURRENT, a).split("\n").map(l => { const ci = l.indexOf("//"); return ci === -1 ? l : l.slice(0, ci); }).join("\n");
    if (/Date\.now|Math\.random/.test(stripped)) strictBad.push(a.slice(0, 60));
  }
  const blockStripped = BLOCK_CURRENT.split("\n").map(l => { const ci = l.indexOf("//"); return ci === -1 ? l : l.slice(0, ci); }).join("\n");
  ok(!/Date\.now|Math\.random/.test(blockStripped), "M168-block", "traffic block has zero Date.now/Math.random");
  ok(strictBad.length === 0, "M168-bodies", `identity/reservation/driving/traffic decision bodies clean (${strictBad.join(",")})`);
}

// ================================================================ M169: Stage5-9 cumulative implementations preserved
section("M169 Stage5-9 cumulative implementations preserved");
{
  const stageSymbols = [
    "class TrackGraphManager", "class GraphPointManager", "class SectionManager", "class OccupancyManager",
    "class TrainIdentityManager", "class ReservationManager", "class SectionLocationIndexManager",
    "class NavigationManager", "class DrivingManager", "function makeTrainIdFromMembers",
    "reserveSections(sectionIds, trainId, world) {", "tickDrivingController(world,budget){",
    "removeSectionsForBoundary=function(dimId,boundaryId,world,centerPos){",
    "PHASE 1 STAGE 1", "STAGE 2 FIXED", "STAGE 3 CORRECTED", "STAGE 4 FIXED", "STAGE 5 FIXED", "STAGE 6", "Stage8 ATTEMPT3", "Stage9 ATTEMPT",
  ];
  const missing = stageSymbols.filter(s => !S_CURRENT.includes(s));
  ok(missing.length === 0, "M169-symbols", `all stage 1-9 components present (missing: ${missing.join(",")})`);
  // base addon preserved: final vs ATTEMPT15 identical outside the documented edit windows (node-side line diff)
  const a15 = S_BASE.split("\n"), a17 = S_CURRENT.split("\n");
  const oldTrafficLines = new Set(STACK_BASE.slice(STACK_BASE.indexOf("// Stage10 ATTEMPT15")).split("\n"));
  const newTrafficLines = new Set(BLOCK_CURRENT.split("\n"));
  const insertedNonTraffic = new Set([
    ...PATCH.e1Add, ...PATCH.e8Add, ...PATCH.e2Add, ...PATCH.e5Add, ...PATCH.e7Add, PATCH.e4Add, PATCH.e3NavHead, PATCH.e3NavTail,
  ]);
  // walk-based minimal diff
  let i = 0, j = 0; const removedLines = [], addedLines = [];
  while (i < a15.length || j < a17.length) {
    if (i < a15.length && j < a17.length && a15[i] === a17[j]) { i++; j++; continue; }
    // resync: look ahead up to 6000 lines
    let best = null;
    outer: for (let wi = i; wi < Math.min(a15.length, i + 6000); wi++) {
      for (let wj = j; wj < Math.min(a17.length, j + 6000); wj++) {
        if (a15[wi] === a17[wj] && a15[wi + 1] === a17[wj + 1] && a15[wi + 2] === a17[wj + 2]) { best = { wi, wj }; break outer; }
      }
    }
    if (!best) { removedLines.push(...a15.slice(i)); addedLines.push(...a17.slice(j)); break; }
    removedLines.push(...a15.slice(i, best.wi)); addedLines.push(...a17.slice(j, best.wj));
    i = best.wi; j = best.wj;
  }
  const allowedOld = l => oldTrafficLines.has(l) || l === PATCH.e3Old;
  const allowedNew = l => newTrafficLines.has(l) || insertedNonTraffic.has(l);
  const badOld = removedLines.filter(l => !allowedOld(l));
  const badNew = addedLines.filter(l => !allowedNew(l));
  ok(badOld.length === 0, "M169-old", `vs ATTEMPT15: only E3-old line + ATTEMPT15 traffic block removed (${badOld.length} collateral) ${badOld.slice(0, 2).join("@@")}`);
  ok(badNew.length === 0, "M169-new", `vs ATTEMPT15: only documented E1/E2'/E3'/E4/E5/E7 + ATTEMPT17 traffic block added (${badNew.length} collateral) ${badNew.slice(0, 2).join("@@")}`);
  // vs Stage9 ATTEMPT5: Stage1-9 prefix identical except documented manager hooks
  const pfx9 = STACK9, pfx17 = STACK_CURRENT.slice(0, STACK_CURRENT.indexOf("// Stage10 ATTEMPT18"));
  const b9 = pfx9.split("\n"), b17 = pfx17.split("\n");
  let x = 0, y = 0; const r2 = [], a2 = [];
  while (x < b9.length || y < b17.length) {
    if (x < b9.length && y < b17.length && b9[x] === b17[y]) { x++; y++; continue; }
    let best = null;
    outer: for (let wx = x; wx < Math.min(b9.length, x + 6000); wx++) { for (let wy = y; wy < Math.min(b17.length, y + 6000); wy++) { if (b9[wx] === b17[wy] && b9[wx + 1] === b17[wy + 1] && b9[wx + 2] === b17[wy + 2]) { best = { wx, wy }; break outer; } } }
    if (!best) { r2.push(...b9.slice(x)); a2.push(...b17.slice(y)); break; }
    r2.push(...b9.slice(x, best.wx)); a2.push(...b17.slice(y, best.wy)); x = best.wx; y = best.wy;
  }
  const nonBlank = l => l.trim() !== ""; // boundary whitespace between block and events section is irrelevant
  const inPrefix = new Set([...PATCH.e1Add, ...PATCH.e8Add, ...PATCH.e2Add, ...PATCH.e5Add, PATCH.e4Add, PATCH.e3NavHead, PATCH.e3NavTail]);
  const badOld9 = r2.filter(l => l !== PATCH.e3Old && nonBlank(l));
  const badNew9 = a2.filter(l => nonBlank(l) && !inPrefix.has(l));
  ok(badOld9.length === 0 && badNew9.length === 0, "M169-prefix", `Stage1-9 prefix identical to Stage9 ATTEMPT5 except documented E1/E2'/E3'/E4/E5 hooks (old:${badOld9.length} new:${badNew9.length})`);
}

// ================================================================ M170: ZIP integrity + syntax
section("M170 ZIP integrity + JS syntax + brace balance");
{
  const t = execSync(`unzip -t "${PKG_CURRENT}" | tail -2`).toString();
  ok(/No errors detected/.test(t), "M170-zip", "unzip -t: no errors");
  const cnt = parseInt(execSync(`unzip -Z1 "${PKG_CURRENT}" | wc -l`).toString().trim(), 10);
  ok(cnt === 3144, "M170-entries", `entry count = ${cnt}`);
  const chk = path.join(tmpDir, "check_final.mjs"); fs.writeFileSync(chk, S_CURRENT);
  try { execSync(`node --check "${chk}"`); ok(true, "M170-syntax", "node --check passed (parse = brace+syntax balance)"); }
  catch (e) { ok(false, "M170-syntax", "node --check failed: " + String(e).slice(0, 200)); }
}

// ================================================================ M171: one real manager instance per subsystem
section("M171 single real manager instance per subsystem");
{
  const singles = ["TrackGraphManager", "GraphPointManager", "SectionManager", "OccupancyManager", "TrainIdentityManager", "ReservationManager", "SectionLocationIndexManager", "NavigationManager", "DrivingManager", "TrafficManager"];
  let bad = [];
  for (const m of singles) {
    const instances = (S_CURRENT.match(new RegExp(`new ${m}\\(`, "g")) || []).length;
    const classes = (S_CURRENT.match(new RegExp(`class ${m}[ {]`, "g")) || []).length;
    if (instances !== 1 || classes !== 1) bad.push(`${m}: instances=${instances} classes=${classes}`);
  }
  ok(bad.length === 0, "M171", `exactly one class+instance per manager (${bad.join("; ") || "all 10 OK"})`);
  const trafficConst = (S_CURRENT.match(/const trafficManager=new TrafficManager\(\);/g) || []).length;
  ok(trafficConst === 1, "M171", "single canonical trafficManager singleton");
}

// ================================================================ M172-M175: occupancy safety contract
section("M172 unknowable/unloaded occupancy is NEVER treated as free");
{
  const { E, world } = await freshModule();
  // (a) section entirely unresolvable (no location index entry, no sections, no occupancy shard)
  E.reserveSections(["NX0"], "TRN_N", world);
  const rec = new E.TrafficRecord("TRN_N"); rec.reservedSections = ["NX0"];
  let rel = E.safelyReleaseTrafficReservation("TRN_N", ["NX0"], world, rec, new Set());
  ok(rel === 0 && rec.reservedSections.indexOf("NX0") !== -1 && E.reservationManager.getOwner("NX0") === "TRN_N", "M172", "unresolvable section (no location, no shard) => NEVER released");
  // (b) section resolvable via Stage8 index but its occupancy shard holds no record for it (unloaded/never occupied)
  seedSections(E, DIM, ["NX1"]);
  E.reserveSections(["NX1"], "TRN_N", world);
  rec.reservedSections.push("NX1");
  rel = E.safelyReleaseTrafficReservation("TRN_N", ["NX1"], world, rec, new Set());
  ok(rel === 0 && rec.reservedSections.indexOf("NX1") !== -1 && E.reservationManager.getOwner("NX1") === "TRN_N", "M172", "resolvable section without occupancy record (unloaded) => NEVER released");
  ok(E.occupancyManager.getOccupancyState("NX1", world) === null, "M172", "absent record => getOccupancyState null, not 'free'");
}

section("M173 occupancy probe exception => NEVER release");
{
  const { E, world } = await freshModule();
  seedSections(E, DIM, ["PX"]);
  E.reserveSections(["PX"], "TRN_E", world);
  setOccupancy(E, DIM, "PX", "KNOWN_EMPTY", null);
  const rec = new E.TrafficRecord("TRN_E"); rec.reservedSections = ["PX"];
  const orig = E.occupancyManager.getOccupancyState;
  E.occupancyManager.getOccupancyState = () => { throw new Error("occupancy_probe_failed"); };
  const rel = E.safelyReleaseTrafficReservation("TRN_E", ["PX"], world, rec, new Set());
  E.occupancyManager.getOccupancyState = orig;
  ok(rel === 0 && rec.reservedSections.indexOf("PX") !== -1 && E.reservationManager.getOwner("PX") === "TRN_E", "M173", "thrown probe => never released, tracking retained for retry");
  const rel2 = E.safelyReleaseTrafficReservation("TRN_E", ["PX"], world, rec, new Set());
  ok(rel2 === 1 && E.reservationManager.getOwner("PX") === null, "M173", "after probe recovery the positively-empty section releases");
}

section("M174 known-occupied section is NEVER released");
{
  const { E, world } = await freshModule();
  seedSections(E, DIM, ["KO"]);
  E.reserveSections(["KO"], "TRN_K", world);
  setOccupancy(E, DIM, "KO", "KNOWN_OCCUPIED", "TRN_K");
  const rec = new E.TrafficRecord("TRN_K"); rec.reservedSections = ["KO"];
  // pass an EMPTY occupiedSet: proves the authoritative occupancy gate itself blocks the release
  const rel = E.safelyReleaseTrafficReservation("TRN_K", ["KO"], world, rec, new Set());
  ok(rel === 0 && E.reservationManager.getOwner("KO") === "TRN_K" && rec.reservedSections.indexOf("KO") !== -1, "M174", "KNOWN_OCCUPIED (self) => never released even without occupiedSet hint");
  const st = E.occupancyManager.getOccupancyState("KO", world);
  ok(st && st.state === "KNOWN_OCCUPIED" && st.trainId === "TRN_K", "M174", "authoritative occupant visible via getOccupancyState (direct shard resolve)");
}

section("M175 positively-known-free section IS released");
{
  const { E, world } = await freshModule();
  seedSections(E, DIM, ["KF"]);
  setOccupancy(E, DIM, "KF", "KNOWN_EMPTY", null);
  E.reserveSections(["KF"], "TRN_F2", world);
  const rec = new E.TrafficRecord("TRN_F2"); rec.reservedSections = ["KF"];
  const rel = E.safelyReleaseTrafficReservation("TRN_F2", ["KF"], world, rec, new Set());
  ok(rel === 1 && E.reservationManager.getOwner("KF") === null && rec.reservedSections.length === 0, "M175", "authoritative KNOWN_EMPTY + self owner => released exactly once, tracking dropped");
}

// ================================================================ M176: direct shard resolution (no all-shard scans)
section("M176 occupancy lookups never scan all shards (direct bounded resolution)");
{
  const resolver = bodyOf(S_CURRENT, "  _resolveOccupancyRecord(sectionId, world) {");
  const occStateB = bodyOf(S_CURRENT, "  getOccupancyState(sectionId, world) {");
  const occB = bodyOf(S_CURRENT, "  getOccupant(sectionId, world) {");
  const helperB = bodyOf(STACK_CURRENT, "function safelyReleaseTrafficReservation(");
  const canEnterB = bodyOf(S_CURRENT, "  canEnterRouteSection(sectionId, trainId, world) {");
  const banned = [/for\s*\(\s*const\s*\[[^\]]*\]\s*of\s*this\.shards/, /for\s*\(\s*const\s*[^\]]*of\s*occupancyManager\.shards/,
    /for\s*\(\s*const\s*[^\]]*of\s*this\.shards\.(keys|values|entries)/, /Array\.from\(this\.shards/, /Array\.from\(occupancyManager\.shards/, /getOrCreateShard\(/];
  const badB = [];
  for (const [nm, b] of [["resolver", resolver], ["getOccupancyState", occStateB], ["getOccupant", occB]]) { if (banned.some(rx => rx.test(b))) badB.push(nm); }
  ok(badB.length === 0 && resolver.includes("sectionLocationIndexManager.getLocation") && resolver.includes("this.getShardKey(") && !/sectionManager/.test(resolver) && !/for\s*\(const/.test(resolver), "M176-static", `occupancy read APIs resolve the occupancy shard directly: Stage8 index -> rootPos-derived shard key -> single Map.get (${badB.join(",") || "clean"}; no iteration, no materialization, no shard auto-create, no sectionManager fallback on reads)`);
  ok(!/occupancyManager\.shards/.test(helperB) && helperB.includes("getOccupancyState(") && helperB.includes("KNOWN_EMPTY") && helperB.includes("getOwnershipState(") && !/\.getOwner\(/.test(helperB), "M176-helper", "release helper consults ownership tri-state + getOccupancyState only; releaseSection exclusively on OWNED-self + authoritative KNOWN_EMPTY");
  ok(!/occupancyManager\.shards/.test(canEnterB) && canEnterB.includes("getOccupancyState("), "M176-canenter", "route-entry contract uses direct occupancy resolution (Stage9 shard-scan line removed)");
  // runtime: wrap the occupancy shard map with an iteration-counting proxy; lookups + a full coordinator pass
  // must perform ZERO map iterator/values/entries/forEach touches. 32 decoy shards aggravate any accidental scan.
  const { E, world } = await freshModule();
  seedSections(E, DIM, ["V0", "V1", "V2", "V3"]);
  seedNavRoute(E, "TRN_ST", ["V0", "V1", "V2", "V3"]); seedAutonomous(E, "TRN_ST");
  setOccupancy(E, DIM, "V2", "KNOWN_OCCUPIED", "TRN_ST"); setOccupancy(E, DIM, "V3", "KNOWN_OCCUPIED", "TRN_ST");
  setOccupancy(E, DIM, "V0", "KNOWN_EMPTY", null); setOccupancy(E, DIM, "V1", "UNKNOWN", null);
  E.reserveSections(["V0", "V1", "V2", "V3"], "TRN_ST", world);
  const rec = new E.TrafficRecord("TRN_ST"); rec.reservedSections = ["V0", "V1", "V2", "V3"]; E.trafficManager.records.set("TRN_ST", rec);
  let iterateCount = 0;
  const prox = new Proxy(E.occupancyManager.shards, {
    get(target, prop) {
      if (prop === Symbol.iterator || prop === "values" || prop === "entries" || prop === "forEach") iterateCount++;
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    }
  });
  E.occupancyManager.shards = prox;
  for (let i = 0; i < 32; i++) { E.occupancyManager.shards.set("decoy_" + i, new E.OccupancyShard(DIM, i + 1, 0)); }
  iterateCount = 0;
  const directOcc = E.occupancyManager.getOccupant("V2", world);
  const contract = E.canEnterRouteSection("V1", "TRN_ST", world); // UNKNOWN occupancy + self reservation => stale-held contract
  E.tickTrafficCoordinator(world, 8);
  ok(iterateCount === 0, "M176-runtime", `zero occupancy-shard-map iteration touches across getOccupant + canEnterRouteSection + full coordinator pass (got ${iterateCount}, 32 decoy shards armed)`);
  ok(directOcc === "TRN_ST", "M176-runtime", "getOccupant resolved the occupant via direct shard lookup");
  ok(contract && contract.stale === true && contract.state === "held" && contract.releaseWhenPossible === true && contract.owner === "TRN_ST" && contract.canEnter === false, "M176-stale", `authoritative stale-held contract emitted via direct resolve (${JSON.stringify(contract)})`);
  ok(E.reservationManager.getOwner("V0") === null, "M176-release", "positively KNOWN_EMPTY behind section released inside bounded pass");
  ok(E.reservationManager.getOwner("V1") === "TRN_ST", "M176-retain", "UNKNOWN-occupancy reservation retained (deterministic stale hold, never released)");
  ok(E.reservationManager.getOwner("V2") === "TRN_ST" && E.reservationManager.getOwner("V3") === "TRN_ST", "M176-occupied", "occupied sections untouched by completion behavior");
}

// ================================================================ M177-M178: retry + completion safety
section("M177 retry works after unknown occupancy becomes positively known free");
{
  const { E, world } = await freshModule();
  seedSections(E, DIM, ["RV"]);
  E.reserveSections(["RV"], "TRN_V", world);
  const rec = new E.TrafficRecord("TRN_V"); rec.reservedSections = ["RV"]; E.trafficManager.records.set("TRN_V", rec);
  E.occupancyManager.handleTrainDisappearance("TRN_V", DIM, world); // occupancy for RV: never written => unknown/unloaded
  ok(E.trafficManager.records.has("TRN_V") && E.reservationManager.getOwner("RV") === "TRN_V" && E.trafficManager._releaseRetryQueue.indexOf("TRN_V") !== -1, "M177", "unknown occupancy at disappearance => retained + queued, NEVER released");
  setOccupancy(E, DIM, "RV", "KNOWN_EMPTY", null); // authoritative free knowledge arrives later (e.g. shard loaded)
  E.tickTrafficCoordinator(world, 8);
  ok(E.reservationManager.getOwner("RV") === null && !E.trafficManager.records.has("TRN_V"), "M177", "bounded retry released once occupancy positively KNOWN_EMPTY and definitively deleted the record");
}

section("M178 destination completion NEVER releases occupied sections");
{
  const { E, world } = await freshModule();
  seedSections(E, DIM, ["C0", "C1", "C2"]);
  seedNavRoute(E, "TRN_C", ["C0", "C1", "C2"]); seedAutonomous(E, "TRN_C");
  setOccupancy(E, DIM, "C0", "KNOWN_EMPTY", null);
  setOccupancy(E, DIM, "C1", "KNOWN_OCCUPIED", "TRN_C"); setOccupancy(E, DIM, "C2", "KNOWN_OCCUPIED", "TRN_C");
  E.reserveSections(["C0", "C1", "C2"], "TRN_C", world);
  const rec = new E.TrafficRecord("TRN_C"); rec.reservedSections = ["C0", "C1", "C2"]; E.trafficManager.records.set("TRN_C", rec);
  E.tickTrafficCoordinator(world, 8); // train occupies C1+C2, leading section C2 = destination => completion branch
  ok(E.reservationManager.getOwner("C1") === "TRN_C" && E.reservationManager.getOwner("C2") === "TRN_C", "M178", "occupied sections (incl. final) never released at completion");
  ok(E.reservationManager.getOwner("C0") === null, "M178", "positively KNOW_EMPTY vacated section behind released");
  ok(E.trafficManager.records.has("TRN_C") && E.trafficManager.records.get("TRN_C").reservedSections.indexOf("C1") !== -1, "M178", "record retained with occupied tracking (safe release deferred)");
}

// ================================================================ M179: Stage7/8/9 + ATTEMPT17 surfaces present
section("M179 Stage7/8/9 manager defs + ATTEMPT17 APIs present");
{
  const need = [
    "class TrackGraphManager", "class GraphPointManager", "class SectionManager", "class OccupancyManager",
    "class TrainIdentityManager", "class ReservationManager", "class SectionLocationIndexManager",
    "class NavigationManager", "class DrivingManager", "class TrafficManager",
    "function canEnterRouteSection(", "  _resolveOccupancyRecord(sectionId, world) {", "  getOccupancyState(sectionId, world) {",
    "  getOccupant(sectionId, world) {", "  getOwner(sectionId) {", "  getOwnershipState(sectionId, world) {",
    "stale_ahead_holding_pending_release", "reserveSections(sectionIds, trainId, world) {",
    "removeSectionsForBoundary=function(dimId,boundaryId,world,centerPos){",
    "PHASE 1 STAGE 5 FIXED", "Stage8 ATTEMPT3", "Stage9 ATTEMPT", "// Stage10 ATTEMPT18 layered on REAL Stage9 ATTEMPT5 c8cb356b - traffic fixes",
  ];
  const missing = need.filter(s => !S_CURRENT.includes(s));
  ok(missing.length === 0, "M179-defs", `all stage 5-9 + ATTEMPT17 definitions present (missing: ${missing.join(",") || "none"})`);
  const { E } = await freshModule();
  const fns = ["canEnterRouteSection", "safelyReleaseTrafficReservation", "tickTrafficCoordinator", "tickTrafficSave",
    "loadTrafficOnWorldLoad", "invalidateTrafficForSectionId", "invalidateTrafficForTrainId",
    "getTrafficState", "reserveSections", "releaseSection", "resolveLeadingCurrentSection", "setAutonomousMode"];
  const badF = fns.filter(f => typeof E[f] !== "function");
  const mgrs = ["trackGraphManager", "graphPointManager", "sectionManager", "occupancyManager", "trainIdentityManager",
    "reservationManager", "sectionLocationIndexManager", "navigationManager", "drivingManager", "trafficManager"];
  const badM = mgrs.filter(m => !E[m]);
  const badC = ["ReservationShard", "NavigationShard", "DrivingShard", "SectionIndexRecord", "SectionLocationIndexShard", "TrafficRecord", "OccupancyRecord"].filter(c => !E[c]);
  ok(badF.length === 0 && badM.length === 0 && badC.length === 0 && typeof E.occupancyManager.getOccupancyState === "function" && typeof E.occupancyManager._resolveOccupancyRecord === "function" && typeof E.occupancyManager.getOccupant === "function" && typeof E.reservationManager.getOwner === "function" && typeof E.reservationManager.getOwnershipState === "function",
    "M179-exports", `all ATTEMPT17 manager APIs live on the real singletons (fns:${badF.join(",") || "ok"} mgrs:${badM.join(",") || "ok"} classes:${badC.join(",") || "ok"})`);
}

// ================================================================ M180: package gate
section("M180 ZIP integrity + syntax + version + hash");
{
  const t = execSync(`unzip -t "${PKG_CURRENT}" | tail -2`).toString();
  ok(/No errors detected/.test(t), "M180-zip", "unzip -t: no errors");
  const cnt = parseInt(execSync(`unzip -Z1 "${PKG_CURRENT}" | wc -l`).toString().trim(), 10);
  ok(cnt === 3144, "M180-entries", `entry count = ${cnt}`);
  const chk = path.join(tmpDir, "check_final.mjs"); fs.writeFileSync(chk, S_CURRENT);
  try { execSync(`node --check "${chk}"`); ok(true, "M180-syntax", "node --check main.js passed"); }
  catch (e) { ok(false, "M180-syntax", "node --check failed: " + String(e).slice(0, 200)); }
  const bpMan = JSON.parse(execSync(`unzip -p "${PKG_CURRENT}" "TRAINS Urban Update Add-On/manifest.json"`).toString("utf-8"));
  const rpMan = JSON.parse(execSync(`unzip -p "${PKG_CURRENT}" "TRAINS Urban Update Add-On by matiss/manifest.json"`).toString("utf-8"));
  ok(JSON.stringify(bpMan.header.version) === "[1,1,9]" && JSON.stringify(rpMan.header.version) === "[1,1,9]", "M180-version", `both manifests bumped to 1.1.9 for clean world upgrade (bp=${bpMan.header.version}, rp=${rpMan.header.version})`);
  // no residual ATTEMPT15/ATTEMPT16 traffic-era markers and no old shard-scan line
  ok(!S_CURRENT.includes("// Stage10 ATTEMPT15 layered") && !S_CURRENT.includes("reason:'unknown_or_conflict_safely_blocked'}; } break;"), "M180-clean", "no residual ATTEMPT15 block or old occupancy shard-scan nav line");
  const sha = execSync(`shasum -a 256 "${PKG_CURRENT}"`).toString().split(" ")[0];
  const bytes = fs.statSync(PKG_CURRENT).size;
  console.log(`  INFO package SHA256 = ${sha}`);
  console.log(`  INFO package bytes  = ${bytes}; main.js = ${S_CURRENT.length} chars, ${S_CURRENT.split("\n").length} lines`);
}


// ================================================================ M181-M182: occupancy resolver has ZERO shard iteration
section("M181 SectionLocationIndex failure does NOT trigger sectionManager.shards iteration");
{
  const resolverB = bodyOf(S_CURRENT, "  _resolveOccupancyRecord(sectionId, world) {");
  ok(!/sectionManager/.test(resolverB) && !/for\s*\(const/.test(resolverB) && !/\.keys\(|\.values\(|\.entries\(|forEach/.test(resolverB), "M181-static", "resolver source contains no sectionManager reference and no loop at all (fallback removed)");
  const { E, world } = await freshModule();
  seedSections(E, DIM, ["IX0"]);
  setOccupancy(E, DIM, "IX0", "KNOWN_OCCUPIED", "TRN_IX");
  let secIter = 0;
  E.sectionManager.shards = new Proxy(E.sectionManager.shards, {
    get(t, p) { if (p === Symbol.iterator || p === "values" || p === "entries" || p === "forEach") secIter++; const v = Reflect.get(t, p); return typeof v === "function" ? v.bind(t) : v; }
  });
  const orig = E.sectionLocationIndexManager.getLocation;
  E.sectionLocationIndexManager.getLocation = () => { throw new Error("index_unavailable"); };
  const a = E.occupancyManager.getOccupant("IX0", world);
  const b = E.occupancyManager.getOccupancyState("IX0", world);
  E.sectionLocationIndexManager.getLocation = orig;
  ok(secIter === 0 && a === null && b === null, "M181", `index failure => ${secIter} sectionManager.shards iteration touches, safe-fail null (record exists but is never hunted for)`);
}

section("M182 getOccupant/getOccupancyState zero shard-map iteration even when index fails");
{
  const { E, world } = await freshModule();
  seedSections(E, DIM, ["IZ0"]);
  setOccupancy(E, DIM, "IZ0", "KNOWN_OCCUPIED", "TRN_IZ");
  let occIter = 0, secIter = 0;
  const mk = (map, bump) => new Proxy(map, { get(t, p) { if (p === Symbol.iterator || p === "values" || p === "entries" || p === "forEach") bump(); const v = Reflect.get(t, p); return typeof v === "function" ? v.bind(t) : v; } });
  E.occupancyManager.shards = mk(E.occupancyManager.shards, () => { occIter++; });
  E.sectionManager.shards = mk(E.sectionManager.shards, () => { secIter++; });
  for (let i = 0; i < 32; i++) E.occupancyManager.shards.set("bait_" + i, new E.OccupancyShard(DIM, i + 1, 0));
  const orig = E.sectionLocationIndexManager.getLocation;
  E.sectionLocationIndexManager.getLocation = () => null; // index lookup definitively fails
  const a = E.occupancyManager.getOccupant("IZ0", world);
  const b = E.occupancyManager.getOccupancyState("IZ0", world);
  E.sectionLocationIndexManager.getLocation = orig;
  const c = E.occupancyManager.getOccupant("IZ0", world); // index healthy again -> direct resolve
  ok(occIter === 0 && secIter === 0 && a === null && b === null, "M182", `index failure => zero occupancy/section shard-map iteration touches (occ=${occIter}, sec=${secIter}); results null (never 'free')`);
  ok(c === "TRN_IZ", "M182", "index healthy => direct shard resolution finds the occupant (no iteration used anywhere)");
}

// ================================================================ M183-M184: ownership tri-state + persistence
section("M183 Stage7 ownership UNKNOWN is distinct from FREE");
{
  const { E, world } = await freshModule();
  const u = E.reservationManager.getOwnershipState("UF", world);
  ok(u && u.state === "UNKNOWN" && u.owner === null, "M183", `unloaded/never-persisted shard => UNKNOWN, not FREE (${JSON.stringify(u)})`);
  E.reserveSections(["UF"], "TRN_F", world);
  E.releaseSection("UF", "TRN_F", world); // real reserve+release leaves the resolved shard with no record
  const f = E.reservationManager.getOwnershipState("UF", world);
  ok(f && f.state === "FREE" && f.owner === null && u.state !== f.state, "M183", `resolvable shard with no record => FREE, strictly distinct from UNKNOWN (${JSON.stringify(f)})`);
  const o = E.reservationManager.getOwnershipState("UF", world) && E.reservationManager.getOwnershipState("UF", world);
  E.reserveSections(["UF3"], "TRN_O", world);
  const owned = E.reservationManager.getOwnershipState("UF3", world);
  ok(owned && owned.state === "OWNED" && owned.owner === "TRN_O", "M183", "active reservation => OWNED{owner}");
  // pick a section whose deterministic reservation shard is definitively not loaded in memory
  let probe = null;
  for (let i = 0; i < 500 && !probe; i++) { const cand = "UFN_" + i; const ix = E.reservationManager.getShardIndicesForSectionId(cand); if (!E.reservationManager.shards.has(E.reservationManager.getShardKey(ix.primary, ix.sub))) probe = cand; }
  ok(!!probe, "M183", `found genuinely-unloaded probe section ${probe}`);
  const u2 = E.reservationManager.getOwnershipState(probe, null);
  ok(u2 && u2.state === "UNKNOWN", "M183", "no world + no in-memory shard => UNKNOWN (probe-degraded never becomes FREE)");
}

section("M184 persisted/unloaded reservation with getOwner null is retained, not forgotten");
{
  const { E, world } = await freshModule();
  E.reserveSections(["PU"], "TRN_P", world);
  E.reservationManager.tickSave(world, 64); // real Stage7 save path persists the deterministic shard
  const dpKeys0 = world.getDynamicPropertyIds().filter(k => k.startsWith("pod_trn_resv_shard_"));
  ok(dpKeys0.length > 0, "M184-setup", "reservation persisted to its deterministic reservation shard DP");
  E.reservationManager.shards.clear(); E.reservationManager.knownSectionToTrain.clear(); E.reservationManager.knownTrainToSections.clear();
  ok(E.reservationManager.getOwner("PU") === null, "M184", "raw getOwner null after unload (ambiguous, NOT authoritative free)");
  const st = E.reservationManager.getOwnershipState("PU", world);
  ok(st && st.state === "OWNED" && st.owner === "TRN_P", "M184", `persisted shard resolves OWNED via direct deterministic load (${JSON.stringify(st)})`);
  const rec = new E.TrafficRecord("TRN_P"); rec.reservedSections = ["PU"];
  let releaseCalls = 0; const oRel = E.reservationManager.releaseSection;
  E.reservationManager.releaseSection = (...a2) => { releaseCalls++; return oRel.apply(E.reservationManager, a2); };
  const rel = E.safelyReleaseTrafficReservation("TRN_P", ["PU"], world, rec, new Set());
  E.reservationManager.releaseSection = oRel;
  ok(rel === 0 && releaseCalls === 0 && rec.reservedSections.indexOf("PU") !== -1, "M184", "OWNED-self + unknown occupancy => tracking retained, no release attempted, nothing forgotten");
  const dpKeys1 = world.getDynamicPropertyIds().filter(k => k.startsWith("pod_trn_resv_shard_"));
  ok(dpKeys1.length === dpKeys0.length && E.reservationManager.shards.size === 0, "M184", "read-only API mutated nothing: DP set unchanged, no shard cached/created");
}

// ================================================================ M185-M190: release-contract decision matrix
section("M185 UNKNOWN ownership + occupied/unknown occupancy never releases");
{
  const { E, world } = await freshModule();
  seedSections(E, DIM, ["W1", "W2"]);
  setOccupancy(E, DIM, "W1", "KNOWN_OCCUPIED", "TRN_W");
  setOccupancy(E, DIM, "W2", "UNKNOWN", null);
  const rec = new E.TrafficRecord("TRN_X"); rec.reservedSections = ["W1", "W2"];
  let releaseCalls = 0; const oRel = E.reservationManager.releaseSection;
  E.reservationManager.releaseSection = (...a) => { releaseCalls++; return oRel.apply(E.reservationManager, a); };
  const rel = E.safelyReleaseTrafficReservation("TRN_X", ["W1", "W2"], world, rec, new Set());
  E.reservationManager.releaseSection = oRel;
  ok(rel === 0 && releaseCalls === 0 && rec.reservedSections.length === 2, "M185", "UNKNOWN ownership (shard never persisted/loaded) + occupied or unknown occupancy => zero releases, tracking fully retained");
}

section("M186 authoritative FREE may reconcile stale tracking");
{
  const { E, world } = await freshModule();
  E.reserveSections(["FR"], "TRN_Z", world);
  E.releaseSection("FR", "TRN_Z", world); // real release: resolved shard now answers 'no record' => FREE
  ok(E.reservationManager.getOwnershipState("FR", world).state === "FREE", "M186-setup", "authoritative FREE established via the resolved shard");
  const rec = new E.TrafficRecord("TRN_Z"); rec.reservedSections = ["FR"]; // stale tracking after definitive free
  let releaseCalls = 0; const oRel = E.reservationManager.releaseSection;
  E.reservationManager.releaseSection = (...a) => { releaseCalls++; return oRel.apply(E.reservationManager, a); };
  const rel = E.safelyReleaseTrafficReservation("TRN_Z", ["FR"], world, rec, new Set());
  E.reservationManager.releaseSection = oRel;
  ok(rel === 0 && releaseCalls === 0 && rec.reservedSections.indexOf("FR") === -1, "M186", "authoritative FREE => stale tracking reconciled with NO release call and NO world mutation");
}

section("M187 authoritative foreign owner may reconcile stale tracking");
{
  const { E, world } = await freshModule();
  E.reserveSections(["FO"], "TRN_A", world);
  const rec = new E.TrafficRecord("TRN_B"); rec.reservedSections = ["FO"]; // stale tracking of a foreign-owned section
  let releaseCalls = 0; const oRel = E.reservationManager.releaseSection;
  E.reservationManager.releaseSection = (...a) => { releaseCalls++; return oRel.apply(E.reservationManager, a); };
  const rel = E.safelyReleaseTrafficReservation("TRN_B", ["FO"], world, rec, new Set());
  E.reservationManager.releaseSection = oRel;
  const st = E.reservationManager.getOwnershipState("FO", world);
  ok(rel === 0 && releaseCalls === 0 && rec.reservedSections.indexOf("FO") === -1 && st && st.state === "OWNED" && st.owner === "TRN_A", "M187", "authoritative foreign owner => our stale tracking dropped only; the real reservation untouched");
}

section("M188 own reservation + KNOWN_EMPTY releases normally");
{
  const { E, world } = await freshModule();
  seedSections(E, DIM, ["K8"]);
  setOccupancy(E, DIM, "K8", "KNOWN_EMPTY", null);
  E.reserveSections(["K8"], "TRN_8", world);
  const rec = new E.TrafficRecord("TRN_8"); rec.reservedSections = ["K8"];
  let releaseCalls = 0; const oRel = E.reservationManager.releaseSection;
  E.reservationManager.releaseSection = (...a) => { releaseCalls++; return oRel.apply(E.reservationManager, a); };
  const rel = E.safelyReleaseTrafficReservation("TRN_8", ["K8"], world, rec, new Set());
  E.reservationManager.releaseSection = oRel;
  ok(rel === 1 && releaseCalls === 1 && rec.reservedSections.length === 0 && E.reservationManager.getOwnershipState("K8", world).state === "FREE", "M188", "OWNED-self + authoritative KNOWN_EMPTY => exactly one releaseSection, tracking dropped, shard now FREE");
}

section("M189 release failure retains tracking");
{
  const { E, world } = await freshModule();
  seedSections(E, DIM, ["K9"]);
  setOccupancy(E, DIM, "K9", "KNOWN_EMPTY", null);
  E.reserveSections(["K9"], "TRN_9", world);
  const rec = new E.TrafficRecord("TRN_9"); rec.reservedSections = ["K9"];
  const orig = E.reservationManager.releaseSection;
  E.reservationManager.releaseSection = () => ({ ok: false, reason: "forced_fail" });
  let rel = E.safelyReleaseTrafficReservation("TRN_9", ["K9"], world, rec, new Set());
  ok(rel === 0 && rec.reservedSections.indexOf("K9") !== -1 && E.reservationManager.getOwnershipState("K9", world).owner === "TRN_9", "M189", "release attempt failed => tracking retained (never forgotten)");
  E.reservationManager.releaseSection = orig;
  rel = E.safelyReleaseTrafficReservation("TRN_9", ["K9"], world, rec, new Set());
  ok(rel === 1 && rec.reservedSections.length === 0, "M189", "after recovery the retained tracking releases cleanly");
}

section("M190 active reservation never becomes untracked due ambiguous owner-null");
{
  const { E, world } = await freshModule();
  seedSections(E, DIM, ["AM"]);
  E.reserveSections(["AM"], "TRN_M", world); // real ACTIVE reservation (shard record + in-memory index)
  E.reservationManager.knownSectionToTrain.delete("AM"); // simulate the ambiguous owner-null window
  ok(E.reservationManager.getOwner("AM") === null, "M190", "raw getOwner null (ambiguous) while the reservation record is still live");
  const st = E.reservationManager.getOwnershipState("AM", world);
  ok(st && st.state === "OWNED" && st.owner === "TRN_M", "M190", "tri-state recovers the active reservation from the resolved shard record");
  setOccupancy(E, DIM, "AM", "UNKNOWN", null);
  const rec = new E.TrafficRecord("TRN_M"); rec.reservedSections = ["AM"];
  let releaseCalls = 0; const oRel = E.reservationManager.releaseSection;
  E.reservationManager.releaseSection = (...a) => { releaseCalls++; return oRel.apply(E.reservationManager, a); };
  const rel = E.safelyReleaseTrafficReservation("TRN_M", ["AM"], world, rec, new Set());
  E.reservationManager.releaseSection = oRel;
  const st2 = E.reservationManager.getOwnershipState("AM", world);
  ok(rel === 0 && releaseCalls === 0 && rec.reservedSections.indexOf("AM") !== -1 && st2 && st2.owner === "TRN_M", "M190", "OWNED-self + UNKNOWN occupancy => retained: active reservation never untracked, never released");
}

// ================================================================ M191-M192: preservation + package gate
section("M191 cumulative Stage7/8/9 definitions preserved (+ ATTEMPT18 APIs)");
{
  const need = [
    "class TrackGraphManager", "class GraphPointManager", "class SectionManager", "class OccupancyManager",
    "class TrainIdentityManager", "class ReservationManager", "class SectionLocationIndexManager",
    "class NavigationManager", "class DrivingManager", "class TrafficManager",
    "  getOwner(sectionId) {", "  getOwnershipState(sectionId, world) {",
    "  _resolveOccupancyRecord(sectionId, world) {", "  getOccupancyState(sectionId, world) {", "  getOccupant(sectionId, world) {",
    "getOwnershipState(secId", "getShardIndicesForSectionId(sectionId)", "ReservationShard.tryLoad(world, ix.primary, ix.sub)",
    "stale_ahead_holding_pending_release", "reserveSections(sectionIds, trainId, world) {",
    "removeSectionsForBoundary=function(dimId,boundaryId,world,centerPos){",
    "PHASE 1 STAGE 5 FIXED", "STAGE 6", "Stage8 ATTEMPT3", "Stage9 ATTEMPT", "// Stage10 ATTEMPT18 layered on REAL Stage9 ATTEMPT5 c8cb356b - traffic fixes",
    "loadTrafficOnWorldLoad(world19);",
  ];
  const missing = need.filter(x => !S_CURRENT.includes(x));
  ok(missing.length === 0, "M191-defs", `all Stage7/8/9 defs + ATTEMPT18 APIs present (missing: ${missing.join(",") || "none"})`);
  const singles = ["TrackGraphManager", "GraphPointManager", "SectionManager", "OccupancyManager", "TrainIdentityManager", "ReservationManager", "SectionLocationIndexManager", "NavigationManager", "DrivingManager", "TrafficManager"];
  let bad = [];
  for (const m of singles) {
    const inst = (S_CURRENT.match(new RegExp(`new ${m}\\(`, "g")) || []).length;
    const cls = (S_CURRENT.match(new RegExp(`class ${m}[ {]`, "g")) || []).length;
    if (inst !== 1 || cls !== 1) bad.push(`${m}:${inst}/${cls}`);
  }
  ok(bad.length === 0, "M191-singletons", `exactly one class+instance per manager (${bad.join(",") || "all 10 OK"})`);
  const { E } = await freshModule();
  ok(typeof E.reservationManager.getOwnershipState === "function" && typeof E.reservationManager.getOwner === "function" &&
     typeof E.occupancyManager._resolveOccupancyRecord === "function" && typeof E.occupancyManager.getOccupancyState === "function" &&
     typeof E.occupancyManager.getOccupant === "function" && typeof E.safelyReleaseTrafficReservation === "function" &&
     typeof E.canEnterRouteSection === "function" && typeof E.loadTrafficOnWorldLoad === "function",
     "M191-live", "all ATTEMPT18 manager APIs live on the real packaged singletons");
}

section("M192 ZIP integrity + syntax + versions + dependency verification");
{
  const t = execSync(`unzip -t "${PKG_CURRENT}" | tail -2`).toString();
  ok(/No errors detected/.test(t), "M192-zip", "unzip -t: no errors (integrity)");
  const cnt = parseInt(execSync(`unzip -Z1 "${PKG_CURRENT}" | wc -l`).toString().trim(), 10);
  ok(cnt === 3144, "M192-entries", `entry count = ${cnt}`);
  ok(path.basename(PKG_CURRENT) === "TRAINS_Phase1_Stage10_ATTEMPT18.mcaddon", "M192-name", "package named TRAINS_Phase1_Stage10_ATTEMPT18.mcaddon");
  const chk = path.join(tmpDir, "check_final18.mjs"); fs.writeFileSync(chk, S_CURRENT);
  try { execSync(`node --check "${chk}"`); ok(true, "M192-syntax", "node --check main.js passed"); }
  catch (e) { ok(false, "M192-syntax", "node --check failed: " + String(e).slice(0, 200)); }
  const bpMan = JSON.parse(execSync(`unzip -p "${PKG_CURRENT}" "TRAINS Urban Update Add-On/manifest.json"`).toString("utf-8"));
  const rpMan = JSON.parse(execSync(`unzip -p "${PKG_CURRENT}" "TRAINS Urban Update Add-On by matiss/manifest.json"`).toString("utf-8"));
  const BP_UUID = "ab5cde80-a5b3-48b1-85db-3048b2dbc6ab", RP_UUID = "56ca16b1-f4df-4512-b739-e72d8367d309";
  const bpDep = (bpMan.dependencies || []).find(d => d.uuid === RP_UUID);
  const rpDep = (rpMan.dependencies || []).find(d => d.uuid === BP_UUID);
  ok(bpMan.header.uuid === BP_UUID && rpMan.header.uuid === RP_UUID, "M192-uuids", "header uuids unchanged (BP/RP pairing intact)");
  ok(JSON.stringify(bpMan.header.version) === "[1,1,9]" && JSON.stringify(rpMan.header.version) === "[1,1,9]", "M192-version", `both headers at 1.1.9 (bp=${bpMan.header.version} rp=${rpMan.header.version})`);
  ok(bpDep && JSON.stringify(bpDep.version) === "[1,1,9]" && rpDep && JSON.stringify(rpDep.version) === "[1,1,9]", "M192-deps", `cross-pack dependency versions verified: BP->RP ${JSON.stringify(bpDep && bpDep.version)}, RP->BP ${JSON.stringify(rpDep && rpDep.version)}`);
  const scriptMod = (bpMan.modules || []).find(m => m.type === "script");
  ok(!!scriptMod, "M192-script-module", "script module declared in BP manifest");
  ok(!S_CURRENT.includes("// Stage10 ATTEMPT15 layered") && !S_CURRENT.includes("// Stage10 ATTEMPT16 layered") && !S_CURRENT.includes("// Stage10 ATTEMPT17 layered"), "M192-clean", "no residual earlier-attempt traffic blocks");
  const sha = execSync(`shasum -a 256 "${PKG_CURRENT}"`).toString().split(" ")[0];
  const bytes = fs.statSync(PKG_CURRENT).size;
  console.log(`  INFO package SHA256 = ${sha}`);
  console.log(`  INFO package bytes  = ${bytes}; main.js = ${S_CURRENT.length} chars, ${S_CURRENT.split("\\n").length} lines`);
}

// ================================================================ summary
console.log(`\n========================================`);
console.log(`RESULT: ${pass} passed, ${failN} failed`);
if (failures.length) { console.log("FAILURES:"); for (const f of failures) console.log("  - " + f); process.exit(1); }
console.log("ALL TESTS PASSED");
