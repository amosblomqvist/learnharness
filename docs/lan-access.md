# LAN access

The desktop app can serve its full interface to other devices on your network (another computer, a phone, a tablet). It is off by default and only runs while the desktop app is open.

## Turn it on

1. Open **Settings → LAN access** in the desktop app.
2. Switch on **Allow access from other devices on this network**.
3. Open one of the listed URLs (for example `http://192.168.1.20:4747`) in the other device's browser.

The default port is 4747; change it in the same section (1024 to 65535). If the port is busy, the switch stays off and the section says so. Closing the app, or switching the option off, cuts access immediately.

## Password (optional)

Set one in the same section. Devices then see a sign-in page before anything else, and stay signed in for 30 days, including across app restarts. After 5 wrong attempts from one address, that address is blocked for 60 seconds. Changing or removing the password signs every device out.

Without a password, anyone on the network gets in. The section shows a warning while that is the case.

## What works on other devices

- Chats, lessons, notes, the graph, and settings use the same data as the desktop app, live.
- The connection is plain HTTP, so browsers expose no microphone there: the app's microphone button is hidden, and the keyboard's own dictation works instead.
- Attaching a file uploads it into the app's data folder under `uploads/` (26 MiB per file). If you restrict the agent's file access, add that uploads folder to the allowed paths.

Desktop only: updates, subscription sign-in (devices use subscriptions once they are signed in on the desktop), and the LAN settings themselves.

## Security

Use this only on a network you trust. Anyone who can reach the port without a password, or with it, can use the agent, which can read files on this computer, your saved keys, and your learning data. Traffic is not encrypted. Never expose the port to the Internet (no port forwarding). The gateway only accepts requests addressed to an IP, `localhost`, or this computer's name, and rejects cross-site requests.
