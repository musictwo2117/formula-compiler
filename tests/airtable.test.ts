import cases from "./cases/airtable.json";
import { runCases, type TestCase } from "./harness";

runCases("airtable", cases as TestCase[]);
