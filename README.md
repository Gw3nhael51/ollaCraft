# ollaCraft - Autonomous Minecraft AI Agent (ReAct + Ollama)

An autonomous Minecraft survival agent powered by local Large Language Models (LLMs) via **Ollama** and built on **Mineflayer**. The bot continuously perceives its surrounding 3D environment, reasons about survival goals, and executes complex in-game skills through a closed-loop **ReAct (Reasoning + Acting)** architecture.

---

## 🌟 Highlights

- **Local LLM Intelligence:** Operates 100% locally and privately using Ollama (supporting models such as `qwen3.5:9B`, `qwen2.5:27b`, `llama3.1:8b`, or similar).
- **Two-Tier ReAct Decision Loop:** Structured cycle of **Perception -> Prompt Synthesis -> LLM Reasoning -> Skill Execution -> Supervisor Review & Feedback**.
- **Anti-Looping Strategy Manager:** A supervisor pass monitors action history, detects repeated failures or ping-pong loops, and sanitizes directives against real inventory and recipe constraints.
- **Autonomous Progression Chain:** Naturally advances through survival tiers:

```mermaid
flowchart LR
    A["Logs"] --> B["Wooden Pickaxe"]
    B --> C["Cobblestone"]
    C --> D["Stone Pickaxe"]
    D --> E["Furnace"]
    E --> F["Iron Gear & Shield"]
    F --> G["Water Bucket"]
    G --> H["Nether Portal"]
    H --> I["Blaze Rods & Ender Eyes"]
```

- **Smart Pathfinding & Unstuck Recovery:** Powered by `mineflayer-pathfinder` with 3D cave and terrain obstacle analysis and automatic unstuck routines for holes, walls, or water.
- **Full Combat & Vitality Safeguards:** Weapon selection, automatic armor and off-hand shield equipping, passive animal hunting, hostile mob combat, and food consumption.
- **Crafting, Smelting & Storage Automation:** Finds or places crafting tables, operates furnaces with fuel matching, and organizes chest storage to deposit bulky materials.
- **Built-in Minecraft Wiki Database:** Queries local game metadata (`minecraft-data`) for recipes, drop tables, and harvest tool requirements.

---

## 🏗️ Architecture

```mermaid
flowchart TD
    subgraph Minecraft["Minecraft World (Server)"]
        SENSORS["World State & Sensors (Health, Food, Biome, Blocks, Entities)"]
        EXEC["Skill Execution (Pathfinder, Mining, Crafting, Smelting, Combat)"]
    end

    subgraph Core["Agent Brain (Node.js)"]
        CTX["State & Context Aggregator (Inventory, Base Coords, Quest Chain, Advancements)"]
        PROMPT["Dynamic Prompt Generator (3D Radar, Wiki Knowledge & Available Crafts)"]
        LLM{"Player Ollama Model (Tactical ReAct)"}
        MANAGER{"Manager Ollama Model (Anti-Loop Supervisor)"}
        DISPATCH["Skill Dispatcher (mine, craft, place, smelt, chest, hunt, fight, equip, portal, wiki, explore, unstuck, eat)"]
    end

    SENSORS --> CTX
    CTX --> PROMPT
    PROMPT --> LLM
    LLM -->|JSON Action| DISPATCH
    DISPATCH --> EXEC
    EXEC -->|Action Result Feedback| CTX
    CTX --> MANAGER
    MANAGER -->|Validated Directive| CTX
```

---

## 📁 Project Structure

