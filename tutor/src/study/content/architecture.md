# Architecture
id: architecture
blurb: Making design decisions on purpose, writing them down, and drawing a system at the right level for each reader. Source-first: you read the original authors, and Tutor checks what you write.
why: Clients pay an architect for decisions they can read, question and audit later. This module trains the habit of goals before technology, decisions with their costs, and diagrams and documents in shapes that people in German-speaking countries already know (arc42, C4).
stage: decide | Deciding on purpose | Separate constraints from goals, and record a decision with its costs.
stage: draw | Drawing and writing it down | Draw the system at the right level, and put every kind of information in its place.
stage: judge | Judging what you read | Use provider frameworks as checklists, then design a small system end to end.

## Goals, constraints and trade-offs
id: goals
stage: decide
minutes: 45
goal: Tell a constraint from a quality goal, and write goals that someone could test.
source: arc42: Introduction and goals | https://docs.arc42.org/section-1/
source: arc42: Quality requirements | https://docs.arc42.org/section-10/
source: AWS Well-Architected Framework (the vocabulary of quality goals) | https://aws.amazon.com/architecture/well-architected/
source: Gregor Hohpe, The Architect Elevator (articles) | https://architectelevator.com/

**The question:** what must this system do well, and what are we not allowed to give up?

**Read** the sources above, in that order. Keep one running example in mind: a small Swiss company puts its PDF invoice service online. Two people run it part-time, the budget is about 300 CHF a month, and the contract says invoice data stays in Switzerland.

**Look for:**
- how arc42 separates what *limits* your design from what you *optimise* (read its short list of top quality goals, and note how many it suggests);
- that its quality requirements are written as situations ("when X happens, Y within N"), not as adjectives;
- how the framework pillars give you words for goals, and how a goal in one pillar costs something in another.

**Working rule used in these exercises:** a *constraint* is not negotiable (a contract clause, a law, a fixed budget). A *goal* is something you rank and trade. "Fast", "secure" and "scalable" are not goals until they come with a number and a situation.

**Trap:** a list of five goals with no ranking. If everything is top priority, nothing is a decision.

**What Tutor can check here:** the shape of what you write (a constraint, three goals, a number in each). It cannot judge whether your ranking is wise. After it turns green, read the solution and argue with it.

::: quiz
q: In the invoicing example, "invoice data must stay in Switzerland" is written in the customer contract. Where does it belong?
- Quality goals: it is the most important one
+ Constraints: it is fixed, and the goals are ranked inside it
- Risks: it might not be met
- Nowhere, because the provider handles it
why: A contract clause cannot be traded away against cost or speed, so it limits the design instead of competing with the goals. Goals are what you rank *within* the constraints.
:::

::: quiz
q: Which of these is written as a testable quality goal?
- The system must be secure and fast
- The system should scale well
+ When a person without an account opens a guessed PDF link, they get nothing, for 100 of 100 attempts
- The system follows security best practice
why: It names a situation, an event and a measurable result, so you can test it. The others are adjectives; two people can disagree forever on whether they were met.
:::

::: card
q: What makes a list of quality goals useless?
answer: No ranking. If the goals are not ordered, nobody can use them to decide, because every choice that helps one hurts another. Pick the top three and say which one wins in a conflict.
:::

::: config lang=yaml
task: Write the goals for the invoicing service. Put what is fixed under `constraints` (at least the Swiss contract clause). Then give exactly **three** `goals`, ranked best first. Each goal has a `name` and a `scenario` that contains a number. Do not make the Swiss clause a goal.
starter:
```yaml
constraints:
  -
goals:
  - name:
    scenario:
```
check: constraints ~ /swiss|switzerland/i | A constraint names the Swiss clause
check: goals count 3 | There are exactly three goals
check: goals[0].name !~ /swiss|switzerland|residen|locat/i | Goal 1 is not the contract clause
check: goals[0].scenario ~ /\d/ | Goal 1 has a number in its scenario
check: goals[1].name !~ /swiss|switzerland|residen|locat/i | Goal 2 is not the contract clause
check: goals[1].scenario ~ /\d/ | Goal 2 has a number in its scenario
check: goals[2].name !~ /swiss|switzerland|residen|locat/i | Goal 3 is not the contract clause
check: goals[2].scenario ~ /\d/ | Goal 3 has a number in its scenario
solution:
```yaml
constraints:
  - Invoice data is stored and processed in Switzerland (customer contract)
  - Budget is about 300 CHF per month
  - Two people run it part-time
goals:
  - name: Confidentiality of invoices
    scenario: A person without an account who opens a guessed PDF link gets nothing, in 100 of 100 attempts
  - name: Availability in office hours
    scenario: The invoice page answers in 99.5 percent of requests between 07:00 and 19:00 on weekdays
  - name: Recoverability
    scenario: After the database is lost, invoices are restored from backup within 4 hours with at most 24 hours of data lost
```
hint: A scenario reads "when something happens, the system does this, measured by that number". The constraints list can hold more than the Swiss clause.
:::

