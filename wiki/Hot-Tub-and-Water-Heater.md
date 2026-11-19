# Hot Tub and Water Heater

Stored heat: an outdoor hot tub (spa) or a hot water tank (boiler). The device heats the water
in the cheapest hours so that it is warm when you need it, and never lets it get too cold or too
hot. It learns how fast the water heats and cools.

The device says when heating is needed (**Heating demand**). Choose the heater's switch when you
pair it, and the device switches the heater itself. Or leave the switch out and let your flows
turn Heating demand into the heater's own actions, with whatever app runs it.

The two device types work the same way. They differ in what surrounds the water and in their
defaults:

| | Hot Tub | Water Heater |
|---|---|---|
| Surroundings | Outdoor temperature: a sensor, or the Home Controller's outdoor sensor | Room temperature: a sensor, or a fixed temperature from the settings |
| Keep (default) | None: between ready times the tub's own controller holds the water | 45 °C, enough hot water at any time |
| Target temperature | 38 °C, set by you | Read only: learned where the tank's own thermostat stops the heater |
| Maximum (default) | 40 °C | 75 °C |

## Before you add one

The [Home Controller](Home-Controller) must exist and follow a price device (see
[Prices](Prices)): the device plans on its prices. Without prices it heats just in time for each ready time,
without looking at prices (a Water Heater also holds Keep).

## Add it

Add device → Adaptive Home Comfort → **Hot Tub** or **Water Heater**, then choose:

- **Water temperature**: a temperature of another device. A separate sensor in the water is
  best: it reports all the time, also when the pump doesn't run, and in 0.1 °C steps or finer.
  A tub's own reading often comes in 0.5 °C steps, which makes learning slower and rougher. Or
  **From a flow**: your flow sets it with the **Set water temperature** card, for a temperature
  that comes from MQTT (the MQTT Client app) or another app without a device, for example a
  DS18B20 probe on an ESP32 board. Set it at least every few hours: a value older than 6 hours
  counts as no water temperature.
- **Top**, **Middle** and **Bottom temperature** (Water Heater, instead of one water
  temperature): a tank's sensors at up to three heights, each a temperature of another device,
  **From a flow** (the **Set tank temperature** card, with the height) or **None** when there is
  no sensor there. At least one is needed. The Water Heater plans and learns with their average,
  which follows the heat stored in the tank, and holds **Keep** on the top one (the hot water at
  the tap). The bottom one drops with every shower, as cold water comes in at the bottom; that is
  normal and doesn't start a reheat. Sensors on the tank wall under its insulation work well:
  they read close to the water, a little low and a little late.
- **Outdoor temperature** (Hot Tub) or **Room temperature** (Water Heater): another sensor, or
  none to use the Home Controller's outdoor sensor or the fixed temperature in the settings.
- **Power meter** (optional): the power of the heater, or of the whole tub. Recommended:
  learning then knows when the heater really heats, also when the heater's own thermostat
  switches it on and off. The device learns two power levels from it: **heating**, and the
  **base load** such as a circulation pump (for example 3.2 kW and 0.2 kW). A reading above
  halfway between them counts as heating. Standby below 50 W is left out.
- **Heater switch** (optional): a relay or plug that switches the heater, from any app. It
  follows **Heating demand**: on when heating is demanded, off when not. In mode **Off** it is
  left alone. A device with several switches (for example a meter with a relay add-on) also asks
  **Switch to use**; switches with the same name show their number, such as "Turned on (1)".
  Without a switch, let a flow switch the heater on **Heating demand started** and **stopped**.
  When something else switches it, the device switches it back to the demand while Homey runs. So
  a schedule in the relay itself (for example every night 02:45 for 3 hours, with an automatic
  switch-off) works as a fallback: it heats only when Homey is down. Stops the device makes itself
  aren't learned as the thermostat's.

The app reads only standard capabilities. If a reading is only available in a non-standard
form, a virtual device updated by a flow can pass it on. To change the choices later, use
**Repair** in the device settings.

## What it shows

