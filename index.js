#!/usr/bin/env node
// perfguard-mcp
// Serveur MCP local qui expose l'etat RAM/CPU/process de la machine (Windows)
// pour permettre a un LLM de decider combien de taches/agents lancer en parallele.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Groupes de process a surveiller en priorite (alignes avec le widget RamWatcher)
const WATCHED_GROUPS = {
  chrome: ["chrome"],
  claudeNode: ["node", "Claude"],
  dockerWsl: ["Docker Desktop", "com.docker.backend", "com.docker.build", "vmmem", "vmmemWSL", "wslhost", "wsl"],
};

const PS_SCRIPT = `
$os = Get-CimInstance Win32_OperatingSystem
$totalMB = [Math]::Round($os.TotalVisibleMemorySize / 1024)
$freeMB  = [Math]::Round($os.FreePhysicalMemory / 1024)
$usedMB  = $totalMB - $freeMB
$pctRAM  = [Math]::Round(($usedMB / $totalMB) * 100)
$cpuLoad = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
if ($null -eq $cpuLoad) { $cpuLoad = 0 }
$allProcs = Get-Process | Where-Object { $_.ProcessName -notin @('powershell','pwsh') } |
    Group-Object ProcessName | ForEach-Object {
        [PSCustomObject]@{
            Name = $_.Name
            MB   = [Math]::Round((($_.Group | Measure-Object WorkingSet64 -Sum).Sum) / 1MB)
        }
    }
$top = $allProcs | Sort-Object MB -Descending | Select-Object -First 10
$result = [PSCustomObject]@{
    usedMB  = $usedMB
    totalMB = $totalMB
    freeMB  = $freeMB
    pctRAM  = $pctRAM
    cpuPct  = [Math]::Round($cpuLoad)
    top     = @($top)
    all     = @($allProcs)
}
$result | ConvertTo-Json -Depth 4 -Compress
`;

async function getRawStatus() {
  if (process.platform !== "win32") {
    throw new Error("perfguard-mcp : seul Windows est supporte pour l'instant.");
  }
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", PS_SCRIPT],
    { maxBuffer: 10 * 1024 * 1024 }
  );
  return JSON.parse(stdout);
}

function normalizeArray(x) {
  if (Array.isArray(x)) return x;
  if (x === null || x === undefined) return [];
  return [x];
}

function groupSums(all) {
  const sums = {};
  for (const [key, names] of Object.entries(WATCHED_GROUPS)) {
    const lowerNames = names.map((n) => n.toLowerCase());
    sums[key] = all
      .filter((p) => lowerNames.includes(String(p.Name).toLowerCase()))
      .reduce((acc, p) => acc + p.MB, 0);
  }
  return sums;
}

function loadLevel(pctRAM) {
  if (pctRAM >= 90) return "critical";
  if (pctRAM >= 75) return "warning";
  return "ok";
}

async function getStatus() {
  const raw = await getRawStatus();
  const all = normalizeArray(raw.all);
  const top = normalizeArray(raw.top);
  return {
    timestamp: new Date().toISOString(),
    ram: { usedMB: raw.usedMB, totalMB: raw.totalMB, freeMB: raw.freeMB, pct: raw.pctRAM },
    cpuPct: raw.cpuPct,
    groups: groupSums(all),
    top5: top.slice(0, 5).map((p) => ({ name: p.Name, mb: p.MB })),
    loadLevel: loadLevel(raw.pctRAM),
    _all: all,
  };
}

function json(obj) {
  const { _all, ...rest } = obj;
  return { content: [{ type: "text", text: JSON.stringify(rest, null, 2) }] };
}

const server = new McpServer({ name: "perfguard", version: "1.0.0" });

server.tool(
  "get_status",
  "Renvoie l'etat actuel de la machine : RAM/CPU utilises, repartition par groupe (Chrome, Claude/Node, Docker/WSL), top 5 process par RAM, et un niveau de charge (ok / warning / critical).",
  {},
  async () => json(await getStatus())
);

server.tool(
  "recommend_parallelism",
  "Calcule combien de taches/agents supplementaires peuvent raisonnablement tourner en parallele sans saturer la RAM, a partir de la RAM libre actuelle.",
  {
    estimatedMbPerAgent: z.number().optional().describe("RAM estimee par agent, en Mo (defaut 800)"),
    reserveMb: z.number().optional().describe("RAM a garder de cote pour l'OS/Chrome/Docker, en Mo (defaut 4000)"),
  },
  async ({ estimatedMbPerAgent = 800, reserveMb = 4000 }) => {
    const status = await getStatus();
    const usable = status.ram.freeMB - reserveMb;
    const recommendedMax = Math.max(0, Math.floor(usable / estimatedMbPerAgent));
    return json({ ...status, estimatedMbPerAgent, reserveMb, recommendedMax });
  }
);

server.tool(
  "check_before_spawn",
  "A appeler avant de lancer plusieurs agents/taches en parallele. Indique si c'est raisonnable de lancer 'desired' agents maintenant, et combien lancer sinon.",
  {
    desired: z.number().describe("Nombre d'agents/taches qu'on voudrait lancer en parallele"),
    estimatedMbPerAgent: z.number().optional(),
    reserveMb: z.number().optional(),
  },
  async ({ desired, estimatedMbPerAgent = 800, reserveMb = 4000 }) => {
    const status = await getStatus();
    const usable = status.ram.freeMB - reserveMb;
    const recommendedMax = Math.max(0, Math.floor(usable / estimatedMbPerAgent));
    const allowed = status.loadLevel !== "critical" && desired <= recommendedMax;
    const reason =
      status.loadLevel === "critical"
        ? "RAM/CPU deja critiques, ne pas lancer de nouvelles taches maintenant."
        : desired > recommendedMax
        ? `Seulement ${recommendedMax} agent(s) tiennent dans la RAM libre actuelle (sur ${desired} demandes).`
        : "OK, la marge RAM est suffisante.";
    return json({ ...status, desired, recommendedMax, allowed, reason });
  }
);

server.tool(
  "list_top_processes",
  "Liste les process qui consomment le plus de RAM en ce moment, avec un filtre optionnel par nom.",
  {
    count: z.number().optional().describe("Nombre de process a retourner (defaut 10)"),
    filter: z.string().optional().describe("Sous-chaine pour filtrer par nom de process"),
  },
  async ({ count = 10, filter }) => {
    const status = await getStatus();
    let all = status._all;
    if (filter) {
      const f = filter.toLowerCase();
      all = all.filter((p) => String(p.Name).toLowerCase().includes(f));
    }
    const sorted = [...all].sort((a, b) => b.MB - a.MB).slice(0, count);
    return {
      content: [
        { type: "text", text: JSON.stringify(sorted.map((p) => ({ name: p.Name, mb: p.MB })), null, 2) },
      ],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
