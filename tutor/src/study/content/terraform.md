# Terraform
id: terraform
blurb: Infrastructure as code: desired state, plans, remote state with S3 locking, modules, expressions, tests, and stacks that share outputs.
why: Clicking resources together in the console can't be reviewed, repeated or rolled back. Terraform turns the cloud you learned in the last module into code that goes through the same pull-request flow as everything else.
stage: core | The core loop | Write resources, plan, apply, and understand what state is.
stage: reuse | Reusable configuration | Parameterize, repeat, and package infrastructure.
stage: team | Terraform in a team | Refactor safely, test, split environments, and ship a stack.

## Why infrastructure as code
id: iac
stage: core
minutes: 40
goal: Explain declarative infrastructure, the three-way diff of code, state, and reality, and where Terraform sits next to OpenTofu, CloudFormation, and CDK.
needs: cloud/model
source: Terraform: What is Terraform? | https://developer.hashicorp.com/terraform/intro
source: Terraform: Purpose of Terraform state | https://developer.hashicorp.com/terraform/language/state/purpose
source: OpenTofu | https://opentofu.org/docs/intro/

You can build a VPC by clicking. The second time, you will miss a route. The third time, someone else will add a security-group rule at 2 a.m. and nobody will know it is there until an audit. Infrastructure as code is the decision that the cloud account is a projection of files in Git. Terraform is one tool that does that, and it is the one this module teaches, because the idea (declare the end state, diff it, apply it, remember what you created) shows up again in Kubernetes.

### The problem the console does not solve

A console change has no diff, no reviewer, and no memory. If the person who clicked leaves, the next person inherits a bucket whose settings they can describe only by looking. If two people click, the last click wins and the first person does not find out. If you need the same shape in dev and prod, you re-click and the copies drift. A script of AWS CLI commands is better, and it is still the wrong shape: it is a list of steps. Run it twice and it tries to create the bucket again. Run it after someone renamed a thing and it does not know what to update. You wanted a description of what should exist, and a program that computes the steps.

That description is **desired state**. "There is a private S3 bucket named acme-logs, versioning on, no public access." You do not write "call CreateBucket, then PutBucketVersioning, then skip if it exists." Terraform's AWS provider knows those calls. Your file names the outcome.

### Three things that must agree

Every Terraform surprise is a mismatch between three records:

1. **Configuration**: the `.tf` files, what you asked for.
2. **State**: Terraform's map from an address in those files (`aws_s3_bucket.logs`) to a real ID (`acme-logs` in account 123). State is how it knows this block is that bucket, not a new bucket.
3. **Reality**: what the cloud API returns right now.

`terraform plan` refreshes reality into a candidate state, diffs it against configuration, and prints create, update, or destroy. `terraform apply` performs that diff and writes the new state. Nobody else is allowed to be the memory. If state is lost, Terraform thinks the bucket is new and plans to create it, which fails because the name exists, or worse, plans a second copy of something that should be unique. If state is edited by hand, the map lies. If reality is edited in the console, the next plan shows **drift**: a change that puts the cloud back to the code.

Drift is not an error. It is the point. A colleague adds an inbound rule to a Terraform-managed security group. The next plan shows that rule being removed, because the code does not contain it. If the rule is wanted, it goes in the code and the plan adds it on purpose. If it is not wanted, apply removes it. The rule of a Terraform account is: change it in code, or expect the next apply to undo you. Kubernetes controllers do the same thing continuously. Terraform does it when you plan and apply. Both are reconciliation. The tempo is the difference.

### What a plan is promising

A plan is a prediction, not a log of what already happened. It says "if I apply now, I will create this, change that attribute in place, and destroy this other thing." Some changes force replacement: the provider cannot edit the attribute, so the only path is destroy and create. A database with `force replacement` in the plan is a production incident unless you meant it. You read the plan for destroys before you read it for anything else. Apply without reading the plan is how a rename becomes a dropped database. The workflow lesson is the discipline. This lesson is why the plan exists: the three records can disagree, and the plan is the disagreement written in sentences.

Plans go stale. Someone else applies, or the cloud changes, between plan and apply. A careful pipeline saves the plan file and applies that exact file, so the apply cannot silently include a newer diff. Applying a saved plan still fails if the state lock shows someone else got there first. Locking is the state lesson.

### Where Terraform sits

| Tool | What you write | Who stores state | When it fits |
| --- | --- | --- | --- |
| Terraform | HCL, desired state | You: local file, S3, Terraform Cloud | Many clouds, reviewed plans, a provider for almost everything |
| OpenTofu | The same language, a fork | The same idea | You want an open-source MPL fork of the Terraform 1.5 lineage |
| CloudFormation | YAML or JSON | AWS, in a stack | AWS only, and you want AWS to own the state machine |
| CDK | TypeScript or Python that synthesizes a CloudFormation template | AWS | You want loops and types, and you accept that the deployed artifact is still a template |
| Pulumi | A general-purpose language | Pulumi's state or a self-managed backend | Same "code, not YAML" wish, not tied to CloudFormation |

The concepts transfer. Desired state, a diff, an apply, a record of what exists, drift. CDK does not remove state. CloudFormation's state is the stack in AWS. Pulumi's state is explicit, like Terraform's. People who say "CDK has no state" mean "I do not hold a tfstate file." The stack can still drift, and a change can still replace a database. The CDK lesson at the end is the comparison. Do not switch tools to escape reading plans.

OpenTofu exists because Terraform's license changed after 1.5. The language you learn here is the language both tools speak for the features this module uses: resources, modules, `moved`, `import`, `removed`, and the test command's ideas. Pin a version in CI either way. A provider and a Terraform version are a pair. "It worked on my laptop" is often "my laptop is 1.9 and CI is 1.6."

### What code will not do

Terraform will not invent a design. A public bucket written clearly is still public. It will not apply itself when you edit the console. It will not hide a secret that the provider stores as an attribute: that value lands in state. It will not update a resource another stack created unless that resource is in this state. Two stacks managing one security group is two writers, and the last apply wins. One owner per object.

It also will not click through approvals inside AWS. The plan is the approval. The pull request is where a human looks at destroys. A pipeline that applies every merge to main without a saved plan is a robot clicking the console, faster.

### How this connects

The cloud module chose the VPC, the role, and the bucket. This module is how those choices become reviewable. The Kubernetes module is the same reconciliation idea aimed at pods. When a Terraform apply and a controller fight, you have two desired states. Pick one owner for the load balancer, the node pool, and the IAM role.

### You can now

- Say what desired state means, as opposed to a script of CLI calls.
- Name the three records (configuration, state, reality) and what a plan is diffing.
- Predict that a hand-made console change shows up as drift, not as an error and not as a silent edit to the code.
- Place Terraform next to OpenTofu, CloudFormation, and CDK without pretending any of them has no record of what exists.
- Refuse a second stack that manages an object this stack already owns.

