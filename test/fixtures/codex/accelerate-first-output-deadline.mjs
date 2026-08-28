import process from "node:process";
import { accelerateDeadline } from "./accelerate-deadline.mjs";

accelerateDeadline({
  controlPath: process.env.ENSEMBLE_FIRST_OUTPUT_DEADLINE_CONTROL,
  errorName: "AppServerFirstOutputTimeoutError",
  kind: "first-output",
  observe: { errorName: "AppServerRetryPromiseBrokenError", kind: "retry-promise" }
});