- **Mode**: **Automatic**, the device decides when to heat. **Heat**, it holds the ready
  temperature all the time, whatever the price, like an ordinary thermostat. **Off**, it never
  demands heating and the heater runs on its own controls (a tub's own controller keeps its
  frost protection). Use Heat or Off when you run the heater by hand for a longer time.
- **Heating demand** (button): on while the heater should heat. In Automatic, turn
  it on by hand to heat to the target temperature now, whatever the price; then the device
  carries on by itself. Turn it off by hand to stop the heating going on now; the device starts
  again at its next planned start or latest safe start. Keep (Water Heater) and Maximum always win. In Heat or
  Off, turning it on or off switches the mode to Heat or Off.
- **Water temperature**, the outdoor or room temperature, and **Power** when a power meter is
  chosen.
- **Target temperature** (the dial): the temperature to reach for each ready time. The dial's text
  follows the mode (heating towards it in Automatic and Heat), not whether the heater heats now:
  that is the **Heating demand** button and the **State**.
- **Heating ready** (button): on while the water is held at the target temperature.
  Turn it off to end it now; turn it on to be ready now (held until you turn it off, at most
  as long as set in the settings).
- **State**: **Pre-heating** (heating ahead of a ready time in cheap hours), **Heating** (heating
  demand is on otherwise), **Ready** (at the target temperature for a ready time,
  not heating now), **Waiting** (nothing to heat yet), **Stopped** (no water temperature, or at
  Maximum) or **Off** (the mode is Off).
- **Expected start**: when heating starts next, for example `16:05` or `Sun 16:05`; `Now` while
  heating, `–` when nothing is planned. While learning it is the latest safe start, so it moves
  later as the device learns and as the water cools more slowly than feared.
- **Expected ready**: when the water is expected at the temperature it heats to, by the learned
  heating curve, for example `17:48`; `Now` when it is there.
- **Time remaining**: while heating, how long until then, for example `1 h 5 min`.
- **Reason**: why, for example `Starts 15:30 for 18:00`, `For 18:00, held until 20:00`,
  `Ready until 20:00` or, still heating after the ready time, `Heating to 37 °C until 20:00`.
  A Water Heater heats until its own thermostat stops it at the target temperature, and doesn't
  hold the water through the use: once at the target temperature it shows `Ready for 06:00`. Hot water used after that is heated again only below
  Keep, by a top-up cheaper than the night block, or by the next block.
- **Heater problem**: no water temperature, heating was demanded for 1.5 hours without the
  water getting warmer, or (with a power meter) heating was demanded for 10 minutes without the
  meter showing heating power. A flow on **Heater problem turned on** can resend the heater's own
  mode. While bathing only the 1.5-hour check counts: a tub may hold its heater off while the jets
  run. A heater that heated and then stopped by itself has reached its own set point (a tub's
  controller reads the water a little differently): that is not a problem until the water has
  fallen 1 °C below where it stopped.

## Settings

