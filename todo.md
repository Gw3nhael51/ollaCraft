# Roadmap & Backlog Technique — ollaCraft (Bot Autonome Minecraft)

## 🚨 Priorité P0 : Corrections d'Incohérences & Bugs Critiques
- [x] **Bug du saut infini hors de l'eau (`src/index.js`)** : Remettre `bot.setControlState('jump', false)` lorsque `bot.entity.isInWater` repasse à `false` dans `physicsTick` pour éviter l'épuisement de la faim et le blocage du pathfinder.
- [x] **Incohérence de l'objectif initial (`src/state.js` & `src/config.js`)** : Aligner `currentObjective` initial (`'wooden_pickaxe'` au lieu de `'wooden_axe'`) avec `QUEST_CHAIN` pour éviter que `'wooden_axe'` soit marquée comme complétée sans avoir été fabriquée.
- [x] **Recette `blaze_powder` manquante (`src/utils/inventory.js` & `src/config.js`)** : Ajouter `'blaze_powder'` dans `getAvailableCrafts` (et/ou `QUEST_CHAIN`) afin de débloquer la fabrication de `'ender_eye'`.
- [x] **Conservation du gravier et matériaux clés (`src/skills/storage.js`)** : Aligner `maxToKeep` dans `skillChest` avec `isItemToStore` et conserver `gravel`/`flint` (requis pour `flint_and_steel`), `blaze_rod`, `ender_pearl` et `obsidian`.
- [x] **Reprise de progression après mort/reconnexion et faux positif AuthMe (`src/index.js` & `src/utils/inventory.js`)** : Ignorer `"already have registered"` pour le lancement initial, reprendre la survie au respawn et valider les paliers antérieurs si un équipement supérieur est possédé.
- [x] **Condition erronée du succès `Diamonds!` (`src/utils/advancements.js`)** : Retirer `hasItem('bucket')`, `hasItem('water_bucket')` et `hasItem('flint_and_steel')` de la validation du jalon `'Diamonds!'`.

## 🛠️ Priorité P1 : Corrections Gameplay & Compétences
- [x] **Exploitation de `state.managerSubGoal` (`src/ai/loop.js` & `src/ai/manager.js`)** : Utiliser `state.managerSubGoal` (actuellement calculé mais jamais lu) dans le prompt du joueur et comme action de *fallback* si l'appel LLM du joueur échoue.
- [x] **Harmonisation de la portée de détection de l'établi (`src/ai/manager.js`, `src/ai/loop.js`, `src/skills/craft.js`)** : Unifier la distance de recherche de `crafting_table` et prendre en compte `state.base.crafting_table` dans `sanitizeManagerOutput`.
- [x] **Ajout de l'action `"wiki"` dans le Manager (`src/ai/manager.js`)** : Autoriser `"wiki"` dans la liste des `suggestedAction` du prompt Manager.
- [x] **Prise en compte de `qty` dans le craft (`src/skills/dispatcher.js` & `src/skills/craft.js`)** : Transmettre le paramètre `qty` à `skillCraft` et l'utiliser dans `bot.craft(recipes[0], qty, tableToUse)`.
- [x] **Cuisson multiple et gestion du combustible (`src/skills/smelt.js`)** : Calculer la quantité de combustible requise selon `qty`, attendre la cuisson complète de tous les items (au lieu de s'arrêter dès le 1er item produit) et adapter le timeout dynamiquement.
- [ ] **Collecte des drops à la position de mort réelle (`src/skills/combat.js`)** : Mémoriser la dernière position valide de la cible pendant `combatLoop` au lieu d'aller chercher le butin à `startPos` (position initiale avant poursuite).
- [ ] **Construction et moulage du portail du Nether (`src/skills/portal.js`)** :
  - Corriger `placePortalFrameStep` pour poser les blocs contre n'importe quelle face adjacente solide (et utiliser des blocs d'échafaudage pour les coins) afin de pouvoir monter les piliers et le linteau supérieur.
  - Remplacer le simple versement d'eau de `castObsidianAtLavaPool` par un vrai moulage bloc par bloc ou par le minage de l'obsidienne formée si une pioche en diamant est disponible.

