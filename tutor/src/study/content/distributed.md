# Distributed systems
id: distributed
blurb: The data plane a staff engineer owns: Postgres and Redis under replication and failure, durable queues, overload controls, and regional failover with measured RTO and RPO.
why: A Staff Distributed Systems Engineer is judged on what happens when a dependency is slow, a primary dies, or a region disappears. This module is the practice layer: real primaries, replicas, pools, queues and failover drills, plus the source documents the people who run these systems wrote.
stage: pg | Postgres as a system | Read plans, pool connections, find a blocker, stream a replica, restore to a point in time, and promote.
stage: cache | Caches under pressure | Bound memory, replicate and promote Redis, shard keys, and stop a stampede.
stage: msg | Durable messaging | Claim work exactly once in effect, dedupe redelivery, and know what JetStream and Kafka promise.
stage: overload | Overload, by design | Bound the queue, limit the rate, break the circuit, and retry with a budget instead of hope.
stage: regions | Regions and recovery | Do the latency and RTO/RPO arithmetic, map it onto AWS, alert on the leading signals, and choose a DR strategy.

## Read the plan, then add the index
id: pg-plans
stage: pg
needs: sql/indexes
minutes: 55
goal: Use EXPLAIN to see a sequential scan, add the composite index the query needs, and make the sort disappear.
source: PostgreSQL: Using EXPLAIN | https://www.postgresql.org/docs/current/using-explain.html
source: PostgreSQL: pg_stat_statements | https://www.postgresql.org/docs/current/pgstatstatements.html

A query plan is the database's argument about the cheapest way to answer you. `EXPLAIN` shows the argument; `EXPLAIN (ANALYZE, BUFFERS)` shows what actually happened. The thing to look for is not "did it use an index" but "how many rows did the planner think it would touch, and how many did it touch".

