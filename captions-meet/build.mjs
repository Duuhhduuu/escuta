// Junta cada ponto de entrada em um arquivo só (sem módulos em tempo de execução) e deixa tudo em dist/.
import { build, context } from "esbuild";

const common = { bundle: true, format: "iife", target: "chrome111", sourcemap: false, logLevel: "info", legalComments: "none" };
const entries = [
  { entryPoints: ["src/page/main.ts"], outfile: "dist/page.js" },
  { entryPoints: ["src/content/bridge.ts"], outfile: "dist/content.js" },
  { entryPoints: ["src/popup.ts"], outfile: "dist/popup.js" },
];

if (process.argv.includes("--watch")) {
  for (const e of entries) await (await context({ ...common, ...e })).watch();
} else {
  await Promise.all(entries.map((e) => build({ ...common, ...e })));
}
