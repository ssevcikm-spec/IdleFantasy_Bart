# Worker Hiring / Queueing + Efficiency System — Analysis

**Project:** Idle Fantasy (free offline idle RPG) — com.fantasyidler
**Scope:** worker hiring, queueing, and efficiency/throughput, with a specific check on
whether the system works for **gathering** but **not** for **production/crafting**.

**Verdict (hypothesis): FALSE.** The worker system is wired end-to-end for both
resource-gathering and production/crafting. Higher worker tiers genuinely make crafting
faster *and* higher-capacity. What differs is only the *mechanism*: gathering applies a
collect-time multiplier, crafting applies a queue-time speed + capacity model. Both are
driven by the same per-tier efficiencyMultiplier.

---

## 1. Project structure (relevant subset)

- Kotlin source root: app/src/main/kotlin/com/fantasyidler/
- data/model/PlayerModels.kt — persisted model: PlayerFlags, QueuedAction, WorkerTier,
  HiredWorker, SkillSessionExport, EquipSlot, Skills.
- data/model/SkillSession.kt — Room entity for a single session (player or worker).
- repository/ — business logic:
  - PlayerRepository.kt — worker hire/queue persistence (enqueueWorkerAction,
    dequeueNextWorkerAction, clearHiredWorker) and collect-time result scaling
    (applySessionResults, applyMultiSkillResultsUnlocked).
  - SessionRepository.kt — startSession / startWorkerSession.
  - QueuedSessionStarter.kt — the **player's** own queue starter.
  - WorkerQueuedSessionStarter.kt — the **worker's** queue starter (the key file).
- simulator/SkillSimulator.kt — gathering/craft simulation primitives.
- util/ToolEfficiency.kt — *tool* efficiency (pickaxe/axe/rod/hammer/tinderbox/pan), a
  separate concept from *worker tier* efficiency.
- ui/viewmodel/InnViewModel.kt — worker hiring UI logic (the Inn).
- ui/viewmodel/WorkerSkillsViewModel.kt — worker task assignment (queueing).
- ui/viewmodel/HomeViewModel.kt — worker session collection + summary.
- ui/screen/WorkerSkillsScreen.kt, ui/screen/InnScreen.kt — UI.

