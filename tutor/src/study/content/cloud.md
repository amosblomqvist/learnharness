# Cloud (AWS)
id: cloud
blurb: The cloud as a builder sees it: regions and accounts, IAM, VPC networking, compute and storage choices, availability, observability and cost. Shaped like the Solutions Architect exam.
why: Your containers need somewhere to run, a network, identities and data stores. This module teaches the AWS building blocks and the trade-offs between them, so the next one (Terraform) can write them down as code.
stage: found | Foundations | Know how AWS is organized and who is allowed to do what.
stage: build | Building blocks | Choose the network, compute and storage for a workload, and say why.
stage: run | Running it well | Keep it up, see inside it, and keep the bill sane.
stage: exam | Exam practice | Answer scenario questions in the shape of the Solutions Architect exam.

## How the cloud is organized
id: model
stage: found
minutes: 40
goal: Place any AWS resource in its region, availability zone and account, and know what you are responsible for.
needs: containers/what
source: AWS: Regions and Availability Zones | https://aws.amazon.com/about-aws/global-infrastructure/regions_az/
source: AWS: Shared responsibility model | https://aws.amazon.com/compliance/shared-responsibility-model/

A region is not a brand name for the cloud. It is a physical failure domain you chose when you created the resource, and almost nothing you build later can quietly outgrow that choice. If the invoicing API is in eu-central-2, the database, the keys that encrypt the invoices, the log group, and the backup vault are decisions about that same place, or about a second place you have drawn on purpose. People get this wrong by treating the console's region dropdown as a view filter. It is not. It is which set of data centres will hold the thing you are about to create.

Availability Zones are the unit the rest of this module means by highly available unless a sentence says otherwise. A zone is one or more data centres with independent power and networking, close enough that synchronous replication is ordinary and far enough that a fire, a flood, or a bad power domain in one zone is not the same event in the next. Two zones in one region survive the loss of one site. They do not survive the loss of the region. They do not satisfy a contract that names a country the region is not in. A second region is a second design: another copy of the data, a story for which side accepts writes, a recovery point you can measure, and a failover you have rehearsed. Drawing a box in another region on a slide is not that design.

An account is the blast-radius boundary that a VPC is not. Billing rolls up to the account. IAM principals live in the account. Service quotas are counted in the account, and usually in one region of it. A role that can terminate instances in the development account cannot terminate them in production unless you built a path across that line. Putting dev and prod in two subnets of one account, with one administrator role that can see both, is how a Friday experiment deletes Monday's data. AWS Organizations is the tool that groups accounts. The account lesson is how its guardrails work. This lesson is why you want more than one account before the guardrails matter.

Scope is where diagrams lie. A VPC is regional: one network, stretched across the zones where you placed subnets. A subnet is zonal. An EC2 instance, an EBS volume, and a NAT gateway sit in one zone even when the product name sounds regional. An S3 bucket's name is global, and the objects sit in the region you selected. IAM users, groups, and roles are global inside one account and one partition: there is not a separate IAM database in eu-west-1. A customer managed KMS key is regional. CloudFront and Route 53 answer from the edge and still read an origin you placed in a region. If a runbook says the role is missing in this region, you are usually looking at a regional resource that references the role, or at a region that is not enabled, not at a second copy of IAM.

Shared responsibility is the sentence both the exam and the incident review use, and it moves. AWS operates the buildings, the hardware, the hypervisor, and the managed control planes. You operate what you configure and what you store. On EC2 that includes the operating system. On Lambda it does not: AWS patches the workers, and you still own the function code, the execution role, the resource policy on the trigger, and the data the function writes. On S3 you do not run disks. You still own Block Public Access, the bucket policy, the KMS key policy, and whether a presigned URL was too wide. Encryption does not move a bucket to another country. A public bucket is almost always the customer's side of a service that did what the policy said.

Some regions are opt-in. An older account does not have every new region enabled, and a pipeline that assumes the full list fails in a dull way, or worse, an attacker enables a region you do not watch. CloudTrail, GuardDuty, and the organization policies in the next lessons have to be designed for the partition, not for the two regions you deploy to. Quotas are the other invisible region. A NAT gateway quota or a Lambda concurrency limit raised in a sandbox is not raised in production. Service Quotas belongs on the design, not in the chat channel during the outage.

### Choosing a region

You are choosing latency to users, latency to the systems you must call, the legal place data may be stored and processed, and the service list. A Swiss residency clause points at eu-central-2, and then you check that every service in the design exists there before you promise it. Frankfurt has the larger menu and is the wrong answer when the contract says Switzerland. us-east-1 receives features first and is the wrong answer for the same contract. Write the constraint on the diagram before you pick instance types. Edge locations are not a way around this. CloudFront can terminate TLS near the user. The origin, the logs, and the backups are still wherever you put them. Local Zones, Wavelength, and Outposts are smaller footprints for a city, a carrier network, or your own building. They have a shorter service list. They are not a fourth Availability Zone of a region that already has three.

### Managed does not mean finished

The slope runs from EC2, where you patch an OS, through ECS on EC2, Fargate, and Lambda, and from a database on a VM through RDS, Aurora, and DynamoDB. Moving along the slope deletes a class of work and a class of control. You cannot SSH to DynamoDB, and you cannot skip the IAM role. Managed means AWS runs the undifferentiated heavy lifting. It does not mean the resource is private, backed up to your recovery point, in the right region, or cheap. A small team should take the most managed option that meets the constraint, and should be able to name the constraint that forced them back toward EC2. The compute, data, and serverless lessons make those choices one service at a time. This lesson is the map they sit on.

### How a click becomes an API call

The console is not a side door. A click is an API request signed with the caller's credentials and evaluated by IAM, the same path the CLI and the SDKs use. CloudTrail is the record of that request: who, which action, which resource, from where, and whether it was allowed. When you learn a service in this module, learn the action name. s3:PutObject is the thing the button does. The policy either allows that action on that ARN or it does not. There is no extra permission called using the console. If the console can do it and your automation cannot, the difference is the principal and the policy, not a secret console privilege. The IAM lessons are that decision. The CLI lesson is how you sign the call without pasting a long-lived key into a laptop shell you will forget.

### A worked placement

Put a Swiss invoicing API on the map before you name products. Account: production, not the account where someone is learning IAM. Region: eu-central-2, because the contract says Switzerland, after you have checked the service list. Zones: two, for the load balancer subnets, the tasks, and the database. The PDF bucket is in that region, with the name global only in the sense that no one else can take it. The KMS key that encrypts the bucket is in that region. The trail that records who deleted a rule is not a region you remember. It is every region, because a missed region is where the delete happens. The edge, if you add one later, is CloudFront in front, origin in Zurich. Nothing in that paragraph required a second region. Add one only when a recovery objective or a latency number you can show demands it.

### Where this breaks

The usual break is a diagram with one zone and the words highly available in the corner. The next is a second region with no arrow for writes and no recovery point. The next is a shared account, because accounts felt like paperwork. The next is assuming IAM is regional and creating a role again in another region, which does nothing, or assuming a KMS key is global and failing the encrypt call. The next is treating a managed service as if AWS owed you your backup policy. RDS can take automated backups. It will not invent your retention, your vault's region, or a restore you have never tried. The next is a residency review that looks at the origin and forgets the replica, the log archive, and the support attachments.

### How this is used at work

A design review starts with account, region, and zones before instance types. Terraform, the next module, will encode those as required variables, not as defaults hidden in a provider block someone copied from us-east-1. Kubernetes clusters are regional control planes with zonal worker capacity. The same picture applies, and EKS does not move a cluster to another country because you wished it. When an incident is the region, your two-zone design is already exhausted, and the only honest status is the recovery objective you actually built.

### What to draw

| You need | Draw | Do not draw |
| Region outage survival | A second region, a replication path, an RPO, a practised failover | A second Availability Zone |
| One data centre's power loss | Two zones and a Multi-AZ data service | A bigger instance in one zone |
| Dev cannot delete prod | Separate accounts, later an organization guardrail | Two subnets and a naming convention |
| Data in Switzerland | eu-central-2, including keys, logs, and backups | Encryption plus Frankfurt |
| A closer TLS handshake | CloudFront or Global Accelerator, origin still in the chosen region | A new region for the database |

### You can now

Place a resource in an account, a region, and an Availability Zone when it has one. Say what two zones survive and what they do not. Explain shared responsibility for EC2, Lambda, and S3 without pretending AWS secures the bucket policy. Trace a console click to a signed API call. Refuse a second region until a requirement you can name demands it.

::: quiz
q: You need the app to keep running if one data centre loses power. What's the minimum?
- A bigger EC2 instance
+ Run it in at least two Availability Zones of the region
- Use two regions
- Use a second AWS account
why: AZs are designed to fail independently. Multi-AZ covers a data-centre failure; multi-region is for whole-region outages and costs a lot more in complexity.
:::

::: quiz
q: A company's S3 bucket with customer data was found readable by anyone on the internet. Under the shared responsibility model, whose failure is that?
- AWS's: S3 should prevent it
+ The customer's: access configuration of their data is their side of the model
- Shared equally
- The internet provider's
why: AWS secures the service. Who may read a bucket is the customer's configuration (and S3 Block Public Access exists to prevent exactly this).
:::

::: quiz
q: A design uses two Availability Zones and a Multi-AZ database. The whole region becomes unreachable. What is still true?
+ The two-AZ design does not cover a regional outage. A second region is a separate design you have to test
- Two AZs sit in different regions, so the region cannot fail as a unit
- The managed database fails over to another region on its own
- Edge locations keep serving the origin from cache until the region returns, so users see no errors
why: Availability Zones fail independently inside one region. A regional outage takes all of them. Multi-region failover is extra replication, a runbook, and an RPO you chose. Cache at the edge does not contain your database.
:::

::: card
q: In one commercial AWS account, are IAM roles regional?
answer: No. IAM is global inside the account and partition. The same role exists in every enabled region. VPCs and customer managed KMS keys are regional. A missing role in one region usually means you are looking at a regional service, or the region is not enabled.
:::

::: predict lang=python
q: This models what a two-AZ design survives. What does it print?
code:
```python
def survives(failure):
    if failure == 'one AZ':
        return 'yes'
    return 'no'
print(survives('whole region'))
```
answer:
```text
no
```
why: Two zones cover one site. They do not cover loss of the region. The function returns no for any failure other than one AZ.
:::

::: quiz
q: Who patches the operating system under a standard Lambda function?
+ AWS. You still own the code, the execution role, and the permissions on the event source
- You do, on the same schedule as EC2
- Nobody, because Lambda has no operating system at all
- You do, but only if you uploaded a container image
why: The responsibility line moves. Lambda removes worker patching. A container image is still your code on AWS-managed workers. Identity and data access stay yours.
:::

## Regions, zones, and the edge
id: regions
stage: found
needs: model
minutes: 40
goal: Say what a partition, a region, an Availability Zone, and an edge location each survive, and choose one on purpose.
source: AWS: Regions and Availability Zones | https://aws.amazon.com/about-aws/global-infrastructure/regions_az/
source: AWS: Global infrastructure | https://aws.amazon.com/about-aws/global-infrastructure/

The last lesson put a resource on a map. This one is what the map is made of, because the names are easy to mix and the exam, and production, punish the mix. A partition is the outermost wall. Commercial AWS, GovCloud, and the China regions are different partitions. An ARN carries the partition, and a role in aws does not exist in aws-us-gov. If you copy a policy between partitions by search and replace, you will allow the wrong account or none. Most of this path lives in the commercial partition. Say so when you write an ARN, instead of assuming the prefix arn:aws is a law of nature.

A region is a named cluster of Availability Zones in one geography, advertised as a separate failure domain from other regions. eu-central-1 is Frankfurt. eu-central-2 is Zurich. They are not interchangeable because they are both in Europe. Data does not flow between them unless you configure replication, and that replication is your availability design and your bill. New regions are often opt-in. Enabling a region is an account setting, not a view. Until it is enabled, you cannot create resources there, and after it is enabled you are responsible for watching it. An unused enabled region is a favourite place to launch cryptomining, because the trail and the detector you deployed in two regions do not see it.

An Availability Zone name such as eu-central-1a is not a physical identity you can compare across accounts. AWS maps the letter to a physical zone per account, so that not every customer's 1a is the same building. Do not design capacity by saying we will all use 1a because it is the cheap one. Do pin a subnet to a zone id when you need two accounts to land in the same physical zone, and use the zone id, not the letter, for that. Inside one account the letter is stable. Across accounts it is not.

Global services are the short list that does not live in the region dropdown the way EC2 does. IAM, AWS Organizations, and Route 53 hosted zones are global within the partition. CloudFront uses a global network of edge locations and still has an origin you placed somewhere. STS has a global endpoint and regional endpoints. Prefer the regional STS endpoint in new work so a problem at the global endpoint is not a dependency of every assume-role call. S3 is the trap in this list. The bucket name is claimed globally. The objects, the storage class, and the KMS key you attach are regional. A bucket in Zurich is not in Frankfurt because the name looks global.

Edge locations, Local Zones, Wavelength Zones, and Outposts are not regions and not extra AZs of the parent region. An edge location terminates a CloudFront or Global Accelerator connection near the user. A cache hit never touches your origin. A cache miss does, and the user's POST usually does too, because you should not cache a write. A Local Zone is a small extension of a parent region into a city, for single-digit-millisecond access to a slice of services. Wavelength places compute in a carrier's network. Outposts is AWS hardware in your building. All three have a shorter service list and a parent region they depend on. Using one to dodge a residency rule is a legal question, not a checkbox. The parent region's control plane and the logs may still be outside the city you named.

Latency is a number you measure, not a feeling about the map. Users in Vienna to Frankfurt is often fine for a business app. Users in Vienna to a database in Zurich plus an API in Ireland plus a cache in Virginia is a design, and it is usually an accident. Synchronous calls across regions add tens of milliseconds each, and they fail when the path fails. If the user-facing request must read three regions, you have coupled their availability. Put the data the request needs in the region that answers the request. Replicate asynchronously for the other copies, and decide what a stale read means.

Service availability is part of choosing a region. The regional services list is not identical. A design that needs a particular database engine, a GPU instance, or a newer Lambda feature has to be checked against the region in the contract, not against us-east-1 where the tutorial was written. Zurich in particular is the right answer for Swiss residency and the wrong answer if you never looked up the service. The fix is to look it up before the proposal, not to quietly store the data in Frankfurt and encrypt it.

### What survives

Walk three designs and say the failure they actually cover. One instance in one zone survives nothing that matters. It is a demo. Two zones, a load balancer, stateless tasks, and a Multi-AZ database survive one zone. They do not survive a regional control-plane or network event, and they do not survive you deleting the database. Two regions with Aurora Global Database or DynamoDB global tables, a Route 53 failover record, and a written RPO survive a regional outage only to the extent the replication lag and the failover drill say they do. If you have never failed over, you have a replica, not a recovery plan. The resilient-architecture lesson comes back to this with RTO and RPO. Here, the point is to stop calling all three designs highly available.

### A worked choice

A company in Austria serves customers in the EU, stores payroll data that the works council wants in the EU, and has one engineer. eu-central-1 is a reasonable default: broad service list, Multi-AZ, and a latency that is fine for an internal app. A second region is not a reasonable default. The payroll extract does not need an active-active pair. It needs backups in the same region, tested restores, and a written note that a regional outage is an accepted risk measured in hours, not a surprise. Contrast that with a game backend whose players are in Frankfurt and Sao Paulo and whose score writes must be local. Two regions, and a conflict rule for the score, are the product. The geography did not change. The requirement did.

### Where this breaks

People enable every region because the CLI loop was easy, then never create a trail there. People compare AZ letters across accounts and wonder why the latency between peers is wrong. People put CloudFront in front of a single-AZ origin and call the edge the availability story. The edge hides origin latency on cache hits. It does not run your database. People use the global STS endpoint from everything and share one fate. People treat Route 53 health checks as a load balancer inside a region. They are a DNS change, with TTL delay, for steering between endpoints you already built. And people forget that deleting a region from a Terraform provider alias does not delete the resources an attacker, or an old pipeline, created there.

### How this is used at work

The provider block in Terraform takes a region. A second region is a second provider alias, not a copy-paste of the whole stack with the region string changed and the state still shared. State itself must live somewhere. A state bucket in the same region as the stack shares fate with it. The remote-state lesson in the next module is that decision. In incidents, the first question is which region and which zones, because the dashboard defaults to us-east-1 and will cheerfully show you an empty, healthy graph of the wrong place.

### What belongs where

| Name | Scope | Common mistake |
| Partition | Commercial, GovCloud, or China | Copying an arn:aws policy into another partition |
| Region | A geography of zones | Assuming two EU regions are one data-residency story |
| Availability Zone | One or more data centres in that region | Comparing the letter a across accounts |
| Edge location | CloudFront, Route 53, Global Accelerator | Treating cache as a second region |
| Local Zone or Outpost | A small footprint tied to a parent region | Counting it as an independent region |
| Opt-in region | Off until the account enables it | Watching only the regions you meant to use |

### You can now

Name the partition, region, and zone of a resource, and say which of those words do not apply to IAM, to an S3 bucket name, and to an EBS volume. Explain why AZ letters are not physical ids across accounts. Choose a region from residency, latency, and the service list, and refuse a second region that has no replication story. Say what an edge location does not survive on your behalf.

::: quiz
q: Two accounts both use the AZ name eu-central-1a. What can you rely on?
+ Inside one account the name is stable. Across accounts the letter may map to different physical zones, so compare zone IDs when that matters
- The letter a is the same building worldwide
- AWS forbids two accounts from using the same letter
- The letter selects a region, not a zone
why: AZ names are remapped per account so customers are spread across sites. Zone IDs are the physical identity. The letter is still the right handle inside a single account's VPC.
:::

::: quiz
q: Which statement about an S3 bucket is accurate?
+ The bucket name is globally unique, and the objects are stored in the region you chose
- The objects are copied to every region because the name is global
- The bucket and the objects are both global, like IAM
- The bucket is zonal, like a subnet
why: Global name means no one else can take that name. It does not mean the bytes are everywhere. Replication to another region is a feature you turn on.
:::

::: card
q: What is an opt-in AWS region?
answer: A region that stays disabled in an account until you enable it. After you enable it, you must include it in CloudTrail, GuardDuty, and organization guardrails, because an unused region is still part of the account.
:::

::: predict lang=python
q: What does this print?
code:
```python
def scope(kind):
    return {'iam':'partition','volume':'zone','bucket-objects':'region'}[kind]
print(scope('volume'))
```
answer:
```text
zone
```
why: An EBS volume lives in one Availability Zone. IAM is partition-global inside the account. Bucket objects are regional even though the bucket name is global.
:::

::: quiz
q: CloudFront sits in front of a single-AZ API. The zone fails. What do users get?
+ Errors, except where a cached object can be served without the origin. The edge is not a second Availability Zone
- Automatic failover to another region
- A healthy API, because edge locations are Multi-AZ
- DNS answers only, and the connection never used the origin
why: Cache hits can still be served. Anything that must reach the origin fails with the origin. High availability is still a property of the origin you built.
:::

::: quiz
q: A job in eu-central-2 calls STS on the global endpoint and also calls regional services. Why do newer designs prefer the regional STS endpoint?
+ So an impairment of the global endpoint is not a shared dependency of every AssumeRole
- Because IAM roles exist only in the regional STS endpoint
- Because the global endpoint cannot issue temporary credentials
- Because regional endpoints are free and the global one is billed per call
why: STS is available on regional endpoints. Using them removes a global dependency. The role itself is still global IAM. This is a reliability choice, not a billing trick.
:::

## A safe account
id: account
stage: found
needs: model
minutes: 45
goal: Lock root away, sign humans in through Identity Center, and use Organizations and SCPs as guardrails that do not grant access.
source: AWS Organizations: Service control policies | https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps.html
source: AWS IAM Identity Center: What is IAM Identity Center | https://docs.aws.amazon.com/singlesignon/latest/userguide/what-is.html
source: AWS Budgets | https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html

An AWS account starts as a blast radius and a credit card. The root user is the email address that created it. Root can do anything in the account, including close it, and it can do a few things no IAM principal can. That is why root is not a daily login. Put MFA on it, do not create access keys for it, and store the password where two people can reach it and a departing employee cannot. The day-to-day path is IAM Identity Center, formerly called AWS SSO. People sign in once, with your company's identity provider if you have one, and assume a permission set in the account they are supposed to touch. A permission set becomes an IAM role in the account. It is not a second kind of IAM user with a secret key.

An IAM user with a long-lived key is the older path. It still exists, and it is still how accounts get drained when the key lands in a git repository. Prefer Identity Center for humans. Prefer roles for software. If a break-glass IAM user remains, it is one user, MFA, no standing access keys, alarmed when it is used. The account lesson's job is to make the unsafe path harder than the safe one before anyone creates a bucket.

AWS Organizations is how you stop treating accounts as unrelated snowflakes. One management account holds the organization. Member accounts sit in a tree of organizational units: security, workloads, sandbox, suspended. You attach guardrail policies to a node, and they apply to the accounts under it. A service control policy is the guardrail people mean first. An SCP does not grant power. It is a filter on what member-account principals are allowed to do, even if their IAM policies are wide. The default SCP is FullAWSAccess, which allows everything the filter could allow. The moment you attach a second SCP, you are intersecting allows, and an explicit Deny anywhere in the chain wins. SCPs do not apply to the management account. A wide role there is not saved by the policy you wrote for the workloads OU. Keep the management account empty of workloads.

Two consequences fall out of that. First, an SCP cannot give a developer access they do not already have in IAM. People write an SCP with Allow s3:GetObject and are surprised the developer still cannot read the bucket. The allow in an SCP only defines the maximum. IAM still has to allow the call. Second, a Deny in an SCP stops even an administrator in the member account. That is how you make "no one disables CloudTrail" and "no one leaves the approved regions" true without trusting every account's admins. It is also how you lock yourself out of a region if you deny ec2:* and forget the role that was supposed to administer it. Test SCPs in a sandbox OU. Use the condition key aws:RequestedRegion rather than a list of actions you will get wrong.

Organizations can also turn on resource control policies. An RCP limits what resource-based policies in member accounts can allow, which is the other side of the same idea: SCPs cap the principals, RCPs cap the resources. You do not need an RCP to pass this lesson. You need to know that a bucket policy saying Principal star is still your problem, and that an organization guardrail can refuse that shape in member accounts. Delegated administrator is the other grown-up feature. Security services such as GuardDuty can be administered from a member account so the management account is not where analysts log in.

The bill is part of account safety. A budget is not a cap. AWS Budgets can email you when forecasted spend crosses a number. It will not stop the instances unless you add a budget action, and even then the action is something you defined, not a universal brake. Turn the alarm on before the workshop, not after the invoice. Cost allocation tags, agreed before anyone creates resources, are how the invoice becomes a set of owners. An untagged sandbox is how the invoice becomes a mystery. The cost lesson is the optimization. This lesson is the alarm and the boundary.

### A worked organization

A twenty-person company does not need forty accounts. It needs a shape it will not outgrow in a month. Management account: billing, the organization, no application. Security account: the log archive bucket, delegated GuardDuty, read-only roles into other accounts. Workloads OU: prod and non-prod accounts, separate. Sandbox OU: an SCP that denies everything outside two regions and denies leaving CloudTrail or GuardDuty off, plus a budget alert at a number that hurts feelings but not the company. Identity Center in the management account, or in a delegated identity account, with permission sets named for jobs: platform-admin, developer, auditor. Developers have no permission set in prod except a read-only one. The break-glass role in prod is allowed to administer, is alarmed, and is not the role CI uses.

CI does not use a person. A later module shows GitHub Actions assuming a role with OIDC. The account shape is what makes that role exist in the right account and not in every account. If prod and dev share an account, no identity provider trick will put the blast radius back.

### Where this breaks

SCPs feel like IAM, so people paste an identity policy into an SCP and expect it to grant access. It will not. People attach a Deny of iam:* and then cannot fix the account. People put workloads in the management account because it was the first one they had, and the SCP never applied to the thing they needed to protect. People create access keys for root "just to run the CLI once" and the key outlives the ticket. People treat a budget email as a spending limit and discover the GPU job ran all weekend. People federate everyone as AdministratorAccess in every account because the permission set was the example in the tutorial. Least privilege is the IAM lesson. The account lesson fails first if everyone is an admin of everything.

Quotas and support plans are account properties too. Raising a quota in the sandbox does not raise it in prod. Enterprise support on the management account is not automatically the support experience you think it is for member accounts. Check. Closing an account is slow and root-shaped. Do not learn that during an incident.

### How this is used at work

The platform team owns the organization, the SCPs, the trail bucket, and Identity Center. Application teams own their accounts inside the rails. Terraform runs with a role in the target account, not with keys from a shared admin user. A new account is a ticket with an OU, a budget, tags, and a permission set, not a credit card on someone's laptop. When a pen test says they disabled the trail, the SCP was missing or the trail was only in one region. Both are account-design bugs, not a clever attacker.

### What each control actually does

| Control | Grants access | Limits access | Applies to management account |
| IAM policy | Yes | Yes, within what the principal has | Yes, it is ordinary IAM |
| Permission boundary | No | Yes, a maximum on a principal | Yes, if you attach it |
| Service control policy | No | Yes, a maximum on member principals | No |
| Budget alert | No | No, unless you add an action | The budget is per account or consolidated |
| Root MFA | No | It only protects the root credential | Root exists in every account |

### You can now

Lock root down and say why it still exists. Log humans in through Identity Center permission sets instead of long-lived keys. Explain that an SCP filters and does not grant, and that it does not apply to the management account. Place prod, non-prod, and logs in different accounts. Turn on a budget alert before the first workshop resource, and not confuse the alert with a cap.

::: quiz
q: An SCP on the workloads OU allows only ec2:* and s3:*. A developer in a member account has IAM AdministratorAccess. Can they call iam:CreateUser?
+ No. The SCP filter does not include that action, so the call is denied even though IAM allows it
- Yes, because AdministratorAccess overrides an SCP
- Yes, because SCPs apply only to the management account
- Yes, if they use the console instead of the CLI
why: An SCP is a maximum, not a grant. Explicit absence of an allow in the SCP, once you have replaced the picture with a narrower allow list, denies the member-account principal. The management account is the one SCPs do not filter.
:::

::: quiz
q: Where should the production API run?
+ In a member account under a workloads OU, not in the management account
- In the management account, so the SCP protects it
- In the same account as the sandbox, with a different VPC
- On the root user's access key, so deploy does not depend on IAM
why: The management account is for the organization itself. SCPs do not constrain it. Prod and sandbox in one account share fate and share administrators.
:::

::: card
q: What does a budget alert do by itself?
answer: It notifies you when cost or forecasted cost crosses a threshold. It does not stop resources unless you configured a budget action to do a specific thing.
:::

::: predict lang=python
q: What does this print?
code:
```python
def scp_allows(action, allowed):
    return action in allowed
def iam_allows(action):
    return True
def final(action, allowed):
    return 'allow' if scp_allows(action, allowed) and iam_allows(action) else 'deny'
print(final('iam:CreateUser', {'s3:GetObject'}))
```
answer:
```text
deny
```
why: Both the SCP maximum and IAM have to allow the call. IAM allows everything here, and the SCP list does not include the action, so the result is deny.
:::

::: quiz
q: A new teammate needs to look at production logs. What do you give them?
+ An Identity Center permission set that can assume a read-only role in the production account
- The root password, because logs are sensitive
- An IAM user access key checked into the wiki
- AdministratorAccess in the management account
why: Humans should get temporary access through Identity Center, scoped to the account and the job. A key in a wiki is a leak. Root and the management account are the wrong blast radius for reading logs.
:::

::: quiz
q: In a member account, IAM allows s3:GetObject, the SCP allow list does not include it, and no SCP denies it. What is the result?
- Allow. AdministratorAccess in IAM overrides an SCP
+ Deny. An SCP does not grant, so a missing SCP allow blocks the call even when IAM allows it
- Allow. SCPs apply only to the management account, so this member account ignores them
- Deny only if the SCP was attached after the IAM policy
why: Both the SCP maximum and the identity policy have to allow the action, and an SCP deny would also block it. IAM cannot widen past the SCP. The management account is the one SCPs do not filter. Order of attachment does not change that.
:::

## IAM: who may do what
id: iam
stage: found
minutes: 45
goal: Read and write IAM policies, use roles instead of keys, and apply least privilege.
needs: model
source: AWS IAM: Policies and permissions | https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies.html
source: AWS IAM: Policy evaluation logic | https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic.html
source: AWS IAM: Security best practices | https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html

Every call you make in this module is the same shape. A principal asks for an action on a resource, the request is signed, and IAM decides. The console, the CLI, a Terraform provider, and an application using the SDK are not four permission systems. They are four ways to sign that request. If you can name the principal, the action, and the ARN, you can debug the denial. If you cannot, you will keep adding AdministratorAccess until the error goes away, which is how the next incident starts.

A principal is who. An IAM user is an identity in one account with optional long-lived access keys. Humans should not have those keys. Use IAM Identity Center, from the account lesson, so a person gets a role session that expires. A role is an identity with no password and no standing key. Something that IAM already trusts assumes the role and receives temporary credentials from STS. Those credentials expire. An EC2 instance profile, a Lambda execution role, an ECS task role, and a GitHub Actions job using OIDC are all this pattern. The root user is a principal too, and it is the one you already locked away. A service itself can be a principal in a trust policy or a resource policy, which is not the same as your application being a principal. The next lesson pulls that apart. This lesson is the identity policy on the caller.

A policy is a JSON document of statements. Each statement has an effect, an action or a list of them, a resource or a list of them, and sometimes a condition. The version string you will see is 2012-10-17. It is the policy language version, not the date you wrote the file. Effect is Allow or Deny. Action is a service prefix and a verb, such as dynamodb:GetItem. Resource is an ARN. Star is a real character. It matches more than you think, and it matches things that will exist next year and that you did not review. Least privilege is the practice of naming the verbs and the ARNs the job needs, then widening when a real denial says you missed one. CloudTrail and IAM Access Analyzer are how you see the miss. A policy that was copied from a tutorial and never narrowed is not temporary. It is the production policy.

Identity-based policies attach to the principal. That is the policy on the role the ECS task uses. Resource-based policies attach to the resource and say which principal may use it. An S3 bucket policy is the usual example. Both can matter for one request. The deep lesson is the full order, including SCPs and permission boundaries. You already know the part that surprises people first. The request starts denied. An allow permits it. An explicit deny beats the allow, no matter which policy it sits in and no matter the order of the statements. There is no "the bigger policy wins" and there is no "the newer policy wins".

Conditions are how a statement becomes true only in a situation. s3:prefix on ListBucket, aws:RequestedRegion, aws:SourceIp, and s3:x-amz-server-side-encryption are conditions. A condition that does not match makes that statement not apply. It does not make the opposite statement true. If your only allow requires a condition the caller forgot, the result is an implicit deny, and the error looks like a missing permission. Read the encoded denial message. It is more useful than guessing which star to add.

Roles for applications are the point of the lesson. The task that reads one table should have dynamodb:GetItem and dynamodb:Query on that table's ARN, not dynamodb star on star. The instance profile on an EC2 box is the same idea, and it is a reason to be careful what else runs on that box. Anything that can reach the instance metadata service can ask for the role's credentials. IMDSv2, hop limits, and not running untrusted code next to a powerful role are part of using a role well. A role does not make a bad policy safe. It makes the credential short-lived. The policy is still your fault.

### A worked policy

