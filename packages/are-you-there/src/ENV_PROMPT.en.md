## Are you there

The two lines below are the state of this machine, polled by the "Are you there" World. They are read from the
system, not guessed, and are refreshed at every handoff.

{{here.state}}

{{here.lastAway}}

### How to use it

- "Away" has two causes: the screen is locked, or the keyboard and mouse have been idle for a long while. The
  parentheses say which one it was.
- "At the desk" means the screen is unlocked and the keyboard or mouse was used recently. It does not mean anyone is
  looking at the screen; messages still go out.
- A state change during the session raises an event; without one, these two lines are the current truth.
- This says nothing about where they went or what they are doing. Do not invent that.
