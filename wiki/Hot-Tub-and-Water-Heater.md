# Hot Tub and Water Heater

Stored heat: an outdoor hot tub (spa) or a hot water tank (boiler). The device heats the water
in the cheapest hours so that it is warm when you need it, and never lets it get too cold or too
hot. It learns how fast the water heats and cools.

The device doesn't switch the heater itself. It says when heating is needed (**Heating
demand**), and your flows turn that into the heater's own actions, with whatever app runs it.

The two device types work the same way. They differ in what surrounds the water and in their
defaults:

| | Hot Tub | Water Heater |
|---|---|---|
| Surroundings | Outdoor temperature: a sensor, or the HVAC Controller's outdoor sensor | Room temperature: a sensor, or a fixed temperature from the settings |
| Keep (default) | 30 °C, frost protection | 45 °C, enough hot water at any time |
| Ready / Maximum (default) | 38 / 40 °C | 73 / 75 °C |

## Before you add one

The [HVAC Controller](HVAC-Controller) must exist and follow a price device (see
[Prices](Prices)): the device plans on its prices. Without prices it still holds Keep and heats
just in time for each use, without looking at prices.

## Add it

Add device → Smart HVAC Control → **Hot Tub** or **Water Heater**, then choose:

- **Water temperature**: a temperature of another device. A separate sensor in the water is
  best: it reports all the time, also when the pump doesn't run, and in 0.1 °C steps or finer.
  A tub's own reading often comes in 0.5 °C steps, which makes learning slower and rougher. Or
  **From a flow**: your flow sets it with the **Set water temperature** card, for a temperature
  that comes from MQTT (the MQTT Client app) or another app without a device, for example a
  DS18B20 probe on an ESP32 board. Set it at least every few hours: a value older than 6 hours
  counts as no water temperature.
- **Outdoor temperature** (Hot Tub) or **Room temperature** (Water Heater): another sensor, or
  none to use the HVAC Controller's outdoor sensor or the fixed temperature in the settings.
- **Power meter** (optional): the power of the heater, or of the whole tub. Recommended:
  learning then knows when the heater really heats, also when the heater's own thermostat
  switches it on and off. The device learns two power levels from it: **heating**, and the
  **base load** such as a circulation pump (for example 3.2 kW and 0.2 kW). A reading above
  halfway between them counts as heating. Standby below 50 W is left out.

The app reads only standard capabilities. If a reading is only available in a non-standard
form, a virtual device updated by a flow can pass it on. To change the choices later, use
**Repair** in the device settings.

## What it shows

- **Control** (on/off): on, the device plans and demands heating. Off, it demands nothing, not
  even Keep, and the heater is left to its own controls. Turn it off when you run the heater by
  hand, or **Heater problem** turns on after 1.5 hours of demand without heating.
- **Water temperature**, the outdoor or room temperature, and **Power** when a power meter is
  chosen.
- **Ready temperature** (the dial): the temperature to reach for each use.
- **Heating demand**: on while the heater should heat.
- **Heating ready** (button): on while the water is held at the ready temperature for a use.
  Turn it off to end the use now; turn it on to be ready now (held until you turn it off, at most
  as long as set in the settings).
- **State**: **Heating** (heating demand is on), **Ready** (at the ready temperature for a use,
  not heating now), **Waiting** (nothing to heat yet), **Stopped** (no water temperature, or at
  Maximum) or **Off** (the control is off).
- **Reason**: why, for example `Starts 15:30 for 18:00`, `For 18:00, held until 20:00` or
  `In use until 20:00`.
- **Heater problem**: no water temperature, or heating was demanded for 1.5 hours without the
  water getting warmer.

## Settings

- **Keep**: never below, whatever the price. **Maximum**: heating demand always stops here.
- **Use**: **Ready at** (a time of day, empty for none), **Use lasts**, the days of the week,
  **Hold before use** and **Ready by hand at most**. One-off uses and skipped ones come from flows.
- **Price limit**: skip a use when heating for it would cost more per kWh. 0 = always heat.
  Keep is held anyway.
- **Heater power**: the power while heating, used until a power meter has shown it.
- **Learned heating curve** (read only): how fast the water heats, how fast it loses heat to the
  surroundings, the mixing drop (below), and the learned power levels.

## How it decides

1. **Safety first**: below Keep it heats, at Maximum it stops.
2. **During a use** it holds the ready temperature until the use ends. Ready reached within
   **Hold before use** of the start is held too, so the water doesn't cool again before you use
   it.
3. **Before a use** it picks the cheapest quarters, counting the heat lost while waiting. Until
   it has learned the heating curve (about a day or two of heating and waiting), it heats only
   just in time instead of ahead.
4. **Latest safe start**: when waiting longer would miss the ready time, it heats now, whatever
   the price. This covers a wrong model and late prices. It counts the water cooling until the
   start and aims to be ready 15 minutes early. While little is learned it also assumes a slower
   heater (80 %) and faster heat loss (125 %) than learned; this margin shrinks as heating and
   waiting are seen, and after about 10 hours of heating and 48 hours of waiting it times by
   the learned curve.

In standing water the warm water rises, so a sensor near the surface reads high until the
circulation mixes the water. The device learns this **mixing drop** each time heating starts
after the water stood still, and plans still water with the reading minus the drop. The first
15 minutes of each heating are left out of learning while the water mixes.

Uses are left out of learning too, from the start of a use until 30 minutes after it ends: with
the lid open, the jets on and people in the water, the heat loss and heating say nothing about
the closed tub.

## Flows

- Triggers **Heating demand started** and **Heating demand stopped**, with the **Ready
  temperature** and the **Reason** as tokens.
- Trigger **State changed**, with the state as a token (`heating`, `ready`, `waiting`,
  `stopped` or `off`).
- Conditions **Heating demand is active**, **Heating ready is on** and **State is**.
- Actions **Ready at a time** (a one-off use, the next time it is that time of day), **Skip the
  next use**, **Turn heating ready on or off** and **Set water temperature** (when the water
  temperature comes from a flow).
- Homey's own cards for the control (turn on or off) and the ready temperature.

A typical pair of flows for a hot tub:

- **Heating demand started** → set the tub's heater mode to Ready, then set its target
  temperature to the **Ready temperature** token.
- **Heating demand stopped** → set the tub's heater mode to Rest.

The tub's own thermostat measures in a different place than your sensor. If it stops a little
early or late, add an offset to the token in the flow.

To try it before it takes over, first connect the triggers only to notifications and compare
them with what your current flows do.
