import cases from "./cases/sheets.json";
import { runCases, type TestCase } from "./harness";

runCases("sheets", cases as TestCase[]);
