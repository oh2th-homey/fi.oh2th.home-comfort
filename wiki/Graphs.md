# Graphs

The Home Controller, each Heating Zone, the Hot Tub and the Water Heater show two graphs as
camera images: **Today** and **Tomorrow**. Open the device and swipe to the images. Tap one to
see it larger.

The app draws them on your Homey, without internet. Today's image is drawn again every 15
minutes. Tomorrow's is drawn only when something in it changes, for example when new prices
arrive or you change a setpoint.

Each scale shows its unit at the top. Times are local, midnight to midnight. Today is shaded
after the white **now** line. What lies ahead is only what the app already knows: the known
prices, what the zone will aim at with them, the outdoor forecast and the water heating plan.
The app doesn't guess room temperatures ahead.
Tomorrow shows **Prices not known yet** until tomorrow's prices arrive (see [Prices](Prices)).

## Heating Zone

- **Temperature** (blue): measured, until now.
- **Target** (yellow): what the zone aimed at. After now it is dashed: what the zone will aim
  at, from the zone's rules and the known prices, with the occupancy, season and setpoints as
  they are now. It changes when they change.
- **Eco-comfort** (shaded): the band between eco and comfort.
- The strip under the graph marks the **price peaks** (orange) and the prices over **Expensive
  above** (red, see [Prices](Prices)).
- The headline: today the temperature and target now, tomorrow the eco time.

## Home Controller

- **Price** of each slot (left scale): **price peaks** in orange, prices over **Expensive above**
  in red.
- **Outdoor** temperature (green, right scale): measured until now, then the
  [forecast](Home-Controller#outdoor-forecast) dashed, when it is on.
- The headline: today the price and outdoor temperature now, tomorrow the average price and the
  forecast low.

## Hot Tub and Water Heater

- **Water** temperature (blue, right scale): measured until now, then dashed what the plan
  expects.
- **Ready** (white line, shaded behind): each ready time and its temperature.
- **Heating** (strip under the graph): when it heated, and when the plan heats.
- **Price** of each slot (grey, left scale).
- The headline: the water temperature now and the next ready time.

## Homey Pro models

Drawing the graphs takes memory, so the app needs a Homey Pro (Early 2023) or newer, or Homey
Self-Hosted Server. It can't be installed on Homey Pro (2016–2019).

## Credits

The graphs are drawn with [pureimage](https://github.com/joshmarinacci/node-pureimage) (MIT) and
use the [Inter](https://rsms.me/inter/) font (SIL Open Font License).
