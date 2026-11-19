# Sauna

A read-only device that follows a sauna session: when it heats, when it is ready, and when someone
starts bathing. It switches nothing, so it works
with any stove: an electric stove with no connectivity, or a wood-burning stove.

## Add it

Add device → Adaptive Home Comfort → **Sauna**, then choose:

- **Sauna temperature**: a temperature sensor in the sauna (required).
- **Sauna humidity** (optional): the same or another sensor's humidity. While the sauna heats, its
  humidity only falls; the first löyly makes it jump. That is how bathing is seen.
- **Stove power meter** (optional): a meter on the stove's supply. With it, the device sees when the
  stove heats and when its own thermostat switches the elements off. **None** for a wood-burning
  stove.

## What it shows

- **State**: **Off**, **Heating**, **Ready** or **In use**.
- **Expected ready** while heating, from how fast the temperature rises now (or the learned rate).
- **Left on**: on when a session lasts longer than **Left on after** (settings).
- The temperature, humidity and power.

## How a session goes

1. **Heating**: the stove draws power, or (without a meter) the temperature rises by a few degrees
   within ten minutes. **Sauna heating started** runs, with Expected ready.
2. **Ready**, once per session, at whichever comes first:
   - the stove's thermostat switching the elements off for the first time (with a power meter, once
     the sauna is warm),
   - the **Ready temperature** (settings, optional), or for a wood-burning stove the learned or
     default ready temperature (60 °C).
   **Sauna ready** runs. The sauna keeps getting warmer after this while the stove is on; that is
   normal.
3. **In use**: the first löyly (the humidity jumps once the sauna is warm). **Sauna bathing
   started** runs. When this comes before ready, there is no ready notification: someone is already
   there.
4. **Off**: no power for 45 minutes, or (wood) cooled below 40 °C.

## Stove switch (optional)

When another device sees the stove's main switch (for example an input on its supply), feed it with
the action **Set stove switch** in a flow: when the input turns on, *The stove switch is on*; when
it turns off, *off*. From the first time it is set, the switch starts the session and ends it at
once, instead of waiting 45 minutes without power.

With a wood-burning stove, **Add wood** runs when the temperature stops rising before ready, or
falls a few degrees during the session.

## Learned

At each first switch-off of the thermostat the device learns the sauna temperature then (**Ready
at**) and how fast it heated up (**Heats up**, per hour). The ready temperature as the sensor sees
it depends on where the sensor hangs, so it is learned rather than set.

## Flow cards

- Triggers **Sauna heating started** (temperature, expected ready), **Sauna ready** (temperature),
  **Sauna bathing started** (temperature, minutes since switched on), **Add wood** (temperature).
- Action **Set stove switch** (on or off).
- Homey's own cards for the temperature, humidity, power and **Left on**.
