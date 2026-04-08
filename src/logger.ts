import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const LOG_DIR = join(import.meta.dir, "..", "logs");

try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch {
  // already exists
}

function timestamp(): string {
  return new Date().toISOString();
}

function formatMessage(level: string, tag: string, message: string): string {
  return `${timestamp()} [${level}] [${tag}] ${message}\n`;
}

function writeLog(level: string, tag: string, message: string): void {
  const line = formatMessage(level, tag, message);

  // Always write to stdout
  process.stdout.write(line);

  // Write to daily log file
  const date = new Date().toISOString().slice(0, 10);
  const logFile = join(LOG_DIR, `${date}.log`);
  try {
    appendFileSync(logFile, line);
  } catch {
    // Don't crash on log failure
  }
}

export const log = {
  info(tag: string, message: string): void {
    writeLog("INFO", tag, message);
  },
  warn(tag: string, message: string): void {
    writeLog("WARN", tag, message);
  },
  error(tag: string, message: string): void {
    writeLog("ERROR", tag, message);
  },
};
