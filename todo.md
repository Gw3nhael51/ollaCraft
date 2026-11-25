# 🗺️ Roadmap & Bilan Technique — OllaCraft (v4.6)

## ✅ Architecture Cognitive & Apprentissage Procédural (Phases 1 → 4.6)
- [x] **Phase 1 — Restructuration Modulaire (`src/core`, `src/infrastructure`, `src/agent`, `src/actions`, `src/procedures`, `src/perception`, `src/minecraft`)** : Séparation stricte des responsabilités et découplage du client Mineflayer.
- [x] **Phase 2 — Primitives d'Actions Déterministes (`src/actions/primitives/`)** : 27 primitives vérifiées (`movement`, `blocks`, `items`, `container`, `combat`) avec verrous réentrants (`lock.js`), gestion d'`AbortSignal` et vérification de l'état du monde.
- [x] **Phase 3 — Moteur DSL Déclaratif (`src/procedures/`)** : Schéma JSON (`schema.js`), catalogue d'actions (`registry.js`), validation statique et sémantique (`validator.js`), exécution supervisée (`runner.js`), persistance (`store.js`) et intégration `dispatcher.js` / `manager.js`.
- [x] **Phase 4.1 — Détection des Objectifs Non Couverts & Anti-Boucle (`matcher.js`)** : Filtrage des micro-tâches triviales et protection contre les boucles de génération (`ObjectiveGenerationTracker`).
- [x] **Phase 4.2 — Génération DSL par Ollama (`generator.js`)** : Synthèse de procédures déclaratives avec tentatives bornées et gestion des timeouts.
- [x] **Phase 4.3 — Validation Sémantique Profonde (`validator.js`)** : Vérification statique des types, du graphe de dépendances (`$steps`, `$parameters`), des préconditions et de la vérifiabilité des postconditions.
- [x] **Phase 4.4 — Enregistrement & Exécution Expérimentale (`memory.js`, `runner.js`)** : Protection stricte des procédures `validated`, attribution d'identifiants uniques et trace d'exécution normalisée (`executionId`).
- [x] **Phase 4.5 — Évaluation Indépendante des Résultats Réels (`evaluator.js`)** : Vérification physique de l'objectif (`evaluateObjective`), statut `unknown` pour capteurs indisponibles, détection des contradictions (`detectTraceContradictions`) et des pénuries de ressources (`detectResourceShortage`).
- [x] **Phase 4.6 — Cycle de Vie, Versionnement & Exploitation des Connaissances (`lifecycle.js`, `memory.js`)** :
  - Historique d'évaluation dédupliqué par `executionId`.
  - Promotion `experimental → validated` après >= 3 réussites vérifiées et indépendantes.
  - Classification des échecs (`resource_shortage`, `execution_error`, `objective_not_achieved`, `contradiction`, `inconclusive`) et dépréciation prudente.
  - Versionnement non-destructif (`v1 validated` + `v2 experimental`) avec comparaison de performances et fallback.
  - Extraction de connaissances (`getKnowledge`) pour le Manager et le Generator.
- [x] **Tests & Benchmark (`test/`, `scripts/benchmark.js`, `.github/workflows/ci.yml`)** : **180/180 tests unitaires et E2E** + benchmark automatisé (`npm run benchmark`) + CI/CD GitHub Actions.

---

## ✅ Stabilisation Runtime, Connaissances & Démo (P0/P1)
- [x] **Raccordement `ProcedureMemory` & Docker (`src/index.js`, `src/core/state.js`, `docker-compose.yml`)** : Chargement `loadAll()` au démarrage, volume `./data:/app/data`, priorité absolue + bypass LLM Joueur sur procédures `validated`, enveloppe timeout 75s, suppression de l'auto-promotion booléenne.
- [x] **Connaissances Minecraft & Graphe de Dépendances (`src/minecraft/knowledge.js`)** : Décomposition récursive des prérequis (`getItemKnowledge`, `resolveGoalPlan`) intégrée au Manager et au prompt Joueur.
- [x] **Perception & Exploration (`src/perception/environment.js`, `src/actions/behaviors/blocks/mine.js`, `src/actions/behaviors/movement/navigate.js`)** : TTL (2 min) sur `badBlocksRegistry` synchronisé avec `scanEnvironment`, filtrage des `*_leaves` du Radar, exploration directionnelle.
- [x] **Stabilisation P0 Pré-Démo (`src/index.js`, `src/agent/loop.js`, `src/agent/manager.js`, `src/actions/behaviors/items/smelt.js`)** : Réinitialisation propre après `death`, suppression des doubles `unstuck` sur terrain libre, marquage temporaire des fours inaccessibles avec bascule vers `craft`/`place` d'un four local.

