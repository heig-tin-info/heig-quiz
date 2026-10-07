/**
 * Safe Exam Browser, pure (D21, merge task M6-02): the typed plist of a
 * `.seb`, its Config Key, and the hashes SEB sends. No database, no HTTP:
 * the routes that serve a file or check a header are their app's.
 */
export { configKey } from "./configKey.js";
export {
  array,
  bool,
  data,
  date,
  dict,
  int,
  real,
  str,
  toPlistXml,
  type SebDict,
  type SebValue,
} from "./plist.js";
export {
  CONFIG_KEY_HEADER,
  REQUEST_HASH_HEADER,
  absoluteRequestUrl,
  anyKeyMatches,
  expectedHash,
  hashesEqual,
} from "./request.js";
export { buildSebConfig, type SebConfigInput } from "./sebConfig.js";
