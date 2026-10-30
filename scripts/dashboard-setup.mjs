import {
  readFileSync,
  writeFileSync,
  statSync,
  existsSync,
  renameSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import { join } from "node:path";
import process from "node:process";
import { parse } from "dotenv";
const root = fileURLToPath(new URL("../", import.meta.url));
try {
  const sourcePath = join(root, ".env.local"),
    localPath = join(root, ".env.dashboard.local");
  if ((statSync(sourcePath).mode & 0o077) !== 0) throw new Error();
  const source = parse(readFileSync(sourcePath)),
    url = new URL(source.DATABASE_URL);
  if (
    url.pathname !== "/security_events" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(url.hostname) ||
    (url.port && url.port !== "5432")
  )
    throw new Error();
  const inspected = spawnSync(
    "docker",
    [
      "inspect",
      "--format",
      '{"name":{{json .Name}},"networks":{{json .NetworkSettings.Networks}}}',
      source.DEV_DATABASE_CONTAINER || url.hostname,
    ],
    { encoding: "utf8", timeout: 3000 },
  );
  if (inspected.status !== 0) throw new Error();
  const container = JSON.parse(inspected.stdout),
    network = source.DEV_DATABASE_NETWORK ? container.networks?.[source.DEV_DATABASE_NETWORK] : Object.values(container.networks ?? {}).find(n => [...(n.Aliases ?? []), ...(n.DNSNames ?? []), container.name?.replace(/^\//, "")].includes(url.hostname));
  if (
    !network ||
    ![
      container.name?.replace(/^\//, ""),
      ...(network.Aliases ?? []),
      ...(network.DNSNames ?? []),
    ].includes(url.hostname) ||
    !/^\d+\.\d+\.\d+\.\d+$/.test(network.IPAddress)
  )
    throw new Error();
  let local = {};
  if (existsSync(localPath)) {
    if ((statSync(localPath).mode & 0o077) !== 0) throw new Error();
    local = parse(readFileSync(localPath));
  }
  const values = {
    DEV_DATABASE_HOST: network.IPAddress,
    DEV_LAN_IP: local.DEV_LAN_IP ?? source.DEV_LAN_IP ?? "",
    DASHBOARD_ORIGIN: local.DASHBOARD_ORIGIN ?? "http://127.0.0.1:5173",
    DASHBOARD_PASSWORD:
      local.DASHBOARD_PASSWORD ?? randomBytes(24).toString("hex"),
    DASHBOARD_SESSION_KEY:
      local.DASHBOARD_SESSION_KEY ?? randomBytes(32).toString("hex"),
  };
  const temporary = localPath + ".tmp";
  writeFileSync(
    temporary,
    Object.entries(values)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}\n`)
      .join(""),
    { mode: 0o600, flag: "wx" },
  );
  renameSync(temporary, localPath);
  process.stdout.write(
    "Prepared protected .env.dashboard.local; existing production environment unchanged.\nOpen that file in your editor for the dashboard password. No database ports were published.\n",
  );
} catch {
  process.stderr.write(
    "Development setup stopped: verify protected .env.local, its database target and Docker inspection permissions. No production changes made.\n",
  );
  process.exitCode = 1;
}
