# SkyDesk

Public landing page, legal docs, and Chrome extension source.

- **Live site:** https://cmb-server.github.io/SkyDesk/
- **Chrome Web Store:** https://chromewebstore.google.com/detail/skydesk/bebpoadgmffalooplgaloncgblhblbkc
- **Releases:** https://github.com/cmb-server/SkyDesk/releases

## Repo layout

| Path | Purpose |
|------|---------|
| `index.html`, `privacy/`, `terms/` | GitHub Pages landing + legal |
| `analytics.js` | GA4 for website (`click_install` event) |
| `extension/` | Chrome extension source (v1.0.4+) |

## Extension — load unpacked

1. Open `chrome://extensions` → Developer mode
2. **Load unpacked** → select the `extension/` folder

## Extension — store upload zip

```bash
cd extension && zip -r ../SkyDesk.zip . -x "*.DS_Store"
```

Upload `SkyDesk.zip` in the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