A reporting job must read objects under reports/ in acme-data and must list that prefix. Those are two different IAM actions on two different ARNs, which is why the exercise at the end of the original steps is picky. s3:GetObject applies to object ARNs, the ones that include the key. s3:ListBucket applies to the bucket ARN, the one with no key, and the prefix is a condition, not part of the ARN. People write ListBucket on arn:aws:s3:::acme-data/reports/* and the call does not do what they meant. People write GetObject on the bucket ARN and it does not either. The resource type is part of the permission. The service authorization reference is the page that says which action takes which resource. Guessing from the console is how the policy grows a star.

The same job does not need s3:DeleteObject, s3:PutBucketPolicy, or s3:*. If a later feature needs a delete, that is a new statement, reviewed, not a widening of the first one because it was late. Separate statements for separate jobs make the denial easier to read. One statement with ten actions and a star is shorter to type and harder to trust.

### Where this breaks

The common break is a long-lived key in an environment variable, then in a crash dump, then in a ticket. The role removes the key only if you actually stop creating the key. The next break is an explicit deny you forgot in a permissions boundary or an SCP, and an allow you keep editing. The allow will never win. The next is a policy attached to the wrong principal: the Lambda execution role is correct and the developer is testing with their own admin keys, so the test proves nothing. Call sts get-caller-identity, or the CLI lesson's equivalent, as the first step of a denial. The next is trust in names. A policy on a role named prod-read that allows s3:* is not a read role. The next is NotAction and NotResource, which invert the match and are easy to write backwards. Avoid them until you can explain the match on a whiteboard.

Cross-account access needs two agrees. The caller's identity policy must allow the action, and the resource policy or the role trust must name the caller. Either half alone fails. People fix one side three times. The deep lesson is the trust policy. Here, remember that "it works in the same account" is not evidence it will work across accounts.

### How this is used at work

Application repositories contain the identity policy next to the service, reviewed like code. Platform repositories contain the SCPs and the permission boundaries. A human does not paste JSON into the console in production. Access Analyzer tells you which roles are unused and which external principals you trust. After an incident, the question is which principal called which action, and CloudTrail answers it if the trail was on. The Kubernetes module's EKS Pod Identity is this same role, assumed for a service account instead of for an instance. The Terraform module will create the role. Neither tool invents the least privilege for you.

### Choosing the principal

| Caller | Give it | Do not give it |
| A person | An Identity Center permission set, temporary | An access key, root |
| An ECS or Lambda workload | A role with the actions that workload performs | A user key in the environment |
| A CI job | A role assumed via OIDC, scoped to one account | A shared admin key in the runner |
| Another account's role | An allow on your side and a trust or resource policy naming them | A copied key |
| Break glass | A role that is alarmed and unused | The same role the app uses every day |

### You can now

Name the principal, action, and resource of a call. Read an identity policy and say what it allows. Predict that an explicit deny beats an allow, and that no allow means deny. Attach a role to a workload instead of a key. Write object actions against object ARNs and ListBucket against the bucket ARN with a prefix condition. Ask which principal you are actually testing with before you widen a policy.

::: quiz
q: One policy allows `s3:*` on a bucket; another policy attached to the same role denies `s3:DeleteObject` on it. Can the role delete objects?
- Yes, the Allow is broader
+ No: an explicit Deny always overrides an Allow
- Only if the Deny policy was attached later
- It depends on the order of statements
why: IAM evaluation: explicit deny beats any allow, regardless of order or breadth.
:::

::: quiz
q: Your app on ECS needs to read one DynamoDB table. Best way to give it access?
- Create an IAM user, put its access key in an environment variable
- Put the root user's keys in Secrets Manager
+ Give the ECS task a role whose policy allows the needed DynamoDB read actions on that table's ARN
- Make the table public
why: A task role gives temporary, automatically rotated credentials, scoped to what the app needs. No long-lived key exists to leak.
:::

::: config lang=json
task: Write a policy for a reporting job. It may **read** objects under the `reports/` prefix of bucket `acme-data` (`s3:GetObject`), and **list** the bucket but only for keys starting with `reports/`. Listing is the action `s3:ListBucket` on the **bucket** ARN (no `/*`), limited with a `Condition` on `s3:prefix` using `StringLike` and `reports/*`.
starter:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "s3:*",
      "Resource": "*"
    }
  ]
}
```
check: Version = 2012-10-17 | Version is 2012-10-17
check: Statement[*].Action !~ /\*/ | No wildcard actions
check: Statement[*].Resource !~ /^"?\*"?$/ | No Resource of just *
check: Statement[*].Effect = Allow | Every statement is an Allow
check: Statement ~ /"s3:GetObject"/ | Allows s3:GetObject
check: Statement ~ /"Resource":"arn:aws:s3:::acme-data\/reports\/\*"/ | GetObject is limited to arn:aws:s3:::acme-data/reports/*
check: Statement ~ /"s3:ListBucket"/ | Allows s3:ListBucket
check: Statement ~ /"Resource":"arn:aws:s3:::acme-data"/ | ListBucket is on the bucket ARN arn:aws:s3:::acme-data
check: Statement ~ /"StringLike":\{"s3:prefix":"reports\/\*"\}/ | Listing is limited with StringLike on s3:prefix = reports/*
solution:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::acme-data/reports/*"
    },
    {
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::acme-data",
      "Condition": {
        "StringLike": { "s3:prefix": "reports/*" }
      }
    }
  ]
}
```
hint: Two statements: objects are `arn:aws:s3:::acme-data/reports/*`; the bucket itself is `arn:aws:s3:::acme-data`. Add `"Condition": { "StringLike": { "s3:prefix": "reports/*" } }` to the listing statement.
:::

::: card
q: In IAM, what wins when one statement Allows an action and another applicable statement Denies it?
answer: The explicit Deny. It beats every Allow. Statement order and which policy was attached later do not matter. If no statement applies, the request is an implicit deny.
:::

::: predict lang=python
q: What does this print?
code:
```python
def decide(effects):
    if 'Deny' in effects:
        return 'deny'
    if 'Allow' in effects:
        return 'allow'
    return 'deny'
print(decide(['Allow', 'Deny']))
```
answer:
```text
deny
```
why: An explicit deny is checked as a veto. The Allow in the same list does not outvote it. No matching effect at all would also deny, which is the other branch.
:::

::: quiz
q: A developer says the ECS task role is wrong because the call works from their laptop. What should you check first?
+ Which principal the laptop is using. Their admin user can succeed while the task role would still be denied
- The region of the IAM role, because roles are copied per region
- Whether the laptop is in a public subnet
- The size of the ECS task CPU
why: A successful call proves the caller's policy, not the role you meant to test. Confirm the principal, then test as that role. IAM roles are not regional copies.
:::

::: quiz
q: One matching statement Allows s3:DeleteObject and another matching statement Denies it. No other statement matches. What does IAM do?
- Allow, because an Allow is enough once any statement matches
+ Deny. An explicit Deny beats the Allow, and a request with no matching statement would also be denied
- Allow, if the Allow statement appears first in the file
- Deny only when the Deny is in a different account
why: Explicit deny wins over allow regardless of statement order. If nothing matched, the result would still be an implicit deny. The two statements here are on the same request, not a cross-account gap.
:::

## IAM in depth
id: iam-deep
stage: found
needs: iam, account
minutes: 50
goal: Explain a denial across identity policies, trust policies, permission boundaries, and SCPs, and assume a role on purpose.
source: AWS IAM: Policy evaluation logic | https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic.html
source: AWS IAM: Permission boundaries | https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_boundaries.html
source: AWS IAM: Temporary security credentials | https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_temp.html
source: Amazon EKS: Pod Identity | https://docs.aws.amazon.com/eks/latest/userguide/pod-identities.html

The last lesson was enough to write a role for one task in one account. Production denials are meaner than that. A request can be allowed by the identity policy, allowed by the bucket policy, inside the permission boundary, and still denied by an SCP. Or the identity policy is fine and the role cannot be assumed, because the trust policy names a different principal. This lesson is the rest of the decision, in the order you can remember under pressure.

Start with the caller. If the caller is in your account, their identity-based policies are the first place an Allow can come from. If the caller is in another account, an identity policy in their account must allow the action, and something on your side must agree: a resource-based policy that names them, or a role trust policy if what they are doing is assuming a role. Same-account calls can be allowed by the identity policy alone. Cross-account calls cannot. That single split explains a large fraction of "it works in dev" tickets, because dev was one account.

The trust policy is a resource-based policy on the role. It answers who may call sts:AssumeRole, not what the role may do afterwards. The identity policies attached to the role answer the afterwards. Mixing them up produces a role that anyone can assume and that can do nothing, or a role that can do everything and that nothing is allowed to assume. The principal in the trust is a specific role ARN, an account, or a service principal such as lambda.amazonaws.com or pods.eks.amazonaws.com. A trust of Principal AWS star is a public role. Do not do that. For cross-account access, add a condition on sts:ExternalId when the party on the other side is a vendor who assumes roles for many customers. The external id is not a secret in the cryptographic sense. It is a confused-deputy check so their task for customer A cannot be pointed at your role by a task for customer B. You still need the identity policy on their side, and you still must not trust their whole account if a narrower role ARN is available.

STS is the service that mints the temporary credentials. AssumeRole returns an access key id, a secret, a session token, and an expiration. The session token is not optional. Calls signed with the key and secret but without the token fail in a way that looks like a bug in the SDK. Session duration is bounded by the role's maximum and by the caller's request. Shorter sessions shrink the window of a stolen credential. They also annoy humans if Identity Center's session is shorter than the work. Pick the duration on purpose. AssumeRoleWithWebIdentity is the OIDC path that CI and IRSA use. The trust then conditions on the token's subject, audience, and issuer. A trust that checks only the issuer accepts every workflow in that identity provider.

A permission boundary is a second policy on a user or role. It does not grant anything. The effective permission is the intersection of the identity policy and the boundary. People use boundaries so a developer who can create roles cannot create a role more powerful than the boundary. That only works if creating a role also requires iam:PermissionsBoundary to be set to that policy. Otherwise the developer creates a role with no boundary. SCPs, from the account lesson, are the organization-shaped version of a maximum, and they do not apply to the management account. The evaluation order you should be able to say out loud is: explicit deny anywhere in the applicable policies wins; otherwise an allow must exist on the identity side and, when they apply, the boundary, the session policy, and the SCP must not withhold it; resource policies can allow, and for some services they are required across accounts. Session policies, passed into AssumeRole, can only narrow the session. They cannot widen past the role.

Resource policies have their own sharp edges. An S3 bucket policy that allows a principal is useless if the identity policy or the SCP denies, because deny wins. A bucket that blocks public access ignores a public grant even if the policy says Principal star. KMS is stricter than most services: a key policy that does not trust the account root, or that does not name the caller, denies even an admin, because KMS requires the key policy to allow the call. People learn this by locking themselves out of a key. The KMS lesson is the recovery. The IAM lesson is the warning that "admin" is not magic in every service.

### A worked denial

A Lambda in account A reads a bucket in account B. The function's role allows s3:GetObject on the object ARN. The call still fails. The bucket policy in B does not name the role. Add that principal to the bucket policy. It still fails. The bucket is encrypted with a customer managed key in B, and the key policy does not allow the role kms:Decrypt. Add that. It still fails. An SCP in A denies s3:* outside a region, and the bucket is in the other region. No identity policy edit will fix an SCP deny. The order of debugging is the order of evaluation: read the denial, identify the principal with the CLI, then ask which layer can say no. CloudTrail on the bucket's side, if data events are on, shows the failing call. They often are not on, because data events cost money. The observe lesson is that tradeoff.

EKS is the same machinery. Pod Identity has the cluster's agent call STS and pass temporary credentials to the pod. The role trust must allow pods.eks.amazonaws.com to assume it and to tag the session. There is no OIDC provider to create for that path. IRSA is the older path: an OIDC provider per cluster and a trust on the token's subject. Fargate pods do not use Pod Identity. They use IRSA for the application role. The pod execution role is what the Fargate platform uses to pull images and write logs, and the container cannot assume it. The EKS lesson comes back to the cluster side. If the trust is wrong, no Kubernetes annotation will save it.

### Where this breaks

Wildcards in trusts. Missing session tokens. Boundaries that are not required on iam:CreateRole. External ids that are the same for every customer, which defeats the point. Conditions written against the wrong key, so the statement never applies and the result is an implicit deny that looks like a missing action. Passing a role with iam:PassRole to a service that will run it, which is a second permission people forget, and also a privilege escalation if a user can pass an admin role to a service they can edit. A user who can attach policies to a role they can assume is an admin, whatever their job title says. Least privilege includes the IAM actions, not only the data actions.

### How this is used at work

Platform teams publish a boundary and a pipeline that refuses roles without it. Application teams write the identity policy and the trust conditions for their OIDC subject. Vendors get an external id and a role with the few actions they need, not an IAM user in your account. Reviews ask "who can assume this" before they ask "what can it do". After a leak of temporary credentials, you look at the expiration and at what the session was allowed to do. You do not rotate a key that does not exist. You do revoke the session if it is still valid and you can, and you fix the trust that was too wide.

### Which document says what

| Document | Question it answers | Can it grant |
| Identity policy | What may this principal do | Yes |
| Trust policy | Who may assume this role | It grants the assume, not the later actions |
| Permission boundary | What is the maximum for this principal | No |
| Session policy | What this one session must not do beyond the role | No, it only narrows |
| SCP | What member principals may do at most | No |
| Resource policy | Which principals may touch this resource | Yes, and cross-account often needs it |
| KMS key policy | Who may use this key | Yes, and it is mandatory |

### You can now

Separate a trust policy from an identity policy. Explain why cross-account access needs an agreement on both sides. Describe a permission boundary as an intersection, not a grant. Trace a denial through identity policy, resource policy, boundary, and SCP. Write a trust that names a principal and a condition instead of a star. Say why EKS Pod Identity and IRSA are both STS, and why a Fargate pod does not use the execution role as its application role.

::: quiz
q: A role's identity policy allows s3:GetObject on a bucket in another account. The bucket policy does not mention the role. The call fails. What is missing?
+ Agreement on the resource side. Cross-account access needs the bucket policy, or another resource policy, to allow that principal
- A second copy of the role in the bucket's region
- An SCP that grants s3:GetObject
- Root credentials in the caller's account
why: Same-account calls can succeed on the identity policy alone. Cross-account calls also need the resource to trust the caller. An SCP cannot grant the missing allow.
:::

::: quiz
q: What does a permission boundary do?
+ It sets a maximum. The principal only gets actions allowed by both the identity policy and the boundary
- It replaces the identity policy
- It grants everything in the boundary even if the identity policy is empty
- It applies to every account in the organization
why: The boundary does not grant. An empty identity policy still denies. Organization-wide maxima are SCPs, and those do not apply to the management account.
:::

::: card
q: What is in a trust policy?
answer: Who may assume the role: a principal, often with a condition such as an OIDC subject or an external id. It is not the list of S3 or DynamoDB actions the role can perform afterwards. Those belong in the identity policy.
:::

::: predict lang=python
q: What does this print?
code:
```python
def effective(identity, boundary):
    return 'allow' if identity and boundary else 'deny'
print(effective(True, False))
```
answer:
```text
deny
```
why: Both the identity policy and the boundary have to allow the action. A boundary of false withholds it. This is an intersection, not a union.
:::

::: quiz
q: A vendor's task assumes your role and can be pointed at the wrong customer. What belongs in the trust?
+ A condition on sts:ExternalId that only your agreement with that vendor satisfies
- Principal set to star, so the vendor is not blocked
- The vendor's root access key stored in your Secrets Manager
- An SCP in the vendor's account
why: The external id is a confused-deputy check on AssumeRole. It does not replace a narrow principal. You cannot attach an SCP to someone else's account.
:::

::: quiz
q: A role's identity policy allows kms:Decrypt, the permission boundary does not, and the SCP allows it. There is no explicit Deny. Can the role decrypt?
- Yes. The identity policy is the only grant that matters
+ No. The boundary is a maximum. The action has to be inside the identity policy, the boundary, and the SCP
- Yes. A boundary grants what it lists even when the identity policy is empty
- No, because an SCP always denies decrypt
why: Effective permission is the intersection of the identity policy and the boundary, still capped by the SCP. The boundary does not grant. An SCP allow is not a reason to ignore the boundary, and this stem has no explicit deny to blame instead.
:::

::: quiz
q: Which role should a container on EKS Fargate use to read from DynamoDB?
+ An IRSA role on the service account. Pod Identity does not run on Fargate, and the pod execution role is for the platform, not the container
- The Fargate pod execution role, because it already exists
- EKS Pod Identity, because it is the current default for every compute type
- The node instance profile of a cluster that has no EC2 nodes
why: Pod Identity needs the agent on Linux EC2 nodes. Fargate application permissions stay on IRSA. The execution role pulls images and writes logs for the platform.
:::

## CLI and SDK
id: cli-sdk
stage: found
needs: iam
minutes: 40
goal: Sign calls as the principal you meant, see where the credentials came from, and stop putting long-lived keys in code and CI.
source: AWS CLI: Configuring settings | https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-files.html
source: AWS SDKs: Credential provider chain | https://docs.aws.amazon.com/sdkref/latest/guide/standardized-credentials.html

The CLI and the SDKs are how you stop clicking. They are also how a laptop becomes an admin of production if you treat credentials as a file you copy. This lesson is the signing path and the credential chain, not a tour of every subcommand. You will look up subcommands. You cannot look up, after a leak, which principal a script was using if you never printed it.

A request is signed with Signature Version 4. The SDK builds a canonical request, mixes in the date, the region, and the service name, and signs it with a key derived from the secret access key. The access key id goes with the request so IAM can find the principal. If the credentials are temporary, the session token goes too. A region in the signature that is not the region of a regional endpoint fails. A clock that is badly wrong fails, because the date is part of the signature. These errors look like network bugs. They are not. The practical check is aws sts get-caller-identity. It tells you the account and the ARN of the caller the CLI is using right now. Run it before a destructive command and whenever a denial surprises you.

Where the CLI finds those keys is the chain. You do not need to recite every step from memory. You need to know that more than one place can supply them, and that the first one that applies wins, which may not be the profile you edited. Environment variables override the shared files. A profile named in AWS_PROFILE selects a block in the config and credentials files. A container credential relative URI, or an EC2 instance metadata role, supplies keys when there is no file. On a laptop, Identity Center writes a short-lived session into the profile after you log in. On a build agent, you want the same shape: the agent assumes a role, and the environment receives temporary keys, and there is no long-lived key in the runner image. aws configure list shows which provider supplied the access key, the secret, and the region. When two tools disagree, that output is the argument.

Profiles are how one laptop talks to more than one account without renaming files. A profile can name a role to assume and a source profile to assume it with. That is the right shape for a break-glass admin: the source is your ordinary Identity Center session, the role is the alarmed one, and the profile is not the default. The default profile should be the harmless account. People set default to production because it saves a flag. Then a script written for a sandbox runs against production. There is no IAM feature that saves you from the default profile except not having permission, which is why the sandbox role should not work in prod in the first place.

The SDK in an application should not read a key from a string in the source. The default provider chain looks at the environment, then the files, then the container or instance role, with the same idea as the CLI. On ECS and EKS the chain picks up the task role or the Pod Identity credentials if the SDK is new enough to know how. An old SDK that does not understand the Pod Identity endpoint will sit on the node role or on nothing, and the error will be a denial or a metadata timeout. Pin SDK versions when you change identity mechanisms. Passing keys into a container environment from a CI secret is the old path. It works until the secret is copied into logs. Prefer the role.

Retries and idempotency are part of calling an API, not a library detail. SDKs retry throttling and transient network errors. They should not blindly retry a payment or an order create unless the API has an idempotency key. A client timeout that is shorter than the server's work produces a retry of a call that is still running. S3, DynamoDB, and SQS are built for this. Your HTTP API might not be. The serverless lesson uses idempotency keys for that reason. The CLI lesson's contribution is to stop treating a 500 from a script as "run it again" when the first run created the resource and the second failed on the name.

Region and output are the other foot-guns. The CLI region is not the console region. A command with no --region uses the profile's region, which might be us-east-1, and creates the bucket in the wrong country. Set the region in the profile you use for that account, and pass --region when a script must be obvious. --output json is what you can parse. Do not parse the table output. Do not use a shell pipeline as an authorization check. And do not log the whole process environment. The session token in that dump is a credential.

### A worked setup

A developer has three profiles. sandbox comes from Identity Center and can create what the workshop needs inside two regions. prod-read comes from Identity Center and can read logs and metrics in production. prod-admin is a role assumption from prod-read, max session one hour, and CloudTrail plus an alarm on AssumeRole of that role. The shell prompt shows the profile name. Scripts take --profile as a required argument, or they refuse to run when AWS_PROFILE is unset, so the default profile is never accidentally production. get-caller-identity is the first line of the deploy script's dry run. None of the profiles has a permanent access key in ~/.aws/credentials. If that file has a key, it is a finding, not a convenience.

### Where this breaks

Committed credentials files. Environment variables in a Docker image. A CI job that uses a personal access key because the OIDC role was a ticket for later. A laptop with an expired SSO session that falls through to an old key still in the credentials file, which is why finding that old key matters. Tools that shell out to the CLI and inherit a different profile than the Terraform provider next to them, so the plan and the script disagree. Retry loops that create duplicate orders. Region mismatches that pass tests in us-east-1 and fail a residency review. And SDKs configured with a custom endpoint for a local emulator left on in production, so you were never talking to AWS.

### How this is used at work

Local development uses Identity Center. CI uses OIDC to a role per account, the same idea Terraform will use. Applications use the runtime role. Nobody shares a key in a password manager as the integration plan. When a key does leak, you disable it, you look in CloudTrail for what it did, and you replace the path that required a key with a role so there is nothing to leak next time. The CLI remains how you inspect: caller identity, the policy simulator when you are allowed to use it, and the service commands the runbook names. It is not how production deploys once Terraform exists. A laptop running aws s3 rb on the wrong profile is a resume-generating event.

### Where the credential should come from

| Place the code runs | Credential | Smell |
| Your laptop | Identity Center profile, short session | A long-lived key in the credentials file |
| CI | OIDC assume-role into one account | A personal key in the runner secret |
| ECS, Lambda, EC2, EKS pod | The runtime role via the default chain | Keys injected as environment variables |
| A break-glass shell | A separate profile that assumes an alarmed role | Using that profile as the default |
| A unit test | No network and no keys | A test that fails without your production profile |

### You can now

Explain that the CLI and the SDK sign the same kind of request IAM evaluates. Use get-caller-identity and configure list to see which principal and which provider you are actually using. Keep production out of the default profile. Prefer roles and Identity Center over access keys. Name the failure modes of retries without idempotency, and of a region that was never set.

::: quiz
q: A command was denied, and the policy on the role you meant to use does allow it. What do you run first?
+ aws sts get-caller-identity, to see whether the CLI is even using that role
- aws iam create-access-key, to get a fresh key
- A second copy of the command with --no-sign-request
- An SCP that grants the action
why: The denial is about the principal that signed the request. Confirm that principal before you edit a policy. An SCP cannot grant what IAM already allows.
:::

::: card
q: What does aws configure list tell you that the config file alone does not?
answer: Which provider actually supplied the access key, secret, and region the next command will use. A value in the file can lose to an environment variable or to a role from instance metadata.
:::

::: quiz
q: Where should a CI job get permission to deploy into one account?
+ By assuming a role with OIDC, so the job holds temporary credentials and no long-lived key
- From a personal access key stored as a runner secret
- From the root access key of the management account
- From the developer's default profile, copied into the image
why: OIDC federation is the same AssumeRole pattern as a workload role. A key in the runner is a standing credential. Root and a personal profile are the wrong principals.
:::

::: predict lang=python
q: What does this print?
code:
```python
def signer(env_key, file_key):
    return env_key or file_key
print(signer('ENV', 'FILE'))
```
answer:
```text
ENV
```
why: If an environment credential is set, it wins over the shared file in this model. Editing the file would not change the caller. Real CLIs have more providers; the point is that the first match wins.
:::

::: quiz
q: A script retries any failed HTTP call, including the one that creates an invoice. What is the risk?
+ The first call may have succeeded and the retry creates a second invoice, unless the API deduplicates with an idempotency key
- Retries are ignored by AWS, so nothing happens twice
- Signature Version 4 refuses retries
- IAM denies the second call automatically
why: SDKs retry some transport errors. A create that is not idempotent is your bug. Payments and orders need a key the server remembers, or a queue that accepts the work once.
:::

::: quiz
q: The console shows the bucket in eu-central-2. The CLI says it does not exist. What is a likely cause?
+ The CLI profile's region is not eu-central-2, so you are asking a different regional endpoint
- S3 bucket names are zonal, so the console and the CLI see different zones
- IAM roles do not work in the CLI
- The bucket is global, so region cannot matter
why: Regional services answer for the region you sign. The console region and the CLI region are separate settings. The bucket name is global, but the objects are in the region where it was created.
:::

## Networking: VPCs
id: vpc
stage: build
minutes: 45
goal: Draw a standard VPC with public and private subnets, and say exactly what can reach what.
needs: iam, linux/network
source: AWS VPC: How Amazon VPC works | https://docs.aws.amazon.com/vpc/latest/userguide/how-it-works.html
source: AWS VPC: Security groups | https://docs.aws.amazon.com/vpc/latest/userguide/vpc-security-groups.html
source: AWS VPC: Gateway endpoints | https://docs.aws.amazon.com/vpc/latest/privatelink/gateway-endpoints.html

A VPC is the network you actually control in one region. It has a CIDR, a set of subnets, route tables, and two different firewalls that people insist on merging into one mental model. They are not one model. If you can draw the route and the security group for a packet, you can explain almost every "it times out" ticket in this module. Timeouts are the clue. AWS firewalls drop traffic they do not allow. They often do not send a reset. A timeout means you are looking at a route, a security group, or a network ACL, not at an application error that would have returned HTTP 500.

The address plan comes first. 10.0.0.0/16 is a common VPC CIDR. It is also a common office CIDR, and a common other-VPC CIDR. If you will ever peer, attach a transit gateway, or connect a VPN, overlapping ranges are a redesign, not a setting. Carve subnets by zone and by tier. A public subnet has a route of 0.0.0.0/0 to an internet gateway. That route is what the word public means, not the word in the subnet's name. A private subnet has no route to the internet gateway. Instances there can have no public IP and still be useful. A data subnet is just a private subnet you promise not to put the app in, so the database's security group has a smaller set of peers. Each subnet is in exactly one Availability Zone. A regional service such as a load balancer is not a subnet. It has an elastic network interface in each subnet you give it.

Outbound from private subnets is the NAT gateway, sitting in a public subnet with an elastic IP, and the private route table points 0.0.0.0/0 at it. NAT is one way. The internet cannot open a connection through it. It is also billed per hour and per gigabyte, per AZ if you build one per AZ, which you should if you do not want a zone failure to cut everyone else's outbound path. Pulling images and talking to S3 through NAT is the bill the cost lesson complains about. Gateway endpoints for S3 and DynamoDB are route-table entries, not boxes you pay per hour, and they keep that traffic off NAT. Interface endpoints, PrivateLink, are different. The edge lesson covers them. Here, know that "private subnet" does not mean "no AWS API access" and it does not mean "free AWS API access".

Security groups are attached to elastic network interfaces: the instance, the load balancer, the RDS instance, the Lambda in a VPC, the Fargate task. They are allow-only and stateful. If the inbound connection is allowed, the response is allowed, without an outbound rule for the client's ephemeral port. The default outbound rule is allow all, which people forget to narrow. Referencing another security group is the three-tier pattern: the load balancer allows 443 from the internet, the app allows its port only from the load balancer's group, the database allows its port only from the app's group. IP addresses of tasks change. Group ids do not. Network ACLs are on the subnet, stateless, and can deny. A deny on a NACL is how you block a single abusive range at the subnet. It is also how you break return traffic by forgetting the ephemeral ports, because stateless means the response is a separate packet. Leave NACLs open until you have a reason, and then write both directions.

VPC flow logs are the record of which packets the network accepted or rejected. They are not CloudTrail, and they are not application logs. When a timeout is blamed on IAM, flow logs are how you show it was a reject on port 5432. They cost money and they can contain addresses you treat as sensitive. Turn them on for the production VPC at a sane sampling or a filter, and keep them where the security account can read them.

### A worked three-tier path

A request arrives at the internet gateway, follows the public route table to the load balancer in a public subnet in zone a or b. The load balancer's security group allows 443 from the world. It opens a new connection to a task in a private subnet. That works only if the app's security group allows the app port from the load balancer's group, and the route from the private subnet back to the load balancer's address is the local VPC route, which is automatic. You do not NAT traffic inside the VPC. The task connects to Postgres on 5432. The database security group must allow 5432 from the app group. The database subnet's route table must not be required to send that packet to the internet. If the task also calls an external API, that packet uses the NAT route. If the task calls S3, give it the gateway endpoint so the PDF upload does not hairpin through NAT. Health checks are connections too. A security group that allows the user port but not the health check port will look like a broken application and is a broken rule.

### Where this breaks

A subnet named private with a route to the internet gateway. A NAT gateway in only one zone, so the other zone's failure mode is "cannot pull images". A security group that allows 22 from the world because SSH felt easier than Session Manager. Session Manager uses the instance role and does not need a port. A NACL copied from a blog that allows inbound 443 and not the return range. A peering connection that was created and never had routes added on both sides. DNS that is off, so the interface endpoint exists and the name does not resolve. IPv6 added on one subnet and not in the security group, or the reverse. And CIDR overlaps discovered the week you try to connect the office.

### How this is used at work

Platform owns the VPC, the address plan, the endpoints, and the flow logs. Application teams receive subnet ids and security group ids, or a higher-level service that uses them. Terraform modules should not let an app team set 0.0.0.0/0 on the database. Kubernetes on EKS uses the same subnets. The AWS VPC CNI gives pods addresses from the subnet, which is why the subnet must be large enough for pod density, not only for nodes. That is a different lesson's depth. The network fact you need now is that an undersized subnet fails later, at scale, with an error that does not say "you chose /28 in a workshop".

### Which firewall

| | Security group | Network ACL |
| Attached to | An elastic network interface | A subnet |
| Rules | Allow only | Allow and deny |
| State | Stateful, return traffic follows | Stateless, write both directions |
| Typical use | The real design | A rare explicit deny, or a compliance demand |
| Failure look | Timeout, flow log REJECT | Timeout, and the return path is the usual bug |

### You can now

Draw a VPC with public, private, and data subnets in two zones, and say which route table entry makes a subnet public. Place a NAT gateway and say what it does not allow inbound. Write security group rules that reference other groups for a three-tier app. Explain why a NACL is stateless. Send S3 traffic to a gateway endpoint instead of NAT, and know that PrivateLink, DNS, and load-balancer types are the next lesson rather than a second kind of subnet.

::: quiz
q: An instance in a private subnet can't download packages from the internet. The subnet's route table has only the local route. What's missing?
- An internet gateway route; make the subnet public
+ A route `0.0.0.0/0` to a NAT gateway in a public subnet
- A security group rule allowing inbound 443
- An Elastic IP on the instance
why: A NAT gateway gives private subnets outbound access while keeping them unreachable from outside. Making the subnet public would expose the instance.
:::

::: quiz
q: A security group allows inbound 443 from anywhere and has no outbound rules except the default "allow all". A client connects on 443. Are the responses allowed back out?
+ Yes: security groups are stateful, so return traffic for an allowed connection is allowed
- No, an outbound rule for the client's port is needed
- Only if the NACL allows it inbound
- Only for TCP, not for TLS
why: Stateful means the response to an allowed connection is allowed automatically. (NACLs are stateless and would need rules both ways.)
:::

::: config lang=json
task: Here's a simplified description of three security groups, as JSON. Fix it so it follows the three-tier rule: the **load balancer** accepts 443 from anywhere (`0.0.0.0/0`); the **app** accepts 8000 **only from the `lb` group**; the **database** accepts 5432 **only from the `app` group**. Nothing else may be open.
starter:
```json
{
  "lb":  { "ingress": [{ "port": 443, "from": "0.0.0.0/0" }] },
  "app": { "ingress": [{ "port": 8000, "from": "0.0.0.0/0" }, { "port": 22, "from": "0.0.0.0/0" }] },
  "db":  { "ingress": [{ "port": 5432, "from": "10.0.0.0/16" }] }
}
```
check: lb.ingress count 1 | The load balancer has one rule
check: lb.ingress[0].port = 443 | It opens 443
check: lb.ingress[0].from = 0.0.0.0/0 | …to anywhere
check: app.ingress count 1 | The app has exactly one rule (SSH from the internet is gone)
check: app.ingress[0].port = 8000 | The app opens 8000
check: app.ingress[0].from = sg:lb | …only from the lb group (written "sg:lb")
check: db.ingress count 1 | The database has one rule
check: db.ingress[0].port = 5432 | The database opens 5432
check: db.ingress[0].from = sg:app | …only from the app group (written "sg:app")
solution:
```json
{
  "lb":  { "ingress": [{ "port": 443, "from": "0.0.0.0/0" }] },
  "app": { "ingress": [{ "port": 8000, "from": "sg:lb" }] },
  "db":  { "ingress": [{ "port": 5432, "from": "sg:app" }] }
}
```
hint: Reference groups as `"sg:lb"` and `"sg:app"`. Remove the SSH rule (use Session Manager instead of open SSH).
:::

::: card
q: What makes a subnet public?
answer: A route to an internet gateway, usually 0.0.0.0/0. The subnet's name does not. Instances in that subnet still need a public address or a load balancer to be reached, and they still need a security group that allows the port.
:::

::: quiz
q: Private tasks cannot reach S3, and the NAT bill is already high. What is the fitting fix for S3?
+ A gateway VPC endpoint for S3 on the private route tables, so S3 traffic does not use NAT
- A public IP on every task
- An internet gateway route in the private subnet
- A Transit Gateway attachment for one bucket
why: The S3 gateway endpoint is a route-table target. It is the usual way to reach S3 from private subnets without NAT data charges. Opening the subnet to the internet is the wrong direction.
:::

::: predict lang=python
q: What does this print?
code:
```python
def response_allowed(stateful, inbound_ok):
    if stateful and inbound_ok:
        return 'yes'
    return 'no'
print(response_allowed(True, True))
```
answer:
```text
yes
```
why: A stateful security group allows the response to an allowed inbound connection. A stateless ACL would need a second rule. The model prints yes only when both conditions hold.
:::

::: quiz
q: You add a NACL that allows inbound 443 and denies everything else. Clients connect and then hang. Why?
+ The NACL is stateless, so the return packets to the client's ephemeral ports are denied
- Security groups blocked the response even though they are stateful
- 443 is the wrong port for HTTPS
- NAT replaced the NACL
why: Stateless filters do not remember the connection. You must allow the ephemeral return range outbound, or the handshake dies. This is the classic reason not to 'tighten' a NACL from a half-copied example.
:::

::: quiz
q: How should an operator get a shell on a private instance?
+ SSM Session Manager, with an instance role that allows it, and no inbound SSH from the internet
- Security group port 22 from 0.0.0.0/0
- A bastion with a key shared in chat
- The root user SSH key from the account email
why: Session Manager rides the control plane and the instance role. An open SSH port is a standing exposure. A shared key is an identity you cannot revoke per person.
:::

## DNS, the edge, and connecting networks
id: net-edge
stage: build
needs: vpc
minutes: 50
goal: Put Route 53 and CloudFront in front of the right load balancer, and connect private networks with endpoints, peering, or a transit gateway.
source: Amazon Route 53 | https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/Welcome.html
source: Amazon CloudFront | https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Introduction.html
source: Elastic Load Balancing | https://docs.aws.amazon.com/elasticloadbalancing/latest/userguide/what-is-load-balancing.html
source: AWS PrivateLink | https://docs.aws.amazon.com/vpc/latest/privatelink/what-is-privatelink.html
source: AWS Transit Gateway | https://docs.aws.amazon.com/vpc/latest/tgw/what-is-transit-gateway.html

The VPC lesson got a packet from the internet gateway to a task. Real systems put more names in front of that, and more networks beside it. This lesson is those names: Route 53, CloudFront, the choice between an Application Load Balancer and a Network Load Balancer, PrivateLink, and Transit Gateway. None of them replace subnets and security groups. They sit on top of a design that already has them.

Route 53 is authoritative DNS, and it is also health checks and routing policies. A public hosted zone answers the internet for a domain. A private hosted zone answers inside the VPCs you associate. Records have a TTL. A failover you planned in seconds and a TTL of five minutes is a failover in five minutes, plus resolver caches that ignore you. Alias records are how you point the zone apex at an AWS load balancer or CloudFront distribution without a CNAME, which DNS does not allow at the apex. Routing policies are not load balancers. Simple, weighted, latency, failover, geolocation, geoproximity, and multivalue answer different questions about which endpoint's address to hand out. They do not open a connection to a healthy task. If the endpoint is one IP and that task dies, DNS does not notice unless a health check is attached and a second record exists. Use DNS for steering between regions or between stacks. Use a load balancer for steering between tasks.

An Application Load Balancer is layer 7. It understands HTTP and HTTPS, paths, hosts, redirects, and sticky cookies if you insist. It terminates TLS. Targets are instances, IPs, or Lambda. It is the default for a web API in two zones. A Network Load Balancer is layer 4. It forwards TCP or UDP, can pass through the source address, and is the one you pick for non-HTTP protocols or for a static address and very high connection rates. It does not route on URL paths. Putting an NLB in front of an HTTP API because it is "faster" and then being unable to do path rules is a common own-goal. A Gateway Load Balancer is for inserting appliances. You will rarely need it, and you should not confuse it with the other two. Internal load balancers exist for all of these. Not everything faces the internet. Health checks are part of the design. A check against a path that always returns 200 while the dependency is down will keep sending users to a broken task.

CloudFront is the CDN. A distribution has origins, cache behaviors, and a TLS certificate. Cache what is safe to share. Do not cache authenticated responses unless the cache key includes what makes them different, and even then think hard. The origin should be the load balancer or an S3 bucket, not a single instance. Origin access control is how a distribution reads a private S3 bucket without making the bucket public. The old origin access identity is the legacy version of that idea. Prefer origin access control for new buckets. CloudFront can terminate TLS at the edge with a certificate from AWS Certificate Manager in us-east-1, which is a special case people forget: certificates for CloudFront are requested in that region even when the origin is in Zurich. The origin protocol should be HTTPS too. Encryption to the edge and plaintext to the origin is not encryption in transit. Cache invalidations are slow and not a deploy mechanism. Version the asset path instead.

PrivateLink is how you expose a service, or reach an AWS service, by private IP. An interface endpoint is an elastic network interface in your subnet, charged per hour and per gigabyte, with a security group. Gateway endpoints for S3 and DynamoDB are the free-of-hourly-charge route-table kind from the VPC lesson, and they are not interface endpoints. Use interface endpoints when a private subnet must call an AWS API that has no gateway endpoint, or when you publish your own service to another VPC without peering the whole networks. VPC peering is a full route between two VPCs, non-transitive, and allergic to overlapping CIDRs. Transit Gateway is the hub when you have many VPCs and an on-premises network. Peering every pair is a mesh you will not operate. A transit gateway attachment per VPC, route tables on the gateway, and an SCP or a firewall for what may flow, is the grown-up version. It is also a new bill and a new place to black-hole routes. Do not insert it for two VPCs that could peer.

### A worked edge

The invoicing app's users are in Europe. The API is in Zurich, in two zones, behind an internal-facing... no, the browser must reach it, so the load balancer is internet-facing in the public subnets, TLS from AWS Certificate Manager, security group 443 from CloudFront's prefix list if you want to stop people bypassing the CDN, or from the world if you are not ready to maintain that. CloudFront is in front, caching only the static get of invoice logos, passing the API through with a cache policy that does not store authenticated JSON. Route 53 aliases the apex and www to the distribution. A private hosted zone in the VPC names the database so tasks do not use raw addresses. S3 uses a gateway endpoint. Secrets Manager and ECR, if the tasks pull from them, use interface endpoints so NAT is not required for those APIs. There is no second VPC yet, so there is no transit gateway. The day a second account's VPC must call this API privately, you add PrivateLink or peering then, with a ticket, not in the first design.

### Where this breaks

DNS failovers with long TTLs. Health checks against TCP 443 that succeed when the HTTP app returns 500. CloudFront caching a Set-Cookie response. An origin access control left off and the bucket made public "temporarily". Certificate requested in the wrong region for CloudFront. An NLB used for path-based routing it cannot do. An ALB used for a raw TCP database protocol it cannot do. Peering without return routes. A transit gateway with one route table that sends production into the sandbox. Interface endpoints created and the private DNS name not enabled, so the SDK still uses the public endpoint and the NAT path. And overlapping CIDRs discovered at peering time.

### How this is used at work

The domain and the public zone are owned by the platform or the company registrar, not by the app team. Certificate renewal in ACM is automatic if the validation record stays. Application teams own the target group and the health check path. Network teams own transit gateway route tables the way they own WAN routes. A design review asks: what is cached, what is the origin, who can bypass the CDN, and which VPCs are connected. Terraform encodes the records and the distribution. A console click that adds a public bucket policy is the incident.

### Choosing the front door

| Need | Use | Not |
| HTTP routing by path or host | Application Load Balancer | Network Load Balancer |
| TCP or UDP, or preserve source IP | Network Load Balancer | Application Load Balancer |
| Cache and a closer TLS handshake | CloudFront in front of the origin | A second region |
| Private access to an AWS API | Gateway endpoint if one exists, otherwise an interface endpoint | NAT for heavy traffic |
| Many VPCs and an office | Transit Gateway | A full mesh of peering |
| Two VPCs, no overlap | Peering, if you can operate the routes | Transit Gateway on day one |
| Steer users between regions | Route 53 with health checks and a short TTL | A load balancer that spans regions, which it does not |

### You can now

Point a domain at CloudFront or a load balancer with an alias record, and respect TTL. Choose an ALB or an NLB from the protocol, not from habit. Cache only what is safe, and keep S3 private with origin access control. Reach AWS APIs from private subnets with the right kind of endpoint. Connect two VPCs with peering and many VPCs with a transit gateway, and say what overlaps and missing return routes do.

::: quiz
q: You need to route /api to one target group and /static to another, with TLS. Which load balancer?
+ An Application Load Balancer, because it is HTTP-aware
- A Network Load Balancer, because it is always the faster and therefore the right choice
- A transit gateway
- Route 53 weighted records alone, with no load balancer
why: Path routing is a layer-7 feature. An NLB does not look at the URL. DNS can steer between endpoints, and it does not replace a target group inside the region.
:::

::: quiz
q: How should CloudFront read a private S3 bucket?
+ Origin access control, with the bucket policy allowing that distribution and Block Public Access left on
- A public bucket and a long random key
- An access key in the distribution
- A NAT gateway in front of S3
why: Origin access control is the current way for CloudFront to authenticate to S3. Public buckets and embedded keys are the incidents this replaces.
:::

::: card
q: How is a gateway endpoint different from an interface endpoint?
answer: A gateway endpoint is a route-table target for S3 or DynamoDB, with no hourly charge. An interface endpoint is an elastic network interface in your subnet, PrivateLink, billed per hour and per gigabyte, for other services and for services you publish.
:::

::: quiz
q: Two VPCs must talk, and their CIDRs both start at 10.0.0.0/16. What is true?
+ Peering and a transit gateway will not make overlapping addresses routable. One side has to be renumbered
- Transit Gateway translates the overlap automatically
- Security groups fix overlapping CIDRs
- Route 53 geolocation hides the overlap
why: Routing needs unique addresses. No AWS network hub rewrites your overlapping private ranges into a working design. Plan CIDRs before the second VPC.
:::

::: predict lang=python
q: What does this print?
code:
```python
def front(protocol):
    if protocol == 'https-path':
        return 'alb'
    if protocol == 'tcp':
        return 'nlb'
    return 'rethink'
print(front('tcp'))
```
answer:
```text
nlb
```
why: Raw TCP belongs on a Network Load Balancer. HTTP path routing belongs on an Application Load Balancer. The function encodes that split.
:::

::: quiz
q: A Route 53 failover record has a TTL of 30 minutes. The primary region fails. What should you expect?
+ Resolvers can keep handing out the old address until the TTL expires, so failover is not instant
- Every client switches within one second
- The load balancer in the failed region updates DNS for you
- TTL applies only to private hosted zones
why: DNS is cached. Health checks change the answer Route 53 gives. They do not flush the world's resolvers. Short TTLs make failover faster and increase query volume.
:::

::: quiz
q: Where do you request an ACM certificate that CloudFront will use?
+ In us-east-1, even if the origin is in another region
- In the origin's region only
- In every edge location by hand
- Certificates are not required at the edge
why: CloudFront is a global service and it uses public certificates from the us-east-1 ACM home. An origin in Zurich still wants HTTPS, with its own certificate on the load balancer if clients can bypass the distribution.
:::

## Choosing compute
id: compute
stage: build
minutes: 45
goal: Pick EC2, containers, or functions for a workload, and build a web tier that replaces a dead instance.
needs: vpc
source: Amazon EC2: What is EC2 | https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/concepts.html
source: Amazon EC2 Auto Scaling | https://docs.aws.amazon.com/autoscaling/ec2/userguide/what-is-amazon-ec2-auto-scaling.html
source: AWS Lambda: Quotas | https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html
source: AWS: Choosing a container service | https://docs.aws.amazon.com/decision-guides/latest/containers-on-aws-how-to-choose/choosing-aws-container-service.html

Compute is the box that runs your code, and AWS has several boxes because "a server" was never one kind of problem. This lesson is EC2 and the things wrapped around it: images, launch templates, Auto Scaling groups, and the load balancer that stops sending work to a dead instance. Containers, functions, and Kubernetes get their own lessons. The choice among them is still a compute choice, so the map is here, and the depth is there.

An EC2 instance is a virtual machine in one Availability Zone, from an AMI, on a subnet, with a security group and an instance profile. The AMI is a snapshot of a root volume plus a description. You can start from a current Amazon Linux or Ubuntu image and configure it at boot with user data, or you can bake an image in a pipeline. Baking is reproducible. User data that apt-gets from the internet on every boot is a dependency on NAT, on the mirror, and on a script nobody tested this week. The instance store is disk that disappears when the instance stops. EBS is the volume that can survive a stop. If the only copy of the data is on the instance, you do not have a stateless tier, whatever the diagram says.

A launch template is the versioned description of how to start that instance: AMI, type, subnets or a network interface, security groups, the instance profile, and the user data. An Auto Scaling group takes the template and a desired capacity, across the subnets you list, which should be two or more zones. It replaces instances that fail health checks. It does not know whether your application is correct unless the health check is the load balancer's, not merely "the hypervisor says the VM is running". EC2 health and ELB health are different settings. Use the load balancer. Target tracking on CPU or on request count per target is the usual scaling policy. Scaling on a metric that lags the user, or scaling up and down every minute, flaps. Cooldowns and step policies exist for a reason. A minimum of two, in two zones, is the availability story. A minimum of zero is how a dev environment sleeps, and it is also how the first request of the morning is slow.

The load balancer in front is the one from the edge lesson. For HTTP it is an ALB. The Auto Scaling group registers instances into a target group. When you terminate an instance, the load balancer stops using it after the health checks fail, and the group starts another. That is the drill the old compute objective asked for. Connection draining, now deregistration delay, lets in-flight requests finish. A deploy that terminates every instance at once is not a rolling update. Instance refresh and a minimum healthy percent are how the group replaces itself without an outage. Cordon the fact: if the app stores sessions in memory, the new instance is a logout. Sessions belong in a store. The availability lesson says that again because it is the bug everyone writes once.

Purchasing is part of the design. On-Demand is the default, billed per second for many Linux types, no commitment. Savings Plans commit you to a dollar per hour of compute for one or three years, and they are usually the right discount for a steady base. Reserved Instances are the older, more specific commitment. Spot is spare capacity that can be interrupted with a short warning. Use Spot for workers that can stop, and for Auto Scaling groups that are allowed to mix On-Demand base with Spot above it. Do not use Spot for the only database. Compute Optimizer and the actual CloudWatch CPU, not the instance type you guessed in a workshop, are how you right-size. A t-family burstable instance that has exhausted credits looks like an application regression.

Lambda, ECS, and EKS sit on this map so you do not invent a VM for everything. A standard Lambda function's maximum timeout is 15 minutes, which is why a 40-minute transcode is not a standard function. As of 2026, Lambda Managed Instances can run asynchronous invocations and most event-source invocations for up to 90 minutes, while synchronous invocations stay at 15. That is a capacity mode with EC2-shaped pricing, not the default function, and the serverless lesson treats it as a choice rather than as a reason to put every batch job in Lambda. ECS on Fargate and EKS are the container lessons. The default for a small team with a containerized HTTP API remains a managed container service behind a load balancer, not an EC2 box you patched by hand, unless a constraint forces EC2: a GPU shape, a licensed agent, a custom kernel, or a protocol the managed options do not meet.

### A worked web tier

Two public subnets, an ALB, two private subnets, an Auto Scaling group with minimum two and maximum six, launch template with the current AMI, an instance profile that can read one secret and nothing else, user data that only starts the already-baked process. Health check path /healthz, which fails if the database is unreachable, so you do not serve traffic you cannot complete. Target tracking on request count. A deploy uses instance refresh. The nightly batch is not on these instances. It is a separate Spot-capable group or a Fargate task, so a batch spike does not scale the web tier into a bill and a restart. Logs leave the instance. If the instance is the only place logs exist, terminating it is how you delete the evidence.

### Where this breaks

A desired count of one. A health check that always succeeds. An AMI from last year with a CVE you cannot name. User data that fetches secrets and prints them. An instance profile with AdministratorAccess because the app needed S3 once. Spot for a stateful leader. Scaling on average CPU while the bottleneck is a connection pool. A launch template edited in the console and not in Terraform, so the next refresh rolls back to the old image. And a region quota on vCPUs discovered when the scale-out does nothing.

### How this is used at work

The AMI is built in CI and promoted. Terraform owns the template and the group. Humans do not SSH. Session Manager and metrics are the access. A terminated instance is a non-event you practise, not an incident. When it is an incident, the app had state on disk or the minimum size was one. Capacity reservations exist for launches that must succeed in a constrained zone. They are a cost. Use them when a failed launch is worse than the reservation, not by default.

### What runs the process

| Work | Default | Move toward EC2 when |
| HTTP API, container, small team | ECS on Fargate or App Runner, behind an ALB | You need host devices, GPUs, or a specific daemon |
| Short event | Lambda | The job exceeds the timeout of the mode you are actually using |
| Many services, Kubernetes already required | EKS | You do not have that requirement and would be running a cluster for one deployment |
| Steady VM you must configure | EC2 in an Auto Scaling group | The managed service already fits |
| Interruptible batch | Spot or Batch | The job cannot be restarted |

### You can now

Describe an instance as AMI plus subnet plus security group plus role. Put a web tier in an Auto Scaling group across two zones behind a load balancer, and use the load balancer health check. Replace instances without logging everyone out. Choose On-Demand, Savings Plans, and Spot for the shape of the load. Say why a standard Lambda function is the wrong place for a 40-minute job, and where the container lessons take over.

::: quiz
q: Resize every image uploaded to a bucket, a few hundred a day, each in under 5 seconds. Simplest fit?
+ Lambda, triggered by the S3 upload event
- An EC2 instance polling the bucket
- An EKS cluster
- ECS service running 24/7
why: Short, event-driven, low volume: Lambda runs only when an upload happens and costs nothing in between.
:::

::: quiz
q: A video transcoding job takes 40 minutes per file. Why not Lambda?
- Lambda can't read from S3
+ A Lambda invocation can run for at most 15 minutes
- Lambda doesn't support containers
- Lambda can't use more than one CPU
why: 15 minutes is Lambda's hard limit. Use a Fargate task, AWS Batch, or EC2 (Spot is a good fit for interruptible batch jobs).
:::

::: quiz
q: An Auto Scaling group has two instances and the EC2 health check only. The app deadlocks and returns nothing. What happens?
+ The hypervisor still sees a running VM, so the group does not replace it. Use the load balancer health check
- The group replaces both instances within a second
- IAM restarts the process
- A NACL reboots the instance
why: EC2 health is not application health. ELB health probes the path you configured. A check that never fails will keep a dead app in service.
:::

::: card
q: What should be true of a web instance you are willing to terminate?
answer: Nothing you need is only on its disk. Sessions, uploads, and logs live in a store, a bucket, or a log group. The Auto Scaling group can start a replacement from the launch template.
:::

::: predict lang=python
q: What does this print?
code:
```python
def capacity(zones, per_zone):
    return 'ok' if zones >= 2 and per_zone >= 1 else 'single point'
print(capacity(1, 4))
```
answer:
```text
single point
```
why: Four instances in one zone still share one failure domain. Two zones with one each is the minimum shape this model calls ok.
:::

::: quiz
q: A steady base of four web instances runs all year, and a nightly render can be restarted. How do you buy them?
+ A Savings Plan or reserved commitment for the base, and Spot or a restartable fleet for the render
- Spot for the web tier, because it is cheaper
- Reserved Instances for the render only
- Root access keys, because purchasing needs root
why: Commit where the load is smooth. Use interruptible capacity where the work can stop. Spot under the only user-facing tier without an On-Demand base is an outage you chose.
:::

::: quiz
q: A standard Lambda function is invoked synchronously to transcode a 40-minute file. What limit does it hit?
+ The synchronous timeout ceiling of 15 minutes. A longer run needs a different mode or a different service, and it is not the default function
- A limit of one CPU, so the clock is wrong
- A ban on reading from S3
- An SCP that blocks video
why: Standard functions and synchronous Managed Instances invocations stop at 15 minutes. Asynchronous Managed Instances can be configured up to 90 minutes. A 40-minute transcode is still a Fargate, Batch, or EC2 job unless you have deliberately chosen that mode.
:::

## Containers on ECS and Fargate
id: containers-aws
stage: build
needs: compute
minutes: 45
goal: Run a service and a scheduled task on ECS, with separate roles, a real image identity, and private networking.
source: Amazon ECS | https://docs.aws.amazon.com/AmazonECS/latest/developerguide/Welcome.html
source: Amazon ECR | https://docs.aws.amazon.com/AmazonECR/latest/userguide/what-is-ecr.html
source: AWS: Choosing a container service | https://docs.aws.amazon.com/decision-guides/latest/containers-on-aws-how-to-choose/choosing-aws-container-service.html

ECS is the AWS scheduler for containers. You give it a task definition, which is a list of containers, their images, CPU and memory, ports, environment, and the log driver. You give it a cluster, which is a place to run tasks, on Fargate or on EC2 instances you manage. A service keeps a desired count of tasks running, behind a load balancer if they serve traffic. That is the whole product in one paragraph, and the rest is the places people mix it up with EKS or with "just Docker on one VM".

Fargate is capacity you do not patch. You name CPU and memory, the task runs in a zone you allowed, and you pay for the time it runs. There is no instance to SSH to, which is the point. ECS on EC2 is the other capacity provider: a cheaper or more specialized machine, an AMI you patch, and bin-packing you are involved in. Use Fargate unless you need GPUs, persistent agents, Windows quirks, or a cost model you have measured and that EC2 wins. App Runner is a narrower path on top of similar ideas: give it an image or a repository and it serves HTTPS. It is a good fit when the network and sidecar needs are boring. It is a bad fit when you need a private data subnet story you control in detail. The compute lesson's default stands: a small team's web API is a service on Fargate behind an ALB.

The image comes from a registry. ECR is that registry in your account. Repositories are regional. Images are tags pointing at digests. Deploy the digest, or a tag your pipeline moves only by a promotion you trust, not latest. latest is how Friday's build becomes Monday's outage without a diff. Scan images. Do not grant the world pull. The task's execution role is what the ECS agent uses to pull the image and to create the log stream. The task role is what your container's code uses to call AWS. They are two roles. People attach the application policy to the execution role and then wonder why a sidecar can read the database secret, or they attach the pull permissions to the task role and the pull fails. On Fargate, the execution role is not the pod execution role from EKS. Names collide. Read the trust. The execution role trusts ecs-tasks.amazonaws.com.

Networking is awsvpc mode for Fargate: the task gets its own elastic network interface and its own security group, in the subnets you set. A service in private subnets, an ALB in public subnets, the database security group allowing the task's group, is the VPC lesson again. The task must reach ECR to pull, unless you use interface endpoints. NAT plus large images is the bill. Service discovery can register tasks in Cloud Map or behind the load balancer. Do not do both and forget which one clients use. Scheduled tasks are the nightly job: EventBridge triggers RunTask, the task exits, you do not pay for a service that sleeps. A cron inside the container, in a service of three tasks, runs three times or zero times.

Logs default to the awslogs driver into CloudWatch Logs. The log group needs a retention. Infinite retention of debug JSON is a storage product you did not mean to launch. A task that logs the secret it just fetched is an IAM problem and a logging problem.

### A worked service

The invoicing API image is built in CI, pushed to ECR in eu-central-2, tagged with the git SHA. The task definition names that SHA, 0.5 vCPU and 1 GB, a container port 8000, the execution role for ECR and logs, the task role for the invoice prefix and the one secret. The service desires two tasks, minimum healthy 100 percent during deploy so the new task is healthy before the old one stops, in private subnets in two zones. The ALB target group health check is /healthz. Deploys are a new task definition revision, not a restart of the old one. The reminder job is a separate task definition on a schedule, not a thread in the API. If the API scales to four tasks, the reminder still runs once.

### Where this breaks

latest. One task, so a deploy or a zone failure is an outage. A health check of /. A task role with s3:*. Secrets in the task definition's environment in plaintext in the console and in state. No retention on logs. A service in public subnets with a public IP because the NAT endpoint was annoying. Pulling from Docker Hub in production, which will rate-limit you and which you do not control. And an EC2 capacity provider with a full disk of images, so placements fail with an error that looks like IAM.

### How this is used at work

The pipeline builds, scans, signs if you are that far along, and pushes. Terraform or the pipeline registers the task definition and updates the service. Humans do not edit the revision in the console. Roll back by pointing the service at the previous revision, which is still in ECR because you did not delete digests on the same day. EKS is the next lesson, and it is a different control plane. Do not run ECS and EKS for the same app because two teams read two blog posts.

### ECS or something else

| Situation | Choose |
| One to a few HTTP services, AWS is the platform | ECS on Fargate |
| Batch or a nightly container | ECS RunTask, or Batch |
| You already standardized on Kubernetes | EKS, not a second scheduler |
| The simplest HTTPS container and few network needs | App Runner |
| A daemon, a GPU, or a host you must enter | ECS on EC2, or EC2 without ECS if there is no scheduler left to justify |

### What the agent is doing

When a service scales from two tasks to four, ECS asks the capacity provider for room, places each task in a subnet that still has addresses, attaches the security group, pulls the image with the execution role, and starts the container with the task role's credentials available to the SDK. If any of those steps fail, the task stops and the service events list the reason. Read the events before you change the policy at random. A CannotPullContainer error is network or execution role. An AccessDenied from your own code is the task role. A failed ELB health check is the app or the security group on the task port, including the health check port. These strings are the debugging loop. The Kubernetes control plane hides a similar loop behind different words. On ECS the loop is short, and ignoring it is how a task definition gets another star added to the policy.

Fargate prices by requested CPU and memory for the life of the task, not by the utilization inside it. A task sized for a peak you never hit is a quiet bill. A task sized too small is an OOM kill that looks like a crash loop. Measure. ECS service quotas, the number of tasks per service, and the ENI limits of the underlying capacity are real. A design that assumes infinite tasks in one small subnet will fail at the address plan from the VPC lesson, not at the scheduler's marketing page.

### You can now

Read a task definition and point at the image, the CPU, the two roles, and the log group. Run a service across two zones behind a load balancer, and a scheduled task that is not inside the service. Deploy by digest. Explain why the execution role and the task role are different. Keep private tasks private and give them a way to pull images that is not an accident.

::: quiz
q: Which role should the application code use to read a secret?
+ The task role. The execution role is for the ECS agent to pull the image and write logs
- The execution role, because it runs first
- The root user
- The ALB's service-linked role
why: Two roles, two trusts, two policies. Code that calls AWS uses the task role. Mixing them either breaks the pull or hands the agent your data permissions.
:::

::: quiz
q: How should a production deploy name the image?
+ By the digest or an immutable tag your pipeline promoted, not latest
- latest, so the service always moves forward
- The laptop's local image name
- A public Docker Hub tag you do not own
why: latest moves under you. An immutable tag or a digest is a revision you can roll back to. A registry you do not control can disappear or change.
:::

::: card
q: What does an ECS service do that a single RunTask does not?
answer: It keeps a desired count of tasks running, replaces failed ones, and can register them with a load balancer. RunTask starts a task that exits. Use RunTask for a job, a service for a process that should stay up.
:::

::: predict lang=python
q: What does this print?
code:
```python
def runs(kind, tasks):
    if kind == 'cron-in-service':
        return tasks
    if kind == 'scheduled-task':
        return 1
    return 0
print(runs('cron-in-service', 3))
```
answer:
```text
3
```
why: A cron inside each task of a three-task service fires three times. A scheduled RunTask fires once. That is why the reminder job is not a loop in the API process.
:::

::: quiz
q: Fargate tasks in private subnets cannot pull from ECR. The security groups allow the registry port. What is still missing?
+ A path to ECR: NAT, or interface endpoints for ECR and, usually, S3 for the image layers
- A public IP on the database
- An internet gateway route on the data subnet
- A bigger task CPU
why: Private means no inbound internet, and it also means no outbound until you add NAT or endpoints. Image layers often come from S3, so the ECR endpoint alone can still fail the pull.
:::

::: quiz
q: During a deploy you want the old tasks to stay until the new ones are healthy. What do you set?
+ A minimum healthy percent that does not let the service drop the old tasks first, and a health check that can fail
- Desired count zero, then desired count two
- latest, so ECS orders the tasks
- A NACL that blocks the old tasks
why: ECS deployment percentages control the overlap. A health check that never fails will bless a bad revision. Dropping to zero is an outage.
:::

## EKS and Pod Identity
id: eks-aws
stage: build
needs: containers-aws
minutes: 40
goal: Decide when a cluster is earned, and give each pod an IAM role with Pod Identity or IRSA as the compute requires.
source: Amazon EKS: Pod Identity | https://docs.aws.amazon.com/eks/latest/userguide/pod-identities.html
source: Amazon EKS: IAM roles for service accounts | https://docs.aws.amazon.com/eks/latest/userguide/iam-roles-for-service-accounts.html
source: Amazon EKS: Pod execution role | https://docs.aws.amazon.com/eks/latest/userguide/pod-execution-role.html

EKS is Kubernetes with an AWS-managed control plane. You still write Deployments, Services, and probes. The Kubernetes module is that knowledge. This lesson is only the AWS edge of it: what the cluster is in a VPC, how pods get IAM credentials, and when not to create a cluster at all.

The control plane is regional. Worker capacity is zonal: node groups or Fargate profiles in the subnets you choose. A cluster in one set of private subnets, and a load balancer in public subnets, is the same drawing as ECS. The AWS VPC CNI gives pods IP addresses from the subnet. That is why EKS subnets run out of addresses sooner than a diagram of "two nodes" suggests. Plan the CIDR for pod density. Security groups can apply to pods, not only to nodes, which is how you keep the three-tier idea when many pods share a node.

IAM is the part people copy wrong. There are at least three roles in a grown cluster, and they are not interchangeable. The cluster role is what the control plane uses. The node role is what the kubelet on an EC2 node uses to join and to pull what a node must pull. The application role is what your container should use. On EC2 nodes, the current way to give a pod its own role is EKS Pod Identity. You associate a cluster, a namespace, and a service account with an IAM role in the EKS API. You do not annotate the service account with a role ARN. The Pod Identity agent runs as a DaemonSet on Linux EC2 nodes and serves credentials on a link-local address. The role's trust policy allows pods.eks.amazonaws.com to call sts:AssumeRole and sts:TagSession. Session tags can restrict which cluster, namespace, and service account may use the role. Temporary credentials are assumed by EKS and handed to the SDK. There is no OIDC provider to register for this path.

Pod Identity does not apply to pods on Fargate, and it does not apply to Windows nodes. The agent is not there. Fargate pods that need AWS APIs use IAM roles for service accounts, IRSA. IRSA is the older mechanism and it is still the right one on Fargate: an OIDC provider for the cluster, a trust policy that matches the token's subject, and an annotation on the service account. Do not describe IRSA as deprecated for Fargate. Do not describe Pod Identity as optional decoration on Fargate. A mixed cluster uses Pod Identity for Linux EC2 workloads and IRSA for Fargate workloads. The Fargate pod execution role is a fourth role, used by the Fargate platform to pull images and write logs. The container cannot assume it. Giving the application the execution role is the same class of mistake as using the ECS execution role as the task role.

EKS Auto Mode and managed node groups reduce the amount of AMI work. They do not remove Kubernetes, and they do not remove the hourly control plane fee. Add-ons, the VPC CNI, CoreDNS, and the kube-proxy equivalents, are part of the cluster's health. An upgrade of the control plane that the nodes cannot follow is a stuck cluster. The Kubernetes lessons on probes, requests, and PodDisruptionBudgets apply unchanged. AWS will not invent them for you.

### When the cluster is the wrong tool

One API and a worker do not need a control plane. ECS on Fargate is the smaller moving part. EKS earns its fee when you already operate Kubernetes, when you need its scheduling, or when a product you bought is a Helm chart and not a container. "We might want portability" is not a design. A cluster you cannot upgrade is less portable than a Fargate service. If you do run EKS, Pod Identity is the default for Linux EC2 application roles in this path, because it avoids a per-cluster OIDC provider and lets one role trust many clusters through conditions instead of a new trust edit every time.

### A worked identity

Two deployments, billing and invoices, in namespace prod. Two service accounts. Two IAM roles. The association for invoices allows s3:GetObject on one prefix. The association for billing allows dynamodb:GetItem on one table. Neither role trusts the node. A test is an AWS call from each pod: invoices can read its prefix and cannot read the table, and the reverse. If both can do both, they are using the node role, because the SDK never saw Pod Identity. Check the agent, the association, the trust, and the SDK version. A deny in the application is a success of the test, not a failure of the cluster.

### Where this breaks

Annotating a service account and believing that is Pod Identity. It is the IRSA gesture. Forgetting sts:TagSession in the trust, so the association exists and AssumeRole fails. Running the workload on Fargate and debugging the agent that is not scheduled there. A node role with broad S3 access, which every pod can use if it can reach the instance metadata service. IMDSv2 and a hop limit of one are how you make that harder. A subnet too small for the CNI. An OIDC provider left behind for a cluster that was deleted, which is a confused deputy waiting for a reused URL if you are careless. And a cluster in the management account, which the account lesson already forbade.

### How this is used at work

Platform runs few clusters, not one per app. App teams get a namespace, a quota, and a pipeline that can create a Pod Identity association for their role. Terraform owns the cluster and the associations. Kubernetes manifests own the Deployment. The role trust is reviewed as carefully as the RBAC. Audit is CloudTrail on the AWS API and the Kubernetes audit log for who deleted a Deployment. They are not the same log.

### Which identity

| Workload | Use | Do not use |
| Pod on Linux EC2 | EKS Pod Identity | The node role, a key in a Secret |
| Pod on Fargate | IRSA | Pod Identity, the pod execution role |
| The node kubelet | The node role | An application policy attached "so pods work" |
| Fargate platform pull and logs | The pod execution role | The application's IRSA role |
| One simple service | ECS, and no cluster | EKS for the logo |

Upgrades are part of the cost of the control plane, not a project you do if nothing is on fire. AWS announces a Kubernetes version and a calendar. Nodes, add-ons, and the Pod Identity agent have to be compatible with the version you are moving to. A cluster pinned to a version that is leaving support is a security finding and a future outage, because you cannot stay there. Practise the upgrade on a non-production cluster that runs the same add-ons. The application manifests from the Kubernetes module, requests and limits included, are what make the upgrade boring. A cluster with no requests and a single replica is how an upgrade becomes the incident.

### You can now

Say what EKS manages and what is still Kubernetes. Give a Linux EC2 pod its own role with Pod Identity, including the trust for AssumeRole and TagSession. Give a Fargate pod IRSA instead, and keep the execution role away from the container. Refuse a cluster that does not earn the control plane. Prove two pods do not share permissions.

::: quiz
q: A pod on a Linux EC2 node should call S3 as its own role. What do you configure?
+ An EKS Pod Identity association for its service account, and a trust policy that allows pods.eks.amazonaws.com to assume the role and tag the session
- An annotation only, which is the IRSA signal, and no association
- The node instance profile, shared by every pod
- A long-lived key in a Kubernetes Secret
why: Pod Identity is an EKS API association, not a service-account annotation. The trust has to allow both AssumeRole and TagSession. The node role is the blast radius you are trying to leave.
:::

::: quiz
q: The same pod spec is moved to Fargate and the AWS SDK finds no credentials. What changed?
+ Pod Identity does not run on Fargate. That pod needs IRSA. The Pod Identity agent is only on Linux EC2 nodes
- Fargate does not allow any IAM
- The pod should use the pod execution role for application calls
- IAM roles are regional and Fargate is not in a region
why: AWS documents Pod Identity as unsupported on Fargate and on Windows nodes. IRSA remains the application identity there. The execution role is for the platform.
:::

::: card
q: What is the Fargate pod execution role for?
answer: The permissions the Fargate platform needs, such as pulling from ECR and writing logs. Containers in the pod cannot assume it. Application calls need IRSA.
:::

::: predict lang=python
q: What does this print?
code:
```python
def identity(compute):
    if compute == 'ec2-linux':
        return 'pod-identity'
    if compute == 'fargate':
        return 'irsa'
    return 'stop'
print(identity('fargate'))
```
answer:
```text
irsa
```
why: The model picks IRSA for Fargate and Pod Identity for Linux EC2. Anything else is out of scope for this function.
:::

::: quiz
q: Both pods on a node can read a bucket that only one role allows. What is the likely path?
+ They are using the node role through the metadata service, not their Pod Identity roles
- S3 ignores IAM inside a VPC
- Pod Identity always shares the first role on the node
- A security group cannot separate pods, so IAM cannot either
why: If the SDK falls back to the node, every pod inherits it. Check the association, the agent, and IMDSv2 hop limits. Pod security groups do not fix a shared role.
:::

::: quiz
q: When is ECS the better AWS compute than EKS?
+ When you have a small number of services and no need for the Kubernetes control plane you would now have to upgrade
- When you need a pod to assume a role, because ECS cannot
- When the workload is on Fargate, because Fargate is EKS-only
- When you want to avoid IAM
why: ECS task roles already solve identity for containers. EKS is justified by Kubernetes itself, not by the existence of Fargate or IAM.
:::

## Serverless and events
id: serverless
stage: build
needs: compute, iam-deep
minutes: 50
goal: Wire Lambda, API Gateway, SQS, SNS, EventBridge, and Step Functions, and survive at-least-once delivery.
source: AWS Lambda | https://docs.aws.amazon.com/lambda/latest/dg/welcome.html
source: AWS Lambda quotas | https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html
source: Amazon API Gateway | https://docs.aws.amazon.com/apigateway/latest/developerguide/welcome.html
source: Amazon SQS | https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/welcome.html
source: Amazon EventBridge | https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-what-is.html
source: AWS Step Functions | https://docs.aws.amazon.com/step-functions/latest/dg/welcome.html

Serverless here means you do not run the server, not that there is no server and not that the bill is zero. Lambda runs a function. API Gateway or a function URL accepts HTTP. SQS stores work. SNS fans a message out. EventBridge routes events. Step Functions remembers where a long workflow got to. The skill is knowing which of those is the contract you need, and where retries will duplicate a side effect.

A Lambda function is a zip or an image, a handler, a memory size, a timeout, and an execution role. Memory sets the CPU. A function that is slow at 128 MB is often fine at a larger size and cheaper because it ends sooner. The default timeout is three seconds. The maximum for a standard function is 15 minutes. Synchronous invocations, including an API call waiting for the answer, stay at 15 minutes even on Lambda Managed Instances. Asynchronous invocations and most event-source mappings on Managed Instances can be configured up to 90 minutes as of 2026. Init is still capped. This is not a reason to put a 40-minute transcode in a function you invoke from a browser. It is a reason to read which mode you are in before you quote the limit. Concurrency is a quota. Reserved concurrency protects a function and can also throttle it. Provisioned concurrency keeps environments warm, for a fee, when cold starts hurt a user-facing tail latency.

The execution role is the function's identity. The resource policy on the function is who may invoke it. An S3 bucket or an API Gateway needs permission to invoke, which is not the same as the function's permission to read the bucket. People edit one and not the other. Environment variables are not a secret store. Use Secrets Manager or Parameter Store, and cache the value for the lifetime of the environment if you must, knowing that environments are reused. A cold start is a new environment. A warm start is your global variables still there, including anything you should not have cached forever.

API Gateway comes in two flavors you will actually choose between. An HTTP API is cheaper and enough for a proxy to Lambda or to a private integration. A REST API has more features, including some older authorization and usage-plan shapes, and costs more. Do not pick REST because the name sounds more serious. In front of the internet, put authorization on the API, not in a comment. IAM authorization, a JWT authorizer from Cognito or another issuer, or a request off to your own code. A function URL is the smaller door: one function, HTTPS, fewer knobs. It is fine for an internal webhook you also protect. It is a poor substitute for a gateway when you need routes, throttles, and several functions.

SQS is the buffer. Producers send a message. Consumers pull it. The message stays invisible for the visibility timeout while a consumer works. If the consumer dies, the message reappears. If it keeps failing, a redrive policy sends it to a dead-letter queue. Standard queues are at-least-once and best-effort order. FIFO queues add order in a group and exactly-once processing within the deduplication window, and they cost more and throttle differently. A Lambda event source mapping polls the queue and invokes the function. If the function throws, the message returns. If the function writes the invoice and then throws, you get a second invoice. The consumer must be idempotent: a key in DynamoDB, a conditional write, something that makes the second delivery a no-op. The visibility timeout must be longer than the work, or another consumer starts early.

SNS is push fan-out. One publish, many subscribers: SQS queues, Lambda, email, HTTP. Use it when several independent systems must see the same fact. Use SQS when you need a backlog and retries for one worker. The usual pattern is SNS to several SQS queues so each subscriber has its own buffer and its own dead-letter queue. EventBridge is the bus for events with a detail type and a pattern. It is how you say "on Object Created in this bucket, start this rule" without wiring every producer to every consumer. Scheduled rules and EventBridge Scheduler start work on a clock. A cron inside a container is the thing this replaces. Step Functions is the workflow when the steps have order, waits, and human approval, or when each step is a service integration that should not be a 400-line function. Standard workflows can run for a long time and are billed by transition. Express workflows are for high volume and short life. Do not use a Step Function as a queue. Do not use a queue as a workflow with fifteen branches. Retries inside the state machine need the same idempotency as retries from the queue.

### A worked upload

A client uploads a PDF through an HTTP API that returns as soon as the object is in S3 and a message is on a queue. The API's Lambda checks the caller, writes the object with a key that includes an idempotency token, and sends one message. A second Lambda, scaled by the queue, generates a thumbnail and writes a row. Failures go to a dead-letter queue that is alarmed, not ignored. A nightly Step Function, started by Scheduler, reads the day's rows and sends reminders. EventBridge also carries the "invoice finalized" event to a bus the analytics account subscribes to. Nothing in the request path sends email. The user did not wait for the thumbnail. The spike becomes queue age, which is a metric, not an outage.

### Where this breaks

Timeouts shorter than the dependency. Visibility timeouts shorter than the function. Dead-letter queues nobody reads. At-least-once treated as exactly-once. FIFO where standard would do, or the reverse when order mattered. A REST API for a single proxy. Secrets in environment variables in the template, which is the source repository. Infinite retries on a poison message. Step Functions that call back into themselves until the bill arrives. A reserved concurrency of one on the only consumer, which is a queue that never drains. And API Gateway logging left off, so the 500 has no request id.

### How this is used at work

The function is small, the workflow is a state machine, the buffer is a queue, the fact is an event. Terraform owns the wiring. The code owns the handler. Dashboards show iterator age, throttles, and dead-letter depth before they show CPU, because there is no CPU to SSH to. A poison message is a ticket with the body, redacted, not a retry button held down. Idempotency keys are part of the API review the way transactions are part of a database review.

### Which primitive

| You need | Use |
| A short computation on an event | Lambda |
| HTTP routes and throttles | API Gateway, HTTP API unless you need a REST-only feature |
| A backlog and retries for one consumer | SQS, with a dead-letter queue |
| Many consumers of one fact | SNS, usually into SQS queues |
| Match on event content, or a schedule | EventBridge |
| Ordered steps, waits, or compensations | Step Functions |
| A 40-minute synchronous call from a user | Not a standard Lambda. A task, a job, or an async mode you chose on purpose |

### You can now

Set a function's role, timeout, and memory for the work, and quote the 15-minute synchronous limit without forgetting the 2026 async exception. Put an HTTP API in front of a function. Decouple a spike with SQS and a dead-letter queue. Fan out with SNS or route with EventBridge. Put a multi-step process in Step Functions. Make the consumer idempotent because delivery is at least once.

::: quiz
q: An SQS consumer writes an invoice and then throws. The message returns. What must be true?
+ The write is idempotent, so the second delivery does not create a second invoice
- SQS standard queues deliver exactly once, so this cannot happen
- The visibility timeout deletes the invoice
- Lambda refuses to retry
why: Standard queues and event-source mappings are at-least-once. A side effect that is not idempotent is duplicated by the retry that availability requires.
:::

::: quiz
q: You have one event and three independent services that each need their own retry buffer. What is the shape?
+ SNS, or EventBridge, to three SQS queues, each with its own consumer and dead-letter queue
- One SQS queue with three unrelated pollers deleting each other's messages
- A single Lambda that calls all three and throws if any fails
- A longer visibility timeout
why: Fan-out gives each subscriber a copy. A shared queue makes the subscribers compete. One function that calls everyone couples their failures.
:::

::: card
q: What is a dead-letter queue for?
answer: Messages that failed too many times. They wait there for a person or a tool to inspect. They are not a second retry loop you forget about, and an alarm on the depth is part of the design.
:::

::: predict lang=python
q: What does this print?
code:
```python
def deliver(kind):
    if kind == 'standard':
        return 'at-least-once'
    if kind == 'fifo-deduped':
        return 'deduped-in-window'
    return 'unknown'
print(deliver('standard'))
```
answer:
```text
at-least-once
```
why: Standard SQS does not promise exactly-once. FIFO with deduplication changes the contract inside a window. The consumer still has to tolerate a retry at the edges.
:::

::: quiz
q: A browser waits on a Lambda while a video transcodes for 40 minutes. What is wrong?
+ A synchronous invocation still times out at 15 minutes. The browser should enqueue the work, not wait on the function
- Lambda cannot be invoked from API Gateway
- Videos must be stored in DynamoDB
- Managed Instances removed every timeout in 2026
why: The 90-minute ceiling is for asynchronous and most event-source invocations on Managed Instances, not for a synchronous API call. The user-facing pattern is a queue or a task, and a status they can poll.
:::

::: quiz
q: Where do you put a database password the function needs?
+ In Secrets Manager or Parameter Store, read with the execution role. Not in the function's environment in the repository
- In the API Gateway route path
- In the SQS message, logged on failure
- In the dead-letter queue name
why: Environment variables end up in templates and consoles. A secret store plus a role is the path that rotates. A password in a queue message is a password in a log.
:::

::: quiz
q: When is Step Functions the better home than a larger Lambda?
+ When the work is an ordered set of steps with waits, retries, or a trail of what already succeeded
- When you need a queue
- When the whole job is one 20-millisecond calculation
- When you want to avoid IAM
why: The state machine records progress and retries a step. A queue buffers work. A tiny function does not need a workflow product around it.
:::

## Storage and databases
id: storage
stage: build
minutes: 45
goal: Choose object, block, or file storage, and keep S3 private, versioned, and restorable.
needs: compute
source: Amazon S3 | https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html
source: Amazon S3 storage classes | https://docs.aws.amazon.com/AmazonS3/latest/userguide/storage-class-intro.html
source: Amazon EBS | https://docs.aws.amazon.com/ebs/latest/userguide/what-is-amazon-ebs.html
source: Amazon EFS | https://docs.aws.amazon.com/efs/latest/ug/whatisefs.html
source: Amazon RDS Multi-AZ | https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.html

Storage is a decision about access, durability, and what happens when you delete the wrong thing. The services look like a menu. They are three different shapes plus the databases the next lessons cover. Object storage is S3: an API, a key, and a blob, shared by anything that can sign a request. Block storage is EBS: a disk attached to one instance in one Availability Zone, which looks like a local volume and dies with that zone if you have no snapshot. File storage is EFS: a network filesystem many Linux clients mount, billed by what you store, with its own performance modes. Picking EBS because you wanted a shared folder, or EFS because you wanted a database, is the usual mistake. A database is not a disk. RDS, Aurora, DynamoDB, and ElastiCache are the databases lesson. This lesson still has to say enough that the Multi-AZ and presigned-URL questions have a home.

S3 stores objects in a bucket in a region. The name is globally unique. Durability of objects across AZs in that region is the headline number AWS publishes, eleven nines for the standard class, and it is not a backup. It means AWS does not lose a disk. It does not mean you can undelete a key your script removed. Versioning keeps old versions, including delete markers. Lifecycle rules move objects to cheaper classes or expire them. The classes you should be able to name are Standard, Intelligent-Tiering, Standard-IA, One Zone-IA, Glacier Instant Retrieval, Glacier Flexible Retrieval, and Glacier Deep Archive, plus Express One Zone when you have measured a latency need in one zone. IA and Glacier have minimum durations and retrieval costs. A lifecycle that moves yesterday's logs to Deep Archive and then you query them every hour is more expensive than Standard. Intelligent-Tiering is the default for data whose access pattern you will not predict, for a small monitoring fee.

Block Public Access should stay on. New buckets have it on. A bucket policy that grants Principal star is still something you can write, and Block Public Access is how the account refuses to honor it. Share an object with a presigned URL that expires, after your API has decided the caller may see it. Do not use an unguessable key as a password. Keys end up in logs and referrers. Encryption at rest is on by default with SSE-S3. Use a customer managed KMS key when you need to control who can decrypt, and remember the KMS key policy is a second door. Replication to another region is a feature for residency or for a second copy you will actually fail over to, not a feeling of safety. Cross-region replication of a bucket you have never restored is a bill.

EBS volumes are zonal. A snapshot is stored in S3, regionally, and is how you start a volume in another zone. Types are a performance choice: gp3 is the general default, io2 when you need sustained IOPS you are willing to pay for, and the older types still exist in tutorials. Unattached volumes and old snapshots are the quiet bill. EFS is for shared files: uploads that several tasks must see, a home directory, a CMS. It is not faster than S3 for a blob you could have addressed by key, and it is not a substitute for a transaction. Mount targets in each zone, security groups on the mount, and a backup policy, because a shared filesystem is one logical thing to corrupt.

RDS in one paragraph, so the exercise makes sense, with the real treatment later. Multi-AZ keeps a synchronous standby in another zone and fails over. It is availability, and the standby is not a read replica you query, in the classic single-standby deployment. Read replicas are asynchronous and exist to scale reads or to be promoted. Automated backups give you point-in-time restore within the retention window. None of that is versioning on S3. They solve different losses.

### A worked bucket

Invoices live in acme-invoices-ch in eu-central-2. Block Public Access is on. Versioning is on. A lifecycle moves objects under tmp/ to expire in seven days, and it does not touch invoices/. The API role can get and put under invoices/ and cannot change the bucket policy. Users download through a presigned URL that lasts five minutes. A customer managed key encrypts the invoices prefix, and the key policy allows the role and the security account's admin, not the world. Access logs or CloudTrail data events go to a different account so the person who can delete invoices cannot also delete the record of having done it. That last split is the account lesson applied to storage.

### Where this breaks

Public buckets. Presigned URLs with a week of life pasted into tickets. Versioning off, then a bad sync. Lifecycle that expires the only copy. Glacier retrieval time assumed to be instant. EBS in one zone called highly available. Snapshots never copied and never restored. EFS as a database. SSE-S3 when the requirement was "we can disable decryption for a departed vendor", which needs a key you control. And a bucket policy that denies everything except a role you are about to delete.

### How this is used at work

Objects are the integration bus for files. Terraform owns the bucket and forbids public ACLs. The application owns the key prefix. Data lakes and analytics read from a replica or from a prefix, not from the live invoice prefix with a broad role. Restores are practised. A backup you have not restored is a hypothesis, which is the next lesson.

### Which store

| Shape | Service | Survives |
| A key and a blob, many writers via API | S3 | AZ loss inside the region, not your delete, unless versioning or a replica |
| A disk for one instance | EBS | A stop, if it is EBS. Not an AZ loss, until you snapshot and recreate |
| A shared POSIX tree | EFS | AZ loss if you chose the standard class, not an application bug that corrupts the tree |
| Transactions and queries | RDS, Aurora, DynamoDB | The databases lesson, not a bucket |

### Reading a lifecycle before you attach it

Walk the rule against a real key. An object at invoices/2026/04/100.pdf should match no expire action. An object at tmp/upload-9 should expire. A noncurrent version of an invoice should still be there after the days you promised the customer, and a noncurrent version of a tmp object can go. If one rule uses a prefix and another uses a tag, an object with both matches the rule you did not reread. Filters are easy to union by accident. The storage class transition is a one-way cost change for a while: IA classes have minimum storage days, so a rule that transitions after one day and a delete after ten days can bill the minimum anyway. Write the rule in a table next to three example keys before you put it in Terraform. The same habit applies to bucket policies. Read the principal, the action, and the prefix against the role the app uses and against a role it should not be.

S3 Object Lock, in governance or compliance mode, is the stronger version of a vault lock for objects that must not be deleted or overwritten for a retention period. It is the right tool for a regulatory archive. It is the wrong tool for a bucket you are still redesigning, because compliance mode will not make an exception for your mistake. Choose it when the retention is a requirement, and test governance mode first.


### You can now

Choose object, block, or file storage and say what each does not do. Keep a bucket private, versioned, and lifecycle-managed. Hand out a short-lived presigned URL after an authorization check. Explain Multi-AZ versus a read replica well enough to pick one. Point encryption choices at KMS when a managed key is not enough control.

::: quiz
q: You need a database standby that takes over automatically if an AZ fails. Which RDS feature?
+ Multi-AZ deployment
- A read replica in the same AZ
- Automated backups
- A bigger instance class
why: Multi-AZ keeps a synchronous standby in another AZ and fails over automatically. Read replicas are asynchronous and meant for scaling reads.
:::

::: quiz
q: Users upload private documents that other users may view only if allowed. How do you serve a document?
- Make the bucket public and use unguessable keys
+ Check permission in your API, then return a short-lived presigned URL for that object
- Copy the file into the database
- Give every user an IAM user
why: The bucket stays private. Your app decides who may see what and hands out a URL that works for a few minutes only.
:::

::: card
q: S3, EBS and EFS: one-line difference?
answer: S3 stores objects over an HTTP API, unlimited and shared by anything. EBS is a block disk for one EC2 instance in one AZ. EFS is a network filesystem many instances or containers mount at once.
:::

::: quiz
q: Versioning is off and a lifecycle rule expires objects after one day. A bad job overwrites an invoice. What can you get back?
+ Nothing from S3 itself. Versioning would have kept the old bytes. A separate backup might, if one exists
- The eleven-nines durability promise restores the overwrite
- Multi-AZ keeps the previous object
- A presigned URL undeletes it
why: Durability is not versioning. An overwrite or a delete is your action, stored durably. Versioning or a backup you planned is the undo.
:::

::: card
q: EBS, EFS, and S3: which one is a disk for a single instance in one zone?
answer: EBS. S3 is an object API shared by any caller you allow. EFS is a filesystem many clients mount. A snapshot is what lets you recreate an EBS volume in another zone.
:::

::: predict lang=python
q: What does this print?
code:
```python
def share(store):
    return {'s3':'presign','public-bucket':'no','efs':'mount'}[store]
print(share('s3'))
```
answer:
```text
presign
```
why: A private object is shared with a presigned URL after your check. A public bucket is the wrong door. EFS is a mount, not a URL.
:::

::: quiz
q: Which S3 class is the wrong place for logs you query every hour?
+ Glacier Deep Archive. Retrieval is slow and has a cost model for rare access, not for hourly reads
- S3 Standard
- Intelligent-Tiering, if you accept its monitoring fee
- The Standard class in the same region
why: Archive classes are for data you rarely read. A lifecycle that archives hot data makes every query an expensive retrieval.
:::

## Backups and restore
id: backup
stage: build
needs: storage
minutes: 40
goal: Meet an RPO with a copy the application cannot delete, and prove it by restoring.
source: AWS Backup | https://docs.aws.amazon.com/aws-backup/latest/devguide/whatisbackup.html
source: Amazon RDS: Backup | https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithAutomatedBackups.html

Durability is not a backup. S3 can keep an object across disks and still obey a delete. RDS can fail over to a standby that has the same dropped table, because the standby is synchronous. A backup is a copy that is old enough, or isolated enough, that the mistake and the attacker did not reach it. This lesson is that copy: snapshots, AWS Backup, retention, and the restore you have actually done. The disaster-recovery lesson is how far you fail over and how fast. You cannot fail over to a backup you have not defined.

A recovery point objective is how much data you can lose, measured in time. A nightly snapshot is up to a day. A continuous backup or a point-in-time log is minutes. A recovery time objective is how long the restore may take, and it includes finding the right snapshot, having permission to use it, and having a place to put it. People buy a five-minute RPO and then store the only backup in the same account the application admin can empty. The RPO was never five minutes on the day of the incident. It was "however long until we notice we have no copy".

AWS Backup is the control plane that takes backup plans across services: EBS, RDS, Aurora, EFS, DynamoDB, S3, and others that the console lists and that you should check rather than memorize as eternal. A plan has a schedule, a retention, and a vault. The vault can be locked so that even an admin cannot delete a recovery point early. A vault lock is how you get a copy that survives the credentials that were stolen, which is the threat versioning does not always cover, because the stolen role can write a lifecycle that expires versions. A locked vault in another account is stronger than versioning in the same account. It is also slower to change when you genuinely need to delete data for a legal reason. Write that process down before you lock the vault and discover the process is "wait".

RDS automated backups are point-in-time within the retention window, in the region, and they disappear if you delete the instance without a final snapshot. That checkbox is a data-loss incident. Aurora works the same way with its own windows. EBS snapshots are incremental and regional. Copying a snapshot to another region is a separate action and a separate RPO, because the copy lags. DynamoDB point-in-time recovery is a table setting you turn on, not a default you should assume on an old table. S3 versioning plus replication is a backup only if the replica account will not honor a delete from the source. Replication of deletes is a setting. Think about it.

A restore test is the product. Once a quarter, restore a database to a new instance in the same region, point a non-production task at it, and read a row you know. Time it. That time is your real RTO for this failure mode, not the number in the slide. Restore an EBS snapshot to a volume in the other zone and mount it. Retrieve a Glacier object before you promise a user they can have it in an hour. A backup plan that has never been restored is a cron job that might be failing.

### A worked plan

The invoicing database has automated backups for seven days and a monthly snapshot copied to a vault in the security account, vault lock in compliance mode after a trial in governance mode so you felt the restriction first. The invoice bucket has versioning, and a replication rule to a bucket in the security account that does not replicate deletes. AWS Backup also takes the EFS share used for the one legacy mount. The reminder job's queue does not need a backup. Messages are short-lived by design. Backing up a queue is how you resurrect work you already finished. The runbook says who may restore, which role in the security account, and how the application is pointed at the restored endpoint. The role is not the application role. If the application can delete the backup, the attacker who became the application can too.

### Where this breaks

Final snapshot skipped. Point-in-time recovery never enabled. A vault in the same account with no lock. A KMS key for the backup that the same role can schedule for deletion. Restores that depend on a secret that was only in the database you are restoring. Snapshot copies stuck in a region you disabled. A lifecycle that expires versions faster than your RPO. And a test restore into production, which is not a test.

### How this is used at work

Platform owns the vault, the lock, and the cross-account copy. Application teams own the RPO they asked for and the restore drill. Terraform creates the plan. A calendar holds the drill. After an incident, the first question is which recovery point is clean, not which button says failover. Failover to a dirty replica is the DR lesson's warning. This lesson's warning is having no point to fail back to.

### What actually rolls back the clock

| Loss | A Multi-AZ failover | A backup |
| A zone | Yes | Not the first tool |
| A dropped table | No, the standby dropped it too | Yes, to a point before the drop |
| A stolen admin who deletes resources | No | Only if they cannot delete the vault |
| A region | No | Only if a copy exists elsewhere |
| A queue message you already processed | You should not restore this | A backup of a queue is usually wrong |

### What you write down next to the plan

The plan is not only a cron in AWS Backup. Next to it, in the runbook, name the RPO, the RTO you measured last time, the vault, the account the vault lives in, the KMS key and who can disable it, and the role that may start a restore. Name the thing you will not back up, and why. For the invoicing app that is the queue, the container image (ECR already keeps the digest), and the CloudWatch logs if a separate log archive exists. Name the order of a restore: key first, or the snapshot stays ciphertext; network second, so the new database has a subnet and a security group; data third; application config last, pointed at the new endpoint. A restore that creates a database nobody can route to is a snapshot you looked at.

Corruption is a timeline problem. If the bad write has been replicating for an hour, every synchronous copy is bad, and the newest snapshot may be bad too. The drill should include choosing an earlier point, not only the latest one. That choice is easier when the points are labeled and the application can tell you when the bad deploy started. CloudTrail and the deploy history are part of backup, because they tell you which point is clean. A vault full of points and no clock of the incident is a guessing game you play while the product is down.


### You can now

Separate durability, failover, and backup. Set an RPO and name the feature that meets it: point-in-time, snapshot, versioning, or a locked vault. Put a copy in another account. Refuse a plan that has never been restored. Leave ephemeral queues out of the backup story.

::: quiz
q: Multi-AZ RDS fails over after someone drops a table. What is on the new primary?
+ The same dropped table. The standby applied the drop. You need a backup from before it
- The table, restored automatically
- An empty database, which is safer
- A read replica's old pages, even if you had no replica
why: Synchronous replication copies mistakes. Backups and point-in-time restore are the time machine. Failover is for a broken instance, not a bad query.
:::

::: quiz
q: Why put a backup vault in another account with a lock?
+ So the principal that runs the application, or an attacker using it, cannot delete the recovery points
- Because snapshots only work cross-account
- Because a vault is required to create an EBS volume
- Because S3 versioning is a vault
why: Isolation is the point of the copy. A lock stops early deletion. Versioning in the same account is weaker against an admin of that account.
:::

::: card
q: What does an RPO of one hour require you to have?
answer: A recovery point no older than one hour, and a way to restore it. A nightly snapshot misses that RPO. A point-in-time window or a more frequent copy is what you are promising.
:::

::: predict lang=python
q: What does this print?
code:
```python
def recovers(kind):
    if kind == 'failover':
        return 'same-data'
    if kind == 'pitr':
        return 'earlier-point'
    return 'unknown'
print(recovers('failover'))
```
answer:
```text
same-data
```
why: Failover moves you to another copy of the same timeline. Point-in-time recovery moves you to an earlier point. The words are not interchangeable.
:::

::: quiz
q: Which of these is a poor candidate for AWS Backup?
+ The short-lived SQS messages of a queue that is the buffer, not the system of record
- The RDS instance
- The EBS volume of a single-zone build host you cannot rebuild
- The EFS share the legacy app writes
why: Back up the system of record. A queue is a buffer. Restoring old messages redoes work or double-sends. Rebuild a build host from a pipeline if you can, and back it up only if you cannot.
:::

::: quiz
q: A restore drill has never been run. What do you know about the RTO?
+ Only the number on the slide. The real RTO includes permissions, the KMS key, and the time you measured
- That AWS guarantees the slide
- That Multi-AZ makes the drill unnecessary
- That vault lock measures the RTO for you
why: An untested restore is a hypothesis. The drill is what turns retention into an RTO you can say out loud.
:::

## Databases and caches
id: databases
stage: build
needs: storage
minutes: 50
goal: Choose RDS, Aurora, DynamoDB, or ElastiCache from the access pattern, and name what each replication option actually promises.
source: Amazon RDS | https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Welcome.html
source: Amazon Aurora | https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/CHAP_AuroraOverview.html
source: DynamoDB partition keys | https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-partition-key-design.html
source: Amazon ElastiCache | https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/WhatIs.html

The storage lesson gave you files and disks. This one is where the rows live, and it is where designs get expensive or fall over. You are choosing a consistency and access model, not a logo. Postgres on RDS is the default when you have relations, constraints, and queries you have not all written yet. Aurora is Postgres or MySQL with a storage layer AWS redesigned. DynamoDB is a key-value and document store you design around known queries. ElastiCache is memory, Valkey or Redis OSS or Memcached, for data you can lose or rebuild. Picking DynamoDB because it is modern, or ElastiCache because the diagram needed a box, is how you spend a quarter migrating back.

RDS runs an engine you already know, in one region, in subnets you mark as a DB subnet group, with a security group. Multi-AZ for the classic deployment keeps a synchronous standby in another zone and fails over in a minute or two. The standby is not a second writer and, in that classic form, not a reader. A Multi-AZ DB cluster, for the engines that offer it, is a writer plus two readable standbys. Read replicas are asynchronous copies for read scaling, in the same region or another, and promoting one is a manual or automated decision you practise, not a health check. Automated backups are the point-in-time window from the backup lesson. The database is in private subnets. The master password is in Secrets Manager, rotated, and the application role can read that secret and nothing else.

Aurora splits compute and storage. The storage is replicated across three zones, six copies, and it repairs itself. A writer and zero or more readers share it. Failover is promoting a reader, typically well under a minute, which is faster than classic RDS Multi-AZ and still not zero. Aurora Global Database replicates to another region asynchronously. The secondary can take over. The lag is your RPO, and you have to measure it. Aurora Serverless v2 scales capacity in ACUs. It does not scale to zero in the sense of a free idle database for every hobby project. Read the current minimum. Use Aurora when you want the operational story and the failover, and you are willing to pay for it. Use RDS when the engine on an instance is enough and the bill matters more than the faster failover. Use either with the same application discipline: indexes, connection pooling, and a migration tool. The database will not index itself because it is managed.

DynamoDB is a different product. A table has a partition key and an optional sort key. The partition key decides where the item lives and how load spreads. A hot key, one customer who is half your traffic, throttles that partition while the table looks idle. The sort key orders items inside the partition. You model queries, not tables in the relational sense. If the access pattern is "get this order by id" and "list this customer's orders by date", you design keys so both are a Get or a Query, not a Scan. A scan reads the table. It is a migration tool and an incident, not an API. Secondary indexes are copies you pay to write. Global secondary indexes have their own keys and their own throughput. Transactions exist and cost more. On-demand capacity fits spiky or unknown load. Provisioned capacity plus auto scaling fits a shape you know, and it is what Savings Plans for DynamoDB can cover. DynamoDB streams are a change log you can attach a Lambda to. Global tables replicate multi-region active-active, with conflict rules you must understand before you write from two regions. Point-in-time recovery is off until you turn it on.

The modelling exercise is the job. Write the queries first. customer#42 as the partition key and order#2026-04-01 as the sort key answers "this customer's orders". It does not answer "all orders that are unpaid" unless you add an index whose partition key is the status, and then you have a hot partition if one status dominates. Sometimes the honest result of the exercise is Postgres. Ad-hoc reporting, joins, and constraints are relational. DynamoDB is for a known, huge, simple access pattern where the operational load of a server is the problem you are paying to remove.

ElastiCache is a cache or a fast structure, not a system of record, unless you have accepted that a flush is data loss and designed for it. Valkey and Redis OSS give you data structures, replication, and persistence options that are still not a backup story you skip. Memcached is a simpler cache. Put a cache aside a database for reads you can tolerate stale, for sessions once you have left the instance memory, for rate limits. Set a TTL. A cache without a TTL is a second database that drifts. A cache in one zone is a single point. Multi-AZ replication for the engine that supports it is the availability story, and a cold cache after failover is a latency event you should have load-tested. Security groups should allow the app, not the VPC CIDR, on the cache port. Encryption in transit is a setting. Turn it on unless you have a measured reason not to.

### A worked choice

Invoices need constraints, a few joins, and a report the finance team will change. That is RDS Postgres or Aurora Postgres, Multi-AZ, in Zurich, private subnets. The PDF bytes are in S3, not in a bytea column. The session and the rate limit are ElastiCache, TTL on the session, and the app works if the cache is empty, only slower or logged out. The "has this webhook been processed" idempotency key is DynamoDB with a conditional put and a TTL, because that access pattern is one key and a huge rate, and it does not need a join. Three stores, three reasons. One store for all of it would have been Postgres, and that would also have been fine at this size. The DynamoDB table is justified by the webhook rate, not by fashion.

### Where this breaks

A scan in a hot path. A partition key that is today's date for all customers. A relational schema copied into DynamoDB as one item per table with no access pattern. Aurora Global Database treated as synchronous. A read replica used for a transaction that must see the write. Connection storms against RDS without a proxy or a pool. ElastiCache as the only copy of a cart. A security group that allows 5432 from 10.0.0.0/8. Secrets in the task definition. And PITR left off until the drop.

### How this is used at work

Schema migrations are a pipeline, not a console. The app role is not the owner role. Dashboards show connections, replica lag, throttle events, and cache hit rate. A throttle on DynamoDB is a modelling or a capacity conversation, not a reboot. The SQL module of this path is how you write the query. This lesson is where that query is allowed to run, and what it costs when the index is missing.

### Picking the engine

| Need | Choose | Watch |
| Joins, constraints, unknown queries | RDS or Aurora Postgres | Connections, indexes, Multi-AZ |
| Known key lookups at large scale | DynamoDB | Partition key, no scans, PITR on |
| A second region with a measured lag | Aurora Global Database or DynamoDB global tables | RPO is the lag, conflicts if both sides write |
| Sessions, rate limits, hot reads | ElastiCache | TTL, empty-cache behavior, Multi-AZ |
| A cache that is the only copy | Do not | A flush is data loss |

### You can now

Choose RDS, Aurora, DynamoDB, or a cache from the access pattern. Explain Multi-AZ, a readable standby, and a read replica as different promises. Model two DynamoDB queries without a scan, or reject DynamoDB when the queries are ad hoc. Put idempotency keys and sessions in the store that matches their loss, and turn on point-in-time recovery for the system of record.

::: quiz
q: You must list one customer's orders by date, and you do not know next year's reports. What is the safer default?
+ Postgres on RDS or Aurora. DynamoDB only if you can name every access pattern now
- DynamoDB, because it is always cheaper at any size
- ElastiCache, because orders should be in memory
- A single EBS volume
why: Unknown queries and constraints are relational. DynamoDB punishes the query you did not model. Memory is not the system of record.
:::

::: quiz
q: A classic RDS Multi-AZ standby exists. Can you send read traffic to it?
+ No. In the classic deployment the standby is for failover, not for reads. Add a read replica or a Multi-AZ cluster with readable standbys if you need that
- Yes, that is what Multi-AZ means
- Yes, if you use the writer endpoint
- Only from the same security group
why: The classic standby is synchronous and not a reader. Read scaling is a replica or a cluster deployment that documents readable standbys. Do not point the app at an address you guessed.
:::

::: card
q: What is a DynamoDB hot partition?
answer: One partition key that takes a disproportionate share of traffic, so that slice throttles while the rest of the table looks idle. Fix the key design or isolate the hot item. A larger table size does not spread one key.
:::

::: predict lang=python
q: What does this print?
code:
```python
def query(kind):
    if kind == 'scan-for-user':
        return 'no'
    if kind == 'query-by-key':
        return 'yes'
    return 'no'
print(query('scan-for-user'))
```
answer:
```text
no
```
why: A scan is not the access pattern you ship. A Query on the key you designed is. The function rejects the scan.
:::

::: quiz
q: Aurora Global Database replicates to another region. What is the RPO?
+ The replication lag you measured, not zero. Promotion is a decision, and writes in flight can be lost up to that lag
- Zero, because Aurora storage has six copies
- The same as a synchronous Multi-AZ standby in one region
- Whatever the Route 53 TTL is
why: Six copies are inside the primary region's storage, not across regions. Global replication is asynchronous. The RPO is the lag, and you have to look at it.
:::

::: quiz
q: The cache is flushed and users are logged out, but orders are intact. Is that acceptable?
+ Yes, if sessions were the only thing in the cache and the system of record is the database. No, if the cart existed only in the cache
- No cache may ever be flushed
- Yes, because ElastiCache is Multi-AZ by magic even when you built one node
- Orders should have been only in the cache
why: A cache is rebuildable state. A flush that loses orders means the cache was the database. Put orders in RDS or DynamoDB and let the cache miss.
:::

::: quiz
q: You must Get one customer's orders by date from DynamoDB, and you do not want a hot key of today's date for every customer. Which key shape fits?
- Partition key ALL and sort key ALL, so one scan reads the table
+ Partition key the customer id, sort key the order date, so one customer's orders share a partition and Query can bound the dates
- Partition key the date, sort key the customer id, so every customer who ordered today lands on one key
- No keys. Scan and filter the customer in the application
why: The partition key is what you query as a group. Sharing it across every customer for one date creates a hot partition. A scan is not the access pattern. Customer as partition and date as sort answers "this customer's orders" without reading the rest of the table.
:::

## KMS and secrets
id: kms
stage: build
needs: storage, iam-deep
minutes: 45
goal: Choose who controls a key, require both IAM and the key policy, and keep passwords in a store that can rotate them.
source: AWS KMS | https://docs.aws.amazon.com/kms/latest/developerguide/overview.html
source: AWS Secrets Manager | https://docs.aws.amazon.com/secretsmanager/latest/userguide/intro.html

Encryption is two problems people fold into one. The first is confidentiality: a disk or a bucket stolen as raw bytes should be noise. The second is authorization: even if you can call GetObject, you should not get plaintext unless you may use the key. SSE-S3 solves the first and barely helps the second, because AWS owns the key and anyone who can read the object can read the bytes. A customer managed KMS key solves both only if the key policy and the IAM policy agree. This lesson is that agreement, plus Secrets Manager for the passwords that are not keys.

KMS stores keys and performs operations. You do not export a customer managed key's material in the ordinary case. You ask KMS to encrypt a data key, and you encrypt the payload with the data key. That is envelope encryption. S3, EBS, and RDS do it for you when you select the key. You need to understand it when you encrypt in the application, and when a bill arrives for millions of KMS requests because you called Encrypt on every row instead of on a data key. A decrypt requires kms:Decrypt. A grant or a policy that allows the data action and not the key action fails in a way that looks like the service is broken.

Keys are regional, with a few multi-region keys for when you deliberately replicate ciphertext. A multi-region key is not a global IAM object. Aliases are names in one region. Key policies are the resource policy, and for KMS they are mandatory. If the key policy does not allow a principal, IAM admin in the account does not save you, unless the key policy trusts the account and lets IAM decide, which is the usual root statement. Deleting that statement and then narrowing wrong locks the key. Schedule deletion has a waiting period. Use it. Do not rush it. Key rotation for customer managed keys is a setting that rotates the backing material and keeps the key id. Old ciphertext still decrypts. Rotation is not a reason to re-encrypt the world tonight, and it is not a response to a leaked data key you used outside KMS. Disable a key to stop decryption now, and accept that the application stops too.

AWS owned keys, AWS managed keys, and customer managed keys are the three grades. Owned keys are invisible and free of a key policy you control. Managed keys are per service, in your account, with a policy you do not fully control. Customer managed keys are yours: policy, grants, rotation, and a CloudTrail event for each use if you turn data-plane logging on, which costs. Use a customer managed key when a departed vendor, a second account, or an auditor needs a principal on the key. Use the default encryption when the requirement is only "not plaintext on disk".

Secrets Manager stores a string, versions it, and can rotate it with a Lambda. RDS integration is the common rotation. The secret's resource policy and the reader's IAM policy both matter across accounts. The application reads the secret at start and on a refresh, and it does not log it. Parameter Store SecureString is the cheaper cousin for values you can rotate yourself, encrypted with a KMS key. Use Secrets Manager when you want rotation and a staging label. Use Parameter Store when the value is configuration. Neither replaces the key policy. A secret that contains a raw AWS access key is a smell. The thing you wanted was a role.

### A worked key

The invoice bucket uses a customer managed key in eu-central-2. The key policy allows the account's IAM to grant, and then IAM allows the task role kms:Decrypt and kms:GenerateDataKey, and allows the security account's admin those actions plus the key administration. The application role cannot PutKeyPolicy. CloudTrail logs management events always, and you accept the cost of data events on this key or you sample. A second statement denies kms:Decrypt if the encryption context is missing, if you are encrypting in the application and you set a context. S3's own integration sets a context you must not invent. Read the service's docs before you add a condition that breaks GetObject. The database password is a secret, rotated, not a second KMS ciphertext in the environment.

### Where this breaks

A key policy edited to deny everyone. A deletion window you shorten in a panic. Encrypting payloads directly at high rate and the KMS quota. A condition on the encryption context that the service does not send. Secrets in environment variables beside a perfect key policy. A multi-region key used by accident in the wrong region with the wrong alias. Granting kms:* on * because one decrypt failed. And rotation that you thought invalidated old data keys and did not.

### How this is used at work

Platform owns key policies and a template that application teams cannot widen to star. Terraform creates the key and the alias. The application names the alias, not a raw key id copied into code, except where an ARN is required for the grant. After a person leaves, you remove their principal from IAM. You do not rotate every key in the account unless they could use the keys directly. If they had a role that could decrypt, you revoke the role and you look at CloudTrail for kms:Decrypt, which you only have if you logged it.

### Which control

| Requirement | Use |
| Disk not stored in plaintext | Default encryption, AWS managed or owned key |
| We decide who can decrypt | Customer managed key, IAM plus key policy |
| A password that rotates | Secrets Manager |
| A non-secret setting | Parameter Store, plain |
| Prove who decrypted | CloudTrail data events on the key, budgeted |
| Stop decryption now | Disable the key, and expect the outage |

### A denial that looks like S3

The task role can s3:GetObject and the bucket policy agrees. GetObject still fails with an access denied that mentions KMS. The object is encrypted with a customer managed key, and the role has no kms:Decrypt. Add the key action on that key's ARN, not on star. If it still fails, the key policy does not allow the account to delegate via IAM, or it does not name the role. Fix the key policy, not the bucket. If the error mentions an encryption context, your extra condition does not match the context S3 sends. Remove the clever condition before you remove the key. This path is the same for a snapshot you cannot restore: the snapshot is ciphertext, and the key is in the other account or pending deletion. A backup drill that does not include the key is a drill that has not started.

Grants are the other way to allow a key use, often created by a service on your behalf. They show up in the key's grant list and they can outlive the IAM policy you thought was the only door. When you review a key, list the grants. When you retire a vendor, retire the grant, not only the role you remember creating.

### You can now

Explain envelope encryption and why every row should not call KMS. Choose an owned, managed, or customer managed key. Read a key policy as a mandatory resource policy. Store rotating passwords in Secrets Manager and keep access keys out of it. Disable a key without pretending rotation deletes old ciphertext.

::: quiz
q: S3 default encryption with an AWS owned key is on. A role with s3:GetObject and no KMS permissions reads the object. What happens?
+ They get the plaintext. Owned-key encryption is at rest, and S3 performs it. It is not an extra authorization check you control
- KMS denies them, because encryption implies a key policy
- The object is unreadable until you create a customer managed key
- GetObject returns the ciphertext to the role
why: Default encryption stops raw disk disclosure. Authorization is still the bucket policy and IAM. A customer managed key is what adds kms:Decrypt as a second door.
:::

::: quiz
q: What does automatic rotation of a customer managed key do to old ciphertext?
+ Old ciphertext still decrypts. The key id stays, and KMS keeps prior material for decrypt
- It makes old objects unreadable, which is the point
- It writes new objects for you
- It rotates the application's Secrets Manager password
why: Rotation changes future encrypt operations. It is not a kill switch. Disabling the key is the kill switch, and it stops the application.
:::

::: card
q: Why is the KMS key policy mandatory?
answer: A caller needs the key policy to allow them, not only an IAM policy. If the key policy does not trust the account or the principal, an IAM administrator cannot decrypt. That is also how people lock a key.
:::

::: predict lang=python
q: What does this print?
code:
```python
def can_read(iam, key_policy):
    return 'yes' if iam and key_policy else 'no'
print(can_read(True, False))
```
answer:
```text
no
```
why: With a customer managed key, IAM allow is not enough. The key policy has to allow the call too. The model prints no when the key policy refuses.
:::

::: quiz
q: Where should the RDS master password live?
+ In Secrets Manager, with rotation, and the task role allowed to read that one secret
- In the task definition environment, because the role is already narrow
- In a KMS Encrypt call stored in git
- On the root account email
why: Secrets Manager is built for this value and can rotate it into RDS. Git and environment templates leak. KMS encrypts. It does not rotate a database password by itself.
:::

::: quiz
q: A service encrypts each of a million small records with a direct kms:Encrypt call. What breaks first?
+ KMS request quotas and the bill. Envelope encryption uses a data key for the payload and KMS for the data key
- S3 versioning
- The VPC route table
- IAM session length
why: KMS is a request service, not a bulk cipher. Data keys exist so the bulk work stays local. The quota error will look like an outage.
:::

## Detection and the edge
id: detect
stage: build
needs: kms, net-edge
minutes: 40
goal: Put WAF on the real front door, know what Shield and GuardDuty do not do, and keep customer identity out of IAM.
source: AWS WAF | https://docs.aws.amazon.com/waf/latest/developerguide/what-is-aws-waf.html
source: AWS Shield | https://docs.aws.amazon.com/waf/latest/developerguide/shield-chapter.html
source: Amazon GuardDuty | https://docs.aws.amazon.com/guardduty/latest/ug/what-is-guardduty.html
source: Amazon Cognito | https://docs.aws.amazon.com/cognito/latest/developerguide/what-is-amazon-cognito.html

KMS answers "can this principal decrypt". It does not answer "is this request an exploit" or "who is mining bitcoin in a region we forgot". Detection and edge filtering are the other half of security-aws. This lesson is WAF, Shield, GuardDuty, and the user-facing identity service Cognito, which is not IAM.

AWS WAF is a web ACL you attach to CloudFront, an Application Load Balancer, API Gateway, or some other front doors the current docs list. Rules look at HTTP: IP reputation, rate, headers, body size, managed rule groups for common exploits. WAF does not see traffic that bypasses the front door. If the load balancer is also open to the world, the attacker skips CloudFront and your WAF. Security groups or a prefix list should make the origin accept the distribution, not the internet, when that is the design. Count mode before block mode. A managed rule that false-positives on your API is an outage you shipped. Rate-based rules are a coarse brake, not a business quota. A logged-in user and a botnet can share an IP behind a carrier. Use the rule, and do not pretend it is application authorization.

Shield Standard is on for AWS edge services and protects against common volumetric floods. You do not turn it on. Shield Advanced costs money and adds support, reporting, and protections for specific resources. Buy it when a flood is a business risk you have quantified, not as a checkbox next to a small internal app. Neither Shield nor WAF replaces an Auto Scaling group. A flood that WAF blocks should not also scale your tasks to the maximum and double the bill. That coupling is a cost and reliability bug.

GuardDuty is a detector. It reads CloudTrail management events, VPC flow logs, DNS logs, and optional sources such as S3 data events and EKS audit logs, and it raises findings. It does not block the call. A finding without a person or an automation that acts is a dashboard. The useful automation is narrow: quarantine a role, snapshot a volume, notify. The dangerous automation is "delete the instance", which an attacker who can cause a finding can use as a weapon, or which fires on a false positive. GuardDuty is regional. Enable it in every region, or delegate it from an organization so a new account and a new region are not a dark room. The finding "instance talking to a mining pool" in a region you do not use is the account lesson coming due.

Cognito is customer identity, not your employees. A user pool authenticates users and issues tokens. An identity pool exchanges a token for temporary AWS credentials. Most application users should never get AWS credentials. They should get a token your API validates. Give them an identity pool only when the client must call AWS directly, and then the role is tiny. Employee access stays in Identity Center. Mixing the two is how a customer token ends up able to read a bucket. JWT validation is the API's job: issuer, audience, expiry, signature. A decoded token you do not verify is a JSON file the client wrote.

### A worked edge

CloudFront is in front, WAF on the distribution, managed rule group in count for a week, then block, plus a rate rule. The origin ALB allows only the CloudFront prefix. Shield Standard is already there. GuardDuty is delegated to the security account and enabled in all regions. Findings page someone. S3 protection is on for the invoice bucket. Cognito, if customers log in, is a user pool. The API checks the JWT. There is no identity pool. The application role remains the only AWS principal. A finding that the role called s3:PutBucketPolicy is a page, not an email in a folder.

### Where this breaks

WAF on the distribution and an open origin. Count mode left forever. Shield Advanced bought instead of fixing the open security group. GuardDuty in one region. An automation that terminates on any finding. Cognito identity pool roles with s3:*. JWTs accepted without checking the audience, so a token for another app works. And logs of the WAF omitted, so you cannot explain a block.

### How this is used at work

Security owns the web ACL, the delegated GuardDuty, and the response runbook. Application teams own the exception for a rule that breaks a real route, with a ticket, not a disable. Cognito or your identity provider is a product choice reviewed with the web module's session and JWT material. None of this is a reason to skip least privilege. Detection is what you do about the day least privilege fails.

### What each one sees

| Service | Sees | Does |
| WAF | HTTP at the front door you attached | Counts or blocks requests |
| Shield Standard | Volumetric attacks on AWS edges | Always-on, not a policy you write |
| Shield Advanced | Resources you subscribe | Paid response and extra protections |
| GuardDuty | Logs and DNS you enabled, per region | Findings, not blocks |
| Cognito user pool | Your customers | Tokens for your API |
| IAM and Identity Center | Your employees and workloads | AWS API access |

### What a finding is worth

Read a GuardDuty finding as a lead, not as a verdict. The resource, the action, the remote IP, and the principal are the fields. A finding on a build host that clones repositories all day may be the build host. A finding on a production task role calling iam:CreateUser is not the build host. Write the response before you need it: who is paged, what they are allowed to revoke, and what they must not delete. Snapshot first if the instance might hold evidence. Revoke the role session if STS will let you. Isolate the security group. Then decide. A weekend of unreviewed findings trains everyone to ignore the page, which is worse than not having the detector, because you think you are covered.

WAF logs belong in the same habit. A blocked request has a rule id. If you cannot say which rule blocked a customer, you cannot unblock them without turning the whole ACL off. Send WAF logs to a log group or a bucket the application team cannot delete. The security account is the right place. Count mode for a new managed rule group is how you learn the rule id before it is an outage. A week is a guess. The real exit criterion is that you have looked at the counted matches.

Cognito tokens still need the checks from any other JWT. Verify the signature against the user pool's keys, check the issuer and the audience, and check the expiry. A token for a different app, or an expired token, is not a user. Access tokens and ID tokens are not interchangeable. The API should say which one it expects. None of that is an IAM policy, and an IAM policy will not do it for you.

### You can now

Attach WAF to the door users actually use, and close the side door. Leave Shield Standard in the picture and buy Advanced only for a reason. Turn GuardDuty on in every region and say who acts on a finding. Use a user pool for customers and do not hand them AWS roles by default. Verify a JWT instead of trusting its payload.

::: quiz
q: WAF is attached to CloudFront. The ALB behind it allows 443 from the world. What is true?
+ Callers can bypass the WAF by going to the ALB. Restrict the origin to CloudFront
- WAF inspects every packet in the VPC
- Shield Standard blocks that bypass
- GuardDuty closes the ALB for you
why: WAF only sees the resource it is attached to. An open origin is a second front door. Prefix lists and security groups are how you close it.
:::

::: quiz
q: A GuardDuty finding says an instance is talking to a mining pool. What does GuardDuty do by itself?
+ It records the finding. It does not stop the instance unless you added an automation
- It terminates the instance
- It rewrites the security group to deny all
- It rotates your KMS keys
why: Detection is not prevention. The response is a runbook you designed. A wild automation that deletes resources is its own incident.
:::

::: card
q: How is a Cognito user pool different from IAM Identity Center?
answer: A user pool is for your application's customers and issues tokens your API checks. Identity Center is for people who sign in to AWS accounts. Customers should not receive IAM roles unless a specific client must call AWS.
:::

::: predict lang=python
q: What does this print?
code:
```python
def door(waf_on_cf, alb_open):
    return 'bypass' if alb_open else 'waf'
print(door(True, True))
```
answer:
```text
bypass
```
why: If the origin is open, the WAF on CloudFront is optional for the attacker. The model returns bypass whenever the ALB is open.
:::

::: quiz
q: Where must GuardDuty be enabled?
+ In every region you can use, ideally by organization delegation, not only in the region you deploy to
- Only in us-east-1, because findings are global
- Only on the production VPC's subnets
- Inside the container image
why: GuardDuty is regional. An unused region is a common place to hide. Delegation stops new accounts from being dark.
:::

::: quiz
q: A rate-based WAF rule blocks a large customer who shares one corporate NAT address. What is the better reading?
+ The rule is a coarse control. You tune or scope it. It was never a per-user quota
- WAF understands your user table if you turn on Shield
- You should remove authentication and rely on the rate rule
- CloudFront caching caused the block
why: IP rate limits catch floods and catch offices. Application quotas belong in the app, keyed by the user, after you know who they are.
:::

## Availability and scaling
id: ha
stage: run
minutes: 40
goal: Design a service that survives instance and AZ failure and a spike, and describe it with RTO and RPO.
needs: storage
source: Elastic Load Balancing | https://docs.aws.amazon.com/elasticloadbalancing/latest/userguide/what-is-load-balancing.html
source: Well-Architected reliability pillar | https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/welcome.html
source: Amazon SQS | https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/welcome.html

Availability is what you still serve when something you knew would fail does fail. Scaling is what you do when more of the same work arrives. They share a load balancer and an Auto Scaling group and they are not the same requirement. A single huge instance scales, until it does not, and it is not available across a zone. Two zones of a stateless app behind a load balancer are available across a zone, and they do not survive a region. The backup lesson covered the copy. The disaster-recovery lesson covers the other region. This lesson is the pattern inside one region, and the queue that keeps a spike from becoming a down page.

The pattern is dull on purpose. Tasks or instances in at least two zones. No session and no file that exists only on one of them. A load balancer that only sends traffic to targets whose health check passes. A minimum count that is not one. A database with a synchronous standby or Aurora's storage, so the zone does not take the data with it. Deploys that add the new tasks before they remove the old ones. A dependency timeout that is shorter than the caller's timeout, so a stuck database does not pin every worker. That last one is how a partial failure becomes a total failure even when the zones are fine.

Health checks are the control. A check that hits a static file says the process is listening. A check that runs a query says the dependency works, and it can also stampede the dependency if every target checks too often. Choose what "unhealthy" should mean. If you want the load balancer to stop sending traffic when the database is down, the check can depend on it, and then a database blip empties the target group. Sometimes you would rather serve a degraded read. That is a product decision. It is not a default in the console.

Queues are the other half of surviving load. SQS, from the serverless lesson, turns a spike into a backlog. The API accepts the work and returns. Workers scale on queue depth or age. Age matters more than depth, because depth can be many fast messages and age means someone is waiting. A dead-letter queue catches poison. The user-visible contract has to allow the delay. An order that must be confirmed in the same request cannot be fully queued. The payment can be a call, and the email can be a queue. Splitting those is the design. A queue in front of a single-threaded worker you cannot scale is a delay, not a safety valve. Scale the worker on the metric, and cap it so a flood does not scale you into a bill. The cap is a choice about shedding load. Shedding load on purpose is better than falling over.

Talk about the target in RTO and RPO before you name products. RTO is how long you may be down. RPO is how much data you may lose. Inside one region, Multi-AZ and a load balancer are how you get a small RTO for a zone failure, with an RPO near zero for the database if replication is synchronous. They do nothing for a dropped table, which is RPO against human error and wants the backup. They do nothing for a region. If the business says eight hours and one day are acceptable, a second region is a hobby. If the business says one minute and zero data, you are in synchronous multi-region territory, which is rare and costly, and you should make them say it twice.

Chaos is a test, not a personality. Terminate one instance. Confirm the load balancer drains it and the group replaces it. Fail a task in one zone. Confirm the other zone serves. Restore from a backup on a calendar, which is the other lesson. If you cannot run these, the diagram is a wish. Write the expected result down so the drill has a pass mark.

### A worked spike

The sale starts at noon. The API writes the order to the queue after a cheap validation and a idempotency key in DynamoDB, and returns 202 with a status URL. Workers in two zones scale on the age of the oldest message, from two to twenty, and stop at twenty so the database connection pool is the limit you chose. The database is Multi-AZ. The status page reads a row, not the worker's memory. At 12:04 a zone's tasks fail their checks. The load balancer uses the other zone. The queue grows. Age alarms. You do not page on CPU. You page on age and on errors. At 12:20 the backlog is gone. The dead-letter queue has three messages, and those three are the incident, not the thousand that succeeded.

### Where this breaks

Sessions in memory. A minimum of one. A health check that never fails. A queue with a consumer that is not idempotent. Scaling without a cap. An alarm on CPU that pages every evening and is ignored at noon. A dependency with no timeout. Multi-AZ described as multi-region. A drill that has never been run. And a status page that depends on the same broken stack as the app.

### How this is used at work

The on-call page is age, error rate, and saturation of the thing that will fail next, such as connections or disk. CPU is a graph for the next day. Post-incident reviews ask which failure the design was supposed to survive and whether the drill had caught this. Terraform sets the minimum, the health check, and the alarm. A human does not resize one instance during the sale. They watch the queue and the error budget.

### What you are surviving

| Failure | Pattern that covers it | Pattern that does not |
| One task or instance | More than one, and a health check | A bigger instance |
| One zone | Two zones, Multi-AZ data | Two tasks in one zone |
| A traffic spike | A queue, or a stateless scale-out with a cap | A timeout and a prayer |
| A bad deploy | Roll forward or back, minimum healthy percent | In-memory state |
| A region | The DR lesson | Another AZ |
| A dropped table | A backup | A failover |

### Timeouts and the blast of one dependency

Give every outbound call a timeout shorter than the caller's budget, and a limit on concurrency. When the database slows, the app should return an error to some requests and keep serving others, not pile up threads until the process is killed and the load balancer has nobody left. Bulkheads do that: a separate pool for the payment call and the catalog call, so one slow vendor does not consume the workers the health check needs. Retries need jitter and a cap, or they become the spike. A retry of a non-idempotent payment is the serverless lesson again. Inside one region, these limits are the difference between a degraded hour and an empty target group. They do not appear on the architecture slide, and they are the slide that matters at noon.

### You can now

Draw the two-zone stateless pattern and say what it does not cover. Use a health check that means something. Put bursty work on a queue and scale workers on age, with a cap and a dead-letter queue. State an RTO and an RPO before you add a region. Terminate one instance as a drill and predict the result.

::: quiz
q: Users get logged out at random after you scale from 1 to 3 instances. The app keeps sessions in memory. Fix?
- Sticky sessions forever
+ Move sessions to a shared store (ElastiCache/Redis or the database), so any instance can serve any request
- Go back to one bigger instance
- Lower the health-check interval
why: Instances behind a load balancer must be stateless. With in-memory sessions, a request landing on another instance finds no session.
:::

::: quiz
q: An order API must never lose an accepted order, and traffic spikes 20× during sales. What helps most?
- Bigger instances
+ Accept the order into an SQS queue and process it with workers that scale on queue depth
- A read replica
- Lambda with a 15-minute timeout
why: The queue absorbs the spike durably; workers drain it at a sustainable rate. A dead-letter queue keeps failing messages for inspection.
:::

::: quiz
q: The sale multiplied traffic by twenty. The API writes an idempotency key and enqueues the order. Workers are capped at twenty. Why the cap?
+ So the spike cannot scale the workers past the database you sized. The queue holds the rest, and age tells you the wait
- Because SQS only allows twenty consumers
- Because a cap replaces the dead-letter queue
- Because Multi-AZ requires a maximum of twenty
why: Unbounded scale-out moves the outage into the database or the bill. A cap is deliberate backpressure. The dead-letter queue is for failures, not for the cap.
:::

::: card
q: Which metric should page a human for the queue in this pattern?
answer: The age of the oldest message, and the depth of the dead-letter queue. Depth alone can be a healthy backlog. CPU on a worker is a clue for later, not the page.
:::

::: predict lang=python
q: What does this print?
code:
```python
def covers(design, failure):
    if design == 'two-az' and failure == 'one-az':
        return 'yes'
    return 'no'
print(covers('two-az', 'region'))
```
answer:
```text
no
```
why: Two zones cover one zone. They do not cover a region. The function returns no for that pair.
:::

::: quiz
q: A health check runs a heavy query every two seconds from every target. What is the risk?
+ The checks themselves can overwhelm the database, or a short blip can empty the target group
- Health checks are free and do not reach the database
- The load balancer caches the query
- IAM stops the checks after one failure
why: Checks are traffic. A dependency check should be cheap, and you should know that a failure removes capacity. A static check hides a dead dependency. Pick the failure you want.
:::

::: quiz
q: Users must see the order confirmation in the same second, including a payment authorization. What can you queue?
+ The work that can be late, such as email and PDF rendering. The authorization stays on the request path
- The payment, because queues are more available
- The whole request, and the client should retry until 202 becomes 200 by itself
- Nothing, because a queue forbids a synchronous call anywhere
why: Queue the tail. Do not queue the decision the user is waiting to trust. Idempotency still matters on the payment call, because the client will retry.
:::

## Disaster recovery
id: dr
stage: run
needs: ha, databases
minutes: 45
goal: Pick a disaster-recovery strategy from RTO, RPO, and residency, and practise the failover including the way back.
source: Disaster recovery of workloads on AWS | https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-workloads-on-aws.html
source: Well-Architected reliability pillar | https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/welcome.html

Two Availability Zones are not a disaster-recovery plan. They are the high-availability plan from the last lesson. Disaster recovery starts when the failure is bigger than those zones: a region, a corrupted dataset that replicated, or an account you cannot use. AWS describes four strategies, in rising cost and falling recovery time. Backup and restore. Pilot light. Warm standby. Multi-site active-active. You pick one from the RTO and RPO the business wrote down, not from the most impressive diagram.

Backup and restore means the other region, or the other account, has your backups and the ability to recreate the stack, and little or nothing is running. RPO is the age of the backup. RTO is how long it takes to create the network, restore the data, and deploy the app, which you only know if you have done it. This is the right strategy when the business can be down for hours or a day. It is honest. A runbook that says "we would restore" and a team that has never created the VPC from scratch is not this strategy. It is a hope. Infrastructure as code is what makes the RTO finite. The Terraform module is not optional if you chose this strategy. A console you cannot remember is an RTO of "until we remember".

Pilot light means the critical data is live in the other region, replication on, and the compute is off or minimal. A database replica, or Aurora Global Database with no readers promoted, or an S3 replica, is the pilot. When you fail over you scale the compute and point DNS at it. RPO is the replication lag. RTO is the scale-up plus DNS TTL plus the mistakes in the runbook. You pay for the data path all the time and for the compute during the disaster and the drills. This fits a tight RPO and a looser RTO. The failure mode is a replica you cannot promote because the parameter group, the secret, or the VPC was never created in the target region.

Warm standby means a smaller but real stack is running in the other region and taking replicated data. Failover is scaling it up and moving traffic. RTO is shorter than pilot light because you are not starting from zero. You pay for an idle-ish environment forever. The standby must be exercised, or it will not boot on the day. A warm standby that cannot pass its own health check is a pilot light you are overpaying for.

Multi-site active-active means both regions serve writes, or both serve and one is ready to. RTO can be very small. RPO can be small only if replication is nearly caught up, and it is not zero unless you accepted synchronous cross-region latency, which you almost certainly did not. Conflict resolution is the product. Shopping carts, counters, and unique constraints do not merge because Route 53 returned the other address. DynamoDB global tables and Aurora Global Database have specific rules. Read them for the engine you use. Active-active is justified by a latency requirement in two geographies or by an RTO you cannot meet any other way. It is not justified by the phrase "highly available" on a slide.

DNS is the switch for several of these, and DNS is slow if the TTL is long. Health checks that flip a record do not drain connections that already have the old IP. Clients retry. Some do not. A load balancer does not span regions. You are steering between two regional stacks. Practise the flip. Flip back. The failback is where unreplicated writes in the disaster region get lost if you are careless. Decide which side is the source of truth before you need to.

Data is the constraint. Compute is easy to recreate. A replica that is missing the last ten minutes is an RPO of ten minutes, even if the compute fails over in thirty seconds. Say the number you measured. A synchronous standby inside the region does not change the cross-region number. And a replica of a corrupted table is a warm copy of the corruption. For that failure you need a point in time, which is the backup lesson, possibly in the second region if the region itself is the problem. DR without a clean point is failover to the bug.

### A worked choice

The invoicing company can be down for four hours and can lose fifteen minutes of data. That is not active-active. A pilot light fits: Aurora replica or a continuous backup copy in a second EU region they are allowed to use, infrastructure in code, compute at zero, a drill twice a year that promotes and serves a test invoice. If the contract had said Switzerland only, the second region might be illegal, and the strategy collapses back to backup and restore inside the region plus a written acceptance of regional outage. Residency beats the pretty strategy. If the contract had said one minute, the conversation is warm standby or active-active, a second region that is lawful, and a bill someone signs.

### Where this breaks

Calling two zones a DR plan. A pilot light whose network does not exist. A TTL of an hour. Active-active with no conflict rule. A drill that restores data and never moves DNS. A KMS key that is not in the target region, so the snapshot will not open. A runbook in the region that is down, stored only there. And a failover that succeeds and a failback that loses a day of invoices.

### How this is used at work

The strategy is a sentence in the design doc: pilot light, RPO fifteen minutes, RTO four hours, last drill date and result. The calendar holds the next drill. Terraform has a provider alias for the second region, even if the only resources are the replica and the vault. On the day, one person is in charge of the flip. Everyone else does not click. Afterward you write what the RTO actually was. If it was twelve hours, the strategy on the slide was wrong, and you change the slide or the design.

### The four strategies

| Strategy | Running in the other region | RTO shape | You pay for |
| Backup and restore | Backups, no live stack | Hours, if the code path works | Storage, and the drill |
| Pilot light | Data replicated, compute off | Scale-up plus DNS | Replication always |
| Warm standby | A small live stack | Scale-up plus DNS, shorter | A second small environment |
| Multi-site active-active | Both serving | Minutes, if conflicts are solved | Two full environments and the complexity |

Write the drill as a checklist with owners, not as a paragraph. Who declares the disaster. Who freezes writes in the old region if it is still partially up. Who promotes the database. Who changes DNS. Who watches error rate. Who decides to fail back, and which data moves first. A checklist you have not timed is still better than a hero who knows the console. Time it anyway. The first drill's value is the list of missing pieces: the key, the secret, the provider alias, the runbook that was stored in the region you lost.

### You can now

Refuse to call Multi-AZ a disaster-recovery strategy. Pick backup and restore, pilot light, warm standby, or active-active from an RTO, an RPO, and a residency rule. Name DNS TTL and the KMS key as part of the RTO. Practise failover and failback. Keep a clean point in time for corruption, not only a replica of it.

::: quiz
q: The business can lose a day of data and be down for a day. Which strategy is honest?
+ Backup and restore, with a drill that recreates the stack. A warm standby would meet it and waste money
- Multi-site active-active, because it is the most resilient
- Two Availability Zones and no backups
- A Route 53 record with no second stack
why: Match the strategy to the objective. Active-active is for objectives the cheaper strategies miss. Two zones do not restore a deleted database.
:::

::: quiz
q: Aurora Global Database shows ten minutes of replica lag. You fail over. What is the RPO you just accepted?
+ About ten minutes of writes, plus whatever the promotion itself loses. The storage copies inside the old region do not shrink that number
- Zero, because Aurora keeps six copies
- The Route 53 TTL
- Fifteen seconds, the Aurora marketing default
why: Cross-region replication here is asynchronous. The lag is the data you may lose. Six copies are the primary region's durability, not the global RPO.
:::

::: card
q: Why is failback part of the drill?
answer: The disaster region may have accepted writes the standby does not have, or the standby may have been promoted and taken new writes. Returning traffic without a rule for those writes loses them. Practise the return, not only the escape.
:::

::: predict lang=python
q: What does this print?
code:
```python
def strategy(rto_hours):
    if rto_hours >= 8:
        return 'backup-restore'
    if rto_hours >= 1:
        return 'pilot-or-warm'
    return 'warm-or-active'
print(strategy(12))
```
answer:
```text
backup-restore
```
why: A twelve-hour RTO does not justify a second live stack. The model picks backup and restore. Shorter objectives move you up the cost curve.
:::

::: quiz
q: The second region is not allowed by the residency contract. What changes?
+ You do not put a replica there. The remaining plan is inside the allowed region, plus an accepted regional outage
- Encryption lets you replicate anywhere
- A Local Zone in another country is not a region, so it is fine
- Route 53 geolocation hides the data location
why: Residency applies to replicas, backups, and logs. A strategy that needs a forbidden region is not a strategy you can use. Write down the regional risk instead of hiding it.
:::

::: quiz
q: The snapshot restores, and the new database will not start because of KMS. What did the plan forget?
+ The key in the target region, and a key policy that lets the restore role use it
- A bigger instance class
- A public subnet for the database
- A WAF rule
why: Ciphertext without the key is not a backup. Multi-region keys or a key in the target region have to be part of the drill, not a surprise at the end.
:::

## Observability
id: observe
stage: run
minutes: 40
goal: Page on symptoms a user would feel, and keep logs, metrics, and traces useful enough to debug one request.
needs: ha
source: Amazon CloudWatch | https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/WhatIsCloudWatch.html
source: OpenTelemetry observability primer | https://opentelemetry.io/docs/concepts/observability-primer/
source: AWS X-Ray | https://docs.aws.amazon.com/xray/latest/devguide/aws-xray.html

Observability is how you notice, and how you find the cause without SSHing into a box that should not exist. Three signals answer three questions. Logs say what happened to one request. Metrics say how often and how slow, over time. Traces say which hop took the time when more than one service was involved. CloudTrail is a fourth record, of the AWS API, and it gets its own lesson because people bury it inside "logging" and then cannot answer who deleted the trail. This lesson is the application and the platform signals, and the alarm that is allowed to page a person.

CloudWatch is the default sink on AWS. Metrics are numbers over time: CPU, the load balancer's 5xx count, queue age, a custom metric you publish. Logs are the lines your process writes. Container stdout can go there. Alarms watch a metric and move to ALARM, and then an action notifies or scales. A dashboard is a picture. It does not page. If the only detection is a human looking at a dashboard, you do not have detection at night. X-Ray and OpenTelemetry are the trace path. A trace id that starts at the load balancer or the API and is logged by every hop lets you join a slow trace to the log lines. Without that id, you have timestamps and a guess.

What you page on is a symptom a user would notice, or a saturation that will become one before a human can react. Error rate. Latency at a high percentile, not the average. Queue age. Disk nearly full. A failed health check count. You do not page on CPU at 70 percent if the error rate is flat. You graph CPU so the person who was paged for errors has a clue. Every alarm has a link to the runbook and a threshold you can explain. An alarm that fires every evening is deleted or fixed, because the night it matters it will be muted. Composite alarms can mean "page if errors are high and it is not the known deploy window". Use them sparingly. A boolean you cannot say out loud is a missed page.

Logs have a shape. One JSON object per line, a level, a message, the request id, and nothing that is a secret, a token, or a full card number. Retention is a setting. Infinite retention is a storage product. A log group per service, a retention that matches how you debug, and a longer archive in the security account if you must keep them. Metric filters turn a log pattern into a metric when the service cannot emit one. That is a bridge, not the goal. Emitting the metric is cheaper to query. Logs are for the one request. Metrics are for the rate.

Traces earn their cost when you have more than one hop. A monolith can live on logs and metrics. A queue plus two Lambdas plus a database cannot, not once the question is "where did the second go". OpenTelemetry is the vendor-neutral way to emit spans. X-Ray is one backend. You do not need both names in the code if the SDK can export. You do need the context propagated across the queue, or the trace breaks at the message. Propagation is a header or an attribute. It is not automatic across every AWS service boundary. Test it.

### A worked alarm

The API's load balancer emits HTTPCode_Target_5XX_Count and a latency percentile. The alarm is 5xx above one percent of requests for five minutes, and a second alarm is p99 latency above one second for five minutes. Both notify the same topic. The runbook says: open the dashboard, read the request id from a sample log, see whether the database or the downstream is in the trace, and do not restart the world first. Queue age has its own alarm because the API can be healthy while the workers are stuck. CPU is on the dashboard. A deploy annotation on the graph stops you from correlating by squinting. The log retention is thirty days in the account and one year in the archive for the audit log only, not for debug.

### Where this breaks

Paging on everything. Logging the authorization header. A request id that is not passed to the worker. Averages that hide the slow tail. No retention. Metrics in one region and the service in another. A dashboard as the on-call. Traces sampled at zero. An alarm on a metric that stops being published, which looks like "everything is fine" unless you alarm on missing data. And a log group the application role can delete.

### How this is used at work

The service owns its dashboard and its alarms, reviewed like code. Platform owns the log archive and the trail. SLOs are the error and latency numbers turned into a budget. An error budget spent means you stop shipping features and fix reliability, which is a product conversation, not a CloudWatch feature. After an incident, the timeline should be reconstructable from the signals. If it is not, the action item is the missing signal, not a longer postmortem.

### Which signal

| Question | Signal | Not |
| How many 5xx this minute | Metric and alarm | A log search as the page |
| What did this request do | Log line with a request id | The average latency |
| Which hop was slow | Trace | CPU of a random task |
| Who called DeleteBucket | CloudTrail, next lesson | The application log |
| Is the queue behind | Age metric | Instance CPU |

### A request you can actually follow

Pick one failed invoice and walk it without guessing. The load balancer access log, or the API log, has the request id and a 500. The same id is on the application line that caught the exception, and the line names the dependency, not only "error". The trace, if you have one, shows the database span longer than the budget. The metric for that minute shows the error rate, so you know it was not a single unlucky call. The queue age did not move, so this was the synchronous path. Nothing in that story required a private key or a customer name in the log. If a step is missing, that is the instrumentation ticket. Write it while you remember which id you could not find.

High-cardinality data belongs in logs and traces, not in unbounded CloudWatch metrics. A metric per customer id will blow the bill and the usefulness. Emit a metric per route and status, and put the customer id on the log line. Cardinality is a cost property. The cost lesson will recognize it. The observe lesson's rule is: metrics are few and stable, logs are detailed and retained on purpose, traces are sampled if the volume demands it, and the sampling still keeps errors.

### You can now

Separate logs, metrics, and traces, and page on symptoms. Put a request id through every hop you operate. Set retention. Alarm when data is missing. Leave the audit of the AWS API to CloudTrail, and do not log secrets while you are at it.

::: quiz
q: Someone deleted a production security group rule last night. Where do you find who did it?
- CloudWatch Metrics
- The VPC flow logs
+ CloudTrail
- X-Ray
why: CloudTrail is the audit log of API calls, with the caller's identity, time and source.
:::

::: quiz
q: Which alarm best reflects what users experience?
- Average CPU above 70%
+ p99 latency above 1 s, or 5xx rate above 1%, for 5 minutes
- Memory above 60%
- More than 100 log lines a minute
why: Symptoms (slow or failing requests) are what users feel. Resource metrics are useful for diagnosis and capacity planning, not as primary alerts.
:::

::: quiz
q: The API is fast and the queue age is twenty minutes. What should page?
+ Queue age. The API metric is the wrong symptom for work that already returned 202
- CPU of the API tasks
- A log line that says hello
- The CloudFront cache hit rate only
why: Page on the symptom that matches the contract. A queued workload's user-visible pain is age, not the front door's CPU.
:::

::: card
q: Why is average latency a bad page?
answer: A few very slow requests can be hidden by many fast ones. A high percentile, p95 or p99, is closer to the worst experience a user actually hits. The average is still a useful graph.
:::

::: predict lang=python
q: What does this print?
code:
```python
def page(symptom, cpu):
    if symptom:
        return 'page'
    return 'graph-cpu' if cpu else 'quiet'
print(page(False, True))
```
answer:
```text
graph-cpu
```
why: CPU without a user symptom goes on a graph. The function pages only when the symptom flag is set.
:::

::: quiz
q: An alarm is green because the metric stopped publishing. What did the alarm forget?
+ A missing-data state that is not OK. Treat absent points as a problem for a metric that should always exist
- A larger period, which invents points
- A log retention of one day
- WAF in front of CloudWatch
why: CloudWatch can treat missing data as good, bad, or ignore. A dead publisher looks healthy if missing is good. Choose the state on purpose.
:::

::: quiz
q: What must cross a queue with the message if you want one trace?
+ The trace context. Propagation is not automatic for every consumer you write
- The IAM session token, logged in the message
- The average CPU
- A second CloudTrail in the worker
why: The worker starts a new process. It will not see the caller's span unless you pass the context and the SDK continues it. Do not pass credentials to get the trace.
:::

## CloudTrail
id: cloudtrail
stage: run
needs: observe
minutes: 40
goal: Keep an audit of AWS API calls that the workload cannot delete, and read an event down to the principal.
source: AWS CloudTrail | https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-user-guide.html

CloudTrail answers who did what to the account. CloudWatch answers how the application behaved. They meet when an API call is the incident, and they are not substitutes. If the bucket policy changed at 02:00, the metric on 5xx will not name the principal. The trail will, if it was on, in that region, and if the log file is somewhere the principal cannot delete.

A trail records management events: creating an instance, attaching a policy, deleting a trail. Those are on in a trail you create. Data events, such as s3:GetObject and Lambda invokes, are off until you pay for them. Insights look for unusual API rates. The default trail AWS now enables in many accounts is a start and not the archive you want. Your trail should deliver to an S3 bucket in a logging account, with a bucket policy that the workload accounts cannot change, a KMS key the same way, and log file validation so you can see tampering. Organization trails apply the same idea to every member account, which is how a new account does not spend a month in the dark.

Regions are the hole. A trail can be multi-region, and it should be, including events from regions you do not use. Global service events, IAM in particular, are delivered in one place and must be included. A trail that is single-region in eu-central-2 does not see an instance launched in a forgotten region. GuardDuty will not fully save you if its own logs were never turned on there. The account lesson and this one are the same control seen twice.

Read an event for the fields that matter. eventTime, eventSource, eventName, awsRegion, sourceIPAddress, userAgent, userIdentity, and errorCode. userIdentity tells you whether it was an assumed role, and the session name often tells you which pipeline or which human. A role named platform-admin and a session named alice is a person. A session named GitHubActions is CI. An access key id in the identity block is a long-lived key you hoped did not exist. errorCode AccessDenied is still useful. Someone tried. A successful PutBucketPolicy is the incident. The request parameters may contain the new policy. Treat the log as sensitive. It can contain resource names and, if you are unlucky, a secret someone passed as a parameter. Do not replicate trails into a slack channel in raw form.

What you alarm on is a short list. Root sign-in. CloudTrail stopped or the bucket policy changed. A security group opened to the world. iam:CreateAccessKey. Organizations changes. The list should fit on a page and page a human. Alerting on every API call is how you train people to ignore alerts. The detective controls in the security hub family can package some of this. You still need the trail underneath, because a finding without the event is a rumor.

### A worked investigation

The invoice bucket is public. You start with the time the external report arrived. In the log account you look up s3:PutBucketPolicy and s3:PutBucketAcl on that bucket. The event names the role app-deploy and the session github-main. So it was the pipeline, not a laptop. The request parameters show a policy someone committed. You do not reset passwords at random. You revert the policy, you fix the pipeline role so it cannot put a bucket policy, and you check the SCP that should have denied it. Then you look at data events, if you had them, for unexpected GetObject from outside. If you did not have data events, you say so in the incident notes. You cannot claim you know who downloaded the objects.

### Where this breaks

A trail in the same account the admin can delete, with no organization trail and no vault. Data events everywhere and a bill that gets the events turned off. A single region. Global IAM events excluded by a copy-paste. Log file validation never checked. An alarm on the trail that notifies an email nobody reads. Secrets in parameters. And a retention of a day, so the incident you notice on Monday is gone.

### How this is used at work

Security owns the organization trail and the bucket. Platform cannot stop it, because an SCP denies cloudtrail:StopLogging and the bucket is elsewhere. Application teams get read access to their own events through a filter, not the ability to delete. A change review for IAM includes the thought "this will be in the trail, and the session name must identify the human or the pipeline". After a leak of a key, the trail is how you list what the key did. If the key was used in a region without a trail, the list is incomplete and that incompleteness is the finding.

### Trail versus everything else

| Question | Record |
| Who attached this policy | CloudTrail management event |
| Did anyone GetObject last night | CloudTrail data event, if enabled |
| Did the API return 500s | CloudWatch metric |
| What was in one request | Application log |
| Is this IP mining | GuardDuty, which may use the trail |

### Retention and the question you will be asked

Someone will ask, months later, who had access when a contract changed. Management events are the cheap part of that answer. Keep them for the period the company actually needs, in a bucket with a lifecycle to a cheaper class, not deleted at thirty days because a tutorial used thirty days. Data events for every object in a busy bucket can cost more than the bucket. Turn them on for the invoice prefix, or for the trail of a sensitive bucket, and leave the static website logs to S3 access logs if those are enough. S3 server access logs are not CloudTrail. They are a different format, from the bucket, and they do not include the same identity block. Know which one you have before you promise an investigation.

Integrity checking is a command, not a feeling. Log file validation writes a digest. If you never run the validation, you will not notice a missing file until the incident. Put the check on a calendar or a pipeline in the logging account. A failed validation is a page. A trail that is logging and a bucket policy that changed are also pages, and they are management events you already have, so there is no excuse about cost. The cost excuse is real for data events and weak for "we did not notice they stopped the trail".

Look up the event name in the service's API reference when the console's wording does not match. The button Create bucket is PutBucket or CreateBucket depending on the tool. The trail has the API name. Search for that, not for the English on the button. A saved query in Athena, or in CloudWatch Logs if you sent the trail there too, is how the investigation takes minutes and not a day of downloading gzip files. Athena over the log bucket is a common pattern. The table definition is part of the logging account's code, so it still exists when you are tired.

### You can now

Explain why a multi-region organization trail in another account is the default you want. Read an event down to the role and the session name. Enable data events only where the answer is worth the bill. Alarm on a short list that includes the trail being stopped. Admit when a download cannot be investigated because the data events were off.

::: quiz
q: The application log does not say who set the bucket public. Where do you look?
+ CloudTrail, for the PutBucketPolicy or PutBucketAcl event, including the principal and session
- The CPU metric
- The VPC flow log, which records IAM principals
- The container's environment variables
why: Flow logs see packets, not API principals. CloudTrail is the API audit. The application log only knows what the application printed.
:::

::: quiz
q: A trail exists in eu-central-2 only. What can you miss?
+ API calls in every other region, including a region an attacker enabled. Use a multi-region trail
- Nothing, because IAM replicates trail events
- Only S3 data events, which are global
- Only console clicks, because the CLI is exempt
why: Trails are regional unless you ask for all regions. Unused regions are a common blind spot. IAM is a global service whose events still have to be included.
:::

::: card
q: What is the difference between a management event and a data event?
answer: Management events are control-plane actions such as creating a bucket or attaching a role. Data events are high-volume actions such as GetObject. Data events are not recorded until you enable them, and they cost more.
:::

::: predict lang=python
q: What does this print?
code:
```python
def sees(trail, region):
    if trail == 'multi' or region == 'home':
        return 'yes'
    return 'no'
print(sees('single', 'other'))
```
answer:
```text
no
```
why: A single-region trail does not see the other region. The model returns no for that pair. A multi-region trail would return yes.
:::

::: quiz
q: Why deliver the trail to a bucket in a logging account?
+ So the principal who can change production cannot also delete the record of the change
- Because CloudTrail only writes cross-account
- Because S3 refuses buckets in the same account
- Because management events require a second partition
why: Isolation is the control. A bucket the admin can empty is a trail they can switch off in practice. SCPs and a separate account make the deletion a separate privilege.
:::

::: quiz
q: The event shows an assumed role and a session name github-main. What is a fair conclusion?
+ The pipeline that uses that session name made the call. It does not by itself prove which human merged the change
- The root user did it
- GitHub was attacked, so AWS credentials do not matter
- Session names are random and can be ignored
why: Session names are a convention you set. A good convention identifies the system. The human is in the CI audit, which you still have to open. Ignoring the session name throws away the best clue.
:::

## Cost and the Well-Architected Framework
id: cost
stage: run
minutes: 40
goal: Predict the big lines on an AWS bill and cut the ones that do not buy a requirement.
needs: observe, net-edge
source: AWS Well-Architected cost optimization pillar | https://docs.aws.amazon.com/wellarchitected/latest/cost-optimization-pillar/welcome.html
source: AWS Pricing Calculator | https://calculator.aws/
source: AWS Cost Explorer | https://docs.aws.amazon.com/cost-management/latest/userguide/ce-what-is.html

Cost is a design property you can predict, not a surprise that finance discovers. The bill is dominated by a few lines. Compute that runs when nobody is using it. Managed databases that cannot scale to zero. NAT gateways, per hour and per gigabyte. Data transfer, especially out to the internet and across AZs and regions. Storage you forgot: unattached volumes, old snapshots, logs with no retention, CloudTrail data events you enabled everywhere. If you can name those, you can explain most of a small company's AWS invoice without opening a spreadsheet. The spreadsheet still matters. Cost Explorer is how you see which account, which service, and which tag. A budget alert is how you hear about it before the month ends. Neither optimizes for you.

Tags are the join key. Decide project, env, and owner before the first resource, and refuse untagged resources with a policy if you are ready for that fight. An untagged account is one number. You cannot tell the sandbox from the sale. Allocation is not optimization. It is how the right team feels the number.

Compute discounts follow the shape of the load. On-Demand for the unknown and the spiky. Savings Plans for the steady dollar-per-hour base, compute or EC2-instance depending on how sure you are that the footprint stays EC2. Reserved Instances when you need a specific reservation. Spot for work that can stop. A Savings Plan on a workload you will delete next month is a commitment, not a saving. Right-sizing comes before the commitment. A plan that covers an oversized instance commits you to the waste. Compute Optimizer and the actual utilization are the input. A weekend average that hides a flat night is still a night you might schedule off for non-production.

Data transfer is the line people do not model. Into AWS from the internet is often free. Out is not. Across AZs, traffic can be billed even when it is "inside the VPC". Across regions, replication is a bill you accepted when you chose the RPO. NAT for S3 and ECR is the avoidable one: gateway endpoints and interface endpoints have their own prices, and the gateway endpoint for S3 is the usual win. A CloudFront distribution can reduce bytes from the origin and add its own price. Model both. A chatty microservice that calls across AZs for every request is an architecture cost, and the fix might be a cache or a coarser API, not a cheaper instance.

Non-production is the easiest save. Turn it off at night if the team works days. Scale the database down. Delete the load balancer of an environment nobody uses. A schedule is code. A wiki page that says please stop the instance is not a control. Production rightsizing is the harder save, and it waits on metrics from the observe lesson. Do not resize during the incident. Do it the week after, with the graph.

The Well-Architected cost pillar is this habit turned into review questions: do you know the spend, do you match supply to demand, do you pick the right pricing model, do you manage demand and data transfer. The other five pillars are the next lesson. They are not optional context. A cheap design that drops the only copy of the data is not optimized. It is incomplete. Cost questions on the exam are usually "which option meets the constraint for less", not "which option is the smallest number on the page".

### A worked trim

A private subnet pulls images through NAT and writes logs with infinite retention. Two NAT gateways, which you keep because of the zones, and an S3 gateway endpoint you add, remove the image and object traffic from the NAT bill. ECR interface endpoints are a calculation: if the image traffic is large, the endpoint hours beat the NAT gigabytes. You do the arithmetic. Log retention goes to thirty days. The dev database stops at night. The prod API's four instances are at eight percent CPU, so you drop a size after a load test, then you consider a Savings Plan for what remains. You do not buy the plan first. The invoice the next month should show the NAT line down and the endpoint line up by less than that. If it does not, the traffic is not going through the endpoint. Check the route table.

### Where this breaks

A commitment before measurement. Spot on the database. Endpoints that cost more than the NAT they replaced, because the traffic was small. Cross-AZ chatter you never priced. A budget with no owner. Tags added after a year of resources. Turning off backups to save the snapshot line. And a "free tier" architecture that becomes the production architecture by inertia.

### How this is used at work

FinOps is a meeting where engineering brings the change that moves a line, and finance brings the number. Terraform tags every resource. A pull request that adds a NAT gateway or a cross-region replica says what it will cost. The exam's cost domain is the same muscle: reject the option that overbuys, and reject the option that saves money by dropping the requirement.

### Where the money hides

| Line | Question |
| NAT | Is S3 or ECR still going through it |
| Data transfer | Cross-AZ, cross-region, or out to users |
| Idle compute | Nights, weekends, forgotten environments |
| Commitments | Did you right-size first |
| Storage | Unattached disks, old snapshots, eternal logs |
| Requests | KMS, CloudTrail data events, high-cardinality metrics |

### A one-page estimate before you build

Write the estimate in units, not in a single monthly number you cannot defend. How many tasks, at what CPU and memory, for how many hours. How many gigabytes through NAT, and how many through a gateway endpoint instead. How many gigabytes out to users, and whether CloudFront changes that. The database instance class and the storage, and whether Multi-AZ doubles the instance hours. The log volume times the retention. KMS requests if you encrypt in the application. This page is what you compare to the first real invoice. A mismatch is a lesson: the traffic did not take the path you drew, or the dev environment ran all weekend, or you forgot cross-AZ.

The pricing calculator is a model of the public price, not a quote for your discounts, and not a substitute for reading the bill. Use it to compare two designs. Use Cost Explorer to see what you actually did. Use a budget so the comparison does not wait until someone is angry. If a number in the calculator surprises you, good. That is the time to change the design, while it is still a number and not a resource.

### You can now

Name the usual large lines on a small AWS bill. Put S3 on a gateway endpoint when NAT is hauling it. Right-size before you commit. Tag and budget so the number has an owner. Turn non-production off on a schedule. Refuse a saving that deletes the backup or the second zone the requirement needed.

If a saving needs a sentence you cannot point to in the requirement, it is not a saving. It is a different design. Say which line on the bill gets smaller and which requirement stays true. If you cannot say both, keep the current design and look for idle waste instead.

::: quiz
q: A private subnet's containers pull large images from ECR and read terabytes from S3, all through a NAT gateway. What cuts the cost?
- A bigger NAT gateway
+ VPC endpoints for S3 (gateway endpoint) and ECR, so that traffic doesn't pass through NAT
- Moving the containers to a public subnet
- Compressing the images
why: NAT charges per GB processed. Gateway endpoints for S3 are free, and interface endpoints for ECR cost far less than NAT for heavy traffic.
:::

::: card
q: Name the six pillars of the AWS Well-Architected Framework.
answer: Operational excellence, security, reliability, performance efficiency, cost optimization, sustainability.
:::

::: quiz
q: You want a discount on a steady API that is oversized. What is the order?
+ Measure and right-size, then consider a Savings Plan. Do not commit to the waste
- Buy a three-year reservation today, then look at CPU
- Move it to Spot
- Delete the second Availability Zone to halve the bill
why: A commitment covers what you run. Shrink it first if the metric says you can. Spot and dropping a zone change the reliability, which was not offered.
:::

::: card
q: Name a data-transfer path that is easy to forget inside one VPC.
answer: Traffic between Availability Zones. It can be billed per gigabyte even though both ends are private. Cross-region replication and egress to the internet are the other classic lines.
:::

::: predict lang=python
q: What does this print?
code:
```python
def order(sized):
    return 'commit' if sized else 'measure'
print(order(False))
```
answer:
```text
measure
```
why: The model will not commit until the footprint has been sized. False means you still need the metric.
:::

::: quiz
q: A dev account costs as much as prod. What is the first control?
+ A schedule that stops non-production, and a budget alert with an owner. Then look at sizes
- A Savings Plan on the dev account for three years
- Shield Advanced
- A second NAT gateway
why: Dev is often idle at night. Turning it off beats committing to it. A budget makes the next surprise loud. Shield does not shrink a dev bill.
:::

::: quiz
q: An interface endpoint for a rarely called API costs more than the NAT traffic it replaced. What do you do?
+ Remove the endpoint and keep NAT for that API. Endpoints are not free, and the arithmetic wins
- Add more endpoints until the unit price falls
- Make the subnet public
- Turn off CloudTrail to pay for the endpoint
why: PrivateLink has an hourly cost. For light traffic, NAT can be cheaper. Model it. Do not fund the endpoint by blinding the audit.
:::

## Well-Architected review
id: wa
stage: run
needs: cost, kms
minutes: 40
goal: Review a design against the six pillars and see which constraint a trade-off already chose.
source: AWS Well-Architected Framework | https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html

The Well-Architected Framework is a set of questions, not a product you install. AWS groups them into six pillars: operational excellence, security, reliability, performance efficiency, cost optimization, and sustainability. The Solutions Architect exam is built out of the first five in practice, and the official framework still includes the sixth. A design review in a company is the same list, shorter, and ruder. For each box on the diagram you ask what happens when it fails, who can reach it, how you will know, whether it is the right size, what it costs, and whether you are using more of it than the job needs.

Operational excellence is the ability to change and to run. Infrastructure as code, small deploys, a runbook, and an alarm that matches the runbook. If the only person who can deploy is on holiday, the pillar is failing even if the architecture is elegant. The observe and CloudTrail lessons are the "how you know". Terraform, next module, is the "how you change it twice".

Security is identity, network, data, and detection. Least privilege, private data subnets, encryption where you need a key policy, WAF on the real door, GuardDuty in every region, a trail you cannot delete. The pillar fails when a diagram has a lock icon and a security group of 0.0.0.0/0 on the database. Shared responsibility sits under this pillar. AWS will not configure your bucket policy.

Reliability is recovery. Two zones, a health check, a queue, a backup you have restored, a DR strategy that matches the RTO, a drill. It fails when Multi-AZ is the answer to a dropped table, or when the minimum capacity is one. The reliability pillar's questions are the ha and dr lessons in review form.

Performance efficiency is the right resource, not the largest. The database that matches the query. The cache that is allowed to miss. The placement close to the user when latency is a requirement. A review fails when every workload is an EC2 instance because that is the icon the tool had, or when a scan of DynamoDB is the API. It also fails when you over-shard and over-cache a problem that a single Postgres index would solve.

Cost optimization is the previous lesson. The review question is whether the spend buys a requirement. Sustainability is the newer pillar: the same work with fewer resources. In practice it overlaps cost and performance. A right-sized instance and a lifecycle to a colder storage class are both. You do not need a separate product to take it seriously, and you should not claim a number you did not measure.

The trade-off is the exam. A more reliable design can cost more. A cheaper design can raise the RPO. A more secure design can add a step that hurts latency. The question states which constraint wins. If it says "most cost-effective" and also states an RPO, the cheapest option that misses the RPO is wrong. If it says "operational overhead must be minimal", the option where you patch a fleet is wrong even if it is cheaper. Read the constraint twice. Then eliminate options that violate it, before you fall in love with a service name.

### A worked review

The invoicing design: two zones, Fargate, private tasks, Multi-AZ Postgres, private bucket, presigned URLs, a budget, a trail in the log account, alarms on 5xx and queue age. Operational excellence: Terraform and a pipeline, or it fails this pillar no matter how nice the VPC is. Security: the task role is narrow, the bucket is not public, the database has no public route. Reliability: a zone failure is covered, a region failure is accepted in writing, backups are drilled. Performance: Postgres matches the queries, the PDF is not in the database. Cost: NAT is not hauling S3, dev sleeps at night. Sustainability: the same choices, said without pretending you computed grams of carbon from a feeling. The review's action items are the gaps, dated, not a score.

### Where this breaks

Using the pillars as a bingo card of services. "We have CloudFront, so performance is done." Treating sustainability as a slogan. A review that never looks at the bill or the trail. Copying a reference architecture that does not match the constraint. And arguing the pillar instead of naming the requirement the design missed.

### How this is used at work

A one-hour review before a launch, with the diagram and the bill estimate on the table. Each pillar gets a few questions, not a workshop. Findings are tickets. The exam domains that follow are the pillars turned into scenario questions: secure, resilient, high-performing, cost-optimized. Operational excellence is woven through them. When you practise, say which pillar the question is really testing. It stops you from picking the security answer on a cost question.

### The six questions

| Pillar | Ask |
| Operational excellence | Can we deploy, observe, and fix this on a Tuesday |
| Security | Who can reach it, and how do we know they did |
| Reliability | What fails, and what is the RTO and RPO |
| Performance efficiency | Is this the right service and size for the access pattern |
| Cost optimization | What does this line buy, and can we meet the requirement for less |
| Sustainability | Can the same job use less |

### How a review meeting actually runs

Put the diagram on one page. Under it, write the requirements that are not negotiable: residency, RPO, RTO, who the users are, and what must not be public. Then walk the pillars in order and write gaps as sentences, not as products. "No one has restored the database" is a gap. "Buy AWS Backup" is a possible fix you pick after. Limit the meeting. An hour that produces three tickets beats an afternoon that produces a new reference architecture nobody will build. Revisit the tickets when the drill or the bill proves them done.

The exam questions in the next lessons are the same meeting, compressed. The stem is the requirement. The wrong options are pillar answers to a different question: a security control when the stem asked for the cheapest design that still meets the RPO, or a second region when the stem only asked to survive a zone. Say the pillar first, then eliminate. If two options meet the constraint, pick the one the stem's adverb asks for, usually least operational overhead or most cost-effective. Do not add a requirement the stem did not write.

Bring the last invoice and the last incident to the review. A pillar discussion with neither is a debate club. The invoice shows which cost comments are real. The incident shows which reliability comments are theories. If you have not had an incident, bring the last drill result, including a drill that failed. A failed drill is a successful review input.

### You can now

Name the six pillars and one question each. Review a design without turning it into a shopping list. Spot a trade-off the question already resolved. Point a gap at the lesson that fixes it: IAM, network, data, backup, alarms, or the bill. Use the same list in the scenario practice that follows.

::: quiz
q: A design is cheap because it runs in one zone and has no backups. Which pillar is the reason to reject it, if the requirement is to survive a zone loss?
+ Reliability. The cost pillar does not outrank a requirement the question already stated
- Cost optimization, because cheap is the goal of the framework
- Sustainability, because one zone uses less power
- Operational excellence, because one zone is easier to operate
why: The framework is trade-offs under constraints. A stated availability requirement beats a lower bill. One zone can be the right answer only when the requirement allows it.
:::

::: card
q: Name the six pillars of the AWS Well-Architected Framework.
answer: Operational excellence, security, reliability, performance efficiency, cost optimization, and sustainability.
:::

::: quiz
q: The team can deploy only by SSHing and editing a file. The diagram is Multi-AZ and least privilege. What is still weak?
+ Operational excellence. You cannot change or recover in a repeatable way
- Performance efficiency, because SSH is slow
- Cost, because SSH is free
- Nothing, if the pillars about security and reliability pass
why: A design you cannot deploy safely fails operational excellence even when the static picture looks resilient. The run and the change are part of the review.
:::

::: predict lang=python
q: What does this print?
code:
```python
def reject(requirement, design):
    if requirement == 'two-az' and design == 'one-az':
        return 'reliability'
    return 'ok'
print(reject('two-az', 'one-az'))
```
answer:
```text
reliability
```
why: The model names the pillar the design misses. Meeting a cost goal would not change this pair.
:::

::: quiz
q: Which review comment is a shopping list, not a pillar?
+ Add CloudFront, GuardDuty, and Aurora because mature systems have them
- The database is public. Close it
- There is no alarm on error rate
- The RPO is untested
why: Naming products without a gap is not a review. The other comments each point at a failed question: exposure, detection, and a recovery you have not proved.
:::

::: quiz
q: Sustainability on this path mostly means what?
+ Doing the same work with fewer resources, which overlaps right-sizing and storage lifecycle. It is not a second bill and not a slogan
- Always choosing the cheapest region even when residency forbids it
- Disabling backups
- Buying carbon offsets in the console as the architecture
why: The pillar is efficiency. Residency and durability constraints still win. You do not measure it by how many green icons are on the slide.
:::

## Project: design a web app on AWS
id: p-design
stage: run
minutes: 75
goal: Make the decisions an architect makes for a real brief, then write the app's IAM policy.
needs: cost, ha
project: yes

A Swiss client wants a B2B invoicing app. The API is a container. The database is Postgres. Users download PDF invoices. A nightly job emails reminders. Data must stay in Switzerland, including backups and keys. Traffic is modest and must survive a data-centre failure. The team is small and has no one to run a cluster or to patch a pet server. Losing the whole region is acceptable only if someone has written the RTO down. This project is that decision, then the API's permissions.

Plan on about 75 minutes. The first questions are the architecture. The last original step is the task role policy, and the checker is strict about wildcards. Later review sessions show the questions without this page, so each question repeats the constraint it cares about.

### Requirements

- Region where the data can legally sit. Encryption is not a region.
- API containers in more than one Availability Zone, on a managed container service, private subnets, a load balancer in public subnets.
- PDFs in a private versioned bucket. The API checks the caller and returns a short-lived presigned URL.
- The nightly job is a schedule that starts work, not a cron inside every replica of the API.
- The task role can read and write only the invoice prefix, and can read only the one database secret.
- You can say what a zone failure does, and what a region failure does not do.

### How this is graded

The multiple-choice steps check the region, the compute, the bucket, and the schedule. The policy step checks the JSON the checker parses: no wildcard actions, no resource of star, the prefix ARN, and the secret ARN. A policy that "works" by allowing s3 star is a fail even if a real account would accept it. The extra questions check that you know this design's limit. The checker does not call AWS.

### Where a pass still fails in real life

You have not drawn the subnets, set a budget, or restored a snapshot. Passing means the decisions match the brief. The clinic project and the exam set are the same kind of judgement on new stems. Terraform is where these choices become a plan you can apply twice.

### Working this brief in order

The Swiss clause is the first filter. Zurich is the region that matches Switzerland, and only if the services you named exist there. Frankfurt is closer to a lot of tutorials and wrong for this contract. A global bucket name does not put the PDFs in Switzerland. A KMS key in another region does not either. Backups and logs are data. Write them in the same place unless the contract says otherwise.

The team is the second filter. They will not patch a pet server and they will not run a control plane. A managed container service in two zones is the compute. The load balancer is the front door. The tasks do not hold the PDFs and do not hold the sessions. You have already seen what happens when they do. The nightly reminder is a schedule that starts one piece of work. It is not a line in a container that exists three times.

The policy is the third filter, and it is the step the checker grades most literally. One prefix. One secret. Two statements. A star is a fail. If you are unsure which ARN ListBucket uses, this policy does not ask for ListBucket. It asks for get and put on the prefix and a read of the secret. Do not add actions to be helpful. Helpful actions are how the role grows.

Say the limit out loud when you finish. A zone can fail. The region can still take the app with it. Users get a presigned URL that expires. They do not get a public bucket. The reminder runs once. That is the design. Anything you add, a second region, a cluster, a star in the policy, needs a sentence in the brief that you do not have.


### What each original question is forcing

The region question is residency. If you pick Frankfurt because it is familiar, you have decided the contract does not matter. The compute question is operational load plus a zone failure. EKS fails the first. One VM fails the second. Lambda waiting on a long render fails the timeout lesson. The bucket question is authorization. A public bucket with random names fails it. Bytes in Postgres fail the storage lesson and the backup size. A presigned URL after a check is the small door. The schedule question is "how many times does this run". Cron inside a scaled service runs once per task. A scheduler runs the job you defined.

The policy question is least privilege with the ARNs written out. Get and put on the prefix. GetSecretValue on the one secret. Version 2012-10-17 because that is the policy language, not because it is the year of the invoice. If the checker complains about a star, you still have a star, including a star hiding in an action array. If it complains about the secret ARN, compare the region and the account in the brief to the string you typed. IAM itself is not regional. The secret is.

### After you pass

Draw the trust you did not write. The task role needs a trust that lets ECS assume it. You did not get a step for that, and it is still required in a real account. Draw the security group you did not write. The database allows the task's group, not the VPC. Draw the alarm you would add. 5xx and the job's failure, not CPU. When those three are easy, the brief is actually done, whether or not the checker already said yes. Take the same three questions to the clinic project and to the mixed exam set. The names change. The filters do not.

A passing policy that you cannot explain is a fail you will not see until review week. Say the two resources out loud without looking. If you have to open the solution, you copied. Do the step again from an empty file. The hint is there after you are stuck, not before you have named the prefix.


### A review you can rehearse

Read the design to a skeptical teammate. They ask where the PDFs are. You say a private bucket in Zurich, versioned, presigned. They ask what happens if a zone dies. You say the other zone's tasks and the Multi-AZ database. They ask what happens if Zurich dies. You say the written RTO, not a second zone. They ask who can delete the bucket. You say not the task role, and the trail is outside the app's power to switch off, which is the account lesson even though this exercise stops at the policy. If you cannot answer one of those in a sentence, you are not done with the brief. The checker will not ask in that voice. A person will.

Keep the policy and the picture consistent. A role that can only touch invoices/ should not be drawn with an arrow to the whole account. A schedule that runs once should not be drawn inside the service box. A region name on the database and a different region on the secret ARN is a bug the checker is trying to catch. Look at the region string twice. Switzerland is the constraint. The ARN is where you prove you meant it.

::: quiz
q: Which region?
- `eu-central-1` (Frankfurt), it's the closest big region
+ `eu-central-2` (Zurich), because data must stay in Switzerland
- `us-east-1`, it has every service first
- Any, data residency is handled by encryption
why: Residency requirements decide the region. Check that every service you need is available there before committing.
:::

::: quiz
q: Where does the API container run?
+ ECS on Fargate in private subnets across two AZs, behind an ALB in public subnets
- One EC2 instance with Docker installed
- EKS, so it's future-proof
- Lambda, with the container image, running 24/7
why: Containerized, modest traffic, no ops staff, must survive an AZ failure: managed containers in two AZs behind a load balancer. EKS adds work this team doesn't need.
:::

::: quiz
q: Where do the invoice PDFs go, and how do users download them?
- On the container's disk, served by the API
- In Postgres as binary columns
+ A private S3 bucket with versioning; the API checks the user's access and returns a presigned URL
- A public S3 bucket with random file names
why: Durable, cheap, private. The API stays the gatekeeper; S3 serves the bytes.
:::

::: quiz
q: The nightly reminder job?
+ An EventBridge Scheduler rule that starts a Fargate task (or a Lambda if it finishes well within 15 minutes)
- A cron entry inside the API container
- A developer's laptop with a cron job
- An EC2 instance running all day for a nightly script
why: The scheduler is managed and runs the job only when needed. Cron inside a multi-instance service would run once per instance, or not at all after a redeploy.
:::

::: config lang=json
task: Write the API task role's policy: read and write objects only under `invoices/` in bucket `acme-invoices-ch` (`s3:GetObject`, `s3:PutObject`), read the one secret `arn:aws:secretsmanager:eu-central-2:123456789012:secret:invoicing/db-*` (`secretsmanager:GetSecretValue`), and nothing else. No wildcards in actions; no `"Resource": "*"`.
starter:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:*", "secretsmanager:*"], "Resource": "*" }
  ]
}
```
check: Version = 2012-10-17 | Version is 2012-10-17
check: Statement[*].Action !~ /\*/ | No wildcard actions
check: Statement[*].Resource !~ /^"?\*"?$/ | No Resource of just *
check: Statement ~ /"s3:GetObject"/ | Allows s3:GetObject
check: Statement ~ /"s3:PutObject"/ | Allows s3:PutObject
check: Statement ~ /"arn:aws:s3:::acme-invoices-ch\/invoices\/\*"/ | S3 access is limited to acme-invoices-ch/invoices/*
check: Statement ~ /"secretsmanager:GetSecretValue"/ | Allows secretsmanager:GetSecretValue
check: Statement ~ /"arn:aws:secretsmanager:eu-central-2:123456789012:secret:invoicing\/db-\*"/ | …on the invoicing/db secret only
check: Statement !~ /DeleteObject|PutBucket|CreateSecret/ | Nothing beyond what was asked
solution:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::acme-invoices-ch/invoices/*"
    },
    {
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": "arn:aws:secretsmanager:eu-central-2:123456789012:secret:invoicing/db-*"
    }
  ]
}
```
hint: Two statements, one per service, each with its exact actions and its own resource ARN.
:::

::: quiz
q: This invoicing design is Multi-AZ in Zurich. A regional outage takes the region offline. What is already true?
+ The design does not cover that outage. Surviving it would be a second region or a rebuild you have not built here
- Two zones are in two regions, so the region cannot fail
- The presigned URLs keep working because S3 is global
- The nightly cron on the container retries in another country
why: Zones are inside one region. A global bucket name is not a second copy. The schedule does not imply a second region.
:::

::: card
q: Why is a cron entry inside the API container the wrong nightly job?
answer: A service with more than one task would run it more than once, and a redeploy can skip it. A scheduler that starts a single task or function runs the job once, outside the request path.
:::

::: quiz
q: The task role's policy allows s3 star on star and secretsmanager star on star. Why does the exercise reject it?
+ The brief asked for one prefix and one secret. A star meets a demo and fails least privilege, which is the point of the policy step
- Because AWS rejects all policies that contain s3
- Because the region is wrong inside IAM, and IAM is regional
- Because presigned URLs require a deny on GetObject
why: The checker is enforcing the brief, not a fictional AWS syntax rule. IAM is global in the account. Presigned URLs need GetObject, scoped, not a deny.
:::

## Design secure architectures
id: saa-secure
stage: exam
needs: wa, detect, iam-deep
minutes: 50
goal: Answer secure-architecture scenarios by naming the principal and the smallest control that meets the stem.
source: SAA-C03 exam guide | https://docs.aws.amazon.com/aws-certification/latest/solutions-architect-associate-03/solutions-architect-associate-03.html
source: Well-Architected security pillar | https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/welcome.html

This lesson is how to answer SAA-C03 questions in the secure architectures domain, which the exam guide weights at 30 percent of scored content. The facts are the earlier lessons. The skill here is reading a stem until the constraint is louder than the product name. Security questions are the largest share. They are still questions about a specific control, not an invitation to add every security service.

Read the stem once for the situation and once for the words that decide: most cost-effective, least operational overhead, highly available, lowest latency, must not be public, company employees, customers of the application, already uses, cannot change. Those words delete options. An option that is more secure and misses "most cost-effective" is wrong. An option that is cheaper and misses the RPO is wrong. An option that introduces a service the company said they will not operate is wrong if another option meets the goal with managed services.

Eliminate in order. First, drop anything that violates a hard constraint, including residency and "no long-lived keys". Second, drop anything that does not actually do the job, such as a cache that does not restore a deleted database, or a WAF that does not see the bypass. Third, among the survivors, apply the adverb. If two survive, you misread one of them. Check cross-account, synchronous versus asynchronous, and who the principal is.

The questions below are in the exam's shape: a situation, four plausible designs, one that fits. They are not trivia about default limits. When you miss one, write down which constraint you skipped. That note is the study plan. The mixed set at the end of the module is the same skill without the domain label on the door.

### What this domain is really asking

Secure access means the principal is right: Identity Center for employees, roles for workloads, no root, no access keys in code, a trust policy that names who may assume, a permission boundary or an SCP when the stem is about a maximum rather than a grant. Secure workloads means the network: private subnets, security groups that reference other groups, no 0.0.0.0/0 on the database, WAF on the door users actually use, PrivateLink or a gateway endpoint when the stem says traffic must not go over the internet. Data protection means the bucket is not public, the key policy allows the role, Secrets Manager holds the password, and logs and backups are in scope if the stem mentions them. Detective controls appear when the stem asks how you will know: CloudTrail, GuardDuty, not a hope.

The tempting wrong answer is usually more machinery. A customer managed key when SSE-S3 already meets "encrypted at rest" and nobody asked to control the key. GuardDuty when the stem asks to prevent, not detect. An identity pool for users who only need to call your API. A VPN when a private endpoint would do. Read "prevent" and "detect" as different verbs.

### A stem you can dissect

"A partner account must upload to one prefix nightly. No long-lived keys. You must be able to see the calls." The partner assumes a role. The trust names their role and an external id. The identity policy on that role allows s3:PutObject on the prefix. CloudTrail data events, or at least the management events plus S3 access logging if the stem accepts it, provide the record. An IAM user with a key fails "no long-lived keys". A public bucket fails least privilege. A bucket policy with Principal star fails it too. The correct option is the role, even if another option mentions KMS and sounds more serious.

### Walking the options without collecting services

Take a stem about a database password in a task definition. The options will include: leave it, because the security group is private; move it to Secrets Manager and scope the task role; encrypt it with a customer managed key and commit the ciphertext; put it in an S3 bucket with Block Public Access off so the task can read it. The private security group does not protect a secret that is in the template, in state, and in the console. The ciphertext in git is a secret with extra steps, and rotation is now your homework. The public bucket is a second incident. Secrets Manager is the option that matches the requirement with the least new risk. If the stem also says the auditor must disable the vendor tomorrow, the key policy joins the answer. If the stem does not say that, do not drag KMS in to sound thorough.

Take a stem about a CI system in another account that deploys into yours. The wrong options are an access key in the CI variables, a trust policy of Principal star, and an SCP that grants deploy rights. The SCP cannot grant. The star trust is a public role. The key is long-lived. The fit is OIDC or a cross-account role with a trust that names the other side and a condition on the subject or external id, plus a narrow identity policy. You already did this in the IAM lessons. The exam only hides it inside a paragraph about a company that "wants to modernize".

Take a stem that says the data must stay in a country and the logs must be included. The option that replicates the bucket to another region for "durability" fails even if the replication is technically a fine feature. Durability inside the region is already the S3 story. The extra region is a residency bug. The option that encrypts and then replicates still replicates. Encryption is not a location.

### Common secure distractors

A distractor that adds GuardDuty when the stem asked how to stop a principal is the detect-versus-prevent swap. A distractor that adds WAF when the traffic is a private VPC endpoint is a tool on the wrong path. A distractor that uses a NACL as the main design, with a security group left open, is the stateless firewall you will misconfigure. A distractor that puts the application in the management account so "the SCP protects it" has the SCP fact backwards: the management account is exactly where the SCP does not apply. When you see the management account used as a place to run workloads, it is almost always the wrong option.

Write the principal in the margin. Employee, customer, task, partner account, root. Then write the verb. Prevent, detect, rotate, confine to a prefix, confine to a region. The option that does that verb for that principal wins. The option that does a different verb for a different principal is the long paragraph you were afraid to cross out.

If you are down to two options that both seem secure, check the blast radius. One option grants the action on star. The other names an ARN. The named ARN wins unless the stem says the set of resources changes every minute and a tag condition is the point. Check the account boundary next. A role in the application account that can delete the log archive is worse than a slightly wider read in the application account. The exam will not always say least privilege. It will describe a breach and ask which design would have contained it. Containment is a boundary: account, key policy, security group, or SCP. Pick the boundary that matches the attacker in the stem, who is often a stolen application role, not a stranger on the internet.

### You can now

Name the principal the stem is talking about before you look at the options. Separate prevent from detect. Reject a public bucket, a long-lived key, and a database on the internet. Prefer the smallest control that meets the written requirement.

::: quiz
q: A company's employees need administrative access to a new account for a week-long incident, and the security team forbids long-lived access keys. Which design meets that?
+ IAM Identity Center permission set that lets the incident group assume a role in that account, with a session that expires
- Create an IAM user, generate an access key, and share it in the incident channel
- Give them the root password with MFA, because root is already monitored
- Attach AdministratorAccess to the EC2 instance profile and let them SSH
why: People should get temporary credentials through Identity Center. A shared key and the root password are standing or oversized credentials. An instance profile is for the instance, not for a human incident.
:::

::: quiz
q: An application in a private subnet must read one S3 bucket without using a NAT gateway. Security requires the data not to traverse the public internet. What do you add?
+ A gateway VPC endpoint for S3, and a bucket policy that still names the role
- A public IP on the instances, with a security group allowing 443 from the bucket
- AWS Shield Advanced in front of the bucket
- A NAT gateway, because NAT is private
why: The S3 gateway endpoint keeps the traffic on the AWS network and off NAT. A public IP is the opposite of the requirement. Shield does not change the path. NAT still sends traffic through a public service path you were told to avoid, and it is the wrong tool here.
:::

::: quiz
q: A bucket must be encrypted, and security must be able to disable decryption for a vendor's role without editing the application. What meets that?
+ A customer managed KMS key, with the vendor's decrypt permission only on that key, so disabling or denying the key stops them
- SSE-S3, because encryption is on by default and that is the same control
- An S3 lifecycle rule that moves objects to Glacier
- A resource control that turns off TLS
why: SSE-S3 does not give you a key policy you can use as a kill switch for one principal. A customer managed key does. Glacier and TLS do not remove decrypt permission.
:::

::: quiz
q: GuardDuty reports that a role called iam:CreateUser from an unusual IP. What does the finding do, and what should already exist?
+ It only reports. The useful design is a trail you can read and a runbook that can revoke the role. GuardDuty does not undo the user
- GuardDuty deletes the user automatically in every configuration
- Turn GuardDuty off to stop the API call
- Add a NACL on the IAM service
why: Detection is not prevention. The stem's value is the response you prepared. There is no NACL in front of the IAM API.
:::

::: quiz
q: Customers of a web app must sign in. The API should authorize them. Nobody wants customers to hold AWS credentials. Which service fits?
+ A Cognito user pool, or another OIDC issuer, with the API verifying the token. No identity pool
- IAM users created per customer
- A Cognito identity pool that hands each customer an AdministratorAccess role
- Root access keys stored in the mobile app
why: User pools authenticate application users. Identity pools that mint AWS credentials are for a different problem. Customers are not IAM users, and they are not root.
:::

::: quiz
q: A workload role can be assumed by any principal in the account because the trust policy uses a wildcard principal. What is the fix?
+ Name the specific principal, such as the CI OIDC subject or the ECS service with a condition, and remove the wildcard
- Add an SCP that allows sts:AssumeRole, because that narrows the trust
- Turn on S3 Block Public Access
- Encrypt the trust policy with KMS
why: The trust policy is who may assume. A wildcard is too wide. An SCP cannot replace a narrow trust, and it does not grant. Block Public Access and KMS do not edit the trust.
:::

::: quiz
q: The company wants to stop member accounts from disabling CloudTrail, including their administrators. Where does the control go?
+ An SCP on the organization, denying the stop and delete actions, with the trail delivered outside the member account
- A note in the Well-Architected review
- An IAM policy on one role, which an administrator can detach
- A budget alert
why: SCPs cap member-account principals, including admins. An IAM policy they can detach does not. A budget does not protect logs. The bucket should also live where they cannot delete it.
:::

## Design resilient architectures
id: saa-resilient
stage: exam
needs: wa, dr
minutes: 50
goal: Match the failure in the stem to Multi-AZ, a queue, a backup, or a real cross-region strategy.
source: SAA-C03 exam guide | https://docs.aws.amazon.com/aws-certification/latest/solutions-architect-associate-03/solutions-architect-associate-03.html
source: Disaster recovery on AWS | https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-workloads-on-aws.html

Resilient-architecture questions are about 26 percent of scored SAA-C03 content. They ask what still works when a named thing fails, and how much data you lose. The name of the failure is the whole question. An Availability Zone, a region, a dropped table, a spike, and a bad deploy are five different answers. Options that solve a different failure are the distractors, and they are real designs, which is why they tempt you.

Match the failure before you match the product. One instance dies: more than one instance, a health check, a load balancer. One zone dies: two zones and a Multi-AZ or Aurora data layer, stateless compute. The region dies: a second region and a strategy you can name, backup and restore or pilot light or warm standby or active-active, plus DNS. A table is dropped: a backup or point-in-time, not a failover, because the standby dropped it too. Traffic spikes: a queue or stateless scale-out, with a cap. A message is delivered twice: idempotency, not a bigger instance.

Loose coupling is the other half of this domain. SQS between the API and the slow work. SNS or EventBridge when several consumers need the fact. Step Functions when the steps have an order. A single function that calls three vendors and fails if any fails is the coupled design the stem is trying to leave. A queue does not make a synchronous payment asynchronous. Read whether the user is waiting.

The adverb is often "least time to recover" or "most cost-effective given this RTO". Active-active is not the answer to an eight-hour RTO. Two zones are not the answer to a regional RPO. A read replica is not the answer to a zone failure of the writer unless the stem says you will promote it, and promotion is a plan, not a health check.

### Three failures, three answers, no mixing

A stem about a single Availability Zone power event wants a second zone and a data layer that fails over with it. The option that adds a second region is not more correct. It is a different project, with lag and a DNS plan the stem did not ask for, and if the stem says most cost-effective it is wrong. The option that only adds a bigger instance is how you buy a faster outage. The option that adds a read replica and calls it failover is the vocabulary trap. A replica can be promoted. If the option does not say promote, and does not say Multi-AZ, it is a reader.

A stem about a region outage wants a strategy whose RTO you can stand next to the number in the stem. If they can wait a day, recreating from backups is enough and you should not pay for warm capacity. If they can wait an hour and cannot lose data from the last minutes, you are looking at replication that is actually that fresh, not at a snapshot from last night. If they say zero data loss across regions, be suspicious. Synchronous cross-region writes are rare in these questions. The honest option may be to say the requirement is not met by the replica they have, which is a valid answer when one of the choices is "the current design does not meet the RPO".

A stem about a spike wants a buffer or a scale-out of stateless workers. The database remaining the bottleneck is the follow-on. A correct queue with a consumer that opens a new connection per message and has no cap will fall over one box to the right. If an option includes the queue and a cap and idempotency, it is thinking about the spike. If it includes only Auto Scaling on CPU of a server that stores sessions in memory, it is the outage from the availability lesson, dressed up as elasticity.

### Loose coupling is a sentence

Say what is allowed to be late. Email, thumbnail, report, webhook to a partner: late. Card authorization the user is staring at: not late. The option that queues the authorization and returns success immediately has lied to the user. The option that queues the email and returns the order id is the design. Step Functions appears when the stem has steps, a wait, or a human approval. It is the wrong box when the stem is only "absorb a burst". SQS is that box. EventBridge appears when the stem is "when this happens, these independent systems should hear it". SNS is the same idea with a slightly different shape. You do not need both unless the option is doing something specific with each.

Drills show up as "which process improves resilience" with an answer that is "regularly restore and regularly fail over", not "buy a larger instance and document it". A runbook that has never been run is not a control. The exam likes the option where you test failure, because the reliability pillar likes it, because it is the only evidence.

### What "highly available" is allowed to mean

Inside these questions, highly available without a number usually means more than one Availability Zone, a load balancer or an equivalent managed front, and a data service that fails over inside the region. It does not mean two regions. If they wanted two regions they would mention a regional outage, a disaster, or an RTO that one region cannot meet. Fault tolerant is stronger than highly available in some stems: the user should not notice. That pushes you toward a standby that is already warm, or toward a managed service whose failover is short, and away from "we will restore from backup". Scalable is not a synonym. A design can scale in one zone and still be a single point of failure. When the stem says both scalable and highly available, you need the queue or the Auto Scaling group and the second zone. One of them is not a substitute for the other.

Also watch the health check. An option that adds instances and a load balancer but checks a path that never fails is not highly available in practice. The exam sometimes offers "use ELB health checks so unhealthy instances are replaced" against "use EC2 status checks only". You know which one sees a dead process. Choose the one that sees the failure the stem described, not the one that sees a powered-off machine only.

When the stem offers both a managed failover and a self-built script that rewrites DNS, prefer the managed failover if the RTO is short and the script is something the team must operate. Prefer the script only when the stem says the managed option cannot see the failure, which is rare. A Route 53 health check in front of a single instance is not a second instance. It is a faster way to notice you are down. Pair the check with a real second target or it is an alarm, and alarms belong to operational excellence more than to this recovery.

### You can now

Underline the failure in the stem. Reject a design that solves a different failure. Name RPO and RTO in words before you pick pilot light or active-active. Ask whether the consumer can see the same message twice.

::: quiz
q: Orders are written to a single RDS instance in one zone. The company can tolerate a few minutes of failover and no data loss when a zone fails. What meets that?
+ Multi-AZ RDS, or Aurora, so a standby in another zone takes over with synchronous replication
- A read replica in the same zone
- More CPU on the one instance
- A nightly snapshot only
why: A zone failure needs a synchronous copy in another zone. A replica is asynchronous and is not, by itself, failover. A snapshot is an RPO of a day. CPU does not add a zone.
:::

::: quiz
q: The same company now says a whole region can be down for a day and they can lose an hour of data. They want the cheapest honest option. What fits?
+ Backup and restore into the other region, practised, with backups at least hourly. Not a second live stack
- Active-active in two regions
- Two more Availability Zones in the first region
- A CloudFront distribution in front of the single instance
why: A one-day RTO and one-hour RPO is backup and restore if the backups are fresh enough. Active-active overbuys. More zones do not survive the region. CloudFront does not restore a database.
:::

::: quiz
q: During a product launch the checkout API times out because the email provider is slow. Orders themselves are fine. How do you decouple this?
+ Accept the order, and send the email from a queue consumer. The user does not wait on the provider
- Put CloudFront in front of the email provider
- Scale the API tasks without a timeout change
- Store the order only in ElastiCache
why: The slow dependency should leave the request path. A queue is the buffer. Caching the order as the only copy is a different outage. Scaling the wait makes a more expensive wait.
:::

::: quiz
q: A consumer writes a row and then fails before deleting the SQS message. What must the design include?
+ An idempotent write, so the redelivery does not create a second row. A dead-letter queue for messages that fail for good
- A FIFO queue, which removes the need for idempotency in all cases
- A shorter visibility timeout so the message is deleted sooner
- Multi-AZ on the queue's consumer only
why: Redelivery is normal. FIFO deduplication is not a blanket substitute for an idempotent write. A shorter visibility timeout causes more duplicates. The dead-letter queue is how poison messages stop cycling.
:::

::: quiz
q: Aurora Global Database replica lag is eight minutes. Finance requires an RPO of one minute for a regional failure. What is true?
+ This replica does not meet the RPO. You need a tighter replication design or a changed requirement, not a DNS failover on top
- Failing over meets a one-minute RPO because Aurora stores six copies
- Route 53 health checks shrink replica lag
- A read replica in the same region fixes the cross-region RPO
why: The lag is the data you can lose. Six copies are inside the primary region. DNS does not make replication faster. A same-region replica does not help when the region is the failure.
:::

::: quiz
q: A deploy replaces all tasks at once and users see errors for two minutes. The tasks are stateless and behind a load balancer. What is the resilient deploy?
+ A rolling or refresh strategy that keeps a minimum healthy count, and a health check that can fail the new tasks
- Sticky sessions so each user stays on a dead task
- A single task, so there is nothing to overlap
- Disable the health check so the deploy looks green
why: Overlap healthy capacity. Sticky sessions and a disabled health check hide the bad revision. One task cannot overlap itself.
:::

::: quiz
q: Someone drops a table on a Multi-AZ database. Failover completes. What do users get?
+ The same dropped table. Restore from a point in time or a snapshot taken before the drop
- The table, because Multi-AZ is a backup
- An empty standby that never received the drop
- Automatic undo from the read replica, even if you did not create one
why: Synchronous replication copies the mistake. Failover is the wrong tool. Recovery is a backup from before the drop.
:::

## Design high-performing architectures
id: saa-perform
stage: exam
needs: wa, databases, net-edge
minutes: 50
goal: Pick the storage, compute, database, and network that match the bottleneck in the stem.
source: SAA-C03 exam guide | https://docs.aws.amazon.com/aws-certification/latest/solutions-architect-associate-03/solutions-architect-associate-03.html
source: Performance efficiency pillar | https://docs.aws.amazon.com/wellarchitected/latest/performance-efficiency-pillar/welcome.html

High-performing questions are about 24 percent of scored content. They ask for the resource that makes the access pattern fast enough, not the resource that is newest. Storage, compute, database, network, and ingestion are the official slices. In practice the stem names a bottleneck: large objects, a hot key, a chatty cross-AZ call, a report that joins, a global user base, a burst of writes.

Storage performance is the class and the pattern. S3 for objects, with a class that matches how soon you must read them. Glacier is the wrong answer when the stem says retrieval in milliseconds. EBS when one instance needs a disk and you can name the IOPS. EFS when many clients need the same files. A cache when the same read happens constantly and staleness is allowed.

Compute performance is the shape. Lambda for short parallel bursts, remembering cold starts and the timeout. Fargate or EC2 when the job is long or steady. Placement in the region of the users when the stem is about latency and the data can live there. A bigger instance is the wrong answer when the bottleneck is a lock in the database.

Database performance is the access pattern again. An index or a replica for read-heavy SQL. Aurora when the stem wants readers and fast failover and accepts the cost. DynamoDB when the stem has a known key and a huge rate, and not when the stem has ad-hoc SQL. ElastiCache when the stem says the database is melting under repeated reads. DAX is the DynamoDB-specific cache, not a general excuse to skip key design. A hot partition is fixed by a better key, not by a wish.

Network performance is distance and chatter. CloudFront for cacheable content close to users. Global Accelerator or latency-based DNS when you have more than one region that can serve. Direct Connect when the stem is a steady office or data-center link and a VPN is not enough. Fewer round trips beat a larger instance.

Ingestion is Kinesis or a queue or Firehose when the stem is a stream, not a database insert per event from a fleet that cannot keep up. Do not introduce a stream for a nightly file. A nightly file is S3 and a batch job.

### Bottlenecks the stem is hinting at

If the stem says the same bytes are fetched by many users far away, the bottleneck is distance and repeated origin reads. CloudFront, or a cache, is the family of answers. A bigger origin is the distractor. If the stem says the bytes are unique per user and must be fresh, caching is the distractor and you place the compute near the user or you reduce the round trips. Read "personalized" as a warning against a shared cache key that would leak one user's response to another. That is a performance question that is also a security question. The secure option wins if the cached design is wrong. The fast option wins if the cache key is actually safe and the stem asked for latency.

If the stem says a key-value lookup at a huge rate, DynamoDB is the family, and the follow-on is the partition key. If the stem says the workload is analytical and the queries change, the family is a warehouse or at least SQL, and DynamoDB is the distractor that sounded scalable. If the stem says the database CPU is high and the queries are the same SELECT, a cache or a replica is the family. If the stem says writes are slow because of a lock, a replica does not take the write. Read replicas do not make commits faster.

If the stem says a job runs for an hour, you are not in synchronous Lambda. If the stem says a job runs for 30 milliseconds on every upload, you are not in a dedicated instance that idles. Performance and cost agree there. The domain label tells you which adverb to weight if they ever diverge. In this domain, latency and throughput win ties. In the cost domain, the bill wins ties. The stem still has to meet the minimum bar of actually working.

### Ingestion without a science project

A steady drip of events wants a buffer so the database sees batches. The option that introduces three buses and a fan-out to five consumers, when the stem has one consumer and a nightly report, is overbuilding. The option that has each client write straight into the warehouse will show up as "throttling" or "connection storms" in the stem you get next. Firehose, Kinesis, or SQS into a batch writer are enough vocabulary. You do not need to recite shard counts. You need to know that a shard or a partition exists and that a single hot producer will hurt.

Placement is a performance control. Putting the API in Ireland and the database in Virginia because the tutorial was in Virginia is a latency bug. The stem that says "users in one country" and "data must stay there" has already picked the region. Your job is not to add a global table. Your job is to refuse the option that does.

### Latency budgets you can say out loud

A page that calls three services in series pays the sum of their latencies. The option that runs those calls in parallel, or that collapses a chatty interface into one call, beats the option that upgrades the instance class. A page that calls a service in another region on the critical path pays a cross-region round trip every time. The option that replicates data for local reads, with a staleness the stem allows, beats the option that keeps one database and hopes. If the stem says the read must be strongly consistent with the write the user just made, local stale replicas are wrong and you keep the read in the region that took the write. Consistency is a performance constraint. Do not cache your way past it.

Edge compute is a rare answer. A function at the edge is for a tiny request-time decision, not for a job that needs a database in one region and a large library. If the stem's work is heavy, the edge is a distractor and the work belongs next to the data. If the stem's work is "redirect this path" or "check this header", the edge can be the low-latency answer. Size the work before you place it.

Measure is a valid answer when the stem asks what to do first. A performance question that offers 'turn on detailed monitoring or load-test before you re-architect' against 'immediately shard the database' wants the measurement if nobody has located the bottleneck. Re-architecting a guess is how you get a faster wrong tier. Once the stem already shows the bottleneck, stop measuring and pick the fix. Reading whether the numbers are already on the page is part of the question.

### You can now

Name the bottleneck in the stem. Pick the store and the compute that match it. Reject a low-latency claim that adds a cross-region dependency on the request path. Reject Glacier for hot reads and a scan for a hot key.


If the stem already measured the bottleneck, do not ask for another week of metrics. If it has not, the option that re-architects first is how you speed up the wrong tier. The page either contains the numbers or it asks what to do first. Read which one you were given.

::: quiz
q: Users worldwide download the same product images. The origin is in one region and the images rarely change. What improves latency most?
+ CloudFront in front of the bucket, caching the images at the edge
- A larger EC2 instance as the origin for every request
- DynamoDB in front of S3
- A second full copy of the application database in every region, written on each request
why: Cacheable bytes belong at the edge. A bigger origin still sits far away. A database is the wrong store for image bytes. Multi-region writes are not required for static images.
:::

::: quiz
q: A DynamoDB table throttles. CloudWatch shows one partition key, customer id 1, taking most of the traffic. What addresses the cause?
+ Change the key design so that hot item is not a single partition. More table capacity does not spread one key
- Turn on S3 Transfer Acceleration
- Add an Availability Zone
- Enable S3 versioning
why: A hot key is a modeling problem. Capacity on other partitions does not help that key. The other options are unrelated services.
:::

::: quiz
q: Finance runs unpredictable SQL joins over the latest orders. The team wants the least application change. What fits?
+ Keep the relational database and add the indexes or a read replica the report needs. Do not move the reports to DynamoDB this week
- A full rewrite to DynamoDB scans
- ElastiCache as the only store
- EBS on the analyst's laptop
why: Ad-hoc joins are relational. DynamoDB is for known access patterns. A cache is not the system of record for a report that must be correct.
:::

::: quiz
q: A 40-minute video encode runs once per upload and can be retried. The user does not wait. What is the efficient compute?
+ A queue and a Fargate or Batch or EC2 worker that can run for 40 minutes. Not a synchronous Lambda call
- A synchronous Lambda with a 40-minute waiter in the browser
- A CloudFront function, which runs at the edge for milliseconds
- A NAT gateway, which can execute code
why: The job is long and asynchronous. Standard synchronous Lambda stops at 15 minutes. Edge functions are not encoders. NAT does not compute.
:::

::: quiz
q: The office uploads terabytes nightly to S3 and the internet VPN is saturated. They want a steady private link. What is the fitting service?
+ AWS Direct Connect, sized for the transfer, possibly with a VPN as a fallback
- A bigger NAT gateway in the VPC, which does not help the office circuit
- CloudFront in front of the upload
- DynamoDB global tables
why: Direct Connect is the private circuit for this pattern. NAT is inside AWS. CloudFront is not how you drain a data-center upload. Global tables are a database feature.
:::

::: quiz
q: The same product page is read thousands of times a minute from Postgres and the rows change every few minutes. Stale reads of a few minutes are acceptable. What helps?
+ A cache such as ElastiCache with a TTL, in front of the database, and the app must tolerate a miss
- A scan of the table on every request
- Turning off Multi-AZ to make reads faster
- Storing the only copy of the page in the cache
why: A TTL cache absorbs repeated reads. The database remains the record. Removing Multi-AZ does not fix read volume. A cache as the only copy fails the durability the stem did not give away.
:::

::: quiz
q: Events arrive continuously from devices and must land in S3 for later analysis. The devices should not each insert into the warehouse. What is the shape?
+ A stream or a queue into a delivery service such as Data Firehose, writing to S3 in batches
- Each device opens a SQL transaction
- A nightly email of a CSV
- A CloudFront distribution as the ingest
why: Continuous ingest wants a buffer and batched writes. Per-device transactions will not scale. Email and a CDN are not the ingest path.
:::

## Design cost-optimized architectures
id: saa-cost
stage: exam
needs: wa, cost
minutes: 50
goal: Choose the design that meets the stated constraint for less, and refuse savings that drop the constraint.
source: SAA-C03 exam guide | https://docs.aws.amazon.com/aws-certification/latest/solutions-architect-associate-03/solutions-architect-associate-03.html
source: Cost optimization pillar | https://docs.aws.amazon.com/wellarchitected/latest/cost-optimization-pillar/welcome.html

Cost-optimized questions are about 20 percent of scored content. They are not "pick the cheapest line". They are "meet the constraint for less". The constraint is still in the stem: the RPO, the availability, the latency, the operational overhead. An option that saves money by dropping a required zone is wrong. An option that adds Aurora, Kinesis, and a second region to a nightly job is wrong the other way.

The usual savings are the ones from the cost lesson. Right-size, then consider a Savings Plan for the steady base. Spot or a scheduled stop for what can stop. S3 lifecycle for data that cools, not for data you read all day. A gateway endpoint instead of NAT for S3. CloudFront when it reduces origin egress and the cache is safe. A serverless call for a spiky, short job, and not for a steady 24/7 CPU where the request price loses to a small reserved instance. Delete unattached volumes and old snapshots. Turn dev off at night.

The usual traps are similar. Buying a reservation before measuring. Using Glacier because it sounds cheap, then paying retrieval on a hot workload. Using a NAT gateway as a design habit. Replicating across regions "for safety" when the RPO did not ask. A dedicated bastion instance when Session Manager is enough. CloudTrail data events on every bucket when the stem only needed management events. High-cardinality metrics.

When two options both meet the constraint, pick the one the stem calls most cost-effective, and prefer the managed service if it also says least operational effort. Those two adverbs can conflict. Least effort may cost more. Read which one the stem used last, and do not invent the other.

### Arithmetic the stem expects you to feel

You rarely get prices. You get shapes. Idle all night versus running all night is a shape. Per gigabyte through NAT versus a gateway endpoint is a shape. Retrieval from archive versus storage of hot data is a shape. A second region versus one region is a shape. When the stem says the traffic is large and S3, feel the NAT line. When the stem says the traffic is tiny, do not spend endpoint-hours to save cents, if an option lets you say so. When the stem says the data is read once a year, feel Glacier. When the stem says the data is read during every request, Glacier is a trick.

Commitments are a shape too. A Savings Plan is a promise that the base stays. A stem that says the project ends in three months is a bad place for a three-year reservation, even if the unit price looks sweet. A stem that says the fleet has been steady for a year and will stay is a bad place to remain On-Demand out of fear, if the question asks for the most cost-effective long-term choice. Right-size first is still the order when the metric is on the page. If the metric is not on the page and the stem says the size is already correct, you may commit.

### Overbuy is the cost-domain signature

The distractor in this domain is the resilient or high-performing design from the previous lesson, applied to a stem that did not need it. Multi-region for a business that can be down for a day. A stream for a nightly file. Provisioned concurrency for a job that runs at 03:00 and can be cold. A load balancer in front of one scheduled task. These are not stupid designs. They are answers to different questions. The discipline is to notice that this question is the cost question. The pillar review said the same thing: do not add a box that does not buy a requirement.

Operational overhead is the second price. A design that is cheaper in dollars and requires you to patch a fleet, when another design meets the same RTO with a managed service and the stem said "minimal administration", loses. Say which price the stem named. Dollars or hours. Then pick. If it named both, it will also tell you which requirement is absolute. The absolute one is a filter. The other is a sort.

### A second pass for the bill you forgot

After you pick an option, name the line item it adds. A NAT gateway is hours plus gigabytes. A cross-region replica is storage plus transfer plus the other region's compute if it is warm. A load balancer is hours even when idle. Provisioned IOPS is a bill you pay when the disk is quiet. A KMS request per object is a bill at high rate. CloudTrail data events are a bill. If the stem is a cost question and your option adds three of these without a sentence in the stem that needs them, go back. You probably liked the resilient option.

Then look for waste the correct option removes. Unattached storage. A dev fleet at night. A NAT path to S3. An oversized instance. A retention of forever. The correct cost answer usually removes a line or stops paying for idle time. It rarely adds a new product. If your answer adds a product, be able to say which larger line it deletes. Endpoint instead of NAT bytes. Schedule instead of idle hours. Lifecycle instead of Standard storage for cold objects. That sentence is the justification. If you cannot say it, the option is a shopping list and this domain does not want one.

The calculator is not in the exam room. The shape of the price is. Practise saying "this is billed per hour even when idle" and "this is billed per gigabyte processed" until the options sort themselves. Those two sentences explain NAT, load balancers, idle EC2, interface endpoints, and why a nightly job should not own a server.

Non-production data is a frequent saving the stem buries. A full copy of production in dev, refreshed every hour, costs storage and snapshots and sometimes a second Multi-AZ database. The option that refreshes a smaller sample nightly, or that shares anonymized data, beats the option that clones everything, unless the stem says the test is a performance test that needs production volume. Read whether they need fidelity or whether they need a place to click. Those are different bills.

Finally, watch free and included. Shield Standard is already there. A second product that duplicates it is spend. S3's default encryption does not need a new key to satisfy 'encrypted at rest' on a cost question. Adding a customer managed key adds requests and administration. Do that when the security stem asks for control, not when the cost stem asks for encryption in general.

If the option you like saves money by moving data to a region the stem's residency rule forbids, it is not a cost answer. It is an invalid design. Cross it out before the arithmetic. The same goes for an option that drops encryption the stem required, or a second zone the stem required. Cost is the sort. The requirement is the filter.

### You can now

List the constraint, then the bill. Reject a saving that breaks the constraint. Reject a design that overbuys a stream or a second region the stem did not need. Prefer endpoints, lifecycle, schedules, and right-sizing over a new product.

::: quiz
q: A dev environment matches production's size and runs all night. The company wants the bill down this month without buying a commitment. What do you do?
+ Schedule the non-production stack to stop outside working hours, and look at sizes next
- Buy a three-year Savings Plan for the dev account
- Turn off production Multi-AZ
- Delete the backups
why: Idle dev is the fast saving. A three-year commit on dev locks the waste in. Dropping prod availability or backups violates requirements the stem did not cancel.
:::

::: quiz
q: Private tasks pull large images and read S3 through a NAT gateway. Which change is the cost win if S3 is most of the bytes?
+ A gateway VPC endpoint for S3, so those bytes leave the NAT path. Check ECR separately
- A second NAT gateway in the same zone
- S3 Glacier for the live images
- A public subnet so NAT is unnecessary and the tasks are exposed
why: NAT bills per gigabyte. The S3 gateway endpoint is the usual fix. Glacier breaks live pulls. Exposing the tasks trades money for a security regression the stem did not ask for.
:::

::: quiz
q: A steady four instances run at 10 percent CPU after a month of metrics. The company wants a discount. What is the order?
+ Right-size, confirm the load test, then consider a Savings Plan for the smaller steady base
- Reserve the current size for three years, then shrink
- Move the database to Spot
- Add two regions so the discount applies twice
why: Do not commit to idle CPU. Spot is the wrong purchase for a database-shaped assumption, and the stem is about the instances. A second region doubles a footprint.
:::

::: quiz
q: Logs are kept forever in CloudWatch and almost never read after two weeks. What is the cost-effective retention?
+ Shorten retention to the period you actually debug, and archive only what compliance names to cheaper storage
- Move the logs to Glacier Deep Archive on day one and query them hourly
- Turn logging off
- Send every log line as a custom metric
why: Retention should match use. Deep Archive plus hourly queries is an expensive retrieval. No logs fails an operational requirement. Metrics per line explodes cardinality.
:::

::: quiz
q: A nightly report runs for twenty minutes and the rest of the day the instance is idle. What is the cheaper shape?
+ A scheduled Fargate task or a Lambda, if it fits the timeout, and no instance the rest of the day
- A second instance for high availability of a job that can rerun tomorrow
- A three-year reservation of the idle host
- S3 Transfer Acceleration
why: Pay for the twenty minutes. A reservation of an idle host is the opposite. A second instance is availability the stem did not require for a rerunnable report.
:::

::: quiz
q: Two options both keep the required Multi-AZ database. One adds a cross-region replica the RPO does not need. The other does not. The stem says most cost-effective. Which do you pick?
+ The design without the cross-region replica. Replication is a bill and a complexity the requirement did not buy
- The cross-region replica, because more copies are always more resilient
- The option that drops Multi-AZ instead
- Whichever uses Glacier
why: Meet the written RPO and stop. Extra regions cost money and operational load. Dropping Multi-AZ fails the requirement. Glacier is unrelated.
:::

::: quiz
q: Unattached EBS volumes and old snapshots show up in Cost Explorer. What is the right cleanup?
+ Delete the ones you can prove are unused, after a snapshot or a check that no AMI needs them. Do not delete the only backup of a volume you still care about
- Delete every snapshot in the account
- Turn off Cost Explorer to hide the line
- Convert them to NAT gateways
why: The saving is the waste, not the recovery points. Prove unused, then delete. Hiding the explorer does not change the bill.
:::

## Project: a clinic SaaS on AWS
id: p-saas
stage: exam
needs: saa-resilient, saa-perform, saa-secure
minutes: 75
project: yes
goal: Record a small, reviewable AWS design that meets a written residency, availability, and operations constraint.
source: AWS Well-Architected Framework | https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html

A clinic in Austria wants a small SaaS for lab results. Staff sign in through the company's identity provider. Patients never get AWS credentials. A container serves the API. Postgres holds the records. PDFs of results go in object storage and must not be public. Data, keys, backups, and logs stay in the EU. The service must keep serving if one data centre in the region loses power. Losing the whole region is accepted for up to a day, with at most an hour of data loss, and that plan has to be written down rather than implied. A sale, in this business a Monday morning rush, must not fall over. Emailing the patient can be a few minutes late. The team is four people. They will not run a Kubernetes control plane.

You will not create a real account. You will record the design as a JSON document the checker can read, and you will answer the decisions the way a review would. Budget about 75 minutes. Read the whole brief before the first question. The questions stand on their own in a later review, so they restate the constraint they need.

### Requirements

- Region in the EU, named, not "whatever is cheapest".
- Compute is a managed container service behind a load balancer, in more than one Availability Zone, tasks in private subnets. Not a single VM. Not EKS.
- Database is Multi-AZ Postgres, RDS or Aurora, in private subnets. Not a single instance. Not DynamoDB for this relational record.
- PDFs in a private S3 bucket. Downloads are presigned after an authorization check.
- Sessions are not in process memory.
- Patient email goes through a queue. The API returns when the record is saved.
- Secrets in Secrets Manager. The task role can read the one secret and the one prefix. No long-lived access keys.
- An alarm on user-visible errors, not on CPU alone.
- A backup that can meet a one-hour RPO, and a one-sentence regional strategy that is not "we are Multi-AZ".
- A budget alert with an owner. Tags env and owner exist in the design notes.

### How this is graded

The checker does not log in to AWS. It checks the JSON design against the fields below, and it checks the short answers in the questions. A design that is more expensive and still meets the brief can be wrong when the question says the team will not operate a cluster, or when it puts data outside the EU. A design that is cheap and drops Multi-AZ is wrong. There is no partial credit in the checker. There is partial understanding in the why text. Read it when you miss.

### Where a pass still fails in real life

A JSON file is not a drill. You have not restored the database, you have not terminated a task, and you have not seen the bill. The next module turns the same choices into Terraform. If a field says Fargate and you cannot draw the subnets, go back to the VPC lesson before you write the module.


### Working the brief in order

Start with the place. Austria and an EU clause means an EU region, and then a minute in the service list before you name Aurora or a particular instance family. Frankfurt is a normal choice. Zurich is for a Swiss clause, which this brief does not have. us-east-1 is a habit. Write the region on the page before the compute, because the keys, the log group, and the backup vault inherit it. If a service you wanted is missing, you change the service, not the country.

Then the failure you promised. One data centre is one Availability Zone. Two zones, a load balancer, and a Multi-AZ database are the shape. Draw the tasks in private subnets and the load balancer in public ones. If you cannot say which security group is allowed to speak to the database, the drawing is not finished. EKS does not appear. A single VM does not appear. Lambda as the whole API does not appear, because you have a container and a long PDF job that must not sit on a synchronous timeout.

Then the data. Records are relational, so Postgres. PDFs are objects, so S3, private, versioned, presigned. Sessions are small and must be shared, so a cache with a TTL, and the app still works if the cache is empty. The password is a secret. The task role is two statements, not a star. Email is a queue because the brief says it can be late. The Monday rush is that queue plus a cap, not a larger VM and a prayer.

Then the region-sized failure, which you did not promise to ride through. You promised a day and an hour. That is a backup or a copy that is at most an hour old, and a rebuild you could start from code. It is not a sentence that says Multi-AZ. Write the sentence. If you cannot, the field is unfinished even when the JSON matches.

Last, the bill and the page. A budget with a person's name. An alarm on 5xx, and one on the age of the email queue. CPU on a graph. Tags so the clinic can see this account in the invoice. None of these create the clinic. They stop the design from being a diagram that only works on the day you drew it.

### What you hand back

The JSON is the short form of that page. Each field is one decision. If you change a field, change the reason, not only the string. A later review question will not show you the JSON. It will show you a clinic that looks like this one and an option that is cheaper because it runs in one zone. You already know how that ends.


### A Monday you can narrate

The rush starts. The API writes the lab record and enqueues the mail. One zone's tasks fail their health checks. The load balancer uses the other zone. The database fails over inside the region. The queue age rises and then falls. Three messages hit the dead-letter queue because the mail provider rejected a bad address. Those three are the work list, not a reason to scale without a cap. Nobody SSHes. The 5xx alarm stays quiet if you did this well, and the age alarm might fire if the cap is too low. That is a tuning ticket, not a new architecture. A public bucket would have made the morning a breach instead of a queue. A single VM would have made it an outage. The JSON you submit is this morning, written in fields.

If you want a longer RPO argument, write the age of the backup next to the sentence. "Up to one hour" means a point-in-time window or a copy schedule that is at least that frequent, and a person who has restored it once. The checker cannot see your drill. The brief still asks you to know the difference between that drill and a second Availability Zone.


When a field is tempting because it is familiar, write the sentence in the brief that allows it. If you cannot find the sentence, the field is wrong. Familiarity is not a requirement. The Monday rush, the EU clause, and the refusal to run a cluster are requirements. The JSON is only finished when each of those still has a home in a field.

::: quiz
q: The clinic's records must stay in the EU, and the team has not checked service lists yet. What is the first region decision?
+ Pick an EU region and confirm the services you will use exist there before you promise it. Do not pick us-east-1 for convenience
- us-east-1, because new features land there
- Any region, if the bucket is encrypted
- A Local Zone in another continent, because it is not a region
why: Residency is a place, and the service list is part of the place. Encryption does not move data. A Local Zone is not a way around the contract.
:::

::: quiz
q: Which compute choice matches a four-person team and a ban on running Kubernetes?
+ ECS on Fargate in two Availability Zones behind an application load balancer
- EKS, so it is future-proof
- One EC2 instance with Docker
- Lambda for the whole API, invoked synchronously for a 40-minute PDF render
why: Fargate is the managed container default from the compute lessons. EKS adds a control plane they refused. One instance does not survive a zone. A long synchronous render is not the API.
:::

::: quiz
q: Monday's rush sends email slowly and the API starts timing out. What change keeps the record save fast?
+ Save the record, enqueue the email, and let a consumer send it. Scale the consumer with a cap
- Cache the PDF on CloudFront and skip the database
- Make the database publicly reachable so email is faster
- Page someone when CPU exceeds 20 percent
why: The email is allowed to be late. The save is not. A queue is the decoupling. A public database and a CPU page do not fix a slow provider on the request path.
:::

::: config lang=json
task: The starter design violates the brief. Fix the JSON so it matches the clinic: an EU region, Fargate across two zones, Multi-AZ Postgres, a private bucket, sessions in ElastiCache, email on a queue, and an alarm on 5xx. Use the field values the checks name.
starter:
```json
{
  "region": "us-east-1",
  "compute": "single-ec2",
  "zones": 1,
  "database": "dynamodb",
  "multi_az": false,
  "bucket_public": true,
  "sessions": "memory",
  "email": "inline",
  "alarm": "cpu"
}
```
check: region = eu-central-1 | Region is an EU region
check: compute = fargate | Compute is Fargate
check: zones = 2 | Two zones
check: database = postgres | Relational database
check: multi_az = true | Multi-AZ is on
check: bucket_public = false | The bucket is private
check: sessions = elasticache | Sessions are shared
check: email = queue | Email is queued
check: alarm = 5xx | The alarm is the error symptom
solution:
```json
{
  "region": "eu-central-1",
  "compute": "fargate",
  "zones": 2,
  "database": "postgres",
  "multi_az": true,
  "bucket_public": false,
  "sessions": "elasticache",
  "email": "queue",
  "alarm": "5xx"
}
```
hint: The brief wants EU, two zones, Fargate, Postgres with Multi-AZ, a private bucket, shared sessions, a queue for email, and a 5xx alarm. eu-central-1 is the EU region this exercise expects.
:::

::: quiz
q: The regional outage plan says Multi-AZ so we need nothing else. The accepted loss is one hour of data and one day down. What is missing?
+ A backup or replica copy that is at most an hour old, and a practised rebuild. Multi-AZ does not cover the region
- A third Availability Zone, which covers a region
- CloudFront, which serves the API with no origin
- A larger instance
why: Multi-AZ is one region. A one-hour RPO needs a recovery point that fresh, and a one-day RTO needs a rebuild you have timed. A CDN does not replace the database.
:::

::: quiz
q: Where does the database password go?
+ In Secrets Manager, readable by the task role and not by the world. Not in the image and not in git
- In the container image, because the subnet is private
- On the root account
- In the patient's PDF
why: A private subnet does not hide a secret baked into an image. Secrets Manager plus a role is the pattern. Root and the PDF are the wrong places.
:::

::: card
q: What does this design deliberately not survive?
answer: A regional outage, until the backup rebuild is done, and it may lose up to the backup's RPO. It does survive one zone. It does not give patients AWS credentials, and it does not run EKS.
:::

## SAA-C03 practice set
id: saa-exam
stage: exam
needs: saa-secure, saa-resilient, saa-perform, saa-cost, p-saas, p-design
minutes: 90
goal: Answer a mixed set of scenario questions without the lesson text in front of you.
source: SAA-C03 exam guide | https://docs.aws.amazon.com/aws-certification/latest/solutions-architect-associate-03/solutions-architect-associate-03.html
source: AWS Certification: Solutions Architect Associate | https://aws.amazon.com/certification/certified-solutions-architect-associate/

This is a mixed set in the shape of SAA-C03: a situation, four designs, one that fits the constraint that is actually written. The domain weights on the current exam guide are 30 percent secure, 26 percent resilient, 24 percent high-performing, and 20 percent cost-optimized. The questions are not labeled. Say the pillar before you look at the options, then cross out anything that violates a hard constraint, then apply the adverb such as most cost-effective or least operational overhead.

There is no AWS account in the sandbox. The grade is the choice and the reason, the same as the domain lessons. A wrong option is a real design aimed at a different problem: a backup where a failover was required, a key where a role was required, a second region where a second zone was required. When you miss one, write down the constraint you skipped.

The official exam is longer, timed, and scored by AWS. This set is practice, not a promise of a score. Use the exam guide for the live outline, and use these questions to see whether the earlier lessons stayed in your head without the lesson on the screen.

::: quiz
q: A photo-sharing app stores images in S3. Users must only download their own images. The team proposes making the bucket public and using long random keys. What is the better design?
+ Keep the bucket private and return a short-lived presigned URL after the API checks ownership
- Public bucket with random keys is enough because the keys are unguessable
- Give each user an IAM user so S3 can check the password
- Put the images in the database as the only way to keep them private
why: Random keys leak via logs and referrers. The API is the authorization point, and a presigned URL expires. IAM users are not application users. A database is the wrong blob store, not the privacy model.
:::

::: quiz
q: Employees must administer several accounts without access keys. What do you roll out?
+ IAM Identity Center permission sets that assume roles in those accounts
- One IAM user per account with a shared access key
- Root credentials in a password manager
- An SCP that grants AdministratorAccess
why: Identity Center issues temporary role credentials. Shared keys and root are standing credentials. An SCP cannot grant access.
:::

::: quiz
q: A Lambda function in account A must read a bucket in account B. The function's role allows GetObject and the call still fails. What else is required?
+ The bucket policy in B must allow the role, and the KMS key policy must allow decrypt if a customer managed key is used
- A second copy of the Lambda function in B, because roles are regional
- An SCP in A that grants s3:GetObject
- Making the bucket public to the internet
why: Cross-account reads need the resource side to agree. Roles are not regional. SCPs do not grant. Public access is not the fix.
:::

::: quiz
q: The company must stop member-account admins from turning off CloudTrail. What enforces that?
+ An SCP denying the CloudTrail stop and delete actions, with logs delivered to another account
- An email policy
- A CloudWatch alarm only
- A note in the runbook
why: An SCP is a maximum on member principals, including admins. An alarm detects. It does not prevent. A runbook depends on the admin you do not trust.
:::

::: quiz
q: A web tier must survive one Availability Zone failure with a few minutes of database failover. Which data choice fits?
+ Multi-AZ RDS or Aurora in private subnets across two zones
- A single RDS instance with a larger class
- A read replica in the same zone
- An EBS volume snapshot taken once a week
why: Zone failure needs a synchronous standby in another zone. A bigger instance and a same-zone replica do not add a zone. A weekly snapshot is a long RPO and a long RTO.
:::

::: quiz
q: Users are logged out at random after the web tier scales from one task to three. Sessions are in process memory. What fixes it?
+ Move sessions to a shared store such as ElastiCache or the database so any task can serve any user
- Enable sticky sessions and never revisit the bug
- Scale back to one larger task
- Lower the health-check interval
why: Tasks behind a load balancer must be stateless for sessions. Sticky sessions paper over it. One task is not highly available. The health check is unrelated.
:::

::: quiz
q: A sale will multiply traffic for an hour. The work after checkout can finish a few minutes later. What absorbs the spike?
+ Write the order idempotently and enqueue the slow work on SQS, scaling consumers on queue age with a cap
- A single larger instance with no queue
- A read replica to take the writes
- CloudFront caching the POST
why: A queue turns the spike into backlog. A read replica does not take writes. CloudFront should not cache the checkout POST. One instance is a bottleneck.
:::

::: quiz
q: The business can be down for a day and can lose a day of data if a region fails. They want the lowest cost. What is appropriate?
+ Backups that meet the one-day RPO, infrastructure as code to rebuild, and a practised restore. No second live region
- Active-active in two regions
- A warm standby at full size
- Two extra Availability Zones only
why: The RTO and RPO match backup and restore. Active-active and a full warm standby overbuy. More zones do not cover a region.
:::

::: quiz
q: Replica lag to the other region is twenty minutes. The required regional RPO is five minutes. What is true?
+ The replica does not meet the RPO. Failover would accept about twenty minutes of loss
- Aurora's six copies make the cross-region RPO zero
- A shorter DNS TTL reduces lag
- Multi-AZ in the primary region fixes the cross-region number
why: Asynchronous cross-region lag is the RPO. Primary-region copies and DNS do not shrink it.
:::

::: quiz
q: A standard Lambda is invoked synchronously to run a 40-minute render while the user waits. What is the problem?
+ Synchronous invocations time out at 15 minutes. The user should enqueue the work instead of waiting
- Lambda cannot read from S3
- The 2026 90-minute async limit applies to this browser call automatically
- API Gateway removes the limit
why: The 90-minute ceiling is for asynchronous or most event-source calls on Managed Instances, not for a synchronous wait. Enqueue the render.
:::

::: quiz
q: You need HTTP path routing and TLS to two target groups. Which load balancer?
+ An Application Load Balancer
- A Network Load Balancer, because it is always faster and therefore enough
- A transit gateway
- A NAT gateway
why: Path routing is layer 7. An NLB does not route on paths. Transit and NAT are not HTTP routers.
:::

::: quiz
q: CloudFront should serve a private S3 bucket. How do you allow the read?
+ Origin access control, bucket stays private, bucket policy allows the distribution
- Make the bucket public
- Put an access key in the distribution
- Open the bucket to 0.0.0.0/0 and rely on a long URL
why: Origin access control is the current CloudFront-to-S3 control. Public buckets and embedded keys are the incidents.
:::

::: quiz
q: Two VPCs use 10.0.0.0/16 and must communicate. What is required first?
+ Renumber one of them. Overlapping CIDRs cannot be routed by peering or a transit gateway
- A transit gateway, which rewrites the overlap
- A security group that allows the overlap
- Route 53 geolocation
why: Routing needs unique addresses. No hub fixes overlapping CIDRs. Security groups and DNS do not renumber networks.
:::

::: quiz
q: Where do you request a public ACM certificate used by CloudFront?
+ In us-east-1, even when the origin is in another region
- Only in the origin region
- In every edge location manually
- Certificates are not used at the edge
why: CloudFront uses public ACM certificates from us-east-1. The origin can still have its own certificate if clients can reach it directly.
:::

::: quiz
q: A DynamoDB table throttles on one customer id that is half of traffic. What fixes the cause?
+ Redesign the partition key so that customer's traffic is not a single hot key
- Add a second region
- Turn on S3 versioning
- Increase the Auto Scaling group of a nonexistent EC2 fleet
why: One key is one partition slice. More regions and unrelated services do not spread that key.
:::

::: quiz
q: Finance will write new SQL joins next month. The data is a few hundred gigabytes. What is the safer store?
+ RDS or Aurora Postgres, with room to add indexes
- DynamoDB, and they can scan for the new joins
- ElastiCache as the only copy
- EBS on one instance with no snapshot
why: Unknown relational queries belong in a relational engine. A scan is not a plan. A cache and a single disk are not the system of record.
:::

::: quiz
q: A cache flush logs every user out and loses no orders. Is the design acceptable?
+ Yes, if sessions lived in the cache and orders live in the database
- No, a cache must never be flushed
- No, because ElastiCache cannot be Multi-AZ
- Yes, even if the orders existed only in the cache
why: A cache may lose rebuildable state. It may not be the only copy of orders. Multi-AZ is available for the engines that support it and is a separate choice.
:::

::: quiz
q: Private tasks cannot reach S3 and NAT cost is high. What do you add for S3?
+ A gateway VPC endpoint on the private route tables
- An internet gateway route on the private subnets
- A public IP on each task
- A Transit Gateway just for one bucket
why: The S3 gateway endpoint avoids NAT bytes and keeps the subnet private. An internet route and public IPs expose the tasks.
:::

::: quiz
q: WAF is on CloudFront and the ALB allows 443 from the world. What is wrong?
+ Clients can bypass the WAF by calling the ALB. Restrict the origin to CloudFront
- WAF inspects the ALB automatically
- Shield Standard closes the ALB
- GuardDuty rewrites the security group
why: WAF only sees the resource it is attached to. An open origin is a second door. Shield and GuardDuty do not close it.
:::

::: quiz
q: GuardDuty raises a finding on a role. What has already happened?
+ Nothing has been blocked. A person or a narrow automation must respond
- The role has been deleted
- The account has been closed
- All public buckets have been made private
why: GuardDuty detects. Response is yours. It does not close the account or delete roles by itself.
:::

::: quiz
q: A customer managed key's policy does not allow the task role, and IAM does allow kms:Decrypt. Can the role decrypt?
+ No. The key policy must allow the call. IAM alone is not enough for KMS
- Yes, IAM admin always overrides the key policy
- Yes, if the bucket policy allows GetObject
- Yes, because rotation disables key policies
why: KMS requires the key policy to permit the principal. A bucket policy does not replace it. Rotation does not switch the key policy off.
:::

::: quiz
q: You want old ciphertext to become unreadable tonight because a laptop was stolen. The thief has no role. What does key rotation do?
+ Nothing useful here. Rotation still decrypts old ciphertext. Revoke the stolen credential instead
- It immediately destroys old data keys
- It deletes the S3 objects
- It turns off CloudTrail
why: Rotation keeps old material for decrypt. If the thief has no key access, revoke whatever credential leaked and look at CloudTrail. Disabling a key is the kill switch when you must stop decrypt, and it stops the application too.
:::

::: quiz
q: A nightly job runs 15 minutes and the instance is idle otherwise. The most cost-effective shape?
+ A schedule that starts a task for the job and then stops it, or Lambda if the mode's timeout fits
- A three-year reservation of the idle instance
- A second instance for availability of a rerunnable report
- Cross-region replication of its scratch disk
why: Pay for the window the job runs. A reservation of idle time and a second region buy things the stem did not need.
:::

::: quiz
q: Four steady instances sit at 10 percent CPU. You want a discount. What first?
+ Right-size from the metrics, then consider a Savings Plan
- Buy a three-year plan for the current size, then shrink
- Move them to Spot with no On-Demand base
- Add a region so the discount stacks
why: Do not commit to idle CPU. Spot without a base changes availability. A second region is not a discount.
:::

::: quiz
q: Dev costs as much as prod because it runs all night. Fastest saving without a commitment?
+ Stop non-production on a schedule and set a budget alert
- A three-year Savings Plan on dev
- Remove prod Multi-AZ
- Delete CloudTrail
why: Idle dev should stop. A long commit on dev locks waste in. The other options drop a production or audit requirement.
:::

::: quiz
q: An SCP allows only s3:* and the developer has AdministratorAccess in IAM. Can they create an IAM user?
+ No. The SCP does not allow that action, so the call is denied
- Yes, AdministratorAccess beats an SCP
- Yes, because SCPs apply only in the management account
- Yes, from the console only
why: The SCP is a filter on the member account. It does not apply to the management account, which is the opposite of the distractor. Console and CLI use the same IAM decision.
:::

::: quiz
q: A trust policy has Principal star on a role that can read production data. What is the defect?
+ Anyone who can call AssumeRole may be able to become the role. Name the principal and add a condition
- Nothing, star in a trust is required for ECS
- The identity policy will stop every assume
- KMS blocks AssumeRole
why: A wildcard trust is a public role. The identity policy applies after assume, so it does not stop the assume. ECS trusts the service principal, not star.
:::

::: quiz
q: Fargate EKS pods need to read DynamoDB. Which identity?
+ IRSA on the service account. Pod Identity does not run on Fargate, and the pod execution role is not for the app
- EKS Pod Identity, because it replaced IRSA for every compute type
- The Fargate pod execution role
- The node role, even though there is no node
why: Pod Identity is for Linux EC2 nodes. Fargate application roles stay on IRSA. The execution role is for the platform to pull images and write logs.
:::

::: quiz
q: A Linux EC2 pod should use Pod Identity. What must the role trust allow?
+ pods.eks.amazonaws.com to sts:AssumeRole and sts:TagSession
- Only a service-account annotation, with no trust change
- The root user of every account
- ec2.amazonaws.com and no session tags, which is the node
why: Pod Identity assumes the role and tags the session. An annotation alone is the IRSA gesture. The node trust is the wrong principal.
:::

::: quiz
q: An ECS task cannot pull its image. The task role is correct for S3. What do you check?
+ The execution role and a network path to ECR, NAT or interface endpoints, including S3 for layers
- The application task role only
- The database security group
- Whether the image tag is latest
why: Pulling is the execution role plus network. The task role is for your code. latest is a deploy smell, not the pull error itself.
:::

::: quiz
q: A deploy uses the image tag latest. Why is that a problem?
+ The tag can move, so a rollback and a diff are unclear. Deploy a digest or an immutable tag
- ECS cannot pull tags
- latest is stored in every region automatically
- IAM denies latest
why: Mutable tags hide which bytes are running. Digests and immutable tags are revisions you can return to.
:::

::: quiz
q: Route 53 failover TTL is 30 minutes. The primary region fails. What do clients do?
+ Many keep the old address until their cache expires, so failover is not instant
- They all switch within one second
- The load balancer updates every resolver
- TTL only applies to private zones
why: DNS caches ignore you until TTL. Health checks change the answer Route 53 gives next. They do not flush the world.
:::

::: quiz
q: You need a shared POSIX volume for several tasks. What do you pick?
+ EFS, with mount targets in the zones you use
- One EBS volume mounted on all the tasks
- S3 mounted as if it were a POSIX disk with no gateway
- A DynamoDB table
why: EBS attaches to one instance in one zone. S3 is an object API. EFS is the shared filesystem. DynamoDB is not a filesystem.
:::

::: quiz
q: Versioning is off and a job overwrites an object. What does S3 durability give you?
+ The new bytes, stored durably. The old bytes are gone unless you have a backup or versioning
- Automatic restore of the previous bytes
- A Multi-AZ undo
- A presigned URL of the old object
why: Durability means AWS keeps the object you stored. It does not keep the object you overwrote unless versioning or a backup did.
:::

::: quiz
q: A Multi-AZ failover just happened after a bad migration. Where is the dropped column?
+ On the new primary too. Restore a point in time from before the migration
- Only on the old primary, the standby refused the migration
- In the read replica automatically, even if none exists
- Restored by the failover
why: Synchronous replication applied the migration. Failover is not a time machine. Point-in-time recovery is.
:::

::: quiz
q: Who patches the operating system of a standard Lambda function's workers?
+ AWS. You still own the code, the role, and the event source permissions
- You do, on the EC2 schedule
- Nobody, Lambda has no computer under it
- The customer, only if they used a container image
why: Lambda moves worker patching to AWS. A container image is still your code. Identity stays yours.
:::

::: quiz
q: An alarm pages on CPU above 50 percent and never on 5xx. What is the better page?
+ Error rate or a latency percentile sustained for several minutes, plus saturation such as queue age
- Average CPU only
- A count of log lines
- Billing alerts as the only production page
why: Page on user symptoms and on saturation that will become one. CPU and log volume are investigations. Billing is a different audience.
:::

::: quiz
q: A trail exists only in the home region. What can you fail to see?
+ API calls in other regions, including regions you did not mean to use
- Nothing, trails are global by default once one region is on
- Only console clicks
- Only data events, which are the only events that exist
why: A single-region trail is blind elsewhere. Unused regions are a common place to work unseen. Management events exist without data events.
:::

::: quiz
q: The CLI denies a call the role policy allows. What do you check first?
+ aws sts get-caller-identity, to see if you are even using that role
- Create a new access key and retry
- An SCP that grants the action
- The region's copy of the IAM role
why: The signer may be a different principal, often from an environment variable. IAM roles are not copied per region. An SCP cannot grant the missing permission.
:::

::: quiz
q: A Swiss contract requires data to stay in Switzerland. Which region is the honest default?
+ eu-central-2, after you confirm every service you need exists there, including backups and keys
- eu-central-1, because encryption is enough
- us-east-1, because features arrive first
- Any region, if the bucket name is global
why: Residency is a place. Encryption and a global bucket name do not move the bytes. Confirm the service list in Zurich before you promise it.
:::

::: quiz
q: A design review shows one zone, no alarms, a public database, and a low bill. The requirement is to survive a zone failure. What do you reject first?
+ The single zone. Cost does not outrank a stated availability requirement
- Nothing, because the bill is low and cost is a pillar
- The alarms, and leave one zone
- The private subnets you would have added, to save NAT
why: The requirement filters the design. A cheap single zone fails reliability. Alarms matter and are not a substitute for the second zone.
:::

::: quiz
q: A partner assumes a role in your account for many of their customers. How do you stop their task for someone else from using your role?
+ Condition the trust on an external id that is unique to your agreement
- Use Principal star so the external id is unnecessary
- Share your root password with the partner
- Disable CloudTrail so the confusion is not logged
why: The external id is a confused-deputy check. A wildcard trust makes it worse. Root and blinding the trail are not controls.
:::
