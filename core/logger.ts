import {
  mkdirSync,
  appendFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
export class Logger extends EventEmitter {
  lines: string[] = [];
  secrets: string[];
  constructor(publicDir: string, options: any = {}, secrets: string[] = []) {
    super();
    this.dir = publicDir;
    this.options = options;
    this.secrets = secrets.filter(Boolean);
    mkdirSync(this.dir, { recursive: true });
    for (const file of readdirSync(this.dir))
      if (
        /^whalelife-\d{4}-\d{2}-\d{2}\.log$/.test(file) &&
        Date.now() - statSync(join(this.dir, file)).mtimeMs >
          (options.keep_days ?? 14) * 86400000
      )
        unlinkSync(join(this.dir, file));
  }
  dir: string;
  options: any;
  log(level: string, message: string, extra?: unknown) {
    if (
      ["debug", "info", "warn", "error"].indexOf(level) <
      ["debug", "info", "warn", "error"].indexOf(this.options.level ?? "info")
    )
      return;
    let line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}${extra === undefined ? "" : " " + JSON.stringify(extra, (_k, v) => (v instanceof Error ? { message: v.message, stack: v.stack } : v))}`;
    for (const secret of this.secrets)
      line = line.replaceAll(secret, "[REDACTED]");
    console.log(line);
    appendFileSync(
      join(this.dir, `whalelife-${new Date().toLocaleDateString("en-CA")}.log`),
      line + "\n",
    );
    this.lines.push(line);
    if (this.lines.length > (this.options.max_web_lines ?? 1000))
      this.lines.shift();
    this.emit("line", line);
  }
  debug(m: string, e?: unknown) {
    this.log("debug", m, e);
  }
  info(m: string, e?: unknown) {
    this.log("info", m, e);
  }
  warn(m: string, e?: unknown) {
    this.log("warn", m, e);
  }
  error(m: string, e?: unknown) {
    this.log("error", m, e);
  }
}
