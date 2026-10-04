import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { terminateChild } from "./terminate";

test("a child that ignores SIGTERM is killed with SIGKILL after the grace period", async () => {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], {
    stdio: "ignore",
  });
  // Give the child time to install its SIGTERM handler before we signal it.
  await new Promise((resolve) => setTimeout(resolve, 150));
  terminateChild(child, 200);
  const signal = await new Promise<NodeJS.Signals | null>((resolve) => child.once("exit", (_code, sig) => resolve(sig)));
  assert.equal(signal, "SIGKILL");
});

test("a child that exits on SIGTERM gets no SIGKILL", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
  await new Promise((resolve) => setTimeout(resolve, 150));
  terminateChild(child, 200);
  const signal = await new Promise<NodeJS.Signals | null>((resolve) => child.once("exit", (_code, sig) => resolve(sig)));
  assert.equal(signal, "SIGTERM");
});
