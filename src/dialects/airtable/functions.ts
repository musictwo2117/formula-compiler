/**
 * Airtable function table. JS calls the helpers in src/runtime/airtable.ts;
 * SQL mirrors them. The behaviour was checked against a real Airtable base
 * (see docs/behavior-notes.md).
 */
import { registry } from "../../core/registry";
import { quoteText, sqlFloat, type SqlGen, type SqlVal } from "../../codegen/sql";
import { DATE_FUNCTIONS, definer, lazyArgsJs, numericSql, sqlArgs, substituteNthSql } from "../shared";
import { airtableValue } from "../../runtime/common";
import { switchJs } from "../spreadsheet-functions";

const def = definer("airtable");
const ERR = "#ERROR!";

/** Text argument of a text function: numbers and booleans are #ERROR! in Airtable. */
function textArg(g: SqlGen, x: SqlVal): SqlVal {
  const p = g.dispatch(x, (a) => {
    if (a.k === "text") return { v: a.e, err: null };
    if (a.k === "blank") return { v: "''", err: null };
    return { v: "NULL::text", err: quoteText(ERR) };
  });
  return g.make("text", p.v, [x.err, p.err]);
}

const pow10 = (d: string) => `power(10::float8, ${d})`;
/** Math.round(v): ties toward +infinity. */
const jsRound = (v: string) => `CASE WHEN ${v} - floor(${v}) >= 0.5 THEN ceil(${v}) ELSE floor(${v}) END`;
/** Clamp an index to [0, len] the way String.prototype.substring does. */
const clampIndex = (x: string, len: string) => `LEAST(GREATEST(CASE WHEN ${x} = 'NaN'::float8 THEN 0 ELSE trunc(${x}) END, 0), ${len})::int`;

def({
  name: "IF",
  minArgs: 2,
  maxArgs: 3,
  summary: "IF(condition, value_if_true, [value_if_false])",
  notes: "Without value_if_false the result is blank.",
  js: (c, g) => lazyArgsJs(c, g, [0]),
  sql: (c, g) => {
    const [cond, then, otherwise] = c.args;
    return g.chain([{ cond: g.toBool(g.expr(cond!)), then: g.expr(then!) }], otherwise ? g.expr(otherwise) : g.blank());
  },
});

def({
  name: "SWITCH",
  minArgs: 3,
  maxArgs: Infinity,
  summary: "SWITCH(expression, pattern, result, ..., [default])",
  notes: "No match and no default gives blank.",
  js: switchJs,
  sql: (c, g) => {
    const [e, ...rest] = sqlArgs(c, g);
    const arms: { cond: SqlVal; then: SqlVal }[] = [];
    let i = 0;
    for (; i + 1 < rest.length; i += 2) arms.push({ cond: g.compare("=", e!, rest[i]!), then: rest[i + 1]! });
    return g.chain(arms, i < rest.length ? rest[i]! : g.blank());
  },
});

for (const [name, joiner] of [["AND", "AND"], ["OR", "OR"]] as const) {
  def({
    name,
    minArgs: 1,
    maxArgs: Infinity,
    summary: `${name}(logical1, ...)`,
    sql: (c, g) => {
      const bs = sqlArgs(c, g).map((a) => g.toBool(a));
      return g.make("boolean", `(${bs.map((b) => b.v).join(` ${joiner} `)})`, bs.map((b) => b.err));
    },
  });
}

def({
  name: "NOT",
  minArgs: 1,
  maxArgs: 1,
  summary: "NOT(logical)",
  sql: (c, g) => {
    const b = g.toBool(g.expr(c.args[0]!));
    return g.make("boolean", `(NOT ${b.v})`, [b.err]);
  },
});

def({ name: "TRUE", minArgs: 0, maxArgs: 0, summary: "TRUE()", sql: (_, g) => g.boolean(true) });
def({ name: "FALSE", minArgs: 0, maxArgs: 0, summary: "FALSE()", sql: (_, g) => g.boolean(false) });
def({ name: "BLANK", minArgs: 0, maxArgs: 0, summary: "BLANK()", sql: (_, g) => g.blank() });
def({ name: "ERROR", minArgs: 0, maxArgs: 0, summary: "ERROR()", sql: (_, g) => g.error(ERR) });

def({
  name: "ISERROR",
  minArgs: 1,
  maxArgs: 1,
  summary: "ISERROR(expression) — 1 for errors and for Infinity / NaN, else 0",
  sql: (c, g) => {
    const x = g.expr(c.args[0]!);
    const special = g.dispatch(x, (a) => ({ v: a.k === "number" ? `(${a.e} IN ('Infinity'::float8, '-Infinity'::float8, 'NaN'::float8))` : "FALSE", err: null })).v;
    const cond = x.err === null ? special : `(${x.err} IS NOT NULL OR ${special})`;
    return g.make("number", cond === "FALSE" ? "0::float8" : `CASE WHEN ${cond} THEN 1::float8 ELSE 0::float8 END`, []);
  },
});

