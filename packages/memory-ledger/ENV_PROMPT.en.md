## Memory Graph

What follows was read from disk again when the prefix was built; it is not what you are writing now, and it does not refresh in the middle of a session. card loads 常驻 / preferences / 记忆 whole; this world only gives the index of three streams and does not duplicate those files.

{{ml.health}}

{{ml.meta}}

{{ml.policy}}

{{ml.layers}}

{{ml.hint}}

{{ml.card}}

### How to use it

- The top line — "Memory: N files | covers … to … | today …" — is the **heartbeat**. A dropped file count, or a coverage date frozen at yesterday, means a file is not being read or the world is not running. Investigate that before assuming "nothing much happened lately".
- Read the "Coverage" section at the end first: how far the memory reaches, which days are missing, whether a day sits in two files at once. If something is missing or doubled, put that right before tidying anything else.
- **One line per block, no day dropped.** "Past the reminder line" means the entries grew (time to trim them), not that a day was removed.
- "Due for tidying" is a **to-do list**: which day is already past its window, which file has more entries than its cap. It does not mean anything is lost — the line is still there.
- 常驻 / preferences / 记忆 are loaded whole by card and are not repeated here; read card's text when you need them.
- A day missing from the index does not mean it never happened; use `ml_recall` by date instead of filling the gap from memory.

### Writing to the memory

Change these files through the tools, **not with `write_file` / `append_file` / `edit_file`**: both files usually end with a **special block** (currently "还挂着" — the name is yours to change), so an append lands inside that block.

- Add an entry → `ml_add`. When the same thing happened before, put those dates straight into the text — the date channel picks them up, no wrapper needed.
- Write "the one line for this day" → `ml_add(..., first=true)`, which puts it at the very front of the block instead of the end. **In `超近期` / `近期`, the first line of every dated block is that day's one line — it is the line in the index, the key you look things up by**: 50 characters at most, the day's through-line (not the first line of the log, and not starting with a clock time like `13:00`).
  - **To add a first line to a block that already has content, still use `ml_add(..., first=true)`** — do not splice it in with `ml_edit`. Splicing means copying the original text, and one missed character wastes the whole edit.
  - **Write the first line as a `- ` entry too**, not as a bare line. The board does read bare lines, but they are not entries: `ml_delete` cannot remove them, and another `ml_add(first=true)` stacks on top of them.
- **The body is not a log.** One entry carries one judgement, one feeling, or one exception: **no clock times, no process**. "What happened at what minute" does not get written down — two days later nobody rereads the process, only what the day held and what it left behind. Three to six entries a day is the usual size; before writing a second entry about the same thing, see whether it can be folded into the first.
- **A game gets one line of result.** Finish with "12-player game, good side won, I was villager #10" and stop; round detail (who went out on D1, the tally) does not go into the log. **Lessons go into `games/*` under that role's block; never both places** — a battle report in the log is wasted work.
- **One entry in `games/*` carries one judgement.** The shape is **a judgement + at most one example + one action you can take next time**; the example carries no seat numbers, game ids or tallies — those belong to that one game and cannot be looked up later. Before writing, ask yourself: **would this still point the way in another game, with another player count?** If not, skip it. Any judgement that depends on the exact rules (how many cards, whether there is a witch or guard) starts with "check the setup before you speak".
- **A block heading carries the role and nothing else.** `## 当狼`, `## 当女巫`, `## 当民` — dates, player counts and game ids go into the entries, never into the heading. **One role, one block**: if there are several, merge them with `ml_merge(into="当女巫")` and keep the heading down to the role. Routing picks blocks by role, and the heading is its only handle; a heading with a tail breaks as soon as a second block appears.
- **When you start a file for a new game, put three things in the header.** That is how routing knows which game this is and which block is your role:

  ```
  family: werewolf
  wolf: 当狼
  witch: 当女巫
  ```

  `family` is the game's name in 星邮; each line below maps an English role to a Chinese block name. **Without it nothing is routed** — no error, just no notes handed to you when a round starts. Adding a new game means editing this file, never the plugin.
