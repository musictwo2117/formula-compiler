/**
 * Airtable function table. JS calls the helpers in src/runtime/airtable.ts;
 * SQL mirrors them. Behaviour that is not confirmed against Airtable is
 * listed in docs/behavior-notes.md.
 */
import { registry } from "../../core/registry";
import { errorIf, quoteText, type SqlVal } from "../../codegen/sql";
import {
  DATE_FUNCTIONS,
  definer,
  lazyArgsJs,
  numericSql,
  roundDigits,
  roundSql,
  sqlArgs,
  substituteNthSql,
  textSql,
} from "../shared";
import { NUMERIC_TEXT, NUMERIC_TEXT_SQL, STRIP_CURRENCY_SQL, stripCurrency, type RoundMode } from "../../runtime/common";

const def = definer("airtable");
const ERR = "#ERROR!";

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
  js: (c, g) => g.call("SWITCH", c.args.map((a, i) => (i === 0 || i % 2 === 1) && !(i === c.args.length - 1 && i % 2 === 1) ? g.expr(a) : g.lazy(a))),
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
  summary: "ISERROR(expression)",
  sql: (c, g) => {
    const x = g.expr(c.args[0]!);
    return g.make("boolean", x.err === null ? "FALSE" : `(${x.err} IS NOT NULL)`, []);
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

const ROUNDS: [string, RoundMode, string][] = [
  ["ROUND", "halfUp", "ties round toward +infinity (ROUND(-2.5, 0) = -2)"],
  ["ROUNDUP", "up", "away from zero"],
  ["ROUNDDOWN", "down", "toward zero"],
];
for (const [name, mode, note] of ROUNDS) {
  def({
    name,
    minArgs: 2,
    maxArgs: 2,
    summary: `${name}(value, precision)`,
    notes: note,
    sql: (c, g) => {
      const [x, d] = sqlArgs(c, g).map((a) => g.toNumber(a));
      return g.make("number", roundSql(mode, x!.v, roundDigits(g, d!)), [x!.err, d!.err]);
    },
  });
}

def({ name: "ABS", minArgs: 1, maxArgs: 1, summary: "ABS(value)", sql: (c, g) => numericSql(g, sqlArgs(c, g), (x) => `abs(${x})`) });
def({ name: "INT", minArgs: 1, maxArgs: 1, summary: "INT(value) — round down to an integer", sql: (c, g) => numericSql(g, sqlArgs(c, g), (x) => `floor(${x})`) });
def({
  name: "MOD",
  minArgs: 2,
  maxArgs: 2,
  summary: "MOD(value, divisor)",
  notes: "Result takes the sign of the dividend (unverified, see behavior notes).",
  sql: (c, g) =>
    numericSql(g, sqlArgs(c, g), (a, b) => `(${a} - ${b} * trunc(${a} / NULLIF(${b}, 0)))`, (_, b) => errorIf(`${b} = 0`, ERR)),
});

def({ name: "SUM", minArgs: 1, maxArgs: Infinity, summary: "SUM(number1, ...)", sql: (c, g) => numericSql(g, sqlArgs(c, g), (...xs) => `(${xs.join(" + ")})`) });
def({
  name: "AVERAGE",
  minArgs: 1,
  maxArgs: Infinity,
  summary: "AVERAGE(number1, ...)",
  sql: (c, g) => numericSql(g, sqlArgs(c, g), (...xs) => `((${xs.join(" + ")}) / ${xs.length})`),
});
def({ name: "MIN", minArgs: 1, maxArgs: Infinity, summary: "MIN(number1, ...)", sql: (c, g) => numericSql(g, sqlArgs(c, g), (...xs) => `LEAST(${xs.join(", ")})`) });
def({ name: "MAX", minArgs: 1, maxArgs: Infinity, summary: "MAX(number1, ...)", sql: (c, g) => numericSql(g, sqlArgs(c, g), (...xs) => `GREATEST(${xs.join(", ")})`) });

def({
  name: "VALUE",
  minArgs: 1,
  maxArgs: 1,
  summary: "VALUE(text) — convert text to a number; a leading $ is dropped",
  sql: (c, g) => {
    const x = g.expr(c.args[0]!);
    const re = quoteText(NUMERIC_TEXT_SQL);
    const p = g.dispatch(x, (a) => {
      switch (a.k) {
        case "blank": return { v: "0::float8", err: null };
        case "number": return { v: a.e, err: null };
        case "boolean": return { v: `CASE WHEN ${a.e} THEN 1::float8 ELSE 0::float8 END`, err: null };
        case "text": {
          if (typeof a.lit === "string") {
            const t = stripCurrency(a.lit);
            return NUMERIC_TEXT.test(t) ? { v: `${Number(t.trim())}::float8`, err: null } : { v: "NULL::float8", err: quoteText(ERR) };
          }
          const t = `regexp_replace(${a.e}, ${quoteText(STRIP_CURRENCY_SQL.pattern)}, ${quoteText(STRIP_CURRENCY_SQL.replacement)})`;
          return { v: `CASE WHEN ${t} ~ ${re} THEN (${t})::float8 END`, err: `CASE WHEN ${t} ~ ${re} THEN NULL ELSE ${quoteText(ERR)} END` };
        }
      }
    });
    return g.make("number", p.v, [x.err, p.err]);
  },
});

// ---------------------------------------------------------------- text

const count = (g: Parameters<typeof roundDigits>[0], x: SqlVal) => g.int(g.toNumber(x), 0);

def({ name: "LEN", minArgs: 1, maxArgs: 1, summary: "LEN(string)", sql: (c, g) => { const t = textSql(g, sqlArgs(c, g), (s) => s); return g.make("number", `length(${t.v})::float8`, [t.err]); } });
def({ name: "UPPER", minArgs: 1, maxArgs: 1, summary: "UPPER(string)", sql: (c, g) => textSql(g, sqlArgs(c, g), (s) => `upper(${s})`) });
def({ name: "LOWER", minArgs: 1, maxArgs: 1, summary: "LOWER(string)", sql: (c, g) => textSql(g, sqlArgs(c, g), (s) => `lower(${s})`) });
def({
  name: "TRIM",
  minArgs: 1,
  maxArgs: 1,
  summary: "TRIM(string) — remove leading and trailing whitespace",
  notes: "Inner runs of spaces are kept (unlike Sheets/Excel).",
  sql: (c, g) => textSql(g, sqlArgs(c, g), (s) => `regexp_replace(${s}, ${quoteText("^[ \\t\\n\\r\\f\\v]+|[ \\t\\n\\r\\f\\v]+$")}, '', 'g')`),
});
def({ name: "CONCATENATE", minArgs: 1, maxArgs: Infinity, summary: "CONCATENATE(text1, ...)", sql: (c, g) => textSql(g, sqlArgs(c, g), (...xs) => `(${xs.join(" || ")})`) });

def({
  name: "LEFT",
  minArgs: 2,
  maxArgs: 2,
  summary: "LEFT(string, howMany)",
  sql: (c, g) => {
    const [s, n] = sqlArgs(c, g);
    const t = g.toText(s!);
    const k = g.toNumber(n!);
    return g.make("text", `left(${t.v}, ${count(g, k)})`, [k.err, t.err]);
  },
});
def({
  name: "RIGHT",
  minArgs: 2,
  maxArgs: 2,
  summary: "RIGHT(string, howMany)",
  sql: (c, g) => {
    const [s, n] = sqlArgs(c, g);
    const t = g.toText(s!);
    const k = g.toNumber(n!);
    return g.make("text", `right(${t.v}, ${count(g, k)})`, [k.err, t.err]);
  },
});
def({
  name: "MID",
  minArgs: 3,
  maxArgs: 3,
  summary: "MID(string, whereToStart, count) — 1-based",
  sql: (c, g) => {
    const [s, st, n] = sqlArgs(c, g);
    const start = g.toNumber(st!);
    const k = g.toNumber(n!);
    const t = g.toText(s!);
    return g.make("text", `substr(${t.v}, ${g.int(start, 1)}, ${count(g, k)})`, [start.err, k.err, t.err]);
  },
});

for (const [name, notFound] of [["FIND", "0"], ["SEARCH", "NULL::float8"]] as const) {
  def({
    name,
    minArgs: 2,
    maxArgs: 3,
    summary: `${name}(stringToFind, whereToSearch, [startFromPosition])`,
    notes: name === "FIND" ? "Returns 0 when not found." : "Returns blank when not found; case-sensitive like FIND (unverified).",
    sql: (c, g) => {
      const [n, h, st] = sqlArgs(c, g);
      const start = st ? g.toNumber(st) : g.number(0);
      const s0 = count(g, start);
      const [needle, hay] = [g.toText(n!), g.toText(h!)];
      const v = `CASE WHEN ${s0} > length(${hay.v}) THEN ${notFound} ELSE COALESCE((NULLIF(strpos(substr(${hay.v}, ${s0} + 1), ${needle.v}), 0) + ${s0})::float8, ${notFound}) END`;
      return g.make("number", v, [start.err, needle.err, hay.err], name === "SEARCH");
    },
  });
}

def({
  name: "SUBSTITUTE",
  minArgs: 3,
  maxArgs: 4,
  summary: "SUBSTITUTE(string, old_text, new_text, [index])",
  sql: (c, g) => {
    const [s, o, n, idx] = sqlArgs(c, g);
    const ts = [g.toText(s!), g.toText(o!), g.toText(n!)];
    const [t, old, rep] = ts.map((x) => x.v) as [string, string, string];
    if (!idx) return g.make("text", `CASE WHEN ${old} = '' THEN ${t} ELSE replace(${t}, ${old}, ${rep}) END`, ts.map((x) => x.err));
    const i = g.toNumber(idx);
    const iv = g.int(i);
    return g.make("text", substituteNthSql(t, old, rep, iv), [i.err, errorIf(`${iv} < 1`, ERR), ...ts.map((x) => x.err)]);
  },
});

def({
  name: "REPLACE",
  minArgs: 4,
  maxArgs: 4,
  summary: "REPLACE(string, start_character, number_of_characters, replacement)",
  sql: (c, g) => {
    const [s, st, n, r] = sqlArgs(c, g);
    const start = g.toNumber(st!);
    const k = g.toNumber(n!);
    const [t, rep] = [g.toText(s!), g.toText(r!)];
    const from = g.int(start, 1);
    return g.make("text", `(substr(${t.v}, 1, ${from} - 1) || ${rep.v} || substr(${t.v}, ${from} + ${count(g, k)}))`, [start.err, k.err, t.err, rep.err]);
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