Read the [EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html) page for `ANALYZE`, `BUFFERS`, row estimates and the scan nodes. Keep [pg_stat_statements](https://www.postgresql.org/docs/current/pgstatstatements.html) open for the production version of the same question: which statements, across all sessions, cost the most.

::: quiz
q: A table has 300,000 rows. A tenant owns about 1,000 of them, and the query wants that tenant's 20 newest rows ordered by time. Which access path should the planner prefer?
- A sequential scan, because 300,000 rows is small enough to scan
+ An index on `(tenant_id, created_at)` that returns the rows already in order
- An index on `(created_at)` alone, because the query orders by time
why: The leading column must be the equality predicate, and the second column supplies the order. PostgreSQL can then walk only that tenant's entries and stop after 20; no sort and no scan of the other 299,000 rows.
:::

::: term
task: |
  The `bench` database has `events(id, tenant_id, kind, created_at, payload)` with 300,000 rows and no index on the columns this query uses.

  ```sql
  select id from events where tenant_id = 42 order by created_at desc limit 20;
  ```

  1. Run `explain (analyze, buffers)` on it. Notice the sequential scan and the sort.
  2. Add **one** index that lets PostgreSQL answer the query without scanning the whole table and without sorting the result.
  3. Run the explain again. The plan should say `Index Scan`, should not say `Seq Scan`, and should not need a `Sort` node.
  4. Run `analyze events` and explain one more time, so the planner has fresh statistics.

  You are root; PostgreSQL runs as the `postgres` user, so use `su postgres -c "psql -d bench ..."`.
setup: |
  ```bash
  set -e
  pg_ctlcluster 16 main start
  su postgres -c "psql -q -c 'drop database if exists bench'"
  su postgres -c "createdb bench"
  su postgres -c "psql -q -d bench -c \"
    create table events(
      id bigserial primary key,
      tenant_id int not null,
      kind text not null,
      created_at timestamptz not null,
      payload text not null
    );
    insert into events(tenant_id, kind, created_at, payload)
      select (g % 300) + 1, 'click', now() - (g || ' seconds')::interval, repeat('x', 80)
      from generate_series(1, 300000) g;
    analyze events;
  \""
  ```
verify: |
  ```bash
  idx=$(su postgres -c "psql -d bench -Atc \"select indexdef from pg_indexes where tablename = 'events' and indexdef like '%tenant_id%'\"")
  [ -n "$idx" ] || { echo "there is no index on events that starts with tenant_id"; exit 1; }
  echo "$idx" | grep -q 'created_at' || { echo "the index on tenant_id does not include created_at, so PostgreSQL still has to sort"; exit 1; }
  plan=$(su postgres -c "psql -d bench -Atc \"explain select id from events where tenant_id = 42 order by created_at desc limit 20\"")
  echo "$plan" | grep -qi 'Seq Scan' && { echo "the plan still scans the whole table: $plan"; exit 1; }
  echo "$plan" | grep -qi 'Sort' && { echo "the plan still sorts: $plan"; exit 1; }
  echo "$plan" | grep -qi 'Index Scan' || { echo "the plan does not use an index scan: $plan"; exit 1; }
  ```
solution: |
  ```bash
  su postgres -c "psql -d bench -c 'create index events_tenant_created_idx on events (tenant_id, created_at desc)'"
  su postgres -c "psql -d bench -c 'analyze events'"
  su postgres -c "psql -d bench -c 'explain select id from events where tenant_id = 42 order by created_at desc limit 20'"
  ```
hint: A composite index is ordered left to right. Put the equality column first and the ordering column second, in the direction the query asks for.
:::

::: card
q: The plan flips from an index scan to a sequential scan after the table grows, even though the query did not change. What did the planner learn?
answer: The index stopped being selective enough for that predicate, or the visibility map / correlation changed, so walking the index plus fetching heap pages became more expensive than reading the table. The plan is a cost argument, not a property of the SQL. Check `pg_stats` and the estimated versus actual rows before forcing anything.
:::

## Pool the connections, not the sessions
id: pg-pool
stage: pg
needs: pg-plans
minutes: 55
goal: Put PgBouncer in transaction mode in front of PostgreSQL and prove that thirty clients share five server connections.
source: PgBouncer features | https://www.pgbouncer.org/features.html
source: PgBouncer configuration | https://www.pgbouncer.org/config.html
source: PostgreSQL: Connections and authentication | https://www.postgresql.org/docs/current/runtime-config-connection.html

Every PostgreSQL backend is a process. A few hundred is normal; a few thousand is a memory and scheduler problem, and each one holds a snapshot and a transaction slot. A pooler does not make queries faster. It makes the number of server processes independent of the number of clients.

PgBouncer's [features page](https://www.pgbouncer.org/features.html) explains the pooling modes. In **transaction** mode a server connection is returned after each transaction, so session state (prepared statements, `SET`, advisory locks, `LISTEN`) does not follow the client. That is the trade: transaction mode packs more clients into fewer backends, and breaks code that assumes a session.

::: card
q: Why does a transaction-mode pool break a server-side prepared statement that was created in an earlier transaction?
answer: The client's next transaction may be routed to a different server connection, where that prepared statement does not exist. Use protocol-level prepared statements with PgBouncer's support, prepare inside the same transaction, or use session mode for that client. The pool is multiplexing sessions, so session state cannot be assumed.
:::

::: term
task: |
  PgBouncer is installed but not configured. Put a transaction-mode pool in front of the `appdb` database:

  - listen on `127.0.0.1:6432`
  - database `appdb` -> `host=127.0.0.1 port=5432 dbname=appdb`
  - authenticate as `scram-sha-256`, with `app` / `apppass` in the userlist
  - `pool_mode = transaction`, `default_pool_size = 5`, `max_client_conn = 200`
  - the `app` user may read the pooler's admin console (`admin_users = app`)

  Start PgBouncer and prove the pool works: thirty concurrent clients run `select pg_sleep(0.8)` through port 6432, and while they are running PostgreSQL must show **at most six** backends for `appdb` (five pooled plus the checker's own inspection connection).

  PostgreSQL is already running with the role and database created. The files are `/etc/pgbouncer/pgbouncer.ini` and `/etc/pgbouncer/userlist.txt`.
setup: |
  ```bash
  set -e
  pg_ctlcluster 16 main start
  su postgres -c "psql -tAc \"select 1 from pg_roles where rolname = 'app'\"" | grep -qx 1 || su postgres -c "psql -c \"create role app login password 'apppass'\""
  su postgres -c "psql -tAc \"select 1 from pg_database where datname = 'appdb'\"" | grep -qx 1 || su postgres -c "createdb -O app appdb"
  ```
verify: |
  ```bash
  f=/etc/pgbouncer/pgbouncer.ini
  [ -f "$f" ] || { echo "there is no $f"; exit 1; }
  grep -Eq '^[[:space:]]*pool_mode[[:space:]]*=[[:space:]]*transaction' "$f" || { echo "pool_mode is not transaction in $f"; exit 1; }
  grep -Eq '^[[:space:]]*default_pool_size[[:space:]]*=[[:space:]]*5' "$f" || { echo "default_pool_size is not 5 in $f"; exit 1; }
  PGPASSWORD=apppass psql -h 127.0.0.1 -p 6432 -U app -d appdb -Atc 'select 1' 2>/dev/null | grep -qx 1 || { echo "could not run select 1 through 127.0.0.1:6432 as app"; exit 1; }
  for i in $(seq 1 30); do
    PGPASSWORD=apppass psql -h 127.0.0.1 -p 6432 -U app -d appdb -c 'select pg_sleep(0.8)' >/dev/null 2>&1 &
  done
  sleep 0.5
  n=$(su postgres -c "psql -d postgres -Atc \"select count(*) from pg_stat_activity where datname = 'appdb'\"")
  wait
  [ "$n" -le 6 ] || { echo "PostgreSQL saw $n backends for appdb; the pool is not capping them at five"; exit 1; }
  ```
solution: |
  ```bash
  cat > /etc/pgbouncer/pgbouncer.ini <<'EOF'
  [databases]
  appdb = host=127.0.0.1 port=5432 dbname=appdb

  [pgbouncer]
  listen_addr = 127.0.0.1
  listen_port = 6432
  auth_type = scram-sha-256
  auth_file = /etc/pgbouncer/userlist.txt
  pool_mode = transaction
  max_client_conn = 200
  default_pool_size = 5
  admin_users = app
  EOF
  printf '"app" "apppass"\n' > /etc/pgbouncer/userlist.txt
  chown postgres:postgres /etc/pgbouncer/userlist.txt
  chmod 600 /etc/pgbouncer/userlist.txt
  systemctl restart pgbouncer
  sleep 1
  PGPASSWORD=apppass psql -h 127.0.0.1 -p 6432 -U app -d appdb -Atc 'select 1'
  ```
hint: The userlist comes before the first client. Start or restart the service after changing the ini file, then test with a single `psql` before the burst.
:::

## Find the transaction holding the row
id: pg-locks
stage: pg
needs: sql/transactions, pg-plans
minutes: 50
goal: Find a blocking backend from pg_stat_activity, terminate only that backend, and finish the blocked transfer.
source: PostgreSQL: Explicit locking | https://www.postgresql.org/docs/current/explicit-locking.html
source: PostgreSQL: Monitoring statistics | https://www.postgresql.org/docs/current/monitoring-stats.html
source: PostgreSQL: Transaction isolation | https://www.postgresql.org/docs/current/transaction-iso.html

A row lock is held until the transaction ends, not until the statement ends. A session that ran `update` and then went to lunch is still holding that row, and every later writer queues behind it. The useful question is not "who is slow" but "who is blocking whom, and what is that session doing".

`pg_stat_activity` gives you the session, its state, its current query and how long it has been there. `pg_blocking_pids(pid)` turns a wait into a graph edge. The [monitoring stats](https://www.postgresql.org/docs/current/monitoring-stats.html) page documents both; the [explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html) page explains why the lock outlives the statement.

::: quiz
q: A writer has been waiting for two minutes. `pg_stat_activity` shows `wait_event_type = Lock`. What is the next useful query?
- `select * from pg_locks` and read every row
+ `select pg_blocking_pids(pid) from pg_stat_activity where pid = <the waiter>`
- `select pg_terminate_backend(<the waiter>)`
why: `pg_blocking_pids` names the sessions that must finish or die before the waiter can proceed. Terminating the waiter throws away the work without touching the cause; terminating the blocker is a decision you make after seeing what it is doing.
:::

::: term
task: |
  The `bank` database has two accounts, both with balance 100. A nightly transfer is stuck: one backend opened a transaction, updated account 1, and is now sitting in `pg_sleep(600)`.

  1. Find the waiting writer and the session blocking it with `pg_stat_activity` and `pg_blocking_pids`.
  2. Look at what the blocking session is doing. Terminate **that backend** with `pg_terminate_backend`, not the whole cluster.
  3. In one transaction, move 10 from account 1 to account 2. The final balances must be 90 and 110, and no `pg_sleep(600)` session may remain.

  You are root; use `su postgres -c "psql -d bank ..."`.
setup: |
  ```bash
  set -e
  pg_ctlcluster 16 main start
  su postgres -c "psql -q -c 'drop database if exists bank'"
  su postgres -c "createdb bank"
  su postgres -c "psql -q -d bank -c \"
    create table accounts(id int primary key, balance int not null);
    insert into accounts values (1, 100), (2, 100);
  \""
  su postgres -c "setsid psql -d bank -c \"begin; update accounts set balance = balance - 1 where id = 1; select pg_sleep(600); commit;\" >/tmp/blocker.log 2>&1 </dev/null &"
  sleep 1
  ```
verify: |
  ```bash
  n=$(su postgres -c "psql -d bank -Atc \"select count(*) from pg_stat_activity where query like '%select pg_sleep(600)%' and pid <> pg_backend_pid()\"")
  [ "$n" = "0" ] || { echo "the blocking pg_sleep(600) session is still there"; exit 1; }
  got=$(su postgres -c "psql -d bank -Atc 'select string_agg(id || chr(61) || balance, chr(44) order by id) from accounts'")
  [ "$got" = "1=90,2=110" ] || { echo "balances are $got, not 1=90,2=110"; exit 1; }
  ```
solution: |
  ```bash
  pid=$(su postgres -c "psql -d bank -Atc \"select pid from pg_stat_activity where query like '%select pg_sleep(600)%' and pid <> pg_backend_pid() limit 1\"")
  su postgres -c "psql -d bank -c \"select pg_terminate_backend($pid)\""
  sleep 0.5
  su postgres -c "psql -d bank -c \"begin; update accounts set balance = balance - 10 where id = 1; update accounts set balance = balance + 10 where id = 2; commit;\""
  ```
hint: Run the blocked transfer in a second session if you want to watch it wait before you kill the blocker. The blocker's `state` is `active` and its query text contains the sleep.
:::

## A standby that is actually streaming
id: pg-replica
stage: pg
needs: pg-plans
minutes: 65
goal: Diagnose a standby whose WAL receiver cannot authenticate, fix it, and prove that a write on the primary reaches the replica.
source: PostgreSQL: Log-shipping standby servers | https://www.postgresql.org/docs/current/warm-standby.html
source: PostgreSQL: pg_basebackup | https://www.postgresql.org/docs/current/app-pgbasebackup.html
source: PostgreSQL: The pg_hba.conf file | https://www.postgresql.org/docs/current/auth-pg-hba-conf.html

Streaming replication is a sender on the primary, a receiver on the standby, and WAL records in between. A standby that is "up" can still be useless: if the receiver cannot authenticate, it retries forever and serves a frozen snapshot. The primary's `pg_stat_replication` is empty, and the standby's log says why.

The [log-shipping](https://www.postgresql.org/docs/current/warm-standby.html) chapter covers the primary settings (`wal_level`, `max_wal_senders`, `pg_hba.conf`) and the standby's `primary_conninfo`. `pg_basebackup -R` writes the standby signal and the connection string; the password still has to come from somewhere, usually a `passfile`.

::: quiz
q: `pg_stat_replication` on the primary is empty, but `select pg_is_in_recovery()` on the standby returns true. What does that combination tell you?
- The standby is caught up and healthy
+ The standby started in recovery but has no working WAL receiver
- The primary is read-only
why: `pg_is_in_recovery()` only says the server did not finish recovery. An empty `pg_stat_replication` means no sender is connected, so the standby is replaying old WAL or waiting. The standby log is the next place to look.
:::

::: term peer=replica
task: |
  `lab` is the primary. `replica` was cloned from it with `pg_basebackup -R`, but it is not streaming: the primary's `pg_stat_replication` is empty.

  The replication role is `replicator` and its password is `replpass`. The standby's connection string points at a passfile, and the credential in that file is wrong.

  1. On `replica` (use its tab), find the WAL receiver error in the PostgreSQL log.
  2. Fix the passfile, restart the standby, and confirm `pg_stat_replication` on `lab` shows `streaming`.
  3. Prove the direction: the checker inserts a row on `lab`; that row must appear on `replica`, which must still be in recovery.

  `lab` can reach `replica` with the key at `/root/.ssh/peer_key` if you prefer one shell, but the peer tab is the normal way.
setup: |
  ```bash
  set -e
  pg_ctlcluster 16 main start
  su postgres -c "psql -tAc \"select 1 from pg_roles where rolname = 'replicator'\"" | grep -qx 1 || su postgres -c "psql -c \"create role replicator with replication login password 'replpass'\""
  grep -q '^host replication replicator' /etc/postgresql/16/main/pg_hba.conf || echo 'host replication replicator 10.214.77.0/24 scram-sha-256' >> /etc/postgresql/16/main/pg_hba.conf
  sed -i "s/^#\?listen_addresses.*/listen_addresses = '*'/" /etc/postgresql/16/main/postgresql.conf
  pg_ctlcluster 16 main restart
  su postgres -c "psql -q -c 'drop database if exists app'"
  su postgres -c "createdb app"
  su postgres -c "psql -q -d app -c \"
    create table orders(id int primary key, note text not null);
    insert into orders select g, 'seed' from generate_series(1, 1000) g;
  \""
  ssh-keygen -q -t ed25519 -N '' -f /root/.ssh/peer_key
  mkdir -p /tmp/to-peer
  cp /root/.ssh/peer_key.pub /tmp/to-peer/peer_key.pub
  ```
peersetup: |
  ```bash
  set -e
  install -d -m 700 /root/.ssh
  cat /tmp/from-lab/peer_key.pub >> /root/.ssh/authorized_keys
  chmod 600 /root/.ssh/authorized_keys
  systemctl enable --now ssh >/dev/null 2>&1
  pg_ctlcluster 16 main stop >/dev/null 2>&1 || true
  rm -rf /var/lib/postgresql/16/main
  install -d -m 700 -o postgres -g postgres /var/lib/postgresql/16/main
  printf 'lab:5432:replication:replicator:replpass\n' > /var/lib/postgresql/.pgpass
  chown postgres:postgres /var/lib/postgresql/.pgpass
  chmod 600 /var/lib/postgresql/.pgpass
  su postgres -c "pg_basebackup -h lab -U replicator -D /var/lib/postgresql/16/main -R -X stream -c fast"
  chmod 700 /var/lib/postgresql/16/main
  printf 'lab:5432:replication:replicator:wrongpass\n' > /var/lib/postgresql/.pgpass
  chown postgres:postgres /var/lib/postgresql/.pgpass
  chmod 600 /var/lib/postgresql/.pgpass
  pg_ctlcluster 16 main start >/dev/null 2>&1 || true
  ```
verify: |
  ```bash
  state=$(su postgres -c "psql -d app -Atc 'select state from pg_stat_replication'")
  [ "$state" = "streaming" ] || { echo "pg_stat_replication says '$state', not streaming"; exit 1; }
  su postgres -c "psql -q -d app -c \"insert into orders values (9999, 'live') on conflict (id) do update set note = 'live'\""
  ```
peerverify: |
  ```bash
  rec=$(su postgres -c "psql -d app -Atc 'select pg_is_in_recovery()'")
  [ "$rec" = "t" ] || { echo "replica is not in recovery; it is not a standby"; exit 1; }
  for i in $(seq 1 20); do
    note=$(su postgres -c "psql -d app -Atc 'select note from orders where id = 9999'" 2>/dev/null)
    [ "$note" = "live" ] && exit 0
    sleep 0.25
  done
  echo "the row written on the primary never reached the replica"; exit 1
  ```
solution: |
  ```bash
  ssh -i /root/.ssh/peer_key -o StrictHostKeyChecking=no root@replica "
    sed -i 's/wrongpass/replpass/' /var/lib/postgresql/.pgpass
    pg_ctlcluster 16 main restart
  "
  sleep 1
  su postgres -c "psql -d app -Atc 'select state from pg_stat_replication'"
  ```
hint: On the standby, `journalctl -u postgresql@16-main` will show `password authentication failed for user "replicator"`. The passfile is `/var/lib/postgresql/.pgpass`; the server reads it as the `postgres` user.
:::

## Restore to a named point, not to last night
id: pg-pitr
stage: pg
needs: pg-replica
minutes: 70
goal: Recover a dropped table from a base backup plus archived WAL, stopping at a named restore point, and prove it is the same system.
source: PostgreSQL: Continuous archiving and point-in-time recovery | https://www.postgresql.org/docs/current/continuous-archiving.html
source: PostgreSQL: Backup control functions | https://www.postgresql.org/docs/current/functions-admin.html

A nightly dump gives you a recovery point, not a recovery objective. Point-in-time recovery is a base backup plus every WAL segment after it, replayed up to a target: a timestamp, an LSN, a transaction id, or a named restore point. The target is the promise; the archive is what makes it real.

Read the [continuous archiving](https://www.postgresql.org/docs/current/continuous-archiving.html) chapter for `archive_mode`, `restore_command`, `recovery.signal`, and `recovery_target_name`. Keep the [backup control functions](https://www.postgresql.org/docs/current/functions-admin.html) page for `pg_create_restore_point`, `pg_switch_wal` and `pg_control_system`.

::: card
q: A backup is taken every night at 02:00 and WAL is archived continuously. The database dies at 14:00. What is the RPO before any restore has been tested?
answer: It is the time between the last archived WAL record and the failure, not the time since the base backup. If archiving is healthy, that can be seconds or minutes; if `archive_command` has been failing, it is unbounded. A restore drill is the only thing that turns that sentence into a number.
:::

::: term
task: |
  A standalone PostgreSQL cluster on port **5434** holds a `ledger` table. The sequence was:

  1. ten rows were inserted;
  2. a base backup was taken at `/var/lib/postgresql/pitr-base`;
  3. a restore point named `before_drop` was created;
  4. ten more rows were inserted and the WAL was switched;
  5. the table was dropped and the WAL was switched again.

  Restore the base backup into `/var/lib/postgresql/pitr-restore`, replay WAL from `/var/lib/postgresql/pitr-wal` to the restore point `before_drop`, and start the restored cluster on port **5435**. Do not stop or modify the original cluster.

  When you are done, the restored `ledger` must contain exactly ids 1 through 10, the restored server must not be in recovery, and it must report the same `system_identifier` as the original (a fresh `initdb` would not).

  The PostgreSQL binaries are in `/usr/lib/postgresql/16/bin`; run server commands as `postgres`.
setup: |
  ```bash
  set -e
  install -d -m 700 -o postgres -g postgres /var/lib/postgresql/pitr /var/lib/postgresql/pitr-wal
  su postgres -c "/usr/lib/postgresql/16/bin/initdb -D /var/lib/postgresql/pitr -A trust" >/dev/null
  cat >> /var/lib/postgresql/pitr/postgresql.conf <<'EOF'
  port = 5434
  archive_mode = on
  archive_command = 'test ! -f /var/lib/postgresql/pitr-wal/%f && cp %p /var/lib/postgresql/pitr-wal/%f'
  EOF
  su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /var/lib/postgresql/pitr -l /var/lib/postgresql/pitr.log start"
  su postgres -c "psql -p 5434 -q -c \"
    create table ledger(id int primary key, amount int not null);
    insert into ledger select g, g * 10 from generate_series(1, 10) g;
  \""
  su postgres -c "psql -p 5434 -Atc 'select system_identifier from pg_control_system()'" > /root/system_id
  su postgres -c "pg_basebackup -h 127.0.0.1 -p 5434 -D /var/lib/postgresql/pitr-base -X stream -c fast"
  su postgres -c "psql -p 5434 -c \"select pg_create_restore_point('before_drop')\""
  su postgres -c "psql -p 5434 -q -c 'insert into ledger select g, g * 10 from generate_series(11, 20) g'"
  su postgres -c "psql -p 5434 -Atc 'select pg_switch_wal()'"
  su postgres -c "psql -p 5434 -c 'drop table ledger'"
  su postgres -c "psql -p 5434 -Atc 'select pg_switch_wal()'"
  ```
verify: |
  ```bash
  orig=$(cat /root/system_id)
  got=$(su postgres -c "psql -p 5435 -Atc 'select system_identifier from pg_control_system()'" 2>/dev/null)
  [ "$got" = "$orig" ] || { echo "the server on 5435 is not the restored system (system_identifier '$got', expected '$orig')"; exit 1; }
  rows=$(su postgres -c "psql -p 5435 -Atc 'select count(*) || chr(124) || max(id) from ledger'" 2>/dev/null)
  [ "$rows" = "10|10" ] || { echo "the restored ledger is '$rows', not 10 rows ending at id 10"; exit 1; }
  rec=$(su postgres -c "psql -p 5435 -Atc 'select pg_is_in_recovery()'" 2>/dev/null)
  [ "$rec" = "f" ] || { echo "the restored server is still in recovery"; exit 1; }
  ```
solution: |
  ```bash
  cp -a /var/lib/postgresql/pitr-base /var/lib/postgresql/pitr-restore
  chown -R postgres:postgres /var/lib/postgresql/pitr-restore
  chmod 700 /var/lib/postgresql/pitr-restore
  cat >> /var/lib/postgresql/pitr-restore/postgresql.auto.conf <<'EOF'
  restore_command = 'cp /var/lib/postgresql/pitr-wal/%f %p'
  recovery_target_name = 'before_drop'
  recovery_target_action = 'promote'
  EOF
  touch /var/lib/postgresql/pitr-restore/recovery.signal
  chown postgres:postgres /var/lib/postgresql/pitr-restore/recovery.signal
  su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /var/lib/postgresql/pitr-restore -o '-p 5435' -l /var/lib/postgresql/pitr-restore.log start"
  sleep 2
  su postgres -c "psql -p 5435 -Atc 'select count(*), max(id) from ledger'"
  ```
hint: The base backup already contains `postgresql.conf`; append the recovery settings to `postgresql.auto.conf` so they win. `recovery.signal` is removed automatically after a successful promotion.
:::

## Promote, count what you lost, write it down
id: pg-failover
stage: pg
needs: pg-replica, pg-pitr
minutes: 75
goal: Run a primary failure drill against a streaming standby, promote it, count the writes the replica never saw, and record RPO and RTO.
source: PostgreSQL: Log-shipping standby servers | https://www.postgresql.org/docs/current/warm-standby.html
source: PostgreSQL: pg_ctl | https://www.postgresql.org/docs/current/app-pg-ctl.html
source: AWS: Disaster Recovery of Workloads on AWS | https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-workloads-on-aws.html

Async replication makes the standby a good copy, not an identical one. When the primary dies, the difference between the last commit it acknowledged and the last WAL the standby replayed is the data you just lost. That difference is the RPO you actually had, not the one in the design document. RTO is the wall-clock time until the standby accepts writes again.

The [log-shipping](https://www.postgresql.org/docs/current/warm-standby.html) chapter covers promotion and the meaning of `pg_is_in_recovery`. `pg_ctl promote` is the command; `pg_ctlcluster 16 main promote` is the Debian wrapper. The AWS whitepaper is useful for the service-level framing: backup and restore, pilot light, warm standby, multi-site, each with a different RTO/RPO bill.

::: card
q: The standby is 4 seconds behind when the primary dies, and the application was committing 500 writes per second. What is the RPO, and what does the number not tell you?
answer: The worst-case data loss is about 2,000 committed writes (4 seconds at 500/s), assuming the lag was steady. It does not tell you which of those writes were acknowledged to users, whether they were idempotent, or how long promotion and traffic switching will take. RPO is a data-loss budget; RTO is a separate clock.
:::

::: term peer=dr
task: |
  `lab` is the primary region and `dr` is a streaming standby. Run a failover drill and write down what it cost.

  1. On `dr`, stop PostgreSQL. It is now unreachable, and it will not receive the next writes.
  2. On `lab`, confirm there are 1,000 rows. Insert ids **1001 through 1100**. Confirm there are 1,100.
  3. Stop PostgreSQL on `lab`. Do not destroy the machine or the data directory.
  4. On `dr`, start PostgreSQL and promote it. It becomes the new primary.
  5. On `dr`, count the rows that survived and insert id **2000**.
  6. On `lab`, write `/root/failover-report.txt` with exactly these lines:

     ```text
     primary_rows=1100
     replica_rows=<the count on dr>
     lost_rows=<1100 minus replica_rows>
     promoted=yes
     rto_seconds=<whole seconds from the stop in step 3 to the end of the promotion in step 4>
     ```

  The report is the evidence. The checker also verifies that `dr` accepts writes and that `lab`'s PostgreSQL is down.
setup: |
  ```bash
  set -e
  pg_ctlcluster 16 main start
  su postgres -c "psql -tAc \"select 1 from pg_roles where rolname = 'replicator'\"" | grep -qx 1 || su postgres -c "psql -c \"create role replicator with replication login password 'replpass'\""
  grep -q '^host replication replicator' /etc/postgresql/16/main/pg_hba.conf || echo 'host replication replicator 10.214.77.0/24 scram-sha-256' >> /etc/postgresql/16/main/pg_hba.conf
  sed -i "s/^#\?listen_addresses.*/listen_addresses = '*'/" /etc/postgresql/16/main/postgresql.conf
  pg_ctlcluster 16 main restart
  su postgres -c "psql -q -c 'drop database if exists ledger'"
  su postgres -c "createdb ledger"
  su postgres -c "psql -q -d ledger -c \"
    create table ledger(id int primary key, amount int not null);
    insert into ledger select g, 1 from generate_series(1, 1000) g;
  \""
  ssh-keygen -q -t ed25519 -N '' -f /root/.ssh/peer_key
  mkdir -p /tmp/to-peer
  cp /root/.ssh/peer_key.pub /tmp/to-peer/peer_key.pub
  ```
peersetup: |
  ```bash
  set -e
  install -d -m 700 /root/.ssh
  cat /tmp/from-lab/peer_key.pub >> /root/.ssh/authorized_keys
  chmod 600 /root/.ssh/authorized_keys
  systemctl enable --now ssh >/dev/null 2>&1
  pg_ctlcluster 16 main stop >/dev/null 2>&1 || true
  rm -rf /var/lib/postgresql/16/main
  install -d -m 700 -o postgres -g postgres /var/lib/postgresql/16/main
  printf 'lab:5432:replication:replicator:replpass\n' > /var/lib/postgresql/.pgpass
  chown postgres:postgres /var/lib/postgresql/.pgpass
  chmod 600 /var/lib/postgresql/.pgpass
  su postgres -c "pg_basebackup -h lab -U replicator -D /var/lib/postgresql/16/main -R -X stream -c fast"
  chmod 700 /var/lib/postgresql/16/main
  pg_ctlcluster 16 main start
  for i in $(seq 1 40); do
    n=$(su postgres -c "psql -d ledger -Atc 'select count(*) from ledger'" 2>/dev/null || true)
    [ "$n" = "1000" ] && break
    sleep 0.25
  done
  [ "$n" = "1000" ]
  ```
verify: |
  ```bash
  report=/root/failover-report.txt
  [ -f "$report" ] || { echo "there is no $report"; exit 1; }
  grep -qx 'primary_rows=1100' "$report" || { echo "primary_rows is not 1100"; exit 1; }
  replica=$(sed -n 's/^replica_rows=//p' "$report")
  lost=$(sed -n 's/^lost_rows=//p' "$report")
  [ "$replica" = "1000" ] || { echo "replica_rows is '$replica', but the standby was stopped before the 100 writes and should have 1000"; exit 1; }
  [ "$lost" = "100" ] || { echo "lost_rows is '$lost', not 100"; exit 1; }
  grep -qx 'promoted=yes' "$report" || { echo "promoted=yes is missing"; exit 1; }
  rto=$(sed -n 's/^rto_seconds=//p' "$report")
  case "$rto" in ''|*[!0-9]*) echo "rto_seconds is not a whole number"; exit 1;; esac
  [ "$rto" -ge 1 ] && [ "$rto" -le 3600 ] || { echo "rto_seconds=$rto is not a plausible measured time"; exit 1; }
  if pg_isready -q; then echo "PostgreSQL on lab is still up; step 3 did not happen"; exit 1; fi
  ```
peerverify: |
  ```bash
  rec=$(su postgres -c "psql -d ledger -Atc 'select pg_is_in_recovery()'")
  [ "$rec" = "f" ] || { echo "dr is still in recovery; it was not promoted"; exit 1; }
  got=$(su postgres -c "psql -d ledger -Atc 'select count(*) || chr(124) || max(id) from ledger'")
  [ "$got" = "1001|2000" ] || { echo "dr has '$got', expected 1001 rows ending at id 2000"; exit 1; }
  su postgres -c "psql -q -d ledger -c 'insert into ledger values (2001, 1)'"
  ```
solution: |
  ```bash
  set -e
  ssh -i /root/.ssh/peer_key -o StrictHostKeyChecking=no root@dr "pg_ctlcluster 16 main stop"
  sleep 1
  su postgres -c "psql -d ledger -Atc 'select count(*) from ledger'"
  su postgres -c "psql -q -d ledger -c 'insert into ledger select g, 1 from generate_series(1001, 1100) g'"
  t0=$(date +%s)
  pg_ctlcluster 16 main stop
  ssh -i /root/.ssh/peer_key -o StrictHostKeyChecking=no root@dr "pg_ctlcluster 16 main start; pg_ctlcluster 16 main promote"
  for i in $(seq 1 40); do
    rec=$(ssh -i /root/.ssh/peer_key -o StrictHostKeyChecking=no root@dr "su postgres -c \"psql -d ledger -Atc 'select pg_is_in_recovery()'\"" 2>/dev/null || true)
    [ "$rec" = "f" ] && break
    sleep 0.25
  done
  t1=$(date +%s)
  rows=$(ssh -i /root/.ssh/peer_key -o StrictHostKeyChecking=no root@dr "su postgres -c \"psql -d ledger -Atc 'select count(*) from ledger'\"")
  cat > /root/failover-report.txt <<EOF
  primary_rows=1100
  replica_rows=$rows
  lost_rows=$((1100 - rows))
  promoted=yes
  rto_seconds=$((t1 - t0))
  EOF
  ssh -i /root/.ssh/peer_key -o StrictHostKeyChecking=no root@dr "su postgres -c \"psql -q -d ledger -c 'insert into ledger values (2000, 1)'\""
  cat /root/failover-report.txt
  ```
hint: Stop the standby first, then write on the primary, then stop the primary. That ordering makes the RPO deterministic: the standby cannot have the hundred writes. Promotion is `pg_ctlcluster 16 main promote` on Debian.
:::

## A cache with a memory ceiling
id: cache-evict
stage: cache
minutes: 40
goal: Bound Redis memory, choose an eviction policy, and watch a cache evict instead of failing writes.
source: Redis: Key eviction | https://redis.io/docs/latest/develop/reference/eviction/
source: Redis: INFO command | https://redis.io/docs/latest/commands/info/

Redis is not a database with a cache in front of it. It is a memory allocator with a policy: when `maxmemory` is reached, either writes fail or keys are evicted according to `maxmemory-policy`. `noeviction` is the safe default for a store; it is the wrong default for a cache.

The [key eviction](https://redis.io/docs/latest/develop/reference/eviction/) page explains LRU, LFU, volatile vs all-keys policies and the approximated eviction pool. `INFO memory` and `INFO stats` are how you check what the policy actually did.

::: quiz
q: You run Redis as a pure cache and would rather lose an arbitrary key than fail a write. Which policy is the honest choice?
- `noeviction`, because losing data is worse than an error
+ `allkeys-lru`, because every key is disposable and the cache must keep accepting writes
- `volatile-lru`, because keys with a TTL are the only safe ones to evict
why: `allkeys-lru` treats the whole keyspace as cache. `volatile-lru` only evicts keys that have a TTL, so a cache with many persistent keys can still fill up and start refusing writes. `noeviction` turns a full cache into an application outage.
:::

::: term
task: |
  A Redis server is running on `127.0.0.1:6379` with no memory limit. Turn it into a bounded cache:

  1. Set `maxmemory` to **2 MB**.
  2. Set `maxmemory-policy` to **allkeys-lru**.
  3. Insert at least **5,000** keys of roughly 1 KB each (a simple loop is fine).
  4. Prove the policy worked: `evicted_keys` must be greater than zero, `used_memory` must be at or below `maxmemory`, and `dbsize` must be under 5,000.

  The change is runtime state, not a config file.
setup: |
  ```bash
  set -e
  redis-server --daemonize yes --save '' --appendonly no
  sleep 0.5
  redis-cli ping | grep -qx PONG
  ```
verify: |
  ```bash
  policy=$(redis-cli config get maxmemory-policy | tail -1)
  [ "$policy" = "allkeys-lru" ] || { echo "maxmemory-policy is '$policy', not allkeys-lru"; exit 1; }
  max=$(redis-cli config get maxmemory | tail -1)
  [ "$max" = "2097152" ] || { echo "maxmemory is '$max', not 2097152"; exit 1; }
  ev=$(redis-cli info stats | sed -n 's/^evicted_keys://p' | tr -d '\r')
  [ -n "$ev" ] && [ "$ev" -gt 0 ] || { echo "evicted_keys is '$ev'; nothing was evicted"; exit 1; }
  used=$(redis-cli info memory | sed -n 's/^used_memory://p' | tr -d '\r')
  [ "$used" -le "$max" ] || { echo "used_memory $used is above maxmemory $max"; exit 1; }
  size=$(redis-cli dbsize | tr -d '\r')
  [ "$size" -lt 5000 ] || { echo "dbsize is $size; the cache did not shrink below 5,000 keys"; exit 1; }
  ```
solution: |
  ```bash
  redis-cli config set maxmemory 2mb
  redis-cli config set maxmemory-policy allkeys-lru
  value=$(head -c 900 /dev/zero | tr '\0' x)
  for i in $(seq 1 5000); do redis-cli set "cache:$i" "$value" >/dev/null; done
  redis-cli info stats | grep evicted_keys
  redis-cli info memory | grep -E 'used_memory:|maxmemory:'
  redis-cli dbsize
  ```
hint: `redis-cli config set maxmemory 2mb` accepts the unit. Check the result with `config get`, not by assuming the set worked. `INFO` output uses colons, not spaces.
:::

::: card
q: `used_memory` is 2,096,424 bytes with `maxmemory` at 2,097,152. Why is it allowed to sit just under the line instead of evicting earlier?
answer: Eviction is triggered as memory is allocated and the limit is crossed, but Redis accounts for the allocator's view of used memory, not a hard per-key budget. It evicts until it is back under the limit, which can leave it a few kilobytes below. The exact margin is not a contract; the contract is that writes keep working and the policy makes space.
:::

## Promote the cache when the primary dies
id: cache-replica
stage: cache
needs: cache-evict
minutes: 55
goal: Configure a Redis replica, prove it receives writes, then promote it after the primary is stopped.
source: Redis: Replication | https://redis.io/docs/latest/operate/oss_and_stack/management/replication/
source: Redis: REPLICAOF | https://redis.io/docs/latest/commands/replicaof/
source: Redis: Sentinel | https://redis.io/docs/latest/operate/oss_and_stack/management/sentinel/

Redis replication is asynchronous. The primary acknowledges a write before the replica has it; `WAIT` can ask for acknowledgements, but it cannot make a dead primary's last writes reappear. For a cache that is acceptable by definition, which is exactly why cache failover is a different exercise from database failover: you promote, accept the cold or stale keys, and refill.

The [replication](https://redis.io/docs/latest/operate/oss_and_stack/management/replication/) page covers `REPLICAOF`, partial resynchronization and the replication ID. [Sentinel](https://redis.io/docs/latest/operate/oss_and_stack/management/sentinel/) is the automated version: it watches primaries and replicas, agrees on a failure, and promotes one. This drill does the promotion by hand so you can see the state change.

::: card
q: The primary dies after acknowledging `SET session:2`. The replica never received it. What does Redis promise you, and what should the application do?
answer: Nothing about that write: replication is async. The application should treat the cache as disposable, re-read from the system of record, and accept a miss. If the data cannot be recomputed, it does not belong in a cache whose failover you are willing to run this way.
:::

::: term peer=cache2
task: |
  `lab` runs the Redis primary. `cache2` is a fresh machine with Redis installed but stopped.

  1. On `cache2`, start Redis as a replica of `lab:6379`. Bind it so the lab can reach it, and disable protected mode for this private lab network.
  2. On `lab`, confirm `INFO replication` shows `role:master` and `connected_slaves:1`.
  3. On `lab`, write `session:2 = bob`; read it on `cache2` (and use `WAIT 1 1000` if you want the acknowledgement).
  4. Stop Redis on `lab`.
  5. On `cache2`, promote it with `REPLICAOF NO ONE`, set `session:3 = carol`, and confirm `session:1`, `session:2` and `session:3` are all readable there.

  The initial key `session:1 = alice` is already on the primary. `lab` can reach `cache2` with `/root/.ssh/peer_key` if you want one shell.
setup: |
  ```bash
  set -e
  redis-server --daemonize yes --bind 0.0.0.0 --protected-mode no --save '' --appendonly no
  sleep 0.5
  redis-cli set session:1 alice >/dev/null
  ssh-keygen -q -t ed25519 -N '' -f /root/.ssh/peer_key
  mkdir -p /tmp/to-peer
  cp /root/.ssh/peer_key.pub /tmp/to-peer/peer_key.pub
  ```
peersetup: |
  ```bash
  set -e
  install -d -m 700 /root/.ssh
  cat /tmp/from-lab/peer_key.pub >> /root/.ssh/authorized_keys
  chmod 600 /root/.ssh/authorized_keys
  systemctl enable --now ssh >/dev/null 2>&1
  redis-cli shutdown nosave >/dev/null 2>&1 || true
  systemctl stop redis-server >/dev/null 2>&1 || true
  ```
verify: |
  ```bash
  if redis-cli ping >/dev/null 2>&1; then echo "Redis on lab is still answering; the primary was not stopped"; exit 1; fi
  ```
peerverify: |
  ```bash
  role=$(redis-cli info replication | sed -n 's/^role://p' | tr -d '\r')
  [ "$role" = "master" ] || { echo "cache2 reports role '$role', not master"; exit 1; }
  vals=$(redis-cli --raw mget session:1 session:2 session:3 | tr '\n' '|')
  [ "$vals" = "alice|bob|carol|" ] || { echo "cache2 has '$vals', expected alice|bob|carol|"; exit 1; }
  ```
solution: |
  ```bash
  ssh -i /root/.ssh/peer_key -o StrictHostKeyChecking=no root@cache2 "redis-server --daemonize yes --bind 0.0.0.0 --protected-mode no --replicaof lab 6379 --save '' --appendonly no"
  sleep 1
  redis-cli info replication | grep -E 'role:|connected_slaves:'
  redis-cli set session:2 bob >/dev/null
  redis-cli wait 1 1000
  ssh -i /root/.ssh/peer_key -o StrictHostKeyChecking=no root@cache2 "redis-cli get session:2"
  redis-cli shutdown nosave
  ssh -i /root/.ssh/peer_key -o StrictHostKeyChecking=no root@cache2 "redis-cli replicaof no one; redis-cli set session:3 carol; redis-cli mget session:1 session:2 session:3"
  ```
hint: `redis-server --replicaof lab 6379` is enough for a lab. The default config binds to loopback and enables protected mode, so the replica's connection will be refused until you change both.
:::

## Shard keys without moving everything
id: cache-hash
stage: cache
needs: cache-evict
minutes: 60
goal: Build a consistent-hash ring with virtual nodes and measure how few keys move when a node joins or leaves.
source: Redis: Cluster specification | https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/
source: Amazon Dynamo paper | https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf

`hash(key) % N` is the obvious shard function and the one that hurts. When `N` changes, almost every key changes owner, so a cache tier loses most of its hit rate at the moment it can least afford to. Consistent hashing puts nodes and keys on the same ring; adding a node takes a slice from its neighbours and leaves the rest alone.

The [Redis Cluster spec](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/) uses a different mechanism (16,384 hash slots, assigned to nodes) for the same reason: the mapping is explicit and only the moved slots change. The [Dynamo paper](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf), section 6.4, is the canonical description of the ring with virtual nodes.

::: quiz
q: Four cache nodes use `hash(key) % 4`. A fifth node is added. Roughly what fraction of keys changes owner?
- About 20%, because one of five nodes is new
+ About 75%, because the modulus changed for almost every key
- None, because the hash of each key did not change
why: Changing the modulus changes the remainder for most keys, not just the ones that would belong to the new node. Consistent hashing bounds the movement to roughly the new node's share of the ring.
:::

::: write lang=typescript
task: Export `hash32(key: string): number` and a `HashRing` class.

  `hash32` is FNV-1a over the UTF-16 code units of the string, as an unsigned 32-bit integer.

  `new HashRing(replicas = 500)` creates an empty ring with that many virtual points per node.
  `add(node)` adds the node and its virtual points; adding the same node twice must not duplicate it.
  `remove(node)` removes the node; removing a node that is not there is a no-op.
  `get(key)` returns the node that owns the key: hash the key, find the first ring point at or after that hash, and wrap to the first point. An empty ring returns `undefined`.

  Use the virtual point name `${node}#${i}` for `i` from 0 to `replicas - 1`.
starter:
```ts
export function hash32(key: string): number {
  return 0
}

export class HashRing {
  replicas: number
  constructor(replicas = 500) {
    this.replicas = replicas
  }
  add(node: string): void {}
  remove(node: string): void {}
  get(key: string): string | undefined {
    return undefined
  }
}
```
tests:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { HashRing, hash32 } from "./solution.ts"

const keys = Array.from({ length: 6000 }, (_, i) => `user:${i}`)

test("hash32 is FNV-1a, unsigned", () => {
  assert.equal(hash32(""), 2166136261)
  assert.equal(hash32("hello"), 1335831723)
  assert.ok(hash32("hello") >= 0)
})

test("an empty ring owns nothing", () => {
  assert.equal(new HashRing().get("a"), undefined)
})

test("a key is stable and only maps to a live node", () => {
  const r = new HashRing()
  r.add("alpha")
  r.add("beta")
  r.add("gamma")
  const first = r.get("user:1")
  assert.ok(first === "alpha" || first === "beta" || first === "gamma")
  for (let i = 0; i < 20; i++) assert.equal(r.get("user:1"), first)
  r.remove("beta")
  assert.notEqual(r.get("user:1"), "beta")
})

test("virtual nodes spread six thousand keys", () => {
  const r = new HashRing()
  for (const n of ["alpha", "beta", "gamma"]) r.add(n)
  const counts: Record<string, number> = { alpha: 0, beta: 0, gamma: 0 }
  for (const k of keys) counts[r.get(k)!]++
  for (const n of ["alpha", "beta", "gamma"]) {
    const share = counts[n] / keys.length
    assert.ok(share > 0.18 && share < 0.5, `${n} owns ${(share * 100).toFixed(1)}%`)
  }
})

test("adding a fourth node moves a minority of keys", () => {
  const before = new HashRing()
  const after = new HashRing()
  for (const n of ["alpha", "beta", "gamma"]) {
    before.add(n)
    after.add(n)
  }
  after.add("delta")
  let moved = 0
  for (const k of keys) if (before.get(k) !== after.get(k)) moved++
  const share = moved / keys.length
  assert.ok(share > 0.1 && share < 0.55, `${(share * 100).toFixed(1)}% moved`)
})

test("removing a node puts its keys back on the ring", () => {
  const r = new HashRing()
  for (const n of ["alpha", "beta", "gamma", "delta"]) r.add(n)
  const owned = keys.filter((k) => r.get(k) === "delta").length
  r.remove("delta")
  for (const k of keys) assert.ok(["alpha", "beta", "gamma"].includes(r.get(k)!))
  assert.ok(owned > 0)
  r.add("delta")
  r.add("delta")
  const again = keys.filter((k) => r.get(k) === "delta").length
  assert.equal(again, owned)
})
```
solution:
```ts
export function hash32(key: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

type Point = { hash: number; node: string }

export class HashRing {
  replicas: number
  private points: Point[] = []
  private nodes = new Set<string>()

  constructor(replicas = 500) {
    this.replicas = replicas
  }

  add(node: string): void {
    if (this.nodes.has(node)) return
    this.nodes.add(node)
    for (let i = 0; i < this.replicas; i++) {
      this.points.push({ hash: hash32(`${node}#${i}`), node })
    }
    this.points.sort((a, b) => a.hash - b.hash)
  }

  remove(node: string): void {
    if (!this.nodes.delete(node)) return
    this.points = this.points.filter((p) => p.node !== node)
  }

  get(key: string): string | undefined {
    if (!this.points.length) return undefined
    const h = hash32(key)
    let lo = 0
    let hi = this.points.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.points[mid]!.hash < h) lo = mid + 1
      else hi = mid
    }
    return this.points[lo % this.points.length]!.node
  }
}
```
wrong: The obvious modulo shard moves almost every key when the node count changes.
```ts
export function hash32(key: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

export class HashRing {
  replicas: number
  private nodes: string[] = []
  constructor(replicas = 500) {
    this.replicas = replicas
  }
  add(node: string): void {
    if (!this.nodes.includes(node)) this.nodes.push(node)
  }
  remove(node: string): void {
    this.nodes = this.nodes.filter((n) => n !== node)
  }
  get(key: string): string | undefined {
    if (!this.nodes.length) return undefined
    return this.nodes[hash32(key) % this.nodes.length]
  }
}
```
wrong: One point per node is not enough; the ring is badly unbalanced.
```ts
export function hash32(key: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

export class HashRing {
  replicas: number
  private points: { hash: number; node: string }[] = []
  private nodes = new Set<string>()
  constructor(replicas = 500) {
    this.replicas = replicas
  }
  add(node: string): void {
    if (this.nodes.has(node)) return
    this.nodes.add(node)
    this.points.push({ hash: hash32(node), node })
    this.points.sort((a, b) => a.hash - b.hash)
  }
  remove(node: string): void {
    if (!this.nodes.delete(node)) return
    this.points = this.points.filter((p) => p.node !== node)
  }
  get(key: string): string | undefined {
    if (!this.points.length) return undefined
    const h = hash32(key)
    let lo = 0
    let hi = this.points.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.points[mid]!.hash < h) lo = mid + 1
      else hi = mid
    }
    return this.points[lo % this.points.length]!.node
  }
}
```
hint: Keep the ring points sorted and binary-search the first point with `hash >= keyHash`; the wrap is `index % length`. Virtual nodes are not decoration: with one point per node, the arcs are wildly unequal.
:::

## One miss, one load
id: cache-stampede
stage: cache
needs: cache-hash
minutes: 60
goal: Build a single-flight cache so concurrent misses share one load, expired entries refresh, and failures are not cached.
source: AWS Builders' Library: Caching challenges and strategies | https://aws.amazon.com/builders-library/caching-challenges-and-strategies/
source: Azure Architecture Center: Cache-Aside pattern | https://learn.microsoft.com/en-us/azure/architecture/patterns/cache-aside
source: Go: singleflight | https://pkg.go.dev/golang.org/x/sync/singleflight

A cache miss is not one request. It is every request that arrives between the miss and the fill, and they all ask the same expensive question. The cache-aside pattern's simple `get` / on miss `load` / `set` has a hole exactly there. Single-flight closes it by making the in-flight load itself the shared object.

The [Builders' Library article](https://aws.amazon.com/builders-library/caching-challenges-and-strategies/) covers stampedes, thundering herds and the expiry edge. The [Cache-Aside pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/cache-aside) is the baseline; Go's [singleflight](https://pkg.go.dev/golang.org/x/sync/singleflight) is the smallest useful implementation of the missing piece.

::: quiz
q: A hot key expires and 500 requests miss at once. The loader takes 200 ms. What does a single-flight cache change?
- It makes the loader faster
+ It lets one request load and makes the other 499 await the same result
- It prevents the key from expiring
why: Single-flight coalesces concurrent misses for the same key. It does not reduce the loader's latency or make the TTL longer; it removes the duplicate work and the burst on the backing store.
:::

::: write lang=typescript
task: Export `SingleFlightCache<K, V>`.

  `new SingleFlightCache(loader, ttlMs, now = Date.now)` takes an async `loader(key)`, a time-to-live, and a clock.

  `get(key)` returns a promise:
  - if a fresh value is cached, resolve with it;
  - if a load for that key is already in flight, return the **same** promise (do not call the loader again);
  - otherwise call the loader once, cache the value with an expiry of `now() + ttlMs`, and clear the in-flight entry;
  - if the loader rejects, clear the in-flight entry and do **not** cache the failure; every caller waiting on that load sees the rejection, and the next `get` tries again.

  Different keys load independently. An expired value is treated as a miss.

starter:
```ts
export type Loader<K, V> = (key: K) => Promise<V>

export class SingleFlightCache<K, V> {
  private loader: Loader<K, V>
  private ttlMs: number
  private now: () => number

  constructor(loader: Loader<K, V>, ttlMs: number, now: () => number = Date.now) {
    this.loader = loader
    this.ttlMs = ttlMs
    this.now = now
  }

  async get(key: K): Promise<V> {
    return this.loader(key)
  }
}
```
tests:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { SingleFlightCache } from "./solution.ts"

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test("concurrent misses for one key share one load", async () => {
  let calls = 0
  const d = deferred<string>()
  const cache = new SingleFlightCache(async () => {
    calls++
    return d.promise
  }, 1000)
  const a = cache.get("k")
  const b = cache.get("k")
  const c = cache.get("k")
  assert.equal(calls, 1)
  d.resolve("value")
  assert.deepEqual(await Promise.all([a, b, c]), ["value", "value", "value"])
  assert.equal(calls, 1)
})

test("a cached value is returned until it expires", async () => {
  let t = 0
  let calls = 0
  const cache = new SingleFlightCache(async () => {
    calls++
    return `v${calls}`
  }, 100, () => t)
  assert.equal(await cache.get("k"), "v1")
  assert.equal(await cache.get("k"), "v1")
  t = 101
  assert.equal(await cache.get("k"), "v2")
  assert.equal(calls, 2)
})

test("different keys load independently", async () => {
  let calls = 0
  const cache = new SingleFlightCache(async (k: string) => {
    calls++
    return k.toUpperCase()
  }, 1000)
  assert.deepEqual(await Promise.all([cache.get("a"), cache.get("b")]), ["A", "B"])
  assert.equal(calls, 2)
})

test("a failed load is shared but not cached", async () => {
  let calls = 0
  const cache = new SingleFlightCache(async () => {
    calls++
    if (calls === 1) throw new Error("boom")
    return "ok"
  }, 1000)
  const a = cache.get("k")
  const b = cache.get("k")
  await assert.rejects(a, /boom/)
  await assert.rejects(b, /boom/)
  assert.equal(calls, 1)
  assert.equal(await cache.get("k"), "ok")
  assert.equal(calls, 2)
})
```
solution:
```ts
export type Loader<K, V> = (key: K) => Promise<V>

type Entry<V> = { value: V; expires: number }

export class SingleFlightCache<K, V> {
  private values = new Map<K, Entry<V>>()
  private flights = new Map<K, Promise<V>>()

  private loader: Loader<K, V>
  private ttlMs: number
  private now: () => number

  constructor(loader: Loader<K, V>, ttlMs: number, now: () => number = Date.now) {
    this.loader = loader
    this.ttlMs = ttlMs
    this.now = now
  }

  get(key: K): Promise<V> {
    const hit = this.values.get(key)
    if (hit && hit.expires > this.now()) return Promise.resolve(hit.value)
    const flight = this.flights.get(key)
    if (flight) return flight
    const p = this.loader(key)
      .then((value) => {
        this.values.set(key, { value, expires: this.now() + this.ttlMs })
        return value
      })
      .finally(() => {
        this.flights.delete(key)
      })
    this.flights.set(key, p)
    return p
  }
}
```
wrong: No in-flight map: every concurrent miss calls the loader.
```ts
export type Loader<K, V> = (key: K) => Promise<V>

export class SingleFlightCache<K, V> {
  private values = new Map<K, { value: V; expires: number }>()
  private loader: Loader<K, V>
  private ttlMs: number
  private now: () => number

  constructor(loader: Loader<K, V>, ttlMs: number, now: () => number = Date.now) {
    this.loader = loader
    this.ttlMs = ttlMs
    this.now = now
  }
  async get(key: K): Promise<V> {
    const hit = this.values.get(key)
    if (hit && hit.expires > this.now()) return hit.value
    const value = await this.loader(key)
    this.values.set(key, { value, expires: this.now() + this.ttlMs })
    return value
  }
}
```
wrong: The failure is cached because the rejected promise is stored as the in-flight entry and never cleared.
```ts
export type Loader<K, V> = (key: K) => Promise<V>

export class SingleFlightCache<K, V> {
  private values = new Map<K, { value: V; expires: number }>()
  private flights = new Map<K, Promise<V>>()
  private loader: Loader<K, V>
  private ttlMs: number
  private now: () => number

  constructor(loader: Loader<K, V>, ttlMs: number, now: () => number = Date.now) {
    this.loader = loader
    this.ttlMs = ttlMs
    this.now = now
  }
  get(key: K): Promise<V> {
    const hit = this.values.get(key)
    if (hit && hit.expires > this.now()) return Promise.resolve(hit.value)
    const flight = this.flights.get(key)
    if (flight) return flight
    const p = this.loader(key).then((value) => {
      this.values.set(key, { value, expires: this.now() + this.ttlMs })
      return value
    })
    this.flights.set(key, p)
    return p
  }
}
```
hint: Store the promise in the map before you await anything, and remove it in `finally`. Caching the resolved value is a separate map; a rejected load must leave both the value cache and the in-flight map clean.
:::

## A queue in the database, with SKIP LOCKED
id: msg-queue
stage: msg
needs: sql/transactions, pg-locks
minutes: 65
goal: Build a durable worker queue in PostgreSQL that reclaims stale claims and never hands the same job to two live workers.
source: PostgreSQL: SELECT, locking clause | https://www.postgresql.org/docs/current/sql-select.html
source: PostgreSQL: Explicit locking | https://www.postgresql.org/docs/current/explicit-locking.html
source: AWS Builders' Library: Avoiding insurmountable queue backlogs | https://aws.amazon.com/builders-library/avoiding-insurmountable-queue-backlogs/

A queue is a table plus a claim protocol. The protocol has to answer three questions at once: how does a worker take one row without taking the queue, how does a second worker take a different row, and what happens when a worker dies holding a row? `FOR UPDATE SKIP LOCKED` answers the first two; a visibility deadline answers the third.

The [SELECT](https://www.postgresql.org/docs/current/sql-select.html) page documents `SKIP LOCKED` and its warning: it is for queue-like tables, because it returns an inconsistent view. The [queue backlog](https://aws.amazon.com/builders-library/avoiding-insurmountable-queue-backlogs/) article is the operational counterpart: a queue that only grows is a outage with a delay.

::: card
q: Why is `SKIP LOCKED` wrong for a ledger balance query but right for a job queue?
answer: `SKIP LOCKED` silently omits rows that another transaction has locked, so a query that is supposed to see a consistent set of accounts can miss money. A queue wants exactly that behavior: a worker should skip a row another worker already owns and take a different one. The clause is a scheduling tool, not a consistency tool.
:::

::: term
task: |
  The `queue` database has 60 jobs and a `job_runs` audit table. Five jobs were left `running` with `locked_at` ten minutes ago by a worker that crashed.

  Write `/root/worker.sh`:
  - it reads `WORKER` from the environment (default `w1`);
  - it repeatedly claims **one** pending job, or one `running` job whose `locked_at` is older than two minutes, using `FOR UPDATE SKIP LOCKED`;
  - it inserts a row into `job_runs(job_id, worker)`, then marks the job `done` and clears the lock;
  - it exits when there is no claimable job.

  Then run two workers at the same time:

  ```bash
  WORKER=a /root/worker.sh &
  WORKER=b /root/worker.sh &
  wait
  ```

  Every one of the 60 jobs must be `done`, each must appear exactly once in `job_runs`, and the five stale jobs must have been reclaimed. Do not add a unique constraint to hide a duplicate; the point is the claim protocol.
setup: |
  ```bash
  set -e
  pg_ctlcluster 16 main start
  su postgres -c "psql -q -c 'drop database if exists queue'"
  su postgres -c "createdb queue"
  su postgres -c "psql -q -d queue -c \"
    create table jobs(
      id serial primary key,
      payload text not null,
      status text not null default 'pending',
      locked_at timestamptz,
      locked_by text
    );
    create table job_runs(
      id serial primary key,
      job_id int not null,
      worker text not null,
      at timestamptz not null default now()
    );
    insert into jobs(payload) select 'job-' || g from generate_series(1, 55) g;
    insert into jobs(payload, status, locked_at, locked_by)
      select 'stale-' || g, 'running', now() - interval '10 minutes', 'crashed'
      from generate_series(1, 5) g;
  \""
  ```
verify: |
  ```bash
  runs=$(su postgres -c "psql -d queue -Atc 'select count(*) from job_runs'")
  distinct=$(su postgres -c "psql -d queue -Atc 'select count(distinct job_id) from job_runs'")
  [ "$runs" = "60" ] || { echo "job_runs has $runs rows, expected 60 (one per job)"; exit 1; }
  [ "$distinct" = "60" ] || { echo "job_runs covers $distinct distinct jobs; some job was processed twice"; exit 1; }
  open=$(su postgres -c "psql -d queue -Atc \"select count(*) from jobs where status <> 'done'\"")
  [ "$open" = "0" ] || { echo "$open jobs are not done"; exit 1; }
  stale=$(su postgres -c "psql -d queue -Atc \"select count(*) from jobs where id > 55 and status = 'done'\"")
  [ "$stale" = "5" ] || { echo "only $stale of the five stale jobs were reclaimed"; exit 1; }
  ```
solution: |
  ```bash
  cat > /root/worker.sh <<'EOF'
  #!/bin/bash
  set -euo pipefail
  worker="${WORKER:-w1}"
  while true; do
    job=$(su postgres -c "psql -d queue -Atqc \"
      update jobs set status = 'running', locked_by = '$worker', locked_at = now()
      where id = (
        select id from jobs
        where status = 'pending'
           or (status = 'running' and locked_at < now() - interval '2 minutes')
        order by id
        for update skip locked
        limit 1
      )
      returning id;\"")
    [ -n "$job" ] || break
    su postgres -c "psql -q -d queue -c \"
      insert into job_runs(job_id, worker) values ($job, '$worker');
      update jobs set status = 'done', locked_at = null, locked_by = null where id = $job;
    \""
  done
  EOF
  chmod +x /root/worker.sh
  WORKER=a /root/worker.sh &
  WORKER=b /root/worker.sh &
  wait
  su postgres -c "psql -d queue -c 'select count(*), count(distinct job_id) from job_runs'"
  ```
hint: `psql -Atqc` prints only the returned id; without `-q`, the `UPDATE 1` command tag comes along and becomes part of the next SQL statement. The stale predicate belongs in the subquery that chooses the row, not in the outer update.
:::

## At-least-once means dedupe
id: msg-idempotent
stage: msg
needs: msg-queue
minutes: 55
goal: Build a consumer that survives redelivery: claim an event id atomically, release on failure, and never apply the same effect twice.
source: NATS: JetStream consumers | https://docs.nats.io/nats-concepts/jetstream/consumers
source: Kafka: Message delivery semantics | https://kafka.apache.org/documentation/#semantics
source: microservices.io: Idempotent consumer | https://microservices.io/patterns/communication-style/idempotent-consumer.html

A durable message system gives you at-least-once delivery or at-most-once, and the useful one is at-least-once. The broker will redeliver after a timeout, a crash, or a lost acknowledgement. That makes **the consumer** responsible for turning "at least once" into "exactly once in effect" with an idempotency key.

The [JetStream consumer](https://docs.nats.io/nats-concepts/jetstream/consumers) docs describe acknowledgements, redelivery and `ack_wait`; Kafka's [delivery semantics](https://kafka.apache.org/documentation/#semantics) section makes the same distinction. The [idempotent consumer](https://microservices.io/patterns/communication-style/idempotent-consumer.html) pattern is the shape below: claim the key, do the work, mark it complete; a duplicate delivery finds the claim and does nothing.

::: quiz
q: A consumer claims an idempotency key, then crashes before the side effect is committed. What should happen on redelivery?
- The key stays claimed, so the message is dropped
+ The claim must expire or be released, so the redelivery can retry the side effect
- The broker must remove the message permanently
why: A claim that outlives the work turns at-least-once into at-most-once by accident. The claim and the side effect need a shared commit, or the claim needs a lease/TTL that a dead consumer cannot renew.
:::

::: write lang=typescript
task: Export `consume(event, store, apply)`.

  `event` has an `id: string`. `store` has three synchronous methods: `claim(id)` returns true only for the first caller and records the claim atomically; `release(id)` removes it; `complete(id)` marks it done. `apply()` performs the side effect and may be async.

  Return `"processed"` when this call claimed the event and `apply` succeeded. Return `"duplicate"` when `claim` returns false; do not call `apply`.

  If `claim` succeeds but `apply` throws or rejects, call `release(id)` and rethrow the same error, so a redelivery can try again. Call `complete(id)` only after `apply` succeeds.

starter:
```ts
export type Store = {
  claim(id: string): boolean
  release(id: string): void
  complete(id: string): void
}

export async function consume(
  event: { id: string },
  store: Store,
  apply: () => Promise<void> | void
): Promise<"processed" | "duplicate"> {
  await apply()
  return "processed"
}
```
tests:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { consume, type Store } from "./solution.ts"

function memoryStore(): Store & { claimed: Set<string>; completed: Set<string> } {
  const claimed = new Set<string>()
  const completed = new Set<string>()
  return {
    claimed,
    completed,
    claim(id) {
      if (claimed.has(id)) return false
      claimed.add(id)
      return true
    },
    release(id) {
      claimed.delete(id)
    },
    complete(id) {
      completed.add(id)
    }
  }
}

test("the first delivery applies once, the redelivery is a duplicate", async () => {
  const store = memoryStore()
  let calls = 0
  const apply = () => {
    calls++
  }
  assert.equal(await consume({ id: "e1" }, store, apply), "processed")
  assert.equal(await consume({ id: "e1" }, store, apply), "duplicate")
  assert.equal(calls, 1)
  assert.ok(store.completed.has("e1"))
})

test("concurrent duplicate deliveries do not both apply", async () => {
  const store = memoryStore()
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const apply = async () => {
    calls++
    await gate
  }
  const a = consume({ id: "e2" }, store, apply)
  const b = consume({ id: "e2" }, store, apply)
  release()
  const results = await Promise.all([a, b])
  assert.deepEqual(results.sort(), ["duplicate", "processed"])
  assert.equal(calls, 1)
})

test("a failed apply releases the claim for a retry", async () => {
  const store = memoryStore()
  let calls = 0
  const apply = async () => {
    calls++
    if (calls === 1) throw new Error("temporary")
    return
  }
  await assert.rejects(consume({ id: "e3" }, store, apply), /temporary/)
  assert.equal(await consume({ id: "e3" }, store, apply), "processed")
  assert.equal(calls, 2)
  assert.ok(store.completed.has("e3"))
})

test("complete happens after apply, not before", async () => {
  const store = memoryStore()
  let completedDuringApply = false
  await consume({ id: "e4" }, store, () => {
    completedDuringApply = store.completed.has("e4")
  })
  assert.equal(completedDuringApply, false)
  assert.ok(store.completed.has("e4"))
})
```
solution:
```ts
export type Store = {
  claim(id: string): boolean
  release(id: string): void
  complete(id: string): void
}

export async function consume(
  event: { id: string },
  store: Store,
  apply: () => Promise<void> | void
): Promise<"processed" | "duplicate"> {
  if (!store.claim(event.id)) return "duplicate"
  try {
    await apply()
    store.complete(event.id)
    return "processed"
  } catch (err) {
    store.release(event.id)
    throw err
  }
}
```
wrong: It applies first and never claims, so every redelivery has the effect again.
```ts
export type Store = {
  claim(id: string): boolean
  release(id: string): void
  complete(id: string): void
}

export async function consume(
  event: { id: string },
  store: Store,
  apply: () => Promise<void> | void
): Promise<"processed" | "duplicate"> {
  await apply()
  store.complete(event.id)
  return "processed"
}
```
wrong: It releases only after a successful completion, so a failed apply leaves the event claimed forever.
```ts
export type Store = {
  claim(id: string): boolean
  release(id: string): void
  complete(id: string): void
}

export async function consume(
  event: { id: string },
  store: Store,
  apply: () => Promise<void> | void
): Promise<"processed" | "duplicate"> {
  if (!store.claim(event.id)) return "duplicate"
  await apply()
  store.complete(event.id)
  return "processed"
}
```
hint: The `try` must wrap the `apply` and the `complete`, but the `catch` only needs to release. Return `"duplicate"` before any work starts.
:::

## JetStream and Kafka: what the broker promises
id: msg-jetstream
stage: msg
needs: msg-queue, msg-idempotent
minutes: 50
goal: Tell apart streams, consumers, acks, retention and partitions, and know which guarantee belongs to the broker and which to the consumer.
source: NATS: JetStream | https://docs.nats.io/nats-concepts/jetstream
source: NATS: Streams | https://docs.nats.io/nats-concepts/jetstream/streams
source: Apache Kafka: Documentation | https://kafka.apache.org/documentation/

JetStream and Kafka solve the same problem with different nouns. A **stream** (JetStream) or **topic** (Kafka) is the durable log. A **consumer** (JetStream) or **consumer group** (Kafka) is the cursor plus the delivery policy. Retention is a property of the log; acknowledgement is a property of the consumer; ordering is a property of the partition or subject.

Read the [JetStream overview](https://docs.nats.io/nats-concepts/jetstream), then [streams](https://docs.nats.io/nats-concepts/jetstream/streams) and [consumers](https://docs.nats.io/nats-concepts/jetstream/consumers). For Kafka, read the [documentation introduction](https://kafka.apache.org/documentation/) and the delivery-semantics section. The details differ; the questions to ask are the same.

::: quiz
q: A JetStream consumer is configured with `ack_wait` of 30 seconds and the handler takes 45 seconds. What happens?
- The message is acknowledged at 45 seconds and delivered once
+ The server considers the ack late and redelivers the message while the first handler is still running
- The stream is deleted after 30 seconds
why: `ack_wait` is the server's deadline, not the handler's timeout. A handler slower than the ack window gets a concurrent redelivery, so the consumer must be idempotent or extend the ack deadline (`AckProgress`/`InProgress`) while it works.
:::

::: quiz
q: Two Kafka consumers in the same consumer group read a topic with four partitions. How many partitions can each consumer process at once?
- Both can process all four, because the group shares the topic
+ The partitions are divided between them; each gets a subset, and one gets at least two
- Exactly one partition total, because a group has one active consumer
why: A partition is assigned to at most one consumer in a group at a time, which is what gives per-partition ordering and parallel consumption. With two consumers and four partitions, each gets two.
:::

::: card
q: What does "exactly once" mean in Kafka, and what does it not mean for your side effect?
answer: Kafka's exactly-once semantics cover the broker transaction: the produced records and the consumed offsets commit together, so a restart does not replay or duplicate within that boundary. It does not make an external side effect (charge a card, send an email) exactly once. That still needs an idempotency key or a transactional outbox.
:::

::: card
q: A stream has a retention limit of one hour. A consumer is down for two hours. What is the correct statement about the missed messages?
answer: They are gone from the stream once retention removes them, regardless of the consumer's cursor. Retention is a property of the log, not of the consumer. A consumer that needs a longer replay window requires a longer retention policy, an archive, or a different store.
:::

::: quiz
q: Which failure does a durable log with at-least-once delivery **not** remove by itself?
- A broker losing an acknowledged write
+ A consumer applying the same message twice after a redelivery
- A producer retrying after a timeout
why: At-least-once explicitly allows redelivery, so duplicate application is the consumer's problem. Broker replication addresses lost writes; producer idempotence addresses duplicate production. The consumer still needs dedupe.
:::

## Retry with a budget, not a reflex
id: overload-retry
stage: overload
minutes: 55
goal: Implement exponential backoff with full jitter, a hard deadline, and a retry predicate that refuses non-retryable errors.
source: AWS Builders' Library: Timeouts, retries and backoff with jitter | https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/
source: Google SRE: Handling overload | https://sre.google/sre-book/handling-overload/
source: Azure Architecture Center: Retry pattern | https://learn.microsoft.com/en-us/azure/architecture/patterns/retry

A retry is a bet that the next attempt will differ. If the dependency is overloaded, the retry is a second request arriving at the worst possible time, and synchronised retries turn one blip into a self-inflicted outage. Jitter spreads the retries; a deadline stops a request from spending its entire budget waiting to try again.

The [Builders' Library article](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/) explains full jitter and why it beats exponential backoff alone. Google's [Handling overload](https://sre.google/sre-book/handling-overload/) covers retry budgets and client-side rejection; the [Retry pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/retry) is the baseline shape.

::: quiz
q: A service retries every failed request three times immediately. The dependency is at 100% CPU. What does the retry do?
- It gives the dependency three chances to recover
+ It multiplies the load on a system that is already failing, and can keep it down
- It reduces the tail latency because some attempts succeed
why: Retries do not create capacity. Without backoff, jitter and a budget, they amplify the overload and synchronise clients. The dependency needs less work, not more attempts.
:::

::: write lang=typescript
task: Export `retry(op, options)`.

  `op(attempt)` is async and receives the 1-based attempt number. `options` has:
  - `attempts`: maximum attempts, including the first;
  - `baseMs`, `maxMs`: the exponential backoff bounds;
  - `deadline`: optional absolute timestamp (same clock as `now`);
  - `now`: clock, default `Date.now`;
  - `sleep(ms)`: async sleep, injected for tests;
  - `random`: returns a number in `[0, 1)`, default `Math.random`;
  - `retryOn(err, attempt)`: optional predicate, default retry everything.

  On failure, if this was the last attempt or `retryOn` returns false, throw the error. Otherwise compute `delay = floor(random() * min(maxMs, baseMs * 2 ** (attempt - 1)))`. If a deadline is set and `now() + delay >= deadline`, throw the error **without sleeping**. Otherwise sleep, then try again.

  A successful attempt returns its value immediately. Full jitter means the delay is a random value between zero and that exponential cap, not the cap itself.
starter:
```ts
export type RetryOptions = {
  attempts: number
  baseMs: number
  maxMs: number
  deadline?: number
  now?: () => number
  sleep: (ms: number) => Promise<void>
  random?: () => number
  retryOn?: (err: unknown, attempt: number) => boolean
}

export async function retry<T>(op: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  return op(1)
}
```
tests:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { retry } from "./solution.ts"

function harness() {
  const sleeps: number[] = []
  let t = 0
  return {
    sleeps,
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      t += ms
    },
    advance: (ms: number) => {
      t += ms
    }
  }
}

test("a success on the first attempt does not sleep", async () => {
  const h = harness()
  assert.equal(await retry(async () => "ok", { attempts: 3, baseMs: 100, maxMs: 1000, sleep: h.sleep, now: h.now }), "ok")
  assert.deepEqual(h.sleeps, [])
})

test("full jitter doubles the cap and caps at maxMs", async () => {
  const h = harness()
  let calls = 0
  const op = async () => {
    calls++
    if (calls < 4) throw new Error("again")
    return "ok"
  }
  assert.equal(await retry(op, { attempts: 4, baseMs: 100, maxMs: 150, sleep: h.sleep, now: h.now, random: () => 1 }), "ok")
  assert.deepEqual(h.sleeps, [100, 150, 150])
})

test("random zero means no wait, not a fixed delay", async () => {
  const h = harness()
  let calls = 0
  const op = async () => {
    calls++
    if (calls === 1) throw new Error("again")
    return "ok"
  }
  await retry(op, { attempts: 2, baseMs: 1000, maxMs: 5000, sleep: h.sleep, now: h.now, random: () => 0 })
  assert.deepEqual(h.sleeps, [0])
})

test("the deadline stops a retry before it sleeps", async () => {
  const h = harness()
  let calls = 0
  const op = async () => {
    calls++
    throw new Error("nope")
  }
  await assert.rejects(
    retry(op, { attempts: 5, baseMs: 100, maxMs: 1000, deadline: 50, sleep: h.sleep, now: h.now, random: () => 1 }),
    /nope/
  )
  assert.equal(calls, 1)
  assert.deepEqual(h.sleeps, [])
})

test("retryOn false stops immediately and the last error wins", async () => {
  const h = harness()
  let calls = 0
  const op = async () => {
    calls++
    throw new Error(`e${calls}`)
  }
  await assert.rejects(
    retry(op, { attempts: 5, baseMs: 10, maxMs: 10, sleep: h.sleep, now: h.now, random: () => 1, retryOn: () => false }),
    /e1/
  )
  assert.equal(calls, 1)
  assert.deepEqual(h.sleeps, [])
})

test("exhaustion throws the last error", async () => {
  const h = harness()
  let calls = 0
  const op = async () => {
    calls++
    throw new Error(`e${calls}`)
  }
  await assert.rejects(
    retry(op, { attempts: 3, baseMs: 10, maxMs: 10, sleep: h.sleep, now: h.now, random: () => 1 }),
    /e3/
  )
  assert.equal(calls, 3)
})
```
solution:
```ts
export type RetryOptions = {
  attempts: number
  baseMs: number
  maxMs: number
  deadline?: number
  now?: () => number
  sleep: (ms: number) => Promise<void>
  random?: () => number
  retryOn?: (err: unknown, attempt: number) => boolean
}

export async function retry<T>(op: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random
  const retryOn = options.retryOn ?? (() => true)
  let last: unknown
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    try {
      return await op(attempt)
    } catch (err) {
      last = err
      if (attempt === options.attempts || !retryOn(err, attempt)) throw err
      const cap = Math.min(options.maxMs, options.baseMs * 2 ** (attempt - 1))
      const delay = Math.floor(random() * cap)
      if (options.deadline !== undefined && now() + delay >= options.deadline) throw err
      await options.sleep(delay)
    }
  }
  throw last
}
```
wrong: A fixed delay ignores backoff, jitter and the deadline.
```ts
export type RetryOptions = {
  attempts: number
  baseMs: number
  maxMs: number
  deadline?: number
  now?: () => number
  sleep: (ms: number) => Promise<void>
  random?: () => number
  retryOn?: (err: unknown, attempt: number) => boolean
}

export async function retry<T>(op: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  let last: unknown
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    try {
      return await op(attempt)
    } catch (err) {
      last = err
      if (attempt === options.attempts) throw err
      await options.sleep(options.baseMs)
    }
  }
  throw last
}
```
wrong: It retries errors the caller said not to retry.
```ts
export type RetryOptions = {
  attempts: number
  baseMs: number
  maxMs: number
  deadline?: number
  now?: () => number
  sleep: (ms: number) => Promise<void>
  random?: () => number
  retryOn?: (err: unknown, attempt: number) => boolean
}

export async function retry<T>(op: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random
  let last: unknown
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    try {
      return await op(attempt)
    } catch (err) {
      last = err
      if (attempt === options.attempts) throw err
      const cap = Math.min(options.maxMs, options.baseMs * 2 ** (attempt - 1))
      const delay = Math.floor(random() * cap)
      if (options.deadline !== undefined && now() + delay >= options.deadline) throw err
      await options.sleep(delay)
    }
  }
  throw last
}
```
hint: Compute the cap from the attempt that just failed, then multiply by `random()` for full jitter. The deadline check is before the sleep; sleeping and then discovering you are out of budget is the bug.
:::

## Break the circuit before the dependency does
id: overload-breaker
stage: overload
needs: overload-retry
minutes: 55
goal: Implement closed, open and half-open states with a cooldown, one trial at a time, and a reset on success.
source: Azure Architecture Center: Circuit Breaker pattern | https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker
source: Google SRE: Addressing cascading failures | https://sre.google/sre-book/addressing-cascading-failures/

A circuit breaker is a failure detector with a memory. After enough consecutive failures it stops calling the dependency at all, so the dependency gets room to recover and the caller fails fast instead of waiting on a timeout. After a cooldown it lets one trial through: success closes the circuit, failure reopens it with a fresh cooldown.

The [Circuit Breaker pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker) covers the states and the half-open probe. Google's [Addressing cascading failures](https://sre.google/sre-book/addressing-cascading-failures/) explains why failing fast is often the only way to keep the rest of the system alive.

::: quiz
q: Why does half-open allow only one trial, not all waiting requests?
- Because one success is enough to prove the dependency is healthy for every request
+ Because a burst of trials recreates the overload that opened the circuit
- Because the circuit is still fully open
why: Half-open is a probe, not a reopening. Letting the whole backlog through at once turns the recovery test into the next outage. One trial (or a small, bounded number) tells you whether to close; the rest keep failing fast until it does.
:::

::: write lang=typescript
task: Export `CircuitBreaker`.

  `new CircuitBreaker({ failureThreshold, cooldownMs, now = Date.now })`.

  - `allow()`: in `closed`, return true; in `open`, if the cooldown has elapsed, move to `half-open` and allow **one** trial; otherwise false; in `half-open`, return false while a trial is outstanding.
  - `succeed()`: in `half-open`, close the circuit and reset the failure count; in `closed`, reset the failure count.
  - `fail()`: increment consecutive failures; if the threshold is reached, or the failure happened during a half-open trial, open the circuit and restart the cooldown.
  - `state()`: return `"closed"`, `"open"` or `"half-open"`. It must report `"half-open"` after the cooldown has elapsed, even before `allow()` is called.

  A success in the closed state resets the consecutive-failure count, so three failures spread across successes do not open the circuit.

starter:
```ts
export type BreakerState = "closed" | "open" | "half-open"

export class CircuitBreaker {
  constructor(options: { failureThreshold: number; cooldownMs: number; now?: () => number }) {}
  allow(): boolean {
    return true
  }
  succeed(): void {}
  fail(): void {}
  state(): BreakerState {
    return "closed"
  }
}
```
tests:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { CircuitBreaker } from "./solution.ts"

function clock() {
  let t = 0
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

test("closed allows, and consecutive failures open at the threshold", () => {
  const c = clock()
  const b = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, now: c.now })
  assert.equal(b.state(), "closed")
  assert.equal(b.allow(), true)
  b.fail()
  b.fail()
  assert.equal(b.state(), "closed")
  b.fail()
  assert.equal(b.state(), "open")
  assert.equal(b.allow(), false)
})

test("a success resets the failure count", () => {
  const c = clock()
  const b = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: c.now })
  b.fail()
  b.succeed()
  b.fail()
  assert.equal(b.state(), "closed")
  b.fail()
  assert.equal(b.state(), "open")
})

test("after the cooldown exactly one trial is allowed", () => {
  const c = clock()
  const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: c.now })
  b.fail()
  assert.equal(b.allow(), false)
  c.advance(1000)
  assert.equal(b.state(), "half-open")
  assert.equal(b.allow(), true)
  assert.equal(b.allow(), false)
  b.succeed()
  assert.equal(b.state(), "closed")
  assert.equal(b.allow(), true)
})

test("a failed trial reopens with a fresh cooldown", () => {
  const c = clock()
  const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: c.now })
  b.fail()
  c.advance(1000)
  assert.equal(b.allow(), true)
  b.fail()
  assert.equal(b.state(), "open")
  assert.equal(b.allow(), false)
  c.advance(999)
  assert.equal(b.allow(), false)
  c.advance(1)
  assert.equal(b.allow(), true)
})
```
solution:
```ts
export type BreakerState = "closed" | "open" | "half-open"

export class CircuitBreaker {
  private failureThreshold: number
  private cooldownMs: number
  private now: () => number
  private failures = 0
  private openedAt = 0
  private halfOpen = false
  private trial = false

  constructor(options: { failureThreshold: number; cooldownMs: number; now?: () => number }) {
    this.failureThreshold = options.failureThreshold
    this.cooldownMs = options.cooldownMs
    this.now = options.now ?? Date.now
  }

  private cooledDown(): boolean {
    return this.halfOpen || this.now() - this.openedAt >= this.cooldownMs
  }

  state(): BreakerState {
    if (this.halfOpen) return "half-open"
    if (this.failures < this.failureThreshold) return "closed"
    return this.cooledDown() ? "half-open" : "open"
  }

  allow(): boolean {
    if (!this.halfOpen) {
      if (this.failures < this.failureThreshold) return true
      if (this.now() - this.openedAt < this.cooldownMs) return false
      this.halfOpen = true
      this.trial = false
    }
    if (this.trial) return false
    this.trial = true
    return true
  }

  succeed(): void {
    this.failures = 0
    this.halfOpen = false
    this.trial = false
  }

  fail(): void {
    if (this.halfOpen) {
      this.halfOpen = false
      this.trial = false
      this.openedAt = this.now()
      return
    }
    this.failures++
    if (this.failures >= this.failureThreshold) {
      this.halfOpen = false
      this.trial = false
      this.openedAt = this.now()
    }
  }
}
```
wrong: There is no half-open transition, so the breaker never recovers.
```ts
export type BreakerState = "closed" | "open" | "half-open"

export class CircuitBreaker {
  private failureThreshold: number
  private cooldownMs: number
  private now: () => number
  private failures = 0
  private openedAt = 0

  constructor(options: { failureThreshold: number; cooldownMs: number; now?: () => number }) {
    this.failureThreshold = options.failureThreshold
    this.cooldownMs = options.cooldownMs
    this.now = options.now ?? Date.now
  }

  state(): BreakerState {
    return this.failures >= this.failureThreshold ? "open" : "closed"
  }

  allow(): boolean {
    return this.failures < this.failureThreshold
  }

  succeed(): void {
    this.failures = 0
  }

  fail(): void {
    this.failures++
    this.openedAt = this.now()
  }
}
```
wrong: The half-open state lets every waiting caller through, recreating the burst.
```ts
export type BreakerState = "closed" | "open" | "half-open"

export class CircuitBreaker {
  private failureThreshold: number
  private cooldownMs: number
  private now: () => number
  private failures = 0
  private openedAt = 0

  constructor(options: { failureThreshold: number; cooldownMs: number; now?: () => number }) {
    this.failureThreshold = options.failureThreshold
    this.cooldownMs = options.cooldownMs
    this.now = options.now ?? Date.now
  }

  state(): BreakerState {
    if (this.failures < this.failureThreshold) return "closed"
    return this.now() - this.openedAt >= this.cooldownMs ? "half-open" : "open"
  }

  allow(): boolean {
    return this.state() !== "open"
  }

  succeed(): void {
    this.failures = 0
  }

  fail(): void {
    this.failures++
    if (this.state() === "half-open") this.openedAt = this.now()
    if (this.failures >= this.failureThreshold && this.state() === "closed") this.openedAt = this.now()
  }
}
```
hint: Track a boolean for "half-open" and another for "trial in flight". `state()` is a view, but `allow()` is the transition; do not let two callers both see a half-open circuit and both take the trial.
:::

## Shed load by priority, not by accident
id: overload-bounded
stage: overload
needs: overload-retry
minutes: 50
goal: Build a bounded queue that rejects or evicts low-priority work when full, and never grows without limit.
source: Google SRE: Handling overload | https://sre.google/sre-book/handling-overload/
source: AWS Builders' Library: Avoiding insurmountable queue backlogs | https://aws.amazon.com/builders-library/avoiding-insurmountable-queue-backlogs/

An unbounded queue is a promise to run out of memory later. A bounded queue forces the decision now: reject the new work, or drop something already queued. If all work is equal, reject the newest; if some work is more important, evict the lowest-priority item. Either way, the caller must see the rejection.

The [Handling overload](https://sre.google/sre-book/handling-overload/) chapter describes load shedding and criticality; the [queue backlog](https://aws.amazon.com/builders-library/avoiding-insurmountable-queue-backlogs/) article explains why a queue that absorbs everything eventually serves nothing. This exercise is the data structure behind that decision.

::: card
q: Why is "accept everything and process it later" not backpressure?
answer: Backpressure pushes the signal back to the caller: slow down, retry later, or fail now. An unbounded queue absorbs the signal and hides it, moving the failure to memory, latency, or a queue that is hours behind. Backpressure requires a bound and a policy for what happens at the bound.
:::

::: write lang=typescript
task: Export `BoundedQueue<T>`.

  `new BoundedQueue(capacity)` holds at most `capacity` items. Each item has a numeric priority; larger is more important. Equal priorities are FIFO.

  - `push(value, priority = 0)`: if there is room, insert and return true.
  - If full, compare the new priority with the **lowest** priority in the queue. If the new item is strictly more important, remove the oldest item at that lowest priority, insert the new one, count one drop, and return true. Otherwise reject the new item, count one drop, and return false.
  - `shift()`: remove and return the highest-priority, oldest item; `undefined` when empty.
  - `size`: current number of items.
  - `dropped`: total items rejected or evicted.

starter:
```ts
export class BoundedQueue<T> {
  constructor(capacity: number) {}
  push(value: T, priority = 0): boolean {
    return false
  }
  shift(): T | undefined {
    return undefined
  }
  get size(): number {
    return 0
  }
  dropped = 0
}
```
tests:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { BoundedQueue } from "./solution.ts"

test("equal priorities are FIFO", () => {
  const q = new BoundedQueue<string>(3)
  assert.equal(q.push("a"), true)
  assert.equal(q.push("b"), true)
  assert.equal(q.shift(), "a")
  assert.equal(q.shift(), "b")
  assert.equal(q.shift(), undefined)
})

test("higher priority is served first, FIFO within a priority", () => {
  const q = new BoundedQueue<string>(4)
  q.push("low", 1)
  q.push("high-1", 10)
  q.push("high-2", 10)
  q.push("mid", 5)
  assert.equal(q.shift(), "high-1")
  assert.equal(q.shift(), "high-2")
  assert.equal(q.shift(), "mid")
  assert.equal(q.shift(), "low")
})

test("a low-priority item is rejected when the queue is full", () => {
  const q = new BoundedQueue<string>(2)
  assert.equal(q.push("a", 5), true)
  assert.equal(q.push("b", 5), true)
  assert.equal(q.push("c", 1), false)
  assert.equal(q.size, 2)
  assert.equal(q.dropped, 1)
  assert.equal(q.shift(), "a")
  assert.equal(q.shift(), "b")
})

test("a high-priority item evicts the oldest lowest-priority item", () => {
  const q = new BoundedQueue<string>(2)
  q.push("low-1", 1)
  q.push("low-2", 1)
  assert.equal(q.push("urgent", 9), true)
  assert.equal(q.size, 2)
  assert.equal(q.dropped, 1)
  assert.equal(q.shift(), "urgent")
  assert.equal(q.shift(), "low-2")
})

test("a zero-capacity queue rejects everything", () => {
  const q = new BoundedQueue<string>(0)
  assert.equal(q.push("a"), false)
  assert.equal(q.size, 0)
  assert.equal(q.dropped, 1)
})
```
solution:
```ts
type Entry<T> = { value: T; priority: number; seq: number }

export class BoundedQueue<T> {
  private capacity: number
  private items: Entry<T>[] = []
  private nextSeq = 0
  dropped = 0

  constructor(capacity: number) {
    this.capacity = Math.max(0, capacity)
  }

  push(value: T, priority = 0): boolean {
    if (this.capacity === 0) {
      this.dropped++
      return false
    }
    if (this.items.length < this.capacity) {
      this.items.push({ value, priority, seq: this.nextSeq++ })
      return true
    }
    let low = 0
    for (let i = 1; i < this.items.length; i++) {
      const a = this.items[i]!
      const b = this.items[low]!
      if (a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq)) low = i
    }
    const victim = this.items[low]!
    if (priority <= victim.priority) {
      this.dropped++
      return false
    }
    this.items.splice(low, 1)
    this.items.push({ value, priority, seq: this.nextSeq++ })
    this.dropped++
    return true
  }

  shift(): T | undefined {
    if (!this.items.length) return undefined
    let best = 0
    for (let i = 1; i < this.items.length; i++) {
      const a = this.items[i]!
      const b = this.items[best]!
      if (a.priority > b.priority || (a.priority === b.priority && a.seq < b.seq)) best = i
    }
    return this.items.splice(best, 1)[0]!.value
  }

  get size(): number {
    return this.items.length
  }
}
```
wrong: It ignores priority, so urgent work waits behind whatever arrived first.
```ts
export class BoundedQueue<T> {
  private capacity: number
  private items: T[] = []
  dropped = 0
  constructor(capacity: number) {
    this.capacity = Math.max(0, capacity)
  }
  push(value: T, priority = 0): boolean {
    if (this.items.length >= this.capacity) {
      this.dropped++
      return false
    }
    this.items.push(value)
    return true
  }
  shift(): T | undefined {
    return this.items.shift()
  }
  get size(): number {
    return this.items.length
  }
}
```
wrong: It evicts the newest item even when an older, less important item is the right victim.
```ts
type Entry<T> = { value: T; priority: number }

export class BoundedQueue<T> {
  private capacity: number
  private items: Entry<T>[] = []
  dropped = 0
  constructor(capacity: number) {
    this.capacity = Math.max(0, capacity)
  }
  push(value: T, priority = 0): boolean {
    if (this.items.length >= this.capacity) {
      this.items.shift()
      this.items.push({ value, priority })
      this.dropped++
      return true
    }
    this.items.push({ value, priority })
    return true
  }
  shift(): T | undefined {
    if (!this.items.length) return undefined
    let best = 0
    for (let i = 1; i < this.items.length; i++) {
      if (this.items[i]!.priority > this.items[best]!.priority) best = i
    }
    return this.items.splice(best, 1)[0]!.value
  }
  get size(): number {
    return this.items.length
  }
}
```
hint: Keep a monotonically increasing sequence number so equal priorities are FIFO. When full, find the lowest priority and the oldest item at that priority; the new item only wins if it is strictly higher.
:::

## Rate limits that refill
id: overload-token
stage: overload
needs: overload-bounded
minutes: 50
goal: Implement a per-key token bucket with lazy refill, a capacity ceiling, and no leaked state between tenants.
source: Azure Architecture Center: Rate Limiting pattern | https://learn.microsoft.com/en-us/azure/architecture/patterns/rate-limiting-pattern
source: NGINX: limit_req | https://nginx.org/en/docs/http/ngx_http_limit_req_module.html

A token bucket is a rate plus a burst allowance. The bucket fills at a steady rate up to a capacity, and each request spends tokens. If there are enough tokens, the request proceeds; otherwise it is rejected or queued. The capacity is the burst; the refill rate is the sustained rate.

The [Rate Limiting pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/rate-limiting-pattern) covers the trade-offs; nginx's [limit_req](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html) is the production version of the same idea (leaky bucket, burst, `nodelay`). The important detail in a multi-tenant service is that the bucket is **per key**, not per process.

::: quiz
q: A bucket has capacity 10 and refills at 2 tokens per second. It has been idle for a minute. How many requests can it admit immediately?
- 120, because a minute of refill accumulated
+ 10, because the bucket is capped at its capacity
- 2, because that is the refill rate
why: The capacity is the maximum burst, not a savings account. Idle time fills the bucket to 10 and no further; that is what bounds a burst after a quiet period.
:::

::: write lang=typescript
task: Export `TokenBucket`.

  `new TokenBucket(capacity, refillPerSecond, now = Date.now)`.

  - Buckets are per key and start full.
  - `take(key, tokens = 1)`: refill that key's bucket by `elapsed seconds * refillPerSecond`, capped at `capacity`; if at least `tokens` are available, subtract and return true; otherwise return false and leave the bucket unchanged.
  - `tokens(key)`: return the current (refilled, capped) number of tokens without spending any.
  - A request for more than `capacity` tokens is always false.
  - Refill is lazy: compute it from the clock when the key is touched; do not run a timer.

starter:
```ts
export class TokenBucket {
  constructor(capacity: number, refillPerSecond: number, now: () => number = Date.now) {}
  take(key: string, tokens = 1): boolean {
    return false
  }
  tokens(key: string): number {
    return 0
  }
}
```
tests:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { TokenBucket } from "./solution.ts"

function clock() {
  let t = 0
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

test("capacity limits the immediate burst, then refill restores it", () => {
  const c = clock()
  const b = new TokenBucket(2, 1, c.now)
  assert.equal(b.take("a"), true)
  assert.equal(b.take("a"), true)
  assert.equal(b.take("a"), false)
  c.advance(999)
  assert.equal(b.take("a"), false)
  c.advance(1)
  assert.equal(b.take("a"), true)
})

test("refill is fractional and capped", () => {
  const c = clock()
  const b = new TokenBucket(5, 2, c.now)
  b.take("a", 5)
  c.advance(500)
  assert.equal(b.tokens("a"), 1)
  c.advance(10_000)
  assert.equal(b.tokens("a"), 5)
  assert.equal(b.take("a", 6), false)
})

test("keys are independent", () => {
  const c = clock()
  const b = new TokenBucket(1, 1, c.now)
  assert.equal(b.take("a"), true)
  assert.equal(b.take("a"), false)
  assert.equal(b.take("b"), true)
  assert.equal(b.take("b"), false)
})

test("a rejected take does not spend tokens", () => {
  const c = clock()
  const b = new TokenBucket(3, 1, c.now)
  assert.equal(b.take("a", 3), true)
  c.advance(1000)
  assert.equal(b.take("a", 2), false)
  assert.equal(b.tokens("a"), 1)
  assert.equal(b.take("a", 1), true)
})
```
solution:
```ts
type Bucket = { tokens: number; last: number }

export class TokenBucket {
  private capacity: number
  private refillPerSecond: number
  private now: () => number
  private buckets = new Map<string, Bucket>()

  constructor(capacity: number, refillPerSecond: number, now: () => number = Date.now) {
    this.capacity = capacity
    this.refillPerSecond = refillPerSecond
    this.now = now
  }

  private current(key: string): Bucket {
    const t = this.now()
    const b = this.buckets.get(key)
    if (!b) {
      const fresh = { tokens: this.capacity, last: t }
      this.buckets.set(key, fresh)
      return fresh
    }
    const elapsed = Math.max(0, t - b.last) / 1000
    b.tokens = Math.min(this.capacity, b.tokens + elapsed * this.refillPerSecond)
    b.last = t
    return b
  }

  take(key: string, tokens = 1): boolean {
    if (tokens < 0 || tokens > this.capacity) return false
    const b = this.current(key)
    if (b.tokens < tokens) return false
    b.tokens -= tokens
    return true
  }

  tokens(key: string): number {
    return this.current(key).tokens
  }
}
```
wrong: It ignores elapsed time and refills one token on every call, so the rate depends on how often the caller asks.
```ts
type Bucket = { tokens: number; last: number }

export class TokenBucket {
  private capacity: number
  private refillPerSecond: number
  private now: () => number
  private buckets = new Map<string, Bucket>()
  constructor(capacity: number, refillPerSecond: number, now: () => number = Date.now) {
    this.capacity = capacity
    this.refillPerSecond = refillPerSecond
    this.now = now
  }
  take(key: string, tokens = 1): boolean {
    const b = this.buckets.get(key) ?? { tokens: this.capacity, last: this.now() }
    b.tokens = Math.min(this.capacity, b.tokens + 1)
    this.buckets.set(key, b)
    if (b.tokens < tokens) return false
    b.tokens -= tokens
    return true
  }
  tokens(key: string): number {
    return this.buckets.get(key)?.tokens ?? this.capacity
  }
}
```
wrong: One global bucket lets one tenant spend every other tenant's rate limit.
```ts
export class TokenBucket {
  private capacity: number
  private refillPerSecond: number
  private now: () => number
  private tokensLeft: number
  private last: number
  constructor(capacity: number, refillPerSecond: number, now: () => number = Date.now) {
    this.capacity = capacity
    this.refillPerSecond = refillPerSecond
    this.now = now
    this.tokensLeft = capacity
    this.last = now()
  }
  take(key: string, tokens = 1): boolean {
    const t = this.now()
    this.tokensLeft = Math.min(this.capacity, this.tokensLeft + ((t - this.last) / 1000) * this.refillPerSecond)
    this.last = t
    if (this.tokensLeft < tokens) return false
    this.tokensLeft -= tokens
    return true
  }
  tokens(key: string): number {
    return this.tokensLeft
  }
}
```
hint: Store `{ tokens, last }` per key and compute `elapsed / 1000 * refillPerSecond` on every touch. Update `last` even when the take is rejected, so the next call does not count the same elapsed time twice.
:::

## Ask nginx to say no
id: overload-nginx
stage: overload
needs: overload-token
minutes: 50
goal: Put a request-rate limit and a connection limit in front of a static site and see the excess requests rejected with 429/503.
source: NGINX: limit_req | https://nginx.org/en/docs/http/ngx_http_limit_req_module.html
source: NGINX: limit_conn | https://nginx.org/en/docs/http/ngx_http_limit_conn_module.html
source: Google SRE: Handling overload | https://sre.google/sre-book/handling-overload/

nginx can shed load before a request reaches your application. `limit_req_zone` defines a shared bucket keyed by client address; `limit_req` applies it to a location with a burst allowance. `limit_conn` caps concurrent connections per key. Both return a status you choose, and both are only useful if the application would otherwise be the thing that falls over.

The [limit_req](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html) docs define `rate`, `burst` and `nodelay`; [limit_conn](https://nginx.org/en/docs/http/ngx_http_limit_conn_module.html) defines the connection cap. The [Handling overload](https://sre.google/sre-book/handling-overload/) chapter is the reason to reject early rather than queue forever.

::: term
task: |
  nginx is installed. A static site is at `/var/www/limits/index.html`, but nothing is serving it yet.

  Create `/etc/nginx/conf.d/limits.conf` so that:

  - a request-rate zone named `api` is keyed by client address, with a rate of **1 request per second**;
  - a connection zone named `conn` is keyed by client address;
  - a server listens on **8080**, serves `/var/www/limits`, and applies `limit_req` with `burst=3` and `nodelay`, returning **429** when limited;
  - the same location applies `limit_conn` with a limit of **2**, returning **503** when limited.

  Run `nginx -t`, start or reload nginx, and test with a burst of at least 20 requests to `http://127.0.0.1:8080/`. Some must be 200 and some must be 429; if every request succeeds, the limit is not doing anything.

  The zone directives belong in the `http` context, which is why a file in `conf.d` is the right place.
setup: |
  ```bash
  set -e
  install -d /var/www/limits
  printf 'ok\n' > /var/www/limits/index.html
  systemctl stop nginx >/dev/null 2>&1 || true
  ```
verify: |
  ```bash
  f=/etc/nginx/conf.d/limits.conf
  [ -f "$f" ] || { echo "there is no $f"; exit 1; }
  grep -q 'limit_req_zone' "$f" || { echo "no limit_req_zone in $f"; exit 1; }
  grep -q 'limit_conn_zone' "$f" || { echo "no limit_conn_zone in $f"; exit 1; }
  grep -q 'listen 8080' "$f" || { echo "the server does not listen on 8080"; exit 1; }
  grep -q 'limit_req zone=api' "$f" || { echo "the location does not apply limit_req zone=api"; exit 1; }
  grep -q 'limit_conn conn' "$f" || { echo "the location does not apply limit_conn"; exit 1; }
  nginx -t >/dev/null 2>&1 || { echo "nginx -t fails; run it and read the error"; exit 1; }
  reachable=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/ || true)
  [ "$reachable" = "200" ] || [ "$reachable" = "429" ] || { echo "nothing is serving on 127.0.0.1:8080 (got '$reachable')"; exit 1; }
  sleep 4
  codes=$(for i in $(seq 1 25); do curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/; done)
  ok=$(echo "$codes" | grep -c '^200$' || true)
  limited=$(echo "$codes" | grep -c '^429$' || true)
  [ "$ok" -ge 1 ] || { echo "no request succeeded; the limit is too tight or the site is broken"; exit 1; }
  [ "$limited" -ge 1 ] || { echo "all $ok requests succeeded; the rate limit is not rejecting anything"; exit 1; }
  ```
solution: |
  ```bash
  cat > /etc/nginx/conf.d/limits.conf <<'EOF'
  limit_req_zone $binary_remote_addr zone=api:1m rate=1r/s;
  limit_conn_zone $binary_remote_addr zone=conn:1m;

  server {
      listen 8080;
      root /var/www/limits;
      index index.html;

      location / {
          limit_req zone=api burst=3 nodelay;
          limit_req_status 429;
          limit_conn conn 2;
          limit_conn_status 503;
      }
  }
  EOF
  nginx -t
  systemctl start nginx
  systemctl reload nginx
  for i in $(seq 1 25); do curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/; done | sort | uniq -c
  ```
hint: `return 200` runs in the rewrite phase and bypasses the limit modules; serve a real file with `root` and `index` instead. `systemctl start` is not enough if nginx was already running: reload it.
:::

## The speed of light, and the tail
id: regions-latency
stage: regions
needs: pg-replica
minutes: 40
goal: Put a number on same-zone, cross-region and cross-continent calls, and see how fan-out turns a rare slow response into a common slow request.
source: Colin Scott: Interactive latency numbers | https://colin-scott.github.io/personal_website/research/interactive_latency.html
source: Dean and Barroso: The Tail at Scale | https://research.google/pubs/the-tail-at-scale/
source: AWS Builders' Library: Timeouts, retries and backoff with jitter | https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/

You cannot optimize a distance. A same-zone round trip is sub-millisecond; a cross-region round trip is tens of milliseconds; a cross-continent one is over a hundred. That floor changes the design: which reads can be local, which writes must pay the distance, and which requests can be parallelized without multiplying the tail.

The [latency numbers](https://colin-scott.github.io/personal_website/research/interactive_latency.html) page lets you compare the orders of magnitude. [The Tail at Scale](https://research.google/pubs/the-tail-at-scale/) is the paper to read on why p99, not the mean, decides the user experience once a request fans out.

::: predict lang=python
q: Each of ten parallel calls is slow (over one second) with probability 1%. Assuming independence, what is the probability that at least one call in the request is slow?
code: |
  p_slow = 0.01
  n = 10
  print(round(1 - (1 - p_slow) ** n, 4))
answer: |
  0.0956
why: One percent per call becomes about 9.6% per request at fan-out ten. That is the tail amplification that makes a p99 dependency a p90 user experience; hedged requests, bounded fan-out and per-call deadlines exist to contain it.
:::

::: quiz
q: A read replica in the same region is 2 ms behind the primary. A user updates their profile and immediately reloads the page. What can they see?
- Always the new value, because the write committed
+ The old value, because the read may be served by a replica that has not replayed the write yet
- An error, because the replica is inconsistent
why: Asynchronous replication gives eventual consistency. The write committed on the primary; the replica's replay is behind. A read-your-writes guarantee needs the read to go to the primary, a session token that tracks the LSN, or a wait for the replica to catch up.
:::

::: card
q: A service spans two regions and writes to the primary in one. What are the two honest ways to reduce the write latency?
answer: Move the write's coordination closer to the user (make the local region the primary for that key, or partition keys by home region), or accept asynchronous propagation and define what a conflicting write means. You cannot make a synchronous cross-region commit faster than the round trip; you can only change which work waits for it.
:::

::: card
q: Why is a 100 ms cross-region call dangerous even when the p50 is fine?
answer: If a request makes ten such calls sequentially, the p50 budget is already a second before any application work. Under load, queueing adds to each hop, and the tail grows faster than the median. The design question is how many cross-region hops the critical path can afford, not whether 100 ms is "fast".
:::

## Do the RTO/RPO arithmetic
id: regions-rto
stage: regions
needs: regions-latency, pg-failover
minutes: 45
goal: Turn a replication lag and a failover runbook into lost writes and downtime, and check both against the stated budgets.
source: AWS: Disaster Recovery of Workloads on AWS | https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-workloads-on-aws.html
source: Google SRE: Emergency response | https://sre.google/sre-book/emergency-response/
source: AWS: Route 53 failover routing | https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/dns-failover-types.html

RPO and RTO are budgets, not adjectives. RPO is how much committed data you can lose; with async replication it is bounded by the lag at the moment the primary dies. RTO is how long until the service accepts writes again; it includes detection, the promotion itself, and the time DNS or service discovery takes to send traffic to the new primary.

The [AWS DR whitepaper](https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-workloads-on-aws.html) maps the strategies to budgets. [Route 53 failover](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/dns-failover-types.html) is a reminder that the DNS TTL is part of the outage, not a footnote. The [SRE emergency response](https://sre.google/sre-book/emergency-response/) chapter is about the human clock around the technical one.

::: quiz
q: A failover takes 20 seconds to promote the database, but the DNS record has a 60-second TTL. What is the RTO contribution?
- 20 seconds, because promotion is the failover
+ At least 80 seconds, because clients can keep using the old address until the TTL expires
- 60 seconds, because DNS is the only thing users see
why: RTO is measured until clients are actually served by the new primary. Promotion plus detection plus the traffic switch all count. A long TTL is a deliberate trade for fewer DNS queries; it is also a delay in every failover.
:::

::: write lang=python
task: Write `failover_report(writes_per_second, replica_lag_seconds, detect_seconds, promote_seconds, dns_ttl_seconds, rpo_seconds, rto_seconds)`.

  Return a dict with:

  - `lost_writes`: `ceil(writes_per_second * replica_lag_seconds)`;
  - `downtime_seconds`: detection + promotion + DNS TTL;
  - `rpo_ok`: the replication lag is less than or equal to the RPO budget;
  - `rto_ok`: the downtime is less than or equal to the RTO budget;
  - `verdict`: `"meets"` when both are true, otherwise `"misses"`.

  Use `math.ceil` for the write count: a fractional write is still a write you lost. The DNS TTL is part of downtime.
starter:
```python
import math

def failover_report(writes_per_second, replica_lag_seconds, detect_seconds, promote_seconds, dns_ttl_seconds, rpo_seconds, rto_seconds):
    return {}
```
tests:
```python
from solution import failover_report

def test_a_plan_that_meets_both_budgets():
    r = failover_report(500, 4, 30, 20, 60, 5, 120)
    assert r["lost_writes"] == 2000
    assert r["downtime_seconds"] == 110
    assert r["rpo_ok"] is True
    assert r["rto_ok"] is True
    assert r["verdict"] == "meets"

def test_lag_over_budget_misses_rpo():
    r = failover_report(100, 10, 30, 20, 60, 5, 120)
    assert r["lost_writes"] == 1000
    assert r["rpo_ok"] is False
    assert r["rto_ok"] is True
    assert r["verdict"] == "misses"

def test_dns_ttl_pushes_downtime_over_budget():
    r = failover_report(100, 1, 30, 20, 60, 5, 100)
    assert r["downtime_seconds"] == 110
    assert r["rto_ok"] is False
    assert r["verdict"] == "misses"

def test_fractional_writes_round_up():
    r = failover_report(12.5, 3, 1, 1, 1, 5, 120)
    assert r["lost_writes"] == 38
    assert r["downtime_seconds"] == 3

def test_zero_lag_loses_nothing():
    r = failover_report(1000, 0, 1, 1, 1, 0, 10)
    assert r["lost_writes"] == 0
    assert r["rpo_ok"] is True
    assert r["verdict"] == "meets"
```
solution:
```python
import math

def failover_report(writes_per_second, replica_lag_seconds, detect_seconds, promote_seconds, dns_ttl_seconds, rpo_seconds, rto_seconds):
    lost = math.ceil(writes_per_second * replica_lag_seconds)
    downtime = detect_seconds + promote_seconds + dns_ttl_seconds
    rpo_ok = replica_lag_seconds <= rpo_seconds
    rto_ok = downtime <= rto_seconds
    return {
        "lost_writes": lost,
        "downtime_seconds": downtime,
        "rpo_ok": rpo_ok,
        "rto_ok": rto_ok,
        "verdict": "meets" if rpo_ok and rto_ok else "misses",
    }
```
wrong: It uses `int` and drops the fractional write instead of rounding up.
```python
def failover_report(writes_per_second, replica_lag_seconds, detect_seconds, promote_seconds, dns_ttl_seconds, rpo_seconds, rto_seconds):
    lost = int(writes_per_second * replica_lag_seconds)
    downtime = detect_seconds + promote_seconds + dns_ttl_seconds
    rpo_ok = replica_lag_seconds <= rpo_seconds
    rto_ok = downtime <= rto_seconds
    return {"lost_writes": lost, "downtime_seconds": downtime, "rpo_ok": rpo_ok, "rto_ok": rto_ok, "verdict": "meets" if rpo_ok and rto_ok else "misses"}
```
wrong: It leaves the DNS TTL out of the downtime, so the plan looks faster than the user experience.
```python
import math

def failover_report(writes_per_second, replica_lag_seconds, detect_seconds, promote_seconds, dns_ttl_seconds, rpo_seconds, rto_seconds):
    lost = math.ceil(writes_per_second * replica_lag_seconds)
    downtime = detect_seconds + promote_seconds
    rpo_ok = replica_lag_seconds <= rpo_seconds
    rto_ok = downtime <= rto_seconds
    return {"lost_writes": lost, "downtime_seconds": downtime, "rpo_ok": rpo_ok, "rto_ok": rto_ok, "verdict": "meets" if rpo_ok and rto_ok else "misses"}
```
hint: `math.ceil` is the honest function for a count. The DNS TTL is not a monitoring detail; it is the window in which some clients still send writes to a dead primary.
:::

## Multi-AZ is the floor, not the ceiling
id: regions-aws
stage: regions
needs: regions-rto
minutes: 60
goal: Write the Terraform for a multi-AZ RDS instance, a replicated ElastiCache group, and an ECS service that rolls back a bad deployment.
source: AWS: RDS Multi-AZ deployments | https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.html
source: AWS: ElastiCache replication | https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Replication.html
source: AWS: Amazon ECS | https://docs.aws.amazon.com/AmazonECS/latest/developerguide/Welcome.html
source: Terraform AWS provider: aws_db_instance | https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/db_instance
source: Terraform AWS provider: aws_elasticache_replication_group | https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/elasticache_replication_group

Multi-AZ is a availability-zone failure story, not a region failure story. RDS Multi-AZ gives you a synchronous standby and a managed failover; ElastiCache replication with automatic failover gives you a promoted replica; ECS spreads tasks across zones if the scheduler and the subnet layout allow it. None of that survives losing the region. The AWS docs are explicit about the boundary; the Terraform provider is where you make the choices visible.

Read the [RDS Multi-AZ](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.html), [ElastiCache replication](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Replication.html) and [ECS](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/Welcome.html) pages, then the two Terraform resources. The exercise is a static configuration, not an AWS account: the checker parses the HCL.

::: quiz
q: RDS Multi-AZ is enabled. The primary's region loses power. What happens?
- RDS promotes the standby in the other Availability Zone
+ The service is down until you restore or promote a copy in another region
- The standby becomes a read replica in the same region
why: Multi-AZ places the standby in a different Availability Zone inside one region. It protects against an AZ failure, not a regional failure. A regional disaster needs a cross-region read replica, a backup copy, or a multi-region architecture.
:::

::: config lang=hcl
task: Write Terraform for a small service that is honest about its failure boundary.

  - `aws_db_instance.main`: PostgreSQL, `multi_az = true`, `backup_retention_period = 7`, `deletion_protection = true`, `skip_final_snapshot = false`.
  - `aws_elasticache_replication_group.sessions`: engine `redis`, `num_cache_clusters = 2`, `automatic_failover_enabled = true`, `multi_az_enabled = true`.
  - `aws_ecs_service.api`: `desired_count = 2`, and a `deployment_circuit_breaker` block with `enable = true` and `rollback = true`.

  The provider region can be anything; use `eu-central-1`.
starter:
```hcl
provider "aws" {
  region = "eu-central-1"
}

resource "aws_db_instance" "main" {
}

resource "aws_elasticache_replication_group" "sessions" {
}

resource "aws_ecs_service" "api" {
}
```
check: resource.aws_db_instance.main.engine = postgres | The database engine is postgres
check: resource.aws_db_instance.main.multi_az = true | The database is multi_az
check: resource.aws_db_instance.main.backup_retention_period = 7 | Backups are kept for 7 days
check: resource.aws_db_instance.main.deletion_protection = true | Deletion protection is on
check: resource.aws_db_instance.main.skip_final_snapshot = false | A final snapshot is required
check: resource.aws_elasticache_replication_group.sessions.engine = redis | The cache engine is redis
check: resource.aws_elasticache_replication_group.sessions.num_cache_clusters = 2 | There are two cache clusters
check: resource.aws_elasticache_replication_group.sessions.automatic_failover_enabled = true | Automatic failover is on
check: resource.aws_elasticache_replication_group.sessions.multi_az_enabled = true | The cache is multi-AZ
check: resource.aws_ecs_service.api.desired_count = 2 | The ECS service runs two tasks
check: resource.aws_ecs_service.api.deployment_circuit_breaker.enable = true | The deployment circuit breaker is on
check: resource.aws_ecs_service.api.deployment_circuit_breaker.rollback = true | A failed deployment rolls back
solution:
```hcl
provider "aws" {
  region = "eu-central-1"
}

resource "aws_db_instance" "main" {
  engine                  = "postgres"
  multi_az                = true
  backup_retention_period = 7
  deletion_protection     = true
  skip_final_snapshot     = false
}

resource "aws_elasticache_replication_group" "sessions" {
  engine                        = "redis"
  num_cache_clusters            = 2
  automatic_failover_enabled    = true
  multi_az_enabled              = true
}

resource "aws_ecs_service" "api" {
  desired_count = 2

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
}
```
hint: The nested `deployment_circuit_breaker` block is a block, not an attribute with dots in its name. HCL checks follow `resource.<type>.<name>.<attribute>` and `...<block>.<attribute>`.
:::

## Alert on the signals that precede the outage
id: regions-observe
stage: regions
needs: pg-replica, overload-nginx
minutes: 55
goal: Write Prometheus rules for replication lag, error ratio, tail latency and backup age, with a `for` window and a severity label.
source: Google SRE: Monitoring distributed systems | https://sre.google/sre-book/monitoring-distributed-systems/
source: Prometheus: Alerting rules | https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/
source: prometheus-community: postgres_exporter | https://github.com/prometheus-community/postgres_exporter
source: Datadog: Tracing | https://docs.datadoghq.com/tracing/
source: AWS: Performance Insights | https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_PerfInsights.html

The four golden signals are latency, traffic, errors and saturation. For this JD, add the data-plane signals that fail before the application notices: replication lag, backup age, connection-pool saturation and cache evictions. A dashboard is for diagnosis; an alert is for a decision someone must make now.

Google's [Monitoring distributed systems](https://sre.google/sre-book/monitoring-distributed-systems/) chapter is the source for symptoms over causes. The [Prometheus alerting rules](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/) page gives the file shape and `for`. [postgres_exporter](https://github.com/prometheus-community/postgres_exporter) is where `pg_replication_lag_seconds` comes from in a real deployment; [Datadog tracing](https://docs.datadoghq.com/tracing/) and [Performance Insights](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_PerfInsights.html) are the managed equivalents.

::: quiz
q: Why does an alert on "CPU is 90%" make a poor page, while "the p99 checkout latency is over the SLO for ten minutes" makes a better one?
- CPU is never a useful signal
+ CPU is a cause that may or may not affect users; the latency burn is the symptom the on-call can act on
- Latency alerts never fire
why: Resource alerts describe a machine; symptom alerts describe the service the user experiences. CPU at 90% can be healthy or irrelevant; a sustained SLO burn is by definition a user-facing problem. Keep the cause metrics for diagnosis, not for waking someone.
:::

::: config lang=yaml
task: Write a Prometheus rule file with one group named `acme` and four alerts:

  1. `ReplicationLagHigh`: `pg_replication_lag_seconds > 30`, for `5m`, severity `critical`.
  2. `ApiErrorRateHigh`: the ratio of 5xx responses to all responses over five minutes is greater than `0.02`, for `10m`, severity `warning`.
  3. `ApiTailLatencyHigh`: the p99 of `http_request_duration_seconds_bucket` over five minutes is greater than `1`, for `5m`, severity `warning`.
  4. `BackupTooOld`: `time() - pg_backup_last_success_timestamp_seconds > 86400`, for `30m`, severity `critical`.

  Put each alert in `rules`, with a `labels` map containing `severity`. The expressions must use the metric names exactly as written.
starter:
```yaml
groups:
  - name: acme
    rules:
      - alert: ReplicationLagHigh
        expr: ""
```
check: groups[0].name = acme | The group is called acme
check: groups[0].rules[0].alert = ReplicationLagHigh | The first alert is ReplicationLagHigh
check: groups[0].rules[0].expr ~ /pg_replication_lag_seconds\s*>\s*30/ | The replication-lag expression compares pg_replication_lag_seconds to 30
check: groups[0].rules[0].for = 5m | ReplicationLagHigh waits 5m
check: groups[0].rules[0].labels.severity = critical | ReplicationLagHigh is critical
check: groups[0].rules[1].alert = ApiErrorRateHigh | The second alert is ApiErrorRateHigh
check: groups[0].rules[1].expr ~ /http_requests_total.*5\.\..*\/.*http_requests_total/ | The error-ratio expression divides 5xx requests by all requests
check: groups[0].rules[1].for = 10m | ApiErrorRateHigh waits 10m
check: groups[0].rules[1].labels.severity = warning | ApiErrorRateHigh is a warning
check: groups[0].rules[2].alert = ApiTailLatencyHigh | The third alert is ApiTailLatencyHigh
check: groups[0].rules[2].expr ~ /histogram_quantile\(0\.99.*http_request_duration_seconds_bucket/ | The tail-latency expression uses histogram_quantile(0.99, ...)
check: groups[0].rules[2].for = 5m | ApiTailLatencyHigh waits 5m
check: groups[0].rules[3].alert = BackupTooOld | The fourth alert is BackupTooOld
check: groups[0].rules[3].expr ~ /pg_backup_last_success_timestamp_seconds.*86400/ | The backup expression compares the last success to 86400 seconds
check: groups[0].rules[3].for = 30m | BackupTooOld waits 30m
solution:
```yaml
groups:
  - name: acme
    rules:
      - alert: ReplicationLagHigh
        expr: pg_replication_lag_seconds > 30
        for: 5m
        labels:
          severity: critical
      - alert: ApiErrorRateHigh
        expr: sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m])) > 0.02
        for: 10m
        labels:
          severity: warning
      - alert: ApiTailLatencyHigh
        expr: histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[5m])) by (le)) > 1
        for: 5m
        labels:
          severity: warning
      - alert: BackupTooOld
        expr: time() - pg_backup_last_success_timestamp_seconds > 86400
        for: 30m
        labels:
          severity: critical
```
hint: YAML lists use `-` at the same indentation. The checks read `groups[0].rules[0]...`; use one group named `acme`, and put `labels.severity` under each rule.
:::

## Export the metrics a scraper can read
id: regions-metrics
stage: regions
needs: regions-observe
minutes: 55
goal: Implement counters, gauges and histograms that render the Prometheus text format correctly, with sorted labels and cumulative buckets.
source: Prometheus: Exposition formats | https://prometheus.io/docs/instrumenting/exposition_formats/
source: Prometheus: Metric types | https://prometheus.io/docs/concepts/metric_types/
source: OpenTelemetry: Metrics | https://opentelemetry.io/docs/concepts/signals/metrics/

A dashboard is only as good as the instrumentation under it. Prometheus does not call your service and ask questions; it scrapes a text page, one sample per line. Counters only go up, gauges go up and down, histograms count observations into cumulative buckets. Get the exposition wrong and the series is silently unusable, or worse, it lies.

Read the [exposition format](https://prometheus.io/docs/instrumenting/exposition_formats/) for the exact line shape, the [metric types](https://prometheus.io/docs/concepts/metric_types/) page for what each type promises, and the [OpenTelemetry metrics](https://opentelemetry.io/docs/concepts/signals/metrics/) page for how the same ideas appear in a vendor-neutral SDK. Metrics tell you that something is wrong; traces and logs tell you where. The JD asks for all three, and this is the layer a Node service has to expose itself.

::: quiz
q: A histogram has buckets `le="0.1"` and `le="0.5"`. Three observations are 0.05, 0.2 and 0.9. What does the `le="0.5"` bucket contain?
- One, because only 0.2 falls between 0.1 and 0.5
+ Two, because a bucket count includes every observation at or below its bound
- Three, because the last bucket is the total
why: Histogram buckets are cumulative. `le="0.5"` counts the 0.05 and the 0.2; the `+Inf` bucket counts all three. A non-cumulative bucket is a common instrumentation bug and makes `histogram_quantile` return nonsense.
:::

::: quiz
q: Which label is safe to put on a request counter?
- `user_id`, so you can find the slow user
+ `route`, from a small fixed set of route templates
- `request_id`, so every request is traceable
why: Every distinct label value is a new time series. A bounded label such as a route template keeps the series count stable; user IDs and request IDs create unbounded cardinality, which is how a metrics backend falls over. Put the unbounded identifier in a trace or a log line.
:::

::: write lang=typescript
task: Export `Metrics`, a tiny Prometheus registry.

  `new Metrics()` starts empty. Methods:
  - `inc(name, labels = {}, by = 1)`: add to a counter. A negative `by` throws. The first use of a name fixes its type.
  - `set(name, value, labels = {})`: set a gauge series.
  - `observe(name, value, labels = {}, buckets = DEFAULT_BUCKETS)`: add an observation to a histogram. The first `observe` for a name fixes its bucket boundaries; later calls use the same boundaries.
  - `render()`: return the Prometheus text exposition, with one `# TYPE <name> <counter|gauge|histogram>` line per metric, metrics sorted by name, series sorted by their rendered label set, and a trailing newline. An empty registry renders `""`.

  Labels are rendered as `{a="1",b="two"}` with keys sorted. Escape `\` as `\\`, `"` as `\"`, and a newline as `\n` inside label values.

  A histogram renders one `_bucket` line per boundary with an `le` label, then `le="+Inf"`, then `_sum` and `_count`. Bucket counts are cumulative. Format numbers without floating-point noise: `0.1 + 0.2` renders as `0.3`. Using one name as two different metric types throws.

starter:
```ts
export type Labels = Record<string, string | number>

export const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]

export class Metrics {
  inc(name: string, labels: Labels = {}, by = 1): void {}
  set(name: string, value: number, labels: Labels = {}): void {}
  observe(name: string, value: number, labels: Labels = {}, buckets: number[] = DEFAULT_BUCKETS): void {}
  render(): string {
    return ""
  }
}
```
tests:
```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { Metrics } from "./solution.ts"

test("counters add per label set and render sorted", () => {
  const m = new Metrics()
  m.inc("http_requests_total", { method: "GET", status: 200 })
  m.inc("http_requests_total", { status: 200, method: "GET" }, 2)
  m.inc("http_requests_total", { method: "POST", status: 500 })
  assert.equal(
    m.render(),
    `# TYPE http_requests_total counter
http_requests_total{method="GET",status="200"} 3
http_requests_total{method="POST",status="500"} 1
`
  )
})

test("gauges overwrite, counters do not", () => {
  const m = new Metrics()
  m.set("queue_depth", 7)
  m.set("queue_depth", 4)
  m.inc("jobs_total")
  m.inc("jobs_total")
  assert.equal(
    m.render(),
    `# TYPE jobs_total counter
jobs_total 2
# TYPE queue_depth gauge
queue_depth 4
`
  )
})

test("histogram buckets are cumulative and include sum and count", () => {
  const m = new Metrics()
  m.observe("request_duration_seconds", 0.003, {}, [0.005, 0.01, 0.1])
  m.observe("request_duration_seconds", 0.007, {}, [0.005, 0.01, 0.1])
  m.observe("request_duration_seconds", 0.05, {}, [0.005, 0.01, 0.1])
  assert.equal(
    m.render(),
    `# TYPE request_duration_seconds histogram
request_duration_seconds_bucket{le="0.005"} 1
request_duration_seconds_bucket{le="0.01"} 2
request_duration_seconds_bucket{le="0.1"} 3
request_duration_seconds_bucket{le="+Inf"} 3
request_duration_seconds_sum 0.06
request_duration_seconds_count 3
`
  )
})

test("histogram labels sit beside le, and floats lose noise", () => {
  const m = new Metrics()
  m.observe("latency_seconds", 0.1, { route: "/a" }, [0.2])
  m.observe("latency_seconds", 0.2, { route: "/a" }, [0.2])
  assert.equal(
    m.render(),
    `# TYPE latency_seconds histogram
latency_seconds_bucket{le="0.2",route="/a"} 2
latency_seconds_bucket{le="+Inf",route="/a"} 2
latency_seconds_sum{route="/a"} 0.3
latency_seconds_count{route="/a"} 2
`
  )
})

test("label values are escaped", () => {
  const m = new Metrics()
  m.set("last_error_info", 1, { message: 'bad "quote" \\ slash\nnewline' })
  assert.equal(
    m.render(),
    `# TYPE last_error_info gauge
last_error_info{message="bad \\"quote\\" \\\\ slash\\nnewline"} 1
`
  )
})

test("a counter cannot decrease, and a name has one type", () => {
  const m = new Metrics()
  assert.throws(() => m.inc("jobs_total", {}, -1), /decrease/)
  m.inc("x_total")
  assert.throws(() => m.set("x_total", 1), /already registered/)
})
```
solution:
```ts
export type Labels = Record<string, string | number>

export const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]

type Kind = "counter" | "gauge" | "histogram"
type Series = { labels: Labels; value: number }
type HistSeries = { labels: Labels; values: number[] }
type Histogram = { buckets: number[]; series: Map<string, HistSeries> }

function keyOf(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${JSON.stringify(String(labels[k]))}`)
    .join(",")
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"')
}

function labelsText(labels: Labels): string {
  const keys = Object.keys(labels).sort()
  if (!keys.length) return ""
  return `{${keys.map((k) => `${k}="${escapeLabel(String(labels[k]))}"`).join(",")}}`
}

function format(value: number): string {
  if (Number.isInteger(value)) return String(value)
  return String(Number(value.toPrecision(12)))
}

export class Metrics {
  private kinds = new Map<string, Kind>()
  private counters = new Map<string, Map<string, Series>>()
  private gauges = new Map<string, Map<string, Series>>()
  private histograms = new Map<string, Histogram>()

  private claim(name: string, kind: Kind): void {
    const existing = this.kinds.get(name)
    if (existing && existing !== kind) throw new Error(`${name} is already registered as a ${existing}`)
    this.kinds.set(name, kind)
  }

  inc(name: string, labels: Labels = {}, by = 1): void {
    if (by < 0) throw new Error("a counter cannot decrease")
    this.claim(name, "counter")
    let series = this.counters.get(name)
    if (!series) {
      series = new Map()
      this.counters.set(name, series)
    }
    const key = keyOf(labels)
    const existing = series.get(key)
    if (existing) existing.value += by
    else series.set(key, { labels: { ...labels }, value: by })
  }

  set(name: string, value: number, labels: Labels = {}): void {
    this.claim(name, "gauge")
    let series = this.gauges.get(name)
    if (!series) {
      series = new Map()
      this.gauges.set(name, series)
    }
    series.set(keyOf(labels), { labels: { ...labels }, value })
  }

  observe(name: string, value: number, labels: Labels = {}, buckets: number[] = DEFAULT_BUCKETS): void {
    this.claim(name, "histogram")
    let histogram = this.histograms.get(name)
    if (!histogram) {
      histogram = { buckets: [...buckets].sort((a, b) => a - b), series: new Map() }
      this.histograms.set(name, histogram)
    }
    const key = keyOf(labels)
    const existing = histogram.series.get(key)
    if (existing) existing.values.push(value)
    else histogram.series.set(key, { labels: { ...labels }, values: [value] })
  }

  private sorted<T extends { labels: Labels }>(series: Map<string, T>): T[] {
    return [...series.values()].sort((a, b) => labelsText(a.labels).localeCompare(labelsText(b.labels)))
  }

  render(): string {
    const lines: string[] = []
    for (const name of [...this.kinds.keys()].sort()) {
      const kind = this.kinds.get(name)!
      lines.push(`# TYPE ${name} ${kind}`)
      if (kind === "histogram") {
        const histogram = this.histograms.get(name)!
        for (const s of this.sorted(histogram.series)) {
          for (const bound of histogram.buckets) {
            lines.push(`${name}_bucket${labelsText({ ...s.labels, le: String(bound) })} ${s.values.filter((v) => v <= bound).length}`)
          }
          lines.push(`${name}_bucket${labelsText({ ...s.labels, le: "+Inf" })} ${s.values.length}`)
          const sum = s.values.reduce((a, b) => a + b, 0)
          lines.push(`${name}_sum${labelsText(s.labels)} ${format(sum)}`)
          lines.push(`${name}_count${labelsText(s.labels)} ${s.values.length}`)
        }
      } else {
        const series = (kind === "counter" ? this.counters : this.gauges).get(name)!
        for (const s of this.sorted(series)) {
          lines.push(`${name}${labelsText(s.labels)} ${format(s.value)}`)
        }
      }
    }
    return lines.length ? lines.join("\n") + "\n" : ""
  }
}
```
wrong: The buckets are not cumulative, so every bucket is a range and +Inf is not the total.
```ts
export type Labels = Record<string, string | number>
export const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
type Series = { labels: Labels; value: number }
type HistSeries = { labels: Labels; values: number[] }
type Histogram = { buckets: number[]; series: Map<string, HistSeries> }
function keyOf(labels: Labels): string {
  return Object.keys(labels).sort().map((k) => `${k}=${JSON.stringify(String(labels[k]))}`).join(",")
}
function labelsText(labels: Labels): string {
  const keys = Object.keys(labels).sort()
  if (!keys.length) return ""
  return `{${keys.map((k) => `${k}="${String(labels[k])}"`).join(",")}}`
}
function format(value: number): string {
  if (Number.isInteger(value)) return String(value)
  return String(Number(value.toPrecision(12)))
}
export class Metrics {
  private kinds = new Map<string, "counter" | "gauge" | "histogram">()
  private counters = new Map<string, Map<string, Series>>()
  private gauges = new Map<string, Map<string, Series>>()
  private histograms = new Map<string, Histogram>()
  private claim(name: string, kind: "counter" | "gauge" | "histogram"): void {
    const existing = this.kinds.get(name)
    if (existing && existing !== kind) throw new Error(`${name} is already registered as a ${existing}`)
    this.kinds.set(name, kind)
  }
  inc(name: string, labels: Labels = {}, by = 1): void {
    this.claim(name, "counter")
    let series = this.counters.get(name)
    if (!series) { series = new Map(); this.counters.set(name, series) }
    const key = keyOf(labels)
    const existing = series.get(key)
    if (existing) existing.value += by
    else series.set(key, { labels: { ...labels }, value: by })
  }
  set(name: string, value: number, labels: Labels = {}): void {
    this.claim(name, "gauge")
    let series = this.gauges.get(name)
    if (!series) { series = new Map(); this.gauges.set(name, series) }
    series.set(keyOf(labels), { labels: { ...labels }, value })
  }
  observe(name: string, value: number, labels: Labels = {}, buckets: number[] = DEFAULT_BUCKETS): void {
    this.claim(name, "histogram")
    let histogram = this.histograms.get(name)
    if (!histogram) {
      histogram = { buckets: [...buckets].sort((a, b) => a - b), series: new Map() }
      this.histograms.set(name, histogram)
    }
    const key = keyOf(labels)
    const existing = histogram.series.get(key)
    if (existing) existing.values.push(value)
    else histogram.series.set(key, { labels: { ...labels }, values: [value] })
  }
  private sorted<T extends { labels: Labels }>(series: Map<string, T>): T[] {
    return [...series.values()].sort((a, b) => labelsText(a.labels).localeCompare(labelsText(b.labels)))
  }
  render(): string {
    const lines: string[] = []
    for (const name of [...this.kinds.keys()].sort()) {
      const kind = this.kinds.get(name)!
      lines.push(`# TYPE ${name} ${kind}`)
      if (kind === "histogram") {
        const histogram = this.histograms.get(name)!
        for (const s of this.sorted(histogram.series)) {
          let previous = 0
          for (const bound of histogram.buckets) {
            const inRange = s.values.filter((v) => v > previous && v <= bound).length
            lines.push(`${name}_bucket${labelsText({ ...s.labels, le: String(bound) })} ${inRange}`)
            previous = bound
          }
          lines.push(`${name}_bucket${labelsText({ ...s.labels, le: "+Inf" })} ${s.values.filter((v) => v > previous).length}`)
          const sum = s.values.reduce((a, b) => a + b, 0)
          lines.push(`${name}_sum${labelsText(s.labels)} ${format(sum)}`)
          lines.push(`${name}_count${labelsText(s.labels)} ${s.values.length}`)
        }
      } else {
        const series = (kind === "counter" ? this.counters : this.gauges).get(name)!
        for (const s of this.sorted(series)) {
          lines.push(`${name}${labelsText(s.labels)} ${format(s.value)}`)
        }
      }
    }
    return lines.length ? lines.join("\n") + "\n" : ""
  }
}
```
wrong: Label values are pasted in raw, so a quote or newline produces a broken exposition line.
```ts
export type Labels = Record<string, string | number>
export const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
type Series = { labels: Labels; value: number }
type HistSeries = { labels: Labels; values: number[] }
type Histogram = { buckets: number[]; series: Map<string, HistSeries> }
function keyOf(labels: Labels): string {
  return Object.keys(labels).sort().map((k) => `${k}=${String(labels[k])}`).join(",")
}
function labelsText(labels: Labels): string {
  const keys = Object.keys(labels).sort()
  if (!keys.length) return ""
  return `{${keys.map((k) => `${k}="${String(labels[k])}"`).join(",")}}`
}
function format(value: number): string {
  if (Number.isInteger(value)) return String(value)
  return String(Number(value.toPrecision(12)))
}
export class Metrics {
  private kinds = new Map<string, "counter" | "gauge" | "histogram">()
  private counters = new Map<string, Map<string, Series>>()
  private gauges = new Map<string, Map<string, Series>>()
  private histograms = new Map<string, Histogram>()
  private claim(name: string, kind: "counter" | "gauge" | "histogram"): void {
    const existing = this.kinds.get(name)
    if (existing && existing !== kind) throw new Error(`${name} is already registered as a ${existing}`)
    this.kinds.set(name, kind)
  }
  inc(name: string, labels: Labels = {}, by = 1): void {
    this.claim(name, "counter")
    let series = this.counters.get(name)
    if (!series) { series = new Map(); this.counters.set(name, series) }
    const key = keyOf(labels)
    const existing = series.get(key)
    if (existing) existing.value += by
    else series.set(key, { labels: { ...labels }, value: by })
  }
  set(name: string, value: number, labels: Labels = {}): void {
    this.claim(name, "gauge")
    let series = this.gauges.get(name)
    if (!series) { series = new Map(); this.gauges.set(name, series) }
    series.set(keyOf(labels), { labels: { ...labels }, value })
  }
  observe(name: string, value: number, labels: Labels = {}, buckets: number[] = DEFAULT_BUCKETS): void {
    this.claim(name, "histogram")
    let histogram = this.histograms.get(name)
    if (!histogram) {
      histogram = { buckets: [...buckets].sort((a, b) => a - b), series: new Map() }
      this.histograms.set(name, histogram)
    }
    const key = keyOf(labels)
    const existing = histogram.series.get(key)
    if (existing) existing.values.push(value)
    else histogram.series.set(key, { labels: { ...labels }, values: [value] })
  }
  private sorted<T extends { labels: Labels }>(series: Map<string, T>): T[] {
    return [...series.values()].sort((a, b) => labelsText(a.labels).localeCompare(labelsText(b.labels)))
  }
  render(): string {
    const lines: string[] = []
    for (const name of [...this.kinds.keys()].sort()) {
      const kind = this.kinds.get(name)!
      lines.push(`# TYPE ${name} ${kind}`)
      if (kind === "histogram") {
        const histogram = this.histograms.get(name)!
        for (const s of this.sorted(histogram.series)) {
          for (const bound of histogram.buckets) {
            lines.push(`${name}_bucket${labelsText({ ...s.labels, le: String(bound) })} ${s.values.filter((v) => v <= bound).length}`)
          }
          lines.push(`${name}_bucket${labelsText({ ...s.labels, le: "+Inf" })} ${s.values.length}`)
          const sum = s.values.reduce((a, b) => a + b, 0)
          lines.push(`${name}_sum${labelsText(s.labels)} ${format(sum)}`)
          lines.push(`${name}_count${labelsText(s.labels)} ${s.values.length}`)
        }
      } else {
        const series = (kind === "counter" ? this.counters : this.gauges).get(name)!
        for (const s of this.sorted(series)) {
          lines.push(`${name}${labelsText(s.labels)} ${format(s.value)}`)
        }
      }
    }
    return lines.length ? lines.join("\n") + "\n" : ""
  }
}
```
hint: Build the label text once from sorted keys, with `\` escaped before `"` and newline. A histogram bucket is a running total, not a range; compute it with `v <= bound` for every observation. `toPrecision(12)` is enough to make a sum of tenths print like a human wrote it.
:::

## Read locally, write home
id: regions-locality
stage: regions
needs: pg-replica
minutes: 40
goal: Decide which reads can be served by a local replica, what consistency each choice gives up, and where the write must go.
source: PostgreSQL: Hot standby | https://www.postgresql.org/docs/current/hot-standby.html
source: AWS: RDS read replicas | https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ReadRepl.html
source: AWS Builders' Library: Caching challenges and strategies | https://aws.amazon.com/builders-library/caching-challenges-and-strategies/

A read replica is a latency tool with a consistency bill. Reads that can tolerate seconds of staleness get a local copy; reads that must see the user's own write go to the primary (or carry a token that waits for the replica to reach the write's LSN). The design question is not "can we add a replica" but "which reads are allowed to be stale, and for how long".

The [hot standby](https://www.postgresql.org/docs/current/hot-standby.html) page describes the read-only standby and `hot_standby_feedback`. [RDS read replicas](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ReadRepl.html) describes the managed version and its lag. The [caching challenges](https://aws.amazon.com/builders-library/caching-challenges-and-strategies/) article covers the same staleness decision one layer up.

::: quiz
q: A user changes their display name, then reloads a page served by a regional read replica. The replica is 800 ms behind. Which guarantee is missing?
- Durability, because the write was not committed
+ Read-your-writes, because this session may read a replica that has not replayed its own write
- Atomicity, because the name update is one row
why: The write committed on the primary and is durable. The read went to a replica that is behind, so the session may not see its own write. Fix it by routing that read to the primary, pinning the session, or waiting for the replica's LSN to pass the write's LSN.
:::

::: card
q: A product page can tolerate five seconds of staleness. A checkout balance cannot. What does that imply for the data path?
answer: Split the reads: product/catalog reads go to the local replica with a five-second freshness budget; balance and authorization reads go to the primary or to a strongly consistent store. The split is a product decision encoded in routing, not a property of the database. Write it down and test the boundary.
:::

::: card
q: What does `hot_standby_feedback = on` trade away?
answer: The standby tells the primary about its oldest running query, so the primary delays vacuuming rows that the standby still needs. That reduces query cancellations on the standby at the cost of more bloat and a slower vacuum on the primary. It is a consistency-versus-maintenance trade, not a free setting.
:::

## Choose the DR strategy, then prove it
id: regions-dr
stage: regions
needs: regions-rto, regions-aws
minutes: 50
goal: Match backup/restore, pilot light, warm standby and multi-site to real RTO/RPO budgets, and treat failback as part of the drill.
source: AWS: Disaster Recovery of Workloads on AWS | https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-workloads-on-aws.html
source: Google SRE: Emergency response | https://sre.google/sre-book/emergency-response/
source: Google SRE: Postmortem culture | https://sre.google/sre-book/postmortem-culture/

The four AWS strategies are a ladder of cost and recovery time: backup and restore, pilot light, warm standby, multi-site active/active. The names are less important than the numbers: what is running in the standby region, how fresh is the data, and how long does it take to turn the standby into the production path? A strategy that has never been drilled is a hypothesis.

Read the [DR whitepaper](https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-workloads-on-aws.html) for the strategies and their RTO/RPO ranges. The [emergency response](https://sre.google/sre-book/emergency-response/) chapter is the incident side; [postmortem culture](https://sre.google/sre-book/postmortem-culture/) is how the drill changes the next design.

::: quiz
q: A team promises an RTO of 15 minutes and an RPO of 1 minute. Which strategy is the minimum honest fit?
- Backup and restore from nightly snapshots
+ Warm standby with continuous replication and a tested traffic switch
- Pilot light with the database restored from a weekly copy
why: Nightly backups cannot meet a one-minute RPO. A pilot light can be cheap but its data freshness and start-up time must be proven; a warm standby with continuous replication is the first rung that can plausibly meet both, and only if the switch is drilled. Multi-site is more expensive than the budget requires.
:::

::: quiz
q: The drill promotes the DR region and serves traffic for two hours. Then the original region comes back. What is the dangerous part of failback?
- Nothing; the original region is empty, so it can be restarted
+ The DR region has accepted writes the original region never saw, so failback can lose them or create conflicts
- DNS will switch back automatically
why: After promotion, the old primary is stale and may also have divergent local writes. Failback is a data-reconciliation problem first and a DNS problem second. You need a plan for the writes made in DR, a resynchronization direction, and a test before moving traffic back.
:::

::: card
q: What must a DR drill produce besides "it worked"?
answer: A measured RTO and RPO, the exact commands and owners for each step, the data-loss count and reconciliation decision, the client/DNS behavior, and the follow-up actions with owners. The report is the artifact that makes the next drill cheaper and the design reviews honest.
:::

::: card
q: Why is active/active not automatically better than warm standby?
answer: Active/active moves the hard problem from recovery time to conflict resolution and data ownership. Every write path must be routable to a home region or mergeable, and every read must tolerate the consistency the replication gives. If the workload cannot define those rules, active/active buys availability with correctness risk and operational complexity.
:::
