# ffstore-item: adding items to the mementos site

For an assistant managing catalog items from the repo:
`~/projects/family-and-friends-store/scripts/ffstore-item`.

It writes the local dev copy unless the first argument is `--live`. Try a
command locally first, then repeat it with `--live` for the real site.

## Commands

    ffstore-item [--live] topics
    ffstore-item [--live] add --topic <slug> --title "<title>" [--description "<text>"] [--price <dollars>] --photo <path> [--photo <path> ...]
    ffstore-item [--live] list [--topic <slug>]
    ffstore-item [--live] show <id>
    ffstore-item [--live] photo-add <id> <path>
    ffstore-item [--live] edit <id> [--title "<title>"] [--description "<text>"] [--price <dollars or "">]

- `topics` prints `slug<TAB>name`. Use the slug with `--topic`.
- `add` prints `Added item N with K photos.` Keep the number, because
  `show`, `edit` and `photo-add` use it.
- `list` prints `id  topic  status  price  photos  title`.
- `edit` changes only the fields you give. `--price ""` clears the price. It
  can't change the topic.
- There's no delete. To remove an item, an admin does it on the admin page.
- On an error it prints one line and exits with status 1. Nothing is written
  in that case.

## Rules

- **Prices go only in `--price`.** Family never sees prices, but they do see
  the title and description. A description with `$`, "dollars", "price",
  "asking" or "obo" is refused. Write prices as plain dollars, like `40` or
  `12.50`. Leave `--price` off if the owner gave no price.
- **The topic must already exist.** Run `topics` first. Pick the one that
  fits, and ask the owner if none does. Don't make up a slug.
  - A friend only sees the topics they've been granted (set in Merit), so the
    topic decides who can see an item.
- **Every new item needs at least one photo.** Photos must really be JPEG,
  PNG, WebP or HEIC (iPhone) files; the tool checks the bytes, not the
  file name. Each one is shrunk to 1600 px JPEG the same way the admin page
  does.
- **Where photos usually are:** `~/Downloads`. AirDrop from an iPhone also
  lands there. Find the newest ones with `ls -t ~/Downloads | head`. Quote
  paths that have spaces in them.
- Titles are 1 to 200 characters. Descriptions are up to 5000 characters.
- New items go out in the next morning's new-items email to family. It runs
  at 8 AM Central and covers items added the day before. Nothing more is
  needed.

## Example

    ffstore-item --live topics
    ffstore-item --live add --topic aviation --title "Cessna 172 yoke" \
      --description "From the Cessna 172 training years." \
      --price 75 --photo ~/Downloads/IMG_4410.HEIC --photo ~/Downloads/IMG_4411.HEIC
    ffstore-item --live show 42
