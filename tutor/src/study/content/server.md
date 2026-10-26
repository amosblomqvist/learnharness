# Linux servers
id: server
blurb: Run real Ubuntu servers from Tutor's Linux lab: packages, systemd services and timers, the journal, users and SSH, firewalls, nginx with TLS, log rotation, performance, storage, and break-and-fix incidents.
why: The Linux module taught the commands on your Mac. This one puts you on a real Ubuntu machine as root, where you install, configure, break and repair the things servers actually run. Every exercise boots a fresh machine, and checks the real result (is the service running, does the firewall drop the port, does the site answer over TLS), not just your output.
stage: run | Running a server | Install software, run your own services and timers, read the journal, manage users and lock down SSH.
stage: serve | Serving and protecting | Firewall, reverse proxy with TLS, log rotation, limits, storage and boot.
stage: fix | Break and fix | Real incidents on real machines: diagnose from symptoms, repair, and make sure it can't happen again.

## Your own Ubuntu machine
id: lab-intro
stage: run
needs: linux/services
minutes: 25
goal: Find your way around a real Ubuntu server: what's running, what's installed, which tools differ from your Mac.
source: Ubuntu Server documentation | https://documentation.ubuntu.com/server/
source: os-release(5) | https://www.freedesktop.org/software/systemd/man/latest/os-release.html

Every exercise in this module runs on a **fresh Ubuntu 24.04 machine** that Tutor boots just for that run, inside its Linux lab. You are `root`, systemd is PID 1, `apt` reaches the real Ubuntu archive, and nothing you do survives the run. Break it as much as you like: the next run starts from the clean template again.

That last point changes how you work compared with a server you keep. Each run is the whole story: **put every command the task needs into one go**, in order, the way you'd write a provisioning script. If you want to look around first, run exploring commands (`systemctl status`, `ls`, `cat`), read the output, then write the full solution. That habit is exactly what infrastructure-as-code teaches later: a server should be reproducible from a script, not from your memory of what you typed.

### First questions on any server

When you land on an unknown machine, these answer "what is this?":

| Question | Command |
|---|---|
| Which distribution and version? | `cat /etc/os-release` (or `lsb_release -a` if installed) |
| Which kernel? | `uname -r` |
| How many CPUs, how much memory? | `nproc`, `free -m` |
| How full are the disks? | `df -h` |
| What's running? | `systemctl list-units --type=service --state=running` |
| What failed? | `systemctl --failed` |
| What's listening on the network? | `ss -tlnp` |
| How long since boot, and how busy? | `uptime` |

`/etc/os-release` is the standard place every modern distribution describes itself, as `KEY=value` lines meant to be read by programs as well as people. A script can source it, `. /etc/os-release`, and then use `$ID` (ubuntu), `$VERSION_ID` (24.04) and `$VERSION_CODENAME` (noble). Ubuntu codenames matter in practice: package repositories are organised by them, so you'll see `noble` in apt source lines.

### GNU tools, finally

Your Mac's tools are the BSD versions. Here they're GNU, and the differences you met in the Linux module go away: `sed -i` takes no argument, `grep -P` exists, `find -printf` works, `stat -c` replaces `stat -f`, `date -d 'yesterday'` parses dates, and long options like `--max-depth` work everywhere. Scripts you write here will run on any Linux server.

### A container, not a full VM, and why it doesn't matter here

Strictly, each exercise machine is a **system container**: it shares the lab VM's kernel but has its own init (systemd), users, processes, filesystem and network. For everything in this module (services, packages, users, firewall rules, nginx, logs) it behaves like a small server. A few things are the host's business and can't be changed from inside: loading kernel modules, most kernel tunables, the clock. When a task would need one of those, the write-up says so. Cloud providers do the same thing at a larger scale, which is why some settings on a managed server are simply not yours to change.

### What you are actually logged into

A fresh machine is a pile of claims until you read them. The distribution, the kernel, the CPU count and the memory size answer different questions, and mixing them up sends you to the wrong package repository or the wrong capacity plan. `/etc/os-release` is a contract between the distribution and every script that needs to know where it is running. The file is plain text, `KEY=value`, with values quoted when they contain spaces, so a shell can source it and a program can parse it without a library. `ID` is the distribution family (`ubuntu`), stable across releases. `VERSION_ID` is the release number (`24.04`), which is what you compare when a package or a config syntax changed. `VERSION_CODENAME` is the archive name (`noble`). Apt source lines and many third-party repositories are filed under the codename, so a script that installs a vendor repo has to read it from here rather than hard-coding a name that will be wrong on the next LTS.

`uname -r` does not participate in that contract. It prints the kernel release the machine booted, which Ubuntu may update independently of the userspace release. Two 24.04 machines can show different kernel strings after one of them installed a newer hardware-enablement kernel, and a script that branched on that string would treat them as different operating systems. `uname -m` is a third fact, the CPU architecture (`x86_64` or `aarch64`), which chooses which `.deb` you download. None of these three replace the others.

```text
/etc/os-release          who built userspace     ID, VERSION_ID, VERSION_CODENAME
uname -r                 which kernel is running a version string, not a distro
uname -m                 which CPU architecture  picks the .deb
nproc / free -m          capacity right now      CPUs, and MiB of RAM
df -h / findmnt          where the bytes live    mount points, not "the disk"
ss -tlnp                 who is listening        process, address, port
systemctl --failed      what did not come up    unit names, then the journal
```

Sourcing the file is worth doing the careful way. `. /etc/os-release` runs in the current shell, so the variables stick around for the next command. `echo "$VERSION_ID"` must be quoted. An unquoted expansion is usually harmless here because the values have no spaces, and then it bites the day a `PRETTY_NAME` with spaces is echoed without quotes and word-splits. A script that needs the values in a child process should export them or pass them on the command line; a child does not inherit shell variables that were not exported.

### A worked look at a different machine

Suppose you land on a build box and you need a one-line label for a log, not a kernel string. This is a different report from a capacity dump:

```bash
. /etc/os-release
printf '%s %s (%s) on %s\n' "$ID" "$VERSION_ID" "$VERSION_CODENAME" "$(uname -m)"
```

Each piece has a job. `$ID` and `$VERSION_ID` tell a human which userspace this is. The codename in parentheses matches the archive the box should be pulling from. `uname -m` is there because a 24.04 arm64 box and a 24.04 amd64 box share those three OS fields and still cannot swap binary packages. The kernel is deliberately absent. If the log line later needs it, print `uname -r` as its own field so nobody parses a kernel string out of the middle of a sentence.

`free -m` is the memory view that matches how people size machines. The number under `total` on the `Mem:` row is installed RAM in mebibytes. The `available` column is the one that answers "can I start another service?"; `free` is small on a healthy box because Linux uses spare RAM as cache. `nproc` is online logical CPUs, which is the right denominator for a load average and the wrong number for "how many cores did we pay for" if some were offlined.

### Where it breaks

`lsb_release -a` looks like the friendly version of os-release, and on a minimal image the `lsb-release` package is not installed, so the command is missing. os-release is required by the systemd file format and is present even when that package is not. A script that depends on `lsb_release` fails closed on the smallest images, which are exactly the ones provisioning starts from.

`hostname` feels like an identity and is not one. Cloud images often boot with a hostname that a later boot script replaces, and two machines in a scaling group can be rebuilt with new names while the OS stays 24.04. Using the hostname to pick a repository or a config branch mixes "which box" with "which OS".

A system container shares the host kernel. `uname -r` then reports the host's kernel, which may be newer or older than the kernel a real 24.04 VM would boot, while `/etc/os-release` still says Ubuntu 24.04 because that file lives in the container's filesystem. Treating `uname -r` as proof of the userspace version is wrong in that environment in particular. The same sharing is why `modprobe`, most sysctl writes, and `date -s` fail or do nothing useful: those operations belong to the kernel, and the kernel is not yours. systemd, apt, users and the container's network stack are yours, because they live in userspace.

`free -m` totals are also easy to misread in a container that has a memory limit. The number can be the limit rather than the host's RAM. `nproc` can be the cgroup's CPU count. Read them as "what this environment will let me use", not as "what the hardware contains", when you are inside a container or a VM with a quota.

### At work

The first minute on an incident box is this inventory, written down, before any change. Fleet automation does the same thing in code: an image build reads `VERSION_CODENAME` to select a repository, a config agent refuses to run on an `ID` it does not recognise, and a capacity alert compares load with `nproc` rather than with a hard-coded 4. When a machine is rebuilt from a script, the script is the only memory of what was installed, so the inventory commands belong in the script's logs at the start. That is the same habit as infrastructure as code later: the machine is a result of the script, not a place where someone typed.

| Question | Read this | Do not read this |
|---|---|---|
| Which Ubuntu release? | `VERSION_ID` in `/etc/os-release` | `uname -r` |
| Which apt archive name? | `VERSION_CODENAME` | `hostname` |
| Which kernel is running? | `uname -r` | `VERSION_ID` |
| Which packages can I install? | `uname -m` plus the codename | the kernel string |
| How much RAM can processes get? | `available` in `free -m` | the `free` column |
| Did boot finish cleanly? | `systemctl --failed` | a single `uptime` |

### You can now

- Source `/etc/os-release` and name `ID`, `VERSION_ID` and `VERSION_CODENAME` separately from the kernel release.
- Tell a system container's limits from a full machine's: userspace is yours, the kernel is not.
- Pick `free`'s available column, `nproc`, `ss -tlnp` and `systemctl --failed` as the first look, each for the question it actually answers.

::: shell vm
task: Print just the Ubuntu release codename of this machine (one word).
expect: noble
solution:
```bash
. /etc/os-release && echo "$VERSION_CODENAME"
```
hint: `/etc/os-release` has a line for it. You can `cat` it to look, or source it with `.` and echo the variable.
:::

