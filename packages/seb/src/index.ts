/**
 * Safe Exam Browser, pure (D21, merge task M6-02): the typed plist of a
 * `.seb`, its Config Key, and the hashes SEB sends. No database, no HTTP:
 * the routes that serve a file or check a header are their app's.
 */
export { EXEMPT_KEY, configKey, configKeyFromPlistXml, sebJson } from "./configKey.js";
export {
  PlistParseError,
  array,
  bool,
  data,
  date,
  dict,
  int,
  parsePlist,
  real,
  str,
  toPlistXml,
  type SebDict,
  type SebValue,
} from "./plist.js";
export { CONFIG_KEY_HEADER, REQUEST_HASH_HEADER, absoluteRequestUrl, expectedHash, hashesEqual } from "./request.js";
export { buildSebConfig, type SebConfigInput } from "./sebConfig.js";
