---
name: perfguard
description: Vérifie la charge RAM/CPU de la machine (via le serveur MCP perfguard) avant de lancer plusieurs agents ou tâches en parallèle, et adapte le nombre de tâches lancées en conséquence. À utiliser avant tout batch d'agents parallèles (Task tool, sous-agents, jobs en fond), ou quand l'utilisateur signale des lenteurs/plantages liés à la RAM.
---

# perfguard

Cette machine tourne souvent à la limite (Chrome + Docker/WSL2 + plusieurs agents Claude Code en parallèle sur 32 Go de RAM). Le serveur MCP `perfguard` donne un état réel de la charge pour éviter de saturer la machine en lançant trop de tâches en même temps.

## Avant de lancer plusieurs agents/tâches en parallèle

1. Appeler `perfguard.check_before_spawn` avec `desired` = le nombre d'agents que tu comptes lancer.
2. Lire le résultat :
   - `allowed: true` → lancer le batch normalement.
   - `allowed: false` → ne pas lancer le batch complet. Utiliser `recommendedMax` comme taille de lot, lancer les tâches par vagues de cette taille au lieu de tout en une fois, et informer l'utilisateur en une phrase de la charge actuelle (`ram.pct`, `cpuPct`) et du nombre de vagues prévu.
   - `loadLevel: "critical"` → ne rien lancer de nouveau. Dire à l'utilisateur que la RAM est déjà saturée (donner `groups` pour dire quoi consomme le plus : Chrome / Claude-Node / Docker-WSL) et proposer d'attendre ou de fermer des applications avant de continuer.

## Pendant un batch long

Si le batch dépasse ~5 tâches ou tourne plus de quelques minutes, rappeler `perfguard.get_status` toutes les 5 tâches environ pour vérifier que la charge n'a pas dérivé, et réduire dynamiquement le nombre de tâches en vol si `loadLevel` passe à `warning` ou `critical`.

## Ce qu'il ne faut jamais faire

- Ne jamais tuer un process automatiquement via ce serveur (il n'expose volontairement aucun outil de kill). Si la RAM est critique et qu'il faut libérer de la mémoire, le dire à l'utilisateur et le laisser décider (ou le renvoyer vers le widget RamWatcher sur son bureau, qui a des boutons pour tuer Chrome/Node/Docker en confirmant).
- Ne pas se fier à une seule lecture ancienne : si plus de ~30s se sont écoulées depuis le dernier `get_status`/`check_before_spawn`, en refaire un avant de décider.

## Outils disponibles

- `get_status` — RAM/CPU actuels, répartition par groupe (chrome, claudeNode, dockerWsl), top 5 process, `loadLevel` (ok/warning/critical).
- `recommend_parallelism` — calcule un nombre max d'agents recommandé à partir de la RAM libre (`estimatedMbPerAgent`, défaut 800 Mo par agent ; `reserveMb`, défaut 4000 Mo réservés à l'OS/Chrome/Docker).
- `check_before_spawn` — comme `recommend_parallelism` mais prend `desired` et renvoie directement `allowed` + une raison lisible.
- `list_top_processes` — top process par RAM, avec filtre optionnel par nom.