::: shell vm
task: Write a short machine report to `/root/report.txt`, exactly three lines: the kernel release (as `uname -r` prints it), the number of CPUs, and the total memory in MiB (the number in `free -m`'s `Mem:` total column).
verify:
```bash
want=$(printf '%s\n%s\n%s' "$(uname -r)" "$(nproc)" "$(free -m | awk '/^Mem:/ {print $2}')")
[ -f /root/report.txt ] || { echo "there is no /root/report.txt"; exit 1; }
[ "$(cat /root/report.txt)" = "$want" ] || { echo "report.txt should be:"; echo "$want"; echo "but it is:"; cat /root/report.txt; exit 1; }
```
solution:
```bash
{ uname -r; nproc; free -m | awk '/^Mem:/ {print $2}'; } > /root/report.txt
```
hint: Group the three commands with `{ …; }` and redirect the group once. `awk '/^Mem:/ {print $2}'` picks the total from `free -m`.
:::

::: quiz
q: You're writing a script that must install a package with the right repository for whatever Ubuntu release it runs on. Where does it reliably get the release codename?
- `uname -r`
+ `/etc/os-release` (`VERSION_CODENAME`)
- `hostname`
- The kernel's build date
why: `uname -r` is the kernel version, which says nothing reliable about the distribution release. `/etc/os-release` is the standard, machine-readable description of the OS.
:::

::: card
q: On Ubuntu, a script needs the distribution id and the release number (such as 24.04), not the kernel version. Which file and which variables supply those?
answer: Source `/etc/os-release`. `$ID` is the distribution (`ubuntu`) and `$VERSION_ID` is the release (`24.04`). `uname -r` prints only the kernel release, which can change without the distribution changing.
:::

::: quiz
q: A system container shares the host kernel but has its own systemd, users, filesystem and network. Which change fails from inside that container?
- Creating a systemd unit and enabling it
+ Loading a kernel module with `modprobe`
- Installing a package with `apt-get`
- Adding a user with `useradd`
why: systemd, apt and useradd all act on the container's own userspace, so they succeed. `modprobe` asks the kernel to load a module, and that kernel belongs to the host, so the call is refused. The same boundary blocks most sysctl changes and setting the clock.
:::

::: shell vm
task: Write `/root/identity.txt` with exactly two lines, `ID=<value>` and `VERSION_ID=<value>`, filled from this machine's OS identity. Do not write the kernel release.
verify:
```bash
# Wrong fix: putting `uname -r` on the first line. That is the kernel release, so ID= would not match /etc/os-release.
. /etc/os-release
[ -f /root/identity.txt ] || { echo "missing /root/identity.txt"; exit 1; }
want=$(printf 'ID=%s\nVERSION_ID=%s' "$ID" "$VERSION_ID")
got=$(cat /root/identity.txt)
[ "$got" = "$want" ] || { echo "wanted:"; printf '%s\n' "$want"; echo "got:"; printf '%s\n' "$got"; exit 1; }
```
solution:
```bash
. /etc/os-release
printf 'ID=%s\nVERSION_ID=%s\n' "$ID" "$VERSION_ID" > /root/identity.txt
```
hint: Source `/etc/os-release` and printf `$ID` and `$VERSION_ID`. Leave `uname` out of it.
:::

## Packages for real: apt and dpkg
id: apt-real
stage: run
needs: lab-intro, linux/packages
minutes: 35
goal: Install, inspect, remove and purge packages, and answer "which package owns this file?".
source: Ubuntu Server: Package management | https://documentation.ubuntu.com/server/how-to/software/package-management/
source: apt-get(8) | https://manpages.ubuntu.com/manpages/noble/man8/apt-get.8.html

On Ubuntu two layers handle software:

- **dpkg** installs, removes and lists individual `.deb` files. It knows what's installed and which files each package owns, but nothing about downloading or dependencies.
- **apt** sits on top: it reads repository indexes, resolves dependencies, downloads, and calls dpkg.

The everyday commands:

| Command | Does |
|---|---|
| `apt-get update` | refresh the package indexes (what's available, in which version). Do it before installing on a fresh machine |
| `apt-get install -y pkg` | install with dependencies; `-y` answers yes, for scripts |
| `apt-get remove pkg` | remove the program, **keep its config files** |
| `apt-get purge pkg` | remove the program **and** its config |
| `apt-get autoremove` | remove dependencies nothing needs any more |
| `apt-cache policy pkg` | installed and candidate versions, and from which repository |
| `dpkg -l pkg` | install state; first column `ii` installed, `rc` removed but config left |
| `dpkg -L pkg` | files the package installed |
| `dpkg -S /path` | which package owns this file |

`apt` (without `-get`) is the friendlier interactive front end; scripts use `apt-get` because its output and options are stable. In scripts, also set `DEBIAN_FRONTEND=noninteractive` so packages that want to ask questions take their defaults instead of hanging.

### remove vs purge, and why it bites

`remove` deliberately keeps configuration under `/etc`, so reinstalling gives you back your settings. That's kind, until you want a clean reinstall after breaking a config: you remove, reinstall, and your broken config is still there. `dpkg -l` shows such packages as `rc` (removed, config remains). `purge` is the clean slate.

Package names and binary names don't always match: `dig` comes from `dnsutils` (or `bind9-dnsutils`), `nslookup` too; `ip` from `iproute2`; `ps` from `procps`. `dpkg -S` answers it for an installed file; `apt-file search` for files in packages you don't have yet.

### Versions and pinning

`apt-cache policy nginx` shows the installed version and the candidate apt would install, with each repository's priority. `apt-mark hold pkg` freezes a package at its current version, so `apt-get upgrade` leaves it alone, the usual tool when an upgrade breaks something and you need time. Unattended security upgrades (`unattended-upgrades`) run automatically on most Ubuntu servers; know they exist when something changed overnight.

### What apt decides before dpkg runs

dpkg is the installer that unpacks a `.deb`, runs its maintainer scripts, and records the result in `/var/lib/dpkg/status`. It will refuse to unpack a package whose dependencies are missing, and it will not go and fetch them. apt's job is the graph: read the indexes under `/var/lib/apt/lists`, choose a version, pull that `.deb` and every dependency, then call dpkg in an order that satisfies the graph. `apt-get update` only refreshes those indexes. It installs nothing. On a machine whose lists are empty or older than the archive, `apt-get install` either fails to find the package or finds a stale version, so update comes first in a script even when it feels redundant.

The status letters in `dpkg -l` are two columns glued together. The first is what you asked for (install, remove, purge, hold). The second is what is true now. `ii` means desired install and current installed. `rc` means desired remove and config-files still present. That second letter is why a "removed" nginx still has `/etc/nginx` and why the next install resurrects a broken config. `purge` sets the desired state so the conffiles go away too. Files you created yourself under `/etc/nginx` are not conffiles, so purge can leave the directory behind; a clean reinstall still needs the directory gone if you want the package defaults and nothing else.

```text
apt-get update     rewrite the index of what exists in the archive
apt-get install    choose versions, download, unpack, configure
dpkg status db     ii / rc / iU  — desired state plus current state
conffiles          shipped config, kept on remove, deleted on purge
other files        logs, local edits you made; not always removed
```

`DEBIAN_FRONTEND=noninteractive` matters because maintainer scripts ask debconf questions through a frontend that, by default, wants a terminal. A script with no terminal waits forever, which looks like a hung provision. Noninteractive makes debconf pick the default answer and continue. `-y` answers apt's own "do you want to install these packages?" question. Neither flag skips a maintainer script failure; they only skip prompts.

### A worked install of a different tool

`curl` is already common. `jq` is the exercise. Here is `ripgrep` as the shape of a script install, with the index refresh and the frontend made explicit:

```bash
apt-get update -q
DEBIAN_FRONTEND=noninteractive apt-get install -y -q ripgrep
dpkg-query -W -f='${Status}\n' ripgrep
```

`dpkg-query -W` asks the status database rather than parsing the table that `dpkg -l` draws for humans. The format string prints the status field, and `install ok installed` is the phrase that means the package is unpacked and configured. `command -v rg` then proves the binary landed on `PATH`. Both checks are needed: a binary can exist from a copied file that dpkg has never heard of, and a package can be recorded installed while a later `rm` removed the binary.

Finding an owner is the reverse map. `dpkg -S /usr/bin/rg` prints `ripgrep: /usr/bin/rg`. The package name is the field before the colon. That is how you learn that `dig` on Ubuntu 24.04 comes from `bind9-dnsutils` (the older `dnsutils` name is a transitional package that pulls it in), that `ss` comes from `iproute2`, and that `ps` comes from `procps`. Guessing the package name from the command name fails often enough that the query is the habit.

### Where it breaks

`apt-get remove nginx` leaves `rc` and the config. The following install looks successful and serves the old, broken site. The status database told you this before you reinstalled, if you looked at the first column. `purge` of the metapackage name `nginx` may not purge `nginx-common`, which is where the config actually lives, so a glob or an explicit list of every nginx package is what empties `/etc/nginx`. `autoremove` then drops libraries nothing depends on any more; it does not purge conffiles of packages you removed by hand.

`apt-mark hold nginx` freezes the installed version so a later `upgrade` will not move it. The hold survives because it is stored in the dpkg database, not in the unit file. People forget holds. A machine that "will not take a security update" often has a hold from an incident six months ago. `apt-mark showhold` lists them. Unattended-upgrades, which Ubuntu enables on servers, will also skip a held package, so a hold is both a brake and a blind spot.

A partial configure (`iU` or "unpacked but not configured") happens when a maintainer script failed halfway. `apt-get -f install` tries to finish the graph. Running dpkg by hand on one `.deb` in the middle of that usually deepens the tangle, because the dependency order is what apt was tracking.

### At work

Image builds and cloud-init scripts call `apt-get` and never `apt`, because the `apt` command warns that its interface is not stable for scripts. The same scripts pin or hold the one package whose upgrade has bitten them, and they let unattended-upgrades take the rest so a fleet does not sit a year behind on OpenSSH. When a host is handed to you, `dpkg -l` and `apt-mark showhold` are part of the inventory, next to os-release. Removing a package in production is a purge only when you have the config in version control; otherwise remove, so a rollback still has the files.

| Goal | Command | Leaves behind |
|---|---|---|
| Install in a script | `DEBIAN_FRONTEND=noninteractive apt-get install -y` | the package and its conffiles |
| Uninstall, keep settings | `apt-get remove` | `rc` and `/etc` config |
| Uninstall, discard settings | `apt-get purge` plus a check that the directory is gone | dependency packages, until autoremove |
| Freeze one version | `apt-mark hold` | a hold you must remember to show |
| Who owns this path? | `dpkg -S /path` | nothing; it only queries |

### You can now

- Explain `ii` versus `rc`, and why remove-then-install resurrects a broken config.
- Install with update, `-y` and a noninteractive frontend, then prove the status database agrees.
- Find the package that owns a file, including tools whose package name is not the command name.
- Hold a package on purpose and know that unattended-upgrades will honour the hold.

::: shell vm
task: Install `jq` from the Ubuntu archive. (The check looks at the real install state, not your output.)
setup:
```bash
# The lab image pulls jq in via prometheus-node-exporter-collectors. Remove it so "install jq" still has work to do.
DEBIAN_FRONTEND=noninteractive apt-get purge -y -q jq || true
```
verify:
```bash
command -v jq >/dev/null || { echo "jq isn't installed"; exit 1; }
dpkg-query -W -f='${Status}' jq 2>/dev/null | grep -q 'install ok installed' || { echo "dpkg doesn't list jq as installed"; exit 1; }
```
solution:
```bash
apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q jq
```
hint: A fresh machine's package lists are empty or stale: update first, then install.
:::

::: shell vm
task: Find out which package owns the file `/usr/sbin/nginx`, and write just the package name into `/root/answer`.
verify:
```bash
want=$(dpkg -S /usr/sbin/nginx | cut -d: -f1 | head -n 1)
[ "$(cat /root/answer 2>/dev/null | tr -d ' \n')" = "$want" ] || { echo "that's not the package that owns /usr/sbin/nginx"; exit 1; }
```
solution:
```bash
dpkg -S /usr/sbin/nginx | cut -d: -f1 > /root/answer
```
hint: `dpkg -S path` prints `package: path`.
:::

::: shell vm
task: nginx is installed and someone customised it. Remove nginx **completely**, including its configuration under `/etc/nginx`, so a later reinstall would start from the package defaults. (No `rc` leftovers.)
setup:
```bash
printf 'server { listen 8088; }\n' > /etc/nginx/conf.d/custom.conf
```
verify:
```bash
[ ! -e /etc/nginx ] || { echo "/etc/nginx still exists (remove keeps config; purge doesn't)"; exit 1; }
! dpkg -l 2>/dev/null | awk '{print $1, $2}' | grep -E '^(ii|rc) nginx(-common|-core)?$' || { echo "dpkg still lists an nginx package as installed or rc"; exit 1; }
```
solution:
```bash
DEBIAN_FRONTEND=noninteractive apt-get purge -y -q 'nginx*'
apt-get autoremove -y -q
rm -rf /etc/nginx
```
hint: `remove` keeps config. `dpkg -l | grep nginx` shows every nginx package and its state. Purge them all.
:::

::: quiz
q: You removed a package, reinstalled it, and your broken config file is still there. Why?
- apt caches old installs
+ `remove` keeps configuration files; only `purge` deletes them
- The reinstall used a different repository
- dpkg can't overwrite files in /etc
why: Keeping config on remove is deliberate (so a reinstall keeps your settings). `dpkg -l` shows such packages as `rc`. Purge for a clean slate.
:::

::: quiz
q: `dpkg -l nginx` shows a row whose first column is `rc`. What state is the package in?
- It is installed and its configuration is valid
+ It was removed, but its configuration files are still on disk
- The download failed and apt will retry it
- It is held, so `apt-get upgrade` will skip it
why: The two letters are the desired action and the current state. `r` means remove and `c` means config-files remain, which is what `apt-get remove` leaves behind. `ii` means installed. A hold is a separate mark (`apt-mark hold`), not the letters `rc`. `purge` is what clears the leftover config.
:::

::: card
q: A shell script must install `curl` on Ubuntu and must not stop to ask a debconf question. What shape of command do you use?
answer: Run `apt-get update`, then `DEBIAN_FRONTEND=noninteractive apt-get install -y curl`. `apt-get` keeps a stable interface for scripts, `-y` answers the install prompt, and the noninteractive frontend makes debconf take defaults instead of waiting for a terminal.
:::

## Writing a systemd service
id: units
stage: run
needs: apt-real
minutes: 40
goal: Turn any program into a managed service: unit file, user, working directory, start on boot, status and logs.
source: systemd.service(5) | https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html
source: systemd.exec(5) | https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html

A **service** is a program systemd starts, watches, restarts and logs for you. You describe it in a **unit file** and systemd does the rest. Compared with `nohup ./app &`, you get: start at boot, restart on crash, a clean stop on shutdown, logs in the journal, resource limits, and running as an unprivileged user.

Your own units go in `/etc/systemd/system/`. Packages put theirs in `/usr/lib/systemd/system/`, and yours win on a name clash, so never edit the package's copy.

```ini
# /etc/systemd/system/web.service
[Unit]
Description=Team web page
After=network.target

[Service]
User=web
Group=web
WorkingDirectory=/srv/web
ExecStart=/usr/bin/python3 -m http.server 8080 --bind 127.0.0.1
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

- `[Unit]` is about relationships: `After=` orders start-up (start me after the network target), it doesn't pull anything in.
- `[Service]` is the process: `ExecStart` must be an **absolute path** (systemd doesn't search `PATH` the way a shell does, and doesn't run a shell, so no `&&` or `>` redirects unless you call `/bin/sh -c`). `User=` drops root.
- `[Install]` is only used by `enable`: `WantedBy=multi-user.target` means "start me when the normal multi-user system starts", which is how you get start-at-boot.

### The four commands, in order

```bash
systemctl daemon-reload          # re-read unit files after creating or editing one
systemctl enable --now web       # start at boot AND start now
systemctl status web             # running? PID? last log lines
journalctl -u web -e             # the service's log, jump to the end
```

`enable` and `start` are independent: `enable` creates a link so it starts at boot, `start` runs it now. `enable --now` does both. Forgetting `daemon-reload` after editing a unit is the most common "my change does nothing" mistake; systemd warns about it in `status`.

### A user for the service

Services shouldn't run as root. Create a **system user** with no login shell and no password:

```bash
useradd --system --home-dir /srv/web --shell /usr/sbin/nologin web
```

Give it ownership of exactly what it must write, and nothing else. If the program is compromised, the attacker gets that user's rights, not root's. (systemd can also create a throwaway user per service with `DynamicUser=yes`, and confine it with `ProtectSystem=strict`, `PrivateTmp=yes` and friends; `systemd-analyze security web` scores a unit's hardening.)

### Checking it really works

`systemctl is-active web` prints `active` and exits 0. `is-enabled` does the same for boot. But "active" only means the process is running; a program can run and still not serve. Check the actual function: `curl -fsS http://127.0.0.1:8080/`. Health checks in production do the same.

### What systemd stores when you start a unit

A unit file on disk is not what systemd runs. `daemon-reload` parses every unit into memory, and `start` uses that copy. Editing the file and restarting without a reload restarts the old definition, which is why the service "ignores" your change and why `status` prints that the file on disk changed. `enable` does not even look at `ExecStart`. It reads only the `[Install]` section and creates a symlink in `multi-user.target.wants/` (or whichever target `WantedBy=` names). Boot reaches that target, wants the symlink, and starts the unit. Delete the symlink by hand and you have disabled the unit without using `disable`.

`ExecStart` is an argv array, not a shell line. systemd splits on whitespace, does not expand `$VARS` unless you ask, does not search `PATH`, and does not run `&&` or redirects. The first token has to be a file it can `exec`. A relative name like `python3` is looked up from `/` and fails with `203/EXEC` before any interpreter starts. `/usr/bin/python3` works because that path exists. If you truly need a shell, the program is `/bin/sh` and the script is its argument (`/bin/sh -c '...'`), which is easy to get wrong and worth avoiding when the real binary has a path.

```text
unit file on disk
    |  daemon-reload
    v
in-memory unit  ---- start ----> fork/exec ExecStart as User=
    |
    |  enable reads [Install] only
    v
multi-user.target.wants/name.service -> /etc/systemd/system/name.service
```

The process runs as `User=` after the exec setup, so that user must exist first (`217/USER` if it does not). A system account from `useradd --system --shell /usr/sbin/nologin` has no password and no interactive shell, which is what you want for a daemon. It still needs to read its working directory and its program. `WorkingDirectory=` is a `chdir` before exec. If the directory is root-only mode 700, the user cannot chdir and the start fails even though the binary is fine.

`systemctl is-active` means the main process is running (or, for a oneshot with `RemainAfterExit=yes`, that it finished successfully). It does not mean the process accepts connections. A health check is a request to the service: `curl` the page, query the port, run the program's own status command. Production checks do both, because a process can be alive and wedged.

### A worked unit for a different page

A status file served on port 8099, as a user named `status`, is the same shape as any small static service and a different path from the usual 8080 page:

```ini
[Unit]
Description=Status page
After=network.target

[Service]
User=status
WorkingDirectory=/srv/status
ExecStart=/usr/bin/python3 -m http.server 8099 --bind 127.0.0.1
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

`After=network.target` only orders this unit after the network target if both are started. It does not start the network, and `network.target` on modern systemd is a weak "network management is up" point, not "an address is configured". Binding to `127.0.0.1` avoids needing a public address at all. `User=status` is the blast radius: a bug in the Python process can write what `status` can write, not what root can write. `Restart=on-failure` is named here so a crash comes back; the restart policy itself is a separate decision from "how do I define the process".

Hardening that is worth knowing once the unit runs: `NoNewPrivileges=yes` stops the process and its children from gaining privileges through setuid. `ProtectSystem=strict` makes `/usr`, `/boot` and `/etc` read-only for the service. `systemd-analyze security status` scores the unit. Those settings do not fix a wrong path; add them after the service actually serves.

### Where it breaks

`203/EXEC` with a correct-looking command is almost always the path or the execute bit. A script written by a deploy that is mode 644, or a shebang pointing at `/usr/bin/env python3` when you needed an absolute interpreter and the environment has no `PATH` search, fails the same way. The program's own logs are empty because the program never started. `journalctl -u` still has systemd's line, which is the one to read.

`217/USER` is the other early failure. Creating the unit before `useradd` does this. So does a typo in `User=`. The fix is the account, not a change to the program.

Forgetting `daemon-reload` after an edit is the failure that looks like "Linux is caching". It is not a cache of the binary. It is systemd holding the parsed unit. `restart` applies the in-memory unit again. Packages that drop a unit into `/usr/lib/systemd/system` get the same rule: your replacement in `/etc/systemd/system` wins by path, but only after a reload, and only if you did not edit the package file (the next package upgrade would overwrite that one).

### At work

Every long-running process on a current Ubuntu server is a unit, including the ones a package shipped. Deploy tooling writes `/etc/systemd/system/app.service` or a drop-in, reloads, and restarts. The same file is what a colleague reads at 3am, so `User=`, the working directory and the absolute `ExecStart` are the whole design. Process supervisors and container orchestrators do the same three jobs — restart, logs, an unprivileged user — with different file formats. If you can explain why `is-active` is not a health check, you can explain why a container "running" is not the same as a ready endpoint.

| Symptom | Cause | Fix |
|---|---|---|
| `203/EXEC` | path is not an executable file | absolute `ExecStart`, mode 755 if it is a script |
| `217/USER` | `User=` does not exist | create the system user first |
| edit had no effect | in-memory unit is stale | `daemon-reload`, then restart |
| active, not serving | process is up and the app is not | curl or the real health check |
| starts now, not on boot | `start` without `enable` | `WantedBy=` and `enable` |

### You can now

- Write a unit whose `ExecStart` is an absolute argv, running as a system user, and enable it for boot.
- Read `203/EXEC` and `217/USER` as setup failures that happen before the program runs.
- Reload after every edit, and check the service with a request, not only with `is-active`.

::: shell vm
task: Run a small web page as a service. Create a system user `web`, a folder `/srv/web` containing `index.html` with the text `hello from web`, and a unit `web.service` that runs `/usr/bin/python3 -m http.server 8080 --bind 127.0.0.1` from `/srv/web` **as the user web**. It must be running now **and** enabled at boot.
verify:
```bash
for i in $(seq 1 20); do curl -fsS http://127.0.0.1:8080/ 2>/dev/null | grep -q 'hello from web' && break; sleep 0.25; done
systemctl is-active --quiet web || { echo "web.service isn't active"; systemctl status web --no-pager | head -n 12; exit 1; }
systemctl is-enabled --quiet web || { echo "web.service isn't enabled at boot"; exit 1; }
curl -fsS http://127.0.0.1:8080/ | grep -q 'hello from web' || { echo "nothing on 127.0.0.1:8080 says 'hello from web'"; exit 1; }
pid=$(systemctl show -p MainPID --value web)
[ "$(ps -o user= -p "$pid" | tr -d ' ')" = web ] || { echo "the service runs as $(ps -o user= -p "$pid"), not as web"; exit 1; }
```
solution:
```bash
useradd --system --home-dir /srv/web --shell /usr/sbin/nologin web
mkdir -p /srv/web
echo 'hello from web' > /srv/web/index.html
cat > /etc/systemd/system/web.service <<'EOF'
[Unit]
Description=Team web page
After=network.target

[Service]
User=web
WorkingDirectory=/srv/web
ExecStart=/usr/bin/python3 -m http.server 8080 --bind 127.0.0.1
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now web
```
hint: User first, then the folder and page, then the unit file with a heredoc, then `daemon-reload` and `enable --now`. `ExecStart` needs absolute paths.
:::

::: quiz
q: You edited `/etc/systemd/system/web.service` and ran `systemctl restart web`, but it still runs with the old settings. What did you forget?
- `systemctl enable web`
+ `systemctl daemon-reload`, so systemd re-reads the unit file
- Rebooting
- `journalctl -u web`
why: systemd keeps its own copy of unit files in memory. After any edit, `daemon-reload`, then restart. `systemctl status` even prints a warning that the unit file changed on disk.
:::

::: card
q: What's the difference between `systemctl enable web` and `systemctl start web`?
answer: `start` runs it now. `enable` links it into the boot target (from `[Install] WantedBy=`) so it starts at every boot, without starting it now. `enable --now` does both.
:::

::: quiz
q: A unit fails at once with `status=203/EXEC`. Its ExecStart line is `python3 -m http.server 8091`. The interpreter is installed at `/usr/bin/python3`. Why did exec fail?
- Port 8091 is privileged, so only root may bind it
+ systemd does not search PATH and does not run a shell, so a bare command name is not a program it can exec
- `WantedBy=` is missing, so the unit is not allowed to start
- python3 refuses to run when systemd is the parent
why: systemd calls exec on the path you wrote. `python3` is not a file in the root directory, so exec fails before Python starts, and systemd reports 203/EXEC. `/usr/bin/python3` is a real path. A missing `User=` is 217/USER, a different failure, and `WantedBy=` only matters for `enable`.
:::

::: shell vm
task: `hook.service` is installed but will not serve. Its program must stay Python's `http.server`, bound to `127.0.0.1` port **8091**, with working directory `/var/lib/hook`. Fix the unit so the service is active and `http://127.0.0.1:8091/` returns a page containing `hook ready`.
setup:
```bash
mkdir -p /var/lib/hook
echo 'hook ready' > /var/lib/hook/index.html
cat > /etc/systemd/system/hook.service <<'EOF'
[Unit]
Description=Hook page

[Service]
WorkingDirectory=/var/lib/hook
ExecStart=python3 -m http.server 8091 --bind 127.0.0.1

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl start hook || true
```
verify:
```bash
# Wrong fix: systemctl restart hook without changing ExecStart. The relative name python3 still cannot be exec'd, so the unit stays failed with 203/EXEC.
systemctl is-active --quiet hook || { echo "hook.service is not active"; systemctl status hook --no-pager | head -n 12; exit 1; }
for i in $(seq 1 20); do curl -fsS http://127.0.0.1:8091/ 2>/dev/null | grep -q 'hook ready' && break; sleep 0.25; done
curl -fsS http://127.0.0.1:8091/ | grep -q 'hook ready' || { echo "127.0.0.1:8091 does not serve hook ready"; exit 1; }
show=$(systemctl show -p ExecStart --value hook)
echo "$show" | grep -q '/usr/bin/python3' || echo "$show" | grep -q '/bin/sh' || { echo "ExecStart still is not an absolute program: $show"; exit 1; }
echo "$show" | grep -q '8091' || { echo "the service must stay on port 8091"; exit 1; }
```
solution:
```bash
sed -i 's|^ExecStart=.*|ExecStart=/usr/bin/python3 -m http.server 8091 --bind 127.0.0.1|' /etc/systemd/system/hook.service
systemctl daemon-reload
systemctl reset-failed hook || true
systemctl restart hook
```
hint: `systemctl status hook` shows 203/EXEC when the program path is not absolute. Edit ExecStart, `daemon-reload`, then restart.
:::

## Restarts and dependencies
id: restarts
stage: run
needs: units
minutes: 30
goal: Make a flaky service recover on its own, change a packaged unit without editing it, and order services correctly.
source: systemd.unit(5): dependencies and ordering | https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html
source: systemctl edit (drop-in files) | https://www.freedesktop.org/software/systemd/man/latest/systemctl.html

Programs crash. A service that's down until someone notices is worse than one that comes back in a second. systemd's restart settings:

| Setting | Means |
|---|---|
| `Restart=on-failure` | restart when it exits non-zero, is killed by a signal, or times out (not on a clean exit 0) |
| `Restart=always` | restart whatever happened, even after a clean exit |
| `RestartSec=2` | wait 2 seconds before restarting |
| `StartLimitBurst=5`, `StartLimitIntervalSec=60` (in `[Unit]`) | give up if it fails 5 times in 60 seconds |

The start limit matters: a service that crashes instantly would otherwise restart forever and fill the journal. After hitting it, the unit is `failed` with "start request repeated too quickly", and `systemctl reset-failed` clears the counter. `systemctl show -p NRestarts web` tells you how often it restarted, the first number to look at for a "flapping" service.

### Drop-ins: change a unit without editing it

You want `Restart=on-failure` on a service whose unit file belongs to a package, or to a teammate's deployment. Don't edit their file (a package upgrade overwrites it). Add a **drop-in**: a file in `/etc/systemd/system/NAME.service.d/*.conf` with just the settings you change:

```ini
# /etc/systemd/system/flaky.service.d/restart.conf
[Service]
Restart=on-failure
RestartSec=1
```

`systemctl edit flaky` opens an editor and creates exactly that file for you; in scripts, write it directly. `systemctl cat flaky` shows the unit and every drop-in in the order they apply, the way to answer "where does this setting come from?".

### Ordering vs requirements

Two separate ideas, constantly confused:

- **Ordering**: `After=db.service` means "if both start, start me after db". It doesn't make db start.
- **Requirement**: `Wants=db.service` pulls db in when you start (failures tolerated); `Requires=db.service` also stops you if db stops.

Usually you want both: `Wants=` + `After=`. Even then, "started" for a database means its process is running, not that it accepts connections; well-written apps retry their connections, which is more robust than any ordering.

### Two clocks inside a restart

systemd decides to restart by looking at how the process ended, then waits `RestartSec=`, then tries again until the start limit says the crash is a loop. `Restart=on-failure` treats a non-zero exit, a fatal signal, and a timeout as failure. A clean exit 0 is success, so a batch job that finishes stays dead, which is what you want. `Restart=always` also restarts after exit 0, which is what a daemon that should never stay stopped wants, and what will make a finished batch run forever. `Restart=on-abnormal` is narrower still: signals and timeouts, not a plain non-zero exit. Picking `always` because "we want it up" is how a one-shot import loop fills the disk.

The start limit is in the `[Unit]` section, not `[Service]`, because it counts start attempts of the unit: `StartLimitBurst=5` and `StartLimitIntervalSec=60` mean five failed starts in a minute and then stop trying. The unit sits in `failed` with "start request repeated too quickly". The counter survives your fix until `systemctl reset-failed`. People hit this, repair the bug, and think the repair failed because start still refuses. `systemctl show -p NRestarts` is the counter of how many times this process has been replaced. If it climbs every few seconds, you are in a loop even when `is-active` flickers to active.

```text
process exits
    |
    +-- exit 0, Restart=on-failure --> stay inactive
    +-- non-zero / signal / timeout --> wait RestartSec
                |
                v
         burst still under the limit? --no--> failed, until reset-failed
                |
               yes
                v
              exec again
```

A drop-in is a second unit fragment. systemd loads `/etc/systemd/system/NAME.service` and then every `NAME.service.d/*.conf` in lexical order, and later settings override earlier ones for the same key. The fragment can contain `[Unit]`, `[Service]`, or both. It cannot invent a new unit name. `systemctl cat NAME` prints the base file and each fragment so you can see who set `Restart=`. Editing the package file under `/usr/lib` works until the package upgrades and replaces it. The drop-in in `/etc` survives that upgrade. `daemon-reload` is still required, and a restart is required for settings that apply at exec time.

### A worked dependency that is not "app and db"

Ordering and requiring are different edges. `After=queue.service` means "if both are in this transaction, start me later". It does not add queue to the transaction. `Wants=queue.service` adds it, and if queue fails, this unit still starts. `Requires=queue.service` adds it and stops this unit if queue fails or stops later. A worker that can wait and retry wants `Wants=` plus `After=`. A worker that corrupts data if it runs without the queue wants `Requires=` plus `After=`, and you still have to accept that "queue is active" means its main process started, not that it accepts jobs. The robust pattern is `Wants=` and `After=` plus retries inside the worker.

```ini
# /etc/systemd/system/worker.service.d/queue.conf
[Unit]
Wants=queue.service
After=queue.service
```

The main unit file stays whatever the package shipped. `systemctl daemon-reload` and `systemctl restart worker` pull queue in because starting worker now wants queue. `systemctl show -p Wants --value worker` and `-p After` show the merged result. If only `After=` was added, queue stays stopped and the show output for `Wants` does not list it.

### Where it breaks

`Restart=on-failure` with a program that crashes in a tight loop and no start limit will restart as fast as `RestartSec=` allows and write a journal line each time. The disk fills with the journal, or journald's rate limit hides the one line you needed. Set a burst, and alert on `NRestarts` rather than on "the process exists".

A drop-in with no section header is ignored or rejected. The keys must sit under `[Service]` or `[Unit]`. A drop-in that sets `ExecStart=` replaces the whole command only if you clear it first (`ExecStart=` on a line by itself, then the new command), because systemd appends additional `ExecStart=` lines for some service types. If the service starts the old command and the new one, that empty reset was missing.

`Requires=` without `After=` pulls the other unit in and does not wait for it. Both start at once, the dependent loses the race, and it looks like "Requires is broken". The requirement is about failure propagation. The order is `After=`. You usually write both.

### At work

Package units ship with a cautious restart policy or none. The local change is a drop-in, reviewed like any other config, so an upgrade does not wipe the on-call fix. Orchestrators encode the same split: a restart policy, a backoff, a maximum number of retries, and a dependency that is either "start this too" or "start this first". When an incident is a crash loop, the useful artefact is the journal from the first failure plus `NRestarts`, not a screenshot of `active` taken between restarts.

| You want | Setting | Missing piece that bites |
|---|---|---|
| Come back from a crash, stay down after success | `Restart=on-failure` | a start limit, or the journal fills |
| Never stay stopped | `Restart=always` | it also restarts a finished batch |
| Change a packaged unit | drop-in under `NAME.service.d` | `daemon-reload` and a restart |
| Start the other unit too | `Wants=` or `Requires=` | `After=`, or you race it |
| Order only | `After=` | the other unit never starts |

### You can now

- Choose `on-failure` versus `always` from the exit code you want to survive.
- Clear a start limit with `reset-failed`, and read `NRestarts` as the loop counter.
- Put `Wants=` and `After=` in a drop-in without editing the shipped unit, and predict what each key does alone.

::: shell vm
task: `flaky.service` (already installed and started) crashes on its first two starts, then works, so right now it's dead. Without editing its unit file, add a drop-in so it restarts on failure after 1 second, and start it again. It must end up active.
setup:
```bash
cat > /usr/local/bin/flaky.sh <<'EOF'
#!/bin/bash
n=$(cat /var/lib/flaky-count 2>/dev/null || echo 0)
echo $((n + 1)) > /var/lib/flaky-count
[ "$n" -lt 2 ] && { echo "flaky: not ready yet (start $((n + 1)))" >&2; exit 1; }
exec sleep infinity
EOF
chmod +x /usr/local/bin/flaky.sh
cat > /etc/systemd/system/flaky.service <<'EOF'
[Unit]
Description=A service that needs a few tries

[Service]
ExecStart=/usr/local/bin/flaky.sh

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl start flaky || true
```
verify:
```bash
grep -q '^ExecStart=/usr/local/bin/flaky.sh$' /etc/systemd/system/flaky.service && ! grep -q Restart /etc/systemd/system/flaky.service || { echo "the unit file itself was edited; use a drop-in"; exit 1; }
ls /etc/systemd/system/flaky.service.d/*.conf >/dev/null 2>&1 || { echo "no drop-in in /etc/systemd/system/flaky.service.d/"; exit 1; }
for i in $(seq 1 24); do systemctl is-active --quiet flaky && break; sleep 0.25; done
systemctl is-active --quiet flaky || { echo "flaky isn't active"; systemctl status flaky --no-pager | head -n 8; exit 1; }
[ "$(systemctl show -p Restart --value flaky)" = on-failure ] || { echo "Restart isn't on-failure"; exit 1; }
```
solution:
```bash
mkdir -p /etc/systemd/system/flaky.service.d
cat > /etc/systemd/system/flaky.service.d/restart.conf <<'EOF'
[Service]
Restart=on-failure
RestartSec=1
EOF
systemctl daemon-reload
systemctl reset-failed flaky
systemctl start flaky
sleep 4
```
hint: Drop-in folder `flaky.service.d`, a `.conf` file with a `[Service]` section, `daemon-reload`, then start it. It needs a few seconds to get through its two crashes; a `sleep` at the end lets you see it come up.
:::

::: quiz
q: A unit has `After=postgresql.service` but no `Wants=` or `Requires=`. You start only this unit, and postgresql is stopped. What happens?
+ Only this unit starts; `After=` orders start-up but never pulls postgresql in
- postgresql starts first, then this unit
- The start fails because postgresql isn't running
- systemd waits forever for postgresql
why: Ordering and requirements are separate. Add `Wants=postgresql.service` (or `Requires=`) to pull it in, and keep `After=` for the order.
:::

::: card
q: How do you change one setting of a packaged unit so the change survives package upgrades?
answer: A drop-in: `/etc/systemd/system/NAME.service.d/override.conf` with only the changed settings (`systemctl edit NAME` creates it), then `daemon-reload` and restart. `systemctl cat NAME` shows the result.
:::

::: quiz
q: A service runs a batch program that exits 0 when the batch finishes. The unit sets `Restart=on-failure` and `RestartSec=2`. What does systemd do after that clean exit?
+ It leaves the unit inactive. `on-failure` does not restart a zero exit
- It starts the program again after 2 seconds
- It marks the unit failed, because a batch should not exit
- It waits until StartLimitBurst is reached, then gives up
why: `on-failure` restarts a non-zero exit, a signal, or a timeout. Exit 0 is success, so the unit stays dead until something starts it. `Restart=always` is the setting that brings it back even after a clean exit, which is what a long-running daemon wants and what a finished batch does not.
:::

::: shell vm
task: `app.service` is running and `db.service` exists but is stopped. Without editing `/etc/systemd/system/app.service` itself, make a start of app also start db, and make app start after db. Restart app. Both units must be active, and the main app unit file must not contain `Wants=` or `After=`.
setup:
```bash
for n in db app; do
  printf '[Unit]\nDescription=%s\n\n[Service]\nExecStart=/bin/sleep infinity\n\n[Install]\nWantedBy=multi-user.target\n' "$n" > "/etc/systemd/system/$n.service"
done
systemctl daemon-reload
systemctl start app
```
verify:
```bash
# Wrong fix: writing only After=db.service into /etc/systemd/system/app.service. Ordering does not start db, and the main file was supposed to stay untouched.
! grep -E '^(Wants|After|Requires)=' /etc/systemd/system/app.service || { echo "the main unit file was edited; use a drop-in"; exit 1; }
ls /etc/systemd/system/app.service.d/*.conf >/dev/null 2>&1 || { echo "no drop-in in app.service.d"; exit 1; }
systemctl is-active --quiet app || { echo "app is not active"; exit 1; }
systemctl is-active --quiet db || { echo "db is not active (Wants= is what pulls it in)"; exit 1; }
systemctl show -p Wants --value app | grep -q 'db.service' || { echo "app does not want db.service"; exit 1; }
systemctl show -p After --value app | grep -q 'db.service' || { echo "app is not ordered After=db.service"; exit 1; }
```
solution:
```bash
mkdir -p /etc/systemd/system/app.service.d
cat > /etc/systemd/system/app.service.d/db.conf <<'EOF'
[Unit]
Wants=db.service
After=db.service
EOF
systemctl daemon-reload
systemctl restart app
```
hint: A drop-in can contain a `[Unit]` section. `Wants=` pulls db in; `After=` orders the two starts. `daemon-reload`, then restart app.
:::

## Timers instead of cron
id: timers-real
stage: run
needs: units, linux/cron
minutes: 30
goal: Schedule a job with a systemd timer, check when it fires next, and run it on demand.
source: systemd.timer(5) | https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html
source: systemd.time(7): calendar events | https://www.freedesktop.org/software/systemd/man/latest/systemd.time.html

A **timer** is a unit that starts another unit on a schedule. You write two files: the job as a `oneshot` service, and the timer that triggers it.

```ini
# /etc/systemd/system/backup.service
[Unit]
Description=Nightly backup of /srv/data

[Service]
Type=oneshot
ExecStart=/usr/local/bin/backup.sh
```

```ini
# /etc/systemd/system/backup.timer
[Unit]
Description=Run backup.service every night

[Timer]
OnCalendar=*-*-* 03:15:00
Persistent=true
RandomizedDelaySec=5min

[Install]
WantedBy=timers.target
```

- `Type=oneshot` means "runs to completion, then it's done", the right type for jobs.
- `OnCalendar=` uses systemd's calendar syntax: `*-*-* 03:15:00` is every day at 03:15; `Mon *-*-* 03:15` is Mondays; `hourly`, `daily`, `weekly` are shortcuts.
- `Persistent=true`: if the machine was off at 03:15, run once at the next boot. Cron just skips it.
- `RandomizedDelaySec=` spreads a fleet so 500 servers don't hit the backup store at the same second.

You enable the **timer**, not the service: `systemctl enable --now backup.timer`. The service has no `[Install]` section because nothing should start it at boot.

### Why teams move jobs from cron to timers

| | cron | systemd timer |
|---|---|---|
| Logs | wherever the script sends them (often mail, or nowhere) | the journal: `journalctl -u backup` |
| Missed runs | skipped | `Persistent=true` catches up |
| Run it now, exactly as scheduled | copy the command and hope the environment matches | `systemctl start backup.service` |
| Overlap | two runs can overlap | a running oneshot isn't started twice |
| Limits and sandboxing | none | every systemd.exec option (`User=`, `MemoryMax=`, `ProtectSystem=`) |

Check your schedule before trusting it: `systemd-analyze calendar '*-*-* 03:15:00'` prints the next elapse time, and `systemctl list-timers` shows every timer with its next and last run.

### Calendar time and monotonic time

A timer unit does not run your script. It elapses, then starts another unit, almost always a `Type=oneshot` service whose `ExecStart` is the script. The service has no `[Install]` section when only the timer should start it. Enabling the service would also start it at boot, which is a different schedule from the one you wrote. Enabling the timer creates a symlink in `timers.target.wants/`. Boot starts `timers.target`, which starts the timer unit, which then waits. `systemctl start the.service` is how you run the job once, on demand, with the same user, environment and limits the timer would have used. Copying the shell command out of the unit and running it by hand is how you get a different `PATH` and a false sense that the job works.

Calendar events and monotonic events are stored separately, and `systemctl show` reports them as `TimersCalendar` and `TimersMonotonic`. `OnCalendar=` is wall-clock time, interpreted in the timezone of the machine, with the syntax in systemd.time: `*-*-* 03:15:00` is every day at 03:15, `Mon *-*-* 09:00` is Mondays, and the shortcuts `hourly`, `daily` and `weekly` expand to calendar events. `systemd-analyze calendar 'Mon *-*-* 09:00'` prints the next few times so you can see that you did not ask for "every day" by accident. `OnBootSec=` and `OnUnitActiveSec=` are monotonic. They count from boot, or from the last time the unit became active, and they do not care that the clock jumped. A timer can have both kinds. A timer that should only be "a minute after boot" has `OnBootSec=1min` and an empty `TimersCalendar`.

```text
timers.target
    |
    v
backup.timer          (enabled)  waits for OnCalendar= or OnBootSec=
    |  elapse
    v
backup.service        (not enabled)  Type=oneshot  ExecStart=the script
    |
    v
journal of that unit, then inactive (dead) until the next elapse
```

`Persistent=true` writes a timestamp on disk when the calendar timer last ran. If the machine was off across an elapse, the next boot runs the service once to catch up. It does not replay every missed hour; it runs once. Cron has no such stamp, so a missed 03:15 is gone. `Persistent=` does not apply to a purely monotonic timer in the same way, because "missed a boot delay" is not a calendar gap. `RandomizedDelaySec=` holds the elapse for a random time up to the cap so a fleet does not hit one database in the same second. `AccuracySec=` (default one minute) lets systemd coalesce timers to save power; a backup does not care, a once-a-second timer would.

A oneshot that is still running is not started a second time by its timer. The new elapse is delayed or skipped according to the unit, which is the overlap protection cron does not give you unless the script locks itself. `Type=oneshot` is what makes "still running" a defined state systemd can see. A `simple` service that backgrounds and exits would look done immediately, and the timer would be free to start another copy.

### A worked weekday job

A certificate fetch that should run on Monday at 09:10, catch up if the box was off, and spread itself by up to three minutes:

```ini
# /etc/systemd/system/cert-fetch.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/cert-fetch

# /etc/systemd/system/cert-fetch.timer
[Timer]
OnCalendar=Mon *-*-* 09:10:00
Persistent=true
RandomizedDelaySec=3min
[Install]
WantedBy=timers.target
```

`systemctl daemon-reload` then `systemctl enable --now cert-fetch.timer`. `systemctl list-timers` shows NEXT and LAST. `systemctl show -p TimersCalendar --value cert-fetch.timer` contains `09:10:00` and a Monday. `TimersMonotonic` stays empty because nothing used `OnBootSec=`. Run it once with `systemctl start cert-fetch.service` and read `journalctl -u cert-fetch.service`. The script's stdout is the journal, which is the point of leaving cron: there is no mail to nobody and no silent `/dev/null`.

A different schedule, "one minute after boot and then every six hours of uptime", is `OnBootSec=1min` and `OnUnitActiveSec=6h` with no `OnCalendar=`. `systemctl show -p TimersMonotonic` prints those delays as `OnBootUSec` and `OnUnitActiveUSec` (the file keys are `Sec`, the shown properties are `USec`). Adding `OnCalendar=daily` as well would make it a calendar timer too, which is a different product from the one you meant.

### Where it breaks

Enabling the service and not the timer installs a boot start and no schedule. The job runs once at boot and never again. `list-timers` does not show it, which is the clue. The `[Install]` section belongs on the timer.

`OnCalendar=daily` is midnight, not "every 24 hours from when I enabled it". People who wanted "an hour from now, then hourly" wanted `OnUnitActiveSec=` or an explicit clock time. `systemd-analyze calendar daily` shows the next midnight before you enable it.

A clock step changes calendar timers and does not change monotonic ones. NTP stepping the clock backwards can make a calendar timer look overdue; `Persistent=` may then fire. A boot-relative timer keeps counting. If the timezone file is wrong, every `OnCalendar=` shifts and every `OnBootSec=` stays put. That is another reason `show` has two properties.

`RandomizedDelaySec=` on a timer you are testing makes the first run late. A manual `start` of the service does not wait for the delay. If you only wait and watch, you think the timer is broken.

### At work

Cron remains on old images and inside some application containers. New Ubuntu services use timers so the job gets `User=`, `MemoryMax=`, a journal, and a single definition of "run it the way production runs it". The on-call question "did the 02:30 job run?" is `list-timers` plus `journalctl -u the.service --since today`, not a grep through root's mail. Catch-up (`Persistent=true`) is how a laptop-style CI runner and a server that rebooted through the window still take a backup. The same split — a schedule object and a job object — shows up in every cloud scheduler.

| Need | Setting | Shown by |
|---|---|---|
| A wall-clock time | `OnCalendar=` | `TimersCalendar` |
| A delay after boot | `OnBootSec=` | `TimersMonotonic` |
| A delay after the last run | `OnUnitActiveSec=` | `TimersMonotonic` |
| Catch up one missed calendar run | `Persistent=true` | `show -p Persistent` |
| Spread a fleet | `RandomizedDelaySec=` | the NEXT column moving a little |
| Run it once, for real | `systemctl start the.service` | the journal of that unit |

### You can now

- Pair a oneshot service with a timer, enable the timer only, and run the service once by hand.
- Tell a calendar timer from a monotonic one with `TimersCalendar` and `TimersMonotonic`.
- Predict what `Persistent=true` catches up (one missed calendar run) and what it does not (every skipped hour, or a boot delay).

::: shell vm
task: Create `backup.service` (a oneshot that runs `/usr/local/bin/backup.sh`, already present) and `backup.timer` that fires every day at 03:15 and catches up on missed runs. Enable and start the **timer**. Then run the backup once now, by starting the service.
setup:
```bash
mkdir -p /srv/data /var/backups/data
echo important > /srv/data/file.txt
cat > /usr/local/bin/backup.sh <<'EOF'
#!/bin/bash
set -euo pipefail
tar -czf "/var/backups/data/data-$(date +%Y%m%d-%H%M%S).tar.gz" -C /srv data
echo "backup done"
EOF
chmod +x /usr/local/bin/backup.sh
```
verify:
```bash
[ "$(systemctl show -p Type --value backup.service)" = oneshot ] || { echo "backup.service should be Type=oneshot"; exit 1; }
systemctl is-enabled --quiet backup.timer || { echo "backup.timer isn't enabled"; exit 1; }
systemctl is-active --quiet backup.timer || { echo "backup.timer isn't active (started)"; exit 1; }
systemctl show -p TimersCalendar --value backup.timer | grep -q '03:15:00' || { echo "the timer doesn't fire at 03:15"; exit 1; }
[ "$(systemctl show -p Persistent --value backup.timer)" = yes ] || { echo "Persistent=true is missing"; exit 1; }
ls /var/backups/data/data-*.tar.gz >/dev/null 2>&1 || { echo "no backup archive yet: start backup.service once"; exit 1; }
journalctl -u backup.service --no-pager | grep -q 'backup done' || { echo "the backup's output isn't in the journal"; exit 1; }
```
solution:
```bash
cat > /etc/systemd/system/backup.service <<'EOF'
[Unit]
Description=Nightly backup of /srv/data

[Service]
Type=oneshot
ExecStart=/usr/local/bin/backup.sh
EOF
cat > /etc/systemd/system/backup.timer <<'EOF'
[Unit]
Description=Run backup.service every night

[Timer]
OnCalendar=*-*-* 03:15:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now backup.timer
systemctl start backup.service
```
hint: Two unit files, `daemon-reload`, `enable --now` on the timer, then `systemctl start backup.service` for the manual run.
:::

::: quiz
q: Your server was powered off from 02:00 to 06:00. Which job runs its 03:15 schedule when it comes back?
- A cron job `15 3 * * *`
+ A systemd timer with `OnCalendar=*-*-* 03:15:00` and `Persistent=true`
- Both
- Neither; schedules can't catch up
why: `Persistent=true` records the last run on disk and fires once at boot if a run was missed. Cron has no memory of missed runs.
:::

::: quiz
q: You want a cleanup to run one minute after every boot, and also one minute after the cleanup itself last finished, with no wall-clock time. Which timer settings match?
+ `OnBootSec=1min` for the boot delay, or `OnUnitActiveSec=1min` for "a minute after the last run". Neither is an `OnCalendar=` event
- `OnCalendar=*-*-* 00:01:00`, because every calendar event is measured from boot
- `Persistent=true` alone, which turns any timer into a boot timer
- A cron line `@reboot sleep 60`, which systemd timers cannot express
why: `OnBootSec=` and `OnUnitActiveSec=` are monotonic: they count from boot or from the unit's last activation, so they do not care what the clock says. `OnCalendar=` is wall-clock time. `Persistent=` only catches up a missed calendar run; it does not define a boot delay.
:::

::: card
q: `systemctl show -p TimersCalendar --value sweep.timer` is empty, and `TimersMonotonic` contains `OnBootUSec`. What kind of timer is this, and what did you not configure?
answer: It is a monotonic timer. The unit file says `OnBootSec=`, and `systemctl show` reports that same delay as `OnBootUSec`. It elapses relative to boot, not at a clock time. An empty `TimersCalendar` means there is no `OnCalendar=` event.
:::

::: shell vm
task: `/usr/local/bin/sweep.sh` is already installed. Create `sweep.service` as a oneshot that runs it, and `sweep.timer` that elapses **1 minute after boot** (a monotonic timer, not a calendar time). Enable and start the timer. Also start the service once now, so `/var/log/sweep.log` exists and is not empty.
setup:
```bash
cat > /usr/local/bin/sweep.sh <<'EOF'
#!/bin/bash
echo "swept $(date -Is)" >> /var/log/sweep.log
EOF
chmod +x /usr/local/bin/sweep.sh
```
verify:
```bash
# Wrong fix: OnCalendar=daily (or any calendar event). That fills TimersCalendar and leaves TimersMonotonic without OnBootSec.
[ "$(systemctl show -p Type --value sweep.service)" = oneshot ] || { echo "sweep.service should be Type=oneshot"; exit 1; }
systemctl is-enabled --quiet sweep.timer || { echo "sweep.timer is not enabled"; exit 1; }
systemctl is-active --quiet sweep.timer || { echo "sweep.timer is not active"; exit 1; }
systemctl show -p TimersMonotonic --value sweep.timer | grep -Eq 'OnBoot(Sec|USec)=' || { echo "the timer is not monotonic OnBootSec (show prints OnBootUSec)"; systemctl show -p TimersMonotonic -p TimersCalendar sweep.timer; exit 1; }
[ -z "$(systemctl show -p TimersCalendar --value sweep.timer)" ] || { echo "a calendar event is set; this timer should only be OnBootSec"; exit 1; }
[ -s /var/log/sweep.log ] || { echo "/var/log/sweep.log is missing or empty: start sweep.service once"; exit 1; }
```
solution:
```bash
cat > /etc/systemd/system/sweep.service <<'EOF'
[Unit]
Description=Sweep temporary records

[Service]
Type=oneshot
ExecStart=/usr/local/bin/sweep.sh
EOF
cat > /etc/systemd/system/sweep.timer <<'EOF'
[Unit]
Description=Sweep one minute after boot

[Timer]
OnBootSec=1min

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now sweep.timer
systemctl start sweep.service
```
hint: Two units. The timer's `[Timer]` section uses `OnBootSec=1min` and no `OnCalendar=`. Enable the timer, then `systemctl start sweep.service` for the run that writes the log.
:::

## The journal on a real server
id: journal-real
stage: run
needs: units
minutes: 30
goal: Find the one log line that matters: by unit, priority, time and boot, and write logs at the right priority.
source: journalctl(1) | https://www.freedesktop.org/software/systemd/man/latest/journalctl.html
source: sd-daemon(3): log level prefixes | https://www.freedesktop.org/software/systemd/man/latest/sd-daemon.html

Everything a service prints to stdout or stderr goes to the **journal**, tagged with the unit, PID, time and a **priority**. `journalctl` queries it:

| Filter | Example |
|---|---|
| one unit | `journalctl -u payments` |
| priority and worse | `-p err` (emerg, alert, crit, err), `-p warning` |
| time window | `--since '10 min ago'`, `--since 03:00 --until 03:30` |
| this boot, previous boot | `-b`, `-b -1` (needs persistent storage) |
| follow live | `-f` |
| newest first, or jump to end | `-r`, `-e` |
| machine-readable | `-o json`, `-o cat` (message only) |

Combine them: `journalctl -u payments -p err --since today -o cat` prints only the error messages of one service today, nothing else.

### Priorities come from the program

journald can only filter by priority if the program sets one. A program that writes to the journal API sets it directly. A plain program printing to stdout gets `info` for every line, so `-p err` finds nothing, even for its errors. There is a simple convention: a line that **starts with `<3>`** is logged at priority 3 (err), `<4>` warning, `<6>` info; journald strips the prefix (it's on by default, `SyslogLevelPrefix=yes`). Shell scripts running as services can use it: `echo "<3>payment gateway rejected the request" >&2`.

That's also why "grep the log for ERROR" persists: many apps put the level in the text. Structured logging (one JSON object per line, with a `level` field) is the modern answer; the journal and every log platform can index it.

### Where the journal lives

On Ubuntu servers the journal is persistent, in `/var/log/journal/`. `journalctl --disk-usage` shows its size, and `SystemMaxUse=` in `/etc/systemd/journald.conf` caps it. If `/var/log/journal` doesn't exist, logs live in `/run` and vanish at reboot, and then `-b -1` has nothing to show after a crash.

### A line is a record, not a string

journald stores records. Each record has a timestamp, the unit, the pid, a boot id, and a priority from 0 (emerg) through 7 (debug). `journalctl` is a query over those fields. `-u payments` selects the unit, `-p err` selects priority err and worse (0 through 3), `--since` selects time, `-b` selects the current boot id, `-b -1` selects the previous one. `-o cat` prints only the message field so a later `grep` is not confused by the metadata. These filters combine. A line that says ERROR in the message and has priority info does not pass `-p err`, because the word is not the field.

A process that writes to stdout or stderr gets a record per line, priority info, unless the line begins with a syslog priority prefix and `SyslogLevelPrefix=yes` (the default). The prefix is `<3>` for err, `<4>` for warning, `<6>` for info, matching the numeric priorities. journald strips it before storing the message, so `journalctl -o cat` shows `disk quota hit` and not `<3>disk quota hit`. The priority field is err, which is what `-p err` matches. A program that uses the journal API sets the priority directly and does not need the prefix. A shell script has no API, so the prefix is the whole mechanism.

```text
echo "<3>disk quota hit" >&2
        |
        v
journald sees SyslogLevelPrefix, stores:
    MESSAGE=disk quota hit
    PRIORITY=3
    UNIT=ingest.service
    _BOOT_ID=...
        |
        v
journalctl -u ingest -p err -o cat   ->  disk quota hit
journalctl -u ingest -p err           ->  nothing, if the prefix was missing
```

Where the bytes live is a second decision. If `/var/log/journal` exists, journald writes a persistent journal there and `-b -1` works after a reboot. If it does not, the journal stays under `/run/log/journal`, which is tmpfs, and shutdown throws it away. `journalctl --disk-usage` and `SystemMaxUse=` in `/etc/systemd/journald.conf` cap the persistent size. A full disk is often this directory. Vacuuming (`journalctl --vacuum-size=200M`) frees it without guessing which files to delete.

### A worked filter for a different service

A mailer unit logged a warning and an error overnight. You want only the error text, from this boot:

```bash
journalctl -u mailer -p err -b -o cat --no-pager
```

`-b` drops yesterday if the question is "since this process started after the reboot". `--no-pager` matters in a script, because a pager waits for a keypress and a provision run looks hung. If the error was a shell line, the script that produced it looked like `echo '<3>smtp refused 550 for msg-18c2' >&2`. The stored message contains `msg-18c2` and does not contain `<3>`. Grepping the unfiltered journal for the word ERROR also matches a later info line that says `ERROR was a false alarm for msg-0000`. The priority filter is what separates them.

To keep that query useful after the next reboot, the directory has to exist before journald starts:

```bash
install -d -m 2755 /var/log/journal
systemctl restart systemd-journald
```

Restarting journald does not delete the volatile journal immediately, but new records go to disk. A crash after that is visible with `-b -1`. A crash before it is not, which is why the directory belongs in the image, not in an incident script.

### Where it breaks

Plain `echo "ERROR: disk full" >&2` is priority info. `-p err` is empty and the line is sitting in `-p info`. The program did its part of "log an error" in the only way a human reader sees. The journal cannot see it. The prefix, or a logging library that talks to the journal, is the missing piece.

`-b -1` on a machine with no `/var/log/journal` prints nothing and looks like the service never logged. The current boot still has the lines. `journalctl --disk-usage` reporting a tiny volatile journal, plus a missing directory, is the diagnosis. Creating the directory after the crash does not bring the old boot back.

`SystemMaxUse=` left at the default on a small disk lets the journal grow until other services cannot write their own files. Rate limits (`RateLimitIntervalSec=`, `RateLimitBurst=`) then drop lines from a crash loop, so the one message you needed is the one journald discarded. A start limit on the unit is the better brake. Raising the rate limit without a start limit just fills the disk faster.

### At work

The journal is the first store, not the only store. A host's `journalctl` answers "what did this unit do in the last hour?". A fleet ships those records to a log service, often by forwarding journald or by having the application write JSON lines that include a level field. Either way the query is the same shape: unit (or service name), severity, time window. People who grep a file for ERROR are working around a logger that never set a severity. Fixing the prefix, or the JSON level, is what makes the on-call query possible. Disk pressure from `/var/log/journal` is a capacity incident with a single knob, `SystemMaxUse=`, which is kinder than deleting files by hand while journald still has them open.

| You want | Filter | If it is empty |
|---|---|---|
| This service's errors | `-u NAME -p err` | the lines may be info; check for a missing `<3>` |
| Only the text | `-o cat` | metadata was hiding the id you grep for |
| Previous boot | `-b -1` | `/var/log/journal` was missing, so there is no previous boot |
| Live tail | `-f` | you are watching info and the error already happened |
| Disk back | `--vacuum-size=` | also set `SystemMaxUse=` or it grows back |

### You can now

- Query by unit, priority, boot and time, and print the message alone.
- Put `<3>` on a shell line and know journald stores the priority and strips the prefix.
- Tell a missing persistent directory from a service that truly logged nothing.

::: shell vm
task: `payments.service` failed. In its log, among many ordinary lines, exactly one message was logged at **error** priority, and it contains a request id like `req-...`. Write just that request id to `/root/answer`.
setup:
```bash
cat > /usr/local/bin/payments.sh <<'EOF'
#!/bin/bash
for i in $(seq 1 40); do echo "processed payment req-ok$i$RANDOM"; done
echo "<4>slow response from gateway for req-warn$RANDOM"
echo "<3>gateway rejected req-7f3k9q2 with status 502" >&2
for i in $(seq 1 10); do echo "retry queue length $i"; done
echo "ERROR is just text here, req-fake01 was fine"
exit 1
EOF
chmod +x /usr/local/bin/payments.sh
printf '[Service]\nExecStart=/usr/local/bin/payments.sh\n' > /etc/systemd/system/payments.service
systemctl daemon-reload
systemctl start payments || true
sleep 1
```
verify:
```bash
[ "$(tr -d ' \n' < /root/answer 2>/dev/null)" = req-7f3k9q2 ] || { echo "that's not the request id from the error-priority message"; exit 1; }
```
solution:
```bash
journalctl -u payments -p err -o cat --no-pager | grep -o 'req-[a-z0-9]*' > /root/answer
```
hint: Filter by unit and priority, print only the message (`-o cat`), then pull out the `req-…` part. Grepping for the word ERROR finds the wrong line.
:::

::: quiz
q: A shell script running as a service prints `ERROR: disk full` to stderr, but `journalctl -u job -p err` shows nothing. Why?
- stderr isn't captured by the journal
+ Plain output gets priority info; only a `<3>` prefix (or the journal API) marks it as err
- `-p err` only works for kernel messages
- The journal drops lines containing ERROR
why: journald assigns a priority per line. Without a level prefix like `<3>`, every line is info, whatever its text says.
:::

::: quiz
q: `journalctl -u worker -b -1` prints nothing, even though the service logged for weeks and the machine was rebooted this morning. `/var/log/journal` does not exist. Why?
+ The journal is stored under `/run`, which is tmpfs, so the previous boot's entries disappeared when the machine shut down
- `-b -1` only shows kernel messages
- The service used stderr, which the journal never stores
- Priority `info` is deleted at reboot
why: Without `/var/log/journal`, journald keeps the journal in `/run/log/journal`. `/run` is emptied at shutdown, so there is no previous boot to select. Creating the directory (and restarting journald) is what makes the journal persistent. stderr is captured; the storage location is the part that failed.
:::

::: card
q: In a systemd service, how do you mark one shell line as priority err so `journalctl -u NAME -p err` shows it, and what does journald do with the marker?
answer: Start the line with `<3>` (for example `echo '<3>disk quota hit' >&2`). With `SyslogLevelPrefix=yes`, which is the default, journald reads that prefix as the priority and stores the rest of the line without the prefix. A line that only contains the word ERROR stays priority info.
:::

::: shell vm
task: `/usr/local/bin/ingest.sh` runs as `ingest.service` and prints `disk quota hit on volume vol-9c` to stderr, but `journalctl -u ingest -p err` does not show it. Change the script so that message is logged at error priority. Start the service once. Leave `ExecStart` pointed at `/usr/local/bin/ingest.sh`.
setup:
```bash
cat > /usr/local/bin/ingest.sh <<'EOF'
#!/bin/bash
echo "ingest started"
echo "disk quota hit on volume vol-9c" >&2
echo "ERROR is only text, vol-other was fine"
exit 0
EOF
chmod 755 /usr/local/bin/ingest.sh
printf '[Service]\nType=oneshot\nExecStart=/usr/local/bin/ingest.sh\n' > /etc/systemd/system/ingest.service
systemctl daemon-reload
systemctl start ingest || true
```
verify:
```bash
# Wrong fix: rewriting the line to start with the word ERROR, or grepping the journal without -p err. The text is not a priority, so -p err still misses vol-9c.
grep -q '/usr/local/bin/ingest.sh' /etc/systemd/system/ingest.service || { echo "ExecStart must stay /usr/local/bin/ingest.sh"; exit 1; }
grep -q '<3>' /usr/local/bin/ingest.sh || { echo "the script never writes a <3> priority prefix"; exit 1; }
systemctl start ingest
journalctl -u ingest -p err -o cat --no-pager | grep -q 'vol-9c' || { echo "journalctl -u ingest -p err does not contain vol-9c"; journalctl -u ingest -o cat --no-pager | tail -n 20; exit 1; }
```
solution:
```bash
cat > /usr/local/bin/ingest.sh <<'EOF'
#!/bin/bash
echo "ingest started"
echo "<3>disk quota hit on volume vol-9c" >&2
echo "ERROR is only text, vol-other was fine"
exit 0
EOF
chmod 755 /usr/local/bin/ingest.sh
systemctl start ingest
```
hint: A leading `<3>` is the priority, not the word ERROR. Start the service again and filter with `-p err`.
:::

## Users, sudo and SSH hardening
id: access
stage: run
needs: units, linux/users, linux/ssh
minutes: 40
goal: Create a deploy user with exactly the privileges it needs, and harden the SSH server the standard way.
source: sudoers(5) | https://www.sudo.ws/docs/man/sudoers.man/
source: sshd_config(5) | https://man.openbsd.org/sshd_config
source: Ubuntu Server: OpenSSH server | https://documentation.ubuntu.com/server/how-to/security/openssh-server/

### Least privilege with sudo

The tempting way to let a deploy user restart nginx is `usermod -aG sudo deploy`: it works, and it gives the account full root. If its key leaks, the attacker owns the server. sudo can grant **one command**:

```text
# /etc/sudoers.d/deploy   (mode 0440)
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart nginx, /usr/bin/systemctl reload nginx
```

Read it as: user `deploy`, on any host, may run as `root`, without a password, exactly these commands with exactly these arguments. Rules:

- Put rules in **`/etc/sudoers.d/`**, never edit `/etc/sudoers` blindly. A syntax error in sudoers can lock **everyone** out of sudo.
- **Validate** before relying on it: `visudo -cf /etc/sudoers.d/deploy` checks one file, `visudo -c` checks everything.
- Use **absolute paths** for commands. And avoid granting commands that can spawn a shell or edit arbitrary files (`vim`, `less`, `bash`, `tee` anything): each of those is root in disguise.
- `sudo -l -U deploy` shows what a user may run: the check you do after every change.

### SSH hardening, the standard set

The usual baseline for an internet-facing server:

| Setting | Why |
|---|---|
| `PasswordAuthentication no` | only keys; password guessing becomes pointless |
| `KbdInteractiveAuthentication no` | closes the other password-prompt path |
| `PermitRootLogin no` | log in as yourself, then sudo; root logins aren't attributable |
| `AllowUsers deploy alice` (optional) | only listed accounts may log in at all |

Ubuntu's `/etc/ssh/sshd_config` includes `/etc/ssh/sshd_config.d/*.conf` **at the top**, and for most settings sshd uses the **first** value it sees, so a drop-in there wins over the main file. Put your settings in `/etc/ssh/sshd_config.d/50-hardening.conf`; package upgrades leave it alone.

Before reloading: `sshd -t` checks syntax, and `sshd -T` prints the **effective** configuration after all includes, the proof your setting won. Then reload, and **keep your current session open** while you test a new login from a second terminal. A bad SSH config on a remote server with only SSH access is how people lock themselves out.

### What sudo and sshd actually evaluate

sudo reads `/etc/sudoers` and then every file in `/etc/sudoers.d/` whose name does not contain a dot or a tilde and whose mode is not writable by group or others. A file mode `0666` is skipped. A file named `deploy.conf.save` is skipped because of the dot. The usual file is `/etc/sudoers.d/deploy` at mode `0440`. `visudo -cf` that path parses it without installing a broken rule over the live one. A syntax error in the main sudoers file can lock out every sudo user, which on a server with no root password means a console recovery. Drop-in files exist so one bad edit does not require touching the distribution's file.

A rule is a match against the command argv, not against "the kind of thing". `deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart nginx` allows that binary with those arguments, as root, with no password, on any host (`ALL`). sudo compares the arguments it was given, so `restart nginx` and `restart nginx.service` are different argv and you should list the form you will actually run. The rule does not allow `systemctl stop nginx`. A shell operator such as `&&` is parsed by the shell before sudo runs, so it is not a way to sneak a second command past a tight rule; the safe habit is still one explicit command per grant. Granting `/usr/bin/vim`, `/usr/bin/less`, `/usr/bin/bash` or `/usr/bin/tee` is root, because each of those can run a shell or write an arbitrary file. `sudo -l -U deploy` prints the expanded list. If it says `(ALL) NOPASSWD: ALL`, the account is root.

```text
sshd reads, first match wins for most keywords:
  /etc/ssh/sshd_config
      Include /etc/ssh/sshd_config.d/*.conf     <- at the top on Ubuntu
      then the rest of the main file
  so a drop-in that says "yes" beats a later "no" in the main file
sshd -t     parse only
sshd -T     print the effective values, lower case
```

Ubuntu's packaged `sshd_config` includes `/etc/ssh/sshd_config.d/*.conf` near the top. sshd's rule for `PasswordAuthentication`, `KbdInteractiveAuthentication` and `PermitRootLogin` is first value wins. A drop-in that sets `yes` overrides a `no` further down in the main file. The reverse is also true: your `no` in a drop-in wins over the packaged `yes`. `sshd -T` prints the merged result in lower case (`passwordauthentication no`). That output is the truth, not the file you remember editing. `sshd -t` only checks that the files parse.

On a remote machine you reload sshd only after `-t` succeeds, and you keep the existing session open while a second session proves login. A bad config plus a closed terminal is a console ticket. Password authentication and keyboard-interactive are two ways to ask for a password; turning off only one of them leaves the other. `PermitRootLogin no` does not disable sudo. It stops a direct root SSH login, so the audit log shows which human logged in before they used sudo.

### A worked pair for a different account

A CI user that may only reload a metrics agent, plus an SSH drop-in that does not mention the word deploy:

```text
# /etc/sudoers.d/ci    mode 0440
ci ALL=(root) NOPASSWD: /usr/bin/systemctl reload metrics-agent
```

```text
# /etc/ssh/sshd_config.d/10-keys-only.conf
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
```

`visudo -cf /etc/sudoers.d/ci` then `sudo -l -U ci`. The SSH check is `sshd -t` and `sshd -T | grep passwordauthentication`. Some minimal images have no `/run/sshd` yet, and `sshd -T` wants that directory as its runtime path; creating it is not a configuration change, it is the privilege-separation directory the daemon expects. The drop-in filename sorts with the other files in the directory. First value wins across the whole included set, so a second drop-in that also sets `PasswordAuthentication` can surprise you. `sshd -T` ends the argument.

### Where it breaks

A rule that names the command without the arguments you think, or with a glob, widens quietly. `NOPASSWD: /usr/bin/systemctl` allows every systemctl subcommand, including `edit` and `start` of a unit whose `ExecStart` is a shell. The least privilege version lists the subcommand and the unit.

`usermod -aG sudo deploy` ignores every careful rule. Group `sudo` on Ubuntu matches `%sudo ALL=(ALL:ALL) ALL` in the packaged sudoers. `sudo -l` then shows full access. Removing the drop-in does not remove the group.

An SSH setting in the main file that "does not apply" is almost always a drop-in earlier in the include that already set it. People edit the line they can see and never run `sshd -T`. Keyboard-interactive left on is the other half of that mistake: password guessing still works through the other prompt.

### At work

Humans log in as themselves with keys. Automation has its own account and a sudoers rule for the one restart it needs. Root SSH is off so a stolen key has a name attached. This is the same least-privilege idea as an IAM policy that can restart one service and not administer the account: the blast radius is the command you wrote down. Fleet images drop a file into `sshd_config.d` and a file into `sudoers.d` rather than sed-ing the packaged originals, because the next package update replaces the originals and leaves the drop-ins.

| Check | Command | Bad sign |
|---|---|---|
| What may this user run? | `sudo -l -U NAME` | `(ALL) ALL` or a shell in the list |
| Does the rule parse? | `visudo -cf /etc/sudoers.d/NAME` | a syntax error, or a file mode other than 0440 |
| What will sshd do? | `sshd -T` | `passwordauthentication yes` after you thought you set no |
| Does the file parse? | `sshd -t` | any output on stderr |
| Are you locked out? | a second login, old session kept | you closed the only session first |

### You can now

- Grant one absolute command with `NOPASSWD`, mode `0440`, and prove it with `sudo -l` and `visudo`.
- Explain why vim, less and a broad `systemctl` are root.
- Put SSH restrictions in a drop-in and confirm the first-match result with `sshd -T`, including both password mechanisms and root login.

::: shell vm
task: Create a user `deploy` (home directory, bash shell) and allow it to run **only** `systemctl restart nginx` and `systemctl reload nginx` as root, without a password, through a file in `/etc/sudoers.d/`. Don't add it to the `sudo` group. The sudoers configuration must validate.
verify:
```bash
id deploy >/dev/null 2>&1 || { echo "there's no user deploy"; exit 1; }
[ "$(getent passwd deploy | cut -d: -f7)" = /bin/bash ] || { echo "deploy's shell should be /bin/bash"; exit 1; }
[ -d /home/deploy ] || { echo "deploy has no home directory"; exit 1; }
! id -nG deploy | tr ' ' '\n' | grep -qx -E 'sudo|admin' || { echo "deploy is in the sudo group: that's full root"; exit 1; }
visudo -c >/dev/null 2>&1 || { echo "sudoers doesn't validate (visudo -c)"; exit 1; }
l=$(sudo -l -U deploy)
echo "$l" | grep -q 'NOPASSWD: /usr/bin/systemctl restart nginx' || { echo "deploy can't restart nginx without a password"; echo "$l"; exit 1; }
echo "$l" | grep -q '/usr/bin/systemctl reload nginx' || { echo "deploy can't reload nginx"; exit 1; }
! echo "$l" | grep -qE '\(ALL( : ALL)?\) (NOPASSWD: )?ALL' || { echo "deploy can run everything as root"; exit 1; }
```
solution:
```bash
useradd --create-home --shell /bin/bash deploy
cat > /etc/sudoers.d/deploy <<'EOF'
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart nginx, /usr/bin/systemctl reload nginx
EOF
chmod 0440 /etc/sudoers.d/deploy
visudo -cf /etc/sudoers.d/deploy
```
hint: `useradd --create-home --shell /bin/bash deploy`. The sudoers line names the user, `ALL=(root)`, `NOPASSWD:`, then the absolute command paths separated by commas. Check with `visudo -c` and `sudo -l -U deploy`.
:::

::: shell vm
task: Harden the SSH server with a drop-in file in `/etc/ssh/sshd_config.d/`: no password authentication, no keyboard-interactive authentication, no root login. Prove the effective configuration with `sshd -T`.
verify:
```bash
mkdir -p /run/sshd
ls /etc/ssh/sshd_config.d/*.conf >/dev/null 2>&1 || { echo "no drop-in in /etc/ssh/sshd_config.d/"; exit 1; }
sshd -t || { echo "sshd -t reports a configuration error"; exit 1; }
t=$(sshd -T 2>/dev/null)
echo "$t" | grep -qx 'passwordauthentication no' || { echo "effective PasswordAuthentication isn't no"; exit 1; }
echo "$t" | grep -qx 'kbdinteractiveauthentication no' || { echo "effective KbdInteractiveAuthentication isn't no"; exit 1; }
echo "$t" | grep -qx 'permitrootlogin no' || { echo "effective PermitRootLogin isn't no"; exit 1; }
```
solution:
```bash
cat > /etc/ssh/sshd_config.d/50-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
mkdir -p /run/sshd
sshd -t && sshd -T | grep -E '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin) '
```
hint: One `.conf` file with three lines. `sshd -T` prints settings in lower case; it may need `/run/sshd` to exist.
:::

::: quiz
q: A teammate wants the CI user to restart the app, and proposes `ci ALL=(ALL) NOPASSWD: /usr/bin/vim /etc/app.conf, /usr/bin/systemctl restart app`. What's wrong?
- Nothing, both commands are needed
+ vim as root can open a shell (`:!bash`) or edit any file, so this grants full root
- NOPASSWD isn't allowed for systemctl
- sudoers rules can't list two commands
why: Any granted program that can run commands or write arbitrary files is root in disguise. Grant the restart; deploy config through your pipeline instead.
:::

::: quiz
q: You put `PasswordAuthentication no` in `/etc/ssh/sshd_config`, and the same setting `yes` in `/etc/ssh/sshd_config.d/00-local.conf`. Ubuntu's main file includes the `sshd_config.d` directory at the top. After a reload, what is the effective value, and why?
- `no`, because the main file is always read last and overrides drop-ins
+ `yes`, because sshd uses the first value it sees and the drop-in is included before the main file
- `no`, because a higher number in the filename always wins
- sshd refuses to start when the two files disagree
why: The include sits at the top of `sshd_config`, so drop-in lines are read first. For `PasswordAuthentication`, the first value wins and later copies are ignored. `sshd -T` prints the effective value in lower case; that is the check, not which file you edited last.
:::

::: card
q: A sudoers drop-in grants `NOPASSWD: /usr/bin/less /var/log/app.log`. Why is that full root, and what mode must the drop-in file have?
answer: `less` can spawn a shell (`!bash` or `v`) and can read any file once it is running as root, so the rule is not limited to one log. The file in `/etc/sudoers.d/` must be mode `0440`, and `visudo -cf` that file must succeed before you rely on it.
:::

## Firewalls with nftables
id: firewall
stage: serve
needs: access, linux/net-tools
minutes: 40
goal: Write a default-deny firewall that keeps SSH and the web open, load it safely, and make it survive reboot.
source: nftables wiki: Quick reference | https://wiki.nftables.org/wiki-nftables/index.php/Quick_reference-nftables_in_10_minutes
source: Ubuntu Server: Firewall (ufw) | https://documentation.ubuntu.com/server/how-to/security/firewalls/

A host firewall decides which packets the kernel accepts. Linux's current framework is **nftables** (the old `iptables` commands still exist, usually translated onto nftables underneath). Ubuntu's **ufw** is a friendly front end that writes the rules for you; knowing raw nftables lets you read and debug whatever a front end produced.

### Default deny, then allow what you serve

```text
# /etc/nftables.conf
#!/usr/sbin/nft -f
flush ruleset

table inet filter {
  chain input {
    type filter hook input priority 0; policy drop;
    ct state established,related accept
    iif "lo" accept
    ct state invalid drop
    ip protocol icmp accept
    ip6 nexthdr icmpv6 accept
    tcp dport { 22, 80, 443 } accept
  }
  chain forward {
    type filter hook forward priority 0; policy drop;
  }
  chain output {
    type filter hook output priority 0; policy accept;
  }
}
```

Read it top to bottom, first match wins:

- `table inet filter`: `inet` covers IPv4 **and** IPv6 in one table. Forget IPv6 and your carefully closed ports may be open on v6.
- `hook input ... policy drop`: anything addressed to this machine that no rule accepts is dropped.
- `ct state established,related accept`: replies to connections this machine opened (apt, DNS, outgoing HTTPS). Without this line, a default-drop input chain breaks almost everything. This is the "stateful" part, the same idea as AWS security groups.
- `iif "lo" accept`: local programs talking to each other over 127.0.0.1.
- ICMP: ping and, more importantly, "packet too big" messages that path MTU discovery needs.
- Then the services you actually offer.

### Loading without locking yourself out

- `nft -c -f /etc/nftables.conf` checks the file without applying it.
- `nft -f /etc/nftables.conf` applies it atomically: the whole ruleset at once, or nothing.
- `systemctl enable nftables` loads `/etc/nftables.conf` at every boot.
- `nft list ruleset` shows what's active now, the source of truth.

On a remote server, open SSH **before** setting a drop policy, and have a way back (a cloud console, or a timed job that flushes the rules unless you cancel it). The established/related rule is what keeps your current SSH session alive while you apply the rules.

### ufw in one minute

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80,443/tcp
ufw enable
ufw status verbose
```

Same idea, fewer words. Use one tool per machine: ufw and hand-written nftables rules both writing rules is how you get "but I allowed that port".

### In the cloud

Security groups filter **before** packets reach the instance; the host firewall filters on the instance. Defense in depth means both, and the host firewall is what still protects the machine if someone opens a security group too wide.

### First match, then the policy

An nftables chain is a list the kernel walks from top to bottom. The first rule that accepts, drops or rejects the packet ends the walk. If nothing matches, the chain policy applies. `policy drop` on the input hook means "this host ignores packets it did not explicitly accept". `policy accept` means the rules are a denylist, and any port you forgot is open. A host firewall that is meant to keep the machine small uses drop as the policy and a short accept list.

The `inet` family attaches one chain to both IPv4 and IPv6. A `table ip` does not see IPv6, so a port you closed for IPv4 stays open on v6, which is a common surprise on a dual-stack cloud image. The input hook sees packets addressed to this machine. The forward hook sees packets this machine would route; a host that is not a router drops forward. The output hook sees packets this machine sends. Leaving output at `policy accept` is normal: you are not trying to stop the server from starting connections, you are trying to stop the world from starting connections to it.

```text
packet to this host
    |
    v
input chain, first match wins
    established,related  -> accept   (replies to our own clients: apt, DNS, HTTPS)
    iif lo               -> accept   (local services talking to each other)
    icmp / icmpv6        -> accept   (ping, and path MTU "packet too big")
    tcp dport {22,80,443}-> accept
    anything else        -> policy drop
```

`ct state established,related` is the stateful part. A connection this host opened (an apt mirror, a DNS lookup) comes back to an ephemeral port. Without that rule, a drop policy throws the replies away and apt times out even though you "only closed inbound". `related` covers extra flows that belong to an existing one, such as some ICMP errors. `iif "lo"` is not a substitute: loopback is local delivery, not the return path of a remote connection.

ICMP is not optional decoration. Path MTU discovery sends "fragmentation needed" or, on IPv6, "packet too big". Drop those and large transfers stall while small ones work, which is a miserable bug to diagnose. `ip protocol icmp accept` covers IPv4 ICMP. `ip6 nexthdr icmpv6 accept` covers IPv6. Ping is the visible part; PMTU is the part that breaks production.

`nft -c -f /etc/nftables.conf` parses the file and does not install it. `nft -f` installs the whole ruleset atomically. `systemctl enable nftables` loads that file at boot. `nft list ruleset` is what the kernel holds now, which can differ from the file if someone loaded a different one later. ufw writes nftables rules too. Running ufw and a hand-written `nftables.conf` on the same host means whichever load happens last wins, and "I allowed it in ufw" can be a lie. One tool per machine.

### A worked ruleset for a database host

This is a different shape from a web server's 22/80/443 list. SSH from anywhere, Postgres only from one application address, still stateful, still inet:

```text
table inet filter {
  chain input {
    type filter hook input priority 0; policy drop;
    ct state established,related accept
    iif "lo" accept
    ip protocol icmp accept
    ip6 nexthdr icmpv6 accept
    tcp dport 22 accept
    ip saddr 10.4.0.20 tcp dport 5432 accept
  }
  chain forward { type filter hook forward priority 0; policy drop; }
  chain output { type filter hook output priority 0; policy accept; }
}
```

The address match is on the packet before the port match, in the same rule, so 5432 from any other address falls through to drop. Loopback is accepted first so a local admin socket still works. Check with `nft -c -f`, load with `nft -f`, enable the unit. In a cloud VPC the security group is a second filter in front of this one. Opening a port only in nftables does nothing if the security group drops it, and opening it only in the security group is one console click away from exposing a port the host would have dropped. Both, on purpose, is defense in depth. One, by accident, is how the port is open.

### Where it breaks

Drop policy without `established,related` breaks the host's own clients. The symptom is timeouts, not "connection refused", because the replies are discarded rather than rejected. Adding inbound port 80 does not fix apt. The established rule does.

Forgetting `inet` and writing `ip` leaves IPv6 open. `nft list ruleset` shows `table ip` and no `table ip6`, which is the tell. Clients on v6 reach a port you thought was closed.

Loading rules before you have allowed SSH, on a remote host, drops the session that is your only login. The established rule keeps an existing SSH session only if it is loaded as part of the same ruleset. A syntax error avoided by `nft -c` is much cheaper than a recovery console. A timed job that flushes the ruleset unless you cancel it is the belt and braces when you are learning on a real remote VM.

### At work

Security groups, network ACLs and a host firewall answer the same question at different layers. The host firewall is the one that still exists when a security group is opened too wide, and the one you can read with `nft list ruleset` during an incident without opening a cloud console. Teams pick ufw when the rules are "these ports" and raw nftables when they need address matches, sets, or to understand what ufw generated. Mixing them is the outage. The established/related rule is also the mental model behind "stateful security group": return traffic is allowed because it belongs to a flow you started, not because an inbound port is open.

| Choice | Use it when | Cost of the other one |
|---|---|---|
| `policy drop` plus accepts | a host with a known port list | `accept` policy leaves forgotten ports open |
| `table inet` | the host has IPv6, which it does | `table ip` leaves v6 unfiltered |
| `established,related` | the host is also a client (always) | apt, DNS and outbound HTTPS time out |
| ufw | a short port list and a team that will not edit nft | a second writer clobbering the ruleset |
| raw nftables | address matches, sets, reading the real rules | more syntax to get wrong; use `nft -c` |

### You can now

- Read an input chain from the top: stateful replies, loopback, ICMP, then the ports, then drop.
- Explain why apt breaks when the established rule is missing, and why ICMP is more than ping.
- Check, load and enable one tool's ruleset, and confirm it with `nft list ruleset`.

::: shell vm
task: Write `/etc/nftables.conf` with an `inet` table whose **input** policy is drop, that accepts established and related traffic, loopback, ICMP (v4 and v6), and new TCP connections only to ports 22, 80 and 443. Forward should drop, output should accept. Load it, and enable the nftables service so it loads at boot.
verify:
```bash
nft -c -f /etc/nftables.conf || { echo "/etc/nftables.conf doesn't check (nft -c -f)"; exit 1; }
r=$(nft list ruleset)
echo "$r" | grep -q 'table inet' || { echo "no inet table is loaded (IPv4 and IPv6 together)"; exit 1; }
echo "$r" | grep -A2 'hook input' | grep -q 'policy drop' || { echo "the input chain's policy isn't drop"; exit 1; }
echo "$r" | grep -q 'ct state established,related accept' || { echo "no rule accepts established,related traffic"; exit 1; }
echo "$r" | grep -q 'iif "lo" accept' || { echo "loopback isn't accepted"; exit 1; }
echo "$r" | grep -Eq 'tcp dport \{ 22, 80, 443 \} accept' || { echo "TCP 22, 80 and 443 aren't accepted (as one set)"; exit 1; }
! echo "$r" | grep -Eq 'tcp dport (8080|3306|5432)' || { echo "another port is open"; exit 1; }
echo "$r" | grep -A2 'hook forward' | grep -q 'policy drop' || { echo "forward should drop"; exit 1; }
systemctl is-enabled --quiet nftables || { echo "the nftables service isn't enabled at boot"; exit 1; }
```
solution:
```bash
cat > /etc/nftables.conf <<'EOF'
#!/usr/sbin/nft -f
flush ruleset

table inet filter {
  chain input {
    type filter hook input priority 0; policy drop;
    ct state established,related accept
    iif "lo" accept
    ct state invalid drop
    ip protocol icmp accept
    ip6 nexthdr icmpv6 accept
    tcp dport { 22, 80, 443 } accept
  }
  chain forward {
    type filter hook forward priority 0; policy drop;
  }
  chain output {
    type filter hook output priority 0; policy accept;
  }
}
EOF
nft -c -f /etc/nftables.conf && nft -f /etc/nftables.conf
systemctl enable nftables
nft list ruleset
```
hint: Start from the lesson's example. Check with `nft -c -f`, apply with `nft -f`, then `systemctl enable nftables`.
:::

::: quiz
q: You set the input policy to drop and allow only port 22. Suddenly `apt-get update` times out on the server. Which rule is missing?
- Allow port 80 inbound
+ `ct state established,related accept`, so replies to the server's own outgoing connections get back in
- Allow DNS on port 53 inbound
- An output chain
why: The replies from the mirror arrive as inbound packets on ephemeral ports. The established/related rule accepts replies to connections the machine started, without opening any port to new connections.
:::

::: card
q: Why `table inet` rather than `table ip` for a host firewall?
answer: `inet` covers IPv4 and IPv6 with the same rules. With `table ip`, IPv6 traffic isn't filtered by those rules, so a closed port may still be reachable over IPv6.
:::

::: quiz
q: A host firewall's input chain uses `policy drop` and accepts TCP 22, 80 and 443. Ping to the host works, but path MTU discovery breaks for some clients and large HTTPS responses stall. Which accept rule is missing?
- `tcp dport 22 accept` written a second time
+ ICMP, including the IPv6 "packet too big" messages (`ip protocol icmp` and `ip6 nexthdr icmpv6`)
- `iif "lo" accept`, because clients arrive on loopback
- An output policy of drop
why: Path MTU discovery depends on ICMP "fragmentation needed" / "packet too big". A drop policy throws those away, so a session that worked for small packets stalls on large ones. Loopback is for local services talking to themselves, not for remote clients. Opening port 22 again does not pass ICMP.
:::

::: card
q: On one Ubuntu server, both `ufw` and a hand-written `/etc/nftables.conf` are enabled. A port you opened in ufw is still closed. Why does that happen, and what do you pick instead?
answer: Both tools write nftables rules, so the ruleset that was loaded last (or at boot) can replace the other. Use one of them on a given machine. `nft list ruleset` shows what the kernel is enforcing right now, which is the check when the two disagree.
:::

## nginx as a reverse proxy with TLS
id: nginx-tls
stage: serve
needs: firewall, units
minutes: 45
goal: Put nginx in front of an app: terminate TLS, proxy to the app on localhost, redirect HTTP to HTTPS, and check the config before reloading.
source: nginx: Beginner's guide | https://nginx.org/en/docs/beginners_guide.html
source: nginx: ngx_http_proxy_module | https://nginx.org/en/docs/http/ngx_http_proxy_module.html
source: Mozilla SSL configuration generator | https://ssl-config.mozilla.org/

Almost every web app on a server runs behind a **reverse proxy**: the app listens only on `127.0.0.1:8080`, and nginx listens on the public ports 80 and 443. nginx then:

- **terminates TLS** (holds the certificate, does the encryption), so the app speaks plain HTTP on localhost;
- serves static files much faster than the app would;
- adds headers, limits request sizes and rates, buffers slow clients, and load-balances several app instances;
- keeps the app off the network entirely: only nginx can reach it.

### A site, step by step

```nginx
# /etc/nginx/sites-available/app.local
server {
    listen 80;
    server_name app.local;
    return 301 https://$host$request_uri;          # everything to HTTPS
}

server {
    listen 443 ssl;
    server_name app.local;

    ssl_certificate     /etc/ssl/app/app.crt;
    ssl_certificate_key /etc/ssl/app/app.key;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Ubuntu's layout: site files live in `sites-available/`, and a symlink in `sites-enabled/` turns one on (`ln -s /etc/nginx/sites-available/app.local /etc/nginx/sites-enabled/`). Remove `sites-enabled/default` if you don't want the welcome page answering on port 80.

The `proxy_set_header` lines matter. Without `Host`, the app sees `127.0.0.1:8080` as the host and builds wrong redirect URLs. Without `X-Forwarded-Proto`, the app thinks every request is plain HTTP and may redirect forever. Without `X-Forwarded-For`, every request seems to come from 127.0.0.1, and rate limits and audit logs see one client.

### Certificates

In production a certificate comes from a public CA, usually **Let's Encrypt** through `certbot`, or your load balancer handles TLS (on AWS, ACM on the ALB, and then nginx isn't doing TLS at all). For a lab, an internal service or a test, make a **self-signed** one:

```bash
mkdir -p /etc/ssl/app
openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
  -keyout /etc/ssl/app/app.key -out /etc/ssl/app/app.crt \
  -subj "/CN=app.local" -addext "subjectAltName=DNS:app.local"
chmod 600 /etc/ssl/app/app.key
```

Browsers and `curl` match the hostname against the **subjectAltName**, not the old CN field, which is why the `-addext` part matters. `curl -k` skips verification when testing a self-signed site; `--resolve app.local:443:127.0.0.1` makes curl send that hostname to localhost without editing `/etc/hosts`.

### Change, test, reload

```bash
nginx -t                  # syntax and file checks, before anything is applied
systemctl reload nginx    # new config, no dropped connections
```

`reload` keeps existing connections and swaps the config gracefully; if the new config is broken, nginx keeps the old one running. A `restart` with a broken config means nginx is down. Always `nginx -t && systemctl reload nginx`.

### Where TLS ends

The browser speaks TLS to nginx. nginx speaks plain HTTP to the application on a loopback port. The application never sees the certificate, and it never sees the client's real scheme unless nginx copies that into a header. That split is the whole design of a reverse proxy: one process is good at TLS, slow clients, and static files; the other process is the application. Binding the application to `127.0.0.1` means a packet from the network cannot reach it even if the host firewall is wrong. Only nginx can.

`server_name` selects the virtual host from the `Host` header (or SNI, for TLS). A request that matches no name hits the default server, which on Ubuntu is the welcome site if you left `sites-enabled/default` in place. Removing that symlink is part of "this name serves this app", not a cosmetic cleanup. `return 301 https://$host$request_uri;` is a redirect that keeps the name and the path. `$host` alone drops the path, so every deep link becomes the site root and the 301 looks successful. `$request_uri` is the original path and query.

```text
client --TLS 443--> nginx (certificate, server_name)
                       |  Host: the name the client used
                       |  X-Forwarded-Proto: https
                       |  X-Forwarded-For: the client address
                       v
                    127.0.0.1:8080  plain HTTP, the app
client --HTTP 80--> nginx  301 to https://$host$request_uri
```

`proxy_set_header Host $host` stops the app building redirects to `127.0.0.1:8080`. `X-Forwarded-Proto $scheme` tells the app the original request was HTTPS. Without it, a framework that forces HTTPS will redirect the already-HTTPS request to HTTPS again, forever. The framework also has to be configured to trust that header, because an untrusted client could send it. Behind nginx, the trust is "this header came from localhost". `X-Forwarded-For` is the client address for logs and rate limits; without it every request looks like 127.0.0.1.

Certificates: clients match the hostname against subjectAltName. The CN field is legacy and is not enough. A lab certificate is `openssl req -x509` with `-addext "subjectAltName=DNS:the.name"`. The key file is mode 600 because it is a secret; the certificate is public. Production certificates come from a public CA, usually Let's Encrypt via certbot, or they are terminated on a load balancer so nginx never sees TLS at all. `curl -k` skips verification and will happily talk to the wrong name. `curl --resolve name:443:127.0.0.1` sends the right hostname to localhost without editing `/etc/hosts`, so the test exercises SNI and `server_name`.

`nginx -t` loads the config and opens the certificate files. A missing key fails the test. `reload` asks a running nginx to swap in a config that already passed, and it keeps existing connections. If the new config fails at reload time, the old workers stay. `restart` with a broken config stops the process. The habit is `nginx -t && systemctl reload nginx`.

### A worked site for a different name

`billing.internal` on loopback port 9090, certificate files under `/etc/ssl/billing/`:

```nginx
server {
    listen 80;
    server_name billing.internal;
    return 301 https://$host$request_uri;
}
server {
    listen 443 ssl;
    server_name billing.internal;
    ssl_certificate     /etc/ssl/billing/billing.crt;
    ssl_certificate_key /etc/ssl/billing/billing.key;
    location / {
        proxy_pass http://127.0.0.1:9090;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

The symlink lives in `sites-enabled` and points at `sites-available`. The default site is removed. `openssl` writes the key and the cert with `DNS:billing.internal` before `nginx -t`, because the test opens those paths. `chmod 600` on the key. Then enable nginx and reload. A request to `http://billing.internal/invoices/9` should answer 301 with a Location that still contains `/invoices/9`.

### Where it breaks

A redirect loop is the forwarded-proto bug, or the app's own HTTPS redirect fighting the proxy. The status line in the browser is 301 to the same URL you are already on. The header, and the app's "trust proxy" setting, fix it. Adding a second certificate on the app does not, because the app is not speaking TLS.

`proxy_pass http://127.0.0.1:9090` with a trailing URI path replaces the request path. Without a URI, the original path is passed through. A trailing slash you did not mean is how `/invoices/9` becomes `/` at the app. The nginx proxy module documents that split; it is the kind of bug that passes `nginx -t` because it is valid config with a wrong meaning.

A certificate with only `CN=billing.internal` fails browsers and `curl` without `-k`. The test that uses `-k` hides it. Read the SAN with `openssl x509 -in cert -noout -ext subjectAltName`. A key mode of 644 is a secret sitting world-readable; the service still starts, which is why the mode has to be checked on purpose.

### At work

The public listener is nginx or a load balancer. The application port is private. The same headers show up on every platform, because every proxy has the same problem: the app is not the TLS endpoint and is not the client socket. Renewing a certificate is a file replace plus `nginx -t && reload`, which is why the test command is in the deploy script and not only in a wiki. When TLS is terminated at a cloud load balancer, you delete the 443 server block rather than inventing a second certificate, and you still set the forwarded-proto header from whatever the load balancer documented.

| Symptom | Cause | Check |
|---|---|---|
| Redirect loop to HTTPS | app thinks the proxy hop is HTTP | `X-Forwarded-Proto`, and the app trusts it |
| Redirect drops the path | `return 301 https://$host` | use `$host$request_uri` |
| Wrong host in app links | `Host` not forwarded | `proxy_set_header Host $host` |
| Browser rejects the cert | no SAN | `openssl x509 -ext subjectAltName` |
| Site down after edit | restart on a bad file | `nginx -t` before reload |

### You can now

- Terminate TLS in nginx, proxy to loopback with `Host` and `X-Forwarded-Proto`, and redirect HTTP without losing the path.
- Issue a self-signed certificate with a SAN, mode 600 on the key, and test it with `--resolve` rather than with name checks disabled.
- Refuse a reload that has not passed `nginx -t`, and remove the default site so it cannot answer for your name.

::: shell vm
task: An app already runs on `127.0.0.1:8080` (it answers `app ok`). Put nginx in front of it for the host `app.local`: a self-signed certificate with subjectAltName `DNS:app.local` under `/etc/ssl/app/` (key mode 600), HTTPS on 443 proxying to the app with the `Host` and `X-Forwarded-Proto` headers set, and port 80 redirecting (301) to HTTPS. Disable the default site. Check the config, and have nginx running and enabled.
setup:
```bash
mkdir -p /srv/app && echo 'app ok' > /srv/app/index.html
printf '[Service]\nWorkingDirectory=/srv/app\nExecStart=/usr/bin/python3 -m http.server 8080 --bind 127.0.0.1\n[Install]\nWantedBy=multi-user.target\n' > /etc/systemd/system/app.service
systemctl daemon-reload && systemctl enable --now app
```
verify:
```bash
nginx -t 2>/dev/null || { echo "nginx -t fails"; nginx -t; exit 1; }
systemctl is-active --quiet nginx && systemctl is-enabled --quiet nginx || { echo "nginx must be running and enabled"; exit 1; }
for i in $(seq 1 12); do curl -sk --resolve app.local:443:127.0.0.1 https://app.local/ 2>/dev/null | grep -q 'app ok' && break; sleep 0.25; done
curl -sk --resolve app.local:443:127.0.0.1 https://app.local/ | grep -q 'app ok' || { echo "https://app.local/ doesn't return the app's page"; exit 1; }
code=$(curl -s -o /dev/null -w '%{http_code}' --resolve app.local:80:127.0.0.1 http://app.local/)
[ "$code" = 301 ] || { echo "http://app.local/ returns $code, not a 301 redirect"; exit 1; }
curl -s -o /dev/null -D - --resolve app.local:80:127.0.0.1 http://app.local/x | grep -qi '^location: https://app.local/x' || { echo "the redirect doesn't keep the host and path"; exit 1; }
openssl x509 -in /etc/ssl/app/app.crt -noout -ext subjectAltName 2>/dev/null | grep -q 'DNS:app.local' || { echo "the certificate has no subjectAltName DNS:app.local"; exit 1; }
[ "$(stat -c %a /etc/ssl/app/app.key)" = 600 ] || { echo "the private key should be mode 600"; exit 1; }
[ ! -e /etc/nginx/sites-enabled/default ] || { echo "the default site is still enabled"; exit 1; }
grep -Rqs 'proxy_set_header Host' /etc/nginx/sites-enabled/ && grep -Rqs 'X-Forwarded-Proto' /etc/nginx/sites-enabled/ || { echo "set the Host and X-Forwarded-Proto headers"; exit 1; }
```
solution:
```bash
mkdir -p /etc/ssl/app
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -keyout /etc/ssl/app/app.key -out /etc/ssl/app/app.crt -subj "/CN=app.local" -addext "subjectAltName=DNS:app.local"
chmod 600 /etc/ssl/app/app.key
cat > /etc/nginx/sites-available/app.local <<'CONF'
server {
    listen 80;
    server_name app.local;
    return 301 https://$host$request_uri;
}
server {
    listen 443 ssl;
    server_name app.local;
    ssl_certificate     /etc/ssl/app/app.crt;
    ssl_certificate_key /etc/ssl/app/app.key;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
CONF
ln -sf /etc/nginx/sites-available/app.local /etc/nginx/sites-enabled/app.local
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl enable --now nginx && systemctl reload nginx
```
hint: Certificate first (`openssl req -x509 … -addext "subjectAltName=DNS:app.local"`), then the site file with two server blocks, the `sites-enabled` symlink, remove the default, `nginx -t`, enable and start.
:::

::: quiz
q: Behind nginx, your app keeps redirecting `https://` requests to `https://` again in a loop, because it thinks they arrive over plain HTTP. What's missing?
- `listen 443 ssl` in the app
+ `proxy_set_header X-Forwarded-Proto $scheme`, and the app configured to trust it
- A second certificate for the app
- `return 301` in the 443 server block
why: TLS ends at nginx, so the app always receives plain HTTP from 127.0.0.1. The forwarded-proto header tells it the original scheme. Most frameworks have a "trust proxy headers" setting for exactly this.
:::

::: card
q: Why `nginx -t && systemctl reload nginx` instead of `systemctl restart nginx`?
answer: `-t` catches config errors before anything changes. `reload` swaps config gracefully, keeps existing connections, and leaves the old config running if the new one fails. `restart` with a broken config takes the site down.
:::

::: quiz
q: `curl -v http://app.local/assets/app.js` receives `301` with `Location: https://app.local/`. The server block is `return 301 https://$host;`. What did that redirect drop, and which variable keeps it?
- The TLS certificate, because a redirect cannot carry a name
+ The path and query. `return 301 https://$host$request_uri;` keeps both
- The port, because `$host` includes `:80`
- The client address, which has to be copied into `Host`
why: `$host` is only the name the client sent. `$request_uri` is the original path and query, so the HTTPS URL is the same resource, not the site root. A redirect to the bare host looks like a working 301 and still breaks every deep link.
:::

::: card
q: A self-signed certificate has `CN=app.local` and no subjectAltName. `curl` (and browsers) reject it for `https://app.local/` even though the CN matches. Why?
answer: Clients match the hostname against subjectAltName, not the legacy CN. The certificate needs `DNS:app.local` in the SAN extension (`openssl … -addext "subjectAltName=DNS:app.local"`). `curl -k` skips that check and hides the mistake.
:::

## Log rotation
id: logrotate-real
stage: serve
needs: journal-real
minutes: 30
goal: Keep application log files from filling the disk, with the right choice between reopening and copytruncate.
source: logrotate(8) | https://manpages.ubuntu.com/manpages/noble/man8/logrotate.8.html

The journal manages its own size. But many programs write **their own files** (`/var/log/myapp/app.log`), and those grow until the disk is full, one of the most common outages there is. **logrotate** fixes that: on a schedule (a daily systemd timer on Ubuntu), it renames `app.log` to `app.log.1`, starts a fresh file, compresses old ones and deletes the oldest.

```text
# /etc/logrotate.d/myapp
/var/log/myapp/*.log {
    daily
    rotate 7
    maxsize 50M
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
```

| Directive | Means |
|---|---|
| `daily` / `weekly` | how often (the timer runs daily; logrotate decides per file) |
| `rotate 7` | keep 7 old files, delete older |
| `maxsize 50M` | also rotate early if bigger than this (`size` would ignore the schedule entirely) |
| `compress` + `delaycompress` | gzip old files, but leave `.1` uncompressed one cycle, in case the program is still finishing a write |
| `missingok`, `notifempty` | no error if the log is missing; don't rotate empty files |
| `create 0640 app app` | after renaming, create a new empty file with this mode and owner |
| `copytruncate` | copy the file, then truncate the original in place |
| `postrotate … endscript` | run a command after rotating, typically telling the program to reopen its log |

### The one decision: how does the program get a new file?

A running program holds its log **open by file descriptor**, not by name. The directory entry is only a name; the open file is the inode behind it. Rename `app.log` to `app.log.1` and the program happily keeps writing into `app.log.1`. Two ways out:

1. **Tell it to reopen**: `postrotate` sends a signal or reload (`systemctl reload myapp`, `nginx -s reopen`, `kill -USR1 …`). Clean, nothing lost, but the program has to support it.
2. **copytruncate**: copy the content away, then truncate the original to zero; the program keeps its descriptor and continues at the start of the now-empty file. It works with any program, but lines written between the copy and the truncate are lost, and the program must open the file in append mode, or it keeps writing at its old offset and the file becomes sparse.

Test without waiting a day: `logrotate -d /etc/logrotate.d/myapp` is a dry run that explains what it would do, and `logrotate -f /etc/logrotate.d/myapp` forces a rotation now.

### The inode stays open

A process writes a log through a file descriptor. The descriptor points at an inode, not at the name `/var/log/myapp/app.log`. logrotate's default move is to rename that name to `app.log.1` and create a new `app.log`. The process does not notice. Its next write goes to the inode, which is now named `app.log.1`, and the new empty file stays empty until something opens it. That is the whole bug people call "rotation did nothing".

Two repairs exist. `postrotate` runs a command that tells the process to close and open the path again (`systemctl reload`, `nginx -s reopen`, a signal the program documented). `create 0640 user group` makes the new empty file with a known mode so the reopened descriptor has something to attach to. Lines are not copied, so nothing is lost between two steps. `copytruncate` copies the bytes aside and truncates the original inode to zero length. The process keeps its descriptor and keeps writing. Any program can be handled this way, including one you cannot signal. The cost is the lines written between the copy and the truncate, which are in neither file, and a second cost if the program did not open with append: its offset is still the old size, so the next write punches a hole in the truncated file.

```text
rename path  ->  process still writes the old inode  ->  new name stays empty
copytruncate ->  same inode, length 0  ->  append writers continue; others seek into a hole
postrotate   ->  process opens the path again  ->  create made that path
```

`daily` and `weekly` are schedules. Ubuntu runs logrotate from a systemd timer about once a day; the file's own directive decides whether that run is allowed to rotate it. `size 50M` replaces the schedule: rotate when a run finds the file already bigger than that, and do not rotate just because a day passed. `maxsize 50M` adds an early size rotation on top of `daily`. `rotate 7` keeps seven old files. `compress` gzips them, and `delaycompress` leaves `.1` uncompressed for one cycle so a process that is still finishing a write, or a human still tailing it, has a plain file. `missingok` and `notifempty` keep a missing or empty log from being an error.

`logrotate -d` is a dry run: it prints the plan and does not rename. `logrotate -f` forces a rotation even if the schedule says not today. A test uses `-d` first and `-f` when you want the files to move.

### A worked config for a job log

A batch process reopens its log when it receives `HUP`, and it is not running while you install the config. This one uses `create` and `postrotate`, not copytruncate:

```text
/var/log/batch-jobs/*.log {
    weekly
    rotate 4
    compress
    missingok
    notifempty
    create 0640 root root
    postrotate
        systemctl kill -s HUP batch-jobs.service
    endscript
}
```

Weekly plus rotate 4 keeps about a month. `create` sets the mode so the new file is not world-readable if the old one was created that way by accident. The `postrotate` block runs with the rotated path available to the script; a HUP is the program's documented reopen. `logrotate -f /etc/logrotate.d/batch-jobs` proves the rename. If the service were not running, the HUP would fail and logrotate would report it, which is a reason to know whether the program is up before choosing postrotate over copytruncate.

### Where it breaks

copytruncate on a non-append writer grows a sparse file. `du` and `ls` disagree about the size, and new lines are not where readers expect them. The fix is postrotate if the program can reopen, or changing the program to append. Running copytruncate "because it always works" is the assumption that failed.

A `postrotate` that restarts the whole service drops connections in order to rotate a log. Reload or a dedicated reopen signal is the smaller hammer. If the command in `postrotate` exits non-zero, logrotate complains; a script with no `endscript` is a parse error that `-d` catches.

`size` without a schedule looks like "cap the file" and then the file sits at 60M until the next timer run. logrotate is not a watcher. The timer has to run. `maxsize` on top of `daily` is how you get both "at least daily" and "sooner if it is huge". Confusing the two directives is how a disk fills on a chatty day even though a size was written down.

### At work

Application logs that are not the journal need a file in `/etc/logrotate.d`, owned by the same change that deploys the app. The choice is mechanical: if the program documents a reopen signal, use it; if it does not, copytruncate and accept a few lost lines, and do not pretend otherwise in the runbook. Disk alerts at 80% exist because rotation that is wrong still fills the disk, just later. The journal has its own cap; mixing "we rotate" with a journal that has no `SystemMaxUse=` leaves the other half of `/var/log` unbounded.

| The program | Config | What you lose |
|---|---|---|
| Can reopen on a signal | `create` plus `postrotate` | nothing from the rename itself |
| Cannot reopen, appends | `copytruncate` | lines in the copy/truncate window |
| Cannot reopen, seeks | neither is honest | fix the program to append or to reopen |
| Must stay under a size | `maxsize` with `daily`, or `size` alone | `size` will not rotate on a quiet day |
| Test now | `logrotate -d` then `logrotate -f` | `-d` does not move files |

### You can now

- Explain why a rename leaves the process writing the old file, and pick postrotate or copytruncate from how the program opens that file.
- Distinguish `size` from `maxsize`, and `compress` from `delaycompress`.
- Dry-run a config and force one rotation without waiting for the daily timer.

::: shell vm
task: `/var/log/myapp/app.log` is written by a program that can't reopen its log. Write `/etc/logrotate.d/myapp` for `/var/log/myapp/*.log`: daily, keep 7, compress with delaycompress, missingok, notifempty, and copytruncate. Then force one rotation so you can see it work.
setup:
```bash
mkdir -p /var/log/myapp
for i in $(seq 1 20000); do echo "2026-01-05T10:00:00 request $i ok"; done > /var/log/myapp/app.log
```
verify:
```bash
f=/etc/logrotate.d/myapp
[ -f "$f" ] || { echo "no $f"; exit 1; }
for d in daily 'rotate 7' compress delaycompress missingok notifempty copytruncate; do grep -Eq "^\s*$d\s*$" "$f" || { echo "missing directive: $d"; exit 1; }; done
grep -q '/var/log/myapp/\*\.log' "$f" || { echo "the config doesn't cover /var/log/myapp/*.log"; exit 1; }
logrotate -d "$f" >/dev/null 2>&1 || { echo "logrotate -d reports a problem"; exit 1; }
[ -s /var/log/myapp/app.log.1 ] || { echo "no app.log.1: force a rotation with logrotate -f"; exit 1; }
[ "$(stat -c %s /var/log/myapp/app.log)" -lt 1000 ] || { echo "app.log wasn't truncated"; exit 1; }
```
solution:
```bash
cat > /etc/logrotate.d/myapp <<'CONF'
/var/log/myapp/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
CONF
logrotate -d /etc/logrotate.d/myapp
logrotate -f /etc/logrotate.d/myapp
ls -l /var/log/myapp
```
hint: One block with the seven directives, then `logrotate -f` on the file to force it.
:::

::: quiz
q: logrotate renamed `app.log` to `app.log.1`, but the program keeps writing into `app.log.1` and the new `app.log` stays empty. Why, and what are the two fixes?
+ The program holds the file open by descriptor, so the rename doesn't affect it. Fix: a postrotate that makes it reopen its log, or copytruncate
- logrotate failed; run it again with -f
- The program needs write permission on the directory
- delaycompress causes this
why: Renaming changes the name, not the open file. Either signal the program to reopen (clean), or copy and truncate in place (works with anything, may lose a few lines).
:::

::: quiz
q: A logrotate block sets `size 50M` and does not set `daily`. The daily logrotate timer runs. When does this file rotate?
+ Only when logrotate runs and the file is already larger than 50M. `size` ignores the schedule
- Every day, and also whenever it crosses 50M
- Never, because `size` requires `maxsize` as well
- Only at boot, because `size` is a monotonic timer
why: `size` replaces the time schedule: the file rotates on a run where it is already over the limit, and it does not rotate just because a day passed. `maxsize` is the one that adds an early size rotation on top of `daily` or `weekly`. The timer still has to run logrotate; `size` does not watch the file itself.
:::

::: card
q: `copytruncate` loses the lines written between the copy and the truncate, and it breaks if the program did not open the log with append. When is `create` plus `postrotate` the better pair?
answer: When the program can reopen its log (a reload, `nginx -s reopen`, or a signal). logrotate renames the file, `create` makes a new empty one with the mode you set, and `postrotate` tells the program to open that new name. Nothing is copied, so the window where lines are lost is gone.
:::

::: shell vm
task: `/var/log/batch/job.log` is not held open by a running process. Write a logrotate config for `/var/log/batch/*.log` that rotates weekly, keeps 4, compresses, uses missingok and notifempty, creates the new file as mode `0640` owned by root:root, and in `postrotate` writes the single word `rotated` into `/var/log/batch/rotated.stamp`. Force one rotation.
setup:
```bash
mkdir -p /var/log/batch
for i in $(seq 1 5000); do echo "batch row $i"; done > /var/log/batch/job.log
```
verify:
```bash
# Wrong fix: the myapp copytruncate block (daily, rotate 7, copytruncate, no postrotate). The stamp file never appears, and the directives do not match.
f=$(grep -ls '/var/log/batch' /etc/logrotate.d/* 2>/dev/null | head -n 1)
[ -n "$f" ] || { echo "no logrotate config mentions /var/log/batch"; exit 1; }
for d in weekly 'rotate 4' compress missingok notifempty; do grep -Eq "^[[:space:]]*$d[[:space:]]*$" "$f" || { echo "missing directive: $d"; exit 1; }; done
grep -Eq '^[[:space:]]*create[[:space:]]+0640[[:space:]]+root[[:space:]]+root[[:space:]]*$' "$f" || { echo "missing: create 0640 root root"; exit 1; }
grep -q 'postrotate' "$f" || { echo "no postrotate"; exit 1; }
logrotate -d "$f" >/dev/null 2>&1 || { echo "logrotate -d reports a problem"; exit 1; }
[ -s /var/log/batch/job.log.1 ] || [ -s /var/log/batch/job.log.1.gz ] || { echo "job.log was not rotated"; exit 1; }
[ "$(cat /var/log/batch/rotated.stamp 2>/dev/null | tr -d '[:space:]')" = rotated ] || { echo "postrotate did not write rotated to rotated.stamp"; exit 1; }
```
solution:
```bash
cat > /etc/logrotate.d/batch <<'CONF'
/var/log/batch/*.log {
    weekly
    rotate 4
    compress
    missingok
    notifempty
    create 0640 root root
    postrotate
        echo rotated > /var/log/batch/rotated.stamp
    endscript
}
CONF
logrotate -f /etc/logrotate.d/batch
```
hint: `create` and `postrotate` replace copytruncate when nothing has the file open. `logrotate -f` runs it now, including the script between `postrotate` and `endscript`.
:::

## Resource limits
id: limits
stage: serve
needs: units, linux/proc
minutes: 25
goal: Set per-service limits (open files, memory, CPU) in systemd, and confirm them on the running process.
source: systemd.exec(5): process properties | https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html
source: systemd.resource-control(5) | https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html

"Too many open files" is a classic production error: every socket and file a process has open uses a **file descriptor**, and each process has a limit, often 1024 by default. A busy web server or database blows past it.

Limits come in two families:

**Per-process limits (rlimits).** Set in a unit with `Limit*=`:

| Setting | Limits |
|---|---|
| `LimitNOFILE=65536` | open file descriptors |
| `LimitNPROC=` | processes and threads for the user |
| `LimitCORE=` | core dump size |

For services, the old answer "edit `/etc/security/limits.conf`" doesn't work: that file applies to **login sessions** (through PAM), and systemd services aren't login sessions. Use the unit, or a drop-in.

**cgroup resource control.** systemd puts each service in its own cgroup, and the kernel enforces:

| Setting | Effect |
|---|---|
| `MemoryMax=512M` | hard cap; over it, the kernel's OOM killer kills the service |
| `MemoryHigh=400M` | throttle and reclaim above this, before reaching the max |
| `CPUQuota=50%` | at most half of one CPU |
| `TasksMax=200` | at most 200 processes and threads |

These are exactly the **limits** of Kubernetes and Docker (`--memory`, `--cpus`): containers are cgroups too. A service killed for `MemoryMax` tells the same signal story as a pod that was OOMKilled: exit code 137, SIGKILL.

### Verifying on the real process

Configuration is a claim; the kernel is the truth:

```bash
pid=$(systemctl show -p MainPID --value web)
grep 'Max open files' /proc/$pid/limits
systemctl show -p MemoryMax,CPUQuotaPerSecUSec web
systemd-cgtop                      # live per-service CPU and memory
```

Limits apply when the process **starts**, so a restart is needed after changing them.

### Two different knobs, applied at start

A process has rlimits, which are per-process ceilings the kernel enforces inside that process: how many file descriptors (`RLIMIT_NOFILE`), how many threads it may create for that uid, how large a core dump may be. systemd sets them from `LimitNOFILE=`, `LimitNPROC=` and `LimitCORE=` when it starts the process. They show up in `/proc/PID/limits`. They do not show up there for a process that was started before you edited the unit, because the values are copied in at exec time. `daemon-reload` updates the unit in memory. `restart` is what creates a process with the new ceiling.

`/etc/security/limits.conf` is a PAM file. Login, su and sshd go through PAM and apply it. A service systemd starts does not log in, so it never reads that file. Raising `nofile` there and rebooting leaves nginx at 1024 and the error "Too many open files" unchanged. nginx also has `worker_rlimit_nofile`, which must be at least as high as the unit limit or the worker drops the rlimit back down. The unit is still the place the ceiling has to exist.

cgroup controllers are the other family. systemd puts each service in a cgroup, and the kernel accounts the whole group: `MemoryMax=` is a hard cap, `MemoryHigh=` is a throttle that starts reclaiming before the cap, `CPUQuota=20%` is a fifth of one CPU, `TasksMax=` counts processes and threads. `MemoryMax=256M` is stored as bytes (`268435456`). Crossing `MemoryMax` is a kill, SIGKILL, exit status 137 (128+9). There is no traceback, because the process does not get to run a handler. `MemoryHigh` does not kill. The process runs slowly and page cache is reclaimed, which is the warning band under the cap.

```text
unit + drop-ins
    | daemon-reload
    v
start / restart
    |-- setrlimit  -> /proc/PID/limits     LimitNOFILE, LimitNPROC
    \-- cgroup     -> MemoryMax, MemoryHigh, CPUQuota, TasksMax
login via PAM ---> limits.conf    (never this path for a service)
```

`CPUQuota=20%` shows up as `CPUQuotaPerSecUSec=200ms`: twenty percent of a one-second period. `LimitNOFILE=` is an rlimit, copied when the process is exec'd, so a running process keeps its old open-file ceiling until you restart it. Cgroup caps are properties of the group; a restart is still the reliable way to make the process and the group agree with the unit you just wrote. A drop-in is the right place to set these on a packaged unit, same as a restart policy, so an upgrade does not wipe them.

Containers use this mechanism. A Docker `--memory` flag and a Kubernetes memory limit are cgroup caps. An OOMKilled pod and a service with exit 137 are the same signal. Reading one teaches the other.

### A worked cap for a different worker

A thumbnail worker tends to open a file per image and to peg a CPU. The packaged unit stays untouched:

```ini
# /etc/systemd/system/thumbs.service.d/caps.conf
[Service]
LimitNOFILE=8192
MemoryHigh=150M
MemoryMax=200M
CPUQuota=20%
```

`systemctl daemon-reload` and `systemctl restart thumbs`. Then:

```bash
pid=$(systemctl show -p MainPID --value thumbs)
grep 'Max open files' /proc/$pid/limits
systemctl show -p MemoryMax -p CPUQuotaPerSecUSec --value thumbs
```

The open-files line should contain 8192. `MemoryMax` should be 209715200. `CPUQuotaPerSecUSec` should be 200ms. If the main PID is 0, the service is not running and the `/proc` check is looking at the wrong thing. If the numbers match the unit but not `/proc`, the process was not restarted after the edit.

### Where it breaks

limits.conf on a service is the most common no-op. The file is valid, PAM would honour it, and systemd never asked PAM. People add a reboot, which restarts the service with the same unit limits as before.

`MemoryHigh` set above `MemoryMax`, or only `MemoryHigh` with no max, does not do what a "hard cap" sentence promised. High is pressure. Max is death. A process that leaks slowly sits in the throttle band and looks like a slow app rather than a crashing one. The kill, when it comes, has no Python stack.

`LimitNOFILE=infinity` looks generous and can make a runaway process exhaust the system-wide file table, which then breaks sshd and journald. A large finite number (65536 for a busy proxy, less for a worker) is a limit. Infinity is the absence of one. `TasksMax=` left at a low default is the opposite surprise: a service that forks for each request hits the task cap and cannot accept work, with an error that does not mention memory or files.

### At work

Every service that takes traffic or opens a database pool gets an explicit `LimitNOFILE` and a memory cap in the same change that deploys it. The cap is how one leak fails that unit instead of the whole host. Alerts watch for exit 137 and for `NRestarts`, because a cap that is too small looks like a crash loop. The same numbers go into the container manifest when the service moves, so the team is not inventing a second limit system. `systemd-cgtop` is the live view of which unit is paying for CPU and memory, which is the bridge from "the machine is slow" to "this unit's quota is the reason".

| Setting | Enforced by | Visible in | Applies to a service via limits.conf? |
|---|---|---|---|
| `LimitNOFILE` | rlimit | `/proc/PID/limits` | no |
| `MemoryMax` | cgroup, SIGKILL at the cap | `systemctl show` | no |
| `MemoryHigh` | cgroup throttle | `systemctl show` | no |
| `CPUQuota=20%` | cgroup, 200ms per second | `CPUQuotaPerSecUSec` | no |
| login `nofile` | PAM | the login shell's limits | that is all it does |

### You can now

- Set open files and a memory cap in a drop-in, restart, and prove both on the running process.
- Explain exit 137 and why `MemoryHigh` does not produce it.
- Ignore `limits.conf` for systemd services and say why a reboot does not make it apply.

::: shell vm
task: `web.service` is running. Raise its open-files limit to 65536 and cap its memory at 256M, using a drop-in (not by editing the unit). Apply it, and make sure the running process has the new open-files limit.
setup:
```bash
mkdir -p /srv/web && echo hi > /srv/web/index.html
printf '[Service]\nWorkingDirectory=/srv/web\nExecStart=/usr/bin/python3 -m http.server 8080 --bind 127.0.0.1\n[Install]\nWantedBy=multi-user.target\n' > /etc/systemd/system/web.service
systemctl daemon-reload && systemctl enable --now web
```
verify:
```bash
! grep -qE 'LimitNOFILE|MemoryMax' /etc/systemd/system/web.service || { echo "use a drop-in, not the unit file"; exit 1; }
ls /etc/systemd/system/web.service.d/*.conf >/dev/null 2>&1 || { echo "no drop-in for web.service"; exit 1; }
pid=$(systemctl show -p MainPID --value web)
[ "$pid" != 0 ] || { echo "web isn't running"; exit 1; }
grep 'Max open files' "/proc/$pid/limits" | grep -q '65536' || { echo "the running process doesn't have 65536 open files (restart after changing limits)"; grep 'Max open files' "/proc/$pid/limits"; exit 1; }
[ "$(systemctl show -p MemoryMax --value web)" = "$((256 * 1024 * 1024))" ] || { echo "MemoryMax isn't 256M"; exit 1; }
```
solution:
```bash
mkdir -p /etc/systemd/system/web.service.d
printf '[Service]\nLimitNOFILE=65536\nMemoryMax=256M\n' > /etc/systemd/system/web.service.d/limits.conf
systemctl daemon-reload
systemctl restart web
grep 'Max open files' /proc/$(systemctl show -p MainPID --value web)/limits
```
hint: A drop-in with `LimitNOFILE=` and `MemoryMax=`, `daemon-reload`, then **restart** (limits are set at start). Check `/proc/PID/limits`.
:::

::: quiz
q: You raised `nofile` in `/etc/security/limits.conf`, rebooted, and nginx still logs "Too many open files". Why?
- The reboot didn't apply limits.conf
+ limits.conf applies to login sessions through PAM; systemd services get their limits from the unit (`LimitNOFILE=`)
- nginx ignores open-file limits
- The limit must be set in /proc
why: Services started by systemd don't go through a PAM login. Set `LimitNOFILE=` in the unit or a drop-in (nginx also has its own `worker_rlimit_nofile`).
:::

::: quiz
q: You set `MemoryHigh=200M` and `MemoryMax=256M` on a service. The process climbs past 200M and is still running, then dies later with no Python traceback. What happened at each threshold?
+ Above MemoryHigh the kernel throttles and reclaims. At MemoryMax it kills the cgroup. The kill is SIGKILL, so the process cannot print a traceback, and the exit status is 137
- MemoryHigh kills the process, and MemoryMax only logs a warning
- Both settings are rlimits, so they appear in `/etc/security/limits.conf` and apply without a restart
- The OOM killer only runs when the whole machine is out of memory, so a per-service cap cannot kill anything
why: `MemoryHigh` is pressure, not death: the process is slowed so it can free memory. `MemoryMax` is a hard cgroup cap. Crossing it is a kernel kill (9), and 128+9 = 137. The process is gone before it can flush a traceback. Editing `limits.conf` does not set either value, and a running process keeps the limits it was started with until you restart it.
:::

::: card
q: A drop-in sets `LimitNOFILE=8192` and `CPUQuota=20%`. You ran `daemon-reload` and did not restart. `/proc/PID/limits` still shows 1024 open files. Why?
answer: `LimitNOFILE` is an rlimit copied at exec, so the running process keeps the old ceiling until `systemctl restart`. `CPUQuota` is a cgroup setting; `daemon-reload` updates systemd's copy of the unit, and a restart is the reliable point where both the cgroup cap and the open-file rlimit match that copy. Confirm with `systemctl show -p CPUQuotaPerSecUSec` and `/proc/PID/limits` after the restart.
:::

::: shell vm
task: `worker.service` is running a busy loop. Using a drop-in (do not edit `/etc/systemd/system/worker.service`), set its open-files limit to 8192 and its CPU quota to 20%. Apply both to the running process.
setup:
```bash
printf '[Service]\nExecStart=/bin/sh -c "while :; do :; done"\n[Install]\nWantedBy=multi-user.target\n' > /etc/systemd/system/worker.service
systemctl daemon-reload
systemctl start worker
```
verify:
```bash
# Wrong fix: writing nofile and cpu lines into /etc/security/limits.conf, or editing LimitNOFILE into the main unit file. limits.conf does not apply to a systemd service, and the main file must stay untouched.
! grep -qE 'LimitNOFILE|CPUQuota' /etc/systemd/system/worker.service || { echo "use a drop-in, not the unit file"; exit 1; }
ls /etc/systemd/system/worker.service.d/*.conf >/dev/null 2>&1 || { echo "no drop-in for worker.service"; exit 1; }
pid=$(systemctl show -p MainPID --value worker)
[ "$pid" != 0 ] && [ -d "/proc/$pid" ] || { echo "worker is not running"; exit 1; }
grep 'Max open files' "/proc/$pid/limits" | grep -q '8192' || { echo "the running process does not have 8192 open files"; grep 'Max open files' "/proc/$pid/limits"; exit 1; }
systemctl show -p CPUQuotaPerSecUSec --value worker | grep -q '200ms' || { echo "CPUQuota is not 20% (200ms per second)"; systemctl show -p CPUQuotaPerSecUSec worker; exit 1; }
```
solution:
```bash
mkdir -p /etc/systemd/system/worker.service.d
printf '[Service]\nLimitNOFILE=8192\nCPUQuota=20%%\n' > /etc/systemd/system/worker.service.d/limits.conf
systemctl daemon-reload
systemctl restart worker
```
hint: `CPUQuota=20%` is twenty percent of one CPU. In a `printf` format string, write `%%` for a literal percent. Restart after `daemon-reload`, then read `/proc/<pid>/limits`.
:::

## Storage: mounts and fstab on a server
id: storage-real
stage: serve
needs: limits, linux/disks
minutes: 35
goal: Read a server's disks and mounts, add a mount to fstab safely, and know the LVM model you'll meet on real servers.
source: Ubuntu Server: About LVM | https://documentation.ubuntu.com/server/explanation/storage/about-lvm/
source: fstab(5) | https://man7.org/linux/man-pages/man5/fstab.5.html
source: findmnt(8) | https://man7.org/linux/man-pages/man8/findmnt.8.html

### Seeing what's there

| Command | Shows |
|---|---|
| `lsblk` | block devices as a tree: disks, partitions, LVM volumes, where each is mounted |
| `blkid` | filesystem type and UUID of each device |
| `findmnt` | the mount tree; `findmnt /var` for one mount point |
| `df -hT` | usage per mounted filesystem, with type |

### The path from disk to directory

```text
disk (/dev/nvme1n1) → partition (/dev/nvme1n1p1) → filesystem (mkfs.ext4) → mount (/data) → fstab (survives reboot)
```

On a real server or cloud VM, adding a data disk looks like this:

```bash
lsblk                                     # find the new, empty disk
mkfs.ext4 -L data /dev/nvme1n1            # make a filesystem (destroys what's there: check twice)
mkdir -p /data
echo 'LABEL=data /data ext4 defaults,nofail 0 2' >> /etc/fstab
mount -a                                  # mount everything in fstab now: tests your line
findmnt /data
```

Two habits come from that. Identify filesystems by **UUID or LABEL**, never `/dev/sdb1` (device names change between boots and instance types). And add **`nofail`** to non-essential mounts, so a missing disk doesn't drop the server into emergency mode at boot. `mount -a` right after editing fstab is your test: an error now is far better than one at the next boot, when you may not have a console.

### LVM in one picture

Most servers you'll inherit use **LVM** between the disks and the filesystems:

```text
physical volumes (disks)  →  volume group (a pool)  →  logical volumes (like partitions, resizable)
   pvcreate                    vgcreate                   lvcreate, lvextend
```

The point is flexibility: add a disk to the pool (`vgextend`), then grow a volume and its filesystem online (`lvextend -r -L +20G /dev/vg0/data`, where `-r` resizes the filesystem too). Snapshots for consistent backups come from the same layer. In the cloud you more often grow the EBS volume itself, then `growpart` and `resize2fs`; the ideas are the same.

### In this lab

Exercise machines are containers, which may not create block devices, so `mkfs` and LVM can't run here. They can do the fstab part with a **tmpfs**, a memory-backed filesystem with a size limit, often used for `/tmp` and scratch space, which follows exactly the same fstab rules.

### From a block device to a directory that survives boot

A disk shows up as a block device. A partition is a slice of it. A filesystem is a structure written onto that slice (`mkfs`). A mount attaches that filesystem to a directory so path lookups land there. None of those steps persist across a reboot except the one you write into `/etc/fstab`. `mount /dev/sdb1 /data` works until the next boot and then the directory is empty again, because empty means "this is the root filesystem's directory" when nothing is mounted on it.

fstab's fields are device, mount point, type, options, dump, pass. The device field should be `UUID=` or `LABEL=`, read from `blkid`, because `/dev/sdb1` is a discovery name. Add a disk, or stop and start a cloud instance, and the names swap. The machine then tries to mount the wrong filesystem, or fails the mount and drops into emergency mode if the line is required. `nofail` in the options says this mount is optional: if the device is absent, keep booting. Root must not be `nofail`. Data disks should be, unless the services truly cannot run without them, in which case emergency mode is the honest failure and you still want a console or a serial log.

`mount -a` mounts everything in fstab that is not already mounted. Running it after you edit the file is the test. An error now is a line you can fix. An error at the next boot may be a machine you cannot SSH to. `findmnt /data` shows what actually got mounted, which can differ from what you typed if an earlier mount covered the path.

```text
disk -> partition -> filesystem (UUID, LABEL)
                         |
                         v
                      fstab line: UUID=... /data ext4 defaults,nofail 0 2
                         |
                    mount -a
                         |
                      findmnt /data
```

LVM inserts a pool in the middle. Physical volumes are disks or partitions (`pvcreate`). A volume group is the pool (`vgcreate`). Logical volumes are the slices you format and mount (`lvcreate`). Growing is `lvextend -L +20G -r`, and `-r` resizes the filesystem in the same step. Without `-r`, `lvs` shows a larger volume and `df` shows the old filesystem, because the filesystem has its own size. `resize2fs` or `xfs_growfs` finishes the job. Snapshots are a property of the volume group, which is why backup tools ask for them. In a cloud VM you often grow the virtual disk, then `growpart`, then the filesystem, and LVM is absent. The idea is the same: the block layer grew, and the filesystem does not notice until you tell it.

A system container often cannot create those block devices. A tmpfs can still exercise fstab, because tmpfs is a filesystem whose "device" is memory and whose size is an option. The fields are the same shape: `tmpfs /mnt/scratch tmpfs size=64M,mode=1777,nofail 0 0`. `mode=1777` is the sticky bit plus world access, which is what `/tmp` uses so anyone can create files and only the owner can delete them. `mount -a` must be what attaches it. A one-shot `mount -t tmpfs` would look mounted and would vanish from the design, because fstab would not contain the line the next boot needs.

### A worked data disk, named by label

On a real VM, after you have identified an empty disk and you are sure it is empty:

```bash
mkfs.ext4 -L vardata /dev/nvme1n1
mkdir -p /var/data
echo 'LABEL=vardata /var/data ext4 defaults,nofail 0 2' >> /etc/fstab
mount -a
findmnt -n -o SOURCE,FSTYPE,OPTIONS /var/data
```

`mkfs` destroys what was on that device. The label is how fstab finds it after the device name changes. `0 2` means "not for dump" and "fsck this after the root filesystem". `findmnt` should show ext4 and the label, not a hope. If `mount -a` warns and `findmnt` is empty, the line is wrong and the boot would have been wrong too.

### Where it breaks

`/dev/sdb1` in fstab plus a new instance type is emergency mode. The root cause is the name, and the amplifier is a required mount. UUID plus `nofail` fixes both halves. `defaults` does not include `nofail`.

`lvextend` without a filesystem resize looks like "the disk did not grow". Two tools, two sizes. `df` is the one applications feel. `lvs` is the one the volume manager feels.

A tmpfs size is a cap, and a full tmpfs returns "no space" for that mount point only. People then delete files on `/` and nothing changes, because `df` of `/` was never the filesystem that filled. `df -hT /the/path` is the check. `mount -a` will also refuse to shrink or alter an already mounted tmpfs if you only edit fstab; remount or reboot applies the new options.

### At work

Servers you inherit are usually LVM or a cloud volume plus a filesystem, mounted from fstab by UUID. The change you make most often is "add a disk and mount it", and the failure you cause most often is a required fstab line that does not survive a stop/start. Backups that need a consistent view use an LVM snapshot or a storage snapshot, then mount the snapshot somewhere else, so the live mount stays put. Container hosts add another layer on top of the same mounts: the data directory is a host path, and the container sees a bind mount. If the host fstab is wrong, every container on that path is wrong.

| Step | Tool | Survives reboot? |
|---|---|---|
| See the tree | `lsblk`, `findmnt`, `df -hT` | the view does; the disks might not |
| Identity of a filesystem | `blkid` UUID or LABEL | yes, if fstab uses it |
| Make it mount on boot | a line in fstab | yes |
| Test the line | `mount -a` | the test is now, the boot is later |
| Optional disk | `nofail` | boot continues if it is missing |
| Grow LVM and the filesystem | `lvextend -r` | yes, both layers |

### You can now

- Write an fstab line that uses a label or UUID and `nofail`, and prove it with `mount -a` and `findmnt`.
- Explain the three LVM layers and why `df` stays small after `lvextend` without `-r`.
- Treat a tmpfs fstab line as the same shape of mount, including a size and a mode.

::: shell vm
task: Add a line to `/etc/fstab` that mounts a **tmpfs** of at most 64 MB at `/mnt/scratch` with mode `1777` (like /tmp), marked `nofail`. Create the mount point, then mount it from fstab with `mount -a` (not by typing the mount options on the command line).
verify:
```bash
grep -Eq '^tmpfs[[:space:]]+/mnt/scratch[[:space:]]+tmpfs[[:space:]]+[^[:space:]]*size=64M' /etc/fstab || { echo "no fstab line: tmpfs /mnt/scratch tmpfs ...size=64M..."; exit 1; }
grep -E '^tmpfs[[:space:]]+/mnt/scratch' /etc/fstab | grep -q 'mode=1777' || { echo "the options need mode=1777"; exit 1; }
grep -E '^tmpfs[[:space:]]+/mnt/scratch' /etc/fstab | grep -q 'nofail' || { echo "the options need nofail"; exit 1; }
findmnt -n -o FSTYPE /mnt/scratch | grep -qx tmpfs || { echo "/mnt/scratch isn't mounted as tmpfs"; exit 1; }
[ "$(findmnt -n -o SIZE /mnt/scratch | tr -d ' ')" = 64M ] || { echo "the mounted size isn't 64M"; exit 1; }
[ "$(stat -c %a /mnt/scratch)" = 1777 ] || { echo "the mount's mode isn't 1777"; exit 1; }
```
solution:
```bash
mkdir -p /mnt/scratch
echo 'tmpfs /mnt/scratch tmpfs size=64M,mode=1777,nofail 0 0' >> /etc/fstab
mount -a
findmnt /mnt/scratch
```
hint: Fields: device (`tmpfs`), mount point, type (`tmpfs`), options (`size=64M,mode=1777,nofail`), then `0 0`. `mount -a` mounts what fstab lists.
:::

::: quiz
q: Why is `nofail` recommended on a data disk's fstab line?
+ If the disk is missing or broken at boot, the system still boots instead of dropping into emergency mode
- It makes the disk mount faster
- It prevents writes from failing
- It's required for ext4
why: Without it, a non-essential mount failing at boot stops the boot. On a cloud VM without a console, that's a server you can't reach.
:::

::: card
q: What are the three layers of LVM, and what's the benefit?
answer: Physical volumes (disks) are pooled into a volume group, which is carved into logical volumes. Volumes can grow online (`lvextend -r`), span disks, and be snapshotted, which fixed partitions can't do.
:::

::: quiz
q: An fstab line names the data disk as `/dev/sdb1`. After a stop/start on a cloud instance the root disk and the data disk swap names, and the machine boots into emergency mode. What change avoids both the swap and the emergency shell?
+ Identify the filesystem by UUID or LABEL, and add `nofail` if the machine should still boot when that disk is absent
- Change the line to `/dev/sda1`, which is always the data disk
- Remove the fstab line and mount by hand after every boot
- Add `defaults` and leave the device name, because `defaults` includes nofail
why: Kernel device names follow discovery order, so they are not stable. `UUID=` or `LABEL=` still finds the filesystem after the names swap. `nofail` tells systemd not to treat a missing optional mount as a reason to enter emergency mode. `defaults` does not include `nofail`.
:::

::: card
q: You extended a logical volume with `lvextend -L +20G` and forgot `-r`. `df` still shows the old size, while `lvs` shows the larger volume. What is left to do?
answer: The volume is larger and the filesystem inside it is not. `resize2fs` (ext4) or `xfs_growfs` (XFS) grows the filesystem into the free space. `lvextend -r` runs that step for you. Growing the filesystem does not require a reboot.
:::

## Boot, targets and failed units
id: boot
stage: serve
needs: restarts
minutes: 25
goal: Know what happens from power-on to login, read and change the boot target, and clean up failed units.
source: bootup(7) | https://www.freedesktop.org/software/systemd/man/latest/bootup.html
source: systemd.special(7): targets | https://www.freedesktop.org/software/systemd/man/latest/systemd.special.html

### From power to prompt

1. **Firmware** (UEFI) finds the boot disk.
2. The **bootloader** (GRUB) loads the kernel and an initial ramdisk (**initramfs**) with the drivers needed to find the real root filesystem.
3. The **kernel** starts, mounts root, and runs **PID 1**: systemd.
4. systemd brings the system to a **target**: a named group of units, the modern version of runlevels.

| Target | Means |
|---|---|
| `multi-user.target` | normal server: networking, services, logins, no GUI |
| `graphical.target` | multi-user plus a desktop |
| `rescue.target` | single-user, minimal services, root shell, for repairs |
| `emergency.target` | even less: root filesystem read-only, nothing else |

`systemctl get-default` shows the boot target; `systemctl set-default multi-user.target` changes it. A server should boot to `multi-user.target`. Units that are enabled are linked into a target's `.wants/` folder, and that's all "enabled" means.

### When boot goes wrong

- A bad fstab line, a missing disk without `nofail`, or a failing critical unit drops you into **emergency mode**. From there: read `journalctl -xb`, fix `/etc/fstab`, reboot.
- `systemd-analyze blame` lists which units took longest to start; `systemd-analyze critical-chain` shows the chain that held up boot.
- `systemctl --failed` lists failed units. Each one is worth a look, because "the server works" with a failed unit often means a backup or monitoring job quietly isn't running.

### Mask: stronger than disable

`disable` removes the boot links, but anything can still start the unit: a dependency, a socket, a person. **`mask`** links the unit to `/dev/null`, so it **cannot** be started at all until unmasked. Mask what must never run, like a legacy service a package keeps reinstalling. `systemctl reset-failed` clears the failed state after you've dealt with the cause.

One gotcha: `mask` works by putting a link to `/dev/null` at `/etc/systemd/system/NAME.service`. That's where packaged units are overridden, so masking a package's unit (in `/usr/lib/systemd/system/`) just works. But if the unit's own file **is** in `/etc/systemd/system/` (one you or a deploy script wrote there), `mask` fails with "already exists": there's no free spot for the link. Then remove that file (or move it away), `daemon-reload`, and mask.

### What "enabled" and "masked" are on disk

Boot is a pipeline: firmware, GRUB, an initramfs that can see the root disk, the kernel, then systemd as PID 1. systemd's job is to reach a target, which is a unit that wants other units. `multi-user.target` is the normal server: logins and services, no graphical session. `graphical.target` wants multi-user and a display. A server whose default is graphical is waiting on units it does not need, and sometimes on a display that will never come. `systemctl get-default` reads the symlink `/etc/systemd/system/default.target`. `set-default multi-user.target` points it at the right one. That does not, by itself, stop a unit. It changes what the next boot wants.

`enable` creates a symlink in a target's `.wants/` directory. `disable` removes that symlink. Anything else may still start the unit: a `Wants=` from another unit, a socket, a timer, a person's `systemctl start`. `mask` is stronger because it points the unit's name at `/dev/null`. systemd then has a unit that cannot be started, by anyone, until `unmask`. The symlink has to live at `/etc/systemd/system/NAME.service`, which is also where an override of a packaged unit lives. A packaged unit file is in `/usr/lib/systemd/system/`, so the `/etc` path is free and mask works. A unit you wrote directly in `/etc/systemd/system/NAME.service` occupies that path. `mask` fails with "file exists", and the service keeps running. Move the file aside, `daemon-reload` so systemd forgets the old definition, then mask.

```text
default.target -> multi-user.target
                      \- wants -> app.service
mask: /etc/systemd/system/legacy.service -> /dev/null
      (fails if a regular file is already at that path)
```

`systemctl --failed` lists units in the failed state. A server can serve traffic with a failed backup unit. That list is part of "is this machine healthy?", not an optional extra. `reset-failed` clears the state after you have dealt with the cause. It does not fix the cause. Clearing it and walking away puts the same failure back on the next start.

`systemd-analyze blame` sorts units by how long they took. `critical-chain` is the chain that delayed the target you care about. A slow unit that nothing waited for is in the blame list and not on the chain. SSH that took 40 seconds is a critical-chain question. A background vacuum that took 40 seconds and blocked nobody is only blame.

### A worked mask when the file is in /etc

`noisy.service` was deployed as a real file in `/etc/systemd/system`, and it must never start again:

```bash
systemctl disable --now noisy
mv /etc/systemd/system/noisy.service /root/noisy.service.bak
systemctl daemon-reload
systemctl mask noisy
systemctl is-enabled noisy    # masked
```

`disable --now` drops the wants symlink and stops the process while the file still exists, so the stop has a definition to act on. The `mv` frees the path. `daemon-reload` is required because systemd still has the old unit loaded; mask without it can race the old definition. `is-enabled` prints `masked`, and `start` fails. `unmask` removes the `/dev/null` symlink when you mean it.

A different cleanup, the failed-unit list after a bad one-shot, is `systemctl --failed` and then `reset-failed` once the unit is fixed or masked. An empty list is the done condition, not a green `status` on the one service you were staring at.

### Where it breaks

`disable` and a package upgrade that enables the unit again is the bug mask exists for. The upgrade script runs `systemctl enable`, the wants symlink comes back, and the legacy daemon is running after the next boot. mask survives that enable attempt because enable will not replace `/dev/null` with a wants link in the way people hope; a masked unit stays masked across the upgrade. The exception is the file-exists failure above, which leaves it not masked at all.

`set-default` does not change the running target. The machine is still in graphical until a reboot or an explicit `isolate`, and `isolate` stops units the new target does not want. Doing that on a live server can drop sessions. For a default-target fix, set the symlink and let the next planned reboot pick it up, unless you have a reason to isolate now.

A bad fstab line, or a required disk that is missing, is how you land in `emergency.target`: root may be read-only, and most services are not started. `journalctl -xb` shows this boot. The repair is the fstab line, then a reboot. Masking a random failed unit does not help if the failure is the mount that everything else needed.

### At work

The default target, the mask list and the failed list are small and worth being boring about. A fleet image sets `multi-user.target` and masks the gettys or the hardware daemons a cloud VM will never use, so boot does not wait on them. Incident review includes `systemctl --failed` from the snapshot, because a red backup unit during a traffic incident is either a clue or a distraction, and you cannot tell if you never looked. `critical-chain` is the tool when "SSH was slow after reboot" and blame's first line is a unit nobody was waiting on.

| Action | What it changes | What can still start the unit |
|---|---|---|
| `disable` | removes the boot symlink | a dependency, a timer, a person |
| `mask` | name points at `/dev/null` | nothing, until unmask |
| `set-default` | the next boot's target | not a running unit; this is not a stop |
| `reset-failed` | clears the failed state | the next start, if the cause remains |
| `isolate` | switches target now | stops units the new target does not want |

### You can now

- Set the default target to `multi-user.target` and say what that does not stop.
- Mask a unit, including one whose file already sits in `/etc/systemd/system`.
- Read `blame` and `critical-chain` as different questions, and clear `--failed` only after the cause is gone.

::: shell vm
task: This server boots to the wrong target and has a failed legacy unit. Set the default target to `multi-user.target`. `legacy-sync.service` is obsolete and must **never** be startable again, by anything. Clear the failed state so `systemctl --failed` lists nothing.
setup:
```bash
systemctl set-default graphical.target >/dev/null 2>&1
printf '[Service]\nExecStart=/bin/false\n[Install]\nWantedBy=multi-user.target\n' > /usr/lib/systemd/system/legacy-sync.service
systemctl daemon-reload
systemctl enable legacy-sync >/dev/null 2>&1
systemctl start legacy-sync || true
```
verify:
```bash
[ "$(systemctl get-default)" = multi-user.target ] || { echo "the default target is $(systemctl get-default)"; exit 1; }
[ "$(systemctl is-enabled legacy-sync 2>/dev/null)" = masked ] || { echo "legacy-sync isn't masked"; exit 1; }
! systemctl start legacy-sync 2>/dev/null || { echo "legacy-sync can still be started"; exit 1; }
[ -z "$(systemctl list-units --failed --plain --no-legend)" ] || { echo "there are still failed units:"; systemctl --failed --no-pager; exit 1; }
```
solution:
```bash
systemctl set-default multi-user.target
systemctl disable legacy-sync
systemctl mask legacy-sync
systemctl reset-failed
systemctl --failed
```
hint: `set-default`, then `mask` (after disabling), then `reset-failed`.
:::

::: quiz
q: You `systemctl disable`d an old service, but after a package upgrade it's running again. What prevents that?
- `systemctl stop`
+ `systemctl mask`, which links the unit to /dev/null so nothing can start it
- Deleting its log
- `systemctl reset-failed`
why: Disable only removes the boot links; a dependency, a socket or a package script can still start it. Masking blocks every start until you unmask.
:::

::: quiz
q: `systemctl mask noisy` prints that the unit file already exists, and `noisy.service` keeps running. The unit file is `/etc/systemd/system/noisy.service`, a regular file you deployed, not a package file under `/usr/lib`. Why does mask fail?
+ `mask` needs to create a symlink of that same path to `/dev/null`. A real unit file is already sitting there, so there is no free name for the symlink
- mask only works on units that have never been started
- The default target is graphical.target, and mask is ignored there
- `reset-failed` has to run before mask, or mask refuses
why: Masking is a symlink at `/etc/systemd/system/NAME.service` pointing at `/dev/null`. Package units live in `/usr/lib/systemd/system/`, so that `/etc` path is free. A unit you wrote directly in `/etc` occupies the path. Move the file away, `daemon-reload`, then mask. `disable` alone still leaves the unit startable.
:::

::: card
q: `systemd-analyze blame` says `db.service` took 40 seconds, and `critical-chain` shows the multi-user target waiting on it. Users could not SSH until then. What is the difference between those two reports?
answer: `blame` sorts units by how long each one took, even units that were not on the path that delayed the boot. `critical-chain` is the chain of dependencies that actually held the boot target. A slow unit that nothing waited for is in `blame` and not on the critical chain.
:::

::: shell vm
task: `noisy.service` is running and its unit file is a regular file at `/etc/systemd/system/noisy.service`. Mask it so nothing can start it, and stop it. A plain `systemctl mask` will fail until the file is out of the way. After you are done, `systemctl is-enabled noisy` must print `masked` and the unit must not be active.
setup:
```bash
printf '[Service]\nExecStart=/bin/sleep infinity\n[Install]\nWantedBy=multi-user.target\n' > /etc/systemd/system/noisy.service
systemctl daemon-reload
systemctl enable --now noisy
```
verify:
```bash
# Wrong fix: systemctl mask noisy while the real unit file still occupies /etc/systemd/system/noisy.service. mask errors with "File exists" and the sleep process keeps running.
[ "$(systemctl is-enabled noisy 2>/dev/null || true)" = masked ] || { echo "noisy is not masked (is-enabled: $(systemctl is-enabled noisy 2>&1 || true))"; exit 1; }
! systemctl is-active --quiet noisy || { echo "noisy is still active"; exit 1; }
[ -L /etc/systemd/system/noisy.service ] && [ "$(readlink -f /etc/systemd/system/noisy.service)" = /dev/null ] || { echo "/etc/systemd/system/noisy.service is not a symlink to /dev/null"; exit 1; }
! systemctl start noisy 2>/dev/null || { echo "noisy can still be started"; exit 1; }
```
solution:
```bash
systemctl disable --now noisy || true
mv /etc/systemd/system/noisy.service /root/noisy.service.bak
systemctl daemon-reload
systemctl mask noisy
```
hint: `mask` cannot replace a real file at that path. Move the unit file aside, `daemon-reload`, then `systemctl mask noisy`.
:::

## Performance: what's eating the machine
id: performance
stage: serve
needs: limits, linux/processes
minutes: 40
goal: Go from "the server is slow" to the guilty process and service, using load, CPU, memory and I/O views.
source: Brendan Gregg: Linux performance analysis in 60,000 milliseconds | https://netflixtechblog.com/linux-performance-analysis-in-60-000-milliseconds-accc10403c55
source: proc(5) | https://man7.org/linux/man-pages/man5/proc.5.html

"The server is slow" has four usual suspects: **CPU**, **memory**, **disk I/O**, and **waiting on something else** (a database, the network, a lock). The first minute of an investigation checks them in order:

| Command | Look for |
|---|---|
| `uptime` | load averages (1, 5, 15 min): runnable plus waiting tasks. Compare with `nproc`: a load of 8 on 2 CPUs means a queue |
| `top -b -n 1 \| head -20` | the busiest processes, and the `%Cpu` breakdown: `us` (programs), `sy` (kernel), `wa` (waiting for disk), `st` (stolen by the hypervisor) |
| `vmstat 1 5` | `r` run queue, `si`/`so` swapping (bad), `wa` I/O wait |
| `free -m` | memory; the **available** column, not "free", is what programs can still get |
| `iostat -xz 1 3` | per-disk `%util` and `await` (milliseconds per I/O) |
| `ps -eo pid,user,pcpu,pmem,comm --sort=-pcpu \| head` | top CPU users, in a form you can script |
| `ss -s`, `ss -tnp` | connection counts and which process holds them |

### From a process to a service

A PID isn't the answer; the **service** is what you'd stop, limit or report. Ways to get there:

- `ps -o unit= -p PID` prints the systemd unit of a process.
- `systemctl status PID` works too: it shows which unit the process belongs to.
- `systemd-cgtop` lists CPU and memory **per service**, live.

### Deeper, when the obvious views don't explain it

- `lsof -p PID` and `ls -l /proc/PID/fd`: what it has open (files, sockets).
- `strace -p PID -f -e trace=network,file`: which system calls it's stuck in. A process "doing nothing" at 0% CPU while requests time out is often blocked in `connect()` or `read()` on a slow dependency.
- `cat /proc/PID/status`: memory, threads, state.

### Fix, then prevent

Stopping the culprit is the fix. Prevention is a limit on the unit (`CPUQuota=`, `MemoryMax=`) or moving the job off-peak (a timer), plus an alert on the symptom (load or latency) so you hear about it before users do.

### Load is a queue, not a CPU percentage

The one-minute load average is the average number of tasks that were runnable or in uninterruptible sleep. Uninterruptible sleep is how Linux accounts disk wait: the task cannot be interrupted because it is inside a disk operation. A load of 6 on a 4-CPU machine means, on average, two tasks were waiting. It does not say whether they were waiting for CPU or for a disk. `nproc` is the denominator. Load equal to the CPU count is a busy machine. Load far above it is a queue. Load high while `top` shows idle CPUs and a high `wa` is a disk queue. The CPUs are idle because the tasks are stuck in the disk, and they still count.

`top`'s `%Cpu` line splits the time. `us` is user code, `sy` is the kernel on behalf of processes, `wa` is idle-because-of-IO, `st` is steal. Steal is time this virtual CPU was ready and the hypervisor ran someone else. A guest at 30% steal is slow because the host is crowded, and tuning the application does not give that time back. `vmstat 1 5` shows the run queue in `r` and swap in `si`/`so`. Swap activity during a complaint is memory pressure even when `free` looks calm.

`free -m` is easy to misread because Linux uses spare RAM as page cache. The `free` column is small on a healthy server. `available` is the estimate of what a new allocation can have without swapping, including cache the kernel can drop. Alerting on `free` pages people at 3am for a machine that is fine.

```text
slow
  |-- load high, CPU busy (us/sy)     -> a process is burning CPU; find the unit
  |-- load high, wa high, CPU idle    -> disk; iostat await and %util
  |-- available memory near 0, si/so  -> memory; a cgroup cap or a leak
  |-- CPU idle, state S, stuck read   -> waiting on another program, not on a core
  \-- st high                         -> the hypervisor took the CPU
```

A PID becomes a unit with `ps -o unit= -p PID` or `systemctl status PID`. Stopping a PID that a unit will restart is not a fix. `disable --now` on the unit is. `systemd-cgtop` skips the PID step and shows CPU and memory per unit. When the obvious CPU list is idle and requests still time out, `strace -p PID` showing `read` or `connect` on a socket means the process is in state `S`, interruptible sleep, waiting for a peer. That wait does not raise load the way disk wait does. The next question is the peer: a database, a lock, a DNS timeout.

### A worked minute on a different box

The complaint is "the API is slow" and the host has two CPUs.

```bash
uptime
nproc
top -b -n 1 | head -n 15
ps -eo pid,stat,pcpu,pmem,comm --sort=-pcpu | head
```

`uptime` says load 4.0. `nproc` says 2. `top` says `wa` is under 1 and `us` is near 100, so this is CPU, not disk. The first `ps` line is a `convert` process in state `R`. `ps -o unit= -p THAT_PID` prints `preview.service`. That unit is the one to stop, limit with `CPUQuota=`, or move off peak. A second scenario on the same commands: load 4, `wa` at 40, `us` near 0. Then `iostat -xz 1 3` and you look at `await` and `%util` instead of killing the top CPU process, because the top CPU process is not the queue.

### Where it breaks

Killing the busiest PID when it belongs to a unit with `Restart=always` brings it back under a new PID and the load never drops. The unit name was the missing step. `disable --now` stops and stays stopped.

Reading `free` and adding RAM, or paging someone, when `available` is large. The cache is doing its job. The exception is `available` near zero, or swap in `vmstat`, which is the real memory story.

Chasing CPU when the process is in `S` inside `read`. More CPUs do not make the peer faster. Steal has the same shape of mistake: the guest's tools look "fine" in `us` and the time is in `st`.

### At work

The first minute of a host incident is this split, written down, before a restart. Restarts hide the process you needed to name. Capacity planning uses load against `nproc`, `available` memory, and disk `await`, and it uses steal as a cloud-specific signal that the instance size or the host is wrong. The fix that prevents a repeat is a cgroup limit or a timer that moves the batch off the request path, plus an alert on latency rather than on "CPU was high once". A process at 0% CPU that times out is a dependency incident, and the host tools have done their job once they show you the socket.

| Observation | Likely queue | Next command |
|---|---|---|
| load > CPUs, `us` high | CPU | `ps -o unit=` on the busy pid |
| load > CPUs, `wa` high | disk | `iostat -xz` |
| `available` near 0, swap | memory | `systemctl status` and cgroup memory |
| state `S`, `read`/`connect` | another service | the peer on that socket |
| `%st` high | hypervisor | instance size or noisy neighbour |

### You can now

- Separate a CPU queue, a disk queue, a memory squeeze, steal, and a process waiting on a socket.
- Turn the busy PID into a unit name before you stop anything.
- Read `available` rather than `free`, and load relative to `nproc`.

::: shell vm
task: The machine is slow. One systemd service is burning CPU in a busy loop. Find **which service** it is, write its unit name (like `name.service`) to `/root/answer`, then stop it and make sure it won't start at boot. Leave the other services running.
setup:
```bash
mk() { printf '[Service]\nExecStart=%s\n[Install]\nWantedBy=multi-user.target\n' "$2" > "/etc/systemd/system/$1.service"; }
mk cache-warmer '/bin/sleep infinity'
mk report-builder '/bin/sh -c "while :; do :; done"'
mk metrics-agent '/bin/sh -c "while :; do sleep 2; done"'
systemctl daemon-reload
systemctl enable --now cache-warmer report-builder metrics-agent >/dev/null 2>&1
sleep 2
```
verify:
```bash
[ "$(tr -d ' \n' < /root/answer 2>/dev/null)" = report-builder.service ] || { echo "/root/answer doesn't name the CPU-burning service"; exit 1; }
! systemctl is-active --quiet report-builder || { echo "report-builder is still running"; exit 1; }
! systemctl is-enabled --quiet report-builder || { echo "report-builder is still enabled at boot"; exit 1; }
systemctl is-active --quiet cache-warmer && systemctl is-active --quiet metrics-agent || { echo "the other services should keep running"; exit 1; }
```
solution:
```bash
pid=$(ps -eo pid,pcpu --sort=-pcpu --no-headers | head -n 1 | awk '{print $1}')
ps -o unit= -p "$pid" | tr -d ' ' > /root/answer
systemctl disable --now "$(cat /root/answer)"
```
hint: `ps -eo pid,pcpu,comm --sort=-pcpu | head` finds the busy process; `ps -o unit= -p PID` names its service. `disable --now` stops it and removes it from boot.
:::

::: quiz
q: `uptime` shows a load average of 6.0 on a 4-CPU server, but `top` shows the CPUs mostly idle and a high `wa`. What's the bottleneck?
- CPU
+ Disk I/O: tasks waiting on I/O count towards the load average while the CPUs sit idle
- Memory
- The network card
why: Linux's load average counts runnable tasks and tasks in uninterruptible (disk) wait. High load with idle CPUs and high iowait points at storage; check `iostat -xz`.
:::

::: card
q: In `free -m`, why look at "available" rather than "free"?
answer: Linux uses spare memory as page cache, so "free" is always low on a healthy server. "available" estimates how much programs can still get, including reclaimable cache.
:::

::: quiz
q: A process is at 0% CPU in `top`, its state in `ps` is `S` (sleeping), and requests to it time out. `strace -p PID` shows it blocked in `read` on a TCP socket. Which resource is it waiting on?
+ Another program, over the network or a local socket. The CPU and the disk are not the queue it is stuck in
- The disk, because every sleep is iowait
- RAM, because a process with no CPU time is being swapped
- The run queue, because load average includes this process
why: State `S` is interruptible sleep: the process asked the kernel to wait for an event, here the next bytes on a socket. Disk wait shows up as state `D` and as `wa` in `top`. A sleeping network wait does not burn CPU and does not, by itself, raise the load average. The next place to look is the peer it is reading from.
:::

::: card
q: `top` shows `%st` (steal) around 30% and the guest's own `us`+`sy` well below a full CPU, while the application is slow. What does steal mean?
answer: The hypervisor gave this virtual CPU to someone else for that fraction of time. The guest was ready to run and was not scheduled on the host. Raising the guest's CPU limit, or moving it off a crowded host, is the fix. Tuning the application does not recover time the hypervisor took away.
:::

## Incident: the crash loop
id: fix-crashloop
stage: fix
needs: restarts, journal-real
minutes: 30
goal: Diagnose a service that won't stay up, from status and journal to the root cause, and fix it properly.
source: systemctl(1) | https://www.freedesktop.org/software/systemd/man/latest/systemctl.html
source: systemd.exec(5): process exit codes | https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html#Process%20Exit%20Codes

These incidents hand you a machine with a real problem and a symptom, the way an incident starts. The method is always the same, and worth saying out loud each time:

1. **Observe**: what exactly is wrong? `systemctl status`, `systemctl --failed`, `ss -tlnp`, `curl`, `df -h`.
2. **Find evidence**: `journalctl -u NAME -n 50 --no-pager` usually says why. Read the first error, not the last one; later errors are often consequences.
3. **Form one hypothesis**, change **one** thing, check again.
4. **Fix the cause**, not the symptom: "I restarted it and it's up" is not a fix if it crashes again in an hour.
5. **Prevent**: a config check, a limit, a monitor, a note for the team.

For a service that won't stay up, the usual causes, roughly in order of frequency: a wrong path or typo in `ExecStart` or a script's shebang, a missing execute bit, a missing config file or environment variable, a port already in use, permissions (the service user can't read or write something), and the program's own error (read its output).

`systemctl status` shows systemd's exit codes, and they point the way:

| Status | Means |
|---|---|
| `status=203/EXEC` | systemd couldn't execute the file at all: wrong path, no execute bit, or a broken `#!` line |
| `status=1/FAILURE` | the program ran and exited with 1, so its own log line is the clue |
| `status=217/USER` | the `User=` doesn't exist |
| `Failed to load environment files` | an `EnvironmentFile=` points at a missing file |

**The incident.** Users say the internal API on port 9000 is down. Nobody changed anything, of course. Make `api.service` run and stay running, serving on `127.0.0.1:9000`, by fixing whatever is actually wrong, not by working around it (don't replace the service with a different program).

### Setup failures happen before the program exists

A crash loop feels like the application is throwing. Often systemd never reached the application. The status line's code tells you which side failed. `203/EXEC` means `exec` failed: the path is missing, the file is not executable, or the shebang points at an interpreter that is not there. The program printed nothing, because it did not start. `217/USER` means `User=` or `Group=` does not resolve to an account. Creating the unit before `useradd`, or typoing the name, does this. Again the program did not start. `status=1/FAILURE` means the program did start and exited 1. That is the first time its own log line is the evidence. A missing `EnvironmentFile=` fails while systemd is building the environment, with "Failed to load environment files", and the program's "variable is unset" branch never runs. You can have both an environment-file failure and a bug in the script, and you will only see the second one after you fix the first.

The order of looking is fixed so you do not "fix" a healthy binary. `systemctl status NAME` for the code. `journalctl -u NAME -n 50 --no-pager` for the first error, not the last. Later lines are often the restart itself. Form one hypothesis, change one thing, start again. If the start limit has tripped ("start request repeated too quickly"), `reset-failed` before you conclude the new change did nothing. Watch `NRestarts` across a couple of seconds. A stable counter means it stayed up. A climbing counter means the loop is still there even if a request succeeded once.

```text
start
  |-- 217/USER          account missing     (program did not run)
  |-- 203/EXEC          path, mode, shebang (program did not run)
  |-- environment file  path missing        (program did not run)
  \-- status=1          program ran         (read its stderr in the journal)
then Restart=on-failure, until StartLimitBurst, then failed
```

Keeping the unit's `ExecStart` and `User=` is part of the repair when the brief says the program and the account are correct. Replacing the service with a different command makes the port answer and leaves the broken script for the next deploy to restore. `chmod 755` on a script that was deployed as 644 is a cause fix. Pointing `EnvironmentFile=` at the file that actually contains the variables is a cause fix. A drop-in that overrides `ExecStart` with a hand-written shell is a workaround.

### A worked diagnosis on a different unit

`billing.service` is flapping. Status says `217/USER`. The unit contains `User=billing`. `getent passwd billing` prints nothing. The binary mode is fine, and it does not matter yet.

```bash
useradd --system --shell /usr/sbin/nologin billing
systemctl reset-failed billing
systemctl start billing
```

If the next status is `203/EXEC`, the account was the first gate and the path is the second. `ls -l` the `ExecStart` path, check the mode, read the shebang. If the next status is a failure to load `/etc/billing/env` while the file on disk is `/etc/billing/settings`, change the unit to the path that exists and `daemon-reload`. Only when the status is `1/FAILURE` do you read the program's "port is unset" line and edit the file it wanted. Two gates, one at a time, is faster than rewriting the unit from memory.

### Where it breaks

Reading the last journal line. It says the start limit, or a restart, and the original `203` has scrolled up. `--no-pager` and an earlier `-n`, or `-p err` if the program set priorities, gets the first failure.

`chmod 777` on the script. The exec bit is what 203 cared about. World-writable means anyone on the box can change what root's unit runs, if the unit is root, or what the service user runs. `755` for a script, owned by root, is the usual repair. The service user does not need to own the script if it only needs to execute it.

Restarting in a loop by hand without `reset-failed`, deciding the fix is wrong, and reverting a correct chmod. The counter is systemd refusing, not the program crashing. `systemctl show -p Result` and the status text distinguish them.

### At work

On-call for a down service starts with the exit code table, not with a redeploy. A redeploy that does not fix the mode or the path reproduces the loop and burns the start limit again. The durable prevention is the deploy script checking that the user exists, that `ExecStart` is executable, and that every `EnvironmentFile=` path is present before it restarts. Those are cheap tests and they fail in the pipeline instead of at 3am. A restart policy without a start limit turns a bad deploy into a full disk via the journal, so the limit is part of the unit, not an afterthought.

| Code | Who failed | Where you look |
|---|---|---|
| `217/USER` | systemd, resolving the account | `getent passwd` the `User=` name |
| `203/EXEC` | systemd, exec | path, mode, shebang |
| environment file | systemd, before exec | the path in the unit versus `ls` |
| `1/FAILURE` | the program | its own line in the journal |
| start limit | systemd, after many failures | `reset-failed` after the cause is fixed |

### You can now

- Map 203, 217, a missing environment file, and exit 1 to the layer that failed.
- Change one cause at a time and use `reset-failed` plus a stable `NRestarts` as the proof.
- Leave `User=` and `ExecStart` in place when those were never the bug.

::: shell vm
task: Make `api.service` active and stable, answering on `http://127.0.0.1:9000/` with its page. Explore first (`systemctl status api`, `journalctl -u api`), then fix every cause.
setup:
```bash
useradd --system --shell /usr/sbin/nologin api
mkdir -p /opt/api/public
echo 'api ok' > /opt/api/public/index.html
printf '#!/bin/bash\ncd /opt/api/public\n[ -n "${API_PORT:-}" ] || { echo "api: API_PORT is not set" >&2; exit 1; }\nexec /usr/bin/python3 -m http.server "$API_PORT" --bind 127.0.0.1\n' > /opt/api/run.sh
chmod 644 /opt/api/run.sh
mkdir -p /etc/api
printf 'API_PORT=9000\n' > /etc/api/env
printf '[Unit]\nDescription=Internal API\n\n[Service]\nUser=api\nEnvironmentFile=/etc/api/environment\nExecStart=/opt/api/run.sh\nRestart=on-failure\nRestartSec=1\n\n[Install]\nWantedBy=multi-user.target\n' > /etc/systemd/system/api.service
systemctl daemon-reload
systemctl enable api >/dev/null 2>&1
systemctl start api || true
```
verify:
```bash
for i in $(seq 1 20); do curl -fsS http://127.0.0.1:9000/ 2>/dev/null | grep -q 'api ok' && break; sleep 0.25; done
systemctl is-active --quiet api || { echo "api isn't active"; systemctl status api --no-pager | head -n 10; exit 1; }
curl -fsS http://127.0.0.1:9000/ | grep -q 'api ok' || { echo "nothing answers 'api ok' on 127.0.0.1:9000"; exit 1; }
[ "$(systemctl show -p User --value api)" = api ] || { echo "the service should still run as the user api"; exit 1; }
grep -q '^ExecStart=/opt/api/run.sh' /etc/systemd/system/api.service || { echo "keep ExecStart=/opt/api/run.sh: fix the cause, don't swap the program"; exit 1; }
n1=$(systemctl show -p NRestarts --value api); sleep 2; n2=$(systemctl show -p NRestarts --value api)
[ "$n1" = "$n2" ] || { echo "api is still restarting"; exit 1; }
```
solution:
```bash
systemctl status api --no-pager | head -n 8
chmod 755 /opt/api/run.sh
sed -i 's#^EnvironmentFile=/etc/api/environment#EnvironmentFile=/etc/api/env#' /etc/systemd/system/api.service
systemctl daemon-reload
systemctl reset-failed api
systemctl restart api
sleep 1
systemctl status api --no-pager | head -n 5
```
hint: There's more than one cause. `systemctl status api` shows the exit status; `journalctl -u api -n 30` shows systemd's own complaints. Check the script's mode and every path in the unit.
:::

::: quiz
q: `systemctl status app` shows `code=exited, status=203/EXEC`. What does that point to?
+ systemd couldn't execute ExecStart: wrong path, no execute bit, or a broken #! line
- The program ran and returned an error
- The service user doesn't exist
- The program was OOM-killed
why: 203/EXEC is systemd's own code for "exec() failed". The program never ran, so its logs won't help; check the path, the mode and the interpreter line.
:::

::: quiz
q: `systemctl status billing` shows `status=217/USER`. The unit contains `User=billing`. The binary at `ExecStart` is mode 755 and its path is absolute. What is wrong?
+ The account `billing` does not exist, so systemd refuses to start the process. `useradd` (or fixing the `User=` name) is the fix. 217 is not an exec failure
- The binary's interpreter line is wrong, which is always reported as 217
- The process ran and exited 217, so the application log has the reason
- `EnvironmentFile=` is missing, which systemd reports as 217/USER
why: 217/USER means the uid or gid in the unit could not be resolved. The program never started, so its own logs are empty. 203/EXEC is the code for a bad path, a missing execute bit, or a broken shebang. A missing `EnvironmentFile=` is reported as a failure to load environment files, not as 217.
:::

::: card
q: A crash-looping service has `Restart=on-failure` and has hit "start request repeated too quickly". You fixed the config. `systemctl start` still does nothing useful. What extra step clears the counter?
answer: `systemctl reset-failed NAME` clears the start-limit counter and the failed state. Until you do that, systemd keeps refusing new starts. Then `daemon-reload` if the unit file changed, and start again. Watch `NRestarts` for a couple of seconds to prove it stayed up.
:::

::: quiz
q: A unit sets `EnvironmentFile=/etc/billing/settings` and that path does not exist. The program would also exit 1 if `BILLING_PORT` were unset. Which message do you expect from systemd, before the program runs?
+ `Failed to load environment files` (the unit never reaches exec of a successful start)
- `status=203/EXEC`, because a missing file is an exec error
- The program's own line `BILLING_PORT is not set`
- `status=217/USER`
why: systemd reads `EnvironmentFile=` while setting up the process. A missing file fails that setup, so the program does not run and cannot print its own "variable is unset" line. Point the setting at the real file, or create the file. 203 and 217 are different setup failures.
:::

## Incident: the port is taken
id: fix-port
stage: fix
needs: fix-crashloop, nginx-tls
minutes: 25
goal: Find which process holds a port, and resolve the conflict without breaking either service.
source: ss(8) | https://man7.org/linux/man-pages/man8/ss.8.html

`bind() to 0.0.0.0:80 failed (98: Address already in use)`: two programs want the same port, and only one can have it. The questions are **who** holds it and **who should**.

```bash
ss -tlnp                         # listening TCP sockets with the owning process
ss -tlnp 'sport = :80'           # just port 80
lsof -i :80                      # same question, another tool
```

`ss -tlnp` shows the state, the queues, the local address and port, the peer, and `users:(("python3",pid=1234,fd=3))`. From the PID, `ps -o unit= -p 1234` names the service.

Typical causes: two web servers installed (Apache and nginx), an old service nobody remembers, a dev server someone left running, or the same service started twice by different means (a unit and a manual `nohup`). The fix is a decision, not a command: move one to another port, or retire it. Killing the process works only until it restarts or the next reboot, so change the config of whatever shouldn't have the port.

**The incident.** nginx won't start after a migration, so the site is down. An old admin tool, `legacy-admin.service`, is still needed by one team and must keep running, just not on port 80. Move it to **port 8081** in its own unit, and get nginx serving its default page on port 80.

### A port is owned by a process, and the process is owned by a unit

`bind` fails with "address already in use" when some socket already has that address and port. The fix starts by naming the socket, not by restarting the thing that failed. `ss -tlnp` lists listening TCP sockets and, if you have permission, the process in `users:(("name",pid=1234,fd=6))`. `ss -tlnp 'sport = :80'` restricts the list to port 80. `lsof -i :80` is the same question with a different table. The PID is not the end. `ps -o unit= -p 1234` or `systemctl status 1234` names the unit systemd will restart. Killing the PID closes the socket and, if the unit has a restart policy, systemd starts a new process that binds the port again. The conflict is back in a second, with a new PID, and it looks like the kill did not work.

The decision is which program should own the port. Two listeners cannot share the same address and port (unless both were written to use `SO_REUSEPORT`, which is a deliberate sharing feature and not the situation a surprise conflict creates). Moving one service to another port, in its unit or its config file, survives the next start. Stopping one unit frees the port and also takes that service down. If the brief says both must keep running, stop is the wrong fix and a different port is the right one. Changing nginx's listen port and leaving the forgotten admin tool on 80 makes the site available on a non-standard port and leaves the conflict for the next person who expects 80.

```text
nginx fails: address already in use
        |
        v
ss -tlnp 'sport = :80'  -> pid
        |
        v
ps -o unit= -p PID      -> legacy-admin.service
        |
        +-- this unit should keep the port -> stop the other one, in its unit
        \-- this unit should move          -> edit its ExecStart/config, daemon-reload, restart it
                |
                v
        start nginx, curl both ports
```

"In its unit" matters because a runtime `ss` view disappears at restart. The file `/etc/systemd/system/legacy-admin.service` is what the next boot will run. `daemon-reload` before restart, or you restarted the old listen line. Then prove both ends: the public port serves the site, the moved port still serves the admin tool, and the unit file contains the new port so a reboot does not undo the afternoon.

IPv6 adds a second socket. A process can hold `*:80` on v4 and `[::]:80` on v6 as two lines in `ss`. Freeing only one of them leaves nginx failing, or leaves nginx bound to one family. Read the address column, not only the port.

### A worked split on a different pair

A metrics scraper and a temporary debug server both want port 9100. The scraper is the one that should keep it. The debug unit is `sample.service` and its `ExecStart` ends in `--port 9100`.

```bash
ss -tlnp 'sport = :9100'
ps -o unit= -p THE_PID
```

The unit is `sample.service`. Edit that unit so the argument is `--port 9101`, `daemon-reload`, `systemctl restart sample`. `ss` now shows different PIDs on 9100 and 9101. Start the scraper. A kill of the sample PID without the edit would have failed this test the moment the restart policy fired. A `systemctl stop sample` would have freed 9100 and failed the requirement that the debug server stay up.

### Where it breaks

Killing a PID and declaring victory. `ss` a second later shows a new PID from the same unit. The unit file still says the old port. The check that catches this is the file content plus a live socket, not a single `ss` taken in the gap.

Editing the failed service to a new port when it was the one that should have won. nginx on 8080 and the forgotten tool still on 80 matches "both are up" and fails "the site is on 80". Read the brief before you move the thing that failed. The failed start is a symptom of losing the race, not proof that it should be the one to move.

`ss` without `-p` shows the port and not the process, so you guess. `-p` needs enough privilege, which you have as root and which a normal user may not. `lsof` has the same privilege rule. Guessing "it must be apache" and purging a package is how a second service disappears that was not the listener.

A socket in `TIME_WAIT` does not block a new listen. People wait for `TIME_WAIT` to drain when the real holder is a live `LISTEN` line they did not filter for. `ss -tlnp` shows listeners only (`-l`). A `TIME_WAIT` line is from `-a` or from a non-listen listing, and it is not why bind failed.

### At work

Port conflicts show up during migrations: the old process and the new process overlap, or a host agent and a container both publish 80. The durable record is the unit or the container spec, not the PID. The same method works when the "unit" is a container runtime: find the pid, find the container, change the published port, recreate. Killing a container that a restart policy recreates is the same mistake as killing a service PID. On a shared dev box, `ss -tlnp` before you pick a port is cheaper than debugging a bind error in an application log that only says "exited".

| Situation | Change | Proof |
|---|---|---|
| Both must keep running | move one listen port in its unit | `ss` shows two ports, two units; the file contains the new port |
| One must go away | `disable --now` that unit | the port is free after a minute, not only immediately |
| You only killed a PID | nothing durable | a new PID owns the port |
| nginx should have 80 | the other unit moves | `curl` on 80 returns nginx, the other port returns the other app |
| Bind error, `ss` empty | not a listen conflict | check the address family and whether you are in the right network namespace |

### You can now

- Go from a port to a PID to a unit, and say why killing the PID is not a change.
- Move the service that should not own the port, in its unit, and prove both services afterwards.
- Ignore `TIME_WAIT` as an explanation for a failed bind when a `LISTEN` socket exists.

::: shell vm
task: Get nginx running and serving on port 80, and keep `legacy-admin.service` running, moved to port 8081 by changing its unit.
setup:
```bash
mkdir -p /srv/legacy && echo 'legacy admin' > /srv/legacy/index.html
printf '[Unit]\nDescription=Old admin tool\n\n[Service]\nWorkingDirectory=/srv/legacy\nExecStart=/usr/bin/python3 -m http.server 80 --bind 0.0.0.0\n\n[Install]\nWantedBy=multi-user.target\n' > /etc/systemd/system/legacy-admin.service
systemctl daemon-reload
systemctl enable --now legacy-admin >/dev/null 2>&1
sleep 1
systemctl enable nginx >/dev/null 2>&1
systemctl start nginx 2>/dev/null || true
```
verify:
```bash
for i in $(seq 1 20); do curl -s http://127.0.0.1:80/ 2>/dev/null | grep -qi 'welcome to nginx' && break; sleep 0.25; done
systemctl is-active --quiet nginx || { echo "nginx isn't running"; exit 1; }
curl -s http://127.0.0.1:80/ | grep -qi 'welcome to nginx' || { echo "port 80 doesn't serve nginx's page"; exit 1; }
systemctl is-active --quiet legacy-admin || { echo "legacy-admin must keep running"; exit 1; }
curl -s http://127.0.0.1:8081/ | grep -q 'legacy admin' || { echo "legacy-admin doesn't answer on 8081"; exit 1; }
grep -q 'http.server 8081' /etc/systemd/system/legacy-admin.service || { echo "change the port in legacy-admin's unit, so it survives a restart"; exit 1; }
```
solution:
```bash
ss -tlnp 'sport = :80'
sed -i 's/http.server 80 /http.server 8081 /' /etc/systemd/system/legacy-admin.service
systemctl daemon-reload
systemctl restart legacy-admin
systemctl restart nginx
sleep 1
ss -tlnp
```
hint: `ss -tlnp` shows who holds port 80. Change that service's port in its unit, reload and restart it, then start nginx.
:::

::: card
q: Which command shows the process listening on a TCP port, and how do you get from there to its service?
answer: `ss -tlnp` (or `lsof -i :PORT`) shows the PID in `users:((…,pid=…))`. `ps -o unit= -p PID` or `systemctl status PID` names the systemd unit.
:::

::: quiz
q: `ss -tlnp 'sport = :80'` shows `users:(("nginx",pid=991,fd=6))` and nginx is active. You `kill 991`. A second later port 80 is taken again by a new nginx pid. Why, and what actually frees the port?
+ The unit's `Restart=` (or the init system) started a new process from the same config. Change the unit, or stop the unit, so the new process does not bind port 80 again
- `kill` cannot stop a process that listens on a privileged port
- `ss` caches the old pid for about a minute
- Port 80 stays reserved until reboot once any process has bound it
why: The socket died with the process, and systemd started the unit again, which bound the port again. Killing a pid is not a configuration change. `systemctl stop` or a changed `ExecStart`/listen directive is what survives the next start.
:::

::: card
q: Two units both want to listen on TCP 443. You need both programs to keep running. What do you change, and which command proves the split?
answer: Move one listener to another port (or another address) in that program's own unit or config, `daemon-reload`, and restart that unit. `ss -tlnp` should then show different pids on the two ports. Stopping one unit would free 443 and would also take that service down, which is not the goal.
:::

::: quiz
q: `ss -tlnp` shows python on `0.0.0.0:80` and `ps -o unit= -p PID` prints `legacy-admin.service`. nginx is inactive and its error is `address already in use`. Which fix matches "keep the admin tool, serve the site on 80"?
+ Change the admin unit to a different port, restart that unit, then start nginx
- Disable nginx and leave the admin tool on port 80
- `kill` the python pid and start nginx, leaving the unit file on port 80
- Add `Restart=no` to nginx so it stops trying
why: The admin tool is still required, so it has to listen somewhere that is not port 80, and the unit file has to say so or the next restart takes 80 back. nginx is the service that should own 80. A kill without an edited unit races the restart.
:::

## Incident: disk full
id: fix-disk
stage: fix
needs: fix-crashloop, logrotate-real
minutes: 35
goal: Free space on a full filesystem without making it worse, and set up rotation so it can't recur.
source: lsof(8) | https://man7.org/linux/man-pages/man8/lsof.8.html
source: logrotate(8) | https://manpages.ubuntu.com/manpages/noble/man8/logrotate.8.html

`No space left on device`, and things start failing in odd ways: services can't write their logs or PID files, databases go read-only, even tab completion breaks. The method under pressure:

1. `df -h` (and `df -i`): which filesystem, and is it blocks or inodes?
2. `du -xh --max-depth=1 /that/mount | sort -h`: which directory, and keep going down.
3. Free space **safely**:
   - A log a running program writes to: **truncate** it (`: > file`, or `truncate -s 0 file`). Don't `rm` it: the program still holds it open, the blocks stay allocated, and `df` doesn't move.
   - Old dumps, core files, rotated logs: delete or move them.
   - `lsof +L1` lists deleted-but-still-open files, the "I deleted it and nothing changed" case.
4. Prevent: rotation with a **size** limit, a cap on the journal, and monitoring on disk usage (alert at 80%, not 100%).

**The incident.** `/var/log/app` is a small dedicated filesystem, and it's full. `chatty.service` writes its log there and must keep running. There's also an old memory dump nobody needs.

### Blocks, inodes, and names that are still open

"No space left on device" is one errno for two shortages. `df -h` shows blocks. `df -i` shows inodes. A filesystem can have lots of free bytes and zero free inodes when something created millions of tiny files: session files, mail, a cache that never expires. Truncating one large log frees blocks and almost no inodes. `du --inodes -xd 1 /the/mount` (or `du --inodes`) finds the directory. The fix is deleting files, not shrinking one of them.

When the shortage is blocks, `df -hT /the/path` names the filesystem, because a full tmpfs or a full `/var` is not a full `/`. `du -xh --max-depth=1` on that mount point shows which directory. `-x` stays on one filesystem so a large other disk mounted underneath does not hide the real consumer.

Deleting a name does not free blocks while a process still has the inode open. The directory entry is gone, so `ls` does not show the file, and the link count is zero, so `lsof +L1` lists it as deleted. `df` does not move. The process is writing into an inode with no name. Restarting the process closes the descriptor and frees the blocks, which is fine when a restart is allowed. When the process must keep the same PID, you cannot free a deleted inode out from under it. The move that works before you delete is truncate: `truncate -s 0 file` or `: > file` sets the size to zero, keeps the name, and the open descriptor (if it appends) continues at the start. `rm` was the wrong tool on a live log.

```text
df -h says full          df -i says full
      |                        |
      v                        v
du -xh --max-depth=1     find the many tiny files
      |
      +-- old core file, nobody has it open -> rm
      \-- live log, process still running
              |-- rm        -> space stays gone (lsof +L1), and you lost the name
              \-- truncate  -> space returns, PID unchanged, name remains
then logrotate, or the file grows back before the afternoon is over
```

Prevention is rotation with a size, not a promise to remember. `size 5M` rotates when logrotate runs and the file is already over 5M. `maxsize 5M` does that early rotation in addition to a daily schedule. `copytruncate` is the right partner for a process that will not reopen and that appends. `rotate 3` and `compress` bound the leftovers. A config that is never installed means the incident repeats. `logrotate -d` checks the file parses.

A full disk also breaks in ways that do not mention the disk: services cannot write a PID file, a database goes read-only, shell history and tab completion fail because they cannot write a temporary file. The errno is the clue once you look at `df` of the path they tried to write.

### A worked cleanup that keeps a PID

`/var/log/app` is a 20M tmpfs at 100%. `chatty.service` is appending to `chatty.log` and must not be restarted. `old-core-dump.bin` is 12M and nothing has it open.

```bash
df -hT /var/log/app
du -sh /var/log/app/*
cat /run/chatty.pid0    # the pid you must still see afterwards
rm -f /var/log/app/old-core-dump.bin
truncate -s 0 /var/log/app/chatty.log
```

`df` should fall well under half. `lsof +L1` should not list `/var/log/app`. The PID file matches `systemctl show -p MainPID`. Then a logrotate snippet for `/var/log/app/*.log` with `size 5M` or `maxsize 5M`, `rotate 3`, `compress`, `copytruncate`. Without that file, chatty fills the tmpfs again. Deleting `chatty.log` would have failed the "name still exists" check and, if the process holds the deleted inode, would have failed `df` as well.

### Where it breaks

`rm` on the live log, then confusion that `df` is cached. It is not cached. The blocks are held by the open file. `lsof +L1` shows the deleted path. Truncate was the tool, or a restart if you are allowed to close the descriptor.

Freeing `/` when the full filesystem is a mount on `/var/log/app`. You delete a large home directory, `df /` drops, the service still cannot write. `df` of the path in the error is the one that counts.

Inodes at 100% and a campaign to gzip logs. Gzip turns many files into fewer files only if you delete the originals. One huge file was never the inode problem. `df -i` before you pick a tool saves that hour.

copytruncate on a program that seeks instead of appending, after you have "fixed" the disk. The file becomes sparse, `df` climbs again with holes, and the new lines are not readable. That program needs a reopen, or a change to append, not another truncate.

### At work

Disk-full is a severity-1 incident because so many failures look unrelated. The runbook is `df -h` and `df -i`, then `du`, then truncate-or-delete with a rule about open files, then the rotation or the journal cap that should have existed. Alerts belong at 80%, not at 100%, because at 100% the thing that would send the alert may be the thing that cannot write. The same open-file fact shows up when a container's log driver fills the node: deleting the file inside the container does not free the node's blocks until the writer closes it.

| What is full | First evidence | Action that actually frees it |
|---|---|---|
| Blocks, old file, not open | `du` | `rm` |
| Blocks, live append-only log | `lsof` on that path | `truncate -s 0`, keep the PID |
| Blocks, deleted and still open | `lsof +L1` | restart the holder, if you may |
| Inodes | `df -i` | delete many files, not truncate one |
| Wrong filesystem | `df` of `/` looks fine | `df` the path that failed |

### You can now

- Tell a block shortage from an inode shortage, and a full mount from a full root.
- Free a live log without restarting the writer, and recognise a deleted-but-open file with `lsof +L1`.
- Leave a size-based logrotate config so the same file cannot fill the filesystem again.

::: shell vm
task: Free the space on `/var/log/app` so it's under half full, **without stopping or restarting** `chatty.service`, and without deleting its live log file (truncate it instead). Then add a logrotate config for `/var/log/app/*.log` that rotates when a file exceeds 5M (keep 3, compress, copytruncate), so this doesn't happen again.
setup:
```bash
mkdir -p /var/log/app
mount -t tmpfs -o size=20M,mode=0755 tmpfs /var/log/app
head -c 12M /dev/zero > /var/log/app/old-core-dump.bin
printf '#!/bin/bash\nexec >> /var/log/app/chatty.log 2>&1\nline=$(head -c 300 /dev/zero | tr "\\\\0" x)\nwhile :; do echo "$(date -Is) $line"; sleep 0.01; done\n' > /usr/local/bin/chatty.sh
chmod +x /usr/local/bin/chatty.sh
printf '[Service]\nExecStart=/usr/local/bin/chatty.sh\n' > /etc/systemd/system/chatty.service
systemctl daemon-reload && systemctl start chatty
for i in $(seq 1 60); do [ "$(df --output=pcent /var/log/app | tail -1 | tr -dc 0-9)" -ge 99 ] && break; sleep 0.25; done
systemctl show -p MainPID --value chatty > /run/chatty.pid0
```
verify:
```bash
systemctl is-active --quiet chatty || { echo "chatty isn't running"; exit 1; }
[ "$(systemctl show -p MainPID --value chatty)" = "$(cat /run/chatty.pid0)" ] || { echo "chatty was restarted; it had to keep running"; exit 1; }
[ -e /var/log/app/chatty.log ] || { echo "chatty.log is gone (truncate it, don't delete it)"; exit 1; }
! lsof +L1 2>/dev/null | grep -q '/var/log/app' || { echo "a deleted file is still held open on /var/log/app, so its space isn't free"; exit 1; }
use=$(df --output=pcent /var/log/app | tail -1 | tr -dc 0-9)
[ "$use" -lt 50 ] || { echo "/var/log/app is still ${use}% full"; exit 1; }
f=$(grep -ls '/var/log/app' /etc/logrotate.d/* | head -n 1)
[ -n "$f" ] || { echo "no logrotate config for /var/log/app/*.log"; exit 1; }
for d in 'rotate 3' compress copytruncate; do grep -Eq "^\s*$d\s*$" "$f" || { echo "logrotate config is missing: $d"; exit 1; }; done
grep -Eq '^\s*(size|maxsize)\s+5M\s*$' "$f" || { echo "rotate by size at 5M (size 5M or maxsize 5M)"; exit 1; }
logrotate -d "$f" >/dev/null 2>&1 || { echo "logrotate -d reports a problem in $f"; exit 1; }
```
solution:
```bash
df -h /var/log/app
du -sh /var/log/app/*
rm -f /var/log/app/old-core-dump.bin
truncate -s 0 /var/log/app/chatty.log
cat > /etc/logrotate.d/app <<'CONF'
/var/log/app/*.log {
    size 5M
    rotate 3
    compress
    missingok
    notifempty
    copytruncate
}
CONF
logrotate -d /etc/logrotate.d/app
df -h /var/log/app
```
hint: `df -h /var/log/app` and `du -sh /var/log/app/*` show what's there. One file can simply go. The live log must be truncated, not removed. Then a logrotate file with `size 5M`.
:::

::: quiz
q: You `rm` a 10 GB log on a full disk, but `df` still shows 100%. What's going on, and what fixes it?
- df caches its results; wait a minute
+ The writing process still holds the deleted file open, so its blocks stay allocated; truncate instead, or restart the process. `lsof +L1` finds such files
- rm only marks files for deletion at the next reboot
- The filesystem needs fsck
why: A file's space is freed when its last name is gone and no process has it open. Truncating keeps the name and frees the blocks immediately.
:::

::: quiz
q: `df -h` shows `/` at 40% and `df -i` shows inode use at 100%. Creating a small file fails with "No space left on device". Where is the space, and what do you look for?
+ The free bytes are fine. The inode table is full, usually because of a huge number of tiny files (caches, sessions, mail). Find the directory with `du --inodes` or `df -i`, then delete files. Truncating one big log does not free inodes
- The disk is out of blocks and `df -h` is cached
- A deleted log is still open, which fills inodes rather than blocks
- logrotate's `compress` uses one inode per byte
why: Each file consumes one inode, whatever its size. A filesystem can have free blocks and zero free inodes, and `creat` then fails with the same errno as a full disk. `df -h` does not show that. An open deleted file holds blocks, not a pile of inodes.
:::

::: card
q: `lsof +L1` shows `chatty` has `/var/log/app/chatty.log (deleted)` open, and `df` did not drop after `rm`. What do you do if the process must keep the same pid?
answer: You cannot free those blocks while that descriptor stays open, and you already removed the name. Restore a name only if you still need the content; otherwise the process has to be restarted, or you should have truncated the file (`truncate -s 0`) instead of deleting it. Truncate keeps the inode, frees the blocks, and the open descriptor writes into the now-empty file.
:::

::: quiz
q: A logrotate config uses `copytruncate` on a program that opened its log without `O_APPEND` and seeks to a saved offset. After rotation the file is huge and sparse, full of holes, while new lines seem to vanish. Why?
+ The program keeps writing at its old offset into the truncated file, so the gap becomes a hole and later readers see empty space until that offset. `copytruncate` is safe only for append writers. A program that can reopen should use `postrotate` instead
- `compress` expands the file
- `delaycompress` punches holes in `.1`
- `missingok` truncates at the wrong offset
why: Truncate sets the size to zero but does not change the file offset the process already has. Without append mode, the next write happens at the old offset and the kernel fills the gap with a hole. `postrotate` plus a reopen gives the process a new descriptor at the start of a new file.
:::

## Incident: name resolution
id: fix-dns
stage: fix
needs: fix-crashloop, linux/network
minutes: 25
goal: Trace how Linux resolves a hostname, and fix a wrong answer at the right layer.
source: nsswitch.conf(5) | https://man7.org/linux/man-pages/man5/nsswitch.conf.5.html
source: hosts(5) | https://man7.org/linux/man-pages/man5/hosts.5.html

When a program connects to `db.internal`, it doesn't ask DNS directly. It asks the C library, which follows **`/etc/nsswitch.conf`**:

```text
hosts: files dns
```

`files` first, meaning **`/etc/hosts`**, then DNS (through `/etc/resolv.conf`, on Ubuntu usually systemd-resolved's stub at 127.0.0.53). The first source that answers wins, and in `/etc/hosts` the **first matching line** wins.

That order explains a whole class of confusing incidents:

- `dig db.internal` and `nslookup` ask **DNS directly** and skip `/etc/hosts`. So `dig` shows the right address while the app connects to the wrong one, because a stale `/etc/hosts` line answers first for everything else.
- **`getent hosts db.internal`** goes through nsswitch exactly like your app does. When the question is "what will my program get?", use `getent`.
- Caches: systemd-resolved caches DNS answers (`resolvectl flush-caches`), and many runtimes cache too (the JVM, some HTTP clients). A fixed record may take a while to be seen.

On servers, `/etc/hosts` entries are handy for a quick override and dangerous when forgotten: months later someone changes the database IP in DNS, and one machine keeps the old address because of a line nobody remembers. Configuration management and comments (`# added for migration 2026-01, remove after`) keep them honest.

**The incident.** After the database moved to `10.20.30.40`, one server's app still fails to connect, and `dig` shows the right address. `/root/INFO` has the details.

### The first source that answers wins

A program that connects to a name does not talk to DNS itself. It calls the C library, which reads `/etc/nsswitch.conf` and walks the `hosts:` line. On Ubuntu that line is `files dns`. `files` means `/etc/hosts`. `dns` means the resolver named in `/etc/resolv.conf`, which on current Ubuntu is usually systemd-resolved's stub at `127.0.0.53`. The first source that returns an answer wins. Later sources are not asked. There is no merging of "all the addresses everyone knows".

Inside `/etc/hosts`, the first matching line wins for the same reason. A stale `10.20.30.4 db.internal` above a correct `10.20.30.40 db.internal` makes every program on that machine use the stale address. The second line is dead. `dig db.internal` and `nslookup` do not read nsswitch. They send a DNS query, so they show the address the DNS server has, which may be the new one, while the application still connects to the old one. That split is the incident. `getent hosts db.internal` walks nsswitch the way the application does. When the question is "what will this program get?", getent is the tool. dig answers a different question: "what does DNS say if I skip the hosts file?"

```text
getent hosts db.internal
    |
    v
nsswitch: files, then dns
    |
    +-- /etc/hosts has a line?  -> that address, stop
    |         first matching line only
    \-- otherwise DNS via 127.0.0.53
              |
              +-- systemd-resolved cache (TTL)
              \-- application cache (JVM, some HTTP clients), separate

dig db.internal  -> DNS only, ignores /etc/hosts
```

Caches sit on the DNS hop, not on the hosts file. `resolvectl flush-caches` drops resolved's cache. It does not reorder `/etc/hosts`, and it does not clear a JVM that cached the address at startup. A hosts line does not expire. A DNS TTL does. Flushing when the bad answer came from hosts changes nothing, which is a useful negative test: if flush did not help, look at the file again.

Overrides are sometimes what you want. One machine should use a new address before DNS is cut over. A single hosts line does that, with a comment that says who added it and when it must die. Leaving `hosts: files dns` in place keeps `localhost`. Replacing the line with `hosts: dns` breaks local names and is a much bigger change than one override. Pointing `resolv.conf` at the new database IP does not make that IP the answer for one name; it makes that IP a DNS server, which it is not.

### A worked stale line, different name

`/etc/hosts` contains:

```text
10.8.0.4 api.internal
10.8.0.50 api.internal
127.0.0.1 localhost
```

`dig api.internal` returns `10.8.0.50`. `getent hosts api.internal` returns `10.8.0.4`. The application times out to the old host. Delete only the first line:

```bash
getent hosts api.internal
sed -i '/^10\.8\.0\.4[[:space:]]\+api\.internal/d' /etc/hosts
getent hosts api.internal
```

The pattern is anchored at the start and includes the name, so a similar address (`10.8.0.40`) is not deleted by a sloppy `10.8.0.4` substring. `localhost` stays. After the edit, getent and the application agree with DNS. dig was never the broken tool; it was the tool that could not see the break.

### Where it breaks

Trusting dig because it is "the DNS tool" during an application incident. The application is not dig. The hour you spend on the authoritative server is wasted when a four-year-old hosts line is the answer. getent first, then dig if getent already shows the wrong DNS answer with no hosts line.

Flushing resolved and restarting the application when the hosts line remains. The application looks up again, nsswitch hits files, and the stale address returns. The restart was not useless forever — it clears an in-process cache — but it does not clear `/etc/hosts`.

A hosts line added "just for the weekend" with no comment. DNS moves on. This one machine keeps the old address, and the only symptom is that one box in the fleet fails. Configuration management that owns `/etc/hosts` makes the line visible in review. A comment with a date is the minimum when you are editing by hand.

Searching with a substring and deleting `10.20.30.40` because the pattern `10.20.30.4` matched the longer address. The bad line is gone and so is the good one, or only the good one is gone. Anchor the address and the name.

### At work

Per-host overrides are a migration tool and a permanent trap. The same split shows up in container images that bake a hosts file, in Kubernetes `hostAliases`, and in application-level resolvers that cache forever. The debugging rule stays: use the resolver the process uses, not a resolver you find more convenient. When DNS itself is wrong, dig and the authoritative server are the right tools, and getent will agree with them once files has no line. When only one machine is wrong, the hosts file and that machine's resolver cache are the first two places, before anyone opens a ticket with the DNS provider.

| Tool | Reads `/etc/hosts`? | Use it to answer |
|---|---|---|
| `getent hosts NAME` | yes, via nsswitch | what this machine's programs get |
| `dig NAME` | no | what DNS says |
| `resolvectl flush-caches` | no | drop the DNS cache, not a hosts line |
| first line in `/etc/hosts` | it is the file | the address files will return |
| a later line for the same name | ignored | nothing, until the earlier line is gone |

### You can now

- Predict getent from nsswitch and the first matching hosts line, and say why dig can disagree.
- Remove only the stale line without touching localhost or a longer address that shares a prefix.
- Decide when a flush will help (a DNS TTL) and when it will not (a hosts line, or an in-process cache).

::: shell vm
task: Make `getent hosts db.internal` return `10.20.30.40` (and only that) on this machine, by fixing the actual cause. Keep the other entries in `/etc/hosts` intact.
setup:
```bash
printf '# migration 2025-11: temporary override, remove afterwards\n10.20.30.4 db.internal\n10.20.30.50 cache.internal\n10.20.30.40 db.internal\n' >> /etc/hosts
printf 'The database now lives at 10.20.30.40 (db.internal). DNS is correct. This server still connects to the old address.\n' > /root/INFO
```
verify:
```bash
[ "$(getent hosts db.internal | awk '{print $1}')" = 10.20.30.40 ] || { echo "getent hosts db.internal says: $(getent hosts db.internal)"; exit 1; }
[ "$(getent ahostsv4 db.internal | awk '{print $1}' | sort -u)" = 10.20.30.40 ] || { echo "db.internal resolves to more than one address"; exit 1; }
grep -q '^10.20.30.50 cache.internal' /etc/hosts || { echo "cache.internal's entry should stay"; exit 1; }
grep -qE '^127\.0\.0\.1[[:space:]]+localhost' /etc/hosts || { echo "the localhost entry must stay"; exit 1; }
! grep -q '^10\.20\.30\.4[[:space:]]' /etc/hosts || { echo "the stale 10.20.30.4 line is still there"; exit 1; }
```
solution:
```bash
getent hosts db.internal
sed -i '/^10\.20\.30\.4[[:space:]]\+db\.internal/d' /etc/hosts
getent hosts db.internal
```
hint: Compare `getent hosts db.internal` with what `/etc/hosts` says. The first matching line wins. Delete exactly the stale line (with `sed -i '/pattern/d'`, anchoring the address so `10.20.30.40` doesn't match).
:::

::: quiz
q: `dig db.internal` returns the new address, but the application still connects to the old one. What's the most likely cause?
+ A stale entry in `/etc/hosts`, which the app consults before DNS but `dig` ignores
- dig uses IPv6
- The DNS server is wrong
- The application has no network access
why: Programs resolve through nsswitch (`files` before `dns`); `dig` queries DNS directly. `getent hosts NAME` shows what programs actually get.
:::

::: quiz
q: `/etc/nsswitch.conf` says `hosts: files dns`. `/etc/hosts` has no line for `api.internal`. `getent hosts api.internal` returns an address, and after you edit the DNS record the application still uses the old address for a few minutes. `dig` already shows the new one. What is caching, and what is not?
+ The resolver (systemd-resolved, or the application's own cache) is holding the old DNS answer. `/etc/hosts` is not involved, because it had no line. `resolvectl flush-caches` drops the resolved cache; a JVM or an HTTP client may keep its own until restart
- `getent` always reads `/etc/hosts` and ignores nsswitch
- `dig` writes the answer into `/etc/hosts`
- The first DNS server in `resolv.conf` is skipped when `files` is listed
why: `files` then `dns` means hosts is consulted first, and if it has no answer the lookup continues to DNS. A TTL cache sits in that DNS step. Flushing it does nothing to a hosts line, and a hosts line does not expire with a TTL. `dig` talks to DNS directly, so it never showed the hosts file and it also bypasses the nsswitch cache path the application uses.
:::

::: card
q: Two lines in `/etc/hosts` name `db.internal`, the stale address first and the new address second. `getent hosts db.internal` returns the stale one. You run `resolvectl flush-caches`. What changes?
answer: Nothing about that name. `files` is first in nsswitch, and the first matching hosts line wins, so DNS is never asked. Flushing the DNS cache does not reorder `/etc/hosts`. Delete the stale line. `dig` would have shown the DNS answer the whole time and would have hidden this.
:::

::: quiz
q: You need the application on this one machine to use `10.9.9.9` for `cache.internal` until a migration finishes, while every other name stays on DNS. What do you add, and what do you leave alone?
+ One `/etc/hosts` line for `cache.internal`, with a comment that says when to remove it. Do not set `hosts: dns` only, and do not delete the `localhost` lines
- A second `nameserver` line at the top of `/etc/resolv.conf` pointing at 10.9.9.9
- `ip route add 10.9.9.9 via cache.internal`
- An `OnCalendar=` timer that restarts the resolver
why: A hosts line is the per-machine override nsswitch will prefer. Pointing `resolv.conf` at the address does not make that address the answer for one name. Removing `files` from nsswitch would also break `localhost`. The comment is what stops the override from outliving the migration.
:::

## Incident: 403 Forbidden
id: fix-perms
stage: fix
needs: fix-crashloop, nginx-tls, linux/perms
minutes: 25
goal: Fix a permission problem with the smallest correct change: right owner, right mode, every directory on the path.
source: namei(1) | https://man7.org/linux/man-pages/man1/namei.1.html
source: nginx: Configuring the server to serve static content | https://docs.nginx.com/nginx/admin-guide/web-server/serving-static-content/

nginx answers **403 Forbidden** for a site whose files are right there. The usual cause is permissions, and the rule people forget: to read `/srv/site/index.html`, the nginx worker (user `www-data`) needs

- **read** (`r`) on the file, and
- **execute** (`x`) on **every directory on the path**: `/srv` and `/srv/site`. `x` on a directory means "may pass through it".

`namei -l /srv/site/index.html` lists the owner and mode of each component of a path, the fastest way to find the one directory that blocks traversal. nginx's error log names the exact file it couldn't open: `tail /var/log/nginx/error.log` (look for `permission denied`).

What **not** to do:

- `chmod -R 777`: everyone may write the site, including whatever gets into any process on the box. It "fixes" the 403 and creates a defacement waiting to happen.
- Make `www-data` own the files: then a compromised nginx can rewrite your site. The web server needs to **read**; a deploy user (or root) owns and writes.

The usual correct state: files `644` (rw-r--r--), directories `755` (rwxr-xr-x), owned by the deploy user or root. If the content must not be world-readable, give the group read access for `www-data` (`chgrp -R www-data`, `750` and `640`).

**The incident.** The new site at `/srv/site` returns 403.

### A path is a walk, and every step needs search

To open `/srv/site/index.html`, the kernel walks `/`, then `srv`, then `site`, then the file. On each directory it needs search permission, the `x` bit, for the uid that is walking. Read permission on a directory is a different bit: it lets you list the names. You can open a file you already know the name of with only `x` on the directories and `r` on the file. You cannot list the directory, and you cannot open the file, if any directory on the walk lacks `x`. The file's mode is never consulted if the walk failed on a parent. That is why a 644 file still returns 403 when `/srv/site` is mode 700 and the worker is not the owner.

nginx's worker runs as `www-data`. The owner of the site files is usually root or a deploy user. `www-data` therefore uses the "other" bits, unless the directory's group is `www-data` and the group bits allow it. The usual public site is directories `755` (`rwxr-xr-x`) and files `644` (`rw-r--r--`): the owner can write, everyone else can read files and traverse directories. `namei -l /srv/site/index.html` prints the mode of every component in one picture, which is faster than `ls` on each parent. nginx's error log says `permission denied` and names the path. The 403 is that line, not a mysterious application error.

```text
www-data opens /srv/site/index.html
    /            x   (root, almost always traversable)
    /srv         x
    /srv/site    x   mode 700 fails here: others have no x
    index.html   r   mode 644 is enough, once the walk arrives
write bit for others is never required
```

What not to do is as much the skill as the chmod. `chmod -R 777` grants write to every uid. Any process on the box can change the site, which turns a 403 into a defacement waiting for the next bug. `chown -R www-data` means a compromised worker can rewrite the files it is serving. The worker needs to read. The deploy user, or root, should be the one that can write. If the content must not be world-readable, put `www-data` in the group, `chgrp` the tree, and use `750` on directories and `640` on files. Others then have no access, and the worker still does, through the group bits.

A directory mode of `711` (`rwx--x--x`) lets the worker traverse and open a known name, and it does not let the worker list the directory. A request for a specific file can return 200 while an index listing returns 403. `755` adds the read bit. A mode of `644` on a directory is read without search, which still cannot be traversed. Copying the file's mode onto the directory is a common "make them match" mistake.

### A worked tree for a different root

`/var/www/shop` returns 403. `namei -l /var/www/shop/index.html` shows `/var/www` as 755 and `/var/www/shop` as `drwx------ root root`, files `600`.

```bash
namei -l /var/www/shop/index.html
find /var/www/shop -type d -exec chmod 755 {} +
find /var/www/shop -type f -exec chmod 644 {} +
```

`find -type d` and `-type f` are the whole trick. A recursive chmod that sets one mode puts `644` on directories or `755` on files. Files do not need to be executable to be served. Directories do need `x`. After the two finds, `www-data` can walk and read, nothing is world-writable (`find -perm -o+w` is empty), and `find -user www-data` is empty because you never chowned. Reload is unnecessary if the files were already the nginx root and only the mode changed; the next request walks again. If the error log still says permission denied, some parent above the tree you chmod'd is still missing `x`. `namei` includes those parents. The tree you were staring at was not the whole walk.

### Where it breaks

chmod 777, ticket closed, incident later. The 403 is gone and the write bit is the new bug. The review is `find /srv/site -perm -o+w`.

chown to `www-data` because "the web server has to own its files". It does not. Ownership is who may write. A static site's writer is the deploy, once. The worker reads on every request.

Fixing the file and not the directory, or the directory and not a parent. `/srv` at 700 with `/srv/site` at 755 still fails the walk on `/srv`. `namei` is how you see the parent you forgot. A symlink in the path adds the symlink's parent to the walk and, if you follow it, the target's parents too.

A file that is 644 and a directory that is 755 and a 403 that is not permissions at all: the nginx root is a different directory, or AppArmor/SELinux denied it. The error log distinguishes "permission denied" from "no such file". If it is permission denied and `namei` looks open to the world, the mandatory access control log is the next place, not another chmod.

### At work

Deploy pipelines set the mode in the same step that copies the files, so a 700 umask in the build agent does not ship to the server. The pipeline user owns the files. The web server's user is not in the deploy group unless you chose the 750/640 layout on purpose. The same walk applies to any daemon: a backup user that cannot traverse `/var/lib/app` fails the same way, and `777` is the same wrong fix. Incident notes that say "fixed permissions" should say the mode and the owner, because the next person needs to know you did not leave the tree writable.

| Mode | On a directory | On a file |
|---|---|---|
| 755 | owner writes, others can traverse and list | executable; not needed for a static asset |
| 644 | list without traverse; the walk fails | others can read; the usual asset |
| 711 | traverse a known name, no listing | not a useful file mode here |
| 700 | only the owner walks | only the owner reads; the worker gets 403 |
| 777 | everyone writes | everyone writes; do not leave this |

### You can now

- Walk a path the way the kernel does, and point at the directory whose missing `x` causes the 403.
- Set directories and files to different modes, leave the owner as root, and refuse world write.
- Use `namei -l` and the nginx error log instead of a recursive 777.

::: shell vm
task: Make `http://127.0.0.1/` return the site in `/srv/site` with status 200 (and its stylesheet at `/assets/site.css`), with the smallest correct permission change: nothing world-writable, and `www-data` must not own the files.
setup:
```bash
mkdir -p /srv/site/assets
echo '<h1>new site</h1>' > /srv/site/index.html
echo 'body{}' > /srv/site/assets/site.css
chown -R root:root /srv/site
chmod 700 /srv/site /srv/site/assets
chmod 600 /srv/site/index.html /srv/site/assets/site.css
printf 'server {\n    listen 80 default_server;\n    root /srv/site;\n    index index.html;\n}\n' > /etc/nginx/sites-available/site
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/site /etc/nginx/sites-enabled/site
systemctl enable --now nginx >/dev/null 2>&1
systemctl reload nginx
```
verify:
```bash
[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/)" = 200 ] || { echo "/ returns $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/)"; exit 1; }
curl -s http://127.0.0.1/ | grep -q 'new site' || { echo "the page isn't served"; exit 1; }
[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/assets/site.css)" = 200 ] || { echo "/assets/site.css isn't served"; exit 1; }
[ -z "$(find /srv/site -perm -o+w)" ] || { echo "something under /srv/site is world-writable"; exit 1; }
[ -z "$(find /srv/site -user www-data)" ] || { echo "www-data shouldn't own the site files"; exit 1; }
```
solution:
```bash
namei -l /srv/site/index.html
find /srv/site -type d -exec chmod 755 {} +
find /srv/site -type f -exec chmod 644 {} +
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/
```
hint: `namei -l /srv/site/index.html` and nginx's error log show what blocks it. Directories need `x` for others to pass through; files need `r`. `find … -type d` and `-type f` let you set them separately.
:::

::: quiz
q: Files are 644, but nginx still returns 403. `namei -l` shows `/srv/site` is `drwx------ root root`. Why?
- 644 files can't be served
+ www-data can't traverse the directory: directories need x (and r for listings) for whoever reads beneath them
- nginx must own the directory
- The index file must be executable
why: Reading a file requires search (x) permission on every directory in its path. 755 on the directories fixes it without granting write.
:::

::: quiz
q: `/srv/site/index.html` is mode 644, owned by root. `/srv` is mode 755. `/srv/site` is mode 711 (`rwx--x--x`). nginx (user `www-data`) returns 200 for `/` but 403 for a request that would list `/assets/`. What is 711 missing?
+ Directory read (`r`). Execute lets `www-data` traverse `/srv/site` when it already knows the file name. Listing the directory needs read on the directory as well
- The file needs to be executable
- `www-data` must own `/srv/site`
- The world-writable bit, because nginx writes its own cache into the site tree
why: On a directory, `x` is search (use a name you already have) and `r` is read (list the names). A static file URL does not need to list the directory, so 711 can still serve `/index.html`. An autoindex, or any open that has to scan the directory, needs `r` too. 755 adds that read bit without granting write.
:::

::: card
q: `chmod -R 777 /srv/site` makes the 403 go away. Why is that not the fix you leave in place?
answer: 777 grants write to every uid on the machine, so any process that is compromised can change the site. The web server only needs to read files and traverse directories. Root (or the deploy user) keeps ownership, directories are 755, files are 644. If the files must not be world-readable, use a group that includes `www-data` with 750 and 640 instead.
:::

::: quiz
q: `namei -l /srv/site/index.html` shows `/` and `/srv` as 755, `/srv/site` as `drwx------ root root`, and the file as 644. nginx's error log says permission denied. Which single change matches the smallest correct fix?
+ `chmod 755 /srv/site` so `www-data` can traverse it. Leave the owner as root and do not add write for others
- `chown www-data /srv/site/index.html`
- `chmod 777 /srv/site/index.html` only
- `chmod 644 /srv/site`, because the file is 644 and the directory should match
why: The walk fails on `/srv/site`: others have no `x`, so `www-data` cannot pass through, and the file mode is never consulted. 755 on that directory adds traverse and list for others. 644 on a directory is `r` without `x`, which still cannot be traversed. Giving `www-data` ownership lets a compromised worker rewrite the page.
:::

## Project: a production-style server
id: p-server
stage: fix
needs: fix-disk, fix-perms, fix-port, fix-dns, timers-real, logrotate-real, access, firewall
minutes: 90
project: yes
goal: Build a complete, hardened server for an app from a fresh machine, in one reproducible script.
source: Ubuntu Server: Security suggestions | https://documentation.ubuntu.com/server/explanation/security/security-suggestions/

Everything in this module, on one machine, written as **one script** you could run on any fresh Ubuntu server. That's the real deliverable: not a server you configured by hand, but the instructions that produce it, which is exactly what Ansible, Terraform and Dockerfiles take further.

**The brief.** Set up the "notes" app on a fresh machine:

1. **Packages**: install `jq` (the app's health script needs it).
2. **App user and files**: a system user `notes` with no login shell. App files in `/srv/notes` with an `index.html` containing `notes app`, owned by root and readable by everyone (directories 755, files 644).
3. **App service** `notes.service`: runs `/usr/bin/python3 -m http.server 8080 --bind 127.0.0.1` in `/srv/notes` **as notes**, restarts on failure, open-files limit 65536, memory capped at 256M, enabled at boot.
4. **Reverse proxy**: nginx for the host `notes.local`: HTTPS on 443 with a self-signed certificate (SAN `DNS:notes.local`, key mode 600) proxying to the app with `Host` and `X-Forwarded-Proto` set; HTTP 80 redirects (301) to HTTPS; the default site disabled; nginx enabled.
5. **Firewall**: nftables, an inet table with input policy drop, accepting established/related, loopback, ICMP, and TCP 22, 80 and 443; enabled at boot.
6. **Access**: a user `deploy` with bash and a home, allowed only `systemctl restart notes` through sudo without a password (validated). SSH hardened with a drop-in: no passwords, no keyboard-interactive, no root login.
7. **Logs and backups**: logrotate for `/var/log/notes/*.log` (daily, keep 14, compress, delaycompress, missingok, notifempty, copytruncate). A `notes-backup.timer` running `notes-backup.service` (a oneshot that runs `tar -czf /var/backups/notes-DATE.tar.gz -C /srv notes`, through a small script) daily at 02:30, persistent, enabled.

**How it's graded.** The check inspects the real machine: services active and enabled, the effective sshd settings, the loaded nftables ruleset, sudo rules, file modes and owners, HTTPS responses and the redirect, timer schedules, logrotate's dry run, and a real backup run. It doesn't look at your output. It reports the first part that doesn't hold, by number.

**How to work.** Build it a part at a time. Each run starts fresh, so keep the whole script growing in the editor and re-run all of it; when the check moves past a part, go on to the next. Reuse your earlier exercises: this is all of them together. Put `set -euo pipefail` at the top, so the first failing command stops the script where you can see it.

### One script, in an order the machine will accept

A production-shaped host is the same pieces you already know, run as one script, on a machine that starts empty. The script is the deliverable. The running processes are a result. If a step only lives in your shell history, the next fresh machine does not have it, and neither does a colleague. `set -euo pipefail` at the top makes the first failing command stop the script on the line that failed, which is a better debugger than a host that is half configured and still exit 0.

Order is dependency, not taste. The system user has to exist before a unit with `User=notes` starts, or the start is `217/USER` and the program never runs. The working directory and the files have to exist before that start, or the `chdir` fails. The certificate files have to exist before `nginx -t`, because the test opens `ssl_certificate` and `ssl_certificate_key`. A test that runs too early fails, and `nginx -t && systemctl reload nginx` then skips the reload. The nftables file has to pass `nft -c -f` before `nft -f`, so a typo does not replace a working ruleset. The sudoers drop-in has to be mode `0440` before you trust it; sudo ignores a file that group or others can write, and `sudo -l` then shows nothing while the text looks correct. `visudo -cf` checks syntax and does not check the mode. Both checks belong in the script. `daemon-reload` comes after the unit files are written and before `enable --now`, or enable starts the previous definition.

```text
packages
  -> user and files
      -> unit file
          -> certificate, then nginx -t, then enable
          -> nft -c, then nft -f, then enable nftables
          -> sudoers mode 0440 and visudo
          -> sshd drop-in, sshd -t
          -> logrotate file
          -> oneshot service, then the timer, enable the timer
      -> daemon-reload
          -> enable --now the units that should survive reboot
```

The timer and the service are a pair. The service is `Type=oneshot` and has no `[Install]` section, so boot does not start a backup on its own. The timer has `OnCalendar=` and `WantedBy=timers.target`, and it is the unit you enable. `Persistent=true` catches one missed run if the machine was off at 02:30. It does not prove the script works. `systemctl start notes-backup.service` once, and a tar file appearing under `/var/backups`, is the proof. Enabling the timer and never starting the service leaves a schedule you have not seen succeed.

The firewall and the proxy have to agree. nftables accepts 22, 80 and 443 and drops the rest. The application listens on 127.0.0.1:8080, which is loopback, and the input chain accepts loopback, so the proxy can reach the app without a public 8080. Publishing 8080 in nftables would bypass nginx and the TLS termination you just configured. SSH hardening is a drop-in, checked with `sshd -T`, and it does not replace the sudo rule. `deploy` can restart one unit, not administer the host. A rule of `ALL` would make the rest of the lockdown decorative.

### A worked order for a smaller cousin

A "status" host that is not the notes app still follows the same gates. Create the user `status` before writing `status.service`. Write the key under `/etc/ssl/status/` and `chmod 600` before `nginx -t`. Run `nft -c -f` before `nft -f`. Write `/etc/sudoers.d/status-deploy` at `0440` and run `visudo -cf` before any later step assumes sudo works. Reload systemd once, near the end, after every unit file exists, then `enable --now` the service, the timer and nftables, and reload nginx last so it proxies to a port that is already listening. Start the backup service once by hand. If any gate fails, the script stops at that gate instead of installing a firewall that drops you and a web server that never started.

### Where it breaks

`enable --now` halfway through, before the certificate exists. nginx fails, the script continues if you forgot `set -e`, and the later `nginx -t` is green while the running process is still the old failed start. Enable after the files exist, or restart after the test.

A sudoers file at the default umask, often `0644`. The rule is correct and sudo skips it. The next debugging step is `stat` on the file, not a rewrite of the rule. `chmod 0440` in the script, every time, because `echo > file` uses the umask.

Enabling `notes-backup.service` because "the backup should be enabled". It then runs at boot and also on the timer, or it fails to enable because there is no `[Install]`. The timer is the enabled unit. The service is what you start for a test.

Opening TCP 8080 in the firewall "so I can curl the app from my laptop". You can, and so can everyone else, without TLS and without the headers the app expects. Curl from the host to 127.0.0.1:8080 for the direct check, and curl `--resolve` to 443 for the real path.

### At work

This script is the smallest version of what Ansible, a cloud-init file, or an image build does. The value is that a new machine is reproducible and a broken machine can be replaced instead of nursed. The checks at the end are the same checks a reviewer would run by hand: package status, the user id, a real HTTP response, `sshd -T`, `nft list ruleset`, `sudo -l`, a forced backup, a logrotate dry run. If those pass, the host matches the brief. If they pass only because you looked at the script's output and not at the machine, they do not pass. Later automation wraps this same order in modules. It does not get to skip the order.

| Gate | If you skip it | What you see |
|---|---|---|
| user before the unit | `217/USER` | the program never starts |
| certificate before `nginx -t` | the test fails | reload does not run |
| `nft -c` before `nft -f` | a bad ruleset can load | SSH replies die if established was omitted |
| mode `0440` and `visudo` | sudo ignores the file, or nobody can sudo | `sudo -l` is empty or sudo is broken |
| `daemon-reload` before enable | the old unit starts | edits look ignored |
| enable the timer, start the service once | a schedule nobody has seen succeed | no archive in `/var/backups` |

### You can now

- Put user, files, unit, certificate, nginx, firewall, sudo, sshd, logrotate and a timer into one script in an order each step can survive.
- Say which unit is enabled for a scheduled job, and why you still start the oneshot once.
- Name the check that proves each gate (status codes, `sshd -T`, `nft list ruleset`, `sudo -l`, a real archive), not the script's own echo.

::: shell vm
task: Write the whole setup as one script and run it. All seven parts of the brief must hold at the end.
verify:
```bash
fail() { echo "$1"; exit 1; }
dpkg-query -W -f='${Status}' jq 2>/dev/null | grep -q 'install ok installed' || fail "part 1: jq isn't installed"
id notes >/dev/null 2>&1 || fail "part 2: no user notes"
case "$(getent passwd notes | cut -d: -f7)" in /usr/sbin/nologin|/bin/false|/sbin/nologin) ;; *) fail "part 2: notes shouldn't have a login shell" ;; esac
grep -q 'notes app' /srv/notes/index.html 2>/dev/null || fail "part 2: /srv/notes/index.html is missing"
[ -z "$(find /srv/notes -perm -o+w)" ] && [ -z "$(find /srv/notes ! -user root)" ] || fail "part 2: /srv/notes should be owned by root and not world-writable"
for i in $(seq 1 20); do curl -fsS http://127.0.0.1:8080/ 2>/dev/null | grep -q 'notes app' && break; sleep 0.25; done
systemctl is-active --quiet notes && systemctl is-enabled --quiet notes || fail "part 3: notes.service must be active and enabled"
pid=$(systemctl show -p MainPID --value notes)
[ "$(ps -o user= -p "$pid" | tr -d ' ')" = notes ] || fail "part 3: notes.service must run as notes"
[ "$(systemctl show -p Restart --value notes)" = on-failure ] || fail "part 3: Restart=on-failure"
grep 'Max open files' "/proc/$pid/limits" | grep -q 65536 || fail "part 3: open-files limit 65536"
[ "$(systemctl show -p MemoryMax --value notes)" = "$((256 * 1024 * 1024))" ] || fail "part 3: MemoryMax=256M"
nginx -t 2>/dev/null && systemctl is-active --quiet nginx && systemctl is-enabled --quiet nginx || fail "part 4: nginx must pass nginx -t, run, and be enabled"
for i in $(seq 1 12); do curl -sk --resolve notes.local:443:127.0.0.1 https://notes.local/ 2>/dev/null | grep -q 'notes app' && break; sleep 0.25; done
curl -sk --resolve notes.local:443:127.0.0.1 https://notes.local/ | grep -q 'notes app' || fail "part 4: https://notes.local/ doesn't show the app"
[ "$(curl -s -o /dev/null -w '%{http_code}' --resolve notes.local:80:127.0.0.1 http://notes.local/)" = 301 ] || fail "part 4: http://notes.local/ should redirect with 301"
[ ! -e /etc/nginx/sites-enabled/default ] || fail "part 4: disable the default site"
key=$(grep -Rhs 'ssl_certificate_key' /etc/nginx/sites-enabled/ | awk '{print $2}' | tr -d ';' | head -n 1)
[ -n "$key" ] && [ "$(stat -c %a "$key")" = 600 ] || fail "part 4: the TLS key must be mode 600"
crt=$(grep -Rhs 'ssl_certificate ' /etc/nginx/sites-enabled/ | awk '{print $2}' | tr -d ';' | head -n 1)
openssl x509 -in "$crt" -noout -ext subjectAltName 2>/dev/null | grep -q 'DNS:notes.local' || fail "part 4: the certificate's SAN must be DNS:notes.local"
grep -Rqs 'X-Forwarded-Proto' /etc/nginx/sites-enabled/ && grep -Rqs 'proxy_set_header Host' /etc/nginx/sites-enabled/ || fail "part 4: set Host and X-Forwarded-Proto"
r=$(nft list ruleset)
echo "$r" | grep -q 'table inet' && echo "$r" | grep -A2 'hook input' | grep -q 'policy drop' || fail "part 5: an inet table with input policy drop"
echo "$r" | grep -q 'ct state established,related accept' && echo "$r" | grep -q 'iif "lo" accept' || fail "part 5: accept established/related and loopback"
echo "$r" | grep -Eq 'tcp dport \{ 22, 80, 443 \} accept' || fail "part 5: accept TCP 22, 80 and 443"
systemctl is-enabled --quiet nftables || fail "part 5: enable nftables at boot"
visudo -c >/dev/null 2>&1 || fail "part 6: sudoers doesn't validate"
l=$(sudo -l -U deploy 2>/dev/null)
echo "$l" | grep -q 'NOPASSWD: /usr/bin/systemctl restart notes' || fail "part 6: deploy may restart notes without a password"
! echo "$l" | grep -qE '\(ALL( : ALL)?\) (NOPASSWD: )?ALL' || fail "part 6: deploy must not have full sudo"
[ "$(getent passwd deploy | cut -d: -f7)" = /bin/bash ] && [ -d /home/deploy ] || fail "part 6: deploy needs bash and a home"
mkdir -p /run/sshd; t=$(sshd -T 2>/dev/null)
for s in 'passwordauthentication no' 'kbdinteractiveauthentication no' 'permitrootlogin no'; do echo "$t" | grep -qx "$s" || fail "part 6: the effective sshd setting should be: $s"; done
f=$(grep -ls '/var/log/notes' /etc/logrotate.d/* | head -n 1)
[ -n "$f" ] || fail "part 7: no logrotate config for /var/log/notes"
for d in daily 'rotate 14' compress delaycompress missingok notifempty copytruncate; do grep -Eq "^\s*$d\s*$" "$f" || fail "part 7: logrotate needs $d"; done
logrotate -d "$f" >/dev/null 2>&1 || fail "part 7: logrotate -d reports a problem"
systemctl is-enabled --quiet notes-backup.timer && systemctl is-active --quiet notes-backup.timer || fail "part 7: notes-backup.timer must be enabled and active"
systemctl show -p TimersCalendar --value notes-backup.timer | grep -q '02:30:00' || fail "part 7: the backup runs at 02:30"
[ "$(systemctl show -p Persistent --value notes-backup.timer)" = yes ] || fail "part 7: Persistent=true"
[ "$(systemctl show -p Type --value notes-backup.service)" = oneshot ] || fail "part 7: notes-backup.service is a oneshot"
systemctl start notes-backup.service && ls /var/backups/notes-*.tar.gz >/dev/null 2>&1 || fail "part 7: running notes-backup.service doesn't produce /var/backups/notes-DATE.tar.gz"
echo "all seven parts hold"
```
solution:
```bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
# 1 packages
apt-get update -q && apt-get install -y -q -o Acquire::Retries=5 jq
# 2 user and files
useradd --system --shell /usr/sbin/nologin --home-dir /srv/notes notes
mkdir -p /srv/notes /var/log/notes
echo 'notes app' > /srv/notes/index.html
chown -R root:root /srv/notes
find /srv/notes -type d -exec chmod 755 {} +
find /srv/notes -type f -exec chmod 644 {} +
# 3 service
printf '[Unit]\nDescription=Notes app\nAfter=network.target\n\n[Service]\nUser=notes\nWorkingDirectory=/srv/notes\nExecStart=/usr/bin/python3 -m http.server 8080 --bind 127.0.0.1\nRestart=on-failure\nLimitNOFILE=65536\nMemoryMax=256M\n\n[Install]\nWantedBy=multi-user.target\n' > /etc/systemd/system/notes.service
# 4 TLS and nginx
mkdir -p /etc/ssl/notes
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -keyout /etc/ssl/notes/notes.key -out /etc/ssl/notes/notes.crt -subj "/CN=notes.local" -addext "subjectAltName=DNS:notes.local" 2>/dev/null
chmod 600 /etc/ssl/notes/notes.key
cat > /etc/nginx/sites-available/notes.local <<'CONF'
server {
    listen 80;
    server_name notes.local;
    return 301 https://$host$request_uri;
}
server {
    listen 443 ssl;
    server_name notes.local;
    ssl_certificate     /etc/ssl/notes/notes.crt;
    ssl_certificate_key /etc/ssl/notes/notes.key;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
CONF
ln -sf /etc/nginx/sites-available/notes.local /etc/nginx/sites-enabled/notes.local
rm -f /etc/nginx/sites-enabled/default
# 5 firewall
cat > /etc/nftables.conf <<'CONF'
#!/usr/sbin/nft -f
flush ruleset
table inet filter {
  chain input {
    type filter hook input priority 0; policy drop;
    ct state established,related accept
    iif "lo" accept
    ct state invalid drop
    ip protocol icmp accept
    ip6 nexthdr icmpv6 accept
    tcp dport { 22, 80, 443 } accept
  }
  chain forward {
    type filter hook forward priority 0; policy drop;
  }
  chain output {
    type filter hook output priority 0; policy accept;
  }
}
CONF
nft -c -f /etc/nftables.conf && nft -f /etc/nftables.conf
# 6 access
useradd --create-home --shell /bin/bash deploy
echo 'deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart notes' > /etc/sudoers.d/deploy
chmod 0440 /etc/sudoers.d/deploy
visudo -cf /etc/sudoers.d/deploy
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\n' > /etc/ssh/sshd_config.d/50-hardening.conf
mkdir -p /run/sshd && sshd -t
# 7 logs and backups
printf '/var/log/notes/*.log {\n    daily\n    rotate 14\n    compress\n    delaycompress\n    missingok\n    notifempty\n    copytruncate\n}\n' > /etc/logrotate.d/notes
printf '#!/bin/bash\nset -euo pipefail\ntar -czf "/var/backups/notes-$(date +%%F).tar.gz" -C /srv notes\n' > /usr/local/bin/notes-backup.sh
chmod 755 /usr/local/bin/notes-backup.sh
printf '[Unit]\nDescription=Back up the notes app\n\n[Service]\nType=oneshot\nExecStart=/usr/local/bin/notes-backup.sh\n' > /etc/systemd/system/notes-backup.service
printf '[Unit]\nDescription=Nightly notes backup\n\n[Timer]\nOnCalendar=*-*-* 02:30:00\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n' > /etc/systemd/system/notes-backup.timer
# start everything
systemctl daemon-reload
systemctl enable --now notes nftables notes-backup.timer
nginx -t && systemctl enable --now nginx && systemctl reload nginx
echo done
```
hint: Go part by part, reusing your earlier solutions (units, nginx-tls, firewall, access, logrotate-real, timers-real).
:::

::: quiz
q: In a provisioning script, `nginx -t` runs before the self-signed certificate files exist. What happens, and why is the certificate created first?
+ `nginx -t` fails because `ssl_certificate` points at a path that is not there yet, so the reload never happens and the site stays on the old config (or nginx never starts). Write the key and certificate, `chmod 600` the key, then `nginx -t`
- nginx generates a temporary certificate and continues
- `nginx -t` only checks syntax, not whether the certificate files exist
- The failure is reported as a systemd 203/EXEC on the notes service
why: The config test opens the certificate and key. A missing file is a failed test, and `nginx -t && systemctl reload nginx` then skips the reload. The app unit does not need the certificate; nginx does. Creating the files first makes the test able to pass.
:::

::: card
q: The notes unit contains `User=notes`, and the script enables the unit before `useradd`. The unit fails with `status=217/USER`. Why does the order matter?
answer: systemd resolves `User=` when the service starts. If the account does not exist yet, the start fails with 217/USER and the program never runs. Create the system user first, then write the unit, `daemon-reload`, and enable. The same ordering applies to any path the unit uses: the working directory and the program must exist before the start.
:::

::: quiz
q: A sudoers drop-in for `deploy` is mode 0666, and the rule text is otherwise correct (`NOPASSWD` only for `/usr/bin/systemctl restart notes`). `sudo -l -U deploy` does not list the command. Why?
+ sudo ignores drop-ins that are writable by group or others. Mode `0440` (or `0400`) is required, and `visudo -cf` should be how you check the syntax before you depend on the rule
- NOPASSWD is illegal for systemctl
- The deploy user must be in group sudo before a drop-in applies
- `sudo -l` only shows rules from `/etc/sudoers`, never from `sudoers.d`
why: A world-writable sudoers file could be edited by anyone, so sudo refuses it. The rule never loads, which looks like "sudo is broken" when the text is fine. `visudo -c` checks syntax; the mode is a separate check (`stat`).
:::

::: card
q: The backup timer unit is enabled and active, and `notes-backup.service` has no `[Install]` section. Why is that the right split, and what still has to happen once before you trust the script?
answer: Enable the timer (`WantedBy=timers.target`), not the service. The service is a oneshot the timer starts; an `[Install]` on it would also start it at boot, which you do not want. `Persistent=true` covers a missed 02:30 only after the timer has been running. Start the service once by hand to prove the tar archive appears under `/var/backups`.
:::

::: quiz
q: You load an nftables ruleset with `nft -f` and skip `nft -c -f`. The file has a typo in the input chain. What is the safer order, and what does the check buy you?
+ `nft -c -f` parses the file and does not install it. A typo fails there, and the kernel keeps the previous ruleset. Only then `nft -f`, which replaces the ruleset atomically
- `nft -f` rolls back a syntax error automatically, so `-c` is only for documentation
- A syntax error disables the firewall until reboot, which is safe
- `systemctl enable nftables` is what parses the file, so a manual load does not matter
why: `-c` is a dry run. Applying a bad file can leave you with a partial idea of what you typed and, on a remote host, can drop the SSH reply path if you also forgot established/related. Check, then apply, then `systemctl enable nftables` so the same file loads at boot. `nft list ruleset` is the proof of what is active.
:::
