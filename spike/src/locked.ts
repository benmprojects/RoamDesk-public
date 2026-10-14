// Phase 0 · Test 3 — does the agent still work while Windows is LOCKED (Win+L)?
// Usage: npm run locked            (waits 90 s, then runs)
//        npm run locked -- 120     (custom delay in seconds)
// Start it, press Win+L straight away, wait ~3 minutes, unlock, then read results/locked.json.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { runTurn } from "./agent.js";

const delay = Number(process.argv[2] ?? 90);
console.log(`Lock the PC now (Win+L). Test runs in ${delay} s; leave it locked for at least ${delay + 90} s.`);
await new Promise((r) => setTimeout(r, delay * 1000));

const ps = (script: string) => {
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", timeout: 30000 }).trim();
  } catch (e: any) {
    return `ERROR: ${e.message?.split("\n")[0]}`;
  }
};

// Is the session actually locked? LogonUI runs while the lock screen is showing.
const lockedAtRun = ps("[bool](Get-Process LogonUI -ErrorAction SilentlyContinue)");

// GUI capability check: screen capture while locked (expected to fail or be black).
const screenshot = ps(`
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$p = $bmp.GetPixel([int]($b.Width/2), [int]($b.Height/2))
$bmp.Save("$PWD\\results\\locked-screenshot.png")
"captured; centre pixel = $($p.R),$($p.G),$($p.B)"
`);

const t0 = Date.now();
const agent = await runTurn("List the five most recently modified files in my Documents folder, by name only.");
const result = {
  ranAt: new Date().toISOString(),
  sessionLockedAtRun: lockedAtRun,
  screenshot,
  agent: { ok: !agent.isError && agent.tools.length > 0, reply: agent.text, tools: agent.tools, ms: Date.now() - t0, costUsd: agent.costUsd },
};
writeFileSync("results/locked.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
