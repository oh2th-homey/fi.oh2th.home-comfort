# Graphs

Each Heating Zone and the HVAC Controller show three graphs as camera images: **Yesterday**,
**Today** and **Tomorrow**. Open the device and swipe to the images; tap one to see it larger.
The app draws them itself on your Homey, without internet. They are updated every 15 minutes
and after a price import.

Times are local, from midnight to midnight, so a day with a daylight saving change is 23 or 25
hours long. Today is shaded after the white "now" line. What lies ahead is only what the app
already knows: the imported prices and what the zone will aim at with them. The app doesn't
guess temperatures ahead.

## Heating Zone

- **Temperature** (blue) and **target** (orange) on the left scale, with the **eco–comfort**
  band shaded. Ahead of now, the **expected** target is dashed: the zone's own rules applied to
  the known prices, with the occupancy, season and setpoints as they are now. It changes when
  they change.
- **Heating** power (blue bars) on the right scale, when the zone has power meters.
- The thin strip under the graph marks the **expensive** quarters (orange).
- The headline: yesterday the energy used, with the mean temperature and the price paid; today
  the temperature and the target now, with today's energy and price paid; tomorrow the expected
  target, with the eco time and how far the prices are known.

Tomorrow stays empty with **Prices not known yet** until tomorrow's prices are imported (see
[Prices](Prices)).

## HVAC Controller

- **Price** per quarter (or hour) on the left scale, **expensive** ones in orange.
- **Outdoor** temperature (green) on the right scale.
- **Heating** power of all zones with power meters, in a pane below.
- The headline: today the price now, with the zones' energy and the outdoor temperature;
  yesterday and tomorrow the average price.

## Memory

Drawing the graphs needs about 45 MB more memory for the app. The **Graphs** setting of the
HVAC Controller turns them on or off for the whole app. **Automatic** (the default) draws them,
except on Homey Pro (Early 2019) and older, which have little memory. Choose **On** to draw them
there too, or **Off** if Homey stops the app for using too much memory. Restart the app after
turning them off to give the memory back.

## Credits

The graphs are drawn with [resvg](https://github.com/linebender/resvg) (MPL-2.0) and use the
[Inter](https://rsms.me/inter/) font (SIL Open Font License).
