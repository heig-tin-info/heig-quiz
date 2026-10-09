# Administration

The administration screen has one main job: deciding who reaches the teacher interface. It also keeps the platform's shared vocabulary of concepts in order. Everything else, courses, pools and evaluations, is managed by the teachers themselves.

## Who reaches it

The platform has one administrator: the e-mail address named in the server configuration. Signing in with that address, on any of its edu-ID addresses, gives the **Administrator** role, and the **Administration** entry appears in the sidebar. There is no way to name a second administrator from the interface.

## Teacher grants

<figure markdown="span">
  ![The administration screen](../assets/screenshots/admin-light.png#only-light)
  ![The administration screen](../assets/screenshots/admin-dark.png#only-dark)
  <figcaption>Administration: the teacher grants, here still empty.</figcaption>
</figure>

A grant is an e-mail address. Type it in the **E-mail** field and click **Grant**. The address may belong to someone who has never signed in: the row shows "has not signed in yet" until they do, and the role is applied at their first sign-in. If the account already exists, the grant takes effect immediately. The role is recomputed at every sign-in, from every address edu-ID reveals for the account, so a grant issued on the institutional address applies to someone signing in under a private one.

The table lists each grant with the person's name once known, their address, the number of courses they are on, their last sign-in and when the grant was issued. Click a header to sort.

A grant is not the only way to be a teacher. A colleague added to the staff of a course is a teacher for as long as they hold that seat, and edu-ID reports employees as staff, which is enough on its own. Grants are for the cases those two rules miss: an assistant without a staff affiliation, or a teacher who should create their first course before anyone has added them anywhere.

Where the platform has the online workspace, each grant also has a **Workspace** column: its switch lets that teacher put the projects of the courses they own in the workspace, and the number beside it is how many of their students' workspaces may run at once (2 by default). An administrator needs no grant: they may always use the workspace, with the default number.

## Removing a grant

The bin at the end of a row revokes the grant, after a confirmation naming the address. The role is recomputed, not forced: someone who still sits on the staff of a course, or whom edu-ID reports as staff, stays a teacher. Someone with neither goes back to student at once.

The administrator's own address cannot be granted; it is already above the teacher role.

## Kiosk stations

Where the platform has kiosk stations, the **People** tab also lists the school's Chromebooks that attested themselves. A new one appears as **Unnamed**, with its serial number: **Name** it after the sticker on the machine and it becomes **Active**, ready to be paired by students. **Rename** changes that name, **Retire** takes a station out of service (it can no longer be paired, and shows "Station not recognised"), **Reactivate** puts it back. Each row also shows the station's **Last check** (**Attested**, **Google unreachable** or **Refused**) and when it was **Last attested**. Setting the stations up in the Google Admin console is described in [Kiosk stations](../development/kiosk.md).

## Concepts

Questions are classified by concepts (*Notions* in the French interface): one vocabulary for the whole platform, each concept with a label in French and in English. Teachers pick concepts in the question editor and may create a new one, which stays **Proposed** until you review it (see [Question pools](pools.md#the-properties-panel)).

The **Concepts** tab of the administration is where the free tags questions carried before concepts existed were sorted. Each tag of each pool is a row: it becomes a concept, or it is dropped. Spellings of one word (`pointeur`, `Pointeurs`) are grouped, and each group shows its tags, their pools, their question counts and up to two statement excerpts. **Show** switches between **To sort**, **Sorted** and **All**; the search field finds a tag or a pool. Tick rows, then choose a decision for them:

- **Map to a concept**: an existing concept, found by its label.
- **New concept**: a label in French and in English, an optional qualifier for a homonym (*address (memory)*) and a description. It is created **Validated** when you accept, since you have just reviewed it.
- **Drop**, with its reason: **Organisational label** (a chapter, a week, an exam), **Kind of task** (reading or writing code, vocabulary) or **Noise** (a typo, a test, a leftover). A dropped label cannot be created again as a concept, by a teacher or by an assistant connected to the platform.

Nothing is written until **Accept** (the tab's one primary action), which applies the chosen decisions and adds the concept to every question that wears the tag. **Propose with AI** first lets the model suggest a decision for every row still to sort, in the background, with a progress line; it needs an AI key (see the **AI** tab) and counts against the daily cap. A suggestion shows as **Suggested by the model** and is only a suggestion: you accept it, change it or leave it. Without an AI key the tab works the same, by hand.

The sorting of the existing tags is done, but a tag a question still wears and that nobody has decided on stays listed under **To sort**, so nothing is lost: accepting it adds its concept to the questions that still wear it. A row already sorted is read-only, so that re-applying a decision never overwrites a teacher's later edits.

The tab shows the tag names, pool names and excerpts of every pool, private ones included, without Super Powers: it is a one-off curation of the platform's vocabulary, not the reading of a colleague's work.

<!-- screenshot: refresh after cut-over -->

## What an administrator sees elsewhere

By default, nothing more than a teacher: the administrator works on the courses whose staff they are on, and on their pools with the role they hold there. A colleague's course or private pool is out of sight, as for any teacher, so that one's own teaching never touches somebody else's by accident.

## Super Powers

To help a colleague or look into a problem, switch on **Super Powers** in **Settings**. For one hour, every course, classroom, evaluation and pool of the platform opens to you, with the owner role on every pool, and the roster rows offer the link to act as a student. A red banner at the top of every page says so, with the time left and **Switch off**; in the last five minutes it counts down by the second. The hour is fixed and cannot be extended: when it ends, the pages that belong to someone else answer as missing, and a change started on one of them is refused. Switching on and off, and the end of the hour, are recorded in the audit log.

Super Powers belong to the browser session that switched them on: signing out ends them, another browser does not have them, and neither an API token nor a connected assistant ever gets them. The administration screen itself, and the server's metrics endpoint, which answers an administrator's session as well as the monitoring token, need none.
