# Chrome Web Store listing — Listening Glass 0.1.0

Source of every claim below: the built extension in `src/` (`src/manifest.json`, `src/page/core.js`,
`src/page/youtube-adapter.js`, `src/site-list.js`, `src/popup/`), verified against the repository at
`https://github.com/beatlejute/ListeningGlass`. Copy the values from this file into the Chrome Web
Store Developer Dashboard as they are written here.

---

## Store listing name

```
Listening Glass
```

## Short description (132 characters max)

```
Keeps audio and video playing when the browser is minimized, the tab is hidden, or you switch windows.
```

Length: 102 characters (limit 132).

## Category

```
Productivity
```

---

## Full description

```
Listening Glass keeps your music and video playing when the browser is not in front of you.

Every browser pauses media when a tab is hidden or the window is minimized. That is by design: a
background tab should not make noise while you work. The trouble is that it also stops when you only
want the sound — a music player, a lecture, a livestream, a podcast while you do something else.
Pressing play again means finding the tab first.

Listening Glass fixes that. Once it is on for a site, the media keeps playing when you minimize the
browser, switch to another window, or move the tab to the background. Play again from your keyboard,
your headset buttons, or the media controls in your phone or watch, and playback resumes.

It is not a downloader, a download accelerator, or an ad remover. It does not unlock anything and it
does not touch what the site offers — it only makes the player behave the way you expected.

How it works: the extension runs a small script on the sites you enable. The script reports the page
as visible to the player and takes the page off the browser's audio-throttling list, so the site keeps
decoding and playing instead of releasing the media element. Playback resumes with the normal play
control, including Media Session commands from your keyboard, headset, or phone.

Sites enabled by default:

- YouTube and YouTube Music (desktop and mobile)
- Rutube
- Twitch
- TikTok
- Apple Music

Picture-in-picture: on the sites that support it, Listening Glass removes the element-level block on
picture-in-picture, so you can pop the video out into a floating window while the sound keeps going.

Your site list: the default sites work out of the box. You can turn the extension off for any of
them, add your own site, or reset the list to defaults from the toolbar popup. The list is stored
locally in your browser profile and never leaves your device.

What the extension does not do: it collects nothing, has no account, no analytics, and no server. It
contains no remotely loaded code. It does not read the content of the pages where it runs, it does
not download media, and it does not change what you are entitled to access. See the privacy policy
for details.

Listening Glass is open source: https://github.com/beatlejute/ListeningGlass
```

---

## Privacy practices tab

### Single purpose

```
Keeps audio and video playing on sites the user enables, when the browser window is minimized, the tab
is hidden, or the user switches to another window or application.
```

### Permission justifications

| Permission or host access in `src/manifest.json` | Why the extension needs it |
|---|---|
| `scripting` | Injects the small playback script into the pages of the sites the user has enabled, in the page's main world and before the page's own scripts, because no browser API exposes the standard page-visibility and media-throttling signals the sites use. |
| `storage` | Saves the user's site list in `chrome.storage.local`: the sites the user added and the default sites the user turned off. The list is read on browser start to decide where to run the script. Nothing else is stored. |
| Host access `*://www.youtube.com/*` | Runs the playback script on that site, which pauses media and blocks play when the tab is hidden. |
| Host access `*://m.youtube.com/*` | The same, for the mobile version of the site. |
| Host access `*://www.youtube-nocookie.com/*` | The same, for the privacy-enhanced host of the same service. |
| Host access `*://music.youtube.com/*` | The same, for the music service. |
| Host access `*://rutube.ru/*` | The same, for a video host that pauses and blocks play when the tab is hidden. |
| Host access `*://m.twitch.tv/*` | The same, for the mobile web player. |
| Host access `*://www.twitch.tv/*` | The same, for the desktop web player. |
| Host access `*://www.tiktok.com/*` | The same, for a site that pauses playback when the tab is hidden. |
| Host access `*://music.apple.com/*` | The same, for a music service that pauses on blur. |
| Optional host access `http://*/*` | Requested only when the user adds a site of their own over plain HTTP, so the playback script can run there too. It is not requested at install time. |
| Optional host access `https://*/*` | Requested only when the user adds a site of their own, so the playback script can run there too. It is not requested at install time. |

### Remote code

```
No. The extension does not download or execute code from the network. Everything it runs is packaged
in the extension itself. It makes no network requests: there is no fetch, XMLHttpRequest, sendBeacon,
or WebSocket call in the source. On the sites it supports it only reads and adjusts the page's own
media element and picture-in-picture state; it does not inject code received from a server, and it
does not modify the pages' scripts.
```

### Data usage certification

```
Listening Glass does not collect, transmit, sell, or share any user data.

Single purpose statement: keeps audio and video playing on sites the user enables, when the browser is
minimized, the tab is hidden, or the user switches windows.

The only data the extension handles is the user's site list — a set of host names such as
www.youtube.com, stored locally in chrome.storage.local in the user's own browser profile. The
extension does not collect or transmit this data, does not send it to the developer, and does not
share it with third parties. It is not used for advertising, and it is not sold.

The extension does not collect or transmit: browsing history, page content, media or track metadata,
cookies, personal or identifying information, IP addresses, or any data from the pages where it runs.
There is no account, no server, no analytics SDK, and no crash reporting.

Certificate: I do not sell or transfer user data to third parties, apart from the approved use cases
described in the Privacy Policy.
```

### Privacy policy URL

```
https://github.com/beatlejute/ListeningGlass/blob/main/store/privacy-policy.md
```

### Homepage, support, and source code

| Field | URL |
|---|---|
| Homepage | https://github.com/beatlejute/ListeningGlass |
| Support | https://github.com/beatlejute/ListeningGlass/issues |
| Source code | https://github.com/beatlejute/ListeningGlass |

---

## Notes for the person filling in the dashboard

- Paste the Short description and Full description blocks as plain text; the ``` fences above mark
  the exact characters to copy, not part of the listing.
- The "Single purpose" answer, both answers in Remote code and Data usage certification, and the
  per-permission justifications are the Privacy practices tab of the store listing form.
- Every permission row in the table maps one-to-one to an entry in `src/manifest.json`: `scripting`,
  `storage`, the nine `host_permissions`, and the two `optional_host_permissions`. If a later version
  changes the manifest, this table has to be rewritten to match it.
- Images for the listing (small promo tile 440×280, screenshots 1280×800) are tracked separately and
  are not described here.
- No wording implies unlocking, downloading, or circumventing site restrictions, and the listing
  contains no competitor names.
