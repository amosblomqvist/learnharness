# Containers
id: containers
blurb: Package an app with everything it needs and run it the same everywhere: namespaces, images, Dockerfiles, BuildKit, networking, volumes, health, Compose, registries, and what a scan does not prove.
why: Containers are how code gets to the cloud: ECS, Lambda images, App Runner and every Kubernetes pod run one. They come after the languages, because what you put in a container is your app, and before the cloud, because the cloud runs containers.
stage: basics | Images and containers | Know what a container really is, and write a Dockerfile that builds fast.
stage: prod | Production-ready containers | Build small, safe images, run several services together, and ship them through a registry.

## What a container is
id: what
stage: basics
needs: linux/processes, linux/network
minutes: 35
goal: Explain an image, a container, and a writable layer, and say what -p, -e, and -v change at run time.
source: Docker docs: What is a container? | https://docs.docker.com/get-started/docker-concepts/the-basics/what-is-a-container/
source: Docker docs: docker run | https://docs.docker.com/reference/cli/docker/container/run/

The API works on your laptop and fails on the server. The laptop has a library the server does not, a different Python, and a file that was never committed. A container is the industry's answer to that gap, and it is smaller than people think. It is not a second computer. It is a process, started from a filesystem snapshot, with a private view of the machine and a budget. This lesson names the pieces. The next one opens the namespaces and cgroups. Later lessons build the snapshot and run it with other processes.

### The problem it was built for

Shipping "the code" is not shipping the program. The program is the code plus the interpreter, the shared libraries, the system packages, the environment variables, and the files it expects to find at particular paths. Two hosts drift. One got a security update of OpenSSL. One still has the old one. A tarball of the repository does not capture that, and a README that says "install these packages" is a hope.

An **image** is a captured filesystem plus the settings needed to start a process from it: the command, the user, the environment, the working directory. A **container** is a running or stopped instance of that image. You can start two containers from one image the way you can start two processes from one binary. They do not share the files they write after they start.

That last sentence is the one that loses data. The image is read-only in practice. The container adds a thin writable layer on top. Files created while it runs live in that layer. `docker rm` deletes the layer. The image is still there, unchanged, which is why a recreated Postgres with no volume comes up empty. The rows were never in the image. They were in the writable layer of a container you deleted.

### Image, container, writable layer

```mermaid
flowchart TB
  image["image: read-only layers plus config"] --> c1["container A writable layer"]
  image --> c2["container B writable layer"]
  c1 --> p1["process"]
  c2 --> p2["process"]
```

The image is built once, named, and stored. Building it is the Dockerfile lesson. What you need here is the split between the three objects `docker` keeps:

- The **image** is what `docker build` produces and `docker pull` downloads. It has an id and usually a name such as `myorg/api:1.4.2`.
- The **container** is what `docker run` creates. It has its own id and a name you pass with `--name`. It points at an image.
- The **writable layer** belongs to that container. It is where changes go. Commit it into a new image only as a debugging trick. Real changes belong in a new build.

`docker ps` lists running containers. `docker ps -a` includes stopped ones. A stopped container still has its writable layer. `docker start` brings the same container back. `docker rm` throws the layer away. `docker rmi` throws away an image, and it refuses if a container still references it.

The settings on the image, called the image config, are the defaults: command, environment, user. `docker run` can override them for one container without changing the image. `-e DATABASE_URL=...` adds an environment variable for that process. The same image then runs in dev and in prod with different configuration. Baking the production URL into the image would make the image a different artifact per environment, which is the opposite of "the same bytes everywhere".

### A run, flag by flag

```bash
docker run -d --name api \
  -p 8080:8000 \
  -e DATABASE_URL=postgres://db/app \
  -v pgdata:/var/lib/postgresql/data \
  myorg/api:1.4.2
```

`-d` starts it in the background. Without `-d`, the process is attached to your terminal and the terminal waits.

`-p 8080:8000` publishes a port. The form is **host port, then container port**. A browser on the host opens `http://localhost:8080`. Inside the container the server is on 8000. Nothing on the host is listening on 8000 unless some other program is. The name `container` is not a DNS name you can type. Publishing is a packet forward into the container's network namespace, which is why the server inside must listen on `0.0.0.0`, not only on `127.0.0.1`. `127.0.0.1` inside the container is the container itself, and the forward arrives on the container's other interface.

`-e` is configuration. Prefer it to a file you copied in at build time. A secret in `-e` is still visible to anyone who can inspect the container. Production systems often inject secrets as files with tighter permissions. The rule at this stage is narrower: do not bake the value into the image.

`-v pgdata:/var/lib/postgresql/data` attaches a **named volume** at that path. The volume outlives `docker rm`. The path is where Postgres keeps its data directory. A volume on the wrong path does nothing for the data. The volume lesson covers bind mounts and the copy-up rule. Here, the point is that survival is a mount, not a property of the image tag.

Then the usual inspection commands:

```bash
docker ps
docker logs -f api
docker exec -it api sh
docker stop api
```

`docker logs` reads the process's stdout and stderr, as the logging driver captured them. A line the app wrote only to `/var/log/app.log` inside the container is not in `docker logs`. Platforms collect stdout. Write logs there.

`docker exec` starts a **new** process in the same namespaces. It does not replace the server. If `sh` is missing from the image, exec into a shell fails. That is a property of the image, not of exec.

`docker stop` sends SIGTERM to PID 1, waits, then SIGKILL. The default wait is 10 seconds. A process that is not PID 1, because a shell is, never sees SIGTERM. That failure mode has its own lesson. The fact you need now is that stop is a signal to the container's main process, not a request to the image.

### What "disposable" commits you to

If the container is a process you are willing to delete, three habits follow.

**State does not live in the writable layer.** Databases, uploads, and queues go to a volume or, better, to a service that is someone else's durability problem. A managed database survives a new image. A file under `/tmp` in the container does not.

**Config comes from the environment, or from a mount, at start.** The image stays one build. Dev points `DATABASE_URL` at a local database. Prod points it at the real one. You do not rebuild to change a hostname.

**Logs go to stdout and stderr.** The host, Compose, or the cloud platform reads them. A log file inside the container is a file in the writable layer. It vanishes with the container, and it is invisible to the platform unless you shipped a sidecar to tail it.

One process per container is the shape platforms assume. A second program is a second container. Supervisors that start three daemons inside one container fight the orchestrator, which thinks "the container" is healthy or not as one unit.

### Where it breaks

**Port direction.** `-p 8000:8080` publishes host 8000 to container 8080. People read it as "from the app, to the host" because they think of the app first. The flag is host, then container. The browser uses the host number.

**`localhost` in the URL you hand a human.** From the human's laptop, `localhost` is the laptop. From a second container, `localhost` is that second container. The published port is a host concept. Another container reaches this one by a network name, which Compose creates, not by the host's published port. You do not have to publish a port at all for two containers on the same Docker network to talk.

**Recreating a database container and expecting the rows.** Same image, same tag, empty data directory. The rows were in the old writable layer. `--restart always` restarts the same container. It does not restore a container you removed, and it does not create a volume you never attached.

**Editing a file in a running container and calling it a deploy.** `docker exec` and a text editor change the writable layer. The next `docker rm` loses it. The image your teammate pulls does not have it. A change that must last is a new image, or a file on a volume you meant to persist.

**A container on a Mac treated as a macOS process.** Docker Desktop runs a Linux VM. The container is a Linux process inside that VM. macOS paths, macOS process lists, and the macOS firewall are outside it. The isolation lesson is the detail. The practical effect is that "it listened on the Mac" still means "it listened in the VM, and Desktop forwarded a port".

### How you use it at work

Every Kubernetes pod runs containers. The pod spec names an image, an args override, environment, and volume mounts. Those are `docker run`'s image, command, `-e`, and `-v`, written as API fields. ECS task definitions are the same four ideas. Lambda container images are the same image, with a different runner. If you can point at which part is the image and which part is the run config, those manifests stop looking like a new product.

The image is what CI builds once. The run config is what each environment changes. Mixing them, by rebuilding to change an environment variable, makes "what is in prod" unknowable. The registry lesson is about pinning the image. This lesson is about not putting the environment into it.

### Which object

| Question | Answer | Not |
|---|---|---|
| Where is the program's filesystem captured? | the image | the running container |
| Where do files written at run time go? | that container's writable layer | the image |
| What survives `docker rm` without a volume? | the image only | the writable layer |
| What does `-p 8080:8000` publish? | host port 8080 to container port 8000 | container 8080 to host 8000 |
| How does the browser on the host connect? | `localhost` and the host port | the container port, or a hostname `container` |
| How do two containers on one network connect? | the other container's network name | the host's published port |
| Where should logs go? | stdout and stderr | a file only inside the writable layer |
| Where should config that differs per environment go? | `-e` or a mount at start | a rebuild per environment |

### You can now

- Define an image, a container, and the writable layer, and say which one `docker rm` deletes.
- Read `-p HOST:CONTAINER` in the right direction and choose the URL a browser on the host opens.
- Put configuration in the environment and durable data on a volume, and say why a restart policy is neither of those.
- Expect `docker logs` to show stdout and stderr, not a file the process opened inside the container.
- Recognise a container on a Mac as a Linux process inside Docker Desktop's VM.

::: quiz
q: Your app inside a container listens on port 8000. `docker run -p 3000:8000 app`. Where do you point the browser?
+ `http://localhost:3000`
- `http://localhost:8000`
- `http://container:8000`
- Nowhere; containers can't be reached from the host
why: `-p HOST:CONTAINER`. The host's port 3000 is forwarded to 8000 inside the container.
:::

::: quiz
q: A Postgres container was removed and recreated from the same image. The data is gone. What was missing?
- A bigger image
+ A volume for `/var/lib/postgresql/data`; without one, the data lived in the container's writable layer, which is deleted with it
- `--restart always`
- A newer Postgres tag
why: Containers are disposable. Anything that must survive goes on a volume (or a managed database).
:::

::: card
q: Container vs virtual machine: what's the core difference?
answer: A VM runs a whole guest operating system on virtual hardware. A container is a process on the host's kernel, isolated with namespaces and limited with cgroups. It's lighter and starts in milliseconds, but shares the kernel.
:::

::: predict lang=python
q: A server inside a container listens on port 8000. It was started with `docker run -p 3000:8000`. This function builds the URL a browser on the host should open. What does it print?
code:
```python
host_port = 3000
container_port = 8000
print(f"http://localhost:{host_port}")
print(f"not {container_port}")
```
answer:
```text
http://localhost:3000
not 8000
```
why: `-p` is host port, then container port. The browser is on the host, so it uses 3000. Port 8000 is where the process listens inside its own network namespace. Opening 8000 on the host only works if some host process is actually bound there.
:::

::: quiz
q: An app in a container writes errors only to `/var/log/api.log` inside the container. `docker logs api` is empty. Why?
+ `docker logs` reads the process's stdout and stderr through the logging driver. A file in the container is not that stream.
- `docker logs` only works while the container is stopped.
- Log files are stored in the image, and this image has none yet.
- `-d` disables logs. Foreground containers log, detached ones do not.
why: The logging driver captures the standard streams. A path inside the container is just a file in the writable layer, and the platform never sees it. Detaching with `-d` does not drop those streams. It is why you can attach `docker logs` later.
:::

::: quiz
q: Dev, staging, and prod must run the same build of an API but talk to three different databases. What stays constant, and what changes?
+ The image stays the same build. Each `docker run` passes a different `DATABASE_URL` with `-e`.
- Three images, one per environment, with the URL written into a file at build time.
- One container, reused across environments, because the writable layer holds the URL.
- The image tag changes and the URL stays in the Dockerfile `ENV`, so a pull updates the URL.
why: The image is the build you tested. The environment variable is run config, so the same bytes can be pointed at another database. Baking the URL into the image makes three artifacts and you can no longer say prod runs the build staging ran. A tag does not carry a different `ENV` unless you rebuilt.
:::

::: card
q: In Docker, what is the difference between an image and a container?
answer: An image is the read-only filesystem layers plus the start config (command, user, environment, working directory). A container is a running or stopped instance of an image, with its own writable layer and its own process. Deleting the container deletes that writable layer. The image remains until you delete it.
:::

## Namespaces and cgroups
id: isolation
stage: basics
needs: what
minutes: 40
goal: Say which namespace hides a process, a mount, or a network, and which cgroup file actually stops a container from using the machine.
source: Linux man pages: namespaces(7) | https://man7.org/linux/man-pages/man7/namespaces.7.html
source: Linux kernel: Control group v2 | https://docs.kernel.org/admin-guide/cgroup-v2.html
source: Docker docs: Isolate containers with a user namespace | https://docs.docker.com/engine/security/userns-remap/

A second process on the same laptop can see your API, open its files, and use the rest of the memory. That is the problem namespaces and cgroups were built to shrink. A container is not a small virtual machine. It is one or more Linux processes whose view of the system has been narrowed, and whose CPU, memory, and process count have a ceiling. If you skip this lesson you will "fix" an out-of-memory kill by adding a volume, and you will look for a second kernel that is not there.

### The mental model

Linux does not start a guest operating system for a container. The host kernel stays in charge. It offers two different mechanisms, and people mix them up because both are configured on the same `docker run`.

A **namespace** changes what a process is allowed to *see*. Two processes in different PID namespaces can both believe they are PID 1. They are not the same process. The kernel keeps a parent map. A **cgroup** (control group) changes what a process is allowed to *consume*. It does not hide other processes. It accounts for CPU time, memory, and how many tasks exist, and it enforces the limit you set.

```mermaid
flowchart TB
  proc["container process"] --> ns["namespaces: what it can see"]
  proc --> cg["cgroup v2: what it can use"]
  ns --> pid["pid"]
  ns --> mnt["mount"]
  ns --> net["network"]
  ns --> uts["UTS hostname"]
  ns --> ipc["IPC"]
  ns --> cgns["cgroup namespace"]
  cg --> mem["memory.max"]
  cg --> cpu["cpu.max"]
  cg --> pids["pids.max"]
```

`namespaces(7)` lists eight kinds: mount, UTS, IPC, network, PID, user, cgroup, and time. A normal container from current Docker, which uses runc, gets its own mount, UTS, IPC, network, PID, and cgroup namespace. The user namespace is off unless you enable `userns-remap` or you are running a rootless engine. The time namespace exists in Linux so a process tree can see a different clock. Docker does not put ordinary containers in one, so `date` inside the container is the host clock, not a private clock.

On a Mac, none of this is the macOS kernel. Docker Desktop, Colima, and OrbStack run a small Linux virtual machine. `docker run` talks to a daemon inside that VM. The namespaces and cgroups live in the VM's Linux kernel. Activity Monitor on the Mac shows the VM, not a Linux PID 1 named `uvicorn`. That is why a port published on the Mac still has to cross from macOS into the VM and only then into the container network namespace.

### What each namespace actually hides

**PID.** Inside the container, the main process is PID 1. It sees only processes in its PID namespace. A sibling container's server does not appear in `ps`. On the host, that same process has an ordinary host PID, often a large number. PID 1 has a second job: if it dies, the container stops, and it is the process that receives `docker stop`'s signal. A shell that became PID 1 and does not forward signals is a runtime bug, covered later, but the reason it matters starts here.

**Mount.** The container has its own mount table. The image is mounted as its root filesystem. A volume is a mount you added on top. It cannot walk up to the host's `/home` unless you bind-mounted it in. `chroot` is the old, weaker idea. A mount namespace is how the filesystem view stays private even after the process is running.

**Network.** The container gets its own interfaces, its own routing table, and its own `localhost`. `localhost` inside is not the host and not the next container. Publishing `-p 8080:8000` is a packet path from the host's network namespace into this one. Host network mode, covered in the networking lesson, is the decision to *not* create this namespace.

**UTS.** Hostname and domain name. `--hostname api` changes what the process reads, not a DNS record that other containers use. Compose DNS is a network feature, not the UTS namespace.

**IPC.** System V shared memory and POSIX message queues. Two containers do not share them unless they share an IPC namespace. Most web apps never notice. A process that expected to attach to the host's shared-memory segment will fail, which is what you want.

**Cgroup namespace.** This one is easy to confuse with the cgroup limit itself. The limit is the cgroup. The namespace makes the container see that cgroup as its own root, so a process inside cannot read sibling containers' `memory.current` and cannot wander the host's cgroup tree. The numbers that enforce the limit are still the files the runtime wrote.

**User.** When it is on, UID 0 inside the container is some unprivileged UID on the host, such as 100000. Root in the container can install packages in its own mount namespace and still be nobody on the host. When it is off, UID 0 inside is UID 0 on the host. A bind mount written by that process is owned by root on the host. That is the default on Docker Engine with userns-remap left off. Rootless Docker and `userns-remap` turn the mapping on. Kubernetes has its own `runAsNonRoot` and user-namespace settings. They are the same idea, configured by the cluster instead of the daemon.

### Cgroup v2, which is the limit you meant

Modern systemd hosts and current Docker use **cgroup v2**: one hierarchy, mounted at `/sys/fs/cgroup`. v1 had separate mounts for cpu, memory, and devices. v2 puts them in one tree. Docker places each container in a directory under that tree and writes a few files.

`memory.max` is the hard memory ceiling, in bytes. `--memory=256m` is how you ask Docker to write it. If the container's processes go past it, the kernel's OOM killer sends **SIGKILL** to a process in that cgroup. The container exits. `docker inspect` then shows `OOMKilled` true and exit code 137. `memory.high` is a softer line: the kernel throttles reclaim before the hard kill. If you only remember one file, remember `memory.max`.

`cpu.max` is two integers, a quota and a period, both in microseconds. A period of `100000` is 100 ms. A quota of `50000` means the cgroup may run for 50 ms out of each 100 ms, which is half of one CPU. `--cpus=0.5` is that pair. The file can also contain `max` as the quota, which means no CPU ceiling. This is not a namespace. Other containers are still visible to the kernel scheduler. They just get their own quota.

`pids.max` caps how many tasks the cgroup may have. A fork bomb dies here instead of filling the host's process table, if you set it. Without it, a PID namespace does not stop the container from creating host processes until the host's global limit.

None of these files hide `/etc/passwd` or give the container a second kernel. A compromised process still calls the host kernel. The namespace makes the call see a private table. The cgroup makes the call fail or get killed when the budget is gone. A virtual machine would have run a second kernel on virtual hardware. That is heavier, and it is a different failure domain: a kernel panic in a VM stays in the guest. A kernel bug in a container is a host kernel bug.

### A worked limit

You start an API with a memory cap and half a CPU:

```bash
docker run -d --name api --memory=256m --cpus=0.5 myorg/api:1.4.2
```

The process inside can read its own cgroup files (the exact path depends on the cgroup namespace and on whether the runtime mounted `/sys/fs/cgroup`). What you observe from outside, without guessing the path:

```bash
docker stats api
docker inspect api --format '{{.HostConfig.Memory}} {{.HostConfig.NanoCpus}}'
```

`docker stats` shows a memory limit of 256 MiB and CPU as a percentage of the host. If the API leaks, the number climbs to the cap and the process disappears. The next start is a new container. The leak is not "in the image". The image is the filesystem. The memory was the cgroup, and it was released when the process was killed.

A second container with the same image does not share that cgroup. It has its own `memory.max`. They do share the host kernel and, if you scheduled them on one machine, the physical RAM. Two caps of 256 MiB can both be granted on a 512 MiB VM and then both get killed when the VM itself runs out, because the outer VM has a limit too. On Docker Desktop that outer limit is the VM's memory slider. Raising `--memory` above the VM does nothing useful.

### Where it breaks

**"The container has its own kernel."** It does not, except in the special case of a VM-based runtime such as Kata, which this course is not using. `uname` inside a normal container prints the host kernel's version. A module you load would be the host's module. You patch containers by patching the host kernel, or by moving the container to a host that is already patched.

**Treating a memory kill as a disk problem.** Exit 137 with `OOMKilled` true is `memory.max` or the outer VM. Adding a volume does not raise it. Exit 137 with `OOMKilled` false is often `docker kill` or the end of `docker stop`'s grace period, which is the runtime lesson.

**Expecting `ps` on the host to hide container processes.** The PID namespace hides them from the container, not from the host. The host sees every process. A monitoring agent on the host should see them. A monitoring agent inside the container should not see its neighbours.

**User namespace left off, plus a bind mount.** The container's root writes a file. The host's root owns it. A later process on the host can read it, and a backup tool treats it as a system file. Either run as a non-root user inside, or turn on a user namespace, and prefer a named volume when the data is the container's.

**Looking for cgroup v1 files on a v2 host.** `cpu.shares` and `memory.limit_in_bytes` are v1 names. On a unified v2 hierarchy the files are `cpu.max`, `cpu.weight`, and `memory.max`. Docker still accepts `--cpu-shares` and translates it. When you debug on the host, read the v2 names.

**Mac tools aimed at the container.** `lsof` on the Mac does not see the container's Linux sockets. Use `docker exec` or tools inside the VM. The networking lesson covers the port path. The isolation fact is only that the socket lives in the VM.

### How you use it at work

Kubernetes requests and limits are the same cgroup files, written by the kubelet instead of by `docker run --memory`. A pod limit of `256Mi` becomes `memory.max`. A CPU limit of `500m` becomes a `cpu.max` quota. Namespaces are still per container, with the pod sharing a network namespace across its containers so sidecars share `localhost`. That shared network namespace is the `container:` network mode you will meet later, raised to a pod.

Terraform or an ECS task definition sets the same two knobs: memory and CPU. When those are too low, the failure looks like a crash loop, not like a Terraform error. When they are unset on a shared node, one container's leak is the node's incident. The namespace does not save you from a missing limit.

### Which mechanism

| You wanted | Use | Not |
|---|---|---|
| Hide other processes from `ps` | PID namespace | a cgroup |
| A private `localhost` and routes | network namespace | UTS hostname |
| A private filesystem root | mount namespace | a volume by itself |
| A hostname the process reads | UTS namespace | Compose DNS |
| Root inside is not root on the host | user namespace | `USER` alone, which only changes the uid inside |
| Stop at 256 MiB | `memory.max` via `--memory` | a namespace |
| Half a CPU | `cpu.max` via `--cpus` | `--cpu-shares`, which is a weight, not a cap |
| See Linux namespaces on a Mac | the Docker Desktop VM | the macOS kernel |

### You can now

- Point at PID, mount, network, UTS, IPC, cgroup, and user namespaces and say what each one hides.
- Say why a time namespace is a Linux feature and not something a normal `docker run` turns on.
- Read `memory.max` and `cpu.max` as the cgroup v2 files behind `--memory` and `--cpus`.
- Explain exit 137 with `OOMKilled` as the memory controller, not as a deleted volume.
- Explain why Docker Desktop on a Mac still depends on a Linux kernel, and where that kernel runs.

::: quiz
q: Two Docker containers on one Linux host both show `uvicorn` as PID 1. How can both be PID 1?
+ Each container has its own PID namespace, so each main process is PID 1 only inside that namespace. On the host they have two different PIDs.
- Docker rewrites the host process table so every container replaces the real PID 1.
- PID 1 is the image name, not a process, so the number can be shared.
- Cgroup v2 assigns PID 1 to whichever container has the higher memory limit.
why: A PID namespace gives a process its own process-number space. The host still has one process table, and the two servers have two host PIDs. The tempting wrong answer is that cgroups pick PID 1. A cgroup limits CPU and memory. It does not renumber processes.
:::