## Decisions on record
id: adr
stage: decide
minutes: 45
goal: Write a decision down with its context, its choice and its costs, so someone can understand it two years later.
source: Michael Nygard, Documenting Architecture Decisions | https://www.cognitect.com/blog/2011/11/15/documenting-architecture-decisions
source: Architectural Decision Records (templates and examples) | https://adr.github.io/
source: arc42: Architecture decisions | https://docs.arc42.org/section-9/

**The question:** why is the system like this, and would I know in two years?

**Read** Nygard's post first. It is short; read all of it. Then skim the templates at adr.github.io to see that there are several shapes and that none of them is the point.

**Look for:**
- the small fixed parts of a record, and why it is kept to about a page;
- what Nygard says the **consequences** section should contain, and what he says about positive and negative ones;
- who the record is for (the person who joins later).

**Trap:** a record that lists only benefits. It is marketing, not a record. A reader two years from now needs to know what you gave up.

**What Tutor can check here:** that each part is present and that you listed a cost. In a real repository you would write the record as a short Markdown file; it is YAML here only so Tutor can read its structure.

::: quiz
q: An ADR says "Decision: use one PostgreSQL database for all services" and lists three benefits under consequences. What is missing?
- The names of the people who decided
- A link to the vendor documentation
+ The costs and risks of the decision: a shared database couples the services' schemas and failures
- A longer description of PostgreSQL
why: A record is useful when it shows what you accepted by choosing this. Without the downsides, the next reader cannot tell if the reasons still hold.
:::

::: quiz
q: Which decision most deserves a written record?
- The name of a variable in one function
- The indentation style
+ Storing PDFs in object storage instead of the database, because it is expensive to reverse and shapes everything around it
- Which colour the buttons are
why: Write records for decisions that are costly to change, that have real alternatives, or that someone will later ask about.
:::

::: card
q: What does an ADR give you in two years that the code alone does not?
answer: The reason. The code shows what was chosen. The record shows the context at the time, the alternatives and the costs accepted, so you know whether the reasons still hold before changing it.
:::

::: config lang=yaml
task: The team decided to store the generated PDF invoices in S3-compatible object storage in the Swiss region, and not as blobs in the PostgreSQL database. Write the record. Use `status` proposed or accepted, a one-sentence `context`, a `decision` that names the storage, and **at least one good and one bad** consequence.
starter:
```yaml
title:
status:
context:
decision:
consequences:
  good:
    -
  bad:
    -
```
check: title ~ /\S{3}/ | There is a title
check: status ~ /^(proposed|accepted)$/ | Status is proposed or accepted
check: context ~ /.{40}/ | The context is a real sentence
check: decision ~ /object storage|bucket|s3/i | The decision names object storage
check: consequences.good[0] exists | There is at least one good consequence
check: consequences.bad[0] exists | There is at least one bad consequence
solution:
```yaml
title: Store generated PDFs in object storage, not in the database
status: accepted
context: Each invoice PDF is 200 KB to 2 MB and the database must be backed up and restored within 4 hours.
decision: We store each PDF as an object in S3-compatible object storage in the Swiss region, and keep only its key in the database.
consequences:
  good:
    - The database stays small, so backups and restores are faster
    - PDFs can be served by signed links without going through the API
  bad:
    - Two systems must be backed up and restored consistently
    - A PDF and its database row can disagree if one write fails
```
hint: Bad consequences are things you accept. Think about backups, consistency and one more system to run.
:::

## Four levels of diagram
id: c4
stage: draw
minutes: 60
goal: Choose the right level of diagram for the reader, and describe containers with clear relationships.
source: The C4 model | https://c4model.com/
source: C4 model: Abstractions | https://c4model.com/abstractions
source: C4 model: Diagrams | https://c4model.com/diagrams

**The question:** which picture does this reader need?

