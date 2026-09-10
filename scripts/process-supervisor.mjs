import { spawn } from "node:child_process";

function exitEvent(child, name) {
  return new Promise((resolve) => {
    child.once("error", (error) => resolve({ name, code: 1, error }));
    child.once("exit", (code, signal) => resolve({ name, code, signal }));
  });
}

async function stopChildren(children, signal, timeoutMs) {
  const running = children.filter(({ child }) => child.exitCode === null && child.signalCode === null);
  for (const { child } of running) child.kill(signal);
  if (!running.length) return;

  const settled = Promise.all(running.map(({ exited }) => exited));
  const timedOut = await Promise.race([
    settled.then(() => false),
    new Promise((resolve) => setTimeout(() => resolve(true), timeoutMs))
  ]);
  if (timedOut) {
    for (const { child } of running) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await settled;
  }
}

export async function supervise(processes, { cwd, environment = process.env, shutdownTimeoutMs = 15000, logger = console } = {}) {
  const children = processes.map(({ name, command, args = [] }) => {
    // Separate process groups ensure a terminal signal reaches the supervisor
    // once; it can then forward exactly one matching signal to each child.
    const child = spawn(command, args, { cwd, env: environment, stdio: "inherit", detached: process.platform !== "win32" });
    return { name, child, exited: exitEvent(child, name) };
  });

  let requestedSignal;
  let resolveSignal;
  const signalRequested = new Promise((resolve) => { resolveSignal = resolve; });
  const handlers = {};
  for (const signal of ["SIGINT", "SIGTERM"]) {
    handlers[signal] = () => {
      if (!requestedSignal) {
        requestedSignal = signal;
        resolveSignal({ requestedSignal: signal });
      }
    };
    process.once(signal, handlers[signal]);
  }

  const first = await Promise.race([...children.map(({ exited }) => exited), signalRequested]);
  const signal = first.requestedSignal || "SIGTERM";
  if (!first.requestedSignal) {
    const reason = first.error?.message || (first.signal ? `signal ${first.signal}` : `exit code ${first.code ?? "unknown"}`);
    logger.error(`${first.name} exited unexpectedly (${reason}); stopping all services.`);
  }
  await stopChildren(children, signal, shutdownTimeoutMs);
  for (const registeredSignal of Object.keys(handlers)) process.removeListener(registeredSignal, handlers[registeredSignal]);
  return first.requestedSignal ? 0 : 1;
}
