import { spawn } from "node:child_process";

const [electronExecutable, electronMain] = process.argv.slice(2);
if (!electronExecutable || !electronMain) process.exit(64);

let launched = false;
let bufferedInput = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  bufferedInput += chunk;
  while (bufferedInput.includes("\n")) {
    const newline = bufferedInput.indexOf("\n");
    const command = bufferedInput.slice(0, newline).trim();
    bufferedInput = bufferedInput.slice(newline + 1);
    if (command === "abort" && !launched) process.exit(0);
    if (command !== "launch" || launched) continue;
    launched = true;
    const child = spawn(electronExecutable, [electronMain], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => process.exit(126));
    child.once("spawn", () => process.stdout.write(`spawned:${child.pid}\n`));
    child.once("exit", (exitCode, signalCode) => {
      const normalizedExitCode = typeof exitCode === "number" ? exitCode : signalCode ? 1 : 0;
      setTimeout(() => process.exit(normalizedExitCode), 500);
    });
  }
});
process.stdin.on("end", () => {
  if (!launched) process.exit(0);
});
process.stdout.write("ready\n");