::: quiz
q: A container exits with code 137 and `docker inspect` shows `OOMKilled` true. You had started it with `--memory=256m`. What fired?
+ The cgroup v2 memory controller hit `memory.max` and the kernel sent SIGKILL to a process in that cgroup.
- The PID namespace ran out of process numbers and reused PID 1.
- The mount namespace unmounted the image because the disk was full.
- Docker always uses exit 137 when a container is stopped with `docker stop`.
why: `--memory` writes a hard cap to `memory.max`. Crossing it is an OOM kill, which is SIGKILL, reported as 137, with `OOMKilled` set. A PID namespace does not kill a process for using memory. `docker stop` sends SIGTERM first, and a clean exit is not `OOMKilled`.
:::

::: quiz
q: You run Docker Desktop on a Mac and a container prints a Linux kernel version from `uname`. Where do its namespaces exist?
+ In the Linux virtual machine Docker Desktop runs. macOS is not the kernel providing those namespaces.
- In the macOS kernel, which implements Linux namespaces natively for Docker.
- In the image layers. Namespaces are files copied in by `FROM`.
- Nowhere. A container on a Mac is only a virtual machine with no namespaces inside.
why: Docker Desktop's daemon runs in a Linux VM. Namespaces and cgroups are features of that VM's kernel. The Mac shows you the VM. The tempting wrong answer is that the container is a VM with no namespaces. The VM is the host. The container inside it is still namespaced processes.
:::

::: card
q: In Docker, what is the difference between a namespace and a cgroup?
answer: A namespace limits what a process can see: process IDs, mounts, network interfaces, hostname, IPC, and its view of the cgroup tree. A cgroup limits what it can use. On cgroup v2, memory.max is the hard memory cap and cpu.max is a CPU quota. A namespace does not enforce memory.max, and a cgroup does not give the process its own PID 1.
:::

::: predict lang=python
q: Docker wrote a container's cgroup v2 `cpu.max` as a quota and a period in microseconds. This function turns that pair into the fraction of one CPU. What does it print?
code:
```python
quota = 50000
period = 100000
print(f"{quota / period:.1f}")
```
answer:
```text
0.5
```
why: `cpu.max` is quota then period. 50000 microseconds of run time in every 100000 microsecond period is half of one CPU, which is what `docker run --cpus=0.5` asks for. A weight such as `cpu.weight` is not this pair, so it would not print a hard fraction.
:::

::: quiz
q: User-namespace remapping is enabled on the daemon. A process is root inside the container and writes a file on a bind-mounted host directory. Who owns that file on the host?
+ The unprivileged host UID that the container's root is mapped to, not the host's real root.
- The host's real root, because UID 0 is always UID 0 on the host.
- Nobody, because a user namespace blocks writes to bind mounts.
- The owner of the image layer, because bind mounts write into the image.
why: With a user namespace, UID 0 in the container is a different UID on the host, so the file's numeric owner is that mapped UID. The tempting wrong answer is that UID 0 is always the host root. That is true only when user namespaces are off. A bind mount is the host directory, not an image layer.
:::

::: quiz
q: A container process lists `/sys/fs/cgroup` and sees only its own limits, not the neighbouring container's `memory.current`. Which feature does that?
+ Its cgroup namespace, which makes its cgroup the root of the tree it can walk.
- `memory.max`, which hides other cgroups when the number is small.
- The UTS namespace, which renames other containers' hostnames.
- The image config, which omits other containers at build time.
why: The cgroup namespace is what hides the rest of the cgroup tree. `memory.max` is only the cap inside this cgroup. It does not filter directory listings. UTS changes the hostname this process reads, not which cgroup files exist.
:::

## Image layers and the union filesystem
id: images
stage: basics
needs: isolation
minutes: 40
goal: Explain how overlay layers stack, what a whiteout is, and which settings live in the image config rather than in a layer.
source: Docker docs: OverlayFS storage driver | https://docs.docker.com/engine/storage/drivers/overlayfs-driver/
source: OCI image spec: image config | https://specs.opencontainers.org/image-spec/config/
source: Docker docs: Build cache | https://docs.docker.com/build/cache/

A one-line code change should not reinstall every dependency, and deleting a secret in a later step should not be how you "remove" it. Both surprises come from the same fact: an image is a stack of layers plus a separate config document. The stack is a union filesystem. The config is the default command, user, and environment. If you treat the image as one opaque file, you will rebuild too much and you will leak credentials that `rm` only hid.

### The problem

Copying a directory of an installed app is slow and shares nothing. Ten services that all start from the same base would store that base ten times. And a running container must be able to write files without changing the image other containers are starting from. Layers are the storage answer. Each layer is a diff: the files added, changed, or removed relative to the layer below. Images that share a base share those blobs in the registry and on disk.

The writable layer from the previous lesson is the same idea, added at run time and thrown away with the container. Build layers stay in the image.

### Union mount

Docker's usual storage driver on a modern Linux host is **overlay2**, an OverlayFS mount. A container's root filesystem is one merged view of several directories:

- **lowerdir** is the image layers, read-only, stacked from oldest to newest.
- **upperdir** is the container's writable layer.
- **workdir** is a scratch directory OverlayFS requires. You do not put files there yourself.
- **merged** is what the process sees as `/`.

```mermaid
flowchart BT
  base["lower: base image layer"] --> mid["lower: dependency layer"]
  mid --> app["lower: application layer"]
  app --> upper["upper: container writes"]
  upper --> merged["merged view the process sees"]
```

A file in an upper layer hides a file with the same path in a lower layer. The lower file is still in the lower blob. A read of that path returns the upper file. A read of a path that only exists below returns the lower file. That is the union. It is not a copy of every file into one directory at build time.

**Whiteouts.** Deleting a file does not edit the lower layer. OverlayFS records a whiteout in the upper layer: a character device with major and minor number 0, named as the deleted file. The merged view hides the lower file. The lower blob still contains the bytes. Anyone who pulls the image and reads the lower layer, or walks `docker history` and exports a layer, still has them. This is why `RUN echo "$TOKEN" > /tmp/tok && rm /tmp/tok` does not remove the token from the image. The `rm` is a later layer's whiteout. The supply-chain lesson treats that as a secret bug. Here it is the filesystem rule that makes the bug possible.

An **opaque directory** is the directory form of the same idea. Replacing a directory can hide everything that a lower layer had in it, without deleting those files out of the lower blob.

Sharing follows from content addressing. A layer blob is stored by the hash of its contents. Two images built from `python:3.12-slim` with the same next instruction reuse that blob. A registry stores it once. A host that already pulled it does not download it again. A change to an upper layer does not rewrite the lower hash. The lower layer stays shared.

### Image config is not a layer

The OCI image config is a JSON document beside the layers. It records how to run the filesystem, not the filesystem itself. The fields you set from a Dockerfile and then override at `docker run`:

| Config field | Dockerfile instruction | What a process sees |
|---|---|---|
| `Cmd` | `CMD` | the default arguments, or the whole command if there is no entrypoint |
| `Entrypoint` | `ENTRYPOINT` | the executable, with `Cmd` as its default arguments |
| `Env` | `ENV` | environment variables |
| `User` | `USER` | the uid and gid to run as |
| `WorkingDir` | `WORKDIR` | the current directory |
| `ExposedPorts` | `EXPOSE` | documentation for humans and for `-P`, not a published port |
| `Volumes` | `VOLUME` | a mount point marked so Docker creates a volume if you did not |
| `StopSignal` | `STOPSIGNAL` | the signal `docker stop` sends first |
| `Labels` | `LABEL` | metadata, not a file |

`CMD`, `ENV`, `USER`, `EXPOSE`, `ENTRYPOINT`, `WORKDIR`, and `STOPSIGNAL` do not add files. `docker history` shows them as a zero-byte step or as a config change. They still participate in the build cache: if that instruction changes, the builder rebuilds from there downward. The previous `RUN` layers stay cached. Changing `CMD` does not reinstall pip. Changing `RUN pip install` does not, by itself, change the command the container will run. Those are different objects, and the cache key includes both the instruction and the parent.

`ENV` is a special leak. It is config, so it is easy to think it is "not in the image". It is in the config JSON, and `docker inspect` prints it. A token in `ENV` is a token in every container started from the image. Prefer a run-time `-e` or a secret mount. The build lesson shows the mount. The rule here is that config is published with the image just as surely as a layer is.

### A small stack, walked

Imagine three instructions that create real files, then one that does not:

```dockerfile
FROM python:3.12-slim
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY main.py .
CMD ["python", "main.py"]
```

The `FROM` line selects a parent image, which is already a stack of layers plus its own config. `COPY requirements.txt` adds a layer whose diff is that one file. `RUN pip install` adds a layer whose diff is the installed packages under the target directory. `COPY main.py` adds a layer with `main.py`. `CMD` sets `config.Cmd` and does not add `main.py` again.

Change `main.py` and rebuild. The builder reuses the parent, the requirements layer, and the pip layer. It rebuilds the `COPY main.py` layer and the config. That is why the Dockerfile lesson puts dependencies before code. The union mount is what makes the reuse real: the pip layer's hash did not change, so nothing below it is rewritten.

Start two containers from that image. Each gets its own upperdir. One writes `/tmp/a`. The other does not see `/tmp/a`. Both see the same `main.py` from the lowerdirs. Remove the first container and `/tmp/a` is gone. `main.py` is not, because it was never in the upperdir.

Delete `main.py` in a later `RUN rm`. The merged view has no `main.py`. The `COPY` layer still does. A scanner that only looks at the merged view can miss it. A scanner that walks layers will not. You will use that fact when you talk about secrets. You need it now so a "clean" final listing does not feel like proof.

### Where it breaks

**Believing `rm` shrinks the image and removes the secret.** The new layer is a whiteout plus whatever else that `RUN` wrote. The previous layer's blob is still in the image manifest's layer list. Image size often goes up, not down. Multi-stage builds avoid the problem by never copying the bad layer into the final image. A whiteout in the same stage does not.

**Editing a file "in the image" through a running container.** You edited the upperdir. `docker commit` can turn that upperdir into a layer, and you will not be able to say how it was produced. The next build from the Dockerfile does not have the edit. Commit is not a build.

**A shared base that was not actually shared.** `python:3.12-slim` and `python:3.12-slim` share layers only when they are the same digest. If the tag moved between two builds, the "same" base is two stacks. The registry lesson pins the digest. The layer lesson is why the pin matters: the hash of every upper layer depends on the parent.

**Looking for the command in the filesystem.** `CMD` is not `/cmd`. `ENV` is not `/etc/environment` unless some `RUN` wrote it there. `docker inspect` on the image shows the config. `docker inspect` on the container shows the config after `docker run` overrides. A shell inside the container prints the environment the process got, which may include both.

**`VOLUME` in the Dockerfile.** It marks a path so Docker creates an anonymous volume when you run the container without a mount. That volume survives the container more often than people expect, and it hides whatever the image had at that path. Prefer an explicit named volume in Compose. The volume lesson is the detail. The image fact is that `VOLUME` is config, and it changes run-time mounts.

**Cache that ignores a file you thought was an input.** The cache key for `COPY` is the files it copies, after `.dockerignore`. A file that is not part of that instruction does not bust that layer. A file that is copied, even if your program never reads it, does. The build-context lesson is where ignore files are written. The cache rule starts with "the instruction and its inputs".

### How you use it at work

CI caches layers between builds. The speedup is not magic. It is the same parent hash. A Dockerfile that copies the whole repository first throws the cache away on every commit, so the pipeline spends its minutes in `pip` and `npm` instead of in tests. A registry bill is also a layer bill: you pay to store and to pull blobs. A fat base that every service copies is a tax on every deploy.

Vulnerability scanners and SBOMs read these same objects. A package in a lower layer is in the image even if a later layer deleted the binary, depending on the scanner. A package only in a build stage that was not copied forward is not in the image you push. "We deleted it" and "it is not in the final manifest" are different sentences. The small-image lesson is how you get the second one.

Kubernetes does not merge layers differently. The kubelet pulls the image, the runtime mounts overlay the same way, and the container's upperdir dies with the pod's container unless a volume is mounted on top. A `ConfigMap` is not a layer. It is a mount, like `-v`, applied at start.

### Which part of the image

| You changed | What is new | What is reused |
|---|---|---|
| One line of `main.py`, copied last | the code layer and the config after it | base and dependency layers |
| `CMD` only | the image config | every filesystem layer |
| `ENV TOKEN=...` | the config, and the token is now in the image | filesystem layers, but the secret is still published |
| `RUN rm` of a file from an earlier layer | a whiteout layer | the earlier blob, secret and all |
| The base image digest | every layer above it | nothing above the base |
| A file in a container's writable layer | that container only | the image, and every other container |

### You can now

- Describe a container root as an OverlayFS merge of read-only lower layers and a writable upper layer.
- Explain a whiteout, and why deleting a file in a later layer leaves the bytes in an earlier blob.
- Point at `CMD`, `ENV`, `USER`, and `EXPOSE` as image config, not as files in a layer.
- Say which layers a one-line code change rebuilds when dependencies were copied first.
- Say why two containers from one image do not see each other's `/tmp` writes.

::: quiz
q: A Dockerfile does `RUN echo "$TOKEN" > /secret` and a later instruction does `RUN rm /secret`. You start a container and `ls` does not show `/secret`. Is the token gone from the image?
+ No. `rm` writes a whiteout in a newer layer. The blob for the earlier layer still contains the file, and anyone who exports that layer can read it.
- Yes. OverlayFS edits the lower layer in place when you delete a file.
- Yes, but only if the second `RUN` is in the same stage. Whiteouts delete blobs.
- No, because `TOKEN` is stored in the container's upperdir at build time and every container gets a copy.
why: A lower layer is immutable. The delete is a whiteout in an upper layer, so the merged view hides the file and the old blob stays in the image. The tempting wrong answer is that OverlayFS edits the lower layer. It cannot. That immutability is also why layers are shareable.
:::

::: quiz
q: You change only the last line of a Dockerfile from `CMD ["python", "app.py"]` to `CMD ["python", "app.py", "--port", "8000"]` and rebuild. What is rebuilt?
+ The image config. The filesystem layers from the previous instructions stay cached, because `CMD` does not add a file and those instructions did not change.
- Every layer, because any Dockerfile edit invalidates the whole stack.
- Only the `RUN pip install` layer, because the command is part of the installed app.
- Nothing. `CMD` is applied by `docker run` and is not stored in the image.
why: `CMD` is image config. The build cache still restarts at the changed instruction, but the parent layers are reused, and no new file diff is required for the command itself. The tempting wrong answer is that the command is not stored in the image. It is stored. It is just not a layer of files. `docker run` can override it.
:::

::: card
q: In an OverlayFS container mount, what are lowerdir, upperdir, and the merged view?
answer: lowerdir is the image's read-only layers. upperdir is the container's writable layer. The merged view is what the process sees as its root: upper files hide lower files with the same path, and a whiteout in the upper layer hides a lower file without deleting it from the lower blob.
:::

::: predict lang=python
q: A build has five cached steps. The first input that changed is index 3 (the fourth step, counting from 0). This function prints which indexes rebuild and which stay cached. What does it print?
code:
```python
steps = ["FROM", "COPY requirements", "RUN pip", "COPY code", "CMD"]
changed = 3
print("rebuild " + " ".join(steps[changed:]))
print("cache " + " ".join(steps[:changed]))
```
answer:
```text
rebuild COPY code CMD
cache FROM COPY requirements RUN pip
```
why: The cache reuses every step before the first one whose instruction or inputs changed, then rebuilds that step and everything after it. `CMD` rebuilds even though it adds no files, because it follows the dirty step. The pip step stays cached because its parent and its inputs did not change.
:::

::: quiz
q: Two images on one host both start `FROM python:3.12-slim` at the same digest, then their Dockerfiles diverge. What do they share on disk?
+ The layer blobs of that shared base. Each image has its own upper layers and its own image config.
- Nothing. Docker copies the base into every image so they can diverge safely.
- The writable layer, so a file written in one container appears in the other image.
- The image config, including `CMD`, because the base config always wins.
why: Layers are content-addressed. The same base digest is the same blobs, stored once. Layers above the divergence are new. Writable layers belong to containers, not to the shared base. Each image's config is its own document, starting from the base config and applying its own `ENV` and `CMD`.
:::

::: config lang=dockerfile
task: This image installs curl with two RUN instructions, so the package indexes stay in an earlier layer after the second instruction deletes them. Install curl in a single RUN that updates, installs, and removes `/var/lib/apt/lists`. Keep `debian:bookworm-slim`. Do not add a second RUN.
starter:
```dockerfile
FROM debian:bookworm-slim
RUN apt-get update
RUN apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
CMD ["curl", "--version"]
```
check: FROM[0] ~ /^debian:bookworm-slim$/ | Base image stays debian:bookworm-slim
check: RUN count 1 | There is a single RUN, so the indexes are not their own layer
check: RUN[0] ~ /apt-get update/ | The same RUN updates the indexes
check: RUN[0] ~ /apt-get install/ | The same RUN installs curl
check: RUN[0] ~ /rm -rf \/var\/lib\/apt\/lists/ | The same RUN deletes the lists before the layer is committed
check: CMD[-1] ~ /curl/ | The command still runs curl
solution:
```dockerfile
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
CMD ["curl", "--version"]
```
hint: One RUN, joined with `&&`. If `rm` is a later RUN, the lists already exist in the previous layer and the whiteout does not remove that blob.
:::

::: quiz
q: `EXPOSE 8000` is in the Dockerfile. Nothing on the host is listening. What did `EXPOSE` change?
+ The image config's exposed-ports metadata. It does not publish a host port. Publishing is `-p` or a Compose `ports` entry at run time.
- It appended a layer that contains a proxy listening on 8000.
- It is the same as `docker run -p 8000:8000`.
- It writes a firewall rule in the host's network namespace when the image is built.
why: `EXPOSE` is documentation in the image config, and it is the set `-P` consults. The build does not open a host socket. The tempting wrong answer is that it equals `-p`. `-p` is run config and names both the host port and the container port.
:::

## Writing a Dockerfile
id: dockerfile
stage: basics
needs: images
minutes: 40
goal: Write a Dockerfile whose dependency layers stay cached, whose server is reachable, and whose command and user are image config.
source: Docker docs: Dockerfile reference | https://docs.docker.com/reference/dockerfile/
source: Docker docs: Build cache | https://docs.docker.com/build/cache/
source: Docker docs: Building best practices | https://docs.docker.com/build/building/best-practices/

A Dockerfile is a script that produces an image: a stack of layers and a config. The order of the lines is the cache. A line in the wrong place does not fail the build. It makes every commit reinstall the world, or it bakes a setting you meant to pass at run time. This lesson is the instructions and the order. The next one is the build context and BuildKit mounts, which change what those instructions can see.

### The problem

You have a Python or Node app and a base image that already has the runtime. You need one file a teammate, CI, and production can build the same way. Shell history is not that file. A Dockerfile is. It is also the place people hide a twenty-minute rebuild in a single `COPY . .` at the top, and the place a server gets bound to `127.0.0.1` so `-p` looks broken.

### What each instruction writes

| Instruction | When it runs | Layer or config |
|---|---|---|
| `FROM` | selects the parent image | the stack you start from. A second `FROM` starts another stage |
| `WORKDIR` | sets the directory for later instructions | config, and it creates the directory |
| `COPY` and `ADD` | read the build context, or another stage | a filesystem layer |
| `RUN` | runs a command in a temporary container | a filesystem layer with whatever the command changed |
| `ENV` | sets an environment variable for later build steps and for the container | config |
| `ARG` | a build-time variable, not automatically in the final config | not in the image unless you copy it into `ENV` |
| `USER` | the user for later `RUN` and for the container | config |
| `EXPOSE` | documents a port | config. It does not publish |
| `CMD` | default command when the container starts | config. It does not run at build time |
| `ENTRYPOINT` | the executable, with `CMD` as its default arguments | config |
| `STOPSIGNAL` | the signal `docker stop` sends | config |

`RUN` happens now, during the build, and the resulting files are committed. `CMD` happens later, when someone starts a container. Mixing them up is the bug where a Dockerfile "runs the server" during the build and the build hangs, or where the server command was a `RUN` and the finished image exits immediately because `CMD` is still the base image's shell.

`COPY` is the one you want for local files. `ADD` can also unpack a local tar and fetch a URL. Fetching a URL in `ADD` is harder to cache and harder to review than a `RUN curl` you pinned. Use `COPY` unless you mean the tar behaviour.

The **exec form** is a JSON array: `CMD ["uvicorn", "main:app"]`. The **shell form** is a string: `CMD uvicorn main:app`, which the builder wraps in `/bin/sh -c`. Shell form gives you variable expansion and also puts `sh` in front of your process. For `RUN`, the shell is usually what you want, because you need `&&`. For `CMD` and `ENTRYPOINT`, the JSON form is what you want, so your program is PID 1. The runtime lesson is the signal. The Dockerfile fact is that the form is part of the config you are writing.

`ENTRYPOINT` is the fixed program. `CMD` is the default arguments, and `docker run myimg --help` replaces `CMD` only. `docker run --entrypoint` replaces the program. If you set both in shell form, the wrapping gets confusing. Set `ENTRYPOINT` as JSON when the image is a single command, and leave `CMD` as the default flags.

### Cache order

The builder reuses a step when the instruction and its inputs match the cached parent. The first miss rebuilds that step and every step after it. So the file is sorted from least volatile to most volatile:

1. `FROM` a pinned base.
2. System packages, in one `RUN`.
3. The dependency manifest only: `requirements.txt`, or `package.json` and the lockfile.
4. The install `RUN`.
5. The rest of the source.
6. `USER`, `EXPOSE`, `CMD`, which are config and cheap, but still last so a config tweak does not sit in the middle of the installs.

```mermaid
flowchart LR
  base["FROM pinned base"] --> sys["RUN system packages"]
  sys --> man["COPY manifest"]
  man --> inst["RUN install"]
  inst --> src["COPY source"]
  src --> cfg["USER EXPOSE CMD"]
```

`COPY . .` before `pip install` means a one-line edit to `main.py` is an input to the install step. The install reruns. The image is correct and the pipeline is slow. Copying the manifest first makes the source edit a miss only at the later `COPY`.

`ARG` declared before `FROM` is only available to `FROM`. An `ARG` after `FROM` is available to later instructions in that stage. Changing an `ARG` that a `RUN` uses busts the cache from that `RUN` down. Do not pass secrets as `ARG`. The value ends up in build history. BuildKit secret mounts are the next lesson.

`ENV` persists in the image config. `ARG` does not, unless you write `ENV TOKEN=$TOKEN`, which is how a build-time value becomes a published one. That line is almost never what you want for a credential.

Pin the base. `python:3.12-slim` is a tag, and tags move. It is still better than `latest`. A digest pin is the registry lesson. Floating `latest` means yesterday's build and today's build are not the same parent, so nothing caches and prod is not what you tested.

### A Python file, annotated

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

`WORKDIR /app` creates `/app` and makes it the current directory for `COPY` and `CMD`. Paths in `COPY` are relative to it when the destination is relative.

`COPY requirements.txt .` copies one file from the build context. The context is the directory you passed to `docker build`, not "the whole computer" and not "whatever git would commit". If `requirements.txt` is missing from the context, the build fails. If a huge unrelated directory is in the context, the client still sends it. `.dockerignore` is how you cut that down. It is not `.gitignore`. Git's ignore file is not read by the builder.

