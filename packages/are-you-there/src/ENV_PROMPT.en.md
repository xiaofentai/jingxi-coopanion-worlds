## Are you there

The two lines below are the state of this machine, polled by the "Are you there" World. They are read from the
system, not guessed, and are refreshed at every handoff.

{{here.state}}

{{here.lastAway}}

### How to use it

- "Away" has three causes: the screen is locked, the mmWave radar sees nobody at the desk, or the keyboard and mouse
  have been idle for a long while. The parentheses say which one it was.
- "At the desk" means the screen is unlocked and the radar sees someone (or, with no radar installed, the keyboard or
  mouse was used recently). It does not mean anyone is looking at the screen; messages still go out.
- A distance in centimetres after "radar" is what the sensor measures, not how far the person is from the monitor.
- "radar not connected" means the hardware dropped off; only the lock and the keyboard are in play then.
- A state change during the session raises an event; without one, these two lines are the current truth. Someone
  merely walking past the desk raises its own event, which does not mean they are back.
- This says nothing about where they went or what they are doing. Do not invent that.
