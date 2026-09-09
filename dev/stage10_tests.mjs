// Stage10 ATTEMPT16 test harness (M150-M171)
// Runs the REAL stage-stack code extracted verbatim from the packaged final main.js,
// under mocked @minecraft/server world/system. No test doubles for the code under test.
// Usage: node dev/stage10_tests.mjs
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const REPO = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const PKG16 = path.join(REPO, "TRAINS_Phase1_Stage10_ATTEMPT16.mcaddon");
const PKG15 = path.join(REPO, "TRAINS_Phase1_Stage10_ATTEMPT15.mcaddon");
const PKG9 = path.join(REPO, "TRAINS_Phase1_Stage9_ATTEMPT5.mcaddon");
const BLOCK_FILE = path.join(REPO, "dev", "traffic_block_attempt16.js");
const MAIN_IN_ZIP = "TRAINS Urban Update Add-On/scripts/main.js";

const S16 = execSync(`unzip -p "${PKG16}" "${MAIN_IN_ZIP}"`).toString("utf-8");
const S15 = execSync(`unzip -p "${PKG15}" "${MAIN_IN_ZIP}"`).toString("utf-8");
const S9 = execSync(`unzip -p "${PKG9}" "${MAIN_IN_ZIP}"`).toString("utf-8");
const BLOCK16 = fs.readFileSync(BLOCK_FILE, "utf-8");

// ---------- stage-stack extraction (verbatim slice from the REAL packaged main.js) ----------
const STACK_START = "// scripts/track_graph/model.ts";
const STACK_END = "// scripts/events/world.ts";
function extractStack(src) {
  const a = src.indexOf(STACK_START), b = src.indexOf(STACK_END);
  if (a < 0 || b < 0 || b <= a) throw new Error("stack markers not found");
  return src.slice(a, b);
}
const STACK16 = extractStack(S16);
const STACK15 = extractStack(S15);
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
const __tk = globalThis.__T16__;
const world8=__tk.world, world5=__tk.world, world19=__tk.world;
const system9=__tk.system, system14=__tk.system, system15=__tk.system, system25=__tk.system, system=__tk.system;
`;
const EXPORTS = `
export { trackGraphManager, graphPointManager, sectionManager, occupancyManager, trainIdentityManager,
 reservationManager, sectionLocationIndexManager, navigationManager, drivingManager, trafficManager,
 TrafficRecord, OccupancyRecord, ReservationRecord, NavigationRecord, DrivingRecord, Section, SectionShard, OccupancyShard,
 safelyReleaseTrafficReservation, tickTrafficCoordinator, tickTrafficSave, loadTrafficOnWorldLoad,
 invalidateTrafficForSectionId, invalidateTrafficForTrainId, getTrafficState, getOccupancyTick,
 makeTrainIdFromMembers, makeSplitTrainId, reserveSection, reserveSections, releaseSection,
 canEnterRouteSection, setAutonomousMode, getDrivingState, getNavigationState, resolveLeadingCurrentSection };