def({
  name: "T",
  minArgs: 1,
  maxArgs: 1,
  summary: "T(value) — the value if it is text, otherwise blank",
  sql: (c, g) => {
    const x = g.expr(c.args[0]!);
    const p = g.dispatch(x, (a) => ({ v: a.k === "text" ? a.e : "NULL::text", err: null }));
    return g.make("text", p.v, [x.err], true);
  },
});

// ---------------------------------------------------------------- numbers

def({
  name: "ROUND",
  minArgs: 2,
  maxArgs: 2,
  summary: "ROUND(value, precision)",
  notes: "Math.round(value × 10^precision) / 10^precision on doubles: ROUND(1.005, 2) = 1, ties toward +infinity.",
  sql: (c, g) => numericSql(g, sqlArgs(c, g), (x, d) => `(${jsRound(`(${x} * ${pow10(d)})`)} / ${pow10(d)})`),
});
for (const [name, fn, note] of [["ROUNDUP", "ceil", "away from zero"], ["ROUNDDOWN", "floor", "toward zero"]] as const) {
  def({
    name,
    minArgs: 2,
    maxArgs: 2,
    summary: `${name}(value, precision)`,
    notes: `${note}, on doubles: ROUNDUP(0.1 + 0.2, 1) = 0.4`,
    sql: (c, g) => numericSql(g, sqlArgs(c, g), (x, d) => `(sign(${x}) * ${fn}(abs(${x}) * ${pow10(d)}) / ${pow10(d)} + 0::float8)`),
  });
}

def({ name: "ABS", minArgs: 1, maxArgs: 1, summary: "ABS(value)", sql: (c, g) => numericSql(g, sqlArgs(c, g), (x) => `abs(${x})`) });
def({ name: "INT", minArgs: 1, maxArgs: 1, summary: "INT(value) — round down to an integer", sql: (c, g) => numericSql(g, sqlArgs(c, g), (x) => `floor(${x})`) });
def({
  name: "MOD",
  minArgs: 2,
  maxArgs: 2,
  summary: "MOD(value, divisor)",
  notes: "|value| mod |divisor| with the sign of the divisor: MOD(-7, 3) = 1, MOD(7, -3) = -1.",
  sql: (c, g) =>
    numericSql(g, sqlArgs(c, g), (a, b) => `CASE WHEN ${b} = 0 THEN 'NaN'::float8 ELSE sign(${b}) * (abs(${a}) - abs(${b}) * trunc(abs(${a}) / abs(${b}))) + 0::float8 END`),
});

def({
  name: "SUM",
  minArgs: 1,
  maxArgs: Infinity,
  summary: "SUM(number1, ...) — blanks count as 0, numeric text counts, other text is skipped",
  sql: (c, g) => {
    const parts = sqlArgs(c, g).map((x) => {
      const p = g.dispatch(x, (a) => {
        if (a.k !== "text") return g.sem.toNumber(a);
        const n = g.sem.toNumber(a).v;
        return { v: `CASE WHEN ${n} = 'NaN'::float8 THEN 0::float8 ELSE ${n} END`, err: null };
      });
      return g.make("number", p.v, [x.err]);
    });
    return g.make("number", `(${parts.map((p) => p.v).join(" + ")})`, parts.map((p) => p.err));
  },
});

/** Numbers taken by AVERAGE / MIN / MAX: blanks and text are skipped (NULL). */
function countedNumbers(c: Parameters<typeof sqlArgs>[0], g: SqlGen): SqlVal[] {
  return sqlArgs(c, g).map((x) => {
    const p = g.dispatch(x, (a) => (a.k === "number" || a.k === "boolean" ? g.sem.toNumber(a) : { v: "NULL::float8", err: null }));
    return g.make("number", p.v, [x.err], true);
  });
}

def({
  name: "AVERAGE",
  minArgs: 1,
  maxArgs: Infinity,
  summary: "AVERAGE(number1, ...) — blanks and text are skipped",
  sql: (c, g) => {
    const ns = countedNumbers(c, g);
    const sum = ns.map((n) => `COALESCE(${n.v}, 0::float8)`).join(" + ");
    const count = ns.map((n) => `CASE WHEN ${n.v} IS NULL THEN 0 ELSE 1 END`).join(" + ");
    return g.make("number", `CASE WHEN (${count}) = 0 THEN 'NaN'::float8 ELSE (${sum}) / (${count}) END`, ns.map((n) => n.err));
  },
});
for (const [name, fn, empty] of [["MIN", "LEAST", Infinity], ["MAX", "GREATEST", -Infinity]] as const) {
  def({
    name,
    minArgs: 1,
    maxArgs: Infinity,
    summary: `${name}(number1, ...) — blanks and text are skipped`,
    sql: (c, g) => {
      const ns = countedNumbers(c, g);
      return g.make("number", `COALESCE(${fn}(${ns.map((n) => n.v).join(", ")}), ${sqlFloat(empty)})`, ns.map((n) => n.err));
    },
  });
}

