## Memory board

What follows was read from disk again when the prefix was built; it is not what you are writing now, and it does not refresh in the middle of a session. Each section starts with its file and that file's modification time. Files in the listing are not on the board: open them before answering anything about them.

{{ml.meta}}

{{ml.card}}

{{ml.index}}

### How to use it

- Read the "Coverage" section at the end first: how far the memory reaches, which days are missing, whether a day sits in two files at once. If something is missing or doubled, put that right before tidying anything else.
- A section marked "Truncated" is missing part of the file: read the file with `read_file` rather than filling in from memory.
- "Blocks not on the board" lists what the character limits kept out: open them before tidying. The board was built at the handoff and may be hours old.
- Nothing on the board means nothing is known; do not fill the gap with what you remember.

### Writing to the memory

Change these files through the tools, **not with `write_file` / `append_file` / `edit_file`**: the end of the file is "还挂着", so an append lands inside that block.

- Add an entry → `ml_add`. When the same thing happened before, name those dates with `again`.
- Write "the one line for this day" → `ml_add(..., first=true)`, which puts it at the very front of the block instead of the end. The first line of every dated block is that day's one line: 30 characters at most, the day's through-line (not the first line of the log, and not starting with a clock time like `13:00`). Details go below it.
- Change one sentence → `ml_edit(file, block, old, new)`. Copy `old` exactly; it must appear once in that block. To turn one entry into two, put a line break in `new`. The file's head (the lines before the first `##`, which belong to no block) is `block="文件头"`.
- Remove one entry → `ml_delete(file, block, old)`. A fragment of the entry is enough; two matches are refused.
- Retire an entry (not the same as removing) → `ml_forget(file, block, old)`: it leaves this file, moves to the archive whole, and **never comes back**. Use it when `大事记` is full and a new entry must replace an old one; if the new entry matters less, `ml_add(file="archive/大事记-归档.md")` instead and leave 大事记 untouched.

One thing per entry, 600 characters at most. A refusal does not leave you guessing: the receipt repeats the block's first few entries, or the blocks this file has. Each tool re-parses the file and checks its write before saving.

### Tidying the memory

1. Run `ml_check` first: gaps, and days that sit in two files.
2. To move a whole day into another file, use `ml_move(from, block, to)`. **Do not move blocks with `move_file` by line range** — one line off and the next day's opening goes with it.
3. One thing at a time, then report: which blocks moved, how many characters each, and the block headings both files now have.
