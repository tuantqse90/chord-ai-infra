// Minimal pino-shaped logger for the Chord modules: logger.info(obj, msg) / logger.warn(msg). One JSON line per call on
// stderr; debug lines only with LOG_LEVEL=debug.
type Fields = Record<string, unknown>;
const debugOn = () => (process.env.LOG_LEVEL ?? "").toLowerCase() === "debug";
function line(level: string, a: unknown, b?: unknown) {
  if (level === "debug" && !debugOn()) return;
  if (process.env.NODE_ENV === "test" && level !== "error") return;
  const [fields, msg] = typeof a === "string" ? [{}, a] : [(a ?? {}) as Fields, String(b ?? "")];
  console.error(JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }));
}
export const logger = {
  debug: (a: unknown, b?: unknown) => line("debug", a, b),
  info: (a: unknown, b?: unknown) => line("info", a, b),
  warn: (a: unknown, b?: unknown) => line("warn", a, b),
  error: (a: unknown, b?: unknown) => line("error", a, b),
  child: () => logger,
};