```text
├── src/
│   ├── index.js               # Entry point, bot connection, server chat & event listeners
│   ├── config.js              # Global configuration, quest chain, timing, and item thresholds
│   ├── state.js               # Central runtime state (inventory, health, memory, base coordinates)
│   ├── ai/
│   │   ├── loop.js            # Main ReAct loop, action execution cycle, and fallback triggers
│   │   ├── manager.js         # Strategic supervisor loop, loop detection, and anti-hallucination
│   │   ├── ollama.js          # Ollama REST client, payload formatting, and JSON extraction
│   │   └── prompt.js          # Dynamic system and user prompt constructor
│   ├── skills/
│   │   ├── dispatcher.js      # Central router mapping action names to skill functions
│   │   ├── mine.js            # Target block search, pathfinding, and mining with best tool
│   │   ├── craft.js           # Crafting table detection/placement and 2x2/3x3 recipe crafting
│   │   ├── smelt.js           # Furnace placement, fuel selection, and smelting operations
│   │   ├── place.js           # Physical block placement (crafting tables, furnaces, chests)
│   │   ├── navigate.js        # Safe exploration, obstacle avoidance, and unstuck recovery
│   │   ├── combat.js          # Passive animal hunting and hostile mob combat
│   │   ├── equip.js           # Automatic armor upgrades and off-hand shield equipping
│   │   ├── eat.js             # Food selection and eating routines
│   │   ├── storage.js         # Chest sorting and bulky item depositing
│   │   ├── portal.js          # Water bucket filling, lava casting, and Nether portal ignition
│   │   └── wiki.js            # Game data lookups (recipes, harvest tools, drops)
│   └── utils/
│       ├── environment.js     # 3D block scanner, exposed ore locator, entity tracking, biomes
│       ├── inventory.js       # Item counting, tool selectors, craft availability checks
│       ├── advancements.js    # Story advancements progression and badge URL builder
│       └── wikiData.js        # Minecraft registry access and harvest verification
├── .env.example               # Template for environment variables
├── package.json               # Dependencies and scripts
└── README.md                  # Project documentation
```

---

## 📋 Prerequisites

Before starting, ensure you have:

1. **Node.js** (v18.0.0 or higher):
   ```bash
   node --version
   ```
2. **Minecraft Java Edition Server** (v1.20.4 recommended):
   - A vanilla, Fabric, Paper, or Spigot server.
   - For local offline development, set `online-mode=false` in `server.properties`.
