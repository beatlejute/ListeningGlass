# Privacy Policy for Listening Glass

**Last updated: 2026-09-30**

Listening Glass is a browser extension that keeps audio and video playing when the browser window is minimized or a tab is in the background. This policy explains exactly what the extension stores on your device and what it never sends anywhere.

## Summary

Listening Glass does not collect, transmit, sell, or share any user data. There is no server, no account, and no analytics. The only data the extension stores is the list of sites you chose to run it on, and that list stays in your browser's local extension storage.

## What the extension stores

The extension stores exactly one thing: your site list.

- **Where it is stored:** `chrome.storage.local`, the browser's local storage for extensions. This storage is part of your browser profile. Its contents never leave the device on their own and are not synchronized to a Google account.
- **What the record looks like:** a single entry named `siteList`, holding two lists of host names — the sites you added yourself and the sites you excluded from the built-in default list. Example: `{ "added": ["example.com"], "excluded": ["www.youtube.com"] }`.
- **What a stored value looks like:** a host name only, such as `www.youtube.com` or `rutube.ru`. The extension extracts the host from any URL you type and discards the rest.
- **What is not stored:** page addresses and their paths, video or track titles, search queries, form input, cookies, browsing history, account identifiers, IP addresses, or any content of the pages where the extension runs.

The default site list ships inside the extension package. Adding, removing, or resetting a site rewrites only the `siteList` record described above.

## What the extension does not collect

- No browsing history, no page content, no media metadata.
- No personal information, no email address, no account or profile data.
- No cookies, no advertising or tracking identifiers.
- No usage statistics, crash reports, telemetry, or diagnostics. The extension contains no analytics SDK and no remote logging.

## What the extension does not transmit

Listening Glass has no backend and makes no network requests on your behalf. Nothing is uploaded, sent to the developer, or shared with third parties — not the site list, not page content, not diagnostics.

The extension is built from the files in its source repository and contains no remote code: everything it runs is packaged in the extension itself and it never downloads or executes scripts from the network. Its permissions are used only on the pages you enable, and only to keep media playing there.

You can verify this yourself: search the extension's source for `fetch`, `XMLHttpRequest`, `sendBeacon`, and `WebSocket` — there are none.

## Where data lives and when it is deleted

- The site list lives in your browser profile, in local extension storage, on the device where you installed the extension.
- Removing a site or resetting the list to defaults removes the corresponding entry.
- Uninstalling the extension removes the stored site list as part of the uninstall. To delete it without uninstalling, reset the site list to its defaults, or clear the extension's data in the browser's extension settings.

## Permissions, and why each is needed

| Permission | Why it is used |
|---|---|
| `storage` | Save your site list locally, so the extension knows which sites to run on. |
| `scripting` | Inject the small playback script into the pages on your site list. |
| Host access for the default sites (`www.youtube.com`, `m.youtube.com`, `www.youtube-nocookie.com`, `music.youtube.com`, `rutube.ru`, `m.twitch.tv`, `www.twitch.tv`, `www.tiktok.com`, `music.apple.com`) | Run the playback script on those sites out of the box. |
| Optional host access for any other `http`/`https` site | Run the playback script on a site you add yourself. Requested only when you add a site. |

## Children

Listening Glass is a general-purpose utility and does not knowingly collect data from anyone, including children.

## Changes to this policy

If this policy changes, the updated version will be published in the extension's source repository at the address below, with the "Last updated" date changed. Material changes will be noted in the repository's release history.

## Contact

Questions about this policy, or a privacy concern, can be raised as an issue in the project's issue tracker:

https://github.com/beatlejute/ListeningGlass/issues

**This policy applies to the extension source published in the repository https://github.com/beatlejute/ListeningGlass, and is available at:**

https://github.com/beatlejute/ListeningGlass/blob/main/store/privacy-policy.md