## ⚡ Priorité P1 : Optimisations Performances (CPU, Mémoire & Coût LLM)
- [ ] **Fusion du scan 3D (`src/utils/environment.js`)** : Unifier `scanEnvironment` et `scanExposedOres` en une seule passe (évite > 47 000 appels `bot.blockAt()` synchrones par cycle) et mettre en cache les listes de blocs de `src/utils/wikiData.js`.
- [ ] **Manager événementiel (`src/ai/loop.js` & `src/ai/manager.js`)** : N'exécuter `runManagerCycle` que sur événement (échec d'action, boucle détectée par `detectActionLoop`, changement de palier, ou tous les $N$ cycles) pour réduire de ~75% la consommation de tokens et la latence.
- [ ] **Filtrage du radar dans le prompt (`src/ai/prompt.js`)** : Exclure les blocs décoratifs inutiles (`short_grass`, `tall_grass`, fleurs, `bedrock`, `kelp`) du JSON envoyé au LLM.
- [ ] **Structured Outputs & Configuration Ollama (`src/ai/ollama.js` & `src/config.js`)** :
  - Rendre l'URL Ollama configurable via `process.env.OLLAMA_HOST`.
  - Passer un schéma JSON strict dans le champ `format` d'Ollama pour contraindre `action` à `VALID_ACTIONS`.
- [ ] **Expiration (TTL) sur `GLOBAL_BAD_BLOCKS` (`src/skills/mine.js`)** : Remplacer le `Set` infini par une `Map<posKey, timestamp>` avec expiration automatique (ex. 2-3 minutes) pour éviter les fuites mémoire et le bannissement définitif de blocs temporairement inaccessibles.

## 🚀 Priorité P2 : Améliorations Fonctionnelles & Documentation
- [ ] **Réflexes de survie déterministes pré-LLM (`src/ai/loop.js`)** : Déclencher automatiquement `skillEat` en cas de faim critique et la fuite/défense en cas de danger vital immédiat sans attendre la génération LLM.
- [ ] **Amélioration de `skillUnstuck` (`src/skills/navigate.js` & `src/config.js`)** : Ajouter `deepslate` et `cobbled_deepslate` dans `SOFT_BLOCKS` et implémenter le *pillar-jumping* (sauter + poser un bloc sous ses pieds) pour sortir des puits profonds.
- [ ] **Combat avancé (`src/skills/combat.js`)** : Activer la parade au bouclier (`bot.activateItem(true)`) face aux Squelettes et reculer lorsque les Creepers gonflent.
- [ ] **Synchronisation de la documentation (`README.md`)** : Aligner la liste des compétences (`chest`, `hunt`, `fight`, `equip`, `portal`), documenter la commande `tokens` et retirer ou implémenter `flee` / `sleep` / `LOOP_DELAY_MS`.

---

## 🗺️ Roadmap Fonctionnelle (Progression Speedrun)

### Étape 1 : Survie avancée et Combat (Âge de Fer & Bouclier)
- [x] **Compétence `hunt` / `fight`** : Apprendre au bot à attaquer les entités (animaux pour la nourriture, monstres pour se défendre ou récupérer des ressources utiles).
- [x] **Gestion des armures (`equip`)** : Apprendre au bot à fabriquer (casque, plastron, jambières, bottes) et à s'équiper automatiquement pour survivre.
- [x] **Stockage et gestion d'inventaire (`chest`)** : Crafter un coffre, le poser dans la base et y déposer les objets non essentiels quand l'inventaire est plein.

### Étape 2 : Le Nether (Transition Speedrun)
- [x] **Création du Portail au Seau (`bucket`)** : Trouver une mare de lave et mouler le portail d'obsidienne avec de l'eau (évite le minage profond de diamant).
- [x] **Allumage du Portail** : Fabriquer un briquet (`flint_and_steel`), allumer le portail et entrer dans le Nether.
- [ ] **Exploration du Nether** : Gérer les dangers environnementaux (feu, lave) et trouver une Forteresse.
- [ ] **Chasse aux Blazes** : Vaincre des Blazes pour obtenir des bâtons de Blaze (`blaze_rod`).

### Étape 3 : La préparation finale (Yeux de l'Ender)
- [ ] **Récolte d'Ender Pearls** : Chasser des Endermen ou mettre en place un système de troc avec les Piglins.
- [ ] **Fabrication des Yeux** : Transformer les bâtons de Blaze en poudre et crafter les Yeux de l'Ender (`ender_eye`).
- [ ] **Triangulation du Stronghold** : Lancer un œil, suivre sa direction, recommencer, et creuser jusqu'à trouver le Stronghold.

### Étape 4 : L'Ender Dragon (Combat Final)
- [ ] **Activation du Portail de l'End** : Trouver la salle du portail et placer les yeux de l'Ender manquants.
- [ ] **Destruction des Cristaux** : Créer une logique pour cibler (arc) ou escalader les piliers afin de détruire les cristaux de l'End.
- [ ] **Combat contre le Dragon** : Gérer les attaques au corps-à-corps lorsque le dragon se pose au centre.
