# 🗺️ Global System Architecture & Schematics - ollaCraft

**ollaCraft** is an autonomous survival and learning agent for **Minecraft Java Edition** powered by local Large Language Models (LLMs) via **Ollama** and interfaced with the game through **Mineflayer**.

The architecture combines a two-tier hierarchical cognitive system (**Strategy Manager** + **Tactical ReAct Player**), a deterministic **Action Primitives** layer, and an autonomous **Procedural Learning Engine (DSL + Evaluator + Lifecycle Memory)** inspired by Voyager, with **strict physical verification** against the real Minecraft world.

---

## 1. High-Level System Architecture

This diagram illustrates the separation of concerns across the Minecraft game server, the Node.js bot runtime, the Procedural Learning Engine, and the local LLM inference server.

```mermaid
flowchart TD
    subgraph SVR["Minecraft Server (Java Edition 1.20.4)"]
        WORLD["3D Voxel World (Weather, Time, Physics)"]
        ENTITIES["Entities (Hostile Mobs, Passive Animals, Players)"]
        BLOCKS["Blocks & Resources (Ores, Trees, Structures)"]
    end

    subgraph BOT["ollaCraft Core Engine (Node.js)"]
        direction TB
        NET["Mineflayer Client & Event Handlers (Spawn, Chat, Physics)"]
        
        subgraph PERCEPTION["Perception & Radar (src/perception)"]
            SCANNER["Unified 3D Environment Scanner (35,937 voxels/pass)"]
            INV_TRACK["Inventory, Equipment & Quest Tracker"]
            ADV_TRACK["Advancements & Milestone Tracker"]
            WIKI_CACHE["Local WikiCraft Database (src/minecraft)"]
        end

        subgraph BRAIN["Hierarchical Brain (src/agent)"]
            MANAGER["Strategy Supervisor (Event-Driven Manager)"]
            REACT["Tactical Operator (ReAct Loop)"]
            STATE[("Shared Global State (src/core/state.js)")]
        end

        subgraph PROCEDURES["Procedural Learning Engine (src/procedures)"]
            MATCHER["Objective Coverage & Anti-Loop Tracker (matcher.js)"]
            GEN["Declarative DSL Generator (generator.js)"]
            VALIDATOR["Static & Semantic Validator (schema.js + validator.js)"]
            RUNNER["Supervised Procedure Runner (runner.js)"]
            EVALUATOR["Independent World Evaluator (evaluator.js)"]
            LIFECYCLE["Lifecycle, Promotion & Versioning (lifecycle.js + memory.js)"]
            STORE[("Persistent JSON Store (store.js)")]
        end

        subgraph ACTUATION["Actuation, Behaviors & Primitives (src/actions)"]
            DISPATCH["Skill & Procedure Dispatcher (dispatcher.js)"]
            BEHAVIORS["High-Level Behaviors (Mine, Craft, Smelt, Combat, Portal)"]
            PRIMITIVES["Verified Action Primitives (Movement, Blocks, Items, Container, Combat)"]
        end
    end

    subgraph OLLAMA["Local LLM Inference (Ollama)"]
        MODEL_M["Supervisor / Generator Model (Structured JSON)"]
        MODEL_P["Player Tactical Model (Structured JSON)"]
    end

    WORLD & ENTITIES & BLOCKS --> NET
    NET --> SCANNER & INV_TRACK & ADV_TRACK
    SCANNER & INV_TRACK & ADV_TRACK & WIKI_CACHE --> STATE

    STATE --> MANAGER & REACT
    MANAGER <-->|"Select Validated / Query Knowledge"| LIFECYCLE
    MANAGER -->|"Uncovered Complex Goal"| MATCHER
    MATCHER --> GEN
    GEN <--> MODEL_M
    GEN --> VALIDATOR --> RUNNER
    RUNNER --> PRIMITIVES
    RUNNER -->|"Execution Trace"| EVALUATOR
    EVALUATOR -->|"Independent Verdict + Contradictions"| LIFECYCLE
    LIFECYCLE <--> STORE

    MANAGER <--> MODEL_M
    REACT <--> MODEL_P
    REACT -->|"Action JSON {action, target, qty}"| DISPATCH
    DISPATCH --> BEHAVIORS & RUNNER
    BEHAVIORS --> PRIMITIVES --> NET
```

