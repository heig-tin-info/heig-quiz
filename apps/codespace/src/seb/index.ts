/**
 * Exam side: the SEB verification of `/launch` and the exam cookie the proxy
 * checks. The `.seb` files are the platform's (D21, merge task M6-07).
 */
export {
  EXAM_COOKIE,
  EXAM_COOKIE_DEFAULT_MAX_AGE_MS,
  examCookieAttributes,
  issueExamCookie,
  verifyExamCookie,
  type ExamClaims,
  type ExamCookieRefusal,
  type ExamCookieVerdict,
} from "./examSession.js";
export { checkExamRequest, outsideSebPage, replyOutsideSeb } from "./check.js";
export {
  absoluteRequestUrl,
  createSebVerifier,
  DEV_HEADER,
  SebConfigurationError,
  type AssignmentSebKeys,
  type RequestUrlOptions,
  type SebRefusal,
  type SebRequestFacts,
  type SebVerdict,
  type SebVerifier,
  type SebVerifierConfig,
} from "./verify.js";