`--no-cache-dir` keeps pip from storing a download cache inside the layer. That cache would be a layer of files you never run. A BuildKit cache mount, next lesson, is the way to keep the download cache between builds without putting it in the image.

`COPY . .` is the source. It comes after the install. It also copies anything in the context you forgot to ignore, including a local `.env`.

`EXPOSE 8000` documents the port. The process still has to listen, and the operator still has to publish.

`--host 0.0.0.0` is the container's network namespace. A server on `127.0.0.1` accepts connections only from inside that namespace. The Docker proxy connects to the container's eth0 address. The connection is refused, and the host port looks open. Binding all interfaces inside the container is what makes `-p` work. It does not publish the port by itself.

### Where it breaks

**Shell-form `CMD`.** `CMD uvicorn main:app` stores `sh -c` as the command. The build succeeds. The stop signal goes to `sh`. Use the JSON array.

**`RUN` to start the server.** The build reaches that line and sits there until the server exits. Start commands belong in `CMD` or `ENTRYPOINT`.

**Two `RUN` lines for apt.** `apt-get update` in one layer and `apt-get install` in the next means the index layer is cached separately. An install can run against a stale index, and deleting the lists in a third `RUN` leaves them in the earlier blob. One `RUN`, joined with `&&`, commits the result once.

**`ADD` of a URL.** The file is whatever that URL returned the day the layer was built. You have no checksum in the Dockerfile unless you added one. `COPY` a vendored file, or `RUN` a download that checks a hash.

**Instructions after a cache miss that did not need to be.** A `LABEL` or `ARG` in the middle of the file that changes every build, such as a timestamp, dirties every layer below it. Put volatile metadata last, or accept that you turned the cache off.

**`USER` before the files are owned.** `COPY` as root, then `USER app`, means the files are root-owned and the app may not be able to read a directory that is not world-readable, or may not be able to write its own work directory. `COPY --chown=app` or a `chown` in the same layer as the copy fixes the ownership. The small-image lesson makes this the default shape.

### How you use it at work

The Dockerfile is the build contract CI runs. A developer machine with extra packages installed is not the contract. If it builds in CI from a clean context, it builds for someone else. The same file is what a Kubernetes deployment eventually runs, after a registry stores the result. The deployment does not read the Dockerfile. It pulls the image the Dockerfile produced. A bug in instruction order is a cost bug in CI. A bug in `CMD` is a runtime bug in every cluster that pulls the image.

Compose can pass build args and a context. It does not replace the Dockerfile. A `command:` in Compose overrides `CMD` for that Compose run. Production should not depend on a Compose override the cluster will never see. Put the real command in the image. Override it only when the override is also in the deployment manifest.

### Which instruction

| You want | Write | Do not write |
|---|---|---|
| Files from the build context | `COPY` | `ADD`, unless you need to unpack a tar |
| A tool installed into the image | one `RUN` that installs and cleans | `CMD apt-get install`, which runs too late |
| Dependencies cached across code edits | `COPY` the manifest, `RUN` install, then `COPY` the source | `COPY . .` before the install |
| The process that starts at `docker run` | exec-form `CMD` or `ENTRYPOINT` | shell-form `CMD`, or `RUN` of the server |
| A port published on the host | `-p` or Compose `ports` | `EXPOSE` alone |
| A reachable server behind `-p` | listen on `0.0.0.0` | listen on `127.0.0.1` |
| A value only the build needs | `ARG`, and never a secret | `ENV` of a token |
| A value every container should have | `ENV`, or `-e` at run time | a rebuild per environment |

### You can now

- Sort a Dockerfile so a code change does not reinstall dependencies, and say which step is the first cache miss.
- Choose `COPY` over `ADD`, and `RUN` over `CMD`, for the jobs they actually do.
- Write `CMD` and `ENTRYPOINT` in JSON form and say what the shell form wraps them in.
- Bind a server to `0.0.0.0` and say why `EXPOSE` did not publish it.
- Keep an `ARG` out of `ENV` so a build-time value does not become image config.

::: quiz
q: You changed one line of `main.py`. With the Dockerfile above, which steps rebuild?
- All of them
- Only `RUN pip install`
+ Only `COPY . .` and what comes after it; the dependency layers come from the cache
- None; Docker detects it's only Python
why: The first instruction whose input changed is `COPY . .` (main.py is in the context). Everything above it is cached, which is why dependencies are copied and installed first.
:::

