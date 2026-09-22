# Question types

Four types are available today: multiple choice, short answer, fill in the blanks and code. All are graded automatically and written in the editor described in [Question pools](pools.md). This chapter covers what each form asks for, how the answer is scored and what the student gets.

## Multiple choice

For a question with a closed list of choices, one or several of them correct. Each choice is Markdown like the statement, so a choice can be a line of code or a formula.

### The editor

The form is a list of **Choices**. The letter in front of each one is the toggle that marks it correct (a filled letter is a key), the handle on the left reorders by drag or with the keyboard, and **Add a choice** or Enter appends one. Two choices at least, twelve at most. The figure in [Question pools](pools.md#the-question-editor) shows it.

Whether the question is single or multiple is decided by the ticks, not by a setting: one correct choice makes it a single-answer question, two or more make it a multiple-answer question and reveal two more options.

- **Scoring policy**: how a partly right answer is scored (below). **Inherited** by default.
- **Maximum selections**: how many choices a student may tick. Empty means no limit, and it cannot be lower than the number of correct choices.

**Never shuffle this question**, in the **Scoring** card, keeps the choices in your order even when the evaluation shuffles choices. Use it when a choice refers to the others.

### How it is graded

A single-answer question is always all or nothing. A multiple-answer question is scored by a policy, resolved through three levels, each overriding the one above it:

1. your preference in **Settings**, which seeds the evaluations you create and nothing else;
2. the evaluation, under its advanced options, for every question it plays;
3. the question itself, **Inherited** by default, free to name a policy of its own.

The policies are named below as the editor, the evaluation options and **Settings** name them, with the wording of the in-app help in parentheses. With `C` correct choices, `W` wrong ones, `c` correct ones ticked and `w` wrong ones ticked:

| Policy | Score | In words |
| --- | --- | --- |
| **Exact** (all or nothing) | 1 if the ticked set is the key, else 0 | the exact set of correct choices, or nothing |
| **True/false** (true/false per choice) | `(c + (W - w)) / (C + W)` | every choice is its own true/false item; ticking nothing already scores `W / (C + W)` |
| **Distance** (discordances) | `d = (C - c) + w`: 0 gives 1, 1 gives 0.5, 2 gives 0.2, more gives 0 | by the number of choices got the wrong way round |
| **Symmetric** | `c/C - w/W` | a wrong tick costs what a right one earns; random ticking is worth nothing on average |
| **Ripkey** | `c/C`, or 0 as soon as `w > 0` | pays a student who ticks only what they are sure of |

No policy ever goes below zero: answering is never worse than leaving the question blank. The result is multiplied by the points of the item.

### What the student sees

<figure markdown="span">
  ![The player on a multiple-choice question](../assets/screenshots/player-mcq-light.png#only-light)
  ![The player on a multiple-choice question](../assets/screenshots/player-mcq-dark.png#only-dark)
  <figcaption>A single-answer question in the player, its choices shuffled for this student.</figcaption>
</figure>

The choices are large buttons with a letter, under the hint **Choose one answer.** or **Choose every correct answer.** The letters follow the student's order, not yours, when the evaluation shuffles. The answer is saved as it changes, and a question marked done shows a **Done** badge.

!!! tip
    Write wrong choices that a student with a specific misconception would pick. A choice nobody picks teaches you nothing in the results.

## Short answer

For an answer that is one value: a word, a number, a date or a time. The student types it, the grader compares it to your accepted answers.

### The editor

<figure markdown="span">
  ![The editor of a short-answer question](../assets/screenshots/editor-short-light.png#only-light)
  ![The editor of a short-answer question](../assets/screenshots/editor-short-dark.png#only-dark)
  <figcaption>A short-answer question: the kind of answer, the field constraints, the prefilters and the accepted answers.</figcaption>
</figure>

**Expected answer** picks the kind: **Text**, **Number**, **Date** or **Time**. It decides what the student's field is, and the constraints on the same line decide what that field takes:

| Kind | Constraints | The student's field |
| --- | --- | --- |
| **Text** | **Min length**, **Max length** (500 at most) | a text field |
| **Number** | **Min**, **Max**, **Integer** | a number field; a comma or a dot both work |
| **Date** | **From**, **To** | a date field |
| **Time** | none | a time field |

A constraint says what the field accepts, never what the answer is: the student is stopped while typing, and nothing gives the key away. Only **Integer** reaches the grade: a non-integer answer to a whole-number question is wrong, whatever the accepted answers say. A **Placeholder** shows in the empty field.

**Prefilters** are two normalisations decided once for the whole question, applied to the student's answer and to every accepted text before the comparison. **Trim** removes leading and trailing spaces; **Lowercase** compares without regard to case, accents staying significant. Runs of spaces inside an answer are always collapsed to one.

**Accepted answers** is a list of matchers, evaluated in order; the first that matches wins. Each one carries **Points**, the share of the item it awards, so a second matcher can accept a partially correct answer for less.

| Matcher | Fields | Accepts |
| --- | --- | --- |
| **Exact text** | **Value** | equality after the prefilters |
| **Regular expression** | **Pattern**, **Flags** | a full match on the prefiltered input; the `i` flag stays the pattern's own |
| **Number** | **Value**, **Tolerance**, **Absolute** or **Relative (%)**, optional **Unit** and **Unit required** | a numeric comparison within the tolerance |
| **Date** | **Value**, **Tolerance (days)** | a date within the window |
| **Time** | **Value**, **Tolerance (minutes)** | a time within the window |

A number matcher whose value is not an integer in an **Integer** question is refused at publication. The **LLM rubric** matcher is listed for a later phase and cannot be published yet.

### How it is graded

The prefilters run, then the matchers in order. The student earns the points of the first matcher that accepts the answer, and zero when none does. The review shows the student's answer and, when feedback allows it, which matcher accepted it.

### What the student sees

<figure markdown="span">
  ![The player on a short-answer question](../assets/screenshots/player-short-light.png#only-light)
  ![The player on a short-answer question](../assets/screenshots/player-short-dark.png#only-dark)
  <figcaption>A short-answer question in the player: one field, with the placeholder written by the teacher.</figcaption>
</figure>

One field under **Your answer**, with a hint that says what to type.

!!! tip
    Put the most precise matcher first and the most tolerant last. With **Lowercase** on, `const` and `CONST` are the same answer, so one exact matcher usually does; add a regular expression only for genuine spelling variants.

## Fill in the blanks

For a text, a formula or a piece of code with holes in it. The student fills each hole; each is graded on its own.

### The editor

<figure markdown="span">
  ![The editor of a fill-in-the-blanks question](../assets/screenshots/editor-cloze-light.png#only-light)
  ![The editor of a fill-in-the-blanks question](../assets/screenshots/editor-cloze-dark.png#only-dark)
  <figcaption>A fill-in-the-blanks question: three blanks in a code block, and the table of what the parser understood.</figcaption>
</figure>

The **Text with blanks** is the same rich field as any statement, and a blank is an object in it. Type `{{`, press the blank button in the toolbar (**Insert a blank**), or click a blank already there: a card opens under it and asks for the **Kind of blank**:

- **Any of these**: one accepted answer, or several, one per line, with **Add an answer**.
- **Dropdown**: a list of options, the right ones ticked **Correct**. The student picks from a menu.
- **Number**: a **Value** and a **Tolerance**, absolute (**±**) or in percent.
- **Regex**: a **Pattern** and its **Flags**.

Every kind takes a **Weight**, 1 by default, for a blank worth more than the others.

Outside a code block, the chip shows what it stands for at a glance: one answer in red, the first of several answers in blue with a `+2`, a dropdown with a `▾`. Hover it and the whole list appears, ticks included. A blank can sit in a table cell, and it can sit inside a fenced code block, where it stays plain text so that "complete this code" reads as code. The **Blanks** table under the field lists what the parser understood, in order of appearance, with the kind, the weight and the expected value: if a blank is missing there, it is not a blank yet.

Two options apply to the whole question: **Case sensitive**, off by default, and **Shuffle the dropdown options**, on by default.

The raw syntax is what is stored, and the **Markdown source** button shows it:

| Written | Meaning |
| --- | --- |
| `{{Newton}}` | a text field, answer `Newton` |
| `{{Newton\|Isaac Newton}}` | accepted alternatives |
| `{{=Newton\|Maxwell\|Faraday}}` | a dropdown, `=` marks the correct option |
| `{{#3.14:0.01}}` | a number with an absolute tolerance |
| `{{#3.14:1%}}` | a number with a relative tolerance |
| `{{/^[0-9a-f]+$/i}}` | a regular expression |
| `{{2*Newton}}` | weight 2 for this blank |
| `\{{` | literal braces in the text |

Inside a blank, a backslash makes a punctuation character literal: `\|`, `\}`, `\*`, `\\`. An answer that starts with `#`, `/` or `=` needs one, or it would become a number, a regex or a dropdown.

### How it is graded

Each blank is right or wrong on its own. The score is the sum of the weights of the correct blanks over the sum of all weights, multiplied by the points of the item: three blanks of weight 1 and two right give two thirds of the points. Text is compared after trimming, and without regard to case unless **Case sensitive** is on.

### What the student sees

<figure markdown="span">
  ![The player on a fill-in-the-blanks question](../assets/screenshots/player-cloze-light.png#only-light)
  ![The player on a fill-in-the-blanks question](../assets/screenshots/player-cloze-dark.png#only-dark)
  <figcaption>The same question in the player: a field at each blank, inside the code block.</figcaption>
</figure>

The text as you wrote it, with a field or a menu at each blank, and the note **Fill every blank. Your answers are saved as you type.** A dropdown shows **Choose…** until the student picks.

!!! tip
    A dropdown is the right kind when the answer has a small closed set of forms, such as `<` against `<=`; a text blank is the right kind when a student should produce the value, not recognise it.

## Code

For a program or a function the student writes, compiled and run against test cases. The editable part is yours to delimit, and the student's trial runs and the grade are two different things.

### The editor

<figure markdown="span">
  ![The editor of a code question](../assets/screenshots/editor-code-light.png#only-light)
  ![The editor of a code question](../assets/screenshots/editor-code-dark.png#only-dark)
  <figcaption>A code question: the statement, the language, where the trial runs, and the starting code with its locked region.</figcaption>
</figure>

**Language** is one of `c`, `cpp`, `python`, `js` or `rust`. **Run in** decides where the student's **Run** button executes: **The server** (the default) or **The browser**, which is available for C and Python only.

**Starting code** is the template the student receives. The lines between a `@@lock` and an `@@endlock` comment are read-only; everything else is an editable region, and there can be several, one per function to complete. The badge counts the locked regions, and **What the student can edit** shows the split as the player will.

The **Reference solution** is your own answer to the editable regions, in their order, separated by a `@@next` comment line when there are several. It serves one button, **Try the reference solution**, which runs it against every case and reports how many pass. A student never sees it.

**Test cases** is the list the program is checked against. Each case has:

- a **Name**, shown to the student when the case is visible;
- **Arguments**, one per line, handed to the program as its command line (`argv[1..]`, `sys.argv[1:]`, `process.argv.slice(2)`), never through a shell;
- **stdin**, what the program reads;
- **Expected output** and **Compare the output**, which can be switched off;
- **Exit code**, 0 by default, empty to accept any; a crash still fails the case;
- **Hidden**, **Points** and an optional **Time (ms)** for this case alone.

A case must check at least one of the output and the exit code. A visible case is shown to the student, command line and expected output included, and can be run before handing in; a hidden case runs only at grading, and the player says only how many there are and what they are worth. The points of the question are the sum of the cases' points.

**Advanced options** hold the **Action** (**Compile only** or **Compile and run**), the **Compiler arguments**, the **Time limit (ms)**, **Memory (MB)** and **Output (KB)**, the **Runs per minute** a student may spend, **All or nothing**, and the **Output comparison**: **Ignore trailing whitespace**, **Ignore case**, and a **Numeric comparison** with an **Epsilon** for programs that print floating-point results.

### The trial run and the grade

<figure markdown="span">
  ![Trying a code question in the editor](../assets/screenshots/try-code-light.png#only-light)
  ![Trying a code question in the editor](../assets/screenshots/try-code-dark.png#only-dark)
  <figcaption>Trying the question with the template as it is: the visible cases fail, the grade is 0 of 5, and the reference solution is shown to the teacher.</figcaption>
</figure>

**Run** compiles the program and runs the visible cases. **Compiled** means the compiler accepted the program; **Compilation failed** shows the compiler's output instead. Each case then gets a verdict: **Passed**, **Output differs**, `exit 1 ≠ 0`, **Timed out**, **Out of memory** or **Crashed**. A case fails first on an accident, then on any enabled check that does not hold.

Where that run executes depends on **Run in**. On the server, it goes through the code runner. In the browser, it runs inside the page: the first run downloads the language runtime once (**Loading the language runtime… this happens once.**), after which every trial is immediate and costs the server nothing. The player then says so, and reminds the student that the server grades.

The grade is always the server's. At grading, the file is rebuilt from your template and the student's editable regions, then compiled and run against every case, hidden ones included, in a sandboxed container with no network. The browser runtime is not Linux, so a trial that passes there can still fail at grading, which is why the player calls it a trial. [Architecture](../development/architecture.md#a-code-question-two-runners) describes the sandbox and the two runners.

!!! warning
    A machine without a container engine has no code runner. There, **Run** on the server answers **The runner is unavailable**, and the grading pass leaves the answer waiting for a manual grade, with the message "The runner was unavailable; this answer is waiting for a manual grade." The teacher grades it from the [grading panel](grading.md), where the code and the reference solution are side by side.

### What the student sees

<figure markdown="span">
  ![The player on a code question](../assets/screenshots/player-code-light.png#only-light)
  ![The player on a code question](../assets/screenshots/player-code-dark.png#only-dark)
  <figcaption>A code question in the player: the locked part greyed out, the editable region in the code editor.</figcaption>
</figure>

The statement, the language and the limits (`2000 ms · 128 MB`), the locked part of the template greyed out, and a code editor for each editable region. Under it, **Visible cases** with a **Run** button, and **Try it yourself** for a run on the student's own **Arguments** and **stdin**, which nobody grades.

<figure markdown="span">
  ![The visible cases after a run](../assets/screenshots/player-run-light.png#only-light)
  ![The visible cases after a run](../assets/screenshots/player-run-dark.png#only-dark)
  <figcaption>After Run: Compiled, every visible case Passed, and the hidden cases announced with their points.</figcaption>
</figure>

After **Run**, the table shows for each visible case its stdin, the expected output, the output obtained and the verdict, then how many hidden cases exist and what they are worth.

!!! tip
    Give one or two visible cases that show the input format, and keep the discriminating ones hidden. Run **Try the reference solution** before publishing: a case your own solution fails is a case nobody can pass.

## Comparison

| Type | Auto-graded | Partial credit | On a phone | Typical use |
| --- | --- | --- | --- | --- |
| Multiple choice | yes | yes, with a policy | yes | a concept check, a poll, a quick recall |
| Short answer | yes | yes, per matcher | yes | a keyword, a computed value, a date |
| Fill in the blanks | yes | yes, per blank | yes, with short blanks | complete a sentence, a formula or a line of code |
| Code | yes, on the server | yes, per case | not comfortably | write or complete a function against test cases |

## Planned types

The specification announces more types for later phases. None is available today:

- **Rich answer**: a free text graded against a rubric, with your validation.
- **Drawing**: a small canvas with shapes and freehand strokes, graded with a rubric.
- **Code with image**: a code question whose program writes an image, compared pixel by pixel to yours.
- **Circuit**: components placed on a grid and wired, graded with a rubric.

Random values in a statement, announced for phase 2, are not available either.
