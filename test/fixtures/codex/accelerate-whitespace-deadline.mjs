import process from "node:process";
import { accelerateDeadline } from "./accelerate-deadline.mjs";

accelerateDeadline({
  controlPath: process.env.ENSEMBLE_WHITESPACE_DEADLINE_CONTROL,
  errorName: "AppServerWhitespaceStreamTimeoutError",
  kind: "whitespace-stream"
});
