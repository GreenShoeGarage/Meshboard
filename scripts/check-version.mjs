import fs from "node:fs";
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const models = fs.readFileSync(new URL("../src/models.ts", import.meta.url), "utf8");
const sw = fs.readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const appVersion = models.match(/APP_VERSION\s*=\s*"([^"]+)"/)?.[1];
const swVersion = sw.match(/meshboard-v([^";]+)/)?.[1];
if (!appVersion || appVersion !== pkg.version) throw new Error(`Version mismatch: package=${pkg.version}, app=${appVersion}`);
if (!swVersion || swVersion !== pkg.version) throw new Error(`Version mismatch: package=${pkg.version}, service-worker=${swVersion}`);
console.log(`Version check OK: ${pkg.version}`);