def({
  name: "VALUE",
  minArgs: 1,
  maxArgs: 1,
  summary: "VALUE(text) — keeps digits and \".\"; \"-\" makes it negative, \"%\" divides by 100",
  sql: (c, g) => {
    const x = g.expr(c.args[0]!);
    const p = g.dispatch(x, (a) => {
      if (a.k !== "text") return g.sem.toNumber(a);
      if (typeof a.lit === "string") return { v: sqlFloat(airtableValue(a.lit)), err: null };
      const digits = `regexp_replace(${a.e}, '[^0-9.]', '', 'g')`;
      const n = `CASE WHEN ${digits} = '' THEN 0::float8 WHEN ${digits} ~ '^[0-9]*\\.?[0-9]*$' AND ${digits} <> '.' THEN (${digits})::float8 ELSE 'NaN'::float8 END`;
      return { v: `(${n} * CASE WHEN strpos(${a.e}, '-') > 0 THEN -1 ELSE 1 END / CASE WHEN strpos(${a.e}, '%') > 0 THEN 100 ELSE 1 END)`, err: null };
    });
    return g.make("number", p.v, [x.err, p.err]);
  },
});

// ---------------------------------------------------------------- text

const TEXT_NOTE = "Numbers and booleans as the text argument are #ERROR! (use & \"\" to convert).";

for (const [name, fn] of [["UPPER", "upper"], ["LOWER", "lower"]] as const) {
  def({ name, minArgs: 1, maxArgs: 1, summary: `${name}(string)`, notes: TEXT_NOTE, sql: (c, g) => { const t = textArg(g, g.expr(c.args[0]!)); return g.make("text", `${fn}(${t.v})`, [t.err]); } });
}
def({
  name: "LEN",
  minArgs: 1,
  maxArgs: 1,
  summary: "LEN(string) — counts characters (an emoji is 1)",
  notes: TEXT_NOTE,
  sql: (c, g) => { const t = textArg(g, g.expr(c.args[0]!)); return g.make("number", `length(${t.v})::float8`, [t.err]); },
});
def({
  name: "TRIM",
  minArgs: 1,
  maxArgs: 1,
  summary: "TRIM(string) — remove leading and trailing whitespace",
  notes: "Inner runs of spaces are kept (unlike Sheets/Excel).",
  sql: (c, g) => {
    const t = textArg(g, g.expr(c.args[0]!));
    return g.make("text", `regexp_replace(${t.v}, ${quoteText("^[ \\t\\n\\r\\f\\v]+|[ \\t\\n\\r\\f\\v]+$")}, '', 'g')`, [t.err]);
  },
});
def({
  name: "CONCATENATE",
  minArgs: 1,
  maxArgs: Infinity,
  summary: "CONCATENATE(text1, ...) — converts numbers and booleans",
  sql: (c, g) => {
    const ts = sqlArgs(c, g).map((a) => g.toText(a));
    return g.make("text", `(${ts.map((t) => t.v).join(" || ")})`, ts.map((t) => t.err));
  },
});

def({
  name: "LEFT",
  minArgs: 2,
  maxArgs: 2,
  summary: "LEFT(string, howMany)",
  notes: TEXT_NOTE,
  sql: (c, g) => {
    const [s, n] = sqlArgs(c, g);
    const k = g.toNumber(n!);
    const t = textArg(g, s!);
    return g.make("text", `left(${t.v}, ${clampIndex(k.v, `length(${t.v})`)})`, [k.err, t.err]);
  },
});
def({
  name: "RIGHT",
  minArgs: 2,
  maxArgs: 2,
  summary: "RIGHT(string, howMany) — \"\" when howMany is longer than the string",
  notes: TEXT_NOTE,
  sql: (c, g) => {
    const [s, n] = sqlArgs(c, g);
    const k = g.toNumber(n!);
    const t = textArg(g, s!);
    const start = `(length(${t.v}) - ${k.v})`;
    return g.make("text", `CASE WHEN ${start} < 0 THEN '' ELSE substr(${t.v}, ${clampIndex(start, `length(${t.v})`)} + 1) END`, [k.err, t.err]);
  },
});
def({
  name: "MID",
  minArgs: 3,
  maxArgs: 3,
  summary: "MID(string, whereToStart, count) — 1-based; \"\" when whereToStart < 1",
  notes: TEXT_NOTE,
  sql: (c, g) => {
    const [s, st, n] = sqlArgs(c, g);
    const start = g.toNumber(st!);
    const k = g.toNumber(n!);
    const t = textArg(g, s!);
    return g.make("text", `CASE WHEN trunc(${start.v}) < 1 THEN '' ELSE substr(${t.v}, ${g.int(start, 1)}, ${g.int(k, 0)}) END`, [start.err, k.err, t.err]);
  },
});

