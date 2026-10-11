# The training course

The training course is a course of your own, created on request, where you learn the platform by doing the loop it exists for: take a quiz as a student, run one in front of a class, write a question and put it in a test, then try the tools around. It holds one classroom, two quizzes already written, and a card that follows your progress. No student is ever in it, and nothing you do there counts anywhere.

You are never graded. A teacher's own attempts are flagged *staff*, stay out of every statistic, and earn nothing; the quizzes are there to be looked at from both sides.

## Starting it

The first time you sign in, the **Courses** home is empty and offers **New course**. Under that button, a line says *First time here? Start with the training course*: click it, and the course is created with its classroom and its two quizzes, then opened on the classroom's **Activities** tab, where the card is.

If your home is not empty, because a colleague already put you on the staff of a course, the entry is **Training course** in the account menu at the bottom of the sidebar, and in the **Help** group of the command palette (`Ctrl+K`). Each of the three opens the same course: there is one per teacher, and asking again opens it rather than making a second one.

The course is named for you and gets a free code of the form `INIT-1`. It is an ordinary course in every other respect: rename it, change its code, link pools to it, and delete it from its **Settings** tab like any other. None of these entries is shown while an administrator has not installed the training content on the platform.

## The card

At the top of the classroom's **Activities** tab, a card lists the four missions below, each **to do** or **done**, read from what you actually did. Its one highlighted action is the next mission to do, and it leads to the screen, or the control, where that mission happens; it never performs the gesture for you, because the point is to learn where the gesture is. While a mission remains, **New ▾** on that tab steps aside; the other tabs keep their own actions. Mission 4 is optional: the card says *all done* after the first three, and links back here.

## Mission 1: Be a student

Two gestures take you to the student side, and you will need both later to rehearse your own exams.

1. On the classroom page, click **Join as student**, beside the primary action. It gives you a seat in your own classroom, flagged *staff* (see [Courses and classrooms](classrooms.md#join-as-student)).
2. In the account menu, choose **Switch to student view**. The classroom now shows what a student gets: **Le quiz d'accueil** is open, an exercise scheduled from the moment the course was created until the end of the classroom's period.

Take it. Seven questions, one per type that the platform grades by itself, in free navigation, corrected as soon as each is validated, and you may retake it as often as you like. Each statement is about the platform, its answer is on the screen around it, and its correction says what you would configure to obtain the behaviour you just saw. On a platform without a code runner, the circuit and the code question are graded as proposals rather than at once (see [When the runner is unavailable](grading.md#when-the-runner-is-unavailable)).

Hand in, then **Back to teacher view** in the banner. The mission is done once you handed in an attempt.

## Mission 2: Run a class

**Le quiz en direct** is a draft in Exam mode, Live: the three configuration steps are yours to read (see [Evaluations](evaluations.md)). Open it from **Activities** and go through them; at **Modalité**, give it a time limit per student (ten minutes is enough), since a live exam must end by itself; on **Launch**, the checklist says what blocks the start and what deserves a look, beside a preview of the waiting room.

1. **Open the waiting room**: you are on the dashboard (see [Running an evaluation](live.md)).
2. Open a second tab on the platform and switch it to the student view; the view is per tab, so the dashboard stays a teacher's. Enter the waiting room from the student's home.
3. **Start** on the dashboard. In the student tab, answer the four questions: an essay in two sentences, a flowchart of the life of an evaluation, and two questions of the welcome quiz again. Hand in.
4. **Close** on the dashboard, then **Go to grading**. The multiple choice and the fill in the blanks arrive validated; the essay and the diagram wait for you, with the AI's proposal and its justification when the platform has a model (see [Grading and results](grading.md#essays-diagrams-and-ai-proposals)). Validate or adjust them.
5. On the results page, **Publish results**. Back in the student tab, read the released grade and the feedback the policy allows.

The mission is done once an evaluation of the course is released.

## Mission 3: Make it yours

This mission puts a question of yours into a copy of the welcome quiz.

1. On **Question pools**, **New pool** (see [Question pools](pools.md)). On the training course's page, **Linked pools** tab, **Link a pool** and pick it.
2. In the pool, create a question. Let the wand write what you leave empty — the answer, the explanation — then **Try** it, and **Publish**.
3. In the welcome quiz's menu, **Save as template**; on the course page's **Templates** tab, instantiate it into the classroom and add your question to it.
4. Edit your question and publish it again: the evaluation's **Questions** step shows the *newer version* badge, and you choose to update or not.
5. **Student preview** walks the evaluation stateless, in its own tab. Then take it for real from the seat of mission 1, and reset your own attempt from the row's menu.

The mission is done once a published question exists in a pool linked to the course for editing, and the course holds a template.

## Mission 4: The tools around

Two tools sit beside the screens. Ask the help assistant, the bubble at the bottom right, *how do I give a student extra time?* and let it open the roster for you (see [Getting started](getting-started.md#the-help-assistant)). Then connect an AI assistant to your account from **Settings › API tokens** (see [AI assistants (MCP)](assistants.md)), ask it for a question in your pool, and find it there.

The mission is done once you hold a token or a connected assistant, or had a conversation with the help assistant. It reads *unavailable* on a platform with neither a model nor the OAuth server configured; it is optional in every case.

The journal, the projects and the groups are not missions: their chapters are [The journal](journal.md), [Projects](projects.md) and [Groups](groups.md).

## Restarting

Delete the course from its **Settings** tab, then start again from the same entry: a fresh course, both quizzes as they were, a card at zero. A pool you made in mission 3 is yours and stays, with its questions; the template, the seat and the attempts go with the course.

## What is not in it

No roster (the only seat is yours, since a roster line admits a sign-in), no [Safe Exam Browser or kiosk station](evaluations.md#safe-exam-browser) (both need a configured client), no impersonation (an administrator's tool), no [GitHub project](github.md) (it needs an organization) and no [poll](polls.md) (one question on the wall, not a quiz).

The questions of the training live in one public pool, **Prise en main de Quiz**, owned by the platform's administrator and linked to your course for reading. You will find it in the catalogue of public pools like any other, and its statements are about the platform, so they collide with no course of yours.
