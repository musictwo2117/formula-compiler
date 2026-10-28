/** Prints the README function-support table from the registry: npx tsx scripts/function-table.ts */
import { registry } from "../src/index";

const cell = (d: "airtable" | "sheets" | "excel", name: string) => {
  const r = registry.lookup(d, name);
  return r.status === "ok" ? "✅" : r.status === "unsupported" ? "⏳" : "—";
};
console.log("| Function | Airtable | Google Sheets | Excel |");
console.log("| --- | :-: | :-: | :-: |");
for (const { name } of registry.matrix()) console.log(`| \`${name}\` | ${cell("airtable", name)} | ${cell("sheets", name)} | ${cell("excel", name)} |`);