- **Keep** (Water Heater): a reheat level. When the tank falls below it, it is heated to its target
  temperature, whatever the price: until the tank's own thermostat stops the heater.
  With tank sensors, Keep is checked on the top temperature (the hot water at the tap). Heating
  to the target temperature also keeps the water hot enough while nobody uses it (see [Long absence](#long-absence)).
  The Hot Tub has no Keep: between ready times its own controller holds the water with its filter
  cycles and frost protection.
- **Maximum**: heating demand always stops here.
- **Ready time**: **Ready at** (the time of day you want the water ready, empty for none), **Ready
  ahead** (0–30 minutes: be ready this long before it, default 15), **Keep ready for**, the days
  of the week, **Hold before ready time** and **Ready by hand at most**. One-off ready times and
  skipped ones come from flows;
  the **Set ready time** card sets Ready at, Ready ahead and the days together.
- **Price limit** (Water Heater; a Hot Tub uses the home's **Expensive above** of the
  [Home Controller](Home-Controller) instead): skip a ready time when heating for it would cost more per kWh on average. 0 = always
  heat. While the device is still learning, this is the mean price from the latest start to the
  ready time, decided before the heating starts. A Water Heater's ready time is also skipped when the price during
  it (the mean from Ready at to its end, once known) is over the limit, however cheap heating
  ahead would be. A Hot Tub's ready time is skipped when its main heating, from the latest start to the
  ready time, would cost over Expensive above on average, not for its own price. Heating many hours earlier in
  cheap hours would mostly cool away, so a skip also stops such early heating. A Water Heater still holds Keep.
- **Heater power**: the power while heating, used until a power meter has shown it. A Water Heater also
  starts planning from it (a 300-litre, well insulated tank) until its heating and cooling are learned.
- **Learned heating curve** (read only): how fast the water heats, how fast it loses heat to the
  surroundings, the mixing drop (below), and the learned power levels. A Water Heater with a power
  meter also learns its **Target temperature**: where its own thermostat stops the heater while heating is
  demanded, or (a heater on its own timer) more than 10 minutes before **Longest block**. It is shown as the Water Heater's (read only) target temperature, 2 °C lower in whole degrees (so a tank that has cooled a little doesn't look short of it), and exactly in the settings. Until it is
  seen, the Water Heater plans with (and shows) 60 °C, at most Maximum; the first stop of the
  thermostat above **Keep** teaches the real one. Ready times and reheats then heat to it, and the tank counts as at its target temperature while it
  has only cooled as standing water does (its thermostat won't heat for that), for up to 36 hours, until the next
  daily heating. Hot water used (a shower, a bath) drops it further, and then ready times heat it again.

## Night heat-up (Water Heater)

The main heating of a hot water tank is one heat-up in the night before the morning ready time. Set
**Plan from** in the device settings (e.g. 22:00, after the evening's showers) to use it:

- As soon as the prices for the night are published (usually in the afternoon), the Water Heater
  plans one block: the cheapest **Longest block** (e.g. 180 minutes, enough for a cold tank) between
  Plan from and the ready time (minus **Ready ahead**). The tank's thermostat ends it early when
  the tank is at its target temperature.
- **Heating planned** runs then, once per ready time, with the block: **Expected start** and
  **End** (HH:mm), **Minutes**, **Ready time**, **Price** (average per kWh) and the reason.
- A typical flow: **Heating planned** → write Start and Minutes into the heater's own daily
  schedule (for example a relay that switches on at a set time and off again after a while). The
  tank then heats in the night also when Homey is down.
- Outside the block the Water Heater only tops up: when the hour is cheaper than the block and the
  tank is short of its target temperature (after hot water was used), and whenever the top falls
  below **Keep**, up to the home's price ceiling (below).
- With a **Heater switch**, the device switches the heater itself, also in the block. When the
  heater's own schedule turns the switch on while no heating is needed (the tank is already at
  its target temperature), the device switches it back off.

Leave **Plan from** empty to heat on the price plan alone: in the cheapest hours before each ready
time, without a fixed night block.

## Long absence

During the Home Controller's **Long absence** the weekly ready times are skipped, and nothing is
heated for them. One-off ready times (**Ready at a time**, **Heating ready** turned on) still count.
The reason shows it, for example `Away until 22 Nov`. The Hot Tub's own
controller holds its rest temperature (lower it in your flow on **Long absence changed** if you
want it colder while away); a Water Heater holds only **Keep**. See [Leave for days](How-to#leave-for-days).

A heater on its own schedule (a night block written into the heater, see **Heating planned**) keeps
repeating its last schedule while you're away, because no new block is planned. Turn that schedule off
in your flow on **Long absence changed**, and back on when the absence ends. While away, write the night
block into the heater only when no long absence is on, and let the **Heater switch** heat.

**Hygiene heat-up while away**: water standing lukewarm in an unused tank is where legionella grow; they
die off above 60 °C. Holding Keep alone can leave the bottom of the tank lukewarm for days, so heat the
tank to its target temperature (its thermostat set to at least 60 °C) about once a week with a flow, for
example: **The time is 15:00** (tomorrow's prices are known) → **Today is Sunday** → **Long absence is
on** → **Ready at 06:00**. The one-off ready time plans the night's cheapest block as usual.

## How it decides

1. **Safety first**: at Maximum it stops. Over the home's price ceiling (Home Controller:
   **Expensive above**) it doesn't heat at all, not even for Keep, except in a Water Heater's night
   block; **Heating held by the price ceiling** runs when the water falls below Keep meanwhile.
   Otherwise a Water Heater below Keep heats.
2. **From the ready time** it holds the target temperature for **Keep ready for**. Ready reached
   within **Hold before ready time** of it is held too, so the water doesn't cool again before
   you need it.
3. **Before a ready time** it picks the cheapest quarters, counting the heat lost while waiting. Until
   it has learned the heating curve (about a day or two of heating and waiting), it heats only
   just in time instead of ahead. A Hot Tub pre-heats (heats before its latest start) only on the
   day of the ready time, and only once the main heating for it is allowed: its prices are known
   and not over **Expensive above**. Heat made a day ahead would mostly cool away. Pre-heating is
   silent: **Heating started for a ready time** runs when the main heating starts.
4. **Latest safe start**: when waiting longer would miss the ready time, it heats now, whatever
   the price. This covers a wrong model and late prices. It counts the water cooling until the
   start and aims to be ready **Ready ahead** minutes early. While little is learned it assumes a slower
   heater (80 %) and faster heat loss while heating (125 %) than learned; this margin shrinks as
   heating and waiting are seen, and after about 6 hours of heating and 24 hours of waiting it
   times by the learned curve.

In standing water the warm water rises, so a sensor near the surface reads high until the
circulation mixes the water. The device plans still water with the reading minus this **mixing
drop**. The first 15 minutes of each heating are left out of learning while the water mixes.

With a **power meter** the device tells three states apart: **still** (standby), **circulating**
(the base load, such as a filter pump) and **heating**. It learns the heat loss over each still
stretch, from the last reading before the pump stops to the mixed reading 15 minutes after it
starts again (less what the heater added meanwhile), so the high readings of still water don't
count. The reading just before the pump starts gives the mixing drop. A pump that stops again
within those 15 minutes ends the stretch without learning. Bathing ends a stretch too; the water
it stirred starts the next one. Without a power meter it can't see
the pump: it learns the mixing drop when heating starts after the water stood still, and the
heat loss from the readings while it waits.

A Water Heater with a power meter also watches for **hot water draws**: when the tank's
temperature falls 0.5 °C or more within 15 minutes, water was drawn, not lost through the
insulation. The stretch then ends at the reading before the draw, and a new one starts once the
temperature has settled, so showers don't make the tank look poorly insulated.

Bathing is left out of learning too, from the ready time until 30 minutes after **Keep ready
for** ends: with the lid open, the jets on and people in the water, the heat loss and heating say nothing about
the closed tub. When you finish early, turn **Heating ready** off: the ready time ends, and learning starts again 30
minutes later.

## Filter cycles (Hot Tub)

Many hot tubs run one or two filter cycles a day from their own schedule, and heat during them.
The Hot Tub can plan these cycles in the cheapest hours: choose **1 filter cycle** or **2 filter
cycles** when you add it (or in **Repair**), then set each cycle in the device settings:

- **Window from** and **to**: the cycle runs somewhere in between, within one day, for example
  00:00–06:00 for a night cycle and 12:00–18:00 for a day cycle.
- **Length**: the same length as on the tub's own filter cycle card.
- **Price limit** (cycle 2 only): on a day when the cycle's cheapest time costs more per kWh on
  average, it doesn't run. 0 = always runs. Cycle 1 always runs, in the cheapest time of its window:
  a tub needs one filter cycle a day, and many can't turn their first cycle off.

Once the next day's prices are known and the current day's cycles are over, the device picks
the cheapest time in each window and runs **Filter cycles planned**. Tokens: **Cycle 1 start**
and **Cycle 2 start** (HH:mm), **Cycle 2 runs** (yes/no), **Cycle 1 runs** (always yes, kept for
older flows), and a **Summary**
such as `Sun: 02:00–04:00, 14:00–15:00`. The tub repeats its schedule daily, so the new times are
sent only after the day's last cycle is over; until the prices come, the tub keeps the times it
has. **Planned** in the settings shows the last plan.

A typical flow: **Filter cycles planned** → set the tub's filter cycle 1 to **Cycle 1 start**;
then **Cycle 2 runs** is yes? → turn cycle 2 on and set it to **Cycle 2 start**, else turn cycle 2
off (with the tub app's own on/off for the cycle; on some tubs that isn't the same as a length of 0).
Add a notification with the **Summary** if you like.

The heating plan counts the heat the tub adds in its filter cycles: during each planned cycle
(and the same times on the following days, as the tub repeats them) the water warms up to
**Filter heats to**, shown in the settings. With a power meter the device learns it where the
tub's own heater stops inside a filter window while the pump runs on and the device isn't
demanding heat. A planned cycle that runs without the heater heating lowers it to the water
temperature at once, for example when your flow sets the tub lower between ready times. Until it has
been seen, filter cycles count as adding no heat. The latest safe start counts the cycles too,
so on a day with a filter cycle before the ready time, heating starts later or not at all.

## Flows

- Triggers **Heating demand started** and **Heating demand stopped**, with the **Target
  temperature** and the **Reason** as tokens.
- Trigger **Filter cycles planned** (Hot Tub), see [Filter cycles](#filter-cycles-hot-tub).
- Triggers **Heating planned** (once per ready time, when the start of heating for it is known, at most a
  day ahead; the plan may still change with prices; a Hot Tub tells the start of its main heating, after any
  pre-heating in cheap hours before it) and **Heating started for a ready time** (once per
  ready time, when the main heating for it starts, also after **Heating ready** was turned on by hand;
  not for pre-heating in cheap hours, nor when it heats again after the water was ready). Use
  **Heating started for a ready time**, not **Heating demand started**, for messages and indicator
  lights, so pre-heating stays silent. Tokens: the **Ready time**, **Expected
  start**, **Expected ready**, **Target temperature** and **Reason**. Good for a daily confirmation.
- Trigger **Ready reached**, once per ready time when the water first reaches the target temperature,
  with the **Ready time**, **Ready until**, **Water temperature** and **Target temperature**. Good for
  a "the tub is ready" message: it doesn't repeat when the water dips and is reheated during use.
- Triggers **Heating ready turned on** and **Heating ready turned off**: a ready time started or ended
  (or it was turned on or off by hand).
- Trigger **Ready time skipped**, once when the price limit skips a ready time, with the **Ready
  time**, the **Price** (average per kWh of the heating it would need, or of the ready time itself)
  and the **Price limit**.
- Trigger **State changed**, with the state as a token (`preheating`, `heating`, `ready`, `waiting`,
  `stopped` or `off`).
- Conditions **Heating ready is on** and **State is**.
- Actions **Ready at a time** (a one-off ready time, the next time it is that time of day), **Set ready
  time** (Ready at, Ready ahead and the days of the week, for example from a calendar), **Skip the next ready time**, **Turn heating ready on or off** and **Set water temperature** (when the water
  temperature comes from a flow).
- Homey's own cards for Heating demand (turned on or off, is on, turn on or off, as by hand), the mode
  (changed, is, set) and the target temperature.

A typical pair of flows for a hot tub:

- **Heating demand started** → set the tub's heater mode to Ready, then set its target
  temperature to the **Target temperature** token.
- **Heating demand stopped** → set the tub's heater mode to Rest, and its target temperature to
  what you want between ready times, for example 30 °C. Its filter cycles then hold that, instead
  of trying to reach the ready temperature on days without a ready time.

The tub's own thermostat measures in a different place than your sensor. If it stops a little
early or late, add an offset to the token in the flow.

To try it before it takes over, first connect the triggers only to notifications and compare
them with what your current flows do.