---

## 2. Procedural Learning & Lifecycle Pipeline (Phase 4.1 → 4.6)

Unlike naive LLM agents that blindly trust step completion return codes, **ollaCraft** separates **execution** (`runner.js`), **physical verification** (`evaluator.js`), and **long-term memory evolution** (`lifecycle.js` & `memory.js`):

```mermaid
flowchart TD
    OBJ["1. Uncovered Complex Objective Detected (matcher.js)"] --> GEN["2. Generate Declarative JSON DSL via Ollama (generator.js)"]
    GEN --> VAL["3. Static & Semantic Graph Validation (schema.js + validator.js)"]
    VAL -->|"Invalid"| RETRY["Bounded Retry / Anti-Loop Cooldown"]
    VAL -->|"Valid"| REG["4. Safe Experimental Registration & Versioning v1/v2 (memory.js)"]
    REG --> RUN["5. Supervised Execution with Timeouts & Safety Guards (runner.js)"]
    RUN --> TRACE["6. Normalized Execution Trace (executionId, stepTraces)"]
    TRACE --> EVAL["7. Independent World Evaluation (evaluator.js)"]

    subgraph EVAL_CHECKS["Independent Evaluator Checks"]
        E1["evaluateObjective() (Real Inventory/World/Entity State)"]
        E2["evaluatePostconditions() (verified / failed / unknown)"]
        E3["detectTraceContradictions() (Catch Hallucinated Success)"]
        E4["detectResourceShortage() (Separate Environment vs Code Fault)"]
    end

    EVAL --> EVAL_CHECKS --> LIFE["8. Procedure Lifecycle & Memory Evolution (lifecycle.js)"]

    subgraph LIFE_RULES["Lifecycle Policy (Phase 4.6)"]
        L1["4.6.1 Deduplicated Evaluation History (executionId)"]
        L2["4.6.2 Promotion Policy (>= 3 Independent Verified Successes)"]
        L3["4.6.3 Failure Classification & Prudent Deprecation"]
        L4["4.6.4 Non-Destructive Versioning (v1 validated + v2 experimental)"]
        L5["4.6.5 Knowledge Extraction for Manager (Success Rate, Limits, Fallbacks)"]
    end

    LIFE --> LIFE_RULES --> MEM[("ProcedureMemory & ProcedureStore")]
```

---

## 3. Hierarchical Decision Loop: Strategy Manager vs Tactical ReAct Player

1. **Strategy Manager** ([`src/agent/manager.js`](src/agent/manager.js)): Triggered on an **event-driven** basis (action failure, loop detected, objective milestone reached, inventory clutter, or heartbeat). It first checks `ProcedureMemory` for a **validated procedure** matching the current objective (with a consecutive-failure guard) — if one exists, `loop.js` bypasses Player LLM inference and executes it directly under a 75s envelope (`60s` Runner + `AbortSignal`). When no validated procedure applies, `resolveGoalPlan` ([`src/minecraft/knowledge.js`](src/minecraft/knowledge.js)) decomposes missing prerequisites for both Manager and Player prompts, and `sanitizeManagerOutput` prevents redundant `unstuck` on clear terrain or repeated navigation to unreachable furnaces.

2. **Tactical ReAct Player** ([`src/agent/loop.js`](src/agent/loop.js)): Runs the **Perception &rarr; Dependency Plan &amp; Dynamic Radar Prompt &rarr; Validated Procedure Bypass or Structured LLM Output &rarr; Skill/Procedure Dispatch &rarr; Terrain-Aware Recovery &rarr; Feedback** cycle. On `death`, action history, base memory, and temporary bad-block blacklists are cleanly reset.

### 3.1 Decision priority inside one cycle ([`src/agent/loop.js`](src/agent/loop.js))

Each cycle picks its action from the first source that has one, so the Player model is only consulted when nothing deterministic applies:

