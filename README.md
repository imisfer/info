# misfer.info

Jekyll blog on GitHub Pages. Posts are written in the WordPress iOS app and
pulled into this repo automatically.

## How publishing works

```
WordPress app  →  imisfer.wordpress.com  →  hourly GitHub Action
                                          →  _posts/*.md  →  GitHub Pages
```

A post only syncs once it is **published on WordPress** *and* carries the
category **`ready`**. That category is the gate: it lets you publish freely on
WordPress without anything appearing on misfer.info until you mean it.

To drop the gate and mirror everything, clear `WP_CATEGORY_GATE` in
`.github/workflows/sync-wordpress.yml`.

## One-time setup

1. **Create the `ready` category** in the WordPress app
   (Post settings → Categories → Add).
2. **Enable GitHub Pages**: repo Settings → Pages → Source: **GitHub Actions**
   (not *Deploy from a branch* — that pins you to Jekyll 3.10).
3. **Allow the workflow to push**: repo Settings → Actions → General →
   Workflow permissions → *Read and write permissions*.
4. **Commit a lockfile**: run `bundle install` locally once and commit the
   generated `Gemfile.lock`. The build workflow fails without it.
5. **Run it once by hand**: Actions tab → *Sync from WordPress* → *Run workflow*.

## Writing

Write normally in the WordPress app. On the next run the script will:

- convert the post to Markdown
- download every image into `assets/img/posts/<slug>/` and rewrite the links
- write `_posts/YYYY-MM-DD-<slug>.md` with Jekyll front matter
- delete files whose WordPress post was unpublished or had `ready` removed

Files without a `wp_id:` line are treated as hand-written and never touched, so
you can still add posts directly to the repo.

## Running the sync locally

```bash
npm install
WP_SITE=imisfer.wordpress.com WP_CATEGORY_GATE=ready npm run sync
```

## Previewing the site locally

```bash
bundle install
bundle exec jekyll serve
```

## Two workflows

| Workflow | Trigger | Does |
|---|---|---|
| `sync-wordpress.yml` | hourly + manual | Pulls posts from WordPress, commits Markdown |
| `pages.yml` | push, after a sync, manual | Builds Jekyll 4.3 and deploys |

`pages.yml` also listens for `workflow_run` because commits made with
`GITHUB_TOKEN` cannot trigger another workflow — without that listener the site
would never rebuild after a sync.

## Things to know

- **Timing.** Scheduled Actions are queued, not precise. A post can take up to
  ~an hour to appear, sometimes longer when GitHub is busy.
- **Dormancy.** GitHub disables scheduled workflows on repos with no activity
  for 60 days. The sync commits count as activity, so this only bites if you
  stop posting entirely — re-enable it in the Actions tab.
- **Drafts stay invisible.** The public WordPress API only exposes published
  posts. Reading drafts would need an OAuth token in `WP_TOKEN`.
- **Editing.** Edit in WordPress, not in `_posts/` — the sync overwrites any
  file carrying a `wp_id`.
- **Arabic slugs** are kept as-is, so URLs percent-encode. They display
  correctly in browsers. Set an English slug in the WordPress app if you'd
  rather have clean ASCII URLs.
