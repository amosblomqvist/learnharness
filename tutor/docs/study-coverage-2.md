# Study coverage (kubernetes, terraform, cloud, containers)

This file is the coverage map for the four modules expanded in parallel with the others. It is not `docs/study-coverage.md`.

## kubernetes

Checker: `npm run check:study -- kubernetes` → 30 lessons, 193 steps, ~21 h, All good. (Before: 13 lessons, 25 steps, ~7 h.)

### Old `k8s-agents` nodes

| Old node | Lesson ids |
| --- | --- |
| t-desired | k8s-why |
| kind | kind-cluster |
| pods | pods, init-sidecars |
| deployments | deployments, rollouts |
| services | services |
| config | config |
| probes | probes |
| resources | resources (the OOMKilled step also remains on probes) |
| storage | storage-k8s |
| debug | debugging |
| helm | eks-helm, kustomize |
| p-deploy-agent | p-k8s |
| gateway-api | ingress, gateway-api |
| autoscale | scaling, autoscale |
| t-least | security-k8s |
| rbac | rbac |
| netpol | netpol |
| quotas | quotas |
| pss | pss |
| ext-secrets | ext-secrets |
| p-secure-ns | p-secure-ns |
| agent-workloads | jobs (Deployment vs Job vs CronJob vs queue worker) |
| model-serving | omitted: optional GPU/vLLM topic; the sandbox cannot run a model server, and a quiz-only lesson would not meet the "do the thing" bar |
| gie | omitted: optional; depends on model-serving and InferencePool CRDs the checker cannot apply |
| spiffe | omitted: optional; SPIRE cannot run in the sandbox, and a fake SVID flow would not be the real attestation path |
| delegation | omitted: optional; it depends on SPIFFE token exchange, which this pass did not teach |
| sandbox | omitted: optional gVisor/Kata/agent-sandbox; pss names stronger runtimes as the next boundary but does not pretend a RuntimeClass exercise runs here |
| p-inference-gw | omitted: optional; it requires the inference gateway and a load test the sandbox cannot host |

### Old `dach-remote` stage `k8s`

| Old node | Lesson ids |
| --- | --- |
| k8s-declare | k8s-why |
| k8s-work | pods, deployments, rollouts |
| k8s-svc | services |
| k8s-debug | debugging, probes |

### Added beyond the old maps

Jobs and CronJobs (`jobs`), DaemonSets (`daemonsets`), init containers and native sidecars (`init-sidecars`), scheduling (`scheduling`), rollout strategy and PodDisruptionBudgets (`rollouts`), Kustomize (`kustomize`), CRDs and operators (`crds`).

### Sandbox limits

No kubectl, kind, or CNI. Exercises are quizzes, cards, Python models of controller decisions, and YAML config checks. A real cluster would unlock ImagePull, drain, and NetworkPolicy deny tests.

### Facts to double-check

- Helm 4.0.0 on 12 Nov 2025; Helm 3 security fixes through 10 Feb 2027 (helm.sh blog).
- Native sidecars (`initContainers` + `restartPolicy: Always`) stable since Kubernetes 1.33.
- `unhealthyPodEvictionPolicy` GA since 1.31. `matchLabelKeys` on topology spread is still documented as beta (on by default since 1.27), not GA.
- EKS Pod Identity is the preferred new-cluster path; IRSA remains for Fargate.
- Gateway API v1.5 (27 Feb 2026) promoted HTTPRoute CORS and other fields to the standard channel. HTTPRoute itself has been GA since v1.
- Restricted Pod Security does not require `readOnlyRootFilesystem`; lessons set it as an extra.

### Depth pass (after the first check)

Brought the short lessons up to the section-2 shape (problem, model, worked case, where it breaks, at work, decision, you can now), each at least 1,200 words: daemonsets, probes, resources, ingress, gateway-api, debugging, kustomize, crds, security-k8s, scaling (HPA only), rollouts, autoscale, rbac, netpol, quotas, pss, ext-secrets. Ingress stays on Ingress. gateway-api is Gateway and HTTPRoute only. scaling keeps the original HPA steps. autoscale owns VPA, KEDA, and node autoscaling. rollouts owns strategy and PodDisruptionBudgets.

File order is now core, then prod, then ops, then traffic, then guard, so an ops lesson is not placed before the prod lessons it needs. Existing ids were not renamed. Original steps of the original lessons stayed first. Giveaway write steps probe_effect, hint, credential, needs_update, release_action, and blast_radius were replaced with scenario quizzes or a predict whose prompt does not state the return table.

p-k8s and p-secure-ns now have a scenario, a requirements list, and how the checker grades them. Original p-k8s steps were not removed.


### Project briefs (follow-up)

p-k8s and p-secure-ns bodies now include the scenario, a numbered requirements list, how the checker grades the files, and which earlier lessons each field comes from. Original steps were not removed. `npm run check:study -- kubernetes` still ends All good.

