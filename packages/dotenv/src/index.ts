export { type CheckOptions, type CheckReport, check, toConfigIssues } from "./check.js";
export * as Document from "./document.js";
export { formatValue, stringify } from "./document.js";
export { DotenvError, type DotenvErrorKind } from "./errors.js";
export { type Expandable, type ExpandOptions, expand } from "./expand.js";
export {
  apply,
  cascade,
  configProvider,
  environment,
  type Loaded,
  type LoadOptions,
  layer,
  load,
} from "./load.js";
export { setValues, unsetKeys } from "./write.js";

import * as Document from "./document.js";

/** Parses dotenv content into a value map with `dotenv` semantics; a repeated key keeps its last value. */
export const parse = (content: string): Map<string, string> =>
  Document.values(Document.parse(content));