```mermaid
flowchart TD
    START["Cycle start: syncObjective + stuck detection"] --> FORCED{"Forced recovery step queued? (recovery.js)"}
    FORCED -->|yes| EXEC["Execute skill"]
    FORCED -->|no| REFLEX{"Survival reflex or stage logistics? (planner.js)"}
    REFLEX -->|yes| EXEC
    REFLEX -->|no| PROC{"Reliable Manager sub-goal / validated procedure?"}
    PROC -->|yes| EXEC
    PROC -->|no| PLAN{"Next feasible step of the dependency plan?"}
    PLAN -->|yes| EXEC
    PLAN -->|no| LLM["Player LLM (temperature rises while stagnating)"]
    LLM --> BLOCKED{"Answer refused by failure memory?"}
    BLOCKED -->|yes| RECOVER["forceRecovery: different action"] --> EXEC
    BLOCKED -->|no| EXEC
    EXEC --> RECORD["recordOutcome: failure memory + stagnation counters"]
```

- **Planner** ([`src/agent/planner.js`](src/agent/planner.js)): survival reflexes (`unstuck`, `eat`), stage rules (Nether logistics, return to the memorized portal after a death, `stronghold`, `endportal`, `dragon`) and the next feasible step of `resolveGoalPlan`. A wanted block that is not loaded nearby becomes a targeted `explore` (ore targets dig down to their generation altitude).
- **Recovery** ([`src/agent/recovery.js`](src/agent/recovery.js)): each failure is stored with its context (position, dimension, inventory). A pair failing twice in the same context is refused there, and the planner answers with a model-free remedy (`explore` away, then retry); the refusal lifts once the bot has moved 6 blocks or its inventory changed. After more than 3 such rounds the step goes to the model, whose feedback carries the reason. Stagnation is measured on a progress signature (dimension, objective, 8-block position cell, inventory). `forceRecovery` cancels the running action, refuses the repeated pair and queues an action absent from the recent history (`unstuck`, `explore relocate`, `goto <waypoint>`), escalating with each recovery. The `debug` chat command calls the same function.
- **Watchdog** ([`src/agent/watchdog.js`](src/agent/watchdog.js)): event-driven guard outside the decision loop. On low air it invalidates the running action, takes the controls back from the pathfinder and queues `unstuck` first.
- **Water escape** ([`src/actions/behaviors/movement/water.js`](src/actions/behaviors/movement/water.js)): a uniform-cost search over the surrounding cells (swimming one cell costs 1, breaking a block costs its real under-water dig time) returns the quickest route to a breathable cell, preferring dry ground when it is barely further. The route is swum with direct controls because the pathfinder cannot dive. Being in water at all is a survival reflex of the planner, and `environment.js` keeps the flooded areas and the "submerged block" test used by the mining target search.
- **Progress store** ([`src/core/progress.js`](src/core/progress.js)): waypoints, sticky milestones, eye throws and the stronghold estimate are persisted in `data/progress-<host>_<port>_<user>.json`.
- **Knowledge fixes** ([`src/minecraft/knowledge.js`](src/minecraft/knowledge.js)): raw resources dropped by ores (`diamond`, `raw_iron`, `coal`...) are mined instead of being resolved to the storage-block decompression recipe, which previously produced circular plans.

---

## 4. Verified Action Primitives & Registry (`src/actions/primitives` & `src/procedures/registry.js`)

All autonomous procedures are composed exclusively of whitelisted, deterministic primitives with reentrant locking and post-action world verification:

| Domain | Module | Registered Primitives |
| :--- | :--- | :--- |
| **Movement** | [`src/actions/primitives/movement.js`](src/actions/primitives/movement.js) | `goto_position`, `goto_coordinates`, `move_direction`, `jump`, `look_at`, `stop_movement` |
| **Blocks** | [`src/actions/primitives/blocks.js`](src/actions/primitives/blocks.js) | `find_block`, `break_block`, `place_block`, `interact_block`, `collect_drops` |
| **Items** | [`src/actions/primitives/items.js`](src/actions/primitives/items.js) | `equip_item`, `unequip_item`, `craft_recipe`, `consume_item`, `drop_item`, `check_inventory` |
| **Container** | [`src/actions/primitives/container.js`](src/actions/primitives/container.js) | `open_container`, `deposit_item`, `withdraw_item`, `transfer_slot`, `close_container` |
| **Combat** | [`src/actions/primitives/combat.js`](src/actions/primitives/combat.js) | `find_entity`, `attack_entity`, `engage_combat`, `follow_entity`, `evade_entity` |

---