**Read** the three pages. C4 describes a system at four zoom levels: system context, containers, components and code. Most clients need only the first two.

**Diagram A: the system context of the invoicing service** (who uses it, and what it talks to):

```mermaid
flowchart TB
  clerk([Office clerk]) -->|creates invoices in a browser| sys[Invoicing service]
  customer([Customer]) -->|opens the PDF by link| sys
  sys -->|sends the invoice mail| mail[Mail provider]
```

**Diagram B: the containers inside it** (separately running parts):

```mermaid
flowchart LR
  clerk([Office clerk]) -->|HTTPS| api[web-api]
  api -->|SQL over TLS| db[(database)]
  api -->|enqueues a PDF job| q[[queue]]
  worker[worker] -->|takes jobs| q
  worker -->|uploads the PDF over HTTPS| obj[(object storage)]
```

**Look for:** what each level leaves out on purpose, and what the pages say about labelling lines and about a "container" in C4. Find the review checklist on the diagrams page and use it on the diagrams above.

**Trap:** in C4, a *container* is a separately running unit (an app, a database, a queue). It is **not** a Docker container. A diagram that shows a Docker container as a C4 container may be right or wrong depending on what runs in it.

**Convention used in these exercises** (check the C4 pages for their own advice): an arrow starts at the part that starts the call, and every arrow says how (protocol or purpose).

::: quiz
q: You are showing the design to the director of the invoicing company, who is not technical. Which level do you start with?
+ System context: the system, its users and the external systems it talks to
- Containers: databases, queues and workers
- Components: classes inside the API
- Code: the main function
why: The director needs to see what the system is, who uses it and what it connects to. Detail goes to the people who will build or run it.
:::

::: quiz
q: A diagram labels "Docker container: web-api" and "Docker container: nginx" as its C4 containers, because both run in Docker. What is the risk?
- None, Docker containers are C4 containers
+ It mixes a packaging detail with the C4 idea of a separately running part. nginx may just be configuration of the api's front, not a part the reader needs
- C4 forbids Docker
- Docker containers cannot have names
why: C4 containers are about what runs and what talks to what at the level a reader can reason about, not about the packaging technology.
:::

::: card
q: What should every arrow on a container diagram carry?
answer: A label saying what the relationship is (a protocol or a purpose), and a direction. Without it, the reader cannot tell what the arrow means or how it fails.
:::

::: config lang=yaml
task: This container model has two mistakes. The `worker` takes jobs from the queue, so the relationship starts at the worker. And the last relationship says nothing about how. Fix both, so that the worker takes jobs from the queue and uploads the PDF to object storage over HTTPS.
starter:
```yaml
relations:
  - from: web-api
    to: database
    how: SQL over TLS
  - from: web-api
    to: queue
    how: enqueues a PDF job
  - from: queue
    to: worker
    how: delivers jobs
  - from: worker
    to: object-storage
    how:
```
check: relations count 4 | There are four relationships
check: relations[0].from = web-api | web-api talks to the database
check: relations[0].to = database | web-api talks to the database
check: relations[1].to = queue | web-api talks to the queue
check: relations[2].from = worker | The worker starts the call to the queue
check: relations[2].to = queue | The worker starts the call to the queue
check: relations[2].how ~ /\S/ | The worker to queue arrow has a label
check: relations[3].from = worker | The worker uploads
check: relations[3].to = object-storage | The worker uploads to object storage
check: relations[3].how ~ /https/i | The upload says how (HTTPS)
solution:
```yaml
relations:
  - from: web-api
    to: database
    how: SQL over TLS
  - from: web-api
    to: queue
    how: enqueues a PDF job
  - from: worker
    to: queue
    how: takes jobs
  - from: worker
    to: object-storage
    how: uploads the PDF over HTTPS
```
hint: Reverse the third relationship and give the last one a label that mentions HTTPS.
:::

## One document, twelve questions
id: arc42
stage: draw
minutes: 45
goal: Put each kind of information in its place in the arc42 structure.
source: arc42 | https://arc42.org/
source: arc42 documentation | https://docs.arc42.org/
source: arc42: Introduction and goals | https://docs.arc42.org/section-1/
source: arc42: Architecture decisions | https://docs.arc42.org/section-9/
source: arc42: Quality requirements | https://docs.arc42.org/section-10/

**The question:** where does this piece of information belong, and where will the reader look for it?

**Read** the home page of the documentation, then the three section pages above. arc42 is a free template with twelve numbered sections. It is common in German-speaking countries, so you will meet it in client work.