Checker after this pass: `npm run check:study -- kubernetes` → 30 lessons, 193 steps, ~21 h, All good.

## terraform

### Giveaway writes removed

Replaced the five write steps whose tasks stated the return mapping: action (iac) and review (workflow) are scenario quizzes; edge (hcl), pin (modules-tf), and state_key (envs) are HCL config fixes. Other steps were left in place. `npm run check:study -- terraform kubernetes` ends All good.


Checker: `npm run check:study -- terraform` → 16 lessons, 90 steps, ~11 h, All good. (Before: 9 lessons, 15 steps, ~4 h.) `npx tsc --noEmit -p tsconfig.json` and `npm run build` succeeded. Every `source:` URL returned HTTP 200.

### Old `mlops-iac` stage `iac`

| Old node | Lesson ids |
| --- | --- |
| t-declarative | iac, workflow |
| tf-basics | hcl, variables, data-sources |
| state | state (S3 `use_lockfile`, sensitive values in state) |
| modules | modules-tf |
| expressions | meta (for_each, count, lifecycle), expressions (for, dynamic, functions, conditionals, splat) |
| refactor | refactor (moved, import, removed) |
| tf-test | tf-test (terraform test, validate, tflint, Checkov) |
| envs | envs, tf-team |
| p-tf | p-tf |
| cdk (optional) | cdk |

### Added beyond that map

Provider aliases (`data-sources`), remote state and outputs between stacks (`remote-state`), sensitive values copied through state and `terraform_remote_state` (`state`, `variables`, `remote-state`).

### Not rebuilt from the old p-tf check

The old project text asked for a whole platform: VPC, EKS or Lambda, ECR, Bedrock, per-agent IAM, budgets, tested modules, and a real apply/destroy. The existing lesson id `p-tf` is a production uploads bucket, and this pass kept that contract and deepened it. The platform rebuild would need the cloud and Kubernetes modules plus a Terraform binary the sandbox does not have. It is not a second project in this file.

### Sandbox limits

No `terraform`, AWS, or Checkov process. Exercises are quizzes, cards, Python models, and HCL config checks. `terraform test` is taught as HCL the checker can parse, not executed.

### Facts checked against current docs (2026-10-04)

- S3 backend `use_lockfile` is optional and defaults to false. The lock object is the state key plus `.tflock`. IAM needs `s3:GetObject`, `s3:PutObject`, and `s3:DeleteObject` on that lock object. `s3:DeleteObject` is not required on the state object itself.
- DynamoDB locking is deprecated and scheduled to be removed in a future minor version. Both mechanisms can be set during migration. New stacks in the lesson use only `use_lockfile`.
- Terraform 1.10 introduced S3 lockfiles and called them experimental. The live S3 backend page no longer uses that word. This pass did not pin the exact minor that dropped it.
- `removed` requires a `lifecycle` block. The documented default is to destroy the real object. `destroy = false` forgets it.
- Non-default S3 workspaces store state at `<workspace_key_prefix>/<name>/<key>` with prefix default `env:`.

### Unsure or not re-verified line by line

- `terraform plan -detailed-exitcode` is taught as 0 / 1 / 2. That is the long-standing CLI contract; the plan command page was not re-read in this pass.
- `mock_provider` is linked from the tests mocking page (HTTP 200) but the lesson does not spell a mock block, so a syntax change there would not fail the checker.
- CDK for Terraform is named only to distinguish it from AWS CDK. No claim about whether HashiCorp still ships releases.

## cloud

Checker: `npm run check:study -- cloud` → 30 lessons, 235 steps, ~24 h, All good. (Before: 9 lessons.) `npx tsc --noEmit -p tsconfig.json` and `npm run build` succeeded. Every source URL in the file returned HTTP 200 on 2026-10-04.

Existing ids kept, original steps first: model, iam, vpc, compute, storage, ha, observe, cost, p-design. New lessons: regions, account, iam-deep, cli-sdk, net-edge, containers-aws, eks-aws, serverless, backup, databases, kms, detect, dr, cloudtrail, wa, saa-secure, saa-resilient, saa-perform, saa-cost, p-saas, saa-exam.

Four write steps that spelled the return mapping were replaced with scenario quizzes (SCP intersection, IAM allow versus deny, permission boundary, DynamoDB key). No write steps remain in the module.

### Old aws-saa nodes

| Old node | Lesson ids |
| --- | --- |
| t-api-iam | model, iam, cli-sdk |
| account | account |
| iam-deep | iam-deep |
| regions | regions, model |
| compute | compute |
| containers-aws | containers-aws |
| serverless | serverless |
| storage | storage, backup |
| databases | databases |
| networking | vpc, net-edge |
| security-aws | kms, detect |
| observe-aws | observe, cloudtrail |
| cost | cost |
| wa | wa |
| saa-1 | saa-secure |
| saa-2 | saa-resilient |
| saa-3 | saa-perform |
| saa-4 | saa-cost |
| p-saas-aws | p-saas |
| saa-exam | saa-exam |

