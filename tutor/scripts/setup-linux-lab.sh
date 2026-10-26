#!/bin/bash
# Sets up Tutor's Linux lab: a small Ubuntu VM (Lima, Apple's virtualization) in which every
# server exercise gets a fresh, throwaway Ubuntu system (an Incus container) with real systemd,
# root, apt and networking. Storage exercises get a small throwaway VM with real extra disks
# instead (that needs nested virtualization: an M3 or newer, macOS 15 or newer).
# Downloads about 1.2 GB once; uses about 6 GB of disk.
#
#   bash scripts/setup-linux-lab.sh            set up (safe to run again)
#   bash scripts/setup-linux-lab.sh --remove   delete the VM and Lima again
#
# The VM has no access to your Mac's files: the usual home-folder share is turned off.
set -euo pipefail

LIMA_VERSION=2.2.1
PREFIX="$HOME/.local/opt/lima"
LIMACTL="$HOME/.local/bin/limactl"
VM=tutor-lab

if [ "${1:-}" = "--remove" ]; then
  [ -x "$LIMACTL" ] && "$LIMACTL" delete -f "$VM" 2>/dev/null || true
  rm -rf "$PREFIX" "$LIMACTL"
  echo "Removed the Linux lab and Lima."
  exit 0
fi

[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || { echo "This script is for Macs with Apple Silicon." >&2; exit 1; }

# 1. Lima
if [ ! -x "$LIMACTL" ]; then
  echo "==> Downloading Lima $LIMA_VERSION"
  tmp=$(mktemp -d)
  file="lima-$LIMA_VERSION-Darwin-arm64.tar.gz"
  curl -fL --progress-bar -o "$tmp/$file" "https://github.com/lima-vm/lima/releases/download/v$LIMA_VERSION/$file"
  curl -fsSL -o "$tmp/SHA256SUMS" "https://github.com/lima-vm/lima/releases/download/v$LIMA_VERSION/SHA256SUMS"
  want=$(grep "$file\$" "$tmp/SHA256SUMS" | awk '{print $1}')
  got=$(shasum -a 256 "$tmp/$file" | awk '{print $1}')
  [ -n "$want" ] && [ "$want" = "$got" ] || { echo "Checksum mismatch for $file, stopping." >&2; exit 1; }
  echo "    checksum OK"
  mkdir -p "$PREFIX" "$(dirname "$LIMACTL")"
  tar -xzf "$tmp/$file" -C "$PREFIX"
  ln -sf "$PREFIX/bin/limactl" "$LIMACTL"
  rm -rf "$tmp"
fi
"$LIMACTL" --version

# 2. The VM
# Nested virtualization lets storage lessons boot VMs inside it. Apple supports it on M3 and newer.
nested_ok() {
  gen=$(sysctl -n machdep.cpu.brand_string 2>/dev/null | sed -n 's/^Apple M\([0-9][0-9]*\).*/\1/p')
  [ -n "$gen" ] && [ "$gen" -ge 3 ] && [ "$(sw_vers -productVersion | cut -d. -f1)" -ge 15 ]
}
NESTED=""
nested_ok && NESTED="--nested-virt"
if ! "$LIMACTL" list -q 2>/dev/null | grep -qx "$VM"; then
  echo "==> Creating the VM (downloads Ubuntu 24.04, about 600 MB)"
  "$LIMACTL" create --name="$VM" --tty=false --cpus=2 --memory=4 --disk=12 $NESTED --mount-none template://ubuntu-24.04
elif [ -n "$NESTED" ] && ! grep -q '^nestedVirtualization: true' "$HOME/.lima/$VM/lima.yaml" 2>/dev/null; then
  echo "==> Turning on nested virtualization for the storage lessons (restarts the VM)"
  "$LIMACTL" stop "$VM" 2>/dev/null || true
  "$LIMACTL" edit "$VM" --tty=false --nested-virt --memory 4
fi
if [ "$("$LIMACTL" list --format '{{.Status}}' "$VM")" != Running ]; then
  echo "==> Starting the VM"
  "$LIMACTL" start "$VM"
fi

# 3. Incus and the template machine, inside the VM
echo "==> Setting up the exercise machines inside the VM"
# The inner script is copied into the VM and run from a file: piped through stdin, commands like
# `incus init` would read the rest of the script as their own YAML input.
inner=$(mktemp)
cat > "$inner" <<'INNER'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
if ! command -v incus >/dev/null; then
  apt-get update -q
  apt-get install -y -q incus btrfs-progs
fi
# Storage (btrfs, so copying the template is instant), a NAT network with a fixed private range
# (auto-detection fails inside some VMs), and the default profile that uses both. Each piece is
# created only if it's missing, so a re-run continues where an earlier one stopped.
incus storage show default >/dev/null 2>&1 || incus storage create default btrfs size=8GiB
incus network show incusbr0 >/dev/null 2>&1 || incus network create incusbr0 ipv4.address=10.214.77.1/24 ipv4.nat=true ipv6.address=none
# DHCP hands out .2-.199; lessons use .200-.254 for static addresses.
[ "$(incus network get incusbr0 ipv4.dhcp.ranges)" = 10.214.77.2-10.214.77.199 ] || incus network set incusbr0 ipv4.dhcp.ranges=10.214.77.2-10.214.77.199
incus profile device show default 2>/dev/null | grep -q '^root:' || incus profile device add default root disk path=/ pool=default
incus profile device show default 2>/dev/null | grep -q '^eth0:' || incus profile device add default eth0 nic network=incusbr0 name=eth0
# The template machine. BASE_VERSION goes up when lessons need more tools; then it's updated
# in place and re-snapshotted.
BASE_VERSION=6
PACKAGES="nginx nftables ufw logrotate sysstat strace lsof openssh-server curl dnsutils iproute2 cron lvm2 less vim-tiny procps psmisc acl python3 openssl netcat-openbsd sudo rsync fail2ban unattended-upgrades apparmor apparmor-utils prometheus-node-exporter haproxy nano postgresql postgresql-contrib redis-server pgbouncer"
# Installed for lessons, off until a lesson turns them on. The apt timers are off too, so a
# background upgrade never holds apt's lock in the middle of an exercise.
SERVICES_OFF="nginx ssh ssh.socket fail2ban prometheus-node-exporter haproxy apt-daily.timer apt-daily-upgrade.timer postgresql redis-server pgbouncer"
if ! incus info tutor-base >/dev/null 2>&1; then
  echo "    downloading the Ubuntu container image (about 150 MB)"
  # The community image server sometimes refuses a connection for a moment: retry a few times.
  for attempt in 1 2 3 4 5; do
    incus init images:ubuntu/24.04 tutor-base < /dev/null && break
    [ "$attempt" = 5 ] && { echo "The image server (images.linuxcontainers.org) didn't answer. Try again in a few minutes." >&2; exit 1; }
    echo "    the image server didn't answer, retrying in 15 seconds ($attempt/5)"
    sleep 15
  done
fi
if [ "$(cat /var/lib/tutor-base-version 2>/dev/null || echo 0)" != "$BASE_VERSION" ]; then
  echo "    installing the lesson tools in the template machine"
  incus start tutor-base 2>/dev/null || true
  for i in $(seq 1 90); do
    incus exec tutor-base -- getent hosts archive.ubuntu.com >/dev/null 2>&1 && break
    sleep 1
  done
  incus exec tutor-base -- bash -c "apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q $PACKAGES && apt-get clean"
  incus exec tutor-base -- systemctl disable --now $SERVICES_OFF 2>/dev/null || true
  # Mirrors sometimes refuse a connection for a moment; let apt retry instead of failing a lesson.
  incus exec tutor-base -- sh -c 'echo "Acquire::Retries \"5\";" > /etc/apt/apt.conf.d/80-retries'
  incus stop tutor-base
  incus snapshot delete tutor-base clean 2>/dev/null || true
  echo "$BASE_VERSION" > /var/lib/tutor-base-version
fi
incus snapshot list tutor-base -f csv 2>/dev/null | grep -q '^clean,' || incus snapshot create tutor-base clean
echo "    template machine ready"

# The disk machine: a small VM for storage lessons, which get real extra disks to partition,
# format, mount and put LVM on. Containers can't do that; VMs need /dev/kvm (nested virtualization).
DISK_VERSION=1
if [ -e /dev/kvm ]; then
  if ! command -v qemu-system-aarch64 >/dev/null; then
    echo "    installing QEMU for the disk machine"
    apt-get install -y -q qemu-system-arm qemu-efi-aarch64 qemu-utils
  fi
  # Ubuntu's Incus 6.0 looks for UEFI firmware only under the x86 names (OVMF_*), in /usr/share/OVMF,
  # even on ARM: give it the ARM firmware (AAVMF) under those names. Copies, not symlinks: the
  # AppArmor profile Incus writes for each VM only lets QEMU open firmware under /usr/share/OVMF.
  if [ "$(uname -m)" = aarch64 ] && { [ ! -f /usr/share/OVMF/OVMF_CODE.fd ] || [ -L /usr/share/OVMF/OVMF_CODE.fd ]; }; then
    mkdir -p /usr/share/OVMF
    cp --remove-destination /usr/share/AAVMF/AAVMF_CODE.no-secboot.fd /usr/share/OVMF/OVMF_CODE.fd
    cp --remove-destination /usr/share/AAVMF/AAVMF_VARS.fd /usr/share/OVMF/OVMF_VARS.fd
  fi
  # Incus checks for QEMU and its firmware when it starts: restart it if it can't make VMs yet.
  if ! incus info | grep -q '^  driver: .*qemu'; then
    systemctl restart incus
    incus admin waitready --timeout 60
  fi
  if ! incus info tutor-disk >/dev/null 2>&1; then
    echo "    downloading the Ubuntu VM image (about 300 MB)"
    for attempt in 1 2 3 4 5; do
      incus init images:ubuntu/24.04 tutor-disk --vm -c limits.cpu=2 -c limits.memory=768MiB -c security.secureboot=false -d root,size=4GiB < /dev/null 2> /tmp/tutor-disk-init.err && break
      cat /tmp/tutor-disk-init.err >&2
      # Only a refused or failed connection is worth waiting for; anything else won't fix itself.
      grep -q -i -E 'connect|timeout|EOF' /tmp/tutor-disk-init.err || { echo "Creating the disk machine failed (above). Storage lessons won't run; everything else will." >&2; exit 1; }
      [ "$attempt" = 5 ] && { echo "The image server (images.linuxcontainers.org) didn't answer. Try again in a few minutes." >&2; exit 1; }
      echo "    the image server didn't answer, retrying in 15 seconds ($attempt/5)"
      sleep 15
    done
  fi
  if [ "$(cat /var/lib/tutor-disk-version 2>/dev/null || echo 0)" != "$DISK_VERSION" ]; then
    echo "    installing the storage tools in the disk machine"
    incus start tutor-disk 2>/dev/null || true
    for i in $(seq 1 180); do
      incus exec tutor-disk -- getent hosts archive.ubuntu.com >/dev/null 2>&1 && break
      sleep 1
    done
    incus exec tutor-disk -- bash -c "apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q lvm2 parted gdisk xfsprogs cloud-guest-utils e2fsprogs apparmor apparmor-utils nano && apt-get clean"
    incus exec tutor-disk -- systemctl disable apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
    incus exec tutor-disk -- sh -c 'echo "Acquire::Retries \"5\";" > /etc/apt/apt.conf.d/80-retries'
    incus stop tutor-disk --timeout 60 2>/dev/null || incus stop -f tutor-disk
    incus snapshot delete tutor-disk clean 2>/dev/null || true
    echo "$DISK_VERSION" > /var/lib/tutor-disk-version
  fi
  incus snapshot list tutor-disk -f csv 2>/dev/null | grep -q '^clean,' || incus snapshot create tutor-disk clean
  echo "    disk machine ready"
else
  echo "    no nested virtualization here: the storage lessons' disk machines are skipped"
fi
INNER
"$LIMACTL" copy "$inner" "$VM:/tmp/tutor-lab-setup.sh"
rm -f "$inner"
"$LIMACTL" shell "$VM" sudo bash /tmp/tutor-lab-setup.sh < /dev/null

echo
echo "Linux lab ready. Tutor starts the VM by itself when a lesson needs it."
echo "Stop it any time:   $LIMACTL stop $VM"
echo "Remove it all:      bash $(cd "$(dirname "$0")" && pwd)/setup-linux-lab.sh --remove"
