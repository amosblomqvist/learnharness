# Prompt: deepen the Server operations module (ops.md)

Paste everything below the line into Grok, working in `~/Desktop/tutor`.

---

You're deepening one module of Tutor, a self-study app: `src/study/content/ops.md` ("Server operations", 13 lessons). Its exercises are done and verified on a real Linux lab. **Your job is the lesson text**, which is too short: each lesson body is currently 590–1,060 words, and the standard for this app is **1,300–2,000 words per lesson**, written so that someone who reads it carefully really understands the topic. Don't pad it out: add substance.

## Rules

1. **Edit only lesson bodies**: the Markdown between a lesson's header lines (`id:`, `stage:`, `needs:`, `minutes:`, `goal:`, `source:`) and its first `::: step`. Don't change, reorder or remove existing steps, and never edit a step's `setup`, `verify`, `peersetup`, `peerverify` or `scripted` fields. They are verified, along with tests that wrong answers fail.
2. You **may add** new steps (quiz, card, predict, or shell/term steps on the lab) after the existing ones, if they teach something the body now covers. Every new lab step must pass `npm run check:study ops/<lesson-id>`, and doing nothing must fail it. The checker runs this for you: a lab step boots real machines (containers in seconds; `fullvm`/`disks=` steps boot a VM, about 40 s each). Read `src/study/parse.ts` for the step format, and copy the patterns already in ops.md (peer machines, live `::: term` steps with `scripted:`).
3. Facts must be right for **Ubuntu 24.04** (systemd 255, OpenSSH 9.6, netplan 1.x, rsyslog 8.2312, fail2ban 1.0, HAProxy 2.8, nginx 1.24, LVM 2.03, AppArmor 4.0). When unsure, check the real docs. Every `source:` must be a real, working URL.
4. Same voice as the existing text: second person, plain and exact, short paragraphs, tables where they compare things, code blocks with comments, mermaid diagrams where a picture helps. No filler phrases, no "In this lesson we will…", and no exclamation marks.
5. After each lesson, run `npm run check:study ops/<lesson-id>` and fix anything it reports before moving on. At the end, run `npm run check:study ops`.
6. Don't edit any other file.

## What each lesson is missing

- **netplan**: a layer-by-layer troubleshooting method (link `ip link`, address, route `ip route get`, DNS `resolvectl query`, firewall, then `ss`/`tcpdump`); IPv6 basics (`ip -6`, SLAAC vs static, link-local); MTU; multiple interfaces and route metrics; bonds and VLANs in netplan (a YAML example of each); how a cloud VPC's route tables and DHCP map onto what you see in the machine.
- **ssh-keys**: `ssh -v` debugging; port forwarding (`-L`, `-R`, `-D`) with real use cases (reaching a database behind a bastion); agent forwarding and why ProxyJump is safer; SSH certificates (a CA signing user and host keys) for fleets; FIDO2 hardware keys (`ed25519-sk`); `AllowUsers`/`Match` blocks in sshd_config.
- **backups**: restic or Borg (deduplication, encryption, `forget --keep-daily 7 --keep-weekly 4 --keep-monthly 12` retention); database dumps (`pg_dump -Fc`, `mysqldump --single-transaction`) and restoring them; consistent snapshots (LVM or cloud volume snapshots, `fsfreeze`); immutable offsite copies (S3 Object Lock); scheduling with a systemd timer plus `OnFailure=`; how to run and record a restore test.
- **metrics**: a `prometheus.yml` scrape config; PromQL with `rate`, `increase`, `sum by (…)`, `histogram_quantile`; an alert rule file with `for:` and labels; label cardinality and why a user ID must never be a label; the blackbox exporter for probing from outside; the Pushgateway, and when not to use it.
- **central-logs**: journald's own settings (`Storage=persistent`, `SystemMaxUse`, `RateLimitBurst`); rsyslog over TLS, in outline; a Vector or Fluent Bit config that ships to Loki or OpenSearch; retention and rotation on the log host; what never to log (secrets, tokens, personal data); log levels.
- **load-balancing**: TLS termination in HAProxy and in nginx; draining a server for a deploy (HAProxy's runtime API `set server app/app2 state drain`, nginx's `down`); timeouts (`timeout connect/client/server`, `proxy_read_timeout`) and what happens when they're wrong; sticky sessions (`cookie SERVERID insert`); the HAProxy stats page; keepalived/VRRP with a config sketch; designing `/healthz`.
- **sysctl**: kernel modules (`modprobe`, `/etc/modules-load.d/`, `br_netfilter` for Kubernetes); the conntrack table filling up (`nf_conntrack_max`, the `table full, dropping packet` message) as an incident; `ip_nonlocal_bind` for keepalived; TCP settings people cargo-cult (`tcp_tw_reuse`), and why to measure before tuning.
- **apparmor**: `aa-genprof` and `aa-logprof` walked through; exec transitions (`ix`, `px`, `cx`, `ux`) with an example; network and capability rules; AppArmor in Docker (`--security-opt apparmor=`) and Kubernetes (`securityContext.appArmorProfile`); SELinux for comparison (contexts, `getenforce`, `ls -Z`, `restorecon`, `audit2allow`), since RHEL jobs use it.
- **fail2ban**: the `recidive` jail; reading bans in nftables (`nft list set …`); jails for nginx (`nginx-http-auth`, `nginx-botsearch`); rate limiting in nginx (`limit_req`) as the complement; CrowdSec as the modern alternative; unbanning yourself safely.
- **auto-updates**: needrestart (`/etc/needrestart/needrestart.conf`, what it restarts); Livepatch; `apt-mark hold`, pinning, phased updates; RHEL's `dnf-automatic`; orchestrated reboots (kured on Kubernetes, one node at a time); patching through staging first.
- **disks-partitions**: swap files vs swap partitions (`fallocate`, `mkswap`, `swapon`, fstab); tmpfs; mount options in depth (`noatime`, `nodev,nosuid,noexec`, `x-systemd.device-timeout`, `x-systemd.automount`); native systemd `.mount` units; NFS mounts in outline; mapping an AWS EBS volume ID to its NVMe device (`/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_vol…`).
- **lvm**: snapshots with commands (create, mount read-only, back up, remove; merge to roll back); thin pools and monitoring `data_percent`; RAID levels compared (0, 1, 5, 6, 10: capacity, failure tolerance, write cost) and `mdadm` basics; LVM metadata backups (`/etc/lvm/backup`, `vgcfgrestore`); `lvs -o +devices,seg_pe_ranges`.
- **grow-disk**: XFS (`xfs_growfs` takes the mount point); root disk growth by cloud-init at boot; Kubernetes PVC expansion (`allowVolumeExpansion`); ext4's reserved blocks at 100%; `ncdu`; `journalctl --vacuum-size`, `docker system prune`, `apt-get clean`; the emergency reserve file (`fallocate -l 1G /var/reserve`); choosing inode density at mkfs (`-i`, `-T news`).

Work lesson by lesson, in order, running the checker after each.
