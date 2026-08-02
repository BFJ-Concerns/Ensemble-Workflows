declare module "acorn-globals" {
  import type { Node } from "acorn";

  interface DetectedGlobalNode extends Node {
    /** Ancestor chain from Program to the identifier itself (acorn-globals walks with ancestors). */
    parents?: Node[];
  }

  interface DetectedGlobal {
    name: string;
    nodes: DetectedGlobalNode[];
  }

  function detectGlobals(source: string | Node): DetectedGlobal[];
  namespace detectGlobals {
    /** acorn.parse with acorn-globals' own options (latest ecmaVersion, return/import anywhere). */
    function parse(source: string): Node;
  }
  export = detectGlobals;
}
