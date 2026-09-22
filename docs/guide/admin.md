# Administration

The administration screen has one job: deciding who reaches the teacher interface. Everything else, courses, pools and evaluations, is managed by the teachers themselves.

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

## Removing a grant

The bin at the end of a row revokes the grant, after a confirmation naming the address. The role is recomputed, not forced: someone who still sits on the staff of a course, or whom edu-ID reports as staff, stays a teacher. Someone with neither goes back to student at once.

The administrator's own address cannot be granted; it is already above the teacher role.

## What an administrator sees elsewhere

The administrator reaches every course and every classroom, not only those whose staff they are on, and holds the owner role on every pool. The server's metrics endpoint answers an administrator's session as well as the monitoring token, which is a matter for whoever runs the machine rather than for this screen.
