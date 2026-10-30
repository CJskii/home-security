import { createServer } from "node:net";
import { setTimeout } from "node:timers";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isIPv4 } from "node:net";
import { parse } from "dotenv";
import { fileURLToPath, URL } from "node:url";
import { join } from "node:path";
import process from "node:process";
const root = fileURLToPath(new URL("../", import.meta.url));
const settings = existsSync(join(root, ".env.dashboard.local")) ? parse(readFileSync(join(root, ".env.dashboard.local"))) : {};
const lanIp = settings.DEV_LAN_IP;
if (process.argv.includes("--lan") && (!lanIp || !isIPv4(lanIp))) throw new Error("Set DEV_LAN_IP in .env.dashboard.local before LAN development");
if (!existsSync(join(root, ".env.dashboard.local"))) {
  process.stderr.write("Run npm run dev:setup first.\n");
  process.exitCode = 1;
} else if (await portsAvailable(process.argv.includes("--lan"))) {
  const lan = process.argv.includes("--lan"),
    env = { ...process.env, DASHBOARD_DEV_LAN: String(lan), DEV_LAN_IP: lanIp ?? "" };
  const children = [],
    stop = () => {
      for (const child of children)
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            /* Already stopped. */
          }
        }
      const timer = setTimeout(() => {
        for (const child of children)
          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              /* Already stopped. */
            }
          }
      }, 5000);
      timer.unref();
    };
  let stopping = false;
  function finish(code) {
    if (!stopping) {
      stopping = true;
      process.exitCode = code;
      stop();
    }
  }
  const commands = [
    { cwd: root, args: ["--import", "tsx", "src/dashboard/development.ts"] },
    {
      cwd: join(root, "web"),
      args: lan
        ? ["scripts/dev-lan.mjs"]
        : ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1"],
    },
  ];
  for (const command of commands) {
    const child = spawn(process.execPath, command.args, {
      cwd: command.cwd,
      env,
      stdio: "inherit",
      detached: true,
    });
    children.push(child);
    child.on("error", () => finish(1));
    child.on("exit", (code) => finish(code ?? 1));
  }
  process.once("SIGINT", () => finish(0));
  process.once("SIGTERM", () => finish(0));
}

// Keep the fixed ports/origin; never silently switch ports or stop an unknown owner.
async function portsAvailable(lan) {
  for (const [host, port] of [["127.0.0.1", 3001], [lan ? lanIp : "127.0.0.1", 5173]]) {
    const available = await new Promise((resolve) => {
      const probe = createServer();
      probe.once("error", () => resolve(false));
      probe.listen({ host, port, exclusive: true }, () => probe.close(() => resolve(true)));
    });
    if (!available) {
      process.stderr.write(`Cannot start dashboard development: ${host}:${port} is occupied or unavailable.\nStop the previous dashboard command with Ctrl+C, then retry.\nIdentify the listener with: ss -ltnp 'sport = :${port}'\nNo development services were started; no existing processes were stopped.\n`);
      process.exitCode = 1;
      return false;
    }
  }
  return true;
}