::: config lang=dockerfile
task: This Dockerfile works, but every code change reinstalls every dependency, and the server can't be reached from outside the container. Fix the order (dependencies before code) and make uvicorn listen on all interfaces. Keep `python:3.12-slim`.
starter:
```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY . .
RUN pip install --no-cache-dir -r requirements.txt
CMD ["uvicorn", "main:app", "--port", "8000"]
```
check: FROM[0] ~ /^python:3\.12-slim$/ | Base image is python:3.12-slim
check: seq ~ /COPY requirements\.txt[^\n]*\nRUN pip install[^\n]*\nCOPY \. / | requirements.txt is copied and installed before the rest of the code
check: CMD[-1] ~ /"--host",\s*"0\.0\.0\.0"/ | uvicorn listens on 0.0.0.0
check: CMD[-1] ~ /^\[/ | CMD uses the exec form ["…", "…"]
solution:
```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```
hint: `COPY requirements.txt .`, then `RUN pip install …`, then `COPY . .`. Add `"--host", "0.0.0.0"` to the CMD list.
:::

::: quiz
q: A Dockerfile sets `ARG PIP_INDEX` after `FROM` and uses it in a `RUN`. It never assigns `ENV PIP_INDEX`. You start a container from the image and print the environment. What do you find?
+ `PIP_INDEX` is not in the container environment. `ARG` is build-time only, unless you copy it into `ENV`.
- `PIP_INDEX` is in the image config because every `ARG` is saved as an environment variable.
- `PIP_INDEX` is in a layer file at `/etc/profile.d`, which the shell reads.
- The build fails, because `ARG` is illegal after `FROM`.
why: An `ARG` after `FROM` is visible to later build instructions in that stage and is not written to the image config by itself. `ENV PIP_INDEX=$PIP_INDEX` would publish it. `ARG` before `FROM` is the one that only applies to `FROM`. The build does not fail for an `ARG` after `FROM`.
:::

::: quiz
q: `CMD ["python", "server.py"]` and `ENTRYPOINT ["python", "server.py"]` are different configs. You run `docker run myimg --help`. What runs?
+ With `ENTRYPOINT ["python", "server.py"]` and no `CMD`, `--help` is an extra argument to `server.py`. With only `CMD ["python", "server.py"]`, `--help` replaces the whole command.
- They are the same. Docker treats `CMD` and `ENTRYPOINT` as two names for the shell form.
- `--help` always replaces `ENTRYPOINT`, and `CMD` is only documentation.
- The build fails if both words appear in the same file.
why: `docker run` arguments replace `CMD`. They are appended to `ENTRYPOINT`. That is why the fixed program belongs in `ENTRYPOINT` and the default flags belong in `CMD`. The tempting wrong answer is that the two instructions are aliases. They are two fields in the image config.
:::

::: predict lang=python
q: This Dockerfile's steps are cached until an input changes. `main.py` changed, and it is copied only by the fourth step (index 3). What does the function print?
code:
```python
steps = ["FROM", "COPY requirements", "RUN pip", "COPY .", "CMD"]
changed = 3
print(" ".join(steps[changed:]))
```
answer:
```text
COPY . CMD
```
why: The first dirty step and everything after it rebuild. `COPY requirements` and `RUN pip` are above the source copy, so they stay cached. `CMD` is after the dirty copy, so it is rewritten even though the command text did not change.
:::

::: quiz
q: In a Dockerfile, `ADD https://example.com/tool.tgz /tmp/tool.tgz` and `COPY tool.tgz /tmp/tool.tgz` both put a file in the image. Why do build guides prefer `COPY` for a file you already have?
+ `COPY` only takes files from the build context or a stage, so the blob you put in the image is the blob you reviewed. `ADD` of a URL downloads during the build and can unpack archives you did not mean to unpack.
- `COPY` compresses the file and `ADD` does not, so `COPY` layers are smaller.
- `ADD` is invalid in current Dockerfiles. The instruction was removed.
- `COPY` publishes the port the tool listens on, and `ADD` does not.
why: `ADD` has extra behaviour: URL fetch and automatic tar extraction. That makes the layer depend on a remote response or on archive side effects. `COPY` is the plain instruction. `ADD` was not removed. Neither instruction publishes a port.
:::

::: config lang=dockerfile
task: The server command is shell form, so a shell is in front of Python, and the port is only documented. Make Python itself the command, with the JSON form, listening on all interfaces at port 8000. Keep the base image and the install. Do not publish the port in this file. `EXPOSE` may stay.
starter:
```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8000
CMD python server.py
```
check: FROM[0] ~ /^python:3\.12-slim$/ | Base image stays python:3.12-slim
check: CMD[-1] ~ /^\[/ | CMD is the exec form
check: CMD[-1] ~ /"python", "server\.py"/ | Python runs server.py directly
check: CMD[-1] ~ /"--host", "0\.0\.0\.0"/ | The server listens on all interfaces
check: CMD[-1] ~ /"--port", "8000"/ | The server uses port 8000
check: CMD[-1] !~ /sh -c/ | A shell is not the command
solution:
```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8000
CMD ["python", "server.py", "--host", "0.0.0.0", "--port", "8000"]
```
hint: Replace the shell-form `CMD` with a JSON array. `EXPOSE` does not bind an address. The `--host` flag has to be in the command the process actually runs.
:::

## Build context and BuildKit mounts
id: buildkit
stage: basics
needs: dockerfile
minutes: 40
goal: Keep the build context small, and use cache mounts and secret mounts so downloads and credentials never become layers.
source: Docker docs: Build context | https://docs.docker.com/build/concepts/context/
source: Docker docs: Optimize cache usage in builds | https://docs.docker.com/build/cache/optimize/
source: Docker docs: Build secrets | https://docs.docker.com/build/building/secrets/
source: Docker docs: RUN --mount | https://docs.docker.com/reference/dockerfile/#run---mount

`docker build` does not read your repository live, file by file, as each `COPY` runs. The client first sends a **build context** to the builder. Whatever is in that context can be copied into a layer. Whatever is not, the Dockerfile cannot see. BuildKit, the builder current Docker Engine uses, adds mounts that exist only for one `RUN`: a cache directory that is not committed, and a secret file that is not committed. Without those, people either put a token in `ARG` or disable the cache to keep credentials out.

### The context is a copy, filtered first

The path you pass, usually `.`, is the context. The client packs it and sends it. On a remote builder that pack is a real upload. A context that contains `.git`, `node_modules`, test videos, and `.env` is hundreds of megabytes of waiting before the first instruction, and it is a cache hazard: any change to any file that a `COPY` includes busts that `COPY`.

`.dockerignore`, in the root of the context, is applied **before** the pack. It is not `.gitignore`. Git never sees the Docker ignore file, and Docker does not read `.gitignore` unless you copied the same patterns yourself. A secret in `.env` that git ignores is still sent, and `COPY . .` still bakes it in, until `.dockerignore` lists it.

Patterns are gitignore-like. A line `node_modules` drops that directory. A later line starting with `!` puts something back. The Dockerfile and the ignore file itself are still available to the builder even if you ignore them, but you cannot `COPY` a file you ignored. The build fails with a missing file rather than copying the secret. That failure is the better outcome.

A Dockerfile-specific ignore file, named `<Dockerfile-name>.dockerignore`, overrides the plain `.dockerignore` when you build with that Dockerfile. Teams with `Dockerfile` and `Dockerfile.ci` use this so CI does not send the fixtures the local file needs.

```mermaid
flowchart LR
  dir["context directory"] --> ign[".dockerignore"]
  ign --> pack["packed context"]
  pack --> builder["BuildKit"]
  builder --> copy["COPY into a layer"]
  builder --> mount["RUN --mount, not a layer"]
```

Bind-mounting the context into a `RUN` (`--mount=type=bind`) is different from `COPY`. The files are visible to that command and are not committed unless the command writes them somewhere else. The best-practices guide uses this for a manifest you only need during `pip install`. If the final image needs the file, you still `COPY` it.

### Cache mounts

A layer cache reuses a `RUN` only when the instruction and its inputs are unchanged. A **cache mount** is a directory BuildKit keeps on the builder and mounts for the duration of one `RUN`. It is not a layer. The next build, even when the `RUN` itself reruns, can see the same directory.

Pip's download cache is the usual example:

```dockerfile
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt
```

The installed packages still land in the image, in the layer this `RUN` commits. The wheels under `/root/.cache/pip` do not. `--no-cache-dir` was the older way to keep that directory out of the layer, at the cost of redownloading on every miss. A cache mount is the way to redownload less without storing the cache in the image.

The mount has a `sharing` mode. `shared` lets two builds use it at once. `locked` makes them take turns, which is what you want for a package manager that does not tolerate two writers. The default is `shared`. For pip, apt, and npm, `sharing=locked` avoids corrupt caches.

The cache lives on the builder. A new CI worker with an empty disk does not have it. Layer cache and cache mounts are both local to where the build runs, unless you export a cache (`--cache-to` and `--cache-from`) to a registry. Exporting is how a second worker reuses work. It is optional. The mount syntax is what keeps the cache out of the image either way.

`id` separates caches. Two `RUN` lines that mount the same `target` path but different ids do not share bytes. Two lines that omit `id` and use the same target share one cache. Name an id when two tools would otherwise collide.

### Secret mounts

A secret mount exists only while the `RUN` is executing. It is not in the layer, not in the image config, and not in `docker history` as a value.

```dockerfile
RUN --mount=type=secret,id=pip_url \
    pip install --extra-index-url "$(cat /run/secrets/pip_url)" privatepkg
```

You pass the file at build time, not in the Dockerfile:

```bash
docker build --secret id=pip_url,src=./pip_url.txt .
```

The default file inside the build is `/run/secrets/<id>`. `target=` moves it. The secret is mounted read-only. The command may read it. If the command writes the value into a file under `/usr` or into an `ENV`, you have copied it into the image yourself. The mount did not save you from that line.

`ARG` and `ENV` are the wrong place for this. `ARG` leaks into history when the instruction that used it is recorded. `ENV` is the image config, printed by `inspect`. A multi-stage build does not scrub an `ENV` you set in the final stage. A secret mount in a build stage, never copied forward, is the pattern that matches how the layer stack actually works.

SSH mounts (`--mount=type=ssh`) are the same idea for a private git clone during the build. The agent socket is there for the `RUN` and is not copied in. Prefer a vendored dependency or a token via a secret mount if you do not already run an agent. The point is the same: credentials are inputs to a command, not contents of a layer.

### A worked pair

Bad:

```dockerfile
ARG TOKEN
RUN pip install --extra-index-url "https://user:${TOKEN}@private.example/simple" privatepkg
```

The token is a build argument. History records the `RUN` line. Anyone with the image can often recover build args from history. The layer may also contain the URL in a pip log if you left logs in the image.

Better:

```dockerfile
RUN --mount=type=cache,target=/root/.cache/pip,sharing=locked \
    --mount=type=secret,id=pip_url \
    pip install --extra-index-url "$(cat /run/secrets/pip_url)" -r requirements.txt
```

The index URL is a file the CI secret store wrote, passed with `--secret`, and not listed in the Dockerfile. The wheel cache is a mount. The image contains the installed package and not the URL. Rebuilds on the same builder reuse the wheels even when `requirements.txt` changes enough to rerun the install.

You still copy `requirements.txt` before the rest of the source. Cache mounts do not replace instruction order. They sit on top of it. A `COPY . .` before this `RUN` still reruns the install on every code change. The mount only makes that rerun cheaper, and only on a builder that still has the cache.

### Where it breaks

**Ignoring with git and not with Docker.** `.gitignore` lists `.env`. The context still has `.env`. `COPY . .` copies it. Add it to `.dockerignore`, and do not `COPY` it back with a `!` exception you copied from a blog.

**A cache mount mistaken for a layer.** You `ls /root/.cache/pip` in the running container and the directory is empty or missing. That is success. The packages you installed are under the Python prefix, which the `RUN` wrote outside the mount. If the install wrote only into the cache directory, the image does not have the package.

**`sharing=shared` on a picky tool.** Two parallel builds corrupt an apt cache and the next install fails in a way that looks like a network bug. Lock the mount.

**Secret in the command string.** `RUN --mount=type=secret ... && echo "$TOKEN"` with `TOKEN` from an `ARG` writes the value into history even though a mount exists. The mount has to be the only path the secret takes. Read the file inside the command. Do not `echo` it.

**Ignoring a file you later `COPY`.** The build error says the file is excluded. Fix the ignore pattern or the `COPY`. Do not "fix" it by deleting the ignore file, or the `.env` comes back.

**Assuming the CI cache mount is warm.** The first build on a new worker pays the full download. A cache export to the registry is what warms the next worker. Until you configure it, a cache mount is a local accelerator, not a distributed one.

### How you use it at work

CI logs are full of "sending build context". If that step takes longer than the compile, the ignore file is wrong. The same ignore file is a security control: the context is the set of files the build machine is allowed to put into a layer by accident. A smaller set is a smaller accident.

Secret mounts match how CI already stores credentials, as files or variables it can write to a temporary file. The Kubernetes secret you mount into a pod at run time is a different mount, for the running app. Do not confuse them. The build secret is for fetching private dependencies. The run-time secret is for the app talking to the database. An image that needed the database password at build time is an image that captured an environment.

Registries can store BuildKit cache and can store attestations about how the image was built. The supply lesson covers the attestation and the SBOM. The mount is what makes "the secret is not in the blob" true before the scanner runs.

### Which mechanism

| Need | Use | Not |
|---|---|---|
| Don't send `.env` or `.git` | `.dockerignore` | `.gitignore` alone |
| Reuse downloads without storing them | `RUN --mount=type=cache` | `--no-cache-dir` if you wanted the reuse, or a committed cache directory |
| A token only during `pip` or `npm` | `RUN --mount=type=secret` and `docker build --secret` | `ARG` or `ENV` |
| A file in the final image | `COPY` | a bind mount, which is gone when `RUN` ends |
| A file only during one `RUN` | `--mount=type=bind` or a secret mount | `COPY` plus a later `rm` |
| Share a cache between CI workers | `--cache-from` / `--cache-to` | a cache mount alone |

### You can now

- Describe the build context as a pack sent to the builder, filtered by `.dockerignore` first.
- Say why `.gitignore` does not keep `.env` out of an image.
- Add a pip or npm cache mount and say why the cache directory is empty in the running container.
- Pass a registry token with a secret mount and say why `ARG` would leak it.
- Explain `sharing=locked` as a way to keep two builds from writing one cache.

::: quiz
q: `.gitignore` lists `.env`. `.dockerignore` does not. The Dockerfile says `COPY . .`. What is in the image?
+ `.env`, because the build context is filtered by `.dockerignore`, not by git. Git's ignore list is never consulted.
- Nothing from `.env`. Docker reads `.gitignore` when `.dockerignore` is missing.
- `.env` is sent to the builder but `COPY . .` skips hidden files.
- The build fails, because a secret in the context is a hard error.
why: Only `.dockerignore` removes files from the context before it is sent. A missing ignore file means the file is sent and `COPY` includes it. The build does not special-case secrets. Hidden files are ordinary files.
:::

::: quiz
q: A `RUN --mount=type=cache,target=/root/.cache/pip` installs a package. You start the image and look at `/root/.cache/pip`. What do you find, and where is the package?
+ The cache directory is not part of the image. The package is wherever pip installed it outside that mount, and that location is in the layer.
- The cache directory is in the image, which is how the next build stays fast.
- The package is only in the cache mount, so the container has no site-packages until you mount the cache again.
- The mount writes a layer, then BuildKit deletes the layer after the push.
why: A cache mount is builder state, not a committed diff. Files pip wrote outside the mount are the layer. If the package existed only inside the mount, the image would not contain it. The next build finds the cache on that builder, not by pulling the image.
:::

::: quiz
q: CI needs a private package index during `docker build`. Which input keeps the token out of the image config and out of the layer history?
+ `docker build --secret id=pip_url,src=...` and a `RUN --mount=type=secret` that reads the file. The Dockerfile never contains the token.
- `ARG TOKEN` and a `RUN` that uses `$TOKEN`. Build args are erased from history automatically.
- `ENV TOKEN=...` in a build stage, because only the final stage is pushed.
- `COPY .netrc .` and a later `RUN rm .netrc`. The `rm` drops the file from every layer.
why: A secret mount lasts for one `RUN` and is not committed. `ARG` is recorded in build history. `ENV` in the final stage is image config, and `ENV` in an earlier stage is still a bad habit if that stage's layers are exported. `rm` is a whiteout, so the copy remains in the earlier layer.
:::

::: card
q: What is a Docker build context, and when is `.dockerignore` applied?
answer: The build context is the directory tree the client sends to the builder. `.dockerignore` in that directory is applied before the tree is packed, so ignored files are never sent and cannot be COPY'd. It is not .gitignore. A cache mount or a secret mount is extra state for one RUN and is not a file from the context unless you point it at one.
:::

::: predict lang=python
q: A context has four paths. The ignore list drops anything whose name starts with a dot, and also `tests`. This function prints what is left, in the given order. What does it print?
code:
```python
paths = [".env", "main.py", "tests", "requirements.txt"]
ignore = {".env", "tests"}
print(" ".join(p for p in paths if p not in ignore))
```
answer:
```text
main.py requirements.txt
```
why: `.dockerignore` removes matching paths before the context is sent. `.env` and `tests` are gone, so a later `COPY . .` cannot put them in a layer. `requirements.txt` stays because the install needs it. Git ignore rules are a different list and are not this filter.
:::

::: config lang=dockerfile
task: The token is in an `ARG` and the `RUN` line interpolates it, so it lands in build history. Install `requirements.txt` with a secret mount `id=pip_url` whose file is at `/run/secrets/pip_url`, and a cache mount at `/root/.cache/pip` with `sharing=locked`. Do not declare an `ARG` or an `ENV`. Keep `python:3.12-slim`.
starter:
```dockerfile
FROM python:3.12-slim
WORKDIR /app
ARG TOKEN
COPY requirements.txt .
RUN pip install --extra-index-url "https://user:${TOKEN}@private.example/simple" -r requirements.txt
COPY . .
CMD ["python", "main.py"]
```
check: ARG missing | No build-arg token
check: ENV missing | No token in the image environment
check: seq ~ /RUN --mount=type=cache,target=\/root\/\.cache\/pip,sharing=locked/ | pip's download cache is a locked cache mount
check: seq ~ /--mount=type=secret,id=pip_url/ | The index URL comes from a secret mount
check: seq ~ /\/run\/secrets\/pip_url/ | The RUN reads the secret file
check: seq !~ /TOKEN/ | The token name is not in an instruction
check: CMD[-1] ~ /"python", "main\.py"/ | The command is unchanged
solution:
```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip,sharing=locked --mount=type=secret,id=pip_url pip install --extra-index-url "$(cat /run/secrets/pip_url)" -r requirements.txt
COPY . .
CMD ["python", "main.py"]
```
hint: Put both `--mount` flags on the same `RUN`. Read `/run/secrets/pip_url` inside the command. Delete the `ARG` line so the token has no instruction to appear in.
:::

::: quiz
q: Two CI jobs build the same Dockerfile at the same time on one builder, both with `--mount=type=cache,target=/root/.cache/pip`. The package tool corrupts its cache if two writers run. What do you set?
+ `sharing=locked` on that mount, so BuildKit runs those RUNs one at a time against the cache.
- `sharing=shared`, which makes BuildKit copy the cache per build.
- A separate `docker volume` in the Dockerfile. Cache mounts are volumes.
- `.dockerignore` on `/root/.cache/pip`, so the second build cannot see the cache.
why: `locked` serialises writers of one cache mount. `shared` allows concurrency and is the default. A cache mount is builder state, not a Docker volume in the Dockerfile, and `.dockerignore` only filters the context the client sends.
:::

## Small, safe images
id: small-images
stage: prod
needs: buildkit
minutes: 40
goal: Ship a final stage that has the runtime and the app, runs as a non-root user, and does not contain the compilers used to build it.
source: Docker docs: Multi-stage builds | https://docs.docker.com/build/building/multi-stage/
source: Docker docs: Building best practices | https://docs.docker.com/build/building/best-practices/
source: Distroless container images | https://github.com/GoogleContainerTools/distroless

The image that built your app and the image that runs it do not have to be the same stack. A compiler, a package manager, and a shell are useful while you build and useful to an attacker after you ship. Multi-stage builds are how you throw that stack away and copy forward only the files the process needs. A non-root user is how a compromise inside the container starts with fewer permissions. Small is not a vanity metric. It is fewer bytes to pull and fewer packages to scan.

### The problem

`python:3.12` is a full distribution. It compiles C extensions, and it also ships tools you will never call in production. Every extra package is a CVE you have to read. Every extra hundred megabytes is a slower pull when a node scales out. And the default user is root. A bug that lets someone run a command runs it as root in the container's namespaces. If user-namespace remapping is off, that uid is root on the host as well, which turns a bind mount into a host file written by root.

You want the opposite shape: build with whatever tools you need, run with a slim or distroless base, as a user that owns only the app.

### Two stages, one result

A stage starts at `FROM`. `FROM ... AS build` names it. The next `FROM` starts a new filesystem. Nothing from the first stage is in the final image unless you `COPY --from=build`.

```dockerfile
FROM python:3.12-slim AS build
WORKDIR /app
RUN python -m venv /venv
COPY requirements.txt .
RUN /venv/bin/pip install --no-cache-dir -r requirements.txt

FROM python:3.12-slim
WORKDIR /app
RUN useradd --create-home app
COPY --from=build /venv /venv
COPY . .
USER app
CMD ["/venv/bin/uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

The final manifest's layers are the second `FROM`'s base plus the `COPY` diffs. The build stage's layers are not in that manifest. A secret or a compiler that existed only in the build stage is not in the image you push. That is a stronger guarantee than `rm`, which leaves a whiteout and the old blob.

`COPY --from` can also copy from an image you did not build in this file (`--from=python:3.12-slim`). The common case is a stage name.

```mermaid
flowchart LR
  build["stage build: compilers, venv"] --> copy["COPY --from=build /venv"]
  slim["final FROM slim"] --> copy
  copy --> user["USER app"]
  user --> out["image you push"]
  build -.-> discard["build stage not in the manifest"]
```

Put `USER` after the copies that must run as root, such as `useradd` and `COPY`. Once `USER app` is set, a later `RUN` in that stage runs as `app` and may not be allowed to write `/`. The final `USER` is the user the container starts as, unless `docker run --user` overrides it.

`COPY --chown=app:app` sets ownership in the same layer as the copy. A separate `RUN chown -R` is an extra layer that duplicates the files. Prefer `--chown`.

### Slim, Alpine, distroless

`python:3.12-slim` is Debian with fewer packages. It still has glibc, which is what most wheels on PyPI expect. It still has a shell, so `docker exec` can start `sh` if the image includes it.

Alpine is smaller and uses **musl**, not glibc. A wheel tagged manylinux does not install there. Pip then builds from source, which needs a compiler you added to save space, and the build is slower and more fragile than the slim image you were trying to beat. Use Alpine when you know every dependency ships a musl wheel or is pure Python. Do not use it as a default for a scientific stack or for anything with unpublished C extensions.

**Distroless** images from Google Container Tools are bases with the runtime and almost nothing else. No package manager, and no shell in the non-debug tags. `gcr.io/distroless/python3-debian12` is the Python shape. A debug tag adds a busybox shell for emergencies. The non-debug image is what you push. `docker exec` into `sh` fails because `sh` is not there. That is the point. Debug with logs, with a copied-out core, or with the debug tag in a non-production namespace. Do not put the debug tag in prod because exec is convenient.

Distroless does not remove the packages inside your virtualenv. It removes the distribution around them. A vulnerable version of a library in `requirements.txt` is still in `/venv`. Scanning still has work to do. The supply lesson is that work. This lesson is why the base the scanner sees should be small.

Pin the base the same way you pin anything else. `python:3.12-slim` is a moving tag. A digest is stronger. Floating tags in the final stage are how prod drifts from the build you scanned.

### Not root

`USER app` is image config. The process starts as that user. It can still be root if someone runs `docker run --user root`. Kubernetes `runAsNonRoot: true` refuses a container whose image wants root, which is the cluster version of the same rule. Set the user in the image so the default is already safe, and let the cluster enforce it.

Create the user in the final stage with a fixed uid if you care about bind-mount ownership. `useradd --uid 10001 --create-home app` makes the number obvious on the host. Distroless already has a `nonroot` user. Switching to it with `USER nonroot` is the whole step. You do not `useradd` inside distroless. There is no `useradd`.

A process that must bind to port 80 needs a capability, not root. Prefer a port above 1024, which is what `EXPOSE 8000` already implies, and publish host 80 onto container 8000 from the outside. Binding low ports is the usual excuse for running as root, and it is a bad one.

### Where it breaks

**Copying the whole build stage.** `COPY --from=build / /` copies compilers, caches, and any secret file the build stage wrote. Copy the venv and the app directory. Nothing else.

**The final stage still `FROM python:3.12`.** You paid for a second stage and then started from the fat image. The final `FROM` is the base you ship. The first `FROM` is the base you build with. They are allowed to differ, and the final one should be the smaller one.

**Alpine and a failed wheel.** The error is a compiler error in the middle of `pip install`, or a runtime `libc` mismatch. Move to a glibc slim image instead of installing `build-base` into Alpine and calling it small.

**`USER` before `useradd`'s files are readable.** The app user cannot read a root-owned `0700` directory. Check the path mode, or `chown` the venv. A container that starts and immediately exits with "permission denied" is this, not a bad `CMD`.

**A shell script as PID 1 in a distroless image.** There is no `/bin/sh`. Exec-form `CMD` with the real binary is the only form that works. Shell form is a hard failure, not a signal bug.

**Debug tools installed in the final stage "just in case".** `curl` in the final image is another package. A healthcheck that needs `curl` can use a binary you copied, or the platform's probe can call the port from outside. Do not leave a package manager in the final stage so you can install curl later. Later is a new build.

### How you use it at work

The image you push is the image the cluster pulls on every scale-up. A 1 GB image times fifty new nodes is a deploy that waits on the registry. A 150 MB image is the same rollout with less to transfer and less to unpack. The layer lesson is why the base is shared across services. This lesson is why the base should be the slim one, not the SDK.

Security review asks two questions: what is in the final manifest, and which user runs. Multi-stage answers the first. `USER` answers the second. A scanner report on the build stage is noise if that stage is not pushed. Configure the scanner on the image you tag for production, which is the final stage.

The same split is how you compile a Go or Rust binary in a stage with the SDK and copy one static binary into a slim or distroless final stage. The Python venv is the interpreted version of "copy the artifact". Node's `npm ci` and `npm prune --omit=dev` in a build stage, then copying `node_modules` and `dist`, is the same pattern.

### Which base and which user

| Situation | Choose | Avoid |
|---|---|---|
| A Python service with ordinary wheels | `python:3.12-slim` final stage, venv copied from a build stage | the full `python:3.12` as the image you push |
| You need the smallest Debian-like runtime and no shell | distroless, non-debug tag | Alpine, if you picked it only for size |
| A dependency with manylinux wheels | glibc slim or distroless Debian | Alpine musl, unless a musl wheel exists |
| The process user | `USER app` or distroless `nonroot` | root because port 80 was convenient |
| Files the user must read | `COPY --chown` | a later `RUN chown -R` that doubles the layer |
| Something only the compiler needed | leave it in the build stage | `rm` it in the final stage |

### You can now

- Write a two-stage Dockerfile and say which stage's layers are absent from the pushed image.
- Choose slim or distroless over Alpine when glibc wheels matter.
- Add a non-root user in the final stage and put `USER` after the copies that create files.
- Explain why `docker exec ... sh` failing in distroless is expected.
- Copy a venv or `node_modules` forward instead of copying `/`.

::: quiz
q: Which file stops `COPY . .` from putting your local `.env` into the image?
- `.gitignore`
+ `.dockerignore`
- The `USER` instruction
- `EXPOSE`
why: Docker reads `.dockerignore`, not `.gitignore`, to decide what's in the build context.
:::

::: config lang=dockerfile
task: Turn this into a **two-stage** build. Stage one, named `build`, installs dependencies into a virtual environment at `/venv` (the starter already does). The final stage starts from `python:3.12-slim` again, copies `/venv` and the code from the build stage, runs as a non-root user called `app`, and keeps the CMD.
starter:
```dockerfile
FROM python:3.12
WORKDIR /app
RUN python -m venv /venv
COPY requirements.txt .
RUN /venv/bin/pip install --no-cache-dir -r requirements.txt
COPY . .
CMD ["/venv/bin/uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```
check: FROM count 2 | There are two stages (two FROM lines)
check: FROM[0] ~ /\s+AS\s+build$/i | The first stage is named build
check: FROM[1] ~ /^python:3\.12-slim$/ | The final stage starts from python:3.12-slim
check: seq ~ /FROM python:3\.12-slim\n[\s\S]*COPY --from=build \/venv / | The final stage copies /venv from the build stage
check: USER[-1] ~ /^app$/ | The container runs as the user app
check: seq ~ /USER app\n(?:[^\n]*\n)*CMD/ | USER comes before CMD
check: CMD[-1] ~ /uvicorn/ | The CMD still starts uvicorn
solution:
```dockerfile
FROM python:3.12 AS build
WORKDIR /app
RUN python -m venv /venv
COPY requirements.txt .
RUN /venv/bin/pip install --no-cache-dir -r requirements.txt

FROM python:3.12-slim
WORKDIR /app
RUN useradd --create-home app
COPY --from=build /venv /venv
COPY . .
USER app
CMD ["/venv/bin/uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```
hint: Add `AS build` to the first FROM. Start a second `FROM python:3.12-slim`, `RUN useradd --create-home app`, `COPY --from=build /venv /venv`, `COPY . .`, then `USER app` before the CMD.
:::

::: quiz
q: A Python service fails `pip install` on `python:3.12-alpine` while building a C extension, and the same `requirements.txt` installs on `python:3.12-slim`. What is the usual reason?
+ Alpine uses musl. Many published wheels are manylinux builds linked against glibc, so pip falls back to compiling from source and the headers are not there.
- Alpine cannot run Python. The `python` package on Alpine is a stub.
- Slim images disable TLS, so pip skips C packages and the build looks green.
- Multi-stage builds require Alpine in the final stage. Slim is illegal there.
why: glibc and musl are different C libraries. A wheel built for manylinux does not load on musl, so the Alpine build tries to compile. Slim is Debian and matches those wheels. Multi-stage does not require Alpine.
:::

::: quiz
q: The final stage is `gcr.io/distroless/python3-debian12` with no debug tag. `docker exec -it api sh` fails with a missing `sh`. What should you do in production?
+ Leave the shell out. Read `docker logs`, or use a debug-tagged image only in a non-production namespace. Do not switch the prod tag to the debug image for convenience.
- Install bash with `apt-get` in that stage so exec works.
- Treat the missing shell as a broken base and go back to running as root on a full OS.
- `EXPOSE` a shell port. Distroless hides `sh` until you publish one.
why: The missing shell is the design of non-debug distroless. There is no package manager to install bash. A debug tag exists for diagnosis and is a different image. Production should keep the image that has no shell.
:::

::: card
q: What does a multi-stage Docker build keep in the image you push?
answer: Only the final stage. Layers from earlier stages are not in the final manifest unless a COPY --from brings specific files forward. Compilers and build secrets that stayed in the build stage are not in the pushed image. A later RUN rm in the same stage does not do this, because the earlier blob remains.
:::

::: predict lang=python
q: A build has a stage named `build` with three layer names and a final stage that only copies `venv`. This function prints the layers of the image you push. What does it print?
code:
```python
build = ["compiler", "headers", "venv"]
final_base = ["slim-os"]
copied = ["venv"]
print(" ".join(final_base + copied))
print("not " + " ".join(x for x in build if x not in copied))
```
answer:
```text
slim-os venv
not compiler headers
```
why: The final image starts at the final `FROM` and adds only what `COPY --from` brought across. Compiler and header layers stay in the build stage and are not in the manifest you push. Copying the whole build root would have printed them too.
:::

::: config lang=dockerfile
task: The final stage still starts from the full `python:3.12` image and runs as root. Make the final stage `python:3.12-slim`, copy `/venv` from the stage named `build` with ownership `app:app`, create the user `app`, and switch to it before the CMD. Keep the CMD.
starter:
```dockerfile
FROM python:3.12 AS build
WORKDIR /app
RUN python -m venv /venv
COPY requirements.txt .
RUN /venv/bin/pip install --no-cache-dir -r requirements.txt

FROM python:3.12
WORKDIR /app
COPY --from=build /venv /venv
COPY . .
CMD ["/venv/bin/uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```
check: FROM count 2 | Two stages
check: FROM[1] ~ /^python:3\.12-slim$/ | The shipped base is the slim image
check: seq ~ /COPY --from=build --chown=app:app \/venv \/venv/ | The venv is copied as app
check: USER[-1] ~ /^app$/ | The process runs as app
check: seq ~ /USER app\n(?:[^\n]*\n)*CMD/ | USER is before CMD
check: CMD[-1] ~ /uvicorn/ | CMD still starts uvicorn
solution:
```dockerfile
FROM python:3.12 AS build
WORKDIR /app
RUN python -m venv /venv
COPY requirements.txt .
RUN /venv/bin/pip install --no-cache-dir -r requirements.txt

FROM python:3.12-slim
WORKDIR /app
RUN useradd --create-home app
COPY --from=build --chown=app:app /venv /venv
COPY --chown=app:app . .
USER app
CMD ["/venv/bin/uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```
hint: Change only the second `FROM`. `useradd` has to happen as root, before `USER app`. `--chown=app:app` is an option on `COPY`, placed before the paths.
:::

## Running containers well
id: runtime
stage: prod
needs: small-images
minutes: 40
goal: Tell a signal problem from an OOM kill, read logs and inspect, and make PID 1 the process that must stop.
source: Docker docs: Shell and exec form | https://docs.docker.com/reference/dockerfile/#shell-and-exec-form
source: Docker docs: docker logs | https://docs.docker.com/reference/cli/docker/container/logs/
source: Docker docs: docker inspect | https://docs.docker.com/reference/cli/docker/container/inspect/
source: Docker docs: docker stop | https://docs.docker.com/reference/cli/docker/container/stop/
source: Docker docs: docker exec | https://docs.docker.com/reference/cli/docker/container/exec/

A container that is "running" can still be the wrong process, deaf to the stop signal, and silent in the log stream you are watching. Running it well means the real server is PID 1, logs leave through stdout, and you can read an exit code without guessing. Healthchecks and restart policies have their own lesson. This one is the process, the logs, and the inspect fields you use when it dies.

### The problem

`docker stop` is not a polite request to an image. It signals PID 1, waits for the grace period (10 seconds unless you change `--time`), then sends SIGKILL. Orchestrators do the same thing on every deploy. If PID 1 is a shell or `npm`, the server never hears SIGTERM. In-flight requests are cut when the kill arrives. The logs never show your shutdown line, and the stop always takes the full grace period.

A second, lookalike failure is exit 137. That number is what you see when the kernel kills with SIGKILL. Docker's stop path does that at the end of the grace period. The OOM killer does it when `memory.max` is hit, and then `inspect` sets `OOMKilled`. Same exit code, different field, different fix. One needs an exec-form command. The other needs a higher memory limit or a fix for the leak.

### PID 1 and the two forms

```dockerfile
CMD uvicorn main:app
CMD ["uvicorn", "main:app"]
```

The first is shell form. The image config's command is `/bin/sh -c "uvicorn main:app"`. `sh` is PID 1. A shell does not forward SIGTERM to the child as its main job, and it does not exit just because the child should shut down. `docker stop` waits, then SIGKILL both.

The second is exec form. `uvicorn` is PID 1. It receives SIGTERM. Uvicorn, gunicorn, and a Node server that handles the signal close listeners and exit. If your program does not handle SIGTERM, being PID 1 is necessary and not sufficient. The process must trap the signal and exit. Python's default is to die on SIGTERM with status 143, which is at least a prompt death. A shell in front is a ten-second wait and a 137.

`npm start` and `yarn` are shells in practice even when you write them in JSON: `CMD ["npm", "start"]` makes `npm` PID 1, and npm's signal behaviour is the same class of bug. The JSON form should name `node` and the script. The same goes for `sh -c` wrapped around a server "so the variable expands". Expand the variable at build time into the exec form, or use an entrypoint binary that execs the server after printing config. `exec` in a shell script replaces the shell, so the server becomes PID 1. A script that ends with `uvicorn` without `exec` keeps the shell.

`docker exec` does not fix PID 1. Exec starts an extra process in the container's namespaces. The server keeps its pid. Exec's stdout goes to your terminal, not to `docker logs`. If the image has no shell, exec of `sh` fails. That is the distroless case, not a broken daemon.

### Logs

`docker logs api` reads what the logging driver stored from stdout and stderr. The default driver is `json-file`. It is a file on the host, not a file the app opened. `-f` follows. `--tail` limits how much you pull.

A line written only to `/var/log/api.log` is invisible to `docker logs` and to every platform that tails the same driver. Write logs to stdout. One event per line, JSON if you want to search fields later. A multi-line stack trace is one event that got split. That is a logging problem in the app, and the driver will store the lines it was given.

Log drivers rotate only if you configure rotation. An unbounded `json-file` log fills the host disk. The container did not "use a volume". The daemon wrote beside the container. Set `max-size` and `max-file` on the daemon or the container when the service is chatty. Kubernetes does this with the node's log rotation. Compose can set `logging` options. The habit that matters first is still stdout.

### Exit codes and inspect

Unix reports a death by signal `n` as status `128 + n`. Docker stores that number as `State.ExitCode`.

| What happened | ExitCode | OOMKilled | What you change |
|---|---|---|---|
| Process called `exit(0)` | 0 | false | nothing, unless it should still be running |
| SIGTERM and the process died from it | 143 | false | a handler, if you needed a cleaner shutdown |
| `docker stop` ran out of grace, or `docker kill` | 137 | false | exec form, a handler, or a longer `--time` |
| cgroup memory kill | 137 | true | `--memory`, a leak, or the Desktop VM size |

```bash
docker inspect api --format '{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}} {{.State.Error}}'
```

`Status` is `running`, `exited`, `created`, and a few others. `Error` is sometimes set when the runtime itself failed to start the process, which is a different problem from the process exiting. A bad `CMD` path looks like that: the file is not found, the container never becomes a healthy server, and the exit is 127 from the shell if a shell was looking up the command.

`docker logs` on an exited container still works. The process is gone and the driver's file remains until the container is removed. `docker rm` then deletes it. A restart policy creates a new run of the same container object. The health lesson covers when that restart happens. Inspect tells you whether you are looking at a fresh crash or at a container that has been restarting.

### A stop, walked

You deploy a new image. The orchestrator stops the old container. With exec form and a handler, the timeline is: SIGTERM, the server stops accepting, it finishes the request it had, it exits 0, well under 10 seconds. With shell form, the timeline is: SIGTERM to `sh`, ten seconds of the server still working, SIGKILL, exit 137, clients see a reset. The bug is in the image config's command, not in the registry and not in the memory limit. `OOMKilled` is false. That single field is how you refuse the "just give it more memory" fix.

A second container in front, such as a shell wrapper that does `exec node server.js`, has the same good timeline. The wrapper must actually `exec`. A log line that says "starting" from the wrapper and then silence from the server is fine. A log line from the wrapper after the server should have exited means the wrapper is still PID 1.

### Where it breaks

**Reading 137 as always OOM.** Check `OOMKilled`. Grace-period kills are 137 with the flag false. Memory kills are 137 with the flag true. The isolation lesson is the cgroup. This lesson is the branch in the debug tree.

**`docker logs` of a file path.** People `docker exec cat /var/log/api.log` and then lose the file on the next replace. Move the log to stdout. If a third-party binary can only write a file, run a tail in the same container only as a last resort, and know that tail is now a second process. The platform still wants one main process.

**Exec and the log stream.** You reproduced a bug with `docker exec` and the output is not in the log platform. It was never going to be. The client's terminal has it.

**A healthcheck that uses a shell in a distroless image.** `HEALTHCHECK CMD curl ...` is shell form unless you use the exec form of HEALTHCHECK. Distroless has neither `sh` nor, usually, `curl`. A healthcheck that cannot run marks the container unhealthy. The health lesson is the policy. The runtime fact is that the check is a process in the same filesystem as the server.

**`STOPSIGNAL` left at the default while the app wants something else.** The default stop signal is SIGTERM. A process that only shuts down on `SIGQUIT` needs `STOPSIGNAL SIGQUIT` in the image, or `docker stop` will SIGTERM, wait, and SIGKILL. The grace period does not change which signal is first.

### How you use it at work

Kubernetes sends SIGTERM to PID 1 and waits `terminationGracePeriodSeconds`, which defaults to 30, not 10. The mechanism is the one you just saw. A pod that always takes the full grace period is a shell-form command or a missing handler. A pod that restarts with exit 137 and an OOMKilled reason is the cgroup, reported by the kubelet as OOMKilled. The Docker field and the Kubernetes reason are the same branch.

CI's `docker run --rm` to execute a test is also this model. The test's exit code becomes the step's exit code only if the test is PID 1. A wrapper that ignores the test's status and exits 0 is a green build that did not run. `exec` the test, or exit with the test's code.

`docker logs` in production is a debugging tool on one host. The durable copy is the logging driver shipping to a system you can search after the container is gone. Stdout is what makes that ship possible. A file in the writable layer cannot be shipped by a driver that never saw it.

### Which clue

| You see | Likely cause | Not |
|---|---|---|
| `docker stop` always waits 10 seconds | shell form, or no SIGTERM handler | a large image |
| Exit 137, `OOMKilled` false | SIGKILL after the grace period, or `docker kill` | a full disk |
| Exit 137, `OOMKilled` true | `memory.max` | a signal-forwarding bug |
| Exit 143 | the process died from SIGTERM | a successful clean exit, which is 0 |
| `docker logs` empty, file has lines | the app did not write stdout | `-d` |
| `exec` output missing from the log platform | exec writes to the attached client | a broken logging driver |
| Exit 127 | command not found | a memory limit |

### You can now

- Explain why shell-form `CMD` makes `sh` PID 1 and why `docker stop` then waits out the grace period.
- Use exec form, and `exec` inside a wrapper, so the server receives SIGTERM.
- Read `ExitCode` together with `OOMKilled` and separate a grace-period kill from a memory kill.
- Expect `docker logs` to show stdout and stderr only, not exec output and not an internal log file.
- Treat exit 143 as death by SIGTERM and exit 0 as a process that chose to stop.

::: quiz
q: `docker stop api` always takes 10 seconds and the logs never show your shutdown message. The Dockerfile ends with `CMD python server.py`. Why?
- Python ignores signals
+ Shell form: `sh` is PID 1 and doesn't forward SIGTERM, so Docker waits 10 s and SIGKILLs everything
- `docker stop` always waits 10 seconds
- The image is too big
why: Switch to `CMD ["python", "server.py"]` so Python is PID 1 and receives SIGTERM directly.
:::

::: config lang=dockerfile
task: Fix the start command so the Node server is PID 1 and receives SIGTERM, and add a `HEALTHCHECK` that runs `curl -fsS http://localhost:3000/health || exit 1`.
starter:
```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
USER node
CMD npm start
```
check: CMD[-1] ~ /^\[/ | CMD uses the exec form
check: CMD[-1] !~ /npm/ | node runs directly, not through npm (npm doesn't forward signals reliably either)
check: CMD[-1] ~ /"node"/ | The command starts node
check: HEALTHCHECK[-1] ~ /curl -fsS http:\/\/localhost:3000\/health/ | A HEALTHCHECK calls /health on port 3000
solution:
```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
USER node
HEALTHCHECK --interval=10s --timeout=2s CMD curl -fsS http://localhost:3000/health || exit 1
CMD ["node", "server.js"]
```
hint: `CMD ["node", "server.js"]` is the exec form. `npm start` adds a process in between that may swallow SIGTERM.
:::

::: quiz
q: `docker inspect` shows `ExitCode` 137 and `OOMKilled` false. The Dockerfile ends with `CMD node server.js` in shell form. `docker stop` was used. What happened?
+ PID 1 was a shell, so the server did not get SIGTERM. Docker waited out the grace period and sent SIGKILL, which is exit 137. `OOMKilled` is false, so this was not the memory controller.
- The cgroup hit `memory.max`. `OOMKilled` is unreliable and 137 always means memory.
- Exit 137 means the process handled SIGTERM and exited cleanly.
- `node` ignores SIGKILL, so the number comes from the image digest.
why: SIGKILL is signal 9, reported as 128+9. `docker stop` sends it only after the grace period. `OOMKilled` true is the memory case, and it is false here. A clean handler exits 0, not 137.
:::

::: quiz
q: You run `docker exec api ls /tmp` while debugging, and that listing never shows up in `docker logs api` or in the log platform. Why?
+ `docker exec` attaches the new process's stdout to your client. The logging driver only stores the container's own stdout and stderr, which are the main process's streams.
- `docker logs` hides exec output until the container exits.
- Exec output is written to a layer, and logs read only the image config.
- `-it` disables the logging driver for the whole container.
why: Exec is an extra process. Its streams are the docker client's streams. The driver captured the main process when the container started. `-it` allocates a TTY for the exec session. It does not turn off logging for PID 1.
:::

::: card
q: In Docker, what do exit codes 0, 137, and 143 mean for a container, and what does `OOMKilled` add?
answer: 0 means the process exited successfully. 143 is 128+15, death by SIGTERM. 137 is 128+9, death by SIGKILL. OOMKilled true means the cgroup memory killer sent that SIGKILL. OOMKilled false with 137 means something else sent SIGKILL, often docker stop after the grace period.
:::

::: predict lang=python
q: A container's main process was killed by a signal. This function uses the 128-plus-signal convention Docker reports. What does it print for SIGKILL (9) and SIGTERM (15)?
code:
```python
def reported(signal):
    return 128 + signal
print(reported(9))
print(reported(15))
```
answer:
```text
137
143
```
why: Docker stores the process status. A signal death is reported as 128 plus the signal number, the same convention a shell uses. Signal 9 is SIGKILL and signal 15 is SIGTERM. The function does not know whether a 137 was an OOM. That is the separate `OOMKilled` field.
:::

::: quiz
q: A wrapper script is PID 1 and ends with the line `uvicorn main:app`. The server still does not receive SIGTERM. What does the last line need to be?
+ `exec uvicorn main:app`, so the server replaces the shell and becomes PID 1.
- `nohup uvicorn main:app`, so the shell ignores the stop and the server keeps running.
- `CMD uvicorn` in the script. Scripts do not use exec.
- `EXPOSE 15`, which forwards SIGTERM into the writable layer.
why: Without `exec`, the shell stays PID 1 and the server is a child. `exec` replaces the shell with uvicorn. `nohup` would make shutdown worse. `EXPOSE` is port metadata, not a signal.
:::

## Container networking modes
id: networks
stage: prod
needs: runtime
minutes: 40
goal: Choose bridge, host, none, or a shared container namespace, and say why localhost and published ports are not the same path.
source: Docker docs: Networking overview | https://docs.docker.com/engine/network/
source: Docker docs: Bridge network driver | https://docs.docker.com/engine/network/drivers/bridge/
source: Docker docs: Host network driver | https://docs.docker.com/engine/network/drivers/host/
source: Docker docs: None network driver | https://docs.docker.com/engine/network/drivers/none/
source: Docker docs: Docker Desktop networking | https://docs.docker.com/desktop/features/networking/

`localhost` is the word that makes container networking look haunted. It means "this network namespace", and a container has its own. A published port is a door from a different namespace. Two containers talk by name only on a network that has a DNS server. This lesson is those modes. Compose, later, creates a user-defined bridge for you and names each service. You still need to know what it created, because the failure looks like a bad password when it is a bad hostname.

### The problem

The API container is up. `docker ps` shows `0.0.0.0:8000->8000/tcp`. The browser gets a connection refused, or the API gets a connection refused talking to Postgres at `localhost:5432`. Both are namespace mistakes. The process listened on `127.0.0.1` inside its namespace, so the Docker proxy on the container's other interface cannot connect. Or the API looked for the database on its own loopback, where nothing is listening, while Postgres is a different namespace on the same bridge.

### Four modes

**Bridge, the default.** Docker creates a virtual Ethernet pair. One end is `eth0` in the container. The other is on a bridge on the host. The container gets an address on that bridge, often `172.17.0.0/16` for the default bridge named `docker0`, or another range for a network you created. Outbound traffic is NATed to the host. Inbound traffic from the host's interfaces reaches the container only if you publish a port.

There are two bridges people confuse. The **default bridge** is `docker0`, used when you `docker run` without `--network`. Containers on it can reach each other by IP. They do **not** resolve each other by container name. The old `--link` flag faked that and is obsolete. A **user-defined bridge** has embedded DNS. A container is reachable at its name, and at its network alias, from other containers on that network. Compose creates a user-defined bridge per project. That is why the service name `db` works in Compose and a bare `docker run --name db` on the default bridge does not resolve `db`.

**Host.** `--network host` does not create a network namespace. The process shares the host's interfaces and port table. `-p` does nothing useful and Docker will tell you so: there is no separate stack to forward into. The process binds the host port directly. Two processes cannot bind the same host port. On a Linux server this is the real host. On Docker Desktop for Mac or Windows, "host" is the **Linux VM**, not the Mac and not Windows. A bind to port 8000 in host mode listens in the VM. Desktop still has to forward from the Mac if you want the Mac's browser to connect, and the docs for Desktop networking are the source of truth for that path. Do not learn host mode on a Mac and expect a datacenter Linux host to feel different. On the datacenter host, host mode really is the machine.

**None.** `--network none` gives the container a loopback interface and nothing else. It cannot route. Use it for a batch job that must not phone home, or to prove a failure is network rather than application. `localhost` inside still works, because loopback is there. A published port has nowhere to go.

**Container.** `--network container:<name>` joins another container's network namespace. Both processes share `localhost` and share one IP. This is how a sidecar shares the app's loopback without a bridge hop. Kubernetes pods do the same thing: containers in a pod share a network namespace. You do not publish ports on the sidecar separately. There is one stack.

```mermaid
flowchart LR
  hostns["host namespace"] --> bridge["user-defined bridge DNS"]
  bridge --> api["api eth0"]
  bridge --> db["db eth0"]
  api --> loop1["api localhost"]
  db --> loop2["db localhost"]
```

### Published ports and the address you bind

`-p 8080:8000` means host port 8080 forwards to container port 8000. The optional form `-p 127.0.0.1:8080:8000` publishes only on the host's loopback, so other machines cannot connect to 8080. Without that address, Docker publishes on all of the host's interfaces, `0.0.0.0`.

Inside the container, the server must accept connections on the interface the proxy uses. That is not `127.0.0.1`. Bind `0.0.0.0` or the container's eth0 address. A server that logs "listening on 127.0.0.1:8000" will not receive published traffic. `EXPOSE` does not publish. `-P` publishes every exposed port onto a random high host port. Prefer an explicit `-p`.

From another container on the same user-defined bridge, you do not use the published host port. You use the container's name and the port it listens on: `db:5432`, not `localhost:5432`, and not the host's `8080`. Publishing is for clients outside Docker's network. Service-to-service traffic stays on the bridge and does not need a published port at all. Publishing a database to `0.0.0.0` is how a laptop firewall becomes the only thing between the internet and Postgres.

DNS on a user-defined bridge is the names of containers, not the host's `/etc/hosts` beyond what Docker injects. `host.docker.internal` is a Desktop convenience so a container can reach a service on the Mac. It is not a Linux engine default you should bake into a production image. Production containers reach other services by service name or by a real DNS name.

### A walk-through

Postgres runs as `--name db` on a user-defined network `app`, listening on 5432, with no `-p`. The API runs on `app` with `-p 8000:8000` and `DATABASE_URL=postgres://db:5432/app`.

The API resolves `db` through Docker's DNS to the bridge IP. The connection never touches the host's port 5432, which is closed, on purpose. A browser on the host opens `localhost:8000`. That packet hits the host's published port, crosses into the API's namespace, and arrives on the API's port 8000. The browser cannot open `db:5432`. The name `db` is not on the host's DNS unless you added it.

Change the URL to `localhost` and the API connects to itself. Connection refused, immediately, because nothing in the API container listens on 5432. The database is healthy. The hostname is wrong.

Put the API on `--network host` and the published-port flag stops mattering. The API must bind host port 8000 itself. It can reach Postgres on the host's `localhost` only if Postgres is also in the host namespace. If Postgres is on a bridge, host-network API reaches it at the bridge IP, not at `localhost`, because `localhost` is now the host. Mixing modes is how a working Compose file breaks after someone "simplifies" one service to host networking.

### Where it breaks

**Default bridge and a hostname.** `docker run --name db` and `docker run api` with no `--network` share `docker0` and do not resolve `db`. Create a network, `--network app`, and attach both. Or use Compose, which does this.

**Publishing the database.** `-p 5432:5432` on a laptop bound to `0.0.0.0` is a database on the LAN. Another container did not need that publish. Bind it to `127.0.0.1` if a host tool must connect, and leave it unpublished for container-to-container.

**Host mode on a Mac, then a surprise in CI.** CI runs Linux. Host mode there shares the build VM's real network. A test that depended on Desktop's special DNS or on a Mac-only forward fails, or worse, binds a port on the shared runner. Prefer a user-defined bridge in tests.

**`none` and a healthcheck that curls the internet.** The check fails forever. A healthcheck should hit loopback. Loopback exists even on `none`.

**IPv6 assumptions.** Default IPv4 bridge behaviour is what this lesson describes. IPv6 on Docker is a separate daemon and network setting. Do not write a URL that only works if IPv6 was enabled on the daemon.

### How you use it at work

Kubernetes Services are the published-port and DNS idea, raised to a cluster. A Service name resolves to an address that load-balances pods. A container still uses another Service's name, not `localhost`, unless the other container is in the same pod and shares the namespace. `hostNetwork: true` is Docker host mode and is just as sharp: the pod binds node ports and skips the usual network policy path. Most apps should stay on the pod network.

Security groups and firewalls see the host port you published, not the container's private bridge address. An unpublished container port is not a host firewall hole. Publishing is the hole. Say that in a review when someone asks to publish Redis "so we can debug". Debug with `docker exec` on the bridge, or with a publish bound to localhost, then remove it.

### Which mode

| You need | Mode | Do not |
|---|---|---|
| Two containers, DNS by name | user-defined bridge | the default `docker0` bridge, which has no name DNS |
| A browser on the host | `-p host:container` on a bridge | the other container's `localhost` |
| A process that must bind a real host port and you accept the cost | host, on Linux | host, as a way to make `localhost` mean "the other container" |
| No network at all | none | a bridge plus a hope the app will not dial out |
| A sidecar that shares loopback | `container:` / a pod | a second bridge address and `localhost` in the URL |
| Container to container | service name and container port | the host's published port |
| Docker Desktop "reach the Mac" | `host.docker.internal` for local dev | that name baked into a prod image |

### You can now

- Say why `localhost` inside a container is that container, and pick the service name instead.
- Explain why the default bridge does not resolve container names and a user-defined bridge does.
- Publish a port in the host:container direction and bind the server to `0.0.0.0`.
- Describe host mode as sharing the host namespace, and as the Linux VM when the host is Docker Desktop on a Mac.
- Leave a database unpublished when only other containers talk to it.

::: quiz
q: On a user-defined Docker bridge, the API container's `DATABASE_URL` uses `localhost:5432`. Postgres is a different container on the same bridge and is healthy. The API gets connection refused. Why?
+ `localhost` in the API's network namespace is the API container. Postgres has a different namespace and is reached by its container name, not by the API's loopback.
- User-defined bridges disable DNS, so the API must use the host's published port.
- `localhost` always means the Docker host, so Postgres should have used `-p` and the URL is right.
- Connection refused only happens when the password is wrong. The hostname resolved.
why: Each container on a bridge has its own loopback. DNS on a user-defined bridge resolves container names, not `localhost`. A wrong password fails later, during authentication. Refused means nothing accepted the TCP connection.
:::

::: quiz
q: A container is started with `--network host` and `-p 8080:8000` on a Linux server. What does `-p` do?
+ Nothing useful. Host mode shares the host network namespace, so there is no separate container port to publish. The process must bind the host port itself.
- It publishes host 8080 into a hidden namespace that host mode still creates.
- It binds 8080 on every other container's loopback.
- It converts host mode into a user-defined bridge for that one flag.
why: Host mode skips the container network namespace. Publishing is a forward between namespaces, so the flag has no job. The process binds host ports directly, and a second process cannot bind the same one.
:::

::: quiz
q: Two `docker run` containers are on the default bridge, named `api` and `db`. From `api`, `getent hosts db` finds nothing. What is missing?
+ A user-defined bridge, which has Docker's DNS. The default `docker0` bridge does not resolve container names.
- `--network host` on both, which is required for any name lookup.
- `EXPOSE 53` on `db`, because DNS has to be published.
- A hosts file baked into the image at build time. Run-time names cannot work.
why: The default bridge has no embedded DNS for container names. Create a network and attach both, or use Compose. Host mode would share the host's DNS, which still does not know the name `db`. `EXPOSE` does not publish or create DNS.
:::

::: card
q: In Docker, what do the bridge, host, none, and container network modes each share or isolate?
answer: Bridge gives the container its own network namespace and an interface on a bridge. User-defined bridges add DNS by container name. The default bridge does not. Host shares the host network namespace, so published ports do not apply. None leaves only loopback. Container mode joins another container's network namespace so both share localhost and one IP.
:::

::: predict lang=python
q: A browser on the host opens a published port. The forward is host port, then container port. The container listens on 8000 and you published 8080 onto it. What does this function print?
code:
```python
publish = (8080, 8000)
print(f"browser {publish[0]}")
print(f"process {publish[1]}")
```
answer:
```text
browser 8080
process 8000
```
why: The host port is the one a browser on the host can open. The container port is the one the process bound inside its namespace. Reversing them publishes the wrong door. Another container on the same bridge would use the process port and the container name, not the browser port.
:::

::: config lang=yaml
task: `api` and `db` must reach each other by service name on Compose's network. `db` must not be published onto the host. `api` must publish only `8000:8000`. Remove the host network mode and the published database port. Keep the images.
starter:
```yaml
services:
  api:
    image: myorg/api:1.4.2
    network_mode: host
    environment:
      DATABASE_URL: postgres://localhost:5432/app
  db:
    image: postgres:16
    ports:
      - "5432:5432"
```
check: services.api.network_mode missing | api is not in the host network namespace
check: services.db.network_mode missing | db is not in the host network namespace
check: services.db.ports missing | the database port is not published on the host
check: services.api.ports[*] ~ /^8000:8000$/ | api publishes 8000 on the host to 8000 in the container
check: services.api.environment.DATABASE_URL = postgres://db:5432/app | api uses the db service name
check: services.db.image ~ /^postgres:16/ | db stays on postgres:16
solution:
```yaml
services:
  api:
    image: myorg/api:1.4.2
    ports:
      - "8000:8000"
    environment:
      DATABASE_URL: postgres://db:5432/app
  db:
    image: postgres:16
```
hint: Delete `network_mode` and delete `db`'s `ports`. Compose puts both services on one user-defined bridge. The URL host is the service name `db`.
:::

::: quiz
q: Docker Desktop is running on a Mac. A container uses `--network host` and binds port 8000. Where is that bind actually happening?
+ In Docker Desktop's Linux virtual machine, which is the "host" for the daemon. It is not a bind in the macOS network stack by itself.
- In the macOS kernel, because host mode always means the machine you are sitting at.
- Nowhere. Host mode is ignored on Macs and becomes a bridge.
- In every container at once, because Desktop shares one loopback across images.
why: The Docker daemon on Desktop runs in a Linux VM. Host network mode shares that VM's namespace. Reaching it from macOS is a separate Desktop forward. On a Linux server the same flag would bind the server itself.
:::

## Volumes, bind mounts, and tmpfs
id: volumes
stage: prod
needs: runtime
minutes: 40
goal: Put durable data on a named volume, source code on a bind mount only in dev, and secrets that must not hit disk on a tmpfs.
source: Docker docs: Volumes | https://docs.docker.com/engine/storage/volumes/
source: Docker docs: Bind mounts | https://docs.docker.com/engine/storage/bind-mounts/
source: Docker docs: tmpfs mounts | https://docs.docker.com/engine/storage/tmpfs/

The writable layer dies with the container. Anything that must outlive `docker rm` has to be a mount. Docker gives you three kinds, and they fail differently. A named volume is Docker's directory, for data the container owns. A bind mount is a path you already had on the host, for source code in development and for almost nothing in production. A tmpfs is memory, for a secret or a scratch file that must not be on disk. Picking a bind mount for a database is how a container ends up writing root-owned files into a home directory, and how a Mac user discovers that the database is painfully slow.

### The problem

Postgres starts, you load a dump, you recreate the container from a new image, and the dump is gone. Or the opposite bug: you bind-mount the project into `/app`, the container's root writes a file, and the host cannot delete it because the uid is 0. Or you put the database password in a file on a named volume "so it persists", and now it persists on the host disk forever. The mount type is the decision. The path inside the container is the second decision. A volume on the wrong path is an empty directory next to the data.

### Three mounts

**Named volume.** `docker volume create pgdata`, then `-v pgdata:/var/lib/postgresql/data`. Docker stores the bytes under its own directory, typically `/var/lib/docker/volumes/pgdata/_data` on Linux. You do not pick that path in normal use. `docker volume rm` deletes it. `docker rm` on the container does not. Two containers can mount the same volume. They must cooperate. Two Postgres processes on one data directory will corrupt it.

**Bind mount.** `-v /host/path:/container/path` or the long `--mount type=bind,source=...,target=...`. The host path is the storage. There is no copy. What the container writes is that host directory. Deleting the container does nothing to it. Deleting the host directory deletes the data. A relative path in a short `-v` flag is a named volume, not a relative bind. The long form is harder to confuse.

**tmpfs.** `--tmpfs /run/secrets` or a Compose mount of `type: tmpfs`. The files live in memory. They disappear when the container stops. They are not a layer and not a volume. Use them for a short-lived secret file or for scratch that must not hit the host disk. Do not use them for a database. A restart is data loss by design.

```mermaid
flowchart TB
  proc["process writes /data"] --> kind{"mount at /data"}
  kind --> vol["named volume: survives docker rm"]
  kind --> bind["bind mount: is a host path"]
  kind --> tmp["tmpfs: gone when the container stops"]
  kind --> upper["no mount: writable layer, gone with docker rm"]
```

### What hides the image, and the copy-up rule

A mount at a path hides whatever the image had at that path.

For a **named volume**, Docker has an extra rule. If the volume is empty the first time you mount it over a directory that already has files in the image, Docker **copies** those image files into the volume. That is how a named volume picks up a default `postgresql.conf` layout or an application's seed directory. If the volume already has files, there is no copy. The volume wins, and the image's files at that path are hidden. You can change the image and restart, and the old volume contents are what the process sees.

A **bind mount** never copies. The moment you mount it, the host directory is the whole content. An empty host directory hides a full image directory. People bind-mount an empty folder onto `/var/lib/postgresql/data` and Postgres fails because the data directory is empty in a way the entrypoint did not initialise, or it initialises and the files are now on the host, owned by the uid Postgres uses inside.

**Anonymous volumes** are named volumes you did not name. A `VOLUME` line in the Dockerfile, or `-v /container/path` with no source, creates one. They survive `docker rm` unless you pass `-v` to `docker rm`. They are painful to recognise later. Prefer an explicit name.

### Uid, and Mac

The kernel stores a numeric uid. User namespaces off means uid 0 in the container is uid 0 on the host. A bind mount written by root is a root-owned host file. A process in the container running as uid 10001 creates a host file owned by 10001, which may be nobody in the host's `/etc/passwd`. That is still the right shape: a known uid, not root.

Named volumes have the same numeric ownership. They are just less often edited from the host. If you must `chown` them, `docker run --user` as root once is the usual awkward escape. Better: let the entrypoint fix ownership of the data directory on start, which official database images often do.

On Docker Desktop for Mac, a bind mount crosses from macOS into the Linux VM. It works, and it is slower and has sharper edges around file events and permissions than a Linux bind mount. Named volumes stay inside the VM and behave like Linux. Use a bind mount for source code you want to edit on the Mac. Use a named volume for the database. Do not bind-mount a Mac folder as the Postgres data directory and then debug the result as if it were a Linux disk.

### A database and a dev loop

Production Compose, the important half:

```yaml
services:
  db:
    image: postgres:16
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata: {}
```

`pgdata` is a named volume. Recreating the container keeps the data. `docker compose down` keeps it too. `docker compose down -v` deletes it. That flag is the one that surprises people who wanted a clean network and got an empty database.

Development, the other half: bind-mount the source over `/app` so a save on the host is the file the process reads, and keep the database on `pgdata`. Do not bind-mount `node_modules` from the Mac over a Linux `node_modules` if the binaries differ. An anonymous volume on `/app/node_modules` is the usual trick to hide the host directory at that one path while the rest of `/app` stays a bind. It is a dev trick, not a prod design.

The path has to be the path the program uses. Postgres in the official image uses `/var/lib/postgresql/data`. A volume on `/data` is an empty mount the server never opens. The server writes the writable layer and you are back to losing the dump.

### Where it breaks

**Bind mount in production for durability.** The host path is now part of the deploy. A second node does not have it. A reschedule loses it or, worse, two nodes bind different disks and you have split data. A named volume is still one node's disk. Real durability for a database you cannot lose is a managed database, or a volume system the orchestrator can reattach. A bind mount is not that system.

**Copy-up remembered backwards.** People expect the image to refresh a volume on every deploy. It does not. Seed data copied into an empty volume stays the old seed after you change the image. Migrations belong in the application, not in a hope that the volume will be recopied.

**Two writers.** A volume is not a lock. Two containers, two Postgres processes, one data directory: corruption. Scale the app containers. Do not scale the database container onto the same volume.

**tmpfs for "small data".** A restart, an OOM kill, a `docker stop`, and the tmpfs is empty. That is correct for a secret you can remount and fatal for a queue you meant to keep.

**`VOLUME` in the image plus a bind you did not mean.** The Dockerfile `VOLUME` creates an anonymous volume if you do not mount anything. Data you thought was in the writable layer is in that anonymous volume, which `docker rm` without `-v` leaves behind. Name the volume in Compose so you can see it.

### How you use it at work

Kubernetes persistent volume claims are named volumes with a provisioner behind them. A pod's `emptyDir` is closer to a writable layer shared by the pod, or to a tmpfs if you set the medium to memory. A `hostPath` is a bind mount and has the same "this node only" trap. The lesson you are learning here is the one a manifest review uses: if it must survive a new container and it is data, it is a volume. If it is source in dev, it is a bind. If it must not touch disk, it is memory.

Backups follow the mount. You snapshot a named volume or dump the database through the protocol. You do not `docker commit` a container and call that a backup. Commit copies the writable layer and misses the volume, because the volume is not the writable layer. That mistake has lost databases. The files were on the volume the whole time. The committed image was empty of them.

### Which mount

| Data | Mount | Why |
|---|---|---|
| Postgres or any database files | named volume, or a managed database | survives `docker rm`, not tied to a repo path |
| Source code while developing | bind mount | the editor and the process share files |
| Database files on a Mac | named volume, not a Mac folder | stays in the Linux VM and avoids the slow share |
| A token file for one run | tmpfs or a secret mount | not in a layer and not left on disk |
| A log you only need live | stdout, not a mount | the driver ships it |
| Seed files from the image, first run | empty named volume, copy-up | only the first time, only if the volume is empty |
| Two replicas of one writer | do not share one volume | a volume is not a distributed lock |

### You can now

- Explain why a file in the writable layer disappears on `docker rm` and a named volume does not.
- Say that `docker compose down -v` deletes named volumes and `down` alone does not.
- Predict that an empty named volume copies image files once, and a bind mount never does.
- Predict the host uid of a file written by root in a container when user namespaces are off.
- Keep a Mac's Postgres data in a named volume and reserve bind mounts for source.

::: quiz
q: A Postgres container is removed with `docker rm` and a new one is started from the same image with `-v pgdata:/var/lib/postgresql/data`. The tables are still there. Why?
+ `pgdata` is a named volume. `docker rm` deletes the writable layer and does not delete that volume, so the new container mounts the same files.
- The image was updated by the first container's writes, so the tables are in a layer.
- `--restart always` is implied by a named volume and it restored the process memory.
- `docker rm` copies the writable layer into the image config before it deletes the container.
why: A named volume is storage outside the writable layer. Removing the container leaves it. The image was not modified by database writes. Restart policies do not put rows back into an empty data directory.
:::

::: quiz
q: The image has seed files in `/app/seed`. You bind-mount an empty host directory onto `/app/seed`. What does the process see?
+ An empty directory. A bind mount hides the image files and does not copy them into the host directory first.
- The seed files, because Docker copy-up runs for bind mounts the same way it does for empty named volumes.
- The seed files merged with the host directory, file by file.
- A build error. Bind mounts are rejected when the image path is not empty.
why: Copy-up is a named-volume behaviour for an empty volume. A bind mount shows the host path immediately, empty or not. The image files are hidden, not merged and not copied.
:::

::: quiz
q: User namespaces are off. The container runs as root and writes `/data/row` on a bind mount. Who owns `row` on the host?
+ Host uid 0, root. The numeric uid is what the filesystem stores, and uid 0 inside is uid 0 on the host when user namespaces are off.
- The user who ran `docker`, because Docker rewrites owners to that uid.
- Nobody. Bind mounts store names, not numbers, and root has no host name.
- The owner of the image layer that contained `/data`.
why: Ownership on the mount is the numeric uid. Without a user namespace, root in the container is root on the host. Docker does not rewrite that to your login uid. The image layer is hidden by the mount, so it is not the owner of the new file.
:::

::: card
q: In Docker, when does a named volume get a copy of files from the image, and when does a bind mount?
answer: If you mount an empty named volume over a path that already has files in the image, Docker copies those files into the volume once. If the volume already has files, the volume hides the image and nothing is copied. A bind mount never copies. The host directory, even if empty, replaces the image path immediately.
:::

::: predict lang=python
q: This function applies Docker's copy-up rule. A named volume is empty the first time and already has files the second time. What does it print?
code:
```python
def sees(volume_empty, image_files):
    if volume_empty:
        return " ".join(image_files)
    return "volume-files"
print(sees(True, ["seed.sql"]))
print(sees(False, ["seed.sql"]))
```
answer:
```text
seed.sql
volume-files
```
why: Copy-up fills an empty named volume from the image path, once. After the volume has files, later image changes stay hidden behind the volume. A bind mount would have printed an empty view even on the first call, because bind mounts do not copy up.
:::

::: config lang=yaml
task: The database is bind-mounted to a path in the project, so a second machine will not have the data and the files are mixed with source. Use a named volume `pgdata` at `/var/lib/postgresql/data`, and declare it at the top level. Do not publish a host path. Keep `postgres:16`.
starter:
```yaml
services:
  db:
    image: postgres:16
    volumes:
      - ./pgdata:/var/lib/postgresql/data
```
check: services.db.image ~ /^postgres:16/ | Image stays postgres:16
check: services.db.volumes[*] ~ /^pgdata:\/var\/lib\/postgresql\/data$/ | Data is on the named volume at the Postgres path
check: services.db.volumes[*] !~ /\.\// | No bind mount of a project directory
check: volumes.pgdata exists | The volume is declared
solution:
```yaml
services:
  db:
    image: postgres:16
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata: {}
```
hint: A named volume is `name:/path/in/container` plus a top-level `volumes:` entry. A leading `./` is a bind mount of the project.
:::

::: quiz
q: You need a database password available as a file inside one container, and it must not remain on disk after the container stops. Which mount?
+ A tmpfs mount at that path, filled at start from a secret. It lives in memory and is gone when the container stops.
- A named volume, because anything important should survive `docker rm`.
- A bind mount of `~/.secrets`, so a restart on the same host still has it and the file is easy to edit.
- A new image layer, so the password is versioned with the app.
why: tmpfs is memory and disappears on stop, which is what you want for a secret file. A named volume would keep it on the host disk. A bind mount of a home directory keeps it too, and an image layer publishes it to anyone who can pull the image.
:::

## Healthchecks and restart policies
id: health
stage: prod
needs: runtime
minutes: 40
goal: Write a healthcheck the process can actually run, and pick a restart policy that does not confuse unhealthy with exited.
source: Docker docs: HEALTHCHECK | https://docs.docker.com/reference/dockerfile/#healthcheck
source: Docker docs: Start containers automatically | https://docs.docker.com/engine/containers/start-containers-automatically/
source: Docker docs: Compose startup order | https://docs.docker.com/compose/how-tos/startup-order/

A process can be running and useless. It can be wedged on a lock, serving errors, or waiting on a database that is not up yet. A healthcheck is a separate command whose exit code answers "can this thing serve". A restart policy answers a different question: "the process exited; should Docker start it again". People wire these together in their heads. Docker does not. An unhealthy container keeps running, and the restart policy does not fire, because the process has not exited. If you remember one sentence from this lesson, remember that one.

### The problem

You ship an API that binds its port only after it has loaded a cache. Compose starts the API, then the worker, and the worker calls the API during the second when the port is closed. Or the API deadlocks an hour later, `docker ps` still says Up, and nothing restarts it. Or the opposite bug: a migrate container runs once, exits 0, and `restart: always` starts it again and the migration runs twice.

You need a check with a real definition of healthy, a start period long enough for boot, and a restart policy that matches whether exit is a failure.

### Health states

`HEALTHCHECK` in the Dockerfile, or `healthcheck:` in Compose, runs a command inside the container on an interval. Exit 0 is success. Exit 1, or a timeout, is a failure. Docker counts consecutive failures up to `retries`.

The status you see in `docker ps` is:

- **starting**, during the start period, before enough results exist.
- **healthy**, after the successes you asked for.
- **unhealthy**, after `retries` failures.
- no health status at all, when the image has no healthcheck. `Up` then means "the process has not exited", which is a weaker statement.

`--start-period` (Compose `start_period`) is the boot window. Failures during it do not count toward `retries`, so a slow start does not mark the container unhealthy before it had a chance. After the period, failures count. A start period is not a delay before the first check. Checks run. They just do not condemn the container yet.

`--interval`, `--timeout`, and `--retries` are the rest. A check that takes longer than the timeout is a failure even if it would have exited 0 a second later. A check that hammers a real dependency every second is a production incident of your own making. Hit a local endpoint that tests what you care about. Do not make the healthcheck the biggest client of the database.

```dockerfile
HEALTHCHECK --interval=10s --timeout=2s --start-period=20s --retries=3 \
  CMD ["curl", "-fsS", "http://127.0.0.1:8000/health"]
```

The JSON form runs `curl` directly. The shell form runs `sh -c`, which distroless images do not have. `127.0.0.1` is correct **inside** the check, because the check runs in the container's network namespace and should hit the server's loopback. That is the opposite of the address the server binds for published traffic. The server binds `0.0.0.0`. The check calls `127.0.0.1`.

`curl -f` fails on HTTP error statuses. A `/health` that returns 500 should fail the check. A `/health` that returns 200 while the database is down is a lie you wrote. Decide what healthy means. For a process that cannot serve without the database, the endpoint checks the database and returns 500 when it cannot. For a liveness notion of "the process is not wedged", do not check the database, or a database blip restarts every API at once. Docker has one check, not Kubernetes's two probes. If you only get one, prefer "can serve" for something Compose waits on, and know that a restart policy will not use it.

### Restart policies

Set with `--restart` or Compose `restart:`.

| Policy | On non-zero exit | On exit 0 | When the Docker daemon restarts |
|---|---|---|---|
| `no` | leave it | leave it | leaves it stopped |
| `on-failure` | start it again | leave it | no. A daemon restart does not start it |
| `always` | start it again | start it again | starts it, even if you had stopped it |
| `unless-stopped` | start it again | start it again | starts it, unless you had stopped it yourself |

`on-failure` takes an optional maximum, `on-failure:5`. After that many failures Docker leaves it exited. It also does nothing on a daemon restart: a container that was exited stays exited when Docker itself comes back. `always` and `unless-stopped` restart a container that exited 0. That is what you want for a server that should never be finished, and what you do not want for a migration that should run once. A policy only starts applying once the container has stayed up for at least 10 seconds, so a process that crashes immediately does not spin in a tight loop.

The daemon-restart column is the famous trap. You `docker stop` a noisy container, reboot the host, and `always` brings it back. `unless-stopped` stays stopped, because you stopped it. `no` stays stopped because it does not restart anything. Pick `unless-stopped` for a service you want back after a host reboot unless a human stopped it. Pick `on-failure` for a worker whose exit 0 means "the queue is empty, I am done". Pick `no` for a one-shot.

None of these rows say "unhealthy". A healthcheck failure does not stop the process. The restart policy never sees an exit. `docker ps` shows `Up (unhealthy)`. To restart on unhealthy you need something else: a swarm service that replaces tasks, a Kubernetes probe with a restart, or a process supervisor. Standalone Docker and Compose will not do it. Compose **will** wait. `depends_on` with `condition: service_healthy` blocks a dependent service until the status is healthy. That is ordering, not restarting.

```mermaid
stateDiagram-v2
  [*] --> starting
  starting --> healthy: checks pass
  starting --> unhealthy: retries fail after start period
  healthy --> unhealthy: retries fail
  unhealthy --> healthy: checks pass again
  healthy --> exited: process exits
  unhealthy --> exited: process exits
```

The arrow from unhealthy to exited is not drawn by the healthcheck. Only the process exiting draws it. Then the restart policy decides whether to start again.

### A worked pair

Postgres has a healthcheck of `pg_isready`. The API `depends_on` that condition. The sequence is: Postgres process starts, status is `starting`, `pg_isready` fails while the server boots, the start period and retries absorb that, status becomes `healthy`, the API starts. Without the condition, Compose only waits until the Postgres process has started, and the API races the boot and crashes. With `restart: on-failure` the API then starts again and may win the race. That accident is not an ordering guarantee. The next race loses. Write the condition.

A migrate container exits 0. Its restart policy is `no` or is omitted. It does not run again. If someone copies `restart: always` from the API block, the migrate runs, exits, runs, and applies the migration twice or errors on an already-applied version. One-shot jobs are `on-failure` if a non-zero exit should retry, and they are not `always`.

### Where it breaks

**Healthcheck uses the public URL.** `curl https://api.example.com/health` from inside the container depends on DNS, TLS, and the load balancer. A blip marks every container unhealthy. Call loopback.

**No `curl` in the image.** The check fails with command not found, the container goes unhealthy, and the API is fine. Use a binary you know is there, or a tiny program in the image. Distroless plus a shell-form check is this bug.

**Start period shorter than boot.** The container is unhealthy during a normal start, Compose refuses the dependent service, and a restart loop begins if you also set `on-failure`. Lengthen the start period instead of deleting the check.

**`always` on a job.** Exit 0 restarts the job. Use `on-failure` or `no`.

**Expecting unhealthy to recycle the container.** It will not, on standalone Docker. If you need recycle, you are in an orchestrator. Do not add a restart policy and call the incident done.

**A check that always exits 0.** `CMD true` is a healthy status that means nothing. The dependent service starts on time and still hits a dead app. Test the endpoint.

### How you use it at work

Kubernetes splits the one Docker check into liveness, readiness, and startup probes. Liveness failure restarts the container. Readiness failure removes it from the Service and does not restart it. That split exists because Docker's single check plus a restart policy was the wrong tool for "do not send traffic, but do not kill it". When you get to the cluster, map your `/health` honestly: a readiness check can look at the database, a liveness check should not. The Docker healthcheck you wrote for Compose is closer to readiness, because Compose uses it to decide when dependents may start, and it does not restart on failure.

A load balancer that only knows the published port will keep sending traffic to an unhealthy container unless something reads the health status. Docker's status is not a load balancer. On a single host, you are the one who notices `unhealthy` in `docker ps`. In a cluster, the probe is wired to the endpoints list. Do not assume a green process list means a green check.

### Which knob

| Situation | Set | Not |
|---|---|---|
| Dependents must wait until Postgres accepts connections | healthcheck plus `depends_on` `service_healthy` | `depends_on` alone, which waits only for the process to start |
| A server should come back after a crash and after a reboot, unless you stopped it | `unless-stopped` | `always`, if a manual stop should survive a reboot |
| A server should come back even after you stopped it, once the daemon restarts | `always` | `unless-stopped` |
| Retry a job that exits non-zero, and leave it when it exits 0 | `on-failure` | `always` |
| Run once and never again | `no` | `on-failure`, if exit 0 is the success and you do not want retries of success |
| The process is wedged but still running | an orchestrator probe, or a human | a restart policy alone |
| Boot is slow | a longer `start_period` | fewer retries, which hides a real failure later |

### You can now

- Read `starting`, `healthy`, and `unhealthy`, and say what "Up" means when there is no healthcheck.
- Write a check that hits loopback and fails on a bad HTTP status.
- Explain why a restart policy does not restart an unhealthy container that has not exited.
- Choose `on-failure`, `always`, and `unless-stopped` from the exit and the reboot behaviour.
- Use `service_healthy` so Compose waits for ready, not merely for started.

::: quiz
q: A Docker container's healthcheck has failed enough times that `docker ps` shows `Up (unhealthy)`. Its restart policy is `on-failure`. What does Docker do?
+ Nothing automatic. The process has not exited, so the restart policy does not run. Unhealthy is not an exit.
- It SIGKILLs the process and starts the container again, because `on-failure` treats unhealthy as a failure.
- It sends SIGTERM once, waits the healthcheck interval, and then restarts.
- It marks the container exited 1 without stopping the process.
why: Restart policies watch the process exit. A healthcheck only changes the health status. Standalone Docker does not stop a container for being unhealthy. The tempting wrong answer is that `on-failure` includes health failures. It includes non-zero exits.
:::

::: quiz
q: A one-shot migration container exits 0 after applying migrations. Compose has `restart: always` on it. What happens next?
+ Docker starts it again, because `always` restarts even when the exit code is 0. The migration runs a second time.
- Docker leaves it stopped, because exit 0 is success for every restart policy.
- Docker starts it only after the daemon itself restarts.
- The healthcheck flips to unhealthy and blocks the restart.
why: `always` and `unless-stopped` restart on any exit, including 0. `on-failure` would have left this container stopped. A healthcheck is not involved unless you added one. One-shot work should not use `always`.
:::

::: quiz
q: You `docker stop` a container whose policy is `unless-stopped`, then the Docker daemon restarts. What is the container's state?
+ It stays stopped. `unless-stopped` does not start a container you stopped yourself, including across a daemon restart.
- It starts, because every policy reapplies on daemon restart.
- It starts only if the last exit code was 137.
- It is deleted, because a manual stop removes containers with that policy.
why: `always` would start it again when the daemon comes back. `unless-stopped` remembers that a person stopped it. The container object is not deleted by `docker stop`.
:::

::: card
q: In Docker, what is the difference between a container being unhealthy and a container exiting non-zero?
answer: Unhealthy means the healthcheck command failed enough times. The main process is still running, and a restart policy does not fire. A non-zero exit means the main process ended. on-failure restarts that. always and unless-stopped restart any exit, including 0. Compose can wait for healthy with depends_on, which is ordering, not a restart.
:::

::: predict lang=python
q: This function models a restart policy on one exit. `always` restarts any exit. `on-failure` restarts only a non-zero exit. What does it print for an API that crashed with 1 and a migration that finished with 0?
code:
```python
def again(policy, code):
    if policy == "always":
        return "restart"
    if policy == "on-failure" and code != 0:
        return "restart"
    return "stay"
print(again("on-failure", 1))
print(again("on-failure", 0))
print(again("always", 0))
```
answer:
```text
restart
stay
restart
```
why: `on-failure` ignores exit 0, so a finished migration stays finished and a crashed process comes back. `always` restarts even a clean exit, which is why it is wrong for that migration. Unhealthy is not an input here, because a health failure is not an exit code.
:::

::: config lang=dockerfile
task: The image has no healthcheck, so Compose cannot wait for it. Add an exec-form `HEALTHCHECK` that runs `curl -fsS http://127.0.0.1:8000/health`. Keep the server as PID 1. Do not switch the check to a public URL.
starter:
```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY . .
CMD ["python", "server.py"]
```
check: CMD[-1] ~ /^\[/ | The server stays exec form
check: CMD[-1] ~ /"python", "server\.py"/ | Python is still the command
check: HEALTHCHECK[-1] ~ /CMD \[/ | The healthcheck is exec form, not a shell string
check: HEALTHCHECK[-1] ~ /curl", "-fsS", "http:\/\/127\.0\.0\.1:8000\/health/ | The check calls loopback /health
check: HEALTHCHECK[-1] !~ /example\.com/ | The check does not depend on an external name
solution:
```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY . .
HEALTHCHECK --interval=10s --timeout=2s --start-period=20s --retries=3 CMD ["curl", "-fsS", "http://127.0.0.1:8000/health"]
CMD ["python", "server.py"]
```
hint: `HEALTHCHECK` uses a JSON command after `CMD`, the same exec form as the server. The host in the URL is `127.0.0.1` because the check runs inside the container.
:::

::: quiz
q: Compose `depends_on` lists the database with no `condition`. The API still sometimes starts before Postgres accepts connections. Why?
+ Without a condition, Compose waits only until the database process has started, not until its healthcheck passes. Boot can take longer than process start.
- `depends_on` is ignored unless the restart policy is `always`.
- Healthchecks run only on the host network, so the condition cannot see Postgres.
- A missing condition means Compose waits until the database container exits 0.
why: The default condition is that the dependency has started. `service_healthy` is what waits for the healthcheck. Restart policies do not add ordering. An exit 0 would mean Postgres stopped, which is the opposite of ready.
:::

## Docker Compose
id: compose
stage: prod
needs: health, volumes, networks
minutes: 40
goal: Describe a few containers in one Compose file so they share a network, wait for health, and keep data in a named volume.
source: Docker docs: Compose file reference | https://docs.docker.com/reference/compose-file/
source: Docker docs: Control startup and shutdown order | https://docs.docker.com/compose/how-tos/startup-order/

One `docker run` is a container. A small system is an API, a database, a cache, and the flags you forget on the second terminal. Compose is a file that holds those flags: images, environment, ports, volumes, health, and restart policy, started with one command. It is a developer and single-host tool. The ideas move to Kubernetes or ECS later. The file does not.

### The problem

The API works when you start Postgres yourself, wait, then start the API with the right URL. A teammate starts them in the other order, uses `localhost` because that worked on their machine outside Docker, and bind-mounts the database into the git checkout. Compose is how you write the working version down so the next start is not a memory test.

The command is `docker compose`, with a space. The older `docker-compose` binary is the v1 Python tool. Current Docker ships v2 as a plugin. Scripts should call `docker compose`.

### What the file is doing

A Compose file, usually `compose.yaml`, has a project name. The default project name is the directory name. Networks and volumes are prefixed with it, so `pgdata` becomes something like `shop_pgdata` and does not collide with another project's `pgdata`.

```yaml
services:
  api:
    build: .
    ports:
      - "8000:8000"
    environment:
      DATABASE_URL: postgres://app:secret@db:5432/app
    depends_on:
      db:
        condition: service_healthy
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: secret
      POSTGRES_DB: app
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app"]
      interval: 5s
      retries: 10
volumes:
  pgdata: {}
```

`services` are containers. The key, `db`, is the DNS name on the project network. Compose creates a user-defined bridge for the project. That is why the name resolves. You do not get that DNS from the default `docker0` bridge.

`build: .` builds the Dockerfile in the context. `image:` pulls instead. A service can have both: build it, and tag it with that image name. Production deploys usually want `image:` set to a registry name and no `build`, because the server has no source tree. Keep `build` for the local file.

`ports` is `-p`. `"8000:8000"` is host, then container. Publishing the database is optional and usually wrong on a shared machine. The API reaches `db:5432` without any `ports` on `db`.

`environment` is `-e`. The URL host is the service name. `localhost` in that URL is the API container.

`depends_on` with `condition: service_healthy` waits until the healthcheck passes. Without `condition`, it waits only until the process has started. `service_completed_successfully` waits until a one-shot service exits 0, which is the right condition for a migration container the API must not race.

`volumes` at the bottom declares named volumes. Under a service, the short syntax `pgdata:/var/lib/postgresql/data` mounts it. A `./data:` prefix is a bind mount of the project. You already know why the database wants the named form.

`docker compose up --build` builds and starts. `docker compose down` stops and removes the containers and the project network. It does **not** remove named volumes. `docker compose down -v` does. `docker compose logs` and `docker compose exec api sh` are the scoped versions of the runtime commands.

```mermaid
flowchart LR
  up["compose up"] --> net["project bridge"]
  up --> db["db starts"]
  db --> hc["healthcheck"]
  hc --> api["api starts"]
  api --> dns["connects to db:5432"]
  db --> vol["named volume pgdata"]
```

### Overrides, profiles, and one-shots

A second file, `compose.override.yaml`, is merged automatically when you `up`. People use it for the bind mount of source code so the main file stays free of laptop paths. `docker compose -f compose.yaml -f compose.prod.yaml` is the explicit form. The merge is field-wise. A later file replaces a given key and appends lists in the ways the Compose spec describes. Do not depend on a subtle merge for the database password. Set the value in the file you mean.

Profiles turn a service off unless you ask. A `tools` profile can hold a debug container you do not want on every `up`. That is optional. The core file should be the path you actually run.

A migration service looks like this in spirit: `restart: "no"`, a command that exits 0, and the API depending on it with `service_completed_successfully`. `restart: always` on that service is the bug from the health lesson, written in YAML.

`restart: unless-stopped` on the API and the database is reasonable for a local stack you want after a reboot. It still will not restart a container that is unhealthy but running.

### Where it breaks

**`localhost` in a service URL.** The name on the project network is the service key. Publishing a port does not make `localhost` inside another container mean the host.

**`depends_on` without a health condition.** The race remains. Add a healthcheck and `service_healthy`, or a completed migration and `service_completed_successfully`.

**`down -v` in a script that meant to reset containers.** The volume goes with them. A teammate loses the local database and thinks the image ate it.

**Forgetting the top-level `volumes:` entry.** Some Compose versions still create the volume. Being explicit is how a reader sees that `pgdata` is not a bind. The checker in this course wants the declaration.

**Host networking on one service.** `network_mode: host` removes that service from the project DNS. The other services cannot find it by name, and it cannot find them at `localhost` unless they also left the bridge. Leave the mode off unless you have the host-mode reason from the networking lesson.

**A Compose file as a production orchestrator on several machines.** Compose runs the project on one Docker daemon. It does not reschedule onto a healthy node. When you need that, the same services become Kubernetes workloads or an ECS task. Take the healthchecks, the volume claim, and the image tag with you. Leave the `build:` key behind.

### How you use it at work

Local development is the main job. A new hire runs `docker compose up --build` and gets the dependencies without installing Postgres on the laptop. CI can run the same file to integration-test against a real database, then `down -v` so the runner does not keep state. The `down -v` that is dangerous on a laptop is correct on a throwaway runner. The difference is whether the volume had anything you needed.

The production manifest should point at an immutable image tag or a digest, not at `build: .`. The registry lesson is that pin. Compose is where people first write `image: api:latest` and then watch two environments drift. Pin it here so the habit exists before the cluster.

Kubernetes Compose-like tools exist and are not the same as this file. A translation can start the conversation. It will not carry every `network_mode` and bind mount, and you do not want it to.

### Which field

| You want | Field | Not |
|---|---|---|
| DNS between the API and Postgres | service names on the default project network | `localhost`, or the host published port |
| API waits until Postgres accepts connections | `depends_on` `condition: service_healthy` | `depends_on` with no condition |
| API waits until migrations exit 0 | `condition: service_completed_successfully` | `service_healthy` on a job that exits |
| Database files survive `down` | a named volume, and `down` without `-v` | a bind mount of the repo, or `down -v` |
| A port for the browser on the host | `ports` on the API | `ports` on the database |
| A one-shot command | `restart: "no"` | `restart: always` |
| Prod bytes | `image` pinned to a tag or digest you built in CI | `build: .` on the server, or `latest` |

### You can now

- Read a Compose service name as the DNS name other services use.
- Wait on `service_healthy` or `service_completed_successfully` instead of on process start.
- Keep database data in a declared named volume and say what `down -v` deletes.
- Leave databases unpublished and publish only the port a host process must open.
- Say why this file runs one host, and which ideas you take with you to a cluster.

::: quiz
q: In the compose file above, the API uses `DATABASE_URL=postgres://app:secret@localhost:5432/app` and gets "connection refused". Why?
- Postgres isn't running
+ `localhost` inside the api container is the api container; the database is reachable as `db`
- Port 5432 must be published with `ports:`
- The password is wrong
why: Each container has its own network namespace. Services find each other by service name on the Compose network.
:::

::: config lang=yaml
task: Finish this `compose.yaml`. The `web` service must reach Redis by its service name, wait until Redis is **healthy**, and publish port 3000. Give `redis` (image `redis:7`) a healthcheck running `redis-cli ping`.
starter:
```yaml
services:
  web:
    build: .
    environment:
      REDIS_URL: redis://localhost:6379
  redis:
    image: redis:7
```
check: services.web.ports[*] ~ /^3000:3000$/ | web publishes port 3000 (as "3000:3000")
check: services.web.environment.REDIS_URL = redis://redis:6379 | web reaches Redis by its service name
check: services.web.depends_on.redis.condition = service_healthy | web waits for Redis to be healthy
check: services.redis.image ~ /^redis:7/ | redis uses redis:7
check: services.redis.healthcheck.test ~ /redis-cli.*ping/ | redis has a healthcheck that runs redis-cli ping
solution:
```yaml
services:
  web:
    build: .
    ports:
      - "3000:3000"
    environment:
      REDIS_URL: redis://redis:6379
    depends_on:
      redis:
        condition: service_healthy
  redis:
    image: redis:7
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      retries: 10
```
hint: `depends_on:` → `redis:` → `condition: service_healthy`. The healthcheck goes under `redis:` as `healthcheck:` → `test: ["CMD", "redis-cli", "ping"]`.
:::

::: quiz
q: In Docker Compose, `depends_on` names the database and sets no `condition`. The API sometimes crashes because Postgres is not accepting connections yet. What is the wait actually for?
+ Only for the database container's process to have started. Readiness is `condition: service_healthy`, which needs a healthcheck.
- For the database container to exit 0, which means it is ready.
- For the named volume to be created. Health is not something Compose can see.
- For `restart: always` to recycle the API until the connection works.
why: The default is "started", not "healthy". `service_completed_successfully` would wait for an exit, which is right for a migration and wrong for Postgres. A restart policy is not an order. The healthcheck plus `service_healthy` is the order.
:::

::: quiz
q: `docker compose down -v` is run in the project directory. The containers come back with `docker compose up`, and the Postgres tables are gone. Why?
+ `-v` removes the project's named volumes as well as the containers and network. A later `up` creates a new empty volume.
- `down` always deletes images, so Postgres was re-pulled empty.
- Compose stores tables in the project network, and `down` always deletes the network.
- `-v` only prints the version. The tables were in the writable layer.
why: Named volumes survive `docker compose down` and do not survive `down -v`. Images are not removed by `down`. The network is removed, but the rows were on the volume, not on the network.
:::

::: card
q: In Docker Compose, what does the service name mean on the network, and what does `docker compose down` delete by default?
answer: Each service is a container on a user-defined bridge, and other services resolve its service name through Compose's DNS. down removes the containers and that network. It does not remove named volumes unless you pass -v. It does not remove images.
:::

::: predict lang=python
q: Compose DNS names are the service keys. This function builds a database URL for the `api` service. The database service is named `db` and listens on 5432. What does it print?
code:
```python
service = "db"
port = 5432
print(f"postgres://app:secret@{service}:{port}/app")
```
answer:
```text
postgres://app:secret@db:5432/app
```
why: Inside the api container, the hostname is the service name on the project network, not `localhost` and not the host port you published. The port is the one Postgres listens on in its own namespace.
:::

::: config lang=yaml
task: This migration runs once and exits 0, but it is set to restart forever, and the API does not wait for it. The API must wait until `migrate` completes successfully. `migrate` must not restart after a successful exit. Keep the images. Do not publish new ports.
starter:
```yaml
services:
  api:
    image: myorg/api:1.4.2
    depends_on:
      - migrate
  migrate:
    image: myorg/api:1.4.2
    command: ["python", "migrate.py"]
    restart: always
```
check: services.api.depends_on.migrate.condition = service_completed_successfully | api waits until migrate exits 0
check: services.migrate.restart = "no" | a successful migration does not run again
check: services.migrate.command[0] = python | the command still runs python
check: services.migrate.command[1] = migrate.py | the command still runs the migration script
check: services.api.image ~ /^myorg\/api:1\.4\.2$/ | api image stays pinned
solution:
```yaml
services:
  api:
    image: myorg/api:1.4.2
    depends_on:
      migrate:
        condition: service_completed_successfully
  migrate:
    image: myorg/api:1.4.2
    command: ["python", "migrate.py"]
    restart: "no"
```
hint: The long form of `depends_on` is a map with `condition`, not a list. `restart: always` starts the job again after exit 0. `no` leaves it stopped.
:::

## Registries, tags and digests
id: registries
stage: prod
needs: small-images
minutes: 35
goal: Name an image so a registry, a tag, and a digest each do one job, and so two environments cannot drift under one word.
source: Docker docs: Build, tag, and publish an image | https://docs.docker.com/get-started/docker-concepts/building-images/build-tag-and-publish-an-image/
source: Docker docs: Multi-platform images | https://docs.docker.com/build/building/multi-platform/
source: AWS: What is Amazon ECR? | https://docs.aws.amazon.com/AmazonECR/latest/userguide/what-is-ecr.html

A tag is a sticky note on an image. Someone can move the note. A digest is the hash of the manifest, and it does not move. Registries are where those notes and hashes live. If you deploy `latest`, you do not know which bytes are running, and you cannot roll back to the previous latest because the word now points somewhere else.

### The problem

CI builds an image, a human pulls it, staging pulls it, prod pulls it. If all three pulls use a tag that was pushed again in between, they are three different images with one name. The bug "only happens in prod" is sometimes "prod pulled later". Pinning is how "the build we tested" stays a single object.

### Names

```text
ghcr.io/acme/orders-api:1.4.2
└ registry ┘ └ repository ┘ └ tag ┘
```

The registry is the server: Docker Hub, GitHub Container Registry (`ghcr.io`), Amazon ECR (`123456789012.dkr.ecr.eu-central-1.amazonaws.com`). The repository is the name inside that server. The tag is a pointer. A digest is written with `@`:

```text
ghcr.io/acme/orders-api@sha256:3f9a…
```

You can have both a tag and a digest. The digest wins for what is pulled. The tag is then a comment for humans.

Docker Hub treats a short name specially. `postgres:16` is `docker.io/library/postgres:16`. A name with one slash, `acme/api`, is under that user's namespace on Hub. Anywhere else you write the registry host.

```bash
docker build -t orders-api:1.4.2 .
docker tag orders-api:1.4.2 ghcr.io/acme/orders-api:1.4.2
docker push ghcr.io/acme/orders-api:1.4.2
```

`docker tag` does not copy bytes. It adds another name to a local image id. `docker push` uploads the missing blobs and then writes the tag on the registry to point at the manifest. Pushing the same tag again moves the pointer. The old manifest may still be in the registry, untagged, until garbage collection. You cannot ask the registry for "whatever `latest` meant yesterday" unless you recorded the digest yourself.

### Digests and multi-arch indexes

The digest people pin is the hash of the **manifest**, not a hash of one file in a layer. The manifest lists the layer digests and the image config digest. Change one layer and the manifest digest changes.

A multi-platform image adds a level. Buildx can push an **index** (a manifest list) that points at one manifest per architecture, often `linux/amd64` and `linux/arm64`. The tag points at the index. Pulling on an arm64 machine selects the arm64 manifest. Pulling on amd64 selects the other. Those two manifests have different digests. The index has its own digest.

Pinning the **index** digest pins the set: each architecture still resolves to the manifest you pushed for it. Pinning one **platform** digest pins those exact bytes and will not run on the other architecture. CI that builds on an Apple Silicon laptop and pushes a single arm64 image, then deploys to amd64 EC2, gets `exec format error`. The fix is a multi-platform build, or a build on the architecture you run. Tagging the arm64 image as `latest` does not make it amd64.

ECR can turn on **immutable tags** so a tag cannot be moved. That is a registry rule, not a property of Docker. Without it, assume every tag is movable, including `1.4.2`. People retag. A digest pin still works on a registry with mutable tags, because the digest was never a pointer you were allowed to swing.

### What to write down

- Do not deploy `latest`. It is a normal tag. It is not a version.
- Tag CI builds with the git commit SHA. That tag is unique if your pipeline refuses to rebuild the same SHA in place, and it is traceable.
- Add a release tag, `1.4.2`, when a human names a release. Expect that someone can move it unless the registry forbids that.
- For the deployment itself, record the digest the pull used. Kubernetes and ECS can run `image@sha256:…`. A rollback is pointing at the previous digest, which you stored. It is not "push a new latest and hope".

A pull by digest fails if that manifest is gone. A pull by tag fails or, worse, succeeds with different bytes. Prefer the failure you can see.

### Where it breaks

**Retagging a release.** `1.4.2` was the build you scanned. Someone pushes a "small fix" to the same tag. Prod pulls on the next deploy and runs unscanned bytes under a familiar name. Move fixes forward with a new tag, or turn on immutable tags, and pin the digest in the manifest that deploys.

**Digest of the wrong object.** You pinned the arm64 manifest and the cluster is amd64. Pin the index if the cluster is mixed, or pin the platform you actually run.

**`latest` in a base image.** `FROM python:latest` is the same bug one level down. Today's build and tomorrow's build are different parents. Pin the base tag at least, and the base digest when you need two builds to share a parent for sure.

**Assuming the local tag is the registry tag.** You built `orders-api:1.4.2` locally. The cluster pulls `ghcr.io/acme/orders-api:1.4.2`. Until you push, those are not the same object. A deploy that "uses the tag" and a laptop that "has the tag" can differ by a push you forgot.

**ECR login.** ECR is a private registry. `docker push` without a login fails. The region is part of the hostname. A repository in `eu-central-1` is not the one in `us-east-1`. The AWS user guide is the login path. The naming rule is the one above.

### How you use it at work

The pipeline on merge builds, tags the SHA, scans, pushes, and writes the digest into the deployment. Scanning is the next lesson. The registry's job is to hold the blobs and the pointer. The deployment's job is to name a digest. Environments differ by configuration, not by quietly pulling a newer tag of the same word.

A rollback is a deploy of a digest you already have. Rebuilding "the old version" from a branch is a different artifact. You may need to do it if the blobs were deleted. You should not need to do it because the tag moved.

Kubernetes's `imagePullPolicy: Always` with a moving tag pulls a new image on every new pod. `IfNotPresent` with a digest is stable, because the digest cannot change under you. The dangerous mix is `IfNotPresent` with `latest`: a node that already pulled some `latest` keeps it, and a new node pulls a different one. Same tag, mixed cluster.

### Which name

| Goal | Use | Not |
|---|---|---|
| A human release name | a tag such as `1.4.2` | `latest` |
| Trace a deploy to a commit | a tag of the git SHA | a tag someone reuses for "current" |
| The bytes a cluster must run | the manifest digest, or the index digest for multi-arch | a tag, if the registry allows retags |
| One architecture only | that platform's manifest digest | the other platform's digest |
| A base image that caches and stays put | a pinned tag, ideally a digest | `latest` |
| Stop a tag from moving | the registry's immutable-tag setting | a naming convention alone |

### You can now

- Read a reference as registry, repository, tag, and optional digest.
- Explain why two pulls of `latest` can be two images, and why a digest cannot.
- Say what a multi-arch index points at, and why an arm64-only push fails on amd64.
- Tag a build with a commit SHA and deploy the digest you recorded.
- Say why `imagePullPolicy` plus a moving tag gives different nodes different bytes.

::: quiz
q: Prod and staging both run `api:latest`, and prod behaves differently. What's the likely reason?
+ `latest` was pushed again in between, so the two environments pulled different images under the same tag
- `latest` is cached forever
- Digests differ between regions
- Tags are case-sensitive
why: Tags are movable labels. Pin a unique tag (commit SHA) or a digest so "the same version" means the same bytes.
:::

::: card
q: What's the difference between an image tag and an image digest?
answer: A tag (`:1.4.2`, `:latest`) is a movable name pointing at an image. A digest (`@sha256:…`) is the hash of the image content itself; it identifies exactly one image and can't be reassigned.
:::

::: quiz
q: Prod and staging both deploy `ghcr.io/acme/api:1.4.2`. Staging was deployed yesterday and prod today, and they behave differently. The registry allows tags to be overwritten. What is the likely cause?
+ Someone pushed a new manifest to the tag `1.4.2` between the two deploys, so the same tag resolved to two digests.
- Tags are stored per region inside one registry, so prod always sees a different blob.
- Digests change every time you pull, even when the manifest is unchanged.
- `1.4.2` is a reserved tag that always means "newest", like `latest`.
why: A tag is a mutable pointer unless the registry makes tags immutable. The digest of a manifest does not change when you pull it. `1.4.2` is not special syntax. It is only as stable as the registry's rules and your push habits.
:::

::: quiz
q: CI on an Apple Silicon laptop builds and pushes `ghcr.io/acme/api:9f3c1` as a single image. ECS on amd64 fails with `exec format error`. What was pushed?
+ A linux/arm64 image. The tag points at one platform's manifest, and that manifest's binaries do not run on amd64.
- A multi-arch index that ECS refuses to pull unless you also set a digest.
- An image with the wrong `CMD` architecture flag. Rebuild with `--host 0.0.0.0`.
- A digest that Docker rewrites to arm64 at pull time on every machine.
why: A plain `docker build` on Apple Silicon produces arm64. ECS on amd64 needs an amd64 manifest or an index that contains one. The error is the kernel refusing the binary, not the server bind address. Pull does not rewrite a single-platform image into another architecture.
:::

::: card
q: In a container registry, what is the difference between a tag and a digest?
answer: A tag is a movable name that points at a manifest or at a multi-arch index. A digest is the hash of that manifest or index. Pushing the same tag again can move the name. A digest keeps identifying the same object. Deploy the digest when two environments must run the bytes you tested.
:::

::: predict lang=python
q: A registry maps tags to digests. This function pushes `1.4.2` twice, at two different manifests. What does it print for the tag and for the old digest?
code:
```python
tags = {}
tags["1.4.2"] = "sha256:aaa"
old = tags["1.4.2"]
tags["1.4.2"] = "sha256:bbb"
print("tag " + tags["1.4.2"])
print("old " + old)
```
answer:
```text
tag sha256:bbb
old sha256:aaa
```
why: The tag now points at the second manifest. The first manifest's digest still names the first manifest if the registry kept the blob, but nothing named `1.4.2` points there anymore. A deploy that stored `old` can roll back. A deploy that only stored the tag cannot.
:::

::: quiz
q: Amazon ECR has immutable tags turned on for a repository. A pipeline tries to push a new image to `orders:1.4.2`, which already exists. What happens?
+ The push of that tag is rejected. The existing tag stays on the original manifest. A new build needs a new tag.
- ECR moves the tag and records the old digest as `latest`.
- The push succeeds and both manifests share the tag.
- Immutable tags block pulls by digest and allow tag moves.
why: An immutable tag cannot be updated to a new manifest. That is the registry feature that makes a release tag safe. Digests remain the way to name an object exactly. The feature does not forbid pulling by digest.
:::

## Image scanning, SBOMs, and secrets
id: supply
stage: prod
needs: registries
minutes: 40
goal: Keep secrets out of layers, read a scan as a point in time, and say what an SBOM lists that a scanner then judges.
source: Docker docs: Build secrets | https://docs.docker.com/build/building/secrets/
source: Docker docs: Build attestations | https://docs.docker.com/build/metadata/attestations/
source: Docker Scout | https://docs.docker.com/scout/
source: Distroless container images | https://github.com/GoogleContainerTools/distroless

A clean `ls` inside a container is not a clean image. The bytes you pushed include every layer, the image config, and whatever a later whiteout only hides. A registry will hand those bytes to anyone who can pull. Scanning and SBOMs are how you look at the bytes on purpose. They do not fix a secret you already pushed. They tell you what you shipped, and a scanner's "no CVEs" is true only for the database it had that day.

### The problem

A token was in `.env`. `COPY . .` put it in a layer. A later `RUN rm` made the running container look fine. The image was pushed. The token is in the registry. Rotating the token is the only fix, and the image must be rebuilt without the file. A second, quieter problem is a library version you did not know you shipped. You cannot patch what you cannot name. An SBOM names it. A scanner compares the name to a vulnerability list.

### Secrets live in blobs

Three ways a secret gets into an image:

- **A layer.** `COPY` of `.env`, or `RUN` that writes a token into a file. A later `rm` adds a whiteout. The earlier blob is still in the manifest. Anyone who saves the image and extracts layers can read it. `docker history` often shows the `RUN` line, including a token that was expanded into the command.
- **The image config.** `ENV TOKEN=...` is not a layer of files. It is still in the config JSON. `docker inspect` prints it. Every container starts with it in the environment, and so does every crash dump that includes the environment.
- **Build history of an `ARG`.** Passing a secret as a build arg and using it in `RUN` records it. BuildKit secret mounts exist so the value is a file for one `RUN` and is not committed. Use them. Do not invent a new place to put the token.

`.dockerignore` is what keeps `.env` out of the context so `COPY . .` cannot see it. `.gitignore` is not that control. If the secret already shipped, un-pushing is not enough if someone pulled. Rotate the credential. Delete the tag. Rebuild from a Dockerfile that never had the value.

A multi-stage build helps only when the secret never enters the **final** stage. A secret in the final stage's `ENV` is in the image you push. A secret only in a build stage that you do not push is not in that image. Do not push the build stage "for debugging" to the same public repository.

### SBOM and scan are different tools

An **SBOM** (software bill of materials) is a list: packages, versions, and often where they came from. SPDX and CycloneDX are the common formats. BuildKit can attach an SBOM as a build **attestation** when you ask it to (`docker buildx build --sbom=true`, along with provenance). The attestation travels with the image in the registry. It is a claim about what the build contained. It is not a verdict.

A **scan** compares packages to a database of vulnerabilities. Docker Scout does that. So do Trivy and Amazon ECR's scanning, which can use Amazon Inspector. The output is a list of CVEs with severities, for the packages the tool recognised. A scan can be empty today and noisy tomorrow, because the database gained a CVE, not because you rebuilt. You re-scan the same digest. You do not assume yesterday's green build is still green.

A scan is not a secret detector, though some tools also look for secrets. A clean CVE report does not mean there is no `.env` in a layer. A secret scanner does not mean there are no CVEs. Run the check that matches the question.

**Provenance** is the other attestation: how the image was built, from which source, with which builder. It is what you want when someone asks "did CI produce this digest". A signature, with a tool such as cosign or Notation, is how you check the attestation was not swapped. This course does not operate those tools. The idea is that a digest plus a signature is a stronger name than a tag. The registry lesson named the digest. Signing is what stops a different manifest from being presented as that build.

### Distroless and the size of the list

Distroless base images ship a runtime and not a shell or a package manager. The SBOM is shorter because the distribution is smaller. An attacker who gets a remote command has no `sh` to start. That is a real reduction. It does not remove the libraries inside your virtualenv or `node_modules`. Those are your layers. Scout will still report a vulnerable `requests` or `lodash` you copied forward. Slimming the base and pinning your own dependencies are both required. Doing one and claiming the image is "secure" is how the other list bites you.

A debug variant of a distroless image adds a shell. Scanning and shipping the debug variant to production undoes the "no shell" property. Scan the tag you deploy.

### A bad Dockerfile and the repair

Bad:

```dockerfile
FROM python:3.12
COPY . .
ARG TOKEN
RUN pip install --extra-index-url "https://user:${TOKEN}@private.example/simple" -r requirements.txt
```

`.env` may be in the copy. `TOKEN` is in history. The final image is the full distribution.

Better: ignore `.env`, install with a secret mount and a cache mount, copy only the venv into a slim or distroless final stage, and push that stage's digest. Then generate an SBOM for that digest and scan it. Store the scan next to the digest. When a CVE appears later, you can say which deployed digests contain the package without pulling every tag you have ever moved.

Rebuilding the same Dockerfile a week later may produce a different digest if the base tag moved. Pin the base. Otherwise "we rebuilt the fix" and "we also changed Debian" arrive together and you cannot tell which one changed the scan.

### Where it breaks

**`rm` as a remediation.** The blob is still there. Rebuild without the secret. Rotate it.

**Scanning the build stage, or scanning `latest`.** You want the digest that production pulls. A scan of a tag that moved is a scan of whatever it meant at scan time, which may not be what the cluster pulled yesterday.

**Treating the SBOM as a pass.** It is a list. A list that includes a bad version is honest and not "green". The scanner is what marks the version. If the SBOM is missing a package the scanner also misses, both are wrong. Native binaries copied without a package manager are the usual gap. Know that the list is what the tool could see.

**A private index token in `ENV` so the app can pip-install at start.** The token is in the image and in every crash report. Install at build time with a secret mount. At run time the app should not need the index.

**Ignoring a critical CVE in the base because "we do not call that binary".** Sometimes that is a reasoned exception, written down, with a date. Often it is how an unused setuid helper stays in the image. Distroless or a slim base removes the question. An exception without an owner becomes permanent.

### How you use it at work

The pipeline order is: build the final stage, tag the git SHA, attach SBOM and provenance, scan the digest, push, and fail the pipeline on the severities you agreed. The deployment records the digest. A new CVE does not rewrite the digest. It opens a ticket to rebuild and redeploy. The cluster does not pull a quieter tag by itself.

ECR scanning on push is the same hook inside AWS. It does not replace a secret-mount Dockerfile. Inspector cannot un-bake a token. Kubernetes admission can reject an image that is not signed or that has no scan. That policy is only as good as the digest it checks. A policy on `latest` checks a moving target.

The Terraform or Kubernetes change that points at the new digest is the rollout. The scanner did not deploy anything. Keeping those steps separate is how you avoid a scanner outage that also blocks an emergency rollback to a known digest. Rollback uses a digest you already scanned, even if a newer CVE exists. You do that with your eyes open, and you do not do it by retagging `latest`.

### Which control

| Question | Tool | Not |
|---|---|---|
| Is a token in a layer or in `ENV`? | do not put it there; secret mount; `.dockerignore` | `rm`, or a scan that only knows CVEs |
| What packages are in this digest? | SBOM attestation | the tag name |
| Which of those packages have CVEs today? | Scout, Trivy, or ECR scanning | the SBOM alone |
| Did CI build this manifest? | provenance, and a signature if you sign | a tag that anyone can push |
| Is the base smaller and shell-less? | distroless or slim final stage | a scanner, which does not delete packages |
| A CVE was published after the deploy | re-scan the same digest, then rebuild | a belief that a green scan stays green |

### You can now

- Explain why a secret copied into a layer survives `rm`, and why `ENV` publishes it without a layer.
- Use a BuildKit secret mount and `.dockerignore` so the token is not in the context or the image.
- Say that an SBOM lists components and a scanner judges them against a CVE database that changes.
- Attach the scan to a digest, not to `latest`, and re-scan when the database changes.
- Say what distroless removes and what it leaves in your application dependencies.

::: quiz
q: A Dockerfile copies `.env` into a layer and a later `RUN rm /app/.env` hides it. The image was pushed. What is true of the token?
+ It is still in the earlier layer blob in the registry. The `rm` is a whiteout. Anyone who can pull and extract layers can read it. Rotate the token and rebuild without the copy.
- It is gone, because the registry stores only the merged filesystem, not the layers.
- It is gone from the registry and remains only in your local build cache.
- It was never pushed, because `docker push` strips files that were deleted in a later instruction.
why: Layer blobs are immutable and the manifest lists them. A whiteout hides the file in the merged view and does not rewrite the earlier blob. Push uploads those blobs. The fix is a new image that never contained the file, plus a rotated token.
:::

::: quiz
q: A build has an SBOM attestation and a Scout report for the same digest. What does each one answer?
+ The SBOM lists packages and versions. Scout says which of those, as of its vulnerability database today, have known CVEs. The SBOM is not a pass or a fail.
- Both are signatures that the image was built by your CI.
- The SBOM is the list of CVEs and Scout is the list of files in the context.
- Scout deletes vulnerable packages from the digest and the SBOM records the deletion.
why: An SBOM is an inventory. A scanner compares an inventory to a CVE database. Neither one rewrites the image. A signature is a third check. A clean scan can become a dirty scan when the database updates, without the digest changing.
:::

::: quiz
q: The final stage is a non-debug distroless image, and Scout still reports a critical CVE in a Python package from your virtualenv. What did distroless change?
+ The base. It removed the distribution's shell and package manager. It did not remove the packages you copied into `/venv`. Those are still your layers, and the scanner is right to report them.
- Nothing. Distroless is a scanner and should have blocked the push.
- The virtualenv, because distroless rebuilds Python wheels without native code.
- The registry tag, which is why the CVE appears only on `latest`.
why: Distroless is a base image, not a scanner and not a rewriter of your `COPY`. Application dependencies stay in the layers you copy forward. Fix the pin in `requirements.txt` and rebuild. The tag is unrelated.
:::

::: card
q: In a container image, where can a secret hide even when a running container does not show the file?
answer: In an earlier layer blob, hidden by a whiteout from a later rm. In the image config, if it was ENV. In build history, if it was an ARG used in a RUN. A BuildKit secret mount avoids all three because it exists only during that RUN and is not committed. .dockerignore keeps the file out of the context in the first place.
:::

::: predict lang=python
q: This function models a two-layer image. Layer 0 contains a secret file. Layer 1 is a whiteout of that path. The merged view hides it. What does it print for the manifest and for `ls`?
code:
```python
layers = ["secret.env", "whiteout secret.env"]
merged_shows_secret = False
print("manifest " + " ".join(layers))
print("ls " + ("shows-secret" if merged_shows_secret else "hides-secret"))
```
answer:
```text
manifest secret.env whiteout secret.env
ls hides-secret
```
why: The manifest still lists the layer that added the file. The merged view a process sees applies the whiteout and hides it. A scanner or a person who only starts the container and runs `ls` can miss the secret. A person who reads the blobs will not.
:::

::: config lang=dockerfile
task: The index token is baked into the image with `ENV`, so `inspect` shows it. Install from `requirements.txt` using a secret mount with id `pip_url` at `/run/secrets/pip_url`. Do not set `ENV` or `ARG`. Keep the slim base and the exec-form command.
starter:
```dockerfile
FROM python:3.12-slim
WORKDIR /app
ENV PIP_EXTRA_INDEX_URL=https://user:token@private.example/simple
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY . .
CMD ["python", "main.py"]
```
check: ENV missing | The token is not image config
check: ARG missing | The token is not a build arg
check: seq ~ /--mount=type=secret,id=pip_url/ | The install reads a secret mount
check: seq ~ /\/run\/secrets\/pip_url/ | The mount file is the index URL
check: seq !~ /token@private/ | The token URL is not written in the Dockerfile
check: CMD[-1] ~ /^\["python", "main\.py"\]$/ | The command stays exec form
solution:
```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN --mount=type=secret,id=pip_url pip install --extra-index-url "$(cat /run/secrets/pip_url)" -r requirements.txt
COPY . .
CMD ["python", "main.py"]
```
hint: Delete the `ENV` line. Put `--mount=type=secret,id=pip_url` on the `RUN`, and read `/run/secrets/pip_url` in the command so the URL never appears in the file.
:::

::: quiz
q: Scout reported no CVEs for `api:latest` on Monday. On Tuesday a CVE is published for a package in that image, and nobody has pushed. What is true on Tuesday?
+ The digest that `latest` happened to point at on Monday now has a known CVE. You discover it by scanning again. The tag may also have moved, so scan the digest you deployed, not the word `latest`.
- The Monday report is a signature that the digest stays clean for 30 days.
- Docker rewrites the image in the registry when a CVE is published, so the running container is already patched.
- An SBOM attestation blocks the CVE from applying to images that have one.
why: A scan is a comparison against a database at one time. New CVEs apply to old digests. The image bytes do not change unless you rebuild and redeploy. `latest` is a bad name to scan because it can move and hide which digest the report was about.
:::

## Project: containerize an API
id: p-containerize
stage: prod
needs: compose, small-images, registries, supply
minutes: 75
project: yes
goal: Containerize a FastAPI service and its Postgres database to the bar this module set.
source: Docker docs: Multi-stage builds | https://docs.docker.com/build/building/multi-stage/
source: Docker docs: Compose file reference | https://docs.docker.com/reference/compose-file/
source: Docker docs: Build secrets | https://docs.docker.com/build/building/secrets/

You are handing a service to someone who will run it on a clean machine. The only app inputs are `main.py` and `requirements.txt`, a FastAPI app that listens with uvicorn. It needs Postgres. The laptop already has a database and a virtualenv, which is why it works there and nowhere else. Your job is two files, a Dockerfile and a `compose.yaml`, that build a small image and start the database with data that survives a new container.

The sandbox does not run Docker. It grades the files by reading them. A starter that already matches is a fail, so the files you begin with are the broken ones. Each step checks one file. Nothing you type in a later step edits the earlier file on disk. The Dockerfile step and the Compose step are separate, and both have to be right on their own.

### What you are shipping

The service is the orders API. In production it will be pulled by digest from a registry. Locally, Compose builds it. The database is `postgres:16`, not a floating `latest`, and not an anonymous volume. The API talks to the host name `db` on the Compose network. A browser on your machine uses host port 8000.

```text
browser localhost:8000
        |
        v
     api container :8000
        |
        |  postgres://app:app@db:5432/app
        v
     db container, volume pgdata
```

### Requirements

1. **Two stages, both `python:3.12-slim`.** The first stage is named `build`. It creates a virtualenv at `/venv` and installs `requirements.txt` into it. The final stage starts from `python:3.12-slim` again, not from the full `python:3.12` image and not from the build stage's leftover layers.
2. **Dependencies before source.** `requirements.txt` is copied and installed before the rest of the code. A one-line change to `main.py` must not be the reason pip runs again.
3. **The venv is the artifact.** The final stage copies `/venv` from the build stage with `COPY --from=build /venv /venv`. It does not copy the compiler tree, and it does not `pip install` a second time in the final stage.
4. **Not root.** The final stage creates a user named `app` and sets `USER app` before the process starts.
5. **A reachable server, exec form.** `EXPOSE 8000` documents the port. The command is exactly the JSON list `["/venv/bin/uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]`. Shell form is wrong. Binding `127.0.0.1` is wrong. `EXPOSE` alone does not publish the port.
6. **Compose service `api`.** It builds from `.`, publishes `8000:8000`, sets `DATABASE_URL` to `postgres://app:app@db:5432/app`, and waits until `db` is healthy.
7. **Compose service `db`.** Image `postgres:16`. `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB` are all `app`. The data directory `/var/lib/postgresql/data` is the named volume `pgdata`, declared at the top level. The healthcheck runs `pg_isready`. No host path, and no `latest`.

### How this is graded

Each config step has checks with messages. The Dockerfile checks count two `FROM` lines, the stage name, the slim final base, the order of the requirements copy and the install, the `--from=build` copy of `/venv`, the user `app`, `EXPOSE 8000`, and that exact `CMD`. The Compose checks read the service map: build context, published port, the URL, `service_healthy`, the pinned image, the three Postgres variables, the volume mount, `pg_isready`, and a top-level `pgdata`.

A solution that prints the right idea in a comment and leaves the broken instruction in place does not pass. A solution that uses `localhost` in `DATABASE_URL` does not pass, even if the rest is perfect. A solution that bind-mounts `./pgdata` does not pass. You are not graded on whether `docker build` succeeds here, because this environment has no Docker daemon. You are graded on the files matching those contracts.

Later steps in the project are questions about this brief: what the volume is for, why the deploy must not say `latest`, and a production Compose fragment that pins a digest. They do not replace the two files.

### Lessons this uses

- **what** and **images**: the image is what you ship, the writable layer is not where Postgres keeps rows.
- **dockerfile**: instruction order, exec-form `CMD`, `0.0.0.0`, `EXPOSE` is not `-p`.
- **buildkit**: if you `COPY . .`, a `.dockerignore` is what keeps `.env` out. The graded Dockerfile does not contain a token. Do not add one to make pip happy.
- **small-images**: multi-stage, slim final base, user `app`, copy the venv only.
- **runtime**: uvicorn is PID 1, so `docker stop` can signal it. The JSON command is that choice.
- **networks**: `db` is the DNS name on the Compose bridge. `localhost` is the API container.
- **volumes**: `pgdata` survives `docker compose down`. `down -v` is how you would delete it on purpose.
- **health**: `pg_isready` plus `service_healthy`, because process start is not "accepting connections".
- **compose**: one file, service names, declared volume.
- **registries** and **supply**: the image you would push is the final stage, tagged by commit and deployed by digest. `latest` is not a requirement and must not be the tag you run. Secrets stay out of `ENV` and out of layers.

### Where the first draft fails

The starter Dockerfile is one fat stage, `COPY . .` before the install, shell-form `CMD`, no user, no `EXPOSE`. It runs as root, reinstalls on every edit, and may not receive SIGTERM. The starter Compose file names an unpinned `postgres` and never sets the URL, the volume, or the healthcheck, so the API would race an empty database and keep rows in the writable layer.

A digest pin does not belong in the local build file. It belongs on the deploy file, which is a later step. Do not "fix" the local `db` image by switching it to `postgres:latest`. That is the bug the registry lesson exists to stop.

### Which file owns it

| Requirement | File | Wrong place |
|---|---|---|
| Install into `/venv` and throw away the build tools | Dockerfile, two stages | a `RUN rm` in one stage |
| Listen on 8000 inside the container | exec-form `CMD` with `--host 0.0.0.0` | `EXPOSE` alone |
| Publish 8000 for the host | Compose `ports` | the Dockerfile |
| Find Postgres | `DATABASE_URL` host `db` | `localhost` |
| Keep the tables | named volume `pgdata` | the writable layer, or a bind mount of the repo |
| Start the API after Postgres accepts connections | `depends_on` `service_healthy` and `pg_isready` | `depends_on` with no condition |
| Run as `app` | `USER app` in the final stage | `user:` only in Compose, which the cluster file might forget |
| Bytes that cannot move under a name | a digest on the deploy image | tag `latest` |

### You can now

- Turn a FastAPI app plus a dependency file into a two-stage image that runs uvicorn as `app`.
- Write a Compose file that builds that image, waits for a healthy `postgres:16`, and stores data on a named volume.
- Say which failures are "the checker never ran Docker" and which would still be wrong if it had.
- Refuse `latest` and a baked-in token when the same service is the one you would push.


Budget about an hour. The two file steps are the work. The questions after them check that you can say why the volume, the digest, and the health condition are in the brief, without the files open. If a check fails, read the message as the contract line you missed, not as a hint to weaken the file until something green appears.

::: config lang=dockerfile
task: **Dockerfile.** Two stages (`build` from `python:3.12-slim` installing requirements into `/venv`; the final stage from `python:3.12-slim`), dependencies installed before the code is copied, a non-root user `app`, port 8000 documented, and an exec-form CMD running `/venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000`.
starter:
```dockerfile
FROM python:3.12
COPY . .
RUN pip install -r requirements.txt
CMD uvicorn main:app
```
check: FROM count 2 | Two stages
check: FROM[0] ~ /^python:3\.12-slim\s+AS\s+build$/i | Stage one is python:3.12-slim AS build
check: FROM[1] ~ /^python:3\.12-slim$/ | The final stage is python:3.12-slim
check: seq ~ /COPY requirements\.txt[^\n]*\nRUN [^\n]*pip install[^\n]*requirements\.txt/ | requirements.txt is copied, then installed
check: seq ~ /COPY --from=build \/venv \/venv/ | The final stage copies /venv from build
check: USER[-1] ~ /^app$/ | Runs as app
check: EXPOSE[-1] ~ /^8000$/ | Documents port 8000
check: CMD[-1] ~ /^\["\/venv\/bin\/uvicorn", "main:app", "--host", "0\.0\.0\.0", "--port", "8000"\]$/ | Exec-form CMD runs uvicorn on 0.0.0.0:8000
solution:
```dockerfile
FROM python:3.12-slim AS build
RUN python -m venv /venv
COPY requirements.txt .
RUN /venv/bin/pip install --no-cache-dir -r requirements.txt

FROM python:3.12-slim
WORKDIR /app
RUN useradd --create-home app
COPY --from=build /venv /venv
COPY . .
USER app
EXPOSE 8000
CMD ["/venv/bin/uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```
hint: Combine the multi-stage lesson with the runtime lesson: `AS build`, `COPY --from=build /venv /venv`, `useradd` plus `USER app`, `EXPOSE 8000`, and CMD as a JSON list.
:::

::: config lang=yaml
task: **compose.yaml.** Service `api` builds from `.`, publishes `8000:8000`, gets `DATABASE_URL` pointing at `postgres://app:app@db:5432/app`, and waits for `db` to be healthy. Service `db` uses `postgres:16`, sets `POSTGRES_USER`, `POSTGRES_PASSWORD` and `POSTGRES_DB` to `app`, stores data in a named volume `pgdata` mounted at `/var/lib/postgresql/data`, and has a `pg_isready` healthcheck. Declare the volume at the top level.
starter:
```yaml
services:
  api:
    build: .
  db:
    image: postgres
```
check: services.api.build = . | api builds from .
check: services.api.ports[*] ~ /^8000:8000$/ | api publishes 8000:8000
check: services.api.environment.DATABASE_URL = postgres://app:app@db:5432/app | api's DATABASE_URL points at db
check: services.api.depends_on.db.condition = service_healthy | api waits for a healthy db
check: services.db.image ~ /^postgres:16/ | db is postgres:16 (pinned)
check: services.db.environment.POSTGRES_USER = app | POSTGRES_USER is app
check: services.db.environment.POSTGRES_PASSWORD = app | POSTGRES_PASSWORD is app
check: services.db.environment.POSTGRES_DB = app | POSTGRES_DB is app
check: services.db.volumes[*] ~ /^pgdata:\/var\/lib\/postgresql\/data$/ | Data lives in the pgdata volume
check: services.db.healthcheck.test ~ /pg_isready/ | db has a pg_isready healthcheck
check: volumes.pgdata exists | pgdata is declared under the top-level volumes
solution:
```yaml
services:
  api:
    build: .
    ports:
      - "8000:8000"
    environment:
      DATABASE_URL: postgres://app:app@db:5432/app
    depends_on:
      db:
        condition: service_healthy
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
      POSTGRES_DB: app
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app"]
      interval: 5s
      retries: 10
volumes:
  pgdata: {}
```
hint: Follow the Compose lesson's example. A top-level `volumes:` with `pgdata: {}` declares the named volume.
:::

::: quiz
q: In the orders API project, Postgres data must still be there after the db container is removed and created again. Where do the rows have to live?
+ In the named volume `pgdata` mounted at `/var/lib/postgresql/data`. The container's writable layer is deleted with the container.
- In the final image layer, because `postgres:16` records every insert as a new layer.
- In `DATABASE_URL`, which Compose replays into a new container.
- On the host port 5432. Publishing the port copies the data directory onto the host.
why: A named volume outlives the container. Inserts do not become image layers. The URL is the address of the server, not a backup. Publishing a port forwards packets and does not copy `/var/lib/postgresql/data`.
:::

::: quiz
q: The orders image was scanned and tested as `ghcr.io/acme/orders@sha256:abc`. A deploy file instead runs `ghcr.io/acme/orders:latest`. What can happen on the next pull?
+ `latest` can point at a manifest you did not scan. The digest `sha256:abc` cannot. Production has to run the digest you recorded.
- `latest` is an alias of the digest you scanned, so the pull is the same bytes.
- Docker refuses to pull `latest` if any digest exists in the same repository.
- The healthcheck fails closed when the tag is `latest`, so the new bytes never start.
why: A tag is a pointer the registry can move. A digest names one manifest. Nothing in Docker ties `latest` to the digest you tested, and a healthcheck does not compare image ids.
:::

::: card
q: In the orders API container project, what does the local Compose file prove, and what does it not prove?
answer: It proves the API builds from the current directory, publishes host port 8000, talks to the service name db, and waits until postgres:16 is healthy, with data on the named volume pgdata. It does not run the containers in this course's sandbox. It also does not pin the production digest. That pin belongs on the deploy file, because a tag such as latest can move after you scan.
:::

::: predict lang=python
q: A deploy record stores the digest that was scanned. A later push moves the tag `latest`. This function prints the name production should run and the name it must not treat as proof. What does it print?
code:
```python
scanned = "sha256:abc"
tags = {"latest": "sha256:abc"}
tags["latest"] = "sha256:fff"
print("run " + scanned)
print("tag " + tags["latest"])
```
answer:
```text
run sha256:abc
tag sha256:fff
```
why: Production runs the digest that was scanned. After the push, `latest` names a different manifest. Following the tag would skip the scan. The old digest still identifies the old manifest if the registry kept it.
:::

::: config lang=yaml
task: This production Compose file builds from a laptop directory and tracks `latest`, so a new push changes what the server runs. It must not build. The api image must be the digest that was scanned, `ghcr.io/acme/orders@sha256:abc`. Leave the database on `postgres:16` with its volume. Do not add a host port for Postgres.
starter:
```yaml
services:
  api:
    build: .
    image: ghcr.io/acme/orders:latest
    ports:
      - "8000:8000"
  db:
    image: postgres:16
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata: {}
```
check: services.api.build missing | production does not build from a source tree
check: services.api.image = ghcr.io/acme/orders@sha256:abc | api is pinned to the scanned digest
check: services.api.image !~ /latest/ | latest is not the api image
check: services.api.ports[*] ~ /^8000:8000$/ | the API port stays published
check: services.db.image ~ /^postgres:16/ | the database tag stays pinned
check: services.db.ports missing | Postgres is not published on the host
check: services.db.volumes[*] ~ /^pgdata:\/var\/lib\/postgresql\/data$/ | data stays on the named volume
check: volumes.pgdata exists | the volume is still declared
solution:
```yaml
services:
  api:
    image: ghcr.io/acme/orders@sha256:abc
    ports:
      - "8000:8000"
  db:
    image: postgres:16
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata: {}
```
hint: Delete `build`. Set `image` to the registry name with `@sha256:abc`, not a tag. Leave `db` as it is.
:::
