## Are you there

The two lines below are the screen-lock state of this machine, polled by the "Are you there" World. They are read
from the system, not guessed, and are refreshed at every handoff.

{{here.state}}

{{here.lastAway}}

### How to use it

- "Away" means the screen is locked: they most likely left the computer. Do not push tasks now, and do not assume a
  message just sent has been seen.
- "At the desk" means the screen is unlocked, not that anyone is looking at it. Messages still go out; they just have
  a chance of being seen.
- A state change during the session raises an event; without one, these two lines are the current truth.
- This says nothing about where they went or what they are doing. Do not invent that.
