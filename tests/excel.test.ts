import cases from "./cases/excel.json";
import { runCases, type TestCase } from "./harness";

runCases("excel", cases as TestCase[]);
