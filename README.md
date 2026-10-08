# GIR - Agent Minecraft Autonome (ReAct + Ollama)

## 🎯 Objectif du Projet
Ce projet est un bot Minecraft autonome développé en **Node.js** avec **Mineflayer**. Le bot (nommé `Herobrine`) utilise une boucle **ReAct** (Reasoning + Acting) couplée à une intelligence artificielle locale servie par **Ollama (modèle llama3.1)** pour analyser son environnement et prendre des décisions de survie (miner, fabriquer, poser des blocs, explorer).

## 🛠️ Fonctionnalités Principales
- **Prise de décision IA (ReAct) :** L'agent analyse son inventaire, son environnement proche (radar des blocs) et déduit la meilleure action possible (`mine`, `craft`, `place`, `explore`, `unstuck`).
- **Chaîne d'objectifs (Quêtes) :** Le bot suit une progression de survie naturelle (hache en bois -> pioche en bois -> cobblestone -> outils en pierre -> four), qu'il adapte en fonction de ce qu'il a déjà.
- **Actions Intelligentes :** 
  - Il choisit et équipe l'outil le plus adapté pour chaque bloc.
  - Il sait repérer un établi existant pour ses crafts avancés, ou poser le sien au sol.
  - Il possède une fonction pour tenter de se dégager (`unstuck`) s'il détecte qu'il est coincé dans un trou ou encerclé par des blocs infranchissables.

## 🚀 Technologies Utilisées
- **Environnement :** Node.js
- **Minecraft :** `mineflayer`, `mineflayer-pathfinder`
- **IA Locale :** Llama 3.1 (via Ollama API locale sur le port 11434)

## 🎮 Commandes In-Game (Chat)
- `start` : Lance le cycle autonome (ReAct).
- `stop` : Interrompt les actions et stoppe l'autonomie.
- `objectif <item>` : Fixe un objectif manuel (ex: `objectif diamond_pickaxe`).
- `objectif auto` : Remet le bot sur sa liste de progression normale.
- `inventaire` : Le bot récapitule les objets qu'il porte dans le chat.

```
