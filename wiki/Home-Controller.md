# Home Controller

The controller holds what all zones share. You can add only one.

- **Occupancy**: Present (someone is home), Coming Home (someone is on the way) or Away
  (nobody is home). Set it with the **Set occupancy** card, for example from presence or a
  geofence.
- **Season**: Heating, Cooling or Off.
- **Long absence**: on for trips of several days. All zones go to eco and nothing cools. To stop
  all heating and cooling, set the season to Off.
- **Price now**, in the currency set in the settings (default €).
- **Expensive now**: on during a price peak, or over **Expensive above**.
- **Price level**: Normal, High (over **High above**) or Expensive (over **Expensive above**).
- **Prices until**: the end of the last known price.
- **Outdoor temperature**, from the sensor you picked. Zones with an outdoor limit use it. To pick
  another sensor, other prices to follow (see [Prices](Prices)) or other heating meters, use
  **Repair** in the controller's device settings.
- **Heating power**, when a zone has power meters or you picked other heating meters: the sum of
  the zones' heating power and the other meters. With other meters, **Zones** and **Other meters**
  show the two parts. In Homey Energy, count either the controller, the zones or the meters, not
  more than one (see [Setup](Setup)).
- **Energy today** of the zones with power meters and the other meters, from midnight. Costs are
  counted by your energy app, for example Power by the Hour's consumption devices, with your own
  tariff. To follow the cost of all heating and cooling in one place, point such a device at the
  controller's heating power.
- **Reason**: why the price is expensive or not, for example `Normal`.

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
- **Long absence until**: the last day of a long absence. See
  [Leave for days](How-to#leave-for-days).
