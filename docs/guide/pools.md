# Question pools

A pool is where your questions live: a tree of categories, a vocabulary of tags, and one history of published versions per question. It belongs to you, not to a course: one pool can feed several courses, and a course can draw on several pools. You get a private pool the first time you sign in, and nobody else sees it until you share it.

## The pools page

**Question pools** in the sidebar lists every pool you can reach: yours, and those a colleague shared with you. Each card shows the pool's icon, its name, the number of questions it holds and a visibility badge (**private**, **shared with 1**, **public**). The toggle at the top right switches between **Cards** and **List**.

<figure markdown="span">
  ![The pools page, two pools as cards](../assets/screenshots/pools-light.png#only-light)
  ![The pools page, two pools as cards](../assets/screenshots/pools-dark.png#only-dark)
  <figcaption>The pools of a teacher: one card per pool, with its icon, its question count and its visibility.</figcaption>
</figure>

**New pool** creates one from a name. The menu at the end of a card offers **Rename pool**, **Change icon**, **Share…** and **Delete pool**. Renaming touches the name only. Deleting takes the questions and the categories with it, after a confirmation that names the pool.

!!! note
    The question count includes drafts never published. A deleted question disappears from the pool and from the count, but an evaluation that already uses it keeps resolving it: results are never lost to a deletion.

A pool is offered when you fill an evaluation only once it is linked to the course, from the course card on **Courses**. Unlinking removes that offer and nothing else. See [Evaluations](evaluations.md).

## Opening a pool

A click on a card opens the pool: its categories in the sidebar, its questions in the table.

<figure markdown="span">
  ![A pool open, with its categories and its question table](../assets/screenshots/pool-light.png#only-light)
  ![A pool open, with its categories and its question table](../assets/screenshots/pool-dark.png#only-dark)
  <figcaption>A pool: the category tree under its name in the sidebar, one row per question in the table.</figcaption>
</figure>

### Categories

The sidebar shows **All questions**, then the tree of categories. Picking a category narrows the table to it. The menu beside each category offers **Rename category**, **New subcategory**, **Move up**, **Move down** and **Delete category**. **New category** at the bottom of the tree adds one at the root.

Deleting a category never deletes a question: its questions move back to the root of the pool.

### Search and filters

The search field matches the internal name and the statement. **Filters** opens a sheet with the type, the difficulty, the tags and **Show deleted questions**.

<figure markdown="span">
  ![The filters sheet of a pool](../assets/screenshots/pool-filters-light.png#only-light)
  ![The filters sheet of a pool](../assets/screenshots/pool-filters-dark.png#only-dark)
  <figcaption>The filters: type, difficulty, tags, and the switch that shows deleted questions.</figcaption>
</figure>

Everything you tick comes back as removable chips under the search bar, with the number of questions left. The search field accepts the same filters as words, which is faster once you know the vocabulary:

| Typed | Meaning |
| --- | --- |
| `tag:pointers` or `tag:#pointers` | the questions wearing that tag |
| `type:mcq`, `type:short`, `type:cloze`, `type:code` | that question type |
| `difficulty:3` | exactly 3 |
| `difficulty:>3`, `difficulty:>=2`, `difficulty:<3`, `difficulty:<=4` | a bound |
| `difficulty:2-4` | a range |
| `version:v2` or `version:2` | published version 2 |
| `version:>1`, `version:>=2`, `version:<3`, `version:1-3` | a bound, a range |
| `"a whole phrase"` | those words together |

Anything else is free text. Several `tag:` words add up, and two `version:` bounds narrow each other. Words and ticks are the same filter: both appear as chips, and removing a chip removes the word from the field. Right after `tag:` or `type:`, a short list opens under the field; arrows move through it, Enter inserts, Escape closes.

### Cards, table, grouping and sort

**Group by** splits the list by **Type**, **Tags** or **Category**; a question with three tags appears in each of its three sections. **Sort by** orders it by **Updated**, **Name**, **Type**, **Difficulty** or **Version**, the arrow beside it reverses the order, and a column header does the same for the whole pool. The toggle at the right switches between **Cards** and **List**. These choices are remembered for your next visit.

### Row actions and bulk actions

Each row shows the type as an icon, the internal name, the tags, the difficulty as five dots, the published version and the last change. A click opens the editor; the three icons at the end of the row are **Edit**, **Duplicate** and **Delete**.

Tick several rows and a bar appears at the bottom: **Add a tag**, **Move to a category**, **Delete**. Deleting hides the questions from the lists; the results already recorded are kept.

## Creating a question

**New question** asks for the **Question type** and the **Internal name**, then **Create question** opens the editor. The name is yours alone, a student never sees it; a stable convention such as `prg1-boucle-for` is what you will search for later.

## The question editor

<figure markdown="span">
  ![The editor of a multiple-choice question](../assets/screenshots/editor-mcq-light.png#only-light)
  ![The editor of a multiple-choice question](../assets/screenshots/editor-mcq-dark.png#only-dark)
  <figcaption>The editor: the statement and the form of the type on the left, the properties on the right, the shortcuts in the sidebar.</figcaption>
</figure>

### The draft saves itself

You always edit the draft. It is saved shortly after you stop typing, and the badge beside the title tells you where you stand: **Saving…** then **Saved**. Next to it, **draft** or **published v1** says whether a version exists. An incomplete draft is stored as it is; publishing is what asks for the missing pieces.

### Three tabs

- **Edit** holds the statement, the form of the type, the explanation and the properties.
- **Try** lets you answer your own question and grade it on the spot. Nothing is recorded.
- **Versions** lists every publication with its change note.

### The properties panel

On the right: the **Internal name**, the **Category**, the **Difficulty** from 1 to 5, and the **Tags**. The tag field suggests the vocabulary already used in the pool, with the number of questions wearing each tag and its one-line description. Pick an existing tag rather than typing a synonym: two spellings of the same idea split the pool in two. A new word is offered as **Create "…"**, and you describe it on the spot with **Add a description**; that line is what the next teacher reads. Backspace in the empty field removes the last tag.

A multiple-choice question also shows a **Scoring** card with **Never shuffle this question**, for a choice list whose order matters, such as "all of the above".

### Writing the statement

The statement is written as in a word processor. Markdown is stored underneath, so `**bold**`, `$x^2$` for a formula and a fenced code block work if you prefer typing them. The toolbar offers bold, italic, inline code, a code block, a formula, an image, a table, a link and the **Markdown source**. A pasted or dragged image is uploaded and referenced by a stable id. The table button inserts a 3 by 3 table; with the caret inside one, the **Table** menu adds and removes rows and columns.

### The explanation

The explanation is why the answer is the answer, in your own words. A student answering never receives it: they read it only when the evaluation's feedback policy carries **Show the explanation**, and only once feedback is open, never while the attempt runs (see [Grading and results](grading.md)). Write the reasoning a student who got it wrong needs, not the answer key, which travels on its own.

## Trying a question

The **Try** tab shows the question as a student sees it. Answer it, then click **Grade my answer**: the score and the correction appear below, exactly as the grader will compute them. **Try again** clears the answer.

<figure markdown="span">
  ![The Try tab, an answer graded](../assets/screenshots/try-mcq-graded-light.png#only-light)
  ![The Try tab, an answer graded](../assets/screenshots/try-mcq-graded-dark.png#only-dark)
  <figcaption>Trying a question: the answer is graded on the spot and nothing is recorded.</figcaption>
</figure>

!!! tip
    Try a question before you publish it. A wrong answer key found here costs one click; found after a test, it costs a regrade.

## The student preview

**Student preview** (`Ctrl+Shift+M`) opens a panel under the properties that shows the draft exactly as a student receives it: no internal name, no tags, no key, no explanation.

<figure markdown="span">
  ![The student preview panel in the editor](../assets/screenshots/editor-preview-light.png#only-light)
  ![The student preview panel in the editor](../assets/screenshots/editor-preview-dark.png#only-dark)
  <figcaption>The student preview: the statement and the choices, and nothing a student is not meant to see.</figcaption>
</figure>

## Publishing

Only a published version can be used in an evaluation; the draft never is. **Publish** (`Ctrl+Shift+P`) validates the draft against the rules of its type. If something is missing, the dialog lists it under **The draft cannot be published yet** and nothing happens. Otherwise it asks **What changed**, one optional line for the version history, and creates the next version number. A toast confirms **Version n published.**

<figure markdown="span">
  ![The publish dialog](../assets/screenshots/editor-publish-light.png#only-light)
  ![The publish dialog](../assets/screenshots/editor-publish-dark.png#only-dark)
  <figcaption>Publishing: one optional line for the version history.</figcaption>
</figure>

A published version never changes. Fixing an answer key means publishing again, which creates v2 and leaves v1 as it was.

### Versions

The **Versions** tab lists every publication: its number, its date, its note, and a **current** badge on the latest one.

<figure markdown="span">
  ![The Versions tab of a question](../assets/screenshots/editor-versions-light.png#only-light)
  ![The Versions tab of a question](../assets/screenshots/editor-versions-dark.png#only-dark)
  <figcaption>The version history: one row per publication, with its change note.</figcaption>
</figure>

The menu at the end of a row offers three actions. **View this version** shows it read-only. **Restore into the draft** replaces the current draft with that version, after a confirmation, since what is not published is lost. **Deprecate** marks the version with a reason (**Why**); an evaluation that still uses it shows a **deprecated** badge to its teacher so they can swap it for a newer version.

### How a version reaches an evaluation

When you add a question to an evaluation, the evaluation freezes the published version of that moment. Publishing v2 afterwards changes nothing in a test already built: its items show **version 2 available** and you decide whether to update them. See [Evaluations](evaluations.md).

## Sharing a pool

**Share…** in a pool's menu opens the sharing sheet.

<figure markdown="span">
  ![The sharing sheet of a pool](../assets/screenshots/pool-share-light.png#only-light)
  ![The sharing sheet of a pool](../assets/screenshots/pool-share-dark.png#only-dark)
  <figcaption>Sharing a pool: its visibility, who has access, and an invitation by e-mail.</figcaption>
</figure>

**Visibility** has three settings. **Private** is you alone, plus the teachers you invite. **Shared** is the invited teachers, each with the role you give them; inviting someone into a private pool switches it to shared by itself. **Public** lets every teacher of the school read the pool, while writing stays with you and your members.

**Invite a teacher** takes an e-mail address and a **Role**:

| Role | May |
| --- | --- |
| **Reader** | open the pool and read its questions |
| **Contributor** | also write: questions, categories, tags, images |
| **Owner** | also manage the members, the name, the icon, the visibility and the deletion |

A reader sees the questions and none of the actions: no **New question**, no edit, no duplicate, no delete, no tick boxes. Opening a question still works, since reading one means opening it.

The invited teacher gets a notification under the bell of the sidebar, "… shared the pool … with you as reader", and the pool appears on their pools page. **Remove** beside a member takes their access away; a member can also **Leave pool** from their own list.

!!! note
    A named seat wins over the course rule. The staff of a course linked to a pool can write in it; a colleague you explicitly name **Reader** stays a reader even when they teach that course.

### If the owner leaves

When a teacher leaves the school, each pool they own passes to its first member, the one added earliest, who is notified: "You are now the owner of …". A pool with no member keeps its owner and stays reachable through its courses. The person who inherits is always someone already working in the pool.

## Keyboard shortcuts of the editor

| Keys | Action |
| --- | --- |
| `Ctrl+S` | Save the draft now |
| `Ctrl+Enter` | Open the **Try** tab |
| `Ctrl+Shift+P` | **Publish** |
| `Ctrl+Shift+M` | Toggle the **Student preview** |
| `Ctrl+K` | Open the command palette, which carries the same actions |

The **Shortcuts** strip at the bottom of the sidebar lists them while the editor is open.