---

## ✅ Correctifs P0 & P1 (Survie, Gameplay & Performances)
- [x] **Sortie d'eau (`src/index.js`)** : Remise à zéro du saut (`jump: false`) dès la sortie de l'eau.
- [x] **Alignement de `QUEST_CHAIN` (`src/infrastructure/config.js`, `src/core/state.js`)** : Objectif initial `wooden_pickaxe` et support de `blaze_powder`.
- [x] **Conservation des matériaux clés (`src/actions/behaviors/items/storage.js`)** : Rétention de `gravel`, `flint`, `blaze_rod`, `ender_pearl`, `obsidian`.
- [x] **Reprise après mort / reconnexion (`src/index.js`, `src/perception/inventory.js`)** : Synchronisation automatique du palier selon l'équipement possédé.
- [x] **Scan 3D unifié & Cache Wiki (`src/perception/environment.js`, `src/minecraft/wikiData.js`)** : Scan en une passe (2,32 ms pour 35 937 voxels) et filtrage des blocs décoratifs dans le radar.
- [x] **Manager événementiel & Structured Outputs Ollama (`src/agent/manager.js`, `src/agent/ollama.js`)** : Réduction des appels LLM et validation stricte des schémas JSON.
- [x] **Construction du portail du Nether & Cuisson par lots (`src/actions/behaviors/world/portal.js`, `src/actions/behaviors/items/smelt.js`)** : Placement multi-faces des 11 blocs d'obsidienne et calcul dynamique du combustible.

---

## ✅ Autonomie Fin de Jeu & Anti-Boucle (branche `feat/endgame-autonomy`)
- [x] **Planificateur déterministe (`src/agent/planner.js`)** : exécution sans LLM de la prochaine étape faisable du plan de dépendances, réflexes de survie et logistique d'étape (retour au portail, Nether, stronghold, End).
- [x] **Mémoire d'échecs & déblocage (`src/agent/recovery.js`)** : refus d'une paire action/cible après 2 échecs (5 min), détection de stagnation, action de remplacement forcée ; commande chat `debug`.
- [x] **Objectif direct (`src/agent/goals.js`)** : `objectif <item> [qté]` construit et annonce la chaîne de prérequis (ex. pioche en fer avant diamant) ; correction des plans circulaires (`diamond`, `raw_iron`, `coal`).
- [x] **Établi portable (`src/actions/behaviors/items/table.js`)** : posé pour le craft, cassé et récupéré en repartant, plus aucune position d'établi mémorisée.
- [x] **Points de repère persistants (`src/core/progress.js`)** : portails, lits, forteresse, stronghold, portail de l'End, dernière mort ; conservés après une mort et un redémarrage.
- [x] **Lits de réapparition (`src/actions/behaviors/world/bed.js`)** : avant le portail du Nether puis avant le portail de l'End.
- [x] **Chaîne de quêtes complète** : `bed` → `nether_portal` → `blaze_rod` → … → `bow` / `arrow` → `end_bed` → `stronghold` → `end_portal` → `ender_dragon`.
- [x] **Triangulation du stronghold à 2 yeux (`src/minecraft/triangulation.js`, `stronghold.js`)**, portail de l'End (`endportal.js`) et combat du dragon (`dragon.js`).

---

## 🧪 Campagne de Tests In-Game & Perspectives (Roadmap Future)
- [ ] **Campagne de tests en conditions réelles (Serveur Minecraft 1.20.4 + Ollama)** : Relever et ouvrir des issues dédiées sur les éventuels cas limites rencontrés en jeu.
- [ ] **Validation en jeu — Nether & Chasse aux Blazes (#23)** : la recherche de forteresse et le combat sont implémentés mais non validés sur serveur réel.
- [ ] **Validation en jeu — Yeux de l'Ender & Triangulation (#24)** : mesure du cap sur l'entité `eye_of_ender`, marche de la ligne de base, trajet et recherche de la salle du portail à valider en jeu.
- [ ] **Validation en jeu — Combat contre l'Ender Dragon (#25)** : tir à l'arc sur les cristaux et attaque du dragon à valider ; cristaux en cage et absence d'arc non gérés.
