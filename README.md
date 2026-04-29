# AI Promotion Awards Voting

This project now supports Cloudflare Pages + Functions with:

- `public/` for static assets
- `functions/` for API routes
- `D1` for structured data
- `R2` for uploaded media files

## Local Node Server

```powershell
npm install
npm start
```

- User: `http://localhost:3000`
- Admin: `http://localhost:3000/admin`

## Cloudflare Setup

Required resources:

1. Cloudflare Pages project
2. D1 database: `aiiparkmall-voting`
3. R2 bucket: `aiiparkmall-media`

Required bindings:

- `DB` -> D1 database
- `MEDIA_BUCKET` -> R2 bucket
- `ADMIN_PASSWORD` -> environment variable

## Wrangler

This repo uses [wrangler.toml](/c:/Users/IPARK/Desktop/업무/AI%20Project%20(김선빈)/07.%20AI%20홍보%20영상%20투표%20사이트/wrangler.toml).

Useful commands:

```powershell
npm run cf:dev
npm run cf:deploy
npm run cf:d1:apply
npm run cf:import:data
```

## D1 Migration

Initial schema file:

- [migrations/0001_init.sql](</c:/Users/IPARK/Desktop/업무/AI Project (김선빈)/07. AI 홍보 영상 투표 사이트/migrations/0001_init.sql>)

Run:

```powershell
npm install
npx wrangler login
npm run cf:d1:apply
```

## Existing Data Import

If local data already exists in [data](/c:/Users/IPARK/Desktop/업무/AI%20Project%20(김선빈)/07.%20AI%20홍보%20영상%20투표%20사이트/data), import it after D1 and R2 bindings are connected:

```powershell
npm run cf:import:data
```

This imports:

- [data/state.json](/c:/Users/IPARK/Desktop/업무/AI%20Project%20(김선빈)/07.%20AI%20홍보%20영상%20투표%20사이트/data/state.json) -> D1 `contest_state`
- [data/employees.json](/c:/Users/IPARK/Desktop/업무/AI%20Project%20(김선빈)/07.%20AI%20홍보%20영상%20투표%20사이트/data/employees.json) -> D1 `employees`
- [data/videos.json](/c:/Users/IPARK/Desktop/업무/AI%20Project%20(김선빈)/07.%20AI%20홍보%20영상%20투표%20사이트/data/videos.json) -> D1 `videos`
- [data/votes.json](/c:/Users/IPARK/Desktop/업무/AI%20Project%20(김선빈)/07.%20AI%20홍보%20영상%20투표%20사이트/data/votes.json) -> D1 `votes`
- [data/uploads](/c:/Users/IPARK/Desktop/업무/AI%20Project%20(김선빈)/07.%20AI%20홍보%20영상%20투표%20사이트/data/uploads) -> R2 `aiiparkmall-media`

## Notes

- Uploaded media is stored in R2 with keys like `bgm/<filename>` or `video/<filename>`.
- The import script expects `wrangler` login to already be completed.
- If a local uploaded file is missing, the script skips that file and continues.
