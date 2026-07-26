# Changesets

Add one changeset for every user-visible change to the published `tokenless` CLI.

Run `npm run changeset` and select `tokenless`. The release workflow creates a
version pull request only when an unpublished changeset is present. Merging that
pull request publishes the single pure JavaScript `tokenless` package.
