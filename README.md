# perfguard-mcp

Serveur MCP local (Windows) qui expose l'état RAM/CPU/process de la machine à un LLM, pour lui permettre de limiter le nombre d'agents/tâches lancés en parallèle au lieu de saturer la machine.

Contexte : sur une machine avec 32 Go de RAM qui fait tourner Chrome + Docker/WSL2 + plusieurs agents Claude en parallèle, la RAM finit par saturer et tout plante. `perfguard-mcp` donne à un LLM un moyen de vérifier la charge réelle avant de lancer un batch de tâches, et de réduire la taille du batch si besoin — plutôt que de deviner.

Ce dépôt contient aussi le skill [`perfguard`](skill/perfguard/SKILL.md) qui explique à Claude comment utiliser ce serveur.

## Outils exposés

| Outil | Description |
|---|---|
| `get_status` | RAM/CPU actuels, répartition par groupe (`chrome`, `claudeNode`, `dockerWsl`), top 5 process par RAM, `loadLevel` (`ok` / `warning` / `critical`). |
| `recommend_parallelism` | Calcule un nombre d'agents recommandé (`recommendedMax`) à partir de la RAM libre. Paramètres optionnels : `estimatedMbPerAgent` (défaut 800 Mo), `reserveMb` (défaut 4000 Mo réservés à l'OS/Chrome/Docker). |
| `check_before_spawn` | Comme `recommend_parallelism` mais prend `desired` (nombre d'agents voulus) et renvoie directement `allowed` (bool) + `reason`. |
| `list_top_processes` | Top process par RAM, avec filtre optionnel `filter` sur le nom. |

Le serveur n'expose volontairement **aucun outil pour tuer un process** — l'idée est de freiner en amont le nombre de tâches lancées, pas d'agir après coup sur des process en cours.

## Prérequis

- Windows (le serveur s'appuie sur PowerShell / WMI ; pas encore de support macOS/Linux)
- Node.js ≥ 18

## Installation

```powershell
git clone <url-du-repo>
cd perfguard-mcp
npm install
```

## Connexion à Claude Desktop

Ouvrir (ou créer) `%APPDATA%\Claude\claude_desktop_config.json` :

```powershell
notepad "$env:AppData\Claude\claude_desktop_config.json"
```

Ajouter le serveur dans la clé `mcpServers` (en conservant les entrées déjà présentes) :

```json
{
  "mcpServers": {
    "perfguard": {
      "command": "node",
      "args": ["C:\\CHEMIN\\VERS\\perfguard-mcp\\index.js"]
    }
  }
}
```

Redémarrer l'application Claude Desktop.

## Le skill perfguard

Le fichier [`skill/perfguard/SKILL.md`](skill/perfguard/SKILL.md) explique à Claude quand et comment appeler `check_before_spawn` avant de lancer un batch d'agents en parallèle, et comment réagir si la charge est trop élevée. Il est déjà enregistré comme skill de compte sur Claude — ce fichier sert de référence versionnée / source de vérité pour le modifier plus tard.

## Licence

MIT
