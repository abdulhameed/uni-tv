# Uni TV

Watch, curate, filter and record the channels in an M3U playlist.

The playlist is not included. Put your own at `Global TV.m3u` in the project root, or point `PLAYLIST` at one (see below).

```
npm start          # or: node server.js
```

Then open http://localhost:4321 in **Chrome / Edge / Arc** (needed for recording).

- **Curated**: rows per category with only streams that pass a live check. They show the best quality first and leave out part-time and geo-blocked channels. Continue watching and Favorites rows sit at the top.
- **All channels**: search plus filters for status, quality, category, favorites, geo-blocked and part-time. Duplicate names are merged, and the player lets you switch between sources.
- **Metadata**: country, language, categories and logos come from the [iptv-org](https://github.com/iptv-org/api) database. It is downloaded to `data/iptv-org/` and refreshed weekly, and about 80% of channels match.
- **Scan streams**: checks every stream in the background. Results are saved in `data/health.json`.
- **Record**: records the playing channel as video or audio only. You can stop it yourself or set it to stop after a set time. Files go to `recordings/` and show up in the Recordings tab.

Keyboard: `/` search · `↑/↓` change channel · `f` fullscreen · `t` theater · `m` mute · `s` favorite · `r` record video · `a` record audio · `Esc` close player.

Use `PLAYLIST=/path/to/other.m3u npm start` to load a different playlist and `PORT=8080` to use another port.