3. **Ollama**:
   - Installed from [ollama.com](https://ollama.com).
   - Ensure Ollama is running and has downloaded the desired model:
     ```bash
     ollama serve
     ollama pull qwen2.5:27b

     # Or for lighter hardware:
     ollama pull llama3.1:8b
     
     # show ollama models in local:
     ollama list
     ```

---

## 🚀 Installation & Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/Gw3nhael51/ollacraft.git
   cd ollacraft
   ```

2. **Install Node.js dependencies:**
   ```bash
   npm install
   ```

3. **Configure Environment Variables:**
   Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
   Edit `.env` to match your Minecraft server and Ollama settings:
   ```env
   # Minecraft connection settings
   MC_HOST=127.0.0.1
   MC_PORT=25565
   MC_USERNAME=Herobrine
   MC_PASSWORD=YourBotPasswordIfRequired

   # Ollama settings (Dual-Model Architecture)
   OLLAMA_MODEL=qwen3.5:9B
   OLLAMA_MODEL_PLAYER=qwen3.5:9B
   OLLAMA_MODEL_MANAGER=qwen3.5:9B
   ```

4. **Launch the agent:**
   ```bash
   node src/index.js
   ```

The bot will connect to the target Minecraft server. If the server has an authentication plugin (`/register` or `/login`), the bot will handle it automatically based on `MC_PASSWORD`. Once connected, the autonomous ReAct cycle starts.

---

## 🎮 In-Game Controls & Chat Commands

Players can interact with and command the bot directly using in-game chat:

| Command | Description |
|---|---|
| `start` | Starts or resumes the autonomous ReAct survival loop. |
| `stop` | Immediately suspends the autonomous loop, clears current pathfinding, and resets controls. |
| `objectif <item>` or `goal <item>` | Manually sets the agent's target objective (e.g., `objectif iron_pickaxe`). |
| `objectif auto` or `goal auto` | Restores the default automatic survival quest progression chain. |
| `inventaire` or `inv` | Causes the bot to output its current inventory contents into chat. |
| `coords` or `pos` | Outputs the bot's current `(X, Y, Z)` coordinates into chat. |
| `tokens` or `token` | Outputs token consumption statistics for both the Player and Manager LLMs. |

---

## ⚙️ Configuration Reference

### Environment Variables (`.env`)

| Variable | Default | Description |
|---|---|---|
| `MC_HOST` | `127.0.0.1` | Minecraft server hostname or IP address. |
| `MC_PORT` | `25565` | Minecraft server port. |
| `MC_USERNAME` | `Herobrine` | In-game player name for the bot. |
| `MC_PASSWORD` | *(Empty)* | Password used for server `/register` or `/login` commands. |
| `OLLAMA_MODEL` | `qwen3.5:9B` | Fallback Ollama model tag. |
| `OLLAMA_MODEL_PLAYER` | `qwen3.5:9B` | Dedicated model for tactical ReAct decisions. |
| `OLLAMA_MODEL_MANAGER` | `qwen3.5:9B` | Dedicated model for strategic supervision and loop recovery. |
| `PORT` | `127.0.0.1:25565:25565` | Optional Docker port mapping. |

### Bot Rules & Parameters (`src/config.js`)

- **Quest Chain:** Streamlined speedrun progression focusing on essential iron tools, shield, water bucket, and Nether/End navigation (`QUEST_CHAIN` & `QUEST_AMOUNT`).
- **Action Whitelist:** Strict validation of allowed LLM actions (`VALID_ACTIONS`) and valid placement surfaces (`VALID_GROUND_BLOCKS`).
- **Base Management:** Stored coordinates in `src/state.js` for the player base, placed crafting tables, furnaces, and storage chests.

---

## 🧰 Available Agent Skills

The ReAct loop provides the LLM with structured actions formatted in JSON:

| Skill | Parameters | Description |
|---|---|---|
| `mine` | `target: string, qty?: number` | Finds the closest target block in the world, navigates to it, equips the optimal tool, and mines it (with BFS vein mining for ores). |
| `craft` | `target: string, qty?: number` | Crafts an item using 2x2 player inventory or navigates to a nearby crafting table for 3x3 recipes. |
| `place` | `target: string` | Places a block from inventory on safe, valid adjacent ground (e.g., `crafting_table`, `furnace`, `chest`). |
| `smelt` | `target: string, qty?: number` | Approaches a furnace, loads fuel (coal/charcoal/wood), and smelts raw ores or food. |
| `chest` | *None* | Navigates to a nearby chest and deposits bulky materials (excess dirt, cobblestone, mob drops). |
| `hunt` | `target?: string` | Hunts nearby passive animals (`cow`, `pig`, `sheep`, `chicken`) to gather food. |
| `fight` | `target?: string` | Engages nearby hostile mobs (`zombie`, `skeleton`, `spider`, `blaze`) with best weapon and armor. |
| `equip` | `target?: string` | Equips best available armor pieces and places the shield in the off-hand slot. |
| `portal` | *None* | Fills water bucket, casts or builds the Nether portal frame, ignites it with `flint_and_steel`, and enters the Nether. |
| `eat` | `target?: string` | Scans inventory for an edible food item and consumes it. |
| `explore` | *None* | Selects a randomized terrain coordinate and walks forward to discover new resources. |
| `unstuck` | *None* | Performs emergency ceiling breaking, wall digging, or upward swimming to escape holes or water. |
| `wiki` | `target: string` | Looks up recipes, tool requirements, and drops for any block or item in the local game database. |

---

## 🛠️ Troubleshooting

### 1. Ollama Connection Issues
- **Error:** `fetch failed` or `ECONNREFUSED 127.0.0.1:11434`
- **Solution:** Verify that Ollama is running (`ollama serve`). Test with `curl http://127.0.0.1:11434/api/tags` in your terminal.

### 2. Bot Getting Disconnected
- **Error:** `Server closed connection` or `Invalid credentials`
- **Solution:** If the server is in online mode (`online-mode=true`), the bot must use official Microsoft credentials. For local testing, set `online-mode=false` in `server.properties`.

### 3. Navigation Timeouts
- **Symptom:** Bot attempts to reach a block but logs `Navigation timeout`.
- **Solution:** This is normal behavior when a block is unreachable (e.g., suspended high in the air or sealed behind bedrock). The bot's built-in blacklist automatically ignores failed coordinates for subsequent steps.

---

## 🧠 Real-World ReAct Reasoning Trace

Below is an authentic execution trace showing how the local LLM encounters unforeseen obstacles (unreachable pathfinder target, missing crafting table in inventory), evaluates failure feedback, and autonomously recovers step-by-step to craft the required components:

```text
=== REACT THINKING CYCLE (objective : stone_pickaxe) ===
[AI THOUGHT] I already own a wooden pickaxe and a stone one. My objective is to obtain a 'stone_pickaxe'. According to the fundamental rule, I must not invent recipes. I check my situation: I need to mine 'stone' to get 'cobblestone', then craft them with sticks. However, before mining, I must ensure I don't need to consult the Wiki to confirm the exact recipe or if a specific action is required. But looking at my resources, I already have 159 cobblestone and only 1 stick. I am therefore lacking sticks. The priority is to obtain sticks. To do that, I need to chop wood with my stone or wooden axe. I have plenty of logs in my inventory but no processed planks to make sticks easily without crafting planks first. Wait, the standard recipe is 3 cobblestone + 2 sticks. I only have 1 stick. So I must craft some. To craft a stick, do you chop wood (log) -> plank -> stick? Right, in vanilla Minecraft: Log -> Planks (4x) -> Sticks (2x). So I must craft planks then sticks. Or mine 'stone' if I had enough sticks. I only have 1 stick. I will therefore use my axe to chop wood (jungle_log or oak_log) to get more resources to make sticks, or craft planks then sticks directly. But the 'mine' action is for blocks on radar. The radar shows trees ('oak_leaves', 'jungle_leaves', etc.) but no exposed trunk specifically listed as a direct mineable target (radar lists 'oak_log':22, 'jungle_log':62). I can mine these logs. So action: mine a log to obtain raw wood, then I'll craft planks and sticks. Or else, I can use the 'craft' action if I have the ingredients. I don't have enough sticks. I must therefore chop wood. The radar indicates 'oak_log':22 and 'jungle_log':62. I will mine an oak_log.
[MINE] Moving towards oak_log...
[SERVER] <Ollama> Action : mine (oak_log)
Mining failure : Took too long to decide path to goal!
[RESULT] ❌ Mining failed for 'oak_log' : Block unreachable (Took too long to decide path to goal!).

=== REACT THINKING CYCLE (objective : stone_pickaxe) ===
[AI THOUGHT] The objective is to craft a stone pickaxe (stone_pickaxe). The recipe requires 3 cobblestone and 2 sticks. I already have 159 cobblestone in my inventory, so I don't need to mine stone. I only possess a single stick ('stick'), whereas I need 2. I must therefore craft another one. To do that, I will first place a crafting table if not already done (there is one visible on the radar), then craft a stick with wood planks (I have plenty of wood). Once the 2 sticks are obtained, I can craft the pickaxe.
[RESULT] ❌ You do not have 'crafting_table' in your inventory.
[SERVER] <Ollama> Action : place (crafting_table)

=== REACT THINKING CYCLE (objective : stone_pickaxe) ===
[AI THOUGHT] The previous action failed because I didn't have a crafting table in my inventory. I must therefore craft one first (3 planks + 1 stick). I have the necessary resources (wood and sticks) to create planks and then the table. I will start by crafting 'crafting_table'.
[CRAFT] Moving to crafting table at (422, 76, -284)...
[SERVER] <Ollama> Action : craft (crafting_table)
[RESULT] ❌ Missing required components in inventory to craft 'crafting_table'.

=== REACT THINKING CYCLE (objective : stone_pickaxe) ===
[AI THOUGHT] Crafting the table failed because I don't have planks. I must first convert my logs (jungle_log, birch_log, oak_log) into planks in order to craft the crafting table. I have enough wood to start.
[SERVER] <Ollama> Action : craft (oak_planks)
[SERVER] <Ollama> Crafting oak_planks...
[RESULT] ✅ Successfully crafted 'oak_planks'.
```

## ⛏️ Connected Ore Vein Mining Trace

Example trace demonstrating the automated BFS vein-mining algorithm recursively clearing an entire cluster of adjacent `coal_ore` blocks without leaving remaining ores:

```text
[MINE] Moving towards coal_ore...
[MINE] Digging coal_ore...
[MINE] Block broken, collecting loot...
[VEIN] Extracting additional vein block (coal_ore) at (416,68,-284)...
[VEIN] Extracting additional vein block (coal_ore) at (416,68,-283)...
[VEIN] Extracting additional vein block (coal_ore) at (415,68,-283)...
[VEIN] Extracting additional vein block (coal_ore) at (416,69,-283)...
[VEIN] Extracting additional vein block (coal_ore) at (416,68,-282)...
[VEIN] Extracting additional vein block (coal_ore) at (415,69,-283)...
[VEIN] Extracting additional vein block (coal_ore) at (417,69,-283)...
[VEIN] Extracting additional vein block (coal_ore) at (417,68,-282)...
[MINE] Moving towards coal_ore...
```

## 📄 License

Copyright &copy; 2026 Gw3nhael51. All rights reserved.

This project is source-available for **personal evaluation and educational purposes only**. Redistribution, sublicensing, modification, copying, or commercial exploitation is strictly prohibited without prior written permission from the author. See [LICENSE](LICENSE) for full details.
