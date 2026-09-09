// Stage10 ATTEMPT18 layered on REAL Stage9 ATTEMPT5 c8cb356b - traffic fixes
// ATTEMPT18 (fix-forward on ATTEMPT17 dfe88f5f; 2nd independent-audit items fixed, architecture unchanged):
//  1. OCCUPANCY RESOLVER ZERO SHARD ITERATION: occupancyManager._resolveOccupancyRecord resolves ONLY via
//     the authoritative SectionLocationIndex -> section location/rootPos -> exact occupancy shard key.
//     The sectionManager.shards fallback loop was REMOVED; unresolvable => null (safe-fail).
//  2. OWNERSHIP TRI-STATE: raw getOwner null is NOT "authoritative free". The helper now consumes the
//     read-only Stage7 API reservationManager.getOwnershipState (OWNED/FREE/UNKNOWN):
//       OWNED by another train => remove our stale tracking only (no release call, no world mutation).
//       FREE (authoritative: exact deterministic reservation shard resolved with no record) => remove stale
//         tracking only.
//       OWNED by this train => releaseSection ONLY when occupancy is authoritatively KNOWN_EMPTY.
//       UNKNOWN (unloaded/unresolvable/probe failure) => RETAIN tracking; never release and never forget.
//       occupancy KNOWN_OCCUPIED / UNKNOWN / CONFLICT / unknown => NEVER release.
// ATTEMPT17 (carried forward unchanged):
//  - occupancy safety contract for releases: positively KNOWN_EMPTY gate; unknown/unloaded/probe-failed
//    occupancy => NEVER release; absent-from-loaded-shards is never "free".
//  - direct occupancy shard resolution (no all-shard scan) via getOccupancyState/getOccupant.
//  - authoritative stale-held contract in canEnterRouteSection (self-held reservation + UNKNOWN/CONFLICT
//    occupancy => {canEnter:false, state:'held', stale:true, releaseWhenPossible:true}; read-only).
//  - traffic records load at world load (events/world.ts worldLoaded -> loadTrafficOnWorldLoad(world19)).
// ATTEMPT16 (carried forward unchanged):
//  - release-behind + destination/completion releases via the single safe helper; success/authoritative
//    foreign-owner/authoritative free => drop tracking; failed/unknown => RETAIN for retry; occupancy
//    never mutated.
//  - read-only authoritative APIs reservationManager.getOwner / occupancyManager.getOccupant.
//  - TRAFFIC_VERSION persistence, deterministic rotating save cursor, DP cleanup on definitive delete,
//    loadAll at world load.
//  - priority arbitration pure in (effectivePriority, trainId); each batch sorted before processing.
//  - fixed ATTEMPT15 latent arg-order bugs: resolveLeadingCurrentSection(trainId, world, route, occupiedSet)
//    and reservationManager.reserveSections(sectionIds, trainId, world).
const TRAFFIC_VERSION=1;
const TRAFFIC_DP_PREFIX="traffic:";
const TRAFFIC_RESERVATION_HORIZON=5;
const TRAFFIC_MAX_TRAINS_PER_TICK=8;
const TRAFFIC_MAX_MUTATIONS_PER_TICK=8;
const TRAFFIC_MAX_RESERVE_PER_ATTEMPT=8;
const TRAFFIC_RELEASE_BUDGET_PER_TRAIN=16;
const MAX_PENDING_SECTIONS=100;
const MAX_CLAIMS_PER_SECTION=8;
const TRAFFIC_SAVE_BUDGET=2;
class TrafficRecord{ constructor(t){ this.trainId=t; this.reservedSections=[]; this.claimedSections=[]; this.priority=0; this.waitingTicks=0; this.state=0; this.version=TRAFFIC_VERSION; } }
// Single safe release helper. occupiedSet = hint set of sections believed occupied by THIS train.
// ATTEMPT18 ownership semantics (via reservationManager.getOwnershipState - read-only Stage7 tri-state):
//   OWNED by another train => remove our stale tracking only (no release call, no world mutation).
//   FREE (authoritative)    => remove our stale tracking only (no release call).
//   OWNED by this train     => releaseSection ONLY when occupancy authoritatively KNOWN_EMPTY.
//   UNKNOWN (or probe fail) => RETAIN tracking; never release and never forget.
//   A null/absent ownership result from the manager is NEVER treated as authoritative FREE.
// ATTEMPT17 occupancy contract (unchanged): KNOWN_EMPTY proven => releasable; KNOWN_OCCUPIED / UNKNOWN /
// CONFLICT / unknown / probe-failed occupancy => NEVER release. MUST NOT mutate occupancyManager state.
function safelyReleaseTrafficReservation(trainId, sectionIds, world, rec, occupiedSet){
 try{
  if(!trainId||!sectionIds||sectionIds.length===0) return 0; if(!rec) return 0;
  let released=0; const toRemove=[];
  for(const secId of sectionIds){
   try{
    if(!secId) continue;
    if(occupiedSet && occupiedSet.has && occupiedSet.has(secId)) continue; // known occupied by this train => NEVER release
    let own=null;
    try{ if(typeof reservationManager!=="undefined" && typeof reservationManager.getOwnershipState==="function"){ own=reservationManager.getOwnershipState(secId, world||null); } }catch(e){ own=null; }
    if(own && own.state==="OWNED" && own.owner && own.owner!==trainId){ toRemove.push(secId); continue; } // authoritative foreign owner => our tracking stale
    if(own && own.state==="FREE"){ toRemove.push(secId); continue; } // authoritative free => our tracking stale
    if(!own || own.state!=="OWNED" || own.owner!==trainId){ continue; } // UNKNOWN ownership => RETAIN (never release, never forget)
    // OWNED by this train: occupancy must be POSITIVELY known NOT occupied, else NEVER release
    let occState=null;
    try{ if(typeof occupancyManager!=="undefined" && typeof occupancyManager.getOccupancyState==="function"){ occState=occupancyManager.getOccupancyState(secId, world||null); } }catch(e){ occState=null; }
    if(!occState || occState.state!=="KNOWN_EMPTY"){ continue; }
    let success=false;
    try{ if(typeof reservationManager!=="undefined" && typeof reservationManager.releaseSection==="function"){ const res=reservationManager.releaseSection(secId, trainId, world); if(res===true) success=true; else if(res && typeof res==="object"){ if(res.ok===true || res.success===true) success=true; } } }catch(e){ success=false; }
    if(success){ toRemove.push(secId); released++; }
    // failed => RETAIN tracking for retry (never forget)
   }catch(e){}
  }
  for(const sid of toRemove){ try{ const idx=rec.reservedSections.indexOf(sid); if(idx!==-1) rec.reservedSections.splice(idx,1); }catch(e){} }
  return released;
 }catch(e){ return 0; }
}
class TrafficManager{
 constructor(){ this.records=new Map(); this.pendingClaims=new Map(); this._claimSectionOrder=[]; this._trafficIterator=null; this._trafficIteratorDone=true; this._saveCursor=0; this._saveKeys=[]; this._saveKeysDirty=true; this._releaseRetryQueue=[]; }
 _markSaveKeysDirty(){ this._saveKeysDirty=true; }
 // Pure effective priority: lower is better. Depends only on (records, trainId) - never on cursor position,
 // Map insertion order, or whether a TrafficRecord existed before (record-less contender evaluates to p=0,w=0).
 effectivePriorityFor(tid){ try{ const rec=this.records.get(tid); const p=rec?(rec.priority||0):0; const w=rec?(rec.waitingTicks||0):0; return p-w; }catch(e){ return 0; } }
 // Authoritative occupancy view for this train's releases. Sources (read-only, no duplication/mutation):
 //  a) occupancyManager.knownTrainToSections (if that coverage map exists)
 //  b) occupancyManager.lastTrainPositions (Stage5 authoritative per-train coverage: Map<trainId, Map<sectionId, railPos>>)
 // every candidate is confirmed against the authoritative per-section API getOccupant(sid)===tid; a failed probe
 // is treated as occupied (conservative: never release).
 _occupiedSetFor(tid){ try{
  const out=new Set();
  try{ if(typeof occupancyManager!=="undefined" && occupancyManager.knownTrainToSections){ const raw=occupancyManager.knownTrainToSections.get(tid); if(raw&&raw.size){ for(const sid of raw){ if(!sid||out.has(sid)) continue; try{ if(typeof occupancyManager.getOccupant==="function"){ if(occupancyManager.getOccupant(sid)===tid) out.add(sid); } else { out.add(sid); } }catch(e){ out.add(sid); } } } } }catch(e){}
  try{ if(typeof occupancyManager!=="undefined" && occupancyManager.lastTrainPositions){ const lm=occupancyManager.lastTrainPositions.get(tid); if(lm&&lm.size&&lm.keys){ for(const sid of lm.keys()){ if(!sid||out.has(sid)) continue; try{ if(typeof occupancyManager.getOccupant==="function"){ if(occupancyManager.getOccupant(sid)===tid) out.add(sid); } else { out.add(sid); } }catch(e){ out.add(sid); } } } } }catch(e){}
  return out;
 }catch(e){ return new Set(); } }
 // ---- claims (bounded: <=MAX_PENDING_SECTIONS sections x <=MAX_CLAIMS_PER_SECTION trains) ----
 upsertClaim(secId,tid,eff,rec){ try{
  if(!secId||!tid) return false;
  let sm=this.pendingClaims.get(secId);
  if(!sm){ if(this.pendingClaims.size>=MAX_PENDING_SECTIONS){ const oldest=this._claimSectionOrder.shift(); if(oldest){ const evicted=this.pendingClaims.get(oldest); if(evicted){ try{ for(const [t] of evicted){ try{ const r=this.records.get(t); if(r&&r.claimedSections){ const ci=r.claimedSections.indexOf(oldest); if(ci!==-1) r.claimedSections.splice(ci,1); } }catch(e){} } }catch(e){} } this.pendingClaims.delete(oldest); } } sm=new Map(); this.pendingClaims.set(secId,sm); this._claimSectionOrder.push(secId); }
  if(sm.has(tid)){ sm.set(tid,{trainId:tid,effectivePriority:eff}); if(rec&&rec.claimedSections.indexOf(secId)===-1) rec.claimedSections.push(secId); return true; }
  if(sm.size<MAX_CLAIMS_PER_SECTION){ sm.set(tid,{trainId:tid,effectivePriority:eff}); if(rec&&rec.claimedSections.indexOf(secId)===-1) rec.claimedSections.push(secId); return true; }
  let worst=null; for(const [t,c] of sm){ if(!worst) worst=c; else if(c.effectivePriority>worst.effectivePriority || (c.effectivePriority===worst.effectivePriority && c.trainId>worst.trainId)) worst=c; }
  if(worst && (eff<worst.effectivePriority || (eff===worst.effectivePriority && tid<worst.trainId))){ sm.delete(worst.trainId); try{ const r=this.records.get(worst.trainId); if(r&&r.claimedSections){ const ci=r.claimedSections.indexOf(secId); if(ci!==-1) r.claimedSections.splice(ci,1); } }catch(e){} sm.set(tid,{trainId:tid,effectivePriority:eff}); if(rec&&rec.claimedSections.indexOf(secId)===-1) rec.claimedSections.push(secId); return true; }
  return false;
 }catch(e){ return false; } }
 removeClaim(secId,tid,rec){ try{ const sm=this.pendingClaims.get(secId); if(sm){ sm.delete(tid); if(sm.size===0){ this.pendingClaims.delete(secId); const idx=this._claimSectionOrder.indexOf(secId); if(idx!==-1) this._claimSectionOrder.splice(idx,1); } } if(rec&&rec.claimedSections){ const ci=rec.claimedSections.indexOf(secId); if(ci!==-1) rec.claimedSections.splice(ci,1); } }catch(e){} }
 removeClaimsForTrain(tid,rec){ try{ rec=rec||this.records.get(tid); if(!rec||!rec.claimedSections) return; const list=rec.claimedSections.slice(); for(const secId of list){ this.removeClaim(secId,tid,rec); } }catch(e){} }
 getClaimsForSection(secId){ try{ const sm=this.pendingClaims.get(secId); if(!sm) return []; const arr=[]; for(const [t,c] of sm) arr.push(c); arr.sort((a,b)=>{ if(a.effectivePriority!==b.effectivePriority) return a.effectivePriority-b.effectivePriority; return a.trainId<b.trainId?-1:(a.trainId>b.trainId?1:0); }); return arr; }catch(e){ return []; } }
 // ---- persistence (bounded, versioned, rotating save cursor, DP cleanup on definitive delete) ----
 _deleteRecordDP(world,tid){ try{ if(world&&world.setDynamicProperty){ world.setDynamicProperty(TRAFFIC_DP_PREFIX+tid, undefined); } }catch(e){} }
 tickSave(world,budget=TRAFFIC_SAVE_BUDGET){ try{
  if(!world||!world.setDynamicProperty) return 0;
  if(this._saveKeysDirty){ this._saveKeys=Array.from(this.records.keys()).sort(); this._saveKeysDirty=false; this._saveCursor=this._saveKeys.length>0?(this._saveCursor%this._saveKeys.length):0; }
  const keys=this._saveKeys; const n=keys.length; if(n===0) return 0;
  let saved=0; let attempts=0;
  while(saved<budget && attempts<n){
   const tid=keys[this._saveCursor%n]; this._saveCursor=(this._saveCursor+1)%n; attempts++;
   const rec=this.records.get(tid); if(!rec) continue;
   try{ const payload={v:TRAFFIC_VERSION,reserved:rec.reservedSections.slice(0,64),claimed:rec.claimedSections.slice(0,64),priority:rec.priority,waiting:rec.waitingTicks,state:rec.state}; world.setDynamicProperty(TRAFFIC_DP_PREFIX+tid, JSON.stringify(payload)); saved++; }catch(e){ break; }
  }
  return saved;
 }catch(e){ return 0; } }
 loadAll(world){ try{
  if(!world||!world.getDynamicProperty) return 0;
  let ids=[]; try{ if(world.getDynamicPropertyIds) ids=world.getDynamicPropertyIds(); else if(world.getDynamicProperties) ids=world.getDynamicProperties(); }catch(e){ ids=[]; }
  let loaded=0;
  for(const k of ids){ try{ if(typeof k!=="string"||k.indexOf(TRAFFIC_DP_PREFIX)!==0) continue; const tid=k.substring(TRAFFIC_DP_PREFIX.length); const raw=world.getDynamicProperty(k); if(typeof raw!=="string") continue; let p=null; try{ p=JSON.parse(raw); }catch(e){ continue; } if(!p||typeof p!=="object") continue; if(p.v!==undefined && p.v!==TRAFFIC_VERSION){ continue; } const rec=new TrafficRecord(tid); rec.reservedSections=Array.isArray(p.reserved)?p.reserved.slice(0,64):[]; rec.claimedSections=Array.isArray(p.claimed)?p.claimed.slice(0,64):[]; rec.priority=(typeof p.priority==="number"&&isFinite(p.priority))?p.priority:0; rec.waitingTicks=(typeof p.waiting==="number"&&isFinite(p.waiting))?p.waiting:0; rec.state=(typeof p.state==="number"&&isFinite(p.state))?p.state:0; for(const sid of rec.claimedSections){ this.upsertClaim(sid,tid,this.effectivePriorityFor(tid),rec); } this.records.set(tid,rec); loaded++; }catch(e){} }
  if(loaded>0) this._markSaveKeysDirty();
  return loaded;
 }catch(e){ return 0; } }
 // ---- invalidation (wired into Stage9 removeSections wrapper + Stage5 handleTrainDisappearance hooks) ----
 invalidateForSectionId(secId,world){ try{
  if(!secId) return;
  const tids=[]; for(const [trainId,rec] of this.records){ if(rec.reservedSections.indexOf(secId)!==-1||(rec.claimedSections&&rec.claimedSections.indexOf(secId)!==-1)) tids.push(trainId); }
  this.pendingClaims.delete(secId); const oi=this._claimSectionOrder.indexOf(secId); if(oi!==-1) this._claimSectionOrder.splice(oi,1);
  for(const trainId of tids){ const rec=this.records.get(trainId); if(!rec) continue;
   try{ if(rec.claimedSections){ const ci=rec.claimedSections.indexOf(secId); if(ci!==-1) rec.claimedSections.splice(ci,1); } }catch(e){}
   try{ const occSet=this._occupiedSetFor(trainId); safelyReleaseTrafficReservation(trainId,[secId],world,rec,occSet); }catch(e){}
   // failed/unknown release retains tracking in rec.reservedSections for retry (helper semantics)
  }
 }catch(e){} }
 invalidateForTrainId(trainId,world){ try{
  if(!trainId) return;
  const rec=this.records.get(trainId);
  try{ this.removeClaimsForTrain(trainId,rec); }catch(e){}
  if(!rec){ this._deleteRecordDP(world,trainId); return; }
  try{ const occSet=this._occupiedSetFor(trainId); const toRel=rec.reservedSections.slice(); if(toRel.length>0) safelyReleaseTrafficReservation(trainId,toRel,world,rec,occSet); }catch(e){}
  // delete record + DP only when every release is confirmed successful/no-longer-owned; else retain for retry
  if(rec.reservedSections.length===0){ this.records.delete(trainId); this._deleteRecordDP(world,trainId); this._markSaveKeysDirty(); }
  else { if(this._releaseRetryQueue.indexOf(trainId)===-1) this._releaseRetryQueue.push(trainId); this._markSaveKeysDirty(); }
 }catch(e){} }
 getTrafficState(tid,world){ try{ return this.records.get(tid)||null; }catch(e){ return null; } }
 // Bounded trailing release: sections strictly behind the whole coupled train, occupied skipped inside helper.
 releaseSectionsBehind(tid,curIdx,route,occSet,world,rec,maxLeft){ try{
  if(curIdx<=0||!route) return 0; const behind=[]; const cap=Math.min(TRAFFIC_RELEASE_BUDGET_PER_TRAIN,(typeof maxLeft==="number"&&maxLeft>=0)?maxLeft:TRAFFIC_RELEASE_BUDGET_PER_TRAIN); if(cap<=0) return 0;
  for(let i=0;i<curIdx;i++){ const sid=route[i]; if(!sid) continue; if(occSet&&occSet.has&&occSet.has(sid)) continue; if(rec.reservedSections.indexOf(sid)!==-1) behind.push(sid); if(behind.length>=cap) break; }
  if(behind.length===0) return 0; return safelyReleaseTrafficReservation(tid,behind,world,rec,occSet);
 }catch(e){ return 0; } }
 // ---- coordinator (bounded: <=budget trains/pass, <=TRAFFIC_MAX_MUTATIONS_PER_TICK reserve+release calls) ----
 tickTrafficCoordinator(world,budget=TRAFFIC_MAX_TRAINS_PER_TICK){ try{
  if(!world||!world.getDynamicProperty) return {ok:false,reason:'no_world',processed:0};
  if(typeof budget!=="number"||budget<=0) budget=TRAFFIC_MAX_TRAINS_PER_TICK;
  let mutations=0;
  // bounded release-retry passes first (<=2 per pass)
  let retryProcessed=0;
  while(this._releaseRetryQueue.length>0 && retryProcessed<2 && mutations<TRAFFIC_MAX_MUTATIONS_PER_TICK){
   const tid=this._releaseRetryQueue.shift(); retryProcessed++;
   try{
    const rec=this.records.get(tid);
    if(!rec){ this._deleteRecordDP(world,tid); continue; }
    if(rec.reservedSections.length===0){ if(!rec.claimedSections||rec.claimedSections.length===0){ this.records.delete(tid); this._deleteRecordDP(world,tid); this._markSaveKeysDirty(); } continue; }
    const occSet=this._occupiedSetFor(tid);
    const cap=Math.min(rec.reservedSections.length,TRAFFIC_RELEASE_BUDGET_PER_TRAIN,TRAFFIC_MAX_MUTATIONS_PER_TICK-mutations);
    const rel=safelyReleaseTrafficReservation(tid,rec.reservedSections.slice(0,cap),world,rec,occSet); mutations+=rel;
    if(rec.reservedSections.length>0){ this._releaseRetryQueue.push(tid); }
    else if(!rec.claimedSections||rec.claimedSections.length===0){ this.records.delete(tid); this._deleteRecordDP(world,tid); this._markSaveKeysDirty(); }
   }catch(e){}
  }
  // bounded rotating selection over driving-known trains (rotating cursor, no full scans)
  let toProcess=[];
  try{
   if(!this._trafficIterator||this._trafficIteratorDone){ if(typeof drivingManager!=="undefined"&&drivingManager.knownTrainToDriving){ this._trafficIterator=drivingManager.knownTrainToDriving.entries(); this._trafficIteratorDone=false; } }
   if(this._trafficIterator){
    for(let i=0;i<budget;i++){ const r=this._trafficIterator.next(); if(r.done){ this._trafficIteratorDone=true; break; } const e=r.value; if(!e) continue; const tid=e[0]; const ds=e[1]; if(!tid) continue;
     if(ds && ds.autonomousActive===false){ try{ const recS=this.records.get(tid); if(recS&&recS.claimedSections&&recS.claimedSections.length>0){ this.removeClaimsForTrain(tid,recS); } }catch(e){} continue; }
     toProcess.push(tid);
    }
    if(this._trafficIteratorDone){ if(typeof drivingManager!=="undefined"&&drivingManager.knownTrainToDriving){ this._trafficIterator=drivingManager.knownTrainToDriving.entries(); this._trafficIteratorDone=false; } }
   }
  }catch(e){}
  // deterministic arbitration batch: sort by (effectivePriority, trainId) ascending. This makes arbitration
  // independent of the rotating cursor, Map insertion order, and TrafficRecord pre-existence.
  try{ toProcess.sort((a,b)=>{ const ea=this.effectivePriorityFor(a); const eb=this.effectivePriorityFor(b); if(ea!==eb) return ea-eb; return a<b?-1:(a>b?1:0); }); }catch(e){}
  if(toProcess.length===0) return {ok:true,processed:0,mutations:mutations};
  let processed=0; const intended=new Set();
  for(const trainId of toProcess){
   if(mutations>=TRAFFIC_MAX_MUTATIONS_PER_TICK) break;
   try{
    let rec=this.records.get(trainId); if(!rec){ rec=new TrafficRecord(trainId); this.records.set(trainId,rec); this._markSaveKeysDirty(); }
    const navState=(typeof navigationManager!=="undefined")?navigationManager.getNavigationState(trainId,world):null;
    const navStatus=navState?(navState.status||null):null;
    const route=(navState&&navState.routeSectionIds&&navState.routeSectionIds.length>0)?navState.routeSectionIds:null;
    if(!route || navStatus==="INVALIDATED"||navStatus==="NO_ROUTE"||navStatus==="FAILED"||navStatus==="IDLE"){
     // completion / no-route: clear claims, bounded safe release of tracked non-occupied reservations, retain on failure
     try{ this.removeClaimsForTrain(trainId,rec); }catch(e){}
     if(rec.reservedSections.length>0){
      const occSet=this._occupiedSetFor(trainId);
      const cap=Math.min(rec.reservedSections.length,TRAFFIC_RELEASE_BUDGET_PER_TRAIN,TRAFFIC_MAX_MUTATIONS_PER_TICK-mutations);
      const rel=safelyReleaseTrafficReservation(trainId,rec.reservedSections.slice(0,cap),world,rec,occSet); mutations+=rel;
      if(rec.reservedSections.length>0){ if(this._releaseRetryQueue.indexOf(trainId)===-1) this._releaseRetryQueue.push(trainId); }
      else if(rec.claimedSections.length===0){ this.records.delete(trainId); this._deleteRecordDP(world,trainId); this._markSaveKeysDirty(); }
     } else if(rec.claimedSections.length===0){ this.records.delete(trainId); this._deleteRecordDP(world,trainId); this._markSaveKeysDirty(); }
     continue;
    }
    const occSet=this._occupiedSetFor(trainId);
    // leading current section (ATTEMPT16: correct arg order trainId,world,route,occSet)
    let curIdx=-1;
    try{ const lr=resolveLeadingCurrentSection(trainId,world,route,occSet); if(lr&&lr.ok){ let li=-1; try{ li=route.indexOf(lr.sectionId); }catch(e){} if(li!==-1) curIdx=li; else if(typeof lr.index==="number") curIdx=lr.index; } }catch(e){}
    if(curIdx===-1){ for(const sid of occSet){ const ii=route.indexOf(sid); if(ii!==-1&&ii>curIdx) curIdx=ii; } }
    if(curIdx===-1){ continue; } // position unknown => safe-fail; no blind reservations
    // 1. release safely behind the whole coupled train (occupied sections are skipped inside the helper)
    if(curIdx>0 && rec.reservedSections.length>0 && mutations<TRAFFIC_MAX_MUTATIONS_PER_TICK){ const rel=this.releaseSectionsBehind(trainId,curIdx,route,occSet,world,rec,TRAFFIC_MAX_MUTATIONS_PER_TICK-mutations); mutations+=rel; }
    // 2. destination/completion: at final route section => clear claims + release remaining tracked (occupied skipped)
    if(curIdx>=route.length-1){
     try{ this.removeClaimsForTrain(trainId,rec); }catch(e){}
     if(rec.reservedSections.length>0 && mutations<TRAFFIC_MAX_MUTATIONS_PER_TICK){
      const cap=Math.min(rec.reservedSections.length,TRAFFIC_RELEASE_BUDGET_PER_TRAIN,TRAFFIC_MAX_MUTATIONS_PER_TICK-mutations);
      const rel=safelyReleaseTrafficReservation(trainId,rec.reservedSections.slice(0,cap),world,rec,occSet); mutations+=rel;
      if(rec.reservedSections.length>0){ if(this._releaseRetryQueue.indexOf(trainId)===-1) this._releaseRetryQueue.push(trainId); }
      else if(rec.claimedSections.length===0){ this.records.delete(trainId); this._deleteRecordDP(world,trainId); this._markSaveKeysDirty(); }
     } else if(rec.reservedSections.length===0 && rec.claimedSections.length===0){ this.records.delete(trainId); this._deleteRecordDP(world,trainId); this._markSaveKeysDirty(); }
     continue;
    }
    // 3. claims + forward reservation (bounded horizon of 5 sections, max 8 sections per attempt)
    const myEff=this.effectivePriorityFor(trainId);
    const fwd=[]; for(let f=1;f<=TRAFFIC_RESERVATION_HORIZON;f++){ const sIdx=curIdx+f; if(sIdx>=route.length) break; const sId=route[sIdx]; if(!sId) continue; if(occSet.has(sId)) continue; fwd.push(sId); }
    for(const sid of fwd){ try{ this.upsertClaim(sid,trainId,myEff,rec); }catch(e){} }
    let blocked=false;
    for(const sId of fwd){
     try{ const claims=this.getClaimsForSection(sId); if(claims.length>0){ const win=claims[0]; if(win.trainId!==trainId){ if(win.effectivePriority<myEff || (win.effectivePriority===myEff && win.trainId<trainId)){ blocked=true; break; } } } }catch(e){}
     if(intended.has(sId)){ blocked=true; break; }
     try{ if(typeof reservationManager!=="undefined" && typeof reservationManager.getOwner==="function"){ const own=reservationManager.getOwner(sId); if(own && own!==trainId){ const oEff=this.effectivePriorityFor(own); if(oEff<myEff || (oEff===myEff && own<trainId)){ blocked=true; break; } } } }catch(e){}
     try{ if(typeof occupancyManager!=="undefined" && typeof occupancyManager.getOccupant==="function"){ const occ=occupancyManager.getOccupant(sId); if(occ && occ!==trainId){ blocked=true; break; } } }catch(e){}
    }
    if(blocked){ rec.waitingTicks=(rec.waitingTicks||0)+1; for(const sid of fwd){ try{ this.upsertClaim(sid,trainId,this.effectivePriorityFor(trainId),rec); }catch(e){} } continue; }
    const toRes=[]; const alreadyOwned=[];
    for(const sId of fwd){ if(intended.has(sId)) break; let own=false; try{ if(typeof reservationManager!=="undefined" && typeof reservationManager.getOwner==="function" && reservationManager.getOwner(sId)===trainId) own=true; }catch(e){} if(own){ alreadyOwned.push(sId); continue; } toRes.push(sId); if(toRes.length>=TRAFFIC_MAX_RESERVE_PER_ATTEMPT) break; }
    // sections already owned by us confirm without a mutation call (keeps the mutation budget for real work)
    if(alreadyOwned.length>0){ try{ const existingSet=new Set(rec.reservedSections); for(const sid of alreadyOwned) existingSet.add(sid); rec.reservedSections=Array.from(existingSet); for(const sid of alreadyOwned){ try{ this.removeClaim(sid,trainId,rec); }catch(e){} } }catch(e){} }
    if(toRes.length===0) continue;
    if(mutations>=TRAFFIC_MAX_MUTATIONS_PER_TICK) continue; // deferred to a later pass; claims keep intent visible
    mutations++; // one reserveSections call counts as one traffic mutation (its section set is itself bounded)
    try{
     const result=(typeof reservationManager!=="undefined" && reservationManager.reserveSections)?reservationManager.reserveSections(toRes,trainId,world):{ok:false,reason:'missing_manager'}; // ATTEMPT16: fixed ATTEMPT15 arg-order bug (sectionIds, trainId, world)
     if(result && result.ok){
      let confirmed=[]; if(result.reserved && Array.isArray(result.reserved)) confirmed=result.reserved; else if(result.sections && Array.isArray(result.sections)) confirmed=result.sections; else confirmed=toRes;
      for(const sid of confirmed){ intended.add(sid); try{ this.removeClaim(sid,trainId,rec); }catch(e){} }
      const existingSet=new Set(rec.reservedSections); for(const sid of confirmed) existingSet.add(sid); rec.reservedSections=Array.from(existingSet);
      rec.waitingTicks=0; processed++;
     } else { rec.waitingTicks=(rec.waitingTicks||0)+1; for(const sid of fwd){ try{ this.upsertClaim(sid,trainId,this.effectivePriorityFor(trainId),rec); }catch(e){} } }
    }catch(e){ rec.waitingTicks=(rec.waitingTicks||0)+1; for(const sid of fwd){ try{ this.upsertClaim(sid,trainId,this.effectivePriorityFor(trainId),rec); }catch(e){} } }
   }catch(e){}
  }
  return {ok:true,processed:processed,mutations:mutations};
 }catch(e){ return {ok:false,reason:'exception',processed:0}; } }
}
const trafficManager=new TrafficManager();
function tickTrafficCoordinator(world,budget){ try{ return trafficManager.tickTrafficCoordinator(world,budget); }catch(e){ return {ok:false,reason:'exception',processed:0}; } }
function tickTrafficSave(world){ try{ return trafficManager.tickSave(world,TRAFFIC_SAVE_BUDGET); }catch(e){ return 0; } }
function loadTrafficOnWorldLoad(world){ try{ return trafficManager.loadAll(world); }catch(e){ return 0; } }
function getTrafficState(trainId,world){ try{ return trafficManager.getTrafficState(trainId,world); }catch(e){ return null; } }
function invalidateTrafficForSectionId(sid,w){ try{ trafficManager.invalidateForSectionId(sid,w); }catch(e){} }
function invalidateTrafficForTrainId(tid,w){ try{ trafficManager.invalidateForTrainId(tid,w); }catch(e){} }
try{
const __realWorldForTraffic=(typeof world8!=='undefined'?world8:(typeof world5!=='undefined'?world5:world19));
if(typeof system9!=='undefined'){
 system9.runInterval(()=>{try{const w=__realWorldForTraffic; if(w&&w.getDynamicProperty){tickTrafficCoordinator(w,TRAFFIC_MAX_TRAINS_PER_TICK);}}catch(e){}},10);
 system9.runInterval(()=>{try{const w=__realWorldForTraffic; if(w&&w.getDynamicProperty){tickTrafficSave(w);}}catch(e){}},10);
 // ATTEMPT17: traffic records are loaded at world load (authoritative event wiring in the
 // events/world.ts worldLoaded handler -> loadTrafficOnWorldLoad(world19)), not at module eval,
 // so reload order after a restart is the authoritative world-load sequence.
}
}catch(e){console.warn('[Stage10 ATTEMPT18] traffic wrapper',e);}