- **`大事记` is not written per day.** It holds only what you judge worth keeping for a long time: firsts, turning points, promises, lessons. When one comes to mind, `ml_add(file="大事记.md", text="**2026-11-12**：…")` — **no `block`, the date lives in the entry, year included**. If nothing comes to mind, skip it: there is no quota and nobody chases you. **The division is: the other two files are the log; this is the handful that stays.**
  - **Write no `## month` heading.** The file is one list: one event per line, each carrying its own date; its handle is the file name. A month heading is never shown on the card and never matched, and it forces the year to be *inferred* — two years in, nobody can tell 11-12 of this year from the last. Month headings already in the file can stay; just keep adding underneath.
- Change one sentence → `ml_edit(file, block, old, new)`. Copy `old` exactly; it must appear once in that block. To turn one entry into two, put a line break in `new`. The file's head (the lines before the first `##`, which belong to no block) is `block="文件头"`.
- Change a **block heading** → `ml_block(action="rename", block=…, new=…)`. `ml_edit` only touches the body, so the heading line is out of its reach. A day block may only have its weekday changed (use `ml_move` to change the date); a month block's heading cannot change.
- **Merge several blocks into one** → `ml_merge(file, into="当狼", blocks="block one|block two")` (separate names with `|`; an array works too). This is how `games/*` gets tidied: the same role across different games becomes one block, the heading carries the role only (`## 当狼`), and the date and player count move into the entries — that heading is what role lookups rely on later. No entry is lost (the receipt counts them); to drop duplicate lessons, use `ml_delete` yourself afterwards.
- Remove one entry → `ml_delete(file, block, old)`. A fragment of the entry is enough; two matches are refused.
- Retire an entry (not the same as removing) → `ml_delete(file, block, old, keep=true)`: it is **archived whole first, then removed**; the archive never enters the prefix and it **never comes back**. Use it when `大事记` is over its entry cap and a new entry must replace an old one; if the new entry matters less, `ml_add(file="archive/大事记-归档.md")` instead and leave 大事记 untouched.
- Over the cap is not an emergency: the receipt tells you by how much. **If you have no time now, `alarm_set` in 30 minutes**, but never skip recording something just because "I will tidy later".

One thing per entry, 600 characters at most. **Compress as you write**: what you keep is the judgement and the feeling, not the process and the clock times. A refusal does not leave you guessing: the receipt repeats the block's first few entries, or the blocks this file has. Each tool re-parses the file and checks its write before saving.

### Tidying the memory

1. Run `ml_check` first: one pass gives three things — gaps, days that sit in two files, and a **to-tidy list** (blocks whose first line starts with a clock time, days already past their window, files over their entry cap). Every line on that list is directly actionable.
2. **A day past its window in the today file gets distilled one layer back**: read that day once, drop the clock times, merge the repeats, keep the feeling, and write five or six entries; then make one call — `ml_move(from="超近期.md", block="11-11", text="the distilled entries")`. **Without `to` it goes to the "one layer back" file** (see the three-layers line above). With `text`, the body is replaced as it moves, and the original is not kept — it only ever existed for you to look things up. The receipt reports the compression ratio; still above 30% means you only removed the clock times.
   - **Do not move blocks with `move_file` by line range** — one line off and the next day's opening goes with it.
3. **A day past its window one layer back moves whole into the flow archive**: `ml_move(from="近期.md", block="11-03")`, with no `text` and **no `to` needed** — the tool files it by that source file's own archive setting (recent goes monthly into `archive/近期-YYYY-MM.md`, resolved by that day's date across month boundaries). The archive folder is fixed to `archive/`; `to` is only required for a file with no archive configured.
   - Once moved, that day leaves the index. **What survives is only what you wrote into `大事记`.** So take one second before moving: does this day hold anything worth keeping for a long time?
4. **Ask yourself once**: is there anything today you want in `大事记`? If so, `ml_add(file="大事记.md", text="**2026-11-19**：…")`; if not, skip it — nobody is counting.
5. One thing at a time, then report: which blocks moved, how many characters each, and the block headings both files now have.
