# Server password

The self-hosted server's sign-in is controlled by two values in
`.env.server`, next to `docker-compose.yml` in the folder you deployed from
(see [self-hosting.md](self-hosting.md)):

| Setting | What it does |
|---|---|
| `LH_SERVER_PASSWORD` | The password you type on the sign-in page. Setting it is what turns sign-in on. |
| `LH_SESSION_SECRET` | Signs the "stay signed in" cookie each device keeps for 30 days. Changing it signs every device out. |

The examples below assume the server is reachable as `user@server` and the
deployment lives in `~/learnharness`. Substitute your own.

## Set the password (first time)

```bash
ssh user@server
cd ~/learnharness
cp .env.server.example .env.server
chmod 600 .env.server
nano .env.server
```

Fill in:

```
LH_SERVER_PASSWORD=your-new-password
LH_SESSION_SECRET=<paste the output of: openssl rand -hex 32>
```

Then start the server:

```bash
docker compose -p learnharness up -d --build
```

## Change the password

```bash
ssh user@server
nano ~/learnharness/.env.server        # edit the LH_SERVER_PASSWORD= line, save
cd ~/learnharness && docker compose -p learnharness up -d
```

Compose prints `Recreated` for the LearnHarness container. Only that
container restarts; your data (the `learnharness-data` volume) and anything
else on the server are untouched.

Devices that are already signed in **stay signed in**: their cookies depend
on `LH_SESSION_SECRET`, not on the password. New sign-ins need the new
password.

## Sign every device out

Do this if the old password may have leaked, or a device was lost. Replace
the session secret as well as (or instead of) the password:

```bash
openssl rand -hex 32                   # copy the output
nano ~/learnharness/.env.server        # paste it after LH_SESSION_SECRET=
cd ~/learnharness && docker compose -p learnharness up -d
```

Every browser and desktop app has to sign in again. (If `LH_SESSION_SECRET`
is left empty, sessions are signed with the password instead, so then
changing the password alone signs everyone out.)

To sign out just one device, use **LearnHarness → Sign Out of Server** in the
desktop app, or clear the site's cookies in that browser.

## Look up the current password

```bash
ssh user@server "grep LH_SERVER_PASSWORD ~/learnharness/.env.server"
```

## Tips

- Use letters, numbers, `-` and `_`. Quotes, spaces or `$` can be
  misinterpreted in the `.env` file.
- Make it long: a passphrase of four or more random words works well.
- Ten wrong passwords from one address lock that address out for 15
  minutes. Restarting the container clears the lockout.
- `.env.server` is in `.gitignore`. Never commit it.