Game data is JSON under app/src/main/assets/data/ (ores, trees, fish, bones, runes,
recipes/*, skills/*).

---

## 2. The worker model: hiring, queueing, efficiency

### 2.1 Tiers and their efficiency (PlayerModels.kt)

WorkerTier (PlayerModels.kt:459-501) defines the four hireable tiers:

| Tier | efficiencyMultiplier | durationMs | hireCost | maxCraftQty |
|------|---------------------|-----------|----------|-------------|
| LONG_LABORER | 0.5x | 8 h | 5,000 | unlimited (Int.MAX_VALUE) |
| APPRENTICE   | 1.0x | 8 h | 10,000 | 480 |
| JOURNEYMAN   | 1.5x | 6 h | 20,000 | 540 |
| MASTER       | 2.5x | 4 h | 50,000 | 600 |

Key derived properties (all from the single efficiencyMultiplier):

    val durationMs: Long get() = when (this) {   // 8h / 8h / 6h / 4h
        LONG_LABORER -> 8L * 60 * 60_000L
        APPRENTICE   -> 8L * 60 * 60_000L
        JOURNEYMAN   -> 6L * 60 * 60_000L
        MASTER       -> 4L * 60 * 60_000L
    }

    val efficiencyMultiplier: Float get() = when (this) {  // 0.5 / 1.0 / 1.5 / 2.5
        LONG_LABORER -> 0.5f; APPRENTICE -> 1.0f; JOURNEYMAN -> 1.5f; MASTER -> 2.5f
    }

    // Per-item time for crafting/prayer/runecrafting sessions.
    val craftingPerItemMs: Long get() = (60_000L / efficiencyMultiplier).toLong()

    // Maximum qty for crafting/prayer/runecrafting sessions (LONG_LABORER uncapped).
    val maxCraftQty: Int get() =
        if (this == LONG_LABORER) Int.MAX_VALUE else (combinedGatheringMultiplier * 60).toInt()

    // Combined multiplier applied to gathering/combat loot and XP at collect time.
    val combinedGatheringMultiplier: Float get() =
        (durationMs / (60L * 60_000L)).toFloat() * efficiencyMultiplier   // hours x efficiency

> Note the MASTER comment at PlayerModels.kt:474-476: efficiencyMultiplier was raised to
> 2.5x specifically so a Master (4 h x 2.5 = 10 "effective hours") outpaces the cheapest
> tier — and this is stated to apply to **"gathering yield and crafting caps"**. The model
> was designed for both paths from the start.

### 2.2 Hiring (InnViewModel.kt:87-113)

- Two slots: hiredWorker (slot 1, LONG_LABORER only) and hiredWorker2 (slot 2,
  APPRENTICE/JOURNEYMAN/MASTER), stored in PlayerFlags (PlayerModels.kt:108-111).
- Ironmen cannot hire (InnViewModel.kt:90-93).
- hire(tier) spends tier.hireCost, clears old worker sessions, and writes a new
  HiredWorker(tier, name) (InnViewModel.kt:103-110).

### 2.3 Queueing (PlayerRepository.kt:622-643, WorkerQueuedSessionStarter.kt:43-65)

- Each HiredWorker holds a sessionQueue: List<QueuedAction> of capacity **1**
  (PlayerRepository.kt:627 — "if (worker.sessionQueue.size >= 1) return false").
- WorkerQueuedSessionStarter.startNextQueued(slot) dequeues and starts the next action once
  the worker has no active session; it drops actions that no longer qualify after a prestige
  and requeues on unexpected errors.

---

## 3. Gathering vs crafting: how each computes efficiency

The single divergence point is in **WorkerQueuedSessionStarter.kt:23-102**:

    private val GATHERING_SKILLS = setOf(
        Skills.MINING, Skills.WOODCUTTING, Skills.FISHING,
        Skills.AGILITY, Skills.THIEVING, "combat", "boss",
    )

    val isGathering = action.skillName in GATHERING_SKILLS
    val efficiencyMultiplier = if (isGathering) tier.combinedGatheringMultiplier else 1.0f
    val durationMs = if (isGathering) tier.durationMs
                     else action.estimatedDurationMs.takeIf { it > 0 } ?: tier.durationMs

### 3.1 Gathering path (collect-time multiplier)

- Session runs a **fixed** tier.durationMs (4–8 h).
- Frames are pre-simulated once (SkillSimulator.simulateMining/Woodcutting/Fishing/Agility,
  ThievingSimulator.simulate, CombatSimulator).
- efficiencyMultiplier = tier.combinedGatheringMultiplier (= hours x tier efficiency).
- At collection (HomeViewModel.kt:1400-1427), that multiplier scales both XP and items via
  applySessionResults(..., mult, ...) → PlayerRepository.kt:214,220-221.

So a MASTER gathering worker = 4 h x 2.5 = **10x** one simulated hour of loot/XP per session
(2.5x the per-hour rate of an Apprentice).

### 3.2 Crafting/production path (queue-time speed + capacity)

Crafting is discrete (consume materials → produce N items), so tier efficiency is baked in
when the action is **queued**, not when it is collected:

- **Speed** — estimatedDurationMs = qty x tier.craftingPerItemMs
  (WorkerSkillsViewModel.kt:430, 469, 507, 557), where
  craftingPerItemMs = 60_000 / efficiencyMultiplier → Master = 24 s/item, Apprentice = 60 s/item.
- **Capacity** — qty = qty.coerceAtMost(tier.maxCraftQty)
  (WorkerSkillsViewModel.kt:418, 453, 494, 542).
- At start time the frames are built with **efficiencyMultiplier = 1.0f** (no collect-time
  scaling): buildCraftFrames emits one batch frame with outputQty x qty items and
  xpPerItem x qty x toolEfficiency XP (WorkerQueuedSessionStarter.kt:427-441).
- Materials are consumed at queue time (WorkerSkillsViewModel.kt:419, 456, 496, 545).

Result — throughput is tier-scaled exactly as designed:

| Tier | per-item time | max qty | full-session time | items/hour |
|------|--------------|---------|-------------------|-----------|
| APPRENTICE | 60 s | 480 | 480x60 s = 8 h | 60/h |
| JOURNEYMAN | 40 s | 540 | 540x40 s = 6 h | 90/h (1.5x) |
| MASTER     | 24 s | 600 | 600x24 s = 4 h | 150/h (2.5x) |

XP-per-hour scales identically (XP = xpPerItem x qty with no tier multiplier, but more items
complete per hour for higher tiers).

### 3.3 Supported activities

- **Gathering (worker):** mining, woodcutting, fishing, agility, thieving, combat/dungeon,
  boss. (WorkerQueuedSessionStarter.kt:104-377; GATHERING_SKILLS.)
- **Production/crafting (worker):** firemaking, runecrafting, prayer, smithing, cooking,
  fletching, crafting (jewellery), herblore, construction.
  (WorkerSkillsViewModel.onSkillTapped WorkerSkillsViewModel.kt:308-374;
  WorkerQueuedSessionStarter.kt:163-255.)
- *Farming is the only listed "gathering" skill NOT routed through the worker queue* — it is
  patch/alarm based (FarmingRepository, FarmPatchAlarmReceiver) and absent from the worker
  starter and worker skill sheet. This is unrelated to the crafting hypothesis.

---

## 4. Hypothesis assessment

**Hypothesis: "hire workers + queue workers + efficiency works for gathering but does NOT
work for production/crafting."**

**Conclusion: FALSE** — the worker/efficiency system works for both.

Evidence that crafting is fully functional:

1. **Hiring is skill-agnostic.** A HiredWorker has no skill restriction; the tier alone
   drives cost/duration/efficiency (PlayerModels.kt:459-508).
2. **Queueing accepts crafting actions.** WorkerSkillsViewModel enqueues firemaking,
   runecrafting, prayer, smithing, cooking, fletching, crafting, herblore, and construction
   (WorkerSkillsViewModel.kt:414-569).
3. **The starter executes them.** WorkerQueuedSessionStarter has explicit
   when(action.skillName) branches for every crafting skill (WorkerQueuedSessionStarter.kt:163-255).
4. **Tier efficiency is applied.** craftingPerItemMs and maxCraftQty (both derived from
   efficiencyMultiplier) make higher tiers faster and higher-capacity
   (WorkerSkillsViewModel.kt:418,430,453,469,494,507,542,557), and the MASTER tier was even
   rebalanced with crafting caps in mind (PlayerModels.kt:474-476).
5. **Collection is correct.** The single batch frame grants outputQty x qty items and the
   right XP at collect time (HomeViewModel.kt:1400-1427 → PlayerRepository.applySessionResults).

The only real difference is **mechanism**, not presence:

- Gathering = continuous yield → fixed duration + **collect-time** combinedGatheringMultiplier.
- Crafting = discrete batch → **queue-time** speed (craftingPerItemMs) + capacity (maxCraftQty).

Both produce the intended per-tier throughput (Master = 2.5x Apprentice). There is no dead
code path or missing wiring for crafting.

### Minor observations (not bugs, but worth knowing)

- Worker sessions ignore pet boosts and pet drops (petBoostPct = 0, petDropChance = 0.0 in
  WorkerQueuedSessionStarter.kt), for **both** gathering and crafting alike.
- Worker crafting XP uses the *player's* equipped tool efficiency for firemaking/smithing/
  cooking (matches the player path); fletching/crafting/herblore/construction have no tool
  efficiency (also matches the player path).
- The UI's sessionDurationMs = tier.craftingSessionMs = craftingPerItemMs x 60 is a display
  estimate for a 60-item batch; the actual enqueued duration is qty x craftingPerItemMs.

---

## 5. If a change is still desired — prioritized plan

Although the hypothesis is refuted, here is a concrete plan for anyone who wants the two
paths to *feel* more uniform (e.g. expose worker efficiency for crafting the same way it is
exposed for gathering), or who wants to harden the current split:

1. **(P0) Unify the efficiency declaration.** Extract the split at
   WorkerQueuedSessionStarter.kt:99-102 into one place (e.g. a WorkerTier.efficiencyFor(skillName)
   returning combinedGatheringMultiplier for gathering and a documented 1.0f for crafting,
   plus durationFor(action)). Right now the "gathering vs crafting" rule is implicit in a
   private constant list and easy to misread as "crafting is unsupported". Add a doc comment
   explaining *why* crafting is 1.0f (its multiplier is already baked into craftingPerItemMs /
   maxCraftQty).
2. **(P1) Surface worker crafting throughput in the UI.** WorkerSkillsScreen already shows
   gathering efficiency but only shows a per-item duration for crafting. Add a visible
   "items/hour" or "tier speed/capacity" readout derived from craftingPerItemMs and
   maxCraftQty so players see the tier benefit (this is the most likely source of the
   "crafting doesn't scale" perception).
3. **(P1) Add regression tests.** Cover WorkerQueuedSessionStarter with a crafting-action
   fixture asserting: (a) estimatedDurationMs == qty x craftingPerItemMs, (b)
   efficiencyMultiplier == 1.0f, (c) single frame holds outputQty x qty items and
   xpPerItem x qty x toolEff XP, and (d) maxCraftQty caps the queued qty per tier. Mirror the
   existing simulator/SkillSimulatorPureTest.kt style.
4. **(P2) Decide on worker pet/tool parity.** If workers should benefit from pets and tools
   exactly like the player, change petBoostPct = 0 / petDropChance = 0.0 in
   WorkerQueuedSessionStarter.kt and route worker crafting buildCraftFrames through the same
   tool-efficiency + pet helpers the player path uses in QueuedSessionStarter.kt. This is a
   deliberate balance decision, not a correctness fix.
5. **(P3, optional) Fold farming into the worker queue.** Add Skills.FARMING to the worker
   starter/sheet if a "farm hands" feature is ever wanted; today farming is the only
   gathering skill absent from the worker system.
