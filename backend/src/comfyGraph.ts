// Types for the ComfyUI graph JSON that workflowService manipulates.
//
// These are deliberately `any`-backed, and that is a decision rather than an
// oversight, so it lives here with its reasoning instead of being repeated as 67
// anonymous `Record<string, any>` annotations across workflowService.ts.
//
// Why not `unknown`: a Comfy node's shape is decided by its node type. A
// LoadImage has `inputs.image`; a KSampler has `widgets_values` positional to
// that node's widget list; a subgraph node carries a nested `definitions`. There
// is no closed set -- installing a custom node pack adds shapes, and this app
// reads workflow files authored in the Comfy UI by artists. Typing the graph
// honestly would mean a discriminated union over every node type this studio
// might install, which cannot be enumerated. Typing it as `unknown` would mean a
// narrowing check at every one of ~200 property accesses in code whose job is
// precisely to walk unknown structures.
//
// What this DOES buy over the scattered annotations it replaces: the looseness is
// now one named, explained decision instead of 67 silent ones, so a reader can
// tell it is intentional, and a future effort to tighten it has a single place to
// start. What it does NOT buy: any actual type safety inside a node. Property
// typos on graph objects are still caught only by workflowService's tests, which
// is why those tests assert on concrete node ids and widget positions.

/* eslint-disable @typescript-eslint/no-explicit-any -- see the reasoning above. */

/**
 * One node in a Comfy graph. Known fields are listed for readability; the index
 * signature is what makes per-node-type fields reachable.
 */
export type ComfyNode = {
  id?: any;
  type?: string;
  class_type?: string;
  inputs?: any;
  outputs?: any;
  widgets_values?: any;
  [key: string]: any;
};

/**
 * A whole workflow document, a subgraph, or an /object_info response.
 * Structurally identical to ComfyNode -- named separately only so call sites read
 * as what they are.
 */
export type ComfyGraph = ComfyNode;

/** An entry in a node's `inputs` or `outputs` array. */
export type ComfyPort = {
  name?: string;
  link?: any;
  [key: string]: any;
};

/* eslint-enable @typescript-eslint/no-explicit-any */
