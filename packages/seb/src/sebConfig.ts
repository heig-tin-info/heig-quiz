/**
 * The configuration of a `.seb` the platform hands out (D21: the platform
 * builds every `.seb`, evaluations and projects alike).
 *
 * An unencrypted `.seb` is a bare XML plist, no gzip and no prefix: what
 * Moodle's `quizaccess_seb` serves (`Content-Type: application/seb`). It is a
 * partial configuration, the settings that matter only, as
 * `seb_quiz_settings::process_seb_config_manually()` builds one: the Config
 * Key is computed over the content of the file, whatever it leaves out.
 *
 * Every key comes from a real SEB configuration (the sibling's
 * `sebFile.ts`, read against SEB Windows 2.2.3's and the SEB project's
 * published files); `sendBrowserExamKey` is what makes SEB send the Config
 * Key header. The keys and their order are the ones Quiz's evaluations have
 * served since ADR-027: their bytes, and so their Config Key, are pinned by
 * `apps/api/src/auth/seb.snapshot.test.ts`.
 */
import { array, bool, data, dict, int, str, type SebDict, type SebValue } from "./plist.js";

export interface SebConfigInput {
  /** The absolute URL SEB opens first. Its host is always allowed. */
  readonly startUrl: string;
  /**
   * Hosts the URL filter allows beside the start URL's (a project's
   * workspace host, later). Duplicates of it are dropped.
   */
  readonly allowedHosts: readonly string[];
  /**
   * A Browser Exam Key salt, in base64, for an activity that checks BEKs:
   * SEB computes its BEK from it and its own binary. Never a BEK itself,
   * which would hand the shared secret to the student. Omitted by default
   * (the Config Key alone, D21).
   */
  readonly examKeySalt?: string;
}

/** One URL filter rule: action 1 = allow, `regex` false = a host with wildcards. */
const allow = (expression: string): SebValue =>
  dict([
    ["action", int(1)],
    ["active", bool(true)],
    ["expression", str(expression)],
    ["regex", bool(false)],
  ]);

/** The SEB configuration of one launch, as a typed plist tree. */
export function buildSebConfig(input: SebConfigInput): SebValue {
  const hosts = [...new Set([new URL(input.startUrl).host, ...input.allowedHosts])];
  const entries: SebDict = [
    ["startURL", str(input.startUrl)],
    ["allowQuit", bool(true)],
    ["URLFilterEnable", bool(true)],
    ["URLFilterEnableContentFilter", bool(true)],
    ["URLFilterRulesAsRegex", bool(false)],
    ["URLFilterRules", array(hosts.map(allow))],
    ["allowDownUploads", bool(false)],
    ["downloadAndOpenSebConfig", bool(false)],
    ["downloadPDFFiles", bool(false)],
    ["enablePrivateClipboard", bool(true)],
    ["browserViewMode", int(1)],
    ["enableBrowserWindowToolbar", bool(false)],
    ["hideBrowserWindowToolbar", bool(true)],
    ["showMenuBar", bool(false)],
    ["showTaskBar", bool(false)],
    ["allowBrowsingBackForward", bool(false)],
    ["allowPreferencesWindow", bool(false)],
    ["allowSwitchToApplications", bool(false)],
    ["allowVirtualMachine", bool(false)],
    ["allowSpellCheck", bool(false)],
    ["blockPopUpWindows", bool(true)],
    ["createNewDesktop", bool(true)],
    ["killExplorerShell", bool(false)],
    ["sendBrowserExamKey", bool(true)],
  ];
  return dict(input.examKeySalt === undefined ? entries : [...entries, ["examKeySalt", data(input.examKeySalt)]]);
}