for (const name of ["FIND", "SEARCH"] as const) {
  def({
    name,
    minArgs: 2,
    maxArgs: 3,
    summary: `${name}(stringToFind, whereToSearch, [startFromPosition])`,
    notes:
      name === "FIND"
        ? "Case-sensitive; startFromPosition is 1-based; 0 when not found."
        : "Same as FIND (case-sensitive, 0 inside expressions); a not-found SEARCH shown as the whole result is empty.",
    sql: (c, g) => {
      const [n, h, st] = sqlArgs(c, g);
      const start = st ? g.toNumber(st) : g.number(1);
      const s0 = `(${g.int(start, 1)} - 1)`;
      const [needle, hay] = [textArg(g, n!), textArg(g, h!)];
      const v = `CASE WHEN ${s0} > length(${hay.v}) THEN 0::float8 ELSE COALESCE((NULLIF(strpos(substr(${hay.v}, ${s0} + 1), ${needle.v}), 0) + ${s0})::float8, 0::float8) END`;
      return g.make("number", v, [start.err, needle.err, hay.err]);
    },
  });
}

def({
  name: "SUBSTITUTE",
  minArgs: 3,
  maxArgs: 4,
  summary: "SUBSTITUTE(string, old_text, new_text, [index]) — index <= 0 changes nothing",
  notes: TEXT_NOTE,
  sql: (c, g) => {
    const [s, o, n, idx] = sqlArgs(c, g);
    const i = idx ? g.toNumber(idx) : null;
    const ts = [textArg(g, s!), textArg(g, o!), textArg(g, n!)];
    const [t, old, rep] = ts.map((x) => x.v) as [string, string, string];
    if (!i) return g.make("text", `CASE WHEN ${old} = '' THEN ${t} ELSE replace(${t}, ${old}, ${rep}) END`, ts.map((x) => x.err));
    const iv = g.int(i);
    return g.make("text", `CASE WHEN ${iv} < 1 THEN ${t} ELSE ${substituteNthSql(t, old, rep, iv)} END`, [i.err, ...ts.map((x) => x.err)]);
  },
});

def({
  name: "REPLACE",
  minArgs: 4,
  maxArgs: 4,
  summary: "REPLACE(string, start_character, number_of_characters, replacement)",
  notes: "Works like string.substring(0, start - 1) + replacement + string.substring(start - 1 + count).",
  sql: (c, g) => {
    const [s, st, n, r] = sqlArgs(c, g);
    const start = g.toNumber(st!);
    const k = g.toNumber(n!);
    const [t, rep] = [textArg(g, s!), textArg(g, r!)];
    const len = `length(${t.v})`;
    const a = clampIndex(`(${start.v} - 1)`, len);
    const b = clampIndex(`(${start.v} - 1 + ${k.v})`, len);
    return g.make("text", `(left(${t.v}, ${a}) || ${rep.v} || substr(${t.v}, ${b} + 1))`, [start.err, k.err, t.err, rep.err]);
  },
});

registry.markUnsupported("airtable", DATE_FUNCTIONS.concat([
  "DATEADD", "DATETIME_DIFF", "DATETIME_FORMAT", "DATETIME_PARSE", "DATESTR", "TIMESTR", "IS_BEFORE", "IS_AFTER",
  "IS_SAME", "WORKDAY_DIFF", "TONOW", "FROMNOW", "SET_LOCALE", "SET_TIMEZONE", "CREATED_TIME", "LAST_MODIFIED_TIME",
]), "date and time functions are planned");
registry.markUnsupported("airtable", [
  "ARRAYJOIN", "ARRAYUNIQUE", "ARRAYCOMPACT", "ARRAYFLATTEN", "ARRAYSLICE", "COUNTALL", "COUNTA", "COUNT",
], "array/rollup functions are planned");
registry.markUnsupported("airtable", [
  "POWER", "SQRT", "EXP", "LOG", "CEILING", "FLOOR", "EVEN", "ODD", "XOR", "REPT", "ENCODE_URL_COMPONENT",
  "REGEX_MATCH", "REGEX_EXTRACT", "REGEX_REPLACE", "RECORD_ID",
], "not implemented yet");
