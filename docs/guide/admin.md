# Administration

The administration screen has one main job: deciding who reaches the teacher interface. Everything else, courses, pools and evaluations, is managed by the teachers themselves.

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

Questions are classified by concepts (*Notions* in the French interface): one vocabulary for the whole platform, each concept with a label in French and in English. Teachers pick concepts in the question editor and may create a new one, which stays **Proposed** (see [Question pools](pools.md#the-properties-panel)).

The **Concepts** tab of the administration is the curation queue of that vocabulary. It lists every concept, those teachers proposed first, with the number of questions of the whole platform that use it (a number only: the pools and statements stay out of reach without Super Powers), who proposed it and when. Filter by **To validate** or **Validated**, or search a label in either language.

- **Validate** accepts a proposed concept. It is disabled while the concept has no label in French or in English: the row says which one is missing. Open the concept with **Edit** to add it.
- **Edit** opens the concept: label, qualifier (what tells *Address (memory)* from *Address (network)*) and description, in both languages. A label another concept already holds is refused.
- **Merge into…**, in the same sheet, folds a duplicate into another concept. Search the **validated** concept that stays (it keeps its labels): the dialog shows how many questions use each and says what happens before you confirm. Every question that used the merged concept now uses the one you picked, the deleted questions of the pools included, and a question that had both keeps one. The merged concept leaves the list and its label no longer designates anything. A merge cannot be undone from the application: choose the target with care. Only a validated concept can be a target, so validate a proposed one first.
- **Delete concept**, in the same sheet, is possible only while nothing refers to the concept. Otherwise it stays disabled and says why: a question uses it, or a deleted question or a merged concept still points to it.

Aliases and the detection of probable duplicates come next. The free tags that questions carried before concepts existed are gone, and so is the administration's former **Concepts** tab where they were sorted. A label the administrator dropped during that sorting (a chapter, a week, a kind of task, noise) still cannot be created again as a concept, by a teacher or by an assistant connected to the platform.

## What an administrator sees elsewhere

By default, nothing more than a teacher: the administrator works on the courses whose staff they are on, and on their pools with the role they hold there. A colleague's course or private pool is out of sight, as for any teacher, so that one's own teaching never touches somebody else's by accident.

## Super Powers

To help a colleague or look into a problem, switch on **Super Powers** in **Settings**. For one hour, every course, classroom, evaluation and pool of the platform opens to you, with the owner role on every pool, and the roster rows offer the link to act as a student. A red banner at the top of every page says so, with the time left and **Switch off**; in the last five minutes it counts down by the second. The hour is fixed and cannot be extended: when it ends, the pages that belong to someone else answer as missing, and a change started on one of them is refused. Switching on and off, and the end of the hour, are recorded in the audit log.

Super Powers belong to the browser session that switched them on: signing out ends them, another browser does not have them, and neither an API token nor a connected assistant ever gets them. The administration screen itself, and the server's metrics endpoint, which answers an administrator's session as well as the monitoring token, need none.
