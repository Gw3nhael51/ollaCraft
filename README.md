# ollaCraft - Autonomous Minecraft AI Agent (ReAct + Ollama)

An autonomous Minecraft survival agent powered by local Large Language Models (LLMs) via **Ollama** and built on **Mineflayer**. The bot continuously perceives its surrounding 3D environment, reasons about survival goals, and executes complex in-game skills through a closed-loop **ReAct (Reasoning + Acting)** architecture.

---

## 🌟 Highlights

- **Local LLM Intelligence:** Operates 100% locally and privately using Ollama (supporting models such as `qwen2.5:27b`, `llama3.1:8b`, or similar).
- **ReAct Decision Loop:** Structured cycle of **Perception &rarr; Prompt Synthesis &rarr; LLM Reasoning & Plan &rarr; Skill Execution &rarr; Environment Feedback**.
- **Deterministic Heuristic Fallback:** If the LLM produces invalid JSON, encounters an API timeout, or hallucinates an unreachable goal, a rule-based fallback immediately takes over to maintain uninterrupted survival.
- **Autonomous Progression Chain:** Naturally advances through survival tiers:
  $$\text{Logs} \rightarrow \text{Wooden Pickaxe} \rightarrow \text{Cobblestone} \rightarrow \text{Stone Pickaxe} \rightarrow \text{Furnace} \rightarrow \text{Iron Gear} \rightarrow \text{Diamonds} \dots$$
- **Smart Pathfinding & Unstuck Recovery:** Powered by `mineflayer-pathfinder` with 3D cave/terrain obstacle analysis, jump-scaffolding, and automatic unstuck routines for holes, water, or deep pits.
- **Full Combat & Vitality Safeguards:** Automatic mob threat assessment, tactical fleeing when low on health, weapon selection, shield blocking, and proactive eating.
- **Crafting, Smelting & Storage Automation:** Finds or places crafting tables, operates furnaces with fuel matching, and organizes chest storage to deposit bulky materials.
- **Built-in Minecraft Wiki Database:** Queries local game metadata (`minecraft-data`) for recipes, drop tables, and harvest tool requirements.

---

## 🏗️ Architecture

