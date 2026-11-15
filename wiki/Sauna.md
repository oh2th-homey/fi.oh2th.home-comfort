# Sauna

A read-only device that follows a sauna session: when it heats, when it is ready, when someone
starts bathing, and (with a power meter) what the session costs. It switches nothing, so it works
with any stove: an electric stove with no connectivity, or a wood-burning stove.

## Add it

Add device → Smart HVAC Control → **Sauna**, then choose:

- **Sauna temperature**: a temperature sensor in the sauna (required).
- **Sauna humidity** (optional): the same or another sensor's humidity. While the sauna heats, its
  humidity only falls; the first löyly makes it jump. That is how bathing is seen.
- **Stove power meter** (optional): a meter on the stove's supply. With it, the device sees when the
  stove heats and when its own thermostat switches the elements off. **None** for a wood-burning
  stove.

## What it shows

- **State**: **Off**, **Heating**, **Ready** or **In use**.
- **Expected ready** while heating, from how fast the temperature rises now (or the learned rate).
- **Cost estimate** (with a power meter): the session's energy so far plus the rest of the
  heat-up, at the current price.
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

With a wood-burning stove, **Add wood** runs when the temperature stops rising before ready, or
falls a few degrees during the session.

## Learned

At each first switch-off of the thermostat the device learns the sauna temperature then (**Ready
at**) and how fast it heated up (**Heats up**, per hour). The ready temperature as the sensor sees
it depends on where the sensor hangs, so it is learned rather than set.

## Flow cards

- Triggers **Sauna heating started** (temperature, expected ready), **Sauna ready** (temperature),
  **Sauna bathing started** (temperature, minutes since switched on), **Add wood** (temperature).
- Homey's own cards for the temperature, humidity, power and **Left on**.