## 5. Benchmark & Performance Metrics (`npm run benchmark`)

Measured via [`scripts/benchmark.js`](scripts/benchmark.js) across **180 automated unit & integration tests**:

| Subsystem | Metric | Result | Architectural Impact |
| :--- | :--- | :--- | :--- |
| **DSL Schema + Semantic Validator** | Latency / Throughput | **0.030 ms/proc** (~33,780 proc/s) | Zero-cost static safety and dependency graph verification |
| **Supervised Runner + Evaluator** | Full Cycle Latency | **1.15 ms/cycle** | Sub-2ms orchestration and independent world verification |
| **Anti-Hallucination Guard** | False Positive Detection | **50/50 (100 %)** | Prevents learning from Desyncs or hallucinated step claims |
| **Lifecycle & Knowledge Engine** | Memory Update + Query | **0.45 ms/cycle** | Real-time promotion, versioning (`v1`/`v2`), and knowledge extraction |
| **Unified 3D Environment Scan** | 35,937 Voxels (Radius 16) | **2.32 ms/scan** | Single-pass block + exposed ore scanning with cached registry |
| **Cognitive Cost (10 Episodes)** | LLM Calls & Token Usage | **-90.0 % LLM calls / -90.0 % tokens** | Validated procedures replace repetitive step-by-step ReAct queries |

---

## 6. Directory Structure & Key Files

```text
ollaCraft/
├── ARCHITECTURE.md                  # Global system architecture, diagrams, and benchmarks
├── README.md                        # Quickstart, installation, commands, and usage guide
├── todo.md                          # Development roadmap and completed milestones
├── package.json                     # Dependencies and npm scripts (test, benchmark)
├── scripts/
│   └── benchmark.js                 # Automated performance and cognitive savings benchmark
├── src/
│   ├── index.js                     # Bot bootstrap, AuthMe authentication, server listeners
│   ├── core/
│   │   ├── state.js                 # Central runtime state (inventory, base, token stats)
│   │   └── logger.js                # Structured logging utility
│   ├── infrastructure/
│   │   ├── config.js                # Models, quest progression chain, action whitelists
│   │   └── env.js                   # Environment variable loader
│   ├── agent/
│   │   ├── loop.js                  # Tactical ReAct execution loop and timeout guards
│   │   ├── manager.js               # Event-driven Strategy Supervisor & procedure selector
│   │   ├── ollama.js                # Ollama REST client with structured JSON outputs
│   │   └── prompt.js                # Dynamic prompt builder with filtered 3D radar
│   ├── actions/
│   │   ├── dispatcher.js            # Routes skills and autonomous procedures
│   │   ├── primitives/              # Deterministic primitives (movement, blocks, items, container, combat, locks)
│   │   └── behaviors/               # High-level skills (mine, craft, smelt, place, navigate, combat, storage, portal)
│   ├── procedures/
│   │   ├── schema.js                # Declarative JSON DSL schema and dynamic reference resolver
│   │   ├── registry.js              # Whitelisted action catalog and parameter contracts
│   │   ├── validator.js             # Static & semantic validator (types, causal graph, preconditions)
│   │   ├── matcher.js               # Uncovered objective detector and anti-loop tracker
│   │   ├── generator.js             # Ollama DSL procedure generator with bounded retries
│   │   ├── runner.js                # Supervised experimental & validated procedure runner
│   │   ├── evaluator.js             # Independent objective, postcondition & contradiction evaluator
│   │   ├── lifecycle.js             # Evaluation history, promotion policy, failure analysis & versioning
│   │   ├── memory.js                # In-memory procedure registry, lineage manager & knowledge API
│   │   └── store.js                 # Persistent JSON storage with validated procedure protection
│   ├── perception/
│   │   ├── environment.js           # Unified 3D block & exposed ore scanner, entity radar
│   │   ├── inventory.js             # Item counting, tool selection, quest progression sync
│   │   └── advancements.js          # Vanilla Minecraft advancements tracker
│   └── minecraft/
│       ├── knowledge.js             # Recursive dependency graph & prerequisite goal resolver
│       ├── wiki.js                  # Offline recipe, drop, and tool lookup skill
│       └── wikiData.js              # Cached minecraft-data registry access
└── test/                            # 180 automated unit and end-to-end integration tests
```