aws-agents base: iam and iam-deep, cli-sdk, vpc and net-edge, observe. Organizations and SCPs are in account. Trust policies, STS, and permission boundaries are in iam-deep. EKS Pod Identity is in eks-aws. Route 53, CloudFront, ALB versus NLB, PrivateLink, and Transit Gateway are in net-edge.

### Omissions

No project at the end of the found or build stages. p-design ends run. p-saas is the exam-stage project. saa-exam is 42 mixed scenario questions, not a third project. Bedrock and the rest of aws-agents are phase C. The sandbox has no AWS CLI, so nothing is applied in an account.

### Unsure or not re-read line by line

- Aurora is taught as six copies across three zones, with regional failover typically well under a minute. That is the long-standing overview claim. The overview page was not re-read sentence by sentence in this pass.
- ElastiCache is named as Valkey, Redis OSS, or Memcached. Recheck the engine names if AWS renames the Redis-compatible offering.
- Resource control policies are one sentence in the account lesson, as a maximum on resource-based policies. The exercises are SCPs. The RCP page was not re-read.
- Direct Connect and Data Firehose appear only as options in saa-perform, not as their own lessons.

## containers

14 lessons, 98 steps, about 10 hours. `npm run check:study -- containers` ended with All good. Source URLs in the module were checked with `curl -sIL` on 2026-10-04 and returned HTTP 200 (38 unique URLs).

### Lessons

| id | Stage | What it covers |
| --- | --- | --- |
| what | basics | Image, container, writable layer, `-p`, env, logs on stdout. Old `t-container`. |
| isolation | basics | PID, mount, network, UTS, IPC, cgroup, and user namespaces; cgroup v2 `memory.max` and `cpu.max`; Docker Desktop's Linux VM. Old `t-container`. |
| images | basics | overlay2 lower/upper/merged, whiteouts, image config versus layers, cache invalidation. Old `images`. |
| dockerfile | basics | Instruction order, exec form, `EXPOSE` versus publish, `ARG` versus `ENV`. Old `dockerfile`. |
| buildkit | basics | Build context, `.dockerignore`, cache mounts, secret mounts. |
| small-images | prod | Multi-stage, slim versus Alpine musl, distroless, non-root. Old `multistage`. |
| runtime | prod | PID 1, logs, exec, inspect, exit 137 versus 143, `OOMKilled`. Old `run-debug`. |
| networks | prod | Bridge, host, none, container mode, published ports, Compose DNS. Old `run-debug`. |
| volumes | prod | Named volume, bind mount, tmpfs, copy-up, uid. Old `run-debug`. |
| health | prod | Health states, start period, restart policies. |
| compose | prod | Service DNS, `service_healthy`, named volumes, one-shot migrations. Old `compose`. |
| registries | prod | Tags, digests, multi-arch indexes, ECR immutable tags. Old `registries`. |
| supply | prod | Secrets in layers and `ENV`, SBOM versus scan, distroless limits. Old `image-security`. |
| p-containerize | prod | Project brief, Dockerfile, Compose, digest pin. Old `p-containerize`. |

Existing lesson ids are unchanged. Existing steps are still first in each original lesson. New steps are appended. No write steps were added.

### Old git-docker `docker` nodes

| Old node | Lesson ids |
| --- | --- |
| t-container | what, isolation |
| images | images |
| dockerfile | dockerfile, buildkit |
| multistage | small-images |
| run-debug | runtime, networks, volumes |
| compose | compose |
| registries | registries |
| image-security | supply |
| p-containerize | p-containerize |

Healthchecks and restart policies are the `health` lesson. Namespaces and cgroups are `isolation`.

### Omissions

The basics stage does not end in a project. The only project is `p-containerize`, at the end of prod. The sandbox has no Docker daemon, so nothing is built or run. Practice is quizzes, predict steps, and Dockerfile or Compose config.

### Unsure or not re-read line by line

- A private cgroup namespace is described as what current runc gives a container. `memory.max` and `cpu.max` are the cgroup v2 files. The runc default was not re-read from source in this pass.
- Linux has a time namespace. The lesson says an ordinary `docker run` does not turn it on. That negative is not a sentence copied from a Docker page.
- Restart policies were checked against the Docker "start containers automatically" page. `on-failure` does not start a container just because the daemon restarted. A policy applies after the container has been up for at least 10 seconds. `unless-stopped` stays stopped across a daemon restart only when you stopped it.
- Distroless is cited from its GitHub repo. The numeric uid of `nonroot` is not stated.
- A multi-arch tag points at an index of per-platform manifests. The index page of the OCI spec was not re-read line by line.
- cosign and Notation are named as signing tools and are not given source URLs. SBOM and provenance cite Docker's attestations page. Scout, Trivy, and ECR scanning are named as scanners.
