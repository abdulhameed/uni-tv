# Uni TV

Watch, curate, filter and record the channels in an M3U playlist.

The playlist is not included. Put your own at `Global TV.m3u` in the project root, or point `PLAYLIST` at one (see below).

```
npm start          # or: node server.js
```

Then open http://localhost:4321 in **Chrome / Edge / Arc** (needed for recording).

Requires Node 22.13 or newer (uses the built-in SQLite).

**Accounts:** anyone can watch without signing in. An account is needed to chat or comment, and it keeps your watch history and watch time (open it from your name in the top-right). Signing up and in is protected against bots by:
- a proof-of-work puzzle the browser solves in about a second
- signed, single-use, expiring challenges with a minimum time to fill in the form
- a hidden honeypot field
- per-IP and per-account rate limits, with account lockout after repeated failures
- cross-site request blocking

Passwords are hashed with scrypt, and sessions are HttpOnly cookies. Accounts and history live in `data/uni-tv.db`. Keep `data/secret.key` private.

Options:
- `TURNSTILE_SITE_KEY=… TURNSTILE_SECRET=…` adds a Cloudflare Turnstile human check, which is recommended if the app is reachable from the internet.
- `GUEST_POSTING=1` lets people without an account chat and comment under a nickname.

**Comments & live chat:** every channel has its own **live chat** (with a count of who's watching) and a **comments** section, as two tabs under the player. The **Live chat** tab is one room for everyone using this Uni TV. It shows who's online and what they're watching, and you can click a channel tag to watch along. Posting needs an account, and posts from accounts show a ✓. With `GUEST_POSTING=1`, people without an account can post under a nickname. People can delete their own posts, and the host computer can delete anything. Messages and comments are stored in `data/social.json`.

**Sharing:** the ↗ button in the player gives you a link to the channel, a one-channel `.m3u` file for VLC/IINA, and the raw stream URL. Start with `LAN=1 npm start` and friends on the same Wi‑Fi can open the link and watch. Guests can't see or change your recordings. Note that LAN mode also lets anyone on that network stream through your computer, so use it only on networks you trust.

- **Curated**: rows per category with only streams that pass a live check. They show the best quality first and leave out part-time and geo-blocked channels. Continue watching and Favorites rows sit at the top.
- **All channels**: search plus filters for status, quality, category, favorites, geo-blocked and part-time. Duplicate names are merged, and the player lets you switch between sources.
- **Metadata**: country, language, categories and logos come from the [iptv-org](https://github.com/iptv-org/api) database. It is downloaded to `data/iptv-org/` and refreshed weekly, and about 80% of channels match.
- **Scan streams**: checks every stream in the background. Results are saved in `data/health.json`.
- **Record**: records the playing channel as video or audio only. You can stop it yourself or set it to stop after a set time. Files go to `recordings/` and show up in the Recordings tab.

Keyboard: `/` search · `↑/↓` change channel · `f` fullscreen · `t` theater · `m` mute · `+`/`-` volume · `p` screenshot · `s` favorite · `r` record video · `a` record audio · `Esc` close player.

Use `PLAYLIST=/path/to/other.m3u npm start` to load a different playlist and `PORT=8080` to use another port.
