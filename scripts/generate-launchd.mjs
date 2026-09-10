import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const WEB_LABEL = "com.printer-fleet-monitor.web";
export const COLLECTOR_LABEL = "com.printer-fleet-monitor.collector";

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export function renderLaunchAgent({ label, projectRoot, nodePath, arguments: serviceArguments, stdoutPath, stderrPath, pathValue }) {
  const args = [nodePath, ...serviceArguments].map((value) => `      <string>${xml(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(projectRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DOTENV_CONFIG_PATH</key>
    <string>${xml(join(projectRoot, ".env"))}</string>
    <key>PATH</key>
    <string>${xml(pathValue)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(stderrPath)}</string>
</dict>
</plist>
`;
}

export async function generateLaunchAgents({ projectRoot, nodePath, outputDirectory }) {
  const logDirectory = join(projectRoot, "data/log");
  const nodeDirectory = dirname(nodePath);
  const pathValue = [nodeDirectory, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].filter((value, index, values) => values.indexOf(value) === index).join(":");
  const definitions = [
    {
      label: WEB_LABEL,
      arguments: [join(projectRoot, "apps/api/dist/server.js")],
      stdoutPath: join(logDirectory, "web.stdout.log"),
      stderrPath: join(logDirectory, "web.stderr.log")
    },
    {
      label: COLLECTOR_LABEL,
      arguments: [join(projectRoot, "packages/collector/dist/cli.js"), "--watch"],
      stdoutPath: join(logDirectory, "collector.stdout.log"),
      stderrPath: join(logDirectory, "collector.stderr.log")
    }
  ];
  await mkdir(outputDirectory, { recursive: true });
  for (const definition of definitions) {
    const content = renderLaunchAgent({ ...definition, projectRoot, nodePath, pathValue });
    await writeFile(join(outputDirectory, `${definition.label}.plist`), content, { encoding: "utf8", mode: 0o644 });
  }
  return definitions.map(({ label }) => join(outputDirectory, `${label}.plist`));
}

async function main() {
  const [projectRoot, nodePath, outputDirectory] = process.argv.slice(2);
  if (!projectRoot || !nodePath || !outputDirectory) {
    console.error(`Usage: node ${basename(fileURLToPath(import.meta.url))} <project-root> <node-path> <output-directory>`);
    process.exitCode = 2;
    return;
  }
  await generateLaunchAgents({ projectRoot: resolve(projectRoot), nodePath: resolve(nodePath), outputDirectory: resolve(outputDirectory) });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
