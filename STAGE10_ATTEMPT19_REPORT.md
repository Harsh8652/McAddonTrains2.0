# STAGE 10 — ATTEMPT19 (final audit edge fix) — DELIVERED

**Package:** `TRAINS_Phase1_Stage10_ATTEMPT19.mcaddon`
**SHA256:** `7c3a1b92b8cab6bd9e689ed7744974b2678122d3f7f39b965ad6312d5d7357ac`
**Size:** 7,446,759 bytes · **ZIP entries:** 3,144 (`unzip -t`: no errors) · **main.js:** 873,737 bytes / 18,375 lines (`node --check` passed)
**Manifests:** both packs `[1,1,10]` — header + cross-dependency (BP→RP `[1,1,10]`, RP→BP `[1,1,10]`, UUIDs unchanged; verified from the binary)
**Base:** packaged ATTEMPT18 (`691732e9…`) — **one** surgical hunk, everything else byte-preserved
**Tests:** **182/182 PASS** (three independent runs) — `node dev/stage10_attempt19_tests.mjs`, executed against the **actual packaged** `.mcaddon`

---

## The one consistency edge — closed

The forensic audit proved: `getOwnershipState` can authoritatively report OWNED from a persisted
reservation shard while `knownSectionToTrain` is empty, yet the old `releaseSection` early-return
(`if (!existingOwner) return {ok:true, state:'already_free'}`, packaged ATTEMPT18 L3844) answered
`already_free` **without deleting the persisted OWNED record** — so the traffic helper could drop
tracking while the reservation survived.

**E9 fix (23 lines replacing that 1 line, the only change vs ATTEMPT18):** on an in-memory owner-map
miss, `releaseSection` now resolves ownership authoritatively:

1. deterministic 16×4 double-hash index (`getShardIndicesForSectionId`) → in-memory `shards.get(key)`
   hit, **else** direct `ReservationShard.tryLoad(world, primary, sub)` of that ONE persisted shard
   (zero shard-map iteration; proven: 0 iterations, exactly 1 DP read);
2. a loaded authoritative shard is adopted with the **same rebuild semantics** as `loadAll`/
   `getOrCreateShard` (records replayed into both owner indexes; DP untouched);
3. resolved shard holds **no record** ⇒ `{ok:true, state:'already_free'}` — only now is free authoritative;
4. record owned by **another train** ⇒ `{ok:false, reason:'NOT_OWNER', owner}` — **no mutation**;
5. record owned by **this train** ⇒ delete record, update both in-memory indexes, `markDirty` +
   `tickSave(1)` ⇒ `{ok:true, state:'RELEASED'}` — a genuinely durable release;
6. unresolvable / probe failure / missing world ⇒ `{ok:false, reason:'ownership_unknown',
   state:'UNKNOWN'}` — **never** `already_free`.

Normal in-memory-owner path unchanged; `getOwnershipState` preserved read-only; the helper's
KNOWN_EMPTY-only occupancy gate not weakened; no `Date.now`/`Math.random`; no occupancy mutation
from reservation code.

## Exact diff vs ATTEMPT18

`main.js` (E9 hunk only: 1 line → 23 lines) + the two `manifest.json` files. **3,141 of 3,144 entries
byte-identical.** Line-walk diff (M169-diff19): removed=1, added=23, zero collateral. Stage1–9 prefix
vs Stage9 ATTEMPT5: identical except the documented cumulative hooks (E1/E8/E2″/E3′/E4/E5 + E9).

## Tests — M150–M202, 182/182 PASS

- **M193** persisted-only OWNED + empty memory ⇒ `releaseSection` returns **RELEASED**, record durably deleted, FREE afterward (incl. after re-resolve)
- **M194** persisted foreign owner ⇒ `NOT_OWNER` naming the owner, DP byte-identical, reservation preserved
- **M195** resolved-empty shard ⇒ `already_free` returned only there; FREE cross-confirmed
- **M196** no-world / hash-throw probes ⇒ `ownership_unknown` (never `already_free`); record untouched; releases after recovery
- **M197** helper drops tracking only after a **genuine** durable free (no zombie); unknown-occupancy retention unchanged
- **M198** successful release ⇒ persisted + in-memory both FREE, no resurrection after restart
- **M199** static (no `this.shards` iteration in `releaseSection`) + runtime (0 shard-map iterations, exactly 1 DP read)
- **M200** all M150–M192 regressions pass against the packaged ATTEMPT19 (169 prior assertions, 0 failures)
- **M201** Stage7/8/9 cumulative defs, singletons, ATTEMPT19 surfaces live on packaged singletons
- **M202** ZIP integrity, 3,144 entries, `node --check`, name, headers `[1,1,10]`, cross-dependency `[1,1,10]` both directions, exact-diff gate, SHA/size

Full ATTEMPT16/17/18 mechanics preserved and re-verified by the suite: ownership tri-state gate,
zero-iteration occupancy resolver, KNOWN_EMPTY-only release contract, stale-held `canEnterRouteSection`
contract, atomic `reserveSections`, release-behind/completion/retry, persistence + save cursor + DP
cleanup, horizon 5, ≤8 mutations/tick, deterministic arbitration, bounded claims, world-load wiring.

## STOP boundary

Stage10 is **not approved**. ATTEMPT19 is delivered for validation. No Stage11 work has begun.
