import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const windowsVenv = resolve(".venv", "Scripts", "python.exe");
const posixVenv = resolve(".venv", "bin", "python");
const python = process.env.PYTHON || (existsSync(windowsVenv) ? windowsVenv : existsSync(posixVenv) ? posixVenv : "python");
const child = spawn(python, [resolve("scripts", "train_rug_model.py"), ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, PYTHONIOENCODING: process.env.PYTHONIOENCODING || "utf-8" }
});

child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});

child.on("error", (error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