**Look for:** the names and order of the twelve sections, and the question each one answers for a reader. Write the twelve names on a card before you do the exercise.

**Trap:** filling every section for a tiny system. Short sections, and an empty section marked "not applicable", beat pages of filler.

::: quiz
q: Where do you record the reason you chose object storage over the database?
- In the quality requirements section
+ In the architecture decisions section, one record per decision
- In the glossary
- In the building block view
why: Section 9 of arc42 is for decisions and their reasons. The building blocks show what exists; the decisions explain why.
:::

::: quiz
q: Where do the "99.5 percent available in office hours" scenarios go?
- Constraints
- Risks and technical debt
+ Quality requirements, as quality scenarios
- Deployment view
why: Section 10 holds the quality requirements, written as testable scenarios. The top few also appear in the introduction and goals.
:::

::: config lang=yaml
task: Write the arc42 section number (1 to 12) where each item belongs. Check yourself against the section list on docs.arc42.org afterwards.
starter:
```yaml
sections:
  contract_says_data_stays_in_switzerland: 0
  who_the_users_and_neighbouring_systems_are: 0
  why_we_chose_object_storage: 0
  scenario_99_5_percent_available_in_office_hours: 0
  which_servers_and_networks_it_runs_on: 0
  the_two_person_team_may_not_cope_with_an_outage: 0
```
check: sections.contract_says_data_stays_in_switzerland = 2 | Constraints
check: sections.who_the_users_and_neighbouring_systems_are = 3 | Context and scope
check: sections.why_we_chose_object_storage = 9 | Architecture decisions
check: sections.scenario_99_5_percent_available_in_office_hours = 10 | Quality requirements
check: sections.which_servers_and_networks_it_runs_on = 7 | Deployment view
check: sections.the_two_person_team_may_not_cope_with_an_outage = 11 | Risks and technical debt
solution:
```yaml
sections:
  contract_says_data_stays_in_switzerland: 2
  who_the_users_and_neighbouring_systems_are: 3
  why_we_chose_object_storage: 9
  scenario_99_5_percent_available_in_office_hours: 10
  which_servers_and_networks_it_runs_on: 7
  the_two_person_team_may_not_cope_with_an_outage: 11
```
hint: The sections go from 1 introduction and goals, 2 constraints, 3 context and scope, through the views and decisions, to 10 quality requirements, 11 risks and 12 glossary.
:::

## Frameworks are checklists
id: frameworks
stage: judge
minutes: 45
goal: Use a provider's framework for its questions, and spot where it steers you to its own services.
source: AWS Well-Architected Framework | https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html
source: Azure Architecture Center | https://learn.microsoft.com/en-us/azure/architecture/
source: The Twelve-Factor App | https://12factor.net/
source: Gregor Hohpe, Don't get locked up into avoiding lock-in | https://martinfowler.com/articles/oss-lockin.html

**The question:** what does this framework ask me, and what would I answer on a different provider?

**Read** the two provider frameworks for their *questions*, then the twelve-factor site, then Hohpe's article.

**Look for:**
- the review questions in the frameworks, and how many of them are provider-neutral;
- which factors in twelve-factor are about being able to move or run the same build in different places;
- Hohpe's argument about the cost of avoiding lock-in.

**Trap:** these frameworks are written by providers. They are good, and they also lead you toward their own services. Read for the questions, then decide for yourself.

::: quiz
q: A framework says "use the provider's managed identity service for every workload". What is the best response in a design review?
- Follow it, because the provider wrote it
- Ignore it, because lock-in is always bad
+ Treat it as one option: ask what it costs to switch later, what the alternatives are, and write the decision down
- Delete the identity requirement
why: A good architect uses the framework's question ("how do workloads prove who they are?") and then weighs the answer, including the cost of moving later.
:::

::: quiz
q: Twelve-factor says to keep config in the environment, not in the code or the image. What does that make easier?
- Writing shorter code
+ Deploying the exact same build to test and production, with only the config different
- Choosing a database
- Choosing a cloud provider
why: One build that behaves differently by environment only through its config is easier to test, to move between providers and to roll back.
:::

