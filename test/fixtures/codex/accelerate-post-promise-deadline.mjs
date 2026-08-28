import process from "node:process";
import { accelerateDeadline } from "./accelerate-deadline.mjs";

accelerateDeadline({
  controlPath: process.env.ENSEMBLE_POST_PROMISE_DEADLINE_CONTROL,
  errorName: "AppServerRetryPromiseBrokenError",
  kind: "retry-promise"
});
