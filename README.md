# Song Quiz

Multiplayer song guessing game for GitHub Pages. No server: the host's browser runs the game and players connect to it over WebRTC (PeerJS).

## Deploy

1. Put these files at the root of a repo (keep `index.html`, `style.css`, `app.js`, `custom-songs.json`).
2. Settings → Pages → deploy from your main branch.
3. Open the site, **Create room**, share the invite link or the 5-letter code.

To test locally, serve the folder (e.g. `python -m http.server`). Opening `index.html` as a file won't load `custom-songs.json`.

## Playlists

The host pastes one or more Deezer playlist links in the lobby. Requirements:

- The playlist must be public.
- Use the full URL (`https://www.deezer.com/en/playlist/123456789`). Short `link.deezer.com` / `deezer.page.link` links can't be resolved from a browser. Open them once and copy the final URL.
- Questions use Deezer's 30-second preview clips. Tracks without a preview are skipped.

## Custom songs

Put audio files in a `songs/` folder (mp3 recommended) and list them in `custom-songs.json`:

```json
[
  {
    "title": "My Song",
    "artist": "Me",
    "album": "Demo EP",
    "file": "songs/my-song.mp3",
    "cover": "songs/my-song.jpg",
    "start": 45
  }
]
```

- `title` and `file` are required. `artist`, `album`, `cover` and `start` are optional.
- `start` is the second where the clip begins. If omitted, a random 30s window is chosen each game.
- A song with no `artist` or `album` just won't get that question type, but still counts as a wrong-answer source for the others.
- Custom songs join the same pool as the playlist (or use "Custom songs only" in the lobby).
- Files in a public repo are public. Only commit audio you have the right to share.

## Artist aliases

`artist-aliases.json` renames artists before the game uses them, for Deezer and custom songs alike. The renamed artist is what players see in options and on the reveal, and what hard mode and the duplicate check compare.

```json
{
  "ye": "Kanye West",
  "Kanye West & Ty Dolla $ign": "¥$"
}
```

- Left side: the artist name as Deezer (or your custom file) gives it. Right side: the name to use instead.
- The whole name must match, ignoring capitalization, accents and extra spaces. "ye" only matches the artist "Ye", never a name that merely contains it.
- The file is optional. If it's missing, no renaming happens. If it isn't valid JSON, loading songs shows an error.
- Add as many entries as you like. Several different names can map to the same artist.

## Question types

Title, artist, album, and **album art** (the options are four album covers and you pick the one that belongs to the song). Each can be toggled in the lobby. Custom songs only get album-art questions if they have a `cover` image, and the pool needs at least 4 different covers.

## Game length, hard mode, loudness

- **Questions:** any number from 1 up to the number of songs in the pool. Use **Load songs** in the lobby to see the pool size. Each song is used at most once per game. Large games take a while to prepare because each Deezer track is looked up individually (throttled to respect Deezer's rate limit).
- **Similar wrong options (always on):** wrong options are random, but similar songs are more likely to show up. For title questions, songs from the same album are the most likely, then songs by the same artist. For album and album-art questions, other albums/covers by the same artist are favored. Nothing is guaranteed, and artist questions are unchanged.
- **Hard mode:** the same idea with much bigger weights, so look-alike options show up far more often. The weights are at the top of `app.js` (an unrelated song counts as 1): `SIM_ALBUM` (12) and `SIM_ARTIST` (6) for the normal game, `HARD_ALBUM` (60) and `HARD_ARTIST` (25) for hard mode. Raise or lower them to taste.
- **Level loudness:** louder songs are turned down toward a common level, which evens out the jumps between tracks. Deezer tracks use Deezer's own loudness value. Custom files are measured by the host's browser (approximate). It can only turn songs down, never up, so very quiet songs stay quiet. Turn it off in the lobby if you prefer.

## Volume

The slider and mute button in the top bar apply to everyone's own device and are remembered between visits.

## Round summary

After each question, the "This round" table shows every player's result, and for players who answered wrong it shows what they picked (the option text, or a small thumbnail for album art questions). Players who didn't answer show "no answer".

## Pausing

The host has a **Pause** button above the timer (during a question or the reveal). Pausing freezes the timer and the audio for everyone, blocks answers, and shows "paused by the host". **Resume** continues with the time that was left, so nobody loses answering time or the countdown to the next question.

## Scoring

Correct answers score 500–1000 points depending on how fast you answer. The audio keeps playing (up to 30s) during the reveal.

## Notes

- Matchmaking uses PeerJS's free cloud broker plus public STUN servers. Most networks work; strict NATs/corporate networks may need a TURN server added to `ICE` in `app.js`.
- If the host closes the tab, the room ends.
- Max 12 players per room.
