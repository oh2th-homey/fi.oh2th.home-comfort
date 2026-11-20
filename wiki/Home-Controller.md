# Home Controller

The controller holds what all zones share. You can add only one.

- **Occupancy**: Home (someone is home), Coming home (someone is on the way) or Out
  (nobody is home right now). Set it with the **Set occupancy** card, for example from presence or a
  geofence.
- **Season**: Heating, Cooling, Off or Automatic. In [Automatic](#automatic-season) the app
  chooses heating or cooling itself.
- **Away**: on when everyone has left for days, off when you are home. All zones go to eco and
  nothing cools. To stop
  all heating and cooling, set the season to Off.
- **Price now**, in the currency set in the settings (default €).
- **Expensive now**: on during a price peak, or over **Expensive above**.
- **Price level**: Normal, High (over **High above**) or Expensive (over **Expensive above**).
- **Prices until**: the end of the last known price.
- **Outdoor temperature**, from the sensor you picked. Zones with an outdoor limit use it. To pick
  another sensor, other prices to follow (see [Prices](Prices)) or other heating meters, use
  **Repair** in the controller's device settings.
- **Forecast low (24 h)**, with the [outdoor forecast](#outdoor-forecast) on: the lowest outdoor
  temperature in the next 24 hours.
- **Heating power**, when a zone has power meters or you picked other heating meters: the sum of
  the zones' heating power and the other meters. With other meters, **Zones** and **Other meters**
  show the two parts. In Homey Energy, count either the controller, the zones or the meters, not
  more than one (see [Setup](Setup)).
- **Energy today** of the zones with power meters and the other meters, from midnight. Costs are
  counted by your energy app, for example Power by the Hour's consumption devices, with your own
  tariff. To follow the cost of all heating and cooling in one place, point such a device at the
  controller's heating power.
- **Reason**: in Automatic first the season and why (`Heating: outdoor mean 7.2 °C`), then why the
  price is expensive or not, in one phrase, the strongest first: `Expensive:
  over 0.15 €/kWh` (over Expensive above), `Price peak: over 0.27 €/kWh`, `High: over 0.10 €/kWh`
  or `Normal`.

### Other heating meters

Heating and cooling that isn't in any zone, such as a ventilation unit with heat recovery, a
storage room heater or a defroster, can still count in the controller's heating power and energy.
Pick their power meters under **Other heating meters** when you add the controller or in its
**Repair**. A power meter that a zone uses already can't be picked, so nothing is counted twice.
The app only reads these meters; it never switches them.

<img src="images/controller-device.png" alt="Home Controller during a price peak" width="300">

## Settings

- **Currency** (follows the Power by the Hour price device), **Price model**, **High above** and **Expensive above** (the home's price levels),
  **Minimum price difference** and the **Percentage above average** for the Above average model. See [Save on price peaks](How-to#save-on-price-peaks).
- **Check tomorrow's prices at** (default 16:00): the time of the daily check that fires
  **Prices missing for tomorrow**.
- **Away until**: the last day away. See
  [Leave for days](How-to#leave-for-days).
- **Automatic season**: the limits of the [automatic season](#automatic-season).
- **Outdoor forecast from Open-Meteo** (default off): see [Outdoor forecast](#outdoor-forecast).

## Automatic season

With the season set to **Automatic**, the controller chooses heating or cooling from the
temperatures it has collected itself:

- **Outdoor mean**: the outdoor temperature over the past 3 days. With the
  [outdoor forecast](#outdoor-forecast) on, the past 2 days and the next 24 hours.
- **Indoor mean**: the temperature over the past 24 hours of the zones that can cool (zones with an
  air conditioner).

The season becomes **Heating** when the outdoor mean is below **Heating when outdoor mean below**
(default 10 °C), and **Cooling** when the outdoor mean is above **Cooling when outdoor mean above**
(default 18 °C) and the indoor mean is above **and indoor mean above** (default 23 °C). Between the
limits the season stays as it is, so it doesn't switch back and forth. Without zones that can cool,
Automatic always heats.

Automatic never chooses Off, because Off also stops frost protection in the zones. The means start
when the controller is added or updated: for about the first 2–3 days the season stays as it was
(Heating if it was Off). Setting the season to Heating, Cooling or Off takes over from Automatic;
setting it back to Automatic hands the choice back to the app.

## Outdoor forecast

With **Outdoor forecast from Open-Meteo** on, the controller fetches the hourly outdoor
temperature for the next three days from [Open-Meteo](https://open-meteo.com/) once an hour: no
account or API key. It sends only the Homey's location, rounded to about 1 km. The controller then
shows **Forecast low (24 h)**, the lowest temperature in the next 24 hours.
**Forecast source** under the setting shows where it came from and when: in the Nordic countries
**MET Nordic** (1 km, updated hourly) for about 2½ days, then ECMWF; elsewhere Open-Meteo's best
match of models.

The forecast is for planning ahead; the current outdoor temperature still comes from your own
sensor. Without the forecast, or when it can't be fetched for 6 hours, the current outdoor
temperature counts for the hours ahead too.
