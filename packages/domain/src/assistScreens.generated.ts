/*
 * GENERATED from the web router by apps/web/src/assist/screens.ts — do not
 * edit. `UPDATE_ASSIST_SCREENS=1 pnpm --filter @quiz/web test -- src/assist/screens`
 * rewrites it; the test fails while it differs (ADR-080 P2b).
 */
import type { AssistScreenEntry } from "./assistScreens.js";

export const ASSIST_SCREENS: readonly AssistScreenEntry[] = [
  {
    "screen": "home",
    "pattern": "/",
    "ids": [],
    "params": {},
    "title": "Courses",
    "help": "courses",
    "audience": "staff"
  },
  {
    "screen": "settings",
    "pattern": "/settings",
    "ids": [],
    "params": {},
    "title": "Settings",
    "help": null,
    "audience": "staff"
  },
  {
    "screen": "admin",
    "pattern": "/admin",
    "ids": [],
    "params": {
      "tab": {
        "kind": "enum",
        "values": [
          "people",
          "system",
          "tasks",
          "llm"
        ]
      }
    },
    "title": "Administration",
    "help": null,
    "audience": "admin"
  },
  {
    "screen": "course",
    "pattern": "/courses/:id",
    "ids": [
      {
        "field": "id",
        "kind": "course"
      }
    ],
    "params": {
      "tab": {
        "kind": "enum",
        "values": [
          "classrooms",
          "templates",
          "pools",
          "members",
          "conditions",
          "settings"
        ]
      }
    },
    "title": "Course",
    "help": "courses",
    "audience": "staff"
  },
  {
    "screen": "template",
    "pattern": "/templates/:id",
    "ids": [
      {
        "field": "id",
        "kind": "template"
      }
    ],
    "params": {
      "tab": {
        "kind": "enum",
        "values": [
          "questions",
          "settings"
        ]
      }
    },
    "title": "Evaluation template",
    "help": "courses",
    "audience": "staff"
  },
  {
    "screen": "classroomSettings",
    "pattern": "/classrooms/:id/settings",
    "ids": [
      {
        "field": "id",
        "kind": "classroom"
      }
    ],
    "params": {},
    "title": "Classroom settings",
    "help": "classroom",
    "audience": "staff"
  },
  {
    "screen": "classroomJournal",
    "pattern": "/classrooms/:id/journal",
    "ids": [
      {
        "field": "id",
        "kind": "classroom"
      }
    ],
    "params": {},
    "title": "Classroom journal",
    "help": "journal",
    "audience": "staff"
  },
  {
    "screen": "classroomGroups",
    "pattern": "/classrooms/:id/groups",
    "ids": [
      {
        "field": "id",
        "kind": "classroom"
      }
    ],
    "params": {},
    "title": "Classroom groups",
    "help": "groups",
    "audience": "staff"
  },
  {
    "screen": "classroomGrades",
    "pattern": "/classrooms/:id/grades",
    "ids": [
      {
        "field": "id",
        "kind": "classroom"
      }
    ],
    "params": {},
    "title": "Classroom grades",
    "help": "classroom",
    "audience": "staff"
  },
  {
    "screen": "classroom",
    "pattern": "/classrooms/:id",
    "ids": [
      {
        "field": "id",
        "kind": "classroom"
      }
    ],
    "params": {
      "tab": {
        "kind": "enum",
        "values": [
          "evaluations",
          "roster",
          "drill"
        ]
      }
    },
    "title": "Classroom",
    "help": "classroom",
    "audience": "staff"
  },
  {
    "screen": "activities",
    "pattern": "/activities",
    "ids": [],
    "params": {},
    "title": "Activities",
    "help": null,
    "audience": "staff"
  },
  {
    "screen": "pools",
    "pattern": "/pools",
    "ids": [],
    "params": {},
    "title": "Question pools",
    "help": "pools",
    "audience": "staff"
  },
  {
    "screen": "poolCategories",
    "pattern": "/pools/:id/categories",
    "ids": [
      {
        "field": "id",
        "kind": "pool"
      }
    ],
    "params": {},
    "title": "Pool categories",
    "help": "categories",
    "audience": "staff"
  },
  {
    "screen": "pool",
    "pattern": "/pools/:id",
    "ids": [
      {
        "field": "id",
        "kind": "pool"
      }
    ],
    "params": {
      "tab": {
        "kind": "enum",
        "values": [
          "questions",
          "tags",
          "review"
        ]
      },
      "q": {
        "kind": "text",
        "hint": "the search box: free text and tag:<name> type:<type id> difficulty:<n|>n|a-b> version:<n|>n>"
      },
      "category": {
        "kind": "id",
        "of": "category"
      }
    },
    "title": "Question pool",
    "help": "pool",
    "audience": "staff"
  },
  {
    "screen": "polls",
    "pattern": "/polls",
    "ids": [],
    "params": {},
    "title": "Start a poll",
    "help": null,
    "audience": "staff"
  },
  {
    "screen": "question",
    "pattern": "/questions/:id",
    "ids": [
      {
        "field": "id",
        "kind": "question"
      }
    ],
    "params": {
      "tab": {
        "kind": "enum",
        "values": [
          "edit",
          "try",
          "versions"
        ]
      }
    },
    "title": "Question editor",
    "help": "question-editor",
    "audience": "staff"
  },
  {
    "screen": "live",
    "pattern": "/evaluations/:id/live",
    "ids": [
      {
        "field": "id",
        "kind": "evaluation"
      }
    ],
    "params": {},
    "title": "Live dashboard",
    "help": "live",
    "audience": "staff"
  },
  {
    "screen": "grading",
    "pattern": "/evaluations/:evaluationId/grading",
    "ids": [
      {
        "field": "evaluationId",
        "kind": "evaluation"
      }
    ],
    "params": {
      "item": {
        "kind": "id",
        "of": "question"
      }
    },
    "title": "Grading",
    "help": "grading",
    "audience": "staff"
  },
  {
    "screen": "results",
    "pattern": "/evaluations/:evaluationId/results",
    "ids": [
      {
        "field": "evaluationId",
        "kind": "evaluation"
      }
    ],
    "params": {
      "tab": {
        "kind": "enum",
        "values": [
          "students",
          "questions"
        ]
      }
    },
    "title": "Results",
    "help": "results",
    "audience": "staff"
  },
  {
    "screen": "evaluation",
    "pattern": "/evaluations/:id",
    "ids": [
      {
        "field": "id",
        "kind": "evaluation"
      }
    ],
    "params": {
      "step": {
        "kind": "enum",
        "values": [
          "questions",
          "timing",
          "launch"
        ]
      }
    },
    "title": "Evaluation configuration",
    "help": "evaluation",
    "audience": "staff"
  }
];
