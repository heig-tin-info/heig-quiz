import { createLucideIcon, type IconNode, type LucideIcon } from "lucide-react";

/**
 * Pool icons lucide does not ship: the languages, tools and engineering
 * subjects HEIG-VD teaches (python, c, java, plc, beam…). lucide removed
 * every brand icon in its 1.0, and has no glyph for a ladder rung or a
 * loaded beam.
 *
 * Each one is a list of path data on lucide's own grid (24×24, 2 px stroke,
 * round caps and joins, no fill), drawn through lucide's `createLucideIcon`:
 * it renders, sizes and colours exactly like the rest of the shelf. A name
 * here is stored on a pool like a lucide name, so it must never collide
 * with one — `poolIcons.test` asserts it, and a lucide upgrade that adds
 * the same name fails there rather than silently swapping the glyph.
 *
 * Some are drawn for Quiz; the others come from Tabler Icons, whose grid
 * and stroke match lucide's:
 *
 *   Tabler Icons — MIT License, Copyright (c) 2020-2026 Paweł Kuna.
 *   Permission is hereby granted, free of charge, to any person obtaining a
 *   copy of this software and associated documentation files (the
 *   "Software"), to deal in the Software without restriction, including
 *   without limitation the rights to use, copy, modify, merge, publish,
 *   distribute, sublicense, and/or sell copies of the Software, and to
 *   permit persons to whom the Software is furnished to do so, subject to
 *   the following conditions: The above copyright notice and this
 *   permission notice shall be included in all copies or substantial
 *   portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT
 *   WARRANTY OF ANY KIND.
 *
 * Product names and logos belong to their owners; they only name the
 * subject a pool is about.
 */
