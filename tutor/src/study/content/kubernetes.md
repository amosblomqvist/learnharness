# Kubernetes
id: kubernetes
blurb: Run containers on a cluster: desired state, workloads, services, config, scheduling, storage, traffic, security, and the way teams ship to EKS.
why: Kubernetes comes last because it uses everything before it: Linux processes and signals, networking, containers, cloud infrastructure, and the declarative desired-state idea you met in Terraform.
stage: core | The core objects | Run an app on a cluster and reach it.
stage: prod | Production settings | Configure, schedule, keep healthy, and size workloads properly.
stage: ops | Operating a cluster | Route traffic in, debug, package, and ship to EKS.
stage: traffic | Traffic and scale | Route with the Gateway API and scale on a real signal.
stage: guard | Least privilege | Lock a namespace down: identity, network, quota, and pod security.

## What Kubernetes does
id: k8s-why
stage: core
needs: containers/runtime, terraform/iac
minutes: 40
goal: Explain the control loop at the heart of Kubernetes, who stores desired state, and why apply is idempotent.
source: Kubernetes: Overview | https://kubernetes.io/docs/concepts/overview/
source: Kubernetes: Cluster architecture | https://kubernetes.io/docs/concepts/architecture/
source: Kubernetes: Controllers | https://kubernetes.io/docs/concepts/architecture/controller/

You already know how to run one container. The painful part starts when there are many of them, on more than one machine, and they have to stay running after you close the laptop. People invent the same pile of scripts: SSH to each host, `docker run`, a cron job that restarts what died, a spreadsheet of which port is free. The scripts drift. A node reboots and nobody notices until customers do. Kubernetes is that pile, turned into a small set of programs that never stop comparing what you asked for with what is actually running.

### The problem it was built to solve

A process on one Linux machine is easy to reason about. You saw that in the containers module: a container is a process with its own namespaces and a cgroup limit. The moment you want three copies, on machines you do not log into by hand, with a stable name other programs can call, the questions change. Who starts the third copy if the second machine dies? Who notices the copy is gone? Where is the record of "three" so a new operator can see it next week? If two people both "fix" production, whose fix wins?

The answer Kubernetes picked is the same idea you met in Terraform, with one change of tempo. You declare **desired state**. Something else keeps working until reality matches, and then keeps watching, because reality keeps changing. Terraform's loop is usually "you run plan and apply". Kubernetes' loop runs all the time, without you in the session.

### The mental model

```text
you ──kubectl apply──▶ API server ──▶ etcd (the record of what should exist)
                           ▲
     controllers ──watch───┘   "3 replicas wanted, 2 running → create one"
     scheduler ────watch───┘   "this new pod has no node → pick node-b"
     kubelet (on each node) ── "pods assigned here → start their containers"
```

Four pieces matter more than the rest of the diagram people tape to the wall.

The **API server** is the only front door. kubectl, controllers, the scheduler, and the kubelet all talk to it. Nothing writes to the database behind its back. That is why every change is authorized, validated, and recorded the same way.

**etcd** is that database. It stores the objects you applied and the status the system reports back. If you can read etcd (or the API, which is the supported way), you can answer "what did we ask the cluster to be?" Desired state is data, not a script that already ran.

**Controllers** are loops. Each one watches a kind of object, compares spec with status, and takes one small action. The ReplicaSet controller's whole job is "the spec says N pods with these labels; count the ones that exist; create or delete until the count matches." The Deployment controller does not run containers. It writes ReplicaSets. The node controller notices a node that stopped reporting. None of them is a special case of magic. They are programs that read and write API objects.

The **scheduler** only decides *where*. A new pod comes in with no node name. The scheduler filters nodes that cannot take it (not enough free memory compared with the pod's requests, a taint the pod does not tolerate, a node selector that does not match) and scores the rest. It then writes the chosen node name back onto the pod. It does not start the container.

The **kubelet** on each node does that. It watches the API for pods bound to itself, talks to the container runtime (containerd on almost every cluster you will touch in 2026), starts the containers, and reports status: running, waiting, terminated, probe results. If the kubelet cannot pull the image, the pod stays on that node and the status says why. The scheduler will not move it for you. That distinction is the source of half the debugging lessons later.

There is also a **controller manager** process that hosts the built-in controllers, and a cloud controller when you run on AWS, GCP, or Azure (it creates load balancers and disks when Services and volumes ask for them). On EKS, AWS runs the control plane for you. You still own the worker nodes' kubelets, or you let an autoscaler own them.

### A worked example, the small one

You apply a Deployment that wants 3 replicas. The API server stores it. The Deployment controller creates a ReplicaSet whose template is a copy of the pod template. The ReplicaSet controller sees 0 pods and creates 3 pod objects. Those pods have no node. The scheduler binds each one. Three kubelets start three containers.

Now you delete one pod with `kubectl delete pod`. You did not change the Deployment. The ReplicaSet controller's next pass counts 2 pods that match its selector and creates a new one. The new pod gets a new name. That is the whole of "self-healing". It is not a restart of the same pod. It is a new object, because the controller's spec says "three matching pods", not "these three names forever".

`kubectl apply -f app.yaml` a second time, with the file unchanged, is a no-op that still succeeds. Apply sends the desired state. The API server sees the objects already match. This is why apply is safe to run from CI on every commit. `kubectl create` is not: the second run errors because the name exists. Prefer apply.

### A realistic pass

A node stops sending heartbeats. The node controller marks it NotReady. Pods on that node are not deleted instantly; Kubernetes waits (by default on the order of minutes, controlled by the node's lease and pod-eviction timeouts) so a brief network blip does not stampede the cluster. Then the pods are evicted. The ReplicaSet controller sees the missing count and creates replacements. The scheduler places them on nodes that are Ready and have room. The Service, which you will meet later, never stored those pod names. It selects labels, so the new pods start receiving traffic once they are Ready.

That chain is why "the node died and the site stayed up" is not a property of the container. It is a property of a controller that still wanted three replicas, plus a scheduler that had somewhere else to put them, plus a Service that did not care about pod names. Miss any one of those and the story fails. A bare pod has no controller. If its node dies, nothing recreates it.

### Where it breaks

**Editing live objects and forgetting Git.** `kubectl edit` or `kubectl scale` changes the object in etcd. The next apply from an old file puts the old number back. The next apply from GitOps puts Git's number back, which is what you want only if Git was updated. Two writers, one object. Pick one source of truth. The GitOps lesson at the end of the module is this rule with a name.

**Controllers that fight.** Two Deployments whose selectors both match the same pods will both try to own them. Selectors must be disjoint. The Deployment lesson shows the error the API server actually returns when the selector does not match the template.

**Assuming the scheduler moves a stuck pod.** ImagePullBackOff, a crashing container, a volume that cannot attach: the pod already has a node name. The scheduler is done. You fix the image, the quota, or the zone. Deleting the pod is sometimes the right nudge, because the controller creates a fresh one that can be scheduled again. Deleting the pod is not "the restart button" for a bare pod with no controller.

**Treating YAML as the system.** YAML is a way to spell objects. The system is the control loops. A diagram of boxes labeled "pod, service, ingress" does not tell you who acts when a node dies. When you are stuck, ask which controller should have acted, and what object it reads.

**kind is not a small production cluster.** `kind` (Kubernetes in Docker) runs nodes as containers on your laptop so you can apply real manifests. It is the right place to learn. It is the wrong place to learn about cloud load balancers, EBS volumes, or IAM roles. Those need a real cloud, which is why the EKS lesson is separate. A kind node that disappears takes its pods with it, and your laptop's Docker is the "hardware".

### How this shows up at work

Platform teams treat the cluster as a product: namespaces, quotas, and a pipeline that applies manifests. Application teams rarely SSH. They review YAML or a Helm chart, and a controller (Argo CD, Flux) applies it. The reconciliation idea is the one you already used with Terraform: the tool computes a difference and tries to close it. Terraform closes it when you apply, against cloud APIs. Kubernetes closes it continuously, against pods that die on their own.

You will feel the Linux module here every time a container is OOMKilled (exit 137) or receives SIGTERM on shutdown. You will feel the containers module because the kubelet is just asking containerd to run an image. You will feel IAM when a Service of type LoadBalancer asks AWS for a real load balancer and the node role is not allowed to.

### When you would not reach for it

One process on one VM, a static site on object storage, or a function that runs ten times a day does not need a scheduler and etcd. Kubernetes costs operational complexity: upgrades, certificates, noisy neighbors, YAML review. Use it when you need several copies, rolling replacement, a stable internal name, and a place for many teams to share a cluster without sharing root on the nodes. If you cannot say which of those you need, you are probably early.

### You can now

- Name what the API server, etcd, a controller, the scheduler, and the kubelet each do, in one sentence.
- Explain, in order, who recreates a pod after you delete it by hand.
- Say why a second `kubectl apply` of the same file succeeds, and why `kubectl create` does not.
- Say why a bare pod is not self-healing.
- Say what kind is for, and what it cannot teach you.

::: quiz
q: A Deployment wants 3 replicas. You delete one of its pods by hand. What happens?
- It stays at 2 until you apply again
+ The ReplicaSet controller sees 2 of 3 and creates a new pod within seconds
- The Deployment is deleted
- Kubernetes restarts the node
why: Controllers keep reconciling. Deleting a pod by hand is a common way to restart it.
:::

::: card
q: What do the scheduler and the kubelet each do?
answer: The scheduler picks which node a new pod should run on. The kubelet on that node actually starts and watches the pod's containers, and reports their status back.
:::

::: quiz
q: You run `kubectl apply -f web.yaml` twice, and the file did not change. What should the second run do?
- Fail, because the Deployment already exists
+ Succeed and leave the objects as they are; apply sets desired state, it does not mean "create once"
- Delete the Deployment and create it again, causing downtime
- Restart every pod, because apply always rolls out
why: Apply is idempotent. The API server compares the declared objects with what is stored. `kubectl create` is the command that fails the second time, which is why teams and CI use apply. Apply also does not restart pods unless the pod template actually changed.
:::

::: quiz
q: A pod is Pending with `0/3 nodes are available: 3 Insufficient cpu`. Which component is refusing to place it?
- The kubelet, which starts containers
- etcd, which rejected the write
+ The scheduler, which will not bind a pod whose CPU request does not fit on any node
- The ReplicaSet controller, which only creates the pod object
why: The scheduler filters nodes by requests, taints, and affinity, then binds the pod. The ReplicaSet controller already did its job by creating the pod object. The kubelet only acts after a node is chosen. Free memory you see in `top` on the node is not what the scheduler uses; it uses the sum of pod requests.
:::

::: card
q: In a Kubernetes cluster, what is etcd for, as opposed to the scheduler?
answer: etcd stores the cluster's objects (desired state and reported status) behind the API server. The scheduler does not store that record; it only chooses a node for pods that do not have one yet and writes the node name back through the API.
:::

::: predict lang=python
q: A ReplicaSet wants 3 pods. This function decides the next action from the desired count and how many matching pods exist. What does it print?
code:
```python
def plan(desired, have):
    gap = desired - have
    if gap > 0:
        return f"create {gap}"
    if gap < 0:
        return f"delete {-gap}"
    return "steady"

print(plan(3, 1))
print(plan(3, 3))
print(plan(2, 5))
```
answer:
```text
create 2
steady
delete 3
```
why: The controller's decision is arithmetic on the spec, not a memory of which pod you deleted. One short of 3 creates two. An exact match does nothing, which is why apply of an unchanged file is quiet. Five when you want two means delete three extras. Real ReplicaSets choose which pods to delete with a policy; the count is the part that matters first.
:::

::: write lang=python
task: A ReplicaSet keeps the lexicographically smallest `desired` pod names and deletes the rest. Implement `reconcile(desired, existing)` so it returns `{"create": n, "delete": [...]}`. `existing` is a list of pod names. If there are too few, `create` is how many new pods are needed and `delete` is empty. If there are too many, `create` is 0 and `delete` lists the names to remove, in sorted order. If `desired` is 0, delete every existing name.
starter:
```python
def reconcile(desired, existing):
    return {"create": desired, "delete": []}
```
tests:
```python
from solution import reconcile

def test_scale_up():
    assert reconcile(3, ["pod-a"]) == {"create": 2, "delete": []}

def test_scale_down_keeps_smallest_names():
    assert reconcile(1, ["b", "a", "c"]) == {"create": 0, "delete": ["b", "c"]}

def test_steady():
    assert reconcile(2, ["a", "b"]) == {"create": 0, "delete": []}

def test_to_zero():
    assert reconcile(0, ["b", "a"]) == {"create": 0, "delete": ["a", "b"]}
```
solution:
```python
def reconcile(desired, existing):
    names = sorted(existing)
    if len(names) > desired:
        return {"create": 0, "delete": names[desired:]}
    return {"create": desired - len(names), "delete": []}
```
hint: Sort the names first. The ones you keep are the slice `names[:desired]`. Everything after that index is what you delete. Create only when the list is shorter than `desired`.
:::

::: quiz
q: You built an image on your laptop and created a pod in a local kind cluster that uses that image name. The pod stays ImagePullBackOff. What is the usual cause?
- kind clusters cannot run your own images, only Docker Hub
+ The image exists in your laptop's Docker, but kind's nodes are separate containers with their own containerd, so the image was never loaded into the node
- The scheduler refuses locally built images
- ImagePullBackOff means the container crashed after it started
why: kind nodes are containers. They do not see the host's image store. `kind load docker-image` copies the image into the node. ImagePullBackOff means the runtime could not fetch the image; a crash after start is CrashLoopBackOff. The scheduler already placed the pod, which is why a pull error does not move it to another node by itself.
:::

## A local cluster with kind
id: kind-cluster
stage: core
needs: k8s-why
minutes: 35
goal: Read a kind cluster config, switch kubectl contexts, and explain why a local image is invisible until you load it.
source: kind: Quick start | https://kind.sigs.k8s.io/docs/user/quick-start/
source: kind: Configuration | https://kind.sigs.k8s.io/docs/user/configuration/
source: kubectl: Contexts | https://kubernetes.io/docs/tasks/access-application-cluster/configure-access-multiple-clusters/

kind runs a real Kubernetes cluster by making each node a container. You use it to apply the same YAML you will later apply to EKS, on a laptop, with no cloud bill. It is not a simulator of the YAML. The API server, scheduler, and kubelet are the real programs. What is fake is the hardware: a "node" is a Docker container, and its disk vanishes when the container does.

### The problem

Installing Kubernetes by hand, even with kubeadm, is a lesson about certificates and etcd that you do not need yet. You need `kubectl` pointed at something that accepts manifests, and you need to throw it away when you break it. kind is that. `minikube` is the other common choice (one node in a VM or container). kind is the one this course uses because a multi-node cluster is a config file, which matters as soon as you care about DaemonSets, topology spread, or "this pod landed on the wrong node".

### What a cluster config actually says

```yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: dev
nodes:
  - role: control-plane
  - role: worker
  - role: worker
```

`kind: Cluster` here is kind's own config, not a Kubernetes `kind: Pod`. The apiVersion `kind.x-k8s.io/v1alpha4` is the config schema. `name: dev` becomes the kubectl context name `kind-dev`. One control-plane node and two workers is enough to see a pod scheduled onto a worker and to see a DaemonSet create two pods (one per worker) plus one on the control plane unless you tainted it.

kind's defaults already taint the control plane so ordinary workloads stay on workers, the same way a real cluster does. If every pod is Pending and the only node is the control plane, the taint is why. A toleration or a worker node is the fix, not "kind is broken".

Create and delete look like this:

```bash
kind create cluster --config kind.yaml
kubectl cluster-info --context kind-dev
kind delete cluster --name dev
```

Deleting the cluster deletes the containers and the etcd inside them. There is no recovery. That is the point.

### Contexts

kubectl talks to one cluster at a time, chosen by a **context** in `~/.kube/config`. A context is a cluster address, a user (a client certificate, for kind), and a default namespace. `kubectl config get-contexts` lists them. `kubectl config use-context kind-dev` switches. The current context is how people wipe the wrong cluster. Before any delete, read the prompt or run `kubectl config current-context`. Production kubeconfigs belong in a separate file you pass with `--kubeconfig`, not mixed casually with kind.

### Images

You build `api:dev` on the laptop. You write a pod that says `image: api:dev` and `imagePullPolicy: IfNotPresent`. It still fails with ImagePullBackOff. The node is a container with its own containerd. It cannot see the host's image list. Two ways out:

- `kind load docker-image api:dev --name dev` copies the image into the cluster's nodes. Pull policy must not be `Always`, or the node tries the registry anyway and fails if the tag was never pushed.
- Or push to a registry the node can reach. kind nodes often cannot reach your laptop's `localhost:5000` without extra container-network setup. Loading is the path that works on the first day.

`imagePullPolicy: Never` means "only the local store; do not try a registry". Useful in kind once you have loaded the image. Dangerous in production, where a new node has an empty store and the pod never starts.

### What kind will not teach you

A Service of type LoadBalancer stays pending, or kind's Docker provider maps a port on localhost, depending on the config. You do not get an AWS network load balancer. A PersistentVolume backed by EBS cannot exist. IAM roles for service accounts do not exist. Pods can talk to each other on the kind network, which is enough for Services, NetworkPolicy (if you installed an implementation; kind does not enable a policy controller unless you add one, Calico or Cilium), and probes.

So: use kind to practice objects, selectors, rollouts, and RBAC. Do not use a green kind test as evidence that your AWS integration works.

### Where people get hurt

**Port 6443 already in use.** A leftover kind or k3s is holding the API port. `kind get clusters` and delete the old one.

**Changing the config does not edit a running cluster.** `kind create` reads the file once. Adding a worker means a new cluster, or kind's node-image procedures you do not need yet. Recreate. It is cheap.

**Clock and DNS inside the node.** Corporate SSL inspection breaks image pulls from Docker Hub. The error is still ImagePullBackOff; `kubectl describe pod` shows the certificate or timeout. That is a laptop network problem, not a Deployment bug.

**Running as root in the pod by default.** kind does not turn on the restricted Pod Security Standard. A pod that works in kind may be rejected later in a namespace labeled `pod-security.kubernetes.io/enforce: restricted`. You will meet that standard in the security lessons. Do not treat "kind accepted it" as "production will".

### At work

Most teams do not develop inside a remote cluster on day one. They run kind or a small shared dev cluster, review the manifests in Git, and let CI apply them to a real environment. The skill you are building is not "click kind". It is "my YAML was accepted by a real API server, the scheduler placed the pod, and I can read why it did not".

### You can now

- Point at a kind config and say which nodes exist and what the context will be called.
- Explain why `kind load docker-image` is required for an image you only built locally.
- Say what a kubectl context selects, and why you check it before deleting.
- Name two production concerns kind cannot prove (cloud load balancers, IAM, or EBS).

::: quiz
q: In a kind config, what does `name: dev` under `kind: Cluster` change for kubectl?
- It sets the default namespace to `dev`
+ It names the cluster so the kubectl context is `kind-dev`
- It labels every pod with `dev`
- It selects which Kubernetes version to install on EKS
why: kind prefixes cluster names with `kind-` in the kubeconfig context. The namespace is still `default` until you set one. Pod labels are unrelated to the cluster name. EKS versions are chosen in AWS, not in a kind file.
:::

::: quiz
q: A kind cluster has one control-plane node and no workers. A Deployment stays Pending. `describe` mentions a taint on the control plane. What is going on?
- The image failed to pull, and kind reports that as a taint
+ kind taints the control-plane node so ordinary pods are not scheduled there, and there is no worker to take them
- Deployments cannot run on kind
- The API server only schedules pods after you install ingress
why: Control-plane nodes are tainted (`node-role.kubernetes.io/control-plane`) so app pods stay on workers, matching production practice. With no worker, nothing can schedule the pod. Image pull errors look different (ImagePullBackOff) and only happen after a node is assigned.
:::

::: card
q: Why can a pod in kind fail with ImagePullBackOff for an image that `docker images` already lists on your laptop?
answer: Each kind node is a container with its own container runtime and image store. The laptop's Docker images are not in that store until you `kind load docker-image` (or the node pulls the image from a registry it can reach).
:::

::: config lang=yaml
task: Write a kind cluster config named `lab` with one control-plane node and two workers. This is kind's config file, not a Pod.
starter:
```yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: lab
nodes:
  - role: control-plane
```
check: kind = Cluster | The document is a kind Cluster config
check: apiVersion = kind.x-k8s.io/v1alpha4 | apiVersion is kind's config version
check: name = lab | The cluster is named lab
check: nodes count 3 | There are three nodes
check: nodes[0].role = control-plane | The first node is the control plane
check: nodes[1].role = worker | The second node is a worker
check: nodes[2].role = worker | The third node is a worker
solution:
```yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: lab
nodes:
  - role: control-plane
  - role: worker
  - role: worker
```
hint: `nodes` is a list. Each item needs `role:`. You already have the control plane; add two more list items with `role: worker`.
:::

::: quiz
q: You set `imagePullPolicy: Always` on a pod and loaded `api:dev` into kind with `kind load`. The tag was never pushed to a registry. What happens?
- The load is enough, because Always still prefers the local image
+ The kubelet tries the registry every time, the registry does not have the tag, and the pod stays ImagePullBackOff
- Always means "always use the loaded image and never the network"
- kind rewrites Always to Never when it loads an image
why: `Always` pulls on every start. A loaded image satisfies `IfNotPresent` or `Never`, not `Always`. kind does not rewrite your pull policy. This is the usual "I loaded it and it still pulls" bug.
:::

::: predict lang=python
q: This models kind's image visibility. `host` is the laptop store, `node` is the node's store. What does it print?
code:
```python
def visible(host, node, name):
    if name in node:
        return "run"
    if name in host:
        return "load-first"
    return "pull-or-fail"

print(visible({"api:dev"}, set(), "api:dev"))
print(visible({"api:dev"}, {"api:dev"}, "api:dev"))
print(visible(set(), set(), "nginx:1.27"))
```
answer:
```text
load-first
run
pull-or-fail
```
why: An image only on the host is not runnable inside the node until it is copied. Once it is in the node store, the kubelet can run it (assuming the pull policy allows a local hit). An image in neither store has to be pulled from a registry or the start fails.
:::

## Pods and manifests
id: pods
stage: core
needs: k8s-why
minutes: 40
goal: Read a Pod manifest, explain the shared network and volume namespace, and say why you almost never create a bare Pod.
source: Kubernetes: Pods | https://kubernetes.io/docs/concepts/workloads/pods/
source: Kubernetes: Labels and selectors | https://kubernetes.io/docs/concepts/overview/working-with-objects/labels/
source: Kubernetes: Namespaces | https://kubernetes.io/docs/concepts/overview/working-with-objects/namespaces/

A pod is the smallest thing the scheduler will place. It is not "a container", and it is not "a deployment". It is one or more containers that always run together, on the same node, sharing one IP address and able to share volumes. You write a pod spec constantly. You rarely create a pod object by hand, because nothing will recreate it.

### The problem

Containers in the containers module are one process tree each. Real processes often need a neighbour: a proxy that terminates TLS, a log shipper that reads the same files, a helper that must be on the same machine because the connection is `localhost`. If you schedule those as separate pods, they can land on different nodes, and `localhost` means the wrong machine. If you stuff every helper into the application image, you rebuild the app to change the helper. A pod is the unit that says "these containers are one scheduling decision".

### The four parts of every manifest

Every object you apply has the same skeleton. Pods are just the first kind you meet.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: hello
  namespace: shop
  labels:
    app: hello
spec:
  containers:
    - name: web
      image: nginx:1.27
      ports:
        - containerPort: 80
```

`apiVersion` and `kind` pick the schema. Core objects (Pod, Service, ConfigMap, Secret, Namespace) are `v1`. Deployments are `apps/v1`. Ingress is `networking.k8s.io/v1`. A typo here is not a style issue. The API server rejects the object or, worse, stores a version you did not mean.

`metadata` is identity: name, namespace, labels, annotations. Names are unique inside a namespace, not across the cluster. `shop/hello` and `billing/hello` are different pods.

`spec` is what you want. `status` is what the system reports. You do not author status. Controllers and the kubelet do. If you copy a `kubectl get -o yaml` dump back into Git, strip status, or you will fight the control plane.

YAML rules that actually cause outages: indentation is spaces, and it is structure. A tab breaks the parse. `containers` is a list, so one container still needs `- name`. `ports` is a list of mappings, so `containerPort` sits under `-`, not beside `ports` as a sibling that YAML quietly turns into a broken shape. The parser in this course will reject some of those mistakes; `kubectl` will too, with a line number you should read.

`containerPort` does not publish the port. It documents it. Other pods can reach it only if they can route to this pod's IP, which they usually do through a Service, not through a port you "opened" in the manifest. Host ports and host network exist and are how you accidentally take over a node. You will lock those down with Pod Security later.

### One IP, shared volumes

Containers in a pod share the network namespace. One IP, one loopback, one set of ports. The web container reaches an envoy sidecar on `127.0.0.1:9901`. They cannot both bind `0.0.0.0:80`. That collision looks like a crash loop, and `describe` says the container failed to start, not "selector mismatch".

They do not share the process namespace unless you set `shareProcessNamespace: true`. By default one container cannot see the other's processes or send them signals. They also do not share the filesystem unless you mount the same volume into both. An `emptyDir` volume lives as long as the pod does and dies with it. That is how a log shipper reads the app's files without `localhost` being involved: same volume, two mount paths.

The pod is scheduled as a unit. If the node does not have room for the sum of the containers' requests, the whole pod stays Pending. You cannot put the sidecar on a different node. If you need that, they are two pods and a Service.

### Labels are the only stable handle

Pod names change. A ReplicaSet names pods `web-7d8f9c-xk2pq`. Killing one creates `web-7d8f9c-mm1aa`. Anything that stored the first name is now wrong. Labels are key/value tags you choose (`app: hello`, `tier: web`). Selectors on Services, NetworkPolicies, and PodDisruptionBudgets match labels, not names.

Labels are data, not decoration. A Service with `selector: app: hello` sends traffic to every pod in that namespace with that label, including one you created by hand while debugging. A label that is too broad (`app: web` on both the API and the worker) merges two programs into one Service. A label that is missing means the Service has no endpoints and calls hang until they time out. You will debug that exact symptom in the Services lesson.

Annotations are the other bag of metadata. They are not for selection. Controllers and ingress implementations read them (`alb.ingress.kubernetes.io/...`). Do not "select" on an annotation. The API does not work that way.

### Namespaces

A namespace is a folder for names, plus the scope of RBAC and quotas. It is not a hard network boundary. Pods in `dev` can call pods in `prod` by DNS unless a NetworkPolicy says otherwise. People learn this the day a dev workload hits the production database Service by its full DNS name. Namespaces organise identity and limits. Network policy isolates traffic. You need both, and they are different lessons.

`kube-system` holds cluster components. Do not put your app there. Do not grant your app's ServiceAccount rights there.

### Why a bare pod is a trap

Apply the manifest above. The scheduler places it. The kubelet runs it. Delete the node, or delete the pod, and it is gone. No controller wanted it. The only pod objects you should expect to see in production are ones owned by a Deployment, Job, DaemonSet, or StatefulSet, plus the occasional debug pod you delete when you are done.

`kubectl run` creates a pod (or, with flags, a deployment). It is fine for a thirty-second test in kind. It is not how you ship.

### Where manifests break

**The spec that kind accepts and prod rejects.** No resource requests, running as root, a writable root filesystem. kind's default Pod Security is permissive. A namespace with the restricted standard will refuse the same YAML. Write the securityContext now; the security lesson shows the fields.

**`latest`.** The tag moves. Two nodes can pull two different digests. Rollouts become unreproducible. Pin a version or a digest. The project at the end of the module rejects `latest` for this reason.

**Forgetting the namespace in the file and relying on `kubectl --namespace`.** The next person applies the file and creates a second copy in `default`. Put `metadata.namespace` in the manifest when the environment is fixed, or be explicit in the GitOps app. Do not depend on someone's shell.

### At work

You will read pod YAML inside a Deployment's `template` far more often than as a top-level object. The template is still a pod spec. Every probe, resource, volume, and security field you learn lives there. When a platform team says "the unit of scheduling is a pod", they mean requests are summed, affinity is on the pod, and a crash of one container can restart the others depending on `restartPolicy` (Always for Deployments).

### You can now

- Point at apiVersion, kind, metadata, and spec in a manifest.
- Explain how two containers in one pod reach each other, and what they do not share.
- Say why Services select labels rather than pod names.
- Say why a namespace is not a network firewall.
- Refuse to ship a bare pod as the way an app stays running.

::: quiz
q: Two containers are in the same pod. How does one reach the other's port 9000?
+ `localhost:9000`; containers in a pod share one network namespace
- By the other container's name
- Through a Service
- They can't talk to each other
why: A pod has one IP shared by all its containers, like processes on one machine.
:::

::: config lang=yaml
task: Write a Pod manifest: name `api`, label `app: api`, one container named `api` running image `ghcr.io/acme/api:1.0.0` with container port `8000`.
starter:
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: api
spec:
  containers:
  name: api
  image: ghcr.io/acme/api:1.0.0
```
check: apiVersion = v1 | apiVersion is v1
check: kind = Pod | kind is Pod
check: metadata.name = api | The pod is named api
check: metadata.labels.app = api | It's labelled app: api
check: spec.containers count 1 | containers is a list with one item
check: spec.containers[0].name = api | The container is named api
check: spec.containers[0].image = ghcr.io/acme/api:1.0.0 | It runs ghcr.io/acme/api:1.0.0
check: spec.containers[0].ports[0].containerPort = 8000 | It declares containerPort 8000
solution:
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: api
  labels:
    app: api
spec:
  containers:
    - name: api
      image: ghcr.io/acme/api:1.0.0
      ports:
        - containerPort: 8000
```
hint: `containers:` is a list, so its item starts with `- name: api`, and the item's other keys line up under `name`. Same for `ports:` → `- containerPort: 8000`.
:::

::: quiz
q: A Pod manifest sets `containerPort: 80` and nothing else about networking. What did that field do?
- It opened port 80 on every node's IP
+ It recorded the port the container listens on; it did not publish the port or create a Service
- It created a ClusterIP Service on port 80
- It blocked other containers in the pod from using port 80
why: `containerPort` is documentation the kubelet and tools can show. Publishing is a Service, a hostPort, or hostNetwork. Another container in the same pod could still bind the same port and fail at start; the field does not reserve it cluster-wide.
:::

::: card
q: In Kubernetes, what do containers in the same pod share, and what do they not share unless you add it?
answer: They share one network namespace (one IP and localhost) and the pod's volumes when you mount them. They do not share a process namespace or a filesystem unless you set shareProcessNamespace or mount the same volume into each container.
:::

::: quiz
q: You delete a bare Pod that you applied with `kubectl apply -f pod.yaml`. There is no Deployment or Job. What recreates it?
- The ReplicaSet controller, because every pod has one
- The kubelet, which restarts deleted pods
- The scheduler, on its next pass
+ Nothing. A bare pod has no controller, so it stays deleted until you apply it again
why: Self-healing comes from a controller whose spec still demands the pods. The kubelet restarts containers inside a pod according to restartPolicy; it does not recreate a pod object you deleted. The scheduler only places pods that exist.
:::

::: predict lang=python
q: A Service selects `app=web`. This function says whether a pod is in the set. What does it print?
code:
```python
def selected(labels):
    return labels.get("app") == "web"

print(selected({"app": "web", "pod-template-hash": "abc"}))
print(selected({"app": "worker"}))
print(selected({"tier": "web"}))
```
answer:
```text
True
False
False
```
why: Selectors match key and value. Extra labels do not exclude a pod, which is why the ReplicaSet's hash label does not stop a Service from seeing the pod. A different value, or the right value on the wrong key, does not match. `tier: web` is not `app: web`.
:::

::: config lang=yaml
task: Fix this Pod. It must be named `logger` in namespace `shop`, labelled `app: logger`, and run one container `logger` from `ghcr.io/acme/logger:2.1` whose only port is containerPort 8080. The list shape is currently wrong.
starter:
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: log
spec:
  containers:
    name: logger
    image: ghcr.io/acme/logger:latest
    ports:
      containerPort: 80
```
check: metadata.name = logger | The pod is named logger
check: metadata.namespace = shop | It is in namespace shop
check: metadata.labels.app = logger | Label app=logger
check: spec.containers count 1 | containers is a one-item list
check: spec.containers[0].name = logger | The container is named logger
check: spec.containers[0].image = ghcr.io/acme/logger:2.1 | Image is pinned to 2.1, not latest
check: spec.containers[0].ports[0].containerPort = 8080 | containerPort is 8080
solution:
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: logger
  namespace: shop
  labels:
    app: logger
spec:
  containers:
    - name: logger
      image: ghcr.io/acme/logger:2.1
      ports:
        - containerPort: 8080
```
hint: Add `-` so `containers` and `ports` are lists. Put `namespace` and `labels` under `metadata`, next to `name`, not under `spec`.
:::

## Deployments
id: deployments
stage: core
needs: pods
minutes: 40
goal: Run replicated pods with a Deployment, keep the selector honest, and roll forward and back when the template changes.
source: Kubernetes: Deployments | https://kubernetes.io/docs/concepts/workloads/controllers/deployment/
source: Kubernetes: ReplicaSet | https://kubernetes.io/docs/concepts/workloads/controllers/replicaset/

A Deployment keeps N copies of a pod template running, and replaces those copies when the template changes. It is the object you want for a stateless web API. It is the wrong object for a pod that must be exactly one specific name on every node (DaemonSet), for a batch that should finish (Job), or for a database that needs stable names and disks (StatefulSet).

### The problem

You can create three bare pods. Then you change the image. You now have to delete them in some order, hope you do not delete all of them, and remember what the old image was. You also have no record of "we wanted three". A Deployment stores that record. The Deployment controller does not run containers. It creates a ReplicaSet for each revision of the template. The ReplicaSet controller creates and deletes pods until the count matches.

```text
Deployment (replicas: 3, template image api:2)
    └── ReplicaSet abc  (the current revision, 3 pods)
    └── ReplicaSet 9f2  (the previous revision, scaled to 0, kept for rollback)
```

`pod-template-hash` on each pod labels which ReplicaSet owns it. That is why two revisions can exist during a rollout without the Service mixing them up by accident: the Service selects `app: api`, which both revisions carry, on purpose, so traffic shifts as pods become Ready. The ReplicaSet selector is narrower. It includes the hash. You do not type the hash yourself.

### The manifest that has to be consistent

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 3
  selector:
    matchLabels:
      app: api
  template:
    metadata:
      labels:
        app: api
    spec:
      containers:
        - name: api
          image: ghcr.io/acme/api:1.4.0
```

The selector must match the template labels. The API server rejects the Deployment if it does not. This is not a warning. A running Deployment's selector is immutable. You cannot edit it to "fix" a typo; you delete and recreate, which is disruptive, so you get the labels right before the first apply.

Changing the image, an env var, a probe, or a resource request changes the template. That creates a new ReplicaSet. Changing `replicas` does not. Scaling is not a rollout. `kubectl scale` and an HPA both write `spec.replicas`. They do not change the hash.

### A rollout, slowly

Default strategy is RollingUpdate with `maxUnavailable: 25%` and `maxSurge: 25%`. Percentages round **up**. For 10 replicas, 25% is 3. The controller may run 13 pods at the peak and must keep at least 7 of the old ones until new ones are Ready, within those bounds. The exact sequence is: create some new pods (surge), wait until they are Ready, delete some old ones, repeat.

Ready means the readiness probe passes, or there is no probe and the container is running. A Deployment with no readiness probe will treat a process that bound the port but still loads a cache as Ready. Traffic shifts too early. The probes lesson is part of making a rollout safe, not an optional health check.

`minReadySeconds` waits after a pod is Ready before counting it toward the new ReplicaSet. Use it when the probe is shallow. `progressDeadlineSeconds` (default 600) fails the rollout if it makes no progress. `kubectl rollout status` then returns an error instead of hanging forever. The old ReplicaSet is still there. `kubectl rollout undo deployment/api` scales the previous ReplicaSet back up and the bad one down. Undo is just another rollout to an old template. It is not a time machine for the database.

`revisionHistoryLimit` (default 10) is how many old ReplicaSets you keep. Set it too low and undo has nothing to undo to.

### Recreate, and when surge cannot work

`strategy.type: Recreate` kills every old pod before starting new ones. You get downtime. You use it when two versions must not run together: a migration that cannot tolerate both schemas, or a program that takes an exclusive lock on a file you should not have put on a Deployment in the first place.

`maxSurge: 0` never goes above the replica count. You need spare capacity nowhere, but you dip below N during the rollout. `maxUnavailable: 0` never goes below N, so you need spare cluster capacity for the surge. A cluster that is packed to the requests will stick the rollout: new pods Pending, old pods still serving, progress deadline eventually fires. That looks like a bad image. It is a scheduling problem. `describe` the new pod.

### Where it breaks

**The selector that matched too much.** Selector `app: api` and a template that also only has `app: api` is correct. If you later create a Job or a debug pod with `app: api`, the Service will send it traffic. The ReplicaSet will not adopt it, because of the hash, but the Service will. Extra labels on the template are fine. Missing the selector's labels is rejected.

**Editing the live image and also Git.** The next Git apply rolls "back" to whatever Git says, mid-incident. Decide which writer owns the Deployment.

**A bad probe and a stuck rollout.** New pods never Ready, old pods remain, and undo is the right move. Deleting the Deployment is not. Undo keeps the Service and the history.

**Readiness that always succeeds.** Then maxUnavailable is the only brake, and you can roll a build that returns 500 to every request. The probe has to mean "I can serve".

### At work

Application teams own Deployments. Platform teams own the namespace, the limit range, and the pipeline that applies them. A change review looks at the image digest, the replica count, the resources, and the probe, not at prose. The same desired-state habit as Terraform shows up as "do not kubectl edit the live Deployment; change the file and apply". Rollouts are how you ship. PodDisruptionBudgets, in a later lesson, are how a node drain does not delete the last copies while a rollout is also deleting them.

### You can now

- Draw Deployment → ReplicaSet → Pod and say who creates each.
- Explain why the selector and the template labels must match, and why the selector is immutable.
- Predict that an image change rolls and a replica change does not.
- Choose RollingUpdate versus Recreate, and say what `maxUnavailable: 0` demands of the cluster.
- Roll back by pointing at the previous ReplicaSet rather than by retyping an image from memory.

::: quiz
q: What happens if `spec.selector.matchLabels` is `app: api` but the template's labels say `app: web`?
- The Deployment selects nothing and creates pods forever
+ The API server rejects it: the selector doesn't match the template's labels
- Kubernetes renames the labels to match
- It works; selectors are only hints
why: A Deployment must own the pods it creates; the API validates that its selector matches its own template.
:::

::: config lang=yaml
task: Turn this Pod into a **Deployment** named `web` with **3 replicas**, a selector on `app: web`, and the same container in its template.
starter:
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: web
  labels:
    app: web
spec:
  containers:
    - name: web
      image: nginx:1.27
      ports:
        - containerPort: 80
```
check: apiVersion = apps/v1 | apiVersion is apps/v1
check: kind = Deployment | kind is Deployment
check: metadata.name = web | It's named web
check: spec.replicas = 3 | 3 replicas
check: spec.selector.matchLabels.app = web | The selector matches app: web
check: spec.selector.matchLabels.app == spec.template.metadata.labels.app | The template's labels match the selector
check: spec.template.spec.containers[0].image = nginx:1.27 | The template runs nginx:1.27
check: spec.template.spec.containers[0].ports[0].containerPort = 80 | …on port 80
solution:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: web
          image: nginx:1.27
          ports:
            - containerPort: 80
```
hint: The pod's `metadata` (labels) and `spec` move under `spec.template`. Add `replicas` and `selector.matchLabels` beside `template`.
:::

::: quiz
q: You change only `spec.replicas` from 3 to 5 on a Deployment. What happens to the pod template hash?
- A new ReplicaSet is created and a rollout starts
+ The existing ReplicaSet is scaled to 5; the template hash does not change
- All pods are deleted and recreated with the same image
- The Deployment is rejected because replicas are immutable
why: Rollouts happen when the pod template changes. The replica count is scaling. The hash is computed from the template, so it stays. Recreating pods on every scale would make autoscaling a rolling outage.
:::

::: card
q: In a Deployment rolling update, what do maxSurge and maxUnavailable limit?
answer: maxSurge is how many extra pods above the desired count may exist during the rollout. maxUnavailable is how many pods below the desired count you will tolerate. Percentages round up. maxUnavailable 0 needs spare capacity so new pods can start before old ones stop.
:::

::: predict lang=python
q: Kubernetes rounds a rollout percentage up. For 10 replicas, what does this print for maxSurge and maxUnavailable of 25%?
code:
```python
def absolute(replicas, percent):
    return (replicas * percent + 99) // 100

print(absolute(10, 25))
print(absolute(1, 25))
print(absolute(8, 25))
```
answer:
```text
3
1
2
```
why: 25% of 10 is 2.5, and the API rounds up to 3, so a surge can add 3 pods. 25% of 1 rounds up to 1, not 0. 25% of 8 is 2. If both surge and unavailable would round to 0, Kubernetes raises unavailable to 1 so a rollout can still move.
:::

::: quiz
q: A rollout never finishes. New pods are Pending, old pods are still Running, and the new pods' events say Insufficient cpu. What is the best first move?
- Delete the Deployment and apply it again
- Set maxUnavailable to 100% so the old pods are killed to free CPU
+ Free capacity or lower requests, or undo if this image is not worth keeping; the new pods cannot start because the scheduler has nowhere to put the surge
- Change the selector so the old pods stop matching
why: Pending plus Insufficient cpu means the surge does not fit. Deleting the Deployment drops the service. Raising maxUnavailable might free CPU by killing healthy pods, which is a deliberate outage, not the first fix. The selector is immutable and is not the bug.
:::

::: write lang=python
task: Implement `rollout_bounds(replicas, surge_pct, unavail_pct)` returning `(max_surge, max_unavailable)` as absolute pod counts. Round each percentage up (the Kubernetes rule). If both results would be 0, set max_unavailable to 1. Percentages are integers from 0 to 100.
starter:
```python
def rollout_bounds(replicas, surge_pct, unavail_pct):
    return (0, 0)
```
tests:
```python
from solution import rollout_bounds

def test_rounds_up():
    assert rollout_bounds(10, 25, 25) == (3, 3)

def test_one_replica():
    assert rollout_bounds(1, 25, 25) == (1, 1)

def test_both_zero_becomes_one_unavailable():
    assert rollout_bounds(3, 0, 0) == (0, 1)

def test_surge_only():
    assert rollout_bounds(4, 50, 0) == (2, 0)
```
solution:
```python
def rollout_bounds(replicas, surge_pct, unavail_pct):
    def up(pct):
        return (replicas * pct + 99) // 100
    surge, unavail = up(surge_pct), up(unavail_pct)
    if surge == 0 and unavail == 0:
        unavail = 1
    return (surge, unavail)
```
hint: Integer round-up of `replicas * pct / 100` is `(replicas * pct + 99) // 100`. Apply it to both percentages, then handle the both-zero case.
:::

## Jobs and CronJobs
id: jobs
stage: core
needs: deployments
minutes: 40
goal: Choose a Job, a CronJob, or a Deployment, and set completions, backoff, and concurrency so a batch finishes once.
source: Kubernetes: Jobs | https://kubernetes.io/docs/concepts/workloads/controllers/job/
source: Kubernetes: CronJobs | https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/
source: Kubernetes: Pod failure policy | https://kubernetes.io/docs/concepts/workloads/controllers/job/

A Deployment wants pods running forever. A lot of work is the opposite: migrate a table, send a batch of invoices, retrain a model, expire a queue. Those tasks should run to completion, record success or failure, and stop. A Job is the controller for that. A CronJob creates Jobs on a schedule.

### The problem

People put batch work in a Deployment because it is the object they know. The pod runs the script, exits 0, and the kubelet restarts it because a Deployment's pod `restartPolicy` is Always. The script runs again. You have charged the database twice, or you have a CrashLoop of a program that finished correctly. The other failure is a script in cron on one VM. The VM dies halfway and nothing retries, and you have no object that says "this run failed".

A Job's pod template must use `restartPolicy: Never` or `OnFailure`. `Always` is rejected. Never means a failed container is a failed pod, and the Job controller creates a replacement pod if it still has retries left. OnFailure restarts the container in the same pod. Either way the Job, not a human, counts success.

### Completions and parallelism

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: invoices
spec:
  completions: 4
  parallelism: 2
  backoffLimit: 3
  ttlSecondsAfterFinished: 86400
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: worker
          image: ghcr.io/acme/invoices:3.2.0
```

`completions` is how many pods must exit 0. `parallelism` is how many run at once. The controller will not start a fifth success; it stops at four. `backoffLimit` is how many failed pods you tolerate before the Job is marked Failed. The default is 6. A bug that fails instantly will still burn that many pods, so set the limit, and set resources so a retry storm cannot eat the namespace. You will cap that properly with a ResourceQuota later.

`ttlSecondsAfterFinished` deletes the Job object (and its pods) after it is done. Without it, finished Jobs sit forever. etcd is not a log archive. Put the business result in a database or an object store. The Job is the run record, and it should expire.

Indexed Jobs (`completionMode: Indexed`) give each pod an index in `JOB_COMPLETION_INDEX`, from 0 to completions-1. Use that to split a file into shards. Non-indexed completions are identical workers pulling from a queue you built yourself.

### What "finished" means

A container that exits 0 counts as a success. Exit non-zero counts as a failure. A pod stuck in Pending does not fail the Job until something else times it out; `activeDeadlineSeconds` on the Job kills it if the whole run takes too long. That is your backstop for a deadlock.

Native sidecar containers (init containers with `restartPolicy: Always`, stable since Kubernetes 1.33) do not block Job completion. A legacy sidecar that is a normal container with `restartPolicy` inherited from the pod will keep the pod from ever finishing, because that container never exits. If a Job "succeeds" in the app log but stays Running, look for a sidecar that is not a native sidecar.

### CronJobs

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: invoices-nightly
spec:
  schedule: "15 2 * * *"
  timeZone: Etc/UTC
  concurrencyPolicy: Forbid
  startingDeadlineSeconds: 300
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 2
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: worker
              image: ghcr.io/acme/invoices:3.2.0
```

`schedule` is cron syntax in the Job controller, not on a machine's crontab. `timeZone` is stable (since 1.27) and you should set it. Without it the schedule uses the controller manager's zone, which you do not want to discover during a cluster move.

`concurrencyPolicy` matters more than the schedule. `Allow` (the default) starts a new Job even if last night's run is still going. Two writers then share the same table. `Forbid` skips the new run if one is active. `Replace` deletes the active Job and starts another, which is a kill, not a polite cancel. For invoices, Forbid is usually right, plus an alert if last night's Job is still running at lunch.

`startingDeadlineSeconds` is how late a run may start after its timestamp. If the controller was down longer than that, those ticks are missed rather than fired in a pile. History limits keep the list of child Jobs short. They are not a substitute for logs.

CronJobs do not retry a missed schedule forever, and they do not know your business calendar. "Weekdays except bank holidays" is application logic, or a schedule you generate. Do not encode a holiday calendar in five CronJobs you will forget.

### Deployment, Job, or a queue worker

| Work | Object | Why |
| --- | --- | --- |
| HTTP API that should always be up | Deployment | You care about replicas and rollouts, not about exiting |
| One-shot migration or shard | Job | Success is exit 0, a counted number of times |
| Every night at 02:15 | CronJob | It creates the Job; you do not want a pod sleeping 24 hours |
| Pull from a queue until the queue is empty, then scale to zero | Deployment or a scaler such as KEDA, not a CronJob | The work arrives whenever; a clock is the wrong trigger |
| A long agent session that must not be killed at the end of an HTTP request | A Job per session, or a worker Deployment reading a queue | A request-scoped pod dies when the gateway times out |

The mistake to avoid: a Deployment whose container exits, and a Job whose container sleeps forever so it "stays up". Match the object's success condition to the work.

### Where it breaks

**A CronJob in local time with no `timeZone`, then a control-plane move.** The schedule shifts by hours. Set `Etc/UTC` or an explicit zone.

**Forbid plus a stuck Job.** Every later tick is skipped. You think the cron is broken. `kubectl get jobs` shows one job Running since Tuesday. Fix or delete that Job.

**No idempotency.** Retries are normal. `backoffLimit` will run your container more than once. If "send invoice" is not safe to repeat, the Job controller will double-send. Idempotency keys belong in the program. Kubernetes will not add them.

**Using a Job for a Service.** Jobs' pods can be selected by a Service if the labels match, and then they disappear when the Job finishes. Callers get connection errors. Do not point a Service at batch pods.

### At work

Migrations in a deploy pipeline are often a Job (Helm hooks are one way, a separate manifest is another) that must finish before the new Deployment receives traffic. The pipeline reads Job status. It does not SSH. Nightly warehouse loads are CronJobs with Forbid, a deadline, and an alert on `Failed`. Queue consumers stay Deployments because the queue, not the clock, is the source of work. That split is the same one you will use when an agent either handles one task and exits or waits for the next message.

### You can now

- Explain why a batch program must not run under a Deployment's restartPolicy Always.
- Set completions, parallelism, and backoffLimit and say what each counts.
- Choose Allow, Forbid, or Replace for a CronJob and justify it.
- Set timeZone and a starting deadline so a controller blip does not fire a stampede.
- Pick Job, CronJob, or Deployment for a one-shot, a schedule, and a queue consumer.

::: quiz
q: A container runs a migration and exits 0. It is the only container in a Deployment. What does Kubernetes do?
- Marks the Deployment succeeded and stops
+ Restarts the container, because a Deployment pod's restartPolicy is Always
- Creates a Job automatically
- Scales the Deployment to 0
why: Deployments keep containers running. A successful exit is not success to that controller; it is a container that stopped. A Job with restartPolicy Never treats exit 0 as a completion and does not start another one past `completions`.
:::

::: quiz
q: A CronJob has `concurrencyPolicy: Forbid`. Last night's Job is still Running. The schedule fires again. What happens?
- The new Job starts in parallel
- The old Job is deleted and replaced
+ The new run is skipped while the old Job is still active
- The CronJob object is marked Failed permanently
why: Forbid means do not overlap. The controller skips the tick. It does not fail the CronJob itself. Replace would kill the active Job, which you did not ask for. Allow is the default and would overlap.
:::

::: card
q: In a Kubernetes Job, what do `completions` and `parallelism` each control?
answer: completions is how many pods must finish successfully before the Job is done. parallelism is how many of those pods may run at the same time. The Job stops starting new pods once enough have succeeded.
:::

::: predict lang=python
q: A Job wants 4 completions and parallelism 2. Each call to `tick` starts pods up to the cap and records one success. What does it print?
code:
```python
def tick(done, active, completions, parallelism):
    start = min(parallelism - active, completions - done - active)
    start = max(start, 0)
    return f"start {start}"

print(tick(0, 0, 4, 2))
print(tick(1, 2, 4, 2))
print(tick(4, 0, 4, 2))
```
answer:
```text
start 2
start 0
start 0
```
why: At the beginning nothing is running, so parallelism allows 2. When 2 are already active, start stays 0 even though completions are not met. When 4 have succeeded, start stays 0 even if parallelism would allow more. The controller will not overshoot completions.
:::

::: config lang=yaml
task: Write a Job named `migrate` that must complete once, may run at most one pod at a time, allows 2 failed pods, deletes itself a day after finishing (86400 seconds), and runs `ghcr.io/acme/migrate:1.0.0` with restartPolicy Never.
starter:
```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: migrate
spec:
  template:
    spec:
      containers:
        - name: migrate
          image: ghcr.io/acme/migrate:latest
```
check: metadata.name = migrate | The Job is named migrate
check: spec.completions = 1 | It completes once
check: spec.parallelism = 1 | Only one pod at a time
check: spec.backoffLimit = 2 | Two failures are allowed
check: spec.ttlSecondsAfterFinished = 86400 | It is removed a day after finishing
check: spec.template.spec.restartPolicy = Never | restartPolicy is Never
check: spec.template.spec.containers[0].image = ghcr.io/acme/migrate:1.0.0 | Image pinned to 1.0.0
solution:
```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: migrate
spec:
  completions: 1
  parallelism: 1
  backoffLimit: 2
  ttlSecondsAfterFinished: 86400
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: ghcr.io/acme/migrate:1.0.0
```
hint: completions, parallelism, backoffLimit, and ttlSecondsAfterFinished sit on the Job spec, beside template. restartPolicy sits on the pod spec, not on the container. Pin the image.
:::

::: quiz
q: You need a worker that pulls tasks from a queue all day and should scale with queue depth. Which object matches the work?
- A CronJob every minute that exits when the queue is empty
+ A Deployment (scaled by queue length), because the process is supposed to stay up and wait for the next message
- A bare Pod, so it keeps the same name
- A Job with completions set to 1000000
why: The success condition of a queue worker is "be running", which is a Deployment. A CronJob is a clock. A huge completions number is a Deployment wearing a Job's coat, and it will end. Bare pods do not come back. Scaling that Deployment from queue depth is the autoscaling lesson, not a reason to switch objects.
:::

## DaemonSets
id: daemonsets
stage: core
needs: pods
minutes: 35
goal: Run exactly one pod per node for node-local work, and choose a DaemonSet update strategy.
source: Kubernetes: DaemonSet | https://kubernetes.io/docs/concepts/workloads/controllers/daemonset/

Some programs are not "three copies somewhere". They are "one copy on every machine": a log agent that reads that node's files, a metrics exporter that sees that node's cgroup, a CSI driver that mounts disks, a CNI binary that must exist before pods can have a network. A Deployment will happily put all three replicas on one node and none on the others. A DaemonSet does not.

### The problem

You can script "SSH to each node and start the agent". The script misses the node the autoscaler added at 03:00. The agent is absent, logs from that node never ship, and you notice during an incident. The DaemonSet controller watches nodes. When a node appears and matches the DaemonSet's node selector, the controller creates a pod bound to that node. When the node leaves, the pod goes with it. You do not keep a replica count. The count is "eligible nodes".

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: log-agent
spec:
  selector:
    matchLabels:
      app: log-agent
  template:
    metadata:
      labels:
        app: log-agent
    spec:
      tolerations:
        - key: node-role.kubernetes.io/control-plane
          operator: Exists
          effect: NoSchedule
      containers:
        - name: agent
          image: ghcr.io/acme/log-agent:1.8.0
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
```

The selector and template labels must match, same rule as a Deployment. The toleration is the part people forget. Control-plane nodes are tainted NoSchedule. A log agent that should run there needs a toleration. A log agent that must not run there should not have one. Worker nodes with a dedicated taint (`workload=gpu:NoSchedule`) are skipped unless you tolerate that too. "The DaemonSet is not on the GPU nodes" is almost always a taint, not a broken controller.

### One pod per node, not a replica

Do not set `replicas`. The API does not work that way for DaemonSets. If you need three copies of a web API, that is a Deployment. If you need the agent even on a cordoned node during a drain, read the drain docs: drain evicts DaemonSet pods only if you ask it to, because evicting the network plugin's pod is how you take the node off the network while you are trying to move other pods. Default drain leaves DaemonSet pods alone.

The pod is bound to a named node. The scheduler is not choosing among free nodes for a floating replica. If that node is out of memory, that DaemonSet pod stays Pending on it. Extra capacity on another node does not help. Size the agent's requests small, and remember they count against every node. A 500 millicore request on a 50-node cluster is 25 cores you cannot give to the product.

### Updates

`updateStrategy.type` is `RollingUpdate` (the default) or `OnDelete`. RollingUpdate replaces pods a few nodes at a time, controlled by `maxUnavailable` (default 1) and `maxSurge`. Surge for a DaemonSet means a second pod on a node during the handoff, which needs spare pods-per-node room and is wrong for a host port. Agents that bind `hostPort: 53` or mount a host path exclusively should use OnDelete or a rolling update with surge 0, and you should understand that two copies cannot bind the same host port.

OnDelete does nothing until you delete the pod. That is how you hand-roll a canary across three nodes before the rest. It is also how a DaemonSet stays stale for a year because nobody deleted the pods. If you use OnDelete, the rollout is your job.

Readiness still matters. A rolling update waits for the new pod to be Ready before it moves on, within maxUnavailable. A probe that hits a node-local socket is appropriate. A probe that calls your production API from every node's agent just invented a monitoring loop you did not intend.

### Where it breaks

**Host path plus a security standard.** Mounting `/var/log` or `/var/run/docker.sock` is normal for an agent and forbidden by the restricted Pod Security Standard. Those DaemonSets live in a namespace you exempt on purpose, not in the application namespace you lock down. Do not weaken the app namespace so the agent can mount the socket.

**A Service in front of a DaemonSet.** You can select the pods. You get one backend per node, which is what you want for a metrics scrape and a bad fit for "send each user to any agent". Node-local traffic (`internalTrafficPolicy: Local` on a Service) is the feature that keeps a pod talking to the agent on its own node. Without it, kube-proxy may send the packet to an agent on a different node, which defeats the point of reading local files.

**Cluster autoscaler and requests.** Pending DaemonSet pods that cannot schedule block scale-down and can force scale-up. A broken image in a DaemonSet is a cluster-wide incident, not one Deployment's incident. Pin the image. Roll slowly.

### At work

Platform teams own DaemonSets: CNI, CSI, log shipping, node exporters. Application teams almost never create one. If you think you need one, say which node-local resource you are touching. "I want it on every node for lower latency" is usually a Deployment plus topology spread, which is cheaper and does not require host access. The security lesson's least-privilege rule applies twice: the agent can see every pod's logs or every node's network, so its ServiceAccount and its image matter more than the average app.

### You can now

- Say what a DaemonSet guarantees that a Deployment does not.
- Explain why a missing toleration skips tainted nodes.
- Choose RollingUpdate versus OnDelete for an agent that binds a host port.
- Explain why DaemonSet requests are multiplied by the node count.
- Refuse a DaemonSet when the work is just "several copies of a stateless API".

### A worked node

Take a three-node cluster. You want a metrics exporter on every node, including the control plane, and a log collector that must not run on a tainted GPU pool. A Deployment with `replicas: 3` is the wrong object even when the count matches today. Tomorrow the autoscaler adds node-d and the Deployment does not care. A DaemonSet does. The controller's desired count is "one pod per selected node," not a number you typed.

The node-exporter pod gets a toleration for `node-role.kubernetes.io/control-plane` so the control-plane taint does not keep it off. It does not set `replicas`. It does not set a strategy with a surge that would run two exporters on one node and zero on another while you "roll." The default rolling update replaces the pod on a node before moving on, which is what you want for an agent that binds a host port. `maxUnavailable` is the knob. Surge is usually wrong because the host port or the hostPath is already taken.

The GPU pool has taint `sku=gpu:NoSchedule`. The log collector does not tolerate it, so those nodes stay dark on purpose. The exporter does tolerate it, because you still want metrics from the GPU machines. Tolerations are how you opt in. Forgetting one is how a node looks healthy in the cloud console and empty in Prometheus.

### Where it breaks

A DaemonSet pod that is Pending on one node does not fail the others. `kubectl get ds` shows desired, current, ready, and the gap is one node. `describe` that pod. The usual causes are a taint you did not tolerate, a port conflict with another agent, a lack of CPU request room on a tiny node, or a node selector that excluded a new pool. People raise replicas. There is no replicas field that means "try harder."

HostPath and hostNetwork make the pod a guest in the node's namespaces. A bug in the agent can fill the node disk or see every packet. That is sometimes the job (a CNI, a log shipper) and sometimes an accident (an app someone "just" wanted on every node). If the process does not need the host, it is not a DaemonSet.

Updates that change a label selector are not a rolling update. They are "these pods are no longer mine," and the controller creates a second set. Treat selector changes as a new DaemonSet plus a removal of the old one, the same way you treat a Deployment selector.

### At work

Platform charts install the CNI, the node exporter, the log agent, and the EKS Pod Identity agent as DaemonSets. Application teams do not get to add another one because "we need a file on every node." They get a sidecar or a volume. The review question is: if this node disappears, should this process disappear with it, and should a new node start it before any app pod is scheduled? If yes, DaemonSet, with a priority class so it schedules before the apps that depend on it. If the work is per request, it is a Deployment.

### Decision

| You need | Use |
|---|---|
| One agent per node, including nodes that appear later | DaemonSet |
| A fixed number of stateless replicas | Deployment |
| One batch completion | Job |
| The agent must run on tainted nodes | a toleration, not a second DaemonSet |
| The agent must not run on a pool | no toleration for that taint, or a node affinity that excludes it |

### You can now

- Say why a replica count is not a DaemonSet.
- Tolerate the control-plane taint on purpose, and refuse it for workloads that do not belong there.
- Read desired versus ready as a per-node gap.
- Keep hostPath and hostNetwork for agents that truly need the host.

::: quiz
q: A DaemonSet has no toleration for the control-plane taint. How many of its pods run on the control-plane node?
- One, because a DaemonSet always covers every node
+ None. The taint rejects the pod, so that node is not eligible
- One, but only after you set replicas to 1
- It runs, then the kubelet deletes it
why: DaemonSets schedule only onto nodes that pass the pod's node selector and tolerations. The control-plane NoSchedule taint excludes the pod until you tolerate it. There is no replicas field to override that.
:::

::: quiz
q: Your log agent binds host port 1514. You set the DaemonSet strategy to RollingUpdate with maxSurge greater than 0. What goes wrong on a node during the update?
- The old pod is deleted cluster-wide before any new pod starts
+ A second pod is created on the same node and cannot bind the host port the old pod still holds
- Surge is ignored for DaemonSets
- The Service selector changes automatically
why: maxSurge on a DaemonSet allows an extra pod on a node during the handoff. Two pods cannot bind the same host port. Use surge 0 or OnDelete for exclusive host ports. The selector is not rewritten by the strategy.
:::

::: card
q: When should you use a DaemonSet instead of a Deployment?
answer: When you need one pod on each eligible node because the work is node-local (logs, node metrics, a network or storage driver). A Deployment places N interchangeable pods and may stack them on one node.
:::

::: config lang=yaml
task: Write a DaemonSet named `node-exporter` selecting `app: node-exporter`, image `quay.io/prometheus/node-exporter:v1.8.0`, with a toleration so it can run on the control plane. The toleration key is `node-role.kubernetes.io/control-plane`, operator `Exists`, effect `NoSchedule`. Do not set replicas.
starter:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: node-exporter
spec:
  replicas: 1
  selector:
    matchLabels:
      app: node-exporter
  template:
    metadata:
      labels:
        app: node-exporter
    spec:
      containers:
        - name: node-exporter
          image: quay.io/prometheus/node-exporter:latest
```
check: kind = DaemonSet | kind is DaemonSet
check: metadata.name = node-exporter | name is node-exporter
check: spec.replicas missing | DaemonSets do not set replicas
check: spec.selector.matchLabels.app = node-exporter | selector matches app
check: spec.template.metadata.labels.app = node-exporter | template label matches
check: spec.template.spec.containers[0].image = quay.io/prometheus/node-exporter:v1.8.0 | image is pinned
check: spec.template.spec.tolerations[0].key = node-role.kubernetes.io/control-plane | tolerates the control-plane taint
check: spec.template.spec.tolerations[0].operator = Exists | operator is Exists
check: spec.template.spec.tolerations[0].effect = NoSchedule | effect is NoSchedule
solution:
```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-exporter
spec:
  selector:
    matchLabels:
      app: node-exporter
  template:
    metadata:
      labels:
        app: node-exporter
    spec:
      tolerations:
        - key: node-role.kubernetes.io/control-plane
          operator: Exists
          effect: NoSchedule
      containers:
        - name: node-exporter
          image: quay.io/prometheus/node-exporter:v1.8.0
```
hint: Change kind to DaemonSet and delete replicas. Add a tolerations list on the pod spec. Pin the image tag.
:::

::: predict lang=python
q: Eligible nodes are those that are Ready and either untainted or tolerated. What does this print?
code:
```python
def eligible(nodes, tolerate_control):
    out = []
    for name, tainted in nodes:
        if tainted and not tolerate_control:
            continue
        out.append(name)
    return ",".join(out)

nodes = [("cp", True), ("a", False), ("b", False)]
print(eligible(nodes, False))
print(eligible(nodes, True))
```
answer:
```text
a,b
cp,a,b
```
why: Without a toleration the tainted control plane is skipped, so the DaemonSet runs only on a and b. With the toleration it runs on every listed node. Adding a worker later would add a pod; you do not edit a replica count.
:::

::: quiz
q: You want three copies of a stateless API, and you do not care which nodes they land on. Why is a DaemonSet the wrong object?
- DaemonSets cannot run web servers
+ A DaemonSet ties one pod to each node, so the count tracks the node pool, not the traffic you need to serve
- DaemonSets do not support Services
- DaemonSets ignore resource requests
why: The API's replica count should follow load, via a Deployment and maybe an HPA. A DaemonSet would scale when you add nodes and would refuse to put two copies on a roomy node. Services and requests both work on DaemonSet pods; they are not the reason to avoid one.
:::

## Services
id: services
stage: core
needs: deployments, linux/network
minutes: 40
goal: Give a set of pods a stable name and virtual IP, and explain the path from DNS to an endpoint.
source: Kubernetes: Service | https://kubernetes.io/docs/concepts/services-networking/service/
source: Kubernetes: DNS for Services and Pods | https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/
source: Kubernetes: EndpointSlice | https://kubernetes.io/docs/concepts/services-networking/endpoint-slices/

Pods get new IPs whenever they are created. A caller cannot keep a list of those IPs, and it should not. A Service is a stable name, a virtual IP (ClusterIP), and a selector that finds the current pods. kube-proxy (or an equivalent dataplane such as Cilium's) programs the nodes so that a packet to that virtual IP is delivered to one of the ready pods.

### The problem

You have three API pods. You tell another service to call `10.0.1.15`. Tomorrow that pod is gone and `.15` belongs to nothing, or worse, to a different pod after the IP is reused. You could register pods in a database yourself. That is a Service, badly reinvented, without readiness. The Service object is the registry, and EndpointSlices are the current list.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: orders
  namespace: shop
spec:
  selector:
    app: orders
  ports:
    - name: http
      port: 80
      targetPort: 8000
```

`port` is what callers use. `targetPort` is the container port. They are allowed to differ, and they usually should: callers speak 80, the process listens on 8000, and you can change the process port without telling every client. `targetPort` may be a name that matches a `containerPort` name. A number is fine and is what these lessons use.

Other pods in the cluster call `http://orders` or, from another namespace, `http://orders.shop.svc.cluster.local`. The short name works inside the same namespace because the pod's DNS search path includes `svc.cluster.local` and the namespace. CoreDNS answers the name with the ClusterIP. The packet then hits the node dataplane and is sent to a ready endpoint.

### Ready endpoints, not every pod

The endpoints controller watches pods that match the selector and are Ready. A pod that fails its readiness probe is removed from the EndpointSlice. It stays Running. Callers stop being sent there. That is the difference between liveness and readiness, and it is why a Service with an empty EndpointSlice hangs or resets instead of "trying the unready pod".

`kubectl get endpointslices -l kubernetes.io/service-name=orders` shows the backend IPs. An empty list means the selector matched nothing that is Ready. The usual causes, in order: the label is wrong, the pods are in another namespace (selectors do not cross namespaces), the pods are not Ready, or you created a Service with no selector at all.

A Service with no selector is legal. You wanted an external name or you will fill endpoints yourself. For an in-cluster app it is almost always a mistake. There is nothing to route to until endpoints exist.

### Types

| Type | What you get | Use it when |
| --- | --- | --- |
| ClusterIP (default) | A virtual IP inside the cluster only | Another pod is the caller |
| NodePort | ClusterIP plus a port on every node | Rarely; a load balancer or ingress should sit in front |
| LoadBalancer | NodePort plus a cloud load balancer | You are on a cloud and want a real VIP; costs money and needs cloud IAM |
| ExternalName | A DNS CNAME, no proxy | You want a short cluster name for an outside host |

`ExternalName` does not proxy and does not add TLS. It is a CNAME. Callers talk to the outside name directly.

Headless Services set `clusterIP: None`. DNS returns the pod IPs, not a virtual IP. StatefulSets use this so each pod has a stable DNS name (`pod-0.db.shop.svc.cluster.local`). A normal web API does not want headless. It wants load balancing.

### The packet, end to end

1. The client resolves `orders.shop.svc.cluster.local` through CoreDNS and gets the ClusterIP.
2. It sends a TCP packet to that IP on `port`.
3. The node's dataplane (iptables, ipvs, or eBPF) DNATs the destination to a ready pod IP and `targetPort`.
4. The pod replies. The reply is rewritten so the client still thinks it talked to the ClusterIP.

The client does not know the pod IP. Killing a pod removes it from the slice only after it is NotReady or gone. In-flight connections die. New connections go to the survivors. This is why graceful shutdown and readiness matter: you mark NotReady, wait for the dataplane to drop the endpoint, then exit. The probes lesson walks that sequence.

`internalTrafficPolicy: Local` restricts endpoints to pods on the same node. Useful for node-local DaemonSets. For a normal API it causes black holes on nodes that happen to have no local pod. Leave the default (Cluster) unless you mean it.

### Where it breaks

**Selector typo.** Pods are Running, `curl` hangs, EndpointSlice is empty. Diff the Service selector against `kubectl get pods --show-labels`. This is the single most common Service bug.

**targetPort equals the Service port by habit, but the container listens elsewhere.** Endpoints exist, connections are refused. The dataplane is doing what you asked. The process is not listening on that port.

**Calling a ClusterIP from your laptop.** It is not routed there. Use `kubectl port-forward service/orders 8080:80` for debugging. Do not change the Service to NodePort so your laptop works. That exposes the port on every node.

**LoadBalancer on kind.** The type stays Pending because there is no cloud controller with a real balancer. That does not mean the ClusterIP is broken. Inside the cluster, ClusterIP still works.

**Forgetting that traffic from a pod to its own Service is a special path.** Hairpinning usually works on modern dataplanes and occasionally does not on old ones. If "it works from another pod but not from itself", test from a debug pod before you rewrite the app.

### At work

Services are how every in-cluster call is named. Ingress and the Gateway API do not replace them. Those objects route HTTP from outside to a Service, and the Service still selects pods. gRPC needs to know about connection reuse: a client that keeps one TCP connection forever will stick to one pod even though the Service has many endpoints. HTTP/2 load balancing is a client or mesh concern, not something ClusterIP magically does per request.

NetworkPolicy, later, selects pods and sometimes namespace-and-pod for ingress. The Service name is not a policy identity. You allow the pods, or you allow traffic from the namespace, depending on the policy. People write a policy for "the Service" and are surprised it does nothing. The policy lesson is explicit about this.

### You can now

- Explain ClusterIP, port, and targetPort, and the DNS name another namespace must use.
- Predict that a failing readiness probe removes the pod from the EndpointSlice but leaves it Running.
- Debug an empty EndpointSlice from the selector, the namespace, and readiness.
- Choose ClusterIP, headless, or LoadBalancer and say what each does not do.
- Say why Ingress still needs a Service behind it.

::: quiz
q: `curl http://api` from another pod hangs. `kubectl get endpointslices` for the Service shows no endpoints. Most likely?
- DNS is broken
+ The Service's selector doesn't match the pods' labels (or no matching pod is ready)
- The Service type should be LoadBalancer
- The pods need a public IP
why: No endpoints means the Service found no ready pods with its labels. Compare `spec.selector` with the pods' labels.
:::

::: config lang=yaml
task: Add a **Service** (as a second document, after `---`) so other pods can call this Deployment at `http://orders` on port 80. The container listens on 3000.
starter:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orders
spec:
  replicas: 2
  selector:
    matchLabels:
      app: orders
  template:
    metadata:
      labels:
        app: orders
    spec:
      containers:
        - name: orders
          image: ghcr.io/acme/orders:2.1.0
          ports:
            - containerPort: 3000
```
check: [kind=Service] exists | There's a Service document
check: [kind=Service].apiVersion = v1 | The Service's apiVersion is v1
check: [kind=Service].metadata.name = orders | The Service is named orders (that's the DNS name)
check: [kind=Service].spec.selector.app == [kind=Deployment].spec.template.metadata.labels.app | The Service selects the Deployment's pods
check: [kind=Service].spec.ports[0].port = 80 | The Service listens on port 80
check: [kind=Service].spec.ports[0].targetPort = 3000 | It forwards to the container's port 3000
check: [kind=Service].spec.type !~ /LoadBalancer|NodePort/ | It's internal (ClusterIP)
solution:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orders
spec:
  replicas: 2
  selector:
    matchLabels:
      app: orders
  template:
    metadata:
      labels:
        app: orders
    spec:
      containers:
        - name: orders
          image: ghcr.io/acme/orders:2.1.0
          ports:
            - containerPort: 3000
---
apiVersion: v1
kind: Service
metadata:
  name: orders
spec:
  selector:
    app: orders
  ports:
    - port: 80
      targetPort: 3000
```
hint: A `---` line starts a new document in the same file. The Service's `selector` is a plain map (`app: orders`), not `matchLabels`.
:::

::: card
q: In a Kubernetes Service, what is the difference between `port` and `targetPort`?
answer: `port` is the port clients use on the Service's ClusterIP. `targetPort` is the port on the selected pods where the container is listening. They can differ. An empty EndpointSlice means no Ready pod matched the selector, which is a different failure from a wrong targetPort (endpoints exist, connections are refused).
:::

::: quiz
q: Pods matching a Service are Running, but their readiness probes fail. What does a caller to the Service see?
- Traffic is sent to them anyway, because they are Running
+ They are left out of the EndpointSlice, so the caller hits other Ready pods or fails if none are Ready
- The Service object is deleted
- Kubernetes restarts the caller
why: Endpoints are Ready pods, not merely Running pods. Readiness is how you pull a pod out of rotation without killing it. Liveness restarts a container; it is not what edits the EndpointSlice.
:::

::: quiz
q: From a pod in namespace `billing`, which name reaches Service `orders` in namespace `shop`?
- `http://orders`
+ `http://orders.shop.svc.cluster.local`
- `http://shop.orders`
- `http://orders.cluster.local`
why: The short name `orders` only searches the caller's namespace (`billing`). Cross-namespace calls need the namespace in the DNS name. The cluster domain is `svc.cluster.local` by default. `shop.orders` reverses the labels.
:::

::: predict lang=python
q: Endpoint membership is "label matches and ready". What does this print?
code:
```python
def endpoints(pods, selector):
    out = []
    for name, labels, ready in pods:
        if all(labels.get(k) == v for k, v in selector.items()) and ready:
            out.append(name)
    return ",".join(out) or "(none)"

pods = [
    ("a", {"app": "orders"}, True),
    ("b", {"app": "orders"}, False),
    ("c", {"app": "billing"}, True),
]
print(endpoints(pods, {"app": "orders"}))
```
answer:
```text
a
```
why: `b` matches the label but is not Ready, so it is not an endpoint. `c` is Ready but has the wrong label. Only `a` is both. An empty result would mean calls to the Service have nowhere to go.
:::

::: config lang=yaml
task: Add a headless Service named `db` in namespace `shop` that selects `app: db` and maps port 5432 to targetPort 5432. Headless means `clusterIP: None`. One document only.
starter:
```yaml
apiVersion: v1
kind: Service
metadata:
  name: db
spec:
  selector:
    app: postgres
  ports:
    - port: 5432
      targetPort: 80
```
check: metadata.name = db | named db
check: metadata.namespace = shop | namespace shop
check: spec.clusterIP = None | headless
check: spec.selector.app = db | selects app=db
check: spec.ports[0].port = 5432 | port 5432
check: spec.ports[0].targetPort = 5432 | targetPort 5432
solution:
```yaml
apiVersion: v1
kind: Service
metadata:
  name: db
  namespace: shop
spec:
  clusterIP: None
  selector:
    app: db
  ports:
    - port: 5432
      targetPort: 5432
```
hint: `clusterIP: None` makes it headless. The selector value must be `db`, matching the pods you intend, and targetPort should be 5432, not 80.
:::

## Init containers and sidecars
id: init-sidecars
stage: core
needs: pods
minutes: 40
goal: Order startup with init containers, and run a helper for the whole pod lifetime as a native sidecar.
source: Kubernetes: Init containers | https://kubernetes.io/docs/concepts/workloads/pods/init-containers/
source: Kubernetes: Sidecar containers | https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/

A pod with one container starts that container and you are done. Real pods often need a step that must finish first (migrate, render config, wait for a permission file) and a helper that must stay up for the whole life of the pod (proxy, log shipper). Those are two different mechanisms. Mixing them up is how Jobs never complete and how apps start before the proxy is listening.

### The problem

You can make the application wait in a loop until a port opens. Every team writes that loop differently, it hides inside the app image, and a Job that should exit 0 never exits because the loop is a second process in the same container. Kubernetes can order containers, but only if you put them in the right list.

**Init containers** run to completion, in order, before the app containers start. Each must exit 0. If one fails, the pod restarts the init sequence according to the pod's restartPolicy (for a Deployment, you see Init:Error or Init:CrashLoopBackOff). They do not stay running. They are a script with a turn, not a daemon.

**App containers** in `spec.containers` start after every init container has succeeded. They run together, not in a guaranteed order among themselves.

**Native sidecars** are init containers with `restartPolicy: Always`. The field has been stable since Kubernetes 1.33 (it shipped alpha in 1.28 and was on by default in 1.29). You can no longer turn the behaviour off with a feature gate. A native sidecar starts before the app containers, stays up for the life of the pod, restarts on its own if it crashes, and is stopped after the app containers stop. For a Job, it does not keep the pod from completing.

```yaml
spec:
  initContainers:
    - name: migrate
      image: ghcr.io/acme/migrate:1.4.0
      command: ["./migrate"]
    - name: proxy
      image: ghcr.io/acme/proxy:2.0.0
      restartPolicy: Always
      ports:
        - containerPort: 15001
  containers:
    - name: api
      image: ghcr.io/acme/api:1.4.0
```

`migrate` runs and exits. `proxy` is a sidecar because of `restartPolicy: Always`, even though it sits in the init list. `api` starts only after migrate has exited and after the sidecar has been started. "Started" is not "ready". If the app dials the proxy immediately, give the sidecar a **startupProbe**. The kubelet waits for that probe before it starts the next containers. A readiness probe on the sidecar does not hold the app back. A liveness probe restarts the sidecar without stopping the app. People set the wrong probe and then blame the app for connection refused.

### What they share

Init containers and sidecars share the pod network and any volumes you mount into them. The migrate container can write a file into an `emptyDir`, and the app can read it, if both mount the volume. Init containers run one at a time, so they can use the same port in sequence. They cannot use a port the sidecar is already holding, because the sidecar is still running when the app starts.

Resource requests are special. The scheduler uses the **maximum** of (the highest init container request, the sum of app container requests), not the sum of everything, because inits and apps do not run at the same time. A native sidecar is different: it runs alongside the app, so its requests are added to the app containers' requests. A 200 millicore sidecar plus a 200 millicore app needs 400 on the node. Forgetting that is how a pod that "should fit" stays Pending after you add a mesh proxy.

### Legacy sidecars

Before native sidecars, people put the helper in `spec.containers` next to the app. It usually works for a Deployment. It breaks Jobs: the helper never exits, so the pod never finishes, so the Job never completes. It also does not guarantee the helper starts first. If you still see that pattern, do not copy it into a Job. Move the helper to `initContainers` with `restartPolicy: Always`.

### Where it breaks

**A migration init container that is not idempotent.** Deployments roll more than one pod. Each new pod runs the migration. Two alters at once, or a migration that cannot run twice, fails the rollout in a way that looks like a bad image. Run schema migrations as a Job once, or make the init container safe to run on every pod.

**Waiting for another Service inside an init container with no timeout.** The init container retries forever, the pod never becomes Ready, the Service has no endpoints, and the thing you are waiting for is waiting for you. Init containers are a bad place for "wait until the other Deployment is up" across a dependency cycle. Fix the cycle.

**Secrets in the init image.** The migrate image has a shell and a database password in an env var. It is as privileged as the app. Pin it, scan it, and do not use `latest`.

**Startup order among app containers.** There is none. If you need the proxy first, it is a native sidecar with a startup probe, not the first item in `containers`.

### At work

Service meshes inject a native sidecar (or, on older clusters, a legacy one) so the app does not know about mTLS. You notice when the sidecar's requests push the pod over a LimitRange and admission rejects it. Database migrate-on-start is the other common init container, and the teams who have been burned run that as a Job in CI instead. The pattern to remember: exit 0 means init; stay up means sidecar; serve the user means app container.

### You can now

- Order a one-shot step before the app with an init container that exits 0.
- Declare a native sidecar with `restartPolicy: Always` on an init container.
- Choose a startup probe when the app must wait until the sidecar is actually listening.
- Explain why a legacy sidecar breaks Job completion.
- Account for sidecar requests on top of app requests when you ask why a pod is Pending.

::: quiz
q: An init container exits 0. What does the kubelet do next?
- It restarts the init container, because restartPolicy is Always for every init container
+ It runs the next init container, or starts the app containers if that was the last one that must exit
- It marks the pod Succeeded and deletes it
- It removes the pod from every Service permanently
why: A normal init container is finished when it exits 0. The next step starts. `restartPolicy: Always` on an init container is what turns it into a sidecar that stays up. A Deployment pod is not Succeeded just because an init container finished; Succeeded is for pods whose app containers have finished.
:::

::: quiz
q: A Job stays Running even though the worker container exited 0. There is a second container in `spec.containers` running a log shipper that never exits. Why does the Job not complete?
- Jobs ignore exit codes
+ The shipper is a normal container that never exits, so the pod is not finished. A native sidecar would not block completion
- The Job needs completions: 2
- restartPolicy Never forbids successful exits
why: Every app container must finish for the pod to finish. A helper that sleeps forever in `spec.containers` prevents that. Native sidecars (init containers with restartPolicy Always) are defined not to block Job completion. completions: 2 would demand two successful pods, which is a different bug.
:::

::: card
q: Since Kubernetes 1.33, how do you declare a sidecar that starts before the app and stays up for the life of the pod?
answer: Put it in initContainers and set restartPolicy: Always. A startupProbe on that sidecar makes the app wait until the sidecar is ready. A plain init container without that restartPolicy must exit before the app starts and does not stay up.
:::

::: config lang=yaml
task: Write a Pod named `api` with an init container `migrate` using image `ghcr.io/acme/migrate:1.4.0` (no restartPolicy), a native sidecar `proxy` using `ghcr.io/acme/proxy:2.0.0` with restartPolicy Always, and an app container `api` using `ghcr.io/acme/api:1.4.0`.
starter:
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: api
spec:
  containers:
    - name: api
      image: ghcr.io/acme/api:1.4.0
    - name: proxy
      image: ghcr.io/acme/proxy:2.0.0
```
check: metadata.name = api | named api
check: spec.initContainers count 2 | two init containers
check: spec.initContainers[0].name = migrate | migrate runs first
check: spec.initContainers[0].image = ghcr.io/acme/migrate:1.4.0 | migrate image
check: spec.initContainers[0].restartPolicy missing | migrate is a normal init, not a sidecar
check: spec.initContainers[1].name = proxy | proxy is the sidecar
check: spec.initContainers[1].restartPolicy = Always | proxy stays up
check: spec.initContainers[1].image = ghcr.io/acme/proxy:2.0.0 | proxy image
check: spec.containers count 1 | only the app is in containers
check: spec.containers[0].name = api | app container is api
solution:
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: api
spec:
  initContainers:
    - name: migrate
      image: ghcr.io/acme/migrate:1.4.0
    - name: proxy
      image: ghcr.io/acme/proxy:2.0.0
      restartPolicy: Always
  containers:
    - name: api
      image: ghcr.io/acme/api:1.4.0
```
hint: Move the proxy out of `containers` into `initContainers` after migrate, and set its restartPolicy to Always. Leave restartPolicy off migrate so it must exit.
:::

::: predict lang=python
q: Requests used for scheduling. A native sidecar runs at the same time as the app. A normal init container does not. What does this print?
code:
```python
def pod_request(init_max, sidecar, app):
    return max(init_max, app + sidecar)

print(pod_request(100, 200, 200))
print(pod_request(1000, 50, 200))
```
answer:
```text
400
1000
```
why: The sidecar's 200 is added to the app's 200, and that sum is larger than the init container's 100, so the pod requests 400. In the second case the init container's 1000 is larger than 250, so the scheduler uses 1000. Summing every container always would overstate the first pod and understate nothing; the max-of-init rule is why a huge init container still needs a big node even though it exits before the app.
:::

::: quiz
q: You need the app container to wait until a native sidecar is accepting connections. Which probe do you put on the sidecar?
- A readiness probe; it delays the app container
+ A startup probe; the kubelet starts the app containers only after the sidecar's startup probe succeeds
- A liveness probe with a long delay
- No probe; init order already means the sidecar is ready
why: Native sidecars are started before app containers, but "started" only means the process was created. The startup probe is what gates the next containers. Readiness affects Services, not startup order. Liveness restarts a dead sidecar and does not sequence the app.
:::

## ConfigMaps and Secrets
id: config
stage: prod
needs: services
minutes: 40
goal: Inject configuration and credentials into a pod as env or files, and say what a Secret does not protect.
source: Kubernetes: ConfigMaps | https://kubernetes.io/docs/concepts/configuration/configmap/
source: Kubernetes: Secrets | https://kubernetes.io/docs/concepts/configuration/secret/
source: Kubernetes: Good practices for Kubernetes Secrets | https://kubernetes.io/docs/concepts/security/secrets-good-practices/

An image that contains the database URL and the API token has to be rebuilt to change either, and the token sits in the registry forever. ConfigMaps and Secrets exist so the pod spec points at configuration instead of baking it in. They are objects in etcd. They are not a secret manager. That sentence is the whole security model, and the quiz you will see again in review is about it.

### The problem

Twelve replicas must share `LOG_LEVEL` and a database URL. You can set env on the Deployment. Then a rotation means editing the Deployment, which rolls every pod, and the value is visible to anyone who can `kubectl get deploy -o yaml`. You can mount a file from somewhere. ConfigMaps and Secrets are the somewhere that lives in the API, so the same RBAC and the same Git review (or the same refusal to commit them) apply.

A ConfigMap holds configuration that is not a credential: log level, a feature flag, a whole nginx.conf. A Secret holds a credential: a token, a TLS key, a connection string. The split is a signal to humans and to RBAC. The API stores both in etcd. A Secret's data is base64, not encryption. Anyone who can get the object receives the bytes. Base64 is how JSON carries binary. It is not a lock.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: web-config
data:
  LOG_LEVEL: info
  nginx.conf: |
    server {
      listen 80;
    }
---
apiVersion: v1
kind: Secret
metadata:
  name: web-secrets
type: Opaque
stringData:
  token: the-real-token
```

`data` on a Secret must be base64. `stringData` lets you write the raw text in a manifest; the API stores it base64 and does not return `stringData`. Do not commit that manifest. Prefer the cluster to create the Secret from a sealed file, an external-secrets controller, or a CI secret, which is the last security lesson in this module.

### Env versus files

`envFrom.configMapRef` turns every key into an environment variable. `env.valueFrom.secretKeyRef` pulls one key. Files are mounted with `volumes` and `volumeMounts`. The mount is a directory. Each key is a file. Update the ConfigMap and, for a mounted volume, the kubelet eventually refreshes the files (on the order of a minute, and atomic replace via a symlink you should not cache forever). Environment variables are a snapshot from when the container process started. Changing the ConfigMap does not change the process's env. The pod must be recreated.

That is the rotation rule. A token in an env var sticks until rollout. A token in a file can be re-read by an application that watches the file. Most applications do not watch. A rollout is then the honest rotation. Write that down in the runbook so nobody thinks editing the Secret was enough.

`subPath` mounts a single file and **breaks** the update. The kubelet does not refresh subPath mounts. People use subPath to drop one file into an existing directory and then cannot understand why rotation did nothing. Mount the whole ConfigMap on its own directory.

### Immutable, size, and who can read them

`immutable: true` rejects updates. You create `web-config-3` and change the Deployment to point at it. That is a rollout you can see in Git, and it avoids a hot-update that only some pods have noticed. Use it for config you want to be atomic with the image.

Objects are limited (about 1 MiB). A ConfigMap is not a place for a model file or a database dump. Those belong in a volume or an object store.

RBAC is the real lock. A Role that allows `get` on secrets in the namespace allows reading every Secret in it, including ones your app does not use. Split namespaces or split roles. The default ServiceAccount can be bound more widely than you think if someone copied a cluster-admin binding. The RBAC lesson makes you write the narrow role. Here, the point is: the Secret object is not encrypted because you called it a Secret.

Encryption at rest is a cluster option (etcd encryption provider, or the cloud's disk encryption plus a KMS provider). It protects backups and disk theft. It does not stop `kubectl get secret -o yaml` by an authorized user. EKS can encrypt Kubernetes secrets with KMS. Turn it on for a real cluster. Still do not grant broad `get` on secrets.

### Where it breaks

**`envFrom` name typo.** The pod stays ContainerCreating or crashes on start with CreateContainerConfigError. The event says the ConfigMap or Secret was not found. It is not a probe failure. Fix the name or the namespace. References do not cross namespaces.

**Optional refs.** `optional: true` lets the pod start when the object is missing. The variable is then absent and the app uses a default, sometimes the production default. Optional is for a feature you mean to skip, not for the database URL.

**Binary versus string.** `stringData` is text. A TLS key with the wrong newline is a corrupt key that fails at handshake, not at apply. Check the mounted file inside the pod if you can, not only the YAML.

**ConfigMap as a database.** Controllers that write ConfigMaps every few seconds create etcd load and race with your GitOps controller, which reverts them. Desired state has one writer.

### At work

Twelve-factor apps read env. Kubernetes can supply that from a ConfigMap. Platforms that outgrow it move credentials to a secret manager and leave the cluster Secret as a short-lived projection (External Secrets, or CSI secret store, or EKS Pod Identity so there is no static cloud key at all). The Deployment still says where the file appears in the container. The app still reads a path. Only the source of the bytes changes. You will do that move in the external-secrets lesson; do not skip the basic object, because you have to recognise it when it is wrong.

### You can now

- Put non-secret config in a ConfigMap and a credential in a Secret, and say why the name is not encryption.
- Choose env (snapshot) versus a mounted file (can be refreshed, except subPath).
- Read a CreateContainerConfigError as a missing or forbidden reference.
- Keep Secret manifests out of Git in the clear.
- Explain what encryption at rest does and does not stop.

::: quiz
q: A Secret contains `cGFzc3dvcmQ=`. What protects it from someone who can `kubectl get secret -o yaml`?
- The base64 encoding
+ Nothing. Base64 is an encoding, not encryption; access to Secrets must be restricted with RBAC
- etcd encryption
- The Secret's type: Opaque
why: Anyone who can read the object can decode it. Encryption at rest protects the etcd disk, not API reads; RBAC protects API reads.
:::

::: config lang=yaml
task: The container should get `LOG_LEVEL` from the ConfigMap `web-config` (all its keys, with `envFrom`) and `API_TOKEN` from the key `token` of the Secret `web-secrets`. Edit the Deployment.
starter:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 2
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: web
          image: ghcr.io/acme/web:3.0.0
          env:
            - name: API_TOKEN
              value: "hardcoded-token-123"
```
check: spec.template.spec.containers[0].envFrom[0].configMapRef.name = web-config | envFrom loads the ConfigMap web-config
check: spec.template.spec.containers[0].env[name=API_TOKEN].valueFrom.secretKeyRef.name = web-secrets | API_TOKEN comes from the Secret web-secrets
check: spec.template.spec.containers[0].env[name=API_TOKEN].valueFrom.secretKeyRef.key = token | …key token
check: spec.template.spec.containers[0].env[name=API_TOKEN].value missing | The hard-coded token is gone
solution:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 2
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: web
          image: ghcr.io/acme/web:3.0.0
          envFrom:
            - configMapRef:
                name: web-config
          env:
            - name: API_TOKEN
              valueFrom:
                secretKeyRef:
                  name: web-secrets
                  key: token
```
hint: `envFrom:` is a list: `- configMapRef: { name: web-config }`. For the token, replace `value:` with `valueFrom: secretKeyRef: name/key`.
:::

::: card
q: You can `kubectl get secret -o yaml` and base64-decode a Secret's data. What did the Secret type protect you from?
answer: Nothing cryptographic. A Secret is base64-encoded in the API and readable by anyone authorized to get it. Protection is RBAC, plus optional etcd encryption at rest, which still does not hide the value from an authorized get. Use a Secret instead of a ConfigMap so tools and reviews treat the bytes as sensitive, not because the encoding is a lock.
:::

::: quiz
q: You update a ConfigMap that a container mounted as a volume (not via subPath). The process already running in the container had read the file at startup and cached it. What changes?
- The process's memory updates within a second
+ The file on disk is refreshed by the kubelet, but the process keeps its cached copy until it re-reads or is restarted
- Kubernetes restarts the container automatically
- Environment variables of the process update, even if the ConfigMap was mounted as a file
why: Volume contents are updated periodically. The kernel does not push new file bytes into an application's memory. Env vars are not updated at all, even when they came from the same ConfigMap. A rollout is the reliable way to make every process see the new value.
:::

::: quiz
q: A pod is in CreateContainerConfigError. The event says secret "api-token" not found. What is the most likely fix?
- Raise the memory limit
- Delete the node's container runtime
+ Create the Secret in the same namespace, or correct the name in the pod spec. Secret refs do not cross namespaces
- Mark the Secret optional and ship
why: The kubelet resolves env and volume refs before it starts the container. A missing object is this error, not a probe failure and not an OOM. `optional: true` would hide a missing credential and is the wrong fix for a token the app needs.
:::

::: predict lang=python
q: Env is fixed at start. A mounted key is re-read from disk. What does this print after the ConfigMap value changes?
code:
```python
def sees(mode, cached, disk):
    if mode == "env":
        return cached
    return disk

print(sees("env", "info", "debug"))
print(sees("file", "info", "debug"))
```
answer:
```text
info
debug
```
why: Environment variables were copied into the process at start, so the process still sees info. A reader that opens the mounted file again sees debug, which is what the kubelet has written. Apps that read env once and apps that read a file once at startup behave the same until restart; the file only helps if something re-reads it.
:::

::: config lang=yaml
task: Fix the Deployment pod so `LOG_LEVEL` comes from key `level` of ConfigMap `web-config` as a single env var (not envFrom), and so the ConfigMap `web-config` is also mounted read-only at `/etc/web`. Do not use subPath.
starter:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: web
          image: ghcr.io/acme/web:1.0.0
          env:
            - name: LOG_LEVEL
              value: debug
```
check: spec.template.spec.containers[0].env[name=LOG_LEVEL].valueFrom.configMapKeyRef.name = web-config | LOG_LEVEL references the ConfigMap
check: spec.template.spec.containers[0].env[name=LOG_LEVEL].valueFrom.configMapKeyRef.key = level | the key is level
check: spec.template.spec.containers[0].env[name=LOG_LEVEL].value missing | it is not a literal value
check: spec.template.spec.volumes[name=web-config].configMap.name = web-config | a volume sources the ConfigMap
check: spec.template.spec.containers[0].volumeMounts[name=web-config].mountPath = /etc/web | mounted at /etc/web
check: spec.template.spec.containers[0].volumeMounts[name=web-config].subPath missing | not a subPath mount
solution:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      volumes:
        - name: web-config
          configMap:
            name: web-config
      containers:
        - name: web
          image: ghcr.io/acme/web:1.0.0
          env:
            - name: LOG_LEVEL
              valueFrom:
                configMapKeyRef:
                  name: web-config
                  key: level
          volumeMounts:
            - name: web-config
              mountPath: /etc/web
```
hint: Replace the literal `value:` with `valueFrom.configMapKeyRef`. Add a pod-level volume and a container volumeMount that share the name `web-config`. Leave subPath unset.
:::

## Probes and resources
id: probes
stage: prod
needs: config, linux/processes
minutes: 40
goal: Use startup, readiness, and liveness probes for different decisions, and shut down on SIGTERM without dropping traffic you could have finished.
source: Kubernetes: Liveness, readiness, and startup probes | https://kubernetes.io/docs/concepts/configuration/liveness-readiness-startup-probes/
source: Kubernetes: Pod lifecycle | https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/
source: Kubernetes: Container lifecycle hooks | https://kubernetes.io/docs/concepts/containers/container-lifecycle-hooks/

A process can be running and still unable to serve. It can also be unable to serve for a minute at startup without being broken. Kubernetes cannot see inside your program. Probes are the three questions you agree to answer, and each answer drives a different controller. Mixing them up restarts healthy pods or sends traffic to pods that are still loading.

### The problem

Without a readiness probe, a pod is Ready as soon as the container process has started. The Service sends it traffic while it is still connecting to the database. Clients get errors. You add a liveness probe that hits the same expensive `/health` and, under load, the probe times out, so Kubernetes kills the container, which makes the load worse. You have built a crash loop out of a health check. The fix is to give each probe a job.

**Startup** answers "are you still booting?" Until it succeeds, liveness and readiness do not run. A slow JVM or a model load that takes two minutes needs a startup probe (`failureThreshold` times `periodSeconds` long enough). Without it, the liveness probe kills the process for not answering during boot. That is the usual "it works on my laptop, it restarts on the cluster" bug.

**Readiness** answers "should the Service send you traffic?" Failure removes the pod from the EndpointSlice. The process keeps running. Use this for "cache is cold", "I am shutting down", "downstream is down and I cannot do useful work". Do not use it to express "the whole cluster is unhealthy" on every pod at once, or you empty the Service.

**Liveness** answers "are you wedged so hard that only a restart will help?" Failure kills the container. Use it for a deadlock. Do not point it at a dependency. If the database is down, restarting your API does not bring the database up, and it does drop in-flight work. A liveness probe that checks the database turns a database outage into a cluster-wide restart storm.

```yaml
startupProbe:
  httpGet:
    path: /health
    port: 8000
  failureThreshold: 30
  periodSeconds: 2
readinessProbe:
  httpGet:
    path: /ready
    port: 8000
  periodSeconds: 5
livenessProbe:
  httpGet:
    path: /health
    port: 8000
  periodSeconds: 10
  timeoutSeconds: 1
  failureThreshold: 3
```

`httpGet` hits the pod IP, not the Service. `tcpSocket` only checks that a port accepts. `exec` runs a command in the container; it is easy to make it so heavy that the probe is the load. `grpc` probes exist for gRPC servers. Give every probe a short `timeoutSeconds`. A hung probe counts as a failure once the timeout fires.

### Shutdown

Kubernetes deletes a pod by sending SIGTERM to the containers and waiting `terminationGracePeriodSeconds` (default 30). Then it sends SIGKILL. At the same time it marks the pod NotReady so the EndpointSlice drops it. Those two things are not perfectly ordered on every dataplane. A correct handler:

1. On SIGTERM, fail readiness (or stop the readiness server) immediately.
2. Stop accepting new work.
3. Finish in-flight requests, within the grace period.
4. Exit 0.

If you ignore SIGTERM, the process is killed at the deadline mid-request. If your work takes longer than the grace period (a long agent run, a big upload), raise `terminationGracePeriodSeconds` on the pod. Do not raise it to an hour without a reason; node drains will wait. `preStop` hooks run before SIGTERM and can sleep a few seconds to let endpoints propagate. A `preStop` that sleeps is a blunt tool. Failing readiness is the real tool.

Exit code 137 means SIGKILL, which is 128+9. OOMKilled is also 137, and `describe` says OOMKilled in that case. A probe kill is not an OOM. Read the reason. The resources lesson is where 137 from memory belongs.

### Where it breaks

**The same URL for live and ready, and that URL checks the database.** You wanted to stop traffic. You restarted the fleet.

**No startup probe plus `initialDelaySeconds` guessed wrong.** Prefer a startup probe with a high failure threshold. An initial delay that is "usually enough" fails on a slow node.

**Probes that require authentication.** The kubelet does not log into your app. The probe port should be open to localhost-style checks from the kubelet network, not to the public internet. A separate port is a good pattern.

**`exec` probes that fork a shell every second on a tiny CPU limit.** The probe is throttled, times out, and you get restarts that look like an app bug. `httpGet` is cheaper.

### At work

Reviewers look for a readiness probe on anything behind a Service, a liveness probe that only means "this process is wedged", and a startup probe if boot is slower than the liveness threshold. Rollouts use readiness as the gate, which you saw on Deployments. PodDisruptionBudgets use Ready pods as the count of healthy replicas. A probe that lies makes both of those lie.

The Linux process model is the other half. Your container is PID 1 unless you use an init. PID 1 that does not reap children or pass signals is why a shell-form `CMD` ignores SIGTERM. Prefer the exec form of your image's entrypoint, from the containers module, so the grace period means something.

### You can now

- Assign startup, readiness, and liveness each a single decision.
- Say what happens to a Service when readiness fails, and what does not happen (the process is not killed).
- Write a SIGTERM handler that fails readiness before it finishes work.
- Tell OOMKilled apart from a liveness kill in `describe`.
- Keep dependency checks out of liveness.

### A slow process, walked through

The invoices API takes 40 seconds to open its database pool. Someone sets a liveness probe with `failureThreshold: 3` and `periodSeconds: 10`. Forty seconds after start the kubelet has already killed it. The new container also takes 40 seconds. That is a crash loop, and the events say the liveness probe failed, which is true and useless. The probe did not measure a deadlock. It measured boot.

A startup probe is the budget for boot. While startup has not succeeded, liveness and readiness do not run. Set startup `failureThreshold` times `periodSeconds` above the slowest honest boot, and alert when pods sit in startup longer than that, because a hang during boot is still a hang. After startup succeeds, liveness is the "this process is wedged" check. It should be cheap and should fail only when a restart is the right fix. A liveness probe that depends on a downstream you cannot restart will restart you in a loop while the downstream is the thing that is down.

Readiness is not liveness. Failing readiness removes the pod from Service endpoints. The process keeps running. That is what you want when the process is up but cannot do useful work yet, or when it is draining. Using readiness as liveness, or liveness as readiness, is the pair of mistakes. One restarts a healthy-but-busy process. The other keeps sending traffic to a process that is exiting.

### Where the numbers lie

`timeoutSeconds` is how long the kubelet waits for the probe, not how long your app may take to be ready. A one-second timeout against an endpoint that occasionally takes two seconds flaps. `successThreshold` on readiness can require more than one success before the pod is given traffic, which is how you stop a process that answers once and then dies from entering the Service. Liveness `successThreshold` is forced to 1. If you copy a readiness block onto liveness and wonder why the API rejected it, that is why.

`exec` probes pay a process start on every period. `httpGet` and `tcpSocket` are cheaper. A probe that runs a heavy query will fail when the app is merely busy, and the kubelet will restart the busiest pods. Probe the thing that means "this process can take a request," not "the database is healthy." Database health belongs in readiness if you must shed load, and in a separate alarm if a human should look. It rarely belongs in liveness.

### At work

The platform template has startup, readiness, and liveness stubs, and a review that rejects a Deployment with none of them. The application team fills the paths. `/health` that always returns 200 is not a probe. It is a comment. `/ready` checks the local ability to serve. A preStop hook plus a readiness failure is how a rolling update stops sending new requests before the process exits. The rollout lesson is the budget around that. This lesson is the three probes and the fact that they are not interchangeable.

### Decision

| Symptom | Change |
|---|---|
| Crash loop during boot, logs show the app was still starting | add or lengthen a startup probe; do not loosen liveness forever |
| Pods stay Running but users see connection errors to a dying replica | readiness, and a preStop delay |
| Restarts with OOMKilled | memory limit or a leak, not the probe |
| Slow when CPU looks idle | CPU limit throttle, not a probe period |

### You can now

- Give boot a startup budget so liveness does not kill it.
- Remove traffic with readiness without restarting.
- Restart only when the process itself is wedged.
- Reject a probe that tests a dependency you cannot fix by killing this container.

::: quiz
q: A pod's readiness probe starts failing because its cache is warming up. What does Kubernetes do?
+ Stops sending it traffic through the Service until the probe passes again
- Restarts the container
- Deletes the pod and makes a new one
- Nothing; readiness is informational
why: Readiness controls traffic; liveness controls restarts. That difference is the whole point of having two.
:::

::: quiz
q: A container keeps restarting; `kubectl describe pod` shows `Last State: Terminated, Reason: OOMKilled, Exit Code: 137`. What do you change?
- The liveness probe's timeout
+ Raise the memory limit (and request) to fit the real usage, or fix the memory leak
- The CPU limit
- The image tag
why: OOMKilled means it went over its memory limit and the kernel killed it (SIGKILL, so 137). CPU limits throttle, they never kill.
:::

::: config lang=yaml
task: Make this Deployment production-ready: a **readiness** probe on `GET /ready` port 8000, a **liveness** probe on `GET /health` port 8000, requests of `cpu: 250m` and `memory: 256Mi`, and a memory limit of `512Mi`.
starter:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 3
  selector:
    matchLabels:
      app: api
  template:
    metadata:
      labels:
        app: api
    spec:
      containers:
        - name: api
          image: ghcr.io/acme/api:1.4.2
          ports:
            - containerPort: 8000
```
check: spec.template.spec.containers[0].readinessProbe.httpGet.path = /ready | readinessProbe GETs /ready
check: spec.template.spec.containers[0].readinessProbe.httpGet.port = 8000 | …on port 8000
check: spec.template.spec.containers[0].livenessProbe.httpGet.path = /health | livenessProbe GETs /health
check: spec.template.spec.containers[0].livenessProbe.httpGet.port = 8000 | …on port 8000
check: spec.template.spec.containers[0].resources.requests.cpu = 250m | CPU request 250m
check: spec.template.spec.containers[0].resources.requests.memory = 256Mi | Memory request 256Mi
check: spec.template.spec.containers[0].resources.limits.memory = 512Mi | Memory limit 512Mi
solution:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 3
  selector:
    matchLabels:
      app: api
  template:
    metadata:
      labels:
        app: api
    spec:
      containers:
        - name: api
          image: ghcr.io/acme/api:1.4.2
          ports:
            - containerPort: 8000
          readinessProbe:
            httpGet:
              path: /ready
              port: 8000
            periodSeconds: 5
          livenessProbe:
            httpGet:
              path: /health
              port: 8000
            periodSeconds: 10
          resources:
            requests:
              cpu: 250m
              memory: 256Mi
            limits:
              memory: 512Mi
```
hint: Probes and `resources` sit at the same level as `image` and `ports`, inside the container item.
:::

::: card
q: In Kubernetes, a readiness probe fails and a liveness probe fails. What does each one cause?
answer: Readiness failure removes the pod from Service endpoints and leaves the process running. Liveness failure kills the container so the kubelet can restart it. Startup failure delays the other probes and, if it exceeds the threshold, also kills the container. Do not point liveness at a downstream dependency.
:::

::: quiz
q: During deletion, a pod keeps serving new requests until SIGKILL. The app ignores SIGTERM. What should you change first?
- Remove the readiness probe so deletion is faster
+ Handle SIGTERM by failing readiness and stopping new work, and keep terminationGracePeriodSeconds long enough to finish in-flight requests
- Set the liveness probe to run every second
- Switch the Service to headless
why: Deletion delivers SIGTERM, then waits the grace period, then SIGKILL. If you ignore SIGTERM you are killed mid-request. Failing readiness is what takes you out of the EndpointSlice. A faster liveness probe does not run during a graceful delete as a substitute for a signal handler.
:::

::: predict lang=python
q: A startup probe allows 30 failures at one every 2 seconds. Liveness allows 3 failures at one every 10 seconds. How long can boot take before a kill, and how long can a later hang last? This prints both budgets in seconds.
code:
```python
def budget(failures, period):
    return failures * period

print(budget(30, 2))
print(budget(3, 10))
```
answer:
```text
60
30
```
why: Until startup succeeds, liveness does not run, so boot can take about 60 seconds of failed probes. After that, three liveness failures ten seconds apart kill the container in about 30 seconds. Using the liveness budget as the boot budget is why slow starts crash-loop. The exact kubelet timing includes timeouts, but the product of threshold and period is the budget you meant to set.
:::

::: quiz
q: `kubectl describe pod` shows the last container state as Terminated, Reason OOMKilled, Exit Code 137. The liveness probe is fine. What is the right change?
- Point liveness at a cheaper URL
+ Raise the memory limit, or fix a leak, because the kernel killed the process for exceeding its memory limit
- Increase failureThreshold on the startup probe
- Set restartPolicy to Never so it stops restarting
why: OOMKilled is the kubelet reporting that the cgroup memory limit was hit. Exit 137 is SIGKILL, and the reason field tells you it was the OOM killer, not a probe. Probe changes do not give the process more memory. restartPolicy Never would leave the pod failed, which is not a fix.
:::

::: quiz
q: The invoices API takes 45 seconds to open its pool. Liveness is periodSeconds 10 and failureThreshold 3. There is no startup probe. The pod restarts forever and the logs show a clean boot that never finishes. What is going on?
- Readiness is restarting the container because it is not in the Service yet
+ Liveness is killing the process during boot. A startup probe has to succeed before liveness runs, and that budget has to cover the 45 seconds
- The kubelet always restarts a pod that is not Ready within 30 seconds
- Raise the memory limit. Exit code 137 is the only explanation for a restart
why: Liveness restarts. Readiness only removes endpoints. Without a startup probe, the liveness budget is also the boot budget, and 3 times 10 seconds is shorter than this boot. OOMKilled would say so in the last state. This pattern does not.
:::

## Requests, limits, and QoS
id: resources
stage: prod
needs: probes
minutes: 40
goal: Set CPU and memory requests and limits so the scheduler, the OOM killer, and the CFS quota each do the thing you meant.
source: Kubernetes: Resource management for pods and containers | https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/
source: Kubernetes: Pod QoS classes | https://kubernetes.io/docs/concepts/workloads/pods/pod-qos/
source: Kubernetes: Out of resource handling | https://kubernetes.io/docs/concepts/scheduling-eviction/node-pressure-eviction/

The scheduler does not look at `top`. It looks at numbers you wrote down. If you write nothing, it treats your pod as needing nothing, packs the node, and the kernel starts killing processes when the fiction meets the RAM. Requests and limits are how you tell the truth.

### The problem

A node has 4 CPUs and 16 GiB. Ten pods each "usually use a little" are scheduled onto it because none of them declared a request. At peak they need 20 GiB. The kubelet evicts, the OOM killer fires, and the pods that die are not necessarily the ones that caused it. Requests reserve a share for scheduling. Limits cap what a container can take. They are not the same knob.

**CPU request** is a weight and a scheduling input. `100m` is one tenth of a core. The scheduler subtracts requests from the node's allocatable CPU. It does not subtract current usage.

**CPU limit** is a CFS quota. The container is throttled when it exceeds the limit over the quota period. It is not killed. A service that looks slow with low CPU usage in `top` and high throttle time is hitting its limit. Raising the limit, or the request if the limit equals the request, is the fix. Seeing idle CPU on the node does not help a throttled cgroup.

**Memory request** reserves space for scheduling the same way.

**Memory limit** is a cgroup cap. Cross it and the process is OOMKilled, exit 137, reason OOMKilled. There is no throttle for memory. A limit below the working set is a crash loop. A limit far above the request lets the pod burst into memory the scheduler promised to someone else, until node pressure evicts someone.

### QoS classes

Kubernetes assigns each pod a quality of service class from its containers' requests and limits.

**Guaranteed:** every container has CPU and memory requests, and each limit equals its request. These die last under node pressure.

**Burstable:** at least one request or limit is set, but it is not Guaranteed. Most web apps should be this or Guaranteed. They can burst if you set a limit above the request, and they are evicted before Guaranteed pods when the node is under memory pressure, especially if they use more than they requested.

**BestEffort:** no requests and no limits. Scheduled anywhere, first to be evicted. Fine for a throwaway debug pod. Wrong for anything you mean to keep.

```text
memory pressure on the node
  evict BestEffort first
  then Burstable pods using more than their request
  Guaranteed last
```

A single container that sets memory limit but no request gets its request defaulted to the limit in some admission paths (LimitRange). Do not rely on defaults you have not read. A LimitRange in the namespace can also force a default. The quotas lesson covers that. If your pod arrives with requests you did not write, look at the namespace LimitRange before you blame the Deployment.

### What to write down

Measure a busy hour. Set the memory request near the steady usage and the limit at a peak you are willing to kill above, with headroom for the allocator, not a second copy of the heap "just in case" that makes the scheduler think you need a bigger node. Set the CPU request near what you need to meet latency. Set a CPU limit only if you must cap a noisy neighbour; a limit equal to a tiny request throttles you at the exact moment traffic arrives. Many production APIs set CPU request and no CPU limit, and set both for memory because uncapped memory kills neighbours. That is a defensible split. "Always set both equal" is Guaranteed, which is right for a latency-sensitive pod you do not want evicted, and expensive because the scheduler cannot overcommit that CPU.

Init containers and sidecars count, as the sidecar lesson said. The pod's effective request is what the scheduler sees. A mesh proxy that adds 100 MiB will push a packed node over the edge.

### Where it breaks

**Insufficient memory while `free` looks fine.** The scheduler uses the sum of requests versus allocatable, not free pages. Allocatable is what remains after kubelet reservations. Describe the pod. The event lists the predicate that failed.

**Limit lower than request.** The API rejects that. Good.

**Guaranteed by accident on a batch Job.** You set limit equal to request at a huge number and now the Job cannot schedule beside anything. Burstable would have fit.

**Horizontal pod autoscaling on CPU with no CPU request.** The HPA has nothing to divide by. The scaling lesson's `<unknown>` target is this bug. Requests are not optional if you autoscale on utilization.

### At work

Platform teams set a LimitRange so a namespace cannot admit a BestEffort production pod, and a ResourceQuota so the sum of requests cannot exceed what the team paid for. Application teams pick the numbers from a dashboard (working set, throttle seconds), not from a guess copied from a sample manifest. The cloud module's cost lesson is the same fact in dollars: a request is a reservation you could have sold to another pod. Over-requesting is the quiet way to run out of cluster.

### You can now

- Say what the scheduler adds up, and why free memory on the node can disagree.
- Predict OOMKilled from a memory limit, and throttling from a CPU limit.
- Classify Guaranteed, Burstable, and BestEffort from the manifest.
- Set a CPU request when you plan to autoscale on CPU utilization.
- Include sidecar requests in the sum.

### One node, three pods

A node has 4 allocatable CPUs and 16 GiB. Pod A requests 3 CPU and 10 GiB and uses a little. Pods B and C request nothing and each want 6 GiB at peak. The scheduler places all three, because B and C claimed to need nothing. At peak the kubelet evicts and the OOM killer runs. The pod that dies may be A, the one that told the truth, because OOM scores are not "who forgot a request." Requests are how you stop the scheduler from lying. They are not a fair queue at runtime.

CPU limit is a different lie. The container is throttled, not killed, when it exceeds the CFS quota. A dashboard that shows spare CPU on the node while p99 latency climbs is often throttle time inside the cgroup. Memory limit is a kill. Crossing it is SIGKILL and the reason `OOMKilled`. Raising a memory limit without a request does not reserve room on the node. Setting limit equal to request for memory is the Guaranteed QoS pattern: the kubelet would rather evict a Burstable or BestEffort pod first. BestEffort is what you get with no requests and no limits. It is the first to go under pressure, which is acceptable for a batch experiment and reckless for the API.

### Where it breaks

A request larger than any node is unschedulable forever. The event is `Insufficient cpu` or `Insufficient memory`, and scaling the Deployment does nothing. A limit far above the request lets one pod steal from others until the node is under pressure. A limit below the request is rejected or pointless depending on the resource. Vertical Pod Autoscaler and the HPA are the autoscale lesson. They cannot invent a request you never measured. Look at usage over a week, set the request near the steady need, and set the memory limit with headroom for the spike you are willing to pay for. A limit that is only a little above the peak will OOM on the next release.

Init containers and sidecars have their own requests. The scheduler takes the maximum of init containers (they run one at a time, with native sidecars as the exception you already met) plus the sum of app containers. Forgetting the sidecar's request is how a node that "had room" rejects the pod.

### At work

Namespaces get a LimitRange so a container with no numbers inherits a default request and limit, and a ResourceQuota so the sum cannot eat the cluster. The quota lesson is that cap. Here the point is the per-container truth the quota adds up. Reviews reject `resources: {}` on anything that serves traffic. They also reject a 16 GiB request copied from a laptop "so it never OOMKs," because that request is a node.

### Decision

| Goal | Set |
|---|---|
| Pack nodes honestly | requests from measured steady use |
| Stop one box from taking the node | CPU limit if you must; expect throttle |
| Die rather than swap or get evicted mid-request | memory limit, with the request close to it for Guaranteed |
| Survive node pressure | do not be BestEffort |
| Let a class of jobs be killed first | Burstable or BestEffort, on purpose, on a tainted pool |

### You can now

- Explain why the scheduler ignores `top`.
- Tell CPU throttle from memory OOM.
- Name the three QoS classes from the presence of requests and limits.
- Include every container, including sidecars, in the request sum.

::: quiz
q: A container's CPU usage is being throttled, and the node has idle CPU. What change addresses the throttle?
- Raise the memory limit
+ Raise the container's CPU limit, or remove it. The cgroup quota is local to the container and does not care that the node is idle
- Lower the CPU request so the scheduler moves the pod
- Add a liveness probe
why: The CPU limit is a quota enforced even when the node has spare cycles. The request affects scheduling and CPU shares, not the throttle ceiling. Moving the pod does not raise the quota. Memory and probes are unrelated to CFS throttling.
:::

::: quiz
q: Every container in a pod sets CPU and memory requests equal to limits. What QoS class is the pod?
- BestEffort, because it cannot burst
+ Guaranteed
- Burstable, because Deployments are always Burstable
- It depends on the namespace quota
why: Guaranteed means each container has CPU and memory requests and each limit equals that request. BestEffort means nothing was set. Burstable is the middle. QoS is computed from the pod spec, not from the controller kind or the quota.
:::

::: card
q: In Kubernetes, what is the difference between a memory limit and a CPU limit when the container exceeds it?
answer: Exceeding a memory limit gets the container OOMKilled (exit 137). Exceeding a CPU limit throttles the container; it is not killed. Requests of either resource are what the scheduler uses to decide if the pod fits, and they are not a kill line.
:::

::: predict lang=python
q: QoS from whether cpu and memory are both set with limit == request on the only container. What does this print?
code:
```python
def qos(cpu_req, cpu_lim, mem_req, mem_lim):
    vals = (cpu_req, cpu_lim, mem_req, mem_lim)
    if all(v is None for v in vals):
        return "BestEffort"
    if None not in vals and cpu_req == cpu_lim and mem_req == mem_lim:
        return "Guaranteed"
    return "Burstable"

print(qos("100m", "100m", "128Mi", "128Mi"))
print(qos("100m", "500m", "128Mi", "256Mi"))
print(qos(None, None, None, None))
```
answer:
```text
Guaranteed
Burstable
BestEffort
```
why: Equal requests and limits on both resources is Guaranteed. A limit above the request is Burstable: the scheduler reserved the request, and the container may use more until the limit or until the node is under pressure. Nothing set is BestEffort, scheduled as if it needs zero, and evicted first.
:::

::: write lang=python
task: Implement `fits(allocatable_m, requests_m)` where both arguments are lists of CPU in millicores. `allocatable_m` is one node's free allocatable CPU. Return True if the sum of `requests_m` is less than or equal to that free CPU.
starter:
```python
def fits(allocatable_m, requests_m):
    return True
```
tests:
```python
from solution import fits

def test_exact():
    assert fits(1000, [200, 300, 500]) is True

def test_over():
    assert fits(1000, [600, 500]) is False

def test_empty():
    assert fits(100, []) is True
```
solution:
```python
def fits(allocatable_m, requests_m):
    return sum(requests_m) <= allocatable_m
```
hint: The scheduler adds requests. It does not look at limits for the fit check. Compare the sum with the node's allocatable remainder.
:::

::: config lang=yaml
task: Make this container Burstable on purpose: CPU request 100m with limit 500m, memory request 128Mi with limit 256Mi.
starter:
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: api
spec:
  containers:
    - name: api
      image: ghcr.io/acme/api:1.0.0
      resources:
        requests:
          cpu: 100m
          memory: 128Mi
        limits:
          cpu: 100m
          memory: 128Mi
```
check: spec.containers[0].resources.requests.cpu = 100m | cpu request 100m
check: spec.containers[0].resources.limits.cpu = 500m | cpu limit 500m so it can burst
check: spec.containers[0].resources.requests.memory = 128Mi | memory request 128Mi
check: spec.containers[0].resources.limits.memory = 256Mi | memory limit 256Mi
solution:
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: api
spec:
  containers:
    - name: api
      image: ghcr.io/acme/api:1.0.0
      resources:
        requests:
          cpu: 100m
          memory: 128Mi
        limits:
          cpu: 500m
          memory: 256Mi
```
hint: Guaranteed is limit equal to request. Raise only the limits so the requests stay the scheduling reservation.
:::

## Scheduling: affinity, taints, and spread
id: scheduling
stage: prod
needs: resources
minutes: 40
goal: Place pods with node selectors, affinity, taints and tolerations, and topology spread, and say which rule made a pod Pending.
source: Kubernetes: Assigning pods to nodes | https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/
source: Kubernetes: Taints and tolerations | https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/
source: Kubernetes: Pod topology spread constraints | https://kubernetes.io/docs/concepts/scheduling-eviction/topology-spread-constraints/

Requests decide whether a pod fits. Placement rules decide which nodes are even candidates. When a pod stays Pending and the resources look fine, one of these rules is the reason, and `describe` prints it in the predicate list. You should be able to read that sentence.

### The problem

A cluster is not a uniform pool. GPU nodes are expensive. A zone can disappear. Two replicas on the same node die together when that node dies. A DaemonSet for the log agent must land everywhere, and a batch Job must not land on the nodes that serve the API. If you leave placement to the score function, you get a reasonable spread until the day you do not. The constraints below are how you make the requirement explicit.

### Node selector and node affinity

`nodeSelector` is a map of labels that must all match. It is the small tool. Use it for `disk=ssd` or a pool name.

Node affinity is the larger tool. `requiredDuringSchedulingIgnoredDuringExecution` is a hard filter. If no node matches, the pod stays Pending. `preferredDuringSchedulingIgnoredDuringExecution` adds score. The scheduler may ignore a preference when only non-preferred nodes have room. The long middle phrase means the rule is applied when the pod is scheduled, not continuously. Changing labels later does not evict the pod. (There is a separate required-during-execution form for some affinity types; do not assume a preference evicts.)

```yaml
affinity:
  nodeAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      nodeSelectorTerms:
        - matchExpressions:
            - key: topology.kubernetes.io/zone
              operator: In
              values: [eu-central-1a, eu-central-1b]
```

`In`, `NotIn`, `Exists`, `DoesNotExist`. `Gt` and `Lt` exist for numeric node labels. Terms in the list are ORed. Expressions inside one term are ANDed.

### Taints and tolerations

A taint is on a node. A toleration is on a pod. Effects:

| Effect | Meaning |
| --- | --- |
| NoSchedule | Do not place new pods that do not tolerate it |
| PreferNoSchedule | Try not to, but you may |
| NoExecute | Evict running pods that do not tolerate it, after an optional tolerationSeconds |

The control plane is tainted NoSchedule so random Deployments do not land on it. A GPU pool should be tainted so only pods that tolerate `nvidia.com/gpu` (or your key) land there. Without the taint, a normal web pod can be scheduled onto the expensive node because it fits. The taint is what reserves the pool. The toleration is what opts in. You need both. A toleration without a matching pod request for the GPU still wastes the node if you also forget to request the device.

`NoExecute` is how a node problem drains pods that cannot tolerate the condition, and how you keep a DaemonSet on a node you are about to reboot only if you meant to. Copying tolerations from a sample "so it schedules" is how an app ends up on the control plane.

### Pod affinity and topology spread

Pod affinity attracts or repels relative to pods that already run. `podAntiAffinity` required, topology `kubernetes.io/hostname`, keeps replicas off the same node. Required anti-affinity can make a pod unschedulable when you have more replicas than nodes. Prefer that only when co-location is a real failure.

Topology spread is the modern "do not clump" control:

```yaml
topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: DoNotSchedule
    labelSelector:
      matchLabels:
        app: api
```

Skew is the difference between the most-loaded and least-loaded domain, counting pods that match the selector. `maxSkew: 1` across zones means the counts differ by at most one. `DoNotSchedule` leaves the pod Pending rather than clump. `ScheduleAnyway` records the skew and places the pod anyway. Use DoNotSchedule when a zone outage must not take every replica, and only if you truly have room in the empty zone. Otherwise the rollout sticks, which looks like a bad image and is a spread constraint.

`matchLabelKeys` (beta since 1.27, on by default) can include `pod-template-hash` so a rolling update spreads each revision separately instead of treating old and new pods as one pile. It is beta, not GA, as of the current docs. Do not depend on it in a lecture example that must be stable, but know why a rollout piles new pods into one zone: the selector matched every revision, and the least-loaded zone was computed against a set that already included the old pods.

`minDomains` stops a spread constraint from looking satisfied when the scheduler has only seen one zone because the other nodes are NotReady. Without it, "skew across one domain" is always fine, and you lose the zone you thought you required.

### Where it breaks

**Required rules that sum to empty.** Affinity wants zone A, a taint is only tolerated in pool B which is in zone C, requests need 8 GiB and pool B has 4. The events list several predicates. Read all of them. Fixing the first one reveals the second.

**Preferences you thought were guarantees.** Preferred affinity will stack replicas on one node when the preferred nodes are full. If that is unacceptable, it is required, and you must have capacity.

**Spread plus a surge rollout.** New pods need extra room in the under-filled zone. `maxUnavailable: 0` plus `DoNotSchedule` plus a full zone is a stuck rollout. The rollouts lesson is this interaction.

### At work

Platform teams label nodes (`pool=general`, `pool=gpu`) and taint the special pools. Application teams write a node selector or a toleration they were given, plus a zone spread for anything that has more than one replica and a real availability target. They do not invent taints. A taint nobody documented is an outage for the next Deployment. Keep the key, the effect, and the toleration in the same review.

### You can now

- Distinguish a hard node affinity from a preference, including that preferences do not evict.
- Pair a taint with a toleration and name the three effects.
- Write a topology spread that caps zone skew, and say what DoNotSchedule costs you.
- Read a Pending event as a failed predicate, not as "Kubernetes is down".
- Avoid required anti-affinity that asks for more nodes than you have.

::: quiz
q: A node is tainted `pool=gpu:NoSchedule`. A pod has a toleration for that taint and does not request a GPU. Can the scheduler place it on that node?
- No. A toleration also requests the device
+ Yes, if it otherwise fits. A toleration permits the taint; it does not require the node, and it does not request a GPU
- No. NoSchedule cannot be tolerated
- Only if the pod is a DaemonSet
why: Tolerations opt in to a tainted node. They do not bind the pod to it, and they do not allocate extended resources. Another untainted node may still be chosen. To keep ordinary pods off the GPU pool you need the taint. To make a pod actually use a GPU you request the resource. NoSchedule is exactly the effect a toleration is allowed to override.
:::

::: quiz
q: topologySpreadConstraints set maxSkew 1 on zones with whenUnsatisfiable DoNotSchedule. One zone is full and the other is empty. A new pod does not fit in the empty zone because of requests. What happens?
- The scheduler ignores the constraint and uses the full zone
+ The pod stays Pending. DoNotSchedule will not break the skew
- The pod is placed and the constraint is rewritten to ScheduleAnyway
- Kubernetes adds a node automatically
why: DoNotSchedule is a hard filter. ScheduleAnyway is the mode that places the pod and lives with the skew. The cluster autoscaler might add a node later if one is configured; the scheduler itself does not. Preferred affinity is the other "soft" tool, and this field is not that.
:::

::: card
q: What is the difference between a Kubernetes node taint and a pod nodeSelector?
answer: A taint is set on a node and repels pods that do not tolerate it (NoSchedule, PreferNoSchedule, or NoExecute). A nodeSelector is set on a pod and attracts it only to nodes that have all those labels. You use a taint to keep the wrong pods off a pool, and a selector or node affinity to send the right pods to a pool. Special pools usually need both.
:::

::: predict lang=python
q: Hard filters: the pod needs the label and must tolerate every taint. What does this print?
code:
```python
def place(node_label, taints, want_label, tolerations):
    if node_label != want_label:
        return "skip-label"
    if any(t not in tolerations for t in taints):
        return "skip-taint"
    return "candidate"

print(place("gpu", ["gpu"], "gpu", ["gpu"]))
print(place("gpu", ["gpu"], "gpu", []))
print(place("general", [], "gpu", ["gpu"]))
```
answer:
```text
candidate
skip-taint
skip-label
```
why: The first node is a GPU node and the pod tolerates it. The second has the right label but the pod forgot the toleration, so NoSchedule would reject it. The third is tolerated only because it has no taint, but the label does not match, so a nodeSelector for gpu skips it. Pending pods usually fail one of these two checks.
:::

::: config lang=yaml
task: Add a required node affinity so this pod only schedules onto nodes labelled `pool=general`, and a toleration for taint key `dedicated`, value `batch`, effect NoSchedule, operator Equal.
starter:
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: worker
spec:
  containers:
    - name: worker
      image: ghcr.io/acme/worker:1.0.0
```
check: spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].key = pool | affinity key pool
check: spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].operator = In | operator In
check: spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].values[0] = general | value general
check: spec.tolerations[0].key = dedicated | toleration key
check: spec.tolerations[0].operator = Equal | operator Equal
check: spec.tolerations[0].value = batch | value batch
check: spec.tolerations[0].effect = NoSchedule | effect NoSchedule
solution:
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: worker
spec:
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          - matchExpressions:
              - key: pool
                operator: In
                values:
                  - general
  tolerations:
    - key: dedicated
      operator: Equal
      value: batch
      effect: NoSchedule
  containers:
    - name: worker
      image: ghcr.io/acme/worker:1.0.0
```
hint: Required affinity lives under affinity.nodeAffinity, with matchExpressions inside nodeSelectorTerms. The toleration is a list on the pod spec, and Equal means you set value, not only the key.
:::

::: quiz
q: You set preferred (not required) pod anti-affinity so replicas avoid sharing a node. The preferred nodes are full. What may the scheduler do?
- Leave the pod Pending forever, because anti-affinity always binds
+ Place the pod on a node that already has a replica. Preferred rules affect score, they do not forbid
- Evict the other replica
- Convert the preference into a required rule after five minutes
why: The word preferred is the contract. Required anti-affinity would stay Pending or need another node. IgnoredDuringExecution also means an already-running pod is not evicted when the preference can no longer be met. If sharing a node is unacceptable, say required and pay for the capacity.
:::

## Persistent storage and StatefulSets
id: storage-k8s
stage: prod
needs: probes, cloud/storage
minutes: 40
goal: Give a pod a disk that outlives the container, and use a StatefulSet when names and volumes must stick together.
source: Kubernetes: Persistent volumes | https://kubernetes.io/docs/concepts/storage/persistent-volumes/
source: Kubernetes: StatefulSets | https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/
source: Kubernetes: Volume snapshots | https://kubernetes.io/docs/concepts/storage/volume-snapshots/

`emptyDir` dies with the pod. That is fine for a cache and fatal for a database. Persistent storage is a claim for a disk that the cluster reattaches to whichever node the next pod lands on, within the rules of that disk. StatefulSet is the controller that gives each replica a stable name and its own claim, so the disk and the identity move together.

### The problem

A Deployment named `postgres` with a volume and three replicas is a trap. All three pods may try to mount one ReadWriteOnce disk, or each restart gets an empty volume if you used emptyDir, or the pod is rescheduled into another availability zone where the disk cannot attach. The database looks "up" in kubectl and serves an empty data directory. You wanted one identity, one disk, and a name DNS can find after a restart.

The pieces are split on purpose.

A **StorageClass** is a driver and its parameters (`gp3` in one zone, `waitForFirstConsumer`, encrypted). Apps should not hard-code the cloud.

A **PersistentVolumeClaim** is a request: size, access mode, StorageClass. The pod mounts the claim, not a cloud disk id.

A **PersistentVolume** is the bound disk. With dynamic provisioning you rarely write one. The CSI driver creates it when the claim is bound.

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: pg-data
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: gp3
  resources:
    requests:
      storage: 20Gi
```

`ReadWriteOnce` means one node mounts it read-write, not one pod. Two pods on the same node can sometimes both mount it, which is still a bad database layout. `ReadWriteMany` needs a storage system that supports it (EFS-like). Most block disks do not. `ReadOnlyMany` is for shared inputs.

`WaitForFirstConsumer` delays binding until a pod is scheduled, so the disk is created in the zone the pod actually landed in. `Immediate` binding can create the disk in zone A and then the only free node is in zone B, and the pod sits ContainerCreating forever on a volume that cannot attach. If your StorageClass is Immediate, pin the pod to the volume's zone with affinity. The quiz about a pod stuck after its node in zone A died is this constraint: an EBS volume is zonal. The new pod must be scheduled in zone A, or you restore a snapshot in zone B.

### StatefulSet

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: pg
spec:
  serviceName: pg
  replicas: 3
  selector:
    matchLabels:
      app: pg
  template:
    metadata:
      labels:
        app: pg
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 20Gi
```

Pods are named `pg-0`, `pg-1`, `pg-2`. They are created in order and, by default, deleted in reverse order. Each gets a claim `data-pg-0` that is **not** deleted when the pod is deleted. A new `pg-0` mounts the same claim. A headless Service named `pg` gives `pg-0.pg.ns.svc.cluster.local`. That stable DNS name is how replicas find the primary. A Deployment cannot promise the name or the disk.

Scaling a StatefulSet down does not delete the claim. You can orphan disks you are still paying for. Deleting the StatefulSet does not delete claims either, unless you set a persistent volume retain policy you have read carefully. `volumeClaimTemplates` are not a backup policy.

`podManagementPolicy: Parallel` starts them all at once. Use OrderedReady (the default) for a database that needs the primary up first. OrderedReady will stall the set if `pg-0` never becomes Ready. Fix `pg-0`. Do not switch to Parallel to hide that.

### Snapshots and backups

A volume snapshot is a point-in-time copy if the CSI driver supports `VolumeSnapshot`. It is not a dump you have tested restoring. For a database, a snapshot without freezing writes can capture a torn page. Use the database's backup tool, or quiesce, then snapshot. A PVC in Kubernetes is not an off-site backup. A zone loss takes the zonal disk and the snapshot if the snapshot lives in the same failure domain. The cloud storage lesson's "copy to another region" rule still applies.

### Where it breaks

**Access mode fantasy.** Asking for ReadWriteMany on a gp3 class fails or, worse, your platform silently gives you something else. Read the bound PV.

**Two writers.** Even if the mount succeeds, Postgres will corrupt a data directory with two primaries. The volume does not enforce your topology. The StatefulSet replica count and your operator do.

**Capacity.** Growing a claim is allowed when the StorageClass sets `allowVolumeExpansion: true`. Shrinking is not. Plan the size, and watch inode or disk-full inside the pod. A full disk looks like a crashed database, not like Pending.

**Permissions.** The volume is root-owned and your container runs as uid 10001. The process cannot write. An init container that `chown`s the mount, or a StorageClass that sets the fsGroup via the pod `securityContext.fsGroup`, is the fix. The restricted Pod Security Standard allows fsGroup. It does not chown the disk for you.

### At work

Application teams request a StorageClass the platform published and a size. They use a StatefulSet or an operator (a database operator is a controller that creates StatefulSets) rather than a Deployment with a hand-written claim, unless there is exactly one replica and they accept the zone pinning. Backups are a Job on a schedule, restored in a game day, not a volume you hope is enough. Stateless Deployments should stay stateless: put files in object storage when you can, which scales without zonal attach.

### You can now

- Say what happens to an emptyDir versus a PVC when the pod is deleted.
- Explain why an EBS-backed pod can stick Pending after a zone failure.
- Choose a StatefulSet when you need stable names and one claim per replica.
- Predict that scaling down does not delete volume claims.
- Separate a disk snapshot from a backup you have restored.

::: quiz
q: Why might a pod with an EBS-backed PVC get stuck Pending after its node in AZ a died?
+ The EBS volume lives in AZ a, so the pod can only be scheduled on a node in AZ a; if there's none with capacity, it waits
- PVCs can't be reused
- StatefulSets don't support EBS
- The volume was deleted with the node
why: EBS volumes are zonal. Spread nodes across AZs with spare capacity, or use storage that isn't tied to one AZ.
:::

::: card
q: Deployment vs StatefulSet: when do you need the StatefulSet?
answer: When each replica needs a stable identity: a fixed name (db-0, db-1), ordered start and stop, and its own persistent volume that stays with it. Stateless apps use Deployments.
:::

::: quiz
q: You delete a StatefulSet pod named `pg-0`. The claim was created from volumeClaimTemplates. What happens to the data?
- The claim is deleted with the pod, like emptyDir
+ The claim `data-pg-0` remains, and a replacement `pg-0` mounts it
- The data is copied into the container image
- Kubernetes converts the StatefulSet into a Deployment
why: volumeClaimTemplates create claims whose names stick to the pod identity. Deleting the pod does not delete the claim. emptyDir is the volume that disappears. Deleting the claim, or the whole namespace, is what deletes the data, subject to the reclaim policy.
:::

::: card
q: Why can a pod that uses an EBS volume get stuck Pending when it is rescheduled after its node dies?
answer: EBS volumes are tied to one availability zone. The claim is already bound to a volume in the old zone, so the new pod must be scheduled there. If that zone has no capacity, or affinity sends the pod elsewhere, the volume cannot attach. WaitForFirstConsumer avoids picking the zone before the first pod is placed; it does not make a zonal disk follow the pod to another zone.
:::

::: predict lang=python
q: Claims outlive scale-down. Starting from three claims, scale to 1, then back to 3. What does this print for how many claims exist?
code:
```python
def scale(claims, replicas):
    while len(claims) < replicas:
        claims.append(f"data-{len(claims)}")
    return len(claims)

claims = ["data-0", "data-1", "data-2"]
print(scale(claims, 1))
print(scale(claims, 3))
```
answer:
```text
3
3
```
why: Scaling from 3 to 1 does not pop claims in this model, which matches a StatefulSet: the extra claims remain. Scaling back to 3 reuses them rather than creating data-3. You are still paying for the disks while the replicas are gone. Deleting claims is a separate, explicit step.
:::

::: config lang=yaml
task: Write a PersistentVolumeClaim named `queue-data` for 10Gi, access mode ReadWriteOnce, storage class `gp3`.
starter:
```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: queue
spec:
  accessModes:
    - ReadWriteMany
  resources:
    requests:
      storage: 1Gi
```
check: metadata.name = queue-data | name queue-data
check: spec.accessModes[0] = ReadWriteOnce | ReadWriteOnce
check: spec.storageClassName = gp3 | class gp3
check: spec.resources.requests.storage = 10Gi | size 10Gi
solution:
```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: queue-data
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: gp3
  resources:
    requests:
      storage: 10Gi
```
hint: Fix the name, the access mode, the size, and add storageClassName. ReadWriteMany is not what a normal zonal disk provides.
:::

::: quiz
q: A Deployment has three replicas and one ReadWriteOnce PVC mounted by the pod template. What risk are you taking?
- None. Deployments cannot mount claims
+ More than one pod may try to mount a disk that can attach to only one node, so two replicas fail or you must pin everything to one node
- Each replica automatically gets its own claim
- The claim becomes ReadWriteMany because the Deployment has three replicas
why: A Deployment's pods share the same volume stanza. It does not clone the claim per replica. That cloning is what volumeClaimTemplates on a StatefulSet do. ReadWriteOnce will not follow all three pods onto three nodes.
:::

## Rollouts and PodDisruptionBudgets
id: rollouts
stage: prod
needs: deployments, probes
minutes: 40
goal: Control how a Deployment replaces pods, and use a PodDisruptionBudget so voluntary evictions cannot take the last ready replica.
source: Kubernetes: Deployments | https://kubernetes.io/docs/concepts/workloads/controllers/deployment/
source: Kubernetes: Disruptions | https://kubernetes.io/docs/concepts/workloads/pods/disruptions/
source: Kubernetes: Pod disruption budgets | https://kubernetes.io/docs/tasks/run-application/configure-pdb/

A rolling update and a node drain are the same kind of event from the user's point of view: a ready pod goes away. They are different kinds of event for Kubernetes. The Deployment strategy limits how many pods the rollout itself will kill or add. A PodDisruptionBudget limits voluntary disruptions from somewhere else (drain, autoscaler, an admin deleting a pod through the eviction API). Neither one stops a node from crashing. You need both, and they can deadlock each other if you set them as if they were the same knob.

### The problem

`maxUnavailable: 0` feels safe. A drain also feels safe. Together they can stick: the rollout will not terminate an old pod until a new one is Ready, the drain will not evict the old pod because the PDB says `minAvailable` equals the replica count, and the new pod is Pending because the only free CPU is on the node you are trying to drain. The cluster looks frozen. Nobody is "not working". The policies are each doing what you asked.

### Strategy, again, as a contract

RollingUpdate parameters round percentages up. `maxSurge` is extra pods. `maxUnavailable` is how many may be not-yet-updated. `Recreate` is downtime on purpose. `minReadySeconds` and a real readiness probe are what "updated" means. `progressDeadlineSeconds` turns a stuck rollout into a failed status you can alert on, instead of a spinner.

Pause (`spec.paused: true`) holds the rollout so you can inspect a canary you created some other way. Forgetting to unpause looks like "apply did nothing". Check `kubectl rollout status` and the paused field before you rewrite the chart.

`kubectl rollout undo` rolls to the previous ReplicaSet. It is the right button when the new pods are CrashLooping and the old ones still serve. It is the wrong button when the new version migrated the database forward. Undo will run the old code against the new schema. The migration has to be backward compatible, or undo is a lie. That is an application rule Kubernetes will not enforce.

### Voluntary versus involuntary

Involuntary: the node lost power, the kernel OOM-killed the process, the VM disappeared. No budget can prevent that. Spread pods across zones so one involuntary failure is not all of them.

Voluntary: `kubectl drain`, the cluster autoscaler removing a node, `kubectl delete pod` going through eviction when a controller asks politely, an API call to the eviction subresource. These honor PodDisruptionBudgets.

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: api
  unhealthyPodEvictionPolicy: IfHealthyBudget
```

The selector must match the same pods the Deployment creates. A typo means the budget protects nothing and you think you are safe. `minAvailable: 2` with `replicas: 2` means a drain cannot evict either pod while both are healthy. You cannot drain the node. Prefer `minAvailable` strictly below the replica count, or use `maxUnavailable: 1`. You may set only one of minAvailable and maxUnavailable.

`unhealthyPodEvictionPolicy` is GA since Kubernetes 1.31. The default `IfHealthyBudget` will not evict a Running-but-not-Ready pod when the budget is already broken. A crash-looping pod can then block a drain forever. `AlwaysAllow` lets those unhealthy pods be evicted even when the budget is short, so you can get a node back. Healthy pods are still protected. Set AlwaysAllow when a bad rollout must not freeze cluster maintenance. The default is safer when you would rather wait than lose a pod that might become Ready.

Pods in Pending, Succeeded, or Failed are always allowed to be evicted. The budget is about Ready capacity, not about every object with a label.

### How a drain is supposed to look

The admin drains a node. The eviction API asks each pod. The PDB allows one eviction because three replicas are Ready and maxUnavailable is 1. The pod gets SIGTERM, fails readiness, finishes work, exits. The Deployment creates a replacement elsewhere. When that replacement is Ready, another eviction is allowed. A PDB does not create the replacement. The Deployment does. A bare pod with a PDB can be protected and then never come back. Do not do that.

### Where it breaks

**minAvailable equal to replicas.** Maintenance stops. People then delete the PDB in a hurry and drain everything at once. Set the budget to the real minimum.

**A budget and a rollout that both refuse to go below N, on a cluster with no spare CPU.** Surge pods cannot schedule, old pods cannot be evicted. Add capacity, or allow surge onto the draining node before you cordon, or briefly allow unavailability.

**Selector wider than one app.** A budget selecting `tier: web` counts every web pod in the namespace as one application. You can lose all of one service while the count still looks fine. Select the same labels as the Deployment.

**Believing a PDB helps during a zone outage.** It does not. The pods are already gone. Topology spread and multiple replicas are what help. The budget only shapes voluntary moves.

### At work

Every service with more than one replica and a user-facing SLA gets a PDB in the same chart as the Deployment. The number matches the error budget: "we can lose one pod, not two". Rollout settings match the same sentence. Platform teams drain nodes every week for patching. If your app cannot be drained, it will be drained anyway during an incident, without the grace period you wanted. Practice the drain in kind by cordoning a worker and watching the budget.

### You can now

- Set maxSurge and maxUnavailable as a pair that matches spare capacity.
- Explain why undo is unsafe after a one-way migration.
- Write a PDB whose selector matches the Deployment and whose minimum is actually below the replica count.
- Say what unhealthyPodEvictionPolicy AlwaysAllow changes about crash-looping pods.
- Explain a stuck drain as a budget plus a rollout plus no spare capacity, not as a frozen API server.

### The boundary with autoscaling

A rollout replaces pods. A PodDisruptionBudget limits how many of those pods a voluntary disruption may take at once. Neither object changes the replica count because traffic grew. The HPA and KEDA do that. When a rollout, a drain, and a scale-down happen together, the budget still applies. Set maxUnavailable on the strategy and on the budget so one drain cannot empty the Service while a rollout has already taken a pod down. unhealthyPodEvictionPolicy AlwaysAllow lets the drain evict pods that are not Ready, so a broken pod does not pin the node. It does not let you evict the last ready pod past the budget.

Replica math from CPU or from a queue belongs to the scaling and autoscale lessons. This lesson stays on the replacement and the voluntary-disruption contract.

### You can now

- Hold strategy and disruption budgets in one picture.
- Leave load-driven replica counts to the autoscalers.
- Evict unready pods without giving up the last ready one.

A maxSurge rollout creates extra pods before it deletes old ones, so the budget and the surge both consume quota and node CPU at the same time. If the quota was sized for the steady replica count, the surge pods stay Pending, the new ReplicaSet never becomes ready, and the old pods remain. Size quota and node room for the surge, or set maxSurge to zero and accept a slower replacement that stays inside the steady footprint. The PDB does not create that room. It only refuses voluntary eviction when you are already short.

::: quiz
q: A node loses power. The pods on it die. How does the PodDisruptionBudget change that outcome?
- It restarts the node so the pods can stay
+ It does not. A power loss is involuntary. The budget only gates voluntary evictions such as drain
- It keeps the pods Running on another node without rescheduling
- It freezes the Deployment so no replacement is created
why: PDBs are consulted by the eviction API. A crashed node does not ask permission. Replacements exist only because a controller wanted N replicas. Spread and multiple replicas are what limit the blast radius of a crash.
:::

::: quiz
q: replicas is 2 and the PDB says minAvailable 2. An admin drains the only node those pods can run on, and there is spare room elsewhere. What happens?
- Both pods move immediately
+ The drain blocks. Evicting either healthy pod would drop the ready count below minAvailable
- The PDB is ignored because drain is an admin
- Kubernetes scales the Deployment to 3 automatically
why: minAvailable equal to the replica count forbids any voluntary eviction while both are healthy. Drain uses the eviction API, so it waits. Admins can still force-delete, which bypasses the budget and the grace period. The right manifest is a lower minimum, or more replicas.
:::

::: card
q: What does unhealthyPodEvictionPolicy AlwaysAllow do on a PodDisruptionBudget?
answer: It allows eviction of pods that are Running but not Ready even when the disruption budget is already short. The default, IfHealthyBudget, holds those pods if the application is already disrupted, which can block a drain on a crash loop. Healthy Ready pods are still protected either way. The field has been GA since Kubernetes 1.31.
:::

::: predict lang=python
q: Voluntary eviction is allowed only when ready - 1 is still at least min_available. What does this print?
code:
```python
def allow(ready, min_available):
    return "allow" if ready - 1 >= min_available else "deny"

print(allow(3, 2))
print(allow(2, 2))
print(allow(1, 2))
```
answer:
```text
allow
deny
deny
```
why: Three ready pods can lose one and still have two. Two ready pods with minAvailable 2 cannot lose any. One ready pod is already below the budget, so a further voluntary eviction is denied under the default policy. A crash does not call this function.
:::

::: config lang=yaml
task: Write a PodDisruptionBudget named `api` that selects `app: api`, allows at most 1 unavailable pod, and sets unhealthyPodEvictionPolicy to AlwaysAllow. Do not also set minAvailable.
starter:
```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api
spec:
  minAvailable: 100%
  selector:
    matchLabels:
      app: web
```
check: metadata.name = api | name api
check: spec.maxUnavailable = 1 | at most one unavailable
check: spec.minAvailable missing | do not set both
check: spec.selector.matchLabels.app = api | selects app=api
check: spec.unhealthyPodEvictionPolicy = AlwaysAllow | AlwaysAllow
solution:
```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      app: api
  unhealthyPodEvictionPolicy: AlwaysAllow
```
hint: Use maxUnavailable instead of minAvailable. Fix the selector label. Add the eviction policy field. The API rejects a budget that sets both min and max.
:::

::: write lang=python
task: Implement `can_evict(ready, replicas, max_unavailable)` for a healthy set. Eviction is allowed when the number of pods you would be missing, counting this eviction, is within max_unavailable. Assume all `ready` pods are the replicas (`ready` equals `replicas` when nothing else is down). Return True or False.
starter:
```python
def can_evict(ready, replicas, max_unavailable):
    return True
```
tests:
```python
from solution import can_evict

def test_one_spare():
    assert can_evict(3, 3, 1) is True

def test_none_spare():
    assert can_evict(3, 3, 0) is False

def test_already_down():
    assert can_evict(2, 3, 1) is False
```
solution:
```python
def can_evict(ready, replicas, max_unavailable):
    missing_after = replicas - (ready - 1)
    return missing_after <= max_unavailable
```
hint: After the eviction you have ready-1 pods up. The gap versus replicas must still be <= max_unavailable. If you are already down by max_unavailable, another eviction is too many.
:::

## Ingress
id: ingress
stage: ops
needs: services
minutes: 35
goal: Route external HTTP to Services with an Ingress, and say what the Ingress controller is doing that the Ingress object is not.
source: Kubernetes: Ingress | https://kubernetes.io/docs/concepts/services-networking/ingress/
source: Kubernetes: Ingress controllers | https://kubernetes.io/docs/concepts/services-networking/ingress-controllers/

A Service ClusterIP is inside the cluster. Users on the internet are not. An Ingress is a rule: this host and path go to that Service. An Ingress does nothing by itself. A controller (nginx, the AWS Load Balancer Controller, Traefik, or a Gateway API implementation) watches Ingress objects and programs a real proxy or cloud load balancer. For new work, the Gateway API is the successor. Ingress is still what most clusters run, and you will read it for years. Know it, and know when you are writing a new route that should be an HTTPRoute instead.

### The problem

You could set every Service to LoadBalancer. Each one costs a cloud load balancer and a public address, and none of them can share port 443 with a path-based rule. You want one entrance, many Services, TLS in one place. That entrance is the controller. The Ingress object is the configuration you are allowed to write without editing the proxy by hand.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: shop
spec:
  ingressClassName: alb
  rules:
    - host: shop.example.com
      http:
        paths:
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: api
                port:
                  number: 80
          - path: /
            pathType: Prefix
            backend:
              service:
                name: web
                port:
                  number: 80
```

`ingressClassName` picks the controller. Two controllers in one cluster are normal (internal and external). An Ingress with no class that the controller claims is a rule that never becomes a load balancer. `kubectl get ingress` shows an address only after the controller has created one.

`pathType: Prefix` matches `/api` and `/api/v1`. `Exact` matches one path. `ImplementationSpecific` is "ask the controller", which is how you get a surprise. Prefer Prefix or Exact. Longer prefixes win when they are more specific; do not depend on document order for overlapping prefixes without reading the controller's docs. The safe layout is non-overlapping paths.

The backend is a Service and a port number, not a pod and not a targetPort. The Service still does endpoint selection. Ingress does not replace readiness.

### TLS

```yaml
spec:
  tls:
    - hosts: [shop.example.com]
      secretName: shop-tls
```

The Secret is a `kubernetes.io/tls` Secret with `tls.crt` and `tls.key`. cert-manager is the usual controller that fills it from Let's Encrypt or a private CA. Without it, you create the Secret yourself and rotate it yourself. The Ingress controller presents that certificate. Your app can speak plain HTTP behind the proxy. Do not also redirect inside the app in a way that fights the proxy's `X-Forwarded-Proto`, or you will loop.

### Annotations are the unofficial API

The AWS load balancer controller reads annotations for scheme, certificate ARN, health checks, and target type. nginx reads different annotations for timeouts and body size. Those keys are not in the Ingress spec. They are not portable. Copying an nginx annotation onto an `alb` class does nothing, or worse, is ignored while you think you set a timeout. This is the main reason the Gateway API exists: the portable fields are in the spec, and implementation-specific policy is attached as a typed object instead of a stringly-typed annotation.

### Where it breaks

**No controller installed.** The object is accepted. Nothing listens. kind does not ship one unless you install it.

**Host matches but the DNS does not point at the load balancer.** The Ingress can be perfect and the browser never arrives. Check DNS and the Ingress status address. That is the cloud module's Route 53 step, not a path bug.

**The Service port is wrong.** The controller health-checks the Service port. If the Service targets 8000 and the Ingress names port 80, you follow the Service. If you name a port the Service does not have, the backend is empty.

**Sending the pod IP to the internet.** Do not. Ingress, or a LoadBalancer Service, is the edge. Pod IPs are not stable and are not public.

### At work

Existing clusters have a pile of Ingresses. You will add paths to them. New platforms standardize on Gateway and HTTPRoute so app teams can own routes without annotating the load balancer. When you read an Ingress, find the class, the controller version, and the annotation dictionary that actually applies. The object is half the config.

### You can now

- Explain why an Ingress without a controller does not route traffic.
- Write a host and path to a Service port with an explicit pathType.
- Say where TLS certificates live (a Secret) and who fills them.
- Treat annotations as controller-specific, not as the Kubernetes spec.
- Point new designs at the Gateway API lesson without pretending Ingress is gone.

### What an Ingress is, and what it is not

An Ingress is a desired route from a hostname and a path to a Service. It is not a load balancer. Nothing listens until a controller that matches `ingressClassName` programs one. On EKS that controller is often the AWS Load Balancer Controller, and the class is `alb`. On a kind cluster it is often ingress-nginx. The same YAML applied to the wrong class is a quiet success: the object exists, `ADDRESS` stays empty, and the DNS name never answers. The first debugging step is the class and the controller's logs, not another path rule.

Path types are exact, prefix, and implementation-specific. `Prefix` `/api` also matches `/api/v2`. It does not match `/apiv2`. `Exact` `/` is only the root. A catch-all `Prefix` `/` must be the rule you intend to win last, and implementations differ on which rule wins when two prefixes match. Do not stack overlapping prefixes and hope. Give each host an explicit default if you need one, and test `/api` and `/api/` because some controllers treat the trailing slash as a different path.

The backend is a Service, not a pod and not a Deployment. The Service's port is the Service port, not the container port, unless they happen to be the same number. A route to port 80 on a Service that only exposes 8000 is a black hole with a 503 from the proxy. The Service selector still has to match pod labels. Ingress does not fix a wrong selector. It only forwards to endpoints the Service already has.

### TLS and the secret

TLS on an Ingress names a Secret in the same namespace, containing `tls.crt` and `tls.key`. The Secret is not created by the Ingress. cert-manager or your pipeline creates it. A missing Secret leaves the listener on HTTP or makes the controller skip the host. The AWS controller often wants a certificate ARN annotation instead of a Secret, because the certificate lives in ACM. That annotation is not portable. It is part of the class you chose. Read the controller's documentation for that class. Copying an nginx annotation onto class `alb` does not set a timeout.

### Where it breaks

Two controllers, one class name. Both reconcile, both try to own the hostname, users see flaps. One class string per controller, and a cluster default only if you mean it.

A path that points at a Service in another namespace. Classic Ingress does not do that. The route and the Service are together. Cross-namespace is a Gateway API feature with a ReferenceGrant, not an Ingress trick.

Health checks. The load balancer's target health is the controller's probe, which may not be your readiness probe. An ALB can mark targets unhealthy while kubectl says Ready, if the health-check path or port annotation disagrees with the pod. When traffic fails and the pod looks fine, open the load balancer's target group, not only `kubectl get pods`.

### At work

Existing clusters are full of Ingress objects. You will edit them. The review is: class, host, path type, Service name, Service port, TLS secret or the annotation this class actually honors. New platforms that already run a Gateway should take an HTTPRoute for new hosts. That split is the next lesson. This one is the object you will still debug.

### Decision

| Situation | Use |
|---|---|
| This cluster already routes with Ingress and a known class | an Ingress, with that class |
| You need the platform to own the listener and the app to own the path | Gateway and HTTPRoute, not a bigger Ingress |
| You need TCP, not HTTP | a Service of type LoadBalancer or a TCP route, not an HTTP path |
| The ADDRESS field is empty | the controller, not another rule |

### You can now

- Bind an Ingress to a class and expect nothing without that controller.
- Point paths at a Service port, with Prefix and Exact meaning what you think.
- Keep TLS material in a Secret or in the annotation the class documents.
- Leave Gateway ownership, weights, and ReferenceGrant to the Gateway lesson.

::: config lang=yaml
task: Write an Ingress named `blog` (class `alb`) for host `blog.example.com`: path `/api` (Prefix) goes to Service `blog-api` port 80, and everything else (`/`, Prefix) goes to Service `blog-web` port 80. Add TLS for the host with the secret `blog-tls`.
starter:
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: blog
spec:
  rules: []
```
check: kind = Ingress | kind is Ingress
check: spec.ingressClassName = alb | ingressClassName is alb
check: spec.rules[0].host = blog.example.com | The rule is for blog.example.com
check: spec.rules[0].http.paths[path=/api].pathType = Prefix | /api is a Prefix path
check: spec.rules[0].http.paths[path=/api].backend.service.name = blog-api | /api goes to blog-api
check: spec.rules[0].http.paths[path=/api].backend.service.port.number = 80 | …port 80
check: spec.rules[0].http.paths[path=/].backend.service.name = blog-web | / goes to blog-web
check: spec.rules[0].http.paths[path=/].backend.service.port.number = 80 | …port 80
check: spec.tls[0].hosts has blog.example.com | TLS covers blog.example.com
check: spec.tls[0].secretName = blog-tls | …with the secret blog-tls
solution:
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: blog
spec:
  ingressClassName: alb
  tls:
    - hosts:
        - blog.example.com
      secretName: blog-tls
  rules:
    - host: blog.example.com
      http:
        paths:
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: blog-api
                port:
                  number: 80
          - path: /
            pathType: Prefix
            backend:
              service:
                name: blog-web
                port:
                  number: 80
```
hint: Follow the lesson's example shape: `rules` → `- host` → `http.paths` → two items, each with `path`, `pathType` and `backend.service.name/port.number`.
:::

::: quiz
q: You apply an Ingress and `kubectl get ingress` shows no address. The rules look right. What is the first thing to check?
- Whether the pods are on the control plane
+ Whether an Ingress controller for that ingressClassName is running and has claimed the object
- Whether you set replicas on the Ingress
- Whether the Service is headless
why: The Ingress object is only data. A controller creates the proxy or cloud load balancer and writes the address back. No controller, or the wrong class, means no address. Replicas are not a field on Ingress. Headless Services are a separate choice and still would not create an address by themselves.
:::

::: card
q: What does an Ingress backend point at, and what still chooses the pod?
answer: The backend names a Service and a Service port. The Service's selector and the EndpointSlice still choose a Ready pod. Ingress does not bind to pod IPs. If the EndpointSlice is empty, the proxy has nowhere to send the request even when the host rule matches.
:::

::: quiz
q: Two controllers run in the cluster, class `nginx` and class `alb`. Your Ingress sets no ingressClassName. What should you expect?
- Both controllers configure themselves from it
+ It may match neither, or only a controller that was told to claim classless Ingresses. Set the class so the rule is not ambiguous
- Kubernetes rejects an Ingress with no class
- The default is always alb on EKS
why: Classes exist so two implementations can share a cluster. A missing class is not "all of them", and EKS does not invent an ALB for every Ingress. Set ingressClassName to the controller you mean.
:::

::: predict lang=python
q: Prefix matching. More specific prefixes should win. What does this print for each request path?
code:
```python
rules = [("/api", "api"), ("/", "web"), ("/api/v1", "v1")]

def route(path):
    hits = [(p, b) for p, b in rules if path == p or path.startswith(p.rstrip("/") + "/") or path == p]
    hits.sort(key=lambda item: len(item[0]), reverse=True)
    return hits[0][1]

print(route("/api/v1/orders"))
print(route("/api"))
print(route("/blog"))
```
answer:
```text
v1
api
web
```
why: `/api/v1/orders` matches three prefixes; the longest wins, so the v1 service gets it. `/api` matches `/api` and `/` ; the longer one wins. `/blog` matches only `/`. Relying on YAML order instead of specificity is how a catch-all steals traffic under some controllers. Prefer non-overlapping paths when you can.
:::

::: config lang=yaml
task: Write an Ingress named `shop`, class `nginx`, host `shop.example.com`. Prefix `/api` goes to Service `api` port 80. Prefix `/` goes to Service `web` port 80. Add a tls section for that host using Secret `shop-tls`.
starter:
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: shop
spec:
  rules:
    - host: example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: web
                port:
                  number: 80
```
check: metadata.name = shop | name shop
check: spec.ingressClassName = nginx | class nginx
check: spec.rules[0].host = shop.example.com | host
check: spec.rules[0].http.paths[path=/api].pathType = Prefix | api path type
check: spec.rules[0].http.paths[path=/api].backend.service.name = api | api service
check: spec.rules[0].http.paths[path=/api].backend.service.port.number = 80 | api port
check: spec.rules[0].http.paths[path=/].backend.service.name = web | web service
check: spec.tls[0].secretName = shop-tls | tls secret
check: spec.tls[0].hosts[0] = shop.example.com | tls host
solution:
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: shop
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - shop.example.com
      secretName: shop-tls
  rules:
    - host: shop.example.com
      http:
        paths:
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: api
                port:
                  number: 80
          - path: /
            pathType: Prefix
            backend:
              service:
                name: web
                port:
                  number: 80
```
hint: ingressClassName sits on the spec. Each path needs pathType and a service port number. tls is a list of host plus secretName, parallel to rules, not inside the service.
:::

## Debugging a cluster
id: debugging
stage: ops
needs: probes, ingress
minutes: 40
goal: Move from a symptom to the object that is wrong, using events, logs, and probes instead of restarting at random.
source: Kubernetes: Debug pods | https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/
source: Kubernetes: Debug services | https://kubernetes.io/docs/tasks/debug/debug-application/debug-service/
source: Kubernetes: Determine the reason for pod failure | https://kubernetes.io/docs/tasks/debug/debug-application/determine-reason-pod-failure/

Debugging a cluster is not a different skill from the rest of this module. It is reading which controller did not get what it wanted. The traps are restarting before you look, and looking at logs before you look at events. Events are where the scheduler, the kubelet, and admission say why they refused.

### A path that works

1. What did the user see? Timeouts, 500s, or "my deploy finished and nothing changed"?
2. Which object was supposed to change? Deployment, Service, Ingress, HTTPRoute, Job.
3. `kubectl get pods -n shop -o wide` and read STATUS and the node.
4. If the pod is not Running and Ready, `kubectl describe pod` and read Events at the bottom, newest last.
5. If it is Running and the user still fails, look at endpoints, probes, and logs, in that order.

`describe` beats `logs` for Pending, ImagePullBackOff, CreateContainerConfigError, and CrashLoopBackOff that dies before your logger starts. `logs` beats `describe` once the process is up and printing errors. `logs --previous` is the container that just died. Without it you are reading the new process, which has not failed yet.

### Statuses you should recognise

**Pending.** Not scheduled, or scheduled but not started. Events: Insufficient cpu or memory (requests, not free RAM), untolerated taint, affinity, unbound PVC, or a volume in the wrong zone.

**ImagePullBackOff.** The node cannot fetch the image. Wrong name, missing `kind load`, no pull secret, or a tag that was never pushed. The pod already has a node. Deleting it just reschedules the same pull.

**CreateContainerConfigError.** A Secret or ConfigMap named in the spec is missing in that namespace.

**CrashLoopBackOff.** The process exits. Read logs --previous. Exit 137 with OOMKilled is memory. Exit 137 without that reason can be SIGKILL from elsewhere. Exit 1 is your program.

**Running but not Ready.** Readiness is failing. The Service will not send traffic. Look at the probe path and at the app log. Do not "fix" it by deleting the readiness probe.

**Running and Ready, callers fail.** EndpointSlice empty means the selector or the namespace. Endpoints present and connections refused means targetPort. Endpoints present and HTTP 500 means the app. An Ingress with no address means no controller or no DNS.

### Commands that match the question

`kubectl get events -n shop --sort-by=.lastTimestamp` when the pod is already gone. `kubectl describe deploy` shows replica failures the pod list hides if you are in the wrong namespace. `kubectl rollout status` and `kubectl rollout history` tell you whether the new ReplicaSet is the one you think.

`kubectl port-forward pod/x 8000:8000` talks to the pod, skipping the Service. If that works and the Service does not, the bug is the Service or the probe. If that fails, the bug is the process. `kubectl exec` is for a shell inside a running container. Distroless images have no shell; an ephemeral debug container (`kubectl debug`) adds one without rebuilding the image. On a cluster that forbids it by policy, you will not get it. Do not install a shell in production images "for debugging". That is the security lesson.

`kubectl auth can-i` is the RBAC debugger. A Forbidden in an event is not a crash. Check the ServiceAccount the pod actually uses, not yours.

### A worked incident

Deploy finishes. Pods are ImagePullBackOff. The image in the spec is `ghcr.io/acme/api:1.4.3`. CI pushed `1.4.3-rc1`. The fix is to apply the tag that exists, not to raise replicas. A second incident the same day: pods Running, Service has no endpoints, selector is `app: web`, template label is `app: api`. The Deployment selector matched its own template (or it would not have applied), but the Service was written by someone else. Diff labels. A third: CrashLoopBackOff, previous log says "dial db: connection refused", liveness hits `/health` which dials the db, and every restart makes it worse. Point liveness at the process, readiness at the dependency.

### Where people make it worse

**Deleting the namespace.** You lose the events and the pods you needed to describe.

**kubectl apply from a laptop against the wrong context.** You "fix" production with the dev file. `kubectl config current-context` first.

**Guessing OOM from any restart.** Read the reason field.

**Editing the live Deployment during a GitOps outage.** The controller will revert you. Change Git, or pause the controller on purpose.

### At work

On-call runbooks are this path written down for one service: dashboard, then namespace, then the three commands, then who owns the dependency. The Linux module's signals and the probes lesson are the vocabulary. You are not learning kubectl flags for their own sake. You are learning which object owns the failure.

### You can now

- Choose describe versus logs versus endpoints for a given status.
- Read Insufficient cpu as a request problem.
- Use port-forward to split "process is down" from "Service is wrong".
- Find the previous container's logs after a crash loop.
- Stop before you delete the only evidence.

### A method, not a pile of commands

Start from the symptom a user would report, then walk one hop inward. "The site 502s" is not a reason to `kubectl delete pod` until something changes. The hops are: DNS name, Ingress or Gateway status and the load balancer's targets, the Service's endpoints, the pod's Ready condition, the last events, the current logs, the previous logs if it restarted. Each hop answers a different question. Skipping to logs when endpoints are empty wastes the hour, because the process may be fine and unselected.

`kubectl get endpoints` or `endpointslice` for the Service is the question "would a packet have a destination?" An empty set means the selector matches nothing that is Ready. Ready includes readiness probes. A pod in Running with a failing readiness probe is absent on purpose. Describe the pod before you edit the Service.

Events expire. A FailedScheduling from an hour ago may be gone. If the pod is still Pending, describe it now. If it is Running and the user-facing error started later, events about scheduling are the wrong chapter. `FailedMount` is a volume problem: the PVC, the zone, the secret that was supposed to exist. `Failed` with a container reason is the process. `ImagePullBackOff` is the registry credential or the tag, not the probe.

Logs: `kubectl logs` is the current process. `--previous` is the one that died. A crash loop's useful stack is almost always previous. A multi-container pod needs `-c`. A sidecar's logs are not the app's logs.

### Where the commands lie

`kubectl exec` into a production pod is not a debugging strategy. It is a shell on a machine that is serving traffic, and it teaches you nothing you can paste into a ticket if the pod is then rescheduled. Use it to confirm a filesystem or a DNS answer you already suspect, then get out. `kubectl port-forward` proves the process answers. It does not prove the Service, the NetworkPolicy, or the Ingress. A success through port-forward plus a failure through the Service is the network policy or the selector, not the image.

`kubectl describe node` when pods are Pending tells you pressure and taints. It does not tell you why a Ready pod returns 500. CPU throttle and memory working set are metrics, not describe. The observability stack is where "slow" goes. Describe is where "not scheduled, not pulled, not mounted, not ready" goes.

Restarting the pod clears evidence. Copy logs and the describe output first. A delete that "fixes" a problem that comes back in ten minutes was a leak or a connection the process does not rebuild cleanly. The fix is still in the spec or the dependency.

### At work

The runbook's first link is a dashboard for the Service's 5xx and latency, then a saved query for the request id, then the commands above for when the pod never became Ready. People who start from commands miss the outage that is a bad deploy of a Ready pod. People who start from dashboards miss the pod that never joined the endpoints. You need both, in that order, once traffic was flowing, and the reverse order when the object is still Pending.

### Decision

| What you see | Look at |
|---|---|
| Pending | events: taint, affinity, CPU, memory, PVC zone |
| ImagePullBackOff | image name, pull secret, registry |
| Running, not Ready | readiness probe and logs |
| Ready, Service has no endpoints | selector labels |
| Endpoints exist, browser fails | Ingress or Gateway status, then NetworkPolicy |
| CrashLoopBackOff | logs --previous, then OOMKilled versus probe |

### You can now

- Walk from the hostname inward until the hop that is empty.
- Use previous logs and events for the failure that already happened.
- Prove the process with port-forward without pretending that tested the Service.
- Leave a restart until you have copied the evidence.

::: quiz
q: A new pod stays `Pending`. `describe` says `0/3 nodes are available: 3 Insufficient memory`. The nodes have plenty of free memory in their metrics. Why?
+ Scheduling uses **requests**, not actual usage; the pod requests more memory than any node has unreserved
- The image is too large
- The pod has no limits
- A readiness probe is failing
why: The scheduler reserves capacity by requests. Lower an oversized request, or add capacity.
:::

::: quiz
q: Pods are in `CrashLoopBackOff`. Which command most likely shows the cause?
- `kubectl get nodes`
- `kubectl describe service api`
+ `kubectl logs <pod> --previous`
- `kubectl rollout status`
why: The crashed container's output (a stack trace, "DATABASE_URL not set") is in the previous run's logs.
:::

::: quiz
q: After a deploy, `kubectl get pods` shows `ImagePullBackOff` with image `ghcr.io/acme/api:1.4.3`. The CI log shows it pushed `1.4.3-rc1`. Fix?
- Restart the nodes
- Increase memory
+ Deploy the tag that actually exists (and pin tags from CI's output, ideally commit SHAs)
- Delete the namespace
why: The kubelet can't pull a tag that isn't in the registry. Tie the deployed tag to the build that produced it.
:::

::: card
q: A pod is Pending and describe says Insufficient cpu. `top` on the node shows idle CPU. What number is the scheduler comparing?
answer: It compares the pod's CPU request with the node's allocatable CPU minus requests already placed. Idle usage is not the input. Lower the request, move other pods, or add a node. The kubelet has not started the container yet, so logs will be empty.
:::

::: quiz
q: CrashLoopBackOff started one minute ago. `kubectl logs pod/api` shows a process that just began booting. Where is the error that caused the restart?
- In the Service events
+ In `kubectl logs pod/api --previous`, which is the container that exited
- It was deleted with the pod
- In the Ingress controller only
why: `logs` without `--previous` follows the current attempt. The failure is the previous container. Events may also show the exit code and OOMKilled. The Service and Ingress do not store the process stderr.
:::

::: predict lang=python
q: Pick the next command from the status. What does this print?
code:
```python
def next_step(status, ready):
    if status == "Pending":
        return "describe-events"
    if status == "CrashLoopBackOff":
        return "logs-previous"
    if status == "Running" and not ready:
        return "readiness"
    return "endpoints-then-app"

print(next_step("Pending", False))
print(next_step("CrashLoopBackOff", False))
print(next_step("Running", True))
```
answer:
```text
describe-events
logs-previous
endpoints-then-app
```
why: Pending has no logs yet; the event says which predicate failed. CrashLoopBackOff hides the error in the previous container. Running and Ready means the process is up, so a user-facing failure is the Service endpoints or the application response, not another restart.
:::

::: quiz
q: port-forward to the pod returns HTTP 200, and the Service has no endpoints. Where is the bug?
- The container image
+ The Service selector or the pod readiness. The process is serving; the Service is not selecting a Ready pod
- The kubelet
- etcd encryption
why: port-forward skips the Service and talks to the pod IP. Success means the process listened. An empty EndpointSlice means labels, namespace, or readiness. Restarting the image will not fix a selector typo.
:::

::: quiz
q: A pod has been Pending for ten minutes. describe shows FailedScheduling and 0/5 nodes are available: 5 Insufficient cpu. The request is cpu 4. The largest node has 2 allocatable CPUs. What is the first change that can make this pod run?
- Delete the pod so the scheduler tries again
+ Lower the CPU request to something a node can reserve, or add a node bigger than the request. Rescheduling with the same request hits the same math
- Add a liveness probe so the scheduler knows the pod is healthy
- Switch the Service to ClusterIP
why: Insufficient cpu means the request does not fit allocatable CPU on any node. The scheduler repeats that answer on every retry. Probes and Services are not consulted for a pod that has no node.
:::

## Kustomize
id: kustomize
stage: ops
needs: deployments, config
minutes: 35
goal: Patch one base into dev and prod without templating a programming language into your YAML.
source: Kustomize | https://kubectl.docs.kubernetes.io/references/kustomize/
source: Kubernetes: Declarative management of Kubernetes objects using Kustomize | https://kubernetes.io/docs/tasks/manage-kubernetes-objects/kustomization/
@@@@
Helm templates YAML with a language. That is powerful and it is how you install someone else's chart. For your own service, the usual mess is a copy of the Deployment per environment that drifts until prod has a probe and dev does not. Kustomize starts from a base and applies patches. `kubectl apply -k` has spoken it for years. There is no extra server. The output is plain YAML, which you can diff.

### The problem

Dev needs one replica and `LOG_LEVEL=debug`. Prod needs three replicas, a PDB, and `LOG_LEVEL=info`. If those are two files maintained by hand, a securityContext you add to dev never reaches prod. If they are a Helm template with `if eq .Values.env "prod"`, reviewers read Go templates instead of the manifest that will apply. Kustomize keeps the base as legal YAML and writes the difference beside it.

```text
base/
  deployment.yaml
  service.yaml
  kustomization.yaml
overlays/dev/
  kustomization.yaml
overlays/prod/
  kustomization.yaml
  replicas.yaml
```

A base `kustomization.yaml` lists resources:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - deployment.yaml
  - service.yaml
```

An overlay points at the base and patches:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
replicas:
  - name: api
    count: 3
patches:
  - path: replicas.yaml
images:
  - name: ghcr.io/acme/api
    newTag: 1.4.2
```

`images` rewrites the tag everywhere that image name appears. That is the right way to pin what CI built. `replicas` rewrites a Deployment's replica count. `namespace` sets the namespace on every object. `namePrefix` avoids collisions when two overlays land in one cluster.

### Patches

A strategic merge patch looks like a cut-down manifest. You name the object and include only the fields you want to change. Lists of containers merge by container name, which is why the container must have the same `name` as the base. A JSON patch is a list of operations (`replace`, `add`) when you need to be precise. Use the smallest one you can read.

`configMapGenerator` builds a ConfigMap from a file and suffixes the name with a hash. The Deployment reference is rewritten to that name. Change the file, the name changes, the pod template changes, a rollout happens. That is the immutable-config pattern from the config lesson, done for you. `secretGenerator` does the same for Secrets. Do not point it at a secret committed in Git. Point it at a file CI injects, or do not use it and let External Secrets create the Secret.

### What Kustomize will not do

It will not loop, and it will not `if`. If you need a list of twenty listeners from a values file, that is a template, and Helm is the honest tool. If you need to install Prometheus, use the upstream Helm chart (or its Kustomize variant if the project publishes one). Fighting Helm by wrapping a chart you do not own is worse than either tool. Kustomize can inflate a Helm chart (`helmCharts`) in some builds; know that your pipeline then needs Helm anyway.

`kubectl apply -k` renders and applies. `kubectl kustomize .` renders only. Diff the render in CI. Do not apply an overlay you have not rendered once and read.

### Where it breaks

**The patch targets the wrong name.** It is silently dropped or the build fails, depending on the version and whether you required the target. Always render.

**Two bases define the same object.** The build errors. Good. Fix the duplication rather than letting last-write-win, which is the behaviour people fear from raw apply order.

**Editing the rendered output.** The next build overwrites your edit. Change the overlay.

**Hash suffixes and a hand-written Service.** The generator updates references inside the kustomization. A file outside it still points at the old name. Keep consumers inside the same kustomization.

### At work

Many teams use Kustomize overlays for app manifests and Helm for third-party components. GitOps tools apply the overlay directory. The review comment you want is a small patch, not a thousand-line template diff. The Helm lesson is the other half: charts, values, and releases. Use Kustomize when the base is YAML you wrote. Use Helm when the base is a chart someone else versions.

### You can now

- Point an overlay at a base and change replicas, namespace, and image tag.
- Explain why a configMapGenerator hash forces a rollout.
- Render before you apply.
- Choose Kustomize or Helm for "our Deployment" versus "install this project".
- Keep secrets out of generated manifests in Git.

### What the build actually is

Kustomize is a transformer that runs before the cluster sees anything. `kubectl apply -k` or a GitOps controller builds one manifest from a kustomization and applies that. The cluster does not store the overlays. It stores the result. If you edit the live Deployment and you also edit the overlay, the next reconcile puts the overlay back. That is the point. The overlay is the source.

A base is a directory with a `kustomization.yaml` and the resources it lists. An overlay is another directory whose kustomization points at the base with `resources:` and then applies patches, name prefixes, namespace, images, and replicas. Dev and prod are two overlays of one base, not two copies of a Deployment that you try to keep in sync by hand. The moment someone "just fixes prod" in the prod file and not the base, the next feature reintroduces the bug in dev or the reverse.

`images` rewrites a container image's tag or digest. It matches the image name without the tag. `newTag: 1.4.2` on `ghcr.io/acme/api` changes whatever tag was in the base. It does not change a different registry path. A digest is better than a tag when the tag can move. Kustomize will set what you ask. It will not notice that the tag still points at yesterday's bytes.

`replicas` is a field on the kustomization, not a strategic merge you have to write by hand, for the Deployment name you give. `namespace` sets the namespace on every namespaced object in the build. A ResourceQuota and a Deployment in the same overlay land in the same namespace, which is what you want, and a ClusterRole does not gain a namespace, because it cannot.

### Patches

A strategic merge patch looks like a cut-down resource. You name the kind and the metadata name, and you include only the fields you want to change. Lists that are associative (containers, by name) merge. Lists that are not may replace. This is where overlays surprise people. A patch that sets `env` can replace the whole env list instead of adding one variable, depending on the patch shape. Add one variable in a patch that includes the container name and the new env entry, and render with `kubectl kustomize` before you apply. Reading the build output is the test. Applying and hoping is how you drop `DATABASE_URL`.

JSON patches and replacements exist for fields strategic merge cannot target cleanly. Use them when you must. Prefer a small merge for a replica count and an image. A patch file that is a full copy of the Deployment is not an overlay. It is a fork.

### Where it breaks

`resources` paths are relative to the kustomization file. A base that worked in CI and fails locally is usually the working directory, not Kubernetes. Helm charts can be inflated via `helmCharts`, and that feature is not in every `kubectl` build the same way. Many teams render Helm separately and let Kustomize patch the output, or they pick one tool. Two layers of templating without a rendered artifact in the pull request is how a one-line values change becomes a surprise.

Secrets in a kustomize secretGenerator from a local file do not belong in Git. The generator is for names and literals you are willing to commit, or for CI that injects the file and does not commit the result. External Secrets is the path for real credentials. A secretGenerator of the database password is a copy of the password in Git history.

### At work

Each environment is an overlay: namespace, replicas, image tag, resource requests, and an Ingress host. The base has the probes, the security context, and the Service. Promotion is a pull request that changes the prod overlay's tag, not a kubectl set image on the cluster. The review includes the `kubectl kustomize overlays/prod` diff. If the diff shows a dropped env var or a changed selector, you stop. Selectors are not an overlay toy. Changing a selector orphans pods.

### Decision

| Change | Where |
|---|---|
| Same in every environment | base |
| Namespace, tag, replicas, host | overlay |
| One field the merge keeps clobbering | JSON patch, after you have read the build |
| A password | not a secretGenerator in Git |
| A third-party chart you do not own | Helm, then maybe a thin overlay |

### You can now

- Build an overlay and read it before apply.
- Change an image tag and a replica count without forking the Deployment.
- Predict when a patch replaces a list.
- Keep environment differences in overlays and safety defaults in the base.

::: quiz
q: You change a file that a configMapGenerator consumes. What happens on the next apply?
- The pods keep the old files until you delete them
+ The ConfigMap name changes because of the content hash, the pod template reference changes, and a rollout starts
- Kustomize edits the live ConfigMap in place and every process sees it instantly
- The build fails because ConfigMaps are immutable
why: The hash in the name is the point. A new name changes the Deployment template, so the rollout is atomic with the new files. In-place edits are the opposite pattern and can leave pods on different versions. Immutability is a field you can set; the generator's trick is a new object, not a failed build.
:::

::: card
q: When should you reach for Kustomize instead of a Helm chart you write yourself?
answer: When your own manifests are already YAML and each environment differs by patches (replicas, image tag, namespace, a few fields). Helm fits third-party charts and anything that needs real templates and loops. Kustomize does not replace a chart repository you do not own.
:::

::: config lang=yaml
task: Write a Kustomization that includes resource `deployment.yaml`, sets namespace `prod`, sets image `ghcr.io/acme/api` to newTag `1.4.2`, and sets Deployment `api` to 3 replicas.
starter:
```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - deployment.yaml
```
check: kind = Kustomization | kind
check: namespace = prod | namespace prod
check: images[0].name = ghcr.io/acme/api | image name
check: images[0].newTag = 1.4.2 | tag
check: replicas[0].name = api | deployment name
check: replicas[0].count = 3 | three replicas
check: resources[0] = deployment.yaml | still includes the base resource
solution:
```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - deployment.yaml
namespace: prod
images:
  - name: ghcr.io/acme/api
    newTag: 1.4.2
replicas:
  - name: api
    count: 3
```
hint: namespace, images, and replicas are fields on the kustomization, not a strategic merge patch. Keep the resources list.
:::

::: quiz
q: A strategic merge patch replaces container env, but the container name in the patch is `API` and the base container is named `api`. What should you expect?
- Kubernetes merges them case-insensitively
+ The patch does not merge onto that container, because container merge keys on the name. Render and you will see the base env unchanged
- The build deletes the container
- Kustomize rewrites the base name to match the patch
why: Strategic merge matches list items by key. For containers the key is name, and it is case-sensitive. A patch that does not match is a silent no-op in the worst case. Always render and look at the container you meant to change.
:::

::: predict lang=python
q: The generator suffixes the content hash. The Deployment is rewritten to the new name. What does this print?
code:
```python
def rollout(old, new):
    if old == new:
        return "no-roll"
    return "roll"

print(rollout("web-config-aaa", "web-config-aaa"))
print(rollout("web-config-aaa", "web-config-bbb"))
```
answer:
```text
no-roll
roll
```
why: Same hash means the template did not change, so a Deployment does not roll. A new hash is a new ConfigMap name inside the template, which is a rollout. That is how a config edit becomes a deliberate pod replacement instead of a drift between pods that re-read files at different times.
:::

## CRDs and operators
id: crds
stage: ops
needs: k8s-why
minutes: 35
goal: Explain a CRD as a new API type and an operator as a controller for it, including what happens when the controller is down.
source: Kubernetes: Custom resources | https://kubernetes.io/docs/concepts/extend-kubernetes/api-extension/custom-resources/
source: Kubernetes: Custom resource definitions | https://kubernetes.io/docs/tasks/extend-kubernetes/custom-resource-definitions/
source: Kubernetes: Operator pattern | https://kubernetes.io/docs/concepts/extend-kubernetes/operator/

Deployments exist because someone wrote a controller that reconciles them. You can add your own types the same way. A CustomResourceDefinition tells the API server to accept a new kind. An operator is a controller that watches that kind and creates ordinary objects (Deployments, Services, PDBs) until the cluster matches the custom spec. The control loop from the first lesson does not change. Only the spec changes.

### The problem

A database is not a Deployment plus a document. It is a primary, replicas, backups, a Service, a PDB, and a failover procedure. If every team copies that YAML, every team gets it slightly wrong. A platform can offer a `Postgres` object: version, size, storage class. The operator turns that into the StatefulSet and the rest, and it keeps turning it when a pod dies. That is the same reconciliation you already trust for replicas, applied to a product.

### The CRD

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: postgreses.db.example.com
spec:
  group: db.example.com
  scope: Namespaced
  names:
    kind: Postgres
    plural: postgreses
    singular: postgres
  versions:
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              properties:
                version:
                  type: string
                storageGi:
                  type: integer
```

`metadata.name` must be `<plural>.<group>`. The schema is OpenAPI. The API server rejects objects that do not match, the same way it rejects a Deployment with a bad selector. Without a schema, any YAML is stored and the operator discovers the typo at 02:00. Write the schema. `storage: true` marks which version is stored in etcd. You can serve several versions while you migrate. Cluster-scoped CRDs are for objects that are not in a namespace (a cluster-wide policy). Most app objects are namespaced.

Applying a CRD does not install the controller. After the CRD exists, `kubectl apply` of a Postgres object succeeds even if nothing is watching. The object sits there. No pods appear. This is the Ingress-without-a-controller failure, and it is the default trap.

### The operator

The controller's loop:

1. Watch Postgres objects.
2. Read spec.
3. Create or update a StatefulSet, a Service, a PDB.
4. Write status (`Ready`, `Pending`, the primary's name).

Status is not spec. Users read status. They do not infer health from "the YAML applied". A good operator sets conditions the way Deployments do (`Available`, `Progressing`). A bad operator only logs to stdout, and you cannot alert.

Use a leader election lock (a Lease) if you run two replicas of the controller. Two writers creating the same StatefulSet will fight. One replica is simpler until you care about the controller being down.

When the controller is down, existing pods keep running. New Postgres objects do nothing. Failover does not happen. The operator is in the path of recovery, so it needs its own replicas, its own PDB, and a release process. It is production software, not a script beside the cluster.

### What not to build

Do not build an operator for "we wanted shorter YAML" if a Helm chart or a Kustomize overlay is enough. An operator is a long-running reconciliation with domain behavior (failover, version upgrades). A template has no loop. If you do not need the loop, do not take the on-call.

Do not grant the operator cluster-admin. It should create the kinds it manages in the namespaces it owns. A compromised operator is a compromised cluster if its ServiceAccount can do everything. The RBAC lesson is the constraint. Write the Role before you write the reconcile function.

CRDs that are installed by a chart you do not understand are still your API surface. Gateway API, cert-manager, and External Secrets are CRDs plus controllers. When they break, you debug them like any other controller: is the CRD installed, is the controller Running, what does the object's status say?

### Where it breaks

**The CRD version changed and stored objects do not match.** Upgrades need a conversion strategy or a migration. Read the project's upgrade notes. Applying a new CRD that cannot decode old objects is an outage for that API.

**Finalizers.** An object with a finalizer does not disappear until the controller removes the finalizer. If the controller is gone, `kubectl delete` hangs. You can remove the finalizer by hand and leak the cloud disk the finalizer was supposed to delete. Know which leak you are choosing.

**Webhooks.** Validating and mutating admission webhooks can reject pods cluster-wide when the webhook pod is down, unless `failurePolicy: Ignore` (which then skips the check). A webhook you do not operate is a dependency of every apply. Prefer schema validation in the CRD when it is enough.

### At work

You will consume operators more often than you write them. The skill is to see a custom kind, find its CRD and its controller deployment, and read status and events. Writing one is justified when the team has a procedure they already run by hand every time a pod dies. The first lesson's sentence still holds: if you cannot name the controller, you do not understand the object.

### You can now

- Say what a CRD changes about the API server, and what it does not run.
- Describe an operator as a reconcile loop that writes ordinary objects and status.
- Predict that a custom resource with no controller sits idle.
- Keep operator RBAC narrower than cluster-admin.
- Debug a stuck delete as a finalizer whose controller is gone.

### A type the apiserver did not ship with

A CustomResourceDefinition adds a type: group, version, kind, and a schema. After it exists, you can `kubectl get` that kind. The objects are stored in etcd like any other. Nothing acts on them until a controller watches them. The CRD is the language. The controller is the sentence. Installing a CRD without its controller is how you get objects that sit at `Ready=False` forever and look like Kubernetes is broken.

The schema in the CRD is OpenAPI. It validates on write. A field you thought was a string and sent as a number is rejected by the apiserver, not by your controller. That is useful. A schema that is too loose (`x-kubernetes-preserve-unknown-fields` everywhere) stores typos until the controller misbehaves. Prefer a real schema. Structural schemas are required for CRDs with more than one version in any cluster you should be running.

Versions: `v1alpha1` to `v1beta1` to `v1` is a contract with your users. You can serve more than one version and store one. Conversion is a webhook or, for simple renames, declared in the CRD. Deleting a version that is still stored is an outage. The migration is: serve both, convert, stop writing the old one, then remove it in a later release.

### What a controller owes you

A controller reads the spec, changes the world, and writes status. It does not edit spec. People do. Controllers that write spec fight with GitOps and with users. Status should say what happened: conditions with types such as Ready and names that stay stable, plus a reason and a message a human can read. A log line is not status. The object has to explain itself in `kubectl describe`.

The work has to be idempotent and level-based, not edge-triggered. "On create, make a bucket" misses the case where the bucket was deleted by hand. "Every reconcile, if the bucket is missing, create it" converges. You already know this from the Deployment controller. A custom controller that only handles the create event is a script with extra steps.

Leader election matters when you run two replicas of the controller. Without it, both reconcile and you get duplicate cloud resources or noisy conflicts. One active reconciler, the others waiting, is the normal shape. The controller's own ServiceAccount is RBAC-scoped to its CRD and to the objects it must change, not cluster-admin.

### Where it breaks

A CRD is cluster-scoped even when the custom resources are namespaced. Installing one is a cluster privilege. A tenant who can install CRDs can define types that confuse policy and can point a conversion webhook at a service they control. Platform installs CRDs. Tenants create instances.

Webhooks that fail closed. A validating webhook that is down can block all writes of that kind, including deletes, if `failurePolicy` is Fail. That is correct for security webhooks and dangerous for a flaky one. Know the policy before you ship it. A webhook that calls a cloud API on the admission path adds that latency to every kubectl apply.

Finalizers that never clear. The object sticks in terminating and the namespace sticks with it. A controller must remove its finalizer when the external resource is gone, and a human needs a documented way to clear a finalizer when the controller is dead. Clearing it while the cloud resource remains leaks the cloud resource. Leaving it forever leaks the namespace.

### At work

Operators you actually want are the ones that encode a runbook you were going to write anyway: the database claim, the certificate, the external secret. You do not write an operator for a Deployment. The platform reviews CRDs for schema, names, and RBAC, and the on-call runbook includes "how to tell spec from status" and "how to clear a stuck finalizer." Upgrades are a version migration, tested against a cluster that already has old objects, not an empty kind cluster.

### Decision

| You have | Do |
|---|---|
| A new noun with its own lifecycle | CRD plus a controller |
| A Deployment with extra steps | a chart or a Kustomize base, not a CRD |
| Two copies of the controller | leader election |
| A delete that must also delete a cloud object | a finalizer, and a way to recover |
| Tenant-owned types | no; platform installs the CRD |

### You can now

- Separate the CRD from the controller that gives it meaning.
- Keep spec user-owned and status controller-owned.
- Reconcile toward a desired state instead of handling a single create event.
- Treat finalizers and fail-closed webhooks as operational hazards you designed.

::: quiz
q: You apply a CRD and then a custom resource. No pods appear. The custom resource exists. What is missing?
- The schema, because without it the API server drops the object
+ A controller that watches that kind. The CRD only makes the object storable
- A Service, because every custom resource needs one
- etcd encryption
why: The API server stores objects that match the CRD. It does not invent a Deployment. An operator process has to be running and watching. If the object exists, the schema already accepted it. A Service is something the operator might create, not a prerequisite for storage.
:::

::: card
q: What should an operator write back onto the custom resource besides creating Deployments or StatefulSets?
answer: Status, usually conditions such as Ready or Progressing, so users and alerts can see whether reconciliation succeeded. Spec is the user's desired state. Logs inside the controller are not a substitute; they disappear and they are not queryable as part of the object.
:::

::: quiz
q: `kubectl delete` on a custom resource hangs. The object shows a finalizer and the operator deployment has 0 ready pods. What is going on?
- Kubernetes never deletes custom resources
+ The finalizer waits for the controller to clean up external resources. With the controller down, deletion does not finish
- The CRD schema forbids deletion
- A PDB on the custom resource blocks delete
why: Finalizers are how controllers get a chance to delete a cloud disk or a DNS record before the object is gone. They are not a PDB, and the schema does not block delete. Removing the finalizer by hand unblocks the API object and can leak the thing the controller was going to delete.
:::

::: predict lang=python
q: The operator is down. Existing pods stay. New specs are stored and not acted on. What does this print?
code:
```python
def effect(controller_up, existed):
    if existed:
        return "keeps-running"
    if controller_up:
        return "creates-pods"
    return "stored-only"

print(effect(False, True))
print(effect(False, False))
print(effect(True, False))
```
answer:
```text
keeps-running
stored-only
creates-pods
```
why: A down controller does not delete pods that are already running; those have their own kubelets. It also does not create pods for a new custom resource, which sits in etcd. When the controller is up, a new spec is reconciled into pods. This is why the operator itself must be highly available if failover lives in its code.
:::

::: predict lang=python
q: A controller stores the image it last achieved and reads the image from spec. What does this print when the object is new, when spec moved, and when they match?
code:
```python
def act(spec, live):
    if live is None:
        return "create"
    if spec != live:
        return "update"
    return "steady"

print(act("api:2", None))
print(act("api:2", "api:1"))
print(act("api:2", "api:2"))
```
answer:
```text
create
update
steady
```
why: Level-based reconcile compares desired spec to the last achieved state. A missing object is create. A difference is update. Equality is steady. It does not special-case the string latest, and it does not update when nothing changed.
:::

## Security basics
id: security-k8s
stage: ops
needs: debugging, cloud/iam
minutes: 40
goal: Treat a pod as a principal that can be tricked, and list the controls that follow from least privilege.
source: Kubernetes: Pod Security Standards | https://kubernetes.io/docs/concepts/security/pod-security-standards/
source: Kubernetes: RBAC good practices | https://kubernetes.io/docs/concepts/security/rbac-good-practices/
source: Kubernetes: Service accounts | https://kubernetes.io/docs/concepts/security/service-accounts/

An API pod is a program that reads user input. A bug, a prompt injection, or a remote code execution bug means the caller can do whatever the pod can do. Least privilege is not a slogan. It is the list of things you did not grant, because those are the things a compromised pod cannot do. The rest of the security lessons each close one hole: API calls (RBAC), packets (NetworkPolicy), resource exhaustion (quota), host breakout (Pod Security), and long-lived cloud keys (external secrets and Pod Identity). This lesson is the map.

### The problem

The default is generous. A namespace with no NetworkPolicy allows every pod to dial every other pod and the internet. The default ServiceAccount is mounted into every pod unless you turn that off, and if someone bound that account to a powerful Role, every pod inherited it. Containers run as root unless the image and the spec say otherwise. A memory limit is absent unless you set it, so one leak can press the node. None of this requires a villain in your company. It requires one vulnerable dependency.

What a compromised pod in a default namespace can often do:

- Read the projected ServiceAccount token at `/var/run/secrets/kubernetes.io/serviceaccount/token` and call the API as that account.
- Open TCP connections to other Services, including ones in other namespaces, by DNS name.
- Use cloud instance credentials from the node if the pod can reach the metadata address and the node role is broad. That is an IMDS hop, and it is why node roles must be narrow and why pods should use their own identity.
- Write to the container filesystem, and if it is privileged or mounts the docker socket, escape to the node.

If your threat model says "the app is trusted", you are saying a bug in the app is out of scope. For anything that parses user input, that is a bad scope.

### The controls, one each

**Identity.** Give the workload its own ServiceAccount. Do not use `default`. Bind a Role that names the verbs and the resources. `kubectl auth can-i --as=system:serviceaccount:shop:api get secrets -n shop` is the test. The RBAC lesson writes that Role.

**Admission.** Pod Security admission (stable, the replacement for the removed PodSecurityPolicy) can enforce the restricted standard on a namespace: non-root, no privilege escalation, drop capabilities, seccomp. The standard does **not** require a read-only root filesystem. That is an extra you should still set. The PSS lesson is the label and the fields that pass it.

**Network.** Default deny ingress and egress, then allow DNS and the specific peers. A NetworkPolicy is a packet filter, not a Service feature. The network lesson writes one.

**Quota.** ResourceQuota caps the namespace. LimitRange forces default requests and limits so a pod cannot arrive as BestEffort and so quota math works. The quota lesson writes both.

**Secrets.** A Secret in the namespace is readable by anyone who can get secrets. Prefer a controller that projects a short-lived value, or skip the static cloud key and use EKS Pod Identity. The external secrets lesson is that move.

**Supply chain.** Pin images by digest when you can, scan them, and do not run `latest`. The containers module's image security lesson is the same rule before the pod starts. Kubernetes will run whatever digest the kubelet pulled.

### What least privilege is not

It is not "one cluster per app" by default. Isolation can be a namespace plus the controls above. A second cluster is for a harder boundary (different admin domain, different compliance, blast radius you will not accept). It is also not a service mesh by default. A mesh gives you mTLS identity between pods, which is valuable, and it is another controller to operate. NetworkPolicy plus a real identity is the baseline. Add a mesh when you need the identity on the wire, not because a diagram had one.

It is not disabling securityContext because the pod would not start. Fix the image's UID. The restricted standard is documenting a bug in the image.

### At work

A platform namespace template includes: a default-deny policy, a LimitRange, a quota, a restricted Pod Security label, and no cluster-admin for the team. Application teams get a ServiceAccount name and a Role they can widen in review. The review question is "what new edge does this grant?" A new verb, a new egress host, a hostPath mount. The project at the end of the module builds that namespace as objects you can check.

The Linux capability model and the container runtime are underneath. Dropping `CAP_NET_ADMIN` in Kubernetes is the same capability set you saw in the containers module. The cluster does not invent a new kind of root. It orchestrates the old one.

### You can now

- List what a default-namespace pod can reach if the app is compromised.
- Assign each risk to RBAC, NetworkPolicy, quota, Pod Security, or secret handling.
- Say why the default ServiceAccount should not be the app's identity.
- Say that read-only root is good and is not the same field as the restricted standard.
- Refuse cluster-admin as the fix for a Forbidden error.

### The pod is a Linux box you did not mean to administer

A container is a process with a view of its own. The defaults in Kubernetes are closer to "a process that can still do a lot" than to "a locked-down appliance." The root user inside the container is root in the user namespace unless you opted into a user namespace. A capability you did not drop is still there. A service account token is mounted unless you turned automount off. Security context is how you close those, per pod or per container.

`runAsNonRoot: true` rejects a container that would run as uid 0. `runAsUser` sets the uid. `allowPrivilegeEscalation: false` blocks gaining more privileges, and it is required by the restricted Pod Security profile. `readOnlyRootFilesystem: true` makes the container's root read-only, so a writable emptyDir or a specific mount is how the process writes temp files. `capabilities.drop: ["ALL"]` starts from nothing. Add back only what you measured. `seccompProfile.type: RuntimeDefault` applies the container runtime's default syscall filter. None of these stop a vulnerable application from being vulnerable. They shrink what the vulnerability can do, and they are the fields admission will demand.

### Identity is not the security context

The security context is the Linux box. The ServiceAccount is the Kubernetes identity, and on EKS it can become an IAM role. A non-root container with a ServiceAccount that can get all secrets is still a wide blast radius. A root container with a ServiceAccount that can do nothing in the API is a different hole: host escape and local privilege, not cloud API. Close both. The guard lessons split them into RBAC, NetworkPolicy, quotas, and Pod Security. This lesson is the container fields and the habit of not mounting a token you do not use.

`automountServiceAccountToken: false` on a pod that never calls the API removes a credential from the filesystem. Pods that call the API should use a projected token with a short expiry and an audience, not the legacy token. Do not copy a cluster-admin kubeconfig into an image to "make kubectl work."

### Where it breaks

A read-only root filesystem plus an application that writes to `/tmp` without a volume will crash. Add an emptyDir on `/tmp`. That is a one-line fix. Switching the flag off is how the next person writes a webshell to disk.

`privileged: true` and `hostPath` of `/` are the opposite of this lesson. They show up in debug snippets and in DaemonSets that did not need them. A debug snippet in the app Deployment is how production stays privileged after the debugging session ended.

Windows and some service meshes need exceptions. Put the exception on that pod and document it. Do not drop the context from the whole namespace because one sidecar complained.

### At work

The template has the restricted fields filled in, including the read-only root that the standard does not force. CI rejects a manifest that deletes them. The runtime rejects what CI missed, once the namespace enforces. Image scanning belongs in the pipeline. It does not replace the context. A clean scan of an image that runs as root is still root.

### Decision

| Risk | Field |
|---|---|
| Process runs as root | runAsNonRoot and a non-zero runAsUser |
| Writable system directories | readOnlyRootFilesystem, plus an emptyDir for temp |
| Extra Linux capabilities | drop ALL, add back the minimum |
| Token the app never uses | automountServiceAccountToken false |
| Needs the host | a DaemonSet in an agent namespace, not the app pod |

### You can now

- Set the restricted fields and the read-only root this course adds.
- Separate "non-root" from "may not call the API."
- Give a read-only process a place to write temp files.
- Keep privileged and hostPath out of application Deployments.

::: config lang=yaml
task: Harden this Deployment's container: run as non-root (user `10001`), forbid privilege escalation, make the root filesystem read-only, and drop all capabilities.
starter:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 2
  selector:
    matchLabels:
      app: api
  template:
    metadata:
      labels:
        app: api
    spec:
      containers:
        - name: api
          image: ghcr.io/acme/api:1.4.2
          securityContext:
            privileged: true
```
check: spec.template.spec.containers[0].securityContext.runAsNonRoot = true | runAsNonRoot: true
check: spec.template.spec.containers[0].securityContext.runAsUser = 10001 | runAsUser: 10001
check: spec.template.spec.containers[0].securityContext.allowPrivilegeEscalation = false | allowPrivilegeEscalation: false
check: spec.template.spec.containers[0].securityContext.readOnlyRootFilesystem = true | readOnlyRootFilesystem: true
check: spec.template.spec.containers[0].securityContext.capabilities.drop has ALL | capabilities.drop includes ALL
check: spec.template.spec.containers[0].securityContext.privileged !~ /true/ | Not privileged
solution:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 2
  selector:
    matchLabels:
      app: api
  template:
    metadata:
      labels:
        app: api
    spec:
      containers:
        - name: api
          image: ghcr.io/acme/api:1.4.2
          securityContext:
            runAsNonRoot: true
            runAsUser: 10001
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
```
hint: Replace `privileged: true` with the five settings from the lesson. `drop` is a list: `["ALL"]`.
:::

::: quiz
q: A pod is compromised via a request it parsed. There is no NetworkPolicy in the namespace. What can it open a TCP connection to?
- Only its own Service
+ Any pod or external address the node network allows, including Services in other namespaces, because the default is allow
- Nothing. Kubernetes denies egress unless a policy allows it
- Only the API server
why: NetworkPolicy is deny-by-exception only after a policy selects the pod. With no policy, the dataplane does not insert that deny. Cross-namespace DNS names work. The API server is reachable too if the network path exists, but it is not the only target.
:::

::: card
q: Why is a mounted ServiceAccount token a security boundary, not just a convenience?
answer: It is a credential. The kubelet projects it into the pod, and the API server will honor it for whatever that ServiceAccount is authorized to do. A compromised process can read the file and call the API. Use a dedicated account with a narrow Role, and set automountServiceAccountToken false when the pod does not need the API.
:::

::: quiz
q: The container only starts as root. The namespace enforces the restricted Pod Security Standard. What is the right fix?
- Label the namespace privileged so the standard is gone cluster-wide
+ Change the image or the securityContext so it runs as non-root, and keep the standard. A one-off exemption is a reviewed exception, not the default
- Run it as a DaemonSet
- Switch the probe to exec
why: The standard is doing its job. Privileged namespaces are how host mounts and root come back for every pod, not just this one. Fix the UID. DaemonSets and probes do not bypass Pod Security admission.
:::

::: predict lang=python
q: Which control stops which action? What does this print?
code:
```python
def stops(action):
    return {
        "list-secrets": "rbac",
        "dial-metadata": "networkpolicy",
        "run-as-root": "pod-security",
        "eat-all-cpu": "quota",
    }[action]

print(stops("list-secrets"))
print(stops("dial-metadata"))
print(stops("run-as-root"))
```
answer:
```text
rbac
networkpolicy
pod-security
```
why: Listing secrets is an API call, so RBAC decides it. Dialing the cloud metadata address is a packet, so NetworkPolicy can deny the egress. Running as root is stopped at admission by the Pod Security Standard, before the container starts. Quota would be the answer for a pod that schedules until the namespace is full. Each control misses the others' attacks.
:::

::: quiz
q: Namespace shop has no NetworkPolicy. The invoices ServiceAccount can get and list secrets. The container sets runAsUser 0. You add runAsNonRoot true and change nothing else. What is still true?
- The namespace is default-deny, so the network hole closed when the user changed
+ The process is no longer root, and it can still read every Secret in the namespace and open any connection. Those are separate holes
- Listing secrets is harmless once the pod is non-root
- A NetworkPolicy is created automatically for pods that are non-root
why: Non-root does not grant or remove RBAC, and it does not create a NetworkPolicy. No policy means the CNI is not restricting this pod. Secret get and list still return data to whoever holds the token. Close each hole on purpose.
:::

## Scaling and safe rollouts
id: scaling
stage: ops
needs: probes, debugging
minutes: 35
goal: Scale a Deployment from a metric only when requests exist, and say what an HPA will not do.
source: Kubernetes: Horizontal Pod Autoscaler | https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/

You can set replicas to the peak and pay for the peak all night. You can set replicas to the average and fall over at lunch. A HorizontalPodAutoscaler writes `spec.replicas` for you, between a minimum and a maximum, from a metric. It is a controller. It is not magic, and it does nothing useful if the metric has no meaning.

### The problem

CPU is the metric everyone starts with because metrics-server already exposes it. Utilization is `usage / request`. If the container has no CPU request, utilization is undefined, and the HPA target shows `<unknown>`. It will not scale. The resources lesson is a prerequisite, not a suggestion. Memory utilization exists and is a poor signal for many APIs: the heap grows and does not shrink, so the HPA scales out and never comes back.

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api
  minReplicas: 3
  maxReplicas: 12
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 65
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
```

The formula, ignoring the tolerance band, is `desired = ceil(currentReplicas * (currentMetric / targetMetric))`. If usage is twice the target, you want about twice the pods. A tolerance (ten percent by default) stops it flapping when the ratio is close to 1. `behavior` is how fast you go. Scale down should be slower than scale up. The stabilization window uses the highest recommendation in the window so one quiet minute does not cut you in half.

`minReplicas` below the PDB's minimum is how you autoscale into an outage. If the budget says two must stay and the HPA's minimum is one, a quiet hour plus a drain is a bad afternoon. Set the minimum to what you are willing to run, not to zero, unless the workload is allowed to be down. CPU HPA cannot scale to zero. There is no usage to measure when there are no pods. Queue-based scale to zero is KEDA, in the next lesson.

### What it will not fix

It will not make a single pod faster. A CPU limit that throttles is a throttle. More throttled pods are more throttled pods. It will not replace a missing index in a database. It will not schedule pods onto nodes that do not exist. Pending pods mean the cluster autoscaler or Karpenter has to add nodes, or your requests do not fit. The HPA has done its job by writing replicas. The scheduler is the next controller.

It will not know about in-flight work unless the metric includes it. A worker that is busy and not using CPU (waiting on a vendor) looks idle. Scale on queue depth, not on CPU, for that process.

### At work


### The ratio, with the tolerance the controller actually uses

The textbook formula is `desired = ceil(currentReplicas * current / target)`. A controller that applied that on every scrape would flap. Usage at 66% against a 65% target is not a reason to add a pod. The HPA manager ignores ratios inside a tolerance band around 1.0. The default tolerance is 0.1, so it only acts when the current value is at least 10% above or below the target. 65% target means "do nothing" roughly between 58% and 72%. Your dashboard can show a number that is "over target" while the replica count stays put. That is not a stuck controller. It is the band. If you need tighter tracking, you are probably on the wrong metric, not the wrong tolerance. Changing the tolerance is a controller flag, not a field on the HPA object. Do not plan a design that needs a 1% band.

Work an example with integers so the ceil is visible. Four pods, target 65% CPU, current average 130%. The ratio is 2. `ceil(4 * 2) = 8`. The same four pods at 70% are inside a 10% band of 65 (70/65 is about 1.08, under 1.10), so a real HPA leaves them at 4 even though a naive ceil might want 5. At 10% usage the naive result is 1, and `minReplicas: 3` holds the count at 3. At a spike that would want 40, `maxReplicas: 10` holds it at 10 and the extra load is latency, not more pods. Alert on "at max", because the formula has stopped protecting you.

### behavior is the second spec

`spec.behavior` is where teams stop getting paged for scale-down. Scale up can be aggressive: a percent of current replicas every few seconds, or a fixed number of pods. Scale down should use `stabilizationWindowSeconds`. The controller looks back across the window and picks the **highest** desired count it recommended in that window. One quiet minute does not erase a spike from four minutes ago. 300 seconds is a reasonable start for a web API. A batch worker that finishes and should go away can use a shorter window, or you are paying for pods that have nothing to do. The default scale-down policy is already conservative. Read it before you copy a manifest that sets the window to 0 in the name of "responsiveness". Zero means every dip is acted on. That is how you crash-loop a service that scales down, overloads, scales up, and repeats.

Policies are lists. You can allow at most four pods removed per minute and also at most 10% per minute, and the HPA applies the more restrictive one or the one you select with `selectPolicy`. You rarely need a novel policy. You need a window that matches how long a new pod takes to become Ready. Scaling up faster than the readiness probe is a way to stampede the dependency (the database, the vendor API) with pods that are not serving yet. The probe lesson and this one meet there. `minReadySeconds` on the Deployment is the other brake.

### Which metric

Resource metrics are CPU and memory, from metrics-server, as utilization or as an average value. Utilization needs a request. An average value (`target.averageValue`) does not divide by the request, which is useful when you want "100 millicores of headroom" rather than a percentage. Memory utilization still has the ratchet problem: heaps do not shrink, so the HPA ratchets up.

Object and external metrics are for everything else. A Service's requests-per-second, a queue depth published to Prometheus, a cloud metric. Those need an adapter (Prometheus adapter, KEDA). The HPA object only names the metric. If the adapter is down, the target goes unknown and the HPA stops making decisions. It does not scale to max "to be safe", and it does not scale to min. It holds. An unknown metric during an adapter outage leaves you at the last replica count. That is usually better than flapping, and it is a reason to alert on HPA conditions, not only on CPU.

Pods metrics are per-pod averages you define (for example active sessions). They have the same requirement as CPU: the pods have to exist to be measured. None of these resource or pod metrics scale the Deployment to zero. The autoscaling lesson's KEDA section is the tool when the correct minimum is zero.

### Two controllers writing replicas

The HPA writes `spec.replicas`. So does `kubectl scale`. So does a GitOps sync that applies a file with `replicas: 3`. The last writer wins. If Argo CD reconciles every three minutes, your HPA is a brief suggestion. The fix is to stop Git from owning the replica field: ignore differences on `spec.replicas`, or remove replicas from the rendered manifest and let the HPA be the only writer. This is the same two-writer bug as editing a Deployment by hand. Name the owner. For an autoscaled service the owner is the HPA, and Git owns the min, the max, and the metric.

A Vertical Pod Autoscaler that mutates requests while an HPA scales on utilization of those requests will fight itself. Utilization changes because the request changed, not because the traffic changed. Do not run VPA in Auto mode on the same resource the HPA uses. VPA in recommendation-only mode is a way to learn the number. It is not a second scaler.

### Where this fails in production

**The metric is right and the nodes are full.** Desired replicas climb, pods stay Pending, users still time out. The HPA looks "healthy" because it computed a number. Page on Pending pods, not only on the HPA object.

**A slow startup probe plus a fast scale-up.** New pods count as unready and, depending on the metric, the remaining pods look even busier, so the HPA adds more. You can set the scale-up policy to a small step. You cannot fix a 90-second boot with a 15-second scale period.

**minReplicas under the disruption budget.** Quiet traffic scales to 2. The budget says 2 must remain. A drain cannot proceed. Set the HPA minimum to the number the budget assumes, or lower the budget and accept the risk on purpose.

**Averaging across a canary.** One new pod at 100% CPU and three old pods at 10% can average into "fine" and also into "add pods", depending on the count. The HPA does not understand versions. A skewed rollout is a rollout problem first.


Start with a minimum that survives one node loss, a maximum that matches the quota and the budget, and a metric you have watched on a dashboard. Alert on "HPA at max for 15 minutes" and on "replicas wanted, pods Pending". Those two alerts are the difference between autoscaling and a silent ceiling.

### You can now

- Explain CPU utilization as usage divided by request.
- Predict the rough desired replica count from the ratio.
- Set a scale-down window so you do not flap.
- Keep minReplicas compatible with the disruption budget.
- Say why CPU cannot scale to zero.

### What this lesson is for

The steps here are the Horizontal Pod Autoscaler and the replica formula it uses. Desired replicas come from the current replica count, the current usage, and a target, then the result is clamped to a minimum and a maximum. That is the controller you configure when you write an autoscaling/v2 HPA on CPU utilization. The Vertical Pod Autoscaler, KEDA, the cluster autoscaler, and Karpenter change different numbers. They are the autoscale lesson. Do not add a second controller that also writes spec.replicas on this Deployment. Two writers fight, and the formula you just learned is not what you will observe.

CPU utilization is a percentage of the request. A missing request means the HPA cannot compute a utilization, and the events say so. A request copied from a wish makes the percentage a fiction. The formula rounds up. A noisy metric flaps unless the behavior field sets a stabilization window. That window is part of making this HPA safe. It is not a different autoscaler.

### You can now

- Compute a desired replica count from usage, target, and bounds.
- Require a CPU request before a CPU utilization HPA.
- Leave queue-based scale-to-zero and node scaling to the autoscale lesson.

::: config lang=yaml
task: Write an HPA named `orders` for the Deployment `orders`: between 3 and 12 replicas, targeting 65% average CPU utilization (`autoscaling/v2`).
starter:
```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: orders
spec: {}
```
check: apiVersion = autoscaling/v2 | apiVersion is autoscaling/v2
check: spec.scaleTargetRef.kind = Deployment | It targets a Deployment
check: spec.scaleTargetRef.name = orders | …named orders
check: spec.scaleTargetRef.apiVersion = apps/v1 | scaleTargetRef.apiVersion is apps/v1
check: spec.minReplicas = 3 | minReplicas 3
check: spec.maxReplicas = 12 | maxReplicas 12
check: spec.metrics[0].resource.name = cpu | It scales on cpu
check: spec.metrics[0].resource.target.type = Utilization | …as Utilization
check: spec.metrics[0].resource.target.averageUtilization = 65 | …at 65%
solution:
```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: orders
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: orders
  minReplicas: 3
  maxReplicas: 12
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 65
```
hint: Copy the lesson's HPA and change the name, the bounds and the target.
:::

::: quiz
q: The HPA above shows `<unknown>/70%` and never scales. The Deployment's containers have no `resources` section. Why?
+ Utilization is a percentage of the CPU **request**; with no request there's nothing to divide by
- The HPA needs a memory metric too
- minReplicas must be 1
- HPAs only work with StatefulSets
why: Set CPU requests on the containers (and make sure metrics-server is running).
:::

::: card
q: Why does a CPU HorizontalPodAutoscaler show an unknown target when the Deployment has no CPU requests?
answer: Utilization is current usage divided by the CPU request. With no request the ratio is undefined, so the HPA cannot compute a desired replica count. Set a CPU request on every container that should count. Memory and custom metrics are separate; they do not fill in a missing CPU request.
:::

::: predict lang=python
q: desired replicas are ceil(current * (usage / target)), and at least the minimum. What does this print?
code:
```python
import math
def desired(current, usage, target, minimum, maximum):
    raw = math.ceil(current * (usage / target))
    return max(minimum, min(maximum, raw))

print(desired(4, 130, 65, 2, 10))
print(desired(4, 65, 65, 2, 10))
print(desired(4, 10, 65, 3, 10))
```
answer:
```text
8
4
3
```
why: Twice the target utilization doubles the pods, from 4 to 8. Equal to the target stays at 4 (the real controller also has a tolerance band, so a tiny wobble would stay too). Very low usage would want fewer than the minimum, so the minimum of 3 holds. The maximum would cap a larger result. This is the core ratio, not the stabilization window.
:::

::: quiz
q: The HPA has set replicas to 12, which is its maximum, and new pods are Pending with Insufficient cpu. What scales next, if anything?
- The HPA, if you wait another minute
+ Nothing in the HPA. You need more nodes (cluster autoscaler or Karpenter) or smaller requests. The HPA only writes the replica count
- The liveness probe
- A PodDisruptionBudget, by raising minAvailable
why: Pending means the scheduler cannot place the pods the HPA already asked for. Raising the HPA max does not create CPU. A PDB does not add capacity. Node autoscaling is the other loop.
:::

::: write lang=python
task: Implement `desired(current, usage, target, minimum, maximum)` as ceil(current * usage / target), clamped to the inclusive minimum and maximum. Use math.ceil. Assume all arguments are positive ints.
starter:
```python
import math
def desired(current, usage, target, minimum, maximum):
    return current
```
tests:
```python
import math
from solution import desired

def test_double():
    assert desired(4, 130, 65, 2, 10) == 8

def test_min():
    assert desired(4, 10, 65, 3, 10) == 3

def test_max():
    assert desired(4, 400, 65, 2, 10) == 10
```
solution:
```python
import math
def desired(current, usage, target, minimum, maximum):
    raw = math.ceil(current * (usage / target))
    return max(minimum, min(maximum, raw))
```
hint: Compute the ratio first, ceil it, then clamp. The minimum wins over a small raw value. The maximum wins over a huge one.
:::

## EKS, Helm and GitOps
id: eks-helm
stage: ops
needs: scaling, security-k8s, terraform/tf-team
minutes: 40
goal: Install a chart with Helm, let GitOps own the live objects, and connect a pod to AWS with Pod Identity instead of a key.
source: Helm docs | https://helm.sh/docs/
source: Amazon EKS: Pod Identity | https://docs.aws.amazon.com/eks/latest/userguide/pod-identities.html
source: Argo CD | https://argo-cd.readthedocs.io/en/stable/

You can apply a directory of YAML. You will get tired of it the moment you install someone else's twenty objects, or the moment two environments must differ. Helm packages those objects as a chart and records a release. GitOps applies the chart, or the Kustomize overlay, from Git, and puts it back if someone edits the cluster by hand. EKS is the usual place this runs when the company is on AWS: AWS runs the control plane, you run workloads, and Pod Identity is how those workloads call AWS.

### Helm, as of 2026

Helm 4 shipped in November 2025. It is the current major version. Helm 3 is still what many CI images pin, and it still receives security fixes into early 2027, but you should not start a new platform on it. The user-facing model did not turn upside down. There is still no Tiller (that died in Helm 3). You still have charts, `values.yaml`, releases, `helm upgrade --install`, and `helm rollback`. A release is a row in a Secret in the namespace, listing what was installed. `helm uninstall` deletes the objects. It does not delete your PersistentVolumeClaims if the chart used the right annotations, and some charts get this wrong. Read the chart before you uninstall a database.

A chart you write has `Chart.yaml`, `values.yaml`, and `templates/`. Templates are Go templates. `{{ .Values.image.tag }}` becomes the tag. The failure mode is a template that renders invalid YAML or that quotes a number so the API rejects it. `helm template` renders locally. `helm lint` catches the obvious. CI should do both before apply.

Third-party charts (ingress controllers, cert-manager, External Secrets) should be pinned to a chart version and an app version. Floating `latest` is how you take a breaking CRD upgrade on a Tuesday. Values override the defaults. Do not fork the chart to change one replica count. Override the value.

Kustomize, from its own lesson, is the other tool. Helm when you need templates or someone else's chart. Kustomize when you are patching your own YAML. A platform often uses both.

### GitOps

Argo CD or Flux watches a Git repository and applies it. The cluster is supposed to match Git. If you `kubectl scale` during an incident, the next sync scales it back. That surprise is the system working. To change production, change Git, or use the product's documented break-glass and expect it to revert when you are done.

The sync will not hide a bad probe. Pods crash, the release is "synced", and the app is down. GitOps is not a health check. Readiness, PDBs, and the rollout status still matter. Argo's health is a second view of the same objects.

Do not give the GitOps controller cluster-admin if a namespace-scoped installer will do. It applies whatever Git says. A compromised repo is a compromised cluster in proportion to that ServiceAccount. Protect the branch.

### EKS

EKS runs the API server and etcd for you. You still choose Kubernetes versions and you still upgrade. Falling behind is how you miss Pod Security and sidecar behavior this module treats as stable. Worker nodes are yours: a managed node group, Karpenter, or EKS Auto Mode. The control plane upgrade does not replace the node image. Old nodes run old kubelets. Drain them on purpose.

The cloud controller and the VPC CNI are what make `Service type LoadBalancer` and pod IPs real. A LoadBalancer Service creates an AWS load balancer and a bill. An Ingress or a Gateway does too, if that is the controller you installed. kind will not prepare you for the IAM the controller's ServiceAccount needs. When the load balancer stays pending, check the controller logs and its IAM role before you rewrite the Ingress.

Pod Identity associates a ServiceAccount with an IAM role. The app uses the AWS SDK and does not read a key from a Secret. IRSA is the older OIDC annotation approach, still right for Fargate. New node-group workloads should use Pod Identity. The association is AWS API state, often created by Terraform, not by a field inside the Deployment. The Deployment only sets `serviceAccountName`.

### Where it breaks

**Helm and GitOps both installing the same objects.** Two owners. Pick one. The usual pattern is GitOps runs Helm, and humans do not.

**A values file with a secret.** It lands in Git and in the Helm release Secret. Use External Secrets or Pod Identity instead.

**Upgrading a CRD chart in place.** CRDs sometimes do not upgrade with `helm upgrade` the way Deployments do, depending on the chart. Read the release notes. A half-upgraded CRD is an API outage for that kind.

**The wrong cluster context.** Helm and GitOps will happily install prod values into dev, or the reverse. Name the releases and the contexts so the command looks wrong when it is wrong.

### At work

Application charts are thin: Deployment, Service, PDB, ExternalSecret, HTTPRoute, ServiceAccount. Platform charts are the ingress controller, the scaler, and the policy controllers. Terraform creates the cluster, the Pod Identity associations, and the queues. Kubernetes objects stay in Git. You now have the full loop from the first lesson: desired state in Git, a controller that applies it, other controllers that keep pods running, and an identity that is not a password in a file.

### You can now

- Install and upgrade a chart with values, and render it before you apply.
- Say what Helm 4 kept from Helm 3 (charts, releases, no Tiller) and that Helm 3 is in its security-support window.
- Predict that GitOps will revert a live `kubectl scale`.
- Point a Deployment at a ServiceAccount and let Pod Identity supply AWS credentials.
- Keep Helm and GitOps from both owning the same object.

::: quiz
q: With Argo CD managing a namespace, someone runs `kubectl scale deployment api --replicas=10` by hand. What happens?
- It stays at 10 until the next deploy
+ Argo CD sees the difference from Git (out of sync) and, with self-heal on, sets it back to the Git value
- Argo CD deletes the Deployment
- The command is refused by the API server
why: In GitOps, Git is the desired state. Manual changes are drift, so they're reported and, with self-heal, reverted. (If an HPA owns replicas, leave replicas out of Git.)
:::

::: card
q: Helm vs Kustomize in one line each?
answer: Helm packages manifests as templated charts with values, versioned and installable, and it's how most third-party software ships. Kustomize patches plain YAML (a base plus overlays per environment), with no templates; it's built into kubectl.
:::

::: card
q: What does Argo CD do after someone runs `kubectl scale` on a Deployment it manages?
answer: On the next sync it sets the replica count back to what Git (or the Helm values it rendered) declares. The live edit is drift. To keep the new scale, change Git. Break-glass procedures exist and still revert when sync resumes.
:::

::: quiz
q: It is 2026. You are choosing a Helm major version for a new platform. What is accurate?
- Helm 4 removed charts and brought Tiller back
+ Helm 4, released in November 2025, is the current major. Charts, values, releases, upgrade, and rollback remain. Helm 3 is in a security-fix window into early 2027, not the place to start
- Only Helm 2 works with Kubernetes 1.33 sidecars
- Helm is deprecated in favor of composing YAML by hand
why: Helm 4 is a major release that keeps the Helm 3 user model: no Tiller, charts and releases. Sidecars are a Kubernetes feature, not a Helm 2 feature. Hand-written YAML does not package a third-party controller. Pin a version either way.
:::

::: quiz
q: A pod on EKS must call S3. The Deployment sets serviceAccountName to `api`, and a Pod Identity association binds that account to an IAM role. Where is the access key stored?
- In a Secret named api-keys, by default
+ Nowhere in the cluster. The SDK gets temporary credentials from the Pod Identity agent
- In the Helm values file, which is the supported store
- In etcd, encrypted, as the role's permanent key
why: Pod Identity exists so there is no long-lived key in a Secret or in values. The IAM role's policy is the authorization. IRSA also avoids static keys but uses an OIDC annotation instead. Putting the key in Helm values checks it into Git.
:::

::: predict lang=python
q: Git declares 3 replicas. Someone scaled the live object to 10. Sync runs. What does this print?
code:
```python
def after_sync(git_replicas, live_replicas):
    return git_replicas

print(after_sync(3, 10))
print(after_sync(5, 5))
```
answer:
```text
3
5
```
why: The sync writes the desired state from Git. A live drift to 10 is undone. If Git already says 5 and the live object says 5, nothing changes. This is the same apply idempotence as the first lesson, on a timer, with Git as the file.
:::

::: quiz
q: Helm shows release invoices with status failed. Revision 4 was deployed and is the last good one. The chart in Git is the same commit that just failed. What should the deploy job do next?
- helm install invoices again, because failed means the release does not exist
+ helm rollback invoices 4, then fix the chart before another upgrade. A retry of the same commit repeats the failure
- helm uninstall invoices and install fresh so history is empty
- helm upgrade --install with --force and the same chart, to overwrite the failure
why: A failed release is still a release. Install refuses because the name exists. Upgrade with the same broken chart fails again. Uninstall can delete the Service and the workloads a rollback would have restored. Rollback returns to revision 4, which was deployed.
:::

## Project: deploy the API
id: p-k8s
stage: ops
needs: eks-helm, ingress, config
minutes: 75
goal: Ship the invoices API as a Deployment, Service, and Ingress, then add a disruption budget and a CPU autoscaler that can actually compute utilization.
source: Kubernetes: Deployments | https://kubernetes.io/docs/concepts/workloads/controllers/deployment/
source: Kubernetes: Ingress | https://kubernetes.io/docs/concepts/services-networking/ingress/
source: Kubernetes: Horizontal Pod Autoscaler | https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/
project: yes

The invoices API is already a container. You are the person putting it on the cluster this week. The platform gives you a namespace, an ingress class named alb, and a Secret invoices-db that already holds key url. You do not get a node shell. GitOps will apply the same files again tomorrow, so a kubectl edit is not a result you can hand over.

The image is ghcr.io/acme/invoices:3f9a2c1 and it listens on 8000. It is ready only when GET /ready succeeds, and it should be restarted when GET /health fails. It reads LOG_LEVEL from a ConfigMap and DATABASE_URL from that Secret. Three copies is the floor. The Service is how the rest of the cluster calls it. Host invoices.example.com on class alb is how users reach it.

You are not inventing a cluster. The platform already gave you a namespace and the ingress class. Your job is the manifests GitOps will apply again tomorrow. A kubectl edit that is gone after the next sync does not count. Budget about 75 minutes. Do the four-document file first, then the budget, then the autoscaler, then the review function. Each later file is a new object, not a patch on the previous answer.

### Lessons this uses

1. Pods and Deployments: labels, selectors, replicas, and a pinned image.
2. Config: a ConfigMap and a Secret key projected into the environment, not baked into the image.
3. Probes: readiness on /ready and liveness on /health, on the container port.
4. Resources: CPU and memory requests, and a memory limit, so the scheduler and the HPA have numbers.
5. Security context from the security lesson: non-root, no privilege escalation, read-only root filesystem.
6. Services and Ingress: the Service is the in-cluster address. The Ingress is the host and path on class alb.
7. Rollouts: a PodDisruptionBudget so a drain cannot take every replica.
8. Scaling: an autoscaling/v2 HorizontalPodAutoscaler that uses the CPU request. Without the request, utilization has nothing to divide by.

### Requirements

The first graded file is four documents separated by ---.

1. ConfigMap invoices-config with LOG_LEVEL set to info.
2. Deployment invoices: 3 replicas; selector and pod labels app invoices; envFrom that ConfigMap; DATABASE_URL from Secret invoices-db key url; readiness /ready and liveness /health on port 8000; requests cpu 200m and memory 256Mi; memory limit 512Mi; securityContext runAsNonRoot true, allowPrivilegeEscalation false, readOnlyRootFilesystem true. Pin the image. latest fails.
3. Service invoices: port 80, targetPort 8000, selecting those pods.
4. Ingress invoices, class alb, host invoices.example.com, path / with pathType Prefix, backend Service invoices port 80.

Then a PodDisruptionBudget named invoices that selects app invoices and sets maxUnavailable to 1, with no minAvailable. Then an autoscaling/v2 HorizontalPodAutoscaler named invoices for the Deployment, minimum 3, maximum 10, average CPU utilization 70. The last step is a review function. It flags an image that ends with :latest, a selector that is not the pod label app, and a missing CPU request.

### How this is graded

Each step is checked on its own file. The four-document manifest has to satisfy every numbered field above at once. A later step does not repair an earlier one. The checker parses YAML and runs the Python review locally. It does not talk to a cluster, and it does not have kubectl. A file that would probably work and misses a check is not shipped. The review function sees only the arguments the tests pass. Names, ports, the image tag, and the label app have to match across documents, because that is how the Service, Ingress, budget, and autoscaler find the pods.

### Where a green file still fails later

The Secret has to exist or the pod stays unready. Class alb does nothing without the AWS load balancer controller. The HPA needs metrics-server and the CPU request you wrote. The budget does not survive a dead zone. It stops a drain from taking every replica while a rollout is already short. Those are why the fields exist. They are not reasons to skip one.

### You can now

- Hand over the edge of the service as one manifest.
- Add the disruption budget and the CPU HPA that match the replica floor.
- Reject a moving tag, a broken selector, and a missing request without a cluster.

::: config lang=yaml
task: Write the four documents, separated by `---`.
starter:
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: invoices-config
data:
  LOG_LEVEL: info
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: invoices
spec:
  replicas: 1
  selector:
    matchLabels:
      app: invoices
  template:
    metadata:
      labels:
        app: invoices
    spec:
      containers:
        - name: invoices
          image: ghcr.io/acme/invoices:latest
```
check: [kind=ConfigMap].metadata.name = invoices-config | ConfigMap invoices-config
check: [kind=ConfigMap].data.LOG_LEVEL = info | …with LOG_LEVEL: info
check: [kind=Deployment].spec.replicas = 3 | Deployment: 3 replicas
check: [kind=Deployment].spec.selector.matchLabels.app == [kind=Deployment].spec.template.metadata.labels.app | Deployment: selector matches the template labels
check: [kind=Deployment].spec.template.spec.containers[0].image = ghcr.io/acme/invoices:3f9a2c1 | Deployment: image pinned to 3f9a2c1 (not latest)
check: [kind=Deployment].spec.template.spec.containers[0].envFrom[0].configMapRef.name = invoices-config | Deployment: envFrom the ConfigMap
check: [kind=Deployment].spec.template.spec.containers[0].env[name=DATABASE_URL].valueFrom.secretKeyRef.name = invoices-db | Deployment: DATABASE_URL from Secret invoices-db
check: [kind=Deployment].spec.template.spec.containers[0].env[name=DATABASE_URL].valueFrom.secretKeyRef.key = url | …key url
check: [kind=Deployment].spec.template.spec.containers[0].readinessProbe.httpGet.path = /ready | Deployment: readiness on /ready
check: [kind=Deployment].spec.template.spec.containers[0].livenessProbe.httpGet.path = /health | Deployment: liveness on /health
check: [kind=Deployment].spec.template.spec.containers[0].readinessProbe.httpGet.port = 8000 | Deployment: probes on port 8000
check: [kind=Deployment].spec.template.spec.containers[0].resources.requests.cpu = 200m | Deployment: CPU request 200m
check: [kind=Deployment].spec.template.spec.containers[0].resources.requests.memory = 256Mi | Deployment: memory request 256Mi
check: [kind=Deployment].spec.template.spec.containers[0].resources.limits.memory = 512Mi | Deployment: memory limit 512Mi
check: [kind=Deployment].spec.template.spec.containers[0].securityContext.runAsNonRoot = true | Deployment: runAsNonRoot
check: [kind=Deployment].spec.template.spec.containers[0].securityContext.allowPrivilegeEscalation = false | Deployment: no privilege escalation
check: [kind=Deployment].spec.template.spec.containers[0].securityContext.readOnlyRootFilesystem = true | Deployment: read-only root filesystem
check: [kind=Service].metadata.name = invoices | Service invoices
check: [kind=Service].spec.selector.app == [kind=Deployment].spec.template.metadata.labels.app | Service selects the Deployment's pods
check: [kind=Service].spec.ports[0].port = 80 | Service port 80
check: [kind=Service].spec.ports[0].targetPort = 8000 | …to targetPort 8000
check: [kind=Ingress].spec.ingressClassName = alb | Ingress class alb
check: [kind=Ingress].spec.rules[0].host = invoices.example.com | Ingress host invoices.example.com
check: [kind=Ingress].spec.rules[0].http.paths[0].backend.service.name = invoices | Ingress routes to Service invoices
check: [kind=Ingress].spec.rules[0].http.paths[0].backend.service.port.number = 80 | …port 80
solution:
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: invoices-config
data:
  LOG_LEVEL: info
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: invoices
spec:
  replicas: 3
  selector:
    matchLabels:
      app: invoices
  template:
    metadata:
      labels:
        app: invoices
    spec:
      containers:
        - name: invoices
          image: ghcr.io/acme/invoices:3f9a2c1
          ports:
            - containerPort: 8000
          envFrom:
            - configMapRef:
                name: invoices-config
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: invoices-db
                  key: url
          readinessProbe:
            httpGet:
              path: /ready
              port: 8000
          livenessProbe:
            httpGet:
              path: /health
              port: 8000
          resources:
            requests:
              cpu: 200m
              memory: 256Mi
            limits:
              memory: 512Mi
          securityContext:
            runAsNonRoot: true
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
---
apiVersion: v1
kind: Service
metadata:
  name: invoices
spec:
  selector:
    app: invoices
  ports:
    - port: 80
      targetPort: 8000
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: invoices
spec:
  ingressClassName: alb
  rules:
    - host: invoices.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: invoices
                port:
                  number: 80
```
hint: Build it from the lessons' examples: the config lesson for env, the probes lesson for probes and resources, security basics for the securityContext, the services and ingress lessons for the last two documents.
:::

::: quiz
q: In the invoices project, why is the image tag a digest-like pin `3f9a2c1` instead of `latest`?
- latest is invalid in a Deployment
+ latest moves. Two nodes, or a rollback, can run different builds while the manifest still says latest. A pin is the build you reviewed
- The ALB rejects latest
- Probes only work on pinned tags
why: The registry tag latest is mutable. A pin (or a digest) is what makes a rollout and a rollback refer to a known image. Ingress and probes do not care about the tag string. The API server will happily run latest, which is why the review has to forbid it.
:::

::: quiz
q: The Deployment labels pods `app: invoices` and the Service selector is `app: invoice` (missing the s). The pods are Ready. What do callers to the Service get?
- Traffic, because the Service name matches the Deployment name
+ Nothing useful. The EndpointSlice stays empty because the selector does not match the labels
- Traffic to a random Ready pod in the namespace
- A CreateContainerConfigError
why: Endpoints are pods whose labels match the selector in the same namespace. The names of the Service and the Deployment are irrelevant to that match. The pods stay Ready. The bug is the selector, and port-forward to a pod would still succeed.
:::

::: config lang=yaml
task: Write a PodDisruptionBudget named `invoices` that selects `app: invoices` and sets maxUnavailable to 1. Do not set minAvailable.
starter:
```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: invoices
spec:
  minAvailable: 3
  selector:
    matchLabels:
      app: web
```
check: metadata.name = invoices | name
check: spec.maxUnavailable = 1 | one unavailable
check: spec.minAvailable missing | not both fields
check: spec.selector.matchLabels.app = invoices | selector
solution:
```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: invoices
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      app: invoices
```
hint: maxUnavailable 1 lets a drain take one Ready pod. minAvailable 3 with three replicas blocks every eviction. The label must be invoices, the same one the Deployment template uses.
:::

::: config lang=yaml
task: Write an autoscaling/v2 HorizontalPodAutoscaler named `invoices` for Deployment `invoices`. Minimum 3, maximum 10, average CPU utilization 70.
starter:
```yaml
apiVersion: autoscaling/v1
kind: HorizontalPodAutoscaler
metadata:
  name: invoices
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: web
  minReplicas: 1
  maxReplicas: 1
```
check: apiVersion = autoscaling/v2 | v2
check: metadata.name = invoices | name
check: spec.scaleTargetRef.kind = Deployment | targets a Deployment
check: spec.scaleTargetRef.name = invoices | deployment invoices
check: spec.minReplicas = 3 | minimum 3
check: spec.maxReplicas = 10 | maximum 10
check: spec.metrics[0].type = Resource | resource metric
check: spec.metrics[0].resource.name = cpu | cpu
check: spec.metrics[0].resource.target.type = Utilization | utilization
check: spec.metrics[0].resource.target.averageUtilization = 70 | 70 percent
solution:
```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: invoices
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: invoices
  minReplicas: 3
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
```
hint: autoscaling/v2 puts the target under metrics, not in the old v1 cpu field. The scale target name is invoices. The minimum matches the three replicas you already run so a quiet hour does not go below the disruption budget's comfort.
:::

::: write lang=python
task: Implement `review(image, selector, labels, cpu_request)`. Return a list of problems, in this order. Include "tag" if the image ends with `:latest`. Include "selector" if selector does not equal labels.get("app"). Include "cpu" if cpu_request is missing or empty. An empty list means the manifest passes this review.
starter:
```python
def review(image, selector, labels, cpu_request):
    return []
```
tests:
```python
from solution import review

def test_ok():
    assert review("ghcr.io/acme/invoices:3f9a2c1", "invoices", {"app": "invoices"}, "200m") == []

def test_all():
    assert review("ghcr.io/acme/invoices:latest", "web", {"app": "invoices"}, "") == ["tag", "selector", "cpu"]

def test_selector_only():
    assert review("ghcr.io/acme/invoices:1", "web", {"app": "invoices"}, "200m") == ["selector"]
```
solution:
```python
def review(image, selector, labels, cpu_request):
    problems = []
    if image.endswith(":latest"):
        problems.append("tag")
    if selector != labels.get("app"):
        problems.append("selector")
    if not cpu_request:
        problems.append("cpu")
    return problems
```
hint: Check the three rules in the order tag, selector, cpu. `:latest` at the end of the image string is the bad tag. The Service selector has to equal the app label. An empty CPU request cannot feed a utilization HPA.
:::

## Gateway API
id: gateway-api
stage: traffic
needs: ingress, services
minutes: 40
goal: Split Gateway ownership from HTTPRoute rules, and send a fraction of traffic to a second Service.
source: Gateway API | https://gateway-api.sigs.k8s.io/
source: Gateway API: HTTPRoute | https://gateway-api.sigs.k8s.io/api-types/httproute/
source: Kubernetes blog: Gateway API v1.5 | https://kubernetes.io/blog/2026/04/21/gateway-api-v1-5/

Ingress put every concern in one object: who is allowed to open port 443, which certificate, which path, which timeout annotation. The platform team and the application team edited the same YAML and broke each other. The Gateway API splits those roles. It is GA for the core objects (GatewayClass, Gateway, HTTPRoute have been in the standard channel since the v1 release). As of 2026 the standard channel also includes later promotions such as the HTTPRoute CORS filter (v1.5, February 2026). You install the CRDs; a controller (Envoy Gateway, Istio, the AWS load balancer controller's Gateway support, nginx's implementation) does the work. The objects alone still do nothing, same as Ingress.

### The problem

You want the platform to own the load balancer, the listener, and the TLS certificate, and the app team to own "shop.example.com/api goes to my Service" without permission to change the listener. Ingress cannot express that split cleanly. Gateway API can.

**GatewayClass** is the implementation, like an Ingress class, usually installed by the platform.

**Gateway** is a load balancer the platform requested: which addresses, which ports, which protocols, which namespaces may attach routes.

**HTTPRoute** is the app's rules: host, path, headers, backend Services, weights.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: edge
  namespace: platform
spec:
  gatewayClassName: eg
  listeners:
    - name: https
      protocol: HTTPS
      port: 443
      hostname: "*.example.com"
      tls:
        mode: Terminate
        certificateRefs:
          - name: example-wildcard
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              expose: "true"
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api
  namespace: shop
spec:
  parentRefs:
    - name: edge
      namespace: platform
  hostnames: ["shop.example.com"]
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api
      backendRefs:
        - name: api
          port: 80
```

The route attaches to the Gateway only if the listener allows that namespace and the hostname overlaps. A route that does not attach is Accepted=False in its status. Read status. A green `kubectl apply` is not an attached route.

### Traffic splitting

```yaml
backendRefs:
  - name: api-v1
    port: 80
    weight: 90
  - name: api-v2
    port: 80
    weight: 10
```

Weights are relative. 90 and 10 sends about nine tenths of the requests that match the rule to v1. This is how you canary without a second Ingress annotation dialect. The Services must exist, and their pods must be Ready, or you are sending ten percent of users at an empty EndpointSlice. Pair the split with the readiness probes you already wrote.

Header matches let you send only `X-Canary: true` to v2 before you shift weight. Prefer that for a first look. Weight is for a percentage of real traffic once you trust the metrics.

### What moved out of annotations

Timeouts on HTTPRoute rules are standard-channel since Gateway API 1.2. CORS filters on HTTPRoute are standard since 1.5. You should set those in the route spec when the implementation supports the standard channel, not in a free-form annotation. Implementation-specific policy still exists (load balancer scheme, WAF), and it belongs in a policy object the implementation documents, attached by a reference. If you cannot find the field in the Gateway API spec, do not invent an annotation key and hope.

GRPCRoute is the gRPC-shaped sibling and is in the standard channel in current releases. TCP and TLS routes exist for non-HTTP. Do not force a database through an HTTPRoute.

### Where it breaks

**No ReferenceGrant.** A route in `shop` that points at a Service in `db`, or a Gateway that points at a Secret in another namespace, is refused unless a ReferenceGrant in the target namespace allows that kind of cross-namespace reference. This is intentional. It stops a tenant from attaching to a certificate they do not own. The error is in status, not always in the apply response.

**Hostname overlap.** Two routes claim `shop.example.com` and `/`. The conflict is reported. One of them does not get the traffic you think. Make the matches disjoint.

**Forgetting the controller.** Same failure mode as Ingress. Gateway API is CRDs plus an implementation. kind does not ship one.

**Using weight as a rollout substitute for a broken v2.** Ten percent of errors is still an incident. Gate the shift on the probe and on the error rate. The Deployment rollout is still how pods come up; the route weight is how traffic moves. They are two knobs.

### At work

Platform installs the Gateway in a `platform` namespace and grants which namespaces may attach. App teams ship HTTPRoutes in Git next to the Deployment. Reviews look at weights and hostnames, not at cloud annotations. Ingress stays until you migrate it. Do not run two controllers fighting over the same hostname. Pick one entrance for each host.

The inference-specific extension (InferencePool and an endpoint picker that knows about model servers) is a real SIG project for GPU traffic. It is not required to understand HTTPRoute. Ordinary request/response APIs should not pretend they need it.

### You can now

- Name GatewayClass, Gateway, and HTTPRoute and who owns each.
- Attach a route with parentRefs and explain why status matters.
- Split traffic with backend weights, and say why Ready endpoints still matter.
- Explain ReferenceGrant in one sentence.
- Leave implementation-specific cloud settings out of the route when a typed field exists.

### Listeners, not a second Ingress

A Gateway is a set of listeners. Each listener has a port, a protocol, an optional hostname, and `allowedRoutes`: which namespaces and which kinds may attach. That block is the platform's policy. An application team does not edit it to publish a new path. They write an HTTPRoute whose `parentRefs` name the Gateway, and whose hostnames overlap the listener. If the listener says namespaces `from: Same`, a route in `shop` does not attach to a Gateway in `platform`. Status says `NotAllowedByListeners`. Apply still succeeded. Status is the API.

`parentRefs` can name a namespace. The route lives with the app. The Gateway lives with the platform. A route with no parent, or with a parent that does not exist, is an object in etcd and not a route on a proxy. A route with two parents is attached to two Gateways when both allow it, which is how you expose the same rules on an internal and an external listener without copying paths.

HTTPRoute rules are an ordered list. Each rule has matches (path, headers, method, query) and backendRefs. Path `PathPrefix` `/api` is the usual match. A rule with no matches matches everything that reached the route's hostnames. Weights on backendRefs split traffic. They are not percentages of the cluster. They are relative weights among the refs in that rule. 90 and 10 is nine-to-one. 1 and 1 is even. A weight of 0 keeps the backend in the rule without traffic, which is a useful way to park a Service you are about to drain. A backend in another namespace needs a ReferenceGrant in the target namespace. Without it the route is not accepted. That grant is the security boundary Ingress never had.

### Filters, which replaced a class of annotations

Timeouts, request header modification, redirects, and URL rewrites are filters on the rule or the backend. CORS on HTTPRoute is in the standard channel as of Gateway API 1.5 (February 2026). When the controller implements the standard channel, you set the filter in the route. You do not invent `nginx.ingress.kubernetes.io/...` on a Gateway. Implementation policy that is not in the spec (an AWS certificate ARN, a WAF association) is a policy CRD the implementation documents, attached by reference. If you cannot find the field in the Gateway API types, it is not portable, and it does not belong in a string annotation on the route.

GRPCRoute is the sibling for gRPC methods. TLSRoute and TCPRoute are for connections that are not HTTP. Do not put Postgres on an HTTPRoute because the hostname looks convenient.

### Where it breaks

The CRDs are installed and no controller is. Same failure as an Ingress with no controller. `kubectl get gatewayclass` shows whether a controller accepted the class.

Hostname overlap. The route asks for `api.example.com` and the listener only allows `*.internal.example.com`. The route does not attach. The fix is the listener or the hostname, not a second path.

Two HTTPRoutes claim the same host and path on the same listener. Conflict rules are in the spec: older or more specific matches win in defined ways, and the loser gets a status condition. Do not debug this by deleting random routes. Read status.

A canary weight that points at a Service with zero endpoints. The weight is honest and the endpoints are empty, so that share of requests fails. The route is not the Deployment.

### At work

Platform Git creates GatewayClass and Gateway, the TLS secret or the cloud certificate, and the allowed namespaces. App Git creates HTTPRoute next to the Deployment. Reviews of app changes look at hostnames, matches, weights, and backendRefs. Reviews of platform changes look at listeners. You do not migrate every Ingress on day one. You stop adding new ones for hosts the Gateway already owns, and you do not run two controllers on the same hostname.

### Decision

| You are changing | Object |
|---|---|
| Ports, protocol, who may attach, certificates | Gateway |
| Host, path, headers, weights, timeouts | HTTPRoute |
| Cross-namespace backend or secret | ReferenceGrant in the target namespace |
| A non-HTTP port | TCPRoute or TLSRoute, or a Service load balancer |
| Whether any of this is programmed | GatewayClass and the controller process |

### You can now

- Separate listener ownership from route ownership.
- Attach an HTTPRoute with parentRefs and read status when it does not attach.
- Split traffic with weights and refuse a backend in another namespace without a ReferenceGrant.
- Put portable policy in filters, not in Ingress-style annotations.

::: quiz
q: An HTTPRoute in namespace `shop` sets parentRefs to Gateway `edge` in namespace `platform`. Apply succeeds. Requests never arrive. The route status says NotAllowedByListeners. What does that mean?
- The Service selector is wrong
+ The Gateway listener's allowedRoutes does not permit this namespace or hostname, so the route is not attached
- HTTPRoute cannot name a Gateway in another namespace
- You must also create an Ingress with the same rules
why: Apply only stores the object. Attachment is a policy on the listener. NotAllowedByListeners is that policy saying no. Cross-namespace parentRefs are valid when the listener allows them. An Ingress is a different API, not a required twin.
:::

::: quiz
q: backendRefs weight 90 to api-v1 and 10 to api-v2. api-v2's pods are all unready. What happens to about 10% of matching requests?
- They fall back to api-v1 automatically
+ They are sent at api-v2, which has no ready endpoints, so those requests fail
- The HTTPRoute is rejected and all traffic stops
- Kubernetes changes the weight to 100/0
why: Weights choose a Service. The Service still needs Ready pods. The route controller does not rewrite weights when a backend is empty. Watch the error rate before you raise the weight, and keep a readiness probe that means "I can serve".
:::

::: card
q: In the Gateway API, what is a ReferenceGrant for?
answer: It lets an object in one namespace refer to a Secret or Service in another namespace only when the target namespace opts in. Without it, a route cannot borrow a certificate or a backend it does not own. The grant lives in the target namespace.
:::

::: predict lang=python
q: Weights are relative. What does this print for how many of 100 requests go to v2?
code:
```python
def share(weight, total, requests):
    return round(requests * weight / total)

print(share(10, 100, 100))
print(share(1, 3, 90))
```
answer:
```text
10
30
```
why: 10 of 100 is ten requests. 1 of 3 is one third, so about 30 of 90. The API does not require weights to sum to 100. 90 and 10 is the same ratio as 9 and 1. Empty backends still receive their share of attempts.
:::

::: config lang=yaml
task: Write one HTTPRoute named `api` in namespace `shop`. It attaches to Gateway `edge` in namespace `platform`. Hostname `shop.example.com`. Path prefix `/api` sends weight 90 to Service `api-v1` port 80 and weight 10 to Service `api-v2` port 80.
starter:
```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api
spec:
  rules:
    - backendRefs:
        - name: api-v1
          port: 80
```
check: metadata.name = api | name
check: metadata.namespace = shop | namespace shop
check: spec.parentRefs[0].name = edge | parent gateway
check: spec.parentRefs[0].namespace = platform | gateway namespace
check: spec.hostnames[0] = shop.example.com | hostname
check: spec.rules[0].matches[0].path.type = PathPrefix | prefix
check: spec.rules[0].matches[0].path.value = /api | path /api
check: spec.rules[0].backendRefs[name=api-v1].weight = 90 | v1 weight
check: spec.rules[0].backendRefs[name=api-v2].weight = 10 | v2 weight
check: spec.rules[0].backendRefs[name=api-v2].port = 80 | v2 port
solution:
```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api
  namespace: shop
spec:
  parentRefs:
    - name: edge
      namespace: platform
  hostnames:
    - shop.example.com
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api
      backendRefs:
        - name: api-v1
          port: 80
          weight: 90
        - name: api-v2
          port: 80
          weight: 10
```
hint: parentRefs select the Gateway. hostnames and matches select requests. Each backendRef needs a name, port, and weight. The namespace on the route is metadata, not the gateway's namespace.
:::

::: quiz
q: Your team is adding a brand-new public HTTP API on a platform that already offers a Gateway. Why prefer an HTTPRoute over a new Ingress?
- Ingress was removed from Kubernetes and will not apply
+ The Gateway is already owned by the platform; an HTTPRoute is the supported way to attach your host and weights without editing listener and annotation fields you do not own
- HTTPRoute does not need a controller
- Ingress cannot terminate TLS anymore
why: Ingress still works and is not removed. The point of the Gateway API is role separation and typed fields (weights, matches, timeouts) instead of a shared object full of annotations. You still need an implementation. TLS termination on the listener stays with the Gateway.
:::

## Autoscaling pods and nodes
id: autoscale
stage: traffic
needs: scaling, resources
minutes: 40
goal: Scale workers from a queue with KEDA, and add nodes with Karpenter when pods are Pending.
source: Kubernetes: Horizontal Pod Autoscaler | https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/
source: KEDA | https://keda.sh/docs/latest/concepts/
source: Karpenter | https://karpenter.sh/docs/
@@@@
The HPA lesson scaled a web API on CPU. Two gaps remain. A worker that waits on a queue does not look busy in CPU, and it should scale to zero when the queue is empty. A pod that is Pending does not create a node. Something else has to buy the computer. KEDA covers the first gap. Karpenter, on AWS, covers the second for many new clusters. The cluster autoscaler still exists and still scales predefined node groups. Know which one your cluster runs before you debug a Pending pod.

### The problem

A Deployment of invoice workers has three replicas all night because the minimum is three. The queue is empty. You are paying for idle pods and for the nodes under them. In the morning a million messages arrive. CPU is low because each worker blocks on the vendor API. The CPU HPA does nothing. Messages age out. The metric you care about is the queue length, and the action you want at zero is "no pods", which a CPU HPA cannot do because it would have no pods left to measure.

### KEDA

KEDA is a controller you install. A `ScaledObject` names a Deployment and a trigger (SQS, Kafka, Redis, Prometheus, a cron). KEDA feeds an HPA, or acts as one, so the replica count follows the trigger. `minReplicaCount: 0` is legal. When the queue is empty, the Deployment scales to zero. When a message arrives, KEDA brings a pod back. That cold start is the cost. Do not scale a user-facing API to zero and expect the first request to be fast.

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: invoices
spec:
  scaleTargetRef:
    name: invoices
  minReplicaCount: 0
  maxReplicaCount: 30
  cooldownPeriod: 300
  triggers:
    - type: aws-sqs-queue
      metadata:
        queueURL: https://sqs.eu-central-1.amazonaws.com/123/invoices
        queueLength: "5"
```

`queueLength: "5"` means one replica per five messages, in the SQS scaler's contract. Read the scaler's docs. They differ. The pod that KEDA runs still needs IAM to read the queue, which is Pod Identity, not a key in the ScaledObject. Do not put cloud credentials in the ScaledObject metadata.

`cooldownPeriod` stops scale-to-zero from flapping between messages. A worker that takes a minute to boot wants a longer cooldown than a worker that is instant. Polling interval too slow means the queue waits. Too fast means API rate limits on the cloud queue API.

KEDA does not replace readiness, resources, or the PDB. A worker that cannot shut down mid-message needs the SIGTERM handling from the probes lesson, and a long grace period. Scaling in is a voluntary disruption of a sort: the HPA lowers replicas and the Deployment deletes pods. A PDB can block that delete. Then you never scale in. Set the budget so losing one worker is allowed, or accept that the minimum is what you drain to.

### Nodes

Pending pods with Insufficient cpu are a node problem. The classic cluster autoscaler watches for Pending pods and adds a node to an Auto Scaling group that you defined in advance (instance type, zone, max size). If the pod does not fit any group, it stays Pending. You manage the groups.

Karpenter watches Pending pods and picks an instance type that fits the requests, then launches it. You write NodePools: limits on total CPU, which instance families, which zones, taints. It can also consolidate: move pods and delete underused nodes. Consolidation evicts pods. It honors PDBs. A PDB of minAvailable equal to replicas blocks consolidation forever, and you pay for the node. That interaction is the rollouts lesson again.

EKS Auto Mode, for clusters that turn it on, runs a Karpenter-based node lifecycle for you. You still write requests that tell the truth. A BestEffort pod looks like it needs nothing, so the node it lands on may be too small the moment it uses memory. Requests are the autoscaler's only view of demand.

### A picture

```text
queue depth ──▶ KEDA ──▶ Deployment.replicas
                              │
                              ▼
                         pods Pending ──▶ Karpenter ──▶ new node
                              │
                         pods Ready
```

Two loops, two metrics. Do not point both at CPU and hope.

### Where it breaks

**Scale to zero and a probe that runs a cron inside the pod.** There is no pod. The cron is dead. Use a CronJob or a KEDA cron trigger.

**maxReplicaCount above the ResourceQuota.** The HPA sets a number the quota rejects. Replicas stay low, events say exceeded quota, and the queue grows. Align them.

**Karpenter cannot satisfy a hostname anti-affinity plus a zonal volume.** The pod is unschedulable for a reason no instance type fixes. Read the event. Adding a bigger instance does not add a second copy of a ReadWriteOnce disk in another zone.

**Consolidation during a bad rollout.** New pods are not Ready, the PDB is already unhappy, consolidation wants to evict more. Pause consolidation or fix the rollout. Do not delete the PDB as the first move.

### At work

Web APIs: HPA on a metric that matches load, minimum high enough for a zone loss, Karpenter or a managed node pool underneath. Workers: KEDA on the queue, minimum zero only if the cold start is acceptable, IAM via Pod Identity. The cost lesson in the cloud module is the bill for the nodes Karpenter bought because a request was ten times the real usage. Fix the request. Do not only raise the NodePool limit.

### You can now

- Say why a CPU HPA misses a queue worker and cannot scale to zero.
- Point a ScaledObject at a Deployment and a queue, without embedding cloud keys.
- Explain that Pending is a node autoscaler's input, not the HPA's failure.
- Contrast Karpenter's instance choice with an Auto Scaling group's fixed groups.
- Keep PDBs and quotas compatible with scale-in and with the maximum replicas.

### How this sits next to the HPA lesson

You already wrote an HPA that tracks CPU and a formula that turns a ratio into a replica count. This lesson is the rest of the picture. The HPA changes the pod count from a metric. The Vertical Pod Autoscaler recommends or patches requests and limits. It must not fight an HPA on the same resource. Do not let VPA rewrite CPU requests while an HPA scales on CPU utilization of those requests. KEDA writes an HPA for you from an external signal such as queue length, and it can scale to zero where a CPU HPA minimum would have stayed at one. The cluster autoscaler and Karpenter add and remove nodes when pods are Pending because of resources. They do not change the Deployment replica count. A Pending pod because of a ResourceQuota is not a node problem. A Pending pod because every node has insufficient CPU is.

Read events in that order. If the HPA cannot compute, fix the request. If it raises replicas and pods stay Pending, look at the quota and then at nodes. If the queue is the real load and CPU is idle, a CPU HPA will not scale, and KEDA is the right controller. The worker steps later in this lesson are that case.

### You can now

- Pick HPA, VPA, KEDA, or a node autoscaler by which number is actually wrong.
- Refuse two controllers on the same replica field or the same CPU request.
- Treat scale-to-zero as a KEDA decision, not as a CPU HPA with a minimum of zero.

::: quiz
q: A worker Deployment uses a CPU HPA with minReplicas 1. The queue is empty and CPU is near zero. Why does it not scale to zero?
- Because Deployments cannot have zero replicas
+ Because a CPU HPA needs running pods to measure, and this configuration's minimum is 1. Scale-to-zero wants a metric that exists when no pods exist, which is what KEDA's queue trigger provides
- Because Karpenter forbids zero
- Because readiness probes block scale-in
why: The HPA's minimum is a floor, and CPU utilization is not defined for an empty set of pods in a way that lets the ordinary CPU scaler turn the last one off. KEDA's external trigger can set the count to zero and raise it when the queue is non-empty. Karpenter is about nodes. Readiness does not set replicas.
:::

::: quiz
q: Pods are Pending, the HPA is at the replica count you expected, and the event is Insufficient memory. Which controller should act next on a cluster that runs Karpenter?
- The HPA, by lowering requests automatically
+ Karpenter, by launching a node that fits the pending pod's requests
- The NetworkPolicy controller
- The ExternalSecret controller
why: The replica count is already right. The scheduler cannot place the pod. Karpenter's job is to add a node for unschedulable pods. The HPA does not edit requests. Network policy and secrets do not add memory.
:::

::: card
q: What is the difference between the cluster autoscaler and Karpenter?
answer: The cluster autoscaler adds or removes nodes inside Auto Scaling groups you predefined (instance types and sizes). Karpenter chooses an instance type that fits the pending pod's requests and launches it, within a NodePool's limits. Both react to unschedulable pods. Neither fixes a pod that cannot ever schedule, such as a volume stuck in another zone.
:::

::: predict lang=python
q: One replica per `per` messages, clamped, and zero when the queue is empty. What does this print?
code:
```python
def replicas(messages, per, maximum):
    if messages <= 0:
        return 0
    return min(maximum, (messages + per - 1) // per)

print(replicas(0, 5, 30))
print(replicas(5, 5, 30))
print(replicas(6, 5, 30))
print(replicas(1000, 5, 30))
```
answer:
```text
0
1
2
30
```
why: Empty queue is zero replicas, which a CPU scaler would not do. Five messages at one replica per five is one pod. Six rounds up to two. A thousand would be two hundred, so the maximum of 30 holds and the rest of the queue waits. That maximum should match the namespace quota.
:::

::: config lang=yaml
task: Write a KEDA ScaledObject named `invoices` that scales Deployment `invoices` from 0 to 20 replicas with cooldown 300, trigger type `aws-sqs-queue`, queueURL `https://sqs.eu-central-1.amazonaws.com/123/invoices`, and queueLength `10`. Do not put access keys in the object.
starter:
```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: invoices
spec:
  minReplicaCount: 3
  maxReplicaCount: 3
```
check: metadata.name = invoices | name
check: spec.scaleTargetRef.name = invoices | target deployment
check: spec.minReplicaCount = 0 | scale to zero
check: spec.maxReplicaCount = 20 | max 20
check: spec.cooldownPeriod = 300 | cooldown
check: spec.triggers[0].type = aws-sqs-queue | sqs trigger
check: spec.triggers[0].metadata.queueURL = https://sqs.eu-central-1.amazonaws.com/123/invoices | queue url
check: spec.triggers[0].metadata.queueLength = "10" | length 10
solution:
```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: invoices
spec:
  scaleTargetRef:
    name: invoices
  minReplicaCount: 0
  maxReplicaCount: 20
  cooldownPeriod: 300
  triggers:
    - type: aws-sqs-queue
      metadata:
        queueURL: https://sqs.eu-central-1.amazonaws.com/123/invoices
        queueLength: "10"
```
hint: scaleTargetRef.name is the Deployment. The minimum is 0 so an empty queue can park. The queue URL and length live under the trigger's metadata, not in an env secret.
:::

::: write lang=python
task: Implement `replicas(messages, per, maximum)`. Return 0 when messages is 0. Otherwise return the minimum of maximum and the number of pods needed so each handles at most `per` messages, rounding up.
starter:
```python
def replicas(messages, per, maximum):
    return maximum
```
tests:
```python
from solution import replicas

def test_zero():
    assert replicas(0, 5, 30) == 0

def test_round():
    assert replicas(6, 5, 30) == 2

def test_cap():
    assert replicas(1000, 5, 30) == 30
```
solution:
```python
def replicas(messages, per, maximum):
    if messages <= 0:
        return 0
    need = (messages + per - 1) // per
    return min(maximum, need)
```
hint: Guard the empty queue first. Integer round-up is `(messages + per - 1) // per`. Then clamp to the maximum.
:::

## RBAC and ServiceAccounts
id: rbac
stage: guard
needs: security-k8s
minutes: 40
goal: Bind a ServiceAccount to a Role that allows only the verbs and resources that workload needs, and prove it with a mental can-i.
source: Kubernetes: Using RBAC authorization | https://kubernetes.io/docs/reference/access-authn-authz/rbac/
source: Kubernetes: RBAC good practices | https://kubernetes.io/docs/concepts/security/rbac-good-practices/
@@@@
Every call to the API server is authenticated and then authorized. kubectl uses your user. A pod uses its ServiceAccount token. RBAC is the authorization part: rules that say which verb may touch which resource. It does not filter packets, and it does not stop a process from using a cloud key that is sitting in an environment variable. It stops the API.

### The problem

The quick way to "make the operator work" is to bind `cluster-admin`. The operator, or the app, can then list every Secret in the cluster, create ClusterRoleBindings, and delete nodes. A bug that lets a user reach that process is a cluster compromise. The slower way is a Role in one namespace with one resource and one verb. Start there. Widen it when `can-i` says no and you agree with the request.

### The four objects

**ServiceAccount** is a name in a namespace. Pods select it with `spec.serviceAccountName`. If you omit it, they get `default`, and they all share that account's rights.

**Role** is a set of rules in one namespace. **ClusterRole** is the same list, usable cluster-wide or reused in many namespaces.

**RoleBinding** grants a Role or ClusterRole inside one namespace to a subject (user, group, or ServiceAccount). **ClusterRoleBinding** grants a ClusterRole across the whole cluster. A ClusterRoleBinding to cluster-admin is the sharpest object in the system. Do not create one for an app.

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: api
  namespace: shop
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: api-config
  namespace: shop
rules:
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: api-config
  namespace: shop
subjects:
  - kind: ServiceAccount
    name: api
    namespace: shop
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: api-config
```

`apiGroups: [""]` is the core group (pods, configmaps, secrets, services). Apps are `apps`. A typo in the group means the rule never matches and you "fix" it by granting `*`. `verbs` do not imply each other. `get` is not `list`. `list` is not `watch`. `create` is not `update`. `deletecollection` is not `delete`. Grant the verb the client code actually calls.

`resourceNames` limits a rule to named objects. It works for get, update, delete, and patch. It does not work the way people hope for list: list returns the collection, and the API server does not filter list down to one name for you in every version of this story. If the app lists secrets, assume it sees all of them in the namespace. Split namespaces if two apps must not see each other's secrets.

### can-i

`kubectl auth can-i get configmaps -n shop --as=system:serviceaccount:shop:api` answers as that account. Use it before you ship the binding. Forbidden in a controller log is the same question after you shipped. Check the pod's `serviceAccountName` first. You may be testing your admin user, who can get everything, while the pod cannot.

Bindings are additive. There is no deny rule in RBAC. You cannot grant list and then deny one Secret. The only fix is to not grant list, or to put that Secret in another namespace.

### Where it breaks

**roleRef is immutable.** A wrong Role name in a binding means delete and recreate the binding. Editing it is rejected.

**The token is still mounted.** `automountServiceAccountToken: false` on the ServiceAccount or the pod stops the projection. Set it on pods that do not call the API. A token you do not need cannot be stolen from the filesystem. Pods that call the API should use the projected token (audience and expiry), which modern Kubernetes mounts by default, not a long-lived static token Secret. Static ServiceAccount token Secrets are the old mechanism. Do not create them.

**Wildcard ClusterRoles copied from a blog.** `verbs: ["*"]` on `resources: ["*"]` is cluster-admin with extra steps. Read the rule out loud.

**User-facing kubectl using the pod's identity.** Do not. Humans use their own identity (OIDC, IAM). Pods use ServiceAccounts. Sharing one kubeconfig with a CI robot and a human mixes audit trails.

### At work

Platform teams grant namespace admin to a team group via a RoleBinding, not cluster-admin. CI applies with a pipeline identity that can update Deployments in that namespace and cannot read secrets if Git already has no business reading them. Operators get a dedicated account whose Role matches the client-go calls in the code. When you review a ClusterRoleBinding, you are reviewing a cluster-wide key. Most of them should not exist.

EKS access to the Kubernetes API is a separate layer (access entries or the older aws-auth). That decides which IAM principal is which Kubernetes user. RBAC then decides what that user may do. Passing IAM auth and failing RBAC looks like Forbidden, not like an AWS error. The cloud module's IAM lesson is the other side of the same call.

### You can now

- Point at a ServiceAccount, a Role, and a RoleBinding and say which problem each solves.
- Write a rule with the core apiGroup, one resource, and the verbs you mean.
- Explain why there is no RBAC deny, and why list is broader than get.
- Use the idea of `can-i --as` the ServiceAccount, not your own user.
- Turn off automount when the pod does not call the API.

### A request, and the four things that must line up

A pod calls the API with its ServiceAccount token. The apiserver authenticates the token, then authorizes the verb. Authorization looks for a RoleBinding or ClusterRoleBinding that binds that subject to a Role or ClusterRole whose rules allow the verb on the resource in that namespace. Miss any one of those and the answer is forbidden. Forbidden is not "the ServiceAccount does not exist." It is "nothing bound to this identity allows this."

A Role is namespaced. A ClusterRole is not. A RoleBinding in `shop` can bind a ClusterRole, and the permission then applies only in `shop`. That is how you reuse a "read configmaps" ClusterRole without granting it in every namespace. A ClusterRoleBinding grants it everywhere. Application teams should not get ClusterRoleBindings. The platform does, for controllers that are genuinely cluster-scoped.

Rules are group, resource, verbs. Core configmaps are group `""`. `apps` Deployments are group `apps`. A rule on `pods` does not include `pods/log`. A rule on `secrets` with `get` lets the caller read secret data. There is no "list but hide the values." `list` and `watch` on secrets are how a token becomes a copy of every secret in the namespace. The invoices API that only needs a configmap should not have them.

### Where it breaks

The default ServiceAccount in the namespace is what you get when you set no `serviceAccountName`. Binding a Role to `default` grants it to every pod that forgot the field. Create a ServiceAccount per workload and bind that. Set `automountServiceAccountToken: false` on `default` if you can.

Wildcards. `verbs: ["*"]` and `resources: ["*"]` are cluster-admin in a costume. They show up in helm charts "for convenience." Delete them. Name the verbs. If the chart breaks, you learned what it actually does.

Impersonation and escalate are verbs that let a caller become someone else or change RBAC. They do not belong on an app role. A controller that must create RoleBindings needs a carefully scoped rule, not `*`.

User-facing kubectl uses your user or group, not the pod's ServiceAccount. A test that works as you and fails in the pod is the binding, not the network. `kubectl auth can-i get configmaps --as=system:serviceaccount:shop:api -n shop` is the check.

### At work

Each app's chart creates a ServiceAccount, a Role with the verbs it demonstrated it needs, and a RoleBinding. The demonstration is an audit log or an Access Review, not a guess of `*`. CI runs a policy that forbids ClusterRoleBinding in app overlays and forbids `secrets` in app Roles unless the ticket says the workload reads Kubernetes secrets on purpose. Workloads that only need a cloud secret should use Pod Identity or an ExternalSecret that writes one Kubernetes Secret, and the pod should mount that Secret, not list the secrets API.

### Decision

| Need | Grant |
|---|---|
| Read config in one namespace | Role, get/list on configmaps, bind the app ServiceAccount |
| Same read in many namespaces | ClusterRole plus a RoleBinding per namespace |
| Controller for the whole cluster | ClusterRoleBinding, platform-owned |
| Cloud API | IAM via Pod Identity, not a Kubernetes secret list |
| Debug as the app | kubectl auth can-i --as the ServiceAccount |

### You can now

- Trace subject, binding, role, and rule for a forbidden error.
- Keep app permissions in RoleBindings.
- Refuse secret list and verb wildcards on application accounts.
- Check the ServiceAccount the pod actually uses, not your own user.

::: quiz
q: A Role allows get on secrets, and a RoleBinding binds it to ServiceAccount `api` in namespace `shop`. Can that account list secrets in `shop`?
- Yes. get includes list
+ No. list is a different verb, and RBAC does not imply it
- Yes, but only secret names, not data
- Only if the pod is privileged
why: Verbs are explicit. get reads one object by name. list reads the collection. An app that lists will get Forbidden until you add list, and adding list lets it see every secret in the namespace. Privileged pods are a Pod Security concern, not an extra RBAC verb.
:::

::: quiz
q: You want the app to call the API in namespace `shop` only. Which binding do you create?
- A ClusterRoleBinding to cluster-admin, limited by the namespace field
+ A RoleBinding in `shop` that references a Role (or a ClusterRole) and the app ServiceAccount
- A Role in kube-system
- No binding. The default account can already do this safely
why: A RoleBinding scopes the grant to one namespace even if the roleRef is a ClusterRole. A ClusterRoleBinding does not accept "just this namespace". The default account starts with almost nothing in current Kubernetes, but sharing it couples every pod. kube-system is the wrong place for an app Role.
:::

::: card
q: In Kubernetes RBAC, why can you not grant get on secrets and then deny one secret named `root`?
answer: RBAC rules are only allows, and they add together. There is no deny. resourceNames can narrow get/update/delete to specific objects, but the way to keep a secret from an account that can list is to put that secret in a different namespace or not grant list.
:::

::: predict lang=python
q: A call is allowed if any rule matches group, resource, and verb. What does this print?
code:
```python
rules = [
    {"group": "", "resource": "configmaps", "verbs": ["get", "list"]},
]

def allowed(group, resource, verb):
    for r in rules:
        if r["group"] == group and r["resource"] == resource and verb in r["verbs"]:
            return "yes"
    return "no"

print(allowed("", "configmaps", "get"))
print(allowed("", "secrets", "get"))
print(allowed("apps", "deployments", "get"))
```
answer:
```text
yes
no
no
```
why: The rule is core-group configmaps, get and list. Secrets are a different resource. Deployments are a different API group (`apps`), so a core-group rule does not cover them. A second rule would be required. This is the check the API server does, minus subjects and bindings.
:::

::: config lang=yaml
task: Write a Role named `reader` in namespace `shop` that allows only `get` and `list` on core `configmaps`, and a RoleBinding named `reader` that grants it to ServiceAccount `api` in `shop`.
starter:
```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: reader
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-admin
subjects:
  - kind: ServiceAccount
    name: default
    namespace: default
```
check: [kind=Role].metadata.name = reader | Role name
check: [kind=Role].metadata.namespace = shop | Role namespace
check: [kind=Role].rules[0].apiGroups[0] = "" | core api group
check: [kind=Role].rules[0].resources[0] = configmaps | configmaps only
check: [kind=Role].rules[0].verbs[0] = get | verb get
check: [kind=Role].rules[0].verbs[1] = list | verb list
check: [kind=RoleBinding].metadata.namespace = shop | binding namespace
check: [kind=RoleBinding].subjects[0].name = api | subject is api
check: [kind=RoleBinding].subjects[0].namespace = shop | subject namespace
check: [kind=RoleBinding].roleRef.kind = Role | binds a Role, not a ClusterRole
check: [kind=RoleBinding].roleRef.name = reader | roleRef name
solution:
```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: reader
  namespace: shop
rules:
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: reader
  namespace: shop
subjects:
  - kind: ServiceAccount
    name: api
    namespace: shop
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: reader
```
hint: Replace the ClusterRoleBinding with a namespaced Role and a RoleBinding. The core group is an empty string. roleRef.kind must be Role. Two documents, separated by `---`.
:::

::: write lang=python
task: Implement `can(rules, group, resource, verb)` returning True if any rule matches all three. Each rule is a dict with keys group, resource, and verbs (a list).
starter:
```python
def can(rules, group, resource, verb):
    return True
```
tests:
```python
from solution import can

RULES = [{"group": "", "resource": "configmaps", "verbs": ["get"]}]

def test_yes():
    assert can(RULES, "", "configmaps", "get") is True

def test_verb():
    assert can(RULES, "", "configmaps", "list") is False

def test_resource():
    assert can(RULES, "", "secrets", "get") is False
```
solution:
```python
def can(rules, group, resource, verb):
    return any(
        r["group"] == group and r["resource"] == resource and verb in r["verbs"]
        for r in rules
    )
```
hint: All three fields must match the same rule. A different verb on the right resource is still False. any() over the rules is the additive allow.
:::

## NetworkPolicy
id: netpol
stage: guard
needs: services, security-k8s
minutes: 40
goal: Deny traffic by default and allow only DNS plus the peers you can name.
source: Kubernetes: Network policies | https://kubernetes.io/docs/concepts/services-networking/network-policies/
@@@@
A Service name is not a firewall. Any pod that can resolve DNS can open a connection to a ClusterIP unless something in the dataplane drops the packet. NetworkPolicy is that rule, enforced by the CNI plugin (Calico, Cilium, the VPC CNI with network policy enabled). The API object is only a request. If the plugin is not installed, `kubectl apply` succeeds and nothing is enforced. kind does not enforce policies until you add a plugin. Check that before you trust a test.

### The problem

The shop namespace runs an API and a database. The API should call the database and CoreDNS. It should not call the metadata service, the production billing namespace, or the internet. The database should accept connections only from the API. With no policy, all of those paths work. You will not see a denial in the API server audit log, because this is not an API call.

Policies select pods with `podSelector`. An empty `podSelector: {}` selects every pod in the namespace. Once any policy selects a pod, that pod is isolated for the direction the policy covers: if you write an ingress rule, non-matching ingress is denied; if you write an egress rule, non-matching egress is denied. A policy that only lists ingress does **not** deny egress. Default deny means two policies, or one policy object with empty ingress and empty egress lists, depending how you write it.

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny
  namespace: shop
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
```

An empty ingress and egress (the fields omitted) plus both policy types means: no ingress, no egress, for every pod. You then add allows. Order does not matter. Policies are additive allows inside a direction that has been locked. There is no "deny this one IP" override that beats an allow. If you need a deny exception, the model is wrong for that rule; narrow the allow instead.

### Allow DNS and the database

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api-egress
  namespace: shop
spec:
  podSelector:
    matchLabels:
      app: api
  policyTypes: [Egress]
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
    - to:
        - podSelector:
            matchLabels:
              app: db
      ports:
        - protocol: TCP
          port: 5432
```

DNS is easy to forget and the failure looks like "the database name does not resolve", which people debug as a Service bug. Allow both UDP and TCP 53. The kube-dns labels depend on the cluster. On many clusters the pods are in `kube-system` with `k8s-app: kube-dns`. Confirm the labels. `namespaceSelector` plus `podSelector` in the **same** `to` entry is AND. Two list items are OR. Putting them as two entries allows the whole namespace or the whole pod label in your own namespace, which is wider than you think.

`ipBlock` can allow a CIDR and exclude the metadata address `169.254.169.254/32` with `except`. Prefer not giving the pod a route to IMDS at all, at the node, and also except it here if the pod has a wide CIDR. A policy does not replace a narrow node role.

Ingress to the database:

```yaml
podSelector:
  matchLabels:
    app: db
policyTypes: [Ingress]
ingress:
  - from:
      - podSelector:
          matchLabels:
            app: api
    ports:
      - protocol: TCP
        port: 5432
```

`from` a podSelector without a namespaceSelector means pods in **this** namespace. The API in another namespace does not match. Add a namespaceSelector when the caller is elsewhere, on purpose.

### What a policy does not see

It does not understand Service names. It sees pods, namespaces, ports, and IPs. "Allow Service db" is the wrong sentence. Allow pods labelled `app: db` on port 5432.

It does not terminate TLS and does not identify a workload by a certificate. That is a mesh or an application auth problem. NetworkPolicy is a coarse door.

Host-network pods are a special case the plugin may not filter the way you expect. Avoid hostNetwork for apps. The restricted standard already pushes you that way.

### Where it breaks

**The plugin is off.** Prove enforcement with a connection that should fail, from a debug pod. A policy that "works" because you never tested the deny is not a control.

**You locked egress and the API cannot reach the webhook or the IdP.** Add the allow before you call it an outage. Readiness will fail and the rollout will stick.

**Label changes.** The policy selects labels. A new pod without `app: api` is either unprotected (if nothing selects it) or fully denied (if a namespace-wide deny selects it and no allow does). The deny-all plus specific allows is the pattern that fails closed.

### At work

Every application namespace ships a default-deny in the platform template. App teams add a small egress policy in the same pull request as the new client call. Reviewers ask "what new destination is this?" The cloud security groups are a second layer for node-to-node traffic; they do not replace the namespace policy, because two pods on one node talk on the virtual network the security group may not see the way you think. Defense in depth means both, not "the VPC will save us".

### You can now

- Write a namespace default-deny for ingress and egress.
- Allow DNS explicitly, UDP and TCP.
- Say that podSelector and namespaceSelector in one entry are ANDed.
- Explain why a policy does not name a Service.
- Refuse to trust a policy until the CNI is enforcing and a deny has been observed.

### Empty means deny, once a policy selects the pod

A NetworkPolicy is a namespace object. It selects pods with a label selector. For those pods, if the policy has `policyTypes: ["Ingress"]` and no ingress rules, ingress is denied. The same for egress. Pods that no policy selects are unaffected. A "default deny" is a policy that selects all pods and allows nothing. It does not apply to pods created later in a different namespace. It does not apply until the CNI enforces NetworkPolicy. Some CNIs do not. A policy on a cluster whose CNI ignores it is a document, not a control. Know the CNI before you trust the YAML.

Rules are additive. Two policies that select the same pod both contribute allows. You cannot write an exception that punches a hole in a deny rule inside one policy by writing a second deny. You write a narrow allow. The default-deny policy has no allows. A second policy selects the API pods and allows ingress from the ingress controller's pods on port 8000, and egress to the database pods on 5432 and to DNS.

DNS is the rule people forget. Egress deny without a DNS allow breaks every lookup, and the error looks like an application bug. CoreDNS usually lives in `kube-system`. Allow egress to it on UDP and TCP 53, from the pods that must resolve names. Do not allow all egress to "make DNS work."

### Where it breaks

Label selectors that do not match. The policy selects `app: api` and the pods are labelled `app: invoices`. The policy is green and does nothing to those pods. If a default-deny selects all pods, the allow that selects the wrong label does not open anything, and the pods stay dark. `kubectl describe networkpolicy` and the pod labels belong in the same glance.

Namespace selectors versus pod selectors. Allowing a whole namespace is wider than allowing a pod label. Prefer pod selectors for the database. Use a namespace selector when the source pods do not share a label you own, and accept the width.

Policies are not retroactive magic on established connections in every CNI the same way, and they are not a firewall against the node. HostNetwork pods and the node itself are special. Do not assume a policy protects a pod that uses host networking.

Services and Ingress still need endpoints. A policy that blocks the ingress controller from the pod looks like an Ingress 504. The Ingress object is fine. The hop from the controller's pod to the app pod is what you blocked. Allow that source.

### At work

Every app namespace is created with a default-deny. The app chart adds the allows it needs: ingress from the platform ingress namespace, egress to its database, egress to DNS. Reviews reject `0.0.0.0/0` egress except for a documented proxy. The test is a pod that should fail to reach the internet and succeed to the database. If you cannot run that test, you do not know the policy works. `kubectl exec` curl from a debug pod is the test, then you delete the debug pod, because a debug pod with a wide policy is a back door someone will forget.

### Decision

| Intent | Policy |
|---|---|
| Nothing talks unless allowed | default-deny selecting all pods, both policy types |
| API accepts only the proxy | ingress from the controller's pods on the app port |
| API opens only the database | egress to the db pods on the db port, plus DNS |
| A vendor chart needs the internet | a specific egress, or a different namespace, not deleting default-deny |
| The CNI does not implement policies | fix the CNI before you claim the namespace is locked |

### You can now

- Make deny the default for a namespace without affecting pods you did not select.
- Open DNS on purpose when you deny egress.
- Debug a 504 by checking whether the proxy pods are an allowed source.
- Stack allows, because policies do not express "deny this one peer."

::: quiz
q: A namespace has one NetworkPolicy. It selects the API pods and specifies ingress from the gateway, and it does not set policyTypes to Egress. Can the API pods open outbound connections?
- No. Any NetworkPolicy blocks all egress from the namespace
+ Yes. Isolation applies only to the directions the policy covers. Egress is still open
- No. Selecting the pod always implies default deny both ways
- Only to ClusterIP Services
why: A policy that covers ingress locks ingress for the selected pods. Egress stays allowed until a policy selects those pods and covers egress. You need both policy types for a real default deny. ClusterIP versus external is not the distinction the API makes; ports and peers are.
:::

::: quiz
q: In one `to` entry you set namespaceSelector to kube-system and podSelector to the DNS label. What traffic matches?
- Any pod in kube-system, or any pod in this namespace with the DNS label
+ Only pods that are in kube-system and carry the DNS label
- Only Services named kube-dns
- Nothing. The fields are mutually exclusive and the policy is rejected
why: Selectors combined in a single array element are a conjunction. Two separate `to` elements would be a disjunction, which is much wider. The policy matches pods, not the Service object named kube-dns, even though that Service is how clients find those pods.
:::

::: card
q: You applied a NetworkPolicy on a kind cluster that has no network-policy controller. What is enforced?
answer: Nothing. The API stores the object, and only a CNI plugin that implements NetworkPolicy drops packets. Confirm enforcement by attempting a connection that the policy should deny. A successful apply is not a test.
:::

::: predict lang=python
q: Default deny is on. An allow matches only when the peer label is api and the port is 5432. What does this print?
code:
```python
def allow(label, port):
    if label == "api" and port == 5432:
        return "open"
    return "drop"

print(allow("api", 5432))
print(allow("api", 443))
print(allow("other", 5432))
```
answer:
```text
open
drop
drop
```
why: Both the peer and the port must match. The API calling the database port is open. The same pod calling 443 is dropped, which is what stops it from dialing the internet if you did not allow that port. A different label on the right port is still dropped, so a second app does not inherit the database allow.
:::

::: config lang=yaml
task: Write a NetworkPolicy named `default-deny` in namespace `shop` that selects every pod and sets policy types Ingress and Egress, with no allow rules.
starter:
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-all
spec:
  podSelector:
    matchLabels:
      app: api
  policyTypes:
    - Ingress
  ingress:
    - {}
```
check: metadata.name = default-deny | name
check: metadata.namespace = shop | namespace
check: spec.podSelector count 0 | empty selector means all pods
check: spec.policyTypes[0] = Ingress | ingress type
check: spec.policyTypes[1] = Egress | egress type
check: spec.ingress missing | no ingress rules
check: spec.egress missing | no egress rules
solution:
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny
  namespace: shop
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
```
hint: Use an empty podSelector map, name both policyTypes, and do not add an ingress list. An ingress item of `{}` allows all ingress.
:::

::: config lang=yaml
task: Write a NetworkPolicy named `db-in` in namespace `shop` that selects pods `app: db` and allows ingress from pods `app: api` on TCP port 5432 only.
starter:
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: db-in
  namespace: shop
spec:
  podSelector:
    matchLabels:
      app: api
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: db
```
check: metadata.name = db-in | name
check: spec.podSelector.matchLabels.app = db | selects the database pods
check: spec.ingress[0].from[0].podSelector.matchLabels.app = api | source is the api pods
check: spec.ingress[0].ports[0].protocol = TCP | TCP
check: spec.ingress[0].ports[0].port = 5432 | port 5432
solution:
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: db-in
  namespace: shop
spec:
  podSelector:
    matchLabels:
      app: db
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: api
      ports:
        - protocol: TCP
          port: 5432
```
hint: The podSelector on the policy is the database, the one under from is the caller. Add the TCP port. The starter has those two labels swapped.
:::

::: write lang=python

task: Implement `verdict(default_deny, allowed_peers, peer, port, allowed_port)`. If default_deny is false, return "open". If the peer is in allowed_peers and the port equals allowed_port, return "open". Otherwise return "drop".
starter:
```python
def verdict(default_deny, allowed_peers, peer, port, allowed_port):
    return "open"
```
tests:
```python
from solution import verdict

def test_no_policy():
    assert verdict(False, [], "stranger", 443, 5432) == "open"

def test_allow():
    assert verdict(True, ["api"], "api", 5432, 5432) == "open"

def test_drop():
    assert verdict(True, ["api"], "api", 443, 5432) == "drop"
```
solution:
```python
def verdict(default_deny, allowed_peers, peer, port, allowed_port):
    if not default_deny:
        return "open"
    if peer in allowed_peers and port == allowed_port:
        return "open"
    return "drop"
```
hint: Without default deny nothing is filtered. With it, both the peer and the port must match. Any other pair drops.
:::

## ResourceQuota and LimitRange
id: quotas
stage: guard
needs: resources
minutes: 35
goal: Cap a namespace's total requests and force every container to declare limits so one team cannot take the cluster.
source: Kubernetes: Resource quotas | https://kubernetes.io/docs/concepts/policy/resource-quotas/
source: Kubernetes: Limit ranges | https://kubernetes.io/docs/concepts/policy/limit-range/
@@@@
Requests decide whether a pod fits on a node. They do not decide whether the team has used more cluster than they paid for. A namespace with no quota can schedule until every node is full, including the nodes the other team needed. ResourceQuota is the cap on the namespace. LimitRange is the default and the min/max for each pod or container. You want both. A quota without a limit range is a trap.

### The problem

A bug creates pods in a loop, or a user asks for 128 GiB by typo. The scheduler does its job and places what fits. The rest sit Pending and block the autoscaler, or they fit and evict your API. The fix is admission: refuse the object before it is stored, with a message the user can read.

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: shop
  namespace: shop
spec:
  hard:
    requests.cpu: "4"
    requests.memory: 8Gi
    limits.cpu: "8"
    limits.memory: 16Gi
    pods: "20"
```

The quota adds up **requests and limits from the pod spec**, not live usage. A pod that requests 1 CPU counts as 1 even when it is idle. That is what you want: the reservation is the cost. `pods` counts objects so a loop fails at 20 instead of at 5000 etcd writes.

If the quota tracks `limits.cpu` and a new pod has no CPU limit, admission **rejects** it. The quota cannot add a missing number. This is the trap. Teams set a quota, deploys start failing, and someone deletes the quota. The right companion is a LimitRange that defaults the limit.

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: defaults
  namespace: shop
spec:
  limits:
    - type: Container
      default:
        cpu: 500m
        memory: 256Mi
      defaultRequest:
        cpu: 100m
        memory: 128Mi
      max:
        cpu: "2"
        memory: 2Gi
      min:
        memory: 32Mi
```

`default` fills in limits when the container omitted them. `defaultRequest` fills in requests. `max` rejects a container that asks for more. `min` rejects one that asks for less. A type `Pod` limit applies to the sum. Containers that already set a value keep it. The default does not override an explicit request.

After the LimitRange exists, a pod you apply may show requests you did not write. Describe it before you argue with the scheduler. The number in etcd is the number that counts against quota.

### What quota will not do

It will not kill a running pod that bursts up to its limit. The limit and the OOM killer do that. Quota is admission.

It will not balance fairness inside the namespace. Ten Deployments share one quota. A noisy one can consume it. Split namespaces when two groups must not share a budget.

It will not see DaemonSets the way you might hope if those DaemonSets run in another namespace (`kube-system`). Node pressure is still a node problem. Quota is a tenant problem.

`scopes` can limit a quota to BestEffort or to pods with a priority class. The default scope is "everything in the namespace", which is what you want until you know why you need a split.

### Where it breaks

**Quota on limits, no LimitRange, containers with only requests.** Rejected. Add the range or add the limits. Do not drop the quota.

**Defaults higher than max.** The range is invalid or every pod fails. Read the LimitRange before you debug the Deployment.

**Counting the sidecar.** The mesh proxy's requests count. A quota sized from the app container alone fills up when the sidecar is injected. Include it.

**Jobs that complete.** Finished pods may still count until they are gone. `ttlSecondsAfterFinished` from the Jobs lesson is how you get the quota back. A namespace full of succeeded pods is a quota incident.

### At work

The platform sets a quota from the team's budget and a LimitRange so a forgotten resources block still lands in Burstable with a sane default. The error `exceeded quota` is a planning conversation, not a pager to delete the quota. Raise it when the request is real. The cloud cost lesson is the same budget in currency: CPU requests are what the cluster autoscaler buys.

### You can now

- Explain why quota sums requests, not CPU usage.
- Say why a limits quota without a LimitRange rejects pods that omit limits.
- Set default, defaultRequest, min, and max on a container LimitRange.
- Predict that a succeeded Job still occupies quota until its pods are removed.
- Treat exceeded quota as admission, not as a crash.

### What the quota counts

A ResourceQuota is a budget on a namespace. The apiserver admits a pod only if the sum of the requests (and the limits, if you quota those) still fits. It does not look at usage. A namespace can be under its quota and still OOM on a node, and it can be unable to schedule a new pod while CPU graphs look idle, because the quota is about what was requested, not what is burning. That is the same truth as the scheduler, one level up.

`pods: "10"` counts pods, including the ones that are Pending. A crash loop does not free the count. A Job that creates pods faster than they finish will hit the quota and sit. `requests.cpu` and `requests.memory` are the sums of container requests. A pod with no request uses the LimitRange default if there is one, and otherwise may count as zero or be rejected if the quota requires requests. Do not leave that implicit. A LimitRange default request makes the quota mean something.

Limits can be quota'd separately (`limits.cpu`, `limits.memory`). A team that sets huge limits and tiny requests will pass a request quota and still threaten the node. Quota the limits if you do not trust the template. Count/configmaps/secrets/services exist so a bug cannot create ten thousand Services. The ones that matter for an app namespace are pods, requests, and often persistentvolumeclaims.

### LimitRange is not a quota

A LimitRange sets default, min, and max on a container. It does not cap the namespace. Ten containers each at the max are ten times the max. The quota caps the ten. The LimitRange stops one container from asking for more than a node, and it fills in defaults so a pod without resources still consumes quota honestly. You want both. A quota without defaults lets a pod with empty resources sneak in as zero. Defaults without a quota let a loop create a thousand default-sized pods.

A max below a default is rejected. A default request above a default limit is rejected. Read the object if pods start failing admission with a LimitRange error. The message names the container and the resource. It is not a scheduler Insufficient message. The pod never got that far.

### Where it breaks

A quota of 2 CPU in a namespace that runs a DaemonSet's pods is wrong, because DaemonSets are per node and the quota is per namespace. Cluster agents belong in a namespace you do not quota like an app, or you exempt them. Putting the app and the agents together makes a node scale-up fail admission for the agent or for the app, depending on who asked first.

Raising the quota in Git is the change. Editing it on the cluster is drift the next apply will revert if GitOps is on. A quota that is "temporarily" higher in prod than in Git is a incident waiting for the next sync.

Requests that are larger than the quota fail even when the namespace is empty. The pod spec is the problem, not the other tenants. HPA that scales to 20 with a 200m request needs 4 CPU of quota. If the quota is 2 CPU, the HPA's desired count is fiction. The pods stay Pending and the metric may drop because the extra pods never ran, so the HPA looks stable while you are under-served. Size the quota for the HPA maximum, not for the current replica count.

### At work

Each tenant namespace is created with a quota and a LimitRange from a template. The numbers come from the ticket, not from copying production into a sandbox. Billing and fairness are the reasons, and so is a runaway Job. The review of an app change includes "does the new request times the HPA max still fit?" If it does not, the quota change is part of the same pull request, approved by the people who own the cluster's capacity.

### Decision

| You want | Object |
|---|---|
| A cap on the namespace | ResourceQuota |
| A default or a max on one container | LimitRange |
| Honest scheduling on the node | requests on the pod, which the quota then sums |
| Room for the HPA | quota at least maxReplicas times the request |
| Cluster agents | a namespace outside the app quota |

### You can now

- Admit pods against requests, not against live usage.
- Pair a LimitRange with a quota so empty resources cannot sneak through.
- Size the quota to the largest the autoscaler is allowed to ask for.
- Tell a LimitRange admission error from an Insufficient cpu event.

::: quiz
q: A ResourceQuota sets `limits.cpu: "4"`. A Deployment's containers set CPU requests and no CPU limits. There is no LimitRange. What happens at apply?
- The pod is admitted and the limit is ignored by the quota
+ Admission rejects the pod, because the quota cannot account for a missing limit
- The scheduler places it and the kubelet fills in a limit of 4
- Only the second replica is rejected
why: Quotas that track limits require every container to have that limit, unless a LimitRange default supplies one before the quota runs. The kubelet does not invent a limit to satisfy quota. Requests-only quotas would accept this pod. The failure is at admission, so nothing is Pending.
:::

::: card
q: What does a LimitRange `default` do, as opposed to a ResourceQuota?
answer: `default` fills in a container's limits when the manifest omitted them, and `defaultRequest` fills in requests. A quota then sums those numbers and rejects the pod if the namespace total would be exceeded. The quota does not invent missing limits; the LimitRange does.
:::

::: predict lang=python
q: Quota remaining is 500 millicores. Each new pod requests 200. How many does this admit?
code:
```python
def admit(remaining, each, want):
    n = 0
    while n < want and remaining >= each:
        remaining -= each
        n += 1
    return n

print(admit(500, 200, 5))
print(admit(500, 200, 2))
```
answer:
```text
2
2
```
why: 200 fits twice (400) and the third would need 600, so a request for five still admits two. A request for two admits two. The rest are rejected at admission rather than scheduled and then killed. Idle usage does not refund the 200, because the quota counted the request.
:::

::: config lang=yaml
task: Write a ResourceQuota named `shop` in namespace `shop` with hard pods `10`, requests.cpu `2`, and requests.memory `4Gi`.
starter:
```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: shop
spec:
  hard:
    pods: "100"
```
check: metadata.name = shop | name
check: metadata.namespace = shop | namespace
check: spec.hard.pods = "10" | at most 10 pods
check: spec.hard."requests.cpu" = "2" | cpu requests
check: spec.hard."requests.memory" = 4Gi | memory requests
solution:
```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: shop
  namespace: shop
spec:
  hard:
    pods: "10"
    requests.cpu: "2"
    requests.memory: 4Gi
```
hint: Put the quota in the namespace. `requests.cpu` is a key that contains a dot; in this lesson's YAML you can write it quoted or as a plain key if you keep it in one line under hard. Use pods 10, not 100.
:::

::: config lang=yaml
task: Write a LimitRange named `defaults` in namespace `shop` of type Container. Default limit CPU 500m and memory 256Mi. Default request CPU 100m and memory 128Mi. Max CPU is 1 and max memory is 1Gi.
starter:
```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: defaults
spec:
  limits:
    - type: Pod
```
check: metadata.namespace = shop | namespace
check: spec.limits[0].type = Container | container type
check: spec.limits[0].default.cpu = 500m | default cpu limit
check: spec.limits[0].default.memory = 256Mi | default memory limit
check: spec.limits[0].defaultRequest.cpu = 100m | default cpu request
check: spec.limits[0].defaultRequest.memory = 128Mi | default memory request
check: spec.limits[0].max.cpu = "1" | max cpu
check: spec.limits[0].max.memory = 1Gi | max memory
solution:
```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: defaults
  namespace: shop
spec:
  limits:
    - type: Container
      default:
        cpu: 500m
        memory: 256Mi
      defaultRequest:
        cpu: 100m
        memory: 128Mi
      max:
        cpu: "1"
        memory: 1Gi
```
hint: type Container, not Pod. `default` is the limit fill-in. `defaultRequest` is the request fill-in. max is a ceiling, not a default.
:::

::: quiz
q: A Job succeeds and its pods stay in the namespace. A ResourceQuota on `pods` is already at the hard limit. A new Deployment cannot be created. Why?
- Succeeded pods never count toward quota
+ The finished pods still exist, so they still count, until a TTL or a delete removes them
- Quotas reset when a Job succeeds
- The Deployment is rejected because Jobs and Deployments cannot share a namespace
why: Quota counts objects, not "active work" unless you scope it that way. Succeeded pods occupy the count. ttlSecondsAfterFinished on the Job frees them. Deleting the quota would hide the leak.
:::

## Pod Security standards
id: pss
stage: guard
needs: security-k8s
minutes: 35
goal: Enforce the restricted Pod Security Standard on a namespace and know which fields actually pass it.
source: Kubernetes: Pod Security standards | https://kubernetes.io/docs/concepts/security/pod-security-standards/
source: Kubernetes: Pod Security admission | https://kubernetes.io/docs/concepts/security/pod-security-admission/
@@@@
PodSecurityPolicy was removed in Kubernetes 1.25. The replacement is Pod Security admission, which is stable and built in. You label a namespace. Admission compares each pod with a standard: privileged, baseline, or restricted. There is no policy object to bind and no extra controller to forget to install. The label is the control.

### The problem

A pod with `privileged: true` can escape the container onto the node. A pod that can add `CAP_SYS_ADMIN` is in the same family. You can code-review every manifest, and one Helm chart you did not read will still request hostPath `/var/run/docker.sock`. Admission is the backstop that rejects the object. Review is still useful. It is not sufficient.

Three standards:

**Privileged** allows everything. Use it only for namespaces that must run the CNI or a similar node agent, and do not put applications there.

**Baseline** stops the known easy escapes: privileged, host namespaces, some dangerous capabilities. It still allows root.

**Restricted** is the application default you want. On top of baseline it requires running as non-root, dropping all capabilities (adding back only `NET_BIND_SERVICE` if you must bind a low port), setting `allowPrivilegeEscalation: false`, and setting a seccomp profile of `RuntimeDefault` or `Localhost`. Volume types are limited. hostPath, hostNetwork, hostPID, and hostIPC are out.

Restricted does **not** require `readOnlyRootFilesystem`. Set that anyway. A writable root lets an attacker drop a binary even when they cannot become root. It is defense in depth, not a field the standard checks. People mix the two up and "pass restricted" while leaving the filesystem writable, or they think a read-only root is enough and skip seccomp.

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: shop
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: latest
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/warn: restricted
```

`enforce` rejects. `audit` logs. `warn` adds a warning to the API response. Roll out audit and warn first if the namespace is already full of root pods, then enforce once the images are fixed. `enforce-version: latest` tracks the cluster's standard. Pin a version (`v1.29`) if you want upgrades to be a choice. Latest is fine for a new namespace and surprising during a cluster upgrade if your pods were skating on an old allowance.

### A pod that passes

```yaml
securityContext:
  runAsNonRoot: true
  seccompProfile:
    type: RuntimeDefault
containers:
  - name: api
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      capabilities:
        drop: ["ALL"]
```

`runAsNonRoot: true` can sit on the pod. The container user in the image must actually be non-zero, or the container fails at start even if admission passed. `runAsUser: 10001` makes the uid explicit. Drop ALL capabilities. An empty drop list fails restricted. Seccomp RuntimeDefault is the runtime's default profile, which is what you want unless you have a custom one.

A writable emptyDir for `/tmp` is the usual companion of a read-only root, because real programs write temp files. Mount a volume. Do not turn the standard off.

### Where it breaks

**The chart enables privileged for "install simplicity".** Fix the values. A privileged namespace label to make the chart happy also makes the API privileged.

**Windows and other exceptions.** The standards are written around Linux containers. Read the docs before you enforce restricted on a namespace that runs something else.

**init containers.** They are checked too. A migrate container that runs as root fails the pod even if the app is fine.

**Debug pods.** `kubectl debug` may be rejected. That is painful and correct. Use a namespace you opened on purpose, or an ephemeral container policy you reviewed, not a permanent privileged label.

### At work

New namespaces are born restricted. Exemptions are a ticket with an expiry, not a copy-paste. The containers module's non-root image lesson is the same requirement from the Dockerfile side: if the image only works as root, no securityContext will satisfy both the standard and the process. Fix the image.

gVisor or Kata is a stronger boundary when the code itself is untrusted (a user-supplied script). That is a runtime class, not a Pod Security label. The label still applies. A sandbox you cannot explain is not a substitute for non-root.

### You can now

- Label a namespace to enforce restricted.
- List what restricted adds on top of baseline, including seccomp and dropping capabilities.
- Say that read-only root is worthwhile and not required by the standard.
- Roll audit before enforce on a live namespace.
- Keep privileged for the namespace that runs the node agent, not for the app.

### What admission is enforcing

Pod Security Admission is a built-in admission controller. It looks at the namespace labels and accepts or rejects the pod. It is not a scanner you run in CI, though you should also scan. The labels are `pod-security.kubernetes.io/enforce`, `.../audit`, and `.../warn`, and the values are `privileged`, `baseline`, or `restricted`. Enforce rejects. Audit logs. Warn sends a warning to the client and still admits. You can pin a version with `enforce-version=latest` or a Kubernetes minor version. Pinning `latest` means "the standard as this apiserver understands it today," which moves when you upgrade the cluster. Pinning a version means a cluster upgrade does not change the rules until you move the label. Both are choices. An unlabeled namespace is not restricted. It is whatever the cluster default is, and the default is often no enforcement.

Restricted is the profile this course asks for on application namespaces. It requires `runAsNonRoot: true`, a seccomp profile of `RuntimeDefault` or `Localhost`, `allowPrivilegeEscalation: false`, and dropping all capabilities. It does not, by itself, require `readOnlyRootFilesystem`. This course still sets that, because a writable root filesystem is how a compromised process drops a binary. Do not tell a reviewer that restricted "includes" the read-only root. It does not. Add the field.

Privileged is for the CNI and other agents that need host namespaces. Baseline is a middle that blocks the obvious privilege escalations and still allows root. Application namespaces should not sit on baseline because "restricted was noisy." The noise is the list of fields you have to set. Fix the pod.

### Where it breaks

A Deployment that was running before the label was applied keeps running. Enforcement is on admission, at create and update. Existing pods are not killed when you add the label. The next rollout is when you find out. Roll a canary or expect the rollout to stick.

Windows pods, and some vendor sidecars, cannot meet restricted. The fix is a different namespace or an exemption you document, not a cluster-wide privileged label. Exemptions are cluster configuration. A label of privileged on `shop` because one sidecar needs hostPath is how the API container also becomes allowed to be privileged.

`runAsNonRoot: true` with an image whose USER is 0 fails at runtime even if admission passed, or fails admission when the image's user is known to be root and you also set `runAsUser: 0`. Set `runAsUser` to a non-zero id in the spec so you are not depending on the Dockerfile. The Dockerfile should still not be root. Both layers.

Capabilities: `drop: ["ALL"]` and then adding back `NET_BIND_SERVICE` is the pattern when you must bind a low port. Restricted allows adding back only a small set, and only if you dropped all first. A pod that adds `SYS_ADMIN` is not restricted. Admission will say so. Read the message. It names the field.

### At work

The platform namespace chart labels every new namespace restricted for enforce, audit, and warn. CI renders the manifests and runs a policy tool, but the apiserver is the control that cannot be skipped by someone with kubectl. Break-glass is a labelled exception namespace with a ticket, not a kubectl label change that GitOps will revert, and not a silent revert that leaves privileged on. Audit mode for a week before enforce is how you find the vendor chart that needs hostPath without taking the API down on a Friday.

### Decision

| Namespace | Profile |
|---|---|
| Application | restricted enforce |
| During a migration, to see violations | audit and warn, then enforce |
| CNI, CSI, and other host agents | privileged, in their own namespace |
| "Just for this debug pod" | not the app namespace |

### You can now

- Label enforce, audit, and warn separately.
- Meet restricted without claiming it includes a read-only root filesystem.
- Expect the next rollout, not the existing pods, to feel a new label.
- Keep privileged workloads out of the application namespace.

::: quiz
q: Which field does the restricted Pod Security Standard require?
- readOnlyRootFilesystem true
+ allowPrivilegeEscalation false, run as non-root, drop all capabilities, and a seccomp profile of RuntimeDefault or Localhost
- A NetworkPolicy in the same namespace
- resources.limits.memory set
why: Restricted is about the pod's security context and volumes, not about network policy, quotas, or a read-only root. Read-only root is a good extra. Memory limits are a quota and QoS concern. A pod can pass restricted and still have no NetworkPolicy.
:::

::: quiz
q: You set enforce to restricted on a namespace that already runs pods as root. What happens to those running pods, and to a new deploy?
- Running pods are killed immediately, and new ones are rejected
+ Running pods keep running. New and updated pods that violate the standard are rejected
- Nothing changes until you install a policy controller
- The label only warns, because enforce needs a second plugin
why: Pod Security admission checks pods at admission time. It does not scan and kill pods that were already admitted. The next rollout is when enforce bites. Audit and warn are how you see the impact first. No extra controller is required; this admission is built in, unlike NetworkPolicy.
:::

::: card
q: What Kubernetes feature replaced PodSecurityPolicy, and how do you turn on the restricted profile?
answer: Pod Security admission, which has been stable since well before 1.25's removal of PodSecurityPolicy. Label the namespace with pod-security.kubernetes.io/enforce=restricted. Audit and warn labels are the same key with different modes so you can see violations before you reject them.
:::

::: config lang=yaml
task: Label namespace `shop` so Pod Security admission enforces, audits, and warns the restricted standard. Pin the enforce version to `latest`.
starter:
```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: shop
```
check: metadata.name = shop | name
check: metadata.labels."pod-security.kubernetes.io/enforce" = restricted | enforce restricted
check: metadata.labels."pod-security.kubernetes.io/enforce-version" = latest | version latest
check: metadata.labels."pod-security.kubernetes.io/audit" = restricted | audit
check: metadata.labels."pod-security.kubernetes.io/warn" = restricted | warn
solution:
```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: shop
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: latest
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/warn: restricted
```
hint: These are labels, not annotations. The keys contain dots and slashes; write them as plain YAML keys. All three modes should be restricted.
:::

::: config lang=yaml
task: Fix the container securityContext so it can pass restricted: runAsNonRoot true, seccomp RuntimeDefault, allowPrivilegeEscalation false, and drop ALL capabilities. Also set readOnlyRootFilesystem true as the extra this course wants.
starter:
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: api
spec:
  containers:
    - name: api
      image: ghcr.io/acme/api:1.0.0
      securityContext:
        privileged: true
```
check: spec.securityContext.runAsNonRoot = true | non-root
check: spec.securityContext.seccompProfile.type = RuntimeDefault | seccomp
check: spec.containers[0].securityContext.allowPrivilegeEscalation = false | no escalation
check: spec.containers[0].securityContext.capabilities.drop[0] = ALL | drop ALL
check: spec.containers[0].securityContext.readOnlyRootFilesystem = true | read-only root
check: spec.containers[0].securityContext.privileged missing | not privileged
solution:
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: api
spec:
  securityContext:
    runAsNonRoot: true
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: api
      image: ghcr.io/acme/api:1.0.0
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop:
            - ALL
```
hint: Remove privileged. Put runAsNonRoot and seccomp on the pod securityContext. Put the capability drop and the escalation flag on the container. ALL must be in the drop list.
:::

::: predict lang=python
q: Admission rejects a new pod that violates the enforced standard. An already-running pod is left alone. What does this print?
code:
```python
def admit(existing, runs_as_root, enforce):
    if existing:
        return "keep"
    if enforce == "restricted" and runs_as_root:
        return "reject"
    return "allow"

print(admit(True, True, "restricted"))
print(admit(False, True, "restricted"))
print(admit(False, False, "restricted"))
```
answer:
```text
keep
reject
allow
```
why: Enforce does not evict. A new root pod is rejected under restricted. A new non-root pod that also met the other fields would be allowed; this function only models the root check. Audit mode would warn instead of rejecting, which is how you migrate.
:::

## External secrets and workload identity
id: ext-secrets
stage: guard
needs: config, rbac
minutes: 40
goal: Stop storing long-lived cloud keys in Kubernetes Secrets, and say what an external-secrets controller actually copies.
source: External Secrets Operator | https://external-secrets.io/latest/introduction/
source: Amazon EKS: Pod Identity | https://docs.aws.amazon.com/eks/latest/userguide/pod-identities.html
source: Kubernetes: Secrets good practices | https://kubernetes.io/docs/concepts/security/secrets-good-practices/
@@@@
A Kubernetes Secret is a convenient file mount. It is a bad place for the only copy of a root cloud key, and it is a bad place for a key that never expires. Two better patterns exist. One still results in a Secret, but the bytes come from a real secret manager and can be rotated. The other removes the cloud key entirely: the pod proves who it is and receives a short-lived token. Use the second for AWS APIs. Use the first for credentials that are not AWS IAM, such as a database password the database still expects.

### The problem

Someone creates a Secret from `aws_access_key_id` so the app can read a bucket. The key is long-lived. It is copied into etcd, into a Helm release, into a CI log, and into every replica. Rotating it means editing the Secret and restarting pods, and you will not do it. The blast radius is "whatever that IAM user could do", which is usually more than the one bucket.

EKS Pod Identity (and, where you cannot use it, IRSA) replaces that key. The cluster runs a Pod Identity agent. You associate a ServiceAccount in a namespace with an IAM role. The AWS SDK in the pod asks the agent and receives temporary credentials. There is no access key in a Secret. IRSA does the same idea with an OIDC provider and an annotation on the ServiceAccount. Pod Identity is the one to choose for new Linux node pools on EKS: no per-cluster OIDC issuer to wire, and the role can be reused across clusters. IRSA remains the path for Fargate and for clusters where the Pod Identity agent is not available. Both can coexist. Do not teach yourself only IRSA in 2026 and call it current.

The pod still has an identity. That identity is the ServiceAccount plus the IAM role. RBAC does not limit the AWS API. The IAM policy on the role does. A pod that should read one bucket and can `iam:*` is not least privilege, even though no Secret exists. The cloud IAM lesson is the policy. This lesson is how the credential reaches the process.

### When you still need a Secret

Database passwords, API tokens for a vendor, TLS keys for a legacy process: the program wants a file or an env var. Put the source of truth in AWS Secrets Manager, GCP Secret Manager, or Vault. Run External Secrets Operator, which is a controller you install, not a built-in API.

```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: db
  namespace: shop
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws
    kind: ClusterSecretStore
  target:
    name: db-password
  data:
    - secretKey: password
      remoteRef:
        key: shop/db
        property: password
```

The controller reads the remote store using **its** identity (Pod Identity again, not a key in a Secret if you can help it) and writes a Kubernetes Secret named `db-password`. Your Deployment mounts that Secret the way the config lesson showed. Refresh rewrites the Secret. Env vars still do not update until the pod restarts. Mounted files can. The operator did not remove that rule.

`SecretStore` is namespaced. `ClusterSecretStore` is cluster-wide. A ClusterSecretStore that every namespace can use is convenient and easy to over-share. Prefer a store per environment, and an ExternalSecret that names one key, not "sync the whole account".

The ExternalSecret is a CRD. If the controller is down, refreshes stop. The last Secret remains. That is usually what you want for a short outage and bad if the last value was revoked at the database. Alert on the ExternalSecret's status, not only on the app.

### What not to do

Do not commit `stringData` into Git. Do not log the mounted file. Do not grant the app's ServiceAccount `get` on all secrets because the operator already copied the one it needs; the app should mount its file and have no API access to list the rest. The operator's ServiceAccount is the one that needs to create Secrets in the namespace. That is a Role, not cluster-admin.

Do not use a Secret as a message bus. Controllers that write secrets every few seconds hammer etcd.

### At work

New AWS calls go through Pod Identity and an IAM policy you can read. New vendor tokens go through External Secrets and a rotation in the secret manager. The cluster Secret is a cache with a name. Incident response revokes the IAM role or the secret-manager version, which is faster than finding every YAML copy. The Terraform module can create the IAM role and the Pod Identity association; the Kubernetes module only documents why the Deployment no longer has `AWS_SECRET_ACCESS_KEY`.

### You can now

- Prefer EKS Pod Identity over a long-lived access key in a Secret, and say when IRSA still applies.
- Explain that External Secrets copies a value into a Kubernetes Secret; it is not the AWS API itself.
- Keep the operator's identity separate from the app's Role.
- Remember that env-based secrets do not rotate until restart.
- Alert on ExternalSecret status when the controller cannot refresh.

### The Secret in the namespace is a cache

External Secrets Operator is a controller. An ExternalSecret names a store (a SecretStore or a ClusterSecretStore), a remote key, and the Kubernetes Secret to write. The controller reads the remote value with its own identity and writes `data` on a Secret. Pods mount that Secret the ordinary way. They do not get your cloud credentials. If the operator is down, the Secret stops refreshing. The last value remains until something deletes it. Plan for that. A refresh interval of one hour is not a rotation SLA of one hour if the controller cannot authenticate.

The store holds the cloud configuration: region, and how the operator authenticates. A ClusterSecretStore is cluster-scoped and is what platform installs once. A SecretStore is namespaced. Application teams should not each hold a cloud key in their namespace. On EKS the operator's ServiceAccount should use Pod Identity (or IRSA if you are on Fargate, where Pod Identity does not run). A static access key in the store is the thing this lesson exists to delete.

The ExternalSecret's `data` list maps a remote property to a secret key. `shop/db` property `password` becomes key `password` on Secret `db-password`. The pod's env or volume refers to that key. The remote path does not appear in the pod spec. A typo in the property writes an empty key or errors the ExternalSecret status. Read status. A Secret that exists from a previous success can be stale while status says the new fetch failed.

### Where it breaks

The operator's IAM role can read every secret in the account, and every namespace is allowed to reference the ClusterSecretStore. Then any tenant who can create an ExternalSecret can copy any remote key into their namespace. Restrict which namespaces can use the store, or use a store per environment with a role that can read only that prefix. IAM on the operator is the real boundary. The ExternalSecret is a request.

Pushing the Kubernetes Secret to Git "so the pod starts before the operator syncs" copies the secret into Git. The pod should tolerate a missing Secret on first boot by failing readiness, and the operator should sync before the rollout, or the rollout should wait. Do not commit the data.

`creationPolicy: Owner` means the operator owns the Secret and will delete it when the ExternalSecret is deleted. `Orphan` leaves it. Know which you set before you delete an ExternalSecret in prod.

Pod Identity for the application is a different hop. The operator uses its role to fetch the secret and store it in Kubernetes. The application might instead call Secrets Manager itself with its own Pod Identity and never have a Kubernetes Secret. That avoids a copy. It also means the app depends on the cloud API at runtime. Use the operator when many apps expect a mounted Secret. Use the app's own role when you want no copy in etcd. etcd still holds the Secret at rest if you use the operator. Encrypt etcd secrets. The Kubernetes Secret is not a hardware security module.

### At work

Platform runs one operator and a ClusterSecretStore per account, with a role limited to a path prefix. App repos contain ExternalSecrets and no secret data. Reviews reject `stringData` and `data` on Secrets in app overlays. Rotation is a cloud-side change plus the refresh interval, and a rollout if the process only reads the env at start. A process that does not re-read a file will keep the old password until you restart it. The operator updating the Secret does not restart the pod unless you add a reloader.

### Decision

| Situation | Do |
|---|---|
| App expects a mounted Kubernetes Secret | ExternalSecret, operator identity scoped to a prefix |
| App can call the cloud API | Pod Identity on the app, no Kubernetes Secret |
| Fargate | IRSA for the operator or the app, not Pod Identity |
| Someone pasted a password into Git | revoke it, do not "move it to a Secret" and leave the commit |

### You can now

- Separate the operator's cloud identity from the application's.
- Map a remote property onto a Secret key and read status when it fails.
- Keep secret bytes out of Git.
- Expect a restart or a reloader if the process caches the environment.

::: quiz
q: An application on EKS needs to read one S3 bucket. What is the current preferred way to give it AWS credentials?
- A Secret containing a long-lived access key, mounted as env
+ An EKS Pod Identity association from its ServiceAccount to an IAM role that can read only that bucket
- Bind the pod's ServiceAccount to cluster-admin
- Put the access key in a ConfigMap so it is not a Secret
why: Pod Identity issues temporary credentials to the pod. The IAM policy is the scope. A static key in a Secret or a ConfigMap is long-lived and readable by anyone who can get the object. cluster-admin is Kubernetes RBAC and does not grant S3, and it is far too much API power. IRSA still works, especially on Fargate, but it is not the default you reach for first on a new node pool.
:::

::: quiz
q: External Secrets Operator refreshes a key into Secret `db-password`, which the app reads from an environment variable. You rotate the password in Secrets Manager. When does the running process see it?
- Within the refreshInterval, in its environment, automatically
+ After the Secret object is updated and the pod is restarted, because env vars are not live
- Never. ExternalSecret cannot update an existing Secret
- Only if the Secret is type Opaque
why: The operator updates the Secret data. A mounted file can be re-read. An environment variable was copied at process start. Plan a rollout as part of rotation, or teach the app to re-read a file. The Secret type is unrelated.
:::

::: card
q: What does an ExternalSecret's secretStoreRef point at, and what does target.name become?
answer: secretStoreRef selects the SecretStore or ClusterSecretStore that knows how to talk to the external manager. target.name is the Kubernetes Secret the controller writes in the same namespace. The remoteRef is which key and property to copy. The app mounts the target Secret; it does not talk to the store itself.
:::

::: predict lang=python
q: Static keys outlive the pod. Pod Identity tokens expire and are refreshed. What does this print after the pod is deleted?
code:
```python
def still_valid(kind):
    if kind == "static-key":
        return "valid-until-revoked"
    return "gone-with-pod"

print(still_valid("static-key"))
print(still_valid("pod-identity"))
```
answer:
```text
valid-until-revoked
gone-with-pod
```
why: A leaked access key works from anywhere until someone deactivates it. Temporary credentials from Pod Identity stop working when they expire, and a deleted pod is not a place an attacker can refresh them. You still revoke the role's policy if the session token might have been copied out during the compromise.
:::

::: config lang=yaml
task: Write an ExternalSecret named `db` in namespace `shop` that refreshes every hour, uses ClusterSecretStore `aws`, writes Kubernetes Secret `db-password`, and copies property `password` of remote key `shop/db` into secret key `password`. Use apiVersion `external-secrets.io/v1`.
starter:
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: db
stringData:
  password: hunter2
```
check: apiVersion = external-secrets.io/v1 | external-secrets api
check: kind = ExternalSecret | kind
check: metadata.name = db | name
check: metadata.namespace = shop | namespace
check: spec.refreshInterval = 1h | refresh
check: spec.secretStoreRef.name = aws | store name
check: spec.secretStoreRef.kind = ClusterSecretStore | cluster store
check: spec.target.name = db-password | target secret
check: spec.data[0].secretKey = password | key in the Secret
check: spec.data[0].remoteRef.key = shop/db | remote key
check: spec.data[0].remoteRef.property = password | property
solution:
```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: db
  namespace: shop
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws
    kind: ClusterSecretStore
  target:
    name: db-password
  data:
    - secretKey: password
      remoteRef:
        key: shop/db
        property: password
```
hint: This is not a Secret with stringData. The password must not appear in the manifest. data is a list with secretKey and remoteRef. The store is a ClusterSecretStore named aws.
:::

::: quiz
q: A new API on EKS nodes, not Fargate, must read one key in Secrets Manager. A teammate wants an access key in a Kubernetes Secret mounted as environment variables, because that always works. What do you ship instead?
- The node's IAM role, so every pod on the node can read the key
+ An EKS Pod Identity association from the pod's ServiceAccount to a role that can read that one key, so the SDK gets temporary credentials
- IRSA is the only supported option on EC2 nodes, so create an OIDC provider for every cluster first
- A ClusterRole that allows get on secrets, which grants the cloud permission
why: Pod Identity is the current association model for EKS on EC2: no long-lived key and no per-cluster OIDC provider. IRSA remains the path on Fargate, where the Pod Identity agent does not run. A Kubernetes Role does not grant Secrets Manager. The node role would give the key to every pod on the node.
:::

## Project: a locked-down namespace
id: p-secure-ns
stage: guard
needs: netpol, quotas, pss, rbac, ext-secrets, p-k8s
minutes: 80
project: yes
goal: Admit only a non-root invoices pod, with a default-deny network, a quota, a narrow Role, and a secret that is not typed into Git.
source: Kubernetes: Network policies | https://kubernetes.io/docs/concepts/services-networking/network-policies/
source: Kubernetes: Pod Security admission | https://kubernetes.io/docs/concepts/security/pod-security-admission/
source: Kubernetes: RBAC good practices | https://kubernetes.io/docs/concepts/security/rbac-good-practices/

The invoices API from the deploy project is serving. The container is non-root because that manifest said so. The namespace around it is still open: any pod can connect anywhere, a later chart can bind a wide Role, and the database URL was easy to paste into Git. You are locking namespace shop before another team deploys into it. The API ServiceAccount is invoices. Database pods are labelled app db. CoreDNS has to keep working. The public internet does not get a default allow.

You are not asked to write the allow policy in this project. You are asked not to punch a hole in the deny. Budget about 80 minutes. Each step is one object. Finish the namespace before the pod, because the pod is what the namespace will have to admit.

### Lessons this uses

1. The deploy project: the same invoices image, ServiceAccount, and Secret name. This project does not replace that Deployment. It locks the namespace around it.
2. Pod Security: enforce, audit, and warn on the namespace, restricted, with an enforce version.
3. NetworkPolicy: a default deny for both directions, selecting every pod, with no allow rules in that policy.
4. Quotas: a ResourceQuota on pods and on CPU and memory requests, which the earlier Deployment has to fit inside.
5. RBAC: a Role and RoleBinding in the namespace, get and list on configmaps only, bound to the invoices ServiceAccount.
6. External Secrets: an ExternalSecret that copies one property into a Secret. The password does not appear in Git.

### Requirements

The steps are separate objects. Names have to match, because that is the contract a later manifest would import.

1. Namespace shop with Pod Security enforce, audit, and warn set to restricted, and enforce-version latest.
2. NetworkPolicy default-deny in shop selecting every pod, policy types Ingress and Egress, and no allow rules. This is the floor. An allow for the proxy and the database would be a second policy, not a hole in this one.
3. ResourceQuota shop with hard pods 10, requests.cpu 2, and requests.memory 4Gi.
4. Role invoices and RoleBinding invoices in shop. The Role allows get and list on core configmaps only. The subject is ServiceAccount invoices in shop.
5. ExternalSecret invoices-db, api external-secrets.io/v1, ClusterSecretStore aws, refresh one hour, writing Secret invoices-db from remote key shop/db property url into key url. No password in the object.
6. Pod invoices in shop that can pass restricted admission: ServiceAccount invoices, label app invoices, image ghcr.io/acme/invoices:3f9a2c1, runAsNonRoot, seccomp RuntimeDefault, allowPrivilegeEscalation false, drop ALL capabilities, and a read-only root filesystem.

### How this is graded

The checker parses YAML and JSON-shaped fields. It does not apply them. A default-deny that also contains a wide allow fails the deny step. A Role that can get secrets fails. An ExternalSecret that inlines a password fails even when the remote key is right. The pod fails if it is root, privileged, or missing seccomp. Those are the same fields admission and review would reject.

### What a pass does not prove

Default-deny alone would also block the API and DNS. You still need a later allow for the ingress controller, for kube-dns, and for the database port. This project grades the floor, not that allow. The quota counts requests, so the Deployment from the previous project has to fit inside 2 CPU and 4Gi. Restricted admission does not require a read-only root filesystem. The pod step asks for it anyway, because a writable root is a place to drop a binary.

### You can now

- Put a floor under the namespace before the next team arrives.
- Keep the database URL out of Git and out of a Role that can read secrets.
- Admit a pod that meets restricted and the read-only root this course adds.

::: config lang=yaml
task: Write the namespace `shop` with Pod Security enforce, audit, and warn set to restricted, and enforce-version `latest`.
starter:
```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: default
```
check: kind = Namespace | kind
check: metadata.name = shop | name shop
check: metadata.labels."pod-security.kubernetes.io/enforce" = restricted | enforce
check: metadata.labels."pod-security.kubernetes.io/audit" = restricted | audit
check: metadata.labels."pod-security.kubernetes.io/warn" = restricted | warn
check: metadata.labels."pod-security.kubernetes.io/enforce-version" = latest | version
solution:
```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: shop
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/enforce-version: latest
```
hint: The name is shop, not default. The four keys are labels. enforce without audit and warn hides the migration path; set all three.
:::

::: config lang=yaml
task: Write a default-deny NetworkPolicy named `default-deny` in namespace `shop` for every pod, covering Ingress and Egress, with no allow rules.
starter:
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow
  namespace: shop
spec:
  podSelector:
    matchLabels:
      app: invoices
  policyTypes:
    - Ingress
  ingress:
    - {}
```
check: metadata.name = default-deny | name
check: metadata.namespace = shop | namespace
check: spec.podSelector count 0 | selects all pods
check: spec.policyTypes[0] = Ingress | ingress
check: spec.policyTypes[1] = Egress | egress
check: spec.ingress missing | no allow ingress
check: spec.egress missing | no allow egress
solution:
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny
  namespace: shop
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
```
hint: Empty podSelector, both policy types, and no ingress or egress lists. A rule of `{}` allows everything, which fails the deny.
:::

::: config lang=yaml
task: Write a ResourceQuota named `shop` in namespace `shop` with hard pods 10, requests.cpu "2", and requests.memory 4Gi.
starter:
```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: unlimited
  namespace: shop
spec:
  hard:
    pods: "1000"
```
check: metadata.name = shop | name
check: metadata.namespace = shop | namespace
check: spec.hard.pods = "10" | pod cap
check: spec.hard."requests.cpu" = "2" | cpu requests
check: spec.hard."requests.memory" = 4Gi | memory requests
solution:
```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: shop
  namespace: shop
spec:
  hard:
    pods: "10"
    requests.cpu: "2"
    requests.memory: 4Gi
```
hint: The keys under hard are pods, requests.cpu, and requests.memory. Ten pods, not a thousand. Quote the cpu quantity.
:::

::: config lang=yaml
task: Write a Role `invoices` and a RoleBinding `invoices` in namespace `shop`. The Role allows get and list on core configmaps only. The binding's subject is ServiceAccount `invoices` in `shop`.
starter:
```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: invoices
  namespace: shop
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get", "list", "watch"]
```
check: [kind=Role].rules[0].resources[0] = configmaps | configmaps, not secrets
check: [kind=Role].rules[0].verbs count 2 | two verbs
check: [kind=Role].rules[0].apiGroups[0] = "" | core group
check: [kind=RoleBinding].subjects[0].kind = ServiceAccount | subject kind
check: [kind=RoleBinding].subjects[0].name = invoices | subject name
check: [kind=RoleBinding].subjects[0].namespace = shop | subject namespace
check: [kind=RoleBinding].roleRef.kind = Role | Role, not ClusterRole
check: [kind=RoleBinding].roleRef.name = invoices | role name
check: [kind=RoleBinding].metadata.namespace = shop | binding namespace
solution:
```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: invoices
  namespace: shop
rules:
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: invoices
  namespace: shop
subjects:
  - kind: ServiceAccount
    name: invoices
    namespace: shop
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: invoices
```
hint: Change the resource to configmaps and drop watch. Add a second document that binds ServiceAccount invoices. roleRef.kind is Role.
:::

::: config lang=yaml
task: Write an ExternalSecret `invoices-db` in namespace `shop` (api external-secrets.io/v1) that uses ClusterSecretStore `aws`, refreshes hourly, and writes Secret `invoices-db` from remote key `shop/db` property `url` into secretKey `url`. Do not include the password.
starter:
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: invoices-db
  namespace: shop
stringData:
  url: postgres://user:pass@db/invoices
```
check: kind = ExternalSecret | not a literal Secret
check: apiVersion = external-secrets.io/v1 | api version
check: metadata.name = invoices-db | name
check: metadata.namespace = shop | namespace
check: spec.secretStoreRef.kind = ClusterSecretStore | store kind
check: spec.secretStoreRef.name = aws | store name
check: spec.refreshInterval = 1h | hourly
check: spec.target.name = invoices-db | writes this Secret
check: spec.data[0].secretKey = url | key url
check: spec.data[0].remoteRef.key = shop/db | remote key
check: spec.data[0].remoteRef.property = url | property url
solution:
```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: invoices-db
  namespace: shop
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws
    kind: ClusterSecretStore
  target:
    name: invoices-db
  data:
    - secretKey: url
      remoteRef:
        key: shop/db
        property: url
```
hint: Replace the Secret entirely. The URL must not appear. target.name is the Kubernetes Secret the Deployment already mounts. remoteRef.property is url.
:::

::: config lang=yaml
task: Write a Pod `invoices` in namespace `shop` that would pass restricted admission. Service account `invoices`, label `app: invoices`, image `ghcr.io/acme/invoices:3f9a2c1`, runAsNonRoot, seccomp RuntimeDefault, allowPrivilegeEscalation false, drop ALL capabilities, read-only root filesystem. No privileged flag.
starter:
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: invoices
spec:
  containers:
    - name: invoices
      image: ghcr.io/acme/invoices:latest
      securityContext:
        privileged: true
```
check: metadata.namespace = shop | namespace
check: metadata.labels.app = invoices | label
check: spec.serviceAccountName = invoices | service account
check: spec.securityContext.runAsNonRoot = true | non-root
check: spec.securityContext.seccompProfile.type = RuntimeDefault | seccomp
check: spec.containers[0].image = ghcr.io/acme/invoices:3f9a2c1 | pinned image
check: spec.containers[0].securityContext.allowPrivilegeEscalation = false | no escalation
check: spec.containers[0].securityContext.capabilities.drop[0] = ALL | drop all
check: spec.containers[0].securityContext.readOnlyRootFilesystem = true | read-only root
check: spec.containers[0].securityContext.privileged missing | not privileged
solution:
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: invoices
  namespace: shop
  labels:
    app: invoices
spec:
  serviceAccountName: invoices
  securityContext:
    runAsNonRoot: true
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: invoices
      image: ghcr.io/acme/invoices:3f9a2c1
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop:
            - ALL
```
hint: Pin the image. Delete privileged. The service account name matches the RoleBinding subject. Pod-level securityContext holds runAsNonRoot and seccomp. The container drops ALL.
:::

::: quiz
q: In this locked namespace, a second pod labelled `app: invoices` tries to open TCP 443 to the public internet. Only the default-deny policy exists so far (you have not added an egress allow). What happens to the packet?
- It is allowed, because the pod is admitted by Pod Security
+ It is dropped. Default-deny covers egress, and Pod Security does not allow packets
- It is allowed, because NetworkPolicy never restricts egress
- The API server returns Forbidden
why: Pod Security admission decides whether the pod can exist. NetworkPolicy decides packets. Default-deny with policy type Egress and no allow drops the outbound connection. Forbidden would be an API call, which this is not. Adding an allow later is how you would open a specific destination, not how the deny behaves.
:::

::: card
q: Why does this project use an ExternalSecret instead of stringData on a Secret for the database URL?
answer: stringData would put the credential in Git and in the manifest you apply. An ExternalSecret names a key in a secret manager and lets the controller write the Kubernetes Secret. The running pod still mounts invoices-db. The password is not in the review diff.
:::