`;

let importCounter = 0;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "t16h-"));
const wrappedPath = path.join(tmpDir, "stage_stack_wrapped.mjs");
fs.writeFileSync(wrappedPath, PRELUDE + STACK16 + EXPORTS, "utf-8");
async function freshModule(world, system) {
  globalThis.__T16__ = { world: world || makeWorld(), system: system || makeSystem() };
  const mod = await import(pathToFileURL(wrappedPath).href + "?case=" + (++importCounter));
  return { E: mod, world: globalThis.__T16__.world, system: globalThis.__T16__.system };
}

// ---------- seed helpers (structural, using the real classes/managers) ----------
const DIM = "minecraft:overworld";
function seedSections(E, dimId, ids, boundary = "B1") {
  const key = "pod_trn_section_shard_" + dimId.replace(/[^a-z0-9_]/gi, "_").slice(0, 24) + "_0_0";
  let shard = E.sectionManager.shards.get(key);
  if (!shard) { shard = new E.SectionShard(dimId, 0, 0); E.sectionManager.shards.set(key, shard); }
  for (const id of ids) { const sec = new E.Section(id, dimId, boundary, "B2", "EAST", [], [], 64, [], [], { x: 8, y: 64, z: 8 }); sec.state = "KNOWN"; shard.sections.set(id, sec); }
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
  // train advances: now occupies only S2
  setOccupancy(E, DIM, "S0", "KNOWN_EMPTY", null); setOccupancy(E, DIM, "S1", "KNOWN_EMPTY", null); setOccupancy(E, DIM, "S2", "KNOWN_OCCUPIED", T);
  r = E.tickTrafficCoordinator(world, 8);
  const rec = E.trafficManager.records.get(T);
  ok(E.reservationManager.getOwner("S1") === null, "M150", "behind section S1 released");
  ok(E.reservationManager.getOwner("S2") === T, "M150", "occupied section S2 NOT released");
  ok(E.reservationManager.getOwner("S3") === T && E.reservationManager.getOwner("S5") === T, "M150", "ahead reservations retained");
  ok(rec && rec.reservedSections.indexOf("S1") === -1, "M150", "traffic tracking dropped for S1");
}

section("M151 destination completion releases reservations");
{
  const { E, world } = await freshModule();
  const T = "TRN_B";
  seedSections(E, DIM, ["D0", "D1", "D2"]);
  seedNavRoute(E, T, ["D0", "D1", "D2"]);
  seedAutonomous(E, T);
  setOccupancy(E, DIM, "D0", "KNOWN_OCCUPIED", T);
  E.tickTrafficCoordinator(world, 8);
  ok(E.reservationManager.getOwner("D1") === T, "M151-setup", "reserved ahead while en route");
  // arrive: occupies final section only
  setOccupancy(E, DIM, "D0", "KNOWN_EMPTY", null); setOccupancy(E, DIM, "D1", "KNOWN_EMPTY", null); setOccupancy(E, DIM, "D2", "KNOWN_OCCUPIED", T);
  E.tickTrafficCoordinator(world, 8);
  ok(E.reservationManager.getOwner("D1") === null, "M151", "vacated sections released at destination");
  ok(E.reservationManager.getOwner("D2") === T, "M151", "occupied destination section retained");
  const rec = E.trafficManager.records.get(T);
  ok(!rec || rec.claimedSections.length === 0, "M151", "claims cleared at destination");
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
  E.reserveSections(["FY"], "TRN_F", world);
  const rec = new E.TrafficRecord("TRN_F"); rec.reservedSections = ["FY"];
  const orig = E.reservationManager.releaseSection;
  E.reservationManager.releaseSection = () => ({ ok: false, reason: "forced_fail" });
  const rel = E.safelyReleaseTrafficReservation("TRN_F", ["FY"], world, rec, new Set());
  E.reservationManager.releaseSection = orig;
  ok(rel === 0 && rec.reservedSections.indexOf("FY") !== -1, "M153", "retained after forced release failure");
  ok(E.reservationManager.getOwner("FY") === "TRN_F", "M153", "still owner after failure");
}

section("M154 unknown ownership remains tracked");
{
  const { E, world } = await freshModule();
  E.reserveSections(["FU"], "TRN_U", world);
  const rec = new E.TrafficRecord("TRN_U"); rec.reservedSections = ["FU"];
  const origO = E.reservationManager.getOwner, origR = E.reservationManager.releaseSection;
  E.reservationManager.getOwner = () => { throw new Error("ownership_unknown"); };
  E.reservationManager.releaseSection = () => ({ ok: false, reason: "unknown" });
  const rel = E.safelyReleaseTrafficReservation("TRN_U", ["FU"], world, rec, new Set());
  E.reservationManager.getOwner = origO; E.reservationManager.releaseSection = origR;
  ok(rel === 0 && rec.reservedSections.indexOf("FU") !== -1 && E.reservationManager.getOwner("FU") === "TRN_U", "M154", "unknown ownership => retained for retry");
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

section("M156 getOccupant returns authoritative Stage5 occupancy");
{
  const { E } = await freshModule();
  setOccupancy(E, DIM, "OQ", "KNOWN_OCCUPIED", "TRN_Q");
  setOccupancy(E, DIM, "OU", "UNKNOWN", "TRN_U2");
  ok(E.occupancyManager.getOccupant("OQ") === "TRN_Q", "M156", "KNOWN_OCCUPIED -> occupant");
  ok(E.occupancyManager.getOccupant("OU") === null, "M156", "UNKNOWN -> null");
  ok(E.occupancyManager.getOccupant("ABSENT") === null, "M156", "missing -> null");
  // read-only: occupancy untouched by call
  ok(E.occupancyManager.getOccupant("OQ") === "TRN_Q" && E.occupancyManager.lastTrainPositions.get("TRN_Q").has("OQ"), "M156", "read-only, authoritative");
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
  // simulate restart: same world, fresh module (fresh managers)
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
  E.reserveSections(["GD"], T, world);
  const rec = new E.TrafficRecord(T); rec.reservedSections = ["GD"];
  E.trafficManager.records.set(T, rec);
  E.trafficManager.tickSave(world, 10);
  ok(world.getDynamicProperty("traffic:" + T) !== undefined, "M159-setup", "DP prewritten");
  E.invalidateTrafficForTrainId(T, world);
  ok(!E.trafficManager.records.has(T), "M159", "record deleted when releases confirmed");
  ok(world.getDynamicProperty("traffic:" + T) === undefined, "M159", "traffic DP removed");
  ok(E.reservationManager.getOwner("GD") === null, "M159", "reservation released");
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
  E.reserveSections(["HB"], T, world);
  const rec = new E.TrafficRecord(T); rec.reservedSections = ["HB"]; E.trafficManager.records.set(T, rec);
  E.occupancyManager.handleTrainDisappearance(T, DIM, world);
  ok(E.reservationManager.getOwner("HB") === null, "M161", "disappeared train's reservations safely released");
  ok(!E.trafficManager.records.has(T), "M161", "record deleted after confirmed releases");
}

section("M161b uncertain release retains record for retry");
{
  const { E, world } = await freshModule();
  const T = "TRN_R";
  E.reserveSections(["RU"], T, world);
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
  ok(r && r.canEnter === false && (r.state === "CONFLICT"), "M163", "CONFLICT still blocked");
  r = E.canEnterRouteSection("MS_NOT_SEEDED", "TRN_ME", world);
  ok(r && r.canEnter === false && r.state === "MISSING_SECTION", "M163", "missing section still blocked");
  setOccupancy(E, DIM, "FF", "KNOWN_EMPTY", null); seedSections(E, DIM, ["FF"]);
  r = E.canEnterRouteSection("FF", "TRN_ME", world);
  ok(r && r.canEnter === true && r.state === "FREE_OR_OWN_RESERVATION", "M163", "free section still enterable (no over-blocking)");
}

// ================================================================ M164-M165: first-seen priority / order independence
function buildContention(E, insertionOrder) {
  // two autonomous trains on separate starts converging on shared section SM
  seedSections(E, DIM, ["A0", "B0", "SM"]);
  for (const t of insertionOrder) {
    if (t === "TRN_A") seedNavRoute(E, t, ["A0", "SM"]); else seedNavRoute(E, t, ["B0", "SM"]);
    seedAutonomous(E, t);
    setOccupancy(E, DIM, t === "TRN_A" ? "A0" : "B0", "KNOWN_OCCUPIED", t);
  }
}
section("M164 first-seen contender is not missed by arbitration");
{
  const { E, world } = await freshModule();
  buildContention(E, ["TRN_A", "TRN_B"]);
  // pre-claim SM by TRN_B (simulating an earlier pass), first-seen TRN_A has NO TrafficRecord yet
  const recB = new E.TrafficRecord("TRN_B"); E.trafficManager.records.set("TRN_B", recB);
  E.trafficManager.upsertClaim("SM", "TRN_B", 0, recB);
  const r = E.tickTrafficCoordinator(world, 8);
  ok(E.trafficManager.records.has("TRN_A"), "M164", "first-seen train received TrafficRecord within one pass");
  ok(E.reservationManager.getOwner("SM") === "TRN_A", "M164", "deterministic tie-break gives SM to TRN_A (equal priority, lexicographic)");
}

section("M165 priority arbitration independent of cursor/insertion order/record existence");
{
  const outcomes = [];
  for (const variant of [["TRN_A", "TRN_B"], ["TRN_B", "TRN_A"], ["TRN_B", "TRN_A", "PREEXIST_B"]]) {
    const { E, world } = await freshModule();
    buildContention(E, variant.slice(0, 2));
    if (variant[2]) { const recB = new E.TrafficRecord("TRN_B"); recB.waitingTicks = 0; E.trafficManager.records.set("TRN_B", recB); }
    E.tickTrafficCoordinator(world, 8);
    outcomes.push(E.reservationManager.getOwner("SM"));
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
  // static: coordinator body must not contain full-map materialization/iteration patterns
  function bodyOf(src, anchor) {
    const i = src.indexOf(anchor); if (i < 0) throw new Error("anchor missing " + anchor);
    let d = 0, j = src.indexOf("{", i);
    for (let k = j; k < src.length; k++) { const c = src[k]; if (c === "{") d++; else if (c === "}") { d--; if (d === 0) return src.slice(i, k + 1); } }
    throw new Error("unbalanced " + anchor);
  }
  const coord = bodyOf(STACK16, "tickTrafficCoordinator(world,budget=TRAFFIC_MAX_TRAINS_PER_TICK){");
  const banned = [/knownTrainToSections\.keys\(\)/, /Array\.from\(this\.records/, /for\s*\(const \[\s*\w+\s*,\s*\w+\s*\] of this\.records\)/, /getEntities\(/, /world\.getDynamicPropertyIds\(\)/];
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
  const region = S16.slice(S16.indexOf(regionStart), S16.indexOf(STACK_END));
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
  // strict zero inside decision-relevant bodies
  function bodyOf(src, anchor) {
    const i = src.indexOf(anchor); if (i < 0) throw new Error("anchor missing " + anchor);
    let d = 0, j = src.indexOf("{", i);
    for (let k = j; k < src.length; k++) { const c = src[k]; if (c === "{") d++; else if (c === "}") { d--; if (d === 0) return src.slice(i, k + 1); } }
    throw new Error("unbalanced " + anchor);
  }
  const strictAnchors = [
    "function makeTrainIdFromMembers(members) {", "function makeSplitTrainId(oldId, members) {",
    "function getOrCreateTrainId(members, world) {", "  reserveSection(sectionId, trainId, world) {",
    "  reserveSections(sectionIds, trainId, world) {", "  releaseSection(sectionId, trainId, world) {",
    "  releaseAllForTrain(trainId, world) {", "tickDrivingController(world,budget){",
    "tickTrafficCoordinator(world,budget=TRAFFIC_MAX_TRAINS_PER_TICK){",
  ];
  let strictBad = [];
  for (const a of strictAnchors) {
    const stripped = bodyOf(STACK16, a).split("\n").map(l => { const ci = l.indexOf("//"); return ci === -1 ? l : l.slice(0, ci); }).join("\n");
    if (/Date\.now|Math\.random/.test(stripped)) strictBad.push(a.slice(0, 60));
  }
  const blockStripped = BLOCK16.split("\n").map(l => { const ci = l.indexOf("//"); return ci === -1 ? l : l.slice(0, ci); }).join("\n");
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
  const missing = stageSymbols.filter(s => !S16.includes(s));
  ok(missing.length === 0, "M169-symbols", `all stage 1-9 components present (missing: ${missing.join(",")})`);
  // base addon preserved: final vs ATTEMPT15 identical outside the 6 edit windows (node-side line diff)
  const a15 = S15.split("\n"), a16 = S16.split("\n");
  const oldTrafficLines = new Set(STACK15.slice(STACK15.indexOf("// Stage10 ATTEMPT15")).split("\n"));
  const newTrafficLines = new Set(BLOCK16.split("\n"));
  const e3Old = "      try { if (typeof occupancyManager !== 'undefined' && occupancyManager.shards) { for (const [k, shard] of occupancyManager.shards) { if (shard.records && shard.records.has(sectionId)) { const occ = shard.records.get(sectionId); if (occ) { if (occ.state === 'UNKNOWN' || occ.state === 'CONFLICT') { return {ok:true, canEnter:false, state: occ.state, reason:'unknown_or_conflict_safely_blocked'}; } } break; } } } } catch(e) {}";
  const insertedNonTraffic = new Set([
    "  // ATTEMPT16: minimal read-only authoritative ownership lookup for traffic arbitration.",
    "  // Reads the existing knownSectionToTrain state only - no duplicated state, no mutation.",
    "  getOwner(sectionId) { if (!sectionId) return null; try { const o = this.knownSectionToTrain.get(sectionId); return o ? o : null; } catch(e) { return null; } }",
    "  // ATTEMPT16: minimal read-only authoritative occupancy lookup for traffic arbitration and the",
    "  // route-entry contract. Scans loaded shards only; returns occupant trainId when state is",
    "  // KNOWN_OCCUPIED, else null. No duplicated state, no mutation, no shard loading.",
    '  getOccupant(sectionId) { if (!sectionId) return null; try { for (const [k, shard] of this.shards) { if (shard.records && shard.records.has(sectionId)) { const rec = shard.records.get(sectionId); if (rec && rec.state === "KNOWN_OCCUPIED") { if (rec.trainId) return rec.trainId; if (rec.trainIds && rec.trainIds.length) return rec.trainIds[0]; return null; } return null; } } } catch(e) {} return null; }',
    "drivingManager.invalidateForSectionId(id,world);\n" /* context, not counted */,
    "try{if(typeof invalidateTrafficForSectionId!==\"undefined\"&&invalidateTrafficForSectionId){invalidateTrafficForSectionId(id,world);}}catch(e){}",
    "    // ATTEMPT16: notify traffic layer of disappearance (guarded hook; occupancy state untouched here).",
    "    // Traffic safely releases tracked reservations and only drops its record when all releases are confirmed.",
    "    try { if (typeof invalidateTrafficForTrainId !== 'undefined' && invalidateTrafficForTrainId) { invalidateTrafficForTrainId(trainId, world || null); } } catch(e) {}",
    "// ATTEMPT16 G-fix: another train's KNOWN_OCCUPIED section blocks entry; own occupancy remains allowed.",
  ]);
  // walk-based minimal diff
  let i = 0, j = 0; const removedLines = [], addedLines = [];
  while (i < a15.length || j < a16.length) {
    if (i < a15.length && j < a16.length && a15[i] === a16[j]) { i++; j++; continue; }
    // resync: look ahead up to 6000 lines
    let best = null;
    outer: for (let wi = i; wi < Math.min(a15.length, i + 6000); wi++) {
      for (let wj = j; wj < Math.min(a16.length, j + 6000); wj++) {
        if (a15[wi] === a16[wj] && a15[wi + 1] === a16[wj + 1] && a15[wi + 2] === a16[wj + 2]) { best = { wi, wj }; break outer; }
      }
    }
    if (!best) { removedLines.push(...a15.slice(i)); addedLines.push(...a16.slice(j)); break; }
    removedLines.push(...a15.slice(i, best.wi)); addedLines.push(...a16.slice(j, best.wj));
    i = best.wi; j = best.wj;
  }
  const allowedOld = l => oldTrafficLines.has(l) || l === e3Old;
  const allowedNew = l => newTrafficLines.has(l) || insertedNonTraffic.has(l) || l.startsWith("if (occ.state === 'KNOWN_OCCUPIED') { const occIds")
    || (l.startsWith("      try { if (typeof occupancyManager !== 'undefined' && occupancyManager.shards)") && l.includes("ATTEMPT16 G-fix"));
  const badOld = removedLines.filter(l => !allowedOld(l));
  const badNew = addedLines.filter(l => !allowedNew(l));
  ok(badOld.length === 0, "M169-old", `vs ATTEMPT15: only E3-old line + ATTEMPT15 traffic block removed (${badOld.length} collateral) ${badOld.slice(0, 2).join("@@")}`);
  ok(badNew.length === 0, "M169-new", `vs ATTEMPT15: only E1-E5 + ATTEMPT16 traffic block added (${badNew.length} collateral) ${badNew.slice(0, 2).join("@@")}`);
  // vs Stage9 ATTEMPT5: Stage1-9 prefix identical except E1-E5
  const pfx9 = STACK9, pfx16 = STACK16.slice(0, STACK16.indexOf("// Stage10 ATTEMPT16"));
  const b9 = pfx9.split("\n"), b16 = pfx16.split("\n");
  let x = 0, y = 0; const r2 = [], a2 = [];
  while (x < b9.length || y < b16.length) {
    if (x < b9.length && y < b16.length && b9[x] === b16[y]) { x++; y++; continue; }
    let best = null;
    outer: for (let wx = x; wx < Math.min(b9.length, x + 6000); wx++) { for (let wy = y; wy < Math.min(b16.length, y + 6000); wy++) { if (b9[wx] === b16[wy] && b9[wx + 1] === b16[wy + 1] && b9[wx + 2] === b16[wy + 2]) { best = { wx, wy }; break outer; } } }
    if (!best) { r2.push(...b9.slice(x)); a2.push(...b16.slice(y)); break; }
    r2.push(...b9.slice(x, best.wx)); a2.push(...b16.slice(y, best.wy)); x = best.wx; y = best.wy;
  }
  const nonBlank = l => l.trim() !== ""; // boundary whitespace between block and events section is irrelevant
  const badOld9 = r2.filter(l => l !== e3Old && nonBlank(l));
  const badNew9 = a2.filter(l => nonBlank(l) && !insertedNonTraffic.has(l) && !l.startsWith("if (occ.state === 'KNOWN_OCCUPIED') { const occIds")
    && !(l.startsWith("      try { if (typeof occupancyManager !== 'undefined' && occupancyManager.shards)") && l.includes("ATTEMPT16 G-fix")));
  ok(badOld9.length === 0 && badNew9.length === 0, "M169-prefix", `Stage1-9 prefix identical to Stage9 ATTEMPT5 except documented E1-E5 hooks (old:${badOld9.length} new:${badNew9.length})`);
}

// ================================================================ M170: ZIP integrity + syntax
section("M170 ZIP integrity + JS syntax + brace balance");
{
  const t = execSync(`unzip -t "${PKG16}" | tail -2`).toString();
  ok(/No errors detected/.test(t), "M170-zip", "unzip -t: no errors");
  const cnt = parseInt(execSync(`unzip -Z1 "${PKG16}" | wc -l`).toString().trim(), 10);
  ok(cnt === 3144, "M170-entries", `entry count = ${cnt}`);
  const chk = path.join(tmpDir, "check_final.mjs"); fs.writeFileSync(chk, S16);
  try { execSync(`node --check "${chk}"`); ok(true, "M170-syntax", "node --check passed (parse = brace+syntax balance)"); }
  catch (e) { ok(false, "M170-syntax", "node --check failed: " + String(e).slice(0, 200)); }
}

// ================================================================ M171: one real manager instance per subsystem
section("M171 single real manager instance per subsystem");
{
  const singles = ["TrackGraphManager", "GraphPointManager", "SectionManager", "OccupancyManager", "TrainIdentityManager", "ReservationManager", "SectionLocationIndexManager", "NavigationManager", "DrivingManager", "TrafficManager"];
  let bad = [];
  for (const m of singles) {
    const instances = (S16.match(new RegExp(`new ${m}\\(`, "g")) || []).length;
    const classes = (S16.match(new RegExp(`class ${m}[ {]`, "g")) || []).length;
    if (instances !== 1 || classes !== 1) bad.push(`${m}: instances=${instances} classes=${classes}`);
  }
  ok(bad.length === 0, "M171", `exactly one class+instance per manager (${bad.join("; ") || "all 10 OK"})`);
  const trafficConst = (S16.match(/const trafficManager=new TrafficManager\(\);/g) || []).length;
  ok(trafficConst === 1, "M171", "single canonical trafficManager singleton");
}

// ================================================================ summary
console.log(`\n========================================`);
console.log(`RESULT: ${pass} passed, ${failN} failed`);
if (failures.length) { console.log("FAILURES:"); for (const f of failures) console.log("  - " + f); process.exit(1); }
console.log("ALL TESTS PASSED");