::: quiz
q: A colleague added an inbound rule to a Terraform-managed security group by hand in the console. What does the next `terraform plan` show?
- Nothing; Terraform only tracks its own changes
+ A change that removes the hand-made rule, to bring reality back to the code
- An error: the resource was modified outside Terraform
- It adds the rule to the code automatically
why: Terraform reconciles towards the code. Drift appears in the plan as a change; the fix is to put the rule in code (if it's wanted) or let the apply remove it.
:::
::: card
q: What does Terraform's state file record?
answer: The mapping from each resource in your configuration to the real object it manages (its ID and last known attributes), so Terraform can tell what exists, what changed, and what to create, update or destroy.
:::
::: quiz
q: Terraform plan wants to change a security group. Nobody edited the `.tf` files. What is the usual explanation?
- The provider is broken and should be upgraded before you read the plan
+ Reality drifted: someone changed the group in the console or in another tool, and the plan is proposing a return to the code
- State was deleted, so every plan is empty
- Terraform rewrites the `.tf` files to match the console and then plans the reverse
why: Plan diffs configuration against refreshed reality, using state to know which object is which. A change you did not write is drift. Terraform does not edit your files to match the console. An empty or missing state would plan creates, not a quiet update of one rule. Read the diff before you blame the provider.
:::
::: card
q: In Terraform, what do configuration, state, and reality each represent?
answer: Configuration is the desired state in `.tf` files. State is Terraform's map from a resource address to a real cloud ID. Reality is what the provider API returns now. Plan refreshes reality and shows how to make it match configuration. Drift is reality disagreeing with configuration.
:::
::: predict lang=python
q: A tiny model of drift. Code says ports [443]. Reality says [443, 22]. The next plan proposes the code. What does this print?
code:
```python
def plan(code, reality):
    if code == reality:
        return "no-op"
    return "set-to-code:" + ",".join(str(p) for p in code)

print(plan([443], [443, 22]))
print(plan([443, 22], [443, 22]))
```
answer:
```text
set-to-code:443
no-op
```
why: Terraform does not keep the console's extra port unless the code lists it. The first plan removes 22 by setting the rules back to [443]. Once reality matches the code, the plan is a no-op. Putting 22 in the code would make the first case a no-op instead, which is how you adopt a wanted console change.
:::
::: quiz
q: A security group is already in Terraform state. The configuration allows only port 443. Someone added port 22 in the console. What does the next plan do?
- Nothing. Once state exists, console edits are left alone
+ An update that removes port 22 and makes the group match the configuration
- An import, because the live group and the code disagree
- A destroy of the whole VPC, because any drift is fatal
why: State means Terraform already tracks the address, so this is not an import and not a fresh create. Drift is an update back toward the code, not a no-op. Terraform does not widen that into deleting unrelated resources such as the VPC. Import is for an object that is not in state yet.
:::
::: quiz
q: A teammate says CDK is safer because it has no state file. What is wrong with that?
- Nothing. CDK resources cannot be destroyed by a later deploy
+ CloudFormation still records the stack. A later deploy can still replace resources. You traded tfstate for a stack, not for the absence of memory
- CDK stores state in Git automatically, which is the recommended backend
- Terraform is the only declarative tool
why: Something must remember which physical resources belong to the declaration. CloudFormation keeps that in the stack. Losing it, or having two stacks manage one resource, is the same class of bug as losing tfstate. Git is a bad home for Terraform state because state holds secrets and changes outside review. Declarative is a family, not a single product.
:::
## HCL: resources and references
id: hcl
stage: core
minutes: 40
goal: Read a resource block, follow a reference, and predict what a plan will change when an argument is a string, a number, or another resource's attribute.
needs: iac
source: Terraform: Resources | https://developer.hashicorp.com/terraform/language/resources
source: Terraform: Expressions | https://developer.hashicorp.com/terraform/language/expressions
source: Terraform: Resource addressing | https://developer.hashicorp.com/terraform/cli/state/resource-addressing

HCL is the language Terraform uses for desired state. It looks like JSON that learned names. A file is a sequence of blocks. A block has a type, zero or more labels, and a body of arguments and nested blocks. The provider plugin, not the language, decides which arguments exist and which changes force a new resource. You can write HCL that parses and still plans a disaster, because the disaster is a valid argument.

### The problem

A bucket, a role, and a policy are three API calls with a dependency: the policy must name the bucket, and the role must exist before the policy can attach. If you paste ARNs as strings, the policy can point at a bucket you deleted last week. If you order the calls yourself, you will get the order wrong the day you add a fourth resource. Terraform's answer is references. You name the bucket `aws_s3_bucket.logs`. Another block reads `aws_s3_bucket.logs.arn`. The graph says the bucket comes first. You do not number the steps.

```hcl
resource "aws_s3_bucket" "logs" {
  bucket = "acme-logs"
}

resource "aws_s3_bucket_versioning" "logs" {
  bucket = aws_s3_bucket.logs.id
  versioning_configuration {
    status = "Enabled"
  }
}
```

`resource` is the block type. `aws_s3_bucket` is the provider's type. `logs` is your local name. The address is `aws_s3_bucket.logs`. That address is what state keys on. Rename the local name and Terraform thinks the old bucket should be destroyed and a new one created, unless you tell it the address moved. The string `"acme-logs"` is the cloud name, which is a different thing from the local name. People set them equal out of habit and then cannot have two buckets with the same local meaning in two modules.

### Arguments, blocks, and types

An argument is `name = value` on its own line. A nested block is `versioning_configuration { ... }` with no equals sign. Mixing them up is a parse error or, worse, a provider error that says the argument is wrong. The provider schema is the authority. `terraform validate` checks types against that schema after init has downloaded the provider. It does not call AWS. A valid configuration can still be rejected at apply because the account is not allowed, the name is taken, or the region does not offer the feature.

Strings are quoted. Numbers and booleans are not. `count = "2"` is a string where a number is required, and validate should catch it. `encrypted = "true"` is the string true, not the boolean, and some providers will not coerce it the way you hope. References are not strings. `bucket = aws_s3_bucket.logs.id` has no quotes. Quote it and you pass the literal text `aws_s3_bucket.logs.id` to the API, which is not an id.

A list is `[a, b]`. An object is `{ key = value }`. A reference into a list is `aws_subnet.private[0].id`. That `[0]` depends on order. `count` produces a list. `for_each` produces a map. The meta lesson is why index `[0]` is a trap when you insert an element at the front: Terraform sees a new object at `[0]` and wants to replace it.

### The graph

Terraform builds a graph from references and from explicit `depends_on`. Apply walks that graph. Independent resources run in parallel. A reference is an edge. `depends_on` is an edge you add when the dependency is hidden, for example a policy that must exist before a pod starts even though no argument contains the policy's id. Use it rarely. A `depends_on` on everything serializes the apply and still does not create an edge the next reader can see. If you can reference an attribute, do that instead.

Cycles are errors. A security group that references another, which references the first, does not apply. Split the rule into a separate `aws_security_group_rule` so the groups can exist before the rules.

Unknown values appear during plan. The bucket id does not exist until apply, so a reference to it is `(known after apply)`. That is not a failure. A plan that says the policy document will be known after apply is often fine. A plan that says a `force replacement` is known after apply is how you destroy something you have not seen the reason for. Stop and find which argument is unknown.

### Files and names

Terraform loads every `.tf` file in the directory. Names of files do not order the graph. `main.tf`, `variables.tf`, and `outputs.tf` are a convention for humans. Splitting one resource across files does not change the address. The address is the block, not the filename.

`terraform` blocks, `provider` blocks, `variable` blocks, and `output` blocks are not resources. They do not get state entries of their own, except that outputs are stored in state so other stacks can read them. A `locals` block computes values. It is not a resource either. The variables lesson is where those belong. This lesson is the resource and the reference.

### Where HCL bites

**The schema moved.** AWS provider 4.x split the bucket's ACL, versioning, and encryption into separate resources. Copying an old example sets arguments the current provider rejects, or ignores them. Read the provider docs for the version you pin, not a blog from 2021.

**A set has no indexes.** Some resources expose a set of nested blocks. `set[0]` is not stable. Use a splat or a for expression when the lesson on expressions gets there. Do not depend on the order a set printed in the plan.

**Identity versus configuration.** Changing `bucket` (the name) often forces a new bucket. Changing a tag often updates in place. The plan says which. Your intuition is not the schema.

### At work

Reviewers read addresses and references, then destroys, then the arguments that carry data (CIDRs, principals, public access). A file that hardcodes an account id in five policies is five places to miss when the account changes. A reference to `data.aws_caller_identity.current.account_id` is one place. Data sources are the next lesson after state, because they read reality without creating it.


### A review you can do on one screen

Take a pull request that adds `aws_iam_role_policy.logs`. Read the resource address first. Then read every right-hand side. If a right-hand side is a quoted ARN, ask why it is not a reference. If it interpolates `${aws_s3_bucket.logs.arn}`, that is the older string interpolation; a bare reference is enough in modern Terraform when the whole value is the reference. Interpolation still matters inside a longer string: `"arn:aws:s3:::${aws_s3_bucket.logs.bucket}/*"`. The `${}` is not a shell variable. It is HCL, evaluated by Terraform, not by bash.

Then read `lifecycle` only if it is present. `prevent_destroy` and `create_before_destroy` change apply behavior. They are easy to miss at the bottom of a block. The meta lesson covers them. In review, their presence means "someone was hurt here before." Ask whether the hurt still applies.

Finally check the provider version constraint in `required_providers`. An unbounded `version = ">= 4.0"` will pick up a major-breaking provider on the next init in a clean CI runner. Pin a pessimistic constraint such as `~> 5.0` once you have chosen a major, and let renovate open the upgrade as its own plan. The plan for a provider bump is a real review, not a chore.

### You can now

- Point at a resource address and separate it from the cloud name.
- Follow a reference and say which resource must exist first.
- Tell an argument from a nested block, and a quoted string from a reference.
- Read `(known after apply)` as "the value comes from create" rather than as a successful no-op.
- Explain why renaming the local name without `moved` plans a destroy and a create.

::: quiz
q: What's wrong with `bucket = "aws_s3_bucket.logs.id"`?
+ It's a literal string, so Terraform looks for a bucket literally named "aws_s3_bucket.logs.id" and there's no dependency on the bucket
- Nothing, quotes are optional
- `id` should be `name`
- References must use `${}` always
why: Unquoted `aws_s3_bucket.logs.id` is a reference (and creates a dependency). In quotes it's just text.
:::
::: config lang=hcl
task: Pin the AWS provider (`hashicorp/aws`, `~> 5.0`) and set the provider's region to `eu-central-1`. Create a bucket resource named `assets` with the bucket name `acme-web-assets`, and a separate `aws_s3_bucket_public_access_block` named `assets` that references the bucket's `id` and sets all four settings (`block_public_acls`, `block_public_policy`, `ignore_public_acls`, `restrict_public_buckets`) to `true`.
starter:
```hcl
provider "aws" {
}

resource "aws_s3_bucket" "assets" {
}
```
check: terraform.required_providers.aws.source = hashicorp/aws | The AWS provider source is hashicorp/aws
check: terraform.required_providers.aws.version = ~> 5.0 | The provider version is pinned to ~> 5.0
check: provider.aws.region = eu-central-1 | The region is eu-central-1
check: resource.aws_s3_bucket.assets.bucket = acme-web-assets | The bucket is called acme-web-assets
check: resource.aws_s3_bucket_public_access_block.assets.bucket.expr = aws_s3_bucket.assets.id | The public access block references aws_s3_bucket.assets.id (unquoted)
check: resource.aws_s3_bucket_public_access_block.assets.block_public_acls = true | block_public_acls = true
check: resource.aws_s3_bucket_public_access_block.assets.block_public_policy = true | block_public_policy = true
check: resource.aws_s3_bucket_public_access_block.assets.ignore_public_acls = true | ignore_public_acls = true
check: resource.aws_s3_bucket_public_access_block.assets.restrict_public_buckets = true | restrict_public_buckets = true
solution:
```hcl
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "eu-central-1"
}

resource "aws_s3_bucket" "assets" {
  bucket = "acme-web-assets"
}

resource "aws_s3_bucket_public_access_block" "assets" {
  bucket                  = aws_s3_bucket.assets.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
```
hint: The `terraform { required_providers { aws = { source = ..., version = ... } } }` block pins the provider. In the access block, write `bucket = aws_s3_bucket.assets.id` without quotes.
:::
::: quiz
q: In Terraform, what is the difference between the local name `logs` and the argument `bucket = "acme-logs"`?
- They must be identical or the provider rejects the resource
+ `logs` is your address inside the configuration (`aws_s3_bucket.logs`). `acme-logs` is the name the cloud API stores. State maps the address to the real bucket
- The local name is what IAM policies must use
- The bucket argument is only a comment
why: The address is how Terraform finds the state entry. The bucket argument is provider configuration. You can call the resource `logs` while the bucket is named `acme-logs-prod`. Renaming the local name changes the address. Changing the bucket name may force a new bucket. Those are different edits.
:::
::: card
q: What does Terraform do with a reference like `aws_s3_bucket.logs.id` inside another resource?
answer: It records an edge in the dependency graph so the bucket is created before the resource that reads the id, and it substitutes the real id at apply. Quoting that text makes it a literal string, not a reference. If the id is not known yet, the plan shows (known after apply).
:::
::: predict lang=python
q: Addresses are the state key. This prints the plan when the local name changes but the cloud name stays. What does it print?
code:
```python
def plan(old_addr, new_addr):
    if old_addr == new_addr:
        return "update-or-noop"
    return f"destroy {old_addr}; create {new_addr}"

print(plan("aws_s3_bucket.logs", "aws_s3_bucket.logs"))
print(plan("aws_s3_bucket.logs", "aws_s3_bucket.app_logs"))
```
answer:
```text
update-or-noop
destroy aws_s3_bucket.logs; create aws_s3_bucket.app_logs
```
why: Same address means Terraform updates that state entry. A new local name is a new address, so without a moved block the old address is a destroy and the new one is a create, even if both would use the bucket name acme-logs. The cloud name never entered this function. That is the bug people miss.
:::
::: config lang=hcl
task: The invoices bucket should send access logs to the logs bucket. The starter points target_bucket at a quoted string, so Terraform will not create the logs bucket first and will not notice if that bucket's address changes. Fix the logging resource so the target is the logs bucket's id. Leave the invoices bucket's name as acme-invoices.
starter:
```hcl
resource "aws_s3_bucket" "logs" {
  bucket = "acme-invoices-logs"
}

resource "aws_s3_bucket" "invoices" {
  bucket = "acme-invoices"
}

resource "aws_s3_bucket_logging" "invoices" {
  bucket        = aws_s3_bucket.invoices.id
  target_bucket = "aws_s3_bucket.logs.id"
  target_prefix = "s3/"
}
```
check: resource.aws_s3_bucket_logging.invoices.bucket.expr = aws_s3_bucket.invoices.id | The source bucket is the invoices resource id
check: resource.aws_s3_bucket_logging.invoices.target_bucket.expr = aws_s3_bucket.logs.id | The log target is the logs bucket id, not a quoted address
check: resource.aws_s3_bucket_logging.invoices.target_prefix = s3/ | The prefix stays s3/
check: resource.aws_s3_bucket.invoices.bucket = acme-invoices | The invoices bucket name is unchanged
solution:
```hcl
resource "aws_s3_bucket" "logs" {
  bucket = "acme-invoices-logs"
}

resource "aws_s3_bucket" "invoices" {
  bucket = "acme-invoices"
}

resource "aws_s3_bucket_logging" "invoices" {
  bucket        = aws_s3_bucket.invoices.id
  target_bucket = aws_s3_bucket.logs.id
  target_prefix = "s3/"
}
```
hint: A reference is not wrapped in quotes. target_bucket should be the logs bucket's id the same way bucket already uses the invoices id.
:::
::: quiz
q: `terraform validate` succeeds. Apply fails because the bucket name is already taken in the account. What did validate actually check?
- That the name is free in AWS
+ That the configuration is syntactically valid and matches the provider schema. It does not call the cloud API
- That state is locked
- That the plan has no destroys
why: Validate runs after init, against the schema. Name conflicts, IAM denials, and quotas appear at plan refresh or at apply. A green validate is not a green plan. Locking is a backend concern. Destroys appear only in a plan.
:::
## Plan and apply
id: workflow
stage: core
minutes: 40
goal: Run the init, plan, apply loop safely, including saved plans, locks, and the difference between fmt, validate, and plan.
needs: hcl
source: Terraform: The core workflow | https://developer.hashicorp.com/terraform/intro/core-workflow
source: Terraform: CLI plan | https://developer.hashicorp.com/terraform/cli/commands/plan
source: Terraform: CLI apply | https://developer.hashicorp.com/terraform/cli/commands/apply

The workflow is short, and people skip the only step that prevents outages. Init downloads providers and configures the backend. Plan computes a diff. Apply performs that diff. Format and validate are useful and they are not a plan. A pull request that shows `terraform fmt` passing and never shows a plan has not reviewed the infrastructure change.

### The problem

A laptop apply against production is a console click with extra steps. There is no record of the plan the human thought they approved. CI that runs `terraform apply -auto-approve` on every push to a branch does record a log, after the damage. The workflow you want is: format and validate locally, plan in CI against the right state, a human reads the plan, and apply uses that saved plan from a protected branch. The commands are the same. The ownership of the plan is the difference.

### Init

`terraform init` reads `required_providers` and the `backend` block. It downloads providers into `.terraform/` and writes `.terraform.lock.hcl`. Commit the lock file. It pins provider hashes the way a language lockfile pins packages. A clean CI image without the lock file will download whatever version the constraint allows. Init also connects the backend. Changing the backend, or upgrading Terraform across a change that rewrites backend metadata, needs `terraform init -reconfigure`. Terraform 1.10's upgrade notes say to reconfigure after the upgrade so deprecated root-level assume-role fields drop out of the internal backend state. Init does not create buckets and it does not apply. If the state bucket does not exist, init fails. Bootstrap the bucket outside this configuration, or with a tiny stack that is not stored in the bucket it creates. A stack cannot be the first writer of the bucket that holds its own state.

`-backend=false` inits for validate in a context where you cannot reach the backend. CI still has to init for real before plan, with credentials that can read state.

### Plan

`terraform plan` refreshes resources, diffs, and prints. Exit codes matter in CI. With `-detailed-exitcode`, 0 means no changes, 1 means error, 2 means changes present. A pipeline that treats every non-zero as failure will fail green plans that have a diff. A pipeline that ignores exit codes will apply errors.

`-out=tfplan` writes a binary plan. That file contains the values that will be sent, including sensitive ones. Do not artifact it on a public log. Do not commit it. Apply it with `terraform apply tfplan`. Applying a saved plan skips a fresh prompt and applies that diff, not whatever the files say at apply time, as long as the state still matches what the plan assumed. If someone else applied in between, the saved plan is rejected. That is the lock plus the state lineage doing their job.

Read destroys first. Read replacements second. `~` is an in-place update. `-/+` is replace. `+` is create. `-` is destroy. A tag change should be `~`. A change to a name or an AMI is often `-/+`. If you did not expect replacement, do not apply.

`-refresh-only` updates state from reality without changing infrastructure. Use it to see drift or to adopt a console change into state when you have also put that change in code... actually refresh-only does not edit code. It only rewrites state to match reality. That can hide drift by declaring the console the winner. Do it only when you mean "reality is correct and state is stale," and then update the code so the next plan is empty. A refresh-only apply that is not followed by a code change will be undone by the next normal apply if the code still disagrees. Think it through before you use it as a habit.

### Apply and destroy

`terraform apply` with no plan file plans again and asks for `yes`. In CI, prefer the saved plan so the approval matches the bytes. `-auto-approve` on an unsaved plan is "do whatever the files say at this second." That is acceptable only when the pipeline already gated the same commit. It is not acceptable from a laptop pointed at prod.

`terraform destroy` is a plan that destroys everything in this state. It is not a cleanup of one bucket. One bucket is a removed block or a deleted resource plus a plan you read. Destroy in prod should be rare, locked behind the same approval as a dangerous apply, and impossible from a laptop if you can manage it.

Partial failure is normal. Apply creates ten resources, the eleventh returns an API error, and state now contains the ten. You fix the error and apply again. Terraform does not roll back the ten. It is not a transaction. The next plan continues. Designing resources so a half-applied stack is safe (no public bucket left behind while the policy failed) is your job. `prevent_destroy` does not make apply transactional. It makes Terraform refuse a plan that would destroy that resource.

### fmt and validate

`terraform fmt` rewrites whitespace. It does not know about AWS. `terraform validate` checks syntax and schema. It does not refresh. A pre-commit hook with both is good. Neither replaces plan. Reviewers who ask for validate and not for the plan are reviewing the wrong artifact.

### Where the loop breaks

**Wrong directory, wrong state.** Prod and dev are two directories or two workspaces. Apply in the wrong one is the whole outage. Print the backend key in the CI log. Name the workspace in the job name.

**Credentials of the developer.** A plan refreshes with the caller's IAM principal. A plan run with admin and an apply run with a role can differ if the role cannot read something the refresh needs. Plan and apply should use the same role. That role is not `AdministratorAccess`. The cloud module's IAM lesson is the policy. This lesson is: the workflow identity is part of the workflow.

**Providers that surprise on every plan.** Some resources show a perpetual diff because an API returns a normalized value (a JSON policy with different spacing, a tag the console adds). `lifecycle { ignore_changes = [...] }` is the escape hatch, and it is also how you stop managing a field you should be managing. Prefer fixing the config to match the normalized form. Ignore changes only for fields another system owns, and say so in a comment.

### At work

The pull request contains the `.tf` diff and the plan output, with secrets redacted. The apply job runs on merge to the environment branch, downloads the plan or replans under a concurrency lock, and posts the result. Two applies cannot run at once because the backend lock says so. If the lock is stuck because a runner died, `terraform force-unlock` is a human decision with the lock id, not a retry flag. Forcing a lock while an apply is alive corrupts state.

### You can now

- Order init, plan, and apply, and say what each refuses to do.
- Use a saved plan so the reviewed diff is the applied diff.
- Read `+`, `~`, and `-/+` before you approve.
- Explain why fmt and validate are not a review of the change.
- Treat a failed apply as a partial success that the next plan must finish, not as a rollback.

::: quiz
q: The plan says `Plan: 0 to add, 0 to change, 0 to destroy.` What does that mean?
+ Reality matches the code; applying would do nothing
- Terraform couldn't reach AWS
- The state file is empty
- The configuration has errors
why: "No changes" means the desired state already holds, which is what you want to see after an apply, and a good drift check.
:::
::: quiz
q: You rename `bucket = "acme-logs"` to `bucket = "acme-app-logs"` on an existing bucket full of logs. The plan shows `-/+` for it. What happens on apply?
- The bucket is renamed in place
+ Terraform tries to destroy the old bucket and create a new, empty one (the destroy fails if the bucket isn't empty, unless force_destroy is set)
- Nothing; names are cosmetic
- Terraform copies the objects to the new bucket
why: S3 bucket names can't change. `-/+` means a new resource with a new identity; the data doesn't move with it.
:::
::: card
q: Why `terraform plan -out=tfplan` and then `terraform apply tfplan`?
answer: The apply runs exactly the reviewed plan. A plain `apply` recomputes the plan, and if anything changed in between (code or reality), it would do something nobody reviewed.
:::
::: quiz
q: CI runs `terraform validate` and `terraform fmt -check` on a pull request. Both pass. No plan was run. What do you know about the AWS change?
- The change is safe to apply
+ Only that the files are formatted and match the provider schema. You do not know whether the plan destroys anything
- State is locked
- The providers were not downloaded, so validate could not have passed
why: Validate needs init, but it does not refresh state or call the resource APIs for a diff. A destroy is visible in a plan, not in validate. Fmt is whitespace. A review without a plan is a review of syntax.
:::
::: card
q: Why apply a saved `terraform plan -out` file instead of running apply -auto-approve later?
answer: The saved plan is the exact diff a human reviewed. A later auto-approved apply recomputes the diff against whatever the cloud and the git tree are at that moment, which may include drift or a newer commit. If state changed underneath a saved plan, Terraform rejects it rather than applying a surprise.
:::
::: predict lang=python
q: Apply is not a transaction. This prints what remains after step 3 of 4 fails. What does it print?
code:
```python
def after_failure(done, failed):
    return f"in-state:{','.join(done)}; error:{failed}"

print(after_failure(["net", "bucket"], "policy"))
```
answer:
```text
in-state:net,bucket; error:policy
```
why: The network and the bucket stay created and recorded. The policy is not. The next apply retries the policy and leaves the first two alone if they still match the code. There is no automatic destroy of net and bucket. Design the half-applied stack so those two are not a public incident by themselves.
:::
::: quiz
q: A plan for the production stack shows two in-place updates and one replace of aws_db_instance.main. The replace is marked as a destroy and then a create. What should the reviewer do?
- Approve it. Two of the three actions are ordinary updates, so the replace can ride along
+ Stop the apply. A replace of the database is not an in-place update, even when other actions in the plan are safe
- Approve it. The only plan worth rejecting is an empty plan
- Re-run apply with auto-approve so the replace finishes before anyone reads it
why: One replace means Terraform intends to destroy that object and create another. Updates elsewhere do not make the database action safe. An empty plan is "no change", not the only thing you reject. Auto-approve is how you skip the reading this review exists to force.
:::
## State and backends
id: state
stage: core
minutes: 45
goal: Keep state remote, locked, encrypted, and unread by strangers, and change addresses only with Terraform's own blocks.
needs: workflow
source: Terraform: State | https://developer.hashicorp.com/terraform/language/state
source: Terraform: S3 backend | https://developer.hashicorp.com/terraform/language/backend/s3
source: Terraform: Manage sensitive data | https://developer.hashicorp.com/terraform/language/manage-sensitive-data

State is the map from the names in your configuration to the objects in the cloud. Without it, Terraform would see a bucket named `acme-logs` in the code and a bucket named `acme-logs` in AWS and would not know whether they are the same bucket. The state file says they are, and it stores the attributes Terraform last observed. The next plan is a three-way comparison: the configuration you want, the state you remember, and the live API. Drop any one of those and the plan lies.

### What is actually in the file

`terraform.tfstate` is JSON. Each resource has an address (`aws_s3_bucket.logs`), a provider, an id, and an `attributes` object. Those attributes are not a summary. They are the values the provider returned, including ones you marked sensitive. A generated database password, an IAM secret, the contents of a `templatefile` that included a token: if the provider put it on the resource, it is in state. `sensitive = true` on a variable or output only redacts CLI and plan text. It does not encrypt the state file and it does not omit the value from JSON. Anyone who can `s3:GetObject` the state can read the secret. Treat the state bucket like a production secret store, because that is what it is.

Local state, the default `terraform.tfstate` next to the code, fails as soon as a second person or a CI job joins. Two applies write two files. Git is the wrong merge tool for this JSON. The file also ends up on laptops and in editor backups. The rule is remote state, encrypted, versioned, not in Git, and locked.

### The S3 backend, as of current HashiCorp docs

```hcl
terraform {
  required_version = ">= 1.10"
  backend "s3" {
    bucket       = "acme-terraform-state"
    key          = "prod/network/terraform.tfstate"
    region       = "eu-central-1"
    encrypt      = true
    use_lockfile = true
  }
}
```

The object at `key` is the state. `encrypt = true` turns on server-side encryption for the state object and the lock object. Add `kms_key_id` when you want a customer-managed key; the caller then needs `kms:Encrypt`, `kms:Decrypt`, and `kms:GenerateDataKey` on that key. Turn on bucket versioning. HashiCorp recommends it so a bad write or a delete can be rolled back to a previous object version. Versioning is not a backup strategy by itself, but it is the difference between a five-minute restore and a rebuilt network.

Locking is opt-in. `use_lockfile` defaults to `false`. Set it to `true`. Terraform writes the lock to a second object whose key is the state key plus `.tflock`. For `prod/network/terraform.tfstate` the lock is `prod/network/terraform.tfstate.tflock`. The IAM policy needs `s3:ListBucket` on the bucket, `s3:GetObject` and `s3:PutObject` on the state object, and `s3:GetObject`, `s3:PutObject`, and `s3:DeleteObject` on the `.tflock` object. The current S3 backend docs say `s3:DeleteObject` is not required on the state object itself, because Terraform does not delete that object. Do not copy a policy from a blog that only grants access to the state key and then wonder why apply hangs on the lock.

This lockfile behaviour shipped in Terraform 1.10. That release called it experimental. The current backend page does not. It presents `use_lockfile` as the way to lock, and it marks DynamoDB locking deprecated, to be removed in a future minor version. You can set both during a migration so older clients and newer clients do not stomp each other. Do not create a new DynamoDB lock table for a new stack. Pin `required_version` to `>= 1.10` so an older binary does not ignore `use_lockfile` and apply unlocked.

Backend blocks do not accept variables or locals. The bucket and key are literals, or they come from `-backend-config` and a partial backend. That is deliberate: the backend has to be known before variables are evaluated. Do not put access keys in the backend block. HashiCorp warns that those values are copied into `.terraform/` and into saved plan files. Use the standard AWS credential chain, or `assume_role` / `assume_role_with_web_identity` for CI.

### What locking does and does not do

A lock means one writer. A second plan or apply waits or fails instead of writing a state that dropped the other writer's resources. The lock does not make apply a transaction. A failed apply still leaves the objects it already created, and it writes state for them if it got that far. The lock does not stop the AWS console. A human can still delete a bucket. The next plan shows the drift. The lock does not stop a stolen laptop from reading state if that laptop's role can `GetObject`.

If a runner dies and the lock is stuck, `terraform force-unlock LOCK_ID` is a human decision. Run it while an apply is alive and you invite two writers. Read the lock id from the error, confirm the other process is dead, then unlock.

### Addresses, not the JSON

The address `aws_s3_bucket.logs` is how state finds the object. Rename the resource in code and Terraform thinks `logs` is gone and `app_logs` is new: destroy and create. A `moved` block records the rename so the plan is empty. `import` adopts an object that already exists. `removed` tells Terraform to drop an address; by default that also destroys the real object, and `lifecycle { destroy = false }` leaves the object in the cloud while forgetting it. Those three are the next lesson's whole subject. The rule for this lesson is narrower: never open the JSON in an editor. `terraform state rm`, `state mv`, and `state push` exist and they are sharp. Prefer the blocks, which show up in review. A hand-edited state that no longer matches the provider schema is how teams restore from versioning at midnight.

`terraform refresh` and `plan -refresh-only` rewrite state from the API. They do not change the cloud. They do change what the next plan considers "current". A refresh that accepts console drift, followed by no code change, means the next normal apply will try to undo that drift. Refresh is for "state is stale and reality is the source of truth," not a way to silence a plan.

### Sensitive values, again, because this is where they leak

| Marking | Hides from plan/CLI | Stored in state | Encrypted by `sensitive = true` |
|---|---|---|---|
| `variable` `sensitive = true` | yes | yes, if used on a resource | no |
| `output` `sensitive = true` | yes | yes | no |
| `encrypt = true` on the S3 backend | no | yes, as ciphertext at rest in S3 | n/a, this is the encryption |

Pulling a sensitive output through `terraform_remote_state` copies that value into the caller's state too. A "read only" stack that outputs a database URL with the password has now spread the secret to every state that reads it. Prefer outputs that are identifiers (a secret ARN, a bucket name) and let the app read the secret at runtime. Ephemeral values, in current Terraform, are the language feature aimed at values that should not land in state; they are not a retroactive scrub of old state versions. Old versions in a versioned bucket still have the old plaintext. Restrict `s3:GetObjectVersion` the same way you restrict `GetObject`.

### Where teams get hurt

**One state for prod and dev.** A single key, selected by a workspace you forgot to switch, applies the prod diff to dev's objects or the reverse. Separate keys at minimum: `dev/network/terraform.tfstate` and `prod/network/terraform.tfstate`. Separate accounts when you can.

**The state bucket is itself in this state.** The stack that creates the bucket cannot be the first writer of the bucket it needs in order to start. Bootstrap the bucket, the versioning, the encryption, and the policy outside this configuration, or with a tiny stack whose state lives somewhere else. Losing the bucket is losing the map.

**Plans as artifacts.** A saved plan includes values that were sensitive. Do not upload `tfplan` to a world-readable CI artifact. The log of `terraform plan` is safer than the binary only because sensitive marks redact it, and redaction misses values that were never marked.

### You can now

- Say what a plan compares, and why a second person with a local state file will destroy things.
- Configure an S3 backend with `use_lockfile = true`, and name the lock object.
- Write the IAM split: state object versus `.tflock`, and skip DynamoDB for a new stack.
- Explain why `sensitive = true` is not encryption.
- Refuse to edit state JSON, and point a rename at a `moved` block instead.

::: quiz
q: You renamed a resource in code from `aws_db_instance.db` to `aws_db_instance.main`. The plan wants to destroy one database and create another. What do you add?
- `terraform state rm`
+ A `moved` block from `aws_db_instance.db` to `aws_db_instance.main`
- `prevent_destroy`
- Nothing; apply and restore from backup
why: Terraform tracks resources by their address in code. `moved` records the rename, so the plan shows no destroy.
:::
::: config lang=hcl
task: Configure the **S3 backend**: bucket `acme-tf-state`, key `staging/app/terraform.tfstate`, region `eu-central-1`, encryption on, and native S3 locking on.
starter:
```hcl
terraform {
}
```
check: terraform.backend.s3.bucket = acme-tf-state | The state bucket is acme-tf-state
check: terraform.backend.s3.key = staging/app/terraform.tfstate | The key is staging/app/terraform.tfstate
check: terraform.backend.s3.region = eu-central-1 | The region is eu-central-1
check: terraform.backend.s3.encrypt = true | encrypt = true
check: terraform.backend.s3.use_lockfile = true | use_lockfile = true (S3-native locking)
solution:
```hcl
terraform {
  backend "s3" {
    bucket       = "acme-tf-state"
    key          = "staging/app/terraform.tfstate"
    region       = "eu-central-1"
    encrypt      = true
    use_lockfile = true
  }
}
```
hint: `backend "s3" { ... }` goes inside the `terraform` block.
:::
::: quiz
q: A variable is marked sensitive and used as a database password. Where does the password still end up in cleartext inside Terraform's own files?
- Nowhere. sensitive encrypts it
+ In the state JSON. sensitive only redacts CLI and plan output
- Only in the saved plan, never in state
- In git, because Terraform commits state automatically
why: The tempting answer is that sensitive means secret. It means "do not print". The state file stores attributes as the provider returned them. Encryption is the backend (`encrypt`, a KMS key, a private bucket), not the sensitive flag.
:::
::: card
q: With Terraform's S3 backend and use_lockfile = true, what is the object key of the lock if the state key is prod/app/terraform.tfstate?
answer: prod/app/terraform.tfstate.tflock. The lock is a separate S3 object named by appending .tflock to the state key. IAM needs s3:GetObject, s3:PutObject, and s3:DeleteObject on that lock object. use_lockfile defaults to false, so locking is off until you set it.
:::
::: predict lang=python
q: This prints the lock object key the way the S3 backend names it. What does it print?
code:
```python
def lock_key(state_key):
    return state_key + ".tflock"

print(lock_key("prod/network/terraform.tfstate"))
```
answer:
```text
prod/network/terraform.tfstate.tflock
```
why: Current HashiCorp S3 backend docs: when use_lockfile is true, the lock object is the state key plus the suffix .tflock. It is not a DynamoDB row, and it is not a key named "lock".
:::
::: quiz
q: You are starting a new stack on Terraform 1.10 or newer. How should you lock S3 state?
- Create a DynamoDB table with a LockID partition key and set dynamodb_table
+ Set use_lockfile = true. DynamoDB locking is deprecated; keep it only while migrating old clients
- Locking is on by default, so the backend block needs no lock setting
- Commit terraform.tfstate and let Git lock the file
why: use_lockfile defaults to false, so "already on" is wrong. DynamoDB still works and is deprecated, to be removed in a future minor version. New work should not add a lock table. Git does not lock state.
:::
## Data sources and provider aliases
id: data-sources
stage: core
minutes: 40
goal: Read existing cloud objects with data sources, and target a second region or account with a provider alias.
needs: state
source: Terraform: Data sources | https://developer.hashicorp.com/terraform/language/data-sources
source: Terraform: Provider configuration | https://developer.hashicorp.com/terraform/language/providers/configuration

A resource block says "make this exist." A data source says "look this up, and fail if it is not there." Terraform still stores the result in state, and it still refreshes it on every plan. The difference is that apply will not create, update, or destroy the thing you looked up. That makes data sources the right tool for objects you do not own, and the wrong tool for objects you do own but got tired of wiring outputs for.

### The problem

A network team already built the VPC. Your stack needs its id. You can paste `vpc-0abc` into a variable, and the paste goes stale the day they rebuild. You can `terraform_remote_state` their whole state, and you now depend on every output they ever published, including ones you should not read. Or you can look the VPC up by a tag they agreed to keep:

```hcl
data "aws_vpc" "main" {
  filter {
    name   = "tag:Name"
    values = ["prod"]
  }
}

resource "aws_subnet" "app" {
  vpc_id     = data.aws_vpc.main.id
  cidr_block = "10.0.40.0/24"
}
```

`data.aws_vpc.main.id` is a reference, same as a resource attribute. It creates a dependency edge: the subnet waits until the read succeeds. If two VPCs match, or none do, plan fails. That failure is the feature. A silent pick of the wrong VPC is how a database lands in a peering you did not mean.

`data "aws_caller_identity" "current" {}` and `data "aws_region" "current" {}` are the small ones you will use constantly. Account id and region should come from the caller, not from a string someone typed `111111111111` for. An AMI lookup with `most_recent = true` is more dangerous than it looks. "Most recent Amazon Linux" changes under you. Pin an owner and a name pattern, and know that a new AMI changes the plan into a replacement of every instance that references it. For production, prefer a specific AMI id passed in as a variable, and use the data source in the module that builds images, not in the module that boots the fleet.

### What refresh really does

Data sources run during refresh, before the diff. Every plan is an API read. A data source whose arguments change is a new read, and every resource that interpolates the result may update. That is why a data source inside a module that is instantiated fifty times can turn a plan into fifty identical Describe calls and a slow CI job. Pass the looked-up id into the module as a variable when the lookup is shared.

A data source is not a lock and not a snapshot. Between plan and apply the object can change. Apply refreshes again. If you need a value frozen to the plan a human reviewed, that is what a saved plan file is for, not a second data source.

Data results land in state. A data source that returns a secret (an `aws_secretsmanager_secret_version`) puts that secret in state, sensitive flag or not. Read the ARN if you can. Let the application fetch the payload. The state lesson's rule does not get an exception because the block says `data` instead of `resource`.

### Provider aliases

The `provider "aws"` block with no alias is the default. A second region or a second account is another block with an alias:

```hcl
provider "aws" {
  region = "eu-central-1"
}

provider "aws" {
  alias  = "use1"
  region = "us-east-1"
}

resource "aws_s3_bucket" "replica" {
  provider = aws.use1
  bucket   = "acme-logs-use1"
}
```

`provider = aws.use1` is an expression, not a string. Quotes make Terraform look for a provider literally named that text and fail. The alias is required on every resource and data source that should not use the default. Forgetting it is the bug: the replica bucket appears in eu-central-1 and the plan looks "successful."

Modules do not inherit aliases by magic. The caller passes them:

```hcl
module "replica" {
  source = "./modules/bucket"
  providers = {
    aws = aws.use1
  }
}
```

The map key is the provider name the module declared (`aws`), and the value is the alias in the caller. A module with both a default and an aliased provider needs `configuration_aliases` in its `required_providers` so Terraform knows the extra configuration exists. This is fiddly and it is still better than copying the module twice.

An alias can also assume a role in another account (`assume_role { role_arn = ... }`). The plan then runs as that role for those resources only. Two aliases in one apply means one state containing objects from two accounts. That is legitimate for a replica or a peering, and it is a bad default for "prod and dev." Prod and dev should be two states so a bad plan cannot see both.

You cannot move a resource from one provider address to another with `moved` and expect an in-place update. The provider identity is part of the resource. Changing `provider = aws.use1` on an existing bucket plans a destroy in the old region and a create in the new one. Read that plan. It is a replacement, not a region change.

### Data source versus remote state versus variable

| You need | Use |
|---|---|
| An object another team owns, identified by a stable tag or name | a data source |
| An output of a stack you also review and apply | `terraform_remote_state` or, better, an output passed by the pipeline |
| A value that must not change unless a human edits it | a variable |
| Something this stack creates | a resource, then references |

The mistake is using a data source to find a bucket this same state created, matching on name, instead of referencing `aws_s3_bucket.logs.id`. The reference is free of a race. The data source can run before the create in a fresh state and fail, or it can attach you to a bucket of the same name that you do not manage.

### Where it bites

**most_recent without an owner.** You will eventually select an AMI you do not trust, or a public one with a colliding name.

**Empty results treated as optional.** They are not. If the VPC might legitimately be absent, that is a variable defaulting to null and a `count`, not a data source you catch with a provisioner.

**Alias only on the resource, not on the data source** that looked up the KMS key. The key id from us-east-1 gets sent to an eu-central-1 API and the error is confusing.

**Assuming data sources are free of state.** They are in state. `terraform state list` shows them. Destroying the stack does not destroy the looked-up VPC, which is the point, and it does drop the data source from this state.

### You can now

- Choose a data source, a variable, or remote state for a value you did not create.
- Write a filtered lookup and expect plan to fail when the filter is ambiguous.
- Declare a provider alias and set `provider = aws.alias` unquoted.
- Pass an alias into a module with a `providers` map.
- Predict that changing a resource's provider alias replaces the object.

A lookup that is only used to print an account id in an output still belongs in state. Delete the data source when nothing references it, or every plan pays for the call and every state copy keeps the result. 

::: quiz
q: Your stack creates aws_s3_bucket.logs. A second resource needs that bucket's id. What should it reference?
- data.aws_s3_bucket.logs.id, so the lookup is always fresh
+ aws_s3_bucket.logs.id, the resource this state already manages
- A variable you paste from the console after the first apply
- terraform_remote_state of this same state
why: A data source is for an object you do not manage here. Looking up your own bucket adds an API read and can race a create. The resource attribute is already in the graph. Remote state of yourself is circular.
:::

::: card
q: What does provider = aws.use1 do, and what does provider = "aws.use1" do?
answer: Without quotes, aws.use1 selects the AWS provider configuration whose alias is use1, so that resource is created in that region or account. With quotes it is a literal string, not a provider reference, and Terraform will not use the alias. The default provider is the aws block with no alias. Modules receive aliases only through a providers map.
:::

::: predict lang=python
q: Changing a resource's provider alias is a replacement, not an in-place move. What does this print?
code:
```python
def plan(old, new):
    if old != new:
        return "replace"
    return "update"

print(plan("aws", "aws.use1"))
```
answer:
```text
replace
```
why: The provider configuration is part of the resource identity. Pointing an existing bucket at another alias plans a destroy under the old provider and a create under the new one. moved does not turn that into an in-place region change.
:::

::: config lang=hcl
task: Add one AWS provider block with alias use1 and region us-east-1 (this file has no second provider block). Look up the caller with data aws_caller_identity named current, empty body. Add data aws_vpc named main, provider set to the use1 alias with no quotes, filter name tag:Name, values a one-item list of prod.
starter:
```hcl
data "aws_caller_identity" "current" {
  provider = "aws.use1"
}
```
check: data.aws_caller_identity.current exists | There is a data.aws_caller_identity.current block
check: provider.aws.alias = use1 | The provider alias is use1
check: provider.aws.region = us-east-1 | The alias region is us-east-1
check: data.aws_vpc.main.filter.name = tag:Name | The VPC filter name is tag:Name
check: data.aws_vpc.main.filter.values = ["prod"] | The filter values are ["prod"]
check: data.aws_vpc.main.provider.expr = aws.use1 | The VPC data source uses provider = aws.use1
solution:
```hcl
provider "aws" {
  alias  = "use1"
  region = "us-east-1"
}

data "aws_caller_identity" "current" {
}

data "aws_vpc" "main" {
  provider = aws.use1
  filter {
    name   = "tag:Name"
    values = ["prod"]
  }
}
```
hint: Only one provider "aws" block, with alias = "use1". On the VPC data source write provider = aws.use1 with no quotes. values = ["prod"].
:::

::: quiz
q: A data source uses most_recent = true to pick an AMI, and instances use that id. A newer AMI appears. What does the next plan do?
- Nothing, because data sources never change resource diffs
+ It refreshes the data source, so the instances whose AMI argument changed will plan an update, often a replacement
- It applies the new AMI automatically with no plan
- It fails because most_recent is illegal
why: Data sources refresh on plan. most_recent is allowed and unstable. The new id flows into the instance argument. If AMI forces replacement, you will replace the fleet. Pin an id when you do not want that.
:::

## Variables, outputs and locals
id: variables
stage: reuse
minutes: 40
goal: Parameterize a configuration with typed variables, compute names with locals, and expose only the outputs other stacks should see.
needs: hcl
source: Terraform: Input variables | https://developer.hashicorp.com/terraform/language/values/variables
source: Terraform: Output values | https://developer.hashicorp.com/terraform/language/values/outputs
source: Terraform: Local values | https://developer.hashicorp.com/terraform/language/values/locals

Variables, locals, and outputs are three different directions. A variable is an input, set from outside the module. A local is a name you compute inside, so an expression is written once. An output is a result you deliberately publish to a human, to CI, or to another state. Mixing them up is how a root module grows eighty variables that only exist to thread one string through a local that should have been the variable.

### Variables are the arguments

```hcl
variable "env" {
  type        = string
  description = "Which environment this state builds."
  validation {
    condition     = contains(["dev", "staging", "prod"], var.env)
    error_message = "env must be dev, staging, or prod."
  }
}
```

`var.env` is the reference. Values arrive from `terraform.tfvars`, `*.auto.tfvars`, `-var`, or `TF_VAR_env`. A default makes the variable optional. No default means plan will not start until something supplies it. That is what you want for `env` and for account-specific names. A default of `"prod"` is how a laptop apply builds production by accident.

Types are not decoration. `string`, `number`, `bool`, `list(string)`, `map(string)`, and objects with `optional()` attributes fail the plan when CI passes a number where a string was promised. Validation is for rules the type system cannot say: the environment is one of three names, the CIDR parses, the name matches a prefix. A validation that calls the AWS API does not belong here. Validation sees only variables, not resources. It runs before refresh.

`nullable`, `sensitive`, and `ephemeral` change handling, not meaning. `sensitive = true` redacts the value in plan output. The value is still in state if a resource stores it. Do not put the production database password in `prod.tfvars` in Git and then mark the variable sensitive. The mark does not scrub the file you committed. Pass secrets through the environment for a one-off, or do not pass them at all: generate them with a resource that writes to a secret manager, or read them at runtime in the app. A variable that exists only so Terraform can set a password on RDS will be in state. Prefer the app to read Secrets Manager.

### Locals are names, not inputs

```hcl
locals {
  name = "orders-${var.env}"
  tags = {
    project = "orders"
    env     = var.env
  }
}
```

`local.name` cannot be set from CI. If a reviewer wants a different name, they change the expression. That is the point. Use locals for tags, name prefixes, and "is this prod?" booleans (`is_prod = var.env == "prod"`) so the condition is not copied into twelve resources. Do not use a local as a second variable with a hard-coded account id "because tfvars felt heavy." The account id should be a data source (`aws_caller_identity`) or an explicit variable with no default.

Locals can reference resources. That creates a dependency, and it can force a local to be unknown until apply. A `for_each` over a local that is unknown at plan time is a classic error: Terraform cannot tell how many instances exist until apply, and it refuses. Compute `for_each` keys from variables, not from resource attributes, unless you truly cannot know the set in advance and you accept `-target` pain. You should not accept it. Pass the list in.

### Outputs are a public API

```hcl
output "uploads_bucket" {
  value       = aws_s3_bucket.uploads.bucket
  description = "Name of the uploads bucket."
}

output "db_password" {
  value     = random_password.db.result
  sensitive = true
}
```

An output without `sensitive = true` prints in CI logs. An output with it still sits in state, and any root module that re-exports a child module's sensitive output stores it again. Publish identifiers: bucket names, ARNs, subnet ids. Let the password stay inside the module that created the secret. Root outputs are the only ones `terraform_remote_state` can see. A child module output that the root does not repeat is invisible to other stacks. That is a feature. Re-export on purpose.

`terraform output` reads state. It does not refresh. A value shown by `output` can be older than the cloud if someone changed the object in the console. The plan is the freshness check, not `terraform output`.

### Precedence and files you commit

| Source | Committed? | Typical use |
|---|---|---|
| `default` in the variable | yes | safe empty or a dev-sized number |
| `terraform.tfvars` | sometimes | shared non-secret inputs for this root |
| `prod.auto.tfvars` | careful | environment values that are not secret |
| `TF_VAR_*` / `-var` | no | CI and secrets you have not designed out |
| `*.tfvars` in a secret store | no | last resort |

Auto-loaded tfvars are easy to forget you loaded. A file named `prod.auto.tfvars` sitting in a directory applies even when you meant dev. Prefer one directory per environment, each with its own `terraform.tfvars`, over one directory and a pile of auto files. The environments lesson goes further. Here the rule is: if two files set `env`, know which wins. Later files and explicit `-var` override earlier ones. Do not depend on that subtlety for prod versus dev.

### Misreadings

**"A description is optional so skip it."** The description is what `terraform` prints when it asks for the value, and what a module consumer reads. An undescribed variable becomes a guess.

**"Locals and variables are interchangeable."** Callers can set variables. They cannot set locals. If you need an override, it is a variable. If you need one spelling of a name, it is a local.

**"Outputs are just printf."** Root outputs are a contract. Renaming `vpc_id` breaks every caller reading remote state. Treat the rename like a moved block: add the new output, keep the old one until callers migrate, then remove it.

**Type constraints on objects.** An object type rejects extra attributes the caller thought were harmless. `map(string)` is looser and hides typos in keys. Use an object when the keys are a schema.

### How this shows up in review

A root module's variables are the questions CI must answer. If `env` has no default, the pipeline has to pass it, which means the job is explicit about which environment it is. If every size and name has a default, a plan with an empty tfvars still builds something, and reviewers argue about what. Prefer defaults only for values a stranger could apply in a sandbox without causing a bill or a public bucket.

Child modules should take what they need and no more. A module variable named `vpc_id` is a string the caller computed. A module variable named `raw_remote_state` is a hole in the boundary. Do not pass `data.terraform_remote_state.network.outputs` as a whole object "to be flexible." Pass `subnet_ids`. The module's input list is documentation. When it is a blob, the module starts reaching into keys the producer never promised, and a rename in the network stack becomes a plan error in every consumer at once.

`nullable = false` plus a default is a reasonable way to say "omit means the default, but an explicit null is a mistake." Leaving nullability at the default lets a caller pass null and then trip over a confusing provider error inside the resource. Fail at the variable.

One more precedence trap: environment variables `TF_VAR_env` override tfvars in the usual Terraform load order when they are set in the shell that runs the command. A developer with `TF_VAR_env=dev` exported in `.bashrc` will plan dev while looking at a directory named prod. Print `var.env` in an output during bring-up, or echo the backend key in CI, so the identity of the run is visible. Remove the export when you notice it. The bug is quiet because the plan is internally consistent: it is consistently the wrong environment.

### You can now

- Put a validation on an environment name so `prdo` fails before any API call.
- Use a local for a name prefix and tags, and a variable for anything a caller must choose.
- Mark an output sensitive and still refuse to publish a password.
- Explain why `for_each` keys should come from variables, not from attributes that are unknown at plan time.
- Keep tfvars secrets out of Git.

::: config lang=hcl
task: Add a variable `env` (type `string`) with a `validation` that only allows `dev` or `prod`. Add a `locals` block with `prefix = "shop-${var.env}"`. Use it so the bucket is named `"${local.prefix}-images"`, and add an output `images_bucket` whose value is the bucket's `bucket` attribute.
starter:
```hcl
resource "aws_s3_bucket" "images" {
  bucket = "shop-dev-images"
}
```
check: variable.env.type.expr = string | variable "env" has type = string
check: variable.env.validation.condition ~ /contains\(\[\s*"dev",\s*"prod"\s*\],\s*var\.env\)/ | The validation uses contains(["dev", "prod"], var.env)
check: variable.env.validation.error_message exists | The validation has an error_message
check: locals.prefix = shop-${var.env} | local prefix is "shop-${var.env}"
check: resource.aws_s3_bucket.images.bucket = ${local.prefix}-images | The bucket name is "${local.prefix}-images"
check: output.images_bucket.value.expr = aws_s3_bucket.images.bucket | The output's value is aws_s3_bucket.images.bucket
solution:
```hcl
variable "env" {
  type = string
  validation {
    condition     = contains(["dev", "prod"], var.env)
    error_message = "env must be dev or prod."
  }
}

locals {
  prefix = "shop-${var.env}"
}

resource "aws_s3_bucket" "images" {
  bucket = "${local.prefix}-images"
}

output "images_bucket" {
  value = aws_s3_bucket.images.bucket
}
```
hint: `type = string` has no quotes. The condition is `contains(["dev", "prod"], var.env)`. Strings with `${...}` interpolate.
:::
::: quiz
q: A module author wants every bucket in the module to share a name prefix that callers cannot override. Where does that prefix belong?
- A variable with a default, so callers can still pass -var
+ A local. Callers cannot set locals; that is why the prefix stays consistent
- An output, and resources read the output
- A data source that looks up the prefix
why: Variables are the override hatch, including defaults, because -var and tfvars replace them. A local is internal. Resources do not read outputs of their own module to configure themselves; that is a cycle or a pointless hop.
:::
::: card
q: Why can for_each not use a list that comes from a resource attribute on the first apply?
answer: for_each has to know every instance key during plan, before apply creates the resource. An attribute that is unknown until apply leaves Terraform unable to decide how many instances to plan. Compute the keys from variables or other values known at plan time.
:::
::: predict lang=python
q: Validation should reject an environment typo before any resource is planned. What does this print?
code:
```python
def check(env):
    if env not in ("dev", "staging", "prod"):
        return "error"
    return "ok"

print(check("prdo"))
```
answer:
```text
error
```
why: contains(["dev", "staging", "prod"], var.env) fails the plan for prdo. A typo must not become a bucket named prdo. Validation runs on variables only; it is not an AWS call.
:::
::: quiz
q: You mark an output sensitive = true and then read it from another stack with terraform_remote_state. What is true?
- The password is encrypted inside both state files by the sensitive flag
+ The value is redacted in CLI output and still stored in this state and in the caller's state
- Remote state cannot read sensitive outputs, so the caller gets null
- Sensitive outputs are omitted from state entirely
why: sensitive is a display rule. Root outputs, sensitive or not, are copied into a caller's state when that caller reads remote state. Publish an ARN instead of a password if you can.
:::
## count, for_each and lifecycle
id: meta
stage: reuse
minutes: 40
goal: Create many similar resources from one block, and protect the ones that must never be replaced by accident.
needs: variables
source: Terraform: for_each | https://developer.hashicorp.com/terraform/language/meta-arguments/for_each
source: Terraform: lifecycle | https://developer.hashicorp.com/terraform/language/meta-arguments/lifecycle

Meta-arguments are not resources. They change how a resource block is instantiated and how Terraform is allowed to update it. `count` and `for_each` decide how many instances exist and what their addresses are. `lifecycle` decides whether a destroy is refused, whether a replacement is created first, and which attributes to stop tracking. `depends_on` adds an edge the graph cannot see. None of these are a substitute for a module, and `count` is not a loop in the programming sense. The instances are declared, all of them, in the plan.

### Addresses are the whole game

```hcl
resource "aws_s3_bucket" "env" {
  for_each = toset(["dev", "staging", "prod"])
  bucket   = "acme-${each.key}-data"
}
```

The addresses are `aws_s3_bucket.env["dev"]` and so on. State stores those addresses. Change the key and Terraform sees a destroy of the old address and a create of the new one, even if the bucket name you computed happens to match. Keys must be stable. A key that is a list index, a timestamp, or an unordered set converted badly will churn infrastructure.

`count` addresses are `aws_s3_bucket.env[0]`. The index is the identity. Remove the first element of a three-item list and index 0 now holds what used to be index 1. Terraform updates index 0 in place or replaces it, updates index 1, and destroys index 2. On a subnet or an instance, that is often a replacement of almost everything, not "delete the one I removed." This is the bug that makes people afraid of Terraform. The fix is `for_each` with a meaningful key, not "never loop."

Use `count` for zero or one: `count = var.alarms_enabled ? 1 : 0`. The address is still `[0]`. Callers write `aws_cloudwatch_metric_alarm.errors[0].arn`, or `one(aws_cloudwatch_metric_alarm.errors[*].arn)` when the empty case must be null. Do not use `count` to iterate a list of names you might reorder.

`for_each` wants a set of strings or a map. `for_each = var.queues` on a `map(number)` gives `each.key` and `each.value`. `toset()` on a list of strings is the other common form. A list of objects must become a map first: `{ for s in var.subnets : s.name => s }`. If `s.name` is unknown at plan time, `for_each` cannot proceed. Keys come from variables.

You cannot mix `count` and `for_each` on the same resource. Switching from one to the other changes every address. Do it with `moved` blocks, one per instance, or accept a replacement. The refactor lesson is that move. Do not switch casually on a database.

### lifecycle

```hcl
resource "aws_db_instance" "main" {
  lifecycle {
    prevent_destroy       = true
    create_before_destroy = false
    ignore_changes        = [tags["LastBackup"]]
  }
}
```

`prevent_destroy = true` makes any plan that would destroy this instance an error. It does not stop the console, a `removed` block that sets `destroy = true`, or a human with `terraform destroy` from being a problem you still have to refuse in CI. It does stop the casual rename. It cannot be set from a variable in older Terraform in a way that flips per environment without a conditional that still type-checks; people copy the resource or set it literally. A prod database gets `true`. A sandbox bucket does not, or you will be unable to clean the sandbox.

`create_before_destroy` creates the replacement first, then destroys the old object. The plan symbol flips toward `+/-` instead of `-/+`. Use it when a name can exist twice (a security group attached by id, an instance behind a load balancer) and downtime matters. Do not use it on a resource whose name must be unique, such as an S3 bucket with a fixed name or an IAM role name. The create fails because the name is taken, and you are worse off. S3 bucket renames cannot be create-before-destroy under the same name. They cannot be in-place either.

`ignore_changes` stops Terraform from repairing drift on those arguments. The next plan will not put the code's value back. Use it for fields another system owns: a tag a backup tool writes, an autoscaling desired capacity that a scaler changes. Do not use it to silence a perpetual diff you do not understand. A perpetual diff usually means the provider returns a normalized value (JSON key order, an AWS-added tag). Fix the config to match the normalized form, or set the argument to the value the API wants. `ignore_changes = all` is how a resource quietly leaves management while still sitting in state. It is almost never what a review should approve.

`replace_triggered_by` forces a replacement when another value changes. It is for "the instance must be rebuilt when the script hash changes," not for everyday updates. A forced replace of a database is still a replace.

### depends_on

References already draw edges. `bucket = aws_s3_bucket.logs.id` waits for the bucket. `depends_on` is for hidden edges: a policy that must exist before a bucket public-access setting is applied, an IAM role that a separate service reads, a `null_resource` style ordering you should probably redesign. Over-using `depends_on` serializes the apply and still does not create a data dependency. If the attribute is not passed in, Terraform will not update the dependent resource when the dependency's attributes change. Pass the attribute. Add `depends_on` only when there is nothing to pass.

### Choosing

| Situation | Use |
|---|---|
| Many objects with stable names | `for_each` over a map or set |
| A resource that might not exist | `count` of 0 or 1 |
| A list you filter and transform | a `for` expression that produces the map, then `for_each` |
| Nested repeated blocks inside one resource | a `dynamic` block, not `count` on the parent |
| Must not be destroyed by a plan | `prevent_destroy` |
| Another system writes one attribute | `ignore_changes` on that attribute only |

`dynamic` blocks are the expressions lesson. They do not create new resource addresses. `for_each` on the resource does. If you need one security group with many ingress rules, that is `dynamic`. If you need one queue per name, that is `for_each` on `aws_sqs_queue`.

### At work

Reviewers look at the addresses in the plan, not only the names. `aws_instance.app["api"]` being replaced is a different event from `aws_instance.app[0]` being replaced because someone sorted a list. Modules that take `for_each` at the call (`module "svc" { for_each = var.services }`) get the same address rules: `module.svc["api"]`. Moving a module instance needs a `moved` block too.

### A note on toset and unknown values

`toset(["a", "b"])` is known at plan time because the strings are literals. `toset(var.names)` is known if `var.names` is known. `toset(aws_instance.web[*].id)` is not known on the first apply, and it is a bad key even later: instance ids change when instances are replaced, so the `for_each` set changes and you chase your own tail. Never key instances by an id that this same configuration creates. Key them by a name the human chose.

`each.value` on a set of strings is the same string as `each.key`. People write `each.value` out of habit from maps and then get confused when a set has no separate value. On a map, the value can be an object. Reach in with `each.value.cidr`, and give the object a type on the variable so a missing attribute fails in the variable, not deep in a provider error three modules down.

### You can now

- Explain why deleting the first of three `count` items reshuffles the rest.
- Pick `for_each` keys that will still be true next year.
- Use `count` only for optional single resources.
- Set `prevent_destroy` on data you cannot recreate, and refuse `ignore_changes = all`.
- Add `depends_on` only when no reference can express the edge.

::: quiz
q: Three subnets were created with `count = 3` from a list `["a", "b", "c"]`. You remove `"a"` from the list. What does the plan do?
- Destroy only subnet a
+ Change subnet [0] to b's settings and [1] to c's, and destroy [2], because the indexes shifted (often forcing replacements)
- Nothing
- Error: count can't shrink
why: `count` identifies instances by position. `for_each` with keys "a", "b", "c" would destroy only "a".
:::
::: config lang=hcl
task: Replace the three copy-pasted queues with **one** `aws_sqs_queue` resource named `q` that uses `for_each` over the map `var.queues` (declare the variable with that default: `orders = 300`, `emails = 60`, `reports = 900`), setting `name` from the key and `visibility_timeout_seconds` from the value.
starter:
```hcl
resource "aws_sqs_queue" "orders" {
  name                       = "orders"
  visibility_timeout_seconds = 300
}
resource "aws_sqs_queue" "emails" {
  name                       = "emails"
  visibility_timeout_seconds = 60
}
resource "aws_sqs_queue" "reports" {
  name                       = "reports"
  visibility_timeout_seconds = 900
}
```
check: resource.aws_sqs_queue count 1 | There's exactly one aws_sqs_queue block
check: resource.aws_sqs_queue.q.for_each.expr = var.queues | It uses for_each = var.queues
check: resource.aws_sqs_queue.q.name.expr = each.key | name = each.key
check: resource.aws_sqs_queue.q.visibility_timeout_seconds.expr = each.value | visibility_timeout_seconds = each.value
check: variable.queues.default.orders = 300 | The default has orders = 300
check: variable.queues.default.emails = 60 | …emails = 60
check: variable.queues.default.reports = 900 | …reports = 900
solution:
```hcl
variable "queues" {
  type = map(number)
  default = {
    orders  = 300
    emails  = 60
    reports = 900
  }
}

resource "aws_sqs_queue" "q" {
  for_each                   = var.queues
  name                       = each.key
  visibility_timeout_seconds = each.value
}
```
hint: `for_each = var.queues`, then `each.key` and `each.value` (no quotes) inside.
:::
::: quiz
q: You set ignore_changes = all on a bucket because every plan showed a tag diff. What have you done?
- Told Terraform to update tags in place and stop showing noise
+ Stopped Terraform from managing every attribute of that bucket, not only the tag
- Encrypted the tag
- Removed the bucket from state
why: all is not "ignore the noisy tag." It drops the whole resource out of future diffs, so a real change to encryption or versioning will not appear. Ignore the one tag, or fix the config so it matches the API's normalized tags.
:::
::: card
q: When is create_before_destroy the wrong lifecycle setting?
answer: When the resource name must be unique, so the new object cannot exist until the old one is gone. An S3 bucket with a fixed name, or an IAM role with a fixed name, will fail the create because the name is taken. create_before_destroy is for objects that can overlap, such as an instance that a load balancer addresses by id.
:::
::: predict lang=python
q: count identifies instances by position. Removing the first of three names shifts the others. What does this print?
code:
```python
before = ["a", "b", "c"]
after = ["b", "c"]
print("destroy-index", len(before) - 1)
print("index0-now", after[0])
```
answer:
```text
destroy-index 2
index0-now b
```
why: Terraform keeps index 0 and index 1 and drops index 2. Index 0 used to be a and is now b, so that instance is updated or replaced. for_each keyed by "a" would destroy only a.
:::
::: quiz
q: A module should create one SQS queue per entry in a map of name to timeout. Which meta-argument belongs on the queue resource?
- count = length(var.queues), and index into keys(var.queues)
+ for_each = var.queues, with name = each.key
- dynamic "queue" inside a single aws_sqs_queue
- depends_on = var.queues
why: The map key is a stable address. count shifts when the map's key order changes. dynamic repeats nested blocks, and a queue is a whole resource. depends_on does not create instances.
:::
## Expressions: for, dynamic, functions, conditionals, splat
id: expressions
stage: reuse
minutes: 45
goal: Shape values with for expressions, conditionals, functions, and splat, and repeat nested blocks with dynamic.
needs: meta
source: Terraform: for expressions | https://developer.hashicorp.com/terraform/language/expressions/for
source: Terraform: Dynamic blocks | https://developer.hashicorp.com/terraform/language/expressions/dynamic-blocks
source: Terraform: Functions | https://developer.hashicorp.com/terraform/language/functions
source: Terraform: Conditional expressions | https://developer.hashicorp.com/terraform/language/expressions/conditionals
source: Terraform: Splat expressions | https://developer.hashicorp.com/terraform/language/expressions/splat

`for_each` creates infrastructure. A `for` expression creates a value: a list or a map in memory, used as an argument. Mixing those up leads to dynamic blocks wrapped around whole resources, which is not legal, or to copy-pasted ingress rules that drift apart. This lesson is the value language: transform, filter, branch, call a function, and expand a list of attributes. The resource graph stays in the meta-arguments you already know.

### for expressions

```hcl
locals {
  public_cidrs = [for s in var.subnets : s.cidr if s.public]
  by_name      = { for s in var.subnets : s.name => s.cidr }
}
```

The list form keeps order. The map form must have unique keys. A duplicate `s.name` is an error, which is what you want. The `if` clause filters. There is no `else` in the filter; the false items are dropped, not replaced with null. If you need a parallel list of the same length, do not filter. Build a list of nulls with a conditional inside the expression, or you will zip the wrong cidr onto the wrong subnet later.

`for` cannot loop until a cloud condition becomes true. It is not a `while`. It cannot create resources. The result has to be known enough for whatever consumes it. A `for_each` over `{ for s in var.subnets : s.name => s }` is the usual bridge: the expression makes the map, the meta-argument makes the subnets.

### Conditionals

```hcl
locals {
  nat_count = var.env == "prod" ? 2 : 1
}
```

Both arms must be the same type. `var.env == "prod" ? "on" : 1` is a type error, not a runtime surprise. That trips people coming from Python. The other trip is that a conditional is not a way to pick a resource type. You cannot say `var.edge ? aws_cloudfront_distribution.this : aws_lb.this` as an expression that creates one of them. You create both with `count` of 0 or 1, or you split modules. The conditional chooses a value, such as a number, a string, or a list.

Unknown values: if `var.env` is known, the unused arm is not applied to the cloud, but both arms still have to type-check. Do not put an expression that can error in the unused arm and assume it is skipped the way a lazy language would skip a throw. Keep both arms boring.

`null` is a real value. A conditional that returns null for "do not set this argument" works for some provider arguments that omit the attribute when null, and it is rejected by others. Read the provider doc. Passing null into a string argument that is required is a plan error you want, not a blank resource.

### Functions

Terraform ships functions. It does not let you define your own, except through a provider that exposes one, which is rare and usually a bad idea. You compose `lower`, `replace`, `substr`, `format`, `join`, `split`, `coalesce`, `try`, `length`, `contains`, `merge`, `flatten`, `distinct`, `cidrsubnet`, `jsonencode`, `templatefile`. A name you wish existed is a sign to compute it in a local from these, or to pass the value in already computed.

`templatefile` reads a file at plan time and renders `${}` with the map you pass. The file is part of the configuration. A template that includes a secret bakes the secret into state wherever the result is stored. `jsonencode` of an IAM policy is the right way to build a policy document so you are not fighting string escaping. The AWS provider often wants the JSON string, and it may return the policy with different spacing. Compare hashes or accept the provider's normalization rather than ignoring the whole policy.

`try(local.maybe[0], null)` hides errors. Use it when absence is legitimate. Do not wrap every expression in `try` to make a red plan green. A green plan that swallowed a typo is a wrong subnet.

`merge(local.base_tags, var.extra_tags)` is the tag pattern. Later maps win on key collision. Be explicit about which side wins, and do not merge a user-supplied map over `prevent` tags such as `env` if a caller can override the environment tag and break cost allocation.

### Splat

```hcl
output "subnet_ids" {
  value = aws_subnet.public[*].id
}
```

Splat `[*]` turns a list of objects (the `count` instances) into a list of one attribute. On a single object, `obj[*].id` still produces a list, which surprises people who wanted one string. For `for_each`, the resource is a map, not a list. `aws_subnet.public[*].id` does not do what you think. Use a `for` expression: `[for s in aws_subnet.public : s.id]`, or `values(aws_subnet.public)[*].id` if you accept values() order. The misconception "splat works on everything" causes a type error the first time someone converts `count` to `for_each` and leaves the output alone.

Splat of an empty `count` is an empty list, which is often the correct input to a module. That is nicer than a conditional around a single index `[0]` that panics when count is 0. `one(...)` is the function that demands exactly one element and is the right check when empty or many would be a bug.

### Dynamic blocks

```hcl
resource "aws_security_group" "app" {
  name = "app"
  dynamic "ingress" {
    for_each = var.ports
    content {
      from_port   = ingress.value
      to_port     = ingress.value
      protocol    = "tcp"
      cidr_blocks = ["10.0.0.0/8"]
    }
  }
}
```

The label `ingress` is the block type you are repeating. Inside `content`, the iterator is named `ingress` unless you set `iterator`. `for_each` here is a value, usually a list or map of ports, not a reason to create many security groups. Zero ports means zero blocks, which may be illegal if the provider requires one. Say so in validation.

Dynamic blocks cannot appear in some places (module blocks have their own rules; you do not dynamic a `resource` keyword). They also obscure the plan: a reviewer sees a single security group and has to imagine the rules. If the rules are few and security-sensitive, write them out. If they are a long list of ports from a variable, dynamic is the point, and the variable belongs in the PR.

You can nest dynamics. It becomes unreadable quickly. A nested dynamic that builds IAM statements is a sign the policy should be a template or a `aws_iam_policy_document` data source, which is a data source that renders JSON without creating anything.

### Strings and types, the small cuts

`"10"` and `10` are different. A provider argument typed as a number will not always coerce the string you built with `"${var.n}"`. Prefer the bare number. Interpolation of a single reference, `"${var.env}"`, is the same as `var.env` and the linter will tell you to drop the quotes. Interpolation is for building a larger string: `"acme-${var.env}-logs"`.

A `for` expression over a map iterates values, and you can write `for k, v in var.queues`. Forgetting `k, v` and writing `for v in var.queues` still works; the key is dropped. Building names from values only, when the key was the name, creates duplicates.

### You can now

- Filter and rekey a list of objects with `for`, and hand the map to `for_each`.
- Write a conditional whose arms match in type, and not use it to choose a resource type.
- Reach for `merge`, `jsonencode`, `cidrsubnet`, and `one` instead of string math.
- Splat a `count` result, and use `for` when the resource used `for_each`.
- Repeat a nested block with `dynamic`, and leave the resource itself to `for_each`.

::: quiz
q: You converted a subnet from count to for_each. The output aws_subnet.public[*].id stops type-checking. What replaces it?
- It still works; splat always returns a list of ids
+ A for expression over the map, such as [for s in aws_subnet.public : s.id]
- dynamic "id" so the output grows
- count = length(aws_subnet.public) on the output block
why: for_each resources are maps. Splat is defined for lists, which is what count produces. Outputs are not resources, so count on an output is not how you collect ids. A for expression walks the map.
:::

::: card
q: What is the difference between a for expression and for_each?
answer: A for expression builds a list or a map value. It does not create cloud objects. for_each is a meta-argument on a resource or module that creates one instance per key, with its own state address. Dynamic blocks use for_each too, but only to repeat nested blocks inside one resource.
:::

::: predict lang=python
q: A conditional's two arms must be the same type. This checker rejects a string mixed with a number. What does it print?
code:
```python
def arm_type(env):
    left = "on"
    right = 1
    if type(left) != type(right):
        return "type error"
    return left if env == "prod" else right

print(arm_type("prod"))
```
answer:
```text
type error
```
why: Terraform type-checks both arms of ? :, even though only one value is selected. "on" and 1 cannot sit in the same expression. Make both strings or both numbers.
:::

::: config lang=hcl
task: Declare variable ports as list(number) with default [80, 443]. Local open must be the for expression [for p in var.ports : p if p > 0]. Local nat must be the conditional var.env == "prod" ? 2 : 1. Add aws_security_group named app with name app and one dynamic ingress block, for_each = var.ports, content protocol tcp, from_port and to_port both ingress.value.
starter:
```hcl
variable "env" {
  type = string
}
variable "ports" {
  type = list(string)
}
```
check: variable.ports.type.expr = list(number) | ports is list(number)
check: variable.ports.default = [80,443] | default is [80, 443]
check: locals.open[0].expr = for p in var.ports : p if p > 0 | open filters ports with a for expression
check: locals.nat.expr = var.env == "prod" ? 2 : 1 | nat is a conditional
check: resource.aws_security_group.app.dynamic.ingress.for_each.expr = var.ports | dynamic ingress iterates var.ports
check: resource.aws_security_group.app.dynamic.ingress.content.protocol = tcp | protocol is tcp
check: resource.aws_security_group.app.dynamic.ingress.content.from_port.expr = ingress.value | from_port is ingress.value
solution:
```hcl
variable "env" {
  type = string
}

variable "ports" {
  type    = list(number)
  default = [80, 443]
}

locals {
  open = [for p in var.ports : p if p > 0]
  nat  = var.env == "prod" ? 2 : 1
}

resource "aws_security_group" "app" {
  name = "app"
  dynamic "ingress" {
    for_each = var.ports
    content {
      from_port = ingress.value
      to_port   = ingress.value
      protocol  = "tcp"
    }
  }
}
```
hint: type = list(number) has no quotes. The for expression and the ? : conditional are written unquoted. Inside dynamic "ingress", the iterator name is ingress.
:::

::: quiz
q: You want either a load balancer or CloudFront, chosen by a variable, but not both. What works?
- A conditional expression that names the resource type
+ Two resources, each with count 0 or 1, so only one address exists
- A dynamic block whose label is the resource type
- for_each over a set of resource type strings
why: Expressions choose values, not which resource block exists. count of 0 or 1 is the meta-argument that includes or omits a whole resource. Dynamic blocks only repeat nested blocks inside a resource that already exists.
:::

## Modules
id: modules-tf
stage: reuse
minutes: 40
goal: Package a configuration as a module, call modules with inputs, and pin registry or Git sources.
needs: expressions
source: Terraform: Modules | https://developer.hashicorp.com/terraform/language/modules
source: terraform-aws-modules/vpc on the registry | https://registry.terraform.io/modules/terraform-aws-modules/vpc/aws/latest

Every directory Terraform runs is a module. The directory you apply is the root module. Directories it calls are child modules. A module boundary is an API: variables in, outputs out, resources hidden. Teams that skip the boundary put every resource in the root, and a change to a queue requires reading the network. Teams that over-build the boundary publish a module with eighty variables that restate the AWS provider. The useful middle is a small opinion: "a service," "a bucket that meets our baseline," "a VPC shaped the way we actually run."

### Calling a module

```hcl
module "network" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name = "shop"
  cidr = "10.20.0.0/16"
}
```

`source` is where the code comes from. A registry source should carry `version`. A Git source should carry a ref: `git::https://example.com/infra.git//modules/bucket?ref=v1.4.0`. An unpinned source changes when someone else tags latest, and the next init on a clean machine is a different module. Commit `.terraform.lock.hcl`. It records the selected module versions and provider hashes. `terraform init -upgrade` is a deliberate bump, reviewed like a dependency bump in an application.

A local source `./modules/service` is the right first module. You can read it, and you can change it in the same pull request as the caller. A registry module is a dependency you do not control. Read its variables and its release notes before you pin it. `terraform-aws-modules/vpc/aws` is large on purpose. Use it when you want that shape, not because a blog started there. A local VPC module of a hundred lines you understand is better than a registry module whose defaults open a path you did not notice.

Inputs are the child module's variables. You do not set the child's locals from outside. Outputs are `module.network.private_subnets`. Only the child's output blocks are visible. A resource inside the child is not `module.network.aws_vpc.this`. Reaching in is not a feature you are missing. If you need the id, the module must output it.

### What belongs inside

A child module should create one concept and its required companions: a bucket, its versioning, its encryption, its public-access block. Splitting those across the root "so the caller can choose" recreates the AWS provider and forgets the baseline. The project at the end of this module is that shape.

A child module should not create the whole company. A module that takes a flag for "also build the database, the cache, the topic, and the dashboard" becomes a second programming language. Split along ownership: the network module, the data module, the service module. Each has a state of its own when their lifecycles differ. One root that calls all three is fine for a small product. Separate states are the remote-state lesson, when a bad apply to the service must not hold a lock on the VPC.

Providers are configured in the root, not in the child, in current Terraform. A child that contains its own `provider` block is a warning and a trap: the provider configuration is not inherited the way people think, and aliases must be passed with `providers = { aws = aws.use1 }`. Configure providers in the root. Pass aliases down.

`terraform` and `backend` blocks belong only in the root. A child with a backend is ignored or an error depending on context, and it is never how you give a module its own state. Separate state means a separate root module, a separate directory you init and apply, not a nested backend.

### Versions and breaking changes

`~> 5.0` means `>= 5.0` and `< 6.0` for modules that follow the usual versioning. A major bump can rename variables. Pin the major. Read the upgrade guide. For an internal module, tag `v1.2.0` and do not move the tag. A moved tag is a lie in every lockfile that resolved it.

Inside the module, `required_version` and `required_providers` should be honest. A module that uses `optional()` object attributes needs a Terraform new enough to parse them. A module that uses `use_lockfile` does not, because the backend is not in the module. Do not copy the root's backend into the child "for documentation."

### The graph across modules

Module outputs are values. Another module can take them as inputs: `subnet_ids = module.network.private_subnets`. That edge is inside one state and one apply. Terraform will order the applies. It will not order two different states. If the network root and the service root are applied separately, the service reads an output that must already exist. That is remote state, and it is eventually consistent with whatever the network stack last applied. Do not paper over a missing output with a data source lookup "just this once" and also a remote state read. Pick one.

`count` and `for_each` work on `module` blocks. Addresses become `module.svc["api"]`. The same index-shift warning as resources applies. Moving an instance between two module addresses needs a `moved` block whose `from` and `to` are module addresses.

### Misreadings

**"Modules are for reuse across companies."** Most modules are reused twice: dev and prod. That is enough. Copy-pasted buckets are how the public-access block gets forgotten in one environment.

**"The registry is reviewed the way a standard library is."** It is published by someone. Pin it. Read the code for anything that takes an IAM role.

**"A module call is a function call with no state."** The resources are in the caller's state, under the module address. Destroying the call destroys the resources, unless you moved them or removed them with `destroy = false`. Deleting a `module` block is a destroy plan.

### File layout that survives contact with a team

```text
modules/bucket/versions.tf
modules/bucket/variables.tf
modules/bucket/main.tf
modules/bucket/outputs.tf
envs/prod/main.tf
envs/prod/backend.tf
```

`versions.tf` holds `required_providers` only. `variables.tf` holds inputs and validations, each with a description a caller can read without opening `main.tf`. `outputs.tf` is the contract. `main.tf` is the resources. This is convention, not a language rule. Terraform loads every `.tf` file in the directory as one module. Splitting files does not split state and does not create privacy. A second directory does.

Names inside the module can be boring. `aws_s3_bucket.this` is a common choice when the module creates one bucket. The caller's module label is the interesting name: `module "uploads"`. Addresses in state look like `module.uploads.aws_s3_bucket.this`. Renaming `uploads` is a move. Renaming `this` inside the module is also a move, and it is a breaking change for every caller because the state address changed under them. Publish a changelog when you rename a resource inside a shared module. Better: do not rename casually. The refactor lesson's `moved` block can ship inside the module so callers' next plan is a move rather than a destroy. That is one of the few times a child module contains a `moved` block, and it should stay there until every caller has applied it, then you can delete the block on a later major version.

Tests for a module live next to it, in `tests/`. The test lesson shows `terraform test`. A module with no outputs is hard to test and hard to use. If you cannot name three outputs a caller needs, the module may be doing the wrong thing, or it may be a leaf that only a human inspects in the console. Prefer outputs even then. CI should not have to parse a plan to learn the bucket name.

### You can now

- Draw the boundary: variables in, outputs out, no reaching into child resources.
- Pin registry modules with `version` and commit the lock file.
- Keep `provider` and `backend` blocks in the root.
- Pass a child output into another module in the same state.
- Treat deleting a module block as a plan full of destroys.

::: config lang=hcl
task: Call the registry module `terraform-aws-modules/vpc/aws`, pinned to `~> 5.0`, as `module "network"`, with `name = "shop"`, `cidr = "10.20.0.0/16"`, two AZs `eu-central-1a` and `eu-central-1b`, and `enable_nat_gateway = true`. Then add an output `private_subnets` with the value `module.network.private_subnets`.
starter:
```hcl
module "network" {
}
```
check: module.network.source = terraform-aws-modules/vpc/aws | source is terraform-aws-modules/vpc/aws
check: module.network.version = ~> 5.0 | version is pinned to ~> 5.0
check: module.network.name = shop | name = "shop"
check: module.network.cidr = 10.20.0.0/16 | cidr = "10.20.0.0/16"
check: module.network.azs = ["eu-central-1a","eu-central-1b"] | azs lists eu-central-1a and eu-central-1b
check: module.network.enable_nat_gateway = true | enable_nat_gateway = true
check: output.private_subnets.value.expr = module.network.private_subnets | The output's value is module.network.private_subnets
solution:
```hcl
module "network" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name               = "shop"
  cidr               = "10.20.0.0/16"
  azs                = ["eu-central-1a", "eu-central-1b"]
  enable_nat_gateway = true
}

output "private_subnets" {
  value = module.network.private_subnets
}
```
hint: `source` and `version` are strings. `azs = ["eu-central-1a", "eu-central-1b"]`. A module's outputs are `module.NAME.OUTPUT`.
:::
::: quiz
q: A child module creates aws_vpc.this. The root wants the vpc id. What is the legal reference?
- module.network.aws_vpc.this.id
+ module.network.vpc_id, after the child declares output "vpc_id"
- data.aws_vpc.this.id from inside the root, matching on name
- var.vpc_id, which Terraform fills from the child automatically
why: Child resources are not part of the parent's namespace. Only outputs cross the boundary. A data source lookup by name can attach to the wrong VPC and skips the dependency edge the output would have created.
:::
::: card
q: Where do backend and provider blocks go, and why not inside a reusable child module?
answer: In the root module that you actually init and apply. A backend in a child does not give that child its own state. Provider blocks belong in the root so aliases and credentials are configured once; the child receives an alias through providers = { aws = aws.use1 } when it should not use the default.
:::
::: predict lang=python
q: Deleting a module call plans destruction of everything that call created. What does this print?
code:
```python
def plan(module_present):
    if not module_present:
        return "destroy resources in that module"
    return "no change"

print(plan(False))
```
answer:
```text
destroy resources in that module
```
why: The resources live in the root state under the module address. Removing the module block removes those addresses. Terraform's plan is to destroy them, unless a moved or removed block says otherwise.
:::
::: quiz
q: Why commit .terraform.lock.hcl?
- It contains the state and the secrets
+ It pins provider hashes and the selected module versions so a clean init does not float
- It is the backend configuration
- Terraform will not plan without committing state next to it
why: The lock file is the dependency lock, not the state. State stays in the backend and out of Git. Without the lock, init can select a newer provider or module that still matches a loose constraint.
:::
::: config lang=hcl
task: The uploads module tracks terraform-aws-modules/s3-bucket/aws at the single version 5.0.0, so a lockfile delete can sit on that exact selection with no major bound written in the module block. Change the version constraint so 5.x updates are allowed and 6.0 is not. Do not change the source or the bucket name.
starter:
```hcl
module "uploads" {
  source  = "terraform-aws-modules/s3-bucket/aws"
  version = "5.0.0"

  bucket = "acme-uploads"
}
```
check: module.uploads.source = terraform-aws-modules/s3-bucket/aws | The source stays the registry module
check: module.uploads.version = ~> 5.0 | The version constraint is ~> 5.0
check: module.uploads.bucket = acme-uploads | The bucket name stays acme-uploads
solution:
```hcl
module "uploads" {
  source  = "terraform-aws-modules/s3-bucket/aws"
  version = "~> 5.0"

  bucket = "acme-uploads"
}
```
hint: The pessimistic constraint for major 5 is written ~> 5.0. A bare 5.0.0 is one version, not that range.
:::
## Refactor without destroying: moved, import, removed
id: refactor
stage: reuse
minutes: 45
goal: Change addresses and adopt or forget objects with moved, import, and removed, so a rename is not a destroy.
needs: modules-tf
source: Terraform: moved block | https://developer.hashicorp.com/terraform/language/moved
source: Terraform: Import | https://developer.hashicorp.com/terraform/language/import
source: Terraform: removed block | https://developer.hashicorp.com/terraform/language/block/removed

Terraform binds a real object to an address in state: `aws_s3_bucket.logs`, `module.uploads.aws_s3_bucket.this`, `aws_sqs_queue.q["orders"]`. The cloud object does not know that address. Only state does. Any edit that changes the address looks, to a naive plan, like "the old address is gone, a new address must be created." For a bucket, that is destroy and create. For a database, that is the outage. Refactoring tools exist so the address can change while the object id stays.

### moved

```hcl
moved {
  from = aws_s3_bucket.logs
  to   = aws_s3_bucket.app_logs
}
```

You rename the resource in code, and you add `moved` so state follows. The next plan should say the resource moved, not that it will be replaced. Apply records the new address. After every environment has applied, you can delete the `moved` block. Leaving it forever is harmless but noisy. Deleting it before prod applies makes prod plan a destroy.

`from` and `to` can be module addresses, `count` indexes, and `for_each` keys. Moving `aws_instance.app[0]` to `aws_instance.app["api"]` is how you escape `count` without rebuilding. One `moved` block per instance. A typo in the key moves nothing and the plan still destroys. Read the plan. The move is the absence of `-/+` on that object.

`moved` does not change the cloud. It does not rename an S3 bucket's actual name. If you also change the `bucket` argument, you still get a replacement, and the move only means the replacement is tracked under the new address. Fix one thing at a time: first move the address and plan, then change arguments that are in-place, and treat force-new arguments as a migration project with data copy, not as a rename.

A `moved` block inside a shared module rewrites addresses for every caller. That is how you ship a rename safely. It is also how you destroy every caller if `to` is wrong. Review it like a migration.

### import

An object created in the console, or by another tool, can be adopted.

```hcl
import {
  to = aws_s3_bucket.logs
  id = "acme-logs"
}
```

`to` is the address you will manage. `id` is the provider's import id, which is not always the name. For many AWS resources it is the name or the ARN. The provider doc is the authority. A wrong id imports the wrong object or errors. Import does not generate perfect configuration by itself in every case. Current Terraform can generate config (`terraform plan -generate-config-out=...`) so you do not hand-write every attribute. You still read the result. Generated blocks often need `lifecycle` and split resources (bucket versioning is its own resource in AWS provider v4+).

The import block is declarative and belongs in review, unlike a one-off `terraform import` typed on a laptop and forgotten. The CLI still works and is easy to run against the wrong state. Prefer the block. After a successful apply, remove the `import` block. A later apply does not re-import; the block is instructions for state that does not yet contain the address. Leaving it in after import is a no-op only while the address exists. If someone state-rms the address, the block imports again. Know that.

You cannot import into an address that already tracks a different object. Move or remove first. Import does not copy data between buckets. It only starts tracking.

### removed

Deleting a resource block plans a destroy. Sometimes you want the block gone and the object left alive: a handoff to another team, a move to another state, a console-owned resource you should never have managed.

```hcl
removed {
  from = aws_s3_bucket.legacy
  lifecycle {
    destroy = false
  }
}
```

The current `removed` block reference says the `lifecycle` block is required, and that the default behaviour is to destroy the real object when dropping it from state. `destroy = false` is the "forget, do not delete" switch. `destroy = true` is "I am deleting this from code and I do want the cloud object gone," which is close to just deleting the resource block, but it records the intent when the address is being refactored. Always set `destroy` explicitly so a reviewer sees it. The scary misreading is "removed means keep the infrastructure." It does not, unless `destroy` is false.

`terraform state rm` is the imperative form of forget. It does not destroy. It also does not appear in the PR unless you script it. Prefer `removed` with `destroy = false` so the forget is reviewed. `state rm` on the wrong address is silent success and the next apply recreates the object, or ignores a production database you still thought you managed.

Order of operations when splitting a state: import into the destination state (or `removed` plus a copy of config), then `removed { destroy = false }` in the source, then apply the source so it forgets. If you destroy in the source first, the destination imports nothing. If both states manage the object, two applies will fight. Only one state should list the address.

### Generating configuration, and the ids that are not names

`terraform plan -generate-config-out=generated.tf` writes HCL for addresses in `import` blocks that do not yet have configuration. Treat that file as a draft. It often uses the legacy inline style the provider still accepts, skips your tagging locals, and may set arguments that force replacement on the next plan if they do not match the live object exactly. The workflow is: generate, move the blocks into the real module, delete anything your baseline module already creates, plan, and confirm the plan is empty or is an in-place update you accept. An import plan that wants to replace the object has the wrong id or the wrong arguments. Stop.

Import ids differ by resource. An S3 bucket's import id is the bucket name. An IAM role policy attachment is often a compound id with roles and policy ARNs joined by a slash or comma, exactly as that resource's import docs say. Guessing from the console URL imports nothing or imports a sibling. When the docs say the id is the ARN, a name will not do.

`moved` history can chain. If last month's block moved `a` to `b` and this month you move `b` to `c`, Terraform applies the chain. Do not rewrite an old `from` that some environment has already applied and some has not. Add a new block. Environments that are behind still need the old step. This is another reason a long-lived branch that renames resources is painful: the move blocks and the applies have to land in order.

### What these do not fix

| Tool | Changes state address | Changes cloud | Destroys by default |
|---|---|---|---|
| `moved` | yes, to a new address | no | no |
| `import` | starts tracking an address | no | no |
| `removed` with `destroy = false` | drops the address | no | no |
| `removed` with `destroy = true` | drops the address | yes, deletes | yes |
| editing `terraform.tfstate` | whatever you break | no | you will not enjoy it |

Changing provider alias, changing a force-new argument, or changing a `for_each` key without a matching `moved` still replaces infrastructure. `prevent_destroy` makes the bad plan fail, which is a seatbelt, not a refactor.

### At work

A rename PR contains three things: the new code, the `moved` block, and a plan with no destroys. CI should fail the job if the plan's destroy count is non-zero, with a bypass label for the rare intentional destroy. Import PRs include the import id and a plan that updates only the attributes you accept drifting from the generated config. Someone still has to own the object after import. Importing a bucket you do not understand adopts its public policy too.

### You can now

- Add `moved` when an address changes, and expect the plan not to replace the object.
- Import with a block, using the provider's id, and delete the block after apply.
- Set `removed` `destroy = false` to forget an object, and never assume `removed` is safe by itself.
- Split one state into two without a window where nothing manages the object, or where both do.
- Refuse a refactor plan that still shows `-/+`.

::: quiz
q: You rename aws_db_instance.db to aws_db_instance.main and add a moved block from the old address to the new one. The plan still shows -/+ . What is the likely cause?
- moved blocks always destroy on the first apply
+ You also changed an argument that forces replacement, such as the instance identifier. moved only changes the address
- The database is too large to move
- moved must be written in the state JSON
why: moved rewrites state identity. It does not make force-new arguments in-place. A rename of the RDS identifier still replaces the database. Separate the address move from the argument change and read the plan between them.
:::

::: card
q: What does removed { lifecycle { destroy = false } } do, and what happens if destroy is true?
answer: destroy = false drops the address from state and leaves the cloud object running. The documented default is to destroy the real object when removing it from state, and the lifecycle block is required. destroy = true deletes the infrastructure. removed is not a synonym for "keep it."
:::

::: predict lang=python
q: Apply the source stack only after the destination is tracking the object. This prints the safe order's last step. What does it print?
code:
```python
steps = ["import-into-dest", "removed-destroy-false-in-source", "apply-source"]
print(steps[-1])
```
answer:
```text
apply-source
```
why: The destination must import first. Then the source forgets with destroy = false and you apply the source. Applying a destroy in the source before the import leaves the destination nothing to adopt. Two states must not manage the same address after this.
:::

::: config lang=hcl
task: Import an existing bucket into aws_s3_bucket.logs with id acme-logs. Move that address to module.storage.aws_s3_bucket.logs. Forget aws_s3_bucket.legacy with a removed block whose lifecycle destroy is false.
starter:
```hcl
removed {
  from = aws_s3_bucket.legacy
  lifecycle {
    destroy = true
  }
}
```
check: import.to.expr = aws_s3_bucket.logs | import to is aws_s3_bucket.logs
check: import.id = acme-logs | import id is acme-logs
check: moved.from.expr = aws_s3_bucket.logs | moved from the bucket resource
check: moved.to.expr = module.storage.aws_s3_bucket.logs | moved to the module address
check: removed.from.expr = aws_s3_bucket.legacy | removed from the legacy bucket
check: removed.lifecycle.destroy = false | destroy is false so the object is kept
solution:
```hcl
import {
  to = aws_s3_bucket.logs
  id = "acme-logs"
}

moved {
  from = aws_s3_bucket.logs
  to   = module.storage.aws_s3_bucket.logs
}

removed {
  from = aws_s3_bucket.legacy
  lifecycle {
    destroy = false
  }
}
```
hint: import id is a string. to and from are addresses, so they are not quoted. The starter destroys; set destroy = false.
:::

::: quiz
q: After a successful import apply, what should you do with the import block?
- Keep it forever so Terraform re-imports every plan
+ Remove it once state contains the address. It is an instruction for adopting, not a resource
- Convert it into a data source
- Commit the state file next to it
why: The block tells Terraform how to adopt an address that is not yet in state. After apply, the address is tracked like any other resource. Leaving the block is how a later state rm silently imports again. State stays out of Git.
:::

## Testing Terraform: test, validate, tflint, checkov
id: tf-test
stage: team
minutes: 40
goal: Catch bad plans with terraform test, and know what validate, tflint, and policy scanners do not prove.
needs: refactor
source: Terraform: Tests | https://developer.hashicorp.com/terraform/language/tests
source: Terraform: terraform test | https://developer.hashicorp.com/terraform/cli/commands/test
source: Terraform: terraform validate | https://developer.hashicorp.com/terraform/cli/commands/validate
source: TFLint | https://github.com/terraform-linters/tflint
source: Checkov | https://www.checkov.io/

A plan reviewed by a human is still the production control. Tests exist so the mistakes you can name do not depend on that human being awake. Terraform's own test runner, `terraform test`, evaluates assertions against a plan or an apply. `validate` only checks that the configuration parses and the provider schema accepts the arguments. `tflint` is a linter. Checkov and similar scanners are policy. None of them talk to your production state unless you point them at it. Confusing those layers is how a pipeline goes green and then destroys a database.

### terraform test

Tests live in `tests`, file names ending in `.tftest.hcl`, or next to the module.

```hcl
run "versioning" {
  command = plan

  variables {
    env = "dev"
  }

  assert {
    condition     = aws_s3_bucket_versioning.this.versioning_configuration[0].status == "Enabled"
    error_message = "versioning must be enabled"
  }
}
```

`command = plan` builds a plan and asserts on it. It does not apply. `command = apply` really creates infrastructure unless the provider is mocked. For a module that only composes AWS resources, a plan test is the default. An apply test belongs in a sandbox account with cleanup, or behind mocks.

The current Terraform test language can mock providers (`mock_provider` and related overrides, documented under tests). A mock returns values you specify so CI does not need AWS credentials and does not create buckets. Mocks do not prove the AWS API would accept the call. They prove your module wires arguments the way you asserted. Keep one real plan in a sandbox on a schedule if you need to know the provider still agrees. Do not mock production.

Assertions see the planned resource values, outputs, and variables you passed in the `variables` block. They do not see a separate environment's tfvars unless you pass them. A test that forgets `env = "prod"` is testing the default, which may be dev-shaped. State the inputs in the test.

Multiple `run` blocks can depend on each other. An earlier apply run's state is visible to a later run. That is useful and it is how tests accidentally share a bucket name and fail in parallel CI. Give tests unique names, or use mocks.

`terraform test` is not `terraform validate`. A test failure is an assertion. A validate failure is "this argument does not exist on this resource." Both should fail CI. They answer different questions.

### validate and fmt

`terraform fmt -check` fails when the files are not in canonical format. It knows nothing about AWS. `terraform validate` loads the schema and checks types and references. It does not refresh state and it does not read production. You can validate with `-backend=false` after an init that did not configure the backend, which is what you want on a laptop that should not hold prod credentials. Validate will not notice that `bucket = "AWS_S3_BUCKET.LOGS.ID"` is a nonsense name. The string is a valid string. The plan, or a test that asserts on the reference, is what notices you quoted a reference. Validate also will not notice a destroy.

### tflint

TFLint runs rules: deprecated arguments, missing provider version pins, AWS-specific mistakes such as an invalid instance type, naming rules you configure. It is faster than a plan and it runs without credentials. It is only as good as the rule pack you enabled. A green tflint with the AWS ruleset off is `fmt` with extra steps. Pin the plugin versions. A linter that floats can fail the build on a Monday because a new rule shipped, or worse, go quiet because a plugin failed to download and someone added `|| true`.

Do not encode "is this a good VPC?" only in a linter. The module should make the bad VPC hard to ask for. The linter is the backstop.

### Policy scanners

Checkov, tfsec, and Trivy config read HCL and flag missing encryption, public buckets, open security groups, and similar rules. They do not apply. They also misread dynamic blocks and modules sometimes, reporting the caller as clean because the dangerous argument is inside a module, or reporting the module as dangerous because a variable could be public. Treat a finding as a lead. A suppressed finding needs a comment with a reason and an expiry, not a blanket skip.

Scanners do not replace `prevent_destroy`, a locked state, or a human reading destroys. A scanner cannot see that this particular plan replaces the database. That is in the plan.

### What to run when

| Check | Needs cloud credentials | Fails on a destroy plan | Proves |
|---|---|---|---|
| `fmt -check` | no | no | formatting |
| `validate` | no, if backend disabled | no | schema and references |
| `tflint` | no | no | rules you enabled |
| Checkov / Trivy | no | no | policy heuristics |
| `terraform test` plan, mocked | no | only if you assert it | module wiring |
| `terraform plan` against real state | yes | you see it | this change, this state |

CI for a pull request should run the top rows always, and a plan against the right state with read-only credentials. The apply job is separate, on the protected branch, with the role that can write. The team lesson covers OIDC. Here the point is not to pretend `terraform test` is that plan. The test locks the module's contract. The plan locks this environment's next diff.

### Misreadings

**"Assert on the AWS account in a unit test."** That test is an integration test. It will flake, cost money, and leak into the wrong account if the credentials are the developer's admin keys.

**"command = apply in CI against prod state."** The test runner is not a second apply pipeline with a ticket. Point tests at mocks or at a sandbox.

**"A green scanner means the bucket is private."** It means the scanner's rule matched the HCL it could see. A `aws_s3_bucket_public_access_block` with `block_public_acls = var.public` is not a boolean the scanner can fold if it does not evaluate variables. Your test can: pass `public = true` and assert the attribute is still true because the module ignores that variable. That is a better test than a policy pdf.

### Where assertions go wrong

Assert the smallest fact that would have caught the last incident. "Versioning status is Enabled" is a fact. "The plan is non-empty" is not a useful test of a module, because a module test has no previous state and the plan is almost always non-empty. "No resource has prevent_destroy" is a bad assertion to copy into a sandbox module that should be destroyable. Prod's prevent_destroy is a root-module concern, and a unit test of a shared bucket module can assert the argument is present and true, while the sandbox root passes a variable only if you deliberately designed an escape. Many teams refuse the escape. The module always sets `prevent_destroy = true`, and sandboxes are a different module. That is stricter and easier to test.

An assertion that hard-codes a full ARN will fail in every account. Assert on the parts you control: encryption algorithm, a tag, a boolean, a name prefix built from `var.env`. Leave account ids to a sandbox plan.

`error_message` should say what to change. "failed" wastes the next person's time. "versioning must be enabled" points at the resource. Terraform prints that message when the condition is false. It does not print a diff. Write it as a sentence a reviewer can act on.

### You can now

- Write a `run` block with `command = plan` and an assertion on a planned attribute.
- Say what validate refuses to know.
- Enable a real tflint ruleset, not an empty config.
- Treat scanner findings as leads, and plan output as the destroy check.
- Keep apply tests out of production credentials.

::: quiz
q: CI runs terraform validate and it passes. The pull request removes a database resource. What do you know?
- The database will not be destroyed
+ The configuration is syntactically valid for the provider schema. Validate does not plan and does not look at destroys
- State was locked
- tflint would have failed if it had run, so you can skip the plan
why: Validate does not refresh and does not diff. A deleted resource block is valid HCL. The destroy is a plan event. tflint also does not show the destroy count. Read the plan.
:::

::: card
q: What does command = plan mean inside a terraform test run block, and what does a mock provider add?
answer: command = plan evaluates assertions against a plan and does not apply. A mock provider supplies fake attribute values so the test can run without cloud credentials. The mock does not prove AWS would accept the request. A real sandbox plan still has to exist somewhere if you care about the live API.
:::

::: predict lang=python
q: Policy scanners do not see a destroy count. This prints what a review still has to open. What does it print?
code:
```python
def next_artifact(scanner_clean):
    if scanner_clean:
        return "plan"
    return "plan"

print(next_artifact(True))
```
answer:
```text
plan
```
why: A clean Checkov run and a failing Checkov run both leave the destroy question unanswered. The plan is the artifact that lists adds, changes, and destroys for this state. Scanners never replace it.
:::

::: config lang=hcl
task: Write a terraform test run named versioning with command plan. Its assert condition must mention aws_s3_bucket_versioning.this, and its error_message must be the text versioning must be enabled.
starter:
```hcl
run "versioning" {
  command = apply
}
```
check: run.versioning.command.expr = plan | command is plan, not apply
check: run.versioning.assert.condition.expr ~ /aws_s3_bucket_versioning\.this/ | The condition references the versioning resource
check: run.versioning.assert.error_message = versioning must be enabled | error_message explains the failure
solution:
```hcl
run "versioning" {
  command = plan
  assert {
    condition     = aws_s3_bucket_versioning.this.versioning_configuration.status == "Enabled"
    error_message = "versioning must be enabled"
  }
}
```
hint: command = plan has no quotes in the sense of a string? It is an unquoted keyword-like identifier plan. Put the condition and error_message inside assert.
:::

::: quiz
q: A teammate wants terraform test to apply the production root module on every pull request so the assertions are realistic. What is wrong?
- Nothing; apply tests are the only meaningful tests
+ An apply command creates or changes real infrastructure. Production applies belong in the protected apply job, not in the test runner on unmerged code
- Tests cannot use command = apply at all
- Plan tests always need a DynamoDB lock table
why: command = apply is real. Running it from a pull request uses whatever credentials the job has, against whatever backend the root uses. That is an unreviewed apply. Mock the provider or target a sandbox. Prod stays on the apply pipeline.
:::

## Environments and workspaces
id: envs
stage: team
minutes: 40
goal: Separate dev and prod so one apply cannot touch both, and use workspaces only when you understand the shared config.
needs: tf-test, state
source: Terraform: Workspaces | https://developer.hashicorp.com/terraform/language/state/workspaces
source: Terraform: S3 backend | https://developer.hashicorp.com/terraform/language/backend/s3

An environment is a boundary: its own objects, its own blast radius, usually its own AWS account, always its own state. A workspace is a Terraform feature that stores several states for one configuration. People use the word environment for both, and then they apply production while the shell still says `default`. This lesson is the difference, and a default you can defend: one directory per environment, one state key per directory, one account when the organization can bear it.

### The layout

```text
infra/
  modules/bucket/
  envs/dev/main.tf
  envs/dev/backend.tf
  envs/prod/main.tf
  envs/prod/backend.tf
```

`envs/dev/main.tf` calls the same module as prod and passes smaller instance sizes, a different CIDR, and `env = "dev"`. `backend.tf` sets a different `key`: `dev/app/terraform.tfstate` versus `prod/app/terraform.tfstate`. Same bucket is acceptable. Same key is an incident. CI jobs set `working-directory` so a dev pull request cannot init prod. The prod apply role's trust policy only matches the prod workflow on the prod branch.

Copying the root between dev and prod duplicates a little HCL. That duplication is the list of differences, and it is easier to review than a single root full of `var.env == "prod" ? ... : ...`. Put the shared shape in the module. Put the differences in the roots. A conditional that changes a CIDR in one root is how dev and prod silently share a network address and a peering becomes a loop.

### Workspaces

`terraform workspace new dev` and `terraform workspace select prod` switch state inside one backend configuration. On the S3 backend, the `default` workspace uses the key as written. Any other workspace stores state under `<workspace_key_prefix>/<workspace_name>/<key>`. The prefix defaults to `env:`. The state for workspace `prod` and key `app/terraform.tfstate` is `env:/prod/app/terraform.tfstate`. Note the colon. IAM policies that allow the bare key and not `env:/*` will plan in default and fail, or worse, succeed only in default so everyone uses default.

Workspaces share one configuration. You cannot say "prod's copy of main.tf is different" without conditionals on `terraform.workspace`. Those conditionals are untyped strings. A new workspace named `production` instead of `prod` falls through the else branch and builds a second dev inside the prod account, or builds prod-sized objects in a scratch workspace. `terraform.workspace` is not validated for you. If you use it, validate it.

Workspaces are a reasonable fit for short-lived copies of one identical stack: a preview environment per pull request, torn down by destroying that workspace, with a name prefix so objects do not collide. They are a poor fit for prod versus dev, because the configuration wants to differ, the credentials want to differ, and the cost of selecting the wrong workspace is the whole prod state. The CLI prompt does not show the workspace unless you ask. `terraform workspace show` in CI, printed in the log, is the minimum if you go this way. A directory name is harder to forget than a hidden selection stored in `.terraform/environment`.

### Accounts and credentials

Separate accounts mean a prod role cannot see dev's buckets and a dev plan cannot describe prod's database. The S3 backend docs describe an admin account that holds state and environment accounts that hold the objects, with `assume_role` chosen per workspace. That pattern can work. It still uses workspaces, so the selection problem remains. The same assume-role map with two directories is easier to explain: this directory's provider block contains the prod role ARN and nothing else. There is no map to mis-index.

Do not use one IAM user for both. Do not keep prod credentials in a developer's `AWS_PROFILE` that also has dev. The workflow lesson already said plan and apply should use the same role. Here the extra rule is: the role is per environment, and a human's daily role is not the apply role.

### Names must not collide

Two states creating a bucket named `acme-logs` will fight, whether or not the states are "separate." Bucket names are global. IAM role names are per account. If dev and prod share an account, prefix every name with the environment. If they do not share an account, still prefix. Someday someone peers them or copies a snapshot, and unprefixed names become confusing even when they are not a collision.

`prevent_destroy` on prod's database and not on dev's is a reason to keep two roots. A module argument `prevent_destroy` that defaults to false will be false in prod the day someone forgets to pass it. Some teams hard-code `prevent_destroy = true` in the prod root by wrapping the database there, not in the shared module. Others use two module entry points. Either is more honest than a boolean nobody tests.

### What not to share

| Shared | Not shared |
|---|---|
| Module source, pinned | State key |
| Provider version constraint | Apply credentials |
| Tag keys | `prevent_destroy` if prod must differ |
| CI workflow file, parameterized by directory | The workspace you "will remember to select" |

A shared CI workflow with a matrix of directories is good. A shared CI workflow with a matrix of workspace names and one directory is the footgun with extra YAML.

### Applying and destroying

Destroy is per state. `terraform destroy` in `envs/dev` destroys dev's objects and does not open prod's state, as long as the backend key is dev's key. That is the payoff of the layout. A workspace destroy destroys the selected workspace only, and the default workspace is easy to have selected. Protect prod by not giving the destroy credentials to the dev job, not only by hoping the directory is right. A pipeline that can assume the prod role from a pull request is not saved by a careful folder tree.

Promotion is not "copy the state from dev to prod." Dev's object ids are not prod's. Promotion is "merge the module change, plan prod, read the plan, apply prod." If prod's plan is huge and dev's was tiny, prod was drifted or the module change is not as small as it looked. Stop. The environments are supposed to differ in size and in data, and they are not supposed to differ in security baseline. Encryption, public access blocks, and deletion protection should match even when the instance class does not. Put the baseline in the module so it is not a per-environment choice.

Variable files follow the directory. `envs/prod/terraform.tfvars` is loaded because you ran Terraform there, not because of a clever filename in a shared root. An `auto.tfvars` in a shared root is loaded every time, which is another way to apply prod values in dev. If you are still on one directory, do not name a file `prod.auto.tfvars` and also keep `dev.auto.tfvars`. Both auto-load. You do not get a menu.

Backend configuration is loaded at init, not at plan. Changing the key means `terraform init -reconfigure`. A cloned CI workspace that caches `.terraform` from a dev init and then runs prod in the same cache will talk to the wrong backend until someone reconfigures. Cache the providers if you must. Do not cache one environment's `.terraform` directory into another environment's job. The local file `.terraform/terraform.tfstate` stores the backend configuration, not your resource state. It is still enough to aim a plan at the wrong bucket.

### You can now

- Put dev and prod in two roots with two state keys.
- Explain where S3 stores non-default workspace state, including the `env:` prefix.
- Refuse `terraform.workspace` conditionals as the only thing standing between prod and dev.
- Prefix names so two states cannot create one global bucket name.
- Print the directory or the workspace in CI so the apply identity is in the log.

::: quiz
q: Prod and dev are two workspaces in one directory. The prod resources are chosen with terraform.workspace == "prod". A teammate creates a workspace named production. What gets built there?
- Nothing; Terraform only allows the names you validated
+ Whatever the else branch says, because the string production is not equal to prod, unless you also validated the workspace name
- An automatic copy of prod
- An error from the S3 backend, which knows your environment names
why: terraform.workspace is just a string. The backend will happily store env:/production/. The conditional does not have an enum. Validate the name, or do not use a workspace as your only environment switch.
:::

::: card
q: On the S3 backend, where is state stored for workspace prod if the configured key is app/terraform.tfstate and workspace_key_prefix is left at the default?
answer: At env:/prod/app/terraform.tfstate. The default workspace uses the key as written. Every other workspace is prefixed with workspace_key_prefix, which defaults to env:, then the workspace name. IAM has to allow that prefix, not only the bare key.
:::

::: predict lang=python
q: Two environments must not share a state key. What does this print?
code:
```python
def keys(env):
    return f"{env}/app/terraform.tfstate"

print(keys("dev") == keys("prod"))
```
answer:
```text
False
```
why: dev/app/terraform.tfstate and prod/app/terraform.tfstate are different objects. Same bucket is fine. Same key means both applies write one state and will destroy each other's picture of the world.
:::

::: quiz
q: When is a Terraform workspace a reasonable choice?
- Always, instead of directories, because it is built in
+ For many short-lived copies of the same configuration, such as preview stacks, with a printed workspace name and a name prefix
- For production versus development in one AWS account with no conditionals
- When you want two different backend buckets
why: Workspaces multiply states for one config. They do not multiply configs or backends. Previews that are identical except for a name fit. Prod and dev want different roots, different roles, and usually different accounts. A workspace cannot point one directory at two buckets by itself.
:::

::: config lang=hcl
task: This production backend still uses the shared key app/terraform.tfstate, so dev and prod would be the same state object. Point the key at the production prefix the runbook uses, keep the filename terraform.tfstate under app, and leave the bucket, region, encryption, and S3 lockfile as they are. Do not invent a production prefix for a typo.
starter:
```hcl
terraform {
  backend "s3" {
    bucket       = "acme-tf-state"
    key          = "app/terraform.tfstate"
    region       = "eu-central-1"
    encrypt      = true
    use_lockfile = true
  }
}
```
check: terraform.backend.s3.bucket = acme-tf-state | The bucket stays acme-tf-state
check: terraform.backend.s3.key = prod/app/terraform.tfstate | The key is prod/app/terraform.tfstate
check: terraform.backend.s3.region = eu-central-1 | The region stays eu-central-1
check: terraform.backend.s3.encrypt = true | Encryption stays on
check: terraform.backend.s3.use_lockfile = true | S3 locking stays on
solution:
```hcl
terraform {
  backend "s3" {
    bucket       = "acme-tf-state"
    key          = "prod/app/terraform.tfstate"
    region       = "eu-central-1"
    encrypt      = true
    use_lockfile = true
  }
}
```
hint: The production key is the prefix prod, then app/terraform.tfstate. production/app would be a third state created by a typo.
:::

## Remote state and outputs between stacks
id: remote-state
stage: team
minutes: 40
goal: Pass outputs from one state to another without sharing a lock, and without copying secrets into the caller's state.
needs: envs
source: Terraform: Remote state data source | https://developer.hashicorp.com/terraform/language/state/remote-state-data
source: Terraform: S3 backend | https://developer.hashicorp.com/terraform/language/backend/s3
source: Terraform: Manage sensitive data | https://developer.hashicorp.com/terraform/language/manage-sensitive-data

Two roots have two states and two locks. The service stack cannot see `module.network.vpc_id` from the network stack, because that expression only exists inside one configuration. The bridge is an output on the producer and a read on the consumer. The usual read is the `terraform_remote_state` data source. It is legitimate, and it is easy to overuse until every stack can read every secret every other stack ever output.

### The shape

The network root publishes the least it can:

```hcl
output "vpc_id" {
  value = aws_vpc.main.id
}

output "private_subnet_ids" {
  value = [for s in aws_subnet.private : s.id]
}
```

The service root reads only that state:

```hcl
data "terraform_remote_state" "network" {
  backend = "s3"
  config = {
    bucket = "acme-tf-state"
    key    = "prod/network/terraform.tfstate"
    region = "eu-central-1"
  }
}

module "api" {
  source     = "../../modules/service"
  vpc_id     = data.terraform_remote_state.network.outputs.vpc_id
  subnet_ids = data.terraform_remote_state.network.outputs.private_subnet_ids
}
```

`outputs` is a map of the producer's root outputs. Child module outputs that the producer did not re-export are not there. Renaming `vpc_id` in the producer breaks every consumer at plan time. Treat root outputs as a versioned API. Add a new output, migrate consumers, remove the old one in a later change. Do not rename in place because "it is clearer."

The data source reads the state object from S3. It does not run the network Terraform. It sees whatever apply last wrote. If the network plan is open but not applied, consumers still see the old vpc id. That is correct. They should not see a plan. It also means a consumer can succeed against a network that has drifted from its code, as long as state was updated. State, not the network `.tf` files, is the contract at read time.

### Locks and credentials

A remote state read needs `s3:GetObject` on that key. It should not need `PutObject`. Give the service's plan role read on the network state and write only on the service state. A role that can write every key will "fix" a typo by applying the service config with the network backend, if a human points it there. Split the policies by key prefix: `prod/network/*` versus `prod/app/*`.

Readers do not take the writer's lock for a normal `GetObject`. They can read a state that an apply is halfway through writing only if the writer did not upload atomically. S3 uploads of a new object version are atomic from the reader's point of view for a single PUT. Still, do not read state as a general database from applications. Applications should use the AWS APIs and their own contracts. Remote state is for Terraform consumers.

If `use_lockfile` is on, the reader does not need `DeleteObject` on the `.tflock` object. Do not grant it "so reads don't fail." A reader who can delete locks can unblock a second writer.

### Sensitive values cross the bridge

Everything in the producer's output values is stored in the producer's state, which you already knew, and the consumer's data source result is stored in the consumer's state too. A sensitive output is still copied. Marking the consumer's own output sensitive redacts logs and does not remove the copy. The fix is to not output the secret. Output a secret ARN, a KMS key id, a bucket name. The service reads the secret at runtime with its task role. If a legacy module outputs a database password, stop passing `data.terraform_remote_state.network.outputs` as a whole object into a module "for convenience." That splat of a map drags every output, including ones added next month that you did not review.

`sensitive` on the producer output makes `terraform output` redact it. `terraform state pull` does not redact it. Anyone with read on the state bucket can open the JSON. Cross-account state reads double the number of principals who can. Prefer the producer and the consumer in accounts you understand, and the state bucket in the admin account with a tight policy.

### Alternatives

| Need | Prefer |
|---|---|
| Id of an object this stack created | a resource reference, not remote state |
| Id of an object another of your stacks created | remote state of that stack's outputs, or an SSM parameter / ARN written on purpose |
| Id of an object another team owns and tags | a data source filtered by tag |
| A secret | neither; an ARN and a runtime read |

SSM parameters and AWS RAM are sometimes a better contract than remote state because the consumer's IAM is "read this parameter," not "read the entire state JSON, which happens to contain the parameter and also the database password someone output in 2023." Remote state is blunt. It is still the right tool when the value is an id that only exists in that state and you accept the coupling.

Coupling: the service cannot plan if the network state is unreadable or the output is missing. Apply network first when you bootstrap. Document that order. A cycle, network reading service and service reading network, will not plan. Break cycles with an id passed one way, or a third small state.

### Misreadings

**"Remote state always refreshes the producer."** It reads stored state. It does not apply the producer and it does not re-query every producer resource. Stale state yields stale ids.

**"I will data-source the VPC by name and also read remote state."** Pick one. Two sources of truth diverge the day someone renames a tag.

**"The config block can use variables."** Backend blocks cannot. The `terraform_remote_state` `config` is a normal argument and can use variables. That flexibility is how a dev root is parameterized to read prod's key. Hard-code the prod key in the prod root, or validate the key prefix, so dev cannot point at prod by setting one variable.

### Apply order on a new account

Day one, the state bucket already exists (it was bootstrapped, not created by the network root that needs it). You apply the network root and wait until it has written `vpc_id`. Then you init the service root. A service plan before that output exists fails on the missing attribute, which is the error you want. Do not catch it with `try()`. A swallowed missing vpc id becomes a subnet in a default VPC.

When the network stack later replaces the VPC, the output changes and the service plan shows every dependent resource replaced. That is the remote-state version of a force-new argument. `moved` in the network stack does not move objects in the service state. The service still holds the old id in its own state until its next plan. Coordinate those applies. A Friday network replace plus an unattended service apply is how you rebuild production from a "refactor."

### What the consumer stores

Open a consumer state after the first apply and you will find a `data.terraform_remote_state.network` object whose attributes include the outputs map. That map is not a live link. It is a copy taken at refresh. Destroying the consumer does not destroy the network, and destroying the network does not edit the consumer's copy until the consumer plans again. During that gap the consumer's state still names vpc ids that may already be gone. The next service plan is when Terraform notices, usually as an error from AWS, not as a gentle warning from the data source. Plan the consumer after you apply a destructive network change. Do not leave the two applies a week apart.

### You can now

- Publish a small set of root outputs and read them with `terraform_remote_state`.
- Grant consumers `GetObject` on one key prefix, not write on all states.
- Keep secrets out of outputs so they are not copied into every consumer state.
- Bootstrap in dependency order and refuse cycles.
- Choose a tag data source when you do not own the other state.

::: quiz
q: The network stack outputs db_password and marks it sensitive. The app stack reads that output through terraform_remote_state. Where is the password?
- Only in the network state, because sensitive blocks remote reads
+ In the network state and in the app state. The sensitive flag redacts CLI output and does not stop the copy
- Only in the app's variables, which are not stored
- Nowhere; remote state strips sensitive outputs
why: Root outputs are part of the state document remote state copies into the consumer. sensitive changes display, not storage. Output an ARN instead.
:::

::: card
q: What does terraform_remote_state return, and what does it not return?
answer: It returns the producer root module's outputs, as they were last written to that backend. It does not return child-module outputs that were not re-exported, it does not apply the producer, and it does not refresh the producer's resources from the cloud. A missing or renamed output fails the consumer's plan.
:::

::: predict lang=python
q: A consumer should read one prefix. What does this print?
code:
```python
def allow(key):
    if key.startswith("prod/network/"):
        return "get"
    return "deny"

print(allow("prod/network/terraform.tfstate"))
print(allow("prod/app/terraform.tfstate"))
```
answer:
```text
get
deny
```
why: A consumer of the network stack should be allowed to read prod/network/ and denied the rest of the bucket. Get on the whole bucket copies every other stack's secrets into the blast radius of this role, because state JSON holds outputs and resource attributes.
:::

::: config lang=hcl
task: Read prod network state from bucket acme-tf-state, key prod/network/terraform.tfstate, region eu-central-1, using data terraform_remote_state named network and backend s3. Add output vpc_id set to data.terraform_remote_state.network.outputs.vpc_id and mark that output sensitive.
starter:
```hcl
data "terraform_remote_state" "network" {
  backend = "local"
}
```
check: data.terraform_remote_state.network.backend = s3 | backend is s3
check: data.terraform_remote_state.network.config.bucket = acme-tf-state | bucket is acme-tf-state
check: data.terraform_remote_state.network.config.key = prod/network/terraform.tfstate | key is the prod network state
check: data.terraform_remote_state.network.config.region = eu-central-1 | region is eu-central-1
check: output.vpc_id.value.expr = data.terraform_remote_state.network.outputs.vpc_id | output reads outputs.vpc_id
check: output.vpc_id.sensitive = true | the output is sensitive
solution:
```hcl
data "terraform_remote_state" "network" {
  backend = "s3"
  config = {
    bucket = "acme-tf-state"
    key    = "prod/network/terraform.tfstate"
    region = "eu-central-1"
  }
}

output "vpc_id" {
  value     = data.terraform_remote_state.network.outputs.vpc_id
  sensitive = true
}
```
hint: config is an object with equals signs, one attribute per line. The output value is an expression, so it is not quoted. sensitive = true does not remove the value from state; it only redacts CLI output.
:::

::: quiz
q: The service stack and the network stack each read the other's remote state. What happens?
- Terraform merges them into one apply automatically
+ You built a cycle. Each plan depends on the other state already existing, and a bootstrap has no order that works
- Only the first apply fails; after that cycles are fine
- Remote state reads are ignored when they form a cycle
why: These are two configurations. Terraform does not join them into one graph. Each read expects the other output to be in state already. Break the cycle so ids flow one way.
:::

## Terraform in a team
id: tf-team
stage: team
minutes: 40
goal: Run Terraform through pull requests and CI, separate environments safely, and keep long-lived credentials out of it.
needs: remote-state, git/remotes
source: HashiCorp: Automate Terraform with GitHub Actions | https://developer.hashicorp.com/terraform/tutorials/automation/github-actions
source: GitHub: Configuring OpenID Connect in Amazon Web Services | https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services

A laptop with admin credentials and `terraform apply` is a console click that happens to have a diff. The team workflow is slower on purpose. A pull request runs the cheap checks and a plan. A human reads the destroys. A protected branch apply uses a role that a pull request cannot assume. State is locked, remote, and unreadable to people who do not operate production. None of that is a Terraform language feature. It is the process around the language features from the rest of this module.

### What CI runs

On a pull request, in the environment directory that changed:

1. `terraform fmt -check`
2. `terraform init` with backend credentials that can read state, or init without a backend only for validate, then a second job that plans for real
3. `terraform validate`
4. `tflint` and a policy scanner
5. `terraform test` for modules
6. `terraform plan -out=tfplan -detailed-exitcode`

Exit code 0 is an empty plan. Exit code 2 is a diff. Exit code 1 is a failure. A script that treats every non-zero as a bug will fail the pull request whenever there is a real change. Post the plan as a comment. Trim it if it is huge, but do not trim the destroy lines. The saved plan file contains values that may be sensitive. Store it as an artifact with the same privacy as state, or plan again on the apply branch and accept that the second plan must match. Do not attach `tfplan` to a public comment.

Apply runs on merge to the environment branch, or on a manual approval in the prod environment. It uses the same role family as the plan, with write permissions added, so the refresh sees the same objects. Concurrency is one apply per state. The S3 lock is the real mutex. A GitHub concurrency group is a courtesy so two jobs do not sit and wait until the lock timeout. If a job is cancelled, it must not `force-unlock` on the way out unless you know the apply process is dead.

Nobody applies prod from a laptop. Console access to prod is read-only. Break-glass is a role you assume with a ticket, not a key in `~/.aws/credentials` named `prod`.

### OIDC, not access keys

GitHub Actions can request an OIDC token for the workflow run. AWS trusts GitHub's identity provider. The token's subject claim is the repository and the ref. The IAM role's trust policy allows only `repo:ORG/infra:ref:refs/heads/main` for apply, and only pull request subjects for the plan role. The plan role can read state and describe resources. The apply role can change them. A pull request from a fork should not be able to assume either role. GitHub's OIDC docs describe the subject claims. Read them, because `pull_request` from a fork is a different claim than a branch inside the repo, and getting this wrong publishes prod to the internet's pull requests.

There is no long-lived `AWS_ACCESS_KEY_ID` in repository secrets in this design. A leaked log cannot contain a key that still works tomorrow. The role session lasts an hour. This is the same idea as IRSA or EKS Pod Identity in the Kubernetes module: the workload proves who it is, and the cloud hands it a short-lived role. Do not "temporarily" add keys because OIDC setup is annoying. Temporarily is how the key is still there next year.

### Environments in the pipeline

Use the directory layout from the environments lesson. The workflow takes the directory as an input. Prod is a GitHub Environment with required reviewers. Dev applies on merge without a human if the plan job passed and the destroy count is zero. Any non-zero destroy, in dev or prod, needs a human. Encode that in the workflow if you can, and still look at the plan when the workflow lets you through. A boolean `allow_destroy` that is true by default is not a control.

The apply role for prod is not the apply role for dev. Separate accounts make this natural. Separate keys in one account still need two policies. A single role that can write both keys will be the role every job uses, and then the directory is the only thing standing between them.

### Review

Reviewers read the plan summary first: add, change, destroy. Then every `-/+`. Then the `.tf` diff to see if the replace was intended. A module version bump can hide a replace inside upstream code. Open the upstream changelog when the lockfile changes. A provider bump can change default behaviour. Treat lockfile diffs as production diffs.

Comments in the pull request are not state. "We will import this later" without an `import` block means the next apply creates a second copy and the original is orphaned, or the create fails on a name collision. The refactor blocks belong in the same PR as the code.

### Secrets and logs

`TF_LOG=trace` prints more than you want, including request bodies. Do not enable trace on prod CI by default. Mask sensitive outputs. Remember masking fails for values that were never marked sensitive, and for values that appear inside a larger string. The durable fix is still: do not put the secret in Terraform outputs.

### Ownership

Someone has to be allowed to say no to a plan. In a small team that is the person on call. In a larger team the CODEOWNERS file maps `envs/prod` to the platform group and `modules/bucket` to the same group, because a module change is a prod change once prod calls it. Application developers can change `envs/dev` and propose module changes. They should not be the only approvers of a prod apply. GitHub's "dismiss stale reviews" setting matters: a plan comment from yesterday is not a review of the force-push that added `force_destroy`.

State access is an ownership decision too. If every developer can `terraform state pull` prod, every developer can read the database password that a module output last year. CI's plan role can read state. Humans get a break-glass role that is logged. This feels heavy until the first state file shows up in a screenshot.

Drift is a process, not a moral failing. A nightly plan with `-detailed-exitcode` against prod, alerting on exit code 2, tells you the console was used. The fix is to put the change in code or revert it, not to refresh-only it away so the alert stops. Refresh-only accepts the console as the new source of truth and the next real apply will fight it if the code still disagrees. Decide which one wins and make them match.

### Local applies

Developers still need a loop. Give them a sandbox account whose state key is `sandbox/<user>/...` and whose budget alarms are loud. `terraform apply` there is fine. Prod credentials are not on that laptop. A sandbox that shares the prod state bucket's prefix without a prefix lock will eventually use the prod key. Encode the key in the sandbox backend so it cannot be the prod key, and do not pass the key as an unvalidated variable.

### You can now

- Split plan and apply roles, and refuse long-lived access keys in CI.
- Interpret plan exit codes 0, 1, and 2.
- Require a human for any destroy.
- Bind OIDC trust to the repo and the ref, including the fork case.
- Review lockfile changes and replacement symbols, not only the HCL diff.

::: quiz
q: How should a GitHub Actions workflow authenticate to AWS to run `terraform apply`?
- Store an IAM user's access key in a repository secret
+ OIDC: the workflow assumes an IAM role that trusts GitHub's identity provider, restricted to that repo and branch
- Use the root user's credentials stored as an organization secret
- Run apply from a developer's laptop instead
why: OIDC gives short-lived credentials, with nothing to leak or rotate, and the role's trust policy limits which repo and branch can use it.
:::
::: quiz
q: What should a reviewer read most carefully in an infrastructure pull request?
- The commit messages
+ The plan output: especially every destroy and replace, and the summary line
- Only the .tf diff
- The provider version
why: The code diff says what you meant; the plan says what will actually happen to real infrastructure.
:::
::: quiz
q: The plan job and the apply job use different IAM roles. The apply role cannot read a data source the plan role could. What goes wrong?
- Nothing; apply reuses the plan's API responses without calling AWS
+ Apply refreshes again. If its role cannot read what the configuration reads, apply fails or plans a different diff than the one reviewed
- The S3 lock prevents the mismatch
- OIDC merges the two roles' permissions for the duration of apply
why: A saved plan is rejected if state changed, but a fresh apply still calls the APIs as the apply role. Those two roles need the same visibility into the resources you manage. Write permissions can be apply-only. Read permissions should match.
:::
::: card
q: Why is an OIDC role safer than an IAM user's access key in a GitHub secret?
answer: The workflow gets a short-lived session by proving its repo and ref to AWS. There is no long-lived secret to leak in a log or a fork. The trust policy can allow only the protected branch to assume the apply role, and it can refuse pull requests from forks. A key in a secret works until someone rotates it, from any job that can print it.
:::
::: predict lang=python
q: terraform plan -detailed-exitcode uses 0, 1, and 2. What does this print for a plan that has a diff and no error?
code:
```python
def exit_code(error, changes):
    if error:
        return 1
    if changes:
        return 2
    return 0

print(exit_code(False, True))
```
answer:
```text
2
```
why: 2 means the plan succeeded and there is a diff. 0 means no changes. 1 means the plan failed. A CI script that fails on every non-zero status will reject a healthy change.
:::
::: quiz
q: A pull request from a fork runs the plan workflow. What should be true of the prod apply role?
- The fork can assume it so the plan is realistic
+ The role trust policy should not allow fork pull requests. A fork is untrusted code with your cloud credentials if it can assume the role
- Forks are safe because GitHub strips terraform
- The lock file stops a fork from applying
why: OIDC subject claims for forked pull requests are not the same as a branch you own, and they must not match the apply role. A lock does not stop a principal who is allowed to call AWS. Untrusted code plus prod role is a leak.
:::
## AWS CDK as a comparison
id: cdk
stage: team
minutes: 35
goal: Compare AWS CDK's synthesize-to-CloudFormation model with Terraform, without treating them as the same tool.
needs: tf-team
source: AWS CDK Developer Guide | https://docs.aws.amazon.com/cdk/v2/guide/home.html
source: Terraform: What is Terraform? | https://developer.hashicorp.com/terraform/intro

You do not need CDK to finish this module. The project is still Terraform. This lesson exists so the names stop blurring. AWS CDK is a way to write TypeScript, Python, or another language, and synthesize a CloudFormation template. Terraform is a way to write HCL and apply a graph through providers. Both are declarative at the moment they touch the cloud. They are not declarative in the same file, and they do not share a state format.

### What CDK actually does

A CDK app defines constructs. A stack is a construct that synthesizes into one CloudFormation stack. `cdk synth` writes the template. `cdk diff` compares that template to the deployed stack. `cdk deploy` asks CloudFormation to create a changeset and execute it. The source of truth for "what exists" is the CloudFormation stack in AWS, not a JSON file you store in an S3 backend you operate. CloudFormation has its own drift detection. It is not `terraform plan`. A resource that was in the template and is removed from the CDK app is a removal in the template, and CloudFormation's deletion policy decides whether the real object dies. That policy is the cousin of `removed` and `prevent_destroy`, and the defaults are not the same. Read them before you delete a construct that created a database.

Constructs are libraries. An L2 construct for a bucket might default encryption and block public access. That is the same idea as a Terraform module that encodes a baseline, except the construct is code you import from a package, and the module is HCL you call. A package upgrade can change synthesized IAM. Review the `cdk diff` the way you review a Terraform plan. "It is just a library bump" is how a bucket policy opens.

CDK code is imperative at synth time. Loops, conditionals, and function calls run in Node or Python and emit template resources. That feels like the expressions lesson, and the failure mode is different. A Terraform `for` expression is data. A CDK loop can call the network while synthesizing if someone wrote it that way. Do not call AWS during synth. The template should be a pure function of the code and the context values you passed in. Otherwise two synths differ and the diff is noise.

### What Terraform does that CDK does not, and the reverse

| | Terraform | AWS CDK |
|---|---|---|
| Language you review | HCL | TypeScript, Python, or similar, plus the synthesized template |
| Applies through | providers (AWS and many others) | CloudFormation, so AWS only |
| State you operate | remote state, locking, imports, moves | the CloudFormation stack |
| Plan | `terraform plan` | `cdk diff` / a changeset |
| Multi-cloud | a point of the tool | no |

CDK for Terraform (CDKTF) is a different product from AWS CDK. It uses a CDK-style API to generate Terraform configuration, and then Terraform's providers apply it. Saying "we use CDK" in a Terraform shop is ambiguous. Ask which one. This lesson is about AWS CDK. Do not mix the state stories.

CloudFormation's strengths are the ones AWS operates for you: rollback of a failed stack update is more of a product feature than Terraform's "the first ten resources stayed created." That rollback has limits. It is not a database transaction, and some resources do not roll back cleanly. Terraform's strengths are the provider ecosystem, the explicit plan, `moved` and `import`, and one language for AWS, GitHub, Cloudflare, and whatever else you already pinned. Choosing CDK to avoid learning state does not avoid state. It moves state into CloudFormation, where you still have stack resources, drift, and deletion policies.

### When someone proposes a rewrite

A rewrite from Terraform to CDK, or the reverse, does not move the objects. Imports exist on both sides and they are a project. Running both tools on one bucket means two controllers. The next apply from either one will undo the other. The refactor lesson's rule holds across tools: one owner per object. If you are migrating, `removed { destroy = false }` on the Terraform side and an import on the CloudFormation side, in that order, with a plan and a diff that show no replacement.

HCL is awkward for heavy computation. CDK is awkward when the reviewer cannot read TypeScript, or when the change must also touch Cloudflare and GitHub in the same graph. A team that is already deep in TypeScript services sometimes accepts CDK for AWS so application developers do not learn HCL. A team that operates several vendors usually stays with Terraform or OpenTofu. OpenTofu is the open fork of Terraform's language and workflow, not a fork of CDK. It does not synthesize CloudFormation. Mentioning it here is only to stop a third mix-up.

### Misreadings

**"CDK has no state."** CloudFormation stores stack state. You do not hold the JSON, and you also do not get to `moved` a logical id without a CloudFormation-shaped migration. Renaming a logical id is a replacement unless you use CloudFormation's rename features carefully. Ask for the diff.

**"A construct is safer than a module because AWS wrote it."** Defaults change between construct minor versions. Pin the CDK library. Read the diff. The same rule as a registry module.

**"We can `terraform plan` the CDK app."** Not unless the app is CDKTF emitting Terraform. AWS CDK emits a template. `terraform validate` does not read it.

### Reading a diff when you know Terraform

A Terraform plan line `-/+` maps, roughly, to a CloudFormation resource replacement. The template changes a property that cannot be updated in place, so CloudFormation creates a new physical id and deletes the old one according to the deletion and update-replace policies. `cdk diff` is supposed to show that before deploy. If the diff is empty and production still changed, someone deployed a template from another machine, or the stack drifted and the tool you ran was not pointed at the account in the profile you think. The same identity checks apply: print the account id and the stack name in CI.

Construct ids become logical ids. Changing a construct id is not a rename of the AWS object. It is a new logical resource. People who have learned `moved` expect a block they can add. CloudFormation's answer is not a `moved` block. Do not learn one tool's refactor muscle memory and apply it blindly in the other. When this module's project stays in Terraform, a rename is `moved`. When a neighbouring team renames a CDK construct, ask them for the diff and for whether the physical resource will be replaced.

Escape hatches let you drop to a raw CloudFormation resource when an L2 construct cannot say what you mean. They also let you skip the defaults that made the L2 safe. Review an escape hatch the way you would review a raw `aws_s3_bucket` with no public-access block next to it. The hatch is not a comment. It is the resource.

### You can now

- Explain synth, diff, and deploy, and name CloudFormation as the thing that applies.
- Contrast that with a Terraform plan and an S3 state object you lock.
- Treat a construct upgrade as a plan you read.
- Refuse two tools managing one bucket.
- Tell AWS CDK apart from CDK for Terraform and from OpenTofu.

::: quiz
q: A teammate says the AWS CDK app has no state file, so it cannot drift. What is wrong?
- Nothing; CDK queries AWS on every deploy and has no stored desired state
+ CloudFormation keeps the stack, which is the desired state and the last applied template. Drift is still possible when someone edits the console
- CDK stores terraform.tfstate under a different name
- Drift only applies to HCL
why: The absence of a file you manage is not the absence of state. The stack in AWS is the record. Console edits drift from it. cdk diff is the comparison, and it is not terraform plan.
:::

::: card
q: What does AWS CDK deploy that Terraform does not, and what does Terraform deploy that AWS CDK does not?
answer: AWS CDK synthesizes a CloudFormation template and CloudFormation updates AWS resources. Terraform applies a resource graph through any provider you configured, including non-AWS ones, and records them in its own state. CDK for Terraform is a third thing: CDK-style code that generates Terraform, not CloudFormation.
:::

::: predict lang=python
q: Two controllers on one bucket will fight. What does this print if both tools still list the bucket?
code:
```python
def owners(tools):
    if len(tools) == 1:
        return "stable"
    return "fight"

print(owners(["terraform", "cloudformation"]))
```
answer:
```text
fight
```
why: Each tool's next deploy or apply makes the bucket match its own desired state. They do not merge. Migrate with an explicit handoff: forget on one side without destroying, import on the other, and do not leave both configured.
:::

::: quiz
q: Why is a CDK library bump closer to a Terraform provider bump than to a comment change?
- Because CDK rewrites terraform.tfstate
+ Because synth output can change IAM, defaults, or resource types, and that only shows up in cdk diff
- Because npm installs providers into .terraform
- Because CloudFormation ignores library versions
why: The TypeScript did not appear to change your bucket construct, but the library's generated template did. Review the diff. Pin the library the way you pin provider versions.
:::

::: card
q: What should you look at before deleting a CDK construct that created a database?
answer: The CloudFormation deletion policy and the cdk diff. Removing a construct removes it from the template. Whether the database is actually deleted depends on that policy, not on a Terraform prevent_destroy flag. Those are different tools. Confirm the diff shows what you expect before deploy.
:::

## Project: a production bucket
id: p-tf
stage: team
minutes: 70
goal: Write a complete, reviewable configuration that meets a security baseline, using variables, locals and separate resources.
needs: tf-team, variables, meta
source: Terraform: S3 backend | https://developer.hashicorp.com/terraform/language/backend/s3
source: Terraform AWS provider: aws_s3_bucket | https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/s3_bucket
project: yes

This is the project. You will write one root configuration for an uploads bucket that meets a baseline a reviewer can check without a console. The sandbox cannot run `terraform`, so the check is the HCL itself: types, references, and the four public-access flags. Write it as if the plan were next. The brief below is the contract. The paragraphs after it are how to think while you satisfy it, including the mistakes that still pass a sloppy reading and fail this one.

### The brief

An app needs an S3 bucket for user uploads, per environment, meeting the security baseline:

- variable `env` (string, validated to `dev` or `prod`)
- locals: `name = "uploads-${var.env}"` and `tags = { project = "uploads", env = var.env }`
- bucket `aws_s3_bucket.this` named `"acme-${local.name}"`, tagged with `local.tags`
- versioning enabled (`aws_s3_bucket_versioning.this`)
- server-side encryption with KMS (`aws_s3_bucket_server_side_encryption_configuration.this`, `sse_algorithm = "aws:kms"`)
- all public access blocked (`aws_s3_bucket_public_access_block.this`, all four `true`)
- `lifecycle { prevent_destroy = true }` on the bucket
- output `bucket_arn` with the bucket's `arn`

Every per-bucket resource must reference `aws_s3_bucket.this.id`.

### Why the bucket is split

In the AWS provider's current major line, versioning, encryption, and the public-access block are their own resources. Putting them in one `aws_s3_bucket` block is the v3 shape. It is easy to copy from an old snippet, and it does not express the baseline this project asks for. Separate resources also make the dependency obvious: each one takes `bucket = aws_s3_bucket.this.id`, unquoted, so the graph creates the bucket first. A quoted string `"aws_s3_bucket.this.id"` is a bucket name that does not exist. You already know that from the HCL lesson. It is the most common way to "finish" this project and manage nothing.

`sse_algorithm = "aws:kms"` without a key id uses the AWS-managed S3 key, which is a real choice and a weaker one than a customer-managed key. The brief stops at the algorithm. A follow-on, not required for the check, is an `aws_kms_key` and `kms_master_key_id`. If you add it, the key needs a policy that lets the bucket's principals use it, and the state will contain the key's attributes. Do not output the key material. There is no key material in that resource. Do not output a generated password either. This project has neither. Keep it that way.

### prevent_destroy and environments

`prevent_destroy = true` means a plan that would destroy this bucket fails. That includes a rename of the bucket argument, which is a replacement, and a deletion of the resource block. It does not stop a human in the console, and it does not stop a `removed` block that sets `destroy = true`. It is still the right setting for uploads you cannot recreate. Dev and prod in two roots can both set it. A sandbox you intend to tear down every Friday should not copy this file unchanged, or destroy will be refused and someone will comment the lifecycle out and forget to put it back in prod. The environments lesson was this paragraph in advance.

The name `acme-${local.name}` becomes `acme-uploads-dev` or `acme-uploads-prod`. Bucket names are global. `acme` is a stand-in. A real company prefix is the account or the org, and it must already be unique. Validation that `env` is only `dev` or `prod` stops `prdo` from becoming a third bucket that nothing deletes. The validation condition has to mention `var.env`. A validation that is `condition = true` passes the letter of a weak check and fails the point. Use `contains`.

### Tags and outputs

`tags = local.tags` shares one map. Adding a tag later is a one-line change. Writing the map out inside the bucket and again inside the encryption resource is how they diverge. The encryption resource in this brief does not require tags. The bucket does. `local.tags.env` must be `var.env`, not the string `"var.env"`.

`output "bucket_arn"` is what another stack would read via remote state, or what CI prints. An ARN is not a secret. Do not also output a policy document you built with a wildcard principal. This configuration should not contain a bucket policy at all. The public-access block is what stops a policy someone adds later in the console until the next apply, and it stops a policy in this configuration that tries to grant public read. If you add a policy resource, `restrict_public_buckets` and a public principal will fight you. Good.

### What you are not asked to write

No backend block in the checked file. In a real root you would add the S3 backend with `use_lockfile = true`, a key that includes the environment, and `encrypt = true`, in a file you do not generate from a variable. No provider alias. No `terraform test` file, though a test that asserts `block_public_acls` is true would be the next pull request. No `count`. One bucket.

### Review it yourself before you submit

Read the configuration as a plan. One bucket to add. Three companion resources to add. No replaces, because nothing exists yet. On the second apply, with no edits, the plan should be empty. If you change `env`, the name changes, the bucket must be replaced, and `prevent_destroy` should make that plan fail. That is the behaviour you want for prod, and it is the reason a variable change is not a casual edit.

When this passes, you have used variables, locals, split resources, a lifecycle guard, and an output. The rest of the module was so that those lines are choices, not a template you cannot explain.

### A note on force_destroy and versioning

`force_destroy = true` on the bucket tells Terraform it may empty the bucket in order to delete it. Combined with a failed `prevent_destroy` review, it is how a "temporary" test flag deletes user uploads. This project does not set `force_destroy`. Leave it unset. Versioning means a delete of an object becomes a delete marker, which is what you want for uploads, and it means the bucket is harder to empty by accident. It does not replace a backup. A bucket in the same account, versioned, is not a second region. Replication would be another resource and another alias, and it is out of scope. Do not add it "to be complete" and skip the public-access block.

KMS encryption changes the IAM story for every reader. The app role needs `kms:Decrypt` on the key as well as `s3:GetObject`. If you stayed with the AWS-managed key, the key policy is AWS's and the failure mode is different. Either way, a bucket policy that grants `s3:*` to `*` is incompatible with the point of this exercise. The four booleans are `block_public_acls`, `block_public_policy`, `ignore_public_acls`, and `restrict_public_buckets`. All four. Three of them is how a public ACL still lands.

When the checker accepts the file, read it once more as a stranger. The variable description can be one sentence. The validation error message should name the allowed values. The bucket resource is the only one with `lifecycle`. Putting `prevent_destroy` on the public-access block and not on the bucket protects the wrong object: Terraform could still plan to destroy the bucket and leave a block that points nowhere. The guard sits on the data.

### You can now

- Meet a written baseline without collapsing it into one legacy bucket block.
- Reference the bucket id so the graph orders the companions.
- Keep a name prefix in a local and an environment enum in a variable.
- Set `prevent_destroy` and know what it will refuse.
- Publish an ARN and not a secret.

::: config lang=hcl
task: Write the configuration described in the brief.
starter:
```hcl
resource "aws_s3_bucket" "this" {
  bucket = "acme-uploads"
}
```
check: variable.env.type.expr = string | variable env is a string
check: variable.env.validation.condition ~ /var\.env/ | env has a validation
check: locals.name = uploads-${var.env} | local name is "uploads-${var.env}"
check: locals.tags.project = uploads | local tags has project = "uploads"
check: locals.tags.env.expr = var.env | local tags has env = var.env
check: resource.aws_s3_bucket.this.bucket = acme-${local.name} | The bucket is named "acme-${local.name}"
check: resource.aws_s3_bucket.this.tags.expr = local.tags | The bucket is tagged with local.tags
check: resource.aws_s3_bucket.this.lifecycle.prevent_destroy = true | The bucket has prevent_destroy = true
check: resource.aws_s3_bucket_versioning.this.bucket.expr = aws_s3_bucket.this.id | Versioning references the bucket
check: resource.aws_s3_bucket_versioning.this.versioning_configuration.status = Enabled | Versioning is Enabled
check: resource.aws_s3_bucket_server_side_encryption_configuration.this.bucket.expr = aws_s3_bucket.this.id | Encryption references the bucket
check: resource.aws_s3_bucket_server_side_encryption_configuration.this.rule.apply_server_side_encryption_by_default.sse_algorithm = aws:kms | Encryption uses aws:kms
check: resource.aws_s3_bucket_public_access_block.this.bucket.expr = aws_s3_bucket.this.id | The access block references the bucket
check: resource.aws_s3_bucket_public_access_block.this.block_public_acls = true | block_public_acls = true
check: resource.aws_s3_bucket_public_access_block.this.block_public_policy = true | block_public_policy = true
check: resource.aws_s3_bucket_public_access_block.this.ignore_public_acls = true | ignore_public_acls = true
check: resource.aws_s3_bucket_public_access_block.this.restrict_public_buckets = true | restrict_public_buckets = true
check: output.bucket_arn.value.expr = aws_s3_bucket.this.arn | The output bucket_arn is aws_s3_bucket.this.arn
solution:
```hcl
variable "env" {
  type = string
  validation {
    condition     = contains(["dev", "prod"], var.env)
    error_message = "env must be dev or prod."
  }
}

locals {
  name = "uploads-${var.env}"
  tags = {
    project = "uploads"
    env     = var.env
  }
}

resource "aws_s3_bucket" "this" {
  bucket = "acme-${local.name}"
  tags   = local.tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "this" {
  bucket                  = aws_s3_bucket.this.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

output "bucket_arn" {
  value = aws_s3_bucket.this.arn
}
```
hint: Build it in pieces from the earlier lessons: variable + locals, the bucket with `tags = local.tags` and a `lifecycle` block, then the three per-bucket resources, each with `bucket = aws_s3_bucket.this.id`, and the output.
:::
::: quiz
q: The bucket name changes from acme-uploads-dev to acme-uploads-prod on an existing bucket, and prevent_destroy is true. What does Terraform do?
- It renames the bucket in place
+ It plans a replacement, and prevent_destroy fails that plan rather than deleting the old bucket
- It ignores the name change because of the lifecycle block
- It writes only the new name into state
why: S3 bucket names cannot be updated in place. The plan is a destroy and a create. prevent_destroy turns that plan into an error. It does not make the rename succeed. Change names only when you mean a migration with a new bucket and a copy.
:::
::: card
q: Why are versioning, encryption, and the public-access block separate resources instead of arguments on aws_s3_bucket?
answer: In the current AWS provider they are separate resources, each pointing at the bucket id. The old inline arguments are the v3 style and do not satisfy this baseline. Separate resources also make the dependency explicit and keep a missing public-access block visible in review instead of buried in a default.
:::
::: quiz
q: Which output is appropriate for this bucket?
- The access key of an IAM user you created beside the bucket
+ The bucket ARN, which other stacks can read and which is not itself a secret
- The full state file path plus the lock key
- A presigned URL baked into the output so the app does not need credentials
why: An ARN identifies the bucket. A key, a state path, or a long-lived presigned URL would spread a credential through state and through every remote-state consumer. The app should use its task role to talk to the bucket.
:::
::: predict lang=python
q: The uploads name is a local, not a second variable. What does this print?
code:
```python
def bucket(env):
    name = f"uploads-{env}"
    return f"acme-{name}"

print(bucket("prod"))
```
answer:
```text
acme-uploads-prod
```
why: local.name is uploads plus the environment, and the bucket argument prefixes acme-. Callers set env. They do not set the bucket string directly, so dev and prod cannot drift into two naming schemes.
:::
