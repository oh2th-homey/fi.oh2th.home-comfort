# Flow cards

Homey gives the standard cards for the standard parts of the devices: the season (thermostat
mode), the price now and Boost (on, off, toggle). The app adds these:

## Home Controller

- Actions: **Set occupancy**, **Set away until**, **Back home**.
- Conditions: **Occupancy is**, **Away is on**, **Price is expensive**, **Price level is**.
- Triggers: **Occupancy changed**, **Away changed**, **Expensive now changed**, **Price
  level changed** (`normal`, `high` or `expensive`: a warning for notifications), **Prices
  missing for tomorrow** (once a day at the check time). The **Occupancy
  changed** token is `present` (Home), `coming_home` (Coming home) or `away` (Out).

## Heating Zone

- Actions: **Set zone mode**, **Boost zone** (for a number of minutes), **Set comfort heat**,
  **Set eco heat**, **Set comfort cool**, **Set eco cool**, **Follow home for 24 hours**, **Use own
  occupancy setting**.
- Conditions: **Zone mode is**, **Zone is in eco**.
- Triggers: **Eco changed**, **Target changed** (with the reason), **Member write failed**.

## Hot Tub and Water Heater

- Actions: **Ready at a time**, **Set ready time** (time, minutes ahead and days of the week), **Skip the next ready time**, **Turn heating ready on or off**,
  **Set water temperature** (when the water temperature comes from a flow, e.g. MQTT), **Set tank
  temperature** (Water Heater: the top, middle or bottom temperature from a flow).
- Conditions: **Heating ready is on**, **State is**.
- Triggers: **Heating demand started** and **Heating demand stopped**, with the target temperature
  and the reason; **State changed**, with the state; **Filter cycles planned** (Hot Tub, see
  [Filter cycles](Hot-Tub-and-Water-Heater#filter-cycles-hot-tub)), with each cycle's start and
  whether it runs; **Ready time skipped** (over the price limit), with the ready time, the price
  and the limit; **Heating planned** and **Heating started for a ready time** (once each per ready
  time), with the ready time, expected start and ready, target temperature and reason; Heating
  planned also with the end, minutes and price (a Water Heater with Plan from: its night block, see
  [Night heat-up](Hot-Tub-and-Water-Heater#night-heat-up-water-heater)); **Ready
  reached** (once per ready time), with the ready time, until when and the temperatures;
  **Heating ready turned on** and **Heating ready turned off**; **Heating held by the price
  ceiling** (once, when the water falls below Keep while the price is over the home's ceiling),
  with the ceiling, the water temperature and Keep. Homey's own cards cover Heating demand (on/off, also by hand), the
  mode (Automatic, Heat, Off) and the target temperature.

## Sauna

- Triggers: **Sauna heating started**, **Sauna ready**, **Sauna bathing started**, **Add wood**.
- Action: **Set stove switch** (on or off), when another device sees the stove's main switch. See
  [Sauna](Sauna).