```mermaid
flowchart TD
    subgraph Minecraft ["Minecraft World (Server)"]
        SENSORS["World State & Sensors<br/>(Health, Food, Biome, Nearby Blocks, Hostile Entities)"]
        EXEC["Skill Execution<br/>(Pathfinder, Mining, Crafting, Smelting, Combat)"]
    end

    subgraph Core ["Agent Brain (Node.js)"]
        CTX["State & Context Aggregator<br/>(Inventory, Base Locations, Quest Chain, Advancements)"]
        PROMPT["Dynamic Prompt Generator<br/>(Markdown-formatted Observations & Available Actions)"]
        LLM{"Local Ollama API<br/>(qwen2.5:27b / llama3.1)"}
        FALLBACK["Deterministic Fallback Engine<br/>(Rule-based quest progression)"]
        DISPATCH["Skill Dispatcher<br/>(mine, craft, place, smelt, explore, unstuck, eat, flee)"]
    end

    SENSORS --> CTX
    CTX --> PROMPT
    PROMPT --> LLM
    LLM -- "Valid JSON Action" --> DISPATCH
    LLM -- "Timeout / Parsing Error" --> FALLBACK
    FALLBACK --> DISPATCH
    DISPATCH --> EXEC
    EXEC -- "Action Result Feedback" --> CTX
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
│   │   ├── ollama.js          # Ollama REST client, payload formatting, and JSON extraction
│   │   └── prompt.js          # Dynamic system and user prompt constructor
│   ├── skills/
│   │   ├── dispatcher.js      # Central router mapping action names to skill functions
│   │   ├── mine.js            # Target block search, pathfinding, and mining with best tool
│   │   ├── craft.js           # Crafting table detection/placement and 2x2/3x3 recipe crafting
│   │   ├── smelt.js           # Furnace placement, fuel selection, and smelting operations
│   │   ├── place.js           # Physical block placement (crafting tables, furnaces, chests)
│   │   ├── navigate.js        # Safe exploration, obstacle avoidance, sleeping, and unstuck
│   │   ├── combat.js          # Mob combat, fleeing, armor auto-equip, and shield defense
│   │   ├── eat.js             # Food selection and eating routines
│   │   ├── storage.js         # Chest sorting and bulky item depositing
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

   # Ollama settings
   OLLAMA_MODEL=qwen2.5:27b
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
| `objectif <item>` or `goal <item>` | Manually sets the agent's target objective (e.g., `objectif diamond_pickaxe`). |
| `objectif auto` or `goal auto` | Restores the default automatic survival quest progression chain. |
| `inventaire` or `inv` | Causes the bot to output its current inventory contents into chat. |
| `coords` or `pos` | Outputs the bot's current $(X, Y, Z)$ coordinates into chat. |

---

## ⚙️ Configuration Reference

### Environment Variables (`.env`)

| Variable | Default | Description |
|---|---|---|
| `MC_HOST` | `127.0.0.1` | Minecraft server hostname or IP address. |
| `MC_PORT` | `25565` | Minecraft server port. |
| `MC_USERNAME` | `Herobrine` | In-game player name for the bot. |
| `MC_PASSWORD` | *(Empty)* | Password used for server `/register` or `/login` commands. |
| `OLLAMA_MODEL` | `qwen2.5:27b` | Ollama model tag (`qwen2.5:27b`, `llama3.1:8b`, `mistral`, etc.). |
| `PORT` | `127.0.0.1:25565:25565` | Optional Docker port mapping. |

### Bot Rules & Parameters (`src/config.js`)

- **Survival Delay:** Configured delay between consecutive ReAct decisions (`config.LOOP_DELAY_MS`).
- **Quest Chain:** Linear fallback progression from `oak_log` up to `diamond` tools and armor.
- **Safety Thresholds:** Health and hunger limits that trigger immediate fleeing or eating before continuing tasks.
- **Base Management:** Stored coordinates for the player base, placed crafting tables, furnaces, and storage chests.

---

## 🧰 Available Agent Skills

The ReAct loop provides the LLM with structured actions formatted in JSON:

| Skill | Parameters | Description |
|---|---|---|
| `mine` | `target: string` | Finds the closest target block in the world, navigates to it, equips the optimal tool, and mines it. |
| `craft` | `item: string` | Crafts an item using 2x2 player inventory or navigates to/places a crafting table for 3x3 recipes. |
| `place` | `blockName: string` | Places a block from inventory on safe, valid adjacent ground (e.g., `crafting_table`, `furnace`, `chest`). |
| `smelt` | `item: string` | Places or approaches a furnace, loads fuel (coal/charcoal/wood), and smelts raw ores or food. |
| `explore` | *None* | Selects a safe, unvisited terrain location and walks forward to discover new resources. |
| `unstuck` | *None* | Performs emergency jump-and-place or wall mining maneuvers to escape deep pits, 1x1 holes, or water. |
| `eat` | *None* | Scans inventory for the highest-nourishment food item and consumes it. |
| `store_chest` | *None* | Navigates to a nearby chest and deposits bulky materials (dirt, excess cobblestone, mob drops). |
| `flee` | *None* | Retreats from nearby hostile mobs to recover health in safety. |
| `sleep` | *None* | Searches for a nearby bed during night or thunderstorm to pass the night safely. |
| `wiki` | `target: string` | Looks up recipes, tool requirements, and drops for any block or item in the game database. |

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
[AI THOUGHT] Je possède déjà une pioche en bois et une en pierre. Mon objectif est d'obtenir une 'stone_pickaxe'. Selon la règle fondamentale, je ne dois pas inventer de recettes. Je vérifie ma situation : j'ai besoin de miner du 'stone' pour obtenir des 'cobblestone', puis de les crafter avec des bâtons. Cependant, avant de miner, je dois m'assurer que je n'ai pas besoin de consulter le Wiki pour confirmer la recette exacte ou si une action spécifique est requise. Mais en regardant mes ressources, j'ai déjà 159 cobblestone et seulement 1 stick. Je manque donc de bâtons. La priorité est d'obtenir des bâtons (stick). Pour cela, je dois couper du bois avec mon hache en pierre ou en bois. J'ai beaucoup de logs dans l'inventaire mais pas de planches coupées pour faire des bâtons facilement sans crafter des planches d'abord. Attends, la recette standard est 3 cobblestone + 2 sticks. Je n'ai que 1 stick. Je dois donc en fabriquer. Pour fabriquer un stick, il faut couper du bois (log) -> planche -> stick ? Non, dans Minecraft classique : Log -> Planches (4x) -> Bâtons (2x). Donc je dois crafter des planches puis des bâtons. Ou alors miner du 'stone' si j'avais assez de sticks. Je n'ai que 1 stick. Je vais donc utiliser mon hache pour couper du bois (jungle_log ou oak_log) afin d'obtenir plus de ressources pour faire des bâtons, ou crafter directement des planches puis des bâtons. Mais l'action 'mine' est pour les blocs dans le radar. Le radar montre des arbres ('oak_leaves', 'jungle_leaves', etc.) mais pas de tronc exposé spécifiquement listé comme cible minable directement (le radar liste 'oak_log':22, 'jungle_log':62). Je peux miner ces logs. Donc action : mine un log pour obtenir du bois brut, puis je crafterai des planches et des bâtons. Ou alors, je peux utiliser l'action 'craft' si j'ai les ingrédients. Je n'ai pas assez de sticks. Je dois donc couper du bois. Le radar indique 'oak_log':22 et 'jungle_log':62. Je vais miner un oak_log.
[MINE] Moving towards oak_log...
[SERVER] <Ollama> Action : mine (oak_log)
Mining failure : Took to long to decide path to goal!
[RESULT] ❌ Mining failed for 'oak_log' : Block unreachable (Took to long to decide path to goal!).

=== REACT THINKING CYCLE (objective : stone_pickaxe) ===
[AI THOUGHT] L'objectif est de fabriquer une pioche en pierre (stone_pickaxe). La recette nécessite 3 cobblestone et 2 bâtons. J'ai déjà 159 cobblestone dans mon inventaire, donc je n'ai pas besoin de miner la pierre. Je ne possède qu'un seul bâton ('stick'), alors que j'en ai besoin de 2. Je dois donc en fabriquer un autre. Pour cela, je vais d'abord poser une table d'artisanat si ce n'est pas déjà fait (il y en a une visible dans le radar), puis crafter un bâton avec des planches de bois (j'ai beaucoup de bois). Une fois les 2 bâtons obtenus, je pourrai crafter la pioche.
[RESULT] ❌ You do not have 'crafting_table' in your inventory.
[SERVER] <Ollama> Action : place (crafting_table)

=== REACT THINKING CYCLE (objective : stone_pickaxe) ===
[AI THOUGHT] L'action précédente a échoué car je n'avais pas de table d'artisanat dans mon inventaire. Je dois donc en fabriquer une d'abord (3 planches + 1 bâton). J'ai les ressources nécessaires (bois et bâtons) pour créer des planches puis la table. Je vais commencer par crafter 'crafting_table'.
[CRAFT] Moving to crafting table at (422, 76, -284)...
[SERVER] <Ollama> Action : craft (crafting_table)
[RESULT] ❌ Missing required components in inventory to craft 'crafting_table'.

=== REACT THINKING CYCLE (objective : stone_pickaxe) ===
[AI THOUGHT] L'établissement a échoué car je n'ai pas de planches. Je dois d'abord convertir mes arbres (jungle_log, birch_log, oak_log) en planches pour pouvoir crafter l'établissement. J'ai assez de bois pour commencer.
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

This project is licensed under the [ISC License](LICENSE).
