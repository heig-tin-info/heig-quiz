# Getting started

This chapter takes you from the sign-in screen to a working knowledge of the frame around every page: the sidebar, the command palette, the help drawer, the notifications and your settings.

## Signing in

Open the platform's address and click **Sign in with Switch edu-ID**. You are sent to the identity provider, you authenticate there, and you come back signed in. Your account is created at the first sign-in, with the name and the e-mail addresses that edu-ID reveals; whether you land on the teacher home or on the student home depends on your role (see [Overview](index.md#three-roles)).

<figure markdown="span">
  ![The sign-in screen](../assets/screenshots/sign-in-light.png#only-light)
  ![The sign-in screen](../assets/screenshots/sign-in-dark.png#only-dark)
  <figcaption>The sign-in screen; the second button exists only on a development machine.</figcaption>
</figure>

The **Dev login** button, with its "Development only" hint, is only present on a developer's machine: a production server refuses to start with it enabled, so you will never see it in class.

The session lasts thirty days. **Sign out**, in the account menu described below, ends it explicitly.

## The home page and the sidebar

A teacher lands on **Courses**: one card per course, with its classrooms, its staff and the pools linked to it. The sidebar on the left is the same on every page:

- **Courses**: the home page.
- **Question pools**: your pools and their questions. While a pool is open, its categories unfold under this entry.
- **Poll**: the launcher of a live poll.
- **Administration**: only for the administrator.
- **Classrooms**: one row per classroom you teach, with the code of its course. Click one to open it.

Above the account row, the **Shortcuts** strip lists the keyboard shortcuts that work on the current page. It always starts with the palette; a screen adds its own while it is open.

The account row at the bottom shows your name and address. Click it to open the account menu:

- **Settings**, described below.
- **Switch to student view** shows the portal the way a student sees it, with a banner at the top and **Back to teacher view** to return. It is how you check what a class will find after you release results.
- **Dark theme** or **Light theme** flips the theme for this browser.
- **Documentation** and **Project sources** open outside the app.
- **Sign out**.

On a phone the sidebar becomes a drawer behind the menu icon of the top bar, and the search icon opens the palette.

## The command palette

Press `Ctrl+K` anywhere (or click the search icon on a phone) and the palette opens over the page. It has three groups:

- **Navigation**: Courses, Settings, Question pools, then one entry per pool and per classroom, such as "Open the pool Programmation C" or "Open classroom PRG1-2026".
- **Actions**: **Start a poll**, the theme entries, **Switch to Français** (or to English), **Switch to student view**, **Sign out**. A screen that is open adds its own actions here: the question editor adds **Publish this question** and **Show the student preview**, a closed evaluation adds **Open the grading panel** and **Open the results**.
- **Help**: the documentation, the project sources, and every help topic of the product.

<figure markdown="span">
  ![The command palette](../assets/screenshots/palette-light.png#only-light)
  ![The command palette](../assets/screenshots/palette-dark.png#only-dark)
  <figcaption>The palette as it opens: every screen and action, from anywhere.</figcaption>
</figure>

Type to filter. The list narrows to what matches, across the three groups at once; the arrow keys move, `Enter` runs the highlighted entry and `Esc` closes.

<figure markdown="span">
  ![The palette filtered on "grad"](../assets/screenshots/palette-query-light.png#only-light)
  ![The palette filtered on "grad"](../assets/screenshots/palette-query-dark.png#only-dark)
  <figcaption>Typing `grad` leaves the Grading help topic; Enter opens it in the help drawer.</figcaption>
</figure>

!!! tip
    The palette is the fastest way to reach a help topic: type a word of its title and press Enter, whatever page you are on.

## The help drawer

Every main screen carries a small question-mark icon beside its title. Click it and a drawer slides in from the right with the help topic of that screen: what the screen is, what each control does, what a destructive action takes with it. The page stays visible behind it. Close it with the cross, with `Esc`, or by clicking outside.

<figure markdown="span">
  ![The help drawer on a classroom](../assets/screenshots/help-drawer-light.png#only-light)
  ![The help drawer on a classroom](../assets/screenshots/help-drawer-dark.png#only-dark)
  <figcaption>The help drawer of the classroom screen, opened from the question mark beside the title.</figcaption>
</figure>

The topics are short and describe one screen each. This guide is the longer version: it walks through the tasks that cross several screens.

## Notifications

The bell beside the account row collects what happened to you while you were elsewhere. Today two things arrive there: a colleague shared a pool with you, naming the role they gave you; and the ownership of a pool was transferred to you. An unread count sits on the bell, **Mark all as read** clears it, and a notification is a link to the pool it talks about.

<figure markdown="span">
  ![The notifications panel](../assets/screenshots/notifications-light.png#only-light)
  ![The notifications panel](../assets/screenshots/notifications-dark.png#only-dark)
  <figcaption>The notifications panel, here with nothing new.</figcaption>
</figure>

Two other events are not stored but shown as a brief toast in the corner while you are signed in: a student joining a classroom, and a roster entry that needs your attention. Both can be switched off in the settings.

## Settings

**Settings** opens from the account menu or from the palette. The **Profile** card shows your picture, which you can change, your role and your last sign-in. Under **Preferences**:

- **Language**: **English** or **Français**. The choice is saved on your account, so it follows you to another browser. The palette's **Switch to Français** entry is the same setting.
- **Appearance**: **Light**, **Dark** or **System**, which follows the operating system.
- **Date format**: how dates and times are written across the portal.
- **Multiple-answer scoring**: the policy that seeds the evaluations you create, for multiple-choice questions with several correct answers. Changing it never moves an evaluation that already exists, and each evaluation keeps its own. The five policies are explained in [Question pools](pools.md).

<figure markdown="span">
  ![The settings page](../assets/screenshots/settings-light.png#only-light)
  ![The settings page](../assets/screenshots/settings-dark.png#only-dark)
  <figcaption>Settings: profile, language, appearance, date format, the default scoring policy and the toast switches.</figcaption>
</figure>

The **Notifications** card holds one switch per toast kind. These switches are stored in the browser you are using, not on your account.

## Keyboard shortcuts

The strip at the bottom of the sidebar always shows what applies to the page you are on. The full list, verified against the current version:

| Where | Keys | What it does |
| --- | --- | --- |
| Everywhere | `Ctrl+K` | Open the command palette |
| Question editor | `Ctrl+S` | Save the draft (it saves itself already) |
| Question editor | `Ctrl+Enter` | Try the question |
| Question editor | `Ctrl+Shift+P` | Publish |
| Question editor | `Ctrl+Shift+M` | Toggle the student preview |
| Live dashboard | `N`, `R`, `S` | Hide or show names, answers, results |
| Live dashboard | `Space` | Pause or resume |
| Live dashboard | `F` | Full screen |
| Live dashboard | `Esc` | Close the inspect panel |
| Grading | `V` | Validate and move on |
| Grading | `O` | Adjust the points |
| Grading | `←`, `→` | Previous or next answer |
| Student player | `Alt+←`, `Alt+→` | Previous or next question |
| Student player | `Ctrl+Enter` | Mark the question as done, or run the code |

On a Mac, `Cmd` replaces `Ctrl` and the strip spells it that way.