const CUSTOM_ICON_PATHS = {
  // Drawn for Quiz.
  c: ["M12 2l8.66 5v10l-8.66 5l-8.66-5v-10z", "M15 9.5a4 4 0 1 0 0 5"],
  bash: [
    "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-14a2 2 0 0 1-2-2v-14a2 2 0 0 1 2-2z",
    "M10.5 9h-2.5a1.5 1.5 0 0 0 0 3h1a1.5 1.5 0 0 1 0 3h-2.5",
    "M8.5 7v2",
    "M8.5 15v2",
    "M13 16h4",
  ],
  java: [
    "M5 11h11v4a4 4 0 0 1-4 4h-3a4 4 0 0 1-4-4z",
    "M16 12h1a2 2 0 0 1 0 4h-1",
    "M3 22h15",
    "M9 8c-1-1-1-2 0-3s1-2 0-3",
    "M12.5 8c-1-1-1-2 0-3s1-2 0-3",
  ],
  perl: [
    "M2 8.5l1-2.5h3l2 4c1-3 3-5 5-5s4 2 5 5.5l1 .5v2.5c0 1-1 2-2 2h-8.5c-1 0-1.5-.5-2-1.5l-2-4.5h-2.5z",
    "M9.5 15v6",
    "M17 15v6",
    "M20 11.5l1 3",
  ],
  arduino: [
    "M7 7a5 5 0 1 0 0 10c3 0 3.5-2.5 5-5s2-5 5-5a5 5 0 1 1 0 10c-3 0-3.5-2.5-5-5s-2-5-5-5",
    "M5.5 12h3",
    "M15.5 12h3",
    "M17 10.5v3",
  ],
  plc: [
    "M2 4v16",
    "M22 4v16",
    "M2 12h4",
    "M6 9v6",
    "M10 9v6",
    "M10 12h3",
    "M14 9a5 5 0 0 0 0 6",
    "M17 9a5 5 0 0 1 0 6",
    "M18 12h4",
  ],
  beam: ["M3 11h18v3h-18z", "M5 14l-2 4h4z", "M19 14l-2 4h4z", "M12 3v5", "M10 6l2 2l2-2"],
  truss: ["M2 17h20", "M7 7h10", "M2 17l5-10l5 10l5-10l5 10"],
  contour: [
    "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-14a2 2 0 0 1-2-2v-14a2 2 0 0 1 2-2z",
    "M11.5 9c0-1.7 1.3-3 3-3s2.5 1 2.5 2.5s-1.3 3-3 3s-2.5-1-2.5-2.5z",
    "M7.5 3c-.5 5 2 11.5 7 11.5c3 0 5-2.5 6.5-4.5",
    "M3 13.5c3 0 4 4.5 9 4.5c4 0 6.5-1 9-3",
  ],
  spring: ["M6 3h12", "M12 3v2.5l-4 1.5l8 3l-8 3l4 1.5v2", "M8 16.5h8v4.5h-8z"],
  // From Tabler Icons (MIT), the source name in the comment.
  python: [
    // brand-python
    "M12 9h-7a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h3",
    "M12 15h7a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2h-3",
    "M8 9v-4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-4a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-4",
    "M11 6l0 .01",
    "M13 18l0 .01",
  ],
  cpp: [
    // brand-cpp
    "M18 12h4",
    "M20 10v4",
    "M11 12h4",
    "M13 10v4",
    "M9 9a3 3 0 0 0-3-3h-.5a3.5 3.5 0 0 0-3.5 3.5v5a3.5 3.5 0 0 0 3.5 3.5h.5a3 3 0 0 0 3-3",
  ],
  csharp: [
    // brand-c-sharp
    "M10 9a3 3 0 0 0-3-3h-.5a3.5 3.5 0 0 0-3.5 3.5v5a3.5 3.5 0 0 0 3.5 3.5h.5a3 3 0 0 0 3-3",
    "M16 7l-1 10",
    "M20 7l-1 10",
    "M14 10h7.5",
    "M21 14h-7.5",
  ],
  javascript: [
    // brand-javascript
    "M20 4l-2 14.5l-6 2l-6-2l-2-14.5l16 0",
    "M7.5 8h3v8l-2-1",
    "M16.5 8h-2.5a.5 .5 0 0 0-.5 .5v3a.5 .5 0 0 0 .5 .5h1.423a.5 .5 0 0 1 .495 .57l-.418 2.93l-2 .5",
  ],
  typescript: [
    // brand-typescript
    "M15 17.5c.32 .32 .754 .5 1.207 .5h.543c.69 0 1.25-.56 1.25-1.25v-.25a1.5 1.5 0 0 0-1.5-1.5a1.5 1.5 0 0 1-1.5-1.5v-.25c0-.69 .56-1.25 1.25-1.25h.543c.453 0 .887 .18 1.207 .5",
    "M9 12h4",
    "M11 12v6",
    "M21 19v-14a2 2 0 0 0-2-2h-14a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2",
  ],
  rust: [
    // brand-rust
    "M10.139 3.463c.473-1.95 3.249-1.95 3.722 0a1.916 1.916 0 0 0 2.859 1.185c1.714-1.045 3.678 .918 2.633 2.633a1.916 1.916 0 0 0 1.184 2.858c1.95 .473 1.95 3.249 0 3.722a1.916 1.916 0 0 0-1.185 2.859c1.045 1.714-.918 3.678-2.633 2.633a1.916 1.916 0 0 0-2.858 1.184c-.473 1.95-3.249 1.95-3.722 0a1.916 1.916 0 0 0-2.859-1.185c-1.714 1.045-3.678-.918-2.633-2.633a1.916 1.916 0 0 0-1.184-2.858c-1.95-.473-1.95-3.249 0-3.722a1.916 1.916 0 0 0 1.185-2.859c-1.045-1.714 .918-3.678 2.633-2.633a1.914 1.914 0 0 0 2.858-1.184",
    "M8 12h6a2 2 0 1 0 0-4h-6v8v-4",
    "M19 16h-2a2 2 0 0 1-2-2a2 2 0 0 0-2-2h-1",
    "M9 8h-4",
    "M5 16h4",
  ],
  golang: [
    // brand-golang
    "M15.695 14.305c1.061 1.06 2.953 .888 4.226-.384c1.272-1.273 1.444-3.165 .384-4.226c-1.061-1.06-2.953-.888-4.226 .384c-1.272 1.273-1.444 3.165-.384 4.226",
    "M12.68 9.233c-1.084-.497-2.545-.191-3.591 .846c-1.284 1.273-1.457 3.165-.388 4.226c1.07 1.06 2.978 .888 4.261-.384a3.669 3.669 0 0 0 1.038-1.921h-2.427",
    "M5.5 15h-1.5",
    "M6 9h-2",
    "M5 12h-3",
  ],
  kotlin: [
    // brand-kotlin
    "M20 20h-16v-16h16",
    "M4 20l16-16",
    "M4 12l8-8",
    "M12 12l8 8",
  ],
  php: [
    // brand-php
    "M2 12a10 9 0 1 0 20 0a10 9 0 1 0-20 0",
    "M5.5 15l.395-1.974l.605-3.026h1.32a1 1 0 0 1 .986 1.164l-.167 1a1 1 0 0 1-.986 .836h-1.653",
    "M15.5 15l.395-1.974l.605-3.026h1.32a1 1 0 0 1 .986 1.164l-.167 1a1 1 0 0 1-.986 .836h-1.653",
    "M12 7.5l-1 5.5",
    "M11.6 10h2.4l-.5 3",
  ],
  powershell: [
    // brand-powershell
    "M4.887 20h11.868c.893 0 1.664-.665 1.847-1.592l2.358-12c.212-1.081-.442-2.14-1.462-2.366a1.784 1.784 0 0 0-.385-.042h-11.868c-.893 0-1.664 .665-1.847 1.592l-2.358 12c-.212 1.081 .442 2.14 1.462 2.366c.127 .028 .256 .042 .385 .042",
    "M9 8l4 4l-6 4",
    "M12 16h3",
  ],
  nodejs: [
    // brand-nodejs
    "M9 9v8.044a2 2 0 0 1-2.996 1.734l-1.568-.9a3 3 0 0 1-1.436-2.561v-6.635a3 3 0 0 1 1.436-2.56l6-3.667a3 3 0 0 1 3.128 0l6 3.667a3 3 0 0 1 1.436 2.561v6.634a3 3 0 0 1-1.436 2.56l-6 3.667a3 3 0 0 1-3.128 0",
    "M17 9h-3.5a1.5 1.5 0 0 0 0 3h2a1.5 1.5 0 0 1 0 3h-3.5",
  ],
  html5: [
    // brand-html5
    "M20 4l-2 14.5l-6 2l-6-2l-2-14.5l16 0",
    "M15.5 8h-7l.5 4h6l-.5 3.5l-2.5 .75l-2.5-.75l-.1-.5",
  ],
  css3: [
    // brand-css3
    "M20 4l-2 14.5l-6 2l-6-2l-2-14.5l16 0",
    "M8.5 8h7l-4.5 4h4l-.5 3.5l-2.5 .75l-2.5-.75l-.1-.5",
  ],
  git: [
    // brand-git
    "M15 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0",
    "M11 8a1 1 0 1 0 2 0a1 1 0 1 0-2 0",
    "M11 16a1 1 0 1 0 2 0a1 1 0 1 0-2 0",
    "M12 15v-6",
    "M15 11l-2-2",
    "M11 7l-1.9-1.9",
    "M13.446 2.6l7.955 7.954a2.045 2.045 0 0 1 0 2.892l-7.955 7.955a2.045 2.045 0 0 1-2.892 0l-7.955-7.955a2.045 2.045 0 0 1 0-2.892l7.955-7.955a2.045 2.045 0 0 1 2.892 0",
  ],
  github: [
    // brand-github
    "M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2c2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2a4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0c-2.4-1.6-3.5-1.3-3.5-1.3a4.2 4.2 0 0 0-.1 3.2a4.6 4.6 0 0 0-1.3 3.2c0 4.6 2.7 5.7 5.5 6c-.6 .6-.6 1.2-.5 2v3.5",
  ],
  gitlab: [
    // brand-gitlab
    "M21 14l-9 7l-9-7l3-11l3 7h6l3-7l3 11",
  ],
  docker: [
    // brand-docker
    "M22 12.54c-1.804-.345-2.701-1.08-3.523-2.94c-.487 .696-1.102 1.568-.92 2.4c.028 .238-.32 1-.557 1h-14c0 5.208 3.164 7 6.196 7c4.124 .022 7.828-1.376 9.854-5c1.146-.101 2.296-1.505 2.95-2.46",
    "M5 10h3v3h-3l0-3",
    "M8 10h3v3h-3l0-3",
    "M11 10h3v3h-3l0-3",
    "M8 7h3v3h-3l0-3",
    "M11 7h3v3h-3l0-3",
    "M11 4h3v3h-3l0-3",
    "M4.571 18c1.5 0 2.047-.074 2.958-.78",
    "M10 16l0 .01",
  ],
  chrome: [
    // brand-chrome
    "M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0",
    "M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0",
    "M12 9h8.4",
    "M14.598 13.5l-4.2 7.275",
    "M9.402 13.5l-4.2-7.275",
  ],
  vscode: [
    // brand-vscode
    "M16 3v18l4-2.5v-13l-4-2.5",
    "M9.165 13.903l-4.165 3.597l-2-1l4.333-4.5m1.735-1.802l6.932-7.198v5l-4.795 4.141",
    "M16 16.5l-11-10l-2 1l13 13.5",
  ],
  windows: [
    // brand-windows
    "M17.8 20l-12-1.5c-1-.1-1.8-.9-1.8-1.9v-9.2c0-1 .8-1.8 1.8-1.9l12-1.5c1.2-.1 2.2 .8 2.2 1.9v12.1c0 1.2-1.1 2.1-2.2 1.9l0 .1",
    "M12 5l0 14",
    "M4 12l16 0",
  ],
  android: [
    // brand-android
    "M4 10l0 6",
    "M20 10l0 6",
    "M7 9h10v8a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-8a5 5 0 0 1 10 0",
    "M8 3l1 2",
    "M16 3l-1 2",
    "M9 18l0 3",
    "M15 18l0 3",
  ],
  mysql: [
    // brand-mysql
    "M13 21c-1.427-1.026-3.59-3.854-4-6c-.486 .77-1.501 2-2 2c-1.499-.888-.574-3.973 0-6c-1.596-1.433-2.468-2.458-2.5-4c-3.35-3.44-.444-5.27 2.5-3h1c8.482 .5 6.421 8.07 9 11.5c2.295 .522 3.665 2.254 5 3.5c-2.086-.2-2.784-.344-3.5 0c.478 1.64 2.123 2.2 3.5 3",
    "M9 7h.01",
  ],
  mongodb: [
    // brand-mongodb
    "M12 3v19",
    "M18 11.227c0 3.273-1.812 4.77-6 9.273c-4.188-4.503-6-6-6-9.273c0-4.454 3.071-6.927 6-9.227c2.929 2.3 6 4.773 6 9.227",
  ],
  sql: [
    // sql
    "M12 8a2 2 0 0 1 2 2v4a2 2 0 1 1-4 0v-4a2 2 0 0 1 2-2",
    "M17 8v8h4",
    "M13 15l1 1",
    "M3 15a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1h-2a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1",
  ],
  resistor: [
    // circuit-resistor
    "M2 12h2l2-5l3 10l3-10l3 10l3-10l1.5 5h2.5",
  ],
  "logic-gate": [
    // logic-and
    "M22 12h-5",
    "M2 9h5",
    "M2 15h5",
    "M9 5c6 0 8 3.5 8 7s-2 7-8 7h-2v-14h2",
  ],
  integral: [
    // math-integral
    "M7 19a2 2 0 0 0 2 2c2 0 2-4 3-9s1-9 3-9a2 2 0 0 1 2 2",
  ],
  matrix: [
    // matrix
    "M8 16h.013",
    "M12.01 16h.005",
    "M16.015 16h.005",
    "M16.015 12h.005",
    "M8.01 12h.005",
    "M12.01 12h.005",
    "M16.02 8h.005",
    "M8.015 8h.005",
    "M12.015 8h.005",
    "M7 4h-1a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h1",
    "M17 4h1a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-1",
  ],
  latitude: [
    // world-latitude
    "M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0",
    "M4.6 7l14.8 0",
    "M3 12l18 0",
    "M4.6 17l14.8 0",
  ],
  crane: [
    // crane
    "M6 21h6",
    "M9 21v-18l-6 6h18",
    "M9 3l10 6",
    "M17 9v4a2 2 0 1 1-2 2",
  ],
} as const satisfies Record<string, readonly string[]>;

export type CustomIconName = keyof typeof CUSTOM_ICON_PATHS;

export const CUSTOM_ICON_NAMES = Object.keys(CUSTOM_ICON_PATHS) as CustomIconName[];

/**
 * Words a teacher may type in the catalogue's search that the name alone
 * does not hold. English like lucide's names, with the French term where it
 * differs.
 */
export const CUSTOM_ICON_KEYWORDS: Partial<Record<CustomIconName, string>> = {
  github: "octocat",
  nodejs: "node",
  golang: "go",
  csharp: "c#",
  cpp: "c++",
  bash: "shell",
  plc: "automate ladder",
  beam: "rdm strength of materials statics",
  truss: "treillis statics",
  contour: "topography courbes niveau",
  spring: "ressort oscillator",
  resistor: "resistance",
  "logic-gate": "and",
  latitude: "geomatics",
};

export const CUSTOM_ICON_COMPONENTS = Object.fromEntries(
  Object.entries(CUSTOM_ICON_PATHS).map(([name, paths]) => {
    const node: IconNode = paths.map((d, i) => ["path", { d, key: String(i) }]);
    return [name, createLucideIcon(name, node)];
  }),
) as Record<CustomIconName, LucideIcon>;