::: config lang=yaml
task: This Deployment has the database password written into the manifest and uses the moving tag `latest`. Fix it so the same image can run anywhere: pin the image to `1.4.2`, and read `DATABASE_URL` from the Secret `invoices-db`, key `url`, instead of writing a value.
starter:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-api
spec:
  replicas: 2
  selector:
    matchLabels:
      app: web-api
  template:
    metadata:
      labels:
        app: web-api
    spec:
      containers:
        - name: web-api
          image: registry.example.com/invoicing/web-api:latest
          env:
            - name: DATABASE_URL
              value: postgres://app:hunter2@db.prod.internal/invoices
```
check: spec.template.spec.containers[0].image = registry.example.com/invoicing/web-api:1.4.2 | The image tag is pinned to 1.4.2
check: spec.template.spec.containers[0].env[0].name = DATABASE_URL | The variable is still called DATABASE_URL
check: spec.template.spec.containers[0].env[0].value missing | The password is no longer written in the manifest
check: spec.template.spec.containers[0].env[0].valueFrom.secretKeyRef.name = invoices-db | It reads from the Secret invoices-db
check: spec.template.spec.containers[0].env[0].valueFrom.secretKeyRef.key = url | It reads the key url
solution:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-api
spec:
  replicas: 2
  selector:
    matchLabels:
      app: web-api
  template:
    metadata:
      labels:
        app: web-api
    spec:
      containers:
        - name: web-api
          image: registry.example.com/invoicing/web-api:1.4.2
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: invoices-db
                  key: url
```
hint: Remove the value line and put a valueFrom with a secretKeyRef (name and key) under the same env entry.
:::

## Project: design the invoicing service
id: p-invoicing
stage: judge
minutes: 120
goal: Produce a short design document for the invoicing service, with its decisions, and check its decision log.
source: arc42 | https://arc42.org/
source: The C4 model | https://c4model.com/
source: Michael Nygard, Documenting Architecture Decisions | https://www.cognitect.com/blog/2011/11/15/documenting-architecture-decisions
project: yes

**Your task:** write a design document of about six pages for the Swiss invoicing service, in your own notes (the Obsidian vault is fine), in the arc42 shape. This is the work that matters in this module; do not rush it.

**It must contain:**
1. Introduction and goals: the constraints and the three ranked goals from the first lesson.
2. A system context diagram and a container diagram (mermaid is fine), with labelled arrows.
3. At least **three** architecture decision records, each with a bad consequence.
4. A short "what I'm unsure about" section (risks).
5. One sentence a non-technical director would understand, on why the system is built this way.

**How to check yourself:** hand it to a friend, or to Tutor, and ask for the three weakest decisions and the one that is hardest to change later. Revise once.

**Trap:** describing technology before stating goals. Every decision should point back at a goal or a constraint.

The step below checks only the shape of your decision log (three decisions, each with a title, a status and a cost). The quality of the thinking is in your document.

::: config lang=yaml
task: Summarise the three most important decisions from your design in this log. Use status `proposed` or `accepted`, and name the cost you accepted for each.
starter:
```yaml
decisions:
  - title:
    status:
    cost:
  - title:
    status:
    cost:
  - title:
    status:
    cost:
```
check: decisions count 3 | There are three decisions
check: decisions[0].title ~ /\S{3}/ | Decision 1 has a title
check: decisions[0].status ~ /^(proposed|accepted)$/ | Decision 1 has a valid status
check: decisions[0].cost ~ /.{15}/ | Decision 1 states a cost
check: decisions[1].title ~ /\S{3}/ | Decision 2 has a title
check: decisions[1].status ~ /^(proposed|accepted)$/ | Decision 2 has a valid status
check: decisions[1].cost ~ /.{15}/ | Decision 2 states a cost
check: decisions[2].title ~ /\S{3}/ | Decision 3 has a title
check: decisions[2].status ~ /^(proposed|accepted)$/ | Decision 3 has a valid status
check: decisions[2].cost ~ /.{15}/ | Decision 3 states a cost
solution:
```yaml
decisions:
  - title: PDFs in object storage, not the database
    status: accepted
    cost: Two systems to back up and keep consistent
  - title: One EU provider, no hyperscaler
    status: accepted
    cost: Fewer managed services, so more to run ourselves
  - title: A queue between the API and the PDF worker
    status: proposed
    cost: Jobs can fail silently unless we monitor the queue
```
hint: A cost is something you accept by choosing this, such as more to operate, a weaker guarantee or a harder exit.
:::

::: card
q: Name the one decision in your design that would be hardest to change in two years.
answer: Your own answer. Check that it has a decision record, that the record states why you accepted its cost, and that you can say what it would take to reverse it.
:::
