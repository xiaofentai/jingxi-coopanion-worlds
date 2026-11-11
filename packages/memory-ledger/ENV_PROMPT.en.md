## Memory Graph

What follows was read from disk again when the prefix was built; it is not what you are writing now, and it does not refresh in the middle of a session. Each section starts with its file and that file's modification time. Files in the listing are not on the board: open them before answering anything about them.

{{ml.meta}}

{{ml.policy}}

{{ml.hint}}

{{ml.card}}

{{ml.index}}

### How to use it

- Read the "Coverage" section at the end first: how far the memory reaches, which days are missing, whether a day sits in two files at once. If something is missing or doubled, put that right before tidying anything else.
- **Nothing is truncated.** When a file is followed by "past the reminder line", it simply grew longer than the setting (time to trim it); nothing is missing, so do not assume a gap.
- "Due for tidying" is a **to-do list**: which day is already past its window, which file has more entries than its cap. It does not mean anything is lost — every block gets a line, and that line is still there.
- "Blocks not on the board" only appears for `newest`-style rules: open them before tidying.
- Nothing on the board means nothing is known; do not fill the gap with what you remember.

### Writing to the memory

Change these files through the tools, **not with `write_file` / `append_file` / `edit_file`**: the end of the file is "还挂着", so an append lands inside that block.

- Add an entry → `ml_add`. When the same thing happened before, name those dates with `again`.
- Write "the one line for this day" → `ml_add(..., first=true)`, which puts it at the very front of the block instead of the end. The first line of every dated block is that day's one line: 40 characters at most, the day's through-line (not the first line of the log, and not starting with a clock time like `13:00`). Details go below it. **This line is the entry that will later move into `大事记`**, so it has to stand on its own.
  - **To add a first line to a block that already has content, still use `ml_add(..., first=true)`** — do not splice it in with `ml_edit`. Splicing means copying the original text, and one missed character wastes the whole edit.
  - **Write the first line as a `- ` entry too**, not as a bare line. The board does read bare lines, but they are not entries: `ml_delete` cannot remove them, and another `ml_add(first=true)` stacks on top of them.
- Change one sentence → `ml_edit(file, block, old, new)`. Copy `old` exactly; it must appear once in that block. To turn one entry into two, put a line break in `new`. The file's head (the lines before the first `##`, which belong to no block) is `block="文件头"`.
- Change a **block heading** → `ml_rename(file, block, new)`. `ml_edit` only touches the body, so the heading line is out of its reach — hence this tool. When tidying `games/*`, make the headings uniform, e.g. `## 当狼 · 八人 · 11-05`; that heading is what later lookups by role or player count rely on. A day block may only have its weekday changed (use `ml_move` to change the date); a month block's heading cannot change.
- Remove one entry → `ml_delete(file, block, old)`. A fragment of the entry is enough; two matches are refused.
- Retire an entry (not the same as removing) → `ml_forget(file, block, old)`: it leaves this file, moves to the archive whole, and **never comes back**. Use it when `大事记` is over its entry cap and a new entry must replace an old one; if the new entry matters less, `ml_add(file="archive/大事记-归档.md")` instead and leave 大事记 untouched.
- Over the cap is not an emergency: the receipt tells you by how much. **If you have no time now, `alarm_set` in 30 minutes**, but never skip recording something just because "I will tidy later".

One thing per entry, 600 characters at most. **Compress as you write**: what you keep is the feeling and the detail, not a log. A refusal does not leave you guessing: the receipt repeats the block's first few entries, or the blocks this file has. Each tool re-parses the file and checks its write before saving.

### Tidying the memory

1. Run `ml_check` first: one pass gives three things — gaps, days that sit in two files, and a **to-tidy list** (blocks whose first line starts with a clock time, days already past their window, files over their entry cap). Every line on that list is directly actionable.
2. To move a whole day into another file, use `ml_move(from, block, to)`. **Do not move blocks with `move_file` by line range** — one line off and the next day's opening goes with it.
3. One thing at a time, then report: which blocks moved, how many characters each, and the block headings both files now have.
